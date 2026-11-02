import { join } from 'node:path';
import { ScopeLocks } from '@brigadir/host/client';
import { Snapshots, discoverScopes, upstreamCounts } from '@brigadir/git';
import { SessionStore, ProcessCoordinator } from '@brigadir/persistence';
import { listedInTask, type ScopePanelSnapshot, type ScopeUpdate } from '@brigadir/core';
import type { Sessions } from './sessions';
import type { Changes } from './changes';
import type { LaunchSettingsStore } from './launch-settings';
export class ScopeControls {
	private writes: Promise<unknown> = Promise.resolve();
	private pending = 0;
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.writes;
	}
	constructor(
		private dataDir: string | undefined,
		private services: string,
		private sessions: Sessions,
		private changes: Changes,
		private settings: LaunchSettingsStore
	) {}
	async read(projectId: string, taskId: string | null): Promise<ScopePanelSnapshot> {
		const store = await SessionStore.at(this.dataDir),
			project = await store.project(projectId),
			key = taskId ? { projectId, id: taskId } : null;
		const task = key ? await store.task(key) : null,
			settings = key ? null : await this.settings.read(projectId);
		const preparing = task?.launch?.isolation === 'worktree' && task.preparation?.state !== 'ready';
		// spec/projects-and-board#external-folders: a deselected outside folder is no longer in the task, so it has no row.
		const scopes =
			key && !preparing
				? (await Snapshots.open(store, key)).current.scopes.filter(listedInTask)
				: (await discoverScopes(project.path)).map((scope) => ({
						...scope,
						...(task?.launch ?? settings)!.scopes.find((choice) => choice.id === scope.id),
					}));
		const changes = key && !preparing ? await this.changes.read(key) : null,
			locks =
				task?.launch?.isolation === 'worktree'
					? []
					: await new ScopeLocks(
							store,
							new ProcessCoordinator(join(this.services, 'process-owner'))
						).snapshot();
		const titles = new Map<string, string>();
		for (const lock of locks) {
			const key = lock.owner.key,
				id = `${key.projectId}/${key.id}`;
			if (!titles.has(id))
				titles.set(
					id,
					await store.task(key).then(
						(task) => task.title,
						() => key.id
					)
				);
		}
		// spec/git#pull: ↑N/↓N where the row is the main tree — no task, or a task without isolation; never a task's worktree.
		const mainTree = !task || task.launch?.isolation !== 'worktree',
			counts = new Map(
				await Promise.all(
					scopes.map(
						async (scope) =>
							[
								scope.id,
								mainTree && scope.kind !== 'folder' && scope.available !== false
									? await upstreamCounts(scope.path)
									: null,
							] as const
					)
				)
			);
		const canChangeRepos =
			!task ||
			(!preparing &&
				!['queued', 'preparing'].includes(task.status) &&
				!(await this.sessions.connected(key!)));
		return {
			collapsed: await this.settings.collapsed(projectId),
			canChangeRepos,
			scopes: scopes.map((scope) => {
				const files = changes?.files.filter((file) => file.scopeId === scope.id) ?? [];
				return {
					...scope,
					owners: locks
						.filter((lock) => lock.path === scope.path)
						.map((lock) => ({
							key: lock.owner.key,
							title: titles.get(`${lock.owner.key.projectId}/${lock.owner.key.id}`)!,
							acquiredAt: lock.acquiredAt,
						})),
					additions: files.reduce((n, file) => n + file.additions, 0),
					deletions: files.reduce((n, file) => n + file.deletions, 0),
					firstFile: files[0] ? `${scope.id}/${files[0].path}` : null,
					upstream: counts.get(scope.id) ?? null,
				};
			}),
		};
	}
	update(projectId: string, taskId: string | null, update: ScopeUpdate) {
		this.pending++;
		const result = this.writes
			.then(async () => {
				if (taskId) {
					await this.sessions.command({ projectId, id: taskId }, { kind: 'setScope', update });
				} else await this.settings.updateScope(projectId, update);
			})
			.finally(() => {
				this.pending--;
			});
		this.writes = result.catch(() => {});
		return result;
	}
}
