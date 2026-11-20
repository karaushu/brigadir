import type { ChangedFile } from './changes';
import type { EventRecord, SessionEvent } from './session';
import { isRecord } from './workspace';
import { defaultSmokeMinutes, isSmokeMinutes } from './smoke';
/**
 * spec/reviews#classes: the task's class — what the agent states before its first edit, what the host raises, and the tripwire's size of a
 * small task. Pure: the host decides with these, the chat draws them.
 */

export const taskClasses = ['small', 'medium', 'large'] as const;
export type TaskClass = (typeof taskClasses)[number];
export const isTaskClass = (value: unknown): value is TaskClass =>
	taskClasses.includes(value as TaskClass);
/** The class's name in the catalog. */
export const taskClassLabel = {
	small: 'Small (class)',
	medium: 'Medium (class)',
	large: 'Large (class)',
} as const satisfies Record<TaskClass, string>;
/** spec/reviews#class-row: what a class adds, after its reason in the chat row. */
export function taskClassAdds(value: TaskClass, auto: boolean) {
	if (value === 'small') return 'review before PR' as const;
	if (value === 'medium') return 'plan · plan review' as const;
	return auto ? ('plan · reviews · workers' as const) : ('plan · reviews' as const);
}
/** spec/reviews#class-raise: why the host raised the class. */
export type TaskClassCause = 'threshold' | 'hire';
/** spec/reviews#class-tool: the agent's one line on why, shown in the chat row. */
export const taskClassReasonLimit = 200;
const rank: Record<TaskClass, number> = { small: 0, medium: 1, large: 2 };
export const classBelow = (a: TaskClass, b: TaskClass) => rank[a] < rank[b];

/** spec/reviews#tripwire: files and changed lines past which a small task gets a mid-task review. */
export type SmallTaskLimit = { files: number; lines: number };
export const smallTaskLimits = {
	files: { min: 1, max: 500, step: 1 },
	lines: { min: 10, max: 20_000, step: 10 },
} as const;
export const defaultSmallTaskLimit: SmallTaskLimit = { files: 15, lines: 300 };
const within = (value: unknown, limits: { min: number; max: number }) =>
	Number.isSafeInteger(value) && Number(value) >= limits.min && Number(value) <= limits.max;
export function isSmallTaskLimit(value: unknown): value is SmallTaskLimit {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		within(value.files, smallTaskLimits.files) &&
		within(value.lines, smallTaskLimits.lines)
	);
}
/** spec/settings-modules-and-onboarding#settings-keys: Settings ▸ Agents ▸ Reviews; `smokeMinutes` — spec/smoke-run#limit. */
export type ReviewSettings = { smallTask: SmallTaskLimit; smokeMinutes: number };
export const defaultReviewSettings: ReviewSettings = {
	smallTask: { ...defaultSmallTaskLimit },
	smokeMinutes: defaultSmokeMinutes,
};
export function isReviewSettings(value: unknown): value is ReviewSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		isSmallTaskLimit(value.smallTask) &&
		isSmokeMinutes(value.smokeMinutes)
	);
}
/** spec/settings-modules-and-onboarding#settings-keys: a `reviews` object written before `smokeMinutes` reads it as the default. */
export function withReviewDefaults(value: unknown): unknown {
	return isRecord(value) && !('smokeMinutes' in value)
		? { ...value, smokeMinutes: defaultSmokeMinutes }
		: value;
}
/** spec/smoke-run#limit: the limit a task's host reads from `settings.json`'s `settings` object at `smoke_start`. */
export function smokeMinutesOf(settings: unknown): number {
	const reviews = isRecord(settings) ? withReviewDefaults(settings.reviews) : null;
	return isReviewSettings(reviews) ? reviews.smokeMinutes : defaultSmokeMinutes;
}
/** The limit a task's host reads from `settings.json`'s `settings` object; a missing or broken one reads as the default. */
export function smallTaskLimitOf(settings: unknown): SmallTaskLimit {
	const reviews = isRecord(settings) ? withReviewDefaults(settings.reviews) : null;
	return isReviewSettings(reviews) ? { ...reviews.smallTask } : { ...defaultSmallTaskLimit };
}

/** spec/reviews#tripwire: the size of a change as the tripwire counts it — no generated files, binaries or submodule pointers. */
export function changeSize(files: readonly ChangedFile[]): { files: number; lines: number } {
	const counted = files.filter((file) => !file.generated && !file.binary && !file.gitlink);
	return {
		files: counted.length,
		lines: counted.reduce((sum, file) => sum + file.additions + file.deletions, 0),
	};
}
export const overSmallTask = (size: { files: number; lines: number }, limit: SmallTaskLimit) =>
	size.files > limit.files || size.lines > limit.lines;

/** spec/reviews#classes: the newest class of the task, or null when none was stated or raised. */
export function taskClassOf(records: readonly EventRecord[]): TaskClass | null {
	const last = records.findLast((record) => record.event.kind === 'task.class')?.event;
	return last?.kind === 'task.class' ? last.class : null;
}
/** spec/reviews#tripwire: fired once per task — its raise or its review's start is in the journal. */
export function tripwireFired(records: readonly EventRecord[]): boolean {
	return records.some(
		(record) =>
			(record.event.kind === 'task.class' && record.event.cause === 'threshold') ||
			(record.event.kind === 'task-review.started' && !!record.event.threshold)
	);
}
/** spec/reviews#tripwire: the tripwire watches a task while its class is Small or none, until it fires. */
export const tripwireArmed = (records: readonly EventRecord[]) => {
	const current = taskClassOf(records);
	return (current === null || current === 'small') && !tripwireFired(records);
};
/** The newest approved hire that started a worker. */
export const newestHire = (records: readonly EventRecord[]) =>
	records.findLast(
		(record) =>
			record.event.kind === 'crew.hire.resolved' &&
			record.event.approved &&
			record.event.hired.length > 0
	);
/**
 * spec/reviews#class-raise: what a host that stopped mid-way still owes the class — the tripwire's raise after its review started, and the
 * hire's raise after an approved hire.
 */
export function owedRaise(
	records: readonly EventRecord[]
): Extract<SessionEvent, { kind: 'task.class' }> | null {
	const current = taskClassOf(records);
	const started = records.find(
		(record) => record.event.kind === 'task-review.started' && !!record.event.threshold
	)?.event;
	const raised = records.some(
		(record) => record.event.kind === 'task.class' && record.event.cause === 'threshold'
	);
	if (started?.kind === 'task-review.started' && started.threshold && !raised)
		return {
			kind: 'task.class',
			class: 'medium',
			reason: '',
			by: 'host',
			...(current ? { previous: current } : {}),
			cause: 'threshold',
			files: started.threshold.files,
			lines: started.threshold.lines,
		};
	const hire = newestHire(records);
	if (
		hire &&
		current !== 'large' &&
		!records.some(
			(record) =>
				// Any class after the hire settled it: the raise, or the agent's own class once its workers were gone.
				record.seq > hire.seq && record.event.kind === 'task.class'
		)
	)
		return {
			kind: 'task.class',
			class: 'large',
			reason: '',
			by: 'host',
			...(current ? { previous: current } : {}),
			cause: 'hire',
		};
	return null;
}
/** Workers hired by the task that are not dismissed yet. */
export function runningHires(records: readonly EventRecord[]): string[] {
	const hired = new Set<string>(),
		dismissed = new Set<string>();
	for (const { event } of records) {
		if (event.kind === 'crew.hire.resolved' && event.approved)
			for (const item of event.hired) hired.add(item.taskId);
		if (event.kind === 'crew.worker.dismissed') dismissed.add(event.taskId);
	}
	return [...hired].filter((id) => !dismissed.has(id));
}
/**
 * spec/reviews#large-review: the hired parts are back — no worker runs, a part was accepted since the newest approved hire, and no mid-task
 * review started since that hire.
 */
export function hiredPartsBack(records: readonly EventRecord[]): boolean {
	const hire = newestHire(records);
	if (!hire || runningHires(records).length) return false;
	const after = records.filter((record) => record.seq > hire.seq);
	return (
		after.some(
			(record) =>
				record.event.kind === 'crew.worker.dismissed' && record.event.reason === 'accepted'
		) &&
		!after.some(
			(record) => record.event.kind === 'task-review.started' && record.event.point === 'mid'
		)
	);
}
