import type { EventRecord, SessionEvent } from './session';
import { isRecord } from './workspace';

/** spec/smoke-run#report: how a step of a smoke run ended. */
export type SmokeResult = 'passed' | 'failed' | 'unchecked';
export const smokeResults: readonly SmokeResult[] = ['passed', 'failed', 'unchecked'];
/** `missing`: a started step the report left out (spec/smoke-run#report). */
export type SmokeStep = { step: string; result: SmokeResult; note?: string; missing?: true };
/** spec/smoke-run#limit: why a run stopped before its report. */
export type SmokeStopCause = 'limit' | 'person';
/** spec/smoke-run#limit: why a run ended without a report. */
export type SmokeDropReason = 'cancelled' | 'no-report';
/** spec/smoke-run#ready: where the screen that can be looked at is. */
export type ReadyWhere = 'simulator' | 'browser';

export const smokeLimits = {
	steps: 12,
	reportSteps: 24,
	step: 120,
	note: 500,
	summary: 2000,
	screen: 80,
	/** spec/smoke-run#limit: `+5 min` on the deck row. */
	extendMinutes: 5,
	maxMinutes: 60,
} as const;
/** spec/smoke-run#limit: Settings ▸ Agents ▸ Reviews ▸ `Smoke run limit`, in minutes. */
export const smokeMinutesLimits = { min: 1, max: 60, step: 1 } as const;
export const defaultSmokeMinutes = 10;
export function isSmokeMinutes(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		Number(value) >= smokeMinutesLimits.min &&
		Number(value) <= smokeMinutesLimits.max
	);
}
export function isSmokeResult(value: unknown): value is SmokeResult {
	return smokeResults.includes(value as SmokeResult);
}
const line = (value: unknown, limit: number) =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
export function isSmokeStep(value: unknown): value is SmokeStep {
	return (
		isRecord(value) &&
		line(value.step, smokeLimits.step) &&
		isSmokeResult(value.result) &&
		(value.note === undefined || line(value.note, smokeLimits.note)) &&
		(value.missing === undefined || (value.missing === true && value.result === 'unchecked'))
	);
}
export function isSmokeStepList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length >= 1 &&
		value.length <= smokeLimits.steps &&
		value.every((item) => line(item, smokeLimits.step))
	);
}

/** spec/smoke-run#data: the task's open or last smoke run, as its journal events tell it. */
export type SmokeRun = {
	id: string;
	steps: string[];
	/** `at` of `smoke.started`, ms since the epoch. */
	startedAt: number;
	limitMs: number;
	state: 'running' | 'stopped' | 'reported' | 'dropped';
	cause?: SmokeStopCause;
	/** `at` of `smoke.stopped`. */
	stoppedAt?: number;
	/** The seq of the event that ended the run's last state. */
	seq: number;
	report?: Extract<SessionEvent, { kind: 'smoke.reported' }>;
	dropped?: SmokeDropReason;
};
const time = (record: EventRecord) => {
	const at = Date.parse(record.at);
	return Number.isFinite(at) ? at : 0;
};
/** spec/smoke-run#data: the newest smoke run of the task, open or ended; null when none started. */
export function smokeRunOf(records: readonly EventRecord[]): SmokeRun | null {
	let run: SmokeRun | null = null;
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'smoke.started') {
			run = {
				id: event.id,
				steps: [...event.steps],
				startedAt: time(record),
				limitMs: event.limitMs,
				state: 'running',
				seq: record.seq,
			};
			continue;
		}
		if (!run || !('id' in event) || event.id !== run.id) continue;
		if (event.kind === 'smoke.extended' && run.state === 'running') {
			run = { ...run, limitMs: event.limitMs, seq: record.seq };
		} else if (event.kind === 'smoke.stopped' && run.state === 'running') {
			run = {
				...run,
				state: 'stopped',
				cause: event.cause,
				stoppedAt: time(record),
				seq: record.seq,
			};
		} else if (
			event.kind === 'smoke.reported' &&
			(run.state === 'running' || run.state === 'stopped')
		)
			run = { ...run, state: 'reported', report: event, seq: record.seq };
		else if (event.kind === 'smoke.dropped' && (run.state === 'running' || run.state === 'stopped'))
			run = { ...run, state: 'dropped', dropped: event.reason, seq: record.seq };
	}
	return run;
}
/** spec/smoke-run#limit: a run that has no report yet and was not dropped. */
export const smokeOpen = (run: SmokeRun | null): run is SmokeRun =>
	!!run && (run.state === 'running' || run.state === 'stopped');
/** spec/smoke-run#limit: from `smoke.stopped` until the report the host refuses the browser and the simulator. */
export const smokeBlocks = (run: SmokeRun | null) => !!run && run.state === 'stopped';
/** spec/smoke-run#deck: ms left of a running run's limit (never below 0). */
export const smokeLeftMs = (run: SmokeRun, now: number) =>
	Math.max(0, run.startedAt + run.limitMs - now);
/** spec/smoke-run#report: started steps matched to reported ones by text; a started step the report leaves out is unchecked. */
export function smokeReportSteps(
	started: readonly string[],
	reported: readonly SmokeStep[]
): SmokeStep[] {
	const key = (text: string) => text.trim().toLowerCase();
	const byKey = new Map(reported.map((item) => [key(item.step), item]));
	const used = new Set<SmokeStep>();
	// The started order first, then the report's own extra steps.
	const ordered = [...new Set(started.map(key))].map((name): SmokeStep => {
		const found = byKey.get(name);
		if (found) {
			used.add(found);
			return found;
		}
		return {
			step: started.find((step) => key(step) === name)!,
			result: 'unchecked',
			missing: true,
		};
	});
	for (const item of reported) if (!used.has(item)) ordered.push(item);
	return ordered.map((item) => ({
		step: item.step.trim(),
		result: item.result,
		...(item.note?.trim() ? { note: item.note.trim() } : {}),
		...(item.missing ? { missing: true as const } : {}),
	}));
}
export function smokeCounts(steps: readonly SmokeStep[]) {
	const failed = steps.filter((item) => item.result === 'failed').length,
		unchecked = steps.filter((item) => item.result === 'unchecked').length;
	return { all: steps.length, checked: steps.length - unchecked, failed, unchecked };
}
/** spec/smoke-run#ready: the same screen again notifies nobody; case and outer spaces do not count. */
export const readyScreenKey = (screen: string) => screen.trim().toLowerCase();
export function readyScreens(records: readonly EventRecord[]): Set<string> {
	const seen = new Set<string>();
	for (const record of records)
		if (record.event.kind === 'task.ready') seen.add(readyScreenKey(record.event.screen));
	return seen;
}
/** spec/smoke-run#review: the newest report of the task, whatever runs started after it. */
export function newestSmokeReport(
	records: readonly EventRecord[]
): Extract<SessionEvent, { kind: 'smoke.reported' }> | null {
	const found = records.findLast((record) => record.event.kind === 'smoke.reported')?.event;
	return found?.kind === 'smoke.reported' ? found : null;
}
/** spec/smoke-run#review: the newest smoke report for a reviewer's prompt (English, rule 12), or the rule for a task with none. */
export function smokeReviewParagraph(records: readonly EventRecord[]): string {
	const report = newestSmokeReport(records);
	if (!report)
		return '\nSmoke run: this task has no smoke report. When this change shows in the running app (a screen, a page, a flow a person goes through), leave one finding at the screen\'s file: "No smoke run checked this change in the running app." Do not raise it for a change that does not show in the app.';
	const ended = report.stopped
		? report.stopped === 'limit'
			? 'stopped at its time limit'
			: 'stopped by the person'
		: 'ended in time';
	const steps = report.steps
		.map(
			(item) =>
				`- [${item.result}] ${item.step}${item.missing ? ' — not in the report' : item.note ? ` — ${item.note}` : ''}`
		)
		.join('\n');
	return `\nSmoke run: the task's newest smoke report (the run ${ended}):\n${steps}\nSummary: ${report.summary}\nA failed step that the change since this report does not fix is a finding, at the line that causes it or at the screen's file. An unchecked step is not a finding by itself.`;
}
