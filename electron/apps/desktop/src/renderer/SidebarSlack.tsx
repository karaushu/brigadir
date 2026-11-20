import { useState, type ReactNode } from 'react';
import {
	dayKey,
	slackInboxCount,
	slackMentionMatches,
	slackPlain,
	slackRecentMentions,
	t,
	type Locale,
	type MessageKey,
	type SlackInboxTarget,
	type SlackInboxView,
	type SlackMentionRow,
} from '@brigadir/core';
import { SearchField } from './ui/PanelSearch';
import { IconButton } from './ui/Controls';
import { Avatar } from './ui/Avatar';
import { Glyph, type GlyphName } from './ui/Glyph';
import { SkeletonRows } from './ui/Loading';
import { toastError } from './ui/Toast';
import { SidebarGroup } from './SidebarGroup';
import { slackDayLabel, slackMonthLabel, slackRowTime, slackWeekLabel } from './slack-inbox-data';
import styles from './App.module.css';
import s from './SlackInbox.module.css';

/** spec/todo-and-slack-inbox#slack-inbox-entry: a mention's badge — amber dot Waiting, green tick Answered, none FYI. */
export const slackBadge = (status: SlackMentionRow['status']) =>
	status === 'waiting' ? 'waiting' : status === 'answered' ? 'answered' : null;
/** The first word of a name: `Olena Kovalenko` → `Olena`. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
/** `5 mentions · 2 waiting`, `6 mentions · all answered`, `32 mentions`. */
export function slackCounts(locale: Locale, mentions: number, waiting: number, past: boolean) {
	const head = slackInboxCount(locale, 'mention', mentions).text;
	if (!mentions) return head;
	if (waiting) return `${head} · ${slackInboxCount(locale, 'waiting', waiting).text}`;
	return past ? head : `${head} · ${t(locale, 'all answered')}`;
}

/**
 * spec/todo-and-slack-inbox#slack-inbox-entry: the Slack section's list in the shared list look (rule 17) — `Filter mentions` and `Refresh`, then
 * `Mentions` (the last 7 days), `Days`, `Weeks` and `In the archive` (one row per month, folded).
 */
export function SidebarSlack({
	locale,
	view,
	selected,
	onOpen,
}: {
	locale: Locale;
	view: SlackInboxView | null;
	selected: SlackInboxTarget | null;
	onOpen(target: SlackInboxTarget | null): void;
}) {
	const [query, setQuery] = useState(''),
		[collapsed, setCollapsed] = useState<string[]>(['In the archive']),
		[refreshing, setRefreshing] = useState(false);
	const now = Date.now(),
		today = dayKey(now),
		people = view?.people ?? {},
		name = (id: string) => people[id] ?? id;
	const open = selected ?? { kind: 'day', day: today };
	const group = (title: MessageKey, glyph: GlyphName, count: number, rows: ReactNode) => {
		const shut = collapsed.includes(title);
		return (
			<SidebarGroup
				locale={locale}
				name={t(locale, title)}
				glyph={glyph}
				count={count}
				shut={shut}
				data-slack-group={title}
				onFold={() =>
					setCollapsed((list) => (shut ? list.filter((item) => item !== title) : [...list, title]))
				}>
				{rows}
			</SidebarGroup>
		);
	};
	const refresh = async () => {
		setRefreshing(true);
		try {
			await window.brigadir.refreshSlackInbox(selected);
		} catch {
			toastError(t(locale, 'Could not read Slack.'));
		} finally {
			setRefreshing(false);
		}
	};
	const mentions = view
		? slackRecentMentions(view.mentions, now).filter((mention) =>
				slackMentionMatches(mention, name(mention.author), query)
			)
		: [];
	const row = (
		key: string,
		target: SlackInboxTarget,
		pressed: boolean,
		lead: ReactNode,
		title: ReactNode,
		line: ReactNode,
		time?: string
	) => (
		<button
			key={key}
			className={`${styles.task} ${s.row}`}
			data-slack-row={key}
			aria-pressed={pressed}
			onClick={() => onOpen(target)}>
			{lead}
			<span className={styles.taskCopy}>
				<span className={styles.taskHead}>
					<span className={styles.taskTitle}>{title}</span>
					{time && <small className={s.rowTime}>{time}</small>}
				</span>
				<small className={styles.prLine}>{line}</small>
			</span>
		</button>
	);
	return (
		<>
			<div className={styles.taskFilter} data-size="l">
				<SearchField
					className={styles.taskFilterField}
					locale={locale}
					label={t(locale, 'Filter mentions')}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && query) {
							event.preventDefault();
							setQuery('');
						}
					}}
				/>
				<IconButton
					label={t(locale, 'Refresh')}
					disabled={!view?.connected || refreshing}
					onClick={() => void refresh()}
					data-slack-refresh>
					<Glyph name="refresh" size={14} />
				</IconButton>
			</div>
			<div data-sidebar-list data-sidebar-slack className={styles.projectList}>
				{!view ? (
					<SkeletonRows count={4} height={46} />
				) : !view.connected && !view.mentions.length ? null : (
					<>
						{group(
							'Mentions',
							'slack',
							mentions.length,
							mentions.map((mention) =>
								row(
									mention.id,
									{ kind: 'mention', id: mention.id },
									open.kind === 'mention' && open.id === mention.id,
									<Avatar
										login={mention.author}
										name={name(mention.author)}
										size="xl"
										badge={slackBadge(mention.status)}
									/>,
									<>
										{firstName(name(mention.author))}
										<span className={s.where}>
											{' · '}
											{mention.dm
												? t(locale, 'Direct message (mention)')
												: `#${mention.channelName ?? mention.channel}`}
										</span>
									</>,
									mention.agent?.summary ?? slackPlain(mention.text).split('\n')[0],
									slackRowTime(locale, mention.ts, now)
								)
							)
						)}
						{!query.trim() &&
							group(
								'Days',
								'schedule',
								view.days.length,
								view.days.map((day) =>
									row(
										day.day,
										{ kind: 'day', day: day.day },
										open.kind === 'day' && open.day === day.day,
										<span className={styles.noteGlyph}>
											<Glyph name="schedule" size={14} />
										</span>,
										slackDayLabel(locale, day.day, now),
										slackCounts(locale, day.mentions, day.waiting, false)
									)
								)
							)}
						{!query.trim() &&
							group(
								'Weeks',
								'list',
								view.weeks.length,
								view.weeks.map((week, index) =>
									row(
										week.week,
										{ kind: 'week', week: week.week },
										open.kind === 'week' && open.week === week.week,
										<span className={styles.noteGlyph}>
											<Glyph name="list" size={14} />
										</span>,
										slackWeekLabel(locale, week, now),
										slackCounts(locale, week.mentions, week.waiting, index > 0)
									)
								)
							)}
						{!query.trim() &&
							view.archive.length > 0 &&
							group(
								'In the archive',
								'archive-box',
								view.archive.length,
								view.archive.map((month) =>
									row(
										month.month,
										{ kind: 'month', month: month.month },
										open.kind === 'month' && open.month === month.month,
										<span className={styles.noteGlyph}>
											<Glyph name="archive-box" size={14} />
										</span>,
										slackMonthLabel(locale, month.month),
										slackInboxCount(locale, 'mention', month.mentions).text
									)
								)
							)}
						{query.trim() && !mentions.length && (
							<p className={styles.muted}>{t(locale, 'No matches')}</p>
						)}
					</>
				)}
			</div>
		</>
	);
}
