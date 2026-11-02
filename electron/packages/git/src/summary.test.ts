import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { git, Snapshots, readChanges, snapshotTotals } from './index';
test('totals immutable snapshots, counts binary changes, handles renames and never double-counts nested scopes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-stat-'));
	try {
		const repo = join(root, 'repo'),
			nested = join(repo, 'nested');
		await mkdir(nested, { recursive: true });
		await git(repo, ['init', '-b', 'main']);
		await git(nested, ['init', '-b', 'main']);
		await writeFile(join(repo, 'root.txt'), 'one\ntwo\n');
		await writeFile(join(nested, 'child.txt'), 'before\n');
		await writeFile(join(repo, 'binary'), Buffer.from([0, 1]));
		await git(repo, ['add', 'root.txt', 'binary']);
		const index = await readFile(join(repo, '.git/index'));
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Totals', 'claude'),
			snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		expect(await snapshotTotals(snapshots.current)).toEqual({
			additions: 0,
			deletions: 0,
			files: 0,
		});
		await writeFile(join(repo, 'binary'), Buffer.from([0, 2]));
		await snapshots.capture('turn');
		expect(await snapshotTotals(snapshots.current)).toEqual({
			additions: 0,
			deletions: 0,
			files: 1,
		});
		await chmod(join(repo, 'root.txt'), 0o755);
		await snapshots.capture('turn');
		expect(await snapshotTotals(snapshots.current)).toEqual({
			additions: 0,
			deletions: 0,
			files: 2,
		});
		await writeFile(join(repo, 'root.txt'), 'one\nchanged\nextra\n');
		await writeFile(join(nested, 'child.txt'), 'before\nnew\n');
		await writeFile(join(repo, 'binary'), Buffer.from([0, 2, 3]));
		await snapshots.capture('turn');
		const files = (await readChanges(store, task)).files;
		expect(await snapshotTotals(snapshots.current)).toEqual({
			additions: files.reduce((n, f) => n + f.additions, 0),
			deletions: files.reduce((n, f) => n + f.deletions, 0),
			files: files.length,
		});
		expect(await readFile(join(repo, '.git/index'))).toEqual(index);
		const child = snapshots.current.scopes.find((scope) => scope.name === 'nested')!;
		await snapshots.setScope({ id: child.id, selected: false });
		const hidden = await snapshotTotals(snapshots.current);
		expect(hidden.additions).toBe(2);
		expect(hidden.deletions).toBe(1);
		await rename(join(repo, 'root.txt'), join(repo, 'renamed\tfile.txt'));
		await snapshots.capture('turn');
		const renamed = await snapshotTotals(snapshots.current),
			actual = (await readChanges(store, task)).files;
		expect(renamed).toEqual({
			additions: actual.reduce((n, f) => n + f.additions, 0),
			deletions: actual.reduce((n, f) => n + f.deletions, 0),
			files: actual.length,
		});
		await writeFile(join(repo, 'root.txt'), 'not snapshotted\n');
		expect(await snapshotTotals(snapshots.current)).toEqual(renamed);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
