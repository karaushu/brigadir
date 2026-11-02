import { SessionStore, readWorkspace } from '@brigadir/persistence';
import {
	autoArchiveDue,
	canArchive,
	taskDescendants,
	unstampedCompleted,
	type AgentTask,
	type ArchiveAfterDays,
	type TaskArchive,
	type TaskKey,
} from '@brigadir/core';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
export type TaskArchivesDeps = {
	dataDir?: string | undefined;
	/** The tasks as the sidebar reads them: a `working` task whose host is gone reads `interrupted` (`sessions.workspace()`). */
	tasks?(): Promise<AgentTask[]>;
	/** Stops the host, its terminals and the task's browser (`stopForRemoval`). */
	stop(key: TaskKey): Promise<void>;
	isQueued(key: TaskKey): boolean;
	/** Uncommitted files in the task's worktree; null without one (spec/tasks#delete-task). */
	uncommitted(key: TaskKey): Promise<number | null>;
	/** The same removal as «Remove worktree…»: the branch stays, `worktree-released.json` is written (spec/tasks#delete-task). */
	removeWorktree(key: TaskKey): Promise<void>;
	changed(key: TaskKey): void;
	days(): ArchiveAfterDays;
	now?(): number;
};
export const autoArchiveIntervalMs = 3_600_000;
/**
 * spec/tasks#archive: archive and restore, by hand and by the auto-archive timer. Archiving never deletes: the journal, snapshots
 * and drafts stay, a clean worktree goes the «Remove worktree…» way, a dirty one stays with its count.
 */
export class TaskArchives {
	private busy = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private pass: Promise<TaskKey[]> | null = null;
	constructor(private deps: TaskArchivesDeps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private async tasks() {
		return this.deps.tasks
			? this.deps.tasks()
			: (await readWorkspace(this.deps.dataDir ? { dataDir: this.deps.dataDir } : {})).tasks;
	}
	/** Whether the menu may offer Archive for this task now. */
	async can(key: TaskKey) {
		const all = await this.tasks(),
			task = all.find((item) => item.projectId === key.projectId && item.id === key.id);
		return !!task && canArchive(task, all, (item) => this.deps.isQueued(item));
	}
	async archive(key: TaskKey, by: TaskArchive['by'] = 'manual'): Promise<TaskArchive> {
		if (this.busy.has(name(key))) throw new Error('The task is being archived');
		this.busy.add(name(key));
		try {
			const store = await SessionStore.at(this.deps.dataDir),
				all = await this.tasks(),
				task =
					all.find((item) => item.projectId === key.projectId && item.id === key.id) ??
					(await store.task(key));
			if (!canArchive(task, all, (item) => this.deps.isQueued(item)))
				throw new Error('The task cannot go to the archive while its agent works');
			const tasks: AgentTask[] = [
					task,
					...taskDescendants(task, all).filter((item) => !item.archived),
				],
				at = new Date(this.now()).toISOString();
			// Statuses as they were before the hosts stop: Restore puts these back.
			const statuses = new Map(tasks.map((item) => [name(item), item.status]));
			for (const item of tasks) await this.deps.stop(item);
			let root: TaskArchive | undefined;
			for (const item of tasks) {
				const current = await store.task(item);
				let worktree: TaskArchive['worktree'] = 'none',
					uncommitted: number | undefined;
				if (current.launch?.isolation === 'worktree' && current.preparation) {
					const count = await this.deps.uncommitted(item).catch(() => null);
					if (count === 0) {
						await this.deps.removeWorktree(item);
						worktree = 'removed';
					} else if (count !== null) {
						worktree = 'kept';
						uncommitted = count;
					}
				}
				const record: TaskArchive = {
					at,
					by,
					status: statuses.get(name(item)) ?? current.status,
					worktree,
					...(uncommitted !== undefined ? { uncommitted } : {}),
				};
				await store.archive(item, record);
				this.deps.changed(item);
				if (item === task) root = record;
			}
			return root!;
		} finally {
			this.busy.delete(name(key));
		}
	}
	/** spec/tasks#archive: the task and the tasks under it leave the archive with the statuses they had. */
	async restore(key: TaskKey): Promise<void> {
		const store = await SessionStore.at(this.deps.dataDir),
			all = await this.tasks(),
			task = await store.task(key);
		if (!task.archived) return;
		for (const item of [task, ...taskDescendants(task, all).filter((item) => item.archived)]) {
			await store.unarchive(item);
			this.deps.changed(item);
		}
	}
	/** One auto-archive pass: stamp completed tasks from before `completedAt`, then archive the due ones. Never overlaps. */
	autoArchive(): Promise<TaskKey[]> {
		if (this.pass) return this.pass;
		const run = (async () => {
			const days = this.deps.days();
			if (days === null) return [];
			const store = await SessionStore.at(this.deps.dataDir);
			let all = await this.tasks();
			const unstamped = unstampedCompleted(all);
			if (unstamped.length) {
				const at = new Date(this.now()).toISOString();
				for (const task of unstamped) await store.stampCompleted(task, at).catch(() => {});
				all = await this.tasks();
			}
			const done: TaskKey[] = [];
			for (const task of autoArchiveDue(all, days, this.now())) {
				try {
					await this.archive(task, 'auto');
					done.push({ projectId: task.projectId, id: task.id });
				} catch {
					/* busy now; the next pass tries again */
				}
			}
			return done;
		})();
		this.pass = run.finally(() => {
			this.pass = null;
		});
		return this.pass;
	}
	start(interval = autoArchiveIntervalMs) {
		void this.autoArchive().catch(() => {});
		this.timer = setInterval(() => {
			void this.autoArchive().catch(() => {});
		}, interval);
		this.timer.unref?.();
	}
	stop() {
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
