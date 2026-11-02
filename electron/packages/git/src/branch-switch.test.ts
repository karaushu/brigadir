import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FETCH_FAILED } from '@brigadir/core';
import { gitText } from './command';
import { initRepo } from './monorepo.fixture';
import {
	CARRY_CONFLICT,
	createBranch,
	dirtyFiles,
	discardChanges,
	lastCommit,
	pullFastForward,
	stashDrop,
	stashPush,
	stashRestore,
	stashes,
	switchBranch,
	switchBranches,
	undoLastCommit,
} from './branch-switch';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const commit = async (repo: string, file: string, text: string, message = file) => {
	await writeFile(join(repo, file), text);
	await gitText(repo, ['add', '-A']);
	await gitText(repo, ['commit', '-qm', message]);
};
/** origin (bare) with main and staging; a clone on main whose staging is 2 commits behind origin. */
async function fixture() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-switch-')));
	roots.push(dir);
	const seed = join(dir, 'seed'),
		origin = join(dir, 'origin.git'),
		repo = join(dir, 'repo');
	await initRepo(seed, 2);
	await gitText(seed, ['branch', 'staging']);
	await gitText(seed, ['branch', 'feat/remote-only']);
	await gitText(dir, ['clone', '-q', '--bare', seed, origin]);
	await gitText(dir, ['clone', '-q', origin, repo]);
	for (const path of [repo, seed]) {
		await gitText(path, ['config', 'user.name', 'Fixture']);
		await gitText(path, ['config', 'user.email', 'fixture@localhost']);
	}
	await gitText(repo, ['branch', '-q', '--track', 'staging', 'origin/staging']);
	await gitText(seed, ['remote', 'add', 'origin', origin]);
	await gitText(seed, ['switch', '-q', 'staging']);
	await commit(seed, 's1.txt', '1\n');
	await commit(seed, 's2.txt', '2\n');
	await gitText(seed, ['push', '-q', 'origin', 'staging']);
	return { dir, repo, origin, seed };
}

it('lists local branches with upstream counts, remote ones without a local twin, and branches held by another worktree', async () => {
	const { dir, repo } = await fixture();
	await gitText(repo, ['fetch', '-q']);
	await gitText(repo, ['branch', 'held']);
	await gitText(repo, ['worktree', 'add', '-q', join(dir, 'wt'), 'held']);
	const { current, branches } = await switchBranches(repo);
	expect(current).toBe('main');
	expect(branches.find((branch) => branch.name === 'staging')).toMatchObject({
		remote: false,
		current: false,
		behind: 2,
		ahead: 0,
		upstream: 'origin/staging',
	});
	expect(branches.find((branch) => branch.name === 'main')).toMatchObject({
		current: true,
		worktree: null,
	});
	expect(branches.find((branch) => branch.name === 'held')?.worktree).toBe(join(dir, 'wt'));
	expect(branches.map((branch) => branch.name)).toContain('origin/feat/remote-only');
	expect(branches.map((branch) => branch.name)).not.toContain('origin/staging');
});

it('switches to a local branch and fast-forwards it to origin; a remote-only branch becomes a tracking local one', async () => {
	const { repo } = await fixture();
	expect(await switchBranch(repo, { branch: 'staging', mode: 'clean' })).toEqual({
		current: 'staging',
		pulled: 2,
		stash: null,
	});
	expect(await readFile(join(repo, 's2.txt'), 'utf8')).toBe('2\n');
	expect(
		await switchBranch(repo, { branch: 'origin/feat/remote-only', mode: 'clean' })
	).toMatchObject({ current: 'feat/remote-only' });
	expect(await gitText(repo, ['rev-parse', '--abbrev-ref', 'feat/remote-only@{upstream}'])).toBe(
		'origin/feat/remote-only'
	);
});

it("refuses a dirty tree in the clean mode and stashes by SHA, restoring the right entry under someone else's", async () => {
	const { repo } = await fixture();
	await writeFile(join(repo, 'd0', 'f0.txt'), 'edited\n');
	await writeFile(join(repo, 'new.txt'), 'new\n');
	expect((await dirtyFiles(repo)).map((file) => [file.path, file.status, file.untracked])).toEqual([
		['d0/f0.txt', 'M', false],
		['new.txt', 'A', true],
	]);
	// An untracked file counts its own lines, the last one without `\n` too (not +0 −0).
	await writeFile(join(repo, 'one.txt'), 'only line');
	expect(
		(await dirtyFiles(repo)).map((file) => [file.path, file.additions, file.deletions])
	).toEqual([
		['d0/f0.txt', 1, 1],
		['new.txt', 1, 0],
		['one.txt', 1, 0],
	]);
	await rm(join(repo, 'one.txt'));
	await expect(switchBranch(repo, { branch: 'staging', mode: 'clean' })).rejects.toThrow(
		'uncommitted'
	);
	const result = await switchBranch(repo, { branch: 'staging', mode: 'stash' });
	expect(result.current).toBe('staging');
	expect(result.stash).toMatch(/^[a-f0-9]{40}$/);
	expect(await dirtyFiles(repo)).toEqual([]);
	// Another worktree pushes on top: stash@{0} is no longer ours.
	await writeFile(join(repo, 'other.txt'), 'other\n');
	const other = await stashPush(repo, 'someone else');
	const list = await stashes(repo);
	expect(list.map((entry) => entry.sha)).toEqual([other, result.stash]);
	expect(list[1]).toMatchObject({
		branch: 'main',
		message: 'brigadir: main → staging',
		ours: true,
		files: 2,
	});
	await gitText(repo, ['switch', '-q', 'main']);
	await stashRestore(repo, result.stash!);
	expect(await readFile(join(repo, 'd0', 'f0.txt'), 'utf8')).toBe('edited\n');
	expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('new\n');
	expect((await stashes(repo)).map((entry) => entry.sha)).toEqual([other]);
	await stashDrop(repo, other);
	expect(await stashes(repo)).toEqual([]);
});

it('carries changes when the target does not touch them and leaves the tree as it was when it does', async () => {
	const { repo } = await fixture();
	await writeFile(join(repo, 'd0', 'f0.txt'), 'mine\n');
	expect((await switchBranch(repo, { branch: 'staging', mode: 'carry' })).current).toBe('staging');
	expect(await readFile(join(repo, 'd0', 'f0.txt'), 'utf8')).toBe('mine\n');
	await gitText(repo, ['switch', '-q', 'main']);
	// A branch that changes the same file: git refuses to carry.
	await gitText(repo, ['stash', 'push', '-q', '-m', 'test-hold']);
	await gitText(repo, ['switch', '-q', '-c', 'other']);
	await commit(repo, 'd0/f0.txt', 'theirs\n');
	await gitText(repo, ['switch', '-q', 'main']);
	await gitText(repo, ['stash', 'pop', '-q']);
	await expect(switchBranch(repo, { branch: 'other', mode: 'carry' })).rejects.toThrow(
		CARRY_CONFLICT
	);
	expect(await gitText(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
	expect(await readFile(join(repo, 'd0', 'f0.txt'), 'utf8')).toBe('mine\n');
});

it('discards tracked changes and only the confirmed new files', async () => {
	const { repo } = await fixture();
	await writeFile(join(repo, 'd0', 'f0.txt'), 'edited\n');
	await writeFile(join(repo, 'seen.txt'), 'x\n');
	await writeFile(join(repo, 'later.txt'), 'y\n');
	await discardChanges(repo, ['seen.txt']);
	expect((await dirtyFiles(repo)).map((file) => file.path)).toEqual(['later.txt']);
});

it('fails with FETCH_FAILED when origin is gone and switches without pull when asked', async () => {
	const { repo } = await fixture();
	await gitText(repo, ['remote', 'set-url', 'origin', '/nonexistent/origin.git']);
	await expect(switchBranch(repo, { branch: 'staging', mode: 'clean' })).rejects.toThrow(
		FETCH_FAILED
	);
	expect(await switchBranch(repo, { branch: 'staging', mode: 'clean', offline: true })).toEqual({
		current: 'staging',
		pulled: 0,
		stash: null,
	});
});

it('creates a branch from a remote base without tracking it, carrying the changes', async () => {
	const { repo } = await fixture();
	await writeFile(join(repo, 'd0', 'f0.txt'), 'edited\n');
	expect(await createBranch(repo, { name: 'fix/small', base: 'origin/staging' })).toMatchObject({
		current: 'fix/small',
	});
	expect(await readFile(join(repo, 's2.txt'), 'utf8')).toBe('2\n');
	expect(await readFile(join(repo, 'd0', 'f0.txt'), 'utf8')).toBe('edited\n');
	await expect(
		gitText(repo, ['rev-parse', '--abbrev-ref', 'fix/small@{upstream}'])
	).rejects.toThrow();
	await expect(createBranch(repo, { name: 'fix/small', base: 'main' })).rejects.toThrow(
		'already exists'
	);
});

it('pulls only fast-forward and undoes a commit only while it is on no remote', async () => {
	const { repo, seed } = await fixture();
	await gitText(repo, ['switch', '-q', 'staging']);
	expect(await pullFastForward(repo)).toBe(2);
	expect(await pullFastForward(repo)).toBe(0);
	expect((await lastCommit(repo))?.pushed).toBe(true);
	await expect(undoLastCommit(repo)).rejects.toThrow('already on origin');
	await commit(repo, 'local.txt', 'l\n', 'Local work');
	expect(await lastCommit(repo)).toMatchObject({
		subject: 'Local work',
		pushed: false,
		root: false,
	});
	expect((await undoLastCommit(repo)).subject).toBe('Local work');
	expect((await dirtyFiles(repo)).map((file) => file.path)).toEqual(['local.txt']);
	await commit(repo, 'local.txt', 'l\n', 'Local work');
	await commit(seed, 's3.txt', '3\n');
	await gitText(seed, ['push', '-q', 'origin', 'staging']);
	await expect(pullFastForward(repo)).rejects.toThrow('diverged');
});

it('counts commits ahead of and behind the upstream, and fast-forwards with changes the incoming commits do not touch (spec/git#pull)', async () => {
	const { repo, seed } = await fixture();
	const { upstreamCounts } = await import('./branch-switch');
	expect(await upstreamCounts(repo)).toEqual({ ahead: 0, behind: 0 });
	await gitText(repo, ['switch', '-q', 'staging']);
	await gitText(repo, ['fetch', '-q']);
	expect(await upstreamCounts(repo)).toEqual({ ahead: 0, behind: 2 });
	await writeFile(join(repo, 'd0', 'f0.txt'), 'local edit\n');
	expect(await pullFastForward(repo)).toBe(2);
	expect(await readFile(join(repo, 'd0', 'f0.txt'), 'utf8')).toBe('local edit\n');
	await commit(repo, 'mine.txt', 'm\n');
	expect(await upstreamCounts(repo)).toEqual({ ahead: 1, behind: 0 });
	await gitText(repo, ['switch', '-q', '-c', 'lonely']);
	expect(await upstreamCounts(repo)).toBeNull();
	void seed;
});
