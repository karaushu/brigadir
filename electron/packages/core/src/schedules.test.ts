import { describe, expect, it } from 'vitest';
import {
	scheduleState,
	describeRule,
	formatSlot,
	zoneOffsetLabel,
	dueDecision,
	isSchedule,
	isScheduleRule,
	newScheduleId,
	nextRun,
	parseCron,
	quietRunFinished,
	runNeedsPerson,
	slotsBetween,
	taskListed,
	upcomingRuns,
	weekdayOf,
	zonedInstant,
	type Schedule,
	type ScheduleRule,
} from './schedules';

const kyiv = 'Europe/Kyiv';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (text: string) => Date.parse(text);

describe('rules', () => {
	it('validates each kind', () => {
		expect(isScheduleRule({ kind: 'once', at: '2026-10-30T13:30:00.000Z' })).toBe(true);
		expect(isScheduleRule({ kind: 'hourly', minute: 59 })).toBe(true);
		expect(isScheduleRule({ kind: 'hourly', minute: 60 })).toBe(false);
		expect(
			isScheduleRule({ kind: 'interval', hours: 2, between: { from: '09:00', to: '19:00' } })
		).toBe(true);
		expect(isScheduleRule({ kind: 'interval', hours: 13 })).toBe(false);
		expect(
			isScheduleRule({ kind: 'interval', hours: 2, between: { from: '19:00', to: '09:00' } })
		).toBe(false);
		expect(isScheduleRule({ kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] })).toBe(true);
		expect(isScheduleRule({ kind: 'weekly', days: [], times: ['09:00'] })).toBe(false);
		expect(isScheduleRule({ kind: 'weekly', days: [1, 1], times: ['09:00'] })).toBe(false);
		expect(isScheduleRule({ kind: 'weekly', days: [8], times: ['09:00'] })).toBe(false);
		expect(isScheduleRule({ kind: 'weekly', days: [1], times: ['9:00'] })).toBe(false);
		expect(isScheduleRule({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe(true);
		expect(isScheduleRule({ kind: 'cron', expr: '0 9 * 1-5' })).toBe(false);
	});
	it('parses cron and names its faults', () => {
		const spec = parseCron('*/15 9-17 * * 1-5');
		expect(typeof spec).toBe('object');
		if (typeof spec === 'string') return;
		expect(spec.minutes).toEqual([0, 15, 30, 45]);
		expect(spec.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect(parseCron('0 9 * *')).toBe('fields');
		expect(parseCron('0 25 * * *')).toBe('range');
		expect(parseCron('0 9 * * mon')).toBe('syntax');
		const sunday = parseCron('0 9 * * 7');
		expect(typeof sunday !== 'string' && [...sunday.weekdays]).toEqual([0]);
	});
	it('makes ids', () => {
		expect(newScheduleId(() => 0.5)).toMatch(/^s_[a-z0-9]{12}$/);
	});
});

describe('next run in a zone', () => {
	it('weekdays at 09:00 Kyiv', () => {
		const rule: ScheduleRule = { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] };
		// Thu 29 Oct 2026, 12:00 Kyiv (UTC+2 after the October change) → Fri 30 Oct 09:00 = 07:00Z
		expect(iso(nextRun(rule, kyiv, at('2026-10-29T10:00:00Z')))).toBe('2026-10-30T07:00:00.000Z');
		// Fri after the slot → Mon 2 Nov
		expect(iso(nextRun(rule, kyiv, at('2026-10-30T07:00:00Z')))).toBe('2026-11-02T07:00:00.000Z');
	});
	it('follows summer time, not an offset', () => {
		const rule: ScheduleRule = { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['09:00'] };
		// 24 Oct is still UTC+3, 26 Oct already UTC+2
		expect(iso(nextRun(rule, kyiv, at('2026-10-23T10:00:00Z')))).toBe('2026-10-24T06:00:00.000Z');
		expect(iso(nextRun(rule, kyiv, at('2026-10-25T10:00:00Z')))).toBe('2026-10-26T07:00:00.000Z');
	});
	it('a minute skipped by the spring jump fires after the jump', () => {
		// 29 Mar 2026, Kyiv: 03:00 → 04:00; 03:30 does not exist
		const t = zonedInstant(2026, 3, 29, 3 * 60 + 30, kyiv);
		expect(t).toBeGreaterThanOrEqual(at('2026-03-29T01:00:00Z'));
		expect(t).toBeLessThanOrEqual(at('2026-03-29T01:30:00Z'));
	});
	it('every 2 h between 09:00 and 19:00', () => {
		const rule: ScheduleRule = {
			kind: 'interval',
			hours: 2,
			between: { from: '09:00', to: '19:00' },
		};
		const runs = upcomingRuns(rule, kyiv, at('2026-10-30T14:30:00Z'), 4).map(iso);
		// 16:30 Kyiv → 17:00, 19:00, then next day 09:00, 11:00
		expect(runs).toEqual([
			'2026-10-30T15:00:00.000Z',
			'2026-10-30T17:00:00.000Z',
			'2026-10-31T07:00:00.000Z',
			'2026-10-31T09:00:00.000Z',
		]);
	});
	it('hourly at a minute', () => {
		expect(iso(nextRun({ kind: 'hourly', minute: 5 }, 'UTC', at('2026-10-30T10:06:00Z')))).toBe(
			'2026-10-30T11:05:00.000Z'
		);
	});
	it('cron: day of month OR day of week when both are set', () => {
		const rule: ScheduleRule = { kind: 'cron', expr: '0 8 13 * 5' };
		// Fri 30 Oct 2026 08:00 UTC is a Friday
		expect(iso(nextRun(rule, 'UTC', at('2026-10-29T00:00:00Z')))).toBe('2026-10-30T08:00:00.000Z');
		expect(iso(nextRun(rule, 'UTC', at('2026-11-12T00:00:00Z')))).toBe('2026-11-13T08:00:00.000Z');
	});
	it('once is in the past or the future', () => {
		const rule: ScheduleRule = { kind: 'once', at: '2026-10-30T13:30:00.000Z' };
		expect(iso(nextRun(rule, kyiv, at('2026-10-30T10:00:00Z')))).toBe('2026-10-30T13:30:00.000Z');
		expect(nextRun(rule, kyiv, at('2026-10-30T14:00:00Z'))).toBeNull();
	});
	it('a cron that never fires returns null', () => {
		expect(
			nextRun({ kind: 'cron', expr: '0 9 31 2 *' }, 'UTC', at('2026-10-30T00:00:00Z'))
		).toBeNull();
	});
	it('weekday of a date', () => {
		expect(weekdayOf(2026, 10, 30)).toBe(5);
		expect(weekdayOf(2026, 11, 1)).toBe(7);
	});
	it('slots between two instants keep the latest', () => {
		const rule: ScheduleRule = { kind: 'hourly', minute: 0 };
		const slots = slotsBetween(
			rule,
			'UTC',
			at('2026-10-30T00:00:00Z'),
			at('2026-10-30T05:00:00Z'),
			3
		);
		expect(slots.map(iso)).toEqual([
			'2026-10-30T03:00:00.000Z',
			'2026-10-30T04:00:00.000Z',
			'2026-10-30T05:00:00.000Z',
		]);
	});
});

const schedule = (patch: Partial<Schedule> = {}): Schedule => ({
	id: 's_abcdef123456',
	projectId: 'business',
	name: 'Daily review',
	createdAt: '2026-10-01T00:00:00.000Z',
	paused: false,
	timeZone: kyiv,
	rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] },
	missed: 'catch-up',
	inTasks: 'needs-you',
	task: { prompt: 'Review yesterday', provider: 'claude', transport: 'gui' },
	checkedUntil: '2026-10-29T08:00:00.000Z',
	...patch,
});

describe('due and missed slots', () => {
	it('validates a schedule', () => {
		expect(isSchedule(schedule())).toBe(true);
		expect(isSchedule(schedule({ timeZone: 'Mars/Olympus' }))).toBe(false);
		expect(isSchedule(schedule({ name: ' ' }))).toBe(false);
	});
	it('runs a slot on time', () => {
		expect(dueDecision(schedule(), at('2026-10-30T07:00:30Z'))).toEqual({
			kind: 'run',
			due: at('2026-10-30T07:00:00Z'),
			skipped: [],
		});
	});
	it('nothing due, or paused', () => {
		expect(dueDecision(schedule(), at('2026-10-30T06:59:00Z'))).toEqual({ kind: 'none' });
		expect(dueDecision(schedule({ paused: true }), at('2026-10-30T07:00:30Z'))).toEqual({
			kind: 'none',
		});
	});
	it('catch up: one run for the latest missed slot within 24 h, the rest skipped', () => {
		const d = dueDecision(
			schedule({ checkedUntil: '2026-10-28T00:00:00.000Z' }),
			at('2026-10-30T12:00:00Z')
		);
		expect(d).toEqual({
			kind: 'run',
			due: at('2026-10-30T07:00:00Z'),
			skipped: [at('2026-10-28T07:00:00Z'), at('2026-10-29T07:00:00Z')],
		});
	});
	it('catch up: older than 24 h is skipped', () => {
		const d = dueDecision(schedule(), at('2026-10-31T12:00:00Z'));
		expect(d).toEqual({ kind: 'skip', skipped: [at('2026-10-30T07:00:00Z')] });
	});
	it('skip and ask', () => {
		expect(dueDecision(schedule({ missed: 'skip' }), at('2026-10-30T12:00:00Z'))).toEqual({
			kind: 'skip',
			skipped: [at('2026-10-30T07:00:00Z')],
		});
		expect(dueDecision(schedule({ missed: 'ask' }), at('2026-10-30T12:00:00Z'))).toEqual({
			kind: 'ask',
			missed: [at('2026-10-30T07:00:00Z')],
		});
	});
});

describe('runs in Tasks', () => {
	const run = { scheduleId: 's_abcdef123456', due: '2026-10-30T07:00:00.000Z', quiet: true };
	it('a run needs the person when it waits, failed or left changes', () => {
		expect(runNeedsPerson({ status: 'working' })).toBe(false);
		expect(runNeedsPerson({ status: 'needs-you' })).toBe(true);
		expect(runNeedsPerson({ status: 'failed' })).toBe(true);
		expect(runNeedsPerson({ status: 'done', changeSummary: { additions: 0, deletions: 0 } })).toBe(
			false
		);
		expect(runNeedsPerson({ status: 'done', changeSummary: { additions: 3, deletions: 0 } })).toBe(
			true
		);
	});
	it('quiet runs are listed only with the filter', () => {
		expect(taskListed({ scheduleRun: run })).toBe(false);
		expect(taskListed({ scheduleRun: run }, true)).toBe(true);
		expect(taskListed({ scheduleRun: { ...run, quiet: false } })).toBe(true);
		expect(taskListed({})).toBe(true);
	});
	it('a quiet run that ended without changes is finished', () => {
		expect(quietRunFinished({ status: 'done', scheduleRun: run })).toBe(true);
		expect(
			quietRunFinished({
				status: 'done',
				scheduleRun: run,
				changeSummary: { additions: 1, deletions: 1 },
			})
		).toBe(false);
		expect(quietRunFinished({ status: 'done', scheduleRun: { ...run, quiet: false } })).toBe(false);
	});
});

describe('the rule in words', () => {
	it('reads presets in both languages', () => {
		const weekdays: ScheduleRule = { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] };
		expect(describeRule('en', weekdays, kyiv)).toBe('Weekdays at 09:00');
		expect(describeRule('uk', weekdays, kyiv)).toBe('Щобудня о 09:00');
		expect(
			describeRule(
				'en',
				{ kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['18:30', '09:00'] },
				kyiv
			)
		).toBe('Daily at 09:00 and 18:30');
		expect(describeRule('uk', { kind: 'weekly', days: [1], times: ['10:00'] }, kyiv)).toBe(
			'Щопонеділка о 10:00'
		);
		expect(describeRule('en', { kind: 'weekly', days: [5, 1, 3], times: ['09:00'] }, kyiv)).toBe(
			'Mon, Wed, Fri at 09:00'
		);
		expect(
			describeRule(
				'en',
				{ kind: 'interval', hours: 2, between: { from: '09:00', to: '19:00' } },
				kyiv
			)
		).toBe('Every 2 h, 09:00–19:00');
		expect(describeRule('uk', { kind: 'hourly', minute: 5 }, kyiv)).toBe('Щогодини о :05');
		expect(describeRule('en', { kind: 'cron', expr: '0  9 * * 1-5' }, kyiv)).toBe(
			'cron 0 9 * * 1-5'
		);
		expect(describeRule('en', { kind: 'once', at: '2026-10-30T13:30:00.000Z' }, kyiv)).toMatch(
			/^Once · .*15:30$/
		);
	});
	it('labels a zone and a slot', () => {
		expect(zoneOffsetLabel(kyiv, at('2026-10-30T12:00:00Z'))).toBe('UTC+2');
		expect(zoneOffsetLabel('Asia/Kolkata', at('2026-10-30T12:00:00Z'))).toBe('UTC+5:30');
		expect(formatSlot('en', '2026-10-30T07:00:00.000Z', kyiv)).toMatch(/09:00$/);
	});
});

describe('a row state', () => {
	const summary = { projectId: 'business', paused: false, nextRun: '2026-10-30T07:00:00.000Z' };
	it('reads the last run and the pause', () => {
		expect(scheduleState(summary, [])).toBe('scheduled');
		expect(scheduleState({ ...summary, paused: true, nextRun: null }, [])).toBe('paused');
		expect(scheduleState({ ...summary, nextRun: null }, [])).toBe('done');
		expect(
			scheduleState(
				{ ...summary, pendingMissed: { count: 2, latest: '2026-10-30T07:00:00.000Z' } },
				[]
			)
		).toBe('ask');
		const lastRun = {
			due: '2026-10-30T07:00:00.000Z',
			at: '2026-10-30T07:00:00.000Z',
			status: 'started' as const,
			taskId: 'r1',
		};
		expect(
			scheduleState({ ...summary, lastRun }, [
				{ id: 'r1', projectId: 'business', status: 'working' },
			])
		).toBe('running');
		expect(
			scheduleState({ ...summary, lastRun }, [
				{ id: 'r1', projectId: 'business', status: 'failed' },
			])
		).toBe('failed');
		expect(
			scheduleState({ ...summary, lastRun: { ...lastRun, status: 'failed-to-start' } }, [])
		).toBe('failed');
	});
});
