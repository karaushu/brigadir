import { useEffect, useState } from 'react';
import { create } from 'zustand';
import {
	commentCount,
	emptyTaskReviewView,
	fileCount,
	formatDuration,
	isMainTree,
	providerName,
	t,
	taskReviewCounts,
	taskReviewLive,
	type AgentTask,
	type EventRecord,
	type Locale,
	type TaskKey,
	type TaskReviewCommentRow,
	type TaskReviewMember,
	type TaskReviewView,
} from '@brigadir/core';
import { onSessionEvent } from './session-events';
import { openReviewLaunch } from './ReviewLaunch';
import { useHelperSettings } from './HelperAgent';
import { useForge } from './Forge';
import { Deck, DeckList, DeckRow } from './ui/Deck';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ChatCard, ChatCardChip, ChatCardChips } from './ui/ChatCard';
import { ChangeCounts } from './ui/ChangeCounts';
import { useSecondTick } from './ui/second-tick';
import { toastError } from './ui/Toast';
import styles from './TaskReview.module.css';
// The review's chat rows are the crew's service rows (rule 17).
import service from './Crew.module.css';

/**
 * spec/diff-and-review#agent-review-ui: one view of a task's review before the PR for every surface of the window — the strip, the chat rows,
 * the Changes button, the PR sheet and the sidebar. Read from main and read again when the task's journal says the review moved.
 */
type ReviewStore = {
	views: Record<string, TaskReviewView>;
	/** The strip is open (the chevron, or a comment count clicked in the chat). */
	open: Record<string, boolean>;
	/** The strip was closed with × after the review ended; it comes back with the next review. */
	hidden: Record<string, string>;
};
const useReviewStore = create<ReviewStore>(() => ({ views: {}, open: {}, hidden: {} }));
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const moves = new Set([
	'review.proposed',
	'review.dismissed',
	'review.started',
	'review.finished',
	'review.replied',
	'crew.review',
	'crew.worker.created',
	'checkpoint.created',
	'turn.completed',
	'turn.started',
]);
const reading = new Map<string, Promise<void>>();
function load(key: TaskKey) {
	const id = name(key);
	const next = window.brigadir.readTaskReview(key).then(
		(view) => useReviewStore.setState((state) => ({ views: { ...state.views, [id]: view } })),
		() => {}
	);
	reading.set(id, next);
	return next;
}
/** The review of `task`, kept current while the component lives. Main-tree tasks have none. */
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
export function openReviewStrip(task: TaskKey, open = true) {
	useReviewStore.setState((state) => ({ open: { ...state.open, [name(task)]: open } }));
}
const agentName = (task: AgentTask) => (task.provider ? providerName(task.provider) : 'Agent');
/** The launch dialog of a task's review (spec/diff-and-review#agent-review-start). */
export function openTaskReviewLaunch(task: AgentTask, view: TaskReviewView, locale: Locale) {
	void locale;
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
async function startNow(task: AgentTask, locale: Locale) {
	const reason = await window.brigadir
		.startTaskReview(task, { agent: null, crew: null, notes: '', since: 'start' })
		.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
	if (reason !== null)
		toastError(`${t(locale, 'Could not start the review')}: ${reason}`, {
			action: { label: t(locale, 'Retry'), run: () => void startNow(task, locale) },
		});
	else void load(task);
}
/** spec/diff-and-review#agent-review-ui: who reviews unless the person chooses — the remembered crew or agent of `Review before PR`. */
function useRememberedWho(locale: Locale) {
	const settings = useHelperSettings();
	const crew = settings?.actionCrews.taskReview,
		agent = settings?.actionAgents.taskReview;
	return crew ? crew.name : agent?.name ? agent.name : t(locale, 'Default agent');
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
	if (later.some((item) => item.event.kind === 'review.started')) return null;
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
						<Button disabled={busy} onClick={() => openTaskReviewLaunch(task, view, locale)}>
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
				onClick={() => openTaskReviewLaunch(task, view, locale)}>
				{t(locale, 'Start review')}
			</Button>
		</div>
	);
}
/** A comment count that opens the strip on its comments (spec/diff-and-review#agent-review-ui). */
function CountLink({ task, count, locale }: { task: TaskKey; count: number; locale: Locale }) {
	return (
		<button type="button" className={styles.count} onClick={() => openReviewStrip(task)}>
			{commentCount(locale, count)}
		</button>
	);
}
/** spec/diff-and-review#agent-review-ui: the review's service rows in the chat — started, a round's verdicts, finished. */
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
	const round = (n: number) => t(locale, 'round {n} of 2').replace('{n}', String(n));
	if (e.kind === 'review.started')
		return (
			<div className={service.service} data-review-row="started">
				<Glyph name="review" size={12} />
				<small>{t(locale, 'review')}</small>
				<span className={service.label}>
					{e.who.kind === 'crew' ? `${e.who.name} · ` : ''}
					{e.reviewers.join(', ')}
				</span>
				<small>{round(1)}</small>
				<small>{t(locale, 'started')}</small>
			</div>
		);
	if (e.kind === 'crew.review' && e.taskId === task.id) {
		if (e.state === 'reviewing') return null;
		return (
			<div className={service.service} data-review-row={e.state}>
				<Glyph name={e.state === 'approved' ? 'check-pass' : 'review'} size={12} />
				<small>{t(locale, 'review')}</small>
				<span className={service.label}>
					{e.state === 'comments' ? `${e.reviewer} → ${agent}` : e.reviewer}
					{e.state === 'approved' && ` · ${t(locale, 'approved')}`}
				</span>
				<small>{round(e.round)}</small>
				{e.state === 'approved' ? (
					<small className={service.ok}>{t(locale, 'passed')}</small>
				) : e.state === 'disputed' ? (
					<small className={service.warn}>{t(locale, 'disputed')}</small>
				) : (
					<CountLink task={task} count={e.comments} locale={locale} />
				)}
			</div>
		);
	}
	if (e.kind === 'review.finished' && (e.state === 'stopped' || e.state === 'outdated'))
		return (
			<div className={service.service} data-review-row={e.state}>
				<Glyph name="review" size={12} />
				<small>{t(locale, 'review')}</small>
				<span className={service.label}>
					{t(locale, e.state === 'stopped' ? 'stopped by you' : 'changed after the review')}
				</span>
			</div>
		);
	return null;
}

// ── the strip over the composer ─────────────────────────────────────────────

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
		case 'comments':
			return commentCount(locale, member.comments);
		case 'approved':
			return t(locale, 'approved');
		case 'disputed':
			return t(locale, 'disputed');
		case 'stopped':
			return t(locale, 'stopped');
		case 'failed':
			return member.failure ?? t(locale, 'did not start');
	}
}
/**
 * spec/diff-and-review#agent-review-ui: the review strip in the composer deck — one row with the review's state and actions; open, its reviewers and
 * its comments. It lives while the review runs and after it until the next change, × or the archive.
 */
export function ReviewStrip({
	task,
	locale,
	disabled,
	onComment,
	onReviewer,
}: {
	task: AgentTask;
	locale: Locale;
	disabled: boolean;
	onComment(comment: TaskReviewCommentRow): void;
	onReviewer(taskId: string): void;
}) {
	const forge = useForge(),
		onCreatePR = () => {
			const scope = forge?.data?.scopes[0];
			if (scope) forge!.open('pr', scope.scope.id);
		};
	const view = useTaskReview(task),
		id = name(task),
		open = useReviewStore((state) => state.open[id] ?? false),
		hidden = useReviewStore((state) => state.hidden[id]);
	const review = view.review,
		live = taskReviewLive(review),
		now = useSecondTick(
			live && view.members.some((m) => m.state === 'reading' || m.state === 'checking')
		);
	if (!stripShown(view, hidden)) return null;
	if (!review) return null;
	const counts = taskReviewCounts(view),
		agent = agentName(task),
		failed = view.members.filter((member) => member.state === 'failed'),
		state =
			failed.length && live
				? 'failed'
				: review.state === 'disputed'
					? 'disputed'
					: review.state === 'approved'
						? 'passed'
						: review.state === 'stopped'
							? 'stopped'
							: review.state === 'comments'
								? 'fixing'
								: 'running';
	const shown = open || state === 'disputed';
	const hide = () =>
		useReviewStore.setState((current) => ({ hidden: { ...current.hidden, [id]: review.id } }));
	const stop = () => void window.brigadir.stopTaskReview(task).catch(() => {});
	const round = t(locale, 'round {n} of 2').replace('{n}', String(Math.max(1, review.round)));
	const line =
		state === 'running' ? (
			<>
				{round}
				{review.round > 1
					? ` · ${t(locale, 'checking the fixes')} · ${t(locale, '{n} fixed').replace('{n}', String(counts.fixed))} · ${t(locale, '{n} answered').replace('{n}', String(counts.answered))}`
					: view.members.length
						? ` · ${view.members.map((member) => `${member.name} ${memberText(member, locale, now)}`).join(' · ')}`
						: ''}
			</>
		) : state === 'fixing' ? (
			<>
				{t(locale, '{agent} fixes').replace('{agent}', agent)}{' '}
				<CountLink task={task} count={counts.comments} locale={locale} />
			</>
		) : state === 'passed' ? (
			<>
				<CountLink task={task} count={counts.comments} locale={locale} />
				{` · ${t(locale, '{n} fixed').replace('{n}', String(counts.fixed))} · ${t(locale, '{n} answered').replace('{n}', String(counts.answered))}`}
			</>
		) : state === 'disputed' ? (
			t(locale, '{reviewer} disputes {count}')
				.replace(
					'{reviewer}',
					[
						...new Set(view.comments.filter((c) => c.state === 'disputed').map((c) => c.reviewer)),
					].join(', ')
				)
				.replace('{count}', commentCount(locale, counts.disputed))
		) : state === 'stopped' ? (
			<CountLink task={task} count={counts.comments} locale={locale} />
		) : (
			`${failed[0]!.name}: ${failed[0]!.failure ?? t(locale, 'did not start')}`
		);
	const title = t(
		locale,
		state === 'passed'
			? 'Review passed'
			: state === 'disputed'
				? 'Your call'
				: state === 'stopped'
					? 'Review stopped'
					: state === 'failed'
						? 'Review did not start'
						: 'Review'
	);
	return (
		<>
			<DeckList label={t(locale, 'Review')} data-review-strip={state}>
				<DeckRow
					hover
					label={
						<Glyph
							name={
								state === 'passed'
									? 'check-pass'
									: state === 'failed'
										? 'agent-failed'
										: state === 'disputed'
											? 'agent-question'
											: state === 'stopped'
												? 'stop'
												: 'agent-spinner'
							}
							size={12}
						/>
					}
					actions={
						<>
							{live && state !== 'failed' && (
								<Button size="s" variant="ghost" disabled={disabled} onClick={stop}>
									{t(locale, 'Stop')}
								</Button>
							)}
							{state === 'failed' && (
								<Button
									size="s"
									appearance="primary"
									disabled={disabled}
									onClick={() => {
										stop();
										openTaskReviewLaunch(task, view, locale);
									}}>
									{t(locale, 'Retry')}
								</Button>
							)}
							{state === 'passed' && (
								<>
									<Button
										size="s"
										variant="ghost"
										onClick={() => openTaskReviewLaunch(task, view, locale)}>
										{t(locale, 'Review again…')}
									</Button>
									<Button size="s" appearance="primary" onClick={onCreatePR}>
										{t(locale, 'Create PR…')}
									</Button>
								</>
							)}
							{state === 'stopped' && (
								<Button
									size="s"
									variant="ghost"
									onClick={() => openTaskReviewLaunch(task, view, locale)}>
									{t(locale, 'Start again…')}
								</Button>
							)}
							{!live && (
								<IconButton size="s" label={t(locale, 'Hide')} onClick={hide}>
									<Glyph name="close" size={12} />
								</IconButton>
							)}
							<IconButton
								size="s"
								label={t(locale, shown ? 'Collapse' : 'Expand')}
								aria-expanded={shown}
								onClick={() => openReviewStrip(task, !shown)}>
								<Glyph name="chevron-down" size={12} />
							</IconButton>
						</>
					}>
					<button
						type="button"
						className={styles.main}
						aria-expanded={shown}
						onClick={() => openReviewStrip(task, !shown)}>
						<p>
							<b>{title}</b> <span className={styles.muted}>{line}</span>
						</p>
					</button>
				</DeckRow>
			</DeckList>
			{shown && (
				<ReviewDetails
					task={task}
					view={view}
					locale={locale}
					now={now}
					disabled={disabled}
					onComment={onComment}
					onReviewer={onReviewer}
				/>
			)}
		</>
	);
}
function ReviewDetails({
	task,
	view,
	locale,
	now,
	disabled,
	onComment,
	onReviewer,
}: {
	task: AgentTask;
	view: TaskReviewView;
	locale: Locale;
	now: number;
	disabled: boolean;
	onComment(comment: TaskReviewCommentRow): void;
	onReviewer(taskId: string): void;
}) {
	const order = { disputed: 0, sent: 1, answered: 2, fixed: 3, resolved: 4 } as const;
	const comments = [...view.comments].sort((a, b) => order[a.state] - order[b.state]);
	return (
		<div className={styles.details} data-review-details>
			<section aria-label={t(locale, 'Reviewers')}>
				<h3>
					{t(locale, 'Reviewers')} <span>{view.members.length}</span>
				</h3>
				<ul>
					{view.members.map((member) => (
						<li
							key={member.name}
							data-state={member.state}
							data-hover={member.taskId ? true : undefined}>
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
			{comments.length > 0 && (
				<section aria-label={t(locale, 'Comments')}>
					<h3>
						{t(locale, 'Comments')} <span>{comments.length}</span>
					</h3>
					<ul>
						{comments.map((comment) => (
							<li key={comment.id} data-comment={comment.state}>
								<button type="button" className={styles.comment} onClick={() => onComment(comment)}>
									<span className={styles.text}>{comment.text}</span>
									<small>
										<code>
											{comment.path.split('/').at(-1)}:{comment.line}
										</code>{' '}
										· {comment.reviewer}
									</small>
								</button>
								<span className={styles.tag} data-tag={comment.state}>
									{t(locale, comment.state)}
								</span>
								{comment.state === 'disputed' && (
									<div className={styles.dispute}>
										{comment.answer && (
											<blockquote>
												<b>{agentName(task)}:</b> {comment.answer}
											</blockquote>
										)}
										<span>
											<Button
												size="s"
												disabled={disabled}
												onClick={() => void sendBack(task, comment, locale)}>
												{t(locale, 'Back to the agent')}
											</Button>
											<Button
												size="s"
												disabled={disabled}
												onClick={() => void keep(task, comment, locale)}>
												{t(locale, 'Keep as is')}
											</Button>
										</span>
									</div>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
/** spec/diff-and-review#agent-review-rounds: `Back to the agent` — the disputed comment goes as the person's own review comment. */
async function sendBack(task: AgentTask, comment: TaskReviewCommentRow, locale: Locale) {
	try {
		await window.brigadir.sendTaskReviewComment(task, comment.id);
		void load(task);
	} catch {
		toastError(t(locale, 'Could not send the comment to the agent.'));
	}
}
/** `Keep as is` resolves the disputed comment. */
async function keep(task: AgentTask, comment: TaskReviewCommentRow, locale: Locale) {
	try {
		await window.brigadir.resolveTaskReviewComment(task, comment.id);
		void load(task);
	} catch {
		toastError(t(locale, 'Could not resolve the comment.'));
	}
}

/** The strip stands while the review lives, and after it until the next change, × or a review that went stale. */
function stripShown(view: TaskReviewView, hidden: string | undefined) {
	const review = view.review;
	if (!review || hidden === review.id) return false;
	if (taskReviewLive(review)) return true;
	return review.state !== 'outdated' && !(view.changed && review.state === 'approved');
}
/** Whether the deck over the composer holds the review strip of `task`. */
export function useReviewStripShown(task: TaskKey): boolean {
	const view = useTaskReview(task),
		hidden = useReviewStore((state) => state.hidden[name(task)]);
	return stripShown(view, hidden);
}

// ── Changes and the PR sheet ──────────────────────────────────────────────────

/** spec/diff-and-review#agent-review-surfaces: `Review…` beside `Commit`, telling the review's state. */
export function ReviewButton({ task, locale }: { task: AgentTask; locale: Locale }) {
	const view = useTaskReview(task),
		review = view.review,
		counts = taskReviewCounts(view);
	if (isMainTree(task) || (!review && !view.changes.files)) return null;
	const live = taskReviewLive(review);
	const [label, tone, glyph] =
		review?.state === 'reviewing' || review?.state === 'waiting'
			? [`${t(locale, 'Review')} · ${Math.max(1, review.round)}/2`, 'accent', 'agent-spinner']
			: review?.state === 'comments'
				? [`${t(locale, 'Fixing')} · ${counts.comments}`, 'accent', 'agent-spinner']
				: review?.state === 'approved' && !view.changed
					? [t(locale, 'Reviewed'), 'green', 'check-pass']
					: review?.state === 'disputed'
						? [t(locale, 'Your call'), 'amber', 'agent-question']
						: [t(locale, 'Review…'), null, 'review'];
	return (
		<Button
			variant="ghost"
			className={styles.button}
			data-tone={tone ?? undefined}
			data-dot={review && view.changed && !live ? true : undefined}
			data-review-button={review?.state ?? 'none'}
			onClick={() =>
				live || review?.state === 'disputed'
					? openReviewStrip(task)
					: openTaskReviewLaunch(task, view, locale)
			}>
			<Glyph name={glyph as 'review'} size={12} />
			<span>{label}</span>
		</Button>
	);
}
/** spec/diff-and-review#agent-review-pr: the row of the New pull request sheet; `Create PR` stays available. */
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
			openTaskReviewLaunch(task, view, locale);
		},
		onOpen = () => {
			onLeave();
			openReviewStrip(task);
		},
		review = view.review,
		counts = taskReviewCounts(view);
	if (isMainTree(task)) return null;
	const reviewers = review?.reviewers.join(', ') ?? '';
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
		: taskReviewLive(review)
			? [
					'amber',
					'agent-spinner',
					t(locale, 'Review in progress'),
					`${t(locale, 'Round {n} of 2').replace('{n}', String(Math.max(1, review.round)))} · ${reviewers}`,
					[t(locale, 'Open the review'), onOpen],
				]
			: review.state === 'disputed'
				? [
						'amber',
						'agent-question',
						commentCount(locale, counts.disputed).replace(/^(\d+)/, '$1') +
							` ${t(locale, 'disputed')}`,
						t(locale, '{reviewers} and {agent} did not agree; your call')
							.replace('{reviewers}', reviewers)
							.replace('{agent}', agentName(task)),
						[t(locale, 'Open the review'), onOpen],
					]
				: review.state === 'approved' && !view.changed
					? [
							'green',
							'check-pass',
							t(locale, 'Reviewed'),
							`${t(locale, '{reviewers} approved in round {n}').replace('{reviewers}', reviewers).replace('{n}', String(review.round))} · ${commentCount(locale, counts.comments)}, ${t(locale, '{n} fixed').replace('{n}', String(counts.fixed))}`,
							null,
						]
					: [
							'amber',
							'review-warning',
							t(locale, 'Changed since the review'),
							t(locale, '{files} after round {n}')
								.replace('{files}', fileCount(locale, view.sinceLast ?? 0))
								.replace('{n}', String(review.round)),
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
