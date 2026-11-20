import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * spec/browser-and-simulator#metro-port: two allocators that find the same stale lock at once. Both read it as stale; the second one's removal
 * comes after the first already took a fresh lock. Only one may hold the lock.
 */
const lock = { path: '', stats: 0, unlinks: 0, release: () => {} };
const barrier = new Promise<void>((resolve) => {
	lock.release = resolve;
});
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return {
		...fs,
		stat: (async (...args: Parameters<typeof fs.stat>) => {
			if (args[0] === lock.path && lock.stats < 2) {
				// Both allocators read the stale lock before either acts on it.
				if (++lock.stats === 2) lock.release();
				const info = await fs.stat(...args);
				await barrier;
				return info;
			}
			return fs.stat(...args);
		}) as typeof fs.stat,
		unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
			// The second removal of the lock file is late: the first allocator holds a fresh lock by then.
			if (path === lock.path && ++lock.unlinks === 2)
				await new Promise((resolve) => setTimeout(resolve, 100));
			return fs.unlink(path);
		},
	};
});
const { metroPortFor } = await import('./metro-ports');

it('two allocators that find a stale lock at once never both hold it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-ports-lock-'));
	try {
		lock.path = join(root, 'metro-ports.lock');
		await writeFile(lock.path, '');
		const old = new Date(Date.now() - 60_000);
		await utimes(lock.path, old, old);
		let active = 0,
			most = 0;
		const free = async () => {
			most = Math.max(most, ++active);
			await new Promise((resolve) => setTimeout(resolve, 300));
			active--;
			return true;
		};
		const key = (id: string) => ({ projectId: 'project', id });
		const ports = await Promise.all(
			['a', 'b'].map((id) => metroPortFor(root, key(id), `/w/${id}`, { free }))
		);
		expect(most).toBe(1);
		expect(new Set(ports).size).toBe(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
