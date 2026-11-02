import { useRef } from 'react';
import { t, type AgentTask, type Locale } from '@brigadir/core';
import { useWorkspace } from './store';
import { useSchedules } from './SchedulesScreen';
import { Glyph, type GlyphName } from './ui/Glyph';
import { Button } from './ui/Controls';
import { HeaderChip } from './ui/HeaderChip';
import { MenuItem, MenuPopover, useHoverPopover } from './ui/Popover';
import { useNoteOfTask } from './notes-index';
import styles from './RelayLinks.module.css';

/** One relation of a task: what it says, what its tooltip names and what a click opens. */
type TaskLink = {
	key: string;
	glyph: GlyphName;
	/** «Created from», «Continuation of»… — the `fg2` part. */ label: string;
	/** The other side's name — the `fg` part, the only one that truncates. */ name: string;
	/** The full name, for the tooltip. */ title: string;
	data: Record<`data-${string}`, true>;
	open(): void;
};

/**
 * Every relation of a task (spec/tasks#relay, spec/tasks#agent-created-tasks, spec/notifications-slack-notes-and-schedules#notes, spec/notifications-slack-notes-and-schedules#schedules, spec/notifications-slack-notes-and-schedules#slack), in one order for the header and the
 * board card: the task it continues, the tasks that continue it, the task whose agent proposed it, its Slack thread, its
 * note, its schedule. `gone` —
 * the task it continues was deleted; it is said, not linked.
 */
function useTaskLinks(
	task: AgentTask,
	locale: Locale,
	open: (task: AgentTask) => void,
	sourceOnly: boolean
): { links: TaskLink[]; gone: boolean } {
	const tasks = useWorkspace((state) => state.workspace?.tasks ?? []);
	const schedules = useSchedules(),
		run = task.scheduleRun,
		schedule = run
			? schedules?.find((item) => item.projectId === task.projectId && item.id === run.scheduleId)
			: undefined;
	const note = useNoteOfTask(
		task.projectId,
		task.id,
		useWorkspace((state) => state.appearance.modules.notes)
	);
	const source = task.continuesTaskId
			? tasks.find((item) => item.projectId === task.projectId && item.id === task.continuesTaskId)
			: undefined,
		origin = task.originTaskId
			? tasks.find((item) => item.projectId === task.projectId && item.id === task.originTaskId)
			: undefined,
		children = sourceOnly
			? []
			: tasks.filter(
					(item) => item.projectId === task.projectId && item.continuesTaskId === task.id
				);
	const toTask = (
		item: AgentTask,
		key: string,
		label: 'Continuation of' | 'Continued in' | 'Created from',
		glyph: GlyphName,
		data: Record<`data-${string}`, true> = {}
	): TaskLink => ({
		key: `${key}-${item.id}`,
		glyph,
		label: t(locale, label),
		name: item.title,
		title: item.title,
		data,
		open: () => open(item),
	});
	const links: TaskLink[] = [];
	if (source) links.push(toTask(source, 'source', 'Continuation of', 'relay'));
	for (const child of children) links.push(toTask(child, 'child', 'Continued in', 'relay'));
	// spec/tasks#agent-created-tasks: the task whose agent proposed this one; a deleted origin leaves no link.
	if (origin)
		links.push(toTask(origin, 'origin', 'Created from', 'task-new', { 'data-origin-link': true }));
	// spec/notifications-slack-notes-and-schedules#slack: a task from an `@bot` mention opens its Slack thread.
	const permalink = task.slackThread?.permalink;
	if (permalink)
		links.push({
			key: 'slack',
			glyph: 'slack',
			label: t(locale, 'From Slack'),
			name: '',
			title: t(locale, 'Slack thread'),
			data: { 'data-slack-link': true },
			open: () => void window.brigadir.openWebLink(permalink).catch(() => {}),
		});
	if (note) {
		const name = note.title || t(locale, 'Untitled note');
		links.push({
			key: 'note',
			glyph: 'note',
			label: t(locale, 'From the note'),
			name,
			title: name,
			data: { 'data-note-link': true },
			open: () => useWorkspace.getState().openNotes(note.id),
		});
	}
	if (schedule) {
		// GLOSSARY «Run (of a schedule)»: `Run of Daily review` / `Запуск «Daily review»` — the opening quote goes with the name.
		const [before = '', after = ''] = t(locale, 'Run of {name}').split('{name}'),
			mark = /\S*$/.exec(before)?.[0] ?? '';
		links.push({
			key: 'schedule',
			glyph: 'schedule',
			label: before.slice(0, before.length - mark.length).trimEnd(),
			name: `${mark}${schedule.name}${after}`,
			title: schedule.name,
			data: { 'data-schedule-link': true },
			open: () =>
				useWorkspace.getState().openSchedules({ projectId: schedule.projectId, id: schedule.id }),
		});
	}
	return { links, gone: !!task.continuesTaskId && !source };
}

/** The board card's relations (spec/appearance#evolution-redesign): S tint buttons with an accent glyph. */
export function RelayLinks({
	task,
	locale,
	open,
}: {
	task: AgentTask;
	locale: Locale;
	open(task: AgentTask): void;
}) {
	const { links, gone } = useTaskLinks(task, locale, open, true);
	if (!links.length && !gone) return null;
	return (
		<div className={styles.links} data-relay-links>
			{gone && <span>{t(locale, 'Previous task unavailable')}</span>}
			{links.map((link) => (
				<Button
					key={link.key}
					size="s"
					title={link.title}
					{...link.data}
					onClick={(event) => {
						event.stopPropagation();
						link.open();
					}}>
					<Glyph name={link.glyph} size={12} />
					<span>
						{link.label} <strong>{link.name}</strong>
					</span>
				</Button>
			))}
		</div>
	);
}

/**
 * spec/appearance#evolution-redesign: the task's relations in the second line of its header, after repo · branch · state —
 * the first one a chip (accent glyph, `fg2` label, `fg` name that alone truncates), the rest behind «+N» with the
 * «Related tasks» menu. A deleted source is quiet text without an action.
 */
export function TaskLinksChip({
	task,
	locale,
	open,
}: {
	task: AgentTask;
	locale: Locale;
	open(task: AgentTask): void;
}) {
	const { links, gone } = useTaskLinks(task, locale, open, false);
	const more = useRef<HTMLButtonElement>(null),
		menuId = `task-links-${task.id}`,
		hover = useHoverPopover();
	// spec/tasks#relay: the summary that could not be written is said where the continuation is named.
	const issue =
		task.relayIssue === 'summary-failed'
			? t(locale, 'The summary could not be generated. You can start without it.')
			: null;
	const [first] = links;
	if (!first && !gone) return null;
	const dot = (
		<span className={styles.dot} aria-hidden="true">
			·
		</span>
	);
	return (
		<>
			{gone && (
				<>
					{dot}
					<span className={styles.gone} data-relay-gone>
						{t(locale, 'Previous task unavailable')}
					</span>
				</>
			)}
			{first && (
				<>
					{dot}
					<HeaderChip
						className={styles.chip}
						data-relay-chip
						{...first.data}
						title={
							issue && first.key.startsWith('source-') ? `${first.title}\n${issue}` : first.title
						}
						onClick={first.open}>
						<Glyph name={first.glyph} size={11} />
						<span className={styles.label}>{first.label}</span>
						<span className={styles.name}>{first.name}</span>
					</HeaderChip>
				</>
			)}
			{links.length > 1 && (
				<>
					<HeaderChip
						ref={more}
						count
						pinned={hover.mode === 'pinned'}
						className={styles.more}
						data-relay-more
						aria-haspopup="menu"
						aria-expanded={hover.open}
						aria-controls={hover.open ? menuId : undefined}
						aria-label={`${t(locale, 'Related tasks')} · ${links.length}`}
						{...hover.trigger}
						onClick={(event) => {
							hover.trigger.onClick();
							// A click from the keyboard takes focus into the menu, as any menu does.
							if (event.detail === 0)
								requestAnimationFrame(() =>
									document
										.getElementById(menuId)
										?.querySelector<HTMLElement>('[role=menuitem]')
										?.focus({ preventScroll: true })
								);
						}}>
						+{links.length - 1}
					</HeaderChip>
					<MenuPopover
						id={menuId}
						open={hover.open}
						onClose={hover.close}
						anchor={more}
						width={280}
						className={styles.menu}
						label={t(locale, 'Related tasks')}
						locale={locale}
						onPointerEnter={hover.popover.onPointerEnter}
						onPointerLeave={hover.popover.onPointerLeave}
						focusOnOpen={false}
						closeOnFocusOut>
						{links.map((link) => (
							<MenuItem
								key={link.key}
								icon={<Glyph name={link.glyph} size={13} />}
								title={link.title}
								data-relay-item
								onSelect={link.open}>
								<span className={styles.itemText}>
									<span className={styles.label}>{link.label}</span> {link.name}
								</span>
							</MenuItem>
						))}
					</MenuPopover>
				</>
			)}
		</>
	);
}
