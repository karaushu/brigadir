import { isTaskKey, type TaskKey } from './session';
import { isRecord } from './workspace';
import { isCIWatch, type CIWatch } from './pull-requests';

/**
 * spec/notifications-slack-notes-and-schedules#notification-center: the notification center — what reached the person while they were not looking, kept on disk, and who waits
 * for them now. History rows come from what a system notification says (any «When», any permission), a CI run that
 * finished and a toast with an error, a warning or an action; live rows («Needs you») are rebuilt from pending inputs.
 */
export type NoticeEntryKind =
	| 'turn-ended'
	| 'background'
	| 'failed'
	| 'rate-limited'
	| 'scope-violation'
	| 'ci-pass'
	| 'ci-fail'
	| 'ci-cancelled'
	/** «Needs you» events (spec/notifications-slack-notes-and-schedules#notification-center): a request is history too. */
	| 'question'
	| 'permission'
	| 'plan'
	| 'proposal'
	| 'worker'
	/** A page's notification in the task's browser (spec/browser-and-simulator#notifications). */
	| 'page'
	| 'error'
	| 'warning'
	| 'info'
	| 'success';
export const noticeEntryKinds: readonly NoticeEntryKind[] = [
	'turn-ended',
	'background',
	'failed',
	'rate-limited',
	'scope-violation',
	'ci-pass',
	'ci-fail',
	'ci-cancelled',
	'question',
	'permission',
	'plan',
	'proposal',
	'worker',
	'page',
	'error',
	'warning',
	'info',
	'success',
];
/** What a history row does: opens its task or its run; a toast's own action lives only as long as the window's toast. */
export type NoticeTarget = { kind: 'task'; task: TaskKey } | { kind: 'run'; watch: CIWatch };
export type NoticeEntry = {
	id: string;
	/** Epoch ms of the last time it happened. */ at: number;
	kind: NoticeEntryKind;
	/** Line 1: the task's title, as the system banner's title; a run's «CI #413 failed». */ title: string;
	/** Line 2: the banner's body or the toast's text. */ body: string;
	target: NoticeTarget | null;
	/** A toast's action label («Retry»); the action runs only while the toast that gave it is alive. */ action:
		string | null;
	/** The same toast again: ×N, like the toast's own counter. */ count: number;
	read: boolean;
};
/** A live request: line 1 the task, line 2 what it waits for; actions as on the system banner (spec/notifications-slack-notes-and-schedules#macos-permission). */
/** `schedule` (spec/notifications-slack-notes-and-schedules#schedules): missed slots of a schedule with «If missed: Ask» — Run once or Skip; `task` names the schedule. */
export type PendingNoticeKind =
	'question' | 'permission' | 'plan' | 'proposal' | 'worker' | 'schedule';
export type PendingNotice = {
	id: string;
	at: number;
	kind: PendingNoticeKind;
	task: TaskKey;
	title: string;
	body: string;
	/** `allow_once` / `reject_once` option ids of a permission; null when the request has none. */ allow:
		string | null;
	deny: string | null;
	/** A schedule's request, not a task's: Open goes to the Schedules section. */ schedule?: true;
};
export type NoticeCenter = { entries: NoticeEntry[]; pending: PendingNotice[] };
/** A toast the window hands to main (spec/notifications-slack-notes-and-schedules#notification-center). */
export type ToastNotice = {
	kind: 'error' | 'warning' | 'info' | 'success';
	text: string;
	action: string | null;
	task: TaskKey | null;
	title: string | null;
	read: boolean;
};
export type NoticeCenterAction =
	| { kind: 'read'; ids: string[] }
	| { kind: 'read-all' }
	| { kind: 'dismiss'; id: string }
	| { kind: 'clear' }
	/** A row's task or run — main reads the row and brings the window to it (spec/notifications-slack-notes-and-schedules#notification-center). */
	| { kind: 'open'; id: string }
	| { kind: 'answer'; id: string; option: 'allow' | 'deny' };

/** spec/notifications-slack-notes-and-schedules#notification-center: the last 200 entries, none older than 7 days. */
export const noticeLimit = 200;
export const noticeMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const textMax = 2000;

export function pruneNotices(entries: readonly NoticeEntry[], now: number): NoticeEntry[] {
	return entries
		.filter((entry) => now - entry.at <= noticeMaxAgeMs)
		.sort((a, b) => b.at - a.at)
		.slice(0, noticeLimit);
}
export function unreadNotices(entries: readonly NoticeEntry[]) {
	return entries.filter((entry) => !entry.read).length;
}
/** The popover's sections: Today, Yesterday, Earlier — by the person's local day. */
export type NoticeDay = 'today' | 'yesterday' | 'earlier';
export function noticeDay(at: number, now: number): NoticeDay {
	const day = (time: number) => {
		const date = new Date(time);
		return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	};
	const today = day(now),
		that = day(at);
	if (that >= today) return 'today';
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	return that >= yesterday.getTime() ? 'yesterday' : 'earlier';
}
export function groupNotices(entries: readonly NoticeEntry[], now: number) {
	const groups: { day: NoticeDay; entries: NoticeEntry[] }[] = [];
	for (const entry of entries) {
		const day = noticeDay(entry.at, now),
			last = groups.at(-1);
		if (last?.day === day) last.entries.push(entry);
		else groups.push({ day, entries: [entry] });
	}
	return groups;
}
/**
 * A toast seen again within a minute is one row with ×N, as the toast itself coalesces (spec/notifications-slack-notes-and-schedules#message-classes); a new one goes on top.
 * Returns the entries and the row that took it.
 */
export function addToastNotice(
	entries: readonly NoticeEntry[],
	toast: ToastNotice,
	id: string,
	now: number
): { entries: NoticeEntry[]; entry: NoticeEntry } {
	const same = entries.find(
		(entry) =>
			entry.kind === toast.kind &&
			entry.body === toast.text &&
			now - entry.at < 60_000 &&
			sameTarget(entry.target, toast.task)
	);
	if (same) {
		const entry = {
			...same,
			at: now,
			count: same.count + 1,
			action: toast.action,
			read: same.read && toast.read,
		};
		return {
			entries: pruneNotices(
				entries.map((item) => (item === same ? entry : item)),
				now
			),
			entry,
		};
	}
	const entry: NoticeEntry = {
		id,
		at: now,
		kind: toast.kind,
		title: toast.title ?? '',
		body: toast.text,
		target: toast.task ? { kind: 'task', task: toast.task } : null,
		action: toast.action,
		count: 1,
		read: toast.read,
	};
	return { entries: pruneNotices([entry, ...entries], now), entry };
}
function sameTarget(target: NoticeTarget | null, task: TaskKey | null) {
	if (!target || !task) return !target && !task;
	return (
		target.kind === 'task' && target.task.projectId === task.projectId && target.task.id === task.id
	);
}
/** The center's own state changes: reading, dismissing a row, clearing the history. */
export function applyNoticeAction(
	entries: readonly NoticeEntry[],
	action: Exclude<NoticeCenterAction, { kind: 'answer' } | { kind: 'open' }>
): NoticeEntry[] {
	switch (action.kind) {
		case 'read':
			return entries.map((entry) =>
				action.ids.includes(entry.id) && !entry.read ? { ...entry, read: true } : entry
			);
		case 'read-all':
			return entries.map((entry) => (entry.read ? entry : { ...entry, read: true }));
		case 'dismiss':
			return entries.filter((entry) => entry.id !== action.id);
		case 'clear':
			return [];
	}
}
/** Opening a task reads its rows (spec/notifications-slack-notes-and-schedules#notification-center). */
export function readTaskNotices(entries: readonly NoticeEntry[], task: TaskKey) {
	return entries.map((entry) =>
		!entry.read &&
		entry.target?.kind === 'task' &&
		entry.target.task.projectId === task.projectId &&
		entry.target.task.id === task.id
			? { ...entry, read: true }
			: entry
	);
}

const isText = (value: unknown, max = textMax) => typeof value === 'string' && value.length <= max;
const isNoticeId = (value: unknown) =>
	typeof value === 'string' && /^[A-Za-z0-9._:/%-]{1,300}$/.test(value);
export function isNoticeTarget(value: unknown): value is NoticeTarget {
	if (!isRecord(value)) return false;
	if (value.kind === 'task') return Object.keys(value).length === 2 && isTaskKey(value.task);
	if (value.kind === 'run') return Object.keys(value).length === 2 && isCIWatch(value.watch);
	return false;
}
export function isNoticeEntry(value: unknown): value is NoticeEntry {
	return (
		isRecord(value) &&
		Object.keys(value).length === 9 &&
		isNoticeId(value.id) &&
		Number.isSafeInteger(value.at) &&
		noticeEntryKinds.includes(value.kind as NoticeEntryKind) &&
		isText(value.title) &&
		isText(value.body) &&
		(value.target === null || isNoticeTarget(value.target)) &&
		(value.action === null || isText(value.action, 80)) &&
		Number.isSafeInteger(value.count) &&
		(value.count as number) >= 1 &&
		typeof value.read === 'boolean'
	);
}
export function isToastNotice(value: unknown): value is ToastNotice {
	return (
		isRecord(value) &&
		Object.keys(value).length === 6 &&
		['error', 'warning', 'info', 'success'].includes(value.kind as string) &&
		isText(value.text) &&
		(value.text as string).length > 0 &&
		(value.action === null || isText(value.action, 80)) &&
		(value.task === null || isTaskKey(value.task)) &&
		(value.title === null || isText(value.title, 500)) &&
		typeof value.read === 'boolean'
	);
}
export function isNoticeCenterAction(value: unknown): value is NoticeCenterAction {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'read':
			return (
				Object.keys(value).length === 2 &&
				Array.isArray(value.ids) &&
				value.ids.length <= noticeLimit &&
				value.ids.every(isNoticeId)
			);
		case 'read-all':
		case 'clear':
			return Object.keys(value).length === 1;
		case 'dismiss':
		case 'open':
			return Object.keys(value).length === 2 && isNoticeId(value.id);
		case 'answer':
			return (
				Object.keys(value).length === 3 &&
				isNoticeId(value.id) &&
				(value.option === 'allow' || value.option === 'deny')
			);
		default:
			return false;
	}
}
