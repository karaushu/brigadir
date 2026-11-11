/**
 * spec/projects-and-board#pr-mode: the project screen's «Pull requests» tab — every PR of the project's repos (or of all open projects) in Draft /
 * Open / In review / Closed, the PR badge on a task card, and the review modal over the project screen. The cards share the
 * task cards' shell (ProjectScreen.module.css, rule 17); the list is the same columns in rows.
 */
import { useEffect, useRef, useState } from 'react';
import {
	draftCount,
	isOpenPR,
	prColumns,
	prKeyOf,
	prTask,
	relativeAge,
	reviewStarted,
	t,
	type AgentTask,
	type ForgeAuth,
	liveReviewTask,
	type Locale,
	type MessageKey,
	type PRColumn,
	type PRFilter,
	type PRLocalReview,
	type PRMenuAction,
	type PRRefKey,
	type ProjectView,
	type PullRequestSummary,
	type RepoPullRequests,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { Avatar } from './ui/Avatar';
import { BranchName } from './ui/BranchName';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { PRStateGlyph, PRMarkGlyph } from './ui/PRGlyphs';
import { ProjectIcon } from './ui/ProjectIcon';
import { resolveToast, showToast, toastError } from './ui/Toast';
import { ChecksGlyph, openReviewTask } from './PullRequestPanel';
import { openReviewLaunch, type ReviewChoice } from './ReviewLaunch';
import { repoName } from './ui/RepoPicker';
import { PRReviewModal } from './PRReviewModal';
import { closeReview, openReview, useReviewOpen } from './pr-review';
import { openTaskPR } from './task-state';
import { deliverPrompt, prFixQuickTask } from './pr-agent';
import { useWorkspace } from './store';
import type { QuickTaskRequest } from './QuickTask';
import s from './ProjectScreen.module.css';
import links from './RelayLinks.module.css';
import p from './ProjectPRs.module.css';

export type BoardPR = {
	projectId: string;
	/** The repo's id in the project's main tree (spec/pull-requests-and-ci#review-drafts) — the key of its review file. */ scopeId: string;
	repo: string;
	pr: PullRequestSummary;
	local: PRLocalReview | null;
};
/** A repo of the board: the main tree's repo of one project (spec/projects-and-board#pr-mode). */
export type BoardRepo = RepoPullRequests & { projectId: string };
type BoardState = {
	items: BoardPR[];
	repos: BoardRepo[];
	auth: ForgeAuth;
	loaded: boolean;
	failed: boolean;
};

/**
 * PRs of the projects on the screen, read like the PR panel of the main tree (spec/pull-requests-and-ci#reading-and-refresh, cache spec/pull-requests-and-ci#pr-files) and the review state
 * of each from its review file. Read on open, on window focus and every minute; nothing while the module is off (spec/settings-modules-and-onboarding#module-off).
 */
export function useBoardPRs(projectIds: readonly string[], enabled: boolean, locale: Locale) {
	const [state, setState] = useState<BoardState>({
		items: [],
		repos: [],
		auth: 'ready',
		loaded: false,
		failed: false,
	});
	const revision = useRef(0),
		failedBefore = useRef(false),
		key = projectIds.join('\0');
	async function refresh(fresh = false): Promise<BoardPR[]> {
		const id = ++revision.current;
		if (!enabled || !projectIds.length) {
			setState({ items: [], repos: [], auth: 'ready', loaded: true, failed: false });
			return [];
		}
		const results = await Promise.allSettled(
			projectIds.map(async (projectId) => {
				const snapshot = await window.brigadir.readPullRequests(projectId, null, fresh);
				const refs = snapshot.repos.flatMap((repo) =>
					repo.prs.map((pr) => ({ scopeId: repo.scopeId, number: pr.number }))
				);
				const local = refs.length
					? await window.brigadir.readPullRequestReviewStates(projectId, refs).catch(() => ({}))
					: {};
				return {
					auth: snapshot.auth,
					repos: snapshot.repos.map((repo): BoardRepo => ({ ...repo, projectId })),
					items: snapshot.repos.flatMap((repo) =>
						repo.prs.map((pr): BoardPR => ({
							projectId,
							scopeId: repo.scopeId,
							repo: repo.name,
							pr,
							local:
								(local as Record<string, PRLocalReview>)[prKeyOf(repo.scopeId, pr.number)] ?? null,
						}))
					),
				};
			})
		);
		if (id !== revision.current) return [];
		const read = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
		const failed = !read.length;
		setState((previous) => ({
			items: failed ? previous.items : read.flatMap((value) => value.items),
			repos: failed ? previous.repos : read.flatMap((value) => value.repos),
			auth: read.find((value) => value.auth !== 'ready')?.auth ?? 'ready',
			loaded: true,
			failed,
		}));
		const text = t(locale, 'Could not load pull requests.');
		// spec/projects-and-board#pr-mode: one toast when reading stops working, not one a minute.
		if (failed && !failedBefore.current)
			toastError(text, {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void refresh(true);
					},
				},
			});
		if (!failed) resolveToast(text);
		failedBefore.current = failed;
		return read.flatMap((value) => value.items);
	}
	const readFor = useRef(key);
	useEffect(() => {
		// spec/appearance#loading: the projects came after an empty first list — their PRs are not read yet, so the skeleton, not «0».
		if (!readFor.current && key && enabled)
			setState((previous) => ({ ...previous, loaded: false }));
		readFor.current = key;
		void refresh();
		if (!enabled) return;
		const focus = () => {
			void refresh(true);
		};
		window.addEventListener('focus', focus);
		const timer = setInterval(() => {
			void refresh();
		}, 60_000);
		return () => {
			window.removeEventListener('focus', focus);
			clearInterval(timer);
		};
	}, [key, enabled]);
	return { ...state, refresh };
}

/** The main tree's hidden record of a project (spec/tasks#quick-tasks): the key the PR IPC writes with when no task stands behind the screen. */
const mainTrees = new Map<string, Promise<AgentTask>>();
export function mainTreeTask(projectId: string) {
	let task = mainTrees.get(projectId);
	if (!task) {
		task = window.brigadir.openMainTree(projectId);
		mainTrees.set(projectId, task);
		task.catch(() => mainTrees.delete(projectId));
	}
	return task;
}

export const prColumnLabels: Record<PRColumn, MessageKey> = {
	draft: 'Draft (column)',
	open: 'Open (column)',
	review: 'In review (column)',
	closed: 'Closed (column)',
};
const columnHints: Record<PRColumn, MessageKey> = {
	draft: 'No drafts',
	open: 'No open PRs',
	review: 'Nobody is reviewing yet',
	closed: 'Nothing closed in 7 days',
};
const reviewerLabel = {
	APPROVED: 'Approved',
	CHANGES_REQUESTED: 'Changes requested',
	COMMENTED: 'Commented',
	REQUESTED: 'Review requested',
} as const;

function Reviewers({ pr, locale }: { pr: PullRequestSummary; locale: Locale }) {
	return (
		<>
			{pr.reviewers.flatMap((reviewer) => {
				if (!(reviewer.state in reviewerLabel)) return [];
				const label = t(locale, reviewerLabel[reviewer.state as keyof typeof reviewerLabel]);
				return [
					<span
						key={reviewer.login}
						className={p.reviewer}
						data-review={reviewer.state}
						title={`${label}: ${reviewer.login}`}>
						<Avatar login={reviewer.login} />
						{reviewer.state === 'APPROVED' && <Glyph name="check-pass" size={11} />}
						{reviewer.state === 'CHANGES_REQUESTED' && <Glyph name="review-changes" size={11} />}
						{reviewer.state === 'COMMENTED' && <Glyph name="bubble" size={11} />}
					</span>,
				];
			})}
		</>
	);
}

/** «Your review · 2 drafts · 4/6 viewed» — the review started here, continued in the modal (spec/projects-and-board#pr-mode). */
function YourReview({
	local,
	locale,
	onClick,
}: {
	local: PRLocalReview;
	locale: Locale;
	onClick(): void;
}) {
	const parts = [
		local.drafts ? draftCount(locale, local.drafts) : '',
		local.viewed?.n
			? t(locale, '{v}/{t} viewed')
					.replace('{v}', String(local.viewed.n))
					.replace('{t}', String(local.viewed.of))
			: '',
	].filter(Boolean);
	return (
		<button
			type="button"
			className={p.yours}
			title={t(locale, 'Continue your review')}
			data-your-review
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}>
			<Glyph name="review" size={12} />
			{t(locale, 'Your review')}
			{parts.length > 0 && <small>· {parts.join(' · ')}</small>}
		</button>
	);
}

export function PRBoard({
	items,
	filter,
	view,
	locale,
	all,
	workspace,
	colors,
	now,
	review,
	ready,
	repoShown,
}: {
	/** spec/pull-requests-and-ci#repo-picker, spec/projects-and-board#pr-mode: the repo's name on a card only while the board holds more than one repo of its project. */
	repoShown(item: BoardPR): boolean;
	items: readonly BoardPR[];
	filter: PRFilter;
	view: ProjectView;
	locale: Locale;
	all: boolean;
	workspace: WorkspaceSnapshot;
	colors: Map<string, number>;
	now: number;
	review(item: BoardPR): void;
	/** spec/projects-and-board#pr-mode: Draft → Open marks the PR ready for review. */ ready(
		item: BoardPR
	): Promise<void>;
}) {
	const columns = prColumns(items, filter, now);
	const drag = useRef<BoardPR | null>(null),
		ignoreClick = useRef(0),
		[dragging, setDragging] = useState<string | null>(null),
		[over, setOver] = useState<PRColumn | null>(null),
		[busy, setBusy] = useState<string | null>(null);
	const id = (item: BoardPR) => `${item.projectId}/${item.scopeId}/${item.pr.number}`;
	const drops = (item: BoardPR | null, column: PRColumn) =>
		!!item && item.pr.state === 'DRAFT' && column === 'open' && !busy;
	function finishDrag() {
		drag.current = null;
		ignoreClick.current = performance.now() + 300;
		setDragging(null);
		setOver(null);
	}
	async function menu(item: BoardPR) {
		let action: PRMenuAction | null;
		const ref = { scopeId: item.scopeId, number: item.pr.number };
		try {
			action = await window.brigadir.pullRequestMenu(await mainTreeTask(item.projectId), ref, {
				state: item.pr.state,
				head: item.pr.head,
				url: item.pr.url,
			});
		} catch {
			toastError(t(locale, 'Could not open the menu.'));
			return;
		}
		if (action === 'review') review(item);
		// spec/pull-requests-and-ci#pr-row-menu: the launch dialog, or the live review task of this PR.
		if (action === 'agent-review')
			openReviewLaunch({
				projectId: item.projectId,
				scopeId: item.scopeId,
				number: item.pr.number,
				title: item.pr.title,
				action: 'review',
				start: (choice) => startAgentReview(item, locale, choice),
			});
		if (action === 'open-review') {
			const review = liveReviewTask(useWorkspace.getState().workspace?.tasks ?? [], {
				projectId: item.projectId,
				number: item.pr.number,
				scopeId: item.scopeId,
			});
			if (review) openReviewTask(review);
		}
		if (action === 'github')
			void window.brigadir
				.openPullRequestPage(item.projectId, null, item.scopeId, item.pr.number)
				.catch(() => {});
	}
	return (
		<div className={s.board} data-view={view} data-pr-board key={view}>
			{columns.map(({ column, items: cards }) => (
				<section
					key={column}
					className={s.column}
					data-pr-column={column}
					data-drop={over === column}
					aria-label={t(locale, prColumnLabels[column])}
					onDragOver={(event) => {
						if (drops(drag.current, column)) {
							event.preventDefault();
							event.dataTransfer.dropEffect = 'move';
							setOver(column);
						} else {
							event.dataTransfer.dropEffect = 'none';
							setOver(null);
						}
					}}
					onDragLeave={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
					}}
					onDrop={(event) => {
						event.preventDefault();
						const source = drag.current;
						finishDrag();
						if (!source || !drops(source, column)) return;
						setBusy(id(source));
						void ready(source).finally(() => setBusy(null));
					}}>
					<header className={s.columnHeading}>
						<h2>
							{t(locale, prColumnLabels[column])}
							<span>· {cards.length}</span>
						</h2>
						{column === 'review' && (
							<span
								className={p.hint}
								role="img"
								aria-label={t(locale, 'Reviewed on GitHub, or a review started here')}
								title={t(locale, 'Reviewed on GitHub, or a review started here')}>
								<Glyph name="review-info" size={12} />
							</span>
						)}
						{column === 'closed' && (
							<span className={s.limit} title={t(locale, 'Merged or closed in the last 7 days')}>
								{t(locale, '7 days')}
							</span>
						)}
					</header>
					<div className={s.cards}>
						{!cards.length && <div className={s.placeholder}>{t(locale, columnHints[column])}</div>}
						{cards.map((item) => {
							const { pr } = item,
								closed = !isOpenPR(pr),
								owner = prTask(workspace.tasks, item.projectId, {
									scopeId: item.scopeId,
									number: pr.number,
									url: pr.url,
								}),
								project = workspace.projects.find((value) => value.id === item.projectId),
								open = () => {
									if (drag.current || performance.now() < ignoreClick.current) return;
									review(item);
								};
							return (
								<article
									key={id(item)}
									className={`${s.card} ${p.card}`}
									data-board-pr={pr.number}
									data-pr-state={pr.state}
									data-closed={closed || undefined}
									data-dragging={dragging === id(item)}
									aria-busy={busy === id(item)}
									aria-label={`#${pr.number} ${pr.title}`}
									tabIndex={0}
									draggable={pr.state === 'DRAFT' && !busy}
									onDragStart={(event) => {
										if ((event.target as HTMLElement).closest('button')) {
											event.preventDefault();
											return;
										}
										drag.current = item;
										ignoreClick.current = Number.POSITIVE_INFINITY;
										event.dataTransfer.effectAllowed = 'move';
										event.dataTransfer.setData('application/x-brigadir-pr', id(item));
										setDragging(id(item));
									}}
									onDragEnd={finishDrag}
									onClick={open}
									onContextMenu={(event) => {
										event.preventDefault();
										void menu(item);
									}}
									onKeyDown={(event) => {
										if (event.target !== event.currentTarget) return;
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault();
											open();
										}
										if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
											event.preventDefault();
											void menu(item);
										}
									}}>
									<div className={p.top}>
										<PRStateGlyph pr={pr} size={13} />
										<span className={p.number}>#{pr.number}</span>
										{all && (
											<>
												<span className={p.projectIcon} title={project?.name}>
													<ProjectIcon
														className={s.dot}
														project={project ?? { name: item.projectId }}
														slot={colors.get(item.projectId) ?? 0}
														size={14}
													/>
												</span>
												{/* The icon names the project; its name gives way to the repo's when the project has several. */}
												{!repoShown(item) && (
													<span className={p.project}>{project?.name ?? ''}</span>
												)}
											</>
										)}
										{repoShown(item) && (
											<span className={p.repo}>
												{repoName({ name: item.repo }, project?.name ?? '')}
											</span>
										)}
										<span className={p.marks}>
											{/* Only «waits for you» here: the reviewers' decision is on their avatars below. */}
											{!closed && pr.waiting && <PRMarkGlyph pr={pr} locale={locale} size={12} />}
											{pr.comments > 0 && (
												<span className={p.comments} title={t(locale, 'Comments')}>
													<Glyph name="bubble" size={11} />
													{pr.comments}
												</span>
											)}
											{!closed && <ChecksGlyph state={pr.checks} locale={locale} />}
										</span>
									</div>
									<h3 className={p.title} title={pr.title}>
										{pr.title}
									</h3>
									{!closed && (pr.reviewers.length > 0 || reviewStarted(item.local)) && (
										<div className={p.reviewers}>
											{item.local && reviewStarted(item.local) && (
												<YourReview
													local={item.local}
													locale={locale}
													onClick={() => review(item)}
												/>
											)}
											<Reviewers pr={pr} locale={locale} />
										</div>
									)}
									<footer className={`${s.meta} ${p.meta}`}>
										<span className={p.author}>
											<Avatar login={pr.author} />
											{pr.mine ? t(locale, 'you') : pr.author}
										</span>
										<span className={s.branch}>
											<Glyph name="board-branch" size={11} />
											<BranchName name={pr.head} />
										</span>
										<time dateTime={closed ? (pr.closedAt ?? pr.updatedAt) : pr.updatedAt}>
											{relativeAge(
												locale,
												closed ? (pr.closedAt ?? pr.updatedAt) : pr.updatedAt,
												now
											)}
										</time>
									</footer>
									{owner && (
										<div className={`${links.links} ${p.links}`}>
											<Button
												size="s"
												title={owner.title}
												data-pr-task
												onClick={(event) => {
													event.stopPropagation();
													useWorkspace.getState().selectTask(owner.projectId, owner.id);
												}}>
												<Glyph name="base-task" size={12} />
												<span>
													{t(locale, 'Task (link)')} <strong>{owner.title}</strong>
												</span>
											</Button>
										</div>
									)}
								</article>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}

/** The board item of a task's PR: the list knows the PR by its address, the task by its own repo id (spec/pull-requests-and-ci#review-drafts). */
export function taskPRItems(task: AgentTask, items: readonly BoardPR[]) {
	return Object.values(task.pullRequests ?? {})
		.filter((ref) => ref.state === 'OPEN')
		.map((ref) => ({
			ref,
			item:
				items.find((item) => item.projectId === task.projectId && item.pr.url === ref.url) ?? null,
		}));
}

/** spec/projects-and-board#pr-mode: the badge of a task's open PR (or draft) in the card's meta row; a click opens the review. */
export function TaskPRBadges({
	task,
	items,
	locale,
	review,
	missing,
}: {
	task: AgentTask;
	items: readonly BoardPR[];
	locale: Locale;
	review(item: BoardPR): void;
	/** The board has not read this PR yet (the first read of GitHub is still running): the host reads and opens it. */
	missing(task: AgentTask, url: string): void;
}) {
	const prs = taskPRItems(task, items).filter(({ item }) => !item || isOpenPR(item.pr));
	if (!prs.length) return null;
	const shown = prs.slice(0, 2);
	return (
		<>
			{shown.map(({ ref, item }) => {
				const pr = item?.pr;
				return (
					<button
						type="button"
						key={ref.url}
						className={p.badge}
						data-task-pr-badge={ref.number}
						title={t(locale, 'PR #{n} · Open the review').replace('{n}', String(ref.number))}
						onClick={(event) => {
							event.stopPropagation();
							if (item) review(item);
							else missing(task, ref.url);
						}}>
						<PRStateGlyph pr={pr ?? { state: 'OPEN' }} size={11} />#{ref.number}
						{item && reviewStarted(item.local) && <Glyph name="review" size={11} />}
						{pr && <ChecksGlyph state={pr.checks} locale={locale} size={11} />}
					</button>
				);
			})}
			{prs.length > shown.length && <span className={p.more}>+{prs.length - shown.length}</span>}
		</>
	);
}

/** spec/pull-requests-and-ci#review-with-agent from the project screen: the review task starts on the main tree's key and opens on its PR. */
/** spec/pull-requests-and-ci#review-launch: a failure stays in the launch dialog, so it answers false and shows nothing itself. */
async function startAgentReview(
	item: BoardPR,
	locale: Locale,
	{ where, agent, crew, notes }: ReviewChoice,
	suggestions = false
): Promise<boolean> {
	const ref = { scopeId: item.scopeId, number: item.pr.number };
	try {
		const result = await window.brigadir.startPullRequestAgent(
			await mainTreeTask(item.projectId),
			ref,
			'review',
			false,
			where,
			crew ? null : agent,
			suggestions,
			crew,
			notes
		);
		openTaskPR(result.task, {
			scopeId: result.task.prReview?.scopeId ?? ref.scopeId,
			number: ref.number,
		});
		const started = t(locale, 'The task «{title}» started').replace('{title}', result.task.title),
			open = () => useWorkspace.getState().selectTask(result.task.projectId, result.task.id);
		// spec/pull-requests-and-ci#review-with-agent: from the review modal the review task opens at once.
		if (suggestions) {
			open();
			showToast(started);
		} else showToast(started, { label: t(locale, 'Open'), run: open });
		return true;
	} catch {
		return false;
	}
}

/**
 * spec/projects-and-board#pr-mode: the review modal over the project screen. Its key is the main tree's hidden record, so drafts, the summary and
 * GitHub writes take the same path as from the main tree; what needs an agent goes where it lives already — a quick task, the
 * review task (spec/pull-requests-and-ci#review-with-agent), the PR's own task.
 */
export function ProjectReview({
	task,
	target,
	projectName,
	locale,
	quickTask,
	closed,
}: {
	task: AgentTask;
	target: PRRefKey;
	projectName: string;
	locale: Locale;
	quickTask(request: QuickTaskRequest): void;
	closed(): void;
}) {
	const open = useReviewOpen(task);
	useEffect(() => {
		openReview(task, target);
	}, []);
	const shown = useRef(false);
	useEffect(() => {
		if (open) shown.current = true;
		else if (shown.current) closed();
	}, [open]);
	if (!open) return null;
	const item: BoardPR = {
		projectId: task.projectId,
		scopeId: open.scopeId,
		repo: '',
		pr: { number: open.number } as PullRequestSummary,
		local: null,
	};
	return (
		<PRReviewModal
			key={`${open.scopeId}/${open.number}`}
			task={task}
			target={open}
			locale={locale}
			projectName={projectName}
			mainTree
			onCompose={async (text, _focus, _immediate, name, after) => {
				quickTask({
					projectId: task.projectId,
					scopeId: open.scopeId,
					context: [
						{
							icon: 'code',
							label: name ? name.split('/').at(-1)! : t(locale, 'Selected code'),
							text: [name, text, after].filter(Boolean).join('\n\n'),
						},
					],
				});
				closeReview(task);
				return true;
			}}
			onDeliver={(text, to) => deliverPrompt(to, text)}
			// spec/appearance#evolution-redesign: from the review modal it is «agent suggestions in review».
			onAgentReview={(choice) =>
				startAgentReview(item, locale, choice, true).then((ok) => {
					if (ok) closeReview(task);
					return ok;
				})
			}
			onOpenReview={(review) => openReviewTask(review)}
			onAgentFix={async () => {
				try {
					quickTask({ projectId: task.projectId, ...(await prFixQuickTask(task, open, locale)) });
					closeReview(task);
					return true;
				} catch {
					toastError(t(locale, 'Could not read the pull request.'));
					return false;
				}
			}}
		/>
	);
}
