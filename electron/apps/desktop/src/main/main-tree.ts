import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { SessionStore, ProcessCoordinator } from '@brigadir/persistence';
import { ScopeLocks } from '@brigadir/host/client';
import {
	createBranch,
	dirtyFiles,
	discardChanges,
	discoverScopes,
	fetchRemotes,
	gitText,
	lastCommit,
	pullBranch,
	stashDrop,
	stashPush,
	stashRestore,
	stashes,
	switchBranch,
	switchBranches,
	undoLastCommit,
} from '@brigadir/git';
import {
	validBranch,
	MAIN_TREE_ID,
	isId,
	type BranchSwitchState,
	type CreateBranchRequest,
	type MainTreeBranch,
	type PullOutcome,
	type RepoHolder,
	type StashEntry,
	type SwitchRequest,
	type SwitchResult,
	type TaskKey,
} from '@brigadir/core';

/** The task without isolation whose live host holds this repo (spec/tasks#launch-sheet); null when the tree is free to change. */
export async function repoHolder(
	dataDir: string | undefined,
	services: string,
	path: string
): Promise<RepoHolder | null> {
	const store = await SessionStore.at(dataDir),
		locks = await new ScopeLocks(
			store,
			new ProcessCoordinator(join(services, 'process-owner'))
		).snapshot();
	const real = await realpath(path).catch(() => path),
		lock = locks.find((item) => item.path === real || item.path === path);
	if (!lock) return null;
	const key = lock.owner.key;
	return {
		projectId: key.projectId,
		id: key.id,
		title: await store.task(key).then(
			(task) => task.title,
			() => key.id
		),
	};
}

/**
 * spec/tasks#quick-tasks: a quick task on a PR branch switches the main tree to that branch only when it is clean;
 * a dirty tree stays as it is and the sheet offers a worktree. The branch stays after the task.
 * spec/git#main-tree-branches: the person switches the main tree's branch and has git tools for a dirty tree. Every action that writes
 * to the tree first checks whether a task without isolation holds the repo (spec/tasks#launch-sheet): no tree changes under a live agent.
 */
export class MainTrees {
	private fetched = new Map<string, number>();
	constructor(
		private dataDir: string | undefined,
		private services: string,
		private refresh: (key: TaskKey) => Promise<unknown>,
		private busy: () => boolean,
		private changed: (projectId: string) => void = () => {},
		/** spec/git#pull: whether a task's agent is working now; its own idle task may pull its repo. */ private taskBusy: (
			key: TaskKey
		) => Promise<boolean> = async () => true,
		/** spec/git#pull: a fetch here counts for the background watch's throttle. */ private fetchedRepo: (
			path: string
		) => void = () => {}
	) {}
	private async scope(projectId: string, scopeId: string) {
		const store = await SessionStore.at(this.dataDir),
			scope = (await discoverScopes((await store.project(projectId)).path)).find(
				(item) => item.id === scopeId && item.kind !== 'folder'
			);
		if (!scope) throw new Error('Repo is unavailable');
		return scope;
	}
	async branch(projectId: string, scopeId: string, branch: string): Promise<MainTreeBranch> {
		if (!validBranch(branch)) throw new Error('Invalid branch name');
		const scope = await this.scope(projectId, scopeId);
		const [current, status, local, remote] = await Promise.all([
			gitText(scope.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null),
			gitText(scope.path, ['status', '--porcelain', '--untracked-files=no']),
			gitText(scope.path, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).then(
				() => true,
				() => false
			),
			gitText(scope.path, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).then(
				() => true,
				() => false
			),
		]);
		return {
			scopeId,
			current: current || null,
			branch,
			dirty: status.trim().length > 0,
			exists: local || remote,
		};
	}
	async switch(projectId: string, scopeId: string, branch: string): Promise<MainTreeBranch> {
		if (this.busy()) throw new Error('Another Git operation is in progress');
		const state = await this.branch(projectId, scopeId, branch);
		if (state.current === branch) return state;
		if (state.dirty) throw new Error('The main tree has uncommitted changes');
		const scope = await this.scope(projectId, scopeId);
		await this.free(scope.path);
		// The PR branch may exist only on origin: fetch just it, then switch with tracking; no reset or stash.
		await gitText(scope.path, [
			'fetch',
			'--no-tags',
			'origin',
			`refs/heads/${branch}:refs/remotes/origin/${branch}`,
		]).catch(() => '');
		const local = await gitText(scope.path, [
			'rev-parse',
			'--verify',
			'-q',
			`refs/heads/${branch}`,
		]).then(
			() => true,
			() => false
		);
		await gitText(
			scope.path,
			local ? ['switch', branch] : ['switch', '-c', branch, '--track', `origin/${branch}`]
		);
		await this.after(projectId);
		return this.branch(projectId, scopeId, branch);
	}

	holder(path: string) {
		return repoHolder(this.dataDir, this.services, path);
	}
	private async free(path: string, own?: TaskKey) {
		const holder = await this.holder(path);
		if (!holder) return;
		if (
			own &&
			holder.projectId === own.projectId &&
			holder.id === own.id &&
			!(await this.taskBusy(own))
		)
			return;
		throw new Error(`The task ${holder.title} is working in this repo without isolation.`);
	}
	/** Our worktrees live at `<data>/worktrees/<project>/<task>/…`: the title of the task that holds a branch there. */
	private async worktreeTask(path: string): Promise<string | null> {
		const store = await SessionStore.at(this.dataDir),
			parts = relative(join(store.root, 'worktrees'), path).split(sep);
		if (parts.length < 2 || parts[0] === '..' || !isId(parts[0]) || !isId(parts[1])) return null;
		return store.task({ projectId: parts[0]!, id: parts[1]! }).then(
			(task) => task.title,
			() => null
		);
	}
	/** spec/git#main-tree-branches: the picker's state. `fetch` refreshes the remotes first, at most once a minute per repo. */
	async read(projectId: string, scopeId: string, fetch = false): Promise<BranchSwitchState> {
		const scope = await this.scope(projectId, scopeId);
		if (fetch && Date.now() - (this.fetched.get(scope.path) ?? 0) > 60_000) {
			this.fetched.set(scope.path, Date.now());
			await fetchRemotes(scope.path).then(
				() => this.fetchedRepo(scope.path),
				() => {}
			);
		}
		const [{ current, branches }, dirty, list, heldBy, last] = await Promise.all([
			switchBranches(scope.path),
			dirtyFiles(scope.path),
			gitText(scope.path, ['stash', 'list', '--format=%H']).catch(() => ''),
			this.holder(scope.path),
			lastCommit(scope.path),
		]);
		for (const branch of branches)
			if (branch.worktree)
				branch.worktreeTask = await this.worktreeTask(
					await realpath(branch.worktree).catch(() => branch.worktree!)
				);
		return {
			scopeId,
			current,
			dirty,
			branches,
			stashes: list.split('\n').filter(Boolean).length,
			heldBy,
			last,
		};
	}
	/** Every write: no other Git operation of ours, no live task in the repo, then the main tree's snapshot and panel follow. */
	private async write<T>(
		projectId: string,
		scopeId: string,
		work: (path: string) => Promise<T>,
		own?: TaskKey
	): Promise<T> {
		// Opening the main tree saves its snapshot for a moment: a click right after waits for it instead of failing.
		for (let waited = 0; this.busy() && waited < 5000; waited += 50)
			await new Promise((resolve) => setTimeout(resolve, 50));
		if (this.busy()) throw new Error('Another Git operation is in progress');
		const scope = await this.scope(projectId, scopeId);
		await this.free(scope.path, own);
		try {
			return await work(scope.path);
		} finally {
			await this.after(projectId);
		}
	}
	private async after(projectId: string) {
		await this.refresh({ projectId, id: MAIN_TREE_ID }).catch(() => {});
		this.changed(projectId);
	}
	switchTo(projectId: string, scopeId: string, request: SwitchRequest): Promise<SwitchResult> {
		return this.write(projectId, scopeId, (path) => switchBranch(path, request));
	}
	create(projectId: string, scopeId: string, request: CreateBranchRequest): Promise<SwitchResult> {
		return this.write(projectId, scopeId, (path) => createBranch(path, request));
	}
	async stashes(projectId: string, scopeId: string): Promise<StashEntry[]> {
		return stashes((await this.scope(projectId, scopeId)).path);
	}
	stash(projectId: string, scopeId: string): Promise<string> {
		return this.write(projectId, scopeId, async (path) => {
			const current = await gitText(path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
				() => ''
			);
			return stashPush(path, `brigadir: ${current || 'HEAD'}`);
		});
	}
	restore(projectId: string, scopeId: string, sha: string) {
		return this.write(projectId, scopeId, (path) => stashRestore(path, sha));
	}
	drop(projectId: string, scopeId: string, sha: string) {
		return this.write(projectId, scopeId, (path) => stashDrop(path, sha));
	}
	/** spec/git#pull: a fast-forward, or a rebase of a diverged branch; a stopped rebase comes back aborted. */
	pull(projectId: string, scopeId: string, taskId?: string | null): Promise<PullOutcome> {
		return this.write(
			projectId,
			scopeId,
			async (path) => {
				const outcome = await pullBranch(path);
				this.fetchedRepo(path);
				return outcome;
			},
			taskId ? { projectId, id: taskId } : undefined
		);
	}
	undoCommit(projectId: string, scopeId: string) {
		return this.write(projectId, scopeId, undoLastCommit);
	}
	discard(projectId: string, scopeId: string, untracked: string[]) {
		return this.write(projectId, scopeId, (path) => discardChanges(path, untracked));
	}
}
