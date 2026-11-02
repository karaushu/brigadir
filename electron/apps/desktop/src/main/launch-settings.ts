import {
	scopeSelected,
	outsideProject,
	isLaunchSettings,
	type ScopeChoice,
	type ScopeUpdate,
	type LaunchSettings,
	type TaskLaunch,
} from '@brigadir/core';
import { discoverScopes, gitText } from '@brigadir/git';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { atomicJson, readDocument, safePath, SessionStore } from '@brigadir/persistence';
import { defaultAppSettings, isRecord } from '@brigadir/core';
export class LaunchSettingsStore {
	private writes: Promise<unknown> = Promise.resolve();
	private pending = 0;
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.writes;
	}
	private serial<T>(work: () => Promise<T>) {
		this.pending++;
		const result = this.writes.then(work).finally(() => {
			this.pending--;
		});
		this.writes = result.catch(() => {});
		return result;
	}
	/** spec/settings-modules-and-onboarding#settings-keys: every new task starts with the isolation from Settings ▸ Agents, not the last choice in the project;
	 *  spec/git#worktree-env: and with «Copy .env» from Settings ▸ Editor ▸ Git. */
	constructor(
		private dataDir: string | undefined,
		private defaultIsolation: () => 'in-place' | 'worktree' = () => 'in-place',
		private defaultCopyEnv: () => boolean = () => defaultAppSettings.agents.copyEnvFiles
	) {}
	/** spec/projects-and-board#external-folders: an outside folder is one task's choice; the path is canonical, the name comes from the folder name, a collision with `taken` adds the parent. The project does not change. */
	async describeFolder(
		projectId: string,
		path: string,
		taken: readonly { name: string }[] = []
	): Promise<ScopeChoice> {
		const canonical = await realpath(path);
		if ((await stat(canonical)).isDirectory() === false) throw new Error('Expected a folder');
		const store = await SessionStore.at(this.dataDir),
			project = await store.project(projectId),
			root = await realpath(project.path);
		if (canonical === root || canonical.startsWith(`${root}/`))
			throw new Error('The folder is inside the project');
		const id = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
		const isGit = await gitText(canonical, ['rev-parse', '--show-toplevel'])
			.then((top) => top.trim() === canonical)
			.catch(() => false);
		const names = new Set([
			...(await discoverScopes(project.path)).map((scope) => scope.name),
			...taken.map((scope) => scope.name),
		]);
		let name = basename(canonical) || canonical;
		if (names.has(name)) name = `${basename(dirname(canonical))}/${name}`;
		return { id, name, kind: isGit ? 'external' : 'folder', selected: true, path: canonical };
	}
	private async saved(projectId: string): Promise<LaunchSettings | null> {
		const store = await SessionStore.at(this.dataDir);
		await store.project(projectId);
		try {
			const doc = await readDocument(
				await safePath(store.root, 'projects', projectId, 'workspace.json')
			);
			if (doc.settings === undefined) return null;
			if (!isLaunchSettings(doc.settings)) throw new Error('Invalid launch settings');
			return doc.settings;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
	}
	async read(projectId: string): Promise<LaunchSettings> {
		const store = await SessionStore.at(this.dataDir),
			project = await store.project(projectId),
			saved = await this.saved(projectId),
			scopes = await discoverScopes(project.path);
		// spec/projects-and-board#external-folders: project defaults are only repos under the root; outside folders belong to tasks.
		const merged = scopes.map((scope) => ({
			id: scope.id,
			name: scope.name,
			kind: scope.kind,
			selected: scope.selected,
		}));
		return {
			isolation: this.defaultIsolation(),
			copyEnvFiles: this.defaultCopyEnv(),
			baseRef: saved?.baseRef ?? 'origin/main',
			setupCommand: saved?.setupCommand ?? '',
			...(saved?.crewTemplateId ? { crewTemplateId: saved.crewTemplateId } : {}),
			scopes: merged.map((scope) => {
				const choice = saved?.scopes.find((value) => value.id === scope.id);
				/* spec/projects-and-board#repo-selection: a repo found after the project was set up comes unselected. */ return {
					...scope,
					selected: choice ? scopeSelected(choice) : saved ? false : scope.selected,
				};
			}),
		};
	}
	async resolve(projectId: string, input?: TaskLaunch): Promise<TaskLaunch> {
		const settings = await this.read(projectId);
		if (!input) return { ...settings, branch: '' };
		const outside = input.scopes.filter(
			(choice) => outsideProject(choice) && !settings.scopes.some((scope) => scope.id === choice.id)
		);
		if (
			input.scopes.some(
				(choice) =>
					!outside.includes(choice) && !settings.scopes.some((scope) => scope.id === choice.id)
			)
		)
			throw new Error('A selected repo is unavailable');
		const scopes = settings.scopes.map((scope) => {
			const choice = input.scopes.find((value) => value.id === scope.id);
			return { ...scope, selected: choice ? scopeSelected(choice) : false };
		});
		// spec/projects-and-board#external-folders: an outside folder goes into the task only when selected, and its path is checked again, not trusted.
		for (const choice of outside) {
			if (!scopeSelected(choice)) continue;
			if (!choice.path) throw new Error('A selected repo is unavailable');
			const folder = await this.describeFolder(projectId, choice.path, scopes).catch(() => null);
			if (!folder || folder.id !== choice.id) throw new Error('A selected repo is unavailable');
			scopes.push(folder);
		}
		// spec/git#main-tree-branches: a switch only for a chosen git repo of a task without isolation.
		const chosen = (id: string) =>
			scopes.some((scope) => scope.id === id && scope.selected && scope.kind !== 'folder');
		const { switches, pull, ...rest } = input,
			kept =
				input.isolation === 'in-place'
					? (switches ?? []).filter((item) => chosen(item.scopeId))
					: [];
		// spec/git#pull: a pull for a chosen git repo without isolation; a repo that switches pulls as part of the switch.
		const pulls =
			input.isolation === 'in-place'
				? (pull ?? []).filter((id) => chosen(id) && !kept.some((item) => item.scopeId === id))
				: [];
		return {
			...rest,
			scopes,
			...(kept.length ? { switches: kept } : {}),
			...(pulls.length ? { pull: pulls } : {}),
		};
	}
	async collapsed(projectId: string) {
		const store = await SessionStore.at(this.dataDir);
		await store.project(projectId);
		try {
			const doc = await readDocument(
				await safePath(store.root, 'projects', projectId, 'workspace.json')
			);
			if (doc.scopesCollapsed !== undefined && typeof doc.scopesCollapsed !== 'boolean')
				throw new Error('Invalid repo panel settings');
			return doc.scopesCollapsed === true;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return false;
			throw error;
		}
	}
	/** spec/projects-and-board#external-folders: the project's old `folders` are not rewritten; outside folders never become defaults. */
	private async write(projectId: string, settings: LaunchSettings, scopesCollapsed: boolean) {
		const store = await SessionStore.at(this.dataDir);
		await atomicJson(await safePath(store.root, 'projects', projectId, 'workspace.json'), {
			schemaVersion: 1,
			settings: { ...settings, scopes: settings.scopes.filter((scope) => !outsideProject(scope)) },
			scopesCollapsed,
		});
	}
	save(projectId: string, value: TaskLaunch, crewTemplateId?: string) {
		return this.serial(async () => {
			const previous = await this.saved(projectId);
			const {
				branch,
				branchAuto: _auto,
				copyEnvFiles: _env,
				switches: _switches,
				pull: _pull,
				...settings
			} = value;
			const chosen = crewTemplateId ?? previous?.crewTemplateId;
			await this.write(
				projectId,
				{ ...settings, ...(chosen ? { crewTemplateId: chosen } : {}) },
				await this.collapsed(projectId)
			);
		});
	}
	collapse(projectId: string, collapsed: boolean) {
		return this.serial(async () => {
			await this.write(projectId, await this.read(projectId), collapsed);
		});
	}
	updateScope(projectId: string, update: ScopeUpdate) {
		return this.serial(async () => {
			const settings = await this.read(projectId),
				scope = settings.scopes.find((scope) => scope.id === update.id);
			if (!scope) throw new Error('Repo is unavailable');
			scope.selected = update.selected;
			await this.write(projectId, settings, await this.collapsed(projectId));
		});
	}
}
