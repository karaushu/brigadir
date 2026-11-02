import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	git,
	gitText,
	Snapshots,
	readChanges,
	readSnapshots,
	readBlobs,
	discoverScopes,
} from './index';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function init(path: string) {
	await mkdir(path, { recursive: true });
	await git(path, ['init', '-q']);
	await git(path, ['config', 'user.name', 'Fixture']);
	await git(path, ['config', 'user.email', 'fixture@localhost']);
}
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-git-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await init(repo);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Git test', 'claude');
	return { root, repo, store, task };
}
async function commit(repo: string) {
	await git(repo, ['add', '-A']);
	await git(repo, ['commit', '-qm', 'Fixture']);
}
it('keeps the user index and dirty baseline, survives agent commits, renames, binary files and gc', async () => {
	const { repo, store, task } = await setup();
	await writeFile(join(repo, 'tracked.txt'), 'HEAD\n');
	await writeFile(join(repo, 'old name\tfile.txt'), 'rename content\n'.repeat(20));
	await commit(repo);
	await writeFile(join(repo, '.gitignore'), 'tracked.txt\nignored.txt\n');
	await writeFile(join(repo, 'tracked.txt'), 'staged\n');
	await git(repo, ['add', '-f', 'tracked.txt']);
	await writeFile(join(repo, 'tracked.txt'), 'dirty baseline\n');
	await writeFile(join(repo, 'ignored.txt'), 'secret');
	const index = await readFile(join(repo, '.git/index'));
	const head = await gitText(repo, ['rev-parse', 'HEAD']);
	const snapshots = await Snapshots.open(store, task);
	const base = await snapshots.capture('baseline');
	expect(await readFile(join(repo, '.git/index'))).toEqual(index);
	expect(await gitText(repo, ['rev-parse', 'HEAD'])).toBe(head);
	expect(await snapshots.capture('refresh')).toEqual(base);
	expect(snapshots.current.checkpoints).toHaveLength(1);
	await writeFile(join(repo, 'tracked.txt'), 'agent changed\n');
	await rename(join(repo, 'old name\tfile.txt'), join(repo, 'new\nname.txt'));
	await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 2, 255]));
	await commit(repo);
	const agentIndex = await readFile(join(repo, '.git/index'));
	await snapshots.capture('turn');
	expect(await readFile(join(repo, '.git/index'))).toEqual(agentIndex);
	const changes = await readChanges(store, task);
	expect(changes.files).toHaveLength(3);
	expect(changes.files.some((f) => f.path === 'ignored.txt')).toBe(false);
	expect(changes.files.find((f) => f.status.startsWith('R'))?.oldPath).toBe('old name\tfile.txt');
	const tracked = changes.files.find((f) => f.path === 'tracked.txt')!;
	const scope = changes.scopes[0]!;
	const blobs = await readBlobs(scope, [tracked.before, tracked.after]);
	expect(blobs.map((b) => b.text)).toEqual(['dirty baseline\n', 'agent changed\n']);
	expect(changes.files.find((f) => f.path === 'binary.bin')?.binary).toBe(true);
	await git(repo, ['gc', '--prune=now']);
	expect((await readBlobs(scope, [tracked.before]))[0]?.text).toBe('dirty baseline\n');
	const reopened = await Snapshots.open(store, task);
	await Promise.all([reopened.capture('refresh'), reopened.capture('refresh')]);
	expect(reopened.current.checkpoints).toHaveLength(2);
}, 20000);
it('discovers ignored repositories and submodules, excludes linked worktrees and symlinks', async () => {
	const { repo, root, store, task } = await setup();
	await writeFile(join(repo, 'root.txt'), 'root');
	await writeFile(join(repo, '.gitignore'), 'apps/\nlinked/\n');
	await commit(repo);
	const nested = join(repo, 'apps/admin');
	await init(nested);
	await writeFile(join(nested, 'admin.txt'), 'admin');
	await commit(nested);
	const source = join(root, 'source');
	await init(source);
	await writeFile(join(source, 'kit.txt'), 'kit');
	await commit(source);
	await git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'kit']);
	await commit(repo);
	await git(repo, ['worktree', 'add', '-b', 'linked-fixture', join(repo, 'linked')]);
	await symlink(source, join(repo, 'alias'), 'dir');
	const scopes = await discoverScopes(repo);
	expect(scopes.map((s) => s.name)).toEqual(['.', 'apps/admin', 'kit']);
	expect(scopes.find((s) => s.name === 'kit')?.kind).toBe('submodule');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await writeFile(join(nested, 'admin.txt'), 'changed');
	await writeFile(join(repo, 'kit/kit.txt'), 'changed kit');
	await snapshots.capture('turn');
	const changes = await readChanges(store, task);
	expect(changes.files.map((f) => f.path).sort()).toEqual(['admin.txt', 'kit.txt']);
}, 20000);
it('supports unborn repos and non-Git projects and preserves unsupported or invalid metadata', async () => {
	const { repo, store, task, root } = await setup();
	await writeFile(join(repo, 'new.txt'), 'new');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	expect((await readChanges(store, task)).files).toEqual([]);
	const path = join(await store.taskDir(task), 'snapshots.json');
	const original = await readFile(path, 'utf8');
	const newer = { ...JSON.parse(original), schemaVersion: 2 };
	await atomicJson(path, newer);
	const bytes = await readFile(path);
	await expect(Snapshots.open(store, task)).rejects.toThrow();
	expect(await readFile(path)).toEqual(bytes);
	const invalid = JSON.parse(original);
	invalid.scopes[0].path = root;
	await atomicJson(path, invalid);
	await expect(readSnapshots(store, task)).rejects.toThrow('outside');
	const plain = join(root, 'plain');
	await mkdir(plain);
	const project = await store.addProject(plain);
	const plainTask = await store.createTask(project.id, 'Plain', 'claude');
	expect(await (await Snapshots.open(store, plainTask)).capture('baseline')).toBeNull();
});

it('captures force-added ignored files after baseline without changing their staging', async () => {
	const { repo, store, task } = await setup();
	await writeFile(join(repo, '.gitignore'), 'forced.txt\n');
	await commit(repo);
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await writeFile(join(repo, 'forced.txt'), 'new tracked file');
	await git(repo, ['add', '-f', 'forced.txt']);
	const index = await readFile(join(repo, '.git/index'));
	await snapshots.capture('turn');
	expect(await readFile(join(repo, '.git/index'))).toEqual(index);
	expect((await readChanges(store, task)).files.map((f) => f.path)).toEqual(['forced.txt']);
});

it('reports executable mode changes and avoids loading oversized blobs', async () => {
	const { chmod } = await import('node:fs/promises');
	const { repo, store, task } = await setup();
	await writeFile(join(repo, 'script.sh'), 'echo fixture\n');
	await commit(repo);
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await chmod(join(repo, 'script.sh'), 0o755);
	await writeFile(join(repo, 'large.txt'), 'a'.repeat(6 * 1024 * 1024));
	await snapshots.capture('turn');
	const changes = await readChanges(store, task);
	const mode = changes.files.find((f) => f.path === 'script.sh')!;
	expect([mode.beforeMode, mode.afterMode]).toEqual(['100644', '100755']);
	const large = changes.files.find((f) => f.path === 'large.txt')!;
	expect((await readBlobs(changes.scopes[0]!, [large.after]))[0]).toEqual({
		text: '',
		binary: false,
		tooLarge: true,
	});
});

it('refreshes nested scopes, gives them a first-seen baseline and keeps other repos readable when one disappears', async () => {
	const { repo, store, task } = await setup();
	await writeFile(join(repo, 'root.txt'), 'base\n');
	await writeFile(join(repo, '.gitignore'), 'apps/\n');
	await commit(repo);
	const index = await readFile(join(repo, '.git/index')),
		snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const nested = join(repo, 'apps/new.repo');
	await init(nested);
	await writeFile(join(nested, 'nested.txt'), 'first seen\n');
	await commit(nested);
	const nestedIndex = await readFile(join(nested, '.git/index'));
	await snapshots.capture('refresh');
	expect(snapshots.current.scopes.find((scope) => scope.name === 'apps/new.repo')?.selected).toBe(
		false
	);
	expect(snapshots.current.scopes.map((scope) => scope.name)).toEqual(['.', 'apps/new.repo']);
	expect(snapshots.current.checkpoints[0]!.trees).toHaveLength(1);
	// spec/projects-and-board#repo-selection: a newly discovered repo arrives unselected. The person adds it to the task, and
	// its diff then counts from that repo's first snapshot, not from the moment it was selected.
	await snapshots.setScope({
		id: snapshots.current.scopes.find((scope) => scope.name === 'apps/new.repo')!.id,
		selected: true,
	});
	expect((await readChanges(store, task)).files).toEqual([]);
	await writeFile(join(nested, 'nested.txt'), 'later\n');
	await writeFile(join(repo, 'root.txt'), 'root change\n');
	await snapshots.capture('turn');
	expect((await readChanges(store, task)).files.map((file) => file.path).sort()).toEqual([
		'nested.txt',
		'root.txt',
	]);
	expect((await readChanges(store, task, { base: 0, current: 0 })).files).toEqual([]);
	await rename(join(nested, '.git'), join(nested, '.saved-git'));
	await snapshots.capture('refresh');
	const changes = await readChanges(store, task);
	expect(changes.scopes.find((scope) => scope.name === 'apps/new.repo')?.available).toBe(false);
	expect(changes.files.map((file) => file.path)).toEqual(['root.txt']);
	await rename(join(nested, '.saved-git'), join(nested, '.git'));
	await snapshots.capture('refresh');
	expect((await readChanges(store, task)).files.map((file) => file.path).sort()).toEqual([
		'nested.txt',
		'root.txt',
	]);
	expect(await readFile(join(repo, '.git/index'))).toEqual(index);
	expect(await readFile(join(nested, '.git/index'))).toEqual(nestedIndex);
	await rm(join(nested, '.git'), { recursive: true });
	await init(nested);
	await snapshots.capture('refresh');
	expect(
		(await readChanges(store, task)).scopes.find((scope) => scope.name === 'apps/new.repo')
			?.available
	).toBe(false);
}, 20000);

it('watches repository topology and stops pending discovery on close', async () => {
	const { watchScopes } = await import('./watch-scopes');
	const { repo } = await setup();
	let count = 0;
	const close = watchScopes(repo, async () => {
		count++;
	});
	try {
		await init(join(repo, 'nested'));
		await expect.poll(() => count, { timeout: 10000 }).toBeGreaterThan(0);
	} finally {
		close();
	}
	const stopped = count;
	await init(join(repo, 'later'));
	await new Promise((resolve) => setTimeout(resolve, 1000));
	expect(count).toBe(stopped);
}, 15000);
it('discovers remote metadata without persisting URL credentials or query tokens', async () => {
	const { repo, store, task } = await setup();
	await writeFile(join(repo, 'file'), 'one');
	await commit(repo);
	await git(repo, [
		'remote',
		'add',
		'origin',
		'https://user:secret@example.invalid/team/repo.git?token=secret#private',
	]);
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	expect(snapshots.current.scopes[0]?.remote).toBe('https://example.invalid/team/repo.git');
	expect(await readFile(join(await store.taskDir(task), 'snapshots.json'), 'utf8')).not.toContain(
		'secret'
	);
	await git(repo, ['remote', 'set-url', 'origin', 'git@example.invalid:team/repo.git']);
	await snapshots.capture('refresh');
	expect((await readSnapshots(store, task))?.scopes[0]?.remote).toBe(
		'git@example.invalid:team/repo.git'
	);
});
it('reports read-only changes while excluding an explicitly writable child gitlink', async () => {
	const { repo, root, store, task } = await setup();
	await writeFile(join(repo, 'root.txt'), 'root');
	await commit(repo);
	const source = join(root, 'source');
	await init(source);
	await writeFile(join(source, 'child.txt'), 'before');
	await commit(source);
	await git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'child']);
	await commit(repo);
	const child = join(repo, 'child');
	await git(child, ['config', 'user.name', 'Fixture']);
	await git(child, ['config', 'user.email', 'fixture@example.invalid']);
	const snapshots = await Snapshots.open(store, task),
		before = await snapshots.capture('baseline');
	await writeFile(join(child, 'child.txt'), 'after');
	await commit(child);
	const after = await snapshots.capture('turn');
	const { readOnlyChanges } = await import('./readonly');
	const scopes = snapshots.current.scopes.map((scope) => ({
		...scope,
		selected: scope.kind !== 'root',
	}));
	expect(await readOnlyChanges(scopes, before ?? undefined, after)).toEqual([]);
	const allReadOnly = await readOnlyChanges(
		scopes.map((scope) => ({ ...scope, selected: false })),
		before ?? undefined,
		after
	);
	expect(allReadOnly.find((scope) => scope.name === 'child')?.paths).toEqual(['child.txt']);
	await writeFile(join(repo, 'root.txt'), 'root changed');
	const final = await snapshots.capture('turn');
	expect(
		(await readOnlyChanges(scopes, before ?? undefined, final)).map((scope) => ({
			name: scope.name,
			paths: scope.paths,
		}))
	).toEqual([{ name: '.', paths: ['root.txt'] }]);
}, 15000);
