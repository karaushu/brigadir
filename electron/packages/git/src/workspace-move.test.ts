import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitText } from './command';
import { initRepo } from './monorepo.fixture';
import { planRepoMove, restoreProjectRepo, writeRepoMove } from './workspace-move';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
/** A tree of the folder as it is, untracked files included, without touching the repo's own index. */
async function tree(repo: string) {
	const index = join(await mkdtemp(join(tmpdir(), 'brigadir-tree-')), 'index');
	cleanup.push(() => rm(join(index, '..'), { recursive: true, force: true }));
	const env = { GIT_INDEX_FILE: index };
	await gitText(repo, ['read-tree', 'HEAD'], { env });
	await gitText(repo, ['add', '-A'], { env });
	return gitText(repo, ['write-tree'], { env });
}
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-move-git-'));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const repo = join(dir, 'repo');
	await initRepo(repo, 1);
	await writeFile(join(repo, 'lines.txt'), '1\n2\n3\n');
	await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
	await writeFile(join(repo, 'gone.txt'), 'tracked\n');
	await gitText(repo, ['add', '-A']);
	await gitText(repo, ['commit', '-qm', 'files']);
	return { dir, repo };
}
const status = async (repo: string) =>
	(await gitText(repo, ['status', '--porcelain', '--untracked-files=all'])).split('\n').sort();

it('spec/crew#auto-move: a path the person changed before the task and the task changed too stays when it does not merge, text or binary', async () => {
	const { dir, repo } = await fixture();
	await writeFile(join(repo, 'lines.txt'), '1\nperson\n3\n');
	await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 9, 9, 3, 0, 255]));
	const base = await tree(repo);
	await writeFile(join(repo, 'lines.txt'), '1\nagent\n3\n');
	await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 7, 7, 3, 0, 255]));
	await writeFile(join(repo, 'new.txt'), 'agent\n');
	const plan = await planRepoMove({
		repo,
		baseTree: base,
		currentTree: await tree(repo),
		personPaths: new Set(),
	});
	expect(plan.stayed).toEqual([
		{ path: 'blob.bin', reason: 'conflict' },
		{ path: 'lines.txt', reason: 'conflict' },
	]);
	expect(plan.writes.map((item) => item.path)).toEqual(['new.txt']);
	const copy = join(dir, 'copy');
	await gitText(repo, ['worktree', 'add', '-q', '-b', 'moved', copy, plan.head]);
	expect(await writeRepoMove(copy, plan)).toEqual([]);
	expect(await restoreProjectRepo(repo, base, plan.moved)).toEqual([]);
	// The stayed paths keep both edits in the project folder; only the new file left it.
	expect(await readFile(join(repo, 'lines.txt'), 'utf8')).toBe('1\nagent\n3\n');
	await expect(readFile(join(repo, 'new.txt'))).rejects.toThrow();
	expect(await readFile(join(copy, 'new.txt'), 'utf8')).toBe('agent\n');
});

it('spec/crew#auto-move: the restore undoes the agent’s git add and git rm, keeps a version the person saved meanwhile, and can run again', async () => {
	const { dir, repo } = await fixture();
	const before = await status(repo);
	const base = await tree(repo);
	await writeFile(join(repo, 'lines.txt'), '1\n2\nagent\n');
	await writeFile(join(repo, 'added.txt'), 'agent\n');
	await gitText(repo, ['add', 'lines.txt', 'added.txt']);
	await gitText(repo, ['rm', '-q', 'gone.txt']);
	await writeFile(join(repo, 'd0', 'f0.txt'), 'agent\n');
	const plan = await planRepoMove({
		repo,
		baseTree: base,
		currentTree: await tree(repo),
		personPaths: new Set(),
	});
	const copy = join(dir, 'copy');
	await gitText(repo, ['worktree', 'add', '-q', '-b', 'moved', copy, plan.head]);
	expect(await writeRepoMove(copy, plan)).toEqual([]);
	// The person saves a moved file after the last checkpoint: that version is theirs and stays.
	await writeFile(join(repo, 'd0', 'f0.txt'), 'person\n');
	// A run that stopped half-way (the first path restored), then the whole restore again, then once more.
	await restoreProjectRepo(repo, base, plan.moved.slice(0, 1));
	expect(await restoreProjectRepo(repo, base, plan.moved)).toEqual(['d0/f0.txt']);
	expect(await restoreProjectRepo(repo, base, plan.moved)).toEqual(['d0/f0.txt']);
	expect(await readFile(join(repo, 'gone.txt'), 'utf8')).toBe('tracked\n');
	expect(await readFile(join(repo, 'lines.txt'), 'utf8')).toBe('1\n2\n3\n');
	expect(await readFile(join(repo, 'd0', 'f0.txt'), 'utf8')).toBe('person\n');
	expect(before).toEqual(['']);
	expect(await status(repo)).toEqual(['M d0/f0.txt']);
	// Nothing of the agent stays staged in the person's index.
	expect(await gitText(repo, ['diff', '--cached', '--name-only'])).toBe('');
	// The worktree holds everything the agent did.
	expect(await readFile(join(copy, 'added.txt'), 'utf8')).toBe('agent\n');
	await expect(readFile(join(copy, 'gone.txt'))).rejects.toThrow();
	expect(await readFile(join(copy, 'd0', 'f0.txt'), 'utf8')).toBe('agent\n');
});
