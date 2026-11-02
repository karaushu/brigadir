import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod, rename, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ChangedFile, Scope } from '@brigadir/core';
import { SessionStore } from '@brigadir/persistence';
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			if (command === 'git') spawned.git.push(args);
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, gitText, changedFiles, readChanges, readSnapshots, snapshotTotals, Snapshots } =
	await import('./index');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repo() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-changes-'));
	roots.push(root);
	const path = join(root, 'repo');
	await mkdir(path);
	await git(path, ['init', '-q']);
	await git(path, ['config', 'user.name', 'Fixture']);
	await git(path, ['config', 'user.email', 'fixture@localhost']);
	return { root, path };
}
const tree = async (path: string) => {
	await git(path, ['add', '-A']);
	return gitText(path, ['write-tree']);
};
/** The two-process parser before GIT-05, kept verbatim as the reference for byte-identical results. */
async function legacy(scope: Scope, before: string, after: string): Promise<ChangedFile[]> {
	const zero = (sha: string) => (/^0+$/.test(sha) ? null : sha);
	const common = ['diff-tree', '-r', '-M', '-C', '--no-commit-id', '--no-abbrev', before, after];
	const [rawBytes, numBytes] = await Promise.all([
		git(scope.path, [...common, '--raw', '-z']),
		git(scope.path, [...common, '--numstat', '-z']),
	]);
	const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
	const num = numBytes.toString('utf8').split('\0');
	for (let i = 0; i < num.length - 1; i++) {
		const entry = num[i]!;
		const first = entry.indexOf('\t'),
			second = entry.indexOf('\t', first + 1);
		if (first < 0 || second < 0) throw new Error('Invalid Git numstat');
		const added = entry.slice(0, first),
			removed = entry.slice(first + 1, second);
		let oldPath = entry.slice(second + 1),
			path = oldPath;
		if (!path) {
			oldPath = num[++i]!;
			path = num[++i]!;
		}
		stats.set(`${oldPath}\0${path}`, {
			additions: added === '-' ? 0 : Number(added),
			deletions: removed === '-' ? 0 : Number(removed),
			binary: added === '-' || removed === '-',
		});
	}
	const raw = rawBytes.toString('utf8').split('\0');
	const files: ChangedFile[] = [];
	for (let i = 0; i < raw.length - 1; i++) {
		const header = raw[i]!;
		const match = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z]\d*)$/.exec(header);
		if (!match) throw new Error('Invalid Git raw diff');
		const oldPath = raw[++i]!;
		const status = match[5]!;
		const path = /^[RC]/.test(status) ? raw[++i]! : oldPath;
		const counts = stats.get(`${oldPath}\0${path}`);
		if (!counts) throw new Error('Missing file counts');
		files.push({
			id: createHash('sha256')
				.update(
					`${scope.id}\0${oldPath}\0${path}\0${match[1]}\0${match[2]}\0${match[3]}\0${match[4]}`
				)
				.digest('hex'),
			scopeId: scope.id,
			path,
			oldPath,
			status,
			beforeMode: match[1]!,
			afterMode: match[2]!,
			before: zero(match[3]!),
			after: zero(match[4]!),
			...counts,
			gitlink: match[1] === '160000' || match[2] === '160000',
			generated: /(?:^|\/)(?:pnpm-lock.yaml|package-lock.json|yarn.lock)$|\.tsbuildinfo$/.test(
				path
			),
		});
	}
	return files;
}
it('parses one raw+numstat diff-tree byte-identically to the two-process parser and caches immutable tree pairs', async () => {
	const { root, path } = await repo(),
		scope: Scope = {
			id: '0123456789abcdef',
			path,
			name: '.',
			kind: 'root',
			branch: null,
			selected: true,
		};
	const body = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
	await writeFile(join(path, 'rename me.txt'), body);
	await writeFile(join(path, 'copy source.ts'), body.repeat(3));
	await writeFile(join(path, 'tab\tname.txt'), 'x\n');
	await writeFile(join(path, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
	await writeFile(join(path, 'mode.sh'), 'echo\n');
	await writeFile(join(path, 'gone.txt'), 'bye\n');
	await writeFile(join(path, 'pnpm-lock.yaml'), 'a: 1\n');
	const child = join(root, 'child');
	await mkdir(child);
	await git(child, ['init', '-q']);
	await writeFile(join(child, 'c'), '1');
	await git(child, ['add', '-A']);
	await git(child, ['-c', 'user.name=F', '-c', 'user.email=f@l', 'commit', '-qm', 'c']);
	await git(path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'kit']);
	const first = await tree(path);
	await rename(join(path, 'rename me.txt'), join(path, 'renamed\nwith newline.txt'));
	await appendFile(join(path, 'renamed\nwith newline.txt'), 'more\n');
	await writeFile(join(path, 'copy target.ts'), body.repeat(3) + 'tail\n');
	await appendFile(join(path, 'copy source.ts'), 'source edit\n');
	await writeFile(join(path, 'tab\tname.txt'), 'y\nz\n');
	await writeFile(join(path, 'binary.bin'), Buffer.from([0, 9, 9]));
	await chmod(join(path, 'mode.sh'), 0o755);
	await rm(join(path, 'gone.txt'));
	await writeFile(join(path, 'новий файл.md'), 'привіт\n');
	await writeFile(join(path, 'pnpm-lock.yaml'), 'a: 2\n');
	await writeFile(join(child, 'c'), '2');
	await git(child, ['-c', 'user.name=F', '-c', 'user.email=f@l', 'commit', '-qam', 'c2']);
	await git(join(path, 'kit'), [
		'-c',
		'protocol.file.allow=always',
		'pull',
		'-q',
		'origin',
		'HEAD',
	]);
	const second = await tree(path);
	for (const [before, after] of [
		[first, second],
		[second, first],
		[first, first],
	] as const) {
		const expected = await legacy(scope, before, after);
		spawned.git.length = 0;
		const actual = await changedFiles(scope, before, after);
		expect(spawned.git.filter((args) => args.includes('diff-tree'))).toHaveLength(1);
		expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
		spawned.git.length = 0;
		const again = await changedFiles(scope, before, after);
		expect(spawned.git).toHaveLength(0);
		expect(JSON.stringify(again)).toBe(JSON.stringify(expected));
		// Callers get copies: mutating one result never leaks into the cache.
		if (again[0]) {
			again[0].path = 'mutated';
			expect((await changedFiles(scope, before, after))[0]!.path).toBe(expected[0]!.path);
		}
	}
	const statuses = (await changedFiles(scope, first, second))
		.map((file) => file.status[0])
		.sort()
		.join('');
	expect(statuses).toContain('R');
	expect(statuses).toContain('C');
	expect(statuses).toContain('D');
	expect(statuses).toContain('A');
	expect(statuses).toContain('M');
	expect((await changedFiles(scope, first, second)).some((file) => file.gitlink)).toBe(true);
	await expect(changedFiles(scope, 'HEAD', second)).rejects.toThrow('Invalid tree');
	await expect(changedFiles(scope, '0'.repeat(40), second)).rejects.toThrow();
}, 30000);
it('compares HEAD with the latest snapshot under the last-commit base and keeps the task base as it was (spec/diff-and-review#diff-base)', async () => {
	const { root, path } = await repo();
	await writeFile(join(path, 'a.txt'), 'a\n');
	await git(path, ['add', '-A']);
	await git(path, ['commit', '-qm', 'a']);
	// Before the task: an edit and a new file nobody committed.
	await writeFile(join(path, 'a.txt'), 'a2\n');
	await writeFile(join(path, 'before.txt'), 'pre\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(path),
		task = await store.createTask(project.id, 'Base', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await writeFile(join(path, 'a.txt'), 'a3\n');
	await writeFile(join(path, 'new.txt'), 'n\n');
	await snapshots.capture('turn');
	const doc = await readSnapshots(store, task),
		scope = doc!.scopes.find((scope) => scope.kind === 'root')!,
		head = (await gitText(path, ['rev-parse', 'HEAD'])).trim();
	expect((await readChanges(store, task)).files.map((file) => file.path).sort()).toEqual([
		'a.txt',
		'new.txt',
	]);
	const uncommitted = await readChanges(store, task, 'head');
	expect(uncommitted.files.map((file) => file.path).sort()).toEqual([
		'a.txt',
		'before.txt',
		'new.txt',
	]);
	expect(uncommitted.heads).toEqual({ [scope.id]: head });
	expect(await snapshotTotals(doc!, 'head')).toEqual({ additions: 3, deletions: 1, files: 3 });
	expect(await snapshotTotals(doc!)).toEqual({ additions: 2, deletions: 1, files: 2 });
	// A commit empties the last-commit view without a new snapshot; the task view does not move.
	await git(path, ['add', '-A']);
	await git(path, ['commit', '-qm', 'all']);
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect((await readChanges(store, task, 'head')).files).toEqual([]);
	expect(await snapshotTotals(doc!, 'head')).toEqual({ additions: 0, deletions: 0, files: 0 });
	expect((await readChanges(store, task)).files.map((file) => file.path).sort()).toEqual([
		'a.txt',
		'new.txt',
	]);
});
it('treats a repo without commits as all new under the last-commit base (spec/diff-and-review#diff-base)', async () => {
	const { root, path } = await repo();
	await writeFile(join(path, 'a.txt'), 'a\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(path),
		task = await store.createTask(project.id, 'Empty', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const changes = await readChanges(store, task, 'head');
	expect(changes.files.map((file) => [file.path, file.status])).toEqual([['a.txt', 'A']]);
	expect(Object.values(changes.heads!)).toEqual([null]);
});
it('reads unchanged task changes again without spawning git', async () => {
	const { root, path } = await repo();
	await writeFile(join(path, 'a.txt'), 'a\n');
	await git(path, ['add', '-A']);
	await git(path, ['commit', '-qm', 'a']);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(path),
		task = await store.createTask(project.id, 'Changes', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await writeFile(join(path, 'a.txt'), 'b\n');
	await snapshots.capture('turn');
	spawned.git.length = 0;
	const first = await readChanges(store, task);
	const count = spawned.git.length;
	spawned.git.length = 0;
	const second = await readChanges(store, task);
	expect(count).toBe(1);
	expect(spawned.git).toHaveLength(0);
	expect(second).toEqual(first);
	expect(first.files.map((file) => file.path)).toEqual(['a.txt']);
});
