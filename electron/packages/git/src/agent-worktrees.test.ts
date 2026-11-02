import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, NewWorktrees, worktreeOfRoot, listWorktrees } from './index';
import { initRepo } from './monorepo.fixture';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-agent-wt-')));
	roots.push(dir);
	const repo = join(dir, 'business');
	await initRepo(repo);
	return { dir, repo };
}
it('reports only the worktrees that appeared after the first look, outside the excluded bases (spec/tasks#agent-worktrees)', async () => {
	const { dir, repo } = await fixture();
	await git(repo, ['worktree', 'add', '-q', '-b', 'old', join(dir, 'old')]);
	const found = new NewWorktrees([repo, join(dir, 'data', 'worktrees')]);
	expect(await found.found([repo])).toEqual([]);
	await git(repo, ['worktree', 'add', '-q', '-b', 'feature', join(dir, 'business-validation')]);
	await git(repo, ['worktree', 'add', '-q', '-b', 'own', join(dir, 'data', 'worktrees', 'p', 't')]);
	await git(repo, ['worktree', 'add', '-q', '-b', 'inside', join(repo, 'inner')]);
	expect(await found.found([repo])).toEqual([join(dir, 'business-validation')]);
	expect(await found.found([repo])).toEqual([]);
	expect(await listWorktrees(repo)).toContain(join(dir, 'old'));
});
it('names the root for another checkout of its repository only (spec/tasks#agent-worktrees)', async () => {
	const { dir, repo } = await fixture();
	const other = join(dir, 'other');
	await initRepo(other);
	await git(repo, ['worktree', 'add', '-q', '-b', 'feature', join(dir, 'wt')]);
	const root = { id: 'bb431b6140a30433', path: repo };
	expect(await worktreeOfRoot(join(dir, 'wt'), root)).toBe(root.id);
	expect(await worktreeOfRoot(other, root)).toBeUndefined();
	expect(await worktreeOfRoot(repo, root)).toBeUndefined();
	expect(await worktreeOfRoot(join(dir, 'wt'), undefined)).toBeUndefined();
});
