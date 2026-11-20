import { useEffect, useState, type ReactNode } from 'react';
import {
	dayKey,
	slackInboxCount,
	slackPlain,
	slackTextPieces,
	slackTsMs,
	weekDays,
	t,
	type Locale,
	type SlackDayRow,
	type SlackInboxTarget,
	type SlackInboxView,
	type SlackMentionRow,
	type SlackTodoRef,
	type SlackWeekRow,
} from '@brigadir/core';
import { Button } from './ui/Controls';
import { Avatar } from './ui/Avatar';
import { ChatCardChip } from './ui/ChatCard';
import { Glyph } from './ui/Glyph';
import { EmptyState } from './ui/EmptyState';
import { Spinner, SkeletonText } from './ui/Loading';
import { Tag } from './ui/Tag';
import { notify, toastError } from './ui/Toast';
import { useWorkspace } from './store';
import { firstName, slackBadge, slackCounts } from './SidebarSlack';
import {
	slackClock,
	slackDayLabel,
	slackDayName,
	slackDue,
	slackMonthLabel,
	slackRange,
	slackWeekLabel,
} from './slack-inbox-data';
import n from './BrigadirChat.module.css';
import s from './SlackInbox.module.css';

/** spec/todo-and-slack-inbox#slack-inbox-to-todo: `b2c › Release 1.15`; a list without a project is `No project › …`. */
const targetText = (locale: Locale, project: string | null, list: string) =>
	`${project ?? t(locale, 'No project')} › ${list}`;
const statusTag = (locale: Locale, status: SlackMentionRow['status']) =>
	status === 'waiting' ? (
		<Tag tone="amber">{t(locale, 'Waiting')}</Tag>
	) : status === 'answered' ? (
		<Tag tone="green">{t(locale, 'Answered')}</Tag>
	) : (
		<Tag>{t(locale, 'FYI')}</Tag>
	);

/**
 * spec/todo-and-slack-inbox#slack-inbox-entry: the Slack section's screen — the open day (Today by default), week, mention or archive month; with no
 * user token, `Connect your Slack account`.
 */
export function SlackInboxScreen({
	locale,
	view,
	error,
	target,
	onOpen,
	onOpenSettings,
}: {
	locale: Locale;
	view: SlackInboxView | null;
	error: boolean;
	target: SlackInboxTarget | null;
	onOpen(target: SlackInboxTarget | null): void;
	onOpenSettings(): void;
}) {
	const now = Date.now(),
		open = target ?? { kind: 'day' as const, day: dayKey(now) },
		[refreshing, setRefreshing] = useState(false);
	const refresh = async () => {
		setRefreshing(true);
		try {
			await window.brigadir.refreshSlackInbox(target);
		} catch {
			toastError(t(locale, 'Could not read Slack.'));
		} finally {
			setRefreshing(false);
		}
	};
	const people = view?.people ?? {},
		name = (id: string) => people[id] ?? id;
	const refreshButton = (
		<Button
			size="m"
			variant="ghost"
			disabled={refreshing || !view?.connected}
			onClick={() => void refresh()}
			data-slack-refresh-screen>
			<Glyph name="refresh" size={13} />
			{t(locale, 'Refresh')}
		</Button>
	);
	let head: ReactNode, body: ReactNode;
	if (!view) {
		head = (
			<>
				<Glyph name="slack" size={16} />
				<strong>{t(locale, 'Slack (section)')}</strong>
			</>
		);
		body = error ? (
			<div className={n.empty}>
				<h2>{t(locale, 'Could not read Slack.')}</h2>
			</div>
		) : (
			<div className={s.column}>
				<SkeletonText lines={4} />
			</div>
		);
	} else if (!view.connected && !view.mentions.length && !view.archive.length) {
		// spec/todo-and-slack-inbox#slack-inbox-entry: no user token — the Slack glyph, the title, two ways to connect.
		head = (
			<>
				<Glyph name="slack" size={16} />
				<strong>{t(locale, 'Slack (section)')}</strong>
			</>
		);
		body = (
			<EmptyState glyph="slack" title={t(locale, 'Connect your Slack account')}>
				<Button
					appearance="primary"
					onClick={() =>
						useWorkspace
							.getState()
							.openBrigadir(null, t(locale, 'Connect my Slack account for mentions'))
					}
					data-slack-brigadir>
					<Glyph name="helmet-chat" size={13} />
					{t(locale, 'Set up with Brigadir')}
				</Button>
				<Button onClick={onOpenSettings} data-slack-settings>
					{t(locale, 'Open Slack settings')}
				</Button>
			</EmptyState>
		);
	} else if (open.kind === 'mention') {
		const mention = view.mentions.find((item) => item.id === open.id);
		if (!mention) {
			head = (
				<>
					<Glyph name="slack" size={16} />
					<strong>{t(locale, 'Slack (section)')}</strong>
				</>
			);
			body = null;
		} else {
			head = (
				<MentionHead
					locale={locale}
					mention={mention}
					author={name(mention.author)}
					todo={view.todo}
				/>
			);
			body = <MentionBody locale={locale} view={view} mention={mention} />;
		}
	} else if (open.kind === 'week') {
		const week = view.weeks.find((item) => item.week === open.week) ?? {
			week: open.week,
			...weekDays(open.week),
			mentions: 0,
			waiting: 0,
			file: null,
		};
		head = (
			<>
				<Glyph name="list" size={16} />
				<strong>{slackWeekLabel(locale, week, now)}</strong>
				<small>
					{[
						slackRange(locale, week.from, week.to),
						...(week.file?.madeAt ? [madeAt(locale, week.file.madeAt)] : []),
					].join(' · ')}
				</small>
				<span className={s.gap} />
				{refreshButton}
			</>
		);
		body = (
			<WeekBody
				locale={locale}
				view={view}
				week={week}
				building={view.building.includes(week.week)}
				onOpen={onOpen}
				onRetry={() => void refresh()}
			/>
		);
	} else if (open.kind === 'month') {
		head = (
			<>
				<Glyph name="archive-box" size={16} />
				<strong>{slackMonthLabel(locale, open.month)}</strong>
				<small>{t(locale, 'In the archive')}</small>
			</>
		);
		body = <MonthBody locale={locale} month={open.month} people={people} />;
	} else {
		const day = view.days.find((item) => item.day === open.day) ?? {
			day: open.day,
			mentions: 0,
			waiting: 0,
			wrote: 0,
			threads: 0,
			file: null,
		};
		head = (
			<>
				<Glyph name="schedule" size={16} />
				<strong>{slackDayLabel(locale, day.day, now)}</strong>
				<small>
					{[
						slackDayName(locale, day.day),
						...(day.file?.madeAt ? [madeAt(locale, day.file.madeAt)] : []),
					].join(' · ')}
				</small>
				<span className={s.gap} />
				{refreshButton}
			</>
		);
		body = (
			<DayBody
				locale={locale}
				view={view}
				day={day}
				building={view.building.includes(day.day)}
				onOpen={onOpen}
				onRetry={() => void refresh()}
			/>
		);
	}
	return (
		<section
			className={n.screen}
			aria-label={t(locale, 'Slack (section)')}
			data-slack-screen={open.kind}>
			<header className={`${n.head} ${s.head}`} data-size="m">
				{head}
			</header>
			<div className={s.scroll}>{body}</div>
		</section>
	);
}
const madeAt = (locale: Locale, at: string) =>
	t(locale, 'Made at {time}').replace(
		'{time}',
		new Intl.DateTimeFormat(locale, {
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(at))
	);

/** spec/todo-and-slack-inbox#slack-inbox-to-todo: `Add to Todo` — the toast `Added to b2c › Release 1.15` with `Open` and `Undo`. */
async function addToTodo(locale: Locale, mention: SlackMentionRow) {
	let ref: SlackTodoRef;
	try {
		ref = await window.brigadir.slackInboxTodo(mention.id);
	} catch {
		toastError(t(locale, 'Could not add to Todo.'));
		return;
	}
	notify(
		'success',
		t(locale, 'Added to {target}').replace(
			'{target}',
			targetText(locale, ref.project, ref.listName)
		),
		{
			key: `slack-todo:${mention.id}`,
			action: { label: t(locale, 'Open'), run: () => openTodo(ref) },
			secondary: {
				label: t(locale, 'Undo (Slack)'),
				run: () =>
					void window.brigadir
						.slackInboxUndoTodo(mention.id)
						.catch(() => toastError(t(locale, 'Could not change the mention.'))),
			},
		}
	);
}
/** `Open` and the `In Todo` chip: the Todo section on that list. */
function openTodo(ref: SlackTodoRef) {
	useWorkspace.getState().openTodo(ref.listId);
}
/** `Add to Todo`, or where it went: `In Todo · b2c › Inbox`. */
function TodoAction({
	locale,
	mention,
	todo,
	primary = false,
}: {
	locale: Locale;
	mention: SlackMentionRow;
	todo: boolean;
	primary?: boolean;
}) {
	if (!todo) return null;
	if (mention.todo)
		return (
			<ChatCardChip onClick={() => openTodo(mention.todo!)} data-slack-in-todo>
				<Glyph name={'todo'} size={12} />
				{t(locale, 'In Todo · {target}').replace(
					'{target}',
					targetText(locale, mention.todo.project, mention.todo.listName)
				)}
			</ChatCardChip>
		);
	return (
		<Button
			size="s"
			appearance={primary ? 'primary' : 'neutral'}
			onClick={() => void addToTodo(locale, mention)}
			data-slack-add-todo>
			<Glyph name={'todo'} size={12} />
			{t(locale, 'Add to Todo')}
		</Button>
	);
}

function MentionHead({
	locale,
	mention,
	author,
	todo,
}: {
	locale: Locale;
	mention: SlackMentionRow;
	author: string;
	todo: boolean;
}) {
	return (
		<>
			<Avatar login={mention.author} name={author} size="l" />
			<strong>{author}</strong>
			<small>
				{mention.dm
					? t(locale, 'Direct message (mention)')
					: `#${mention.channelName ?? mention.channel}`}
				{' · '}
				{slackClock(locale, mention.ts)}
			</small>
			{statusTag(locale, mention.status)}
			<span className={s.gap} />
			{mention.permalink && (
				<Button
					size="m"
					variant="ghost"
					onClick={() => void window.brigadir.openWebLink(mention.permalink!).catch(() => {})}
					data-slack-open>
					<Glyph name="external" size={13} />
					{t(locale, 'Open in Slack')}
				</Button>
			)}
			<Button
				size="m"
				variant="ghost"
				disabled={!!mention.answered}
				onClick={() =>
					void window.brigadir
						.slackInboxDone(mention.id)
						.catch(() => toastError(t(locale, 'Could not change the mention.')))
				}
				data-slack-done>
				<Glyph name="tick" size={13} />
				{t(locale, 'Done')}
			</Button>
			{todo && <TodoAction locale={locale} mention={mention} todo={todo} />}
		</>
	);
}

/** spec/todo-and-slack-inbox#slack-inbox-mention: what they want, the thread with the mention lit, the agent's suggested to-do. */
function MentionBody({
	locale,
	view,
	mention,
}: {
	locale: Locale;
	view: SlackInboxView;
	mention: SlackMentionRow;
}) {
	const people = view.people,
		name = (id: string) => people[id] ?? id;
	// The thread is read again when the mention opens.
	useEffect(() => {
		if (view.connected) void window.brigadir.slackInboxThread(mention.id).catch(() => {});
	}, [mention.id, view.connected]);
	const agent = mention.agent,
		want = agent
			? (agent.ask ?? t(locale, 'Nothing — for your information'))
			: mention.agentState === 'pending'
				? null
				: slackPlain(mention.text).split('\n')[0];
	const suggestion =
		view.todo && agent?.todo && mention.suggestion === 'open' && !mention.todo ? agent.todo : null;
	return (
		<div className={s.column} data-slack-mention={mention.id}>
			<div className={s.want} data-size="s">
				<small>{t(locale, 'What they want')}</small>
				{want ?? <SkeletonText lines={1} />}
				{agent?.due && (
					<div className={s.due}>
						<ChatCardChip>
							<Glyph name="clock" size={12} />
							{slackDue(locale, agent.due)}
						</ChatCardChip>
					</div>
				)}
			</div>
			<div className={`${s.section} ${s.flush}`}>{t(locale, 'Thread (Slack)')}</div>
			{mention.context.map((item) => (
				<div
					key={item.ts}
					className={s.message}
					data-lit={item.ts === mention.ts || undefined}
					data-mine={(view.me && item.user === view.me) || undefined}>
					<Avatar login={item.user} name={name(item.user)} size="xxl" />
					<div className={s.messageBody}>
						<b>{firstName(name(item.user))}</b>
						<small>{slackClock(locale, item.ts)}</small>
						<div className={s.text}>
							{slackTextPieces(item.text, people, view.me).map((piece, index) =>
								piece.kind === 'me' || piece.kind === 'mention' ? (
									<span key={index} className={s.at} data-me={piece.kind === 'me' || undefined}>
										{piece.text}
									</span>
								) : piece.kind === 'link' ? (
									<a
										key={index}
										href={piece.url}
										onClick={(event) => {
											event.preventDefault();
											void window.brigadir.openWebLink(piece.url!).catch(() => {});
										}}>
										{piece.text}
									</a>
								) : (
									<span key={index}>{piece.text}</span>
								)
							)}
						</div>
					</div>
				</div>
			))}
			{suggestion && (
				<div className={s.suggestion} data-size="s" data-slack-suggestion>
					<Glyph name="helmet-chat" size={16} />
					<div className={s.suggestionText}>
						<small>{t(locale, 'Suggested to-do')}</small>
						<b>{suggestion.title}</b>
						{mention.target && (
							<small>→ {targetText(locale, mention.target.project, mention.target.list)}</small>
						)}
					</div>
					<Button
						variant="ghost"
						onClick={() =>
							void window.brigadir
								.slackInboxDismiss(mention.id)
								.catch(() => toastError(t(locale, 'Could not change the mention.')))
						}
						data-slack-dismiss>
						{t(locale, 'Dismiss')}
					</Button>
					<TodoAction locale={locale} mention={mention} todo={view.todo} primary />
				</div>
			)}
		</div>
	);
}

/** The state of a summary in place of its lines: making, out of quota, failed, not made yet. */
function SummaryState({
	locale,
	building,
	state,
	made,
	onRetry,
}: {
	locale: Locale;
	building: boolean;
	state: 'none' | 'ready' | 'quota' | 'failed';
	made: boolean;
	onRetry(): void;
}) {
	if (building)
		return (
			<p className={s.note} data-slack-summary="making">
				<Spinner size={12} />
				{t(locale, 'Making the summary…')}
			</p>
		);
	if (state === 'quota' || state === 'failed')
		return (
			<p className={s.note} data-slack-summary={state} data-size="s">
				<Glyph name="toast-warning" size={13} />
				{t(
					locale,
					state === 'quota'
						? 'Summary not made: the agent is out of quota.'
						: 'Could not make the summary.'
				)}
				<Button size="s" onClick={onRetry}>
					{t(locale, 'Retry')}
				</Button>
			</p>
		);
	if (!made)
		return (
			<p className={s.note} data-slack-summary="none">
				{t(locale, 'No summary yet')}
			</p>
		);
	return null;
}

/** One ask with its author's avatar and badge, the line, the channel and time, and `Add to Todo`; the row opens the mention. */
function AskRow({
	locale,
	mention,
	line,
	author,
	todo,
	onOpen,
}: {
	locale: Locale;
	mention: SlackMentionRow;
	line: string;
	author: string;
	todo: boolean;
	onOpen(): void;
}) {
	return (
		<div className={s.ask} data-size="s" data-slack-ask={mention.id}>
			<Avatar login={mention.author} name={author} size="xl" badge={slackBadge(mention.status)} />
			<button className={s.askOpen} onClick={onOpen}>
				{line}
				<small>
					{mention.dm
						? t(locale, 'Direct message (mention)')
						: `#${mention.channelName ?? mention.channel}`}
					{' · '}
					{slackClock(locale, mention.ts)}
				</small>
			</button>
			<TodoAction locale={locale} mention={mention} todo={todo} />
		</div>
	);
}

/** spec/todo-and-slack-inbox#slack-inbox-day: the day — counts, People, Asked of you, You did, Worth knowing. */
function DayBody({
	locale,
	view,
	day,
	building,
	onOpen,
	onRetry,
}: {
	locale: Locale;
	view: SlackInboxView;
	day: SlackDayRow;
	building: boolean;
	onOpen(target: SlackInboxTarget): void;
	onRetry(): void;
}) {
	const name = (id: string) => view.people[id] ?? id,
		mentions = view.mentions.filter((mention) => dayKey(slackTsMs(mention.ts)) === day.day),
		summary = day.file?.summary ?? null,
		asks = mentions.filter(
			(mention) => mention.status !== 'fyi' || summary?.asks.some((item) => item.id === mention.id)
		);
	// People: green — every ask of theirs answered, amber — one still waits; the count of their mentions on hover.
	const people = new Map<string, SlackMentionRow[]>();
	for (const mention of [...mentions].reverse())
		people.set(mention.author, [...(people.get(mention.author) ?? []), mention]);
	const stat = (count: number, kind: 'mention' | 'waiting' | 'wrote' | 'thread', amber = false) => (
		<span>
			<b data-amber={amber || undefined}>{slackInboxCount(locale, kind, count).number}</b>
			{slackInboxCount(locale, kind, count).word}
		</span>
	);
	return (
		<div className={s.column} data-slack-day={day.day}>
			<div className={s.stats}>
				{stat(day.mentions, 'mention')}
				{stat(day.waiting, 'waiting', day.waiting > 0)}
				{stat(day.wrote, 'wrote')}
				{stat(day.threads, 'thread')}
			</div>
			{people.size > 0 && (
				<>
					<div className={s.section}>
						{t(locale, 'People (Slack)')}
						<small>{t(locale, 'green — answered, amber — waiting')}</small>
					</div>
					<div className={s.people}>
						{[...people].map(([id, own]) => {
							const waiting = own.some((mention) => mention.status === 'waiting'),
								answered = own.some((mention) => mention.status === 'answered');
							return (
								<div key={id} className={s.person}>
									<Avatar
										login={id}
										name={name(id)}
										size="xxxl"
										badge={waiting ? 'waiting' : answered ? 'answered' : null}
										label={`${name(id)} · ${slackInboxCount(locale, 'mention', own.length).text}`}
									/>
									<span>{firstName(name(id))}</span>
								</div>
							);
						})}
					</div>
				</>
			)}
			{asks.length > 0 && (
				<>
					<div className={s.section}>{t(locale, 'Asked of you')}</div>
					{asks.map((mention) => (
						<AskRow
							key={mention.id}
							locale={locale}
							mention={mention}
							author={name(mention.author)}
							line={
								summary?.asks.find((item) => item.id === mention.id)?.line ??
								mention.agent?.ask ??
								mention.agent?.summary ??
								slackPlain(mention.text).split('\n')[0]!
							}
							todo={view.todo}
							onOpen={() => onOpen({ kind: 'mention', id: mention.id })}
						/>
					))}
				</>
			)}
			{summary && summary.did.length > 0 && (
				<>
					<div className={s.section}>{t(locale, 'You did')}</div>
					<ul className={s.list}>
						{summary.did.map((line, index) => (
							<li key={index}>{line}</li>
						))}
					</ul>
				</>
			)}
			{summary && summary.worth.length > 0 && (
				<>
					<div className={s.section}>{t(locale, 'Worth knowing')}</div>
					<ul className={s.list}>
						{summary.worth.map((line, index) => (
							<li key={index}>{line}</li>
						))}
					</ul>
				</>
			)}
			{(day.mentions > 0 || day.wrote > 0 || building) && (
				<SummaryState
					locale={locale}
					building={building}
					state={day.file?.state ?? 'none'}
					made={!!summary}
					onRetry={onRetry}
				/>
			)}
			{!day.mentions && !day.wrote && !building && (
				<p className={s.note}>{t(locale, 'No mentions')}</p>
			)}
		</div>
	);
}

/** spec/todo-and-slack-inbox#slack-inbox-day: the week — its lines, the counts and the asks still waiting. */
function WeekBody({
	locale,
	view,
	week,
	building,
	onOpen,
	onRetry,
}: {
	locale: Locale;
	view: SlackInboxView;
	week: SlackWeekRow;
	building: boolean;
	onOpen(target: SlackInboxTarget): void;
	onRetry(): void;
}) {
	const name = (id: string) => view.people[id] ?? id,
		waiting = view.mentions.filter((mention) => {
			const day = dayKey(slackTsMs(mention.ts));
			return mention.status === 'waiting' && day >= week.from && day <= week.to;
		});
	return (
		<div className={s.column} data-slack-week={week.week}>
			<div className={s.stats}>
				<span>
					<b>{slackInboxCount(locale, 'mention', week.mentions).number}</b>
					{slackInboxCount(locale, 'mention', week.mentions).word}
				</span>
				<span>
					<b data-amber={week.waiting > 0 || undefined}>
						{slackInboxCount(locale, 'waiting', week.waiting).number}
					</b>
					{slackInboxCount(locale, 'waiting', week.waiting).word}
				</span>
			</div>
			{week.file?.lines.length ? (
				<ul className={`${s.list} ${s.weekLines}`}>
					{week.file.lines.map((line, index) => (
						<li key={index}>{line}</li>
					))}
				</ul>
			) : null}
			<SummaryState
				locale={locale}
				building={building}
				state={week.file?.state ?? 'none'}
				made={!!week.file?.lines.length}
				onRetry={onRetry}
			/>
			{waiting.length > 0 && (
				<>
					<div className={s.section}>{t(locale, 'Asked of you')}</div>
					{waiting.map((mention) => (
						<AskRow
							key={mention.id}
							locale={locale}
							mention={mention}
							author={name(mention.author)}
							line={
								mention.agent?.ask ??
								mention.agent?.summary ??
								slackPlain(mention.text).split('\n')[0]!
							}
							todo={view.todo}
							onOpen={() => onOpen({ kind: 'mention', id: mention.id })}
						/>
					))}
				</>
			)}
		</div>
	);
}

/** spec/todo-and-slack-inbox#slack-inbox-files: a month of the archive, read-only. */
function MonthBody({
	locale,
	month,
	people,
}: {
	locale: Locale;
	month: string;
	people: Record<string, string>;
}) {
	const [rows, setRows] = useState<SlackMentionRow[] | null>(null);
	useEffect(() => {
		let live = true;
		setRows(null);
		void window.brigadir.slackInboxMonth(month).then(
			(value) => live && setRows(value),
			() => live && setRows([])
		);
		return () => {
			live = false;
		};
	}, [month]);
	const name = (id: string) => people[id] ?? id;
	return (
		<div className={s.column} data-slack-month={month}>
			{!rows ? (
				<SkeletonText lines={3} />
			) : (
				rows.map((mention) => (
					<div key={mention.id} className={s.ask} data-slack-archived={mention.id}>
						<Avatar
							login={mention.author}
							name={name(mention.author)}
							size="xl"
							badge={slackBadge(mention.status)}
						/>
						<span className={s.askOpen}>
							{mention.agent?.summary ?? slackPlain(mention.text).split('\n')[0]}
							<small>
								{name(mention.author)}
								{' · '}
								{mention.dm
									? t(locale, 'Direct message (mention)')
									: `#${mention.channelName ?? mention.channel}`}
								{' · '}
								{slackRange(locale, dayKey(slackTsMs(mention.ts)), dayKey(slackTsMs(mention.ts)))}
							</small>
						</span>
					</div>
				))
			)}
		</div>
	);
}
