import { describe, expect, it } from 'vitest';
import type { AgentTask, DiffLine, PRCheckRun, PullRequestDetail } from '@brigadir/core';
import { diffRows, noExpansion } from '../../renderer/diff-rows';
import {
	changeBars,
	checkState,
	checksGlyph,
	checksLine,
	completeInMenu,
	diffHunks,
	fileMark,
	fileView,
	mergeLine,
} from './logic';

const context = (oldLine: number, newLine: number): DiffLine => ({
	kind: 'context',
	text: `line ${newLine}`,
	oldLine,
	newLine,
});
const added = (newLine: number): DiffLine => ({
	kind: 'added',
	text: `new ${newLine}`,
	oldLine: null,
	newLine,
});
const removed = (oldLine: number): DiffLine => ({
	kind: 'removed',
	text: `old ${oldLine}`,
	oldLine,
	newLine: null,
});

describe('the phone diff (spec/remote-access-and-mobile#phone-task-tools)', () => {
	it('folds context past three lines into hunks with git headers', () => {
		const lines: DiffLine[] = [
			...Array.from({ length: 10 }, (_, i) => context(i + 1, i + 1)),
			removed(11),
			added(11),
			added(12),
			...Array.from({ length: 10 }, (_, i) => context(i + 12, i + 13)),
			removed(22),
			added(23),
			context(23, 24),
		];
		const rows = diffRows(
			{ lines, pairs: [] } as never,
			'unified',
			noExpansion,
			[],
			undefined,
			undefined,
			false,
			null
		);
		const hunks = diffHunks(rows);
		expect(hunks.map((hunk) => hunk.header)).toEqual(['@@ −8,7 +8,8 @@', '@@ −19,5 +20,5 @@']);
		expect(hunks[0]!.lines.map((line) => line.kind)).toEqual([
			'context',
			'context',
			'context',
			'removed',
			'added',
			'added',
			'context',
			'context',
			'context',
		]);
	});
	it('marks a file by the first letter of git status', () => {
		expect(fileMark({ status: 'R100' })).toBe('R');
		expect(fileMark({ status: 'A' })).toBe('A');
	});
	it('gives the code view added and modified bars (spec/editor#change-marks)', () => {
		const bars = changeBars([
			context(1, 1),
			added(2),
			context(2, 3),
			removed(3),
			added(4),
			added(5),
		]);
		expect([...bars]).toEqual([
			[2, 'added'],
			[4, 'modified'],
			[5, 'modified'],
		]);
	});
});

const check = (name: string, state: PRCheckRun['state']): PRCheckRun => ({
	name,
	workflow: null,
	state,
	link: '',
	seconds: 30,
});
const detail = (patch: Partial<PullRequestDetail>, summary: object = {}) =>
	({
		mergeState: 'BLOCKED',
		mergeable: 'MERGEABLE',
		canMerge: true,
		requiredApprovals: 1,
		checks: [],
		...patch,
		summary: { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewers: [], ...summary },
	}) as unknown as PullRequestDetail;

describe('the PR overview line (spec/remote-access-and-mobile#phone-task-tools)', () => {
	it('counts the checks and names the failed one first, then the running one', () => {
		const line = checksLine([
			check('build', 'pass'),
			check('e2e', 'pending'),
			check('lint', 'fail'),
		]);
		expect(line).toMatchObject({ passed: 1, total: 3, state: 'fail' });
		expect(line.named?.name).toBe('lint');
		expect(checksLine([check('build', 'pass'), check('e2e', 'pending')]).named?.name).toBe('e2e');
	});
	it('says why a merge waits: checks, approvals, both, or a block', () => {
		expect(mergeLine(detail({ mergeState: 'CLEAN' }))).toEqual({ kind: 'ready' });
		expect(mergeLine(detail({ checks: [check('e2e', 'pending')] }))).toEqual({
			kind: 'waiting',
			checks: true,
			approvals: 1,
		});
		expect(
			mergeLine(detail({ checks: [check('e2e', 'pending')] }, { reviewDecision: 'APPROVED' }))
		).toEqual({ kind: 'waiting', checks: true, approvals: 0 });
		expect(mergeLine(detail({ checks: [check('e2e', 'fail')] }))).toEqual({
			kind: 'block',
			block: 'checks',
		});
		expect(mergeLine(detail({ mergeable: 'CONFLICTING' }))).toEqual({
			kind: 'block',
			block: 'conflicts',
		});
		expect(mergeLine(detail({}, { state: 'MERGED' }))).toEqual({ kind: 'merged' });
	});
});

describe('a file on the phone (security review W2)', () => {
	it('shows a large file as plain code: no preview, no text sent back for colours', () => {
		expect(fileView('README.md', { state: 'text', large: false })).toEqual({
			preview: true,
			syntax: true,
		});
		expect(fileView('README.md', { state: 'text', large: true })).toEqual({
			preview: false,
			syntax: false,
		});
		expect(fileView('big.ts', { state: 'text', large: true }).syntax).toBe(false);
		expect(fileView('a.png', { state: 'binary', large: false }).syntax).toBe(false);
	});
});

describe('the task menu and the PR card follow the rest of the app', () => {
	const task = (id: string, patch: Partial<AgentTask> = {}): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'done',
		...patch,
	});
	it('offers «Complete task» by the swipe’s rule: not while an agent works in it or under it (spec/tasks#archive-actions)', () => {
		for (const status of ['done', 'interrupted', 'failed', 'backlog'] as const)
			expect(completeInMenu(task('a', { status }), [], false)).toBe(true);
		for (const status of ['working', 'needs-you', 'preparing', 'queued', 'completed'] as const)
			expect(completeInMenu(task('a', { status }), [], false)).toBe(false);
		// The turn runs while the workspace still says done.
		expect(completeInMenu(task('a'), [], true)).toBe(false);
		// A foreman whose worker works.
		const foreman = task('f', { crew: {} as never }),
			worker = task('w', { crewTaskId: 'f', status: 'working' });
		expect(completeInMenu(foreman, [foreman, worker], false)).toBe(false);
	});
	it('draws a failed checks line with the failed check’s glyph, × in a circle', () => {
		expect(checksGlyph('fail')).toBe(checkState({ state: 'fail' }));
		expect(checksGlyph('pass')).toBe('pass');
		expect(checksGlyph('pending')).toBe('running');
		expect(checksGlyph('none')).toBe('skipped');
	});
});
