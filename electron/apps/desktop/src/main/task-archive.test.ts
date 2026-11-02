import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import type { ArchiveAfterDays, TaskKey } from '@brigadir/core';
import { TaskArchives } from './task-archive';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const day = 86_400_000;
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-archive-'));
	roots.push(root);
	const data = join(root, 'data');
	const store = await SessionStore.at(data),
		project = await store.addProject(root);
	const make = async (
		title: string,
		status: 'done' | 'completed' | 'working' | 'backlog' | 'interrupted',
		worktree = false
	) => {
		const task = await store.createTask(
			project.id,
			title,
			'claude',
			'gui',
			'New task',
			status === 'backlog' ? 'backlog' : 'queued',
			worktree
				? {
						isolation: 'worktree',
						branch: `task/${title.toLowerCase()}`,
						baseRef: 'HEAD',
						setupCommand: '',
						scopes: [],
					}
				: undefined
		);
		if (status !== 'backlog') await store.setStatus(task, status);
		if (worktree)
			await store.updateTask(task, {
				preparation: { state: 'ready', step: 'ready' },
				worktreeBranch: `task/${title.toLowerCase()}`,
			});
		return task;
	};
	let now = Date.parse('2026-10-06T12:00:00Z'),
		days: ArchiveAfterDays = 7;
	const dirty = new Map<string, number>();
	const queued = new Set<string>();
	const deps = {
		dataDir: data,
		stop: vi.fn(async (_key: TaskKey) => {}),
		isQueued: (key: TaskKey) => queued.has(key.id),
		uncommitted: vi.fn(async (key: TaskKey) => {
			const task = await store.task(key);
			return task.preparation ? (dirty.get(key.id) ?? 0) : null;
		}),
		removeWorktree: vi.fn(async (key: TaskKey) => {
			await store.clearPreparation(key);
		}),
		changed: vi.fn(),
		days: () => days,
		now: () => now,
	};
	return {
		store,
		make,
		deps,
		archives: new TaskArchives(deps),
		dirty,
		queued,
		setNow: (value: number) => {
			now = value;
		},
		setDays: (value: ArchiveAfterDays) => {
			days = value;
		},
	};
}
it('archives a stopped task, removes a clean worktree, keeps a dirty one with its count, and restores the status (spec/tasks#archive)', async () => {
	const { store, make, deps, archives, dirty } = await setup();
	const clean = await make('Clean', 'done', true),
		messy = await make('Messy', 'interrupted', true),
		plain = await make('Plain', 'backlog');
	dirty.set(messy.id, 3);
	expect(await archives.archive(clean)).toMatchObject({
		by: 'manual',
		status: 'done',
		worktree: 'removed',
	});
	expect(deps.stop).toHaveBeenCalledWith(expect.objectContaining({ id: clean.id }));
	expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
	expect((await store.task(clean)).preparation).toBeUndefined();
	expect(await archives.archive(messy)).toMatchObject({
		status: 'interrupted',
		worktree: 'kept',
		uncommitted: 3,
	});
	expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
	expect((await store.task(messy)).preparation).toEqual({ state: 'ready', step: 'ready' });
	expect(await archives.archive(plain)).toMatchObject({ status: 'backlog', worktree: 'none' });
	await store.setStatus(clean, 'interrupted');
	await archives.restore(clean);
	const back = await store.task(clean);
	expect(back.archived).toBeUndefined();
	expect(back.status).toBe('done');
	await expect(archives.archive(messy)).rejects.toThrow();
});
it('refuses a task whose agent works or that waits to launch, and takes the crew along', async () => {
	const { store, make, archives, queued } = await setup();
	const busy = await make('Busy', 'working');
	await expect(archives.archive(busy)).rejects.toThrow('while its agent works');
	expect(await archives.can(busy)).toBe(false);
	const waiting = await make('Waiting', 'done');
	queued.add(waiting.id);
	expect(await archives.can(waiting)).toBe(false);
	const foreman = await make('Foreman', 'done'),
		worker = await make('Worker', 'done');
	await store.updateTask(worker, {
		crewTaskId: foreman.id,
		crewNodeId: 'node',
		parentTaskId: foreman.id,
	});
	await store.setStatus(worker, 'working');
	expect(await archives.can(foreman)).toBe(false);
	await store.setStatus(worker, 'done');
	await archives.archive(foreman);
	expect((await store.task(worker)).archived).toMatchObject({ status: 'done' });
	await archives.restore(foreman);
	expect((await store.task(worker)).archived).toBeUndefined();
});
it('auto-archives completed tasks after N days, stamping old ones first, and never with Never', async () => {
	const { store, make, archives, setNow, setDays } = await setup();
	const old = await make('Old', 'completed'),
		pinned = await make('Pinned', 'completed'),
		stopped = await make('Stopped', 'interrupted');
	await store.updateTask(pinned, {});
	const legacy = await make('Legacy', 'completed');
	// A task completed before spec/tasks#archive has no completedAt: the first pass stamps it with now and leaves it.
	const path = join(await store.taskDir(legacy), 'task.json');
	const fs = await import('node:fs/promises');
	const doc = JSON.parse(await fs.readFile(path, 'utf8'));
	delete doc.task.completedAt;
	await fs.writeFile(path, JSON.stringify(doc));
	const doc2 = JSON.parse(
		await fs.readFile(join(await store.taskDir(pinned), 'task.json'), 'utf8')
	);
	doc2.task.pinned = true;
	await fs.writeFile(join(await store.taskDir(pinned), 'task.json'), JSON.stringify(doc2));
	const completedAt = Date.parse((await store.task(old)).completedAt!);
	setNow(completedAt + 6 * day);
	expect(await archives.autoArchive()).toEqual([]);
	expect((await store.task(legacy)).completedAt).toBe(
		new Date(completedAt + 6 * day).toISOString()
	);
	setNow(completedAt + 7 * day + 1);
	expect((await archives.autoArchive()).map((key) => key.id)).toEqual([old.id]);
	expect((await store.task(old)).archived).toMatchObject({ by: 'auto', status: 'completed' });
	expect((await store.task(pinned)).archived).toBeUndefined();
	expect((await store.task(stopped)).archived).toBeUndefined();
	setDays(null);
	setNow(completedAt + 60 * day);
	expect(await archives.autoArchive()).toEqual([]);
	setDays(30);
	expect((await archives.autoArchive()).map((key) => key.id)).toEqual([legacy.id]);
});
