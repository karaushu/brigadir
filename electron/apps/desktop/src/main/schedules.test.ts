import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask, Schedule, ScheduleRun } from '@brigadir/core';
import { Scheduler, type ScheduleNotice, type SchedulerDeps } from './schedules';

const at = (text: string) => Date.parse(text);
const base = (patch: Partial<Schedule> = {}): Schedule => ({
	id: 's_abcdef123456',
	projectId: 'business',
	name: 'Daily review',
	createdAt: '2026-10-01T00:00:00.000Z',
	paused: false,
	timeZone: 'Europe/Kyiv',
	rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] },
	missed: 'catch-up',
	inTasks: 'needs-you',
	task: { prompt: 'Review yesterday', provider: 'claude', transport: 'gui' },
	checkedUntil: '2026-10-29T08:00:00.000Z',
	...patch,
});

function harness(schedule: Schedule, now: number, tasks: AgentTask[] = []) {
	let current = schedule;
	const runs: ScheduleRun[] = [],
		notices: ScheduleNotice[] = [],
		started: string[] = [],
		updates: [string, Partial<AgentTask>][] = [];
	let clock = now,
		n = 0;
	const deps: SchedulerDeps = {
		store: {
			list: async () => [current],
			read: async () => current,
			save: async (s) => (current = s),
			update: async (_p, _i, change) => (current = change(current)),
			delete: async () => {},
			appendRuns: async (_p, _i, items) => void runs.push(...items),
			runs: async () => runs,
		},
		tasks: async () => tasks,
		createRun: async (s, due, quiet) => {
			const task: AgentTask = {
				id: `run-${++n}`,
				projectId: s.projectId,
				title: s.name,
				status: 'queued',
				scheduleRun: { scheduleId: s.id, due: new Date(due).toISOString(), quiet },
			};
			tasks.push(task);
			return task;
		},
		start: (key) => void started.push(key.id),
		markLoud: async (task) => {
			updates.push([task.id, { scheduleRun: { ...task.scheduleRun!, quiet: false } }]);
			task.scheduleRun = { ...task.scheduleRun!, quiet: false };
		},
		complete: async (task) => {
			updates.push([task.id, { status: 'completed' }]);
			task.status = 'completed';
		},
		notify: (notice) => void notices.push(notice),
		changed: () => {},
		enabled: () => true,
		now: () => clock,
	};
	const scheduler = new Scheduler(deps);
	return {
		scheduler,
		runs,
		notices,
		started,
		updates,
		tasks,
		get schedule() {
			return current;
		},
		set now(value: number) {
			clock = value;
		},
	};
}

afterEach(() => vi.useRealTimers());

describe('Scheduler', () => {
	it('starts a run on time and moves the cursor', async () => {
		const h = harness(base(), at('2026-10-30T07:00:20Z'));
		h.scheduler.start();
		await h.scheduler.kick();
		h.scheduler.stop();
		expect(h.started).toEqual(['run-1']);
		expect(h.runs).toEqual([
			expect.objectContaining({
				status: 'started',
				taskId: 'run-1',
				due: '2026-10-30T07:00:00.000Z',
			}),
		]);
		expect(h.schedule.checkedUntil).toBe('2026-10-30T07:00:20.000Z');
		expect(h.schedule.lastRun?.taskId).toBe('run-1');
		expect(h.tasks[0]!.scheduleRun?.quiet).toBe(true);
	});
	it('skips a slot while the previous run still waits for the person', async () => {
		const previous: AgentTask = {
			id: 'run-0',
			projectId: 'business',
			title: 'Daily review',
			status: 'needs-you',
		};
		const h = harness(
			base({
				lastRun: {
					due: '2026-10-29T07:00:00.000Z',
					at: '2026-10-29T07:00:00.000Z',
					status: 'started',
					taskId: 'run-0',
				},
			}),
			at('2026-10-30T07:00:20Z'),
			[previous]
		);
		h.scheduler.start();
		await h.scheduler.kick();
		h.scheduler.stop();
		expect(h.started).toEqual([]);
		expect(h.runs).toEqual([
			expect.objectContaining({ status: 'skipped', reason: 'previous-run-active' }),
		]);
	});
	it('catch up: one run for the latest missed slot, the earlier ones written as missed', async () => {
		const h = harness(
			base({ checkedUntil: '2026-10-28T00:00:00.000Z' }),
			at('2026-10-30T12:00:00Z')
		);
		h.scheduler.start();
		await h.scheduler.kick();
		h.scheduler.stop();
		expect(h.runs.map((r) => r.status)).toEqual(['missed', 'missed', 'started']);
		expect(h.started).toEqual(['run-1']);
	});
	it('ask: waits for the person, then runs once', async () => {
		const h = harness(
			base({ missed: 'ask', checkedUntil: '2026-10-28T00:00:00.000Z' }),
			at('2026-10-30T12:00:00Z')
		);
		h.scheduler.start();
		await h.scheduler.kick();
		expect(h.schedule.pendingMissed).toEqual({ count: 3, latest: '2026-10-30T07:00:00.000Z' });
		expect(h.notices).toEqual([expect.objectContaining({ kind: 'missed', asked: true, count: 3 })]);
		expect(h.started).toEqual([]);
		await h.scheduler.resolveMissed('business', 's_abcdef123456', 'run');
		h.scheduler.stop();
		expect(h.schedule.pendingMissed).toBeUndefined();
		expect(h.started).toEqual(['run-1']);
	});
	it('run now works while paused; resume does not catch up the paused stretch', async () => {
		const h = harness(
			base({ paused: true, checkedUntil: '2026-10-20T00:00:00.000Z' }),
			at('2026-10-30T12:00:00Z')
		);
		h.scheduler.start();
		await h.scheduler.kick();
		expect(h.started).toEqual([]);
		await h.scheduler.runNow('business', 's_abcdef123456');
		expect(h.started).toEqual(['run-1']);
		expect(h.runs.at(-1)?.reason).toBe('run-now');
		await h.scheduler.setPaused('business', 's_abcdef123456', false);
		await h.scheduler.kick();
		h.scheduler.stop();
		expect(h.schedule.checkedUntil).toBe('2026-10-30T12:00:00.000Z');
		expect(h.started).toEqual(['run-1']);
	});
	it('a quiet run that waits for the person reaches Tasks; one that ended without changes is completed', async () => {
		vi.useFakeTimers();
		const h = harness(base(), at('2026-10-30T07:00:20Z'));
		h.scheduler.start();
		await h.scheduler.kick();
		await h.scheduler.runNow('business', 's_abcdef123456');
		const [first, second] = h.tasks;
		first!.status = 'needs-you';
		second!.status = 'done';
		h.scheduler.taskEvent(first!);
		h.scheduler.taskEvent(second!);
		await vi.advanceTimersByTimeAsync(1_000);
		h.scheduler.stop();
		expect(first!.scheduleRun?.quiet).toBe(false);
		expect(second!.status).toBe('completed');
		expect(h.notices.some((n) => n.kind === 'finished' && n.task.id === second!.id)).toBe(true);
	});
});
