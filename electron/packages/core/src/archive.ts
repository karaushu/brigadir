import {
	isRecord,
	MAIN_TREE_ID,
	taskStatuses,
	type AgentTask,
	type Project,
	type TaskStatus,
} from './workspace';
import { taskDescendants } from './sidebar';
import type { Locale } from './messages';
import type { TaskKey } from './session';
/**
 * spec/tasks#archive: a task in the archive keeps its status; `status` is the one it had when archived, so Restore puts it
 * back into the same column. `worktree` says what archiving did with the task's worktree.
 */
export type TaskArchive = {
	at: string;
	by: 'manual' | 'auto';
	status: TaskStatus;
	worktree: 'removed' | 'kept' | 'none';
	uncommitted?: number;
};
export function isTaskArchive(value: unknown): value is TaskArchive {
	return (
		isRecord(value) &&
		typeof value.at === 'string' &&
		value.at.length <= 40 &&
		Number.isFinite(Date.parse(value.at)) &&
		(value.by === 'manual' || value.by === 'auto') &&
		taskStatuses.includes(value.status as TaskStatus) &&
		['removed', 'kept', 'none'].includes(value.worktree as string) &&
		(value.uncommitted === undefined ||
			(Number.isSafeInteger(value.uncommitted) && (value.uncommitted as number) >= 0))
	);
}
/** spec/tasks#archive: Settings ▸ Agents ▸ «Archive completed»; null is Never. */
export const archiveAfterDayOptions = [1, 3, 7, 30] as const;
export type ArchiveAfterDays = (typeof archiveAfterDayOptions)[number] | null;
export const defaultArchiveAfterDays: ArchiveAfterDays = 3;
export const isArchiveAfterDays = (value: unknown): value is ArchiveAfterDays =>
	value === null || archiveAfterDayOptions.includes(value as never);
const day = 86_400_000;
/** spec/tasks#archive: the statuses with no agent at work. */
export const archivableStatuses: readonly TaskStatus[] = [
	'done',
	'completed',
	'interrupted',
	'failed',
	'backlog',
];
const busy = (task: AgentTask) => !archivableStatuses.includes(task.status);
/** Whether `task` can go to the archive now: no agent works in it or in any task under it, and it is not waiting to launch. */
export function canArchive(
	task: AgentTask,
	tasks: readonly AgentTask[],
	queued: (key: TaskKey) => boolean = () => false
): boolean {
	if (task.archived || task.id === MAIN_TREE_ID || busy(task) || queued(task)) return false;
	return !taskDescendants(task, tasks).some((item) => busy(item) || queued(item));
}
/** What the sidebar swipe does to a card (spec/tasks#archive-actions): Archive a completed or backlog task, Complete one in progress with no agent at work; null when the swipe does nothing. */
export type SwipeAction = 'archive' | 'complete';
export function swipeAction(
	task: AgentTask,
	tasks: readonly AgentTask[],
	queued: (key: TaskKey) => boolean = () => false
): SwipeAction | null {
	if (!canArchive(task, tasks, queued)) return null;
	return task.status === 'completed' || task.status === 'backlog' ? 'archive' : 'complete';
}
/** Archived tasks the person sees as rows: a worker archived with its foreman lives inside the foreman, newest first. */
export function archivedTasks<T extends AgentTask>(tasks: readonly T[]): T[] {
	const foremen = new Set(
		tasks.filter((task) => task.crew && task.archived).map((task) => `${task.projectId}/${task.id}`)
	);
	return tasks
		.filter(
			(task) =>
				task.archived && !(task.crewTaskId && foremen.has(`${task.projectId}/${task.crewTaskId}`))
		)
		.sort((a, b) => b.archived!.at.localeCompare(a.archived!.at) || a.id.localeCompare(b.id));
}
/** When a completed task goes to the archive by itself; null when auto-archive is off or the task does not qualify. */
export function autoArchiveAt(task: AgentTask, days: ArchiveAfterDays): number | null {
	if (
		days === null ||
		task.archived ||
		task.status !== 'completed' ||
		task.pinned ||
		task.crewTaskId ||
		!task.completedAt
	)
		return null;
	const at = Date.parse(task.completedAt);
	return Number.isFinite(at) ? at + days * day : null;
}
/** spec/tasks#archive: the person's completed, unpinned tasks whose `completedAt` is at least `days` old. */
export function autoArchiveDue(
	tasks: readonly AgentTask[],
	days: ArchiveAfterDays,
	now: number
): AgentTask[] {
	return tasks.filter((task) => {
		const at = autoArchiveAt(task, days);
		return at !== null && at <= now;
	});
}
/** spec/tasks#archive migration: completed tasks from before `completedAt` existed; the first pass stamps them with now. */
export function unstampedCompleted(tasks: readonly AgentTask[]): AgentTask[] {
	return tasks.filter((task) => task.status === 'completed' && !task.completedAt && !task.archived);
}
/** The card clock (spec/tasks#archive): the task leaves for the archive within a day — «today» or «tomorrow» by the calendar. */
export function archiveSoon(
	task: AgentTask,
	days: ArchiveAfterDays,
	now: number
): 'today' | 'tomorrow' | null {
	const at = autoArchiveAt(task, days);
	if (at === null || at - now > day) return null;
	return startOfDay(at) <= startOfDay(now) ? 'today' : 'tomorrow';
}
/** The branch the task works on, for rows and the preview. */
export function taskBranch(task: AgentTask): string | null {
	return task.taskTree?.branch ?? task.worktreeBranch ?? task.launch?.branch ?? null;
}
export type ArchiveFilter = {
	query: string;
	projectId: string | null;
	by: 'manual' | 'auto' | null;
};
/** spec/tasks#archive: archived rows that match title, prompt, branch or project name; one source for the window and Search Everywhere. */
export function archiveSearch<T extends AgentTask>(
	tasks: readonly T[],
	projects: readonly Project[],
	filter: ArchiveFilter,
	locale: Locale = 'en'
): T[] {
	const query = filter.query.trim().toLocaleLowerCase(locale);
	return archivedTasks(tasks).filter(
		(task) =>
			(filter.projectId === null || task.projectId === filter.projectId) &&
			(filter.by === null || task.archived!.by === filter.by) &&
			(!query ||
				[
					task.title,
					task.prompt ?? '',
					taskBranch(task) ?? '',
					projects.find((project) => project.id === task.projectId)?.name ?? '',
				].some((text) => text.toLocaleLowerCase(locale).includes(query)))
	);
}
function startOfDay(at: number) {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
export type ArchiveGroupKey = 'today' | 'week' | `month:${number}-${number}`;
/** spec/tasks#archive: Today, This week (the six days before today), then one group per calendar month, newest first. */
export function archiveGroupKey(at: string, now: number): ArchiveGroupKey {
	const time = Date.parse(at),
		today = startOfDay(now);
	if (time >= today) return 'today';
	if (time >= today - 6 * day) return 'week';
	const date = new Date(time);
	return `month:${date.getFullYear()}-${date.getMonth()}`;
}
export function archiveGroups<T extends AgentTask>(
	tasks: readonly T[],
	now: number
): { key: ArchiveGroupKey; tasks: T[] }[] {
	const groups: { key: ArchiveGroupKey; tasks: T[] }[] = [];
	for (const task of tasks) {
		const key = archiveGroupKey(task.archived!.at, now),
			last = groups.at(-1);
		if (last?.key === key) last.tasks.push(task);
		else groups.push({ key, tasks: [task] });
	}
	return groups;
}
/** A month group's title in the interface language: «Вересень», «September 2025» when not this year. */
export function archiveMonthLabel(
	key: `month:${number}-${number}`,
	locale: Locale,
	now: number
): string {
	const [year, month] = key.slice(6).split('-').map(Number) as [number, number];
	const text = new Intl.DateTimeFormat(locale, {
		month: 'long',
		...(year !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}),
	}).format(new Date(year, month, 1));
	return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}
const forms = (
	locale: Locale,
	count: number,
	en: [string, string],
	uk: Record<'one' | 'few' | 'many' | 'other', string>
) => {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === 'en') return `${number} ${count === 1 ? en[0] : en[1]}`;
	const form = new Intl.PluralRules('uk').select(count) as 'one' | 'few' | 'many' | 'other';
	return `${number} ${uk[form] ?? uk.other}`;
};
/** `2 дні`, `9 днів` — the age column of a sidebar archive row (spec/tasks#archive); under a day «сьогодні». */
export function archiveAge(locale: Locale, at: string, now: number): string {
	const days = Math.round((startOfDay(now) - startOfDay(Date.parse(at))) / day);
	if (days <= 0) return locale === 'uk' ? 'сьогодні' : 'today';
	return forms(locale, days, ['day', 'days'], {
		one: 'день',
		few: 'дні',
		many: 'днів',
		other: 'дня',
	});
}
/** `7 днів`, `1 день` — the auto-archive term in the window footer (spec/tasks#archive). */
export function archiveDays(locale: Locale, count: number): string {
	return forms(locale, count, ['day', 'days'], {
		one: 'день',
		few: 'дні',
		many: 'днів',
		other: 'дня',
	});
}
/** `вчора`, `3 дні тому`, `9 вересня` — when, in the window rows and the preview (spec/tasks#archive). */
export function archiveWhen(locale: Locale, at: string, now: number): string {
	const days = Math.round((startOfDay(now) - startOfDay(Date.parse(at))) / day);
	if (days <= 0) return locale === 'uk' ? 'сьогодні' : 'today';
	if (days === 1) return locale === 'uk' ? 'вчора' : 'yesterday';
	if (days < 7)
		return `${forms(locale, days, ['day', 'days'], { one: 'день', few: 'дні', many: 'днів', other: 'дня' })} ${locale === 'uk' ? 'тому' : 'ago'}`;
	const date = new Date(Date.parse(at));
	return new Intl.DateTimeFormat(locale, {
		day: 'numeric',
		month: 'long',
		...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}),
	}).format(date);
}
/** `Видалити 3 задачі з архіву?` — the window's delete dialog title (spec/tasks#archive), four uk forms. */
export function archiveDeleteTitle(locale: Locale, count: number): string {
	if (locale === 'en')
		return count === 1
			? 'Delete the task from the archive?'
			: `Delete ${count} tasks from the archive?`;
	const form = new Intl.PluralRules('uk').select(count) as 'one' | 'few' | 'many' | 'other';
	return `Видалити ${new Intl.NumberFormat('uk').format(count)} ${{ one: 'задачу', few: 'задачі', many: 'задач', other: 'задачі' }[form] ?? 'задачі'} з архіву?`;
}
/** «Worktree лишився: 3 незакомічені файли.» (spec/tasks#archive). */
export function keptWorktreeLabel(locale: Locale, count: number): string {
	if (locale === 'en')
		return `The worktree stays: ${count} uncommitted ${count === 1 ? 'file' : 'files'}.`;
	const form = new Intl.PluralRules('uk').select(count) as 'one' | 'few' | 'many' | 'other';
	return `Worktree лишився: ${new Intl.NumberFormat('uk').format(count)} ${{ one: 'незакомічений файл', few: 'незакомічені файли', many: 'незакомічених файлів', other: 'незакоміченого файла' }[form]}.`;
}
