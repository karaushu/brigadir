import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	blameFile,
	branchHistory,
	commitMessage,
	discoverScopes,
	gitText,
	numstatPath,
	parsePorcelain,
} from './index';
import { initRepo } from './monorepo.fixture';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repo() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-blame-')));
	roots.push(dir);
	const path = join(dir, 'repo');
	await initRepo(path, 1);
	return path;
}
const commit = async (path: string, message: string, author = 'Fixture') =>
	gitText(path, ['-c', `user.name=${author}`, 'commit', '-qm', message]);

it('parses porcelain: commit fields once per commit, the uncommitted zero sha, original line numbers (spec/editor#line-author)', () => {
	const sha = 'a'.repeat(40),
		zero = '0'.repeat(40);
	const text = [
		`${sha} 3 1 2`,
		'author Ada Lovelace',
		'author-mail <a@b>',
		'author-time 1700000000',
		'summary feat: first',
		'filename a.ts',
		'\tone',
		`${sha} 4 2`,
		'\ttwo',
		`${zero} 2 3 1`,
		'author Not Committed Yet',
		'author-time 1800000000',
		'summary Version of a.ts from a.ts',
		'filename a.ts',
		'\tthree',
		'',
	].join('\n');
	expect(parsePorcelain(text)).toEqual({
		commits: [{ sha, author: 'Ada Lovelace', time: 1_700_000_000_000, summary: 'feat: first' }],
		lines: [0, 0, -1],
		origins: [3, 4, 0],
	});
});

it('blames the file on disk in its own repo, marks uncommitted lines and a file with no commit', async () => {
	const path = await repo();
	await writeFile(join(path, 'a.ts'), 'one\ntwo\n');
	await gitText(path, ['add', 'a.ts']);
	await commit(path, 'feat: first\n\nWhy it exists.', 'Ada Lovelace');
	await writeFile(join(path, 'a.ts'), 'one\ntwo\nthree\n');
	await gitText(path, ['add', 'a.ts']);
	await commit(path, 'feat: third line', 'Olha Shevchenko');
	await writeFile(join(path, 'a.ts'), 'one\nTWO\nthree\n');
	const [scope] = await discoverScopes(path),
		blame = await blameFile(scope!, 'a.ts');
	if (blame === 'untracked') throw new Error('tracked');
	expect(blame.lines.map((index) => (index < 0 ? '-' : blame.commits[index]!.author))).toEqual([
		'Ada Lovelace',
		'-',
		'Olha Shevchenko',
	]);
	expect(blame.origins).toEqual([1, 0, 3]);
	expect(await commitMessage(scope!, blame.commits[0]!.sha)).toBe('feat: first\n\nWhy it exists.');
	await writeFile(join(path, 'new.ts'), 'x\n');
	expect(await blameFile(scope!, 'new.ts')).toBe('untracked');
	// Staged but never committed: every line is not committed yet.
	await gitText(path, ['add', 'new.ts']);
	expect(await blameFile(scope!, 'new.ts')).toEqual({ commits: [], lines: [-1], origins: [0] });
});

it('reads a file history across a rename with that file lines per commit (spec/editor#line-author)', async () => {
	const path = await repo();
	await mkdir(join(path, 'src'), { recursive: true });
	await writeFile(join(path, 'src/Button.tsx'), 'a\nb\nc\nd\ne\n');
	await gitText(path, ['add', '-A']);
	await commit(path, 'feat: first Button');
	await writeFile(join(path, 'other.ts'), 'x\n');
	await gitText(path, ['add', '-A']);
	await commit(path, 'chore: unrelated');
	await mkdir(join(path, 'src/Button'), { recursive: true });
	await gitText(path, ['mv', 'src/Button.tsx', 'src/Button/Button.tsx']);
	await commit(path, 'chore: own folder');
	await writeFile(join(path, 'src/Button/Button.tsx'), 'a\nb\nc\nd\ne\nf\ng\n');
	await gitText(path, ['add', '-A']);
	await commit(path, 'feat: two lines');
	const [scope] = await discoverScopes(path),
		page = await branchHistory(scope!, 'main', 100, 'src/Button/Button.tsx');
	expect(page.path).toBe('src/Button/Button.tsx');
	expect(page.commits.map((item) => [item.subject, item.file])).toEqual([
		['feat: two lines', { path: 'src/Button/Button.tsx', additions: 2, deletions: 0 }],
		[
			'chore: own folder',
			{ path: 'src/Button/Button.tsx', renamedFrom: 'src/Button.tsx', additions: 0, deletions: 0 },
		],
		['feat: first Button', { path: 'src/Button.tsx', additions: 5, deletions: 0 }],
	]);
	expect((await branchHistory(scope!, 'main', 1, 'src/Button/Button.tsx')).truncated).toBe(true);
});

it('reads rename specs of --numstat', () => {
	expect(numstatPath('src/{Button.tsx => Button/Button.tsx}')).toEqual({
		path: 'src/Button/Button.tsx',
		renamedFrom: 'src/Button.tsx',
	});
	expect(numstatPath('src/{ => Button}/Button.tsx')).toEqual({
		path: 'src/Button/Button.tsx',
		renamedFrom: 'src/Button.tsx',
	});
	expect(numstatPath('a.ts => b.ts')).toEqual({ path: 'b.ts', renamedFrom: 'a.ts' });
	expect(numstatPath('a.ts')).toEqual({ path: 'a.ts' });
});
