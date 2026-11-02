import type { ComponentProps, ReactNode } from 'react';
import {
	attachmentCount,
	relativeAge,
	scopeCount,
	t,
	taskDescription,
	type AgentTask,
	type BoardColumn,
	type Locale,
	type MessageKey,
	type Project,
} from '@brigadir/core';
import { BranchName } from './ui/BranchName';
import { Chip, StatusIcon } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ProjectIcon } from './ui/ProjectIcon';
import s from './ProjectScreen.module.css';

/* The project screen's look (spec/projects-and-board#board, spec/projects-and-board#screen-layout, spec/projects-and-board#pr-mode): title strip, toolbar, columns and task cards. ProjectScreen fills them
   with the live board; the intro's sample window shows the same parts at rest (spec/settings-modules-and-onboarding#intro-steps, rule 17). */

const statuses: Record<AgentTask['status'], MessageKey> = {
	backlog: 'Not started',
	'rate-limited': 'Rate limited',
	queued: 'Queued',
	preparing: 'Preparing…',
	working: 'Working',
	'needs-you': 'Needs you',
	done: 'Turn completed',
	interrupted: 'Stopped',
	failed: 'Error',
	completed: 'Completed task',
};
/** A card's state as words — the board card and a note's link to the task (spec/notifications-slack-notes-and-schedules#notes) say it the same. */
export function taskStatusLabel(task: Pick<AgentTask, 'status' | 'hasStarted'>, locale: Locale) {
	return t(
		locale,
		task.status === 'backlog' && task.hasStarted ? 'Backlog' : statuses[task.status]
	);
}
/** The title strip: the screen's name, then its buttons (agents, search). */
export function ProjectTitlebar({
	title,
	hint,
	children,
}: {
	title: ReactNode;
	hint?: string | undefined;
	children?: ReactNode;
}) {
	return (
		<header className={s.titlebar} data-size="m">
			<span title={hint}>{title}</span>
			{children}
		</header>
	);
}
/** spec/projects-and-board#pr-mode: one row of tabs and controls under the title; `tabs` first, the rest at the row's end. */
export function ProjectToolbar({ tabs, children }: { tabs: ReactNode; children: ReactNode }) {
	return (
		<div className={s.toolbar} data-size="m" data-project-toolbar>
			{tabs}
			<span className={s.toolbarGap} />
			{children}
		</div>
	);
}
/** The columns of the board or the sections of the list (spec/projects-and-board#board). */
export function BoardColumns({ view, children }: { view: 'board' | 'list'; children: ReactNode }) {
	return (
		<div className={s.board} data-view={view}>
			{children}
		</div>
	);
}
/** One column: the heading with its count, `extra` (the limit) and `action` beside it; `hint` while it holds no card. */
export function BoardColumnView({
	column,
	label,
	count,
	extra,
	action,
	hint,
	children,
	...section
}: Omit<ComponentProps<'section'>, 'children'> & {
	column: BoardColumn;
	label: string;
	count: number;
	extra?: ReactNode;
	action?: ReactNode;
	hint?: string | undefined;
	children: ReactNode;
}) {
	return (
		<section className={s.column} data-board-column={column} aria-label={label} {...section}>
			<header className={s.columnHeading}>
				<h2>
					{label}
					<span>· {count}</span>
				</h2>
				{extra}
				{action}
			</header>
			<div className={s.cards}>
				{!count && hint && <div className={s.placeholder}>{hint}</div>}
				{children}
			</div>
		</section>
	);
}
/** spec/projects-and-board#screen-layout: the column's limit `working / max` beside its heading. */
export function BoardLimit({ title, children }: { title: string; children: ReactNode }) {
	return (
		<span className={s.limit} title={title}>
			{children}
		</span>
	);
}
/**
 * A task card of the board and a row of the list (spec/projects-and-board#board). `selectable` says whether the model or effort chip
 * opens a menu; `actions` stand at the end of the state line, `badges` before the age, `after` under the card (relay links).
 */
export function BoardCard({
	task,
	locale,
	all,
	project,
	slot,
	now,
	live,
	selectable,
	busy = false,
	actions,
	badges,
	after,
	onOption,
	...article
}: Omit<ComponentProps<'article'>, 'children' | 'slot'> & {
	task: AgentTask;
	locale: Locale;
	/** All projects: the card names its project with the project's icon. */ all: boolean;
	project: Pick<Project, 'name' | 'icon'>;
	slot: number;
	now: number;
	/** Workers of a foreman that hold an agent now (spec/projects-and-board#board). */ live: number;
	selectable(kind: 'model' | 'effort'): boolean;
	busy?: boolean;
	actions?: ReactNode;
	badges?: ReactNode;
	after?: ReactNode;
	onOption?(kind: 'model' | 'effort'): void;
}) {
	const description = taskDescription(task);
	// spec/projects-and-board#board: the type glyph and, beside a foreman's helmet, its live workers. The board shows it in the state line, the list before the title.
	const mark = (size: number) => (
		<>
			<i className={s.type} title={t(locale, task.crew ? 'Brigadir' : 'Agent')}>
				<Glyph name={task.crew ? 'helmet' : 'person'} size={size} />
			</i>
			{live > 0 && (
				<small className={s.workers} title={t(locale, 'Workers working now')}>
					{live}
				</small>
			)}
		</>
	);
	const status = taskStatusLabel(task, locale);
	return (
		<article className={s.card} data-board-task={task.id} data-status={task.status} {...article}>
			<div className={s.state}>
				{mark(13)}
				<span>
					<StatusIcon size={13} status={task.status} label={status} />
					{status}
				</span>
				{task.hasUnread && (
					<span className={s.unread} aria-label={t(locale, 'Unread')} title={t(locale, 'Unread')} />
				)}{' '}
				{actions}
			</div>
			<div className={s.copy}>
				<div className={s.heading}>
					{mark(12)}
					<h3 title={task.title}>{task.title}</h3>
				</div>
				{description && <p>{description}</p>}
			</div>
			<div
				className={s.options}
				onClick={(event) => {
					if ((event.target as HTMLElement).closest('button')) event.stopPropagation();
				}}>
				{(['model', 'effort'] as const).map((kind) => (
					<Chip
						key={kind}
						disabled={!selectable(kind) || busy}
						aria-label={t(locale, kind === 'model' ? 'Model' : 'Effort')}
						title={
							selectable(kind)
								? t(locale, kind === 'model' ? 'Model' : 'Effort')
								: t(locale, 'Agent options are available after the first launch.')
						}
						onClick={() => onOption?.(kind)}>
						{/* spec/projects-and-board#screen-layout: the Claude mark in its own colour, as in the composer's capsule. */}
						<span
							className={s.provider}
							data-provider={kind === 'model' ? task.provider : undefined}>
							<Glyph
								name={
									kind === 'effort'
										? 'effort'
										: task.provider === 'codex'
											? 'openai'
											: task.provider === 'claude'
												? 'claude'
												: 'person'
								}
								size={13}
							/>
						</span>
						<span>
							{kind === 'model'
								? task.modelName ||
									t(
										locale,
										task.provider === 'codex'
											? 'Codex'
											: task.provider === 'claude'
												? 'Claude'
												: 'Agent'
									)
								: task.effortName || '—'}
						</span>
						{selectable(kind) && <Glyph name="sidebar-chevron" size={8} />}
					</Chip>
				))}
			</div>
			<footer className={s.meta}>
				{all && <ProjectIcon className={s.dot} project={project} slot={slot} size={14} />}
				<span className={s.scope} data-project-name={all || undefined}>
					{all
						? project.name
						: task.scopeNames?.length
							? task.scopeNames.length === 1
								? task.scopeNames[0]
								: scopeCount(locale, task.scopeNames.length)
							: project.name}
				</span>
				{task.worktreeBranch && (
					<span className={s.branch}>
						<Glyph name="board-branch" size={11} />
						<BranchName name={task.worktreeBranch} />
					</span>
				)}
				{/* spec/tasks#backlog-edit: a backlog task carries its attachments to the first prompt; the clip says how many, before the age. */}
				{task.status === 'backlog' && !!task.attachments?.length && (
					<span
						className={s.clip}
						data-attachment-count={task.attachments.length}
						title={attachmentCount(locale, task.attachments.length)}
						aria-label={attachmentCount(locale, task.attachments.length)}>
						<Glyph name="paperclip" size={11} />
						{new Intl.NumberFormat(locale).format(task.attachments.length)}
					</span>
				)}
				{badges}
				<time dateTime={task.updatedAt} title={task.updatedAt}>
					{relativeAge(locale, task.updatedAt, now)}
				</time>
			</footer>
			{after}
		</article>
	);
}
