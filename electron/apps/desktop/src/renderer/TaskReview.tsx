import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import {
	commentCount,
	emptyTaskReviewView,
	fileCount,
	findingCount,
	formatDuration,
	gapCount,
	planFindingList,
	isMainTree,
	providerName,
	reviewPoints,
	t,
	taskReviewAt,
	taskReviewCounts,
	taskReviewLive,
	taskReviewRunning,
	taskReviewStep,
	type AgentTask,
	type EventRecord,
	type Locale,
	type MessageKey,
	type PlanFindingKind,
	type PlanFindingList,
	type ReviewPoint,
	type TaskKey,
	type TaskReview,
	type TaskReviewCommentRow,
	type TaskReviewFindingState,
	type TaskReviewMember,
	type TaskReviewView,
} from '@brigadir/core';
import { onSessionEvent } from './session-events';
import { openTaskEditor } from './task-state';
import { openReviewLaunch } from './ReviewLaunch';
import { useHelperSettings } from './HelperAgent';
import { useForge } from './Forge';
import { DeckList, DeckRow } from './ui/Deck';
import { Button, IconButton, Segments } from './ui/Controls';
import { Glyph, type GlyphName } from './ui/Glyph';
import { StepTrack } from './ui/StepTrack';
import { ChatCard, ChatCardChip, ChatCardChips } from './ui/ChatCard';
import { ChangeCounts } from './ui/ChangeCounts';
import { useSecondTick } from './ui/second-tick';
import { toastError } from './ui/Toast';
import styles from './TaskReview.module.css';
// The review's chat rows are the crew's service rows (rule 17).
import service from './Crew.module.css';

/**
 * spec/reviews#strip: one view of a task's reviews for every surface of the window — the strip with its step track, the chat rows, the Changes
 * button, the PR sheet and the sidebar. Read from main and read again when the task's journal says a review moved.
 */
type ReviewStore = {
	views: Record<string, TaskReviewView>;
	/** The strip is open (the chevron, a step, or a findings count clicked in the chat). */
	open: Record<string, boolean>;
	/** The point whose findings the open strip shows; absent — the current review's. */
	step: Record<string, ReviewPoint>;
	/** The strip was closed with × after the review ended; it comes back with the next review. */
	hidden: Record<string, string>;
};
const useReviewStore = create<ReviewStore>(() => ({ views: {}, open: {}, step: {}, hidden: {} }));
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const moves = new Set([
	'review.proposed',
	'review.dismissed',
	'review.started',
	'review.finished',
	'review.replied',
	'source.saved',
	'task-review.started',
	'task-review.findings',
	'task-review.answered',
	'task-review.verified',
	'task-review.decided',
	'task-review.finished',
	'crew.review',
	'crew.worker.created',
	'checkpoint.created',
	'turn.completed',
	'turn.started',
]);
function load(key: TaskKey) {
	const id = name(key);
	return window.brigadir.readTaskReview(key).then(
		(view) => useReviewStore.setState((state) => ({ views: { ...state.views, [id]: view } })),
		() => {}
	);
}
/** The reviews of `task`, kept current while the component lives. Main-tree tasks have none. */
export function useTaskReview(task: TaskKey | null): TaskReviewView {
	const id = task ? name(task) : '';
	const view = useReviewStore((state) => (id ? state.views[id] : undefined));
	useEffect(() => {
		if (!task || isMainTree(task)) return;
		void load(task);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id !== task.id || key.projectId !== task.projectId) return;
			if (record && !moves.has(record.event.kind)) return;
			clearTimeout(timer);
			timer = setTimeout(() => void load(task), 300);
		});
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, [id]);
	return view ?? emptyTaskReviewView;
}
/** Opens (or closes) the strip; `point` picks whose findings it shows. */
export function openReviewStrip(task: TaskKey, open = true, point?: ReviewPoint) {
	const id = name(task);
	useReviewStore.setState((state) => {
		const { [id]: _, ...rest } = state.step;
		return {
			open: { ...state.open, [id]: open },
			step: point ? { ...state.step, [id]: point } : rest,
		};
	});
}
const agentName = (task: AgentTask) => (task.provider ? providerName(task.provider) : 'Agent');
/** spec/reviews#strip: the point in a line and in the steps. */
const pointLine: Record<ReviewPoint, MessageKey> = {
	plan: 'plan',
	mid: 'mid-task',
	'pre-pr': 'before PR',
};
const pointStep: Record<ReviewPoint, MessageKey> = {
	plan: 'Plan review',
	mid: 'Mid-task review',
	'pre-pr': 'Review before PR',
};
const pointSegment: Record<ReviewPoint, MessageKey> = {
	plan: 'Plan',
	mid: 'Mid-task',
	'pre-pr': 'Before PR',
};
/** The launch dialog of a task's review before the PR (spec/reviews#start). */
export function openTaskReviewLaunch(task: AgentTask, view: TaskReviewView) {
	openReviewLaunch({
		kind: 'task',
		projectId: task.projectId,
		taskId: task.id,
		title: task.title,
		changes: view.changes,
		last:
			view.review && view.sinceLast && view.review.round
				? { files: view.sinceLast, round: view.review.round }
				: null,
		agent: agentName(task),
		start: async (choice) => {
			const reason = await window.brigadir.startTaskReview(task, choice);
			if (reason === null) {
				openReviewStrip(task, false);
				void load(task);
			}
			return reason;
		},
	});
}
/** spec/reviews#start: a review that starts at once with the resolved reviewer. Resolves the reason it did not start, else null. */
async function startNow(
	task: AgentTask,
	locale: Locale,
	point: ReviewPoint = 'pre-pr',
	startedBy: 'person' | 'host' = 'person'
) {
	const reason = await window.brigadir
		.startTaskReview(task, { agent: null, crew: null, notes: '', since: 'start', point, startedBy })
		.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
	void load(task);
	if (reason !== null && startedBy === 'person')
		toastError(`${t(locale, 'Could not start the review')}: ${reason}`, {
			action: { label: t(locale, 'Retry'), run: () => void startNow(task, locale, point) },
		});
	return reason;
}
/**
 * spec/reviews#before-pr: `Create PR` on a task whose changes no review before the PR covered starts that review instead of the dialog, and
 * expands the strip; a running review expands the strip; a review that cannot start lets the dialog open. Returns whether the dialog opens.
 */
export async function reviewBeforePR(task: AgentTask, locale: Locale): Promise<boolean> {
	if (isMainTree(task) || task.readOnlyAgent) return true;
	const view = await window.brigadir.readTaskReview(task).catch(() => null);
	if (!view || view.beforePR === 'covered') return true;
	openReviewStrip(task, true, 'pre-pr');
	if (view.beforePR === 'running') return false;
	useReviewStore.setState((state) => {
		const { [name(task)]: _, ...hidden } = state.hidden;
		return { hidden };
	});
	if ((await startNow(task, locale, 'pre-pr', 'host')) === null) return false;
	// Only a review that could not start for want of a reviewer lets the dialog open; a refusal (one already runs) does not.
	const after = await window.brigadir.readTaskReview(task).catch(() => null);
	return after?.review?.point === 'pre-pr' && after.review.state === 'failed';
}
/**
 * spec/reviews#strip: `Retry` on a review that did not start. A review whose reviewer failed to start still lives on the host (it waits for
 * the read), so it is stopped first and a new one starts; the person fixes the sign-in and retries.
 */
export async function retryReview(
	task: TaskKey,
	review: { point: ReviewPoint; state: TaskReview['state'] },
	bridge: Pick<typeof window.brigadir, 'stopTaskReview' | 'startTaskReview'> = window.brigadir
): Promise<string | null> {
	if (taskReviewLive(review as TaskReview)) await bridge.stopTaskReview(task).catch(() => {});
	return bridge.startTaskReview(task, {
		agent: null,
		crew: null,
		notes: '',
		since: 'start',
		point: review.point,
	});
}
/** spec/reviews#start: who reviews unless the person chooses — the remembered crew or agent of `Code reviews`, else `Auto`. */
function useRememberedWho(locale: Locale) {
	const settings = useHelperSettings();
	const crew = settings?.actionCrews.taskReview,
		agent = settings?.actionAgents.taskReview;
	return crew ? crew.name : agent?.name ? agent.name : t(locale, 'Auto');
}

// ── chat ────────────────────────────────────────────────────────────────

/** The card the agent's `propose_review` leaves in the chat; after `Not now` or a later turn, the row `Review skipped`. */
export function ReviewProposalRow({
	task,
	record,
	records,
	locale,
	disabled,
}: {
	task: AgentTask;
	record: EventRecord;
	records: readonly EventRecord[];
	locale: Locale;
	disabled: boolean;
}) {
	const view = useTaskReview(task),
		who = useRememberedWho(locale),
		[busy, setBusy] = useState(false);
	const e = record.event;
	if (e.kind !== 'review.proposed') return null;
	const later = records.filter((item) => item.seq > record.seq);
	if (
		later.some(
			(item) => item.event.kind === 'review.started' || item.event.kind === 'task-review.started'
		)
	)
		return null;
	const latest = !later.some((item) => item.event.kind === 'review.proposed');
	if (latest && view.proposal && !taskReviewLive(view.review))
		return (
			<ChatCard
				aria-label={t(locale, 'Ready for review')}
				data-review-proposal
				glyph="review"
				title={t(locale, 'Ready for review')}
				waiting
				hint={t(locale, '{agent} thinks the task is done').replace('{agent}', agentName(task))}
				note={who}
				actions={
					<>
						<Button
							variant="ghost"
							disabled={disabled || busy}
							onClick={() => void window.brigadir.dismissTaskReview(task).catch(() => {})}>
							{t(locale, 'Not now')}
						</Button>
						<Button disabled={busy} onClick={() => openTaskReviewLaunch(task, view)}>
							{t(locale, 'Options…')}
						</Button>
						<Button
							appearance="primary"
							disabled={disabled || busy}
							onClick={() => {
								setBusy(true);
								void startNow(task, locale).finally(() => setBusy(false));
							}}>
							{t(locale, 'Start review')}
						</Button>
					</>
				}>
				{e.summary && <p className={styles.summary}>{e.summary}</p>}
				{view.changes.files > 0 && (
					<ChatCardChips>
						<ChatCardChip>
							<Glyph name="diff" size={12} />
							<span>{fileCount(locale, view.changes.files)}</span>
							<ChangeCounts
								additions={view.changes.additions}
								deletions={view.changes.deletions}
								locale={locale}
							/>
						</ChatCardChip>
						{task.launch?.branch && (
							<ChatCardChip title={task.launch.branch}>
								<Glyph name="pr-branch" size={12} />
								<span>{task.launch.branch}</span>
							</ChatCardChip>
						)}
					</ChatCardChips>
				)}
			</ChatCard>
		);
	return (
		<div className={styles.skipped} data-review-skipped>
			<Glyph name="review" size={12} />
			<span>{t(locale, 'Review skipped')}</span>
			<Button
				size="s"
				variant="ghost"
				appearance="primary"
				disabled={disabled || taskReviewLive(view.review)}
				onClick={() => openTaskReviewLaunch(task, view)}>
				{t(locale, 'Start review')}
			</Button>
		</div>
	);
}
/** A findings count that opens the strip on its findings (spec/reviews#strip). */
function CountLink({
	task,
	count,
	locale,
	point,
	legacy = false,
	gaps = false,
}: {
	task: TaskKey;
	count: number;
	locale: Locale;
	point?: ReviewPoint | undefined;
	/** An older journal's round row says `comments`. */
	legacy?: boolean;
	/** spec/reviews#plan-verdict: the count of a plan review's gaps in the ticket. */
	gaps?: boolean;
}) {
	return (
		<button
			type="button"
			className={styles.count}
			onClick={() => openReviewStrip(task, true, point)}>
			{legacy
				? commentCount(locale, count)
				: gaps
					? gapCount(locale, count)
					: findingCount(locale, count)}
		</button>
	);
}
function Row({
	state,
	glyph = 'review',
	children,
}: {
	state: string;
	glyph?: GlyphName;
	children: ReactNode;
}) {
	return (
		<div className={service.service} data-review-row={state}>
			<Glyph name={glyph} size={12} />
			{children}
		</div>
	);
}
/** spec/reviews#strip: the reviews' service rows in the chat — and the older rows of journals written before them. */
export function ReviewEventRow({
	task,
	record,
	locale,
}: {
	task: AgentTask;
	record: EventRecord;
	locale: Locale;
}) {
	const e = record.event,
		agent = agentName(task);
	const head = (point: ReviewPoint) => (
		<>
			<small>{t(locale, 'review')}</small>
			<small>{t(locale, pointLine[point])}</small>
		</>
	);
	switch (e.kind) {
		case 'task-review.started':
			return (
				<Row state="started">
					{head(e.point)}
					<span className={service.label}>
						{e.reviewers.join(', ')}
						{e.reason ? ` · ${t(locale, 'after {reason}').replace('{reason}', e.reason)}` : ''}
					</span>
					<small>{t(locale, 'started')}</small>
				</Row>
			);
		case 'task-review.findings':
			return (
				<Row
					state={e.findings ? 'findings' : 'passed'}
					glyph={e.findings ? 'review' : 'check-pass'}>
					{head(e.point)}
					<span className={service.label}>
						{e.findings ? `${e.reviewers.join(', ')} → ${agent}` : e.reviewers.join(', ')}
					</span>
					{e.findings ? (
						<CountLink task={task} count={e.findings} locale={locale} point={e.point} />
					) : (
						<small className={service.ok}>{t(locale, 'passed')}</small>
					)}
					{/* spec/reviews#plan-verdict: the ticket's gaps go to the person, not to the author. */}
					{!!e.gaps && (
						<small>
							· <CountLink task={task} count={e.gaps} locale={locale} point={e.point} gaps />
						</small>
					)}
				</Row>
			);
		case 'task-review.answered':
			return (
				<Row state="answered">
					{head(e.point)}
					<span className={service.label}>{agent}</span>
					<small>
						{t(locale, '{n} fixed').replace('{n}', String(e.fixed))} ·{' '}
						{t(locale, '{n} answered').replace('{n}', String(e.answered))}
					</small>
				</Row>
			);
		case 'task-review.verified':
			return (
				<Row
					state={e.open + e.introduced ? 'open' : 'passed'}
					glyph={e.open + e.introduced ? 'agent-question' : 'check-pass'}>
					{head(e.point)}
					{e.open + e.introduced ? (
						<small className={service.warn}>
							{t(locale, '{count} open').replace(
								'{count}',
								findingCount(locale, e.open + e.introduced)
							)}
						</small>
					) : (
						<small className={service.ok}>{t(locale, 'passed')}</small>
					)}
				</Row>
			);
		case 'task-review.decided':
			return (
				<Row state={e.decision}>
					{head(e.point)}
					<span className={service.label}>
						{e.decision === 'fix'
							? t(locale, 'Fix {n}').replace('{n}', String(e.findings))
							: t(locale, 'accepted')}
					</span>
					<small>{t(locale, 'by you')}</small>
				</Row>
			);
		case 'task-review.finished':
			// spec/reviews#plan-loop: the plan's approval ended the review, with its findings still open.
			if (e.approval)
				return (
					<Row state="approval">
						{head(e.point)}
						<span className={service.label}>{t(locale, 'ended by the approval')}</span>
						{!!e.open && (
							<small className={service.warn}>
								{t(locale, '{count} open').replace('{count}', findingCount(locale, e.open))}
							</small>
						)}
					</Row>
				);
			if (e.state === 'stopped' || e.state === 'failed' || e.state === 'outdated')
				return (
					<Row state={e.state} glyph={e.state === 'failed' ? 'agent-failed' : 'review'}>
						{head(e.point)}
						<span className={service.label}>
							{t(
								locale,
								e.state === 'stopped'
									? 'stopped by you'
									: e.state === 'failed'
										? 'did not start'
										: 'changed after the review'
							)}
						</span>
					</Row>
				);
			return null;
		// Journals written before the loop of spec/reviews#loop keep their rows.
		case 'review.started':
			return (
				<div className={service.service} data-review-row="started">
					<Glyph name="review" size={12} />
					<small>{t(locale, 'review')}</small>
					<span className={service.label}>
						{e.who.kind === 'crew' ? `${e.who.name} · ` : ''}
						{e.reviewers.join(', ')}
					</span>
					<small>{t(locale, 'round {n} of 2').replace('{n}', '1')}</small>
					<small>{t(locale, 'started')}</small>
				</div>
			);
		case 'crew.review':
			if (e.taskId !== task.id || e.state === 'reviewing') return null;
			return (
				<div className={service.service} data-review-row={e.state}>
					<Glyph name={e.state === 'approved' ? 'check-pass' : 'review'} size={12} />
					<small>{t(locale, 'review')}</small>
					<span className={service.label}>
						{e.state === 'comments' ? `${e.reviewer} → ${agent}` : e.reviewer}
						{e.state === 'approved' && ` · ${t(locale, 'approved')}`}
					</span>
					<small>{t(locale, 'round {n} of 2').replace('{n}', String(e.round))}</small>
					{e.state === 'approved' ? (
						<small className={service.ok}>{t(locale, 'passed')}</small>
					) : e.state === 'disputed' ? (
						<small className={service.warn}>{t(locale, 'disputed')}</small>
					) : (
						<CountLink task={task} count={e.comments} locale={locale} legacy />
					)}
				</div>
			);
		case 'review.finished':
			if (e.state !== 'stopped' && e.state !== 'outdated') return null;
			return (
				<div className={service.service} data-review-row={e.state}>
					<Glyph name="review" size={12} />
					<small>{t(locale, 'review')}</small>
					<span className={service.label}>
						{t(locale, e.state === 'stopped' ? 'stopped by you' : 'changed after the review')}
					</span>
				</div>
			);
		default:
			return null;
	}
}

// ── the strip over the composer ─────────────────────────────────────────────

export type ReviewStripState =
	'reading' | 'fixing' | 'verifying' | 'yours' | 'passed' | 'accepted' | 'stopped' | 'failed';
/** spec/reviews#strip: the strip's state from the current review and its reviewers; null — no row. */
export function reviewStripState(view: TaskReviewView): ReviewStripState | null {
	const review = view.review;
	if (!review) return null;
	if (
		review.state === 'failed' ||
		(taskReviewRunning(review) && view.members.some((member) => member.state === 'failed'))
	)
		return 'failed';
	switch (review.state) {
		case 'waiting':
		case 'reading':
			return 'reading';
		case 'fixing':
		case 'verifying':
		case 'yours':
		case 'passed':
		case 'accepted':
		case 'stopped':
			return review.state;
		default:
			return null;
	}
}
function memberText(member: TaskReviewMember, locale: Locale, now: number) {
	const time =
		member.since && (member.state === 'reading' || member.state === 'checking')
			? ` · ${formatDuration(locale, Math.max(0, Math.floor((now - Date.parse(member.since)) / 1000) * 1000))}`
			: '';
	switch (member.state) {
		case 'starting':
			return t(locale, 'starting');
		case 'reading':
			return `${t(locale, 'reading')}${time}`;
		case 'checking':
			return `${t(locale, 'checking')}${time}`;
		case 'findings':
			return findingCount(locale, member.findings);
		case 'open':
			return t(locale, '{count} open').replace('{count}', findingCount(locale, member.findings));
		case 'approved':
			return t(locale, 'approved');
		case 'stopped':
			return t(locale, 'stopped');
		case 'failed':
			return member.failure ?? t(locale, 'did not start');
	}
}
const stepGlyph = {
	none: ['agent-backlog', 'muted'],
	live: ['agent-spinner', undefined],
	yours: ['agent-question', 'amber'],
	done: ['check-pass', 'green'],
	ended: ['stop', 'muted'],
} as const;
const stepState: Record<keyof typeof stepGlyph, MessageKey> = {
	none: 'not started',
	live: 'running',
	yours: 'Your call',
	done: 'passed',
	ended: 'stopped',
};
/**
 * spec/reviews#strip: the strip's row and its open sections, from props only (the strip and its tests). `onDecide`, `onStop`, `onRetry`,
 * `onAgain` and `onCreatePR` act; `onToggle` opens or closes, `onStep` picks a point.
 */
export function ReviewStripView({
	task,
	view,
	locale,
	open,
	point,
	now,
	disabled,
	onToggle,
	onStep,
	onStop,
	onDecide,
	onRetry,
	onAgain,
	onCreatePR,
	onHide,
	onComment,
	onReviewer,
	onSource,
	planWaiting = false,
	onPlanAgain,
}: {
	task: AgentTask;
	view: TaskReviewView;
	locale: Locale;
	open: boolean;
	point: ReviewPoint | null;
	now: number;
	disabled: boolean;
	/** spec/reviews#plan-start: a plan waits for the person — a finished plan review offers `Review again`. */
	planWaiting?: boolean;
	onPlanAgain?: () => void;
	onSource?: (id: string) => void;
	onToggle(open: boolean): void;
	onStep(point: ReviewPoint): void;
	onStop(): void;
	onDecide(decision: 'fix' | 'accept'): void;
	onRetry(): void;
	onAgain(): void;
	onCreatePR(): void;
	onHide(): void;
	onComment(comment: TaskReviewCommentRow): void;
	onReviewer(taskId: string): void;
}) {
	const review = view.review,
		state = reviewStripState(view);
	if (!review || !state) return null;
	const counts = taskReviewCounts(view, review.id),
		agent = agentName(task),
		reviewers = review.reviewers.join(', '),
		failed = view.members.find((member) => member.state === 'failed');
	const count = (n: number) => (
		<CountLink task={task} count={n} locale={locale} point={review.point} />
	);
	// spec/reviews#plan-verdict: a plan review's gaps in the ticket stand apart from its findings, which are the author's.
	const plan = review.point === 'plan',
		gaps = plan
			? view.comments.filter((item) => item.reviewId === review.id && item.kind === 'gap').length
			: 0,
		findings = counts.findings - gaps,
		gapsTail = gaps ? (
			<>
				{' · '}
				<CountLink task={task} count={gaps} locale={locale} point={review.point} gaps />
			</>
		) : null;
	const line: ReactNode =
		state === 'reading' ? (
			`${t(locale, pointLine[review.point])} · ${t(locale, '{reviewer} reading').replace('{reviewer}', reviewers)}`
		) : state === 'fixing' ? (
			plan ? (
				t(locale, '{agent} revises the plan').replace('{agent}', agent)
			) : (
				<>
					{t(locale, '{agent} fixes').replace('{agent}', agent)} {count(counts.findings)}
				</>
			)
		) : state === 'verifying' ? (
			t(locale, '{reviewer} checks the fixes').replace('{reviewer}', reviewers)
		) : state === 'yours' ? (
			<>
				{t(locale, '{count} open').replace('{count}', findingCount(locale, counts.open))}
				{gapsTail}
			</>
		) : state === 'passed' ? (
			<>
				{findings ? count(findings) : t(locale, 'no findings')}
				{gapsTail}
			</>
		) : state === 'accepted' ? (
			t(locale, '{n} accepted').replace('{n}', String(counts.accepted))
		) : state === 'stopped' ? (
			counts.findings ? (
				count(counts.findings)
			) : (
				t(locale, 'no findings')
			)
		) : (
			(review.failure ??
			(failed ? `${failed.name}: ${failed.failure ?? t(locale, 'did not start')}` : ''))
		);
	const title = t(
		locale,
		state === 'yours'
			? 'Your call'
			: state === 'passed'
				? 'Review passed'
				: state === 'accepted'
					? 'Review closed'
					: state === 'stopped'
						? 'Review stopped'
						: state === 'failed'
							? 'Review did not start'
							: 'Review'
	);
	const glyph: GlyphName =
		state === 'passed' || state === 'accepted'
			? 'check-pass'
			: state === 'failed'
				? 'agent-failed'
				: state === 'yours'
					? 'agent-question'
					: state === 'stopped'
						? 'stop'
						: 'agent-spinner';
	const shown = open || state === 'yours';
	const prPoint = review.point === 'pre-pr';
	const steps = reviewPoints.map((item) => {
		const step = taskReviewStep(taskReviewAt(view, item)),
			[name, tone] = stepGlyph[step];
		return {
			id: item,
			glyph: <Glyph name={name} size={12} />,
			title: `${t(locale, pointStep[item])} · ${t(locale, stepState[step])}`,
			tone,
			current: item === review.point,
		};
	});
	return (
		<>
			<DeckList label={t(locale, 'Review')} data-review-strip={state}>
				<DeckRow
					hover
					tone={state === 'passed' ? 'green' : state === 'yours' ? 'amber' : undefined}
					data-review-point={review.point}
					label={
						<span className={styles.glyph} data-state={state}>
							<Glyph name={glyph} size={12} />
						</span>
					}
					actions={
						<>
							<StepTrack
								label={t(locale, 'Review steps')}
								steps={steps}
								onPick={(id) => onStep(id as ReviewPoint)}
							/>
							{taskReviewRunning(review) && state !== 'failed' && (
								<Button size="s" variant="ghost" disabled={disabled} onClick={onStop}>
									{t(locale, 'Stop')}
								</Button>
							)}
							{state === 'yours' && (
								<>
									<Button size="s" disabled={disabled} onClick={() => onDecide('fix')}>
										{t(locale, 'Fix {n}').replace('{n}', String(counts.open))}
									</Button>
									<Button size="s" disabled={disabled} onClick={() => onDecide('accept')}>
										{t(locale, 'Accept')}
									</Button>
								</>
							)}
							{state === 'failed' && (
								<Button size="s" appearance="primary" disabled={disabled} onClick={onRetry}>
									{t(locale, 'Retry')}
								</Button>
							)}
							{(state === 'passed' || state === 'accepted') && prPoint && (
								<Button size="s" appearance="primary" onClick={onCreatePR}>
									{t(locale, 'Create PR')}
								</Button>
							)}
							{state === 'stopped' && !plan && (
								<Button size="s" variant="ghost" onClick={onAgain}>
									{t(locale, 'Start again…')}
								</Button>
							)}
							{/* spec/reviews#plan-start: a new full read of the plan that waits, only when the person asks. */}
							{plan &&
								planWaiting &&
								onPlanAgain &&
								(state === 'stopped' || state === 'passed' || state === 'accepted') && (
									<Button size="s" variant="ghost" disabled={disabled} onClick={onPlanAgain}>
										{t(locale, 'Review again')}
									</Button>
								)}
							{!taskReviewLive(review) && (
								<IconButton size="s" label={t(locale, 'Hide')} onClick={onHide}>
									<Glyph name="close" size={12} />
								</IconButton>
							)}
							<IconButton
								size="s"
								label={t(locale, shown ? 'Collapse' : 'Expand')}
								aria-expanded={shown}
								onClick={() => onToggle(!shown)}>
								<Glyph name="chevron-down" size={12} />
							</IconButton>
						</>
					}>
					<button
						type="button"
						className={styles.main}
						aria-expanded={shown}
						onClick={() => onToggle(!shown)}>
						<p>
							<b>{title}</b> <span className={styles.muted}>{line}</span>
						</p>
					</button>
				</DeckRow>
			</DeckList>
			{shown && (
				<ReviewDetails
					view={view}
					locale={locale}
					now={now}
					point={point ?? review.point}
					onStep={onStep}
					onComment={onComment}
					onReviewer={onReviewer}
					{...(onSource ? { onSource } : {})}
				/>
			)}
		</>
	);
}
/**
 * spec/reviews#strip: the review strip in the composer deck — one row with the current review's state, the step track and actions; open, the
 * reviewer and the findings of the picked point. It lives while a review runs or waits for the person, and after it until the next change, ×
 * or the archive.
 */
export function ReviewStrip({
	task,
	locale,
	disabled,
	onComment,
	onReviewer,
	planWaiting = false,
}: {
	task: AgentTask;
	locale: Locale;
	disabled: boolean;
	onComment(comment: TaskReviewCommentRow): void;
	onReviewer(taskId: string): void;
	/** spec/reviews#plan-start: a plan waits for the person's approval. */
	planWaiting?: boolean;
}) {
	const forge = useForge();
	const view = useTaskReview(task),
		id = name(task),
		open = useReviewStore((state) => state.open[id] ?? false),
		point = useReviewStore((state) => state.step[id] ?? null),
		hidden = useReviewStore((state) => state.hidden[id]);
	const review = view.review,
		now = useSecondTick(
			taskReviewRunning(review) &&
				view.members.some((m) => m.state === 'reading' || m.state === 'checking')
		);
	if (!stripShown(view, hidden) || !review) return null;
	const act = (work: Promise<unknown>) =>
		void work.then(
			() => load(task),
			(error: unknown) => toastError(error instanceof Error ? error.message : String(error))
		);
	return (
		<ReviewStripView
			task={task}
			view={view}
			locale={locale}
			open={open}
			point={point}
			now={now}
			disabled={disabled}
			onToggle={(next) => openReviewStrip(task, next)}
			onStep={(next) => openReviewStrip(task, true, next)}
			onStop={() => act(window.brigadir.stopTaskReview(task))}
			onDecide={(decision) => act(window.brigadir.decideTaskReview(task, decision))}
			onRetry={() =>
				void retryReview(task, review).then(
					(reason) => {
						void load(task);
						if (reason !== null)
							toastError(`${t(locale, 'Could not start the review')}: ${reason}`);
					},
					(error: unknown) => toastError(error instanceof Error ? error.message : String(error))
				)
			}
			onAgain={() => openTaskReviewLaunch(task, view)}
			onCreatePR={() => {
				const scope = forge?.data?.scopes[0];
				if (scope) forge!.open('pr', scope.scope.id);
			}}
			onHide={() =>
				useReviewStore.setState((current) => ({ hidden: { ...current.hidden, [id]: review.id } }))
			}
			onComment={onComment}
			onReviewer={onReviewer}
			planWaiting={planWaiting}
			onPlanAgain={() => void startNow(task, locale, 'plan')}
			onSource={(id) => openSource(task, id)}
		/>
	);
}
/** spec/reviews#plan-surfaces: a saved source opens in the editor like a plan copy. */
export function openSource(task: AgentTask, id: string) {
	void window.brigadir
		.openSourceFile(task, id)
		.then((document) => openTaskEditor(task, document))
		.catch((error: unknown) => toastError(error instanceof Error ? error.message : String(error)));
}
const findingOrder: Record<TaskReviewFindingState, number> = {
	open: 0,
	new: 1,
	sent: 2,
	answered: 3,
	fixed: 4,
	accepted: 5,
	resolved: 6,
};
function ReviewDetails({
	view,
	locale,
	now,
	point,
	onStep,
	onComment,
	onReviewer,
	onSource,
}: {
	view: TaskReviewView;
	locale: Locale;
	now: number;
	point: ReviewPoint;
	onStep(point: ReviewPoint): void;
	onComment(comment: TaskReviewCommentRow): void;
	onReviewer(taskId: string): void;
	onSource?: (id: string) => void;
}) {
	const shown = taskReviewAt(view, point),
		current = shown?.id === view.review?.id;
	const comments = view.comments
		.filter((comment) => comment.reviewId === shown?.id)
		.sort((a, b) => findingOrder[a.state] - findingOrder[b.state]);
	return (
		<div className={styles.details} data-review-details={point}>
			<Segments
				size="s"
				stretch
				label={t(locale, 'Review steps')}
				value={point}
				onChange={(value) => onStep(value as ReviewPoint)}
				options={reviewPoints.map((item) => ({
					value: item,
					label: t(locale, pointSegment[item]),
					disabled: !taskReviewAt(view, item),
				}))}
			/>
			{current && view.members.length > 0 && (
				<section aria-label={t(locale, 'Reviewer')}>
					<h3>{t(locale, 'Reviewer')}</h3>
					<ul>
						{view.members.map((member) => (
							<li key={member.name} data-state={member.state}>
								<Glyph name={member.provider === 'codex' ? 'openai' : 'claude'} size={12} />
								<span>
									{member.name} · {providerName(member.provider)}
								</span>
								<small>{memberText(member, locale, now)}</small>
								{member.taskId && (
									<Button size="s" variant="ghost" onClick={() => onReviewer(member.taskId!)}>
										{t(locale, 'Log')}
									</Button>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
			{point === 'plan' && view.sources.length > 0 && (
				<SourceChips sources={view.sources} locale={locale} onOpen={onSource} />
			)}
			{point === 'plan' &&
				planLists.map((list) => (
					<PlanFindings
						key={list}
						list={list}
						comments={comments.filter((item) => item.kind && planFindingList(item.kind) === list)}
						locale={locale}
					/>
				))}
			{point !== 'plan' && comments.length > 0 && (
				<section aria-label={t(locale, 'Findings')}>
					<h3>
						{t(locale, 'Findings')} <span>{comments.length}</span>
					</h3>
					<ul>
						{comments.map((comment) => (
							<li key={comment.id} data-finding={comment.state}>
								<button type="button" className={styles.comment} onClick={() => onComment(comment)}>
									<span className={styles.text}>{comment.text}</span>
									<small>
										<code>
											{comment.path.split('/').at(-1)}:{comment.line}
										</code>{' '}
										· {comment.reviewer}
									</small>
									{(comment.state === 'open' || comment.state === 'new') && comment.reason && (
										<span className={styles.reason}>
											{comment.reviewer}: {comment.reason}
										</span>
									)}
								</button>
								<span className={styles.tag} data-tag={comment.state}>
									{t(locale, comment.state)}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

/** The strip stands while a review lives, and after it until the next change, × or a review that went stale. */
function stripShown(view: TaskReviewView, hidden: string | undefined) {
	const review = view.review;
	if (!review || hidden === review.id || !reviewStripState(view)) return false;
	if (taskReviewLive(review)) return true;
	return !(view.changed && (review.state === 'passed' || review.state === 'accepted'));
}
/** Whether the deck over the composer holds the review strip of `task`. */
export function useReviewStripShown(task: TaskKey): boolean {
	const view = useTaskReview(task),
		hidden = useReviewStore((state) => state.hidden[name(task)]);
	return stripShown(view, hidden);
}

// ── Changes and the PR sheet ──────────────────────────────────────────────────

/** spec/reviews#surfaces: `Review…` beside `Commit`, telling the review's state. */
export function ReviewButton({ task, locale }: { task: AgentTask; locale: Locale }) {
	const view = useTaskReview(task),
		review = view.review,
		counts = taskReviewCounts(view, review?.id);
	if (isMainTree(task) || (!review && !view.changes.files)) return null;
	const live = taskReviewLive(review);
	const [label, tone, glyph] =
		review?.state === 'reading' || review?.state === 'waiting' || review?.state === 'verifying'
			? [t(locale, 'Review'), 'accent', 'agent-spinner']
			: review?.state === 'fixing'
				? [`${t(locale, 'Fixing')} · ${counts.findings}`, 'accent', 'agent-spinner']
				: review?.state === 'yours'
					? [t(locale, 'Your call'), 'amber', 'agent-question']
					: (review?.state === 'passed' || review?.state === 'accepted') && !view.changed
						? [t(locale, 'Reviewed'), 'green', 'check-pass']
						: [t(locale, 'Review…'), null, 'review'];
	return (
		<Button
			variant="ghost"
			className={styles.button}
			data-tone={tone ?? undefined}
			data-dot={review && view.changed && !live ? true : undefined}
			data-review-button={review?.state ?? 'none'}
			onClick={() => (live ? openReviewStrip(task) : openTaskReviewLaunch(task, view))}>
			<Glyph name={glyph as 'review'} size={12} />
			<span>{label}</span>
		</Button>
	);
}
/** spec/reviews#before-pr: the row of the New pull request sheet; `Create PR` stays available. */
export function ReviewReminder({
	task,
	locale,
	onLeave,
}: {
	task: AgentTask;
	locale: Locale;
	/** Closes the sheet before the review's own surface opens. */
	onLeave(): void;
}) {
	const view = useTaskReview(task),
		onReview = () => {
			onLeave();
			openTaskReviewLaunch(task, view);
		},
		onOpen = () => {
			onLeave();
			openReviewStrip(task);
		},
		review = taskReviewAt(view, 'pre-pr'),
		counts = taskReviewCounts(view, review?.id);
	if (isMainTree(task)) return null;
	const reviewers = review?.reviewers.join(', ') ?? '';
	const covered =
		!!review && ['passed', 'accepted'].includes(review.state) && view.beforePR === 'covered';
	const [tone, glyph, title, note, action] = !review
		? [
				'amber',
				'review-warning',
				t(locale, 'Not reviewed'),
				t(locale, '{files} changed since the task start').replace(
					'{files}',
					fileCount(locale, view.changes.files)
				),
				[t(locale, 'Review first'), onReview],
			]
		: taskReviewRunning(review)
			? [
					'amber',
					'agent-spinner',
					t(locale, 'Review in progress'),
					`${t(locale, pointLine[review.point])} · ${reviewers}`,
					[t(locale, 'Open the review'), onOpen],
				]
			: review.state === 'yours'
				? [
						'amber',
						'agent-question',
						t(locale, '{count} open').replace('{count}', findingCount(locale, counts.open)),
						t(locale, '{reviewers} and {agent} did not close them; your call')
							.replace('{reviewers}', reviewers)
							.replace('{agent}', agentName(task)),
						[t(locale, 'Open the review'), onOpen],
					]
				: covered
					? [
							'green',
							'check-pass',
							t(locale, 'Reviewed'),
							`${reviewers} · ${findingCount(locale, counts.findings)}, ${t(locale, '{n} fixed').replace('{n}', String(counts.fixed))}`,
							null,
						]
					: [
							'amber',
							'review-warning',
							t(locale, 'Changed since the review'),
							t(locale, '{files} after the review').replace(
								'{files}',
								fileCount(locale, view.sinceLast ?? 0)
							),
							[t(locale, 'Review again'), onReview],
						];
	return (
		<div
			className={styles.reminder}
			data-tone={tone}
			data-review-reminder={review?.state ?? 'none'}
			role="status">
			<Glyph name={glyph as 'review'} size={12} />
			<span>
				<b>{title}</b>
				<small>{note}</small>
			</span>
			{action && (
				<Button size="s" onClick={action[1] as () => void}>
					{action[0] as string}
				</Button>
			)}
		</div>
	);
}

// ── the plan review (spec/reviews#plan-surfaces) ────────────────────────────

const planLists: readonly PlanFindingList[] = ['ticket', 'code', 'gap'];
const planListTitle: Record<PlanFindingList, MessageKey> = {
	ticket: 'Plan vs ticket',
	code: 'Plan vs code',
	gap: 'Gaps in the ticket',
};
const planKindTag: Record<PlanFindingKind, MessageKey> = {
	missed: 'missed',
	contradicts: 'contradicts',
	'out-of-scope': 'out of scope',
	assumption: 'wrong assumption',
	'left-open': 'left open',
	unverifiable: 'cannot verify',
	split: 'split',
	gap: 'gap',
};
/** spec/reviews#plan-surfaces: one list of a plan review — a row per finding: its text, `<where> · <reviewer>`, and its kind while it waits
 *  for the author, then its state. Gaps have no reviewer. Plan findings have no thread in the diff, so a row opens nothing. */
function PlanFindings({
	list,
	comments,
	locale,
}: {
	list: PlanFindingList;
	comments: readonly TaskReviewCommentRow[];
	locale: Locale;
}) {
	if (!comments.length) return null;
	return (
		<section aria-label={t(locale, planListTitle[list])} data-plan-list={list}>
			<h3>
				{t(locale, planListTitle[list])} <span>{comments.length}</span>
			</h3>
			<ul>
				{comments.map((comment) => {
					const tag =
						list === 'gap' || comment.state === 'sent'
							? planKindTag[comment.kind ?? 'gap']
							: comment.state;
					return (
						<li key={comment.id} data-finding={comment.state}>
							<div className={styles.comment} data-static>
								<span className={styles.text}>{comment.text}</span>
								<small>
									{[comment.where, list === 'gap' ? null : comment.reviewer]
										.filter(Boolean)
										.join(' · ')}
								</small>
								{(comment.state === 'open' || comment.state === 'new') && comment.reason && (
									<span className={styles.reason}>
										{comment.reviewer}: {comment.reason}
									</span>
								)}
							</div>
							<span
								className={styles.tag}
								data-tag={
									list === 'gap' ? 'gap' : comment.state === 'sent' ? 'kind' : comment.state
								}>
								{t(locale, tag)}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
/** spec/reviews#plan-surfaces: the saved sources as chips; a click opens the saved text in the editor. */
function SourceChips({
	sources,
	locale,
	onOpen,
}: {
	sources: TaskReviewView['sources'];
	locale: Locale;
	onOpen?: ((id: string) => void) | undefined;
}) {
	return (
		<div className={styles.sources} role="group" aria-label={t(locale, 'Sources')}>
			<ChatCardChips>
				{sources.map((source) => (
					<ChatCardChip
						key={source.id}
						title={source.url ?? source.title}
						aria-label={`${t(locale, 'Open the source')} · ${source.title}`}
						data-source={source.id}
						onClick={onOpen ? () => onOpen(source.id) : undefined}>
						<Glyph name="note" size={12} />
						<span>{source.title}</span>
					</ChatCardChip>
				))}
			</ChatCardChips>
		</div>
	);
}
/**
 * spec/reviews#plan-surfaces: the line above a waiting plan's footer — the saved sources as chips and the plan review's state (running, the
 * findings and gaps as links, passed). A click on the state expands the strip on the plan step.
 */
export function PlanReviewLine({ task, locale }: { task: AgentTask; locale: Locale }) {
	const view = useTaskReview(task),
		review = taskReviewAt(view, 'plan'),
		current = review && !review.plan?.approved ? review : null;
	if (!current && !view.sources.length) return null;
	const counts = current ? taskReviewCounts(view, current.id) : null,
		gaps = current
			? view.comments.filter((item) => item.reviewId === current.id && item.kind === 'gap').length
			: 0,
		reviewers = current?.reviewers.join(', ') ?? '',
		expand = () => openReviewStrip(task, true, 'plan');
	let state: ReactNode = null;
	if (current && counts) {
		const glyph: GlyphName = taskReviewRunning(current)
				? 'agent-spinner'
				: current.state === 'yours'
					? 'agent-question'
					: current.state === 'passed' || current.state === 'accepted'
						? 'check-pass'
						: current.state === 'failed'
							? 'agent-failed'
							: 'stop',
			tone =
				current.state === 'yours'
					? 'yours'
					: current.state === 'passed'
						? 'passed'
						: current.state === 'failed'
							? 'failed'
							: undefined;
		const words =
			current.state === 'waiting' || current.state === 'reading'
				? `${t(locale, 'Review')} · ${t(locale, '{reviewer} reading').replace('{reviewer}', reviewers)}`
				: current.state === 'verifying'
					? t(locale, '{reviewer} checks the fixes').replace('{reviewer}', reviewers)
					: current.state === 'fixing'
						? t(locale, '{agent} revises the plan').replace('{agent}', agentName(task))
						: current.state === 'yours'
							? t(locale, '{count} open').replace('{count}', findingCount(locale, counts.open))
							: current.state === 'passed'
								? t(locale, 'Review passed')
								: current.state === 'accepted'
									? t(locale, 'Review closed')
									: current.state === 'failed'
										? t(locale, 'Review did not start')
										: t(locale, 'Review stopped');
		const findings = counts.findings - gaps;
		state = (
			<span className={styles.planState} data-state={tone}>
				<span className={styles.glyph} data-state={tone}>
					<Glyph name={glyph} size={12} />
				</span>
				<button type="button" className={styles.count} onClick={expand}>
					{words}
				</button>
				{!taskReviewRunning(current) && current.state !== 'yours' && findings > 0 && (
					<>
						{' · '}
						<CountLink task={task} count={findings} locale={locale} point="plan" />
					</>
				)}
				{gaps > 0 && (
					<>
						{' · '}
						<CountLink task={task} count={gaps} locale={locale} point="plan" gaps />
					</>
				)}
			</span>
		);
	}
	return (
		<div className={styles.planLine} data-plan-review={current?.state ?? 'none'}>
			{view.sources.length > 0 && (
				<SourceChips sources={view.sources} locale={locale} onOpen={(id) => openSource(task, id)} />
			)}
			{state}
		</div>
	);
}
