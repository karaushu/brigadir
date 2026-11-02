import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { listedInTask } from '@brigadir/core';
import { git, Snapshots, readSnapshots } from './index';
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
async function fixture() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-external-')));
	roots.push(dir);
	const repo = join(dir, 'couriers'),
		backend = join(dir, 'b2c'),
		notes = join(dir, 'notes');
	await init(repo);
	await init(backend);
	await mkdir(notes);
	await writeFile(join(notes, 'read.md'), 'context\n');
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Review', 'claude', 'gui', 'New task', 'queued', {
		isolation: 'in-place',
		branch: '',
		baseRef: 'origin/main',
		setupCommand: '',
		scopes: [
			{ id: '9240902625a8938c', name: '.', kind: 'root', selected: true },
			{ id: '8aa2182539d96de8', name: 'b2c', kind: 'external', path: backend, selected: true },
			{ id: 'bb431b6140a30433', name: 'notes', kind: 'folder', path: notes, selected: true },
		],
	});
	return { dir, backend, notes, store, task };
}
it('captures a baseline with a repo and a folder outside the project root (spec/projects-and-board#external-folders)', async () => {
	const { backend, store, task } = await fixture();
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const kinds = () =>
		snapshots.current.checkpoints
			.at(-1)!
			.trees.map(
				(tree) => snapshots.current.scopes.find((scope) => scope.id === tree.scopeId)!.kind
			)
			.sort();
	expect(kinds()).toEqual(['external', 'root']);
	await writeFile(join(backend, 'file.txt'), 'changed\n');
	expect((await snapshots.capture('turn'))?.trees.length).toBe(2);
	const read = await readSnapshots(store, task);
	expect(
		read!.scopes
			.filter((scope) => scope.kind === 'external' || scope.kind === 'folder')
			.map((scope) => [scope.kind, scope.available])
	).toEqual([
		['external', true],
		['folder', true],
	]);
	expect(read!.scopes.find((scope) => scope.kind === 'external')!.path).toBe(backend);
});
it('rejects an external repo whose path now resolves through a symlink', async () => {
	const { dir, backend, store, task } = await fixture();
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const moved = join(dir, 'moved');
	await rm(backend, { recursive: true });
	await init(moved);
	await symlink(moved, backend);
	await expect(readSnapshots(store, task)).rejects.toThrow('Repo is outside the project');
	await expect(snapshots.capture('turn')).rejects.toThrow('Repo is outside the project');
});
it('marks a removed folder unavailable without failing the task (spec/projects-and-board#external-folders)', async () => {
	const { notes, store, task } = await fixture();
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await rm(notes, { recursive: true });
	expect(
		(await readSnapshots(store, task))!.scopes.find((scope) => scope.kind === 'folder')!.available
	).toBe(false);
});
it('a folder from outside leaves the task once unchosen: no snapshot, no watch (spec/projects-and-board#external-folders)', async () => {
	const { backend, store, task } = await fixture();
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await snapshots.setScope({ id: '8aa2182539d96de8', selected: false });
	const scope = snapshots.current.scopes.find((item) => item.id === '8aa2182539d96de8')!;
	expect(scope.selected).toBe(false);
	expect(listedInTask(scope)).toBe(false);
	await writeFile(join(backend, 'file.txt'), 'changed\n');
	const root = snapshots.current.scopes.find((item) => item.kind === 'root')!.id;
	expect((await snapshots.capture('turn'))?.trees.map((tree) => tree.scopeId)).toEqual([root]);
	await snapshots.addScope({
		id: '8aa2182539d96de8',
		name: 'b2c',
		kind: 'external',
		path: backend,
		selected: true,
	});
	expect(
		listedInTask(snapshots.current.scopes.find((item) => item.id === '8aa2182539d96de8')!)
	).toBe(true);
});
