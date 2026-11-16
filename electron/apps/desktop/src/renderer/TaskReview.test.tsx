import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	emptyTaskReviewView,
	type AgentTask,
	type TaskReview,
	type TaskReviewCommentRow,
	type TaskReviewView,
} from '@brigadir/core';
import { ReviewStripView, retryReview, reviewStripState } from './TaskReview';

/** spec/reviews#strip: the strip's row in every state, from props only. */
const task = { projectId: 'p', id: 't', title: 'Client screen', provider: 'claude' } as AgentTask;
const review = (patch: Partial<TaskReview>): TaskReview => ({
	id: 'r2',
	point: 'pre-pr',
	target: { taskId: 't' },
	startedBy: 'person',
	who: { kind: 'agent' },
	instructions: '',
	guidance: '',
	startedAt: '2026-01-01T00:00:00.000Z',
	state: 'reading',
	round: 1,
	passes: 0,
	reviewers: ['Codex'],
	trees: [],
	...patch,
});
const finding = (
	id: string,
	state: TaskReviewCommentRow['state'],
	reason: string | null = null
): TaskReviewCommentRow => ({
	id,
	reviewId: 'r2',
	text: `Finding ${id}`,
	path: 'src/OrdersTab.tsx',
	line: 41,
	scopeId: 's1',
	reviewer: 'Codex',
	round: 1,
	state,
	answer: null,
	reason,
});
const view = (patch: Partial<TaskReview>, more: Partial<TaskReviewView> = {}): TaskReviewView => ({
	...emptyTaskReviewView,
	review: review(patch),
	past: [review({ id: 'r1', point: 'mid', state: 'passed', startedBy: 'agent' })],
	...more,
});
const noop = () => {};
function strip(value: TaskReviewView, open = false) {
	return renderToStaticMarkup(
		<ReviewStripView
			task={task}
			view={value}
			locale="en"
			open={open}
			point={null}
			now={Date.parse('2026-01-01T00:01:00.000Z')}
			disabled={false}
			onToggle={noop}
			onStep={noop}
			onStop={noop}
			onDecide={noop}
			onRetry={noop}
			onAgain={noop}
			onCreatePR={noop}
			onHide={noop}
			onComment={noop}
			onReviewer={noop}
		/>
	);
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttons = (html: string) =>
	[...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)]
		.map((match) => text(match[1]!).trim())
		.filter(Boolean);

describe('the Review strip (spec/reviews#strip)', () => {
	it('reviewer reading: the point and the reviewer, Stop, the current step on the track', () => {
		const html = strip(view({ state: 'reading' }));
		expect(html).toContain('data-review-strip="reading"');
		expect(text(html)).toContain('Review before PR · Codex reading');
		expect(buttons(html)).toContain('Stop');
		// Three steps: the plan not started, the mid-task review passed (green), the current one — every step can be picked.
		expect(html.match(/data-step="/g)).toHaveLength(3);
		expect(html).not.toMatch(/data-step="plan" disabled=""/);
		expect(html).toMatch(/aria-current="step"[^>]*data-step="pre-pr"/);
		expect(html).toMatch(/data-tone="green" data-step="mid"/);
		expect(html).not.toMatch(/<li[^>]*data-tone=/);
	});
	it('author fixing, then the reviewer verifying', () => {
		const fixing = strip(
			view({ state: 'fixing' }, { comments: [finding('a', 'sent'), finding('b', 'sent')] })
		);
		expect(text(fixing)).toContain('Claude fixes 2 findings');
		expect(buttons(fixing)).toContain('Stop');
		const verifying = strip(view({ state: 'verifying', round: 2 }));
		expect(text(verifying)).toContain('Codex checks the fixes');
	});
	it('open findings with the person: amber row, Fix {n} and Accept, the list open with the open ones first', () => {
		const html = strip(
			view(
				{ state: 'yours', round: 2 },
				{
					comments: [
						finding('a', 'fixed'),
						finding('b', 'new', 'The fix brought it in.'),
						finding('c', 'open', 'Still refetches.'),
					],
				}
			)
		);
		expect(html).toMatch(/<li[^>]*data-tone="amber"/);
		expect(text(html)).toContain('Your call');
		expect(text(html)).toContain('2 findings open');
		expect(buttons(html)).toEqual(expect.arrayContaining(['Fix 2', 'Accept']));
		expect(buttons(html)).not.toContain('Stop');
		const order = [...html.matchAll(/data-finding="(\w+)"/g)].map((match) => match[1]);
		expect(order).toEqual(['open', 'new', 'fixed']);
		expect(text(html)).toContain('Codex: Still refetches.');
	});
	it('passed before the PR: green row, Create PR without an ellipsis; a mid-task pass has no Create PR', () => {
		const html = strip(view({ state: 'passed', round: 2 }, { comments: [finding('a', 'fixed')] }));
		expect(html).toMatch(/<li[^>]*data-tone="green"/);
		expect(text(html)).toContain('Review passed');
		expect(buttons(html)).toContain('Create PR');
		const clean = strip(view({ state: 'passed', point: 'mid', startedBy: 'agent' }));
		expect(text(clean)).toContain('no findings');
		expect(buttons(clean)).not.toContain('Create PR');
	});
	it('accepted: no fill (it did not pass), the accepted count and Create PR', () => {
		const html = strip(view({ state: 'accepted' }, { comments: [finding('a', 'accepted')] }));
		expect(html).not.toMatch(/<li[^>]*data-tone=/);
		expect(text(html)).toContain('Review closed');
		expect(text(html)).toContain('1 accepted');
	});
	it('stopped offers Start again…; could not start offers Retry with the reason', () => {
		const stopped = strip(view({ state: 'stopped' }));
		expect(text(stopped)).toContain('Review stopped');
		expect(buttons(stopped)).toContain('Start again…');
		const failed = strip(
			view({ state: 'failed', failure: 'No reviewer is available: no agent is signed in.' })
		);
		expect(failed).toContain('data-review-strip="failed"');
		expect(text(failed)).toContain('Review did not start No reviewer is available');
		expect(buttons(failed)).toContain('Retry');
	});
	it('no row when nothing was started or a pass went out of date', () => {
		expect(reviewStripState(emptyTaskReviewView)).toBeNull();
		expect(reviewStripState(view({ state: 'outdated' }))).toBeNull();
		expect(strip(emptyTaskReviewView)).toBe('');
	});
	it('a reviewer that failed to start turns a running review into could not start', () => {
		expect(
			reviewStripState(
				view(
					{ state: 'reading' },
					{
						members: [
							{
								name: 'Codex',
								provider: 'codex',
								taskId: 'w',
								state: 'failed',
								findings: 0,
								since: null,
								failure: 'Codex is not signed in',
							},
						],
					}
				)
			)
		).toBe('failed');
	});
	it('open: the segment of the three points and the reviewer row with its log', () => {
		const html = strip(
			view(
				{ state: 'reading' },
				{
					members: [
						{
							name: 'Codex',
							provider: 'codex',
							taskId: 'w',
							state: 'reading',
							findings: 0,
							since: '2026-01-01T00:00:00.000Z',
						},
					],
				}
			),
			true
		);
		expect(html).toContain('data-review-details="pre-pr"');
		expect(text(html)).toMatch(/Plan.*Mid-task.*Before PR/);
		expect(text(html)).toContain('Codex · Codex');
		expect(buttons(html)).toContain('Log');
	});
	it('open: the details are the deck fill under the strip row, and an approval remark stands under its reviewer', () => {
		const html = strip(
			view(
				{ state: 'passed' },
				{
					members: [
						{
							name: 'Codex',
							provider: 'codex',
							taskId: 'w',
							state: 'approved',
							findings: 0,
							since: '2026-01-01T00:00:00.000Z',
							note: 'Ran the greet script: it prints HELLO, ANN.',
						},
					],
				}
			),
			true
		);
		// The strip's row stays outside the fill, which scrolls (spec/reviews#strip).
		expect(html.indexOf('data-review-strip')).toBeLessThan(html.indexOf('data-deck-fill'));
		expect(html.indexOf('data-deck-fill')).toBeLessThan(html.indexOf('data-review-details'));
		expect(text(html)).toContain('Ran the greet script: it prints HELLO, ANN.');
		expect(strip(view({ state: 'passed' }), false)).not.toContain('data-deck-fill');
	});
});

describe('Retry (spec/reviews#strip)', () => {
	const bridge = () => {
		const calls: string[] = [];
		return {
			calls,
			stopTaskReview: async () => {
				calls.push('stop');
			},
			startTaskReview: async (_: unknown, choice: { point?: string }) => {
				calls.push(`start ${choice.point}`);
				return null;
			},
		};
	};
	it('stops a review whose reviewer failed to start before starting a new one', async () => {
		const b = bridge();
		expect(await retryReview(task, { point: 'pre-pr', state: 'reading' }, b as never)).toBeNull();
		expect(b.calls).toEqual(['stop', 'start pre-pr']);
	});
	it('starts at once after a review that could not start', async () => {
		const b = bridge();
		await retryReview(task, { point: 'mid', state: 'failed' }, b as never);
		expect(b.calls).toEqual(['start mid']);
	});
});
