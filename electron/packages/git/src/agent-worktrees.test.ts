import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchExists, git, worktreeEntries, worktreeOfRoot, listWorktrees } from './index';
import { initRepo, monorepo } from './monorepo.fixture';
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
it('lists linked worktrees with their branch, the commit they were made at and when; a gone folder is missing (spec/tasks#agent-worktrees)', async () => {
	const { dir, repo } = await fixture();
	const start = (await git(repo, ['rev-parse', 'HEAD'])).toString().trim();
	const before = Date.now() - 2000;
	await git(repo, ['worktree', 'add', '-q', '-b', 'feature', join(dir, 'business-validation')]);
	await git(repo, ['worktree', 'add', '-q', '--detach', join(dir, 'loose')]);
	await writeFile(join(dir, 'business-validation', 'a.txt'), 'a\n');
	await git(join(dir, 'business-validation'), ['add', 'a.txt']);
	await git(join(dir, 'business-validation'), ['commit', '-qm', 'a']);
	const entries = await worktreeEntries(join(dir, 'business-validation'));
	expect(entries.map((entry) => entry.path).sort()).toEqual(
		[join(dir, 'business-validation'), join(dir, 'loose')].sort()
	);
	const feature = entries.find((entry) => entry.branch === 'feature')!;
	expect(feature).toMatchObject({ missing: false, start });
	expect(feature.createdAt).toBeGreaterThanOrEqual(before);
	expect(entries.find((entry) => entry.path === join(dir, 'loose'))).toMatchObject({
		branch: null,
	});
	await rm(join(dir, 'loose'), { recursive: true, force: true });
	expect(
		(await worktreeEntries(repo)).find((entry) => entry.path === join(dir, 'loose'))
	).toMatchObject({
		missing: true,
	});
	expect(await branchExists(repo, 'feature')).toBe(true);
	expect(await branchExists(repo, 'gone')).toBe(false);
	expect(await listWorktrees(repo)).toContain(join(dir, 'business-validation'));
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
it('reads every repo of the reference monorepo: a worktree of a submodule or a nested repo is its own, the linked worktree inside the root stays inside (spec/overview#reference-case)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-agent-wt-mono-')));
	roots.push(dir);
	const mono = await monorepo(dir, 3);
	await git(mono.kit, ['worktree', 'add', '-q', '-b', 'kit-feature', join(dir, 'kit-feature')]);
	await git(mono.admin, [
		'worktree',
		'add',
		'-q',
		'-b',
		'admin-feature',
		join(dir, 'admin-feature'),
	]);
	await git(mono.repo, ['worktree', 'add', '-q', '-b', 'root-feature', join(dir, 'root-feature')]);
	const listed = async (repo: string) =>
		(await worktreeEntries(repo)).map((entry) => entry.path).sort();
	expect(await listed(mono.repo)).toEqual([mono.wt, join(dir, 'root-feature')].sort());
	expect(await listed(mono.kit)).toEqual([join(dir, 'kit-feature')]);
	expect(await listed(mono.admin)).toEqual([join(dir, 'admin-feature')]);
	expect(await listed(mono.skills)).toEqual([]);
	expect(await listed(mono.plain)).toEqual([]);
	// Only a checkout of the root's repo stands for the root.
	const root = { id: 'bb431b6140a30433', path: mono.repo };
	expect(await worktreeOfRoot(join(dir, 'root-feature'), root)).toBe(root.id);
	expect(await worktreeOfRoot(join(dir, 'kit-feature'), root)).toBeUndefined();
	expect(await worktreeOfRoot(join(dir, 'admin-feature'), root)).toBeUndefined();
});
