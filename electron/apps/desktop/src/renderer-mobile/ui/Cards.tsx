/**
 * spec/remote-access-and-mobile#phone-app: the sidebar's look in the phone's scale — the task card, the quiet row of a completed task
 * (spec/sidebar#done-rows), the project frame (spec/sidebar#layout) and the banners. The whole card is the button
 * (rule 15): pressed covers it all.
 */
import { memo, type ReactNode } from 'react';
import {
	crewLabel,
	formatChangeCount,
	relativeAge,
	t,
	type AgentTask,
	type CrewWorkerRow,
	type Locale,
} from '@brigadir/core';
import { Glyph } from '../../renderer/ui/Glyph';
import { StatusIcon } from '../../renderer/ui/Controls';
import { statusLabels, taskActivityText } from '../../renderer/task-line';
import { Icon } from './Icon';
import s from './Cards.module.css';

const amber = (task: AgentTask) => task.status === 'needs-you';
/** The foreman's card carries the attention of a worker that waits for the person (spec/crew#attention), as on the computer. */
const mono = (task: AgentTask) =>
	(task.status === 'working' || task.status === 'preparing') && task.activity?.kind === 'tool';
export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
	return (
		<span className={`mono ${s.counts}`}>
			<span className={s.add}>+{formatChangeCount(additions)}</span>{' '}
			<span className={s.del}>−{formatChangeCount(deletions)}</span>
		</span>
	);
}
/** The second line: the activity while the agent works or waits, the state otherwise (spec/sidebar#layout). */
function cardLine(locale: Locale, task: AgentTask): string {
	if (task.status === 'rate-limited') return t(locale, 'Subscription limit');
	if (task.status === 'done' && task.hasUnreviewedChanges) return t(locale, 'Changes not reviewed');
	// spec/remote-access-and-mobile#phone-pr-list (KBBacklog): a backlog card says what it will start with.
	if (task.status === 'backlog' && !task.blockedBy?.length)
		return [t(locale, 'Not started'), task.modelName, task.effortName].filter(Boolean).join(' · ');
	return taskActivityText(locale, task);
}
export const TaskCard = memo(function TaskCard({
	task,
	locale,
	workers,
	attention = false,
	onOpen,
}: {
	task: AgentTask;
	locale: Locale;
	/** A foreman's card: the helmet and how many workers it has, in place of the provider (spec/crew#task-type). */ workers?: number;
	/** A worker of this foreman waits for the person (spec/crew#attention): the card is amber and says so. */ attention?: boolean;
	onOpen(task: AgentTask): void;
}) {
	const counts = task.changeSummary,
		branch = task.taskTree?.branch ?? task.worktreeBranch ?? null,
		waits = amber(task) || attention,
		line =
			attention && !amber(task) ? t(locale, 'A worker is waiting for you') : cardLine(locale, task);
	return (
		<button
			type="button"
			className={s.card}
			data-amber={waits || undefined}
			data-task-card={task.id}
			data-status={task.status}
			data-crew-attention={(attention && !amber(task)) || undefined}
			aria-label={`${task.title} · ${t(locale, statusLabels[waits ? 'needs-you' : task.status])}`}
			onClick={() => onOpen(task)}>
			<StatusIcon
				status={waits ? 'needs-you' : task.status}
				question={task.activity?.kind === 'question'}
				signIn={task.status === 'failed' && task.failure === 'auth'}
				label={t(locale, statusLabels[task.status])}
				size={18}
			/>
			<span className={s.cardBody}>
				<span className={s.cardHead}>
					<span className={`ell ${s.cardTitle}`}>{task.title}</span>
					{task.hasUnread && <i className={s.unread} aria-label={t(locale, 'Unread')} />}
					{workers !== undefined ? (
						<span className={s.crew} title={t(locale, 'Workers')}>
							<Glyph name="helmet" size={13} />
							{workers}
						</span>
					) : (
						task.provider && (
							<span className={s.provider} title={task.provider === 'claude' ? 'Claude' : 'Codex'}>
								<Glyph name={task.provider === 'claude' ? 'claude' : 'openai'} size={12} />
							</span>
						)
					)}
				</span>
				<span
					className={`ell ${s.line}${mono(task) ? ' mono' : ''}`}
					data-amber={waits || task.status === 'rate-limited' || undefined}
					data-mono={mono(task) || undefined}>
					{line}
				</span>
				{branch && (
					<span className={s.meta}>
						<span className={s.branch}>
							<Icon name="branch" size={12} />
							<span className={`ell ${s.branchName}`}>{branch}</span>
						</span>
						<span className={s.space} />
						{counts && (counts.additions > 0 || counts.deletions > 0) && (
							<Counts additions={counts.additions} deletions={counts.deletions} />
						)}
					</span>
				)}
			</span>
		</button>
	);
});
/** spec/sidebar#done-rows: a completed task is a quiet 44 row: the tick, the title in --fg2, how long ago. */
export function QuietRow({
	task,
	locale,
	onOpen,
}: {
	task: AgentTask;
	locale: Locale;
	onOpen(task: AgentTask): void;
}) {
	return (
		<button
			type="button"
			className={s.quiet}
			data-quiet-row={task.id}
			aria-label={`${task.title} · ${t(locale, 'Completed task')}`}
			onClick={() => onOpen(task)}>
			<Icon name="tick" size={16} className={s.quietTick} />
			<span className={`ell ${s.quietTitle}`}>{task.title}</span>
			<span className={s.age}>{relativeAge(locale, task.completedAt ?? task.updatedAt)}</span>
		</button>
	);
}
/**
 * A crew's worker under its foreman's card (spec/crew#task-type, the computer's worker row): its state, `name · title`,
 * unread and the provider; the whole row opens the worker's chat (rule 15). Nested agents step in by 14, as on the computer.
 */
export function WorkerRow({
	row,
	locale,
	onOpen,
}: {
	row: CrewWorkerRow;
	locale: Locale;
	onOpen(task: AgentTask): void;
}) {
	const worker = row.task;
	return (
		<button
			type="button"
			className={s.worker}
			data-worker-row={worker.id}
			data-status={worker.status}
			data-amber={amber(worker) || undefined}
			style={{ paddingLeft: 42 + row.depth * 14 }}
			aria-label={`${crewLabel(locale, row.name)} · ${worker.title} · ${t(locale, statusLabels[worker.status])}`}
			onClick={() => onOpen(worker)}>
			<StatusIcon
				status={worker.status}
				question={worker.activity?.kind === 'question'}
				label={t(locale, statusLabels[worker.status])}
				size={16}
			/>
			<span className={`ell ${s.workerTitle}`}>
				<span className={s.workerName}>{crewLabel(locale, row.name)} · </span>
				{worker.title}
			</span>
			{worker.hasUnread && <i className={s.unread} aria-label={t(locale, 'Unread')} />}
			{row.provider && (
				<span className={s.provider}>
					<Glyph name={row.provider === 'claude' ? 'claude' : 'openai'} size={12} />
				</span>
			)}
		</button>
	);
}
export function QuietSeparator() {
	return <div className={s.separator} />;
}
/**
 * The project's frame (spec/sidebar#layout): the chevron folds it, the rest of the head — the dot, the name, the count — opens
 * the project's screen, «+» starts a task in it. The chevron's target reaches 44 pt over the frame's edge.
 */
export function ProjectFrame({
	name,
	color,
	count,
	waiting,
	collapsed,
	locale,
	onToggle,
	onOpen,
	onNew,
	newDisabled = false,
	children,
}: {
	/** The machine is away: no new task. */ newDisabled?: boolean;
	name: string;
	color: string;
	count: number;
	waiting: number;
	collapsed: boolean;
	locale: Locale;
	onToggle(): void;
	onOpen(): void;
	onNew(): void;
	children: ReactNode;
}) {
	return (
		<section className={s.frame} aria-label={name} data-project-frame={name}>
			<div className={s.frameHead}>
				<button
					type="button"
					className={s.frameFold}
					data-project-fold
					aria-expanded={!collapsed}
					aria-label={`${t(locale, collapsed ? 'Expand project' : 'Collapse project')} · ${name}`}
					onClick={onToggle}>
					<Icon name={collapsed ? 'chevr' : 'chev'} size={14} className={s.frameChevron} />
				</button>
				<button
					type="button"
					className={s.frameButton}
					data-project-open
					aria-label={`${name} · ${t(locale, 'Open project')}`}
					onClick={onOpen}>
					<i className={s.dot} style={{ background: color }} />
					<b className="ell">{name}</b>
					<span className={s.frameCount}>{count}</span>
					{collapsed && waiting > 0 && (
						<span className={s.frameWaiting}>
							<StatusIcon status="needs-you" label={t(locale, 'Needs you')} size={14} />
							{waiting}
						</span>
					)}
				</button>
				<button
					type="button"
					className={s.frameNew}
					aria-label={`${t(locale, 'New task')} · ${name}`}
					disabled={newDisabled}
					onClick={onNew}>
					<Icon name="plus" size={20} />
				</button>
			</div>
			{!collapsed && children}
		</section>
	);
}
/** «Waiting for you · N»: the amber row above the projects. */
export function AttentionBanner({
	count,
	kinds,
	locale,
	onClick,
}: {
	count: number;
	kinds: string;
	locale: Locale;
	onClick(): void;
}) {
	return (
		<button type="button" className={s.attention} data-attention onClick={onClick}>
			<StatusIcon status="needs-you" label={t(locale, 'Needs you')} size={18} />
			<span className={s.two}>
				<b>
					{t(locale, 'Waiting for you')} · {count}
				</b>
				<small>{kinds}</small>
			</span>
			<Icon name="chevr" size={16} className={s.attentionChevron} />
		</button>
	);
}
/** A banner: an icon, a title and a second line, an action; amber for attention, tint otherwise. */
export function Banner({
	icon,
	title,
	sub,
	action,
	data,
	amber = false,
}: {
	icon: ReactNode;
	title: ReactNode;
	sub?: ReactNode;
	action?: ReactNode;
	data?: string;
	/** Amber: something to do on the machine first (GitHub not signed in, spec/remote-access-and-mobile#phone-pr-list). */ amber?: boolean;
}) {
	return (
		<div
			className={s.banner}
			data-amber={amber || undefined}
			{...(data ? { [`data-${data}`]: '' } : {})}>
			{icon}
			<span className={s.two}>
				<b>{title}</b>
				{sub !== undefined && <small>{sub}</small>}
			</span>
			{action}
		</div>
	);
}
