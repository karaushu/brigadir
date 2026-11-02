import { it, expect } from 'vitest';
import { turnSummaries, turnSummarizer, turnResponse } from './turns';
import type { EventRecord, SessionEvent } from './session';
it('uses turn checkpoint boundaries, ignores idle edits and counts tool IDs once', () => {
	const events: SessionEvent[] = [
		{ kind: 'checkpoint.created', checkpoint: 0 },
		{ kind: 'turn.started', text: 'First line\nprivate full prompt' },
		{ kind: 'tool.changed', patch: { id: 'a', status: 'in_progress' } },
		{ kind: 'tool.changed', patch: { id: 'a', status: 'completed' } },
		{ kind: 'checkpoint.created', checkpoint: 1 },
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'checkpoint.created', checkpoint: 2 },
		{ kind: 'turn.started', text: 'Second turn' },
		{ kind: 'checkpoint.created', checkpoint: 3 },
		{ kind: 'host.stopped', reason: 'exit' },
		{ kind: 'turn.started', text: 'Running' },
	];
	const records: EventRecord[] = events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(index * 1000).toISOString(),
		event,
	}));
	expect(
		turnSummaries(records).map(({ title, range, tools, status, duration }) => ({
			title,
			range,
			tools,
			status,
			duration,
		}))
	).toEqual([
		{
			title: 'First line',
			range: { base: 0, current: 1 },
			tools: 1,
			status: 'done',
			duration: 4000,
		},
		{
			title: 'Second turn',
			range: { base: 2, current: 3 },
			tools: 0,
			status: 'interrupted',
			duration: 2000,
		},
		{
			title: 'Running',
			range: { base: 3, current: 3 },
			tools: 0,
			status: 'running',
			duration: null,
		},
	]);
});

it('copies only the selected turn response while joining streaming blocks', () => {
	const events: SessionEvent[] = [
		{ kind: 'turn.started', text: 'Never copy the prompt' },
		{
			kind: 'message.delta',
			role: 'thought',
			messageId: null,
			content: { kind: 'text', text: 'Never copy thinking' },
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'a',
			content: { kind: 'text', text: 'First **' },
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'a',
			content: { kind: 'text', text: 'answer**.' },
		},
		{ kind: 'tool.changed', patch: { id: 'tool', output: 'Never copy tool output' } },
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'b',
			content: { kind: 'text', text: '```ts\nconst a = 1;\n```' },
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'turn.started', text: 'Other turn' },
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'Other answer' },
		},
	];
	const records: EventRecord[] = events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(index * 1000).toISOString(),
		event,
	}));
	expect(turnResponse(records, 1)).toBe('First **answer**.\n\n```ts\nconst a = 1;\n```');
	expect(turnResponse(records, 8)).toBe('Other answer');
	expect(turnResponse(records, 2)).toBe('');
});

it('folds an appended journal incrementally, like the full projection, without touching arrays handed out earlier', () => {
	// 100 turns of 1000 streamed deltas each, as a GUI conversation grows (perf review TUI-12).
	const events: SessionEvent[] = [{ kind: 'checkpoint.created', checkpoint: 0 }];
	for (let turn = 0; turn < 100; turn++) {
		events.push({ kind: 'turn.started', text: `Turn ${turn}` });
		for (let i = 0; i < 1000; i++)
			events.push(
				i % 100 === 0
					? { kind: 'tool.changed', patch: { id: `t${turn}-${i}`, status: 'completed' } }
					: {
							kind: 'message.delta',
							role: 'assistant',
							messageId: null,
							content: { kind: 'text', text: 'x' },
						}
			);
		events.push({ kind: 'checkpoint.created', checkpoint: turn + 1 });
		if (turn < 99)
			events.push({ kind: 'turn.completed', reason: turn % 7 ? 'end_turn' : 'cancelled' });
	}
	const records: EventRecord[] = events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(index * 1000).toISOString(),
		event,
	}));
	const summarize = turnSummarizer();
	let previous = summarize(records.slice(0, 50_000));
	const frozen = JSON.stringify(previous);
	for (const length of [50_001, 50_900, 70_000, records.length]) {
		const before = JSON.stringify(previous),
			next = summarize(records.slice(0, length));
		expect(next).toEqual(turnSummaries(records.slice(0, length)));
		expect(JSON.stringify(previous)).toBe(before);
		previous = next;
	}
	expect(JSON.stringify(summarize(records.slice(0, 50_000)))).toBe(frozen);
	// A new snapshot brings new objects: the projection starts over.
	const replaced = records.slice(0, 2000).map((record) => ({ ...record }));
	expect(summarize(replaced)).toEqual(turnSummaries(replaced));
	const time = (run: () => void) => {
		const start = performance.now();
		for (let i = 0; i < 20; i++) run();
		return (performance.now() - start) / 20;
	};
	const grown = turnSummarizer(),
		steps = Array.from({ length: 21 }, (_, i) => records.slice(0, records.length - 20 + i));
	grown(steps[0]!);
	let n = 0;
	const incremental = time(() => grown(steps[++n]!)),
		full = time(() => turnSummaries(records));
	expect(incremental).toBeLessThan(full);
});
