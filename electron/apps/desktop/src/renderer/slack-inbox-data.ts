import { useEffect, useState } from 'react';
import {
	addDays,
	dayKey,
	dayStart,
	slackTsMs,
	t,
	weekKey,
	type Locale,
	type SlackInboxView,
	type SlackWeekRow,
} from '@brigadir/core';

/** spec/todo-and-slack-inbox#slack-inbox: the Slack section's view, kept in step with main by `slack-inbox:changed`; `null` while it loads. */
export function useSlackInbox(on: boolean) {
	const [view, setView] = useState<SlackInboxView | null>(null),
		[error, setError] = useState(false);
	useEffect(() => {
		if (!on) {
			setView(null);
			return;
		}
		let active = true;
		const off = window.brigadir.onSlackInbox((value) => {
			setView(value);
			setError(false);
		});
		void window.brigadir.readSlackInbox().then(
			(value) => active && setView(value),
			() => active && setError(true)
		);
		return () => {
			active = false;
			off();
		};
	}, [on]);
	return { view, error };
}

const at = (day: string) => new Date(dayStart(day) + 12 * 3_600_000);
/** `Thursday, Nov 20` — a day in full. */
export function slackDayName(locale: Locale, day: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		month: 'short',
		day: 'numeric',
	}).format(at(day));
}
/** spec/todo-and-slack-inbox#slack-inbox-entry: `Today`, `Yesterday`, then weekdays and dates. */
export function slackDayLabel(locale: Locale, day: string, now = Date.now()): string {
	const today = dayKey(now);
	if (day === today) return t(locale, 'Today');
	if (day === addDays(today, -1)) return t(locale, 'Yesterday');
	return slackDayName(locale, day);
}
/** `Nov 10–16`, `Oct 27 – Nov 2`. */
export function slackRange(locale: Locale, from: string, to: string): string {
	const format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
	return format.formatRange(at(from), at(to)).replace(/\s*–\s*/, '–');
}
/** spec/todo-and-slack-inbox#slack-inbox-entry: `This week`, `Last week`, then `Nov 10–16`. */
export function slackWeekLabel(locale: Locale, week: SlackWeekRow, now = Date.now()): string {
	const current = weekKey(dayKey(now));
	if (week.week === current) return t(locale, 'This week (row)');
	if (week.week === weekKey(addDays(dayKey(now), -7))) return t(locale, 'Last week');
	return slackRange(locale, week.from, week.to);
}
export function slackMonthLabel(locale: Locale, month: string): string {
	const [year, number] = month.split('-').map(Number) as [number, number];
	return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
		new Date(year, number - 1, 15)
	);
}
/** `14:20`. */
export function slackClock(locale: Locale, ts: string): string {
	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(new Date(slackTsMs(ts)));
}
/** A row's time: today the clock, then `Yesterday`, then the date. */
export function slackRowTime(locale: Locale, ts: string, now = Date.now()): string {
	const day = dayKey(slackTsMs(ts)),
		today = dayKey(now);
	if (day === today) return slackClock(locale, ts);
	if (day === addDays(today, -1)) return t(locale, 'Yesterday');
	return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at(day));
}
/** `By Friday, Nov 21`. */
export function slackDue(locale: Locale, due: string): string {
	return t(locale, 'By {date}').replace('{date}', slackDayName(locale, due));
}
