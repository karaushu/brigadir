import { lstat } from 'node:fs/promises';
import {
	changeBaseOf,
	inTask,
	isRecord,
	snapshotHasChanges,
	type AgentTask,
	type DiffBase,
	type TaskKey,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { SessionStore, safePath } from '@brigadir/persistence';
import { readSnapshots, snapshotTotals, headTree } from '@brigadir/git';
type Summary = Pick<AgentTask, 'hasUnreviewedChanges' | 'changeSummary' | 'taskTree'>;
/** One stat/task on refresh. Changed snapshots use bounded numstat; unchanged histories run no Git. */
export class TaskDiffs {
	private cache = new Map<string, { identity: string; summary: Summary }>();
	private pending = new Map<string, Promise<Summary>>();
	/** spec/diff-and-review#diff-base: under a HEAD base a commit changes the totals without a new snapshot, so the key carries each HEAD. */
	diffBase: DiffBase = 'task';
	constructor(private dataDir?: string) {}
	private read(store: SessionStore, key: TaskKey) {
		const id = `${key.projectId}/${key.id}`,
			pending = this.pending.get(id);
		if (pending) return pending;
		const work = (async () => {
			const path = await safePath(await store.taskDir(key), 'snapshots.json');
			let stat;
			try {
				stat = await lstat(path);
			} catch (error) {
				if (isRecord(error) && error.code === 'ENOENT') {
					this.cache.delete(id);
					return { hasUnreviewedChanges: false };
				}
				throw error;
			}
			if (!stat.isFile()) throw new Error('Invalid snapshots');
			const head = this.diffBase === 'head',
				document = head ? await readSnapshots(store, key) : null,
				heads = document
					? await Promise.all(
							document.scopes
								.filter((scope) => inTask(scope) && scope.available !== false)
								.map(async (scope) => (await headTree(scope))?.commit ?? '-')
						)
					: [];
			const task = await store.task(key),
				identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${this.diffBase}:${heads.join(',')}:${task.changeBase ?? 0}`,
				cached = this.cache.get(id);
			if (cached?.identity === identity) return cached.summary;
			const snapshotDocument = document ?? (await readSnapshots(store, key)),
				from = changeBaseOf(snapshotDocument, task.changeBase),
				root =
					snapshotDocument?.scopes.find(
						(scope) => scope.available !== false && scope.kind === 'root'
					) ??
					snapshotDocument?.scopes.find((scope) => scope.available !== false) ??
					snapshotDocument?.scopes.find((scope) => scope.kind === 'root'),
				// spec/tasks#agent-worktrees: the last added checkout of the root's repo from outside stands for the root.
				standIn = root
					? task.launch?.scopes
							.filter((choice) => choice.selected && choice.worktreeOf === root.id)
							.map((choice) =>
								snapshotDocument?.scopes.find(
									(scope) => scope.id === choice.id && scope.available !== false
								)
							)
							.findLast(Boolean)
					: undefined,
				totals =
					snapshotDocument && (head || snapshotHasChanges(snapshotDocument, from))
						? await snapshotTotals(snapshotDocument, head ? 'head' : undefined, from)
						: { additions: 0, deletions: 0, files: 0 };
			const summary: Summary = {
				hasUnreviewedChanges: totals.files > 0,
				...(snapshotDocument?.checkpoints.length
					? { changeSummary: { additions: totals.additions, deletions: totals.deletions } }
					: {}),
				...(root
					? {
							taskTree: standIn
								? { branch: standIn.branch, worktree: true, scopeId: standIn.id }
								: {
										branch: root.branch,
										worktree: task.launch?.isolation === 'worktree' || root.kind === 'worktree',
									},
						}
					: {}),
			};
			this.cache.delete(id);
			this.cache.set(id, { identity, summary });
			while (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
			return summary;
		})();
		this.pending.set(id, work);
		void work.finally(() => this.pending.delete(id)).catch(() => {});
		return work;
	}
	async decorate(workspace: WorkspaceSnapshot) {
		const store = await SessionStore.at(this.dataDir);
		let index = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, workspace.tasks.length) }, async () => {
				while (index < workspace.tasks.length) {
					const task = workspace.tasks[index++]!;
					try {
						delete task.hasUnreviewedChanges;
						delete task.changeSummary;
						delete task.taskTree;
						Object.assign(task, await this.read(store, task));
					} catch {
						delete task.hasUnreviewedChanges;
						delete task.changeSummary;
						workspace.issues.push({
							path: `projects/${task.projectId}/tasks/${task.id}/snapshots.json`,
							code: 'unreadable',
						});
					}
				}
			})
		);
		return workspace;
	}
}
