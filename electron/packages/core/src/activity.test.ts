import { expect, it } from 'vitest';
import { activityRows } from './activity';
import { isSessionEvent } from './event-validation';
import {
	isUserQuestion,
	pendingInputs,
	validAnswer,
	type EventRecord,
	type SessionEvent,
} from './session';
const records = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, i) => ({ schemaVersion: 1, seq: i + 1, at: '2026-09-09T00:00:00Z', event }));
it('groups message deltas by turn and message ID, and preserves absent tool fields', () => {
	const rows = activityRows(
		records([
			{ kind: 'turn.started', text: 'one' },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'a',
				content: { kind: 'text', text: 'hello ' },
			},
			{
				kind: 'tool.changed',
				patch: { id: 't', title: 'Read', content: [{ kind: 'text', text: 'content' }] },
			},
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'a',
				content: { kind: 'text', text: 'world' },
			},
			{ kind: 'tool.changed', patch: { id: 't', status: 'completed' } },
			{ kind: 'turn.completed', reason: 'end_turn' },
			{ kind: 'turn.started', text: 'two' },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'a',
				content: { kind: 'text', text: 'new turn' },
			},
		])
	);
	expect(rows.filter((r) => r.kind === 'message').map((r) => r.text)).toEqual([
		'one',
		'hello world',
		'two',
		'new turn',
	]);
	expect(rows.find((r) => r.kind === 'tool')).toMatchObject({
		contentSeq: 3,
		tool: { title: 'Read', status: 'completed', content: [{ kind: 'text', text: 'content' }] },
	});
});
it('validates persisted payloads and exact human-answer constraints', () => {
	expect(isSessionEvent({ kind: 'tool.changed', patch: {} })).toBe(false);
	expect(
		isSessionEvent({
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 5 },
		})
	).toBe(false);
	const question = {
		id: 'q',
		header: 'Pick',
		question: 'Which?',
		options: [
			{ label: 'One', description: '' },
			{ label: 'Two', description: '' },
		],
		allowsMultiple: false,
		allowsFreeText: false,
	};
	expect(isUserQuestion(question)).toBe(true);
	expect(validAnswer(question, { labels: ['One'], text: '' })).toBe(true);
	for (const answer of [
		{ labels: ['One', 'Two'], text: '' },
		{ labels: ['One', 'One'], text: '' },
		{ labels: [], text: 'free' },
		{ labels: ['Unknown'], text: '' },
	])
		expect(validAnswer(question, answer)).toBe(false);
	expect(
		pendingInputs(
			records([
				{ kind: 'question.requested', question },
				{ kind: 'question.resolved', id: 'q', answer: null },
			])
		).questions
	).toEqual([]);
});
it('updates one stable plan row per turn without mutating the journal or previous turns', () => {
	const events = records([
		{ kind: 'turn.started', text: 'First' },
		{
			kind: 'plan.changed',
			entries: [{ text: 'First step', priority: 'medium', status: 'pending' }],
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'Working' },
		},
		{
			kind: 'plan.changed',
			entries: [{ text: 'First step', priority: 'medium', status: 'completed' }],
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'turn.started', text: 'Second' },
		{
			kind: 'plan.changed',
			entries: [{ text: 'New step', priority: 'medium', status: 'in_progress' }],
		},
	]);
	const plans = activityRows(events).filter(
		(row) => row.kind === 'event' && row.record.event.kind === 'plan.changed'
	);
	expect(plans.map((row) => row.id)).toEqual(['event-2', 'event-7']);
	expect(plans[0]).toMatchObject({
		record: { seq: 4, event: { entries: [{ status: 'completed' }] } },
	});
	expect(events[1]?.event).toMatchObject({ entries: [{ status: 'pending' }] });
});
it('measures tool duration from journal updates and stops elapsed at the turn boundary', () => {
	const input = records([
		{ kind: 'turn.started', text: 'Run' },
		{ kind: 'tool.changed', patch: { id: 'done', status: 'in_progress' } },
		{ kind: 'tool.changed', patch: { id: 'cancelled', status: 'in_progress' } },
		{ kind: 'tool.changed', patch: { id: 'done', status: 'completed' } },
		{ kind: 'host.stopped', reason: 'Stop' },
	]);
	input.forEach((record, index) => (record.at = new Date(index * 1000).toISOString()));
	expect(
		activityRows(input)
			.filter((row) => row.kind === 'tool')
			.map((row) => ({ id: row.tool.id, start: row.startedAt, end: row.finishedAt }))
	).toEqual([
		{ id: 'done', start: 1000, end: 3000 },
		{ id: 'cancelled', start: 2000, end: 4000 },
	]);
});
it('times a thought from its first chunk to its last; one chunk has no duration (spec/chat#collapse-rules)', () => {
	const at = (s: number) => `2026-09-09T00:00:${String(s).padStart(2, '0')}Z`;
	const rows = activityRows([
		{ schemaVersion: 1, seq: 1, at: at(0), event: { kind: 'turn.started', text: 'one' } },
		{
			schemaVersion: 1,
			seq: 2,
			at: at(1),
			event: {
				kind: 'message.delta',
				role: 'thought',
				messageId: 't',
				content: { kind: 'text', text: 'a' },
			},
		},
		{
			schemaVersion: 1,
			seq: 3,
			at: at(9),
			event: {
				kind: 'message.delta',
				role: 'thought',
				messageId: 't',
				content: { kind: 'text', text: 'b' },
			},
		},
		{
			schemaVersion: 1,
			seq: 4,
			at: at(10),
			event: {
				kind: 'message.delta',
				role: 'thought',
				messageId: 'u',
				content: { kind: 'text', text: 'c' },
			},
		},
	]).filter((row) => row.kind === 'message' && row.role === 'thought');
	expect(rows.map((row) => (row.kind === 'message' ? [row.startedAt, row.endedAt] : null))).toEqual(
		[
			[Date.parse(at(1)), Date.parse(at(9))],
			[Date.parse(at(10)), undefined],
		]
	);
});
it("spec/agents-and-providers#sign-in-recovery: a sign-in failure folds the CLI text that was its turn's only output into the card", () => {
	const cli = 'Failed to authenticate: OAuth session expired and could not be refreshed';
	const failed = activityRows(
		records([
			{ kind: 'turn.started', text: 'Add a test' },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'm',
				content: { kind: 'text', text: cli },
			},
			{ kind: 'session.failed', message: 'Authentication required', reason: 'auth' },
		])
	);
	expect(failed.map((row) => row.kind)).toEqual(['message', 'event']);
	expect(failed.at(-1)).toMatchObject({ kind: 'event', detail: cli });
	// Any other output keeps the message; another failure never folds.
	const worked = activityRows(
		records([
			{ kind: 'turn.started', text: 'x' },
			{ kind: 'tool.changed', patch: { id: 't', title: 'Read' } },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'm',
				content: { kind: 'text', text: cli },
			},
			{ kind: 'session.failed', message: 'Authentication required', reason: 'auth' },
		])
	);
	expect(
		worked.filter((row) => row.kind === 'message').map((row) => row.kind === 'message' && row.text)
	).toEqual(['x', cli]);
	expect(worked.at(-1)).not.toHaveProperty('detail');
	const plain = activityRows(
		records([
			{ kind: 'turn.started', text: 'x' },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'm',
				content: { kind: 'text', text: 'Oops' },
			},
			{ kind: 'session.failed', message: 'Boom' },
		])
	);
	expect(plain.map((row) => row.kind)).toEqual(['message', 'message', 'event']);
	expect(isSessionEvent({ kind: 'session.failed', message: 'm', reason: 'auth' })).toBe(true);
	expect(isSessionEvent({ kind: 'session.failed', message: 'm', reason: 'network' })).toBe(false);
});
