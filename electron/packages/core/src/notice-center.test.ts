import { describe, expect, it } from 'vitest';
import {
	addToastNotice,
	applyNoticeAction,
	groupNotices,
	isNoticeCenterAction,
	isNoticeEntry,
	isToastNotice,
	noticeDay,
	noticeLimit,
	noticeMaxAgeMs,
	pruneNotices,
	readTaskNotices,
	unreadNotices,
	type NoticeEntry,
	type ToastNotice,
} from './notice-center';

const task = { projectId: 'business', id: 'phone' };
const entry = (id: string, at: number, extra: Partial<NoticeEntry> = {}): NoticeEntry => ({
	id,
	at,
	kind: 'turn-ended',
	title: 'Phone validation',
	body: 'The turn ended.',
	target: { kind: 'task', task },
	action: null,
	count: 1,
	read: false,
	...extra,
});
const toast = (extra: Partial<ToastNotice> = {}): ToastNotice => ({
	kind: 'error',
	text: 'Could not send the message.',
	action: 'Retry',
	task,
	title: 'Phone validation',
	read: false,
	...extra,
});

describe('notice center (spec/notifications-slack-notes-and-schedules#notification-center)', () => {
	it('keeps the last 200 entries of the last 7 days, newest first', () => {
		const now = Date.UTC(2026, 9, 29, 12);
		const many = Array.from({ length: 250 }, (_, i) => entry(`e${i}`, now - i * 1000));
		const pruned = pruneNotices([...many, entry('old', now - noticeMaxAgeMs - 1)], now);
		expect(pruned).toHaveLength(noticeLimit);
		expect(pruned[0]!.id).toBe('e0');
		expect(pruned.some((item) => item.id === 'old')).toBe(false);
	});

	it('sorts rows into today, yesterday and earlier by the local day', () => {
		const now = new Date(2026, 9, 29, 9, 0).getTime();
		expect(noticeDay(new Date(2026, 9, 29, 0, 5).getTime(), now)).toBe('today');
		expect(noticeDay(new Date(2026, 9, 28, 23, 50).getTime(), now)).toBe('yesterday');
		expect(noticeDay(new Date(2026, 9, 27, 12).getTime(), now)).toBe('earlier');
		const groups = groupNotices(
			[
				entry('a', new Date(2026, 9, 29, 8).getTime()),
				entry('b', new Date(2026, 9, 28, 8).getTime()),
				entry('c', new Date(2026, 9, 28, 7).getTime()),
			],
			now
		);
		expect(groups.map((group) => [group.day, group.entries.length])).toEqual([
			['today', 1],
			['yesterday', 2],
		]);
	});

	it('folds the same toast within a minute into one row with ×N', () => {
		const now = 1_000_000;
		const first = addToastNotice([], toast(), 't1', now);
		const again = addToastNotice(first.entries, toast(), 't2', now + 30_000);
		expect(again.entries).toHaveLength(1);
		expect(again.entry).toMatchObject({ id: 't1', count: 2, at: now + 30_000 });
		const later = addToastNotice(again.entries, toast(), 't3', now + 120_000);
		expect(later.entries.map((item) => item.id)).toEqual(['t3', 't1']);
		const other = addToastNotice(later.entries, toast({ task: null }), 't4', now + 121_000);
		expect(other.entry.id).toBe('t4');
	});

	it('reads, dismisses and clears; opening a task reads its rows', () => {
		const rows = [entry('a', 3), entry('b', 2, { target: null }), entry('c', 1)];
		expect(unreadNotices(rows)).toBe(3);
		expect(unreadNotices(applyNoticeAction(rows, { kind: 'read', ids: ['a'] }))).toBe(2);
		expect(unreadNotices(applyNoticeAction(rows, { kind: 'read-all' }))).toBe(0);
		expect(applyNoticeAction(rows, { kind: 'dismiss', id: 'b' }).map((r) => r.id)).toEqual([
			'a',
			'c',
		]);
		expect(applyNoticeAction(rows, { kind: 'clear' })).toEqual([]);
		expect(readTaskNotices(rows, task).map((r) => r.read)).toEqual([true, false, true]);
	});

	it('validates what crosses IPC and what comes back from disk', () => {
		expect(isNoticeEntry(entry('a', 1))).toBe(true);
		expect(isNoticeEntry({ ...entry('a', 1), kind: 'nope' })).toBe(false);
		expect(isToastNotice(toast())).toBe(true);
		expect(isToastNotice(toast({ text: '' }))).toBe(false);
		expect(isNoticeCenterAction({ kind: 'read', ids: ['a/b'] })).toBe(true);
		expect(isNoticeCenterAction({ kind: 'answer', id: 'x', option: 'always' })).toBe(false);
		expect(isNoticeCenterAction({ kind: 'open', id: 'x' })).toBe(true);
		expect(isNoticeCenterAction({ kind: 'clear', extra: 1 })).toBe(false);
	});
});
