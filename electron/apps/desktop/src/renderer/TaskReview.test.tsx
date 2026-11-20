import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	emptyTaskReviewView,
	type AgentTask,
	type TaskReview,
	type TaskReviewCommentRow,
	type TaskReviewView,
} from '@brigadir/core';
import { ReviewEventRow, ReviewStripView, retryReview, reviewStripState } from './TaskReview';
import type { EventRecord, SessionEvent } from '@brigadir/core';

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
	it('open on the plan: the sources stand before the reviewer', () => {
		const html = strip(
			view(
				{ state: 'reading', point: 'plan' },
				{
					sources: [
						{
							id: 's1',
							title: 'CRM-412',
							file: 'crm-412.md',
							chars: 10,
							savedAt: '2026-01-01T00:00:00.000Z',
						},
					],
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
		expect(html.indexOf('data-source="s1"')).toBeGreaterThan(-1);
		expect(html.indexOf('data-source="s1"')).toBeLessThan(html.indexOf('aria-label="Reviewer"'));
	});
	it('open: a finding shows its full path and line', () => {
		const html = strip(view({ state: 'passed' }, { comments: [finding('a', 'fixed')] }), true);
		expect(text(html)).toContain('src/OrdersTab.tsx:41 · Codex');
	});
	it("a step's tooltip names its review's own state: stopped, did not start, outdated, accepted", () => {
		const at = (state: TaskReview['state']) =>
			strip(
				view(
					{ state: 'passed', point: 'plan' },
					{ past: [review({ id: 'r1', point: 'mid', state })] }
				)
			);
		expect(at('stopped')).toContain('title="Mid-task review · stopped"');
		expect(at('failed')).toContain('title="Mid-task review · did not start"');
		expect(at('outdated')).toContain('title="Mid-task review · outdated"');
		expect(at('accepted')).toContain('title="Mid-task review · accepted"');
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

/** spec/reviews#class-row: the class row, a changed class, a hire's raise and the tripwire's review row. */
describe('class rows', () => {
	const row = (event: SessionEvent, locale: 'en' | 'uk' = 'en', auto = false) =>
		renderToStaticMarkup(
			<ReviewEventRow
				task={{
					...task,
					...(auto ? { auto: { roles: [], budget: { minutes: 40, tokens: 400_000 } } } : {}),
				}}
				record={{ schemaVersion: 1, seq: 1, at: '2026-11-19T10:00:00.000Z', event } as EventRecord}
				locale={locale}
			/>
		);
	const text = (html: string) =>
		html
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	it('states the class as a pill with its reason and what it adds', () => {
		const html = row({
			kind: 'task.class',
			class: 'small',
			reason: 'one screen, no contract change',
			by: 'agent',
		});
		expect(html).toContain('data-dot-pill="green"');
		expect(text(html)).toBe('class Small one screen, no contract change review before PR');
		expect(
			text(row({ kind: 'task.class', class: 'medium', reason: 'ticket CRM-412', by: 'agent' }))
		).toBe('class Medium ticket CRM-412 plan · plan review');
		expect(
			text(
				row(
					{ kind: 'task.class', class: 'large', reason: 'API and screen apart', by: 'agent' },
					'uk',
					true
				)
			)
		).toBe('клас Велика API and screen apart план · ревʼю · воркери');
	});
	it('a changed class shows both pills; a hire reads hires workers; the tripwire has no row of its own', () => {
		const changed = row(
			{
				kind: 'task.class',
				class: 'large',
				reason: '',
				by: 'host',
				previous: 'small',
				cause: 'hire',
			},
			'en',
			true
		);
		expect(changed).toContain('data-dot-pill="green"');
		expect(changed).toContain('data-dot-pill="yellow"');
		expect(text(changed)).toBe('class Small → Large hires workers plan · reviews · workers');
		expect(
			row({
				kind: 'task.class',
				class: 'medium',
				reason: '',
				by: 'host',
				previous: 'small',
				cause: 'threshold',
				files: 16,
				lines: 620,
			})
		).toBe('');
	});
	it("the tripwire's review row names the size and says more than a small task", () => {
		const html = row({
			kind: 'task-review.started',
			id: 'r1',
			point: 'mid',
			startedBy: 'host',
			reviewers: ['Codex'],
			threshold: { files: 14, lines: 620 },
		});
		expect(text(html)).toBe(
			'review mid-task Codex · 14 files · 620 lines more than a small task started'
		);
		expect(
			text(
				row(
					{
						kind: 'task-review.started',
						id: 'r1',
						point: 'mid',
						startedBy: 'host',
						reviewers: ['Codex'],
						threshold: { files: 14, lines: 621 },
					},
					'uk'
				)
			)
		).toBe('ревʼю посеред задачі Codex · 14 файлів · 621 рядок більше за малу задачу почалося');
		expect(
			text(
				row({
					kind: 'task-review.started',
					id: 'r2',
					point: 'mid',
					startedBy: 'host',
					reviewers: ['Codex'],
					hired: true,
				})
			)
		).toBe('review mid-task Codex · after the hired parts started');
	});
});

it('in a narrow column the step track gives way to the title and its line (spec/reviews#strip)', async () => {
	const { trackYields } = await import('./TaskReview');
	// The text fits: the track stays.
	expect(trackYields(false, 180, 200, 70)).toBe(false);
	// The text is cut: the track hides.
	expect(trackYields(false, 230, 200, 70)).toBe(true);
	// Hidden, the column grew by the track: it comes back only when the text fits beside it.
	expect(trackYields(true, 230, 270, 70)).toBe(true);
	expect(trackYields(true, 190, 270, 70)).toBe(false);
});
