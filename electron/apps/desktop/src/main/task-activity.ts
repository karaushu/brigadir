import { lstat } from 'node:fs/promises';
import {
	isRecord,
	taskActivity,
	type TaskActivity as Activity,
	type AgentTask,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { SessionStore, safePath } from '@brigadir/persistence';
import { journalTail } from './journal-tail';
export class TaskActivities {
	private cache = new Map<string, { identity: string; activity: Activity | null }>();
	constructor(private dataDir?: string) {}
	private async read(store: SessionStore, task: AgentTask) {
		const id = `${task.projectId}/${task.id}`;
		if (!['working', 'needs-you'].includes(task.status)) {
			this.cache.delete(id);
			return null;
		}
		const path = await safePath(await store.taskDir(task), 'events.jsonl');
		let stat;
		try {
			stat = await lstat(path);
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
		if (!stat.isFile()) throw new Error('Invalid journal');
		const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
			cached = this.cache.get(id);
		let activity =
			cached?.identity === identity
				? cached.activity
				: taskActivity(await journalTail(store, task));
		this.cache.delete(id);
		this.cache.set(id, { identity, activity });
		while (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
		if (
			(task.status === 'needs-you' && activity?.kind === 'tool') ||
			(task.status === 'working' && activity?.kind !== 'tool')
		)
			activity = null;
		return activity;
	}
	async decorate(workspace: WorkspaceSnapshot) {
		const store = await SessionStore.at(this.dataDir);
		let index = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, workspace.tasks.length) }, async () => {
				while (index < workspace.tasks.length) {
					const task = workspace.tasks[index++]!;
					try {
						task.activity = await this.read(store, task);
					} catch {
						task.activity = null;
						workspace.issues.push({
							path: `projects/${task.projectId}/tasks/${task.id}/events.jsonl`,
							code: 'unreadable',
						});
					}
				}
			})
		);
		return workspace;
	}
}
