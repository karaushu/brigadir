import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KeepAwakeStatus, TaskStatus } from '@brigadir/core';
import { KeepAwake, keepAwakeKinds, workingAgents } from './keep-awake';
const times = { releaseMs: 30_000, debounceMs: 500, pollMs: 60_000 };
function setup() {
	const state = {
		count: 0,
		enabled: true,
		next: 1,
		started: [] as number[],
		stopped: [] as number[],
		changes: [] as KeepAwakeStatus[],
		counts: 0,
		logs: [] as string[],
		held: false,
		display: false,
		kinds: [] as string[],
	};
	let gate: Promise<void> | null = null;
	const keep = new KeepAwake(
		{
			count: async () => {
				state.counts++;
				if (gate) await gate;
				return state.count;
			},
			enabled: () => state.enabled,
			held: () => state.held,
			display: () => state.display,
			blocker: {
				start: (kind) => {
					const id = state.next++;
					state.started.push(id);
					state.kinds.push(kind);
					return id;
				},
				stop: (id) => {
					state.stopped.push(id);
				},
			},
			changed: (status) => state.changes.push(status),
			log: (line) => state.logs.push(line),
		},
		times
	);
	return {
		keep,
		state,
		hold() {
			let open!: () => void;
			gate = new Promise((resolve) => {
				open = resolve;
			});
			return () => {
				gate = null;
				open();
			};
		},
	};
}
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
it('takes one blocker for any number of agents and releases it 30 s after the last one stops', async () => {
	const { keep, state } = setup();
	state.count = 1;
	await keep.recount();
	expect(state.started).toEqual([1]);
	expect(keep.status()).toEqual({ working: 1, holding: true });
	state.count = 3;
	await keep.recount();
	expect(state.started).toEqual([1]);
	expect(keep.status()).toEqual({ working: 3, holding: true });
	state.count = 0;
	await keep.recount();
	expect(keep.status()).toEqual({ working: 0, holding: true });
	await vi.advanceTimersByTimeAsync(29_999);
	expect(state.stopped).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(state.stopped).toEqual([1]);
	expect(keep.status()).toEqual({ working: 0, holding: false });
	expect(state.changes.at(-1)).toEqual({ working: 0, holding: false });
});
it('work coming back within the delay cancels the release and keeps the same blocker', async () => {
	const { keep, state } = setup();
	state.count = 1;
	await keep.recount();
	state.count = 0;
	await keep.recount();
	await vi.advanceTimersByTimeAsync(20_000);
	state.count = 1;
	await keep.recount();
	await vi.advanceTimersByTimeAsync(60_000);
	expect(state.started).toEqual([1]);
	expect(state.stopped).toEqual([]);
	// A second stop starts a fresh 30 s, not the remainder of the first.
	state.count = 0;
	await keep.recount();
	await vi.advanceTimersByTimeAsync(29_000);
	expect(state.stopped).toEqual([]);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(state.stopped).toEqual([1]);
});
it('the switch off releases at once and takes nothing while off; on takes it again', async () => {
	const { keep, state } = setup();
	state.count = 2;
	await keep.recount();
	expect(keep.status().holding).toBe(true);
	state.enabled = false;
	keep.settingChanged();
	await vi.advanceTimersByTimeAsync(0);
	expect(state.stopped).toEqual([1]);
	expect(keep.status()).toEqual({ working: 0, holding: false });
	const counts = state.counts;
	await keep.recount();
	expect(state.counts).toBe(counts);
	expect(state.started).toEqual([1]);
	state.enabled = true;
	keep.settingChanged();
	await vi.advanceTimersByTimeAsync(0);
	expect(state.started).toEqual([1, 2]);
	expect(keep.status()).toEqual({ working: 2, holding: true });
});
it('refresh debounces events, counts never overlap and a request during a count runs one more after it', async () => {
	const { keep, state, hold } = setup();
	for (let i = 0; i < 10; i++) keep.refresh();
	await vi.advanceTimersByTimeAsync(499);
	expect(state.counts).toBe(0);
	const open = hold();
	await vi.advanceTimersByTimeAsync(1);
	expect(state.counts).toBe(1);
	state.count = 1;
	void keep.recount();
	void keep.recount();
	expect(state.counts).toBe(1);
	open();
	await vi.advanceTimersByTimeAsync(0);
	expect(state.counts).toBe(2);
	expect(keep.status()).toEqual({ working: 1, holding: true });
});
it('start counts at once and then once a minute; a failed count keeps the hold; stop releases', async () => {
	const { keep, state } = setup();
	state.count = 1;
	keep.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(state.counts).toBe(1);
	expect(keep.status().holding).toBe(true);
	await vi.advanceTimersByTimeAsync(60_500);
	expect(state.counts).toBe(2);
	const failing = new KeepAwake(
		{
			count: async () => {
				throw new Error('unreadable');
			},
			enabled: () => true,
			blocker: { start: () => 7, stop: (id) => state.stopped.push(id) },
			changed: () => {},
			log: (line) => state.logs.push(line),
		},
		times
	);
	failing.apply(1);
	await failing.recount();
	expect(failing.status()).toEqual({ working: 1, holding: true });
	expect(state.logs.at(-1)).toMatch(/could not be counted/);
	failing.stop();
	expect(state.stopped).toContain(7);
	keep.stop();
	expect(state.stopped).toContain(1);
	expect(keep.status().holding).toBe(false);
	await vi.advanceTimersByTimeAsync(120_000);
	expect(state.counts).toBe(2);
});

it('holds while remote access is on, with no agent and the switch off (spec/remote-access-and-mobile#architecture)', async () => {
	vi.useFakeTimers();
	const { keep, state } = setup();
	state.enabled = false;
	state.held = true;
	await keep.recount();
	expect(state.started).toEqual([1]);
	expect(keep.status()).toEqual({ working: 0, holding: true });
	state.held = false;
	keep.settingChanged();
	await keep.recount();
	expect(state.stopped).toEqual([1]);
	keep.stop();
	vi.useRealTimers();
});
it('counts only agents at work: one waiting for the person, queued or preparing does not hold the Mac', () => {
	const tasks = (...statuses: TaskStatus[]) => statuses.map((status) => ({ status }));
	expect(workingAgents(tasks())).toBe(0);
	expect(workingAgents(tasks('needs-you', 'queued', 'preparing', 'done', 'rate-limited'))).toBe(0);
	expect(workingAgents(tasks('working', 'needs-you', 'working'))).toBe(2);
});
it('recounts on the events that move a task in or out of work, including a question to the person and a stopped host', () => {
	for (const kind of [
		'turn.started',
		'turn.completed',
		'question.requested',
		'question.resolved',
		'permission.requested',
		'session.failed',
		'host.stopped',
	])
		expect(keepAwakeKinds.has(kind)).toBe(true);
	expect(keepAwakeKinds.has('message.delta')).toBe(false);
});
it('a crew worker still working holds the computer after its foreman and the other workers are done', () => {
	const foreman = { status: 'done' as TaskStatus },
		workers = (['done', 'working', 'done'] as TaskStatus[]).map((status) => ({ status }));
	expect(workingAgents([foreman, ...workers])).toBe(1);
});
it('keeps the display on only while agents work with its switch on, and swaps the blocker with no gap', async () => {
	const { keep, state } = setup();
	state.count = 1;
	await keep.recount();
	expect(state.kinds).toEqual(['system']);
	// The display switch on: the display blocker starts before the system one stops.
	state.display = true;
	keep.settingChanged();
	expect(state.kinds).toEqual(['system', 'display']);
	expect(state.stopped).toEqual([1]);
	expect(keep.status()).toEqual({ working: 1, holding: true });
	// The last agent stops: the display stays on through the 30 s grace, then everything goes.
	state.count = 0;
	await keep.recount();
	expect(state.stopped).toEqual([1]);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(state.stopped).toEqual([1, 2]);
	// Remote access alone never keeps the display on.
	state.held = true;
	await keep.recount();
	expect(state.kinds).toEqual(['system', 'display', 'system']);
	state.held = false;
	await keep.recount();
	await vi.advanceTimersByTimeAsync(30_000);
	// The display switch going off during the grace drops back to the system blocker at once.
	state.count = 1;
	await keep.recount();
	state.count = 0;
	await keep.recount();
	state.display = false;
	keep.settingChanged();
	expect(state.kinds).toEqual(['system', 'display', 'system', 'display', 'system']);
	expect(keep.status()).toEqual({ working: 0, holding: true });
	// Keep awake off: the display switch alone holds nothing.
	state.display = true;
	state.enabled = false;
	state.count = 2;
	keep.settingChanged();
	await keep.recount();
	expect(keep.status()).toEqual({ working: 0, holding: false });
	expect(state.kinds).toHaveLength(5);
});
