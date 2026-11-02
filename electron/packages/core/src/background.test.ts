import { expect, it } from 'vitest';
import {
	backgroundCommands,
	backgroundDeck,
	backgroundPathOf,
	backgroundSummary,
	isBackgroundPath,
	outputTail,
	turnBackground,
	liveBackground,
} from './background';
import { isSessionEvent } from './event-validation';
import { isSessionCommand, type EventRecord, type SessionEvent } from './session';
import { backgroundCommandCount } from './messages';
import { noticeKind } from './notifications';
const at = (s: number) => new Date(Date.UTC(2026, 9, 9, 13, 21, s)).toISOString();
const r = (seq: number, event: SessionEvent, s = seq): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: at(s),
	event,
});
const started = (seq: number, id: string, name = 'Send the plan to Astra') =>
	r(seq, { kind: 'background.started', id, toolId: `toolu_${id}`, name });

it('follows a command from its turn to its end; one without an end stops with the host or a new session (spec/chat-turns-plans-and-questions#background-commands)', () => {
	const records = [
		r(1, { kind: 'turn.started', text: 'go' }),
		started(2, 'b1'),
		r(3, { kind: 'background.changed', id: 'b1', outputPath: '/tmp/x/s/tasks/b1.output' }),
		r(4, { kind: 'turn.completed', reason: 'end_turn' }),
		r(5, { kind: 'background.changed', id: 'b1', state: 'completed' }, 40),
	];
	expect(backgroundCommands(records)).toEqual([
		{
			id: 'b1',
			toolId: 'toolu_b1',
			name: 'Send the plan to Astra',
			seq: 2,
			turnSeq: 1,
			startedAt: Date.parse(at(2)),
			state: 'completed',
			reason: null,
			finishedAt: Date.parse(at(40)),
			finishedSeq: 5,
			outputPath: '/tmp/x/s/tasks/b1.output',
		},
	]);
	// A second end does not move it.
	expect(
		backgroundCommands([
			...records,
			r(6, { kind: 'background.changed', id: 'b1', state: 'failed' }),
		])[0]!.state
	).toBe('completed');
	expect(
		backgroundCommands([started(1, 'b2'), r(2, { kind: 'host.stopped', reason: 'shutdown' })])[0]
	).toMatchObject({ state: 'stopped', reason: 'closed' });
	expect(
		backgroundCommands([
			started(1, 'b2'),
			r(2, { kind: 'session.started', sessionId: 's', modes: [], modeId: null, options: [] }),
		])[0]
	).toMatchObject({ state: 'stopped', reason: 'restarted' });
	expect(
		backgroundCommands([
			started(1, 'b2'),
			r(2, { kind: 'background.changed', id: 'b2', state: 'stopped' }),
		])[0]
	).toMatchObject({ state: 'stopped', reason: 'person' });
	expect(
		liveBackground([
			started(1, 'b3'),
			started(2, 'b4'),
			r(3, { kind: 'background.changed', id: 'b3', state: 'failed' }),
		]).map((command) => command.id)
	).toEqual(['b4']);
});
it('the deck: running rows; a finished one for 4 s; a failed one until the next turn or dismissed; a stopped one leaves at once', () => {
	const base = [
		r(1, { kind: 'turn.started', text: 'go' }),
		started(2, 'ok'),
		started(3, 'bad'),
		started(4, 'stop'),
		started(5, 'run'),
		r(6, { kind: 'turn.completed', reason: 'end_turn' }),
	];
	const ended = [
		...base,
		r(7, { kind: 'background.changed', id: 'ok', state: 'completed' }, 50),
		r(8, { kind: 'background.changed', id: 'bad', state: 'failed' }, 50),
		r(9, { kind: 'background.changed', id: 'stop', state: 'stopped' }, 50),
	];
	const now = Date.parse(at(52));
	expect(backgroundDeck(ended, now).map((command) => command.id)).toEqual(['ok', 'bad', 'run']);
	expect(backgroundDeck(ended, now + 3000).map((command) => command.id)).toEqual(['bad', 'run']);
	expect(backgroundDeck(ended, now, new Set(['bad'])).map((command) => command.id)).toEqual([
		'ok',
		'run',
	]);
	expect(
		backgroundDeck(
			[...ended, r(10, { kind: 'turn.started', text: '', origin: 'agent' }, 51)],
			now
		).map((command) => command.id)
	).toEqual(['ok', 'run']);
	expect(turnBackground(ended, 1).map((command) => command.id)).toEqual([
		'ok',
		'bad',
		'stop',
		'run',
	]);
});
it('the sidebar summary names one command or counts them', () => {
	expect(backgroundSummary([started(1, 'a', 'Start Storybook for kit')])).toEqual({
		count: 1,
		name: 'Start Storybook for kit',
	});
	expect(backgroundSummary([started(1, 'a'), started(2, 'b')])).toEqual({ count: 2, name: null });
	expect(
		backgroundSummary([
			started(1, 'a'),
			r(2, { kind: 'background.changed', id: 'a', state: 'completed' }),
		])
	).toBeNull();
});
it("accepts only the adapter's own output file of the command, and the tail drops a cut first line", () => {
	expect(
		backgroundPathOf('/private/tmp/claude-501/x/sess/tasks/b01ijw66c.output', 'b01ijw66c')
	).toBe(true);
	expect(backgroundPathOf('/private/tmp/claude-501/x/sess/tasks/other.output', 'b01ijw66c')).toBe(
		false
	);
	for (const bad of [
		'relative/tasks/a.output',
		'/tmp/../etc/tasks/a.output',
		'/etc/passwd',
		'/tmp/tasks/a.output\0',
	])
		expect(isBackgroundPath(bad)).toBe(false);
	expect(outputTail('ut line\ntick 1\r\ntick 2\n', true)).toBe('tick 1\ntick 2');
	expect(outputTail('a\nb\nc\n', false, 2)).toBe('b\nc');
});
it('validates the events and the command, and four uk plural forms', () => {
	expect(isSessionEvent({ kind: 'background.started', id: 'b1', toolId: null, name: 'x' })).toBe(
		true
	);
	expect(
		isSessionEvent({ kind: 'background.changed', id: 'b1', state: 'stopped', reason: 'restarted' })
	).toBe(true);
	expect(isSessionEvent({ kind: 'background.changed', id: 'b1', outputPath: '/etc/passwd' })).toBe(
		false
	);
	expect(isSessionEvent({ kind: 'background.changed', id: '../x' })).toBe(false);
	expect(isSessionCommand({ kind: 'stopBackground', id: 'b01ijw66c' })).toBe(true);
	expect(isSessionCommand({ kind: 'stopBackground', id: 'a b' })).toBe(false);
	expect([1, 2, 5, 11, 21, 22, 25, 1.5].map((n) => backgroundCommandCount('uk', n))).toEqual([
		'1 фонова команда',
		'2 фонові команди',
		'5 фонових команд',
		'11 фонових команд',
		'21 фонова команда',
		'22 фонові команди',
		'25 фонових команд',
		'1,5 фонової команди',
	]);
	expect(backgroundCommandCount('en', 2)).toBe('2 background commands');
	expect(noticeKind({ kind: 'background.changed', id: 'b', state: 'failed' })).toBe('failed');
	expect(noticeKind({ kind: 'background.changed', id: 'b', state: 'completed' })).toBeNull();
});
