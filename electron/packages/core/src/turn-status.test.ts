import { it, expect } from 'vitest';
import { shownTurnStatus, turnStatus } from './turn-status';
import type { EventRecord, SessionEvent } from './session';
const journal = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(index * 1000).toISOString(),
		event,
	}));
const started: SessionEvent = { kind: 'turn.started', text: 'Fix the ring' };
const request = {
	id: 'p',
	tool: { id: 't', title: 'git push' },
	options: [],
} as unknown as Extract<SessionEvent, { kind: 'permission.requested' }>['request'];

it('thinks from the start of the turn, until the answer streams', () => {
	expect(turnStatus(journal([started]))).toEqual({
		state: 'thinking',
		startedAt: 0,
		target: null,
		more: 0,
	});
	expect(
		turnStatus(
			journal([
				started,
				{
					kind: 'message.delta',
					role: 'thought',
					messageId: null,
					content: { kind: 'text', text: 'Hm' },
				},
			])
		)?.state
	).toBe('thinking');
	expect(
		turnStatus(
			journal([
				started,
				{
					kind: 'message.delta',
					role: 'assistant',
					messageId: 'a',
					content: { kind: 'text', text: 'I will' },
				},
			])
		)?.state
	).toBe('writing');
});

it('works while a tool runs: the latest started one is the target, the rest are +N; a finished tool thinks again', () => {
	const events: SessionEvent[] = [
		{ kind: 'turn.started', text: 'x' },
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'a',
			content: { kind: 'text', text: 'Now' },
		},
		{
			kind: 'tool.changed',
			patch: { id: 'a', name: 'Bash', title: 'Bash pnpm test', status: 'in_progress' },
		},
		{
			kind: 'tool.changed',
			patch: { id: 'b', name: 'Read', title: 'Read `kit/Button.tsx`', status: 'in_progress' },
		},
		{ kind: 'tool.changed', patch: { id: 'a', status: 'in_progress' } },
	];
	expect(turnStatus(journal(events))).toMatchObject({
		state: 'working',
		target: 'kit/Button.tsx',
		more: 1,
	});
	expect(
		turnStatus(
			journal([...events, { kind: 'tool.changed', patch: { id: 'b', status: 'completed' } }])
		)
	).toMatchObject({ state: 'working', target: 'pnpm test', more: 0 });
	expect(
		turnStatus(
			journal([
				...events,
				{ kind: 'tool.changed', patch: { id: 'b', status: 'completed' } },
				{ kind: 'tool.changed', patch: { id: 'a', status: 'failed' } },
			])
		)
	).toMatchObject({ state: 'thinking', target: null });
	// A tool without a title yet never shows its protocol id.
	expect(
		turnStatus(
			journal([started, { kind: 'tool.changed', patch: { id: 'toolu_01', status: 'pending' } }])
		)
	).toMatchObject({ state: 'working', target: null });
});

it('hides while a card waits for a person and comes back after the answer, with the turn start kept', () => {
	const asked = journal([started, { kind: 'permission.requested', request }]);
	expect(turnStatus(asked)).toBeNull();
	expect(
		turnStatus(
			journal([
				started,
				{ kind: 'permission.requested', request },
				{ kind: 'permission.resolved', id: 'p', optionId: 'allow' } as SessionEvent,
			])
		)
	).toMatchObject({ state: 'thinking', startedAt: 0 });
});

it('is gone when no turn runs', () => {
	expect(turnStatus([])).toBeNull();
	for (const end of [
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'session.failed', message: 'x' },
		{ kind: 'host.stopped' },
	] as SessionEvent[])
		expect(turnStatus(journal([started, end]))).toBeNull();
	expect(
		turnStatus(
			journal([
				started,
				{ kind: 'turn.completed', reason: 'end_turn' },
				{ kind: 'turn.started', text: 'again' },
			])
		)
	).toMatchObject({ state: 'thinking', startedAt: 2000 });
});

it('the log shows «thinking» from the click on Send until the host echoes the turn, and nothing after a stopped turn', () => {
	// Sent, not echoed yet: thinking since the click.
	expect(shownTurnStatus([], 5000)).toEqual({
		state: 'thinking',
		startedAt: 5000,
		target: null,
		more: 0,
	});
	expect(shownTurnStatus([], null)).toBeNull();
	// The echoed turn wins over the click time.
	expect(shownTurnStatus(journal([started]), 5000)).toMatchObject({
		state: 'thinking',
		startedAt: 0,
	});
	// Stop: the turn ends interrupted and the row goes.
	const stopped = journal([
		started,
		{ kind: 'turn.completed', reason: 'cancelled' } as SessionEvent,
	]);
	expect(shownTurnStatus(stopped, null)).toBeNull();
	// A permission card is the call: no row while it waits, even right after Send.
	expect(
		shownTurnStatus(journal([started, { kind: 'permission.requested', request }]), 5000)
	).toBeNull();
});
