import { expect, it } from 'vitest';
import { taskActivity, type EventRecord, type SessionEvent } from '@brigadir/core';
import { workspaceEventKinds } from './workspace-events';

const records = (...events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({ schemaVersion: 1, seq: index + 1, at: '', event }));
const plan: SessionEvent = {
	kind: 'permission.requested',
	request: {
		id: 'p1',
		tool: { id: 't1', title: 'Approve Plan', category: 'switch_mode', status: 'pending' },
		options: [],
	} as never,
};
const verified: SessionEvent = {
	kind: 'task-review.verified',
	id: 'r1',
	point: 'plan',
	closed: 0,
	open: 1,
	introduced: 0,
};
// spec/sidebar#activity-line: seen live — `Accept` on a plan review left the card on `Review · 1 finding open`, because nothing re-read the
// workspace after the review's own events.
it('re-reads the workspace after every review event that changes the activity line', () => {
	const steps: SessionEvent[] = [
		plan,
		verified,
		{ kind: 'task-review.decided', id: 'r1', point: 'plan', decision: 'accept', findings: 1 },
		{ kind: 'task-review.finished', id: 'r1', point: 'plan', state: 'accepted' },
	];
	let before = taskActivity([]);
	steps.forEach((event, index) => {
		const after = taskActivity(records(...steps.slice(0, index + 1)));
		if (JSON.stringify(after) !== JSON.stringify(before))
			expect(workspaceEventKinds.has(event.kind), event.kind).toBe(true);
		before = after;
	});
	expect(taskActivity(records(...steps))).toMatchObject({ kind: 'plan' });
	expect(taskActivity(records(plan, verified))).toMatchObject({ kind: 'review' });
});
it('re-reads the workspace when a hire card, a model question or a worker changes the card', () => {
	for (const kind of [
		'crew.hire.requested',
		'crew.hire.resolved',
		'crew.model.requested',
		'crew.model.resolved',
		'crew.worker.dismissed',
		'crew.budget.exceeded',
		'task-review.started',
		'task-review.finished',
	])
		expect(workspaceEventKinds.has(kind), kind).toBe(true);
});
