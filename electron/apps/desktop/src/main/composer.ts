import { unlink } from 'node:fs/promises';
import { isRecord, type TaskKey } from '@brigadir/core';
import { SessionStore, readDocument, safePath, atomicJson } from '@brigadir/persistence';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
type Pending = {
	key: TaskKey;
	text: string;
	timer: ReturnType<typeof setTimeout>;
	waiters: { resolve(): void; reject(reason: unknown): void }[];
};
export class ComposerDrafts {
	private pending = new Map<string, Pending>();
	private tails = new Map<string, Promise<void>>();
	constructor(
		private dataDir: string | undefined,
		private delay = 500
	) {}
	get isSaving() {
		return this.pending.size > 0 || this.tails.size > 0;
	}
	private async path(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		return safePath(await store.taskDir(key), 'composer.json');
	}
	private async disk(path: string): Promise<string | null> {
		try {
			const doc = await readDocument(path, 5 * 1024 * 1024);
			if (typeof doc.text !== 'string' || doc.text.length > 1_000_000)
				throw new Error('Invalid composer draft');
			return doc.text;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
	}
	async read(key: TaskKey) {
		const id = name(key),
			pending = this.pending.get(id);
		if (pending) return pending.text;
		await this.tails.get(id)?.catch(() => {});
		return this.disk(await this.path(key));
	}
	save(key: TaskKey, text: string): Promise<void> {
		if (text.length > 1_000_000 || Buffer.byteLength(JSON.stringify(text)) > 4 * 1024 * 1024)
			return Promise.reject(new Error('Composer draft is too large'));
		const id = name(key);
		let entry = this.pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			entry.text = text;
			entry.timer = setTimeout(() => this.flush(id), this.delay);
		} else {
			entry = { key, text, timer: setTimeout(() => this.flush(id), this.delay), waiters: [] };
			this.pending.set(id, entry);
		}
		const result = new Promise<void>((resolve, reject) => entry!.waiters.push({ resolve, reject }));
		if (entry.waiters.length >= 128) this.flush(id);
		return result;
	}
	private flush(id: string) {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		const next = (this.tails.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const path = await this.path(entry.key);
				await this.disk(path);
				if (entry.text) await atomicJson(path, { schemaVersion: 1, text: entry.text });
				else
					await unlink(path).catch((error) => {
						if (!isRecord(error) || error.code !== 'ENOENT') throw error;
					});
			});
		this.tails.set(id, next);
		void next
			.then(
				() => entry.waiters.forEach((waiter) => waiter.resolve()),
				(error) => entry.waiters.forEach((waiter) => waiter.reject(error))
			)
			.finally(() => {
				if (this.tails.get(id) === next) this.tails.delete(id);
			});
	}
	async waitForWrites() {
		for (const id of [...this.pending.keys()]) this.flush(id);
		await Promise.allSettled([...this.tails.values()]);
	}
}
