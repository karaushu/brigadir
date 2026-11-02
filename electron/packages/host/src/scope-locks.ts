import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isRecord, isTaskKey, type TaskKey } from '@brigadir/core';
import {
	atomicJson,
	readDocument,
	safePath,
	type ProcessCoordinator,
	type SessionStore,
} from '@brigadir/persistence';

export type ScopeOwner = { key: TaskKey; pid: number; processStart: string; instance: string };
export type ScopeLock = { path: string; owner: ScopeOwner; acquiredAt: string };
type ProcessAccess = Pick<ProcessCoordinator, 'identity' | 'transaction'>;
const sameOwner = (a: ScopeOwner, b: ScopeOwner) =>
	a.pid === b.pid &&
	a.processStart === b.processStart &&
	a.instance === b.instance &&
	a.key.id === b.key.id &&
	a.key.projectId === b.key.projectId;
function isOwner(value: unknown): value is ScopeOwner {
	return (
		isRecord(value) &&
		isTaskKey(value.key) &&
		Number.isSafeInteger(value.pid) &&
		Number(value.pid) > 0 &&
		typeof value.processStart === 'string' &&
		/^[-a-f0-9:]{3,100}$/.test(value.processStart) &&
		typeof value.instance === 'string' &&
		/^[a-f0-9-]{36}$/.test(value.instance)
	);
}
function isLock(value: unknown): value is ScopeLock {
	return (
		isRecord(value) &&
		typeof value.path === 'string' &&
		isAbsolute(value.path) &&
		!value.path.includes('\0') &&
		isOwner(value.owner) &&
		typeof value.acquiredAt === 'string' &&
		Number.isFinite(Date.parse(value.acquiredAt))
	);
}

/** Shared across projects: importing one physical scope twice does not evade its lock. */
export class ScopeLocks {
	constructor(
		private store: SessionStore,
		private processes: ProcessAccess
	) {}
	async owner(key: TaskKey): Promise<ScopeOwner> {
		if (!isTaskKey(key)) throw new Error('Invalid task key');
		const processStart = await this.processes.identity(process.pid);
		if (!processStart) throw new Error('The owning process is no longer running');
		return { key, pid: process.pid, processStart, instance: randomUUID() };
	}
	/** Empty scopes deliberately claim nothing, as for an isolated task. */
	async claim(
		owner: ScopeOwner,
		scopePaths: string[],
		allowConflict = false
	): Promise<{ acquired: boolean; conflicts: ScopeLock[] }> {
		if (!isOwner(owner) || scopePaths.length > 512 || scopePaths.some((path) => !isAbsolute(path)))
			throw new Error('Invalid repo claim');
		// Resolve aliases before entering the registry, so paths cannot create separate locks.
		const paths = [...new Set(await Promise.all(scopePaths.map((path) => realpath(path))))].sort();
		return this.change<{ acquired: boolean; conflicts: ScopeLock[] }>(async (locks) => {
			if ((await this.processes.identity(owner.pid)) !== owner.processStart)
				throw new Error('The owning process is no longer running');
			const conflicts = locks.filter(
				(lock) => paths.includes(lock.path) && !sameOwner(lock.owner, owner)
			);
			if (conflicts.length && !allowConflict)
				return { locks, result: { acquired: false, conflicts } };
			const previous = new Map(
				locks.filter((lock) => sameOwner(lock.owner, owner)).map((lock) => [lock.path, lock])
			);
			const acquiredAt = new Date().toISOString();
			return {
				locks: [
					...locks.filter((lock) => !sameOwner(lock.owner, owner)),
					...paths.map((path) => previous.get(path) ?? { path, owner, acquiredAt }),
				],
				result: { acquired: true, conflicts },
			};
		});
	}
	release(owner: ScopeOwner): Promise<void> {
		if (!isOwner(owner)) throw new Error('Invalid repo owner');
		return this.change(async (locks) => ({
			locks: locks.filter((lock) => !sameOwner(lock.owner, owner)),
			result: undefined,
		}));
	}
	snapshot(): Promise<ScopeLock[]> {
		return this.change(async (locks) => ({ locks, result: locks }));
	}
	private async change<T>(
		operation: (locks: ScopeLock[]) => Promise<{ locks: ScopeLock[]; result: T }>
	): Promise<T> {
		const dir = await safePath(this.store.root, 'run');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const guard = await safePath(dir, 'scope-locks.guard'),
			path = await safePath(this.store.root, 'scope-locks.json');
		return this.processes.transaction(guard, async () => {
			let doc: Record<string, unknown> = { schemaVersion: 1, locks: [] };
			try {
				doc = await readDocument(path, 2 * 1024 * 1024);
			} catch (error) {
				if (!isRecord(error) || error.code !== 'ENOENT') throw error;
			}
			if (!Array.isArray(doc.locks) || doc.locks.length > 8192 || !doc.locks.every(isLock))
				throw new Error('Invalid repo locks');
			const original = doc.locks as ScopeLock[],
				identities = new Map<number, string | null>();
			for (const lock of original)
				if (!identities.has(lock.owner.pid))
					identities.set(lock.owner.pid, await this.processes.identity(lock.owner.pid));
			const alive = original.filter(
				(lock) => identities.get(lock.owner.pid) === lock.owner.processStart
			);
			const { locks, result } = await operation(alive);
			if (locks.length > 8192) throw new Error('Too many repo locks');
			if (JSON.stringify(locks) !== JSON.stringify(original)) {
				const next = { ...doc, locks };
				if (Buffer.byteLength(JSON.stringify(next, null, 2)) > 2 * 1024 * 1024)
					throw new Error('Repo locks exceed their storage limit');
				await atomicJson(path, next);
			}
			return result;
		});
	}
}
