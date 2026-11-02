import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import {
	git,
	gitText,
	optionalLocksOff,
	Snapshots,
	publishState,
	previewCommits,
	commitPreview,
	statusFiles,
	unmergedPaths,
	unmergedNames,
	hasUnmergedPaths,
	mergedCleanly,
	discoverScopes,
} from './index';
import { monorepo, initRepo } from './monorepo.fixture';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** A rewritten index has a new inode or mtime: git writes it through index.lock and rename. */
const identity = async (path: string) => {
	const s = await stat(path, { bigint: true });
	return `${s.ino}:${s.mtimeNs}:${s.size}`;
};
it('marks only commands that never write the user repo, plus anything on a private index (GIT-10)', () => {
	for (const args of [
		['status', '--porcelain'],
		['diff', 'a', 'b'],
		['ls-files', '-u', '-z'],
		['--literal-pathspecs', 'ls-files'],
		['rev-parse', 'HEAD'],
		['log', '--shortstat'],
		['cat-file', '--batch'],
		['diff-tree', '-r', 'a', 'b'],
		['for-each-ref'],
		['check-ignore', '-z', '--stdin'],
		['merge-tree', '--write-tree', 'a', 'b'],
	])
		expect(optionalLocksOff(args)).toBe(true);
	// Every command the app uses to write a user repo keeps git's default, even though git would still take its mandatory lock.
	for (const args of [
		['add', '-A', '--pathspec-from-file=-'],
		['--literal-pathspecs', 'add', '-A'],
		['commit', '-q', '--file=-'],
		['merge', '--no-ff'],
		['checkout', '--ours', '--', 'x'],
		['switch', '-c', 'b'],
		['branch', '-m', 'b'],
		['update-ref', 'r', 'c'],
		['commit-tree', 't'],
		['read-tree', 'HEAD'],
		['write-tree'],
		['push', '--porcelain'],
		['config', 'k', 'v'],
		['worktree', 'add'],
		['fetch', '--quiet'],
		['symbolic-ref', '--short', '-q', 'HEAD'],
		['hash-object', '-w', '--stdin'],
		['-c', 'protocol.file.allow=always', 'submodule', 'add'],
	])
		expect(optionalLocksOff(args)).toBe(false);
	for (const args of [
		['read-tree', 'HEAD'],
		['add', '-A'],
		['write-tree'],
		['--literal-pathspecs', 'add', '-f'],
	])
		expect(optionalLocksOff(args, { GIT_INDEX_FILE: '/tmp/index' })).toBe(true);
});
it('leaves the user index and every submodule index untouched while reading status, merges, commits and snapshots (GIT-10)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-locks-'));
	roots.push(dir);
	const m = await monorepo(dir, 40);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(m.repo),
		task = await store.createTask(project.id, 'Locks', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const scopes = snapshots.current.scopes,
		root = scopes.find((scope) => scope.kind === 'root')!;
	const indexes = [
		join(m.repo, '.git/index'),
		join(m.repo, '.git/modules/kit/index'),
		join(m.repo, '.git/modules/skills/index'),
	];
	// Stat-dirty but content-clean files: exactly what makes git refresh (and rewrite) an index opportunistically.
	const touch = async () => {
		let n = 0;
		for (const path of [
			join(m.repo, 'd1/f1.txt'),
			join(m.kit, 'd0/f0.txt'),
			join(m.skills, 'd0/f0.txt'),
		]) {
			const at = new Date(Date.now() + 60_000 + ++n * 1000 + Math.floor(Math.random() * 1000));
			await utimes(path, at, at);
		}
	};
	// Reproduction: git's default status rewrites the root index and, through its child status, each submodule index.
	await touch();
	const unguarded = await Promise.all(indexes.map(identity));
	await git(m.repo, ['status', '--porcelain'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
	(await Promise.all(indexes.map(identity))).forEach((value, i) =>
		expect(value).not.toBe(unguarded[i])
	);
	for (const read of [
		() => publishState(root, scopes, 'main'),
		() => statusFiles(root, scopes),
		() => previewCommits(scopes, snapshots.current, true),
		() => unmergedPaths(root),
		() => hasUnmergedPaths(m.repo),
		() => mergedCleanly(root, []),
		async () => {
			await writeFile(join(m.repo, 'd2/f2.txt'), `${Math.random()}\n`);
			await snapshots.capture('turn');
		},
	]) {
		await touch();
		const before = await Promise.all(indexes.map(identity));
		await read();
		expect(await Promise.all(indexes.map(identity))).toEqual(before);
	}
	// A commit still stages into and rewrites the user index: writes never get the flag.
	await writeFile(join(m.repo, 'd3/f3.txt'), 'committed\n');
	const fresh = await discoverScopes(m.repo),
		preview = await previewCommits(fresh);
	const before = await identity(indexes[0]!),
		result = await commitPreview(preview, fresh, 'Commit');
	expect(result.error).toBeNull();
	expect(await identity(indexes[0]!)).not.toBe(before);
	expect(await gitText(m.repo, ['show', 'HEAD:d3/f3.txt'])).toBe('committed');
	// Even when forced, the flag does not stop a required write.
	await writeFile(join(m.repo, 'd4/f4.txt'), 'staged\n');
	await git(m.repo, ['add', 'd4/f4.txt'], { env: { GIT_OPTIONAL_LOCKS: '0' } });
	expect(await gitText(m.repo, ['diff', '--cached', '--name-only'])).toBe('d4/f4.txt');
}, 60000);
it('lists unmerged paths exactly as diff --diff-filter=U did (GIT-10)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-unmerged-'));
	roots.push(dir);
	const repo = join(dir, 'repo');
	await initRepo(repo, 3);
	const names = ['d0/f0.txt', 'd1/sp ace\tand\nnewline.txt', 'd2/β.txt'],
		write = async (label: string) => {
			for (const name of names) await writeFile(join(repo, name), `${label} ${name}\n`);
			await gitText(repo, ['add', '-A']);
			await gitText(repo, ['commit', '-qm', label]);
		};
	await write('base');
	await gitText(repo, ['switch', '-q', '-c', 'other']);
	await write('other');
	await gitText(repo, ['switch', '-q', 'main']);
	await write('main');
	await git(repo, ['merge', 'other']).catch(() => {});
	const reference = (await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z']))
		.toString('utf8')
		.split('\0')
		.filter(Boolean);
	expect(reference).toHaveLength(3);
	expect(await unmergedNames(repo)).toEqual(reference);
	expect(await hasUnmergedPaths(repo)).toBe(true);
});
