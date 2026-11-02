import { mkdir } from 'node:fs/promises';
import { isId, isRecord, type TaskKey } from '@brigadir/core';
import { SessionStore, readDocument, safePath, atomicJson } from '@brigadir/persistence';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
/** Read watermarks live outside host-owned task.json, avoiding cross-process lost updates. A streaming visible task
 *  writes them at most every 2 s (two full fsyncs each, perf review IO-02); quit flushes the rest. */
export class TaskReads {
	private loading: Promise<Record<string, number>> | null = null;
	private writes: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending = 0;
	constructor(private dataDir?: string) {}
	get isSaving() {
		return this.timer !== null || this.pending > 0;
	}
	read() {
		return (this.loading ??= this.disk());
	}
	private async disk(): Promise<Record<string, number>> {
		const store = await SessionStore.at(this.dataDir);
		try {
			const doc = await readDocument(await safePath(store.root, 'task-reads.json'));
			if (
				!isRecord(doc.seen) ||
				!Object.entries(doc.seen).every(
					([key, seq]) =>
						key.split('/').length === 2 &&
						key.split('/').every(isId) &&
						Number.isSafeInteger(seq) &&
						(seq as number) >= 0
				)
			)
				throw new Error('Invalid task read state');
			return doc.seen as Record<string, number>;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return {};
			throw error;
		}
	}
	async mark(key: TaskKey, seq: number) {
		if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid sequence');
		const seen = await this.read(),
			id = name(key);
		if ((seen[id] ?? 0) >= seq) return;
		seen[id] = seq;
		if (!this.timer)
			this.timer = setTimeout(() => {
				void this.flush().catch(() => {});
			}, 2000);
	}
	private flush() {
		if (!this.timer) return this.writes;
		clearTimeout(this.timer);
		this.timer = null;
		this.pending++;
		const next = this.writes
			.catch(() => {})
			.then(async () => {
				const store = await SessionStore.at(this.dataDir),
					seen = { ...(await this.read()) };
				await this.disk();
				await mkdir(store.root, { recursive: true, mode: 0o700 });
				await atomicJson(await safePath(store.root, 'task-reads.json'), { schemaVersion: 1, seen });
			})
			.finally(() => this.pending--);
		this.writes = next;
		return next;
	}
	waitForWrites() {
		return this.flush();
	}
}
