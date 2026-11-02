import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@brigadir/core';
import { SessionStore, readProjectFile } from '@brigadir/persistence';
const spawned = vi.hoisted(() => ({ git: [] as { cwd: string; args: string[] }[] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: { cwd: string }) => {
			if (command === 'git') spawned.git.push({ cwd: options.cwd, args });
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, Snapshots, readChanges } = await import('@brigadir/git');
const { saveTaskFile } = await import('./save-file');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function init(path: string) {
	await mkdir(path, { recursive: true });
	await git(path, ['init', '-q']);
	await git(path, ['config', 'user.name', 'Fixture']);
	await git(path, ['config', 'user.email', 'fixture@localhost']);
	await writeFile(join(path, 'file.txt'), 'base\n');
	await git(path, ['add', '-A']);
	await git(path, ['commit', '-qm', 'base']);
}
it('snapshots only the repo of an explicit write and keeps the other trees (GIT-03)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-save-'));
	roots.push(root);
	const repo = join(root, 'repo'),
		nested = join(repo, 'apps/admin');
	await init(repo);
	await writeFile(join(repo, '.gitignore'), 'apps/\n');
	await git(repo, ['add', '-A']);
	await git(repo, ['commit', '-qm', 'ignore']);
	await init(nested);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Save', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const [top, child] = ['.', 'apps/admin'].map((name) =>
		snapshots.current.scopes.find((scope) => scope.name === name)!
	);
	// tmpdir is a symlinked path on macOS; new directories may not exist yet.
	expect(await snapshots.scopesFor(join(repo, 'file.txt'))).toEqual([top!.id]);
	expect(await snapshots.scopesFor(join(nested, 'new/deep/file.ts'))).toEqual([child!.id]);
	expect(await snapshots.scopesFor(join(await realpath(nested), 'file.txt'))).toEqual([child!.id]);
	expect(await snapshots.scopesFor(join(root, 'outside.txt'))).toBeUndefined();
	expect(await snapshots.scopesFor('relative.txt')).toBeUndefined();
	await writeFile(join(nested, 'file.txt'), 'agent shell edit\n');
	const events: SessionEvent[] = [],
		current = await readProjectFile(repo, 'file.txt');
	spawned.git.length = 0;
	const saved = await saveTaskFile(
		store,
		task,
		snapshots,
		{ path: 'file.txt', expectedVersion: current.version, text: 'user save\n' },
		async (event) => {
			events.push(event);
		}
	);
	expect(saved.status).toBe('saved');
	expect(spawned.git.filter((call) => call.cwd === child!.path)).toEqual([]);
	expect(spawned.git.length).toBeGreaterThan(0);
	const [baseline, after] = [
		snapshots.current.checkpoints[0]!,
		snapshots.current.checkpoints.at(-1)!,
	];
	expect(after.reason).toBe('user-after');
	expect(after.trees.find((tree) => tree.scopeId === child!.id)).toEqual(
		baseline.trees.find((tree) => tree.scopeId === child!.id)
	);
	expect(events.at(-1)).toMatchObject({ kind: 'file.saved', path: 'file.txt', after: after.id });
	expect((await readChanges(store, task)).files.map((file) => file.path)).toEqual(['file.txt']);
	// The next full capture (turn end) picks up the other repo; refresh and baseline ignore scopeIds.
	await snapshots.capture('turn');
	expect(
		(await readChanges(store, task)).files
			.map((file) => `${file.scopeId === child!.id ? 'admin' : 'root'}/${file.path}`)
			.sort()
	).toEqual(['admin/file.txt', 'root/file.txt']);
	await writeFile(join(nested, 'file.txt'), 'again\n');
	spawned.git.length = 0;
	await snapshots.capture('refresh', { scopeIds: [top!.id] });
	expect(
		spawned.git.some((call) => call.cwd === child!.path && call.args.includes('write-tree'))
	).toBe(true);
}, 30000);
