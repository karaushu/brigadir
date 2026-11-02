import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, ProcessCoordinator } from '@brigadir/persistence';
import { gitText } from '@brigadir/git';
import { ScopeLocks } from '@brigadir/host/client';
import { LaunchSettingsStore } from './launch-settings';
import { LaunchLocks } from './launch-locks';
it('offers explicit choices before launch, persists blocking owners, consumes one override and can isolate an unused task', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-locks-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		await gitText(repo, ['init', '-b', 'main']);
		await writeFile(join(repo, 'file'), 'base');
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			settings = new LaunchSettingsStore(store.root),
			launch = { ...(await settings.read(project.id)), branch: '', baseRef: 'main' },
			a = await store.createTask(project.id, 'A', 'claude', 'gui', 'New task', 'queued', launch),
			b = await store.createTask(project.id, 'B', 'claude', 'gui', 'New task', 'queued', launch),
			services = resolve('apps/desktop/out/services');
		const registry = new ScopeLocks(store, new ProcessCoordinator(join(services, 'process-owner'))),
			owner = await registry.owner(a);
		await registry.claim(owner, [repo]);
		const events: unknown[] = [],
			locks = new LaunchLocks(
				store.root,
				services,
				() => {},
				(value) => {
					events.push(value);
				}
			);
		expect(await locks.check(b, false)).toBe('queue');
		expect((await store.task(b)).blockedBy).toEqual([{ projectId: a.projectId, id: a.id }]);
		const cancelled = locks.check(b, true);
		await expect.poll(() => locks.conflict).not.toBeNull();
		expect(locks.conflict?.scopes[0]?.owners[0]?.title).toBe('A');
		locks.cancel();
		expect(await cancelled).toBe('cancel');
		expect((await store.task(b)).blockedBy).toEqual([]);
		expect(locks.conflict).toBeNull();
		const override = locks.check(b, true);
		await expect.poll(() => locks.conflict).not.toBeNull();
		locks.resolve(locks.conflict!.id, 'override');
		expect(await override).toBe('ready');
		expect(await locks.check(b, false)).toBe('ready');
		expect(locks.takeOverride(b)).toBe(true);
		expect(locks.takeOverride(b)).toBe(false);
		expect(await locks.check(b, false)).toBe('queue');
		const isolated = locks.check(b, true);
		await expect.poll(() => locks.conflict).not.toBeNull();
		expect(locks.conflict?.canIsolate).toBe(true);
		locks.resolve(locks.conflict!.id, 'worktree');
		expect(await isolated).toBe('ready');
		expect((await store.task(b)).launch).toMatchObject({
			isolation: 'worktree',
			baseRef: 'main',
			branch: expect.stringMatching(/^brigadir\//),
		});
		expect(await locks.check(b, false)).toBe('ready');
		expect(await registry.snapshot()).toHaveLength(1);
		expect(locks.conflict).toBeNull();
		expect(() => locks.resolve('expired', 'override')).toThrow('no longer pending');
		await registry.release(owner);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
