import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
	Worktrees,
	createBranch,
	discoverScopes,
	gitText,
	pullFastForward,
	switchBranch,
} from '@brigadir/git';
import { repoHolder } from './main-tree';
import { ProcessCoordinator, SessionStore, readWorkspace, safePath } from '@brigadir/persistence';
import {
	FETCH_FAILED,
	branchFromAnswer,
	freeBranch,
	isRecord,
	type TaskKey,
	type TaskLaunch,
} from '@brigadir/core';
/** spec/git#agent-branch-names: one-shot branch words for the task; '' keeps the name derived from its text. */
export type BranchNamer = (title: string, prompt: string, signal: AbortSignal) => Promise<string>;
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
export class Preparations {
	private running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
	constructor(
		private dataDir: string | undefined,
		private services: string,
		private changed: (key: TaskKey) => void,
		private nameBranch?: BranchNamer
	) {}
	get isSaving() {
		return this.running.size > 0;
	}
	async waitForWrites() {
		await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
	}
	isPreparing(key: TaskKey) {
		return this.running.has(name(key));
	}
	async cancel(key: TaskKey) {
		const entry = this.running.get(name(key));
		if (!entry) return false;
		entry.controller.abort();
		await entry.promise.catch(() => {});
		return true;
	}
	prepare(key: TaskKey): Promise<void> {
		const existing = this.running.get(name(key));
		if (existing) return existing.promise;
		const controller = new AbortController(),
			promise = this.run(key, controller.signal).finally(() => this.running.delete(name(key)));
		this.running.set(name(key), { controller, promise });
		return promise;
	}
	private async run(key: TaskKey, signal: AbortSignal) {
		const store = await SessionStore.at(this.dataDir),
			task = await store.task(key);
		let launch = task.launch;
		if (launch?.isolation !== 'worktree') {
			if ((launch?.switches?.length || launch?.pull?.length) && task.preparation?.state !== 'ready')
				await this.switchBranches(store, key, launch, signal);
			return;
		}
		const trees = new Worktrees(
			store,
			new ProcessCoordinator(join(this.services, 'process-owner'))
		);
		if (task.preparation?.state === 'ready') {
			await store.projectForTask(key);
			const state = await trees.read(key);
			if (
				state?.state !== 'ready' ||
				state.branch !== launch.branch ||
				state.baseRef !== launch.baseRef
			)
				throw new Error('Prepared workspace metadata changed');
			return;
		}
		await store.setStatus(key, 'preparing');
		this.changed(key);
		try {
			if (launch.branchAuto && !(await trees.read(key)))
				launch = await this.named(store, key, launch, signal);
			const result = await trees.prepare(
				key,
				{
					branch: launch.branch,
					baseRef: launch.baseRef,
					scopeIds: launch.scopes
						.filter((scope) => scope.kind !== 'external' && scope.kind !== 'folder')
						.map((scope) => scope.id),
					setupCommand: launch.setupCommand,
					copyEnvFiles: launch.copyEnvFiles === true,
				},
				async (state) => {
					await store.updateTask(key, {
						preparation: {
							state: state.state,
							step: state.step,
							...(state.error ? { error: state.error } : {}),
						},
						worktreeBranch: state.branch,
					});
					this.changed(key);
				},
				signal
			);
			signal.throwIfAborted();
			await store.updateTask(key, {
				preparation: { state: result.state, step: result.step },
				worktreeBranch: result.branch,
			});
			await store.setStatus(key, 'queued');
			this.changed(key);
		} catch (error) {
			await store.setStatus(key, signal.aborted ? 'interrupted' : 'failed');
			await store.updateTask(key, {
				preparation: {
					state: 'failed',
					step: (await store.task(key)).preparation?.step ?? 'repositories',
					error: error instanceof Error ? error.message : String(error),
				},
			});
			this.changed(key);
			throw error;
		}
	}
	/**
	 * spec/git#main-tree-branches: a task without isolation switches the main tree's branches it chose in the sheet before its agent starts:
	 * the same rules as the picker (no live task in the repo, the dirty choice made in the sheet), once — a start after
	 * success does not switch again. A failure leaves the tree as it was and the task `failed` with the reason.
	 */
	private async switchBranches(
		store: SessionStore,
		key: TaskKey,
		launch: TaskLaunch,
		signal: AbortSignal
	) {
		await store.setStatus(key, 'preparing');
		this.changed(key);
		let step = 'switch';
		try {
			const project = await store.project(key.projectId),
				scopes = await discoverScopes(project.path);
			for (const item of launch.switches ?? []) {
				signal.throwIfAborted();
				const scope = scopes.find((value) => value.id === item.scopeId && value.kind !== 'folder');
				if (!scope) throw new Error('A selected repo is unavailable');
				step = `switch:${scope.name === '.' ? project.name : scope.name}`;
				await store.updateTask(key, { preparation: { state: 'preparing', step } });
				this.changed(key);
				const holder = await repoHolder(this.dataDir, this.services, scope.path);
				if (holder && !(holder.projectId === key.projectId && holder.id === key.id))
					throw new Error(`The task ${holder.title} is working in this repo without isolation.`);
				if (item.create)
					await createBranch(scope.path, { name: item.branch, base: item.create.base });
				else {
					const request = { branch: item.branch, mode: item.dirty ?? 'clean' } as const;
					// Nobody is there to say «switch without pull»: a fetch that fails falls back to the branch as it is locally.
					await switchBranch(scope.path, request).catch((error) => {
						if (error instanceof Error && error.message === FETCH_FAILED)
							return switchBranch(scope.path, { ...request, offline: true });
						throw error;
					});
				}
			}
			// spec/git#pull: a fresh branch is best effort — diverged, overlapping changes, no network or another task's lock start the task as it is.
			for (const id of launch.pull ?? []) {
				signal.throwIfAborted();
				const scope = scopes.find((value) => value.id === id && value.kind !== 'folder');
				if (!scope) continue;
				step = `pull:${scope.name === '.' ? project.name : scope.name}`;
				await store.updateTask(key, { preparation: { state: 'preparing', step } });
				this.changed(key);
				const holder = await repoHolder(this.dataDir, this.services, scope.path);
				if (holder && !(holder.projectId === key.projectId && holder.id === key.id)) continue;
				await pullFastForward(scope.path).catch(() => 0);
			}
			signal.throwIfAborted();
			await store.updateTask(key, { preparation: { state: 'ready', step: 'switch' } });
			await store.setStatus(key, 'queued');
			this.changed(key);
		} catch (error) {
			await store.setStatus(key, signal.aborted ? 'interrupted' : 'failed');
			await store.updateTask(key, {
				preparation: {
					state: 'failed',
					step,
					error: error instanceof Error ? error.message : String(error),
				},
			});
			this.changed(key);
			throw error;
		}
	}
	/** spec/git#agent-branch-names: the agent names the branch before `worktree add`; any failure keeps the derived name, and the choice is fixed in the task. */
	private async named(store: SessionStore, key: TaskKey, launch: TaskLaunch, signal: AbortSignal) {
		await store.updateTask(key, { preparation: { state: 'preparing', step: 'branch' } });
		this.changed(key);
		const task = await store.task(key),
			answer = this.nameBranch
				? await this.nameBranch(task.title, task.prompt ?? '', signal).catch(() => '')
				: '';
		signal.throwIfAborted();
		const words = branchFromAnswer(answer),
			base = words || launch.branch,
			project = await store.project(key.projectId);
		const scopes = (await discoverScopes(project.path).catch(() => [])).filter(
			(scope) => scope.kind !== 'external' && scope.kind !== 'folder'
		);
		const taken = new Set(
			(
				await Promise.all(
					scopes.map((scope) =>
						gitText(scope.path, [
							'for-each-ref',
							'--format=%(refname)',
							`refs/heads/${base}*`,
						]).catch(() => '')
					)
				)
			)
				.flatMap((text) => text.split('\n'))
				.filter(Boolean)
				.map((ref) => ref.slice('refs/heads/'.length))
		);
		const { branchAuto: _auto, ...rest } = launch,
			named = { ...rest, branch: freeBranch(base, taken) };
		await store.updateTask(key, { launch: named });
		return named;
	}
	async recover() {
		const store = await SessionStore.at(this.dataDir);
		for (const task of (await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {})).tasks)
			if (task.status === 'preparing') {
				await store.setStatus(task, 'interrupted');
				await store.updateTask(task, {
					preparation: {
						state: 'failed',
						step: task.preparation?.step ?? 'repositories',
						error: 'Workspace preparation was interrupted.',
					},
				});
			}
	}
	async log(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir),
			path = await safePath(await store.taskDir(key), 'worktree-setup.log');
		let file;
		try {
			file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			const stat = await file.stat();
			if (!stat.isFile()) throw new Error('Invalid setup log');
			const buffer = Buffer.alloc(Math.min(stat.size, 128 * 1024));
			const { bytesRead } = await file.read(
				buffer,
				0,
				buffer.length,
				Math.max(0, stat.size - buffer.length)
			);
			return buffer.subarray(0, bytesRead).toString('utf8');
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return '';
			throw error;
		} finally {
			await file?.close();
		}
	}
	/** Repos section (spec/sidebar#layout): drop the worktree, keep the task, its branches and commits. */
	async discard(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir),
			task = await store.task(key);
		if (task.launch?.isolation !== 'worktree') throw new Error('The task has no worktree');
		if (['queued', 'preparing', 'working', 'needs-you'].includes(task.status))
			throw new Error('Stop the task before removing its worktree');
		await this.remove(key);
		await store.clearPreparation(key);
		this.changed(key);
	}
	async remove(key: TaskKey) {
		await this.cancel(key);
		const store = await SessionStore.at(this.dataDir);
		await new Worktrees(store, new ProcessCoordinator(join(this.services, 'process-owner'))).remove(
			key
		);
	}
	/** spec/tasks#delete-task: what deleting the task loses in its worktree; null when it has none. */
	async uncommitted(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir);
		return new Worktrees(
			store,
			new ProcessCoordinator(join(this.services, 'process-owner'))
		).uncommitted(key);
	}
}
