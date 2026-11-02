// spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent began on its own is an ordinary turn to everything that reads the journal, without a person's row.
import { expect, it } from 'vitest';
import { isSessionEvent } from './event-validation';
import { activityRows } from './activity';
import { turnSummaries } from './turns';
import { turnStatus } from './turn-status';
import { hostStatus, type EventRecord, type SessionEvent } from './session';
import { relayJournal } from './relay';
const journal = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(Date.UTC(2026, 9, 9, 13, 23, index)).toISOString(),
		event,
	}));
const own: SessionEvent[] = [
	{ kind: 'turn.started', text: 'Start the review in the background' },
	{
		kind: 'message.delta',
		role: 'assistant',
		messageId: 'a',
		content: { kind: 'text', text: 'Started.' },
	},
	{ kind: 'turn.completed', reason: 'end_turn' },
	{ kind: 'turn.started', text: '', origin: 'agent' },
	{
		kind: 'tool.changed',
		patch: { id: 'read', name: 'Bash', title: 'cat review.md', status: 'in_progress' },
	},
];
it('accepts origin agent and nothing else', () => {
	expect(isSessionEvent({ kind: 'turn.started', text: '', origin: 'agent' })).toBe(true);
	expect(isSessionEvent({ kind: 'turn.started', text: '', origin: 'person' })).toBe(false);
});
it("runs as a turn: busy, the status row, the rail summary; no person's row in the log", () => {
	const running = journal(own);
	expect(hostStatus(running, true).busy).toBe(true);
	expect(turnStatus(running)).toMatchObject({ state: 'working', target: 'cat review.md' });
	expect(turnSummaries(running).map((turn) => turn.status)).toEqual(['done', 'running']);
	const done = journal([
		...own,
		{ kind: 'tool.changed', patch: { id: 'read', status: 'completed' } },
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'b',
			content: { kind: 'text', text: 'Astra found a blocker.' },
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
	]);
	expect(hostStatus(done, true).busy).toBe(false);
	expect(turnStatus(done)).toBeNull();
	expect(turnSummaries(done).map((turn) => [turn.status, turn.tools])).toEqual([
		['done', 0],
		['done', 1],
	]);
	expect(
		activityRows(done).flatMap((row) =>
			row.kind === 'message' ? [`${row.role}: ${row.text}`] : []
		)
	).toEqual([
		'user: Start the review in the background',
		'assistant: Started.',
		'assistant: Astra found a blocker.',
	]);
	expect(relayJournal(done)).not.toContain('User: \n');
});
