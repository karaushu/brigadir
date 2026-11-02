import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import {
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	groupNotices,
	menuCommands,
	projectColors,
	t,
	unreadNotices,
	withShortcut,
	type Locale,
	type NoticeCenter,
	type NoticeEntry,
	type NoticeEntryKind,
	type PendingNotice,
	type PendingNoticeKind,
} from '@brigadir/core';
import { Button, IconButton, Segments } from './ui/Controls';
import { Glyph, type GlyphName } from './ui/Glyph';
import { Popover } from './ui/Popover';
import { ProjectIcon } from './ui/ProjectIcon';
import { setToastLogger, type ToastAction } from './ui/Toast';
import { useWorkspace } from './store';
import s from './NotificationCenter.module.css';

/**
 * spec/notifications-slack-notes-and-schedules#notification-center: the bell over the sidebar and its popover — «Needs you» with the request's own
 * actions, then the history by day. Main keeps the history (`notifications.jsonl`) and rebuilds the live requests; the
 * window hands over its toasts and keeps their actions while it lives.
 */
export const useNoticeCenter = create<NoticeCenter & { open: boolean }>(() => ({
	entries: [],
	pending: [],
	open: false,
}));
/** A toast's action runs only while the window that showed it lives: keyed by kind and text, as the row is. */
const toastActions = new Map<string, ToastAction>();
const actionKey = (kind: string, text: string) => `${kind}:${text}`;

const ENTRY_GLYPH: Record<NoticeEntryKind, [GlyphName, string]> = {
	'turn-ended': ['agent-completed', 'var(--green)'],
	background: ['console', 'var(--fg2)'],
	failed: ['agent-failed', 'var(--red)'],
	'rate-limited': ['agent-hourglass', 'var(--fg2)'],
	'scope-violation': ['scope-lock', 'var(--amber)'],
	'ci-pass': ['check-pass', 'var(--green)'],
	'ci-fail': ['check-fail', 'var(--red)'],
	'ci-cancelled': ['check-skipped', 'var(--fg2)'],
	question: ['agent-question', 'var(--amber)'],
	permission: ['agent-permission', 'var(--amber)'],
	plan: ['plan', 'var(--amber)'],
	proposal: ['agent-question', 'var(--amber)'],
	worker: ['agent-question', 'var(--amber)'],
	page: ['browser', 'var(--fg2)'],
	error: ['toast-error', 'var(--red)'],
	warning: ['toast-warning', 'var(--amber)'],
	info: ['toast-info', 'var(--accent)'],
	success: ['toast-success', 'var(--green)'],
};
const PENDING_GLYPH: Record<PendingNoticeKind, GlyphName> = {
	question: 'agent-question',
	permission: 'agent-permission',
	plan: 'plan',
	proposal: 'agent-question',
	worker: 'agent-question',
	schedule: 'check-skipped',
};

/** Main's events and the toasts of this window; one per window (App). */
export function NotificationCenterEvents() {
	useEffect(() => {
		let alive = true;
		void window.brigadir
			.readNoticeCenter()
			.then((center) => alive && useNoticeCenter.setState(center))
			.catch(() => {});
		const off = window.brigadir.onNoticeCenter((center) => useNoticeCenter.setState(center));
		const menu = window.brigadir.onWorkspaceAction((action) => {
			if (action === 'notifications') useNoticeCenter.setState((state) => ({ open: !state.open }));
		});
		setToastLogger(({ kind, text, action }) => {
			if (action) toastActions.set(actionKey(kind, text), action);
			const { selectedTask, workspace } = useWorkspace.getState(),
				task = selectedTask
					? workspace?.tasks.find(
							(item) => item.projectId === selectedTask.projectId && item.id === selectedTask.id
						)
					: undefined;
			void window.brigadir
				.addToastNotice({
					kind,
					text,
					action: action?.label ?? null,
					task: task ? { projectId: task.projectId, id: task.id } : null,
					title: task?.title ?? null,
					read: document.visibilityState === 'visible' && document.hasFocus(),
				})
				.catch(() => {});
		});
		return () => {
			alive = false;
			off();
			menu();
			setToastLogger(null);
		};
	}, []);
	return null;
}

/** «2 m», «1 h», then the clock for yesterday and the date before (spec/notifications-slack-notes-and-schedules#notification-center). */
function when(locale: Locale, at: number, now: number) {
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return t(locale, 'just now');
	if (minutes < 60) return t(locale, '{n} m').replace('{n}', String(minutes));
	const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
	if (sameDay && minutes < 12 * 60)
		return t(locale, '{n} h').replace('{n}', String(Math.floor(minutes / 60)));
	const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
	return now - at < 2 * 24 * 60 * 60_000
		? time
		: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
}

const act = (action: Parameters<typeof window.brigadir.noticeCenterAction>[0]) =>
	void window.brigadir.noticeCenterAction(action).catch(() => {});

export function NotificationBell({
	locale,
	size,
	placement = 'strip',
}: {
	locale: Locale;
	size: 's' | 'm' | 'xl';
	/** spec/sidebar#section-rail: in the sections rail the bell stands in the column and its popover opens beside it. */ placement?:
		'strip' | 'rail';
}) {
	const { entries, pending, open } = useNoticeCenter(),
		keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap,
		anchor = useRef<HTMLButtonElement>(null),
		list = useRef<HTMLDivElement>(null),
		[filter, setFilter] = useState<'all' | 'unread'>('all'),
		[now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!open) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [open]);
	const unread = unreadNotices(entries),
		dot = pending.length ? 'var(--amber)' : unread ? 'var(--accent)' : null,
		name = t(locale, 'Notifications'),
		state = pending.length ? t(locale, 'Needs you') : unread ? t(locale, 'Unread') : null,
		label = state ? `${name} · ${state}` : name,
		shortcut = ((key) => (key ? formatAccelerator(key) : undefined))(
			commandAccelerator(
				menuCommands.find((item) => item.id === 'notifications')!,
				keymap
			)
		),
		close = () => useNoticeCenter.setState({ open: false });
	const shown = filter === 'unread' ? entries.filter((entry) => !entry.read) : entries,
		groups = groupNotices(shown, now),
		live = pending;
	/** ↑↓ walk the rows' main buttons; ⌫ takes a history row away (spec/notifications-slack-notes-and-schedules#notification-center). */
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const rows = [
				...(list.current?.querySelectorAll<HTMLButtonElement>('[data-notice-main]') ?? []),
			],
			index = rows.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			rows[index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step))]?.focus();
		}
		if ((event.key === 'Backspace' || event.key === 'Delete') && index >= 0) {
			const id = rows[index]!.dataset.noticeId;
			if (id && rows[index]!.dataset.noticeLive === undefined) {
				event.preventDefault();
				(rows[index + 1] ?? rows[index - 1])?.focus();
				act({ kind: 'dismiss', id });
			}
		}
	};
	const sections: ReactNode[] = [];
	if (live.length)
		sections.push(
			<section key="needs" aria-label={t(locale, 'Needs you')}>
				<h3 className={s.section}>
					{t(locale, 'Needs you')} · <b>{live.length}</b>
				</h3>
				<ul className={s.needs}>
					{live.map((item) => (
						<LiveRow key={item.id} item={item} locale={locale} close={close} />
					))}
				</ul>
			</section>
		);
	for (const group of groups)
		sections.push(
			<section key={group.day} aria-label={t(locale, dayName[group.day])}>
				<h3 className={s.section}>{t(locale, dayName[group.day])}</h3>
				<ul className={s.rows}>
					{group.entries.map((entry) => (
						<EntryRow
							key={entry.id}
							entry={entry}
							locale={locale}
							when={when(locale, entry.at, now)}
							close={close}
						/>
					))}
				</ul>
			</section>
		);
	const empty = !groups.length;
	return (
		<span className={placement === 'rail' ? s.railSlot : s.slot} data-size={size}>
			<IconButton
				ref={anchor}
				size={size}
				label={label}
				hint={withShortcut(label, shortcut)}
				dot={dot}
				aria-haspopup="dialog"
				aria-expanded={open}
				data-notice-bell={pending.length ? 'needs' : unread ? 'unread' : 'idle'}
				onClick={() => useNoticeCenter.setState({ open: !open })}>
				<Glyph name="bell" size={16} />
			</IconButton>
			<Popover
				open={open}
				onClose={close}
				anchor={anchor}
				label={name}
				locale={locale}
				{...(placement === 'rail' ? { side: 'right' as const, align: 'end' as const } : {})}
				width={380}
				size="s"
				className={s.popover}
				data-notice-center
				initialFocus={(root) =>
					root.querySelector<HTMLElement>('[data-notice-main]') ??
					root.querySelector<HTMLElement>('button')
				}
				headerExtra={
					<Segments
						label={t(locale, 'Notifications')}
						tabs
						options={[
							{ value: 'all', label: t(locale, 'All') },
							{ value: 'unread', label: t(locale, 'Unread') },
						]}
						value={filter}
						onChange={(value) => setFilter(value as 'all' | 'unread')}
					/>
				}
				onKeyDown={keys}>
				<div ref={list} className={s.list}>
					{sections}
					{empty && (
						<div className={s.empty} data-notice-empty>
							<Glyph name="bell" size={20} />
							<strong>
								{t(
									locale,
									filter === 'unread'
										? 'No unread notifications'
										: live.length
											? 'History is empty'
											: 'No notifications'
								)}
							</strong>
						</div>
					)}
				</div>
				<footer className={s.footer} data-size="s">
					{!!entries.length && (
						<Button variant="ghost" disabled={!unread} onClick={() => act({ kind: 'read-all' })}>
							{t(locale, 'Mark all as read')}
						</Button>
					)}
					<span />
					{!!entries.length && (
						<Button variant="ghost" onClick={() => act({ kind: 'clear' })}>
							{t(locale, 'Clear (notices)')}
						</Button>
					)}
					<IconButton
						label={t(locale, 'Notification settings')}
						onClick={() => {
							close();
							window.dispatchEvent(
								new CustomEvent('brigadir:open-settings', { detail: 'notifications' })
							);
						}}>
						<Glyph name="search-setting" size={14} />
					</IconButton>
				</footer>
			</Popover>
		</span>
	);
}
const dayName = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' } as const;

function Lines({
	glyph,
	color,
	title,
	body,
	projectId,
}: {
	glyph: GlyphName;
	color: string;
	title: string;
	body: string;
	projectId: string | null;
}) {
	const projects = useWorkspace((state) => state.workspace?.projects),
		project = projectId ? projects?.find((item) => item.id === projectId) : undefined,
		slot = project ? (projectColors(projects!.map((item) => item.id)).get(project.id) ?? 0) : 0;
	return (
		<>
			<span className={s.glyph} style={{ color }}>
				<Glyph name={glyph} size={14} />
			</span>
			<span className={s.lines}>
				<span className={s.title}>
					{project && <ProjectIcon project={project} slot={slot} size={14} />}
					<span className={s.name}>{title}</span>
				</span>
				<span className={s.body}>{body}</span>
			</span>
		</>
	);
}

function LiveRow({ item, locale, close }: { item: PendingNotice; locale: Locale; close(): void }) {
	return (
		<li className={s.row} data-unread data-live>
			<button
				type="button"
				className={s.main}
				data-notice-main
				data-notice-id={item.id}
				data-notice-live
				onClick={() => {
					close();
					act({ kind: 'open', id: item.id });
				}}>
				<Lines
					glyph={PENDING_GLYPH[item.kind]}
					color="var(--amber)"
					title={item.title}
					body={item.body}
					projectId={item.task.projectId}
				/>
			</button>
			<span className={s.actions} data-size="s" data-always>
				{item.kind === 'schedule' ? (
					// spec/notifications-slack-notes-and-schedules#schedules: a schedule's missed slots — Skip them, or Run once now.
					<>
						<Button
							variant="ghost"
							onClick={() => act({ kind: 'answer', id: item.id, option: 'deny' })}>
							{t(locale, 'Skip')}
						</Button>
						<Button
							appearance="primary"
							variant="soft"
							onClick={() => act({ kind: 'answer', id: item.id, option: 'allow' })}>
							{t(locale, 'Run once')}
						</Button>
					</>
				) : item.kind === 'permission' ? (
					<>
						{item.deny && (
							<Button
								variant="ghost"
								onClick={() => act({ kind: 'answer', id: item.id, option: 'deny' })}>
								{t(locale, 'Deny')}
							</Button>
						)}
						{item.allow ? (
							<Button
								appearance="primary"
								variant="soft"
								onClick={() => act({ kind: 'answer', id: item.id, option: 'allow' })}>
								{t(locale, 'Allow')}
							</Button>
						) : (
							<OpenButton id={item.id} locale={locale} close={close} />
						)}
					</>
				) : item.kind === 'question' || item.kind === 'worker' ? (
					<Button
						appearance="primary"
						variant="soft"
						onClick={() => {
							close();
							act({ kind: 'open', id: item.id });
						}}>
						{t(locale, 'Answer (notice)')}
					</Button>
				) : (
					<OpenButton id={item.id} locale={locale} close={close} />
				)}
			</span>
		</li>
	);
}
function OpenButton({ id, locale, close }: { id: string; locale: Locale; close(): void }) {
	return (
		<Button
			appearance="primary"
			variant="soft"
			onClick={() => {
				close();
				act({ kind: 'open', id });
			}}>
			{t(locale, 'Open')}
		</Button>
	);
}

function EntryRow({
	entry,
	locale,
	when,
	close,
}: {
	entry: NoticeEntry;
	locale: Locale;
	when: string;
	close(): void;
}) {
	const [glyph, color] = ENTRY_GLYPH[entry.kind],
		toast = entry.action ? toastActions.get(actionKey(entry.kind, entry.body)) : undefined,
		open = () => {
			close();
			act({ kind: 'open', id: entry.id });
		};
	const action = toast ? (
		<Button
			appearance="primary"
			variant="soft"
			onClick={() => {
				close();
				act({ kind: 'read', ids: [entry.id] });
				toast.run();
			}}>
			{toast.label}
		</Button>
	) : entry.target ? (
		<Button appearance="primary" variant="soft" onClick={open}>
			{t(locale, entry.target.kind === 'run' ? 'Open the run' : 'Open')}
		</Button>
	) : null;
	return (
		<li className={s.row} data-unread={!entry.read || undefined}>
			<button
				type="button"
				className={s.main}
				data-notice-main
				data-notice-id={entry.id}
				onClick={() => (entry.target ? open() : act({ kind: 'read', ids: [entry.id] }))}>
				<Lines
					glyph={glyph}
					color={color}
					title={entry.title || t(locale, 'Brigadir')}
					body={entry.count > 1 ? `${entry.body} ×${entry.count}` : entry.body}
					projectId={
						entry.target?.kind === 'task'
							? entry.target.task.projectId
							: (entry.target?.watch.projectId ?? null)
					}
				/>
			</button>
			<span className={s.tail} aria-hidden>
				{when}
				{!entry.read && <span className={s.dot} />}
			</span>
			<span className={s.actions} data-size="s">
				{action}
				<IconButton
					label={t(locale, 'Dismiss (notice)')}
					onClick={() => act({ kind: 'dismiss', id: entry.id })}>
					<Glyph name="close" size={12} />
				</IconButton>
			</span>
		</li>
	);
}
