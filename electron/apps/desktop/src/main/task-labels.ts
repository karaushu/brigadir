import { lstat, mkdir } from 'node:fs/promises';
import {
	isId,
	isRecord,
	isTaskTitle,
	type AgentTask,
	type TaskKey,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { SessionStore, safePath, readDocument, atomicJson } from '@brigadir/persistence';
type Label = { title?: string; pinned?: boolean };
type Labels = Record<string, Label>;
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
/** User labels are main-owned: a live host may update task.json at any moment. */
export class TaskLabels {
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private cached: { identity: string; labels: Labels } | null = null;
	constructor(private dataDir?: string) {}
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.tail;
	}
	async read(): Promise<Labels> {
		const store = await SessionStore.at(this.dataDir),
			path = await safePath(store.root, 'task-labels.json');
		try {
			const stat = await lstat(path);
			if (!stat.isFile()) throw new Error('Invalid task labels');
			const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
			if (this.cached?.identity === identity) return this.cached.labels;
			const doc = await readDocument(path);
			if (
				!isRecord(doc.labels) ||
				Object.keys(doc.labels).length > 10000 ||
				!Object.entries(doc.labels).every(
					([id, label]) =>
						id.split('/').length === 2 &&
						id.split('/').every(isId) &&
						isRecord(label) &&
						Object.keys(label).every((key) => key === 'title' || key === 'pinned') &&
						(label.title === undefined || isTaskTitle(label.title)) &&
						(label.pinned === undefined || typeof label.pinned === 'boolean')
				)
			)
				throw new Error('Invalid task labels');
			const labels = doc.labels as Labels;
			this.cached = { identity, labels };
			return labels;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') {
				this.cached = null;
				return {};
			}
			throw error;
		}
	}
	async task(task: AgentTask): Promise<AgentTask> {
		const label = (await this.read())[name(task)];
		return { ...task, ...label };
	}
	async title(key: TaskKey, fallback: string) {
		return (await this.read())[name(key)]?.title ?? fallback;
	}
	async decorate(workspace: WorkspaceSnapshot) {
		try {
			const labels = await this.read();
			workspace.tasks = workspace.tasks.map((task) => ({ ...task, ...labels[name(task)] }));
		} catch {
			workspace.issues.push({ path: 'task-labels.json', code: 'unreadable' });
		}
		return workspace;
	}
	rename(key: TaskKey, title: string) {
		if (!isTaskTitle(title)) throw new Error('Invalid task title');
		return this.save(key, { title: title.trim() });
	}
	pin(key: TaskKey, pinned: boolean) {
		return this.save(key, { pinned });
	}
	private save(key: TaskKey, patch: Label) {
		this.pending++;
		const work = this.tail
			.catch(() => {})
			.then(async () => {
				const store = await SessionStore.at(this.dataDir);
				await store.task(key);
				const labels = await this.read(),
					next = { ...labels, [name(key)]: { ...labels[name(key)], ...patch } },
					doc = { schemaVersion: 1, labels: next };
				if (
					Object.keys(next).length > 10000 ||
					Buffer.byteLength(JSON.stringify(doc, null, 2)) > 1024 * 1024 - 1
				)
					throw new Error('Task labels are full');
				await mkdir(store.root, { recursive: true, mode: 0o700 });
				await atomicJson(await safePath(store.root, 'task-labels.json'), doc);
				this.cached = null;
			})
			.finally(() => this.pending--);
		this.tail = work.catch(() => {});
		return work;
	}
}
