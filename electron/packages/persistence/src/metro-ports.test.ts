import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMetroPort, forgetMetroPort, metroPortFor, readMetroPorts } from './metro-ports';
import type { SessionStore } from './session';
const key = (id: string) => ({ projectId: 'project', id });
const slowFree = async () => {
	// A probe takes a while, as listening on a port does: two allocators overlap here without the lock.
	await new Promise((resolve) => setTimeout(resolve, 20));
	return true;
};
it("hands concurrent hosts different ports and keeps each task's port (spec/browser-and-simulator#metro-port)", async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-ports-'));
	try {
		const ports = await Promise.all(
			['a', 'b', 'c', 'd'].map((id) => metroPortFor(root, key(id), `/w/${id}`, { free: slowFree }))
		);
		expect(new Set(ports).size).toBe(4);
		expect([...ports].sort()).toEqual([8082, 8083, 8084, 8085]);
		expect(await metroPortFor(root, key('b'), '/w/b', { free: slowFree })).toBe(ports[1]);
		expect(await readMetroPorts(root)).toEqual({
			'project/a': ports[0],
			'project/b': ports[1],
			'project/c': ports[2],
			'project/d': ports[3],
		});
		await forgetMetroPort(root, key('a'));
		expect((await readMetroPorts(root))['project/a']).toBeUndefined();
		// A lock left by a host that died goes after 15 s.
		await writeFile(join(root, 'metro-ports.lock'), '');
		const old = new Date(Date.now() - 60_000);
		await utimes(join(root, 'metro-ports.lock'), old, old);
		expect(await metroPortFor(root, key('e'), '/w/e', { free: async () => true })).toBe(8082);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it("gives a crew worker's host its own port over the one it inherited from its foreman (spec/browser-and-simulator#metro-port)", async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-ports-'));
	const store = { root } as SessionStore;
	const trees: Record<string, string | null> = {
		foreman: '/w/foreman',
		worker: '/w/worker',
		inplace: null,
	};
	const worktree = async (task: { id: string }) => trees[task.id] ?? null;
	try {
		// The foreman's host takes its port; its environment is what it starts a worker's host with.
		const foreman: NodeJS.ProcessEnv = { PATH: '/bin' };
		const own = await applyMetroPort(store, key('foreman'), foreman, {
			worktree,
			free: async () => true,
		});
		expect(foreman.RCT_METRO_PORT).toBe(String(own));
		const worker = { ...foreman };
		const port = await applyMetroPort(store, key('worker'), worker, {
			worktree,
			free: async () => true,
		});
		expect(port).not.toBe(own);
		expect(worker.RCT_METRO_PORT).toBe(String(port));
		// A worker in the project folder drops the foreman's port; the person's own variable stays.
		const inplace = { ...foreman };
		expect(await applyMetroPort(store, key('inplace'), inplace, { worktree })).toBe(null);
		expect(inplace.RCT_METRO_PORT).toBeUndefined();
		const person: NodeJS.ProcessEnv = { RCT_METRO_PORT: '9000' };
		await applyMetroPort(store, key('inplace'), person, { worktree });
		expect(person.RCT_METRO_PORT).toBe('9000');
		expect(JSON.parse(await readFile(join(root, 'metro-ports.json'), 'utf8')).ports).toEqual({
			'project/foreman': own,
			'project/worker': port,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
