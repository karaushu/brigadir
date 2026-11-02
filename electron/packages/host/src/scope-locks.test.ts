import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProcessCoordinator, SessionStore } from '@brigadir/persistence';
import { ScopeLocks, type ScopeOwner } from './scope-locks';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const helper = resolve('apps/desktop/out/services/process-owner');
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-scope-locks-'));
	roots.push(root);
	const scope = join(root, 'repo');
	await mkdir(scope);
	const store = await SessionStore.at(join(root, 'data')),
		processes = new ProcessCoordinator(helper),
		locks = new ScopeLocks(store, processes);
	return { root, scope, store, processes, locks };
}
it('serializes competing claims, canonicalizes aliases and exposes contention only after an explicit override', async () => {
	const { root, scope, store, processes, locks } = await setup();
	const alias = join(root, 'alias');
	await symlink(scope, alias);
	const first = await locks.owner({ projectId: 'a', id: 'task' }),
		second = await locks.owner({ projectId: 'b', id: 'task' });
	const peer = new ScopeLocks(store, processes);
	const results = await Promise.all([locks.claim(first, [scope]), peer.claim(second, [alias])]);
	expect(results.filter((result) => result.acquired)).toHaveLength(1);
	const winner = results[0]!.acquired ? first : second,
		other = winner === first ? second : first;
	const original = (await locks.snapshot())[0]!;
	expect((await locks.claim(other, [scope])).conflicts).toEqual([original]);
	expect((await locks.claim(other, [scope], true)).acquired).toBe(true);
	expect(await locks.snapshot()).toHaveLength(2);
	await locks.claim(winner, [scope]);
	expect(
		(await locks.snapshot()).find((lock) => lock.owner.instance === winner.instance)!.acquiredAt
	).toBe(original.acquiredAt);
	await locks.release({ ...winner, instance: randomUUID() });
	expect(await locks.snapshot()).toHaveLength(2);
	await locks.release(winner);
	expect((await locks.snapshot()).map((lock) => lock.owner)).toEqual([other]);
	await locks.claim(other, []);
	expect(await locks.snapshot()).toEqual([]);
});
it('reclaims a reused PID by its kernel generation, retains live peers, and fails closed on unreadable identity', async () => {
	const { scope, store, processes } = await setup();
	let identity: string | null = '123:456';
	const locks = new ScopeLocks(store, {
		transaction: (path, work) => processes.transaction(path, work),
		identity: async () => identity,
	});
	const old = await locks.owner({ projectId: 'a', id: 'old' });
	await locks.claim(old, [scope]);
	identity = '123:457';
	expect(await locks.snapshot()).toEqual([]);
	await expect(locks.claim(old, [scope])).rejects.toThrow('no longer running');
	const current = await locks.owner({ projectId: 'a', id: 'current' });
	await locks.claim(current, [scope]);
	const failing = new ScopeLocks(store, {
		transaction: (path, work) => processes.transaction(path, work),
		identity: async () => {
			throw new Error('denied');
		},
	});
	const file = join(store.root, 'scope-locks.json'),
		before = await readFile(file, 'utf8');
	await expect(failing.snapshot()).rejects.toThrow('denied');
	expect(await readFile(file, 'utf8')).toBe(before);
	identity = null;
	expect(await locks.snapshot()).toEqual([]);
});
it('preserves corrupt or future documents and recovers the transaction guard after failure', async () => {
	const { scope, store, locks } = await setup();
	const owner = await locks.owner({ projectId: 'a', id: 'task' });
	await locks.claim(owner, [scope]);
	const file = join(store.root, 'scope-locks.json');
	for (const value of [
		'broken',
		JSON.stringify({ schemaVersion: 2, locks: [] }),
		JSON.stringify({ schemaVersion: 1, locks: [{}] }),
	]) {
		await writeFile(file, value);
		await expect(locks.snapshot()).rejects.toThrow();
		expect(await readFile(file, 'utf8')).toBe(value);
	}
	await writeFile(file, JSON.stringify({ schemaVersion: 1, locks: [] }));
	expect((await locks.claim(owner, [scope])).acquired).toBe(true);
});
it('a dead owner frees scopes, and kernel guards release on helper death without deleting the guard file', async () => {
	const { root, scope, locks, processes } = await setup();
	const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
	const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	try {
		const owner: ScopeOwner = {
			key: { projectId: 'a', id: 'child' },
			pid: child.pid!,
			processStart: (await processes.identity(child.pid!))!,
			instance: randomUUID(),
		};
		expect(owner.processStart).toBeTruthy();
		await locks.claim(owner, [scope]);
		child.kill();
		await stopped;
		expect(await processes.identity(owner.pid)).toBeNull();
		expect(await locks.snapshot()).toEqual([]);
		const path = join(root, 'guard'),
			guard = spawn(helper, ['guard', path], { stdio: ['pipe', 'pipe', 'ignore'] });
		await new Promise<void>((resolve, reject) => {
			guard.stdout.once('data', () => resolve());
			guard.once('error', reject);
		});
		const exited = new Promise<void>((resolve) => guard.once('exit', () => resolve()));
		guard.kill('SIGKILL');
		await exited;
		expect(await processes.transaction(path, async () => 42)).toBe(42);
		const target = join(root, 'target');
		await writeFile(target, 'untouched');
		const alias = join(root, 'unsafe');
		await symlink(target, alias);
		await expect(processes.transaction(alias, async () => false)).rejects.toThrow();
		expect(await readFile(target, 'utf8')).toBe('untouched');
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
			await stopped;
		}
	}
});
