import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { Snapshots, readChanges, git } from '@brigadir/git';
import { revertTaskFile } from './revert-file';
it('reverts to a selected checkpoint, rejects newer bytes and handles additions, deletions and renames', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-revert-')),
		repo = join(root, 'repo');
	await mkdir(repo);
	try {
		await git(repo, ['init', '-q']);
		await git(repo, ['config', 'user.name', 'Fixture']);
		await git(repo, ['config', 'user.email', 'fixture@localhost']);
		await writeFile(join(repo, 'a.txt'), 'committed\n');
		await git(repo, ['add', 'a.txt']);
		await git(repo, ['commit', '-qm', 'baseline']);
		const index = await readFile(join(repo, '.git/index'));
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Revert', 'claude');
		await writeFile(join(repo, 'a.txt'), 'preexisting human change\n');
		const snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		await writeFile(join(repo, 'a.txt'), 'agent change\n');
		await snapshots.capture('turn');
		const file = (await readChanges(store, task)).files[0]!;
		await writeFile(join(repo, 'a.txt'), 'newer human edit\n');
		await expect(
			revertTaskFile(store, task, snapshots, file.id, undefined, async () => {})
		).rejects.toThrow('changed after');
		expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('newer human edit\n');
		await writeFile(join(repo, 'a.txt'), 'agent change\n');
		await revertTaskFile(store, task, snapshots, file.id, undefined, async () => {});
		expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('preexisting human change\n');
		await writeFile(join(repo, 'added.txt'), 'new file\n');
		await snapshots.capture('turn');
		await revertTaskFile(
			store,
			task,
			snapshots,
			(await readChanges(store, task)).files.find((f) => f.path === 'added.txt')!.id,
			undefined,
			async () => {}
		);
		await expect(readFile(join(repo, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
		await unlink(join(repo, 'a.txt'));
		await snapshots.capture('turn');
		await revertTaskFile(
			store,
			task,
			snapshots,
			(await readChanges(store, task)).files[0]!.id,
			undefined,
			async () => {}
		);
		expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('preexisting human change\n');
		await rename(join(repo, 'a.txt'), join(repo, 'renamed.txt'));
		await snapshots.capture('turn');
		const moved = (await readChanges(store, task)).files[0]!;
		expect(moved.status).toMatch(/^R/);
		await revertTaskFile(store, task, snapshots, moved.id, undefined, async () => {});
		expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('preexisting human change\n');
		await expect(readFile(join(repo, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await readChanges(store, task, { base: 0, current: 1 })).files[0]!.id).toBe(file.id);
		expect(await readFile(join(repo, '.git/index'))).toEqual(index);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
