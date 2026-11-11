import { describe, expect, it } from 'vitest';
import { liveReviewTask, prColumn, prColumns, waitingCount, type PRLocalReview } from './pr-board';
import type { AgentTask } from './workspace';
import type { PullRequestSummary } from './pull-requests';

const now = Date.parse('2026-10-26T12:00:00Z');
const pr = (over: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
	number: 1,
	title: 'T',
	url: 'https://github.com/o/r/pull/1',
	state: 'OPEN',
	author: 'ihor',
	mine: false,
	waiting: false,
	head: 'h',
	base: 'main',
	updatedAt: '2026-10-26T10:00:00Z',
	closedAt: null,
	reviewDecision: null,
	reviewers: [],
	comments: 0,
	checks: 'none',
	...over,
});
const started: PRLocalReview = { drafts: 2, note: false, viewed: null };

describe('prColumn (spec/projects-and-board#pr-mode)', () => {
	it('puts a draft in Draft even with a review', () => {
		expect(
			prColumn(
				pr({ state: 'DRAFT', reviewers: [{ login: 'olena', state: 'APPROVED' }] }),
				started,
				now
			)
		).toBe('draft');
	});
	it('keeps an open PR with only requested reviewers in Open', () => {
		expect(prColumn(pr({ reviewers: [{ login: 'olena', state: 'REQUESTED' }] }), null, now)).toBe(
			'open'
		);
	});
	it('moves a PR reviewed by someone else on GitHub to In review', () => {
		expect(prColumn(pr({ reviewers: [{ login: 'olena', state: 'COMMENTED' }] }), null, now)).toBe(
			'review'
		);
	});
	it('ignores the author commenting on their own PR', () => {
		expect(prColumn(pr({ reviewers: [{ login: 'ihor', state: 'COMMENTED' }] }), null, now)).toBe(
			'open'
		);
	});
	it('moves a PR with a review started here to In review', () => {
		expect(prColumn(pr(), started, now)).toBe('review');
		expect(prColumn(pr(), { drafts: 0, note: false, viewed: { n: 1, of: 6 } }, now)).toBe('review');
		expect(prColumn(pr(), { drafts: 0, note: true, viewed: null }, now)).toBe('review');
		expect(prColumn(pr(), { drafts: 0, note: false, viewed: { n: 0, of: 6 } }, now)).toBe('open');
	});
	it('shows closed PRs for 7 days only', () => {
		expect(prColumn(pr({ state: 'MERGED', closedAt: '2026-10-23T12:00:00Z' }), null, now)).toBe(
			'closed'
		);
		expect(
			prColumn(pr({ state: 'CLOSED', closedAt: '2026-10-10T12:00:00Z' }), null, now)
		).toBeNull();
	});
});

describe('prColumns', () => {
	it('keeps every column, waiting first, then fresher', () => {
		const items = [
			{ pr: pr({ number: 1, updatedAt: '2026-10-26T11:00:00Z' }) },
			{ pr: pr({ number: 2, updatedAt: '2026-10-25T11:00:00Z', waiting: true }) },
			{ pr: pr({ number: 3, updatedAt: '2026-10-26T11:30:00Z' }) },
		];
		const columns = prColumns(items, 'all', now);
		expect(columns.map((c) => c.column)).toEqual(['draft', 'open', 'review', 'closed']);
		expect(columns[1]!.items.map((i) => i.pr.number)).toEqual([2, 3, 1]);
		expect(columns[0]!.items).toEqual([]);
	});
	it('filters yours and waiting for you', () => {
		const items = [
			{ pr: pr({ number: 1, mine: true }) },
			{ pr: pr({ number: 2, waiting: true }) },
			{ pr: pr({ number: 3 }) },
		];
		const numbers = (filter: 'mine' | 'waiting') =>
			prColumns(items, filter, now).flatMap((c) => c.items.map((i) => i.pr.number));
		expect(numbers('mine')).toEqual([1]);
		expect(numbers('waiting')).toEqual([2]);
		expect(waitingCount(items.map((i) => i.pr))).toBe(1);
	});
});

describe('the live review task of a PR (spec/pull-requests-and-ci#review-with-agent)', () => {
	const task = (over: Partial<AgentTask>): AgentTask =>
		({
			id: 't1',
			projectId: 'p',
			title: 'Review #7',
			status: 'working',
			prReview: { scopeId: 'main-repo', number: 7, mode: 'review', base: 'main', repo: 'mobile' },
			updatedAt: '2026-11-11T10:00:00Z',
			...over,
		}) as AgentTask;
	const pr = { projectId: 'p', number: 7, scopeId: 'main-repo' };
	it('finds it by the repo id, or by the repo name from a worktree', () => {
		expect(liveReviewTask([task({})], pr)?.id).toBe('t1');
		expect(
			liveReviewTask([task({})], { ...pr, scopeId: 'worktree-repo', repo: 'mobile' })?.id
		).toBe('t1');
		expect(liveReviewTask([task({})], { ...pr, scopeId: 'worktree-repo' })).toBeNull();
	});
	it('skips archived tasks, other modes, numbers and projects; the newest of several wins', () => {
		expect(
			liveReviewTask([task({ archived: { at: '2026-11-11T11:00:00Z' } as never })], pr)
		).toBeNull();
		expect(
			liveReviewTask(
				[task({ prReview: { scopeId: 'main-repo', number: 7, mode: 'fix', base: 'main' } })],
				pr
			)
		).toBeNull();
		expect(liveReviewTask([task({})], { ...pr, number: 8 })).toBeNull();
		expect(liveReviewTask([task({})], { ...pr, projectId: 'q' })).toBeNull();
		expect(
			liveReviewTask([task({}), task({ id: 't2', updatedAt: '2026-11-11T12:00:00Z' })], pr)?.id
		).toBe('t2');
	});
});
