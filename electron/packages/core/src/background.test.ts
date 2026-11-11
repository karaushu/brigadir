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
	backgroundSubagents,
	backgroundWork,
	runningSubagents,
} from './background';
import { activityRows } from './activity';
import { taskActivity } from './task-activity';
import { isSessionEvent } from './event-validation';
import { isSessionCommand, type EventRecord, type SessionEvent } from './session';
import { backgroundCommandCount, backgroundWorkCount, subagentCount } from './messages';
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
			kind: 'command',
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

const subagent = (seq: number, id: string, name = 'Run the tests') =>
	r(seq, { kind: 'subagent.started', id, parentId: null, name, prompt: 'Run them.' });
it('a subagent that outlives its turn is background work until it ends; one that ends in its turn never is (spec/chat-turns-plans-and-questions#background-subagents)', () => {
	const records = [
		r(1, { kind: 'turn.started', text: 'go' }),
		subagent(2, 'quick', 'Find files'),
		r(3, { kind: 'subagent.changed', id: 'quick', state: 'completed' }),
		subagent(4, 'a1'),
		started(5, 'b1'),
		r(6, { kind: 'turn.completed', reason: 'end_turn' }),
	];
	expect(backgroundSubagents(records)).toEqual([
		{
			kind: 'subagent',
			id: 'a1',
			toolId: null,
			name: 'Run the tests',
			seq: 4,
			turnSeq: 1,
			startedAt: Date.parse(at(4)),
			state: 'running',
			reason: null,
			finishedAt: null,
			finishedSeq: null,
			outputPath: null,
		},
	]);
	expect(backgroundWork(records).map((item) => [item.kind, item.id])).toEqual([
		['subagent', 'a1'],
		['command', 'b1'],
	]);
	expect(turnBackground(records, 1).map((item) => item.id)).toEqual(['a1', 'b1']);
	expect(backgroundSummary(records)).toEqual({ count: 2, name: null, subagents: 1 });
	expect(backgroundSummary(records.slice(0, 4).concat(records[5]!))).toEqual({
		count: 1,
		name: 'Run the tests',
		subagents: 1,
	});
	// Later turns do not end it; its own state does. Failed stays until the next turn, cancelled reads as stopped.
	const later = [
		...records,
		r(7, { kind: 'turn.started', text: 'more' }),
		r(8, { kind: 'turn.completed', reason: 'end_turn' }),
		r(9, { kind: 'subagent.changed', id: 'a1', state: 'failed' }),
	];
	expect(backgroundSubagents(later)[0]).toMatchObject({ state: 'failed', finishedSeq: 9 });
	expect(backgroundDeck(later, Date.parse(at(9))).map((item) => item.id)).toEqual(['a1', 'b1']);
	expect(
		backgroundSubagents([
			...records,
			r(7, { kind: 'subagent.changed', id: 'a1', state: 'cancelled' }),
		])[0]
	).toMatchObject({ state: 'stopped' });
	// New work for the same subagent brings it back; the host ends what is left.
	const again = [...later, r(10, { kind: 'subagent.changed', id: 'a1', state: 'running' })];
	expect(backgroundSubagents(again)[0]).toMatchObject({ state: 'running', finishedAt: null });
	expect(runningSubagents(again)).toEqual(new Set(['a1']));
	expect(
		backgroundSubagents([...again, r(11, { kind: 'host.stopped', reason: 'closed' })])[0]
	).toMatchObject({
		state: 'stopped',
	});
	expect(runningSubagents([...again, r(11, { kind: 'host.stopped', reason: 'closed' })])).toEqual(
		new Set()
	);
	expect(isSessionCommand({ kind: 'stopSubagent', id: 'a8dadcb3c40b13777' })).toBe(true);
	expect(isSessionCommand({ kind: 'stopSubagent', id: '../x' })).toBe(false);
	expect(
		isSessionEvent({ kind: 'subagent.changed', id: 'a1', state: 'running', prompt: 'Go.' })
	).toBe(true);
	expect([1, 2, 5, 21].map((n) => subagentCount('uk', n))).toEqual([
		'1 сабагент',
		'2 сабагенти',
		'5 сабагентів',
		'21 сабагент',
	]);
	expect(backgroundWorkCount('en', 3, 2)).toBe('2 subagents · 1 background command');
	expect(backgroundWorkCount('en', 2, 2)).toBe('2 subagents');
	expect(backgroundWorkCount('en', 2)).toBe('2 background commands');
});
it('a background subagent keeps its block, calls and text across turns (spec/chat#subagent-transport)', () => {
	const rows = activityRows([
		r(1, { kind: 'turn.started', text: 'go' }),
		subagent(2, 'a1'),
		r(3, {
			kind: 'tool.changed',
			patch: { id: 't1', title: 'pnpm test', status: 'in_progress' },
			subagentId: 'a1',
		}),
		r(4, { kind: 'turn.completed', reason: 'end_turn' }),
		r(5, { kind: 'turn.started', text: '', origin: 'agent' }),
		r(6, { kind: 'tool.changed', patch: { id: 't1', status: 'completed' }, subagentId: 'a1' }),
		r(7, {
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'm1',
			content: { kind: 'text', text: 'All green.' },
			subagentId: 'a1',
		}),
	]);
	const block = rows.find((row) => row.kind === 'subagent');
	expect(block).toMatchObject({ finishedAt: null, state: null, prompt: 'Run them.' });
	expect(block?.kind === 'subagent' && block.rows.map((row) => row.kind)).toEqual([
		'tool',
		'message',
	]);
	expect(block?.kind === 'subagent' && block.rows[0]).toMatchObject({
		finishedAt: Date.parse(at(6)),
		tool: { status: 'completed' },
	});
});
it('the sidebar line names the subagent while its start or its calls are the latest work (spec/chat#subagent-block)', () => {
	const records = [
		r(1, { kind: 'turn.started', text: 'go' }),
		subagent(2, 'a1', 'Probe sleeper'),
		r(3, { kind: 'tool.changed', patch: { id: 't1', title: 'sleep 20' }, subagentId: 'a1' }),
	];
	expect(taskActivity(records)).toEqual({
		kind: 'tool',
		title: 'Probe sleeper',
		path: null,
		subagent: true,
	});
	expect(
		taskActivity([
			...records,
			r(4, { kind: 'tool.changed', patch: { id: 't2', title: 'Read a.ts' } }),
		])
	).toEqual({ kind: 'tool', title: 'Read a.ts', path: null });
});
