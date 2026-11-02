import { isRecord, isId, type AgentTask } from './workspace';
import { isLaunchInput, type TaskLaunch } from './launch';
import { isCrewLaunch, type CrewLaunch } from './crew';
/**
 * spec/notifications-slack-notes-and-schedules#schedules: scheduled tasks. A schedule belongs to a project: the launch sheet's blank (prompt, provider, launch, crew,
 * options) plus a rule in a time zone. Every run is a new task from the blank; a run reaches Tasks only when it needs the
 * person. Time is computed here, in the schedule's IANA zone, never from a timer: the next run follows from the
 * rule and the cursor `checkedUntil`.
 */

/** Monday = 1 … Sunday = 7. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** `HH:MM`, 24 h, local to the schedule's zone. */
export type ClockTime = string;
export type ScheduleRule =
	| { kind: 'once'; at: string }
	| { kind: 'hourly'; minute: number }
	| { kind: 'interval'; hours: number; between?: { from: ClockTime; to: ClockTime } }
	| { kind: 'weekly'; days: Weekday[]; times: ClockTime[] }
	| { kind: 'cron'; expr: string };
export type ScheduleMissed = 'catch-up' | 'skip' | 'ask';
export type ScheduleInTasks = 'needs-you' | 'always';
export const scheduleMissedValues: readonly ScheduleMissed[] = ['catch-up', 'skip', 'ask'];
export const scheduleInTasksValues: readonly ScheduleInTasks[] = ['needs-you', 'always'];
/** What a run starts with: the sheet's arguments to `task:create` (spec/notifications-slack-notes-and-schedules#schedules). */
export type ScheduleBlank = {
	prompt: string;
	provider: 'claude' | 'codex';
	transport: 'gui' | 'terminal';
	launch?: TaskLaunch;
	crew?: CrewLaunch;
	options?: { id: string; value: string }[];
};
export type ScheduleRunStatus = 'started' | 'skipped' | 'missed' | 'failed-to-start';
export type ScheduleRunReason =
	'previous-run-active' | 'missed' | 'asked-skip' | 'start-failed' | 'run-now';
/** One line of `runs.jsonl`. `due` — the slot; `at` — when main acted on it. */
export type ScheduleRun = {
	due: string;
	at: string;
	status: ScheduleRunStatus;
	taskId?: string;
	reason?: ScheduleRunReason;
};
export type Schedule = {
	id: string;
	projectId: string;
	name: string;
	createdAt: string;
	paused: boolean;
	timeZone: string;
	rule: ScheduleRule;
	missed: ScheduleMissed;
	inTasks: ScheduleInTasks;
	task: ScheduleBlank;
	/** Slots up to and including this instant have been handled (run, skipped or asked about). */
	checkedUntil: string;
	lastRun?: ScheduleRun;
	/** «Ask»: missed slots wait for the person; the live request in Needs you. */
	pendingMissed?: { count: number; latest: string };
};
export type ScheduleDocument = { schemaVersion: 1; schedule: Schedule };
/** The schedule as the renderer reads it: with the next slot computed now. */
export type ScheduleSummary = Schedule & { nextRun: string | null };

export const scheduleLimits = {
	name: 120,
	prompt: 100_000,
	times: 12,
	cron: 120,
	hours: 12,
} as const;
/** A missed slot older than this is never caught up. */
export const catchUpWindowMs = 24 * 3_600_000;

export function isScheduleId(value: unknown): value is string {
	return typeof value === 'string' && /^s_[a-z0-9]{6,24}$/.test(value);
}
export function newScheduleId(random: () => number = Math.random) {
	let id = 's_';
	for (let i = 0; i < 12; i++)
		id += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)];
	return id;
}
const isIso = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
export function isClockTime(value: unknown): value is ClockTime {
	return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export const clockMinutes = (time: ClockTime) =>
	Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const timeZones = new Map<string, Intl.DateTimeFormat | null>();
function zoneFormat(zone: string) {
	if (!timeZones.has(zone)) {
		try {
			timeZones.set(
				zone,
				new Intl.DateTimeFormat('en-US', {
					timeZone: zone,
					hourCycle: 'h23',
					year: 'numeric',
					month: 'numeric',
					day: 'numeric',
					hour: 'numeric',
					minute: 'numeric',
				})
			);
		} catch {
			timeZones.set(zone, null);
		}
	}
	return timeZones.get(zone) ?? null;
}
export function isTimeZone(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 64 &&
		zoneFormat(value) !== null
	);
}

// ── cron ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CronSpec = {
	minutes: number[];
	hours: number[];
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	anyDay: boolean;
	anyWeekday: boolean;
};
export type CronError = 'fields' | 'syntax' | 'range';
const cronRanges: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7],
];
function cronField(text: string, [low, high]: [number, number]): number[] | CronError {
	const out = new Set<number>();
	for (const part of text.split(',')) {
		const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!match) return 'syntax';
		const step = match[4] === undefined ? 1 : Number(match[4]);
		let from = low,
			to = high;
		if (match[1] !== '*') {
			from = Number(match[2]);
			to = match[3] === undefined ? (match[4] === undefined ? from : high) : Number(match[3]);
		}
		if (step < 1 || from < low || to > high || from > to) return 'range';
		for (let value = from; value <= to; value += step) out.add(value);
	}
	return [...out].sort((a, b) => a - b);
}
/** Five fields — minute, hour, day of month, month, day of week (0 and 7 are Sunday); `*`, lists, ranges and steps. */
export function parseCron(expr: string): CronSpec | CronError {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5 || expr.length > scheduleLimits.cron) return 'fields';
	const parsed: number[][] = [];
	for (let i = 0; i < 5; i++) {
		const field = cronField(fields[i]!, cronRanges[i]!);
		if (typeof field === 'string') return field;
		parsed.push(field);
	}
	return {
		minutes: parsed[0]!,
		hours: parsed[1]!,
		days: new Set(parsed[2]),
		months: new Set(parsed[3]),
		weekdays: new Set(parsed[4]!.map((day) => (day === 7 ? 0 : day))),
		anyDay: fields[2] === '*',
		anyWeekday: fields[4] === '*',
	};
}

export function isScheduleRule(value: unknown): value is ScheduleRule {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'once':
			return Object.keys(value).length === 2 && isIso(value.at);
		case 'hourly':
			return (
				Object.keys(value).length === 2 &&
				Number.isInteger(value.minute) &&
				(value.minute as number) >= 0 &&
				(value.minute as number) <= 59
			);
		case 'interval': {
			const between = value.between;
			return (
				Number.isInteger(value.hours) &&
				(value.hours as number) >= 1 &&
				(value.hours as number) <= scheduleLimits.hours &&
				(between === undefined ||
					(isRecord(between) &&
						isClockTime(between.from) &&
						isClockTime(between.to) &&
						clockMinutes(between.from) <= clockMinutes(between.to)))
			);
		}
		case 'weekly':
			return (
				Array.isArray(value.days) &&
				value.days.length >= 1 &&
				value.days.length <= 7 &&
				new Set(value.days).size === value.days.length &&
				value.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) &&
				Array.isArray(value.times) &&
				value.times.length >= 1 &&
				value.times.length <= scheduleLimits.times &&
				new Set(value.times).size === value.times.length &&
				value.times.every(isClockTime)
			);
		case 'cron':
			return typeof value.expr === 'string' && typeof parseCron(value.expr) !== 'string';
		default:
			return false;
	}
}
const isOptions = (value: unknown) =>
	Array.isArray(value) &&
	value.length <= 64 &&
	value.every(
		(item) =>
			isRecord(item) &&
			typeof item.id === 'string' &&
			item.id.length <= 200 &&
			typeof item.value === 'string' &&
			item.value.length <= 200
	);
export function isScheduleBlank(value: unknown): value is ScheduleBlank {
	return (
		isRecord(value) &&
		typeof value.prompt === 'string' &&
		value.prompt.trim().length > 0 &&
		value.prompt.length <= scheduleLimits.prompt &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		(value.transport === 'gui' || value.transport === 'terminal') &&
		(value.launch === undefined || isLaunchInput(value.launch)) &&
		(value.crew === undefined || isCrewLaunch(value.crew)) &&
		(value.options === undefined || isOptions(value.options))
	);
}
const isRun = (value: unknown): value is ScheduleRun =>
	isRecord(value) &&
	isIso(value.due) &&
	isIso(value.at) &&
	['started', 'skipped', 'missed', 'failed-to-start'].includes(value.status as string) &&
	(value.taskId === undefined || isId(value.taskId)) &&
	(value.reason === undefined ||
		['previous-run-active', 'missed', 'asked-skip', 'start-failed', 'run-now'].includes(
			value.reason as string
		));
export { isRun as isScheduleRun };
export function isSchedule(value: unknown): value is Schedule {
	return (
		isRecord(value) &&
		isScheduleId(value.id) &&
		isId(value.projectId) &&
		typeof value.name === 'string' &&
		value.name.trim().length > 0 &&
		value.name.length <= scheduleLimits.name &&
		isIso(value.createdAt) &&
		typeof value.paused === 'boolean' &&
		isTimeZone(value.timeZone) &&
		isScheduleRule(value.rule) &&
		scheduleMissedValues.includes(value.missed as ScheduleMissed) &&
		scheduleInTasksValues.includes(value.inTasks as ScheduleInTasks) &&
		isScheduleBlank(value.task) &&
		isIso(value.checkedUntil) &&
		(value.lastRun === undefined || isRun(value.lastRun)) &&
		(value.pendingMissed === undefined ||
			(isRecord(value.pendingMissed) &&
				Number.isInteger(value.pendingMissed.count) &&
				(value.pendingMissed.count as number) >= 1 &&
				isIso(value.pendingMissed.latest)))
	);
}

// ── time in a zone ──────────────────────────────────────────────────────────────────────────────────────────────────
type Local = { y: number; m: number; d: number; h: number; mi: number };
function localParts(ms: number, zone: string): Local {
	const format = zoneFormat(zone);
	if (!format) throw new RangeError(`Unknown time zone ${zone}`);
	const got: Record<string, number> = {};
	for (const part of format.formatToParts(new Date(ms)))
		if (part.type !== 'literal') got[part.type] = Number(part.value);
	return { y: got.year!, m: got.month!, d: got.day!, h: got.hour! % 24, mi: got.minute! };
}
const offsetAt = (ms: number, zone: string) => {
	const p = localParts(ms, zone);
	return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
};
/** The instant a local wall-clock minute names in `zone`. A minute skipped by a DST jump resolves to the first one after it. */
export function zonedInstant(
	y: number,
	m: number,
	d: number,
	minute: number,
	zone: string
): number {
	const wall = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
	let at = wall - offsetAt(wall, zone);
	const second = wall - offsetAt(at, zone);
	if (second !== at) at = Math.max(at, second);
	return at;
}
export function zonedDay(ms: number, zone: string) {
	const p = localParts(ms, zone);
	return { y: p.y, m: p.m, d: p.d, minute: p.h * 60 + p.mi };
}
/** Monday = 1 … Sunday = 7, for a calendar date. */
export const weekdayOf = (y: number, m: number, d: number) =>
	(((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1) as Weekday;
const nextDate = (y: number, m: number, d: number) => {
	const t = new Date(Date.UTC(y, m - 1, d + 1));
	return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
/** The local minutes of a calendar day on which the rule fires, ascending. */
function dayMinutes(
	rule: Exclude<ScheduleRule, { kind: 'once' }>,
	y: number,
	m: number,
	d: number,
	cron?: CronSpec
): number[] {
	switch (rule.kind) {
		case 'hourly':
			return Array.from({ length: 24 }, (_, h) => h * 60 + rule.minute);
		case 'interval': {
			const from = rule.between ? clockMinutes(rule.between.from) : 0,
				to = rule.between ? clockMinutes(rule.between.to) : 24 * 60 - 1,
				out: number[] = [];
			for (let minute = from; minute <= to; minute += rule.hours * 60) out.push(minute);
			return out;
		}
		case 'weekly':
			return rule.days.includes(weekdayOf(y, m, d))
				? rule.times.map(clockMinutes).sort((a, b) => a - b)
				: [];
		case 'cron': {
			const spec = cron!;
			if (!spec.months.has(m)) return [];
			const sunday0 = weekdayOf(y, m, d) % 7,
				dom = spec.days.has(d),
				dow = spec.weekdays.has(sunday0);
			const matches =
				spec.anyDay && spec.anyWeekday
					? true
					: spec.anyDay
						? dow
						: spec.anyWeekday
							? dom
							: dom || dow;
			if (!matches) return [];
			return spec.hours.flatMap((h) => spec.minutes.map((mi) => h * 60 + mi));
		}
	}
}
/** The first slot strictly after `after`, or null (a past `once`, or nothing within ~4 years — a cron for 31 February). */
export function nextRun(rule: ScheduleRule, zone: string, after: number): number | null {
	if (rule.kind === 'once') {
		const at = Date.parse(rule.at);
		return at > after ? at : null;
	}
	const cron = rule.kind === 'cron' ? parseCron(rule.expr) : undefined;
	if (typeof cron === 'string') return null;
	// Start a day early: the zone may be behind, and the first local day can still hold a slot after `after`.
	let { y, m, d } = zonedDay(after - 86_400_000, zone);
	for (let i = 0; i < 1470; i++) {
		for (const minute of dayMinutes(rule, y, m, d, cron)) {
			const at = zonedInstant(y, m, d, minute, zone);
			if (at > after) return at;
		}
		({ y, m, d } = nextDate(y, m, d));
	}
	return null;
}
/** Slots in (from, to], at most `limit` (the latest ones are kept). */
export function slotsBetween(
	rule: ScheduleRule,
	zone: string,
	from: number,
	to: number,
	limit = 500
): number[] {
	const out: number[] = [];
	let at = nextRun(rule, zone, from);
	while (at !== null && at <= to) {
		out.push(at);
		if (out.length > limit) out.shift();
		at = nextRun(rule, zone, at);
	}
	return out;
}
/** The next `count` slots after `after` — the editor's «Next: …» line. */
export function upcomingRuns(rule: ScheduleRule, zone: string, after: number, count = 3): number[] {
	const out: number[] = [];
	let at = nextRun(rule, zone, after);
	while (at !== null && out.length < count) {
		out.push(at);
		at = nextRun(rule, zone, at);
	}
	return out;
}

// ── what main does with due and missed slots ──────────────────────────────────────────────────────────────────────
export type DueDecision =
	| { kind: 'none' }
	| { kind: 'run'; due: number; skipped: number[] }
	| { kind: 'skip'; skipped: number[] }
	| { kind: 'ask'; missed: number[] };
/**
 * Slots since `checkedUntil` up to `now`. A slot is on time while it is no older than `graceMs` (the timer fired); older
 * ones are missed — the computer slept or the app was closed — and follow the schedule's «If missed».
 */
export function dueDecision(schedule: Schedule, now: number, graceMs = 120_000): DueDecision {
	if (schedule.paused) return { kind: 'none' };
	const slots = slotsBetween(
		schedule.rule,
		schedule.timeZone,
		Date.parse(schedule.checkedUntil),
		now
	);
	if (!slots.length) return { kind: 'none' };
	const latest = slots[slots.length - 1]!;
	if (now - latest <= graceMs) return { kind: 'run', due: latest, skipped: slots.slice(0, -1) };
	switch (schedule.missed) {
		case 'catch-up':
			return now - latest <= catchUpWindowMs
				? { kind: 'run', due: latest, skipped: slots.slice(0, -1) }
				: { kind: 'skip', skipped: slots };
		case 'skip':
			return { kind: 'skip', skipped: slots };
		case 'ask':
			return { kind: 'ask', missed: slots };
	}
}

// ── runs in Tasks ─────────────────────────────────────────────────────────────────────────────────────────────────
/** A run reaches Tasks when it waits for the person, failed, or left changes; otherwise it stays quiet in Schedules. */
export function runNeedsPerson(
	task: Pick<AgentTask, 'status' | 'changeSummary' | 'pullRequests'>
): boolean {
	if (task.status === 'needs-you' || task.status === 'failed' || task.status === 'interrupted')
		return true;
	const changes = task.changeSummary;
	if (changes && changes.additions + changes.deletions > 0) return true;
	return !!task.pullRequests && Object.keys(task.pullRequests).length > 0;
}
/** Whether the task list shows this task: a quiet scheduled run only with the «Quiet scheduled runs» filter on. */
export function taskListed(task: Pick<AgentTask, 'scheduleRun'>, showQuiet = false): boolean {
	return !task.scheduleRun?.quiet || showQuiet;
}
/** The run's task, finished: quiet and without anything for the person — main marks it completed. */
export function quietRunFinished(
	task: Pick<AgentTask, 'status' | 'scheduleRun' | 'changeSummary' | 'pullRequests'>
): boolean {
	return !!task.scheduleRun?.quiet && task.status === 'done' && !runNeedsPerson(task);
}

// ── what the renderer sends (spec/notifications-slack-notes-and-schedules#schedules) ─────────────────────────────────────────────────────────────────────
/** A schedule as the editor and the sheet make it; main adds the id, the times and the run history. */
export type ScheduleDraft = Pick<
	Schedule,
	'name' | 'timeZone' | 'rule' | 'missed' | 'inTasks' | 'task'
>;
export function isScheduleDraft(value: unknown): value is ScheduleDraft {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) =>
			['name', 'timeZone', 'rule', 'missed', 'inTasks', 'task'].includes(key)
		) &&
		typeof value.name === 'string' &&
		value.name.trim().length > 0 &&
		value.name.length <= scheduleLimits.name &&
		isTimeZone(value.timeZone) &&
		isScheduleRule(value.rule) &&
		scheduleMissedValues.includes(value.missed as ScheduleMissed) &&
		scheduleInTasksValues.includes(value.inTasks as ScheduleInTasks) &&
		isScheduleBlank(value.task)
	);
}
export function newSchedule(
	draft: ScheduleDraft,
	projectId: string,
	id: string,
	now: number
): Schedule {
	const at = new Date(now).toISOString();
	return {
		...draft,
		name: draft.name.trim(),
		id,
		projectId,
		createdAt: at,
		paused: false,
		checkedUntil: at,
	};
}
/** An edit keeps the id, the history and the pause; a new rule or zone counts from now — its past slots are not «missed». */
export function editedSchedule(schedule: Schedule, draft: ScheduleDraft, now: number): Schedule {
	const timing =
		JSON.stringify([schedule.rule, schedule.timeZone]) !==
		JSON.stringify([draft.rule, draft.timeZone]);
	const { pendingMissed, ...rest } = schedule;
	return {
		...rest,
		...draft,
		name: draft.name.trim(),
		...(timing
			? { checkedUntil: new Date(Math.max(now, Date.parse(schedule.checkedUntil))).toISOString() }
			: {}),
		...(pendingMissed && !timing ? { pendingMissed } : {}),
	};
}

// ── the rule in words (spec/notifications-slack-notes-and-schedules#schedules, GLOSSARY) ────────────────────────────────────────────────────────────────────
const ukEvery: Record<Weekday, string> = {
	1: 'Щопонеділка',
	2: 'Щовівторка',
	3: 'Щосереди',
	4: 'Щочетверга',
	5: 'Щоп’ятниці',
	6: 'Щосуботи',
	7: 'Щонеділі',
};
const enEvery: Record<Weekday, string> = {
	1: 'Mondays',
	2: 'Tuesdays',
	3: 'Wednesdays',
	4: 'Thursdays',
	5: 'Fridays',
	6: 'Saturdays',
	7: 'Sundays',
};
const ukShort: Record<Weekday, string> = {
	1: 'Пн',
	2: 'Вт',
	3: 'Ср',
	4: 'Чт',
	5: 'Пт',
	6: 'Сб',
	7: 'Нд',
};
const enShort: Record<Weekday, string> = {
	1: 'Mon',
	2: 'Tue',
	3: 'Wed',
	4: 'Thu',
	5: 'Fri',
	6: 'Sat',
	7: 'Sun',
};
const sameDays = (a: Weekday[], b: number[]) =>
	a.length === b.length && b.every((day) => a.includes(day as Weekday));
/** «Weekdays at 09:00» / «Щобудня о 09:00»; a cron rule reads as its expression. */
export function describeRule(locale: 'en' | 'uk', rule: ScheduleRule, zone: string): string {
	const uk = locale === 'uk',
		and = uk ? ' і ' : ' and ';
	switch (rule.kind) {
		case 'once': {
			const when = new Intl.DateTimeFormat(uk ? 'uk' : 'en-GB', {
				timeZone: zone,
				weekday: 'short',
				day: 'numeric',
				month: 'short',
				hour: '2-digit',
				minute: '2-digit',
				hourCycle: 'h23',
			}).format(Date.parse(rule.at));
			return uk ? `Один раз · ${when}` : `Once · ${when}`;
		}
		case 'hourly':
			return uk
				? `Щогодини о :${String(rule.minute).padStart(2, '0')}`
				: `Every hour at :${String(rule.minute).padStart(2, '0')}`;
		case 'interval': {
			const every = uk ? `Кожні ${rule.hours} год` : `Every ${rule.hours} h`;
			return rule.between ? `${every}, ${rule.between.from}–${rule.between.to}` : every;
		}
		case 'weekly': {
			const times = [...rule.times].sort().join(and),
				at = uk ? ` о ${times}` : ` at ${times}`;
			if (sameDays(rule.days, [1, 2, 3, 4, 5, 6, 7])) return (uk ? 'Щодня' : 'Daily') + at;
			if (sameDays(rule.days, [1, 2, 3, 4, 5])) return (uk ? 'Щобудня' : 'Weekdays') + at;
			if (sameDays(rule.days, [6, 7])) return (uk ? 'На вихідних' : 'Weekends') + at;
			if (rule.days.length === 1) return (uk ? ukEvery : enEvery)[rule.days[0]!] + at;
			const days = [...rule.days].sort((a, b) => a - b).map((day) => (uk ? ukShort : enShort)[day]);
			return days.join(', ') + at;
		}
		case 'cron':
			return `cron ${rule.expr.trim().replace(/\s+/g, ' ')}`;
	}
}
/** A slot as a list shows it: «Thu 30 Oct, 09:00» in the schedule's zone. */
export function formatSlot(locale: 'en' | 'uk', at: number | string, zone: string): string {
	return new Intl.DateTimeFormat(locale === 'uk' ? 'uk' : 'en-GB', {
		timeZone: zone,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(typeof at === 'string' ? Date.parse(at) : at);
}
/** The zone's offset now, «UTC+2». */
export function zoneOffsetLabel(zone: string, at = Date.now()): string {
	const minutes = Math.round(
		(Date.UTC(
			...(Object.values(zonedDayParts(at, zone)) as [number, number, number, number, number])
		) -
			Math.floor(at / 60_000) * 60_000) /
			60_000
	);
	const sign = minutes < 0 ? '−' : '+',
		abs = Math.abs(minutes);
	return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}
function zonedDayParts(at: number, zone: string) {
	const p = zonedDay(at, zone);
	return { y: p.y, m: p.m - 1, d: p.d, h: Math.floor(p.minute / 60), mi: p.minute % 60 };
}

/** The state a list row shows (spec/notifications-slack-notes-and-schedules#schedules): its glyph, its colour and the second line's tail. */
export type ScheduleState = 'running' | 'ask' | 'failed' | 'paused' | 'scheduled' | 'done';
export function scheduleState(
	schedule: Pick<ScheduleSummary, 'paused' | 'pendingMissed' | 'lastRun' | 'nextRun' | 'projectId'>,
	tasks: Pick<AgentTask, 'id' | 'projectId' | 'status'>[]
): ScheduleState {
	if (schedule.pendingMissed) return 'ask';
	const last = schedule.lastRun,
		task = last?.taskId
			? tasks.find((item) => item.projectId === schedule.projectId && item.id === last.taskId)
			: undefined;
	if (task && ['queued', 'preparing', 'working'].includes(task.status)) return 'running';
	if (last?.status === 'failed-to-start' || task?.status === 'failed') return 'failed';
	if (schedule.paused) return 'paused';
	return schedule.nextRun ? 'scheduled' : 'done';
}
