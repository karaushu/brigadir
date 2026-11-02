import { expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@brigadir/core';
import { gitText } from './command';
import { gitPath, squashBranch, squashInProgress, syncFromParent, unmergedNames } from './merge';
import { abortMerge, finishMerge, mergeInProgress, startMerge } from './merge-flow';

async function repo() {
	const path = await mkdtemp(join(tmpdir(), 'brigadir-squash-'));
	await gitText(path, ['init', '-q', '-b', 'main']);
	await gitText(path, ['config', 'user.name', 'Fixture']);
	await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
	await writeFile(join(path, 'shared.ts'), 'one\n');
	await gitText(path, ['add', '-A']);
	await gitText(path, ['commit', '-q', '-m', 'feat: [Couriers] seed']);
	const scope: Scope = {
		id: 'a'.repeat(16),
		path,
		name: 'choice',
		kind: 'root',
		branch: 'main',
		selected: true,
	};
	return { path, scope };
}
/** A worker branch off `main`: its own commit, as acceptance commits the worker's tree before the squash. */
async function worker(path: string, branch: string, file: string, text: string) {
	await gitText(path, ['checkout', '-q', '-b', branch, 'main']);
	await writeFile(join(path, file), text);
	await gitText(path, ['add', '-A']);
	await gitText(path, ['commit', '-q', '-m', `Developer: ${branch}`]);
	await gitText(path, ['checkout', '-q', 'main']);
}
const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);
const history = async (path: string) =>
	(await gitText(path, ['log', '--format=%P|%B%x00', 'main']))
		.split('\0')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const bar = entry.indexOf('|');
			return {
				parents: entry.slice(0, bar).split(' ').filter(Boolean).length,
				message: entry.slice(bar + 1).trim(),
			};
		});

it('accepts each worker branch as one commit with one parent and the given message, no merge commits (spec/crew#accept)', async () => {
	const { path } = await repo();
	try {
		// Three parts branch off the same foreman HEAD, as crew workers do.
		await worker(path, 'w1', 'a.ts', 'a\n');
		await worker(path, 'w2', 'b.ts', 'b\n');
		await worker(path, 'w3', 'c.ts', 'c\n');
		for (const [branch, message] of [
			['w1', 'feat: [Couriers] shared contract'],
			['w2', 'feat: [Couriers] live updates'],
			['w3', 'fix: [Delivery] reconnect'],
		] as const) {
			const result = await squashBranch(path, branch, `${message}\n\nBody of ${branch}.\n`);
			expect(result).toMatchObject({ merged: true, conflicts: [] });
			expect(result.sha).toBe(await gitText(path, ['rev-parse', 'HEAD']));
		}
		expect(await history(path)).toEqual([
			{ parents: 1, message: 'fix: [Delivery] reconnect\n\nBody of w3.' },
			{ parents: 1, message: 'feat: [Couriers] live updates\n\nBody of w2.' },
			{ parents: 1, message: 'feat: [Couriers] shared contract\n\nBody of w1.' },
			{ parents: 0, message: 'feat: [Couriers] seed' },
		]);
		expect(await gitText(path, ['log', '--format=%s', 'main'])).not.toMatch(/Merge|Developer:/);
		expect(await gitText(path, ['ls-files'])).toBe('a.ts\nb.ts\nc.ts\nshared.ts');
		expect(await exists(await gitPath(path, 'SQUASH_MSG'))).toBe(false);
		expect(await gitText(path, ['status', '--porcelain'])).toBe('');
		// A retried acceptance commits nothing: the branch is not an ancestor after a squash, but its changes are in the tree.
		const head = await gitText(path, ['rev-parse', 'HEAD']);
		expect(await squashBranch(path, 'w2', 'again')).toEqual({
			merged: false,
			conflicts: [],
			sha: head,
		});
		expect(await gitText(path, ['rev-parse', 'HEAD'])).toBe(head);
		expect(await exists(await gitPath(path, 'SQUASH_MSG'))).toBe(false);
		expect(await squashInProgress(path)).toBe(false);
		// A branch with nothing new (an ancestor of HEAD) commits nothing either.
		await gitText(path, ['branch', 'empty', 'HEAD']);
		expect(await squashBranch(path, 'empty', 'x')).toEqual({
			merged: false,
			conflicts: [],
			sha: head,
		});
		await expect(squashBranch(path, 'missing', 'x')).rejects.toThrow('does not exist');
		await expect(squashBranch(path, '-x', 'x')).rejects.toThrow('Invalid branch');
		await expect(squashBranch(path, 'w1', ' ')).rejects.toThrow('Empty commit message');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('leaves a conflict to the human with the message in SQUASH_MSG; finishing commits that message, aborting restores the tree', async () => {
	const { path, scope } = await repo();
	try {
		await worker(path, 'w1', 'shared.ts', 'first\n');
		await worker(path, 'w2', 'shared.ts', 'second\n');
		expect((await squashBranch(path, 'w1', 'feat: [Couriers] first')).merged).toBe(true);
		const head = await gitText(path, ['rev-parse', 'HEAD']);
		const result = await squashBranch(path, 'w2', 'feat: [Couriers] second\n\nWhy it changed.');
		expect(result).toEqual({ merged: false, conflicts: ['shared.ts'], sha: head });
		expect(await unmergedNames(path)).toEqual(['shared.ts']);
		expect(await exists(join(path, '.git', 'MERGE_HEAD'))).toBe(false);
		expect(await exists(join(path, '.git', 'MERGE_MSG'))).toBe(false);
		expect(await readFile(join(path, '.git', 'SQUASH_MSG'), 'utf8')).toBe(
			'feat: [Couriers] second\n\nWhy it changed.\n'
		);
		// The merge surface (spec/git#merge) sees it as a merge in progress and refuses a second one.
		expect(await squashInProgress(path)).toBe(true);
		expect(await mergeInProgress(scope)).toBe(true);
		await gitText(path, ['branch', 'other', 'w1']);
		await expect(startMerge(scope, 'main', 'other')).rejects.toThrow('already in progress');
		// The next acceptance does not take the pending conflict for its own.
		await expect(squashBranch(path, 'other', 'feat: next')).rejects.toThrow(
			'A merge is in progress'
		);
		await expect(finishMerge(scope)).rejects.toThrow('Resolve every conflict place first.');
		// Abort: `merge --abort` has no MERGE_HEAD here; the tree returns to HEAD.
		await abortMerge(scope);
		expect(await mergeInProgress(scope)).toBe(false);
		expect(await gitText(path, ['status', '--porcelain'])).toBe('');
		expect(await readFile(join(path, 'shared.ts'), 'utf8')).toBe('first\n');
		// Again, resolved by hand: «Finish merge» commits the generated message, one parent, no `# Conflicts:` lines.
		await squashBranch(path, 'w2', 'feat: [Couriers] second\n\nWhy it changed.');
		await writeFile(join(path, 'shared.ts'), 'first\nsecond\n');
		await gitText(path, ['add', '--', 'shared.ts']);
		expect(await mergeInProgress(scope)).toBe(true);
		expect((await finishMerge(scope)).status).toBe('merged');
		expect((await history(path))[0]).toEqual({
			parents: 1,
			message: 'feat: [Couriers] second\n\nWhy it changed.',
		});
		expect(await mergeInProgress(scope)).toBe(false);
		expect(await exists(join(path, '.git', 'SQUASH_MSG'))).toBe(false);
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('refuses a squash over staged changes and keeps them', async () => {
	const { path } = await repo();
	try {
		await worker(path, 'w1', 'a.ts', 'a\n');
		await writeFile(join(path, 'staged.ts'), 'mine\n');
		await gitText(path, ['add', '--', 'staged.ts']);
		await expect(squashBranch(path, 'w1', 'feat: x')).rejects.toThrow();
		expect(await gitText(path, ['status', '--porcelain'])).toBe('A  staged.ts');
		expect(await gitText(path, ['rev-list', '--count', 'HEAD'])).toBe('1');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

/** spec/crew#parts: one crew member works its parts in one worktree; the crew tree (`main`) comes in before each next part. */
async function memberTree(path: string, branch: string) {
	const tree = `${path}-${branch}`;
	await gitText(path, ['worktree', 'add', '-q', '-b', branch, tree, 'main']);
	return tree;
}
const commitAll = async (tree: string, message: string) => {
	await gitText(tree, ['add', '-A']);
	await gitText(tree, ['commit', '-q', '-m', message]);
	return gitText(tree, ['rev-parse', 'HEAD']);
};
it('brings the crew tree into a member branch by fast-forward; the next squash takes only the new part, without false conflicts (spec/crew#parts)', async () => {
	const { path } = await repo();
	const trees: string[] = [];
	try {
		// Part 1 of member A edits shared.ts; acceptance squashes it into main.
		const a = await memberTree(path, 'a');
		trees.push(a);
		await writeFile(join(a, 'shared.ts'), 'one\ntwo\n');
		const accepted = await commitAll(a, 'A: part 1');
		expect((await squashBranch(path, 'a', 'feat: part 1')).merged).toBe(true);
		// Member B then changes the line part 1 wrote; its squash lands in main too.
		const b = await memberTree(path, 'b');
		trees.push(b);
		await writeFile(join(b, 'shared.ts'), 'one\ntwo!\n');
		await commitAll(b, 'B: part');
		expect((await squashBranch(path, 'b', 'feat: other member')).merged).toBe(true);
		const crewHead = await gitText(path, ['rev-parse', 'HEAD']);
		// A plain merge of main into A would conflict: its base is the seed, so part 1 meets its own squash with B's edit on top.
		await expect(gitText(a, ['merge-tree', '--write-tree', accepted, crewHead])).rejects.toThrow();
		const synced = await syncFromParent(a, crewHead, accepted, 'Brigadir: crew tree for part 2');
		expect(synced).toMatchObject({ merged: true, conflicts: [] });
		expect(await readFile(join(a, 'shared.ts'), 'utf8')).toBe('one\ntwo!\n');
		expect(await gitText(a, ['status', '--porcelain'])).toBe('');
		expect(
			await gitText(a, ['merge-base', '--is-ancestor', crewHead, 'HEAD']).then(
				() => true,
				() => false
			)
		).toBe(true);
		// Nothing new in main: a second sync is a no-op.
		expect(await syncFromParent(a, crewHead, accepted, 'again')).toEqual({
			merged: false,
			conflicts: [],
			sha: synced.sha,
		});
		// Part 2: the squash holds only its own file, one commit with one parent.
		await writeFile(join(a, 'd.ts'), 'd\n');
		await commitAll(a, 'A: part 2');
		expect((await squashBranch(path, 'a', 'feat: part 2')).merged).toBe(true);
		expect(await gitText(path, ['show', '--format=', '--name-only', 'HEAD'])).toBe('d.ts');
		expect((await history(path)).map((item) => [item.parents, item.message])).toEqual([
			[1, 'feat: part 2'],
			[1, 'feat: other member'],
			[1, 'feat: part 1'],
			[0, 'feat: [Couriers] seed'],
		]);
		expect(await readFile(join(path, 'shared.ts'), 'utf8')).toBe('one\ntwo!\n');
	} finally {
		for (const tree of trees) await rm(tree, { recursive: true, force: true });
		await rm(path, { recursive: true, force: true });
	}
});
it('keeps work added to a member branch after acceptance, and leaves a real conflict in the member tree (spec/crew#parts)', async () => {
	const { path, scope } = await repo();
	const trees: string[] = [];
	try {
		const a = await memberTree(path, 'a');
		trees.push(a);
		await writeFile(join(a, 'a.ts'), 'a\n');
		const accepted = await commitAll(a, 'A: part 1');
		expect((await squashBranch(path, 'a', 'feat: part 1')).merged).toBe(true);
		// The human worked with A after acceptance: a new file stays, the accepted one does not conflict with its squash.
		await writeFile(join(a, 'e.ts'), 'e\n');
		await commitAll(a, 'A: after acceptance');
		await writeFile(join(path, 'c.ts'), 'c\n');
		await gitText(path, ['add', '-A']);
		await gitText(path, ['commit', '-q', '-m', 'feat: other']);
		const crewHead = await gitText(path, ['rev-parse', 'HEAD']);
		expect(await syncFromParent(a, crewHead, accepted, 'Brigadir: crew tree')).toMatchObject({
			merged: true,
			conflicts: [],
		});
		expect((await gitText(a, ['ls-files'])).split('\n')).toEqual([
			'a.ts',
			'c.ts',
			'e.ts',
			'shared.ts',
		]);
		// A change of its own on a line main changed too: the conflict waits for the human with MERGE_HEAD.
		await writeFile(join(a, 'shared.ts'), 'mine\n');
		const tip = await commitAll(a, 'A: own edit');
		await writeFile(join(path, 'shared.ts'), 'theirs\n');
		await gitText(path, ['commit', '-q', '-am', 'feat: theirs']);
		const head = await gitText(path, ['rev-parse', 'HEAD']);
		expect(await syncFromParent(a, head, accepted, 'Brigadir: crew tree')).toEqual({
			merged: false,
			conflicts: ['shared.ts'],
			sha: tip,
		});
		expect(await mergeInProgress({ ...scope, path: a })).toBe(true);
		expect(await unmergedNames(a)).toEqual(['shared.ts']);
		await expect(syncFromParent(a, head, accepted, 'again')).rejects.toThrow(
			'A merge is in progress'
		);
	} finally {
		for (const tree of trees) await rm(tree, { recursive: true, force: true });
		await rm(path, { recursive: true, force: true });
	}
});
