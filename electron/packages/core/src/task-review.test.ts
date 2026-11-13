import { describe, expect, it } from 'vitest';
import {
	emptyTaskReviewDocument,
	readTaskReviewDocument,
	resolveReviewer,
	reviewLoop,
	taskReviewAt,
	taskReviewCommentState,
	taskReviewCovers,
	taskReviewLive,
	taskReviewPastLimit,
	taskReviewRunning,
	taskReviewStep,
	withNextReview,
	type ReviewLoopEvent,
	type TaskReview,
	type TaskReviewState,
} from './task-review';
import { isSessionEvent } from './event-validation';
import { isSessionCommand, type EventRecord, type SessionEvent } from './session';
import { taskActivity } from './task-activity';
import { noticeKind } from './notifications';

/** Runs the loop from `waiting` and returns every state it passed and the actions the host took. */
function run(events: ReviewLoopEvent[], from: TaskReviewState = 'waiting') {
	let state = from;
	const states: TaskReviewState[] = [state],
		actions: string[] = [];
	for (const event of events) {
		const next = reviewLoop(state, event);
		if (!next) throw new Error(`${state} does not take ${event.kind}`);
		state = next.state;
		states.push(state);
		actions.push(next.action);
	}
	return { state, states, actions };
}
const review = (patch: Partial<TaskReview> = {}): TaskReview => ({
	id: 'r1',
	point: 'pre-pr',
	target: { taskId: 't1' },
	startedBy: 'person',
	who: { kind: 'agent' },
	instructions: '',
	guidance: '',
	startedAt: '2026-01-01T00:00:00.000Z',
	state: 'passed',
	round: 2,
	passes: 1,
	reviewers: ['Codex'],
	trees: [{ scopeId: 's1', tree: 'a'.repeat(40) }],
	...patch,
});

describe('the loop of one read, one fix, one closure check (spec/reviews#loop)', () => {
	it('passes at once when the first read lists no findings', () => {
		expect(run([{ kind: 'begin' }, { kind: 'read', findings: 0 }])).toEqual({
			state: 'passed',
			states: ['waiting', 'reading', 'passed'],
			actions: ['read', 'finish'],
		});
	});
	it('passes after the author fixed every finding and the closure check closed them', () => {
		expect(
			run([
				{ kind: 'begin' },
				{ kind: 'read', findings: 3 },
				{ kind: 'answered' },
				{ kind: 'verified', open: 0 },
			]).actions
		).toEqual(['read', 'deliver', 'verify', 'finish']);
	});
	it('an objection the reviewer accepts closes like a fix: the closure check passes', () => {
		// The author answered with review_reply instead of a change; the reviewer approves, open = 0.
		expect(
			run([
				{ kind: 'begin' },
				{ kind: 'read', findings: 1 },
				{ kind: 'answered' },
				{ kind: 'verified', open: 0 },
			]).state
		).toBe('passed');
	});
	it('a finding still open or a problem the fix introduced goes to the person; no automatic third round', () => {
		const result = run([
			{ kind: 'begin' },
			{ kind: 'read', findings: 2 },
			{ kind: 'answered' },
			{ kind: 'verified', open: 1 },
		]);
		expect(result.state).toBe('yours');
		expect(result.actions.at(-1)).toBe('person');
		// Another answered turn opens nothing while the person decides.
		expect(reviewLoop('yours', { kind: 'answered' })).toBeNull();
		expect(reviewLoop('yours', { kind: 'verified', open: 0 })).toBeNull();
	});
	it('`Fix {n}` runs one more author pass and one more closure check, then the person again if anything stays open', () => {
		const fixed = run(
			[{ kind: 'decided', decision: 'fix' }, { kind: 'answered' }, { kind: 'verified', open: 0 }],
			'yours'
		);
		expect(fixed.actions).toEqual(['deliver', 'verify', 'finish']);
		expect(fixed.state).toBe('passed');
		expect(
			run(
				[{ kind: 'decided', decision: 'fix' }, { kind: 'answered' }, { kind: 'verified', open: 1 }],
				'yours'
			).state
		).toBe('yours');
	});
	it('`Accept` ends the review as accepted; a second decision is refused', () => {
		expect(run([{ kind: 'decided', decision: 'accept' }], 'yours')).toMatchObject({
			state: 'accepted',
			actions: ['finish'],
		});
		expect(reviewLoop('accepted', { kind: 'decided', decision: 'fix' })).toBeNull();
	});
	it('stops from every state that lives, never from an end', () => {
		for (const state of ['waiting', 'reading', 'fixing', 'verifying', 'yours'] as const)
			expect(reviewLoop(state, { kind: 'stop' })).toEqual({ state: 'stopped', action: 'finish' });
		for (const state of ['passed', 'accepted', 'stopped', 'failed', 'outdated'] as const)
			expect(reviewLoop(state, { kind: 'stop' })).toBeNull();
	});
	it('a late verdict of an earlier step changes nothing; a change outdates only an ended pass', () => {
		expect(reviewLoop('fixing', { kind: 'read', findings: 2 })).toBeNull();
		expect(reviewLoop('reading', { kind: 'verified', open: 0 })).toBeNull();
		expect(reviewLoop('passed', { kind: 'changed' })).toEqual({
			state: 'outdated',
			action: 'finish',
		});
		expect(reviewLoop('yours', { kind: 'changed' })).toBeNull();
	});
	it('says which reviews live, run and how each point steps on the track', () => {
		expect(taskReviewLive(review({ state: 'yours' }))).toBe(true);
		expect(taskReviewRunning(review({ state: 'yours' }))).toBe(false);
		expect(taskReviewStep(null)).toBe('none');
		expect(taskReviewStep(review({ state: 'verifying' }))).toBe('live');
		expect(taskReviewStep(review({ state: 'yours' }))).toBe('yours');
		expect(taskReviewStep(review({ state: 'accepted' }))).toBe('done');
		expect(taskReviewStep(review({ state: 'failed' }))).toBe('ended');
	});
});

describe('the review document (spec/reviews#data)', () => {
	it('reads a version-1 document as a review before the PR the person started', () => {
		const v1 = {
			schemaVersion: 1,
			proposal: { summary: 'Done', at: '2026-01-01T00:00:00.000Z' },
			review: {
				id: 'old',
				who: { kind: 'agent' },
				instructions: 'Look',
				guidance: '',
				startedAt: '2026-01-01T00:00:00.000Z',
				state: 'disputed',
				round: 2,
				reviewers: ['Reviewer'],
				trees: [{ scopeId: 's1', tree: 'b'.repeat(40) }],
			},
		};
		const doc = readTaskReviewDocument(v1, 't9')!;
		expect(doc).toMatchObject({
			schemaVersion: 2,
			proposal: { summary: 'Done' },
			past: [],
			review: {
				id: 'old',
				point: 'pre-pr',
				target: { taskId: 't9' },
				startedBy: 'person',
				state: 'yours',
				round: 2,
				passes: 1,
			},
		});
		const states = (['reviewing', 'comments', 'approved', 'outdated', 'stopped'] as const).map(
			(state) =>
				readTaskReviewDocument({ ...v1, review: { ...v1.review, state, round: 1 } }, 't9')!.review!
					.state
		);
		expect(states).toEqual(['reading', 'fixing', 'passed', 'outdated', 'stopped']);
		expect(
			readTaskReviewDocument({ schemaVersion: 1, proposal: null, review: null }, 't9')
		).toEqual(emptyTaskReviewDocument);
		expect(readTaskReviewDocument({ schemaVersion: 3 }, 't9')).toBeNull();
	});
	it('keeps the earlier reviews, newest last, at most the limit; each point shows its last', () => {
		let doc = emptyTaskReviewDocument;
		for (let n = 0; n < taskReviewPastLimit + 3; n++)
			doc = withNextReview(doc, review({ id: `r${n}`, point: n % 2 ? 'mid' : 'pre-pr' }));
		expect(doc.past).toHaveLength(taskReviewPastLimit);
		expect(doc.review!.id).toBe(`r${taskReviewPastLimit + 2}`);
		expect(taskReviewAt(doc, 'pre-pr')!.id).toBe(`r${taskReviewPastLimit + 2}`);
		expect(taskReviewAt(doc, 'mid')!.id).toBe(`r${taskReviewPastLimit + 1}`);
		expect(taskReviewAt(doc, 'plan')).toBeNull();
		expect(readTaskReviewDocument(doc, 't1')).toBe(doc);
	});
	it('a pass, an acceptance or a stop covers exactly the trees it read', () => {
		const now = [{ scopeId: 's1', tree: 'a'.repeat(40) }];
		for (const state of ['passed', 'accepted', 'stopped'] as const)
			expect(taskReviewCovers(review({ state }), now)).toBe(true);
		expect(taskReviewCovers(review({ state: 'yours' }), now)).toBe(false);
		expect(taskReviewCovers(review(), [{ scopeId: 's1', tree: 'c'.repeat(40) }])).toBe(false);
		// A repo that joined the task after the review (a new gitignored nested repo) is not covered.
		expect(taskReviewCovers(review(), [...now, { scopeId: 's2', tree: 'e'.repeat(40) }])).toBe(
			false
		);
	});
});

describe('findings (spec/reviews#findings)', () => {
	const marks = (review: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		taskReviewCommentState({
			review: { reviewId: 'r', round: 1, reviewer: 'Codex', ...review },
			...extra,
		} as Parameters<typeof taskReviewCommentState>[0]);
	it('tells sent, fixed, answered, open, new, accepted from the marks, the thread and the diff', () => {
		expect(marks({})).toBe('sent');
		expect(marks({}, { addressed: true })).toBe('fixed');
		expect(marks({}, { replies: [{ agent: true }] })).toBe('answered');
		expect(marks({ open: 2 })).toBe('open');
		expect(marks({ open: 2, closed: 3 }, { addressed: true })).toBe('fixed');
		expect(marks({ introduced: 2 })).toBe('new');
		expect(marks({ introduced: 2, closed: 3 })).toBe('fixed');
		expect(marks({ closed: 2 }, { replies: [{ agent: true }] })).toBe('answered');
		expect(marks({ open: 2, accepted: true })).toBe('accepted');
		// An older journal's insistence in round 2 reads as open.
		expect(marks({ disputed: true })).toBe('open');
	});
});

describe('who reviews (spec/reviews#who)', () => {
	const providers = ['claude', 'codex'] as const;
	const enabled = { claude: true, codex: true };
	const defaults = {
		claude: { model: 'opus', effort: 'high' },
		codex: { model: 'gpt', effort: 'medium' },
	};
	it('takes another provider that is enabled and signed in, with its catalog defaults', () => {
		expect(
			resolveReviewer({
				providers,
				author: 'claude',
				enabled,
				ready: { claude: true, codex: true },
				override: null,
				defaults,
			})
		).toEqual({ provider: 'codex', model: 'gpt', effort: 'medium', source: 'other' });
	});
	it('without another signed-in provider takes a fresh session of the task’s own', () => {
		// Codex signed out, its sign-in not known, or Codex switched off.
		for (const [ready, on] of [
			[{ codex: false }, true],
			[{}, true],
			[{ codex: true }, false],
		] as const)
			expect(
				resolveReviewer({
					providers,
					author: 'claude',
					enabled: { claude: true, codex: on },
					ready,
					override: null,
					defaults,
				})
			).toMatchObject({ provider: 'claude', source: 'same' });
		expect(
			resolveReviewer({
				providers,
				author: 'codex',
				enabled: { claude: false, codex: true },
				ready: { claude: true },
				override: null,
			})
		).toEqual({ provider: 'codex', model: null, effort: null, source: 'same' });
	});
	it('the setting overrides both, while its provider is enabled', () => {
		const override = { provider: 'claude' as const, model: 'sonnet', effort: null };
		expect(
			resolveReviewer({
				providers,
				author: 'claude',
				enabled,
				ready: { codex: true },
				override,
			})
		).toEqual({ ...override, source: 'setting' });
		expect(
			resolveReviewer({
				providers,
				author: 'claude',
				enabled: { claude: true, codex: false },
				ready: { codex: true },
				override: { provider: 'codex', model: 'gpt', effort: null },
			})
		).toMatchObject({ provider: 'claude', source: 'same' });
	});
	it('nobody when the task’s own provider is signed out and no other is ready', () => {
		expect(
			resolveReviewer({
				providers,
				author: 'claude',
				enabled,
				ready: { claude: false, codex: false },
				override: null,
			})
		).toEqual({ failure: 'No reviewer is available: no agent is signed in.' });
	});
});

describe('journal and commands (spec/reviews#data, rule 2)', () => {
	it('takes the new event kinds and keeps the older review kinds readable', () => {
		for (const event of [
			{
				kind: 'task-review.started',
				id: 'r1',
				point: 'mid',
				startedBy: 'agent',
				reviewers: ['Codex'],
				reason: 'the data layer',
			},
			{ kind: 'task-review.findings', id: 'r1', point: 'mid', findings: 2, reviewers: ['Codex'] },
			{ kind: 'task-review.answered', id: 'r1', point: 'mid', fixed: 1, answered: 1 },
			{ kind: 'task-review.verified', id: 'r1', point: 'mid', closed: 1, open: 1, introduced: 0 },
			{ kind: 'task-review.decided', id: 'r1', point: 'mid', decision: 'fix', findings: 1 },
			{ kind: 'task-review.finished', id: 'r1', point: 'mid', state: 'failed', failure: 'x' },
			// An older journal.
			{ kind: 'review.started', id: 'r0', reviewers: ['Reviewer'], who: { kind: 'agent' } },
			{
				kind: 'crew.review',
				reviewId: 'run',
				taskId: 't1',
				name: 'Task agent',
				reviewer: 'Reviewer',
				round: 2,
				approved: false,
				comments: 1,
				state: 'disputed',
			},
			{ kind: 'review.finished', id: 'r0', state: 'disputed' },
		])
			expect(isSessionEvent(event), event.kind).toBe(true);
		expect(
			isSessionEvent({ kind: 'task-review.finished', id: 'r1', point: 'mid', state: 'disputed' })
		).toBe(false);
		expect(isSessionEvent({ kind: 'task-review.started', id: 'r1', point: 'later' })).toBe(false);
	});
	it('a start without reviewers carries why nobody reviews; the person decides with fix or accept', () => {
		const base = { kind: 'startReview', who: { kind: 'agent' }, instructions: '', guidance: '' };
		expect(isSessionCommand({ ...base, reviewers: [] })).toBe(false);
		expect(isSessionCommand({ ...base, reviewers: [], failure: 'No reviewer is available.' })).toBe(
			true
		);
		expect(isSessionCommand({ kind: 'decideReview', decision: 'accept' })).toBe(true);
		expect(isSessionCommand({ kind: 'decideReview', decision: 'later' })).toBe(false);
	});
});

describe('a review waiting for the person (spec/reviews#surfaces)', () => {
	const records = (...events: SessionEvent[]): EventRecord[] =>
		events.map((event, index) => ({ schemaVersion: 1, seq: index + 1, at: '', event }));
	const verified = (open: number, introduced = 0): SessionEvent => ({
		kind: 'task-review.verified',
		id: 'r1',
		point: 'pre-pr',
		closed: 1,
		open,
		introduced,
	});
	it('is the needs-you reason line until the person decides', () => {
		expect(taskActivity(records(verified(2)))).toEqual({
			kind: 'review',
			title: '',
			path: null,
			count: 2,
		});
		expect(taskActivity(records(verified(0)))).toBeNull();
		// A problem the fix introduced waits for the person too.
		expect(taskActivity(records(verified(0, 1)))).toMatchObject({ kind: 'review', count: 1 });
		expect(
			taskActivity(
				records(verified(1), {
					kind: 'task-review.decided',
					id: 'r1',
					point: 'pre-pr',
					decision: 'accept',
					findings: 1,
				})
			)
		).toBeNull();
	});
	it('notifies as needs-you only when something is open', () => {
		expect(noticeKind(verified(1))).toBe('needs-you');
		expect(noticeKind(verified(0, 1))).toBe('needs-you');
		expect(noticeKind(verified(0))).toBeNull();
	});
});
