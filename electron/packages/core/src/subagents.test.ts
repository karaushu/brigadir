import { expect, it } from 'vitest';
import { activityRows, type ActivityRow } from './activity';
import { isSessionEvent } from './event-validation';
import {
	answerLine,
	subagentElapsed,
	subagentView,
	toolInputPrompt,
	type SubagentRow,
} from './subagents';
import { turnStatus } from './turn-status';
import { tokenCount } from './messages';
import type { EventRecord, SessionEvent } from './session';
const records = (
	events: SessionEvent[],
	from = Date.parse('2026-10-02T10:00:00Z')
): EventRecord[] =>
	events.map((event, i) => ({
		schemaVersion: 1,
		seq: i + 1,
		at: new Date(from + i * 1000).toISOString(),
		event,
	}));
const text = (value: string) => ({ kind: 'text' as const, text: value });
const sub = (rows: ActivityRow[]) =>
	rows.find((row): row is SubagentRow => row.kind === 'subagent')!;

// Shapes from the live probe of claude-agent-acp 0.85.1 with the `subagents` capability: a sync and a background run.
const sync: SessionEvent[] = [
	{ kind: 'turn.started', text: 'list the files with a subagent' },
	{
		kind: 'subagent.started',
		id: 'a7f8',
		parentId: null,
		name: 'List files',
		prompt: 'Run `ls` and answer with the list.',
	},
	{
		kind: 'tool.changed',
		subagentId: 'a7f8',
		patch: {
			id: 'bash',
			name: 'Bash',
			title: 'ls',
			category: 'execute',
			status: 'pending',
			parentId: 'launch',
		},
	},
	{
		kind: 'tool.changed',
		subagentId: 'a7f8',
		patch: { id: 'bash', status: 'completed', parentId: 'launch' },
	},
	{
		kind: 'message.delta',
		subagentId: 'a7f8',
		parentId: 'launch',
		role: 'assistant',
		messageId: null,
		content: text('The command printed one file, `README.md`.'),
	},
	{ kind: 'subagent.changed', id: 'a7f8', state: 'completed' },
	{
		kind: 'subagent.changed',
		id: 'a7f8',
		toolId: 'launch',
		type: 'general-purpose',
		model: 'claude-opus-5-5',
		tokens: 34269,
		durationMs: 10556,
	},
	{
		kind: 'message.delta',
		role: 'assistant',
		messageId: null,
		content: text('The subagent found one file.'),
	},
	{ kind: 'turn.completed', reason: 'end_turn' },
];

it('validates the subagent events and the subagent marks on text and calls', () => {
	for (const event of sync) expect(isSessionEvent(event)).toBe(true);
	expect(isSessionEvent({ kind: 'subagent.changed', id: 'a', state: 'lost' })).toBe(false);
	expect(isSessionEvent({ kind: 'subagent.started', id: 'a', parentId: null, name: 'x' })).toBe(
		false
	);
});

it('puts a subagent on the place it started, with its own text and calls inside, not in the main log', () => {
	const rows = activityRows(records(sync));
	expect(rows.map((row) => row.kind)).toEqual(['message', 'subagent', 'message', 'event']);
	const block = sub(rows);
	expect(block).toMatchObject({
		name: 'List files',
		state: 'completed',
		type: 'general-purpose',
		model: 'claude-opus-5-5',
		tokens: 34269,
		durationMs: 10556,
	});
	expect(block.rows.map((row) => row.kind)).toEqual(['tool', 'message']);
	expect(
		rows.filter((row) => row.kind === 'message').map((row) => row.kind === 'message' && row.text)
	).toEqual(['list the files with a subagent', 'The subagent found one file.']);
	const view = subagentView(block);
	expect(view).toMatchObject({
		answer: 'The command printed one file, `README.md`.',
		calls: 1,
		errors: 0,
		state: 'completed',
		live: null,
	});
	expect(view.rows.map((row) => row.kind)).toEqual(['tool']);
	expect(subagentElapsed(block, Date.now())).toBe(10556);
	expect(answerLine(view.answer!)).toBe('The command printed one file, README.md.');
});

it('keeps two subagents that run at once apart, each with its live call, and names the latest in the turn row', () => {
	const rows = activityRows(
		records([
			{ kind: 'turn.started', text: 'two at once' },
			{ kind: 'subagent.started', id: 'one', parentId: null, name: 'Echo one', prompt: 'echo one' },
			{ kind: 'subagent.started', id: 'two', parentId: null, name: 'Echo two', prompt: 'echo two' },
			{
				kind: 'tool.changed',
				subagentId: 'one',
				patch: { id: 't1', name: 'Bash', title: 'echo one', status: 'pending' },
			},
			{
				kind: 'tool.changed',
				subagentId: 'two',
				patch: { id: 't2', name: 'Bash', title: 'echo two', status: 'pending' },
			},
			{ kind: 'tool.changed', subagentId: 'one', patch: { id: 't1', status: 'completed' } },
			{
				kind: 'message.delta',
				subagentId: 'one',
				role: 'assistant',
				messageId: null,
				content: text('one'),
			},
			{ kind: 'subagent.changed', id: 'one', state: 'completed' },
		])
	);
	const [one, two] = rows.filter((row): row is SubagentRow => row.kind === 'subagent');
	expect(subagentView(one!)).toMatchObject({ answer: 'one', state: 'completed', live: null });
	expect(subagentView(two!)).toMatchObject({ answer: null, state: 'running', calls: 1 });
	expect(subagentView(two!).live?.tool.title).toBe('echo two');
	const status = turnStatus(
		records([
			{ kind: 'turn.started', text: 'two at once' },
			{ kind: 'subagent.started', id: 'one', parentId: null, name: 'Echo one', prompt: null },
			{ kind: 'subagent.started', id: 'two', parentId: null, name: 'Echo two', prompt: null },
			{
				kind: 'tool.changed',
				subagentId: 'two',
				patch: { id: 't2', name: 'Bash', title: 'echo two', status: 'pending' },
			},
		])
	);
	expect(status).toMatchObject({ state: 'working', target: null, subagent: 'Echo two', more: 1 });
});

it('reads a hand-back call as the answer, not a call, by its input shape', () => {
	const block = sub(
		activityRows(
			records([
				{ kind: 'turn.started', text: 'research' },
				{ kind: 'subagent.started', id: 's', parentId: null, name: 'Research', prompt: 'look' },
				{
					kind: 'tool.changed',
					subagentId: 's',
					patch: { id: 'read', name: 'Read', title: 'Read a.ts', status: 'completed' },
				},
				{
					kind: 'tool.changed',
					subagentId: 's',
					patch: {
						id: 'hand',
						name: 'Anything',
						title: 'Anything',
						status: 'completed',
						input: JSON.stringify({ message: '## Short answer\nYes.' }),
					},
				},
				{ kind: 'subagent.changed', id: 's', state: 'completed' },
			])
		)
	);
	expect(subagentView(block)).toMatchObject({ answer: '## Short answer\nYes.', calls: 1 });
	expect(answerLine('## Short answer\nYes.')).toBe('Short answer');
});

it('marks a subagent cut by the end of the turn as interrupted, and a failed one with its errors', () => {
	const rows = activityRows(
		records([
			{ kind: 'turn.started', text: 'go' },
			{ kind: 'subagent.started', id: 'cut', parentId: null, name: 'Cut', prompt: null },
			{ kind: 'subagent.started', id: 'bad', parentId: null, name: 'Bad', prompt: null },
			{
				kind: 'tool.changed',
				subagentId: 'bad',
				patch: { id: 'g', name: 'Bash', title: 'grep x', status: 'failed', exitCode: 1 },
			},
			{ kind: 'subagent.changed', id: 'bad', state: 'failed' },
			{ kind: 'turn.completed', reason: 'cancelled' },
		])
	);
	const [cut, bad] = rows.filter((row): row is SubagentRow => row.kind === 'subagent');
	expect(subagentView(cut!).state).toBe('interrupted');
	expect(subagentView(bad!)).toMatchObject({ state: 'failed', errors: 1, answer: null });
});

it('nests a subagent its parent started, and never merges a subagent text without a session into the main message', () => {
	const rows = activityRows(
		records([
			{ kind: 'turn.started', text: 'go' },
			{ kind: 'subagent.started', id: 'p', parentId: null, name: 'Parent', prompt: null },
			{ kind: 'subagent.started', id: 'c', parentId: 'p', name: 'Child', prompt: null },
			{ kind: 'message.delta', role: 'assistant', messageId: null, content: text('Main says.') },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: null,
				parentId: 'launch',
				content: text('Older subagent text.'),
			},
		])
	);
	expect(sub(rows).rows.map((row) => row.kind === 'subagent' && row.name)).toEqual(['Child']);
	expect(
		rows.filter((row) => row.kind === 'message').map((row) => row.kind === 'message' && row.text)
	).toEqual(['go', 'Main says.', 'Older subagent text.']);
});

it('takes the prompt of an older think call from its input, and counts tokens in four forms', () => {
	expect(
		toolInputPrompt(
			'{"description":"Research","prompt":"Read-only research","subagent_type":"general-purpose"}'
		)
	).toBe('Read-only research');
	expect(toolInputPrompt('{"description":"x"}')).toBeNull();
	expect(toolInputPrompt('not json')).toBeNull();
	expect([1, 3, 5, 34190].map((count) => tokenCount('uk', count))).toEqual([
		'1 токен',
		'3 токени',
		'5 токенів',
		'34.1k токенів',
	]);
	expect(tokenCount('en', 1)).toBe('1 token');
});
