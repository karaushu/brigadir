import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * spec/browser-and-simulator#metro-port: allocators that find the same stale lock at once. They all read it as stale before any of them acts;
 * the later ones' removals come after the first already holds a fresh lock. Only one may hold the lock at a time.
 */
const lock = {
	path: '',
	readers: 2,
	stats: 0,
	unlinks: 0,
	renames: 0,
	release: () => {},
	barrier: Promise.resolve(),
	/** The second removal of the lock file (unlink or rename) and every link back are late by this long. */
	late: 100,
};
beforeEach(() => {
	Object.assign(lock, { stats: 0, unlinks: 0, renames: 0 });
	lock.barrier = new Promise<void>((resolve) => {
		lock.release = resolve;
	});
});
const later = () => new Promise((resolve) => setTimeout(resolve, lock.late));
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return {
		...fs,
		stat: (async (...args: Parameters<typeof fs.stat>) => {
			if (args[0] === lock.path && lock.stats < lock.readers) {
				// Every allocator reads the stale lock before any of them acts on it.
				if (++lock.stats === lock.readers) lock.release();
				const info = await fs.stat(...args);
				await lock.barrier;
				return info;
			}
			return fs.stat(...args);
		}) as typeof fs.stat,
		unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
			if (path === lock.path && ++lock.unlinks === 2) await later();
			return fs.unlink(path);
		},
		rename: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
			if (from === lock.path && ++lock.renames === 2) await later();
			return fs.rename(from, to);
		},
		link: async (from: Parameters<typeof fs.link>[0], to: Parameters<typeof fs.link>[1]) => {
			await later();
			return fs.link(from, to);
		},
	};
});
const { metroPortFor } = await import('./metro-ports');

async function race(count: number) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-ports-lock-'));
	try {
		lock.path = join(root, 'metro-ports.lock');
		lock.readers = count;
		await writeFile(lock.path, '');
		const old = new Date(Date.now() - 60_000);
		await utimes(lock.path, old, old);
		let active = 0,
			most = 0;
		const free = async () => {
			most = Math.max(most, ++active);
			await new Promise((resolve) => setTimeout(resolve, 400));
			active--;
			return true;
		};
		const key = (id: string) => ({ projectId: 'project', id });
		const ports = await Promise.all(
			['a', 'b', 'c'].slice(0, count).map((id) => metroPortFor(root, key(id), `/w/${id}`, { free }))
		);
		return { most, ports: new Set(ports).size };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
it('two allocators that find a stale lock at once never both hold it', async () => {
	expect(await race(2)).toEqual({ most: 1, ports: 2 });
}, 20_000);
it('a third allocator cannot slip in while a fresh lock taken by mistake is put back', async () => {
	expect(await race(3)).toEqual({ most: 1, ports: 3 });
}, 20_000);
