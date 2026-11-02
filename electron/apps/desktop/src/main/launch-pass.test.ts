import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, ProcessCoordinator } from '@brigadir/persistence';
import { gitText } from '@brigadir/git';
import { ScopeLocks } from '@brigadir/host/client';
const discovered = vi.hoisted(() => ({ count: 0 }));
vi.mock('@brigadir/git', async (original) => {
	const git = await original<typeof import('@brigadir/git')>();
	return {
		...git,
		discoverScopes: async (...args: Parameters<typeof git.discoverScopes>) => {
			discovered.count++;
			return git.discoverScopes(...args);
		},
	};
});
import { LaunchLocks } from './launch-locks';
it('a queue pass over blocked tasks discovers repos once instead of twice per task', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-pass-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		await gitText(repo, ['init', '-b', 'main']);
		await writeFile(join(repo, 'file'), 'base');
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			services = resolve('apps/desktop/out/services'),
			[a, ...blocked] = await Promise.all(
				['A', 'B', 'C', 'D'].map((title) => store.createTask(project.id, title, 'claude'))
			);
		const registry = new ScopeLocks(store, new ProcessCoordinator(join(services, 'process-owner'))),
			owner = await registry.owner(a!);
		await registry.claim(owner, [repo]);
		const locks = new LaunchLocks(
			store.root,
			services,
			() => {},
			() => {}
		);
		// Each blocked task must not run discoverScopes twice (check + scopes): 6 walks for three tasks every 3 s, ~0.6 s each on a large monorepo.
		const pass = {};
		for (const task of blocked) expect(await locks.check(task, false, pass)).toBe('queue');
		expect(discovered.count).toBe(1);
		expect(await locks.check(blocked[0]!, false)).toBe('queue');
		expect(discovered.count).toBe(2);
		expect((await store.task(blocked[2]!)).blockedBy).toEqual([
			{ projectId: a!.projectId, id: a!.id },
		]);
		await registry.release(owner);
		expect(await locks.check(blocked[0]!, false, {})).toBe('ready');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
