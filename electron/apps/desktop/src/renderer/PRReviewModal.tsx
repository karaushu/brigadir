import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
} from 'react';
import {
	commentCount,
	mergeControlState,
	commitsSince,
	draftCount,
	fileCount,
	formatAccelerator,
	handedCount,
	layoutLimits,
	locateSummaryItem,
	newCommitCount,
	prAge,
	relativeAge,
	summaryChecks,
	summaryMarks,
	summarySpots,
	t,
	type AgentTask,
	type FileDiff,
	type Locale,
	type MessageKey,
	type PRDraft,
	type PRRefKey,
	type PRReviewEvent,
	type PRSummaryItem,
	type PRThread,
	type PRVerdictHint,
	type PullRequestDetail,
	type HelperRun,
} from '@brigadir/core';
import { closeReview, openReview, prReviewStore, readDetail, usePRReview } from './pr-review';
import {
	dismissSummarySpot,
	generateSummary,
	stopSummary,
	summarySignIn,
	toggleSummaryCheck,
	usePRSummary,
} from './pr-summary';
import { shownFiles } from './pr-viewed';
import { usePullRequests } from './PullRequests';
import { HelperCapsule, useHelperRun } from './HelperAgent';
import { AgentReviewButton, PRFileRow } from './PullRequestPanel';
import type { ReviewChoice } from './ReviewLaunch';
import { PRDiffView } from './PRDiffView';
import { MergeControl, mergeWhy } from './PROverview';
import { useTaskState } from './task-state';
import { useWorkspace } from './store';
import { useSurfaceLayout } from './surface-layout';
import { signInAgent } from './agent-sign-in';
import { Avatar } from './ui/Avatar';
import { Banner } from './ui/Banner';
import { BranchName } from './ui/BranchName';
import { CodeQuote } from './ui/CodeQuote';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Button, Choice, IconButton, Segments } from './ui/Controls';
import { FileIcon } from './ui/FileIcon';
import { GenerateButton } from './ui/GenerateButton';
import { Glyph } from './ui/Glyph';
import { LoadingStatus, Skeleton, SkeletonRows, Spinner } from './ui/Loading';
import { TextArea } from './ui/Input';
import { ModalDialog } from './ui/ModalDialog';
import { ChangeCounts } from './ui/ChangeCounts';
import { OptionCard } from './ui/OptionCard';
import { MenuItem, MenuPopover } from './ui/Popover';
import { PopupClose } from './ui/PopupClose';
import { ProgressBar } from './ui/ProgressBar';
import { ResizeHandle } from './ui/ResizeHandle';
import { primaryKey } from './ui/primary-key';
import { SpotBadges } from './ui/SpotBadges';
import { showToast, toastError } from './ui/Toast';
import styles from './PRReviewModal.module.css';

type Step = 1 | 2 | 3 | 4 | 5;
type Decision = Exclude<PRReviewEvent, 'AGENT'>;
const stepNames: Record<Step, MessageKey> = {
	1: 'Read',
	2: 'Comments',
	3: 'Verdict',
	4: 'Summary',
	5: 'Check',
};
const decisions: { event: Decision; glyph: 'bubble' | 'check-pass' | 'review-changes' }[] = [
	{ event: 'COMMENT', glyph: 'bubble' },
	{ event: 'APPROVE', glyph: 'check-pass' },
	{ event: 'REQUEST_CHANGES', glyph: 'review-changes' },
];
const decisionNames: Record<Decision, MessageKey> = {
	COMMENT: 'Comment',
	APPROVE: 'Approve',
	REQUEST_CHANGES: 'Request changes',
};
const sentLabels = {
	COMMENT: 'You commented',
	APPROVE: 'You approved',
	REQUEST_CHANGES: 'You requested changes',
} as const;
const fileName = (path: string) => path.split('/').at(-1) || path;
const folderOf = (path: string) => {
	const slash = path.lastIndexOf('/');
	return slash > 0 ? path.slice(0, slash) : '';
};
const lines = (draft: Pick<PRDraft, 'startLine' | 'line'>) =>
	draft.startLine && draft.startLine < draft.line
		? `${draft.startLine}–${draft.line}`
		: String(draft.line);
const place = (item: PRSummaryItem) =>
	`${fileName(item.path ?? '')}${item.start ? `:${item.start}${item.end && item.end !== item.start ? `–${item.end}` : ''}` : ''}`;
/** The lines a draft is on, from the file both sides of the PR diff carry (spec/appearance#evolution-redesign quote). */
const quoteOf = (diff: FileDiff | undefined, draft: PRDraft) => {
	if (!diff) return '';
	const text = draft.side === 'LEFT' ? diff.beforeText : diff.afterText,
		all = text.split('\n');
	return all.slice((draft.startLine ?? draft.line) - 1, draft.line).join('\n');
};

/**
 * spec/appearance#evolution-redesign: every button that opens the review modal says so with the window glyph after its name (`zoom`, as the
 * «Review comments» summary of the diff review footer), not ▾. The PR panel footer and Overview.
 */
export function StartReviewButton({
	task,
	target,
	locale,
	label = 'Start review',
	appearance = 'primary',
	iconOnly = false,
}: {
	task: AgentTask;
	target: PRRefKey;
	locale: Locale;
	label?: 'Start review' | 'Continue review' | 'New review';
	appearance?: 'primary' | 'neutral';
	/** A narrow header (Overview in a 400 px workspace): the window glyph alone, the name in its tooltip. */
	iconOnly?: boolean;
}) {
	if (iconOnly)
		return (
			<IconButton
				label={t(locale, label)}
				appearance={appearance}
				variant={appearance === 'primary' ? 'solid' : 'ghost'}
				data-review-open={label}
				onClick={() => openReview(task, target)}>
				<Glyph name="zoom" size={12} />
			</IconButton>
		);
	return (
		<Button
			appearance={appearance}
			className={styles.opener}
			title={t(locale, 'Opens the review window')}
			data-review-open={label}
			onClick={() => openReview(task, target)}>
			{t(locale, label)}
			<Glyph name="zoom" size={13} />
		</Button>
	);
}

/** spec/appearance#evolution-redesign: the PR panel footer — the drafts and the way into the modal. */
export function PRReviewFooter({
	task,
	locale,
	target,
}: {
	task: AgentTask;
	locale: Locale;
	target: PRRefKey;
}) {
	const { review, sent } = usePRReview(task, target),
		count = review.drafts.length,
		agent = review.drafts.filter((draft) => draft.fromAgent && !draft.accepted).length;
	if (sent && !count)
		return (
			<div className={styles.footer} data-pr-review-footer data-size="m">
				<span className={styles.sentGlyph} data-event={sent.event}>
					<Glyph
						name={
							sent.event === 'APPROVE'
								? 'check-pass'
								: sent.event === 'REQUEST_CHANGES'
									? 'review-changes'
									: 'bubble'
						}
						size={13}
					/>
				</span>
				<span className={styles.sent}>
					{t(locale, sentLabels[sent.event])} ·{' '}
					{Date.now() - sent.at < 60_000
						? t(locale, 'just now')
						: prAge(locale, new Date(sent.at).toISOString())}
				</span>
				<StartReviewButton
					task={task}
					target={target}
					locale={locale}
					label="New review"
					appearance="neutral"
				/>
			</div>
		);
	return (
		<div className={styles.footer} data-pr-review-footer data-size="m">
			<small className={styles.caption}>
				{count ? draftCount(locale, count) : t(locale, 'No drafts')}
				{agent > 0 && (
					<span title={t(locale, 'Suggestions from the agent')}>
						{' '}
						· {agent} <Glyph name="generate" size={10} />
					</span>
				)}
			</small>
			<StartReviewButton
				task={task}
				target={target}
				locale={locale}
				label={count ? 'Continue review' : 'Start review'}
			/>
		</div>
	);
}

type Failure = { text: string; draft: string | null; reason: string } | null;

/**
 * spec/appearance#evolution-redesign: the review of a PR in a modal almost the size of the window — the agent
 * summary first, then steps 1 Read → 2 Comments → 3 Verdict → 4 Summary → 5 Check. Files left (spec/pull-requests-and-ci#pr-files «Viewed»), the
 * diff in the centre (spec/appearance#evolution-redesign), the column of the step right. Esc closes at once: the drafts are in the PR (spec/pull-requests-and-ci#review-drafts).
 */
export function PRReviewModal({
	task,
	target,
	locale,
	projectName,
	mainTree,
	onCompose,
	onDeliver,
	onAgentReview,
	onOpenReview,
	onAgentFix,
	onResolveConflicts,
}: {
	/** spec/pull-requests-and-ci#review-with-agent: `Open the review` — the live review task of this PR; the modal steps aside first. */
	onOpenReview?: ((review: AgentTask) => void) | undefined;
	/** spec/appearance#evolution-redesign: `Resolve conflicts… ▾` of the Merge card (spec/pull-requests-and-ci#resolve-conflicts); none — a conflict keeps «Merge PR…» off with its reason. */ onResolveConflicts?:
		((how: 'agent' | 'manual') => Promise<string | null>) | undefined;
	task: AgentTask;
	target: PRRefKey;
	locale: Locale;
	projectName: string;
	mainTree: boolean;
	onCompose(
		text: string,
		focus?: boolean,
		immediate?: boolean,
		name?: string,
		after?: string
	): Promise<boolean>;
	onDeliver?: ((text: string, to: AgentTask) => Promise<void>) | undefined;
	/** spec/pull-requests-and-ci#review-launch: starts the review the launch dialog describes; answers whether its task started. */
	onAgentReview?: ((choice: ReviewChoice) => Promise<boolean>) | undefined;
	onAgentFix?: ((sendComments: boolean) => Promise<boolean>) | undefined;
}) {
	const { detail, detailError, review, busy, actions, viewing, viewedError } = usePRReview(
			task,
			target
		),
		summary = usePRSummary(task, target),
		viewer = usePullRequests()?.data?.viewer ?? null,
		appearance = useWorkspace((state) => state.appearance),
		tasks = useWorkspace((state) => state.workspace?.tasks),
		[, setTaskState] = useTaskState(task);
	const close = () => closeReview(task);
	const [step, setStep] = useState<Step>(1),
		/** spec/appearance#evolution-redesign: steps 2–5 — the step or the «✦ Summary» tab of the column. */ [
			side,
			setSide,
		] = useState<'step' | 'summary'>('step'),
		[path, setPath] = useState<string | null>(null),
		[landing, setLanding] = useState<{ path: string; start: number; end: number } | null>(null),
		[diffs, setDiffs] = useState<Record<string, FileDiff | 'loading' | 'failed'>>({}),
		[narrow, setNarrow] = useState(false),
		[sending, setSending] = useState(false),
		[handing, setHanding] = useState(false),
		[failure, setFailure] = useState<Failure>(null),
		[hint, setHint] = useState<PRVerdictHint | null | 'loading'>(null),
		[body, setBody] = useState(review.body),
		[writing, setWriting] = useState(false),
		[generated, setGenerated] = useState(false),
		root = useRef<HTMLDivElement>(null);
	// The files and the step column are dragged wider like the app's own columns, kept in surface-layout.json.
	const filesWidth = useSurfaceLayout((state) => state.layout.reviewFilesWidth),
		columnWidth = useSurfaceLayout((state) => state.layout.reviewColumnWidth),
		{ resize: resizeLayout, save: saveLayout } = useSurfaceLayout.getState();
	useEffect(() => setBody(review.body), [review.body]);
	// The modal is narrow below 1000 px: files go into a dropdown before the steps, the header drops the branch and the agent.
	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) =>
			setNarrow((entry?.contentRect.width ?? 1200) < 1000)
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const pr = detail?.summary ?? null,
		own = Boolean(pr?.mine),
		files = useMemo(() => (detail ? shownFiles(detail.files, viewing) : []), [detail, viewing]),
		viewed = files.filter((file) => file.viewed).length,
		threads = (detail?.threads ?? []).filter((thread) => !thread.resolved),
		drafts = review.drafts,
		proposals = drafts.filter((draft) => draft.fromAgent && !draft.accepted),
		yours = drafts.filter((draft) => !draft.fromAgent || draft.accepted),
		zero = Boolean(detail && detail.files.length === 0),
		event: Decision = own || review.event === 'AGENT' ? 'COMMENT' : (review.event as Decision);
	// spec/projects-and-board#pr-mode: the board's PR card shows «4/6 viewed» from the review file, without reading the PR's files.
	useEffect(() => {
		if (!detail || !files.length) return;
		if (review.viewed?.n === viewed && review.viewed.of === files.length) return;
		void window.brigadir.notePullRequestViewed(task, target, viewed, files.length).catch(() => {});
	}, [detail, viewed, files.length]);
	// Own PR: GitHub takes neither decision — a saved one falls back to a comment (spec/pull-requests-and-ci#review-drafts).
	useEffect(() => {
		if (own && (review.event === 'APPROVE' || review.event === 'REQUEST_CHANGES'))
			void actions.setReview({ event: 'COMMENT' });
	}, [own, review.event]);
	// The first file opens with the modal; the selected one stays while the PR is read again.
	useEffect(() => {
		if (!files.length) return;
		if (!path || !files.some((file) => file.path === path)) setPath(files[0]!.path);
	}, [files.map((file) => file.path).join('\n')]);
	useEffect(() => {
		if (detail) void window.brigadir.preparePullRequestTrees(task, target).catch(() => {});
	}, [Boolean(detail), detail?.headSha]);
	const load = (file: string) => {
		setDiffs((value) => ({ ...value, [file]: 'loading' }));
		void window.brigadir
			.preparePullRequestTrees(task, target)
			.catch(() => {})
			.then(() => window.brigadir.readPullRequestFileDiff(task, target, file))
			.then(
				(diff) => setDiffs((value) => ({ ...value, [file]: diff })),
				() => setDiffs((value) => ({ ...value, [file]: 'failed' }))
			);
	};
	useEffect(() => {
		if (path && !diffs[path]) load(path);
	}, [path]);
	// The agent's suggestions quote their lines: their files are read once.
	useEffect(() => {
		for (const draft of proposals) if (!diffs[draft.path]) load(draft.path);
	}, [proposals.map((draft) => draft.path).join('\n')]);
	// spec/appearance#evolution-redesign: the summary writes itself on the first open of the PR; the cache of any head is read, never rewritten.
	const agentsOn = appearance.agentsEnabled ?? { claude: true, codex: true },
		provider = appearance.agentProvider ?? 'claude',
		agentName = provider === 'codex' ? 'Codex' : 'Claude',
		noAgent = !agentsOn.claude && !agentsOn.codex,
		autoOff = appearance.prSummary === false;
	const started = useRef(false),
		helper = useHelperRun('prSummary');
	useEffect(() => {
		if (!detail || !summary.read || started.current) return;
		started.current = true;
		if (!summary.summary && !summary.busy && !zero && !noAgent && !autoOff)
			void generateSummary(task, target);
	}, [Boolean(detail), summary.read]);
	const stale = summary.summary && detail && summary.summary.headSha !== detail.headSha,
		since = stale ? commitsSince(detail!.commits, summary.summary!.headSha) : null;
	// The agent's hint on step 3 — once per set of drafts.
	const draftKey = drafts.map((draft) => `${draft.id}:${draft.body.length}`).join(',');
	useEffect(() => {
		if (step !== 3 || !drafts.length || noAgent) return;
		let active = true;
		setHint('loading');
		void window.brigadir.suggestPullRequestVerdict(task, target).then(
			(value) => active && setHint(value),
			() => active && setHint(null)
		);
		return () => {
			active = false;
		};
	}, [step === 3, draftKey]);
	const goTo = (file: string, start: number | null, end?: number | null) => {
		setPath(file);
		if (start) {
			setLanding({ path: file, start, end: end ?? start });
			setTaskState({ diffLineTarget: start });
		} else setLanding(null);
	};
	const reviewTask = useMemo(
		() =>
			(tasks ?? [])
				.filter(
					(item) =>
						item.projectId === task.projectId &&
						item.prReview?.mode === 'review' &&
						item.prReview.number === target.number &&
						!item.archived
				)
				.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ?? null,
		[tasks, task.projectId, target.number]
	);
	const owner =
		(tasks ?? []).find(
			(item) =>
				item.projectId === task.projectId &&
				item.pullRequests?.[target.scopeId]?.number === target.number
		) ?? null;
	const saveBody = async () => {
		if (body === review.body) return true;
		return actions.setReview({ body });
	};
	async function send() {
		if (sending || handing || !detail) return;
		setFailure(null);
		if (!(await saveBody())) {
			setFailure({ text: t(locale, 'Could not save the review.'), draft: null, reason: '' });
			return;
		}
		setSending(true);
		const done = await actions.submit();
		setSending(false);
		if (done) {
			// spec/appearance#evolution-redesign: merged here, the modal stays — the person sees both results in one place.
			if (detail.summary.state !== 'MERGED') close();
			showToast(t(locale, 'Review sent to PR #{n}').replace('{n}', String(target.number)), {
				label: t(locale, 'Open on GitHub'),
				run: () => {
					void window.brigadir
						.openPullRequestPage(task.projectId, task.id, target.scopeId, target.number)
						.catch(() => {});
				},
			});
			return;
		}
		// GitHub names the line it did not take: the draft on it is the one to move or remove.
		const reason = prReviewStore(task, target).getState().error,
			lineAt = reason.match(/line (\d+)/i),
			bad =
				drafts.find(
					(draft) => (lineAt && Number(lineAt[1]) === draft.line) || reason.includes(draft.path)
				) ?? null;
		setFailure({
			text: reason
				? t(locale, 'GitHub did not accept the review: {reason} The drafts are saved.').replace(
						'{reason}',
						reason.replace(/\.?$/, '.')
					)
				: t(locale, 'Could not send the review. The drafts are saved.'),
			draft: bad?.id ?? null,
			reason,
		});
	}
	async function hand() {
		if (!onAgentFix || sending || handing) return;
		setFailure(null);
		if (!(await saveBody())) {
			setFailure({ text: t(locale, 'Could not save the review.'), draft: null, reason: '' });
			return;
		}
		setHanding(true);
		const done = await onAgentFix(review.sendComments).finally(() => setHanding(false));
		if (done) close();
	}
	// ⌘↩ sends from step 5 — from anywhere in the modal but a text field, and from the menu (`review-send`).
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (action === 'review-send' && step === 5) void send();
			}),
		[step, review, body, sending]
	);
	const nextStep = (step < 5 ? step + 1 : null) as Step | null;
	const go = (to: Step) => {
		if (to === 2 && zero) return;
		setStep(to);
		setSide('step');
		setLanding(null);
		setFailure((value) => (to === 2 ? value : value && to === 5 ? value : null));
	};
	const forward = () => go((zero && step === 1 ? 3 : (nextStep ?? 5)) as Step);
	const back = () => go((zero && step === 3 ? 1 : Math.max(1, step - 1)) as Step);
	const suggest =
		step >= 2 ? nextStep : step === 1 && files.length > 0 && viewed === files.length ? 2 : null;
	if (!detail || !pr)
		return (
			<ModalDialog
				title={t(locale, 'Review')}
				locale={locale}
				close={close}
				large
				data-pr-review-modal={target.number}>
				{/* The modal's own frame while GitHub answers: steps, files, the diff and the step column in their places, so the
				    loaded review lands where the eye already is. */}
				<div className={styles.root} ref={root}>
					<div className={styles.steps} aria-hidden="true" />
					<div
						className={styles.body}
						style={
							{
								'--review-files': `${filesWidth}px`,
								'--review-column': `${columnWidth}px`,
							} as CSSProperties
						}>
						{!narrow && (
							<div className={styles.files} aria-hidden="true">
								<SkeletonRows count={12} />
							</div>
						)}
						<div className={styles.diff}>
							{detailError ? (
								<p className={styles.state} role="alert">
									<Glyph name="check-fail" size={13} />
									{t(locale, 'The PR could not be read.')}
									<Button
										size="s"
										onClick={() => {
											void readDetail(task, target, true);
										}}>
										{t(locale, 'Retry')}
									</Button>
								</p>
							) : (
								<LoadingStatus label={t(locale, 'Reading the PR from GitHub…')} />
							)}
						</div>
						<div className={styles.column} aria-hidden="true">
							<div className={styles.columnBody}>
								<Skeleton widths={[40]} />
								<Skeleton widths={[94, 86, 60]} />
								<Skeleton widths={[88, 70]} />
								<Skeleton widths={[76, 52]} />
							</div>
						</div>
					</div>
				</div>
			</ModalDialog>
		);
	const selected = files.find((file) => file.path === path) ?? null,
		diff = path ? diffs[path] : undefined;
	// spec/appearance#evolution-redesign: the summary in the step column and its ⚠ / ✓ on the files.
	const paths = detail.files.map((file) => file.path),
		marks = summary.summary ? summaryMarks(summary.summary, paths) : null;
	const agentSummary = (changedOpen: boolean) => (
		<AgentSummary
			key={changedOpen ? 'tab' : 'read'}
			locale={locale}
			state={summary}
			detail={detail}
			files={paths}
			provider={provider}
			agentName={agentName}
			stale={Boolean(stale)}
			since={since}
			zero={zero}
			noAgent={noAgent}
			autoOff={autoOff}
			changedOpen={changedOpen}
			capsule={
				<HelperCapsule
					locale={locale}
					title={t(locale, 'Summary agent')}
					state={helper}
					onRun={(run) => {
						void generateSummary(task, target, run);
					}}
				/>
			}
			generate={() => {
				void generateSummary(task, target, helper.run);
			}}
			stop={() => stopSummary(task, target)}
			toggle={(key) => toggleSummaryCheck(task, target, key)}
			goTo={goTo}
		/>
	);
	const tip = (item: PRSummaryItem) =>
		item.path && item.start ? `${place(item)} — ${item.text}` : item.text;
	const badges = (file: string, focusable = false) => {
		const mark = marks?.get(file);
		if (!mark) return null;
		return (
			<SpotBadges
				risks={mark.risks.map(tip)}
				checks={mark.checks.map(tip)}
				riskLabel={t(locale, 'Risky spot')}
				checkLabel={t(locale, 'To check')}
				focusable={focusable}
				go={(kind) => {
					const item = (kind === 'risk' ? mark.risks : mark.checks)[0]!;
					goTo(file, item.start, item.end);
				}}
			/>
		);
	};
	const stepTab = (value: Step) =>
		value === 2
			? `${t(locale, 'Comments')} · ${drafts.length}`
			: t(locale, value === 4 ? 'Your summary' : stepNames[value]);
	const tabs =
		step > 1 ? (
			<div className={styles.tabs} data-size="m">
				<Segments
					label={t(locale, 'Step or summary')}
					tablist
					stretch
					optionAttribute="review-tab"
					value={side}
					onChange={(value) => setSide(value as 'step' | 'summary')}
					options={[
						{ value: 'step', label: stepTab(step) },
						{
							value: 'summary',
							label: t(locale, 'Summary'),
							icon: (
								<span className={styles.accent}>
									<Glyph name="generate" size={11} />
								</span>
							),
						},
					]}
				/>
			</div>
		) : null;
	const github = () => {
		void window.brigadir
			.openPullRequestPage(task.projectId, task.id, target.scopeId, target.number)
			.catch(() => {});
	};
	const agentButton = (where: 'header' | 'column') =>
		onAgentReview &&
		!zero && (
			<AgentReviewButton
				locale={locale}
				projectId={task.projectId}
				scopeId={target.scopeId}
				number={target.number}
				title={detail?.summary.title ?? ''}
				action="reviewSuggestions"
				run={onAgentReview}
				onOpenReview={(review) => {
					closeReview(task);
					onOpenReview?.(review);
				}}
				key={where}
			/>
		);
	const tails: Partial<Record<Step, string>> = {
		1: zero ? fileCount(locale, 0) : `${viewed}/${files.length}`,
		2: zero ? '—' : String(drafts.length),
		...(step > 3 ? { 3: t(locale, decisionNames[event]) } : {}),
	};
	// spec/appearance#evolution-redesign: step 5's merge row says what the control does or why it is off.
	const merge = mergeControlState(detail, Boolean(onResolveConflicts)),
		conflict = merge === 'conflicts',
		mergeCaption =
			merge === 'merged' || merge === 'closed'
				? t(locale, merge === 'merged' ? 'The PR is merged' : 'The PR is closed')
				: conflict
					? t(locale, 'Conflicts with {base}').replace('{base}', pr.base)
					: merge === 'blocked'
						? mergeWhy(detail, locale)
						: t(locale, 'Separate from the review');
	const column =
		step === 1 ? (
			<ReadColumn
				locale={locale}
				zero={zero}
				files={files}
				viewed={viewed}
				summary={agentSummary(false)}
				threads={threads}
				select={(file) => goTo(file, null)}
				goTo={goTo}
				next={forward}
			/>
		) : step === 2 ? (
			<CommentsColumn
				locale={locale}
				proposals={proposals}
				yours={yours}
				threads={threads}
				diffs={diffs}
				busy={busy}
				failure={failure}
				reviewTask={reviewTask}
				files={files.length}
				agentButton={agentButton('column')}
				onAgentReview={onAgentReview}
				goTo={goTo}
				accept={(draft) => {
					void actions.acceptDraft(draft.id).then((ok) => {
						if (!ok) toastError(t(locale, 'Could not save the draft.'));
					});
				}}
				edit={async (draft, text, accept) => {
					const ok = await actions.editDraft(draft.id, text);
					if (ok && accept) await actions.acceptDraft(draft.id);
					if (!ok) toastError(t(locale, 'Could not save the draft.'));
					return ok;
				}}
				remove={(draft) => {
					void actions.removeDraft(draft.id).then((ok) => {
						if (!ok) toastError(t(locale, 'Could not delete the draft.'));
					});
				}}
				acceptAll={(drafts) => {
					void actions.acceptDrafts(drafts.map((draft) => draft.id)).then((ok) => {
						if (!ok) toastError(t(locale, 'Could not save the draft.'));
					});
				}}
				dropAll={async (drafts) => {
					if (!(await actions.removeDrafts(drafts.map((draft) => draft.id))))
						throw new Error('drop');
				}}
				back={back}
				next={forward}
			/>
		) : step === 3 ? (
			<VerdictColumn
				locale={locale}
				own={own}
				author={pr.author}
				event={event}
				hint={hint}
				choose={(value) => {
					void actions.setReview({ event: value });
				}}
				back={back}
				next={forward}
			/>
		) : step === 4 ? (
			<SummaryColumn
				locale={locale}
				body={body}
				count={drafts.length}
				writing={writing}
				generated={generated}
				noAgent={noAgent}
				change={(value) => {
					setBody(value);
					setGenerated(false);
				}}
				save={() => {
					void saveBody();
				}}
				generate={() => {
					setWriting(true);
					void window.brigadir
						.writePullRequestReviewBody(task, target)
						.then(
							(text) => {
								setBody(text);
								setGenerated(true);
								void actions.setReview({ body: text });
							},
							() => toastError(t(locale, 'Could not write the summary.'))
						)
						.finally(() => setWriting(false));
				}}
				back={back}
				next={forward}
			/>
		) : (
			<CheckColumn
				merge={
					<div className={styles.foot} data-size="m" data-review-merge>
						<span className={styles.mergeGlyph} data-conflict={conflict || undefined}>
							<Glyph name={conflict ? 'review-warning' : 'pr-merged'} size={13} />
						</span>
						<small>{mergeCaption}</small>
						<span className={styles.space} />
						<MergeControl
							task={task}
							target={target}
							detail={detail}
							locale={locale}
							resolve={onResolveConflicts}
						/>
					</div>
				}
				locale={locale}
				own={own}
				author={pr.author}
				viewer={viewer ?? 'you'}
				event={event}
				body={body}
				drafts={drafts}
				sending={sending}
				handing={handing}
				failure={failure}
				sendComments={review.sendComments}
				setSendComments={(value) => {
					void actions.setReview({ sendComments: value });
				}}
				fix={
					onAgentFix
						? {
								text: own
									? owner
										? t(locale, 'The task «{title}» gets {n}. Push only after you confirm.')
												.replace('{title}', owner.title)
												.replace('{n}', handedCount(locale, drafts.length, threads.length))
										: t(
												locale,
												'The agent of the PR task makes the fixes. Push only after you confirm.'
											)
									: mainTree
										? t(
												locale,
												'A quick task «Fixes #{n}» on {branch} in the main tree: it switches the tree if it is clean. Push only after you confirm.'
											)
												.replace('{n}', String(target.number))
												.replace('{branch}', pr.head)
										: detail.canPush
											? t(
													locale,
													'The agent of the task «Review #{n}» makes the fixes in a worktree on {branch}. Push only after you confirm.'
												)
													.replace('{n}', String(target.number))
													.replace('{branch}', pr.head)
											: t(
													locale,
													'You cannot push to {branch}. The agent opens a separate PR with the fixes, {branch}-fixes → {branch}.'
												).replaceAll('{branch}', pr.head),
								empty: !drafts.length && !body.trim() && !(own && threads.length),
							}
						: null
				}
				goToComment={() => {
					const bad = drafts.find((draft) => draft.id === failure?.draft);
					setStep(2);
					setSide('step');
					if (bad) goTo(bad.path, bad.line);
				}}
				send={() => {
					void send();
				}}
				hand={() => {
					void hand();
				}}
				back={back}
			/>
		);
	return (
		<ModalDialog
			title={`${t(locale, 'Review')} · ${pr.title}`}
			icon={<Glyph name="review" size={14} />}
			locale={locale}
			close={close}
			large
			data-pr-review-modal={target.number}
			headerExtra={
				<>
					<span className={styles.number}>#{target.number}</span>
					<span className={styles.who}>
						<Avatar login={own && viewer ? viewer : pr.author} />
						{own ? t(locale, 'you') : pr.author}
						{!narrow && (
							<>
								<span>·</span>
								<span className={styles.branches} title={`${pr.head} → ${pr.base}`}>
									<BranchName name={pr.head} /> → {pr.base}
								</span>
							</>
						)}
					</span>
					<span className={styles.space} />
					{/* spec/appearance#evolution-redesign: «Merge PR…» always, before «Review with an agent» — the Overview's control and dialog. */}
					<MergeControl
						task={task}
						target={target}
						detail={detail}
						locale={locale}
						narrow={narrow}
						resolve={onResolveConflicts}
					/>
					{!narrow && agentButton('header')}
					<IconButton label={t(locale, 'Open on GitHub')} onClick={github}>
						<Glyph name="external" size={12} />
					</IconButton>
				</>
			}
			onKeyDown={(event: KeyboardEvent<HTMLDialogElement>) => {
				if (
					step === 5 &&
					event.key === 'Enter' &&
					primaryKey(event) &&
					!(event.target as HTMLElement).closest('textarea, [contenteditable]')
				) {
					event.preventDefault();
					void send();
				}
			}}>
			<div className={styles.root} ref={root} data-narrow={narrow || undefined}>
				<nav className={styles.steps} data-size="m" aria-label={t(locale, 'Review steps')}>
					{narrow && (
						<FilesDropdown
							locale={locale}
							files={files}
							viewed={viewed}
							path={path}
							select={(file) => goTo(file, null)}
						/>
					)}
					{([1, 2, 3, 4, 5] as Step[]).map((value, index) => (
						<StepButton
							key={value}
							value={value}
							locale={locale}
							current={step}
							tail={tails[value]}
							suggested={suggest === value}
							disabled={value === 2 && zero}
							line={index > 0}
							go={() => go(value)}
						/>
					))}
				</nav>
				<div
					className={styles.body}
					style={
						{
							'--review-files': `${filesWidth}px`,
							'--review-column': `${columnWidth}px`,
						} as CSSProperties
					}>
					{!narrow && (
						<div className={styles.files} aria-label={t(locale, 'Files')} role="group">
							{zero ? (
								<Empty
									glyph="folder"
									title={t(locale, 'No files')}
									text={t(locale, 'The PR head and {base} have the same tree.').replace(
										'{base}',
										pr.base
									)}
								/>
							) : (
								files.map((file) => (
									<PRFileRow
										key={file.path}
										file={file}
										locale={locale}
										projectName={projectName}
										comments={(detail.threads ?? [])
											.filter((thread) => thread.path === file.path)
											.reduce((sum, thread) => sum + thread.comments.length, 0)}
										opening={diffs[file.path] === 'loading' && file.path === path}
										pressed={file.path === path}
										saving={viewing[file.path]?.saving}
										pending={Boolean(viewing[file.path])}
										failed={viewedError?.path === file.path}
										badges={badges(file.path)}
										open={() => goTo(file.path, null)}
										view={() => {
											void actions.viewed(file.path, !file.viewed);
										}}
									/>
								))
							)}
						</div>
					)}
					{!narrow && (
						<ResizeHandle
							edge="end"
							label={t(locale, 'Resize the files')}
							value={filesWidth}
							min={layoutLimits.reviewFilesWidth[0]}
							max={layoutLimits.reviewFilesWidth[1]}
							onChange={(value) => resizeLayout('reviewFilesWidth', value)}
							onCommit={saveLayout}
						/>
					)}
					<div className={styles.diff}>
						{zero ? (
							<Empty
								glyph="diff"
								title={t(locale, 'No changes')}
								text={t(locale, '{n}, but together they change nothing against {base}.')
									.replace('{n}', commitWord(locale, detail.commits.length))
									.replace('{base}', pr.base)}
								action={
									<Button onClick={github}>
										<Glyph name="external" size={11} />
										{t(locale, 'Open on GitHub')}
									</Button>
								}
							/>
						) : diff && typeof diff === 'object' ? (
							<PRDiffView
								key={diff.file.id}
								task={task}
								target={target}
								diff={diff}
								locale={locale}
								onCompose={onCompose}
								onDeliver={onDeliver}
								highlight={landing?.path === path ? landing : null}
								summary={
									summary.summary
										? {
												spots: summarySpots(
													summary.summary,
													paths,
													diff.file.path,
													summary.dismissed
												),
												stale: Boolean(stale),
												dismiss: (spot) => dismissSummarySpot(task, target, spot.key),
												commented: () => go(2),
											}
										: undefined
								}
								head={(layout) => (
									<DiffHead
										layout={layout}
										locale={locale}
										path={diff.file.path}
										base={pr.base}
										head={detail.headSha}
										badges={badges(diff.file.path, true)}
										viewed={selected?.viewed ?? false}
										view={() => {
											if (selected) void actions.viewed(selected.path, !selected.viewed);
										}}
									/>
								)}
							/>
						) : diff === 'failed' ? (
							<div className={styles.state} role="alert">
								<Glyph name="check-fail" size={13} />
								<span>{t(locale, 'The file could not be read.')}</span>
								<Button size="s" onClick={() => path && load(path)}>
									{t(locale, 'Retry')}
								</Button>
							</div>
						) : (
							<LoadingStatus label={t(locale, 'Reading the file changes…')} />
						)}
					</div>
					<ResizeHandle
						label={t(locale, 'Resize the step column')}
						value={columnWidth}
						min={layoutLimits.reviewColumnWidth[0]}
						max={layoutLimits.reviewColumnWidth[1]}
						onChange={(value) => resizeLayout('reviewColumnWidth', value)}
						onCommit={saveLayout}
					/>
					<SummaryTab.Provider
						value={tabs ? { tabs, summary: side === 'summary' ? agentSummary(true) : null } : null}>
						{column}
					</SummaryTab.Provider>
				</div>
			</div>
		</ModalDialog>
	);
}

const commitWord = (locale: Locale, n: number) =>
	locale === 'uk'
		? `${n} ${({ one: 'коміт', few: 'коміти', many: 'комітів', other: 'коміту' } as Record<string, string>)[new Intl.PluralRules('uk').select(n)] ?? 'комітів'}`
		: `${n} ${n === 1 ? 'commit' : 'commits'}`;

function Empty({
	glyph,
	title,
	text,
	action,
}: {
	glyph: 'folder' | 'diff';
	title: string;
	text: string;
	action?: ReactNode;
}) {
	return (
		<div className={styles.empty}>
			<Glyph name={glyph} size={glyph === 'diff' ? 22 : 18} />
			<b>{title}</b>
			<span>{text}</span>
			{action}
		</div>
	);
}

/** The diff's own row in the modal (32 px): the file, base…head, the diff layout controls and «Viewed». */
function DiffHead({
	layout,
	locale,
	path,
	base,
	head,
	badges,
	viewed,
	view,
}: {
	/** spec/appearance#evolution-redesign: the summary's ⚠ / ✓ on this file. */ badges: ReactNode;
	layout: ReactNode;
	locale: Locale;
	path: string;
	base: string;
	head: string;
	viewed: boolean;
	view(): void;
}) {
	return (
		<div className={styles.diffHead} data-size="s">
			<FileIcon name={fileName(path)} />
			<span className={styles.diffName}>{fileName(path)}</span>
			<small className={styles.diffDir}>{folderOf(path)}</small>
			{badges}
			<span className={styles.space} />
			<small className={styles.diffDir}>
				{base}…{head.slice(0, 7)}
			</small>
			{layout}
			<label className={styles.viewed}>
				<Choice
					type="checkbox"
					label={`${t(locale, 'Viewed')} · ${path}`}
					checked={viewed}
					onChange={view}
				/>
				<span>{t(locale, 'Viewed')}</span>
			</label>
		</div>
	);
}

function FilesDropdown({
	locale,
	files,
	viewed,
	path,
	select,
}: {
	locale: Locale;
	files: PullRequestDetail['files'];
	viewed: number;
	path: string | null;
	select(path: string): void;
}) {
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null);
	return (
		<>
			<Button
				ref={anchor}
				className={styles.fileDrop}
				disabled={!files.length}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((value) => !value)}>
				{files.length && path ? (
					<>
						<FileIcon name={fileName(path)} />
						<span className={styles.fileDropName}>{fileName(path)}</span>
						<small>
							{viewed}/{files.length}
						</small>
					</>
				) : (
					<>
						<Glyph name="folder" size={12} />
						{t(locale, 'No files')}
					</>
				)}
				<Glyph name="chevron-down" size={9} />
			</Button>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={anchor}
				align="start"
				width={280}
				focus="checked"
				label={t(locale, 'Files')}
				locale={locale}>
				{files.map((file) => (
					<MenuItem
						key={file.path}
						kind="radio"
						checked={file.path === path}
						description={folderOf(file.path)}
						onSelect={() => select(file.path)}>
						{fileName(file.path)}
						{file.viewed ? ' ✓' : ''}
					</MenuItem>
				))}
			</MenuPopover>
		</>
	);
}

function StepButton({
	value,
	locale,
	current,
	tail,
	suggested,
	disabled,
	line,
	go,
}: {
	value: Step;
	locale: Locale;
	current: Step;
	tail: string | undefined;
	suggested: boolean;
	disabled: boolean;
	line: boolean;
	go(): void;
}) {
	const state = value === current ? 'on' : value < current ? 'done' : 'next';
	return (
		<>
			{line && <span className={styles.stepLine} aria-hidden="true" />}
			<button
				type="button"
				className={styles.step}
				data-state={state}
				data-suggested={suggested || undefined}
				data-review-step={value}
				aria-current={value === current ? 'step' : undefined}
				disabled={disabled}
				onClick={go}>
				<i>{state === 'done' ? <Glyph name="tick" size={10} /> : value}</i>
				{t(locale, stepNames[value])}
				{tail && <small>{tail}</small>}
			</button>
		</>
	);
}

/**
 * spec/appearance#evolution-redesign: the agent summary of the PR in the step column — step 1 «Read» is the summary, steps
 * 2–5 show it under the «✦ Summary» tab (spec/pull-requests-and-ci#pr-summary cache by head SHA, the same as Overview). The header carries the Helper
 * capsule and Regenerate or Stop; then the TL;DR, risky spots as `file:line` links, «What to check» ticks (only for
 * the person, never sent), «What changed · N» and the size. Writing — a skeleton here, the diff reads meanwhile; no summary
 * — a quiet reason with at most one action.
 */
function AgentSummary({
	locale,
	state,
	detail,
	files,
	provider,
	agentName,
	stale,
	since,
	zero,
	noAgent,
	autoOff,
	changedOpen,
	capsule,
	generate,
	stop,
	toggle,
	goTo,
}: {
	locale: Locale;
	state: ReturnType<typeof usePRSummary>;
	detail: PullRequestDetail;
	files: readonly string[];
	provider: 'claude' | 'codex';
	agentName: string;
	stale: boolean;
	since: string[] | null;
	zero: boolean;
	noAgent: boolean;
	autoOff: boolean;
	/** «What changed» starts open on the tab of steps 2–5, folded on step 1. */ changedOpen: boolean;
	/** spec/appearance#evolution-redesign: who writes the summary — the Helper agent's capsule. */ capsule: ReactNode;
	generate(): void;
	stop(): void;
	toggle(key: string): void;
	goTo(path: string, start: number | null, end?: number | null): void;
}) {
	const [changed, setChanged] = useState(changedOpen);
	const summary = state.summary,
		// The lines of the PR as its files count them: GitHub's totals may lag a push.
		added = detail.files.reduce((sum, file) => sum + file.additions, 0),
		removed = detail.files.reduce((sum, file) => sum + file.deletions, 0);
	const head = (
		glyph: ReactNode,
		tail: ReactNode,
		tone: 'ready' | 'quiet' | 'writing' = 'ready'
	) => (
		<div className={styles.sumHead} data-size="s" data-tone={tone}>
			{glyph}
			<b>{t(locale, 'Summary')}</b>
			<span className={styles.space} />
			{tail}
		</div>
	);
	const quiet = (
		text: string,
		options: { glyph?: ReactNode; action?: ReactNode; error?: boolean; capsule?: boolean } = {}
	) => (
		<section className={styles.summary} data-summary="quiet" aria-label={t(locale, 'Summary')}>
			{head(
				<Glyph name="generate" size={13} />,
				options.capsule === false ? null : capsule,
				'quiet'
			)}
			<Banner
				size="s"
				tone={options.error ? 'error' : 'quiet'}
				glyph={options.glyph}
				title={text}
				action={options.action}
			/>
		</section>
	);
	const generateButton = (
		<Button onClick={generate}>
			<span className={styles.accent}>
				<Glyph name="generate" size={11} />
			</span>
			{t(locale, 'Generate a summary')}
		</Button>
	);
	if (state.busy)
		return (
			<section
				className={styles.summary}
				data-summary="writing"
				aria-busy="true"
				aria-label={t(locale, 'Summary')}>
				{head(
					<Spinner size={13} />,
					<>
						{capsule}
						<Button onClick={stop}>{t(locale, 'Stop')}</Button>
					</>,
					'writing'
				)}
				<p className={styles.expl} role="status">
					{t(locale, 'Reading {n}… The diff is ready to read meanwhile.').replace(
						'{n}',
						fileCount(locale, detail.files.length)
					)}
				</p>
				<Skeleton widths={[94, 86, 60]} />
				<Heading>{t(locale, 'Risky spots')}</Heading>
				<Skeleton widths={[88, 70]} />
				<Heading>{t(locale, 'What to check')}</Heading>
				<Skeleton widths={[76, 52]} />
			</section>
		);
	if (zero)
		return quiet(t(locale, 'Nothing to summarize: the PR changes no files.'), { capsule: false });
	if (!summary) {
		if (state.error === summarySignIn)
			return quiet(
				t(locale, 'Sign in to {agent} to get a summary. The review works without it.').replace(
					'{agent}',
					agentName
				),
				{
					capsule: false,
					glyph: (
						<span className={styles.amber}>
							<Glyph name="agent-key" size={13} />
						</span>
					),
					action: (
						<Button
							onClick={() => {
								void signInAgent(provider).catch(() => {});
							}}>
							{t(locale, 'Sign in to {agent}…').replace('{agent}', agentName)}
						</Button>
					),
				}
			);
		if (state.error)
			return quiet(
				state.error === 'failed'
					? t(locale, 'Could not write the summary.')
					: t(
							locale,
							'Could not write the summary: {reason}. The review works without it.'
						).replace('{reason}', state.error.replace(/\.$/, '')),
				{ error: true, action: <Button onClick={generate}>{t(locale, 'Retry')}</Button> }
			);
		if (noAgent)
			return quiet(
				t(locale, 'No agent can write a summary: Claude and Codex are off in Settings ▸ Agents.'),
				{
					capsule: false,
					action: (
						<Button
							onClick={() => {
								window.dispatchEvent(
									new CustomEvent('brigadir:open-settings', { detail: 'agents' })
								);
							}}>
							{t(locale, 'Open Settings')}
						</Button>
					),
				}
			);
		if (autoOff || state.read)
			return quiet(t(locale, autoOff ? 'Automatic summaries are off.' : 'No summary yet.'), {
				action: generateButton,
			});
		return quiet(t(locale, 'Reading the summary…'));
	}
	const risky = summary.watch.map((item) => locateSummaryItem(item, files)),
		checks = summaryChecks(summary, files),
		ticked = checks.filter((_, index) => state.checked[`${summary.headSha}:${index}`]).length,
		tldr = summary.headline || summary.done[0]?.text || '',
		minutes =
			summary.minutes ?? Math.max(2, Math.round((added + removed) / 25 + detail.files.length));
	return (
		<section className={styles.summary} data-summary="ready" aria-label={t(locale, 'Summary')}>
			{head(
				<Glyph name="generate" size={13} />,
				<>
					{capsule}
					<Button variant="ghost" onClick={generate}>
						{t(locale, 'Regenerate')}
					</Button>
				</>
			)}
			{stale && (
				<Banner
					size="s"
					tone="warning"
					data-summary-stale
					title={
						since === null
							? t(locale, 'The PR changed since the summary.')
							: t(locale, '{n} since the summary.').replace(
									'{n}',
									newCommitCount(locale, since.length)
								)
					}
					action={
						<Button onClick={generate}>
							<span className={styles.accent}>
								<Glyph name="generate" size={11} />
							</span>
							{t(locale, 'Update summary')}
						</Button>
					}
				/>
			)}
			{tldr && <p className={styles.tldr}>{tldr}</p>}
			{risky.length ? (
				<>
					<Heading>
						<span className={styles.amber}>
							<Glyph name="review-warning" size={11} />
						</span>
						{t(locale, 'Risky spots')} · {risky.length}
					</Heading>
					<div className={styles.spots}>
						{risky.map((item, index) => (
							<SpotRow
								key={index}
								locale={locale}
								item={item}
								mark={
									<span className={styles.amber}>
										<Glyph name="review-warning" size={12} />
									</span>
								}
								goTo={goTo}
							/>
						))}
					</div>
				</>
			) : (
				<>
					<Heading>{t(locale, 'Risky spots')}</Heading>
					<p className={styles.none} data-pad>
						{t(locale, 'No risky spots found.')}
					</p>
				</>
			)}
			<Heading>
				{t(locale, 'What to check')}
				{checks.length > 0 &&
					` · ${t(locale, '{n} of {total}')
						.replace('{n}', String(ticked))
						.replace('{total}', String(checks.length))}`}
				{checks.length > 0 && (
					<small className={styles.headingTail}>{t(locale, 'only for you')}</small>
				)}
			</Heading>
			{checks.length ? (
				<div className={styles.checks}>
					{checks.map((item, index) => {
						const key = `${summary.headSha}:${index}`;
						return (
							<label
								key={key}
								className={styles.checkRow}
								data-done={state.checked[key] || undefined}>
								<Choice
									type="checkbox"
									label={item.text}
									checked={Boolean(state.checked[key])}
									onChange={() => toggle(key)}
								/>
								<span>{item.text}</span>
							</label>
						);
					})}
				</div>
			) : (
				<p className={styles.none} data-pad>
					{t(locale, 'Nothing beyond the diff.')}
				</p>
			)}
			<Heading>
				{t(locale, 'What changed')} · {summary.done.length}
				{summary.done.length > 0 && (
					<button
						type="button"
						className={styles.headingToggle}
						aria-expanded={changed}
						onClick={() => setChanged((value) => !value)}>
						{t(locale, changed ? 'Less (summary)' : 'Show')}
					</button>
				)}
			</Heading>
			{changed && summary.done.length > 0 && (
				<div className={styles.spots} data-summary-changed>
					{summary.done.map((item, index) => (
						<SpotRow
							key={index}
							locale={locale}
							item={locateSummaryItem(item, files)}
							mark={<span className={styles.markGap} />}
							goTo={goTo}
						/>
					))}
				</div>
			)}
			<p className={styles.expl} data-summary-size>
				{fileCount(locale, detail.files.length)} ·{' '}
				<ChangeCounts additions={added} deletions={removed} locale={locale} /> ·{' '}
				{commitWord(locale, detail.commits.length)} · ~
				{t(locale, '{n} min').replace('{n}', String(minutes))}
			</p>
		</section>
	);
}
/**
 * A spot of the summary: a mark, the `file:line` link on its own line and the text, wrapped. The whole
 * row lands the diff on the lines (rule 15); a spot without a file is text only.
 */
function SpotRow({
	locale,
	item,
	mark,
	goTo,
}: {
	locale: Locale;
	item: PRSummaryItem;
	mark: ReactNode;
	goTo(path: string, start: number | null, end?: number | null): void;
}) {
	const where = item.path ? place(item) : '';
	return (
		<div className={styles.row} data-spot>
			{item.path && (
				<button
					type="button"
					className={styles.rowButton}
					aria-label={`${t(locale, 'Go to the code')} · ${where}`}
					title={item.path}
					onClick={() => goTo(item.path!, item.start, item.end)}
				/>
			)}
			<span className={styles.rowMark}>{mark}</span>
			<span className={styles.spotCopy}>
				{where && <span className={styles.spotLink}>{where}</span>}
				<span>{item.text}</span>
			</span>
		</div>
	);
}

/**
 * spec/appearance#evolution-redesign: on steps 2–5 the column carries two tabs — the step and «✦ Summary» (the agent summary of the PR). The
 * modal hands them in; a step column shows the summary in its body while that tab is on, and keeps its own footer.
 */
const SummaryTab = createContext<{ tabs: ReactNode; summary: ReactNode | null } | null>(null);
/** The step's column: a title row, the body, and the footer with Back / Next. */
function Column({
	title,
	note,
	children,
	foot,
	dim = false,
	bare = false,
	step,
}: {
	title: string;
	note?: ReactNode;
	children: ReactNode;
	foot: ReactNode;
	dim?: boolean;
	/** Step 1: the summary's own header heads the column (spec/appearance#evolution-redesign); the title is the column's name only. */ bare?: boolean;
	step: Step;
}) {
	const tab = useContext(SummaryTab);
	return (
		<aside className={styles.column} data-review-column={step} aria-label={title}>
			{tab?.tabs}
			<div
				className={styles.columnBody}
				data-dim={dim || undefined}
				aria-busy={dim || undefined}
				data-review-summary-tab={tab?.summary ? true : undefined}>
				{tab?.summary ?? (
					<>
						{!bare && (
							<h3 className={styles.columnTitle}>
								<span>{title}</span>
								{note !== undefined && <small>{note}</small>}
							</h3>
						)}
						{children}
					</>
				)}
			</div>
			{foot}
		</aside>
	);
}
function Foot({
	locale,
	left,
	back,
	next,
	nextLabel,
	disabled = false,
	children,
}: {
	locale: Locale;
	left: ReactNode;
	back?: (() => void) | undefined;
	next?: (() => void) | undefined;
	nextLabel?: string;
	disabled?: boolean;
	children?: ReactNode;
}) {
	return (
		<div className={styles.foot} data-size="m">
			<small>{left}</small>
			<span className={styles.space} />
			{back && (
				<Button disabled={disabled} onClick={back}>
					{t(locale, 'Back')}
				</Button>
			)}
			{children}
			{next && nextLabel && (
				<Button appearance="primary" disabled={disabled} onClick={next}>
					{nextLabel}
				</Button>
			)}
		</div>
	);
}
const nextLabel = (locale: Locale, step: Step) =>
	t(locale, 'Next: {step}').replace('{step}', t(locale, stepNames[step]));
function Heading({ children, agent = false }: { children: ReactNode; agent?: boolean }) {
	return (
		<h4 className={styles.heading}>
			{agent && <Glyph name="generate" size={10} />}
			{children}
		</h4>
	);
}

/**
 * A row of the column's lists: a mark, `file · line` and one line of text. The row is one button over
 * its whole area (rule 15); its own actions lie above it on hover.
 */
function ListRow({
	mark,
	first,
	text,
	tail,
	actions,
	onClick,
	bad = false,
	label,
	...data
}: {
	mark: ReactNode;
	first: ReactNode;
	text: ReactNode;
	tail?: ReactNode;
	actions?: ReactNode;
	onClick?: (() => void) | undefined;
	bad?: boolean;
	label?: string | undefined;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<div className={styles.row} data-bad={bad || undefined} {...data}>
			{onClick && (
				<button type="button" className={styles.rowButton} aria-label={label} onClick={onClick} />
			)}
			<span className={styles.rowMark}>{mark}</span>
			<span className={styles.rowCopy}>
				<span className={styles.rowFirst}>{first}</span>
				<span className={styles.rowText}>{text}</span>
			</span>
			{tail}
			{actions && <span className={styles.rowActions}>{actions}</span>}
		</div>
	);
}
function ThreadRows({
	locale,
	threads,
	goTo,
	empty = false,
}: {
	locale: Locale;
	threads: PRThread[];
	goTo(path: string, start: number | null): void;
	empty?: boolean;
}) {
	if (!threads.length)
		return empty ? (
			<>
				<Heading>{t(locale, 'Open threads')}</Heading>
				<p className={styles.none}>{t(locale, 'No open threads.')}</p>
			</>
		) : null;
	return (
		<>
			<Heading>
				{t(locale, threads.length === 1 ? 'Open thread' : 'Open threads')} · {threads.length}
			</Heading>
			<div className={styles.rows}>
				{threads.map((thread) => (
					<ListRow
						key={thread.id}
						data-review-thread={thread.id}
						mark={<Avatar login={thread.comments[0]?.author ?? '?'} />}
						first={`${fileName(thread.path)} · ${thread.line ?? ''}`}
						text={thread.comments[0]?.body.split('\n')[0] ?? ''}
						tail={<span className={styles.openDot} title={t(locale, 'Open thread')} />}
						label={`${t(locale, 'Go to the code')} · ${thread.path}:${thread.line ?? ''}`}
						onClick={() => goTo(thread.path, thread.line)}
					/>
				))}
			</div>
		</>
	);
}

function ReadColumn({
	locale,
	zero,
	files,
	viewed,
	summary,
	threads,
	select,
	goTo,
	next,
}: {
	locale: Locale;
	zero: boolean;
	files: PullRequestDetail['files'];
	viewed: number;
	/** spec/appearance#evolution-redesign: step 1 «Read» is the summary — the agent summary heads the column. */ summary: ReactNode;
	threads: PRThread[];
	select(path: string): void;
	goTo(path: string, start: number | null, end?: number | null): void;
	next(): void;
}) {
	if (zero)
		return (
			<Column
				step={1}
				bare
				title={t(locale, 'Read the changes (step)')}
				foot={
					<Foot
						locale={locale}
						left={t(locale, 'No files')}
						next={next}
						nextLabel={nextLabel(locale, 3)}
					/>
				}>
				{summary}
				<p className={styles.expl}>
					{t(
						locale,
						'This PR changes no files, so there is nothing to read or comment on lines. You can still send a verdict or a comment.'
					)}
				</p>
			</Column>
		);
	const left = files.filter((file) => !file.viewed),
		all = files.length > 0 && !left.length;
	return (
		<Column
			step={1}
			bare
			title={t(locale, 'Read the changes (step)')}
			foot={
				<Foot
					locale={locale}
					left={
						all
							? t(locale, 'All {n} viewed').replace('{n}', String(files.length))
							: t(locale, '{n} not viewed').replace('{n}', String(left.length))
					}
					next={next}
					nextLabel={nextLabel(locale, 2)}
				/>
			}>
			{summary}
			{all ? (
				<Banner
					size="s"
					tone="success"
					title={t(locale, 'All {n} files viewed.').replace('{n}', String(files.length))}
				/>
			) : (
				<>
					<Heading>
						{t(locale, 'Not viewed yet')} · {left.length}
						<small className={styles.headingTail}>
							{t(locale, '{n} of {total} viewed')
								.replace('{n}', String(viewed))
								.replace('{total}', String(files.length))}
						</small>
					</Heading>
					<p className={styles.unviewed}>
						{left.map((file, index) => (
							<span key={file.path}>
								{index > 0 && ', '}
								<button
									type="button"
									className={styles.fileLink}
									data-review-unviewed={file.path}
									title={file.path}
									onClick={() => select(file.path)}>
									{fileName(file.path)}
								</button>
							</span>
						))}
					</p>
				</>
			)}
			<ThreadRows locale={locale} threads={threads} goTo={goTo} empty={all} />
		</Column>
	);
}

function Suggestion({
	locale,
	draft,
	diff,
	busy,
	accept,
	edit,
	drop,
	goTo,
}: {
	locale: Locale;
	draft: PRDraft;
	diff: FileDiff | undefined;
	busy: boolean;
	accept(): void;
	edit(text: string): Promise<boolean>;
	drop(): void;
	goTo(): void;
}) {
	const [editing, setEditing] = useState(false),
		[text, setText] = useState(draft.body),
		quote = quoteOf(diff, draft);
	return (
		<div className={styles.card} data-review-suggestion={draft.id}>
			<div className={styles.cardHead}>
				<FileIcon name={fileName(draft.path)} />
				<b>{fileName(draft.path)}</b>
				<span className={styles.cardLine}>{lines(draft)}</span>
				<span className={styles.agentTag} title={t(locale, 'A draft from the agent')}>
					<Glyph name="generate" size={10} />
					{t(locale, 'Agent')}
				</span>
			</div>
			{quote.trim() && <CodeQuote text={quote} path={draft.path} locale={locale} />}
			{editing ? (
				<>
					<TextArea
						className={styles.cardEdit}
						aria-label={t(locale, 'Edit the comment')}
						value={text}
						autoFocus
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								event.stopPropagation();
								setEditing(false);
								setText(draft.body);
							}
							if (event.key === 'Enter' && primaryKey(event)) {
								event.preventDefault();
								event.stopPropagation();
								void edit(text).then((ok) => ok && setEditing(false));
							}
						}}
					/>
					<div className={styles.cardActions} data-size="s">
						<span className={styles.space} />
						<PopupClose
							locale={locale}
							close={() => {
								setEditing(false);
								setText(draft.body);
							}}
						/>
						<Button
							appearance="primary"
							disabled={busy || !text.trim()}
							onClick={() => {
								void edit(text).then((ok) => ok && setEditing(false));
							}}>
							{t(locale, 'Save')}
						</Button>
					</div>
				</>
			) : (
				<>
					<p className={styles.cardText}>{draft.body}</p>
					<div className={styles.cardActions} data-size="s">
						<Button appearance="primary" disabled={busy} onClick={accept}>
							{t(locale, 'Accept')}
						</Button>
						<Button disabled={busy} onClick={() => setEditing(true)}>
							{t(locale, 'Edit')}
						</Button>
						<Button disabled={busy} onClick={drop}>
							{t(locale, 'Drop')}
						</Button>
						<span className={styles.space} />
						<IconButton label={t(locale, 'Go to the code')} onClick={goTo}>
							<Glyph name="forward" size={12} />
						</IconButton>
					</div>
				</>
			)}
		</div>
	);
}

function DraftRow({
	locale,
	draft,
	busy,
	bad,
	goTo,
	edit,
	remove,
}: {
	locale: Locale;
	draft: PRDraft;
	busy: boolean;
	bad: boolean;
	goTo(): void;
	edit(text: string): Promise<boolean>;
	remove(): void;
}) {
	const [editing, setEditing] = useState(false),
		[text, setText] = useState(draft.body);
	if (editing)
		return (
			<div className={styles.card} data-review-draft={draft.id} data-editing>
				<div className={styles.cardHead}>
					<FileIcon name={fileName(draft.path)} />
					<b>{fileName(draft.path)}</b>
					<span className={styles.cardLine}>{lines(draft)}</span>
				</div>
				<TextArea
					className={styles.cardEdit}
					aria-label={t(locale, 'Edit the comment')}
					value={text}
					autoFocus
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							event.stopPropagation();
							setEditing(false);
							setText(draft.body);
						}
						if (event.key === 'Enter' && primaryKey(event)) {
							event.preventDefault();
							event.stopPropagation();
							void edit(text).then((ok) => ok && setEditing(false));
						}
					}}
				/>
				<div className={styles.cardActions} data-size="s">
					<span className={styles.space} />
					<PopupClose
						locale={locale}
						close={() => {
							setEditing(false);
							setText(draft.body);
						}}
					/>
					<Button
						appearance="primary"
						disabled={busy || !text.trim()}
						onClick={() => {
							void edit(text).then((ok) => ok && setEditing(false));
						}}>
						{t(locale, 'Save')}
					</Button>
				</div>
			</div>
		);
	return (
		<ListRow
			data-review-draft={draft.id}
			bad={bad}
			mark={
				draft.fromAgent ? (
					<span className={styles.accent}>
						<Glyph name="generate" size={12} />
					</span>
				) : (
					<Glyph name="edit" size={12} />
				)
			}
			first={`${fileName(draft.path)} · ${lines(draft)}`}
			text={draft.body.split('\n')[0]}
			label={`${t(locale, 'Go to the code')} · ${draft.path}:${draft.line}`}
			onClick={goTo}
			actions={
				<>
					<IconButton label={t(locale, 'Go to the code')} onClick={goTo}>
						<Glyph name="forward" size={12} />
					</IconButton>
					<IconButton label={t(locale, 'Edit')} disabled={busy} onClick={() => setEditing(true)}>
						<Glyph name="edit" size={12} />
					</IconButton>
					<IconButton label={t(locale, 'Remove')} disabled={busy} onClick={remove}>
						<Glyph name="trash" size={12} />
					</IconButton>
				</>
			}
		/>
	);
}

function CommentsColumn({
	locale,
	proposals,
	yours,
	threads,
	diffs,
	busy,
	failure,
	reviewTask,
	files,
	agentButton,
	onAgentReview,
	goTo,
	accept,
	edit,
	remove,
	acceptAll,
	dropAll,
	back,
	next,
}: {
	locale: Locale;
	proposals: PRDraft[];
	yours: PRDraft[];
	threads: PRThread[];
	diffs: Record<string, FileDiff | 'loading' | 'failed'>;
	busy: boolean;
	failure: Failure;
	reviewTask: AgentTask | null;
	files: number;
	agentButton: ReactNode;
	/** spec/pull-requests-and-ci#review-launch: starts the review the launch dialog describes; answers whether its task started. */
	onAgentReview?: ((choice: ReviewChoice) => Promise<boolean>) | undefined;
	goTo(path: string, start: number | null): void;
	accept(draft: PRDraft): void;
	edit(draft: PRDraft, text: string, accept: boolean): Promise<boolean>;
	remove(draft: PRDraft): void;
	acceptAll(drafts: PRDraft[]): void;
	dropAll(drafts: PRDraft[]): Promise<void>;
	back(): void;
	next(): void;
}) {
	const [dropping, setDropping] = useState(false);
	const total = proposals.length + yours.length,
		running =
			reviewTask && ['queued', 'preparing', 'working'].includes(reviewTask.status as string),
		where = reviewTask?.launch?.isolation === 'worktree' ? 'worktree' : 'quick';
	const empty = !total;
	return (
		<Column
			step={2}
			title={t(locale, 'Comments')}
			note={
				proposals.length
					? `${total} · ${t(locale, '{n} to go through').replace('{n}', String(proposals.length))}`
					: String(total)
			}
			foot={
				<Foot
					locale={locale}
					left={
						empty
							? t(locale, 'No comments yet')
							: proposals.length
								? t(locale, 'Accept or drop the agent’s first')
								: commentCount(locale, total)
					}
					back={back}
					next={next}
					nextLabel={nextLabel(locale, 3)}
				/>
			}>
			{failure?.draft && failure.reason && (
				<Banner
					size="s"
					tone="error"
					title={t(
						locale,
						'GitHub: {reason} Move the comment to a changed line or remove it.'
					).replace('{reason}', failure.reason.replace(/\.?$/, '.'))}
				/>
			)}
			{empty && !running && !reviewTask ? (
				<div className={styles.emptyComments}>
					<b>{t(locale, 'No comments yet')}</b>
					<div className={styles.inline} data-size="s">
						{agentButton}
					</div>
				</div>
			) : (
				<>
					<Heading agent>
						{t(locale, 'From the agent')}
						{proposals.length > 0 &&
							` · ${t(locale, '{n} to go through').replace('{n}', String(proposals.length))}`}
						{/* spec/pull-requests-and-ci#review-modal: the whole batch at once, from two suggestions on. */}
						{proposals.length > 1 && (
							<>
								<button
									type="button"
									className={styles.headingToggle}
									disabled={busy}
									data-accept-all
									onClick={() => acceptAll(proposals)}>
									{t(locale, 'Accept all')}
								</button>
								<button
									type="button"
									className={styles.headingToggle}
									disabled={busy}
									data-drop-all
									onClick={() => setDropping(true)}>
									{t(locale, 'Drop all')}
								</button>
							</>
						)}
					</Heading>
					{dropping && (
						<ConfirmDialog
							locale={locale}
							title={t(locale, 'Drop all suggestions?')}
							action={t(locale, 'Drop all')}
							danger
							error={t(locale, 'Could not delete the draft.')}
							cancel={() => setDropping(false)}
							confirm={async () => {
								await dropAll(proposals);
								setDropping(false);
							}}>
							<p>
								{t(
									locale,
									'The agent’s suggestions will be removed. Your comments stay. You can ask the agent again.'
								)}
							</p>
						</ConfirmDialog>
					)}
					{proposals.length ? (
						proposals.map((draft) => (
							<Suggestion
								key={draft.id}
								locale={locale}
								draft={draft}
								diff={
									typeof diffs[draft.path] === 'object'
										? (diffs[draft.path] as FileDiff)
										: undefined
								}
								busy={busy}
								accept={() => accept(draft)}
								edit={(text) => edit(draft, text, true)}
								drop={() => remove(draft)}
								goTo={() => goTo(draft.path, draft.line)}
							/>
						))
					) : running ? (
						<Banner size="s" tone="working" title={t(locale, 'The agent is reading the PR…')} />
					) : reviewTask ? (
						<>
							<Banner
								size="s"
								tone="done"
								title={t(locale, 'The agent read {n} and has no suggestions.').replace(
									'{n}',
									fileCount(locale, files)
								)}
								action={
									onAgentReview && (
										<Button
											variant="ghost"
											onClick={() =>
												void onAgentReview({ where, agent: null, crew: null, notes: '' }).then(
													(ok) => ok || toastError(t(locale, 'Could not start the review task.'))
												)
											}>
											{t(locale, 'Ask again')}
										</Button>
									)
								}
							/>
							<p className={styles.expl} data-tight>
								{t(locale, 'Review with an agent')} ·{' '}
								{t(locale, where === 'quick' ? 'quickly' : 'in a worktree')}
								{reviewTask.updatedAt ? ` · ${relativeAge(locale, reviewTask.updatedAt)}` : ''}
							</p>
						</>
					) : (
						<div className={styles.inline} data-size="s">
							<span className={styles.none}>{t(locale, 'Not asked.')}</span>
							<span className={styles.space} />
							{agentButton}
						</div>
					)}
					{yours.length > 0 && (
						<>
							<Heading>
								{t(locale, 'Yours')} · {yours.length}
							</Heading>
							<div className={styles.rows}>
								{yours.map((draft) => (
									<DraftRow
										key={draft.id}
										locale={locale}
										draft={draft}
										busy={busy}
										bad={failure?.draft === draft.id}
										goTo={() => goTo(draft.path, draft.line)}
										edit={(text) => edit(draft, text, false)}
										remove={() => remove(draft)}
									/>
								))}
							</div>
						</>
					)}
				</>
			)}
			<ThreadRows locale={locale} threads={threads} goTo={goTo} />
		</Column>
	);
}

function VerdictColumn({
	locale,
	own,
	author,
	event,
	hint,
	choose,
	back,
	next,
}: {
	locale: Locale;
	own: boolean;
	author: string;
	event: Decision;
	hint: PRVerdictHint | null | 'loading';
	choose(event: Decision): void;
	back(): void;
	next(): void;
}) {
	const notes: Record<Decision, string> = {
		COMMENT: t(locale, 'Feedback only. Merging stays as it is.'),
		APPROVE: t(locale, 'You are fine with merging. GitHub counts your approval.'),
		REQUEST_CHANGES: t(
			locale,
			'Merging waits until {author} pushes fixes and you review again.'
		).replace('{author}', author),
	};
	return (
		<Column
			step={3}
			title={t(locale, 'Verdict')}
			foot={
				<Foot
					locale={locale}
					left={t(locale, decisionNames[event])}
					back={back}
					next={next}
					nextLabel={nextLabel(locale, 4)}
				/>
			}>
			{hint && hint !== 'loading' && (
				<Banner
					size="s"
					tone="done"
					title={t(locale, 'The agent suggests {decision}: {reason}')
						.replace('{decision}', t(locale, decisionNames[hint.event]))
						.replace('{reason}', hint.reason)}
				/>
			)}
			<div className={styles.options} role="radiogroup" aria-label={t(locale, 'Verdict')}>
				{decisions.map((item) => {
					const off = own && item.event !== 'COMMENT';
					return (
						<OptionCard
							key={item.event}
							name="review-verdict"
							checked={event === item.event}
							disabled={off}
							glyph={item.glyph}
							title={t(locale, decisionNames[item.event])}
							description={
								off ? t(locale, 'GitHub does not take this on your own PR.') : notes[item.event]
							}
							onChange={() => choose(item.event)}
						/>
					);
				})}
			</div>
		</Column>
	);
}

function SummaryColumn({
	locale,
	body,
	count,
	writing,
	generated,
	noAgent,
	change,
	save,
	generate,
	back,
	next,
}: {
	locale: Locale;
	body: string;
	count: number;
	writing: boolean;
	generated: boolean;
	noAgent: boolean;
	change(value: string): void;
	save(): void;
	generate(): void;
	back(): void;
	next(): void;
}) {
	return (
		<Column
			step={4}
			title={t(locale, 'Summary')}
			note={t(locale, 'on top of the review')}
			foot={
				<Foot
					locale={locale}
					left={t(locale, 'Optional')}
					back={back}
					next={next}
					nextLabel={nextLabel(locale, 5)}
				/>
			}>
			{writing ? (
				<div className={styles.writing} aria-busy="true">
					<Skeleton widths={[92, 78, 60]} />
				</div>
			) : (
				<TextArea
					className={styles.reviewBody}
					data-generated={generated || undefined}
					aria-label={t(locale, 'Review comment')}
					placeholder={t(locale, 'Optional')}
					value={body}
					onChange={(event) => change(event.target.value)}
					onBlur={save}
				/>
			)}
			<div className={styles.inline} data-size="s">
				<small className={styles.capLine}>
					{writing ? (
						t(locale, 'Reading {n}…').replace('{n}', commentCount(locale, count))
					) : generated ? (
						<>
							<span className={styles.accent}>
								<Glyph name="generate" size={10} />
							</span>
							{t(locale, 'From {n}. Edit freely.').replace('{n}', commentCount(locale, count))}
						</>
					) : (
						'Markdown'
					)}
				</small>
				<span className={styles.space} />
				{writing ? (
					<Button disabled>
						<Spinner size={11} />
						{t(locale, 'Writing…')}
					</Button>
				) : (
					<GenerateButton
						label={t(locale, generated ? 'Generate again' : 'Generate from the drafts')}
						disabled={!count || noAgent}
						title={!count ? t(locale, 'No comments to write from') : undefined}
						onClick={generate}
					/>
				)}
			</div>
			{!count && (
				<p className={styles.expl}>
					{t(locale, 'Generating needs comments from step 2. Write it yourself or leave it empty.')}
				</p>
			)}
		</Column>
	);
}

function GitHubPreview({
	locale,
	viewer,
	event,
	body,
	drafts,
	bad,
	reason,
}: {
	locale: Locale;
	viewer: string;
	event: Decision;
	body: string;
	drafts: PRDraft[];
	bad: string | null;
	reason: string;
}) {
	const verbs: Record<Decision, MessageKey> = {
		COMMENT: 'commented (review)',
		APPROVE: 'approved these changes',
		REQUEST_CHANGES: 'requested changes',
	};
	return (
		<div className={styles.preview} data-review-preview>
			<div className={styles.previewHead}>
				<Avatar login={viewer} size="m" />
				<b>{viewer}</b>
				<span>{t(locale, verbs[event])}</span>
				<span className={styles.space} />
				<span className={styles.previewGlyph} data-event={event}>
					<Glyph name={decisions.find((item) => item.event === event)!.glyph} size={13} />
				</span>
			</div>
			{body.trim() ? (
				<div className={styles.previewBody}>{body}</div>
			) : (
				<div className={styles.previewBody} data-none>
					{t(locale, drafts.length ? 'No summary' : 'No summary · no comments')}
				</div>
			)}
			{drafts.map((draft) => (
				<div
					key={draft.id}
					className={styles.previewComment}
					data-review-comment={draft.id}
					data-bad={bad === draft.id || undefined}>
					<FileIcon name={fileName(draft.path)} />
					<div>
						<span className={styles.previewPlace}>
							{fileName(draft.path)}:{lines(draft)}
						</span>
						<span>{draft.body}</span>
						{bad === draft.id && reason && <span className={styles.previewError}>{reason}</span>}
					</div>
				</div>
			))}
		</div>
	);
}

function CheckColumn({
	merge,
	locale,
	own,
	author,
	viewer,
	event,
	body,
	drafts,
	sending,
	handing,
	failure,
	sendComments,
	setSendComments,
	fix,
	goToComment,
	send,
	hand,
	back,
}: {
	locale: Locale;
	own: boolean;
	author: string;
	viewer: string;
	event: Decision;
	body: string;
	drafts: PRDraft[];
	sending: boolean;
	handing: boolean;
	failure: Failure;
	sendComments: boolean;
	setSendComments(value: boolean): void;
	fix: { text: string; empty: boolean } | null;
	goToComment(): void;
	send(): void;
	hand(): void;
	back(): void;
	/** spec/appearance#evolution-redesign: a row of its own under Send — merging is never part of sending. */ merge: ReactNode;
}) {
	const working = sending || handing,
		// No empty comment: Approve and Request changes go alone, a comment needs something to say.
		empty = event === 'COMMENT' && !drafts.length && !body.trim();
	const sendLabel = sending
		? t(locale, 'Sending…')
		: failure
			? t(locale, 'Send again')
			: t(locale, own ? 'Send as a comment' : 'Send the review');
	const fixOff = !fix
		? t(locale, 'No agent can take the fixes here')
		: fix.empty
			? t(locale, 'No comments or text to hand over')
			: '';
	return (
		<Column
			step={5}
			title={t(locale, 'What GitHub gets')}
			note={t(locale, 'as you, {name}').replace('{name}', viewer)}
			dim={working}
			foot={
				<>
					<div className={styles.checkFoot}>
						<div className={styles.inline} data-size="m">
							<Button disabled={working} onClick={back}>
								{t(locale, 'Back')}
							</Button>
							<Button
								appearance="primary"
								className={styles.sendButton}
								disabled={working || empty}
								title={empty ? t(locale, 'A comment needs text or comments on lines.') : undefined}
								data-review-send
								onClick={send}>
								{sending && <Spinner size={11} />}
								{sendLabel}
								{!sending && (
									<span className={styles.kbd}>{formatAccelerator('CmdOrCtrl+Enter')}</span>
								)}
							</Button>
						</div>
						<div className={styles.or}>
							{t(locale, own ? 'or don’t send' : 'or don’t send — fix it')}
						</div>
						<span className={styles.fixWrap} title={fixOff || undefined}>
							<Button
								className={styles.fixButton}
								disabled={working || Boolean(fixOff)}
								data-review-hand
								onClick={hand}>
								{handing ? (
									<Spinner size={11} />
								) : (
									<span className={styles.accent}>
										<Glyph name="generate" size={11} />
									</span>
								)}
								{t(locale, 'Hand to the agent to fix')}
							</Button>
						</span>
						{fix && !fix.empty && <small className={styles.fixNote}>{fix.text}</small>}
						<label className={styles.check} data-size="s">
							<Choice
								type="checkbox"
								label={t(locale, 'Also send the comments to the PR')}
								checked={sendComments}
								disabled={working || Boolean(fixOff)}
								onChange={(change) => setSendComments(change.target.checked)}
							/>
							<span>{t(locale, 'Also send the comments to the PR')}</span>
						</label>
					</div>
					{merge}
				</>
			}>
			{failure && (
				<Banner
					size="s"
					tone="error"
					title={failure.text}
					action={
						failure.draft ? (
							<Button onClick={goToComment}>{t(locale, 'Go to the comment')}</Button>
						) : undefined
					}
				/>
			)}
			<GitHubPreview
				locale={locale}
				viewer={viewer}
				event={event}
				body={body}
				drafts={drafts}
				bad={failure?.draft ?? null}
				reason={failure?.reason ?? ''}
			/>
			<p className={styles.expl}>
				{empty
					? t(locale, 'A comment needs text or comments on lines.')
					: drafts.length || body.trim()
						? t(locale, 'Comments from the agent go out under your name, without ✦.')
						: event === 'APPROVE'
							? t(
									locale,
									'Just the approval. {author} sees «{viewer} approved these changes» and nothing else.'
								)
									.replace('{author}', author)
									.replace('{viewer}', viewer)
							: t(locale, 'Comments from the agent go out under your name, without ✦.')}
			</p>
		</Column>
	);
}
