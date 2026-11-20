import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentTask, EventRecord, SessionEvent } from '@brigadir/core';
import { ReadyRow, SmokeEventRow, SmokeStrip } from './SmokeRun';

// A server render reads the clock once; the test fixes it.
vi.mock('./ui/second-tick', () => ({ useSecondTick: () => Date.now() }));
afterEach(() => {
	vi.useRealTimers();
});
const task: AgentTask = {
	id: 't1',
	projectId: 'p1',
	title: 'Client details screen',
	status: 'working',
	provider: 'claude',
};
const start = Date.parse('2026-11-20T10:00:00Z');
const journal = (...items: [number, SessionEvent][]): EventRecord[] =>
	items.map(([ms, event], index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(start + ms).toISOString(),
		event,
	}));
const started: SessionEvent = {
	kind: 'smoke.started',
	id: 's1',
	steps: ['Clients list', 'Client card'],
	limitMs: 600_000,
};
const strip = (records: EventRecord[], at: number, open = false) => {
	vi.useFakeTimers();
	vi.setSystemTime(start + at);
	return renderToStaticMarkup(
		<SmokeStrip
			task={task}
			records={records}
			locale="en"
			disabled={false}
			send={() => {}}
			open={open}
		/>
	);
};
it('the deck row counts down, turns amber in the last minute and waits for the report at the limit (spec/smoke-run#deck)', () => {
	const running = strip(journal([0, started]), 228_000);
	expect(running).toContain('data-smoke-strip="running"');
	expect(running).toContain('6:12 left of 10 min');
	expect(running).toContain('+5 min');
	expect(running).toContain('>Stop<');
	expect(running).not.toContain('data-tone="amber"');
	const last = strip(journal([0, started]), 552_000);
	expect(last).toContain('0:48 left of 10 min');
	expect(last).toContain('data-tone="amber"');
	const stopped = strip(
		journal([0, started], [600_000, { kind: 'smoke.stopped', id: 's1', cause: 'limit' }]),
		601_000
	);
	expect(stopped).toContain('stopped at 10 min · Claude writes the report');
	expect(stopped).not.toContain('+5 min');
	expect(stopped).not.toContain('>Stop<');
	const byYou = strip(
		journal([0, started], [60_000, { kind: 'smoke.stopped', id: 's1', cause: 'person' }]),
		61_000,
		true
	);
	expect(byYou).toContain('stopped by you · Claude writes the report');
	expect(byYou).toContain('Client card');
	// A reported run has no row.
	expect(
		strip(
			journal(
				[0, started],
				[
					1000,
					{
						kind: 'smoke.reported',
						id: 's1',
						steps: [{ step: 'Clients list', result: 'passed' }],
						summary: 'ok',
						elapsedMs: 1000,
					},
				]
			),
			2000
		)
	).toBe('');
});
it('the report row says how the run ended; Ready to look names the screen and where it is (spec/smoke-run#chat)', () => {
	const limit = renderToStaticMarkup(
		<SmokeEventRow
			locale="en"
			event={{
				kind: 'smoke.reported',
				id: 's1',
				steps: [
					{ step: 'Clients list', result: 'passed' },
					{ step: 'Client card', result: 'passed' },
					{ step: 'Notes', result: 'unchecked', missing: true },
				],
				summary: 'List and card work; notes not reached.',
				elapsedMs: 600_000,
				stopped: 'limit',
			}}
		/>
	);
	expect(limit).toContain('10 min');
	expect(limit).toContain('stopped at the limit');
	expect(limit).toContain('2 of 3 steps');
	expect(limit).toContain('List and card work; notes not reached.');
	expect(limit).toContain('data-glyph="stop"');
	const inTime = renderToStaticMarkup(
		<SmokeEventRow
			locale="en"
			event={{
				kind: 'smoke.reported',
				id: 's1',
				steps: [{ step: 'Clients list', result: 'passed' }],
				summary: 'ok',
				elapsedMs: 460_000,
			}}
		/>
	);
	expect(inTime).toContain('7m 40s');
	expect(inTime).toContain('1 of 1 steps');
	expect(inTime).toContain('>done<');
	expect(inTime).toContain('data-glyph="check-pass"');
	const ready = renderToStaticMarkup(
		<ReadyRow
			task={task}
			locale="uk"
			event={{
				kind: 'task.ready',
				id: 'r1',
				screen: 'Details screen',
				where: 'simulator',
				device: 'iPhone 17 Pro',
			}}
		/>
	);
	expect(ready).toContain('готово');
	expect(ready).toContain('Details screen');
	expect(ready).toContain('iPhone 17 Pro');
	expect(ready).toContain('Показати');
	const page = renderToStaticMarkup(
		<ReadyRow
			task={task}
			locale="en"
			event={{
				kind: 'task.ready',
				id: 'r2',
				screen: 'Client card',
				where: 'browser',
				tab: 'b1',
				url: 'http://localhost:3000/clients/7',
			}}
		/>
	);
	expect(page).toContain('localhost:3000/clients/7');
});
