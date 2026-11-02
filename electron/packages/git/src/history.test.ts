import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			if (command === 'git') spawned.git.push(args.slice(6));
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, gitText, discoverScopes, branchHistory, parseLog, historyLogArgs, mergeHistory } =
	await import('./index');
const { initRepo } = await import('./monorepo.fixture');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** Reference uncached page: `log` from the branch name on every read. */
async function reference(path: string, ref: string, limit = 100) {
	const commits = parseLog(
		(
			await git(path, [
				'log',
				`--max-count=${limit + 1}`,
				'--format=\x1e%H\x1f%P\x1f%an\x1f%ct\x1f%s',
				'--shortstat',
				ref,
				'--',
			])
		).toString('utf8')
	);
	return { commits: commits.slice(0, limit), truncated: commits.length > limit };
}
it('reads a branch page once per tip commit and returns what log from the branch returned (GIT-14)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-history-')));
	roots.push(dir);
	const repo = join(dir, 'repo');
	await initRepo(repo, 4);
	for (let i = 0; i < 3; i++) {
		await writeFile(join(repo, `c${i}.txt`), `${i}\n`);
		await gitText(repo, ['add', '-A']);
		await gitText(repo, ['commit', '-qm', `Commit ${i}`]);
	}
	const [scope] = await discoverScopes(repo),
		logs = () => spawned.git.filter((args) => args[0] === 'log').length;
	spawned.git.length = 0;
	const first = await branchHistory(scope!, 'main');
	expect(logs()).toBe(1);
	expect(first).toEqual({
		scopeId: scope!.id,
		branch: 'main',
		...(await reference(repo, 'refs/heads/main')),
	});
	spawned.git.length = 0;
	expect(await branchHistory(scope!, 'main')).toEqual(first);
	expect(logs()).toBe(0);
	// A caller mutating its copy does not reach the cache.
	first.commits[0]!.parents.push('x');
	expect((await branchHistory(scope!, 'main')).commits[0]!.parents).not.toContain('x');
	await writeFile(join(repo, 'c9.txt'), '9\n');
	await gitText(repo, ['add', '-A']);
	await gitText(repo, ['commit', '-qm', 'Moved tip']);
	spawned.git.length = 0;
	const moved = await branchHistory(scope!, 'main', 2);
	expect(logs()).toBe(1);
	expect(moved).toEqual({
		scopeId: scope!.id,
		branch: 'main',
		...(await reference(repo, 'refs/heads/main', 2)),
	});
	expect(moved.truncated).toBe(true);
});

it('builds the search argv with the query as one literal, case-insensitive item (spec/git#history-search)', () => {
	const sha = 'a'.repeat(40);
	expect(historyLogArgs(sha, 100, undefined, { field: 'message', query: '-x [a.*' })).toEqual([
		'log',
		'--max-count=101',
		'--regexp-ignore-case',
		'--fixed-strings',
		'--grep=-x [a.*',
		'--format=\x1e%H\x1f%P\x1f%an\x1f%ct\x1f%s',
		'--shortstat',
		sha,
		'--',
	]);
	expect(historyLogArgs(sha, 100, 'src/a.ts', { field: 'author', query: 'Ann' })).toEqual([
		'--literal-pathspecs',
		'log',
		'--follow',
		'-M',
		'--max-count=101',
		'--regexp-ignore-case',
		'--fixed-strings',
		'--author=Ann',
		'--format=\x1e%H\x1f%P\x1f%an\x1f%ct\x1f%s',
		'--numstat',
		sha,
		'--',
		'src/a.ts',
	]);
	expect(historyLogArgs(sha, 2)).not.toContain('--fixed-strings');
});

it('merges the search passes by time, each commit once (spec/git#history-search)', () => {
	const commit = (sha: string, time: number) => ({
		sha,
		subject: sha,
		author: '',
		time,
		parents: [],
		files: 0,
	});
	expect(
		mergeHistory([
			[commit('c', 30), commit('a', 10)],
			[commit('d', 40), commit('c', 30), commit('b', 20)],
			[],
		]).map((item) => item.sha)
	).toEqual(['d', 'c', 'b', 'a']);
});

it('searches the whole history of the branch by message, author and SHA prefix (spec/git#history-search)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-history-search-')));
	roots.push(dir);
	const repo = join(dir, 'repo');
	await initRepo(repo, 1);
	await writeFile(join(repo, 'old.txt'), 'old\n');
	await gitText(repo, ['add', '-A']);
	await gitText(repo, ['commit', '-qm', 'Fix the [Parser] (old)']);
	const old = await gitText(repo, ['rev-parse', 'HEAD']);
	await gitText(repo, [
		'-c',
		'user.name=Olena Koval',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'Other',
	]);
	for (let i = 0; i < 4; i++)
		await gitText(repo, ['commit', '-q', '--allow-empty', '-m', `Filler ${i}`]);
	const [scope] = await discoverScopes(repo),
		subjects = async (path: string | undefined, query: string) =>
			(await branchHistory(scope!, 'main', 2, path, query)).commits.map((c) => c.subject);
	// The match lies past the first page: the search still finds it; regex characters are literal, case is ignored.
	const message = await branchHistory(scope!, 'main', 2, undefined, '[parser] (OLD');
	expect(message).toMatchObject({ query: '[parser] (OLD', truncated: false });
	expect(message.commits.map((commit) => commit.sha)).toEqual([old]);
	expect(message.commits[0]!.files).toBe(1);
	expect(await subjects(undefined, 'olena')).toEqual(['Other']);
	expect(await subjects(undefined, old.slice(0, 7))).toEqual(['Fix the [Parser] (old)']);
	const filler = await branchHistory(scope!, 'main', 2, undefined, 'filler');
	expect(filler.commits.map((c) => c.subject)).toEqual(['Filler 3', 'Filler 2']);
	expect(filler.truncated).toBe(true);
	expect(await subjects(undefined, '.*')).toEqual([]);
	// With a file filter only the commits of that file count, the SHA prefix too.
	expect(await subjects('old.txt', 'parser')).toEqual(['Fix the [Parser] (old)']);
	expect(await subjects('old.txt', old.slice(0, 7))).toEqual(['Fix the [Parser] (old)']);
	expect(await subjects('old.txt', 'olena')).toEqual([]);
});
