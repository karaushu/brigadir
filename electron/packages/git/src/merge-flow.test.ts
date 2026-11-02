import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@brigadir/core';
import { git, gitText } from './command';
import { branchHistory, commitFiles, listBranches, parseLog, resolveBranch } from './history';
import {
	abortMerge,
	applyResolution,
	conflictFiles,
	conflictKind,
	conflictPlaces,
	conflictTexts,
	finishMerge,
	markResolved,
	mergeSource,
	previewMerge,
	rebaseInfo,
	reopenConflict,
	resolveWith,
	startMerge,
	swapSide,
	takeSide,
	unmergedPaths,
} from './merge-flow';

async function repo() {
	const path = await mkdtemp(join(tmpdir(), 'brigadir-merge-flow-'));
	await gitText(path, ['init', '-b', 'main']);
	await gitText(path, ['config', 'user.name', 'Fixture']);
	await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
	await writeFile(
		join(path, 'total.ts'),
		'export function total(items) {\n  return sum(items);\n}\n'
	);
	await writeFile(join(path, 'notes.md'), 'one\n');
	await gitText(path, ['add', '-A']);
	await gitText(path, ['commit', '-q', '-m', 'Seed']);
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
async function commit(path: string, file: string, text: string, message: string) {
	await writeFile(join(path, file), text);
	await gitText(path, ['add', '-A']);
	await gitText(path, ['commit', '-q', '-m', message]);
}

it('reads branches, history and a commit file list from git itself', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature/cart']);
		await commit(
			path,
			'total.ts',
			'export function total(items) {\n  return round(sum(items), 2);\n}\n',
			'Fix cart total rounding'
		);
		const branches = await listBranches(scope);
		expect(branches.current).toBe('feature/cart');
		expect(branches.branches.map((branch) => branch.name).sort()).toEqual(['feature/cart', 'main']);
		const page = await branchHistory(scope, 'feature/cart');
		expect(page.commits.map((commit) => commit.subject)).toEqual([
			'Fix cart total rounding',
			'Seed',
		]);
		expect(page.commits[0]!.files).toBe(1);
		expect(page.commits[1]!.parents).toEqual([]);
		const files = await commitFiles(scope, page.commits[0]!.sha);
		expect(files.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
			['total.ts', 1, 1],
		]);
		expect(
			(await commitFiles(scope, page.commits[1]!.sha)).files.map((file) => file.path).sort()
		).toEqual(['notes.md', 'total.ts']);
		await expect(resolveBranch(scope, 'missing')).rejects.toThrow('unavailable');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('parses subjects that contain the field separator and rejects malformed records', () => {
	expect(
		parseLog(`\x1e${'b'.repeat(40)}\x1f\x1fDev\x1f1\x1fa\x1fb\n\n 1 file changed`)[0]
	).toMatchObject({ subject: 'a\x1fb', files: 1, time: 1000 });
	expect(() => parseLog('\x1enot-a-sha\x1f\x1f\x1f\x1f')).toThrow('Invalid Git log');
});

it('previews, merges cleanly and refuses a dirty tree or a non-current target', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature']);
		await commit(path, 'notes.md', 'one\ntwo\n', 'Add a note');
		await gitText(path, ['checkout', '-q', 'main']);
		const preview = await previewMerge(scope, 'main', 'feature');
		expect(preview).toMatchObject({ commits: 1, conflicts: [], upToDate: false });
		expect(preview.files).toEqual([{ path: 'notes.md', additions: 1, deletions: 0 }]);
		await expect(startMerge(scope, 'feature', 'main')).rejects.toThrow('current branch');
		await writeFile(join(path, 'total.ts'), 'dirty\n');
		await expect(startMerge(scope, 'main', 'feature')).rejects.toThrow('Commit or stash');
		await gitText(path, ['checkout', '--', 'total.ts']);
		const outcome = await startMerge(scope, 'main', 'feature');
		expect(outcome.status).toBe('merged');
		expect(await gitText(path, ['log', '-1', '--format=%s'])).toBe('Merge feature into main');
		expect((await startMerge(scope, 'main', 'feature')).status).toBe('up-to-date');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('predicts and walks a conflict: take a side, resolve by hand, finish only when nothing is left', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature']);
		await commit(
			path,
			'total.ts',
			'export function total(items) {\n  return sum(items) * rate;\n}\n',
			'Apply rate'
		);
		await commit(path, 'notes.md', 'theirs\n', 'Theirs note');
		await gitText(path, ['checkout', '-q', 'main']);
		await commit(
			path,
			'total.ts',
			'export function total(items) {\n  return round(sum(items), 2);\n}\n',
			'Round'
		);
		await commit(path, 'notes.md', 'ours\n', 'Ours note');
		const preview = await previewMerge(scope, 'main', 'feature');
		expect(preview.conflicts.sort()).toEqual(['notes.md', 'total.ts']);
		expect(await gitText(path, ['status', '--porcelain'])).toBe(''); // the preview leaves the tree alone
		expect((await startMerge(scope, 'main', 'feature')).status).toBe('conflicts');
		expect(await unmergedPaths(scope)).toEqual(['notes.md', 'total.ts']);
		await expect(finishMerge(scope)).rejects.toThrow('Resolve every conflict');
		await resolveWith(scope, 'notes.md', 'theirs');
		expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('theirs\n');
		await expect(markResolved(scope, 'total.ts')).rejects.toThrow('Resolve every conflict place');
		const text = await readFile(join(path, 'total.ts'), 'utf8');
		expect(conflictPlaces(text)).toBe(1);
		await writeFile(
			join(path, 'total.ts'),
			'export function total(items, rate) {\n  return round(sum(items) * rate, 2);\n}\n'
		);
		const files = await conflictFiles(scope, ['notes.md', 'total.ts'], ['total.ts']);
		expect(files).toEqual([
			{ path: 'notes.md', places: 0, resolved: true, byAgent: false },
			{ path: 'total.ts', places: 0, resolved: false, byAgent: true },
		]);
		await markResolved(scope, 'total.ts');
		const done = await finishMerge(scope);
		expect(done.status).toBe('merged');
		expect(await gitText(path, ['rev-list', '--count', '--merges', 'HEAD'])).toBe('1');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('shows a modify/delete conflict as open and resolves it by keeping or deleting the file', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature']);
		await gitText(path, ['rm', '-q', 'notes.md']);
		await gitText(path, ['commit', '-q', '-m', 'Drop notes']);
		await commit(path, 'total.ts', 'export const total = 0;\n', 'Theirs total');
		await gitText(path, ['checkout', '-q', 'main']);
		await commit(path, 'notes.md', 'ours\n', 'Ours note');
		await gitText(path, ['rm', '-q', 'total.ts']);
		await gitText(path, ['commit', '-q', '-m', 'Drop total']);
		expect((await startMerge(scope, 'main', 'feature')).status).toBe('conflicts');
		const files = await conflictFiles(scope, ['notes.md', 'total.ts']);
		expect(files).toEqual([
			{ path: 'notes.md', places: 0, resolved: false, byAgent: false, deleted: 'theirs' },
			{ path: 'total.ts', places: 0, resolved: false, byAgent: false, deleted: 'ours' },
		]);
		await expect(resolveWith(scope, 'notes.md', 'both')).rejects.toThrow('deleted on one side');
		// Keep our changed notes.md; delete total.ts as the current branch did.
		await resolveWith(scope, 'notes.md', 'ours');
		await resolveWith(scope, 'total.ts', 'ours');
		expect(await unmergedPaths(scope)).toEqual([]);
		expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('ours\n');
		expect((await finishMerge(scope)).status).toBe('merged');
		expect(await gitText(path, ['ls-files'])).toBe('notes.md');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('aborts a conflicted merge back to the pre-merge tree', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature']);
		await commit(path, 'notes.md', 'theirs\n', 'Theirs');
		await gitText(path, ['checkout', '-q', 'main']);
		await commit(path, 'notes.md', 'ours\n', 'Ours');
		const head = await gitText(path, ['rev-parse', 'HEAD']);
		expect((await startMerge(scope, 'main', 'feature')).status).toBe('conflicts');
		await abortMerge(scope);
		expect(await gitText(path, ['rev-parse', 'HEAD'])).toBe(head);
		expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('ours\n');
		await git(path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
			() => {
				throw new Error('merge still in progress');
			},
			() => {}
		);
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('reads the three texts, applies a Result and goes back to the conflict (spec/appearance#evolution-redesign)', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature']);
		await commit(path, 'notes.md', 'theirs\n', 'Theirs');
		await gitText(path, ['rm', '-q', 'total.ts']);
		await gitText(path, ['commit', '-q', '-m', 'Drop total']);
		await gitText(path, ['checkout', '-q', 'main']);
		await commit(path, 'notes.md', 'ours\n', 'Ours');
		await commit(path, 'total.ts', 'export const total = 1;\n', 'Ours total');
		expect((await startMerge(scope, 'main', 'feature')).status).toBe('conflicts');
		expect(await conflictKind(scope)).toBe('merge');
		expect(await mergeSource(scope)).toBe('feature');
		const texts = await conflictTexts(scope, 'notes.md');
		expect(texts).toMatchObject({ base: 'one\n', ours: 'ours\n', theirs: 'theirs\n' });
		expect(texts.current).toContain('<<<<<<<');
		await expect(conflictTexts(scope, 'total.ts')).rejects.toThrow('deleted on one side');
		// Apply writes the Result and resolves the file; Back to the conflict brings the markers and the stages back.
		await applyResolution(scope, 'notes.md', 'ours\ntheirs\n');
		expect(await unmergedPaths(scope)).toEqual(['total.ts']);
		await reopenConflict(scope, 'notes.md');
		expect(await unmergedPaths(scope)).toEqual(['notes.md', 'total.ts']);
		expect(conflictPlaces(await readFile(join(path, 'notes.md'), 'utf8'))).toBe(1);
		// A side, then back: the same; a deleted file comes back as a modify/delete conflict.
		expect(await resolveWith(scope, 'notes.md', 'theirs')).toBe('theirs');
		await reopenConflict(scope, 'notes.md');
		expect(conflictPlaces(await readFile(join(path, 'notes.md'), 'utf8'))).toBe(1);
		expect(await resolveWith(scope, 'total.ts', 'theirs')).toBe('deleted');
		await reopenConflict(scope, 'total.ts');
		expect((await conflictFiles(scope, ['total.ts']))[0]).toMatchObject({
			resolved: false,
			deleted: 'theirs',
		});
		expect(await resolveWith(scope, 'total.ts', 'ours')).toBe('kept');
		await applyResolution(scope, 'notes.md', 'merged\n');
		expect((await finishMerge(scope)).status).toBe('merged');
		expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('merged\n');
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('walks a rebase that stopped: sides from the person’s view, Continue, Abort (spec/appearance#evolution-redesign)', async () => {
	const { path, scope } = await repo();
	try {
		await gitText(path, ['checkout', '-q', '-b', 'feature']);
		await commit(path, 'notes.md', 'mine\n', 'Mine');
		await commit(path, 'total.ts', 'export const total = 2;\n', 'Mine total');
		await gitText(path, ['checkout', '-q', 'main']);
		await commit(path, 'notes.md', 'stage\n', 'Stage');
		await gitText(path, ['checkout', '-q', 'feature']);
		const before = await gitText(path, ['rev-parse', '--short=7', 'HEAD']);
		await git(path, ['rebase', 'main']).catch(() => {});
		expect(await conflictKind(scope)).toBe('rebase');
		expect(await rebaseInfo(scope)).toEqual({
			branch: 'feature',
			onto: 'main',
			head: before,
			step: { current: 1, total: 2 },
		});
		// Yours is the person's commit (git's «theirs» in a rebase).
		expect(await conflictTexts(scope, 'notes.md', true)).toMatchObject({
			ours: 'mine\n',
			theirs: 'stage\n',
		});
		expect(swapSide('ours', true)).toBe('theirs');
		await resolveWith(scope, 'notes.md', swapSide('ours', true));
		expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('mine\n');
		expect((await finishMerge(scope)).status).toBe('merged');
		expect(await conflictKind(scope)).toBe(null);
		expect(await gitText(path, ['log', '--format=%s', '-3'])).toBe('Mine total\nMine\nStage');
		// Another stop, aborted: the branch is back where it was.
		await gitText(path, ['checkout', '-q', 'main']);
		await commit(path, 'notes.md', 'stage two\n', 'Stage two');
		await gitText(path, ['checkout', '-q', 'feature']);
		const head = await gitText(path, ['rev-parse', 'HEAD']);
		await git(path, ['rebase', 'main']).catch(() => {});
		expect(await conflictKind(scope)).toBe('rebase');
		await abortMerge(scope);
		expect(await conflictKind(scope)).toBe(null);
		expect(await gitText(path, ['rev-parse', 'HEAD'])).toBe(head);
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('takes one side of every conflict place, or both in order, and refuses broken markers', () => {
	const text = 'a\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> feature\nz\n';
	expect(takeSide(text, 'ours')).toBe('a\nours\nz\n');
	expect(takeSide(text, 'theirs')).toBe('a\ntheirs\nz\n');
	expect(takeSide(text, 'both')).toBe('a\nours\ntheirs\nz\n');
	expect(() => takeSide('<<<<<<< HEAD\nours\n', 'ours')).toThrow('incomplete');
	expect(conflictPlaces('<<<<<<< a\n=======\n>>>>>>> b\n<<<<<<< a\n=======\n>>>>>>> b\n')).toBe(2);
});
