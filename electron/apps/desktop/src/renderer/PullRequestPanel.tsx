import { openReviewLaunch, type ReviewChoice } from './ReviewLaunch';
import { taskStatusLabel } from './ProjectBoard';
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from 'react';
import {
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	menuCommands,
	commentCount,
	prGroups,
	prAge,
	prCounts,
	isOpenPR,
	t,
	type AgentTask,
	type Locale,
	type PullRequestSummary,
	type PullRequestDetail,
	type PRGroup,
	type PRChecksState,
	type PRCheckRun,
	type PRThread,
	type PRDraft,
	type PRMenuAction,
	type RepoPullRequests,
	type FileDiff,
	type ChangedFile,
	commitsAhead,
	newPRChoices,
	pushedAgo,
	suggestsPR,
	type ForgeSnapshot,
	type NewPRChoice,
	liveReviewTask,
} from '@brigadir/core';
import { useForge } from './Forge';
import { ChangeCounts } from './ui/ChangeCounts';
import { openTaskPR, useTaskState } from './task-state';
import { useWorkspace } from './store';
import { openReview, usePRReview } from './pr-review';
import { shownFiles, isSaving } from './pr-viewed';
import { PRReviewFooter } from './PRReviewModal';
import { usePullRequests } from './PullRequests';
import { refreshFlight } from './refresh-flight';
import { Glyph } from './ui/Glyph';
import { LoadingPlaceholder, SkeletonRows, Spinner } from './ui/Loading';
import { ProgressBar } from './ui/ProgressBar';
import { Avatar } from './ui/Avatar';
import { PRMarkGlyph, PRStateGlyph } from './ui/PRGlyphs';
export { Avatar, PRStateGlyph };
import { Button, Chevron, Choice, IconButton, Segments, StatusIcon } from './ui/Controls';
import { MenuItem, MenuPopover } from './ui/Popover';
import { toastError } from './ui/Toast';
import { PanelSearch, SearchToggle, Highlight } from './ui/PanelSearch';
import { listStep } from './ui/list-keys';
import { CIListView, MergedChecks, mergedState, useCIRuns, type CIFix } from './CIRuns';
import { CheckRow, CIGlyph, ciDuration } from './ui/RunSteps';
import { RepoPicker, repoName } from './ui/RepoPicker';
import styles from './PullRequestPanel.module.css';

type Glyphs = Parameters<typeof Glyph>[0]['name'];
type Ref = { scopeId: string; number: number };
/** PR actions that live in TaskView: the Overview and diff tabs are editor documents, the review task is in the sidebar. */
export type Actions = {
	onOpenTask?: ((task: AgentTask) => void) | undefined;
	onHandThreads?:
		| ((detail: PullRequestDetail, scopeId: string, threads: PRThread[]) => Promise<void>)
		| undefined;
	activeFile?: (Ref & { path: string }) | null | undefined;
	openingFile?: (Ref & { path: string }) | null | undefined;
	onOpenCommitFile?:
		((scopeId: string, sha: string, diff: FileDiff, fileId: string) => void) | undefined;
	onAgentFix?:
		| ((
				detail: PullRequestDetail,
				scopeId: string,
				drafts: PRDraft[],
				body: string,
				sendComments: boolean
		  ) => Promise<boolean>)
		| undefined;
	onOverview?: ((ref: Ref) => void) | undefined;
	/** spec/pull-requests-and-ci#review-launch: starts the review the launch dialog describes; answers whether its task started. */
	onAgentReview?:
		| ((
				detail: Pick<PullRequestDetail, 'summary'>,
				scopeId: string,
				choice: ReviewChoice
		  ) => Promise<boolean>)
		| undefined;
	/** spec/appearance#evolution-redesign: «Resolve conflicts…» of a list row — the «Merging» card's way, in the dialog. */
	onResolveConflicts?: ((ref: Ref) => void) | undefined;
	onOpenFile?: ((ref: Ref, path: string, line: number | null) => void) | undefined;
	onOpenCommit?: ((ref: Ref, sha: string) => void) | undefined;
	footer?: ((detail: PullRequestDetail, scopeId: string) => React.ReactNode) | undefined;
	onCIFix?: CIFix | undefined;
};
/**
 * spec/pull-requests-and-ci#pr-keyboard: ↑/↓ and Home/End on a row of the Files or Comments tab move to the next row as a click does: the row takes the
 * focus, scrolls in at the nearest edge and opens its diff. The step is the Files tree's (`listStep`): no wrap. Enter and
 * Space stay the button's own; the «Viewed» box is not a stop. A key with a modifier belongs to the menu.
 */
function stepRow(event: KeyboardEvent<HTMLButtonElement>) {
	if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
	const body = event.currentTarget.closest('[role=tabpanel]'),
		rows = [...(body?.querySelectorAll<HTMLButtonElement>('[data-pr-step]') ?? [])],
		step = listStep(event.key, rows.indexOf(event.currentTarget), rows.length);
	if (step === null) return;
	event.preventDefault();
	const next = rows[step];
	if (!next || next === event.currentTarget) return;
	// The first row brings the tab's caption back with it («3 of 62 viewed», the filter).
	next.focus({ preventScroll: true });
	if (step === 0) body?.scrollTo({ top: 0 });
	else next.scrollIntoView({ block: 'nearest' });
	next.click();
}
/**
 * spec/pull-requests-and-ci#reading-and-refresh: «Refresh» reads past main's 20 s cache. The glyph turns while the read runs and finishes its turn before it
 * stops; with reduced motion it only dims. Nothing waits for it: `aria-busy`, never `disabled`. ⌘R (View → Refresh pull
 * requests) clicks it while the focus is in the PR panel. A request during a read is not lost (spec/pull-requests-and-ci#reading-and-refresh, `refreshFlight`).
 */
function RefreshButton({
	locale,
	size,
	run,
}: {
	locale: Locale;
	size: number;
	run(): Promise<unknown>;
}) {
	const [busy, setBusy] = useState(false),
		[spinning, setSpinning] = useState(false),
		button = useRef<HTMLButtonElement>(null),
		latest = useRef(run);
	latest.current = run;
	const keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap,
		command = menuCommands.find((item) => item.id === 'pull-requests-refresh'),
		key = command && commandAccelerator(command, keymap);
	// spec/pull-requests-and-ci#reading-and-refresh: a click or ⌘R during a read runs one more pass after it instead of being dropped.
	const [flight] = useState(() =>
		refreshFlight(
			() => latest.current(),
			(reading) => {
				setBusy(reading);
				if (reading) setSpinning(true);
				else if (matchMedia('(prefers-reduced-motion: reduce)').matches) setSpinning(false);
			}
		)
	);
	const refresh = useCallback(() => {
		void flight.request();
	}, [flight]);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (
					action === 'pull-requests-refresh' &&
					button.current?.closest('[data-pr-panel]')?.contains(document.activeElement)
				)
					refresh();
			}),
		[refresh]
	);
	return (
		<IconButton
			ref={button}
			className={styles.icon}
			data-pr-refresh
			data-spinning={spinning || undefined}
			aria-busy={busy}
			label={t(locale, 'Refresh')}
			hint={key ? `${t(locale, 'Refresh')} · ${formatAccelerator(key)}` : t(locale, 'Refresh')}
			onClick={refresh}
			onAnimationIteration={() => {
				if (!flight.reading) setSpinning(false);
			}}>
			<Glyph name="refresh" size={size} />
		</IconButton>
	);
}
const groupLabels: Record<PRGroup, 'Waiting for you' | 'Yours' | 'Others' | 'Recently closed'> = {
	waiting: 'Waiting for you',
	mine: 'Yours',
	others: 'Others',
	closed: 'Recently closed',
};
export function ChecksGlyph({
	state,
	size = 12,
	locale,
}: {
	state: PRChecksState;
	size?: number;
	locale: Locale;
}) {
	if (state === 'none') return null;
	const label = t(
		locale,
		state === 'pass' ? 'Checks passed' : state === 'fail' ? 'Checks failed' : 'Checks are running'
	);
	return (
		<span className={styles.checks} data-checks={state} title={label} role="img" aria-label={label}>
			<Glyph
				name={state === 'pass' ? 'check-pass' : state === 'fail' ? 'check-fail' : 'check-run'}
				size={size}
			/>
		</span>
	);
}
const author = (locale: Locale, pr: PullRequestSummary) => (pr.mine ? t(locale, 'you') : pr.author);
function PRRow({
	pr,
	locale,
	selected,
	query,
	repo,
	open,
	menu,
}: {
	pr: PullRequestSummary;
	locale: Locale;
	selected: boolean;
	query: string;
	/** spec/pull-requests-and-ci#repo-picker: the repo's name first on the second line while the list holds more than one repo. */ repo?:
		string | undefined;
	open(): void;
	/** spec/appearance#evolution-redesign: the row's native menu; the row keeps its hover while it is open. */
	menu(): Promise<void>;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const showMenu = () => {
		setMenuOpen(true);
		void menu().finally(() => setMenuOpen(false));
	};
	return (
		<button
			type="button"
			className={styles.row}
			data-pr-row={pr.number}
			data-closed={!isOpenPR(pr)}
			data-menu-open={menuOpen || undefined}
			aria-pressed={selected}
			onClick={open}
			onContextMenu={(event) => {
				event.preventDefault();
				showMenu();
			}}
			onKeyDown={(event) => {
				if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
					event.preventDefault();
					showMenu();
				}
			}}
			title={pr.title}>
			<PRStateGlyph pr={pr} />
			<span className={styles.copy}>
				<span className={styles.title}>
					<Highlight text={pr.title} query={query} />
				</span>
				<span className={styles.meta}>
					{repo && (
						<>
							<span className={styles.repo} data-pr-repo>
								<Highlight text={repo} query={query} />
							</span>
							{' · '}
						</>
					)}
					#{pr.number} · {author(locale, pr)} · {prAge(locale, pr.updatedAt)}
				</span>
			</span>
			<PRMarkGlyph pr={pr} locale={locale} />
			{pr.comments > 0 && (
				<span className={styles.comments} title={t(locale, 'Comments')}>
					<Glyph name="bubble" size={11} />
					<span>{pr.comments}</span>
				</span>
			)}
			{isOpenPR(pr) && <ChecksGlyph state={pr.checks} locale={locale} />}
		</button>
	);
}
/**
 * spec/pull-requests-and-ci#pr-list: the PR panel — the repo's PR list in groups, or one PR with the tabs `Comments · Files · Commits · Checks`.
 * Data comes from PullRequestsProvider (the list) and readPullRequestDetail (the PR); no polling.
 */
export function PullRequestPanel({
	task,
	locale,
	projectName,
	onOpenTask,
	onHandThreads,
	activeFile,
	openingFile,
	onOpenCommitFile,
	onOverview,
	onAgentReview,
	onOpenFile,
	onOpenCommit,
	onAgentFix,
	footer,
	onCIFix,
	onResolveConflicts,
}: { task: AgentTask; locale: Locale; projectName: string } & Actions) {
	const [{ prFilter, prOpen }, setTask] = useTaskState(task),
		context = usePullRequests();
	if (prOpen)
		return (
			<PRDetailView
				task={task}
				locale={locale}
				projectName={projectName}
				target={prOpen}
				back={() => setTask({ prOpen: null })}
				{...{
					onOpenTask,
					onHandThreads,
					activeFile,
					openingFile,
					onOpenCommitFile,
					onOverview,
					onAgentReview,
					onOpenFile,
					onOpenCommit,
					onAgentFix,
					footer,
					onCIFix,
				}}
			/>
		);
	return (
		<PRListView
			task={task}
			locale={locale}
			projectName={projectName}
			filter={prFilter}
			context={context}
			onCIFix={onCIFix}
			onAgentReview={onAgentReview}
			onResolveConflicts={onResolveConflicts}
			onOpenTask={onOpenTask}
		/>
	);
}
function Banner({ locale, auth, retry }: { locale: Locale; auth: string; retry(): void }) {
	if (auth === 'ready') return null;
	return (
		<div className={styles.banner} role="status">
			<Glyph name="review-warning" size={14} />
			<span>
				{t(
					locale,
					auth === 'missing'
						? 'Install GitHub CLI (gh) to create pull requests.'
						: auth === 'login'
							? 'Sign in with gh auth login to use GitHub.'
							: 'GitHub status could not be read.'
				)}
			</span>
			<Button size="s" onClick={retry}>
				{t(locale, 'Retry')}
			</Button>
		</div>
	);
}
/** A forge blocker in words; one GitHub could not read stays as it came. */
const blockerText = (locale: Locale, value: string) =>
	t(locale, value as Parameters<typeof t>[1]) || value;
const choiceName = (choice: NewPRChoice, projectName: string) =>
	repoName(choice.item.scope, projectName);
/** `business · brigadir/expo57-qa-fixes → stage` — what exactly becomes the PR. */
const choiceTarget = (choice: NewPRChoice, projectName: string) =>
	`${choiceName(choice, projectName)} · ${choice.item.git.branch} → ${choice.item.git.base}`;
/**
 * spec/pull-requests-and-ci#ready-card: «+ PR» in the header, always there. One ready repo — the button opens New pull request for it; several —
 * a menu of the repos (a blocked one dimmed with its reason). Nothing ready — off, the forge's reason in the tooltip.
 */
function NewPRButton({
	locale,
	projectName,
	scoped,
	created,
}: {
	locale: Locale;
	projectName: string;
	scoped: string | null;
	created(scopeId: string): (value: ForgeSnapshot) => void;
}) {
	const forge = useForge(),
		[open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null);
	// The menu lists the ready repos first, the blocked ones after them.
	const choices = newPRChoices(forge?.data ?? null, scoped).sort(
			(a, b) => Number(a.reasons.length > 0) - Number(b.reasons.length > 0)
		),
		ready = choices.filter((choice) => !choice.reasons.length),
		// spec/pull-requests-and-ci#from-into: a repo whose only reasons are its branch's opens the dialog too — `From` and `Into` choose the pair.
		openable = choices.filter((choice) => !choice.blocked.length),
		why = (choice: NewPRChoice) =>
			choice.reasons.map((value) => blockerText(locale, value)).join(' · '),
		label = t(locale, 'New PR');
	const detail = ready.length
		? ready.map((choice) => choiceTarget(choice, projectName)).join('\n')
		: choices.length === 1
			? why(choices[0]!)
			: choices.length
				? choices.map((choice) => `${choiceName(choice, projectName)}: ${why(choice)}`).join('\n')
				: t(locale, 'GitHub is unavailable');
	const hint = `${label}\n${detail}`,
		menu = openable.length > 1;
	const start = (choice: NewPRChoice) =>
		forge?.open('pr', choice.item.scope.id, anchor.current, created(choice.item.scope.id));
	return (
		<>
			{/* A disabled button gets no pointer events: its reason is the wrapper's tooltip (as Create PR in Changes). */}
			<span className={styles.newWrap} title={openable.length ? undefined : hint}>
				<IconButton
					ref={anchor}
					data-new-pr
					label={label}
					hint={hint}
					disabled={!openable.length}
					aria-haspopup={menu ? 'menu' : undefined}
					aria-expanded={menu ? open : undefined}
					onClick={() => {
						if (menu) setOpen((value) => !value);
						else if (openable[0]) start(openable[0]);
					}}>
					{/* The plus is the small one beside the PR mark: out of the button's one-icon size. */}
					<span className={styles.newGlyph}>
						<Glyph name="plus" size={9} />
						<Glyph name="pr-branch" size={15} />
					</span>
				</IconButton>
			</span>
			{menu && (
				<MenuPopover
					open={open}
					onClose={() => setOpen(false)}
					anchor={anchor}
					align="end"
					width={264}
					label={label}
					locale={locale}>
					{choices.map((choice) => (
						<MenuItem
							key={choice.item.scope.id}
							icon={<Glyph name="pr-branch" size={12} />}
							disabled={choice.blocked.length > 0}
							hands
							data-new-pr-repo={choice.item.scope.name}
							description={
								choice.reasons.length ? (
									why(choice)
								) : (
									<span className={styles.mono}>{choice.item.git.branch}</span>
								)
							}
							tail={
								choice.reasons.length
									? undefined
									: `${choice.item.git.ahead} → ${choice.item.git.base}`
							}
							onSelect={() => start(choice)}>
							{choiceName(choice, projectName)}
						</MenuItem>
					))}
				</MenuPopover>
			)}
		</>
	);
}
/**
 * spec/pull-requests-and-ci#ready-card: above «Yours», a card for each ready branch that is on origin and has no open PR, as on GitHub. One repo —
 * `branch · 3 commits ahead of stage · pushed 2 min ago [Create PR] ×`; several — one card «Ready for a PR · N», a row a repo.
 * × hides the card until that branch is pushed again.
 */
function NewPRCards({
	locale,
	projectName,
	scoped,
	created,
}: {
	locale: Locale;
	projectName: string;
	scoped: string | null;
	created(scopeId: string): (value: ForgeSnapshot) => void;
}) {
	const forge = useForge(),
		all = newPRChoices(forge?.data ?? null, scoped),
		cards = all.filter(suggestsPR);
	if (!forge || !cards.length) return null;
	const hide = (choices: NewPRChoice[]) => {
		void (async () => {
			for (const choice of choices) await forge.hide(choice.item.scope.id);
		})().catch((error: unknown) =>
			toastError(error instanceof Error ? error.message : String(error))
		);
	};
	const create = (choice: NewPRChoice, button: HTMLElement) =>
		forge.open('pr', choice.item.scope.id, button, created(choice.item.scope.id));
	const close = (choices: NewPRChoice[]) => (
		<IconButton
			size="s"
			className={styles.newHide}
			label={t(locale, 'Hide until the next push')}
			onClick={() => hide(choices)}>
			<span className={styles.hideGlyph}>
				<Glyph name="close" size={10} />
			</span>
		</IconButton>
	);
	if (cards.length === 1) {
		const choice = cards[0]!,
			{ git, pushed } = choice.item;
		return (
			<section
				className={styles.newCard}
				aria-label={t(locale, 'Ready for a PR')}
				data-new-pr-card={choice.item.scope.name}>
				<div className={styles.newHead}>
					<Glyph name="pr-branch" size={12} />
					{!scoped && all.length > 1 && (
						<span className={styles.newRepo}>{choiceName(choice, projectName)}</span>
					)}
					<span className={styles.newBranch} title={git.branch ?? undefined}>
						{git.branch}
					</span>
					{close([choice])}
				</div>
				<div className={styles.newFoot} data-size="s">
					<span>
						{commitsAhead(locale, git.ahead, git.base ?? '')}
						{pushed?.at ? ` · ${pushedAgo(locale, pushed.at)}` : ''}
					</span>
					<Button appearance="primary" onClick={(event) => create(choice, event.currentTarget)}>
						<Glyph name="pr-branch" size={11} />
						{t(locale, 'Create PR')}
					</Button>
				</div>
			</section>
		);
	}
	return (
		<section className={styles.newList} aria-label={t(locale, 'Ready for a PR')}>
			<div className={styles.newListHead}>
				<span>{t(locale, 'Ready for a PR')}</span>
				<small>{cards.length}</small>
				{close(cards)}
			</div>
			{cards.map((choice) => (
				<div
					key={choice.item.scope.id}
					className={styles.newRow}
					data-size="s"
					data-new-pr-card={choice.item.scope.name}>
					<Glyph name="pr-branch" size={12} />
					<span className={styles.newRowCopy}>
						<b>
							{choiceName(choice, projectName)}
							<em>
								{commitsAhead(locale, choice.item.git.ahead, choice.item.git.base ?? '', true)}
							</em>
						</b>
						<small title={choice.item.git.branch ?? undefined}>{choice.item.git.branch}</small>
					</span>
					<Button
						aria-label={`${t(locale, 'Create PR')} · ${choiceName(choice, projectName)}`}
						onClick={(event) => create(choice, event.currentTarget)}>
						{t(locale, 'Create PR')}
					</Button>
				</div>
			))}
		</section>
	);
}
function PRListView({
	task,
	locale,
	projectName,
	filter,
	context,
	onCIFix,
	onAgentReview,
	onResolveConflicts,
	onOpenTask,
}: {
	task: AgentTask;
	locale: Locale;
	projectName: string;
	filter: string | null;
	context: ReturnType<typeof usePullRequests>;
	onCIFix?: CIFix | undefined;
} & Pick<Actions, 'onAgentReview' | 'onResolveConflicts' | 'onOpenTask'>) {
	// spec/pull-requests-and-ci#review-drafts: a filter by a repo this task does not have (another worktree's id) is off, not «No open PRs».
	const scoped =
		filter && context?.data?.repos.some((repo) => repo.scopeId === filter) ? filter : null;
	const [{ prSearch, prLast, prSegment }, setTask] = useTaskState(task),
		ci = prSegment === 'ci',
		[showClosed, setShowClosed] = useState(false),
		query = prSearch ?? '';
	const data = context?.data,
		repos = (data?.repos ?? []).filter(
			(repo) => repo.repository && (!scoped || repo.scopeId === scoped)
		);
	const filterRepo = scoped ? data?.repos.find((repo) => repo.scopeId === scoped) : undefined;
	// spec/pull-requests-and-ci#repo-picker: the picker is there while the window has more than one repo on GitHub.
	const github = (data?.repos ?? []).filter((repo) => repo.repository);
	const all = useMemo(() => repos.flatMap((repo) => repo.prs.map((pr) => ({ pr, repo }))), [repos]);
	// spec/pull-requests-and-ci#repo-picker: the name tells rows apart only while the list holds PRs of more than one repo.
	const named = new Set(all.map((item) => item.repo.scopeId)).size > 1;
	const matches = all.filter(
		({ pr, repo }) =>
			!query.trim() ||
			`${pr.title} #${pr.number} ${pr.author} ${pr.head} ${named ? repoName(repo, projectName) : ''}`
				.toLocaleLowerCase()
				.includes(query.trim().toLocaleLowerCase())
	);
	const groups = prGroups(matches.map((item) => item.pr)),
		owner = new Map(matches.map((item) => [item.pr, item.repo]));
	const counts = prCounts(all.map((item) => item.pr)),
		closedTotal = all.filter((item) => !isOpenPR(item.pr)).length;
	const open = (repo: RepoPullRequests, number: number) =>
		setTask({
			prOpen: { scopeId: repo.scopeId, number },
			prLast: { scopeId: repo.scopeId, number },
			prTab: 'comments',
		});
	// spec/appearance#evolution-redesign: a row's menu. Main builds it; the answer runs what the PR's own buttons run.
	const rowMenu = async (repo: RepoPullRequests, pr: PullRequestSummary) => {
		const ref = { scopeId: repo.scopeId, number: pr.number };
		let action: PRMenuAction | null;
		try {
			action = await window.brigadir.pullRequestMenu(task, ref, {
				state: pr.state,
				head: pr.head,
				url: pr.url,
			});
		} catch {
			toastError(t(locale, 'Could not open the menu.'));
			return;
		}
		// spec/appearance#evolution-redesign: the review modal of this PR, as «Start review» of the panel's footer opens it.
		if (action === 'review') openReview(task, ref);
		// spec/pull-requests-and-ci#pr-row-menu: the launch dialog, or the live review task of this PR.
		if (action === 'agent-review' && onAgentReview)
			openReviewLaunch({
				projectId: task.projectId,
				scopeId: repo.scopeId,
				number: pr.number,
				title: pr.title,
				action: 'review',
				start: (choice) => onAgentReview({ summary: pr }, repo.scopeId, choice),
			});
		if (action === 'open-review') {
			const review = liveReviewTask(useWorkspace.getState().workspace?.tasks ?? [], {
				projectId: task.projectId,
				number: pr.number,
				scopeId: repo.scopeId,
				repo: repo.name,
			});
			if (review) openReviewTask(review, onOpenTask);
		}
		if (action === 'conflicts') onResolveConflicts?.(ref);
		if (action === 'github')
			void window.brigadir
				.openPullRequestPage(task.projectId, task.id, repo.scopeId, pr.number)
				.catch(() => {});
	};
	// spec/pull-requests-and-ci#ready-card: the new PR goes to «Yours» as the selected row; the list reads GitHub again to have it.
	const created = (scopeId: string) => (value: ForgeSnapshot) => {
		const pr = value.scopes.find((item) => item.scope.id === scopeId)?.pr;
		if (pr?.state === 'OPEN') setTask({ prLast: { scopeId, number: pr.number } });
		void context?.refresh(true);
	};
	const openGitHub = () => {
		const repo = filterRepo ?? repos[0];
		if (repo)
			void window.brigadir
				.openPullRequestPage(task.projectId, task.id, repo.scopeId, null)
				.catch(() => {});
	};
	// spec/pull-requests-and-ci#ci: CI runs of the header filter's repo, else the first repo on GitHub; «GitHub» opens its Actions page.
	const ciRepo = filterRepo?.repository ? filterRepo : repos[0],
		actionsPage = () => {
			if (ciRepo?.repository)
				void window.brigadir
					.openPullRequestLink(
						task.projectId,
						task.id,
						ciRepo.scopeId,
						`${ciRepo.repository.url}/actions`
					)
					.catch(() => {});
		};
	const errors = (data?.repos ?? []).filter(
			(repo) => repo.error && (!scoped || repo.scopeId === scoped)
		),
		ciRefresh = useRef<(() => Promise<void>) | null>(null);
	return (
		<div className={styles.panel} data-pr-panel="list">
			<header className={styles.header} data-size="m">
				{/* spec/pull-requests-and-ci#pr-panel: the segment sits in the header row, left of the actions; the search takes the rest of the row. */}
				<Segments
					tablist
					label={t(locale, 'Pull requests')}
					value={prSegment}
					onChange={(value) => setTask({ prSegment: value as 'prs' | 'ci' })}
					options={[
						{
							value: 'prs',
							label: t(locale, 'Pull requests (segment)'),
							short: t(locale, 'PR (segment)'),
						},
						{ value: 'ci', label: t(locale, 'CI') },
					]}
				/>
				{prSearch !== null && !ci ? (
					<PanelSearch
						locale={locale}
						label={t(locale, 'Find a PR')}
						value={query}
						count={String(matches.length)}
						onChange={(value) => setTask({ prSearch: value })}
						onClose={() => setTask({ prSearch: null })}
					/>
				) : (
					<>
						{github.length > 1 && (
							<RepoPicker
								className={styles.filter}
								locale={locale}
								projectName={projectName}
								repos={github}
								value={ci ? (ciRepo?.scopeId ?? null) : (filterRepo?.scopeId ?? null)}
								all={!ci}
								onChange={(scopeId) => setTask({ prFilter: scopeId })}
							/>
						)}
						<span className={styles.space} />
						{/* spec/pull-requests-and-ci#ready-card: the header's glyphs stand as one tight group (2 px), so the picker keeps its room. */}
						<span className={styles.headerActions}>
							{/* spec/appearance#evolution-redesign: New PR in both segments; in CI the picker's repo narrows it. */}
							<NewPRButton
								locale={locale}
								projectName={projectName}
								scoped={ci ? (ciRepo?.scopeId ?? null) : scoped}
								created={created}
							/>
							{!ci && (
								<SearchToggle
									label={t(locale, 'Find a PR')}
									onOpen={() => setTask({ prSearch: '' })}
								/>
							)}
							<RefreshButton
								locale={locale}
								size={13}
								run={() =>
									ci
										? (ciRefresh.current?.() ?? Promise.resolve())
										: (context?.refresh(true) ?? Promise.resolve())
								}
							/>
							<IconButton
								label={t(locale, 'Open on GitHub')}
								disabled={!repos.length}
								onClick={ci ? actionsPage : openGitHub}>
								<Glyph name="external" size={13} />
							</IconButton>
						</span>
					</>
				)}
			</header>
			{data && (
				<Banner
					locale={locale}
					auth={data.auth}
					retry={() => {
						void context?.refresh(true);
					}}
				/>
			)}
			{ci ? (
				<CIListView
					task={task}
					locale={locale}
					scopeId={ciRepo?.scopeId ?? null}
					onCIFix={onCIFix}
					github={actionsPage}
					refreshRef={ciRefresh}
				/>
			) : (
				<div className={styles.list} role="list" aria-label={t(locale, 'Pull requests')}>
					{!data && context?.loading && (
						<LoadingPlaceholder label={t(locale, 'Reading PRs from GitHub…')} />
					)}
					{(context?.error || errors.length > 0) && (
						<div className={styles.error} role="alert">
							<Glyph name="check-fail" size={13} />
							<span>{t(locale, 'PRs could not be read: the network is unavailable.')}</span>
							<Button
								size="s"
								onClick={() => {
									void context?.refresh(true);
								}}>
								{t(locale, 'Retry')}
							</Button>
						</div>
					)}
					{!query.trim() && (
						<NewPRCards
							locale={locale}
							projectName={projectName}
							scoped={scoped}
							created={created}
						/>
					)}
					{groups
						.filter((group) => group.group !== 'closed' || !scoped || showClosed || counts.open > 0)
						.map((group, index) => (
							<section
								key={group.group}
								className={styles.group}
								role="group"
								aria-label={t(locale, groupLabels[group.group])}>
								<h3 className={styles.groupHeading} data-first={index === 0}>
									<span>{t(locale, groupLabels[group.group])}</span>
									<small>{group.prs.length}</small>
								</h3>
								{group.prs.map((pr) => (
									<PRRow
										key={`${owner.get(pr)!.scopeId}/${pr.number}`}
										pr={pr}
										locale={locale}
										query={query}
										selected={
											prLast?.scopeId === owner.get(pr)!.scopeId && prLast.number === pr.number
										}
										repo={named ? repoName(owner.get(pr)!, projectName) : undefined}
										open={() => open(owner.get(pr)!, pr.number)}
										menu={() => rowMenu(owner.get(pr)!, pr)}
									/>
								))}
							</section>
						))}
					{data?.auth === 'ready' &&
						!errors.length &&
						!context?.error &&
						counts.open === 0 &&
						!query.trim() && (
							<div className={styles.empty}>
								<Glyph name="pr-branch" size={18} />
								<p>
									{filterRepo
										? t(locale, 'No open PRs in {repo}').replace(
												'{repo}',
												repoName(filterRepo, projectName)
											)
										: t(locale, 'No open PRs')}
								</p>
								{closedTotal > 0 && !showClosed && (
									<Button size="s" onClick={() => setShowClosed(true)}>
										{t(locale, 'Show closed')} · {closedTotal}
									</Button>
								)}
							</div>
						)}
					{query.trim() && !matches.length && (
						<p className={styles.hint}>{t(locale, 'No matches')}</p>
					)}
					<span className={styles.space} />
					{repos.length > 0 && (
						<Button variant="ghost" size="s" className={styles.older} onClick={openGitHub}>
							{t(locale, 'Older closed PRs are on GitHub')}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
const passed = (checks: readonly PRCheckRun[]) =>
	checks.filter((check) => check.state === 'pass' || check.state === 'skipping').length;
function PRDetailView({
	task,
	locale,
	projectName,
	target,
	back,
	onOpenTask,
	onHandThreads,
	activeFile,
	openingFile,
	onOpenCommitFile,
	onOverview,
	onAgentReview,
	onOpenFile,
	onOpenCommit,
	onAgentFix,
	footer,
	onCIFix,
}: { task: AgentTask; locale: Locale; projectName: string; target: Ref; back(): void } & Actions) {
	const [{ prTab }, setTask] = useTaskState(task),
		{ detail, detailError: error, actions, viewing, viewedError } = usePRReview(task, target),
		refresh = () => actions.refresh(),
		list = usePullRequests(),
		summary = list?.data?.repos
			.find((repo) => repo.scopeId === target.scopeId)
			?.prs.find((pr) => pr.number === target.number);
	// spec/notifications-slack-notes-and-schedules#message-classes: GitHub did not save a «Viewed» mark — a toast with Retry; the box keeps its red ring until the next click on it.
	const viewedRetry = useRef(actions.viewed);
	viewedRetry.current = actions.viewed;
	useEffect(() => {
		if (!viewedError) return;
		const { path, viewed } = viewedError,
			name = path.split('/').at(-1) || path;
		toastError(
			t(locale, 'GitHub did not save the «Viewed» mark for {file}.').replace('{file}', name),
			{
				bold: name,
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void viewedRetry.current(path, viewed);
					},
				},
			}
		);
	}, [viewedError]);
	// spec/pull-requests-and-ci#pr-files: the first file of a PR may wait for `git fetch` of its head and base. Start it once the PR is read, on any tab:
	// threads and drafts open files too. Main skips the fetch when both commits are already local.
	useEffect(() => {
		if (detail) void window.brigadir.preparePullRequestTrees(task, target).catch(() => {});
	}, [Boolean(detail), detail?.headSha, task.projectId, task.id, target.scopeId, target.number]);
	// A review task hides «Review with an agent» only on the PR it reviews; any other PR opens a new review task.
	const reviewsThis = Boolean(
		task.prReview &&
		detail &&
		task.prReview.number === detail.summary.number &&
		task.prReview.mode === 'review'
	);
	const pr = detail?.summary ?? summary,
		[unresolved, setUnresolved] = useState(true),
		{ review } = usePRReview(task, target),
		viewerName = usePullRequests()?.data?.viewer ?? null;
	const owner =
		useWorkspace((state) =>
			state.workspace?.tasks.find(
				(item) =>
					item.projectId === task.projectId &&
					item.pullRequests?.[target.scopeId]?.number === target.number
			)
		) ?? null;
	const threads = detail?.threads ?? [],
		shown = unresolved ? threads.filter((thread) => !thread.resolved) : threads;
	const [{ prHanded }] = useTaskState(task),
		[picked, setPicked] = useState<Set<string> | null>(null);
	// spec/pull-requests-and-ci#hand-to-agent: on your own PR the reviewer's threads are picked with checkboxes for «Reply in the PR» and «Hand to the agent».
	const selectable = Boolean(pr?.mine && onHandThreads),
		chosen =
			picked ??
			new Set(
				threads
					.filter((thread) => !thread.resolved && !prHanded.includes(thread.id))
					.map((thread) => thread.id)
			);
	const github = () => {
		void window.brigadir
			.openPullRequestPage(task.projectId, task.id, target.scopeId, target.number)
			.catch(() => {});
	};
	const openCheckLog = (link: string) => {
		void window.brigadir
			.openPullRequestLink(task.projectId, task.id, target.scopeId, link)
			.catch(() => {});
	};
	const tab = (value: typeof prTab, label: string, icon: Glyphs, count: string) => ({
		value,
		label,
		icon: (
			<span className={styles.tab}>
				<span className={styles.tabIcon}>
					<Glyph name={icon} size={12} />
				</span>
				<span className={styles.tabLabel}>{label}</span>
				<small>{count}</small>
			</span>
		),
	});
	const checksText = detail ? `${passed(detail.checks)}/${detail.checks.length}` : '';
	// spec/pull-requests-and-ci#ci: a merged PR shows the runs on its merge commit; the header and the Checks tab show their state instead of the checks count.
	const mergeSha = detail?.summary.state === 'MERGED' ? (detail.mergeSha ?? null) : null,
		ci = useCIRuns(
			task,
			locale,
			mergeSha ? target.scopeId : null,
			mergeSha ? { sha: mergeSha } : null,
			() => true,
			`#${target.number}`
		),
		after = mergeSha ? mergedState(ci, locale) : null;
	return (
		<div className={styles.panel} data-pr-panel="detail" data-pr-number={target.number}>
			<div className={styles.detailHead}>
				{/* spec/pull-requests-and-ci#pr-detail: S buttons (24) in a 28 row, as the run page's title row (spec/pull-requests-and-ci#ci-segment). */}
				<div className={styles.titleRow} data-size="s">
					<IconButton label={t(locale, 'Back to the list')} onClick={back}>
						<Glyph name="chevron-left" size={11} />
					</IconButton>
					{pr && <PRStateGlyph pr={pr} />}
					<h2 className={styles.prTitle} title={pr?.title}>
						{pr?.title ?? `#${target.number}`}
					</h2>
					{/* With no title yet the number stands in for it while GitHub is read, not twice. */}
					{pr && <span className={styles.number}>#{target.number}</span>}
					<RefreshButton
						locale={locale}
						size={12}
						run={() => Promise.all([refresh(), list?.refresh(true)])}
					/>
					<IconButton label={t(locale, 'Open on GitHub')} onClick={github}>
						<Glyph name="external" size={12} />
					</IconButton>
				</div>
				{pr && (
					<div className={styles.metaRow}>
						<Avatar login={pr.author} />
						<span className={styles.who}>
							{author(locale, pr)}
							<span className={styles.branches}>
								{' '}
								·{' '}
								<span>
									{pr.head} → {pr.base}
								</span>
							</span>
						</span>
						{after ? (
							<span className={styles.metaChecks} data-ci-state={after.state}>
								<CIGlyph state={after.state === 'running' ? 'running' : after.state} />
								<small>{after.text}</small>
							</span>
						) : (
							detail &&
							detail.checks.length > 0 && (
								<span className={styles.metaChecks}>
									<ChecksGlyph state={detail.summary.checks} locale={locale} />
									<small>{checksText}</small>
								</span>
							)
						)}
						<PRMarkGlyph pr={pr} locale={locale} />
					</div>
				)}
				<div className={styles.actions} data-size="s">
					<Button onClick={() => onOverview?.(target)}>
						<Glyph name="list-bullets" size={11} />
						{t(locale, 'Overview')}
					</Button>
					{detail && !reviewsThis && onAgentReview && (
						<AgentReviewButton
							locale={locale}
							projectId={task.projectId}
							scopeId={target.scopeId}
							repo={list?.data?.repos.find((repo) => repo.scopeId === target.scopeId)?.name ?? null}
							number={detail.summary.number}
							title={detail.summary.title}
							run={(choice) => onAgentReview(detail, target.scopeId, choice)}
							onOpenReview={(review) => openReviewTask(review, onOpenTask)}
						/>
					)}
					{owner && (owner.id !== task.id || owner.projectId !== task.projectId) && (
						<Button onClick={() => onOpenTask?.(owner)}>
							<Glyph name="chat" size={11} />
							{t(locale, 'PR task')}
						</Button>
					)}
				</div>
			</div>
			<div className={styles.tabs}>
				<Segments
					tablist
					iconOnly
					stretch
					label={t(locale, 'Pull request')}
					value={prTab}
					onChange={(value) => setTask({ prTab: value as typeof prTab })}
					options={[
						tab('comments', t(locale, 'Comments'), 'bubble', String(threads.length)),
						tab('files', t(locale, 'Files'), 'folder', String(detail?.files.length ?? '')),
						tab(
							'commits',
							t(locale, 'Commits'),
							'commit-dot',
							String(detail?.commits.length ?? '')
						),
						tab('checks', t(locale, 'Checks'), 'check-pass', after ? '' : checksText),
					]}
				/>
			</div>
			<div
				className={styles.body}
				role="tabpanel"
				aria-label={t(
					locale,
					prTab === 'comments'
						? 'Comments'
						: prTab === 'files'
							? 'Files'
							: prTab === 'commits'
								? 'Commits'
								: 'Checks'
				)}>
				{error && (
					<div className={styles.error} role="alert">
						<Glyph name="check-fail" size={13} />
						<span>{t(locale, 'The PR could not be read.')}</span>
						<Button
							size="s"
							onClick={() => {
								void refresh();
							}}>
							{t(locale, 'Retry')}
						</Button>
					</div>
				)}
				{!detail && !error && (
					<LoadingPlaceholder label={t(locale, 'Reading the PR from GitHub…')} />
				)}
				{detail && prTab === 'comments' && (
					<>
						<label className={styles.checkbox} data-size="s">
							<Choice
								type="checkbox"
								label={t(locale, 'Unresolved only')}
								checked={unresolved}
								onChange={(event) => setUnresolved(event.target.checked)}
							/>
							<span>{t(locale, 'Unresolved only')}</span>
						</label>
						{shown.map((thread) => (
							<ThreadRow
								key={thread.id}
								thread={thread}
								locale={locale}
								handed={prHanded.includes(thread.id)}
								pick={
									selectable && !thread.resolved && !prHanded.includes(thread.id)
										? {
												checked: chosen.has(thread.id),
												toggle: () =>
													setPicked(() => {
														const next = new Set(chosen);
														if (next.has(thread.id)) next.delete(thread.id);
														else next.add(thread.id);
														return next;
													}),
											}
										: null
								}
								open={() => onOpenFile?.(target, thread.path, thread.line)}
							/>
						))}
						{review.drafts
							.filter((draft) => draft.replyTo === null)
							.map((draft) => (
								<button
									type="button"
									key={draft.id}
									className={styles.thread}
									data-pr-draft-row={draft.id}
									data-pr-step
									title={draft.body}
									onKeyDown={stepRow}
									onClick={() => onOpenFile?.(target, draft.path, draft.line)}>
									<Avatar login={viewerName ?? 'me'} />
									<span className={styles.copy}>
										<span className={styles.place}>
											{draft.path.split('/').at(-1)}:
											{draft.startLine && draft.startLine < draft.line
												? `${draft.startLine}–${draft.line}`
												: draft.line}
										</span>
										<span className={styles.text}>{draft.body.split('\n')[0]}</span>
									</span>
									{(draft.discussion?.length ?? 0) > 0 && (
										<span className={styles.comments} title={t(locale, 'Reply to the agent')}>
											<Glyph name="bubble" size={11} />
											<span>{draft.discussion!.length}</span>
										</span>
									)}
									<span
										className={styles.draftMark}
										title={t(locale, draft.fromAgent ? 'A draft from the agent' : 'Your draft')}
										role="img"
										aria-label={t(
											locale,
											draft.fromAgent ? 'A draft from the agent' : 'Your draft'
										)}>
										{draft.fromAgent ? (
											<Glyph name="generate" size={11} />
										) : (
											<Glyph name="edit" size={11} />
										)}
									</span>
								</button>
							))}
						{!shown.length && (
							<p className={styles.hint}>
								{t(
									locale,
									unresolved && threads.length
										? 'Every thread is resolved'
										: 'No comments on the lines'
								)}
							</p>
						)}
					</>
				)}
				{detail &&
					prTab === 'files' &&
					((files) => {
						const saving = isSaving(viewing);
						return (
							<>
								<p className={styles.caption} data-pr-viewed-caption>
									<span>
										{t(locale, '{n} of {total} viewed')
											.replace('{n}', String(files.filter((file) => file.viewed).length))
											.replace('{total}', String(files.length))}
										{saving && (
											<span className={styles.saving} role="status">
												{' '}
												· {t(locale, 'saving…')}
											</span>
										)}
									</span>
									<ProgressBar
										value={files.filter((file) => file.viewed).length}
										total={files.length}
									/>
								</p>
								{files.map((file) => {
									const opening =
											openingFile?.scopeId === target.scopeId &&
											openingFile.number === target.number &&
											openingFile.path === file.path,
										active =
											activeFile?.scopeId === target.scopeId &&
											activeFile.number === target.number &&
											activeFile.path === file.path;
									return (
										<PRFileRow
											key={file.path}
											file={file}
											locale={locale}
											projectName={projectName}
											comments={threads
												.filter((thread) => thread.path === file.path)
												.reduce((sum, thread) => sum + thread.comments.length, 0)}
											opening={opening}
											pressed={opening || (active && !openingFile)}
											saving={viewing[file.path]?.saving}
											pending={Boolean(viewing[file.path])}
											failed={viewedError?.path === file.path}
											onKeyDown={stepRow}
											open={() => onOpenFile?.(target, file.path, null)}
											view={() => {
												void actions.viewed(file.path, !file.viewed);
											}}
										/>
									);
								})}
							</>
						);
					})(shownFiles(detail.files, viewing))}
				{detail &&
					prTab === 'commits' &&
					detail.commits.map((commit) => (
						<CommitRow
							key={commit.sha}
							task={task}
							target={target}
							commit={commit}
							locale={locale}
							projectName={projectName}
							open={(value, fileId) =>
								onOpenCommitFile?.(target.scopeId, commit.sha, value, fileId)
							}
						/>
					))}
				{detail && prTab === 'checks' && mergeSha && (
					<MergedChecks
						task={task}
						locale={locale}
						scopeId={target.scopeId}
						ci={ci}
						checks={detail.checks}
						label={`#${target.number}`}
						onCIFix={
							onCIFix
								? (scopeId, run, job, step) => onCIFix(scopeId, run, job, step, target.number)
								: undefined
						}
						checkRows={
							<>
								{detail.checks.map((check, index) => (
									<CheckRow
										key={`${check.name}/${index}`}
										check={check}
										locale={locale}
										onLog={openCheckLog}
									/>
								))}
							</>
						}
					/>
				)}
				{detail && prTab === 'checks' && !mergeSha && (
					<>
						{detail.checks.map((check, index) => (
							<CheckRow
								key={`${check.name}/${index}`}
								check={check}
								locale={locale}
								onLog={openCheckLog}
							/>
						))}
						{!detail.checks.length && <p className={styles.hint}>{t(locale, 'No checks')}</p>}
					</>
				)}
			</div>
			{detail &&
			selectable &&
			prTab === 'comments' &&
			threads.some((thread) => !thread.resolved) ? (
				<OwnFooter
					locale={locale}
					handed={threads.filter((thread) => prHanded.includes(thread.id)).length}
					chosen={chosen.size}
					total={
						threads.filter((thread) => !thread.resolved && !prHanded.includes(thread.id)).length
					}
					reply={() => onOverview?.(target)}
					hand={() => {
						void onHandThreads!(
							detail,
							target.scopeId,
							threads.filter((thread) => chosen.has(thread.id))
						).then(() => setPicked(null));
					}}
				/>
			) : (
				detail &&
				(footer
					? footer(detail, target.scopeId)
					: isOpenPR(detail.summary) && (
							<PRReviewFooter task={task} locale={locale} target={target} />
						))
			)}
		</div>
	);
}
/**
 * A PR file with «Viewed» (spec/pull-requests-and-ci#pr-files): the row button spans the whole row (rule 15), the 24 px checkbox lies over its left
 * end. One look in the PR panel and in the review modal (spec/appearance#evolution-redesign, rule 17).
 */
export function PRFileRow({
	file,
	locale,
	projectName,
	comments,
	opening = false,
	pressed,
	saving,
	pending,
	failed,
	onKeyDown,
	open,
	view,
	badges,
}: {
	/** spec/appearance#evolution-redesign: the review summary's ⚠ / ✓ on this file (`ui/SpotBadges`), after the comments. */ badges?: ReactNode;
	file: PullRequestDetail['files'][number];
	locale: Locale;
	projectName: string;
	comments: number;
	opening?: boolean;
	pressed: boolean;
	saving?: boolean | undefined;
	pending: boolean;
	failed: boolean;
	onKeyDown?: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined;
	open(): void;
	view(): void;
}) {
	const slash = file.path.lastIndexOf('/');
	return (
		<div className={styles.fileLine}>
			<button
				type="button"
				className={styles.file}
				aria-pressed={pressed}
				aria-busy={opening || undefined}
				data-opening={opening || undefined}
				data-pr-file={file.path}
				data-pr-step
				title={opening ? `${t(locale, 'Opening…')} · ${file.path}` : file.path}
				onKeyDown={onKeyDown}
				onClick={open}>
				<span className={styles.path}>
					<strong>{file.path.slice(slash + 1)}</strong>
					<small>{slash > 0 ? file.path.slice(0, slash) : projectName}</small>
				</span>
				{opening && (
					<span className={styles.opening} role="status" aria-label={t(locale, 'Opening…')}>
						<Spinner />
					</span>
				)}
				{comments > 0 && (
					<span className={styles.comments}>
						<Glyph name="bubble" size={11} />
						<span>{comments}</span>
					</span>
				)}
				{badges}
				<ChangeCounts
					additions={file.additions}
					deletions={file.deletions}
					locale={locale}
					className={styles.counts}
					split
				/>
			</button>
			<label className={styles.tick} data-size="s">
				<Choice
					type="checkbox"
					tabIndex={-1}
					label={`${t(locale, 'Viewed')} · ${file.path}`}
					checked={file.viewed}
					data-saving={saving || undefined}
					data-failed={failed || undefined}
					aria-busy={pending || undefined}
					title={saving ? t(locale, 'Saving…') : t(locale, file.viewed ? 'Viewed' : 'Not viewed')}
					onChange={view}
				/>
			</label>
		</div>
	);
}

const duration = ciDuration;
function ThreadRow({
	thread,
	locale,
	open,
	pick = null,
	handed = false,
}: {
	thread: PRThread;
	locale: Locale;
	open(): void;
	pick?: { checked: boolean; toggle(): void } | null;
	handed?: boolean;
}) {
	const first = thread.comments[0],
		name = thread.path.split('/').at(-1);
	return (
		<div className={styles.threadLine}>
			{pick && (
				<label className={styles.tick} data-size="s">
					<Choice
						type="checkbox"
						label={`${t(locale, 'Hand to the agent')} · ${name}${thread.line ? `:${thread.line}` : ''}`}
						checked={pick.checked}
						onChange={pick.toggle}
					/>
				</label>
			)}
			<button
				type="button"
				className={styles.thread}
				data-resolved={thread.resolved}
				data-pr-step
				title={first?.body}
				onKeyDown={stepRow}
				onClick={open}>
				{first && <Avatar login={first.author} />}
				<span className={styles.copy}>
					<span className={styles.place}>
						{name}
						{thread.line ? `:${thread.line}` : ''}
					</span>
					<span className={styles.text}>{first?.body.split('\n')[0]}</span>
				</span>
				{thread.resolved ? (
					<span
						className={styles.resolved}
						title={t(locale, 'Resolved')}
						role="img"
						aria-label={t(locale, 'Resolved')}>
						<Glyph name="tick" size={11} />
					</span>
				) : handed ? (
					<span
						className={styles.handed}
						title={t(locale, 'Handed to the agent')}
						role="img"
						aria-label={t(locale, 'Handed to the agent')}>
						<Glyph name="send-plane" size={11} />
					</span>
				) : (
					<span
						className={styles.openDot}
						title={t(locale, 'Open thread')}
						role="img"
						aria-label={t(locale, 'Open thread')}
					/>
				)}
			</button>
		</div>
	);
}
/** A PR commit expands into its files, as in History; a click on a file opens the commit's diff as a tab (spec/pull-requests-and-ci#pr-list). */
/** A PR commit row: expands into files, a click on a file opens the commit's diff as a tab (the Commits tab and the Overview filter). */
export function CommitRow({
	task,
	target,
	commit,
	locale,
	projectName,
	open,
}: {
	task: AgentTask;
	target: Ref;
	commit: PullRequestDetail['commits'][number];
	locale: Locale;
	projectName: string;
	open(diff: FileDiff, fileId: string): void;
}) {
	const [files, setFiles] = useState<ChangedFile[] | null>(null),
		[expanded, setExpanded] = useState(false),
		[failed, setFailed] = useState(false);
	async function toggle() {
		if (expanded) {
			setExpanded(false);
			return;
		}
		setExpanded(true);
		if (files) return;
		try {
			await window.brigadir.preparePullRequestTrees(task, target);
			setFiles((await window.brigadir.readHistoryCommit(task, target.scopeId, commit.sha)).files);
		} catch {
			setFailed(true);
		}
	}
	return (
		<div className={styles.commitGroup}>
			<button
				type="button"
				className={styles.commit}
				aria-expanded={expanded}
				title={commit.subject}
				onClick={() => {
					void toggle();
				}}>
				<Glyph name="commit-dot" size={12} />
				<span className={styles.copy}>
					<span className={styles.subject}>{commit.subject}</span>
					<span className={styles.meta}>
						<code>{commit.sha.slice(0, 7)}</code> · {commit.author} · {prAge(locale, commit.at)}
					</span>
				</span>
			</button>
			{expanded && (
				<div className={styles.commitFiles}>
					{failed ? (
						<p className={styles.hint}>{t(locale, 'The commit could not be read.')}</p>
					) : !files ? (
						<SkeletonRows count={3} height={24} single />
					) : (
						files.map((file) => {
							const slash = file.path.lastIndexOf('/');
							return (
								<button
									type="button"
									key={file.id}
									className={styles.file}
									title={file.path}
									onClick={() => {
										void window.brigadir
											.readHistoryFile(task, target.scopeId, commit.sha, file.id)
											.then(
												(value) => open(value, file.id),
												() => setFailed(true)
											);
									}}>
									<span className={styles.path}>
										<strong>{file.path.slice(slash + 1)}</strong>
										<small>{slash > 0 ? file.path.slice(0, slash) : projectName}</small>
									</span>
									<ChangeCounts
										additions={file.additions}
										deletions={file.deletions}
										locale={locale}
										className={styles.counts}
										split
									/>
								</button>
							);
						})
					)}
				</div>
			)}
		</div>
	);
}
/** spec/pull-requests-and-ci#hand-to-agent: the footer of your own PR on the Comments tab — picking the reviewer's threads and two actions. */
function OwnFooter({
	locale,
	chosen,
	total,
	handed,
	reply,
	hand,
}: {
	locale: Locale;
	chosen: number;
	total: number;
	handed: number;
	reply(): void;
	hand(): void;
}) {
	return (
		<div className={styles.ownFooter} data-pr-own-footer data-size="m">
			{total === 0 && handed > 0 ? (
				<>
					<Glyph name="send-plane" size={12} />
					<span className={styles.ownSent}>
						{t(locale, '{n} handed to the agent').replace('{n}', commentCount(locale, handed))}
					</span>
				</>
			) : (
				<small>
					{t(locale, '{n} of {total} chosen')
						.replace('{n}', String(chosen))
						.replace('{total}', String(total))}
				</small>
			)}
			<span className={styles.space} />
			<Button onClick={reply}>{t(locale, 'Reply in the PR')}</Button>
			{total > 0 && (
				<Button appearance="primary" disabled={!chosen} onClick={hand}>
					<Glyph name="send-plane" size={12} />
					{t(locale, 'Hand to the agent')}
				</Button>
			)}
		</div>
	);
}
/** spec/pull-requests-and-ci#review-with-agent: the live review task opens with the PR panel on its PR. */
export function openReviewTask(review: AgentTask, open?: ((task: AgentTask) => void) | undefined) {
	if (review.prReview)
		openTaskPR(review, { scopeId: review.prReview.scopeId, number: review.prReview.number });
	if (open) open(review);
	else useWorkspace.getState().selectTask(review.projectId, review.id);
}
/**
 * spec/pull-requests-and-ci#review-with-agent: `Review with an agent…` opens the launch dialog (spec/pull-requests-and-ci#review-launch). While a review
 * task of this PR is live it is `Open the review`, led by that task's status. Below 300 px it reads `With an agent…`; the name stays whole for VoiceOver.
 */
export function AgentReviewButton({
	locale,
	projectId,
	scopeId,
	repo = null,
	number,
	title,
	action = 'review',
	run,
	onOpenReview,
}: {
	locale: Locale;
	projectId: string;
	/** The PR's repo as the caller knows it; `repo` — its name in the project, so a worktree's id finds the task too. */
	scopeId: string;
	repo?: string | null;
	number: number;
	title: string;
	/** spec/appearance#evolution-redesign: from the review modal it is «agent suggestions in review», its own row of Customize per action. */
	action?: 'review' | 'reviewSuggestions';
	run(choice: ReviewChoice): Promise<boolean>;
	onOpenReview(review: AgentTask): void;
}) {
	const live = useWorkspace((state) =>
		liveReviewTask(state.workspace?.tasks ?? [], { projectId, number, scopeId, repo })
	);
	if (live) {
		const status = taskStatusLabel(live, locale);
		return (
			<Button data-open-review title={status} onClick={() => onOpenReview(live)}>
				<StatusIcon status={live.status} label={status} size={12} />
				{t(locale, 'Open the review')}
				<Glyph name="zoom" size={11} />
			</Button>
		);
	}
	return (
		<Button
			data-agent-review
			aria-label={t(locale, 'Review with an agent…')}
			onClick={() => openReviewLaunch({ projectId, scopeId, number, title, action, start: run })}>
			<Glyph name="generate" size={11} />
			<span className={styles.wide}>{t(locale, 'Review with an agent…')}</span>
			<span className={styles.narrow}>{t(locale, 'With an agent…')}</span>
		</Button>
	);
}
