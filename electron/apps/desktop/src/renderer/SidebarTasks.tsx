import { memo, useEffect, useId, useRef, useState } from 'react';
import {
	archiveSoon,
	attachmentCount,
	backgroundWorkCount,
	crewNeedsYou,
	crewWorkerRows,
	defaultArchiveAfterDays,
	specProviders,
	t,
	type AgentTask,
	type Locale,
} from '@brigadir/core';
import { cardTree, statusLabels, taskActivityText } from './task-line';
import { RateLimitTime } from './RateLimit';
import { crewLabel } from './Crew';
import { TitleMark } from './ui/TitleMark';
import { BranchName } from './ui/BranchName';
import { useBrowserLive } from './browser-live';
import { useWorkspace } from './store';
import { Glyph } from './ui/Glyph';
import { StatusIcon } from './ui/Controls';
import { ChangeCounts } from './ui/ChangeCounts';
import { Popover, useHoverPopover } from './ui/Popover';
import { TaskPreviewContent } from './ui/TaskPreviewContent';
import { collapseCrew, loadCollapsedCrews, useCrewCollapse } from './crew-collapse';
import { useWaitsForSimulator } from './simulator-waiting';
import styles from './App.module.css';
/* The sidebar's task row and crew card (spec/sidebar#layout, spec/crew#task-type, spec/appearance#evolution-redesign). The intro's sample window shows the same card at rest
   (`preview`, spec/settings-modules-and-onboarding#intro-steps, rule 17): nothing read through main, the crew expanded. */
/** spec/crew#task-type: the foreman header, a full-width line, worker rows inside; collapsed it shows the deck and the count. */
export function CrewCard({
	task,
	tasks,
	onMenu,
	onOpen,
	preview = false,
}: {
	task: AgentTask;
	tasks: readonly AgentTask[];
	onMenu(task: AgentTask): void;
	onOpen(task: AgentTask): void;
	/** spec/settings-modules-and-onboarding#intro-steps: the intro's sample — expanded, the saved folds not read. */ preview?: boolean;
}) {
	const { appearance, selectedTask } = useWorkspace();
	const locale = appearance.locale;
	const collapsed = useCrewCollapse((state) => state.collapsed.has(task.id)) && !preview;
	useEffect(() => {
		if (!preview) void loadCollapsedCrews();
	}, [preview]);
	const rows = crewWorkerRows(task, tasks),
		providers = task.crew ? specProviders(task.crew.root) : [],
		// spec/diff-and-review#agent-review-surfaces: a solo task's reviewers — the card has no helmet and counts reviewers.
		reviewOnly = !task.crew;
	// spec/appearance#evolution-redesign: a collapsed crew says what its workers do when the foreman has no activity line.
	const working = rows.filter(
			(row) => !['done', 'completed', 'backlog'].includes(row.task.status)
		).length,
		finished = rows.filter((row) => ['done', 'completed'].includes(row.task.status)).length;
	const summary = collapsed
		? [
				working ? t(locale, '{n} working').replace('{n}', String(working)) : '',
				finished ? t(locale, '{n} done (workers)').replace('{n}', String(finished)) : '',
			]
				.filter(Boolean)
				.join(' · ')
		: '';
	// spec/crew#attention: a worker waiting for the person lifts needs-you onto the header, expanded or collapsed.
	const waiting = crewNeedsYou(task, tasks);
	return (
		<div
			className={styles.crewCard}
			data-crew-card={task.id}
			data-status={task.status}
			data-collapsed={collapsed}
			data-crew-attention={waiting ? 'needs-you' : undefined}>
			<div className={styles.crewHeader}>
				<TaskRow
					task={task}
					preview={preview}
					crewAttention={waiting}
					onMenu={onMenu}
					onOpen={onOpen}
					{...(summary ? { summary } : {})}
					{...(reviewOnly
						? {}
						: {
								lead: (
									<span className={styles.crewHelmet} title={t(locale, 'Brigadir')}>
										<Glyph name="helmet" size={15} />
									</span>
								),
							})}
					tail={
						<>
							{collapsed &&
								providers.slice(0, 2).map((provider) => (
									<span
										key={provider}
										className={styles.crewProvider}
										title={t(locale, provider === 'claude' ? 'Claude' : 'Codex')}>
										<Glyph name={provider === 'claude' ? 'claude' : 'openai'} size={11} />
									</span>
								))}
							<span
								className={styles.crewCount}
								title={t(locale, reviewOnly ? 'Reviewers' : 'Workers')}>
								{rows.length}
							</span>
							<span className={styles.crewChevronSpace} />
						</>
					}
				/>
				<button
					type="button"
					className={styles.crewChevron}
					aria-expanded={!collapsed}
					aria-label={t(locale, collapsed ? 'Expand crew' : 'Collapse crew')}
					title={t(locale, collapsed ? 'Expand crew' : 'Collapse crew')}
					// A click with the mouse does not take focus, so no ring is left behind (the keyboard still reaches it).
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => collapseCrew(task.id, !collapsed, locale)}>
					<Glyph name="sidebar-chevron" size={10} />
				</button>
			</div>
			{!collapsed && rows.length > 0 && (
				<div className={styles.crewWorkers} data-crew-workers>
					{rows.map((row) => (
						<WorkerRow
							key={row.task.id}
							row={row}
							selected={
								selectedTask?.id === row.task.id && selectedTask.projectId === row.task.projectId
							}
							locale={locale}
							onOpen={onOpen}
							onMenu={onMenu}
						/>
					))}
				</div>
			)}
		</div>
	);
}
/** One worker line of a crew card; its own component so each line keeps its spec/notifications-slack-notes-and-schedules#macos-permission attention. */
function WorkerRow({
	row,
	selected,
	locale,
	onOpen,
	onMenu,
}: {
	row: ReturnType<typeof crewWorkerRows>[number];
	selected: boolean;
	locale: Locale;
	onOpen(task: AgentTask): void;
	onMenu(task: AgentTask): void;
}) {
	const worker = row.task,
		activity = worker.activity,
		{ attention, beat } = useAttention(worker.status, selected),
		waitsForSimulator = useWaitsForSimulator(worker.projectId, worker.id);
	const button = useRef<HTMLButtonElement>(null),
		title = useRef<HTMLSpanElement>(null),
		previewId = useId(),
		truncated = () => !!title.current && title.current.scrollWidth > title.current.clientWidth,
		hover = useHoverPopover({ delay: 1000, canPreview: truncated });
	useEffect(() => {
		if (!hover.open || !title.current) return;
		if (!truncated()) {
			hover.close();
			return;
		}
		const observer = new ResizeObserver(() => {
			if (!truncated()) hover.close();
		});
		observer.observe(title.current);
		return () => observer.disconnect();
	}, [hover.open, worker.title, row.name]);
	return (
		<>
			<button
				ref={button}
				{...hover.trigger}
				type="button"
				className={styles.workerRow}
				data-sidebar-task={worker.id}
				data-depth={row.depth}
				// Nested crews: 14 px a level; a nested foreman's row opens its level, its helmet first.
				style={{ paddingLeft: 6 + (row.depth + (row.role === 'foreman' ? 1 : 0)) * 14 }}
				data-status={worker.status}
				data-attention={attention ?? undefined}
				data-attention-beat={beat}
				aria-pressed={selected}
				aria-describedby={hover.open ? previewId : undefined}
				onClick={() => {
					hover.close();
					onOpen(worker);
				}}
				onContextMenu={(event) => {
					hover.close();
					event.preventDefault();
					onMenu(worker);
				}}>
				{row.role === 'foreman' && (
					<span className={styles.workerHelmet} title={t(locale, 'Brigadir')}>
						<Glyph name="helmet" size={12} />
					</span>
				)}
				<span className={styles.workerIcon}>
					<StatusIcon
						status={worker.status}
						question={activity?.kind === 'question'}
						label={t(locale, statusLabels[worker.status])}
						size={13}
					/>
				</span>
				<span className={styles.workerCopy}>
					<span ref={title} className={styles.workerTitle}>
						<span>{crewLabel(locale, row.name)} · </span>
						{worker.title}
					</span>
					{/* spec/agents-and-providers#tools-awareness: the activity line of a task card, while the worker waits for the project's one device. */}
					{waitsForSimulator && (
						<small data-task-activity data-simulator-wait>
							{t(locale, 'Waiting for the simulator')}
						</small>
					)}
				</span>
				{worker.hasUnread && (
					<span
						className={styles.unread}
						aria-label={t(locale, 'Unread')}
						title={t(locale, 'Unread')}
					/>
				)}
				{row.provider && (
					<span
						className={styles.workerProvider}
						title={t(locale, row.provider === 'claude' ? 'Claude' : 'Codex')}>
						<Glyph name={row.provider === 'claude' ? 'claude' : 'openai'} size={11} />
					</span>
				)}
			</button>
			<Popover
				id={previewId}
				open={hover.open}
				onClose={hover.close}
				anchor={button}
				label={t(locale, 'Task')}
				locale={locale}
				width={420}
				closeOnScroll
				data-worker-preview={worker.id}
				{...hover.popover}>
				<TaskPreviewContent
					task={worker}
					agent={crewLabel(locale, row.name)}
					status={t(locale, statusLabels[worker.status])}
					provider={row.provider ?? worker.provider}
					locale={locale}
				/>
			</Popover>
		</>
	);
}
/**
 * spec/notifications-slack-notes-and-schedules#macos-permission: which attention a row plays, set only on a live status change while the row is mounted,
 * so the first render, a reload or expanding a project never animates. Read in render: no extra frame.
 */
type Attention = 'turn-ended' | 'needs-you';
const attentionRepeatMs = window.brigadir.testAttentionMs ?? 30_000;
/**
 * spec/crew#attention: a row that waits for the person flashes again every 30 s until the person has seen it: the task was selected
 * in a focused window. `beat` alternates the keyframes, which is what restarts a CSS animation.
 */
function useAttention(
	status: AgentTask['status'],
	selected: boolean
): { attention: Attention | null; beat: 0 | 1 | undefined } {
	const previous = useRef(status),
		attention = useRef<Attention | null>(null),
		seen = useRef(false),
		[beats, setBeats] = useState(0);
	if (previous.current !== status) {
		previous.current = status;
		attention.current =
			status === 'done' ? 'turn-ended' : status === 'needs-you' ? 'needs-you' : null;
		seen.current = false;
	}
	useEffect(() => {
		if (status !== 'needs-you') return;
		const look = () => {
			if (selected && document.hasFocus()) seen.current = true;
		};
		look();
		window.addEventListener('focus', look);
		const timer = setInterval(() => {
			look();
			if (!seen.current) setBeats((count) => count + 1);
		}, attentionRepeatMs);
		return () => {
			window.removeEventListener('focus', look);
			clearInterval(timer);
		};
	}, [status, selected]);
	const repeating = status === 'needs-you' && beats > 0;
	return {
		attention: repeating ? 'needs-you' : attention.current,
		beat: repeating ? ((beats % 2) as 0 | 1) : undefined,
	};
}
/** A sidebar row re-renders only for its own task, locale and selection: a workspace reload keeps unchanged task objects (store) and callbacks are stable. */
export const TaskRow = memo(function TaskRow({
	task,
	onMenu,
	onOpen,
	tail,
	lead,
	summary,
	crewAttention = false,
	preview = false,
}: {
	task: AgentTask;
	onMenu(task: AgentTask): void;
	onOpen(task: AgentTask): void;
	tail?: React.ReactNode;
	/** Before the title: the crew's helmet (spec/appearance#evolution-redesign). */ lead?: React.ReactNode;
	/** The second line when nothing else is there: a collapsed crew's «2 working · 1 done». */ summary?: string;
	crewAttention?: boolean;
	/** spec/settings-modules-and-onboarding#intro-steps: the intro's sample — no live browser state from main. */ preview?: boolean;
}) {
	const locale = useWorkspace((state) => state.appearance.locale),
		selected = useWorkspace(
			(state) =>
				state.selectedTask?.id === task.id && state.selectedTask.projectId === task.projectId
		);
	const handleSelect = () => onOpen(task),
		activity = task.activity,
		browserLive = useBrowserLive(task, !preview);
	const activityText = taskActivityText(locale, task);
	const counts = task.changeSummary,
		tree = cardTree(locale, task),
		{ attention, beat } = useAttention(task.status, selected);
	const activityShown =
		task.status === 'working' ||
		task.status === 'needs-you' ||
		task.status === 'preparing' ||
		!!task.blockedBy?.length;
	// spec/appearance#evolution-redesign, spec/sidebar#repos: the task's open PR after the changes, e.g. `#503`.
	const pr = Object.values(task.pullRequests ?? {}).find((item) => item.state === 'OPEN');
	// spec/tasks#archive: a completed card that leaves for the archive within a day shows a clock in its title line.
	const soon = archiveSoon(
		task,
		useWorkspace((state) => state.appearance.archiveAfterDays) ?? defaultArchiveAfterDays,
		Date.now()
	);
	// spec/agents-and-providers#sign-in-recovery: a failure on the agent's sign-in says which sign-in, with the amber key.
	const signIn = task.status === 'failed' && task.failure === 'auth',
		statusText = signIn
			? t(locale, '{agent} sign-in needed').replace(
					'{agent}',
					task.provider === 'codex' ? 'Codex' : 'Claude'
				)
			: t(locale, statusLabels[task.status]);
	return (
		<button
			className={styles.task}
			data-sidebar-task={task.id}
			data-sidebar-order={`${task.projectId}/${task.id}`}
			data-pinned={!!task.pinned}
			data-status={task.status}
			data-quiet-run={task.scheduleRun?.quiet || undefined}
			data-crew-attention={crewAttention ? 'needs-you' : undefined}
			data-attention={attention ?? undefined}
			data-attention-beat={beat}
			title={`${task.title}${task.pinned ? ' · ' + t(locale, 'Pinned') : ''} · ${statusText}`}
			aria-pressed={selected}
			onClick={handleSelect}
			onContextMenu={(event) => {
				event.preventDefault();
				onMenu(task);
			}}
			onKeyDown={(event) => {
				if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
					event.preventDefault();
					onMenu(task);
				}
			}}>
			<StatusIcon
				status={task.status}
				question={activity?.kind === 'question'}
				signIn={signIn}
				label={statusText}
				size={16}
			/>
			<span className={styles.taskCopy}>
				<span className={styles.taskHead}>
					{lead}
					<span className={styles.taskTitle}>{task.title}</span>
					{task.status === 'rate-limited' && (
						<RateLimitTime resetsAt={task.rateLimit?.resetsAt ?? null} locale={locale} />
					)}
					{task.hasUnread && (
						<span
							className={styles.unread}
							aria-label={t(locale, 'Unread')}
							title={t(locale, 'Unread')}
						/>
					)}
					{soon && (
						<TitleMark
							icon="clock"
							data-archive-soon={soon}
							title={t(
								locale,
								soon === 'today' ? 'Goes to the archive today' : 'Goes to the archive tomorrow'
							)}
						/>
					)}
					{/* spec/notifications-slack-notes-and-schedules#schedules: a run of a schedule carries the schedule glyph in its title line. */}
					{task.scheduleRun && (
						<TitleMark icon="schedule" data-schedule-run title={t(locale, 'Schedule')} />
					)}
					{/* spec/browser-and-simulator#background: the agent works with this task's page off screen. */}
					{browserLive && (
						<TitleMark
							icon="browser"
							tone="accent"
							data-browser-live
							title={t(locale, 'Agent in the browser')}
						/>
					)}
					{tail ??
						(task.provider && (
							<span
								className={styles.provider}
								title={t(locale, task.provider === 'claude' ? 'Claude' : 'Codex')}>
								<Glyph name={task.provider === 'claude' ? 'claude' : 'openai'} size={11} />
							</span>
						))}
				</span>
				{signIn && (
					<small data-task-activity data-sign-in title={statusText}>
						{statusText}
					</small>
				)}
				{(task.status === 'working' ||
					task.status === 'needs-you' ||
					task.status === 'preparing' ||
					!!task.blockedBy?.length) && (
					<small
						data-task-activity
						title={
							activity?.path
								? [activity.title, activity.path].filter(Boolean).join(' · ')
								: activityText
						}>
						{activityText}
					</small>
				)}
				{task.background &&
					!(
						task.status === 'working' ||
						task.status === 'needs-you' ||
						task.status === 'preparing' ||
						!!task.blockedBy?.length
					) &&
					(() => {
						// spec/chat-turns-plans-and-questions#background-subagents: one subagent reads «Subagent <name>»; several items as their counts.
						const { count, name, subagents = 0 } = task.background;
						const text = t(locale, 'In the background · {name}').replace(
							'{name}',
							name === null
								? backgroundWorkCount(locale, count, subagents)
								: subagents
									? t(locale, 'Subagent {name}').replace('{name}', name)
									: name
						);
						return (
							<small data-task-background className={styles.taskBackground} title={text}>
								<Glyph name="agent-run" size={11} />
								<span>{text}</span>
							</small>
						);
					})()}
				{summary && !activityShown && !task.background && (
					<small data-crew-summary>{summary}</small>
				)}
				{tree ? (
					<span
						className={styles.taskTree}
						data-task-tree
						data-planned={tree === task.taskTree ? undefined : true}>
						<Glyph name={tree.worktree ? 'sidebar-worktree' : 'sidebar-branch'} size={11} />
						{/* spec/appearance#evolution-redesign: the whole name with its prefix, the middle goes when it does not fit. */}
						{tree.branch ? (
							<BranchName
								className={styles.taskBranchName}
								name={tree.branch}
								title={`${t(locale, tree.worktree ? 'Worktree' : 'Branch')} · ${tree.branch}`}
							/>
						) : (
							<span className={styles.taskBranch} data-detached>
								{t(locale, 'Detached HEAD')}
							</span>
						)}
						{counts && (counts.additions > 0 || counts.deletions > 0) && (
							<ChangeCounts
								additions={counts.additions}
								deletions={counts.deletions}
								locale={locale}
								className={styles.taskCounts}
								data-task-counts
							/>
						)}
						{pr && (
							<span
								className={styles.taskPR}
								data-task-pr={pr.number}
								title={`PR #${pr.number} · ${pr.title}`}>
								#{pr.number}
							</span>
						)}
						{task.hasUnreviewedChanges && (
							<span
								className={styles.taskUnreviewed}
								aria-label={t(locale, 'Unreviewed')}
								title={t(locale, 'Unreviewed')}>
								<Glyph name="sidebar-unreviewed" size={12} />
							</span>
						)}
					</span>
				) : (
					task.status === 'backlog' && (
						<span className={styles.backlogLine}>
							<small className={styles.noBranch}>{t(locale, 'no branch · queued')}</small>
							{/* spec/tasks#backlog-edit */}
							{!!task.attachments?.length && (
								<span
									className={styles.taskClip}
									data-attachment-count={task.attachments.length}
									title={attachmentCount(locale, task.attachments.length)}
									aria-label={attachmentCount(locale, task.attachments.length)}>
									<Glyph name="paperclip" size={11} />
									{new Intl.NumberFormat(locale).format(task.attachments.length)}
								</span>
							)}
						</span>
					)
				)}
			</span>
		</button>
	);
});
