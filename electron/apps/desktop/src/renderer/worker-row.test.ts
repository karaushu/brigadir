import { expect, it } from 'vitest';
import type { TaskReviewMember } from '@brigadir/core';
import { reviewerState } from './worker-row';

const member = (state: TaskReviewMember['state'], findings = 2): TaskReviewMember => ({
	name: 'Codex 2',
	provider: 'codex',
	taskId: 'r1',
	state,
	findings,
	since: null,
});
const of = (state: TaskReviewMember['state'], findings?: number) =>
	reviewerState({ members: [member(state, findings)] }, 'r1', 'en');

it("a reviewer row says the current review's state, never its task title (spec/reviews#surfaces)", () => {
	expect(of('reading')).toEqual({ state: 'Review' });
	expect(of('findings')).toEqual({ state: '2 findings · waits' });
	expect(of('open', 1)).toEqual({ state: '1 finding open', stateTone: 'amber' });
	expect(of('approved')).toEqual({ state: 'Approved' });
	expect(of('accepted')).toEqual({ state: 'Accepted' });
	expect(of('stopped')).toEqual({ state: 'Review stopped' });
	expect(of('failed')).toEqual({ state: 'Review did not start' });
	expect(reviewerState({ members: [member('accepted')] }, 'r1', 'uk')).toEqual({
		state: 'Прийнято',
	});
	expect(reviewerState({ members: [] }, 'r1', 'en')).toEqual({});
});
