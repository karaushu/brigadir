import { AgentsButton } from './LiveAgents';
import {
	crewNeedsYou,
	crewWorkers,
	liveCrewWorkers,
	personTasks,
	sidebarMatches,
	type SidebarFilter,
} from '@brigadir/core';
import { KnowledgePanel } from './Knowledge';
import { RelayLinks } from './RelayLinks';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
	agentOptionKind,
	boardColumns,
	boardColumn,
	boardMove,
	boardSections,
	canArchive,
	projectColors,
	t,
	defaultProjectMode,
	boardRepoKey,
	prColumns,
	prColumnOrder,
	waitingCount,
	type AgentTask,
	type BoardColumn,
	type Locale,
	type MessageKey,
	type PRFilter,
	type PRRefKey,
	type ProjectMode,
	type ProjectTab,
	type ProjectView,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import {
	PRBoard,
	ProjectReview,
	TaskPRBadges,
	mainTreeTask,
	prColumnLabels,
	useBoardPRs,
	type BoardPR,
	type BoardRepo,
} from './ProjectPRs';
import { RepoPicker, repoName } from './ui/RepoPicker';
import type { QuickTaskRequest } from './QuickTask';
import { openTaskPR } from './task-state';
import { Button, IconButton, Segments } from './ui/Controls';
import { ArchiveScreenButton, archiveTask } from './Archive';
import { Glyph } from './ui/Glyph';
import { SkeletonBoard } from './ui/Loading';
import { resolveToast, toastError, toastWarning } from './ui/Toast';
import { useWorkspace } from './store';
import { useCommandShortcut } from './ui/use-command-shortcut';
import { clearPRReview, usePRSectionReview } from './pr-section';
import { NewPRButton } from './NewPRButton';
import s from './ProjectScreen.module.css';
import {
	BoardCard,
	BoardColumnView,
	BoardColumns,
	BoardLimit,
	ProjectTitlebar,
	ProjectToolbar,
} from './ProjectBoard';
const labels: Record<BoardColumn, MessageKey> = {
	backlog: 'Backlog',
	progress: 'In progress',
	completed: 'Completed',
};
const hints: Record<BoardColumn, MessageKey> = {
	backlog: 'Set aside for later',
	progress: 'Drop here and the agent starts',
	completed: 'Drop here what you have accepted',
};
export function ProjectScreen({
	archived,
	openArchive,
	workspace,
	projectId,
	locale,
	newTask,
	editTask,
	taskMenu,
	search,
	knowledgeMenu,
	statusFilter,
	quietRuns = false,
	quickTask,
	section,
}: {
	/** spec/notifications-slack-notes-and-schedules#schedules: quiet scheduled runs show only with the sidebar filter's «Quiet scheduled runs». */ quietRuns?: boolean;
	/** spec/sidebar#section-rail: the rail's section — the board of tasks or of pull requests, with no tabs. */
	section: ProjectTab;
	/** spec/projects-and-board#pr-mode: «To the agent» from the review modal over the screen — a quick task in the main tree (spec/tasks#quick-tasks). */
	quickTask(request: QuickTaskRequest): void;
	/** spec/notifications-slack-notes-and-schedules#notes: the sheet for a note of the Notes tab, and a click on a link to a task in it. */
	workspace: WorkspaceSnapshot;
	projectId: string;
	locale: Locale;
	newTask(backlog: boolean): void;
	editTask(task: AgentTask): void;
	taskMenu(task: AgentTask): void;
	search(): void;
	knowledgeMenu(): void;
	statusFilter: SidebarFilter;
	archived: number;
	openArchive(): void;
}) {
	const newTaskKey = useCommandShortcut()('new-task');
	const [knowledgeCount, setKnowledgeCount] = useState(0),
		[knowledgeExpand, setKnowledgeExpand] = useState(0);
	const all = projectId === '*',
		project = workspace.projects.find((item) => item.id === projectId);
	const home = workspace.homeDirectory,
		path = project?.path ?? '';
	/** spec/projects-and-board#pr-mode: the panel has no title; the window header's name carries the folder as its tooltip. */
	const displayPath = home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
	// spec/projects-and-board#person-tasks: the board and the list show the person's tasks; a foreman stands for its crew, also under a status filter, as in the sidebar.
	const scoped = useMemo(
		() => workspace.tasks.filter((task) => all || task.projectId === projectId),
		[workspace, projectId]
	);
	const tasks = useMemo(
		() =>
			personTasks(scoped, quietRuns).filter(
				(task) =>
					sidebarMatches(task, statusFilter) ||
					crewWorkers(task, scoped).some((worker) => sidebarMatches(worker, statusFilter))
			),
		[scoped, statusFilter, quietRuns]
	);
	// spec/crew#attention: a foreman whose worker waits for the person carries the needs-you frame and sorts with needs-you.
	const waiting = useMemo(
		() =>
			new Set(
				tasks
					.filter((task) => task.crew && crewNeedsYou(task, scoped))
					.map((task) => `${task.projectId}/${task.id}`)
			),
		[tasks, scoped]
	);
	const sections = useMemo(
			() => boardSections(tasks, (task) => waiting.has(`${task.projectId}/${task.id}`)),
			[tasks, waiting]
		),
		colors = useMemo(
			() => projectColors(workspace.projects.map((item) => item.id)),
			[workspace.projects]
		);
	const [view, setView] = useState<ProjectView>('board'),
		[mode, setMode] = useState<ProjectMode>(defaultProjectMode),
		[reviewing, setReviewing] = useState<{ task: AgentTask; target: PRRefKey } | null>(null),
		[ready, setReady] = useState(false),
		[busy, setBusy] = useState<string[]>([]),
		[limit, setLimit] = useState<number | null>(null),
		[now, setNow] = useState(Date.now());
	const drag = useRef<AgentTask | null>(null),
		ignoreClick = useRef(0),
		[dragging, setDragging] = useState<string | null>(null),
		[over, setOver] = useState<BoardColumn | null>(null);
	const active = useRef(true),
		writes = useRef(0),
		savedView = useRef<ProjectView>('board'),
		savedMode = useRef<ProjectMode>(defaultProjectMode),
		modeWrites = useRef(0),
		pendingTab = useRef<ProjectMode['tab'] | null>(null),
		readyMode = useRef<ProjectMode | null>(null);
	// spec/projects-and-board#pr-mode: PRs of this project's main tree, or of every open project on «All projects»; off with the module (spec/settings-modules-and-onboarding#module-off).
	const prsEnabled = useWorkspace((state) => state.appearance.modules.pullRequests),
		projectIds = useMemo(
			() => (all ? workspace.projects.map((item) => item.id) : [projectId]),
			[all, projectId, workspace.projects]
		),
		prs = useBoardPRs(projectIds, prsEnabled, locale),
		// spec/sidebar#section-rail: the rail picks Tasks or Pull requests; there is no Notes tab (Notes is the rail's own section).
		tab: ProjectTab = prsEnabled ? section : 'tasks';
	// spec/projects-and-board#pr-mode (spec/pull-requests-and-ci#repo-picker): with more than one repo on GitHub the PR tab has the repo picker; the cards name their repo
	// only while the board holds more than one repo of their project.
	const githubRepos = useMemo(
			() =>
				prs.repos
					.filter((repo) => repo.repository)
					.map((repo) => ({ ...repo, scopeId: boardRepoKey(repo.projectId, repo.scopeId) })),
			[prs.repos]
		),
		pickedRepo = githubRepos.some((repo) => repo.scopeId === mode.repo)
			? (mode.repo ?? null)
			: null,
		shownPRs = useMemo(
			() =>
				pickedRepo
					? prs.items.filter((item) => boardRepoKey(item.projectId, item.scopeId) === pickedRepo)
					: prs.items,
			[prs.items, pickedRepo]
		),
		reposOf = (id: string) => githubRepos.filter((repo) => repo.projectId === id).length;
	// spec/projects-and-board#pr-mode: the tab counts what waits for a review — Open and In review, not drafts or closed ones.
	const prsToReview = useMemo(
		() =>
			prColumns(shownPRs, 'all')
				.filter(({ column }) => column === 'open' || column === 'review')
				.reduce((sum, { items }) => sum + items.length, 0),
		[shownPRs]
	);
	// spec/projects-and-board#pr-mode: in a window up to 1050 px (the board's own breakpoint) the filter and Board / List keep only their glyphs.
	const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1050px)').matches);
	useEffect(() => {
		const query = matchMedia('(max-width: 1050px)'),
			change = () => setNarrow(query.matches);
		query.addEventListener('change', change);
		return () => query.removeEventListener('change', change);
	}, []);
	/** spec/notifications-slack-notes-and-schedules#message-classes: each failure is its own toast. An unread view leaves the board in its current view; Retry reads it again. */
	const retry = (run: () => void) => ({ action: { label: t(locale, 'Retry'), run } });
	async function loadView() {
		setReady(false);
		try {
			const [views, modes, { settings }] = await Promise.all([
				window.brigadir.readProjectViews(),
				window.brigadir.readProjectModes(),
				window.brigadir.readSettings(),
			]);
			if (active.current) {
				/* spec/settings-modules-and-onboarding#settings-keys */ savedView.current =
					views[projectId] ?? settings.projects.defaultView;
				setView(savedView.current);
				savedMode.current = modes[projectId] ?? defaultProjectMode;
				const picked = pendingTab.current;
				pendingTab.current = null;
				setMode(savedMode.current);
				setReady(true);
				if (picked && picked !== savedMode.current.tab)
					readyMode.current = { ...savedMode.current, tab: picked };
				resolveToast(t(locale, 'Could not read the project view.'));
			}
		} catch {
			if (active.current) {
				setReady(true);
				toastWarning(
					t(locale, 'Could not read the project view.'),
					retry(() => {
						void loadView();
					})
				);
			}
		}
	}
	useEffect(() => {
		active.current = true;
		void loadView();
		void window.brigadir
			.readSettings()
			.then(({ settings }) => {
				if (active.current) setLimit(settings.agents.maxConcurrent);
			})
			.catch(() => {});
		const timer = setInterval(() => setNow(Date.now()), 60000);
		return () => {
			active.current = false;
			clearInterval(timer);
		};
	}, []);
	async function changeView(next: ProjectView) {
		if (!ready) return;
		const id = ++writes.current;
		setView(next);
		try {
			await window.brigadir.saveProjectView(projectId, next);
			savedView.current = next;
		} catch {
			if (active.current && id === writes.current) {
				setView(savedView.current);
				toastError(
					t(locale, 'Could not save the project view.'),
					retry(() => {
						void changeView(next);
					})
				);
			}
		}
	}
	useEffect(() => {
		const next = readyMode.current;
		readyMode.current = null;
		if (ready && next) void changeMode(next);
	}, [ready]);
	/** spec/projects-and-board#pr-mode: the tab and the PR filter persist per project beside the view; a failed write rolls back. */
	async function changeMode(next: ProjectMode) {
		// spec/projects-and-board#screen-layout: the tabs work while the view is read; the pick waits for
		// the saved mode and then wins over it.
		if (!ready) {
			pendingTab.current = next.tab;
			setMode(next);
			return;
		}
		const id = ++modeWrites.current;
		setMode(next);
		try {
			await window.brigadir.saveProjectMode(projectId, next);
			savedMode.current = next;
		} catch {
			if (active.current && id === modeWrites.current) {
				setMode(savedMode.current);
				toastError(
					t(locale, 'Could not save the project view.'),
					retry(() => {
						void changeMode(next);
					})
				);
			}
		}
	}
	// spec/sidebar#section-rail: a PR row of the sidebar opens its review over this board.
	const reviewRequest = usePRSectionReview((state) => state.seq);
	useEffect(() => {
		const item = usePRSectionReview.getState().item;
		if (item && (all || item.projectId === projectId)) review(item);
	}, [reviewRequest]);
	/** spec/projects-and-board#pr-mode: the review modal over the screen, keyed by the project's main tree. */
	function review(item: BoardPR) {
		void mainTreeTask(item.projectId).then(
			(task) => {
				if (active.current)
					setReviewing({ task, target: { scopeId: item.scopeId, number: item.pr.number } });
			},
			() => toastError(t(locale, 'Could not read the pull request.'))
		);
	}
	/**
	 * spec/projects-and-board#pr-mode: a task's PR badge clicked before the board has read GitHub — read it now and open the review over the
	 * screen; a PR GitHub does not list (another account, a deleted repo) opens in the task's own PR panel instead.
	 */
	async function reviewTaskPR(task: AgentTask, url: string) {
		const item = (await prs.refresh()).find(
			(value) => value.projectId === task.projectId && value.pr.url === url
		);
		if (item) return review(item);
		const [scopeId, ref] =
			Object.entries(task.pullRequests ?? {}).find(([, value]) => value.url === url) ?? [];
		if (scopeId && ref) openTaskPR(task, { scopeId, number: ref.number });
		useWorkspace.getState().selectTask(task.projectId, task.id);
	}
	/** spec/projects-and-board#pr-mode: Draft → Open — «Ready for review», then GitHub is read again. */
	async function markReady(item: BoardPR) {
		try {
			await window.brigadir.readyPullRequest(await mainTreeTask(item.projectId), {
				scopeId: item.scopeId,
				number: item.pr.number,
			});
			await prs.refresh(true);
		} catch {
			toastError(
				t(locale, 'Could not mark the PR ready for review.'),
				retry(() => {
					void markReady(item);
				})
			);
		}
	}
	async function action(
		id: string,
		operation: () => Promise<unknown>,
		failure: MessageKey,
		repeat = true
	) {
		if (busy.includes(id)) return;
		const focused = document.activeElement;
		setBusy((items) => [...items, id]);
		try {
			await operation();
			await useWorkspace.getState().load();
			requestAnimationFrame(() => {
				if (active.current && focused instanceof HTMLElement && !focused.isConnected)
					(
						document.querySelector<HTMLElement>(`[data-board-task="${id}"]`) ??
						document.querySelector<HTMLElement>(
							'[data-project-screen] [data-board-task], [data-project-screen] button'
						)
					)?.focus({ preventScroll: true });
			});
		} catch {
			if (active.current)
				toastError(
					t(locale, failure),
					repeat
						? retry(() => {
								void action(id, operation, failure, repeat);
							})
						: {}
				);
		} finally {
			if (active.current) setBusy((items) => items.filter((item) => item !== id));
		}
	}
	function finishDrag() {
		drag.current = null;
		ignoreClick.current = performance.now() + 300;
		setDragging(null);
		setOver(null);
	}
	// The concurrency limit counts every agent, crew workers included (spec/tasks#launch-sheet), so the header does too.
	const working = scoped.filter(
		(task) => task.status === 'working' || task.status === 'needs-you'
	).length;
	return (
		<section
			className={s.screen}
			data-project-screen={projectId}
			data-project-tab={tab}
			aria-label={all ? t(locale, 'All projects') : project?.name}>
			<ProjectTitlebar
				title={all ? t(locale, 'All projects') : project?.name}
				hint={all ? undefined : displayPath}>
				{/* spec/projects-and-board#screen-layout: the project's code without a task — Files, the editor and Git of the main tree. */}
				{!all && (
					<IconButton
						label={t(locale, 'Open main tree')}
						data-open-main-tree
						onClick={() =>
							void useWorkspace
								.getState()
								.openMainTree(projectId, null)
								.catch(() => toastError(t(locale, 'Could not open the main tree.')))
						}>
						<Glyph name="editor" size={15} />
					</IconButton>
				)}
				<AgentsButton />
				<IconButton label={t(locale, 'Search Everywhere')} onClick={search}>
					<Glyph name="search" size={15} />
				</IconButton>
			</ProjectTitlebar>
			{/* spec/sidebar#section-rail: the rail picks Tasks or Pull requests; the row names the section with its count in place of the tabs
			    (spec/projects-and-board#pr-mode), the rest of the row stays — in Pull requests the filter takes the place of knowledge and archive. */}
			<ProjectToolbar
				tabs={
					<h2 className={s.sectionTitle} data-project-section={tab}>
						<Glyph name={tab === 'prs' ? 'pr-branch' : 'base-task'} size={13} />
						{t(locale, tab === 'prs' ? 'Pull requests (section)' : 'Tasks (section)')}
						<span className={s.sectionCount}>
							{tab === 'prs' ? (prs.loaded ? String(prsToReview) : '') : String(tasks.length)}
						</span>
					</h2>
				}>
				{tab === 'prs' ? (
					<>
						{githubRepos.length > 1 && (
							<RepoPicker
								className={s.repoPicker}
								locale={locale}
								projectName={project?.name ?? ''}
								repos={githubRepos}
								value={pickedRepo}
								all
								label={(repo) => {
									const owner =
										workspace.projects.find((item) => item.id === (repo as BoardRepo).projectId)
											?.name ?? '';
									// The root repo is the project itself: «business», not «business · business».
									return all && repo.name !== '.'
										? `${owner} · ${repo.name}`
										: repoName(repo, owner);
								}}
								onChange={(repo) => {
									void changeMode({ ...mode, repo });
								}}
							/>
						)}
						<Segments
							label={t(locale, 'PR filter')}
							value={mode.filter}
							iconOnly={narrow}
							options={[
								{
									value: 'all',
									label: t(locale, 'All (PRs)'),
									icon: <Glyph name="pr-branch" size={13} />,
								},
								{
									value: 'mine',
									label: t(locale, 'Yours'),
									icon: <Glyph name="person" size={13} />,
								},
								{
									value: 'waiting',
									label: t(locale, 'Waiting for you'),
									icon: <Glyph name="review" size={13} />,
									tail: String(waitingCount(shownPRs.map((item) => item.pr)) || ''),
								},
							]}
							onChange={(value) => {
								void changeMode({ ...mode, filter: value as PRFilter });
							}}
						/>
					</>
				) : (
					<>
						{!all && knowledgeCount > 0 && (
							<Button
								aria-label={t(locale, 'Project knowledge')}
								onClick={() => setKnowledgeExpand((value) => value + 1)}
								onContextMenu={(event) => {
									event.preventDefault();
									knowledgeMenu();
								}}
								onKeyDown={(event) => {
									if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
										event.preventDefault();
										knowledgeMenu();
									}
								}}>
								<Glyph name="knowledge" size={13} />
								{knowledgeCount}
							</Button>
						)}
						<ArchiveScreenButton count={archived} locale={locale} onClick={openArchive} />
					</>
				)}
				{/* spec/projects-and-board#screen-layout: while the view is read, Board / List are off. */}
				{
					<Segments
						label={t(locale, 'Project view')}
						value={view}
						iconOnly={narrow}
						disabled={!ready}
						options={[
							{ value: 'board', label: t(locale, 'Board'), icon: <Glyph name="board" size={13} /> },
							{ value: 'list', label: t(locale, 'List'), icon: <Glyph name="list" size={13} /> },
						]}
						onChange={(value) => {
							void changeView(value as ProjectView);
						}}
					/>
				}
				{/* spec/pull-requests-and-ci#project-pr-section: in Pull requests the board's action is a new PR (spec/pull-requests-and-ci#from-into), on every board and «All projects». */}
				{tab === 'prs' ? (
					<NewPRButton
						locale={locale}
						repos={prs.repos.filter((repo) => repo.repository)}
						projects={workspace.projects}
					/>
				) : (
					!all &&
					(tasks.length > 0 || !!statusFilter) && (
						<Button appearance="primary" onClick={() => newTask(false)}>
							<Glyph name="plus" size={13} />
							{t(locale, 'New task')}
							{newTaskKey && <kbd aria-hidden="true">{newTaskKey}</kbd>}
						</Button>
					)
				)}
			</ProjectToolbar>
			{!all && tab === 'tasks' && (
				<KnowledgePanel
					projectId={projectId}
					projectName={project?.name ?? projectId}
					locale={locale}
					tasks={workspace.tasks.filter((task) => task.projectId === projectId)}
					expandRequest={knowledgeExpand}
					onCount={setKnowledgeCount}
				/>
			)}
			{/* spec/appearance#loading: while the view or the PRs are read, the board's columns with skeleton cards, after 150 ms. */}
			{!ready || (tab === 'prs' && !prs.loaded) ? (
				<SkeletonBoard
					key={tab}
					className={s.skeleton}
					view={view}
					label={t(locale, tab === 'prs' ? 'Pull requests (section)' : 'Tasks (section)')}
					columns={
						tab === 'prs'
							? prColumnOrder.map((column) => t(locale, prColumnLabels[column]))
							: boardColumns.map((column) => t(locale, labels[column]))
					}
				/>
			) : tab === 'prs' ? (
				prs.auth !== 'ready' ? (
					<div className={s.empty} data-pr-auth={prs.auth}>
						<Glyph name="github" size={44} />
						<h1>
							{t(
								locale,
								prs.auth === 'missing'
									? 'Install GitHub CLI (gh) to create pull requests.'
									: prs.auth === 'login'
										? 'Sign in with gh auth login to use GitHub.'
										: 'GitHub status could not be read.'
							)}
						</h1>
						<div>
							<Button onClick={() => void prs.refresh(true)}>{t(locale, 'Retry')}</Button>
						</div>
					</div>
				) : !prs.items.length ? (
					<div className={s.empty}>
						<Glyph name="pr-branch" size={44} />
						<h1>{t(locale, 'No pull requests')}</h1>
						<p>{t(locale, 'Nothing open, nothing closed in the last 7 days.')}</p>
					</div>
				) : (
					<PRBoard
						items={shownPRs}
						filter={mode.filter}
						view={view}
						locale={locale}
						all={all}
						workspace={workspace}
						colors={colors}
						now={now}
						review={review}
						ready={markReady}
						repoShown={(item) => !pickedRepo && reposOf(item.projectId) > 1}
					/>
				)
			) : !tasks.length ? (
				<div className={s.empty}>
					<Glyph name="chat" size={44} />
					<h1>{t(locale, statusFilter ? 'No matches' : 'No tasks yet')}</h1>
					{!all && !statusFilter && (
						<div>
							<Button appearance="primary" onClick={() => newTask(false)}>
								{t(locale, 'New task')}
							</Button>
							{newTaskKey && <kbd>{newTaskKey}</kbd>}
						</div>
					)}
				</div>
			) : (
				<BoardColumns view={view} key={view}>
					{boardColumns.map((column) => (
						<BoardColumnView
							key={column}
							column={column}
							label={t(locale, labels[column])}
							count={sections[column].length}
							hint={t(locale, hints[column])}
							data-drop={over === column}
							onDragOver={(event) => {
								const source = drag.current;
								if (source && boardMove(boardColumn(source.status), column) && !busy.length) {
									event.preventDefault();
									event.dataTransfer.dropEffect = 'move';
									setOver(column);
								} else {
									event.dataTransfer.dropEffect = 'none';
									setOver(null);
								}
							}}
							onDragLeave={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget as Node | null))
									setOver(null);
							}}
							onDrop={(event) => {
								event.preventDefault();
								const source = drag.current;
								finishDrag();
								if (source && boardMove(boardColumn(source.status), column) && !busy.length)
									void action(
										source.id,
										() => window.brigadir.moveTask(source, column),
										'Could not move the task.'
									);
							}}
							extra={
								column === 'progress' &&
								limit !== null && (
									<BoardLimit title={t(locale, 'Max concurrent')}>
										{working} / {limit}
									</BoardLimit>
								)
							}
							action={
								column === 'completed'
									? sections.completed.length > 0 && (
											<IconButton
												size="s"
												disabled={busy.length > 0}
												label={t(locale, 'Archive the list')}
												data-archive-completed
												onClick={() => {
													void action(
														'archive',
														() => window.brigadir.archiveCompletedTasks(all ? null : projectId),
														'Could not archive the list.'
													);
												}}>
												<Glyph name="archive-box" size={13} />
											</IconButton>
										)
									: !all && (
											<IconButton
												size="s"
												label={t(locale, column === 'backlog' ? 'New task in backlog' : 'New task')}
												hint={t(locale, 'New task')}
												onClick={() => newTask(column === 'backlog')}>
												<Glyph name="plus" size={13} />
											</IconButton>
										)
							}>
							{sections[column].map((task) => {
								const live = task.crew ? liveCrewWorkers(task, scoped) : 0;
								const projectName =
									workspace.projects.find((item) => item.id === task.projectId)?.name ?? '';
								const catalog = task.agentOptions?.length
									? task.agentOptions
									: (workspace.tasks.find(
											(item) =>
												item.provider === task.provider &&
												item.transport !== 'terminal' &&
												item.agentOptions?.length
										)?.agentOptions ?? []);
								const selectable = (kind: 'model' | 'effort') =>
									!['working', 'needs-you'].includes(task.status) &&
									task.transport !== 'terminal' &&
									(task.status === 'backlog' ? catalog : (task.agentOptions ?? [])).some(
										(option) =>
											agentOptionKind(option) === kind &&
											option.kind === 'select' &&
											option.choices.length > 0
									);
								const open = () => {
									if (
										drag.current ||
										performance.now() < ignoreClick.current ||
										busy.includes(task.id)
									)
										return;
									if (task.status === 'backlog' && !task.hasStarted) editTask(task);
									else useWorkspace.getState().selectTask(task.projectId, task.id);
								};
								return (
									<BoardCard
										key={`${task.projectId}/${task.id}`}
										task={task}
										locale={locale}
										all={all}
										project={
											workspace.projects.find((item) => item.id === task.projectId) ?? {
												name: projectName,
											}
										}
										slot={colors.get(task.projectId) ?? 0}
										now={now}
										live={live}
										selectable={selectable}
										busy={busy.includes(task.id)}
										data-crew-attention={
											waiting.has(`${task.projectId}/${task.id}`) ? 'needs-you' : undefined
										}
										data-dragging={dragging === task.id}
										aria-label={task.title}
										aria-busy={busy.includes(task.id)}
										tabIndex={0}
										draggable={!busy.length}
										onDragStart={(event) => {
											if ((event.target as HTMLElement).closest('button')) {
												event.preventDefault();
												return;
											}
											drag.current = task;
											ignoreClick.current = Number.POSITIVE_INFINITY;
											event.dataTransfer.effectAllowed = 'move';
											event.dataTransfer.setData(
												'application/x-brigadir-task',
												JSON.stringify({ id: task.id, projectId: task.projectId })
											);
											setDragging(task.id);
										}}
										onDragEnd={finishDrag}
										onClick={open}
										onContextMenu={(event) => {
											event.preventDefault();
											taskMenu(task);
										}}
										onKeyDown={(event) => {
											if (event.target !== event.currentTarget) return;
											if (event.key === 'Enter' || event.key === ' ') {
												event.preventDefault();
												open();
											}
											if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
												event.preventDefault();
												taskMenu(task);
											}
										}}
										onOption={(kind) => {
											void action(
												task.id,
												() => window.brigadir.taskOptionMenu(task, kind),
												'Could not open the menu.',
												false
											);
										}}
										actions={
											<>
												{task.status === 'backlog' && !task.hasStarted && (
													<IconButton
														size="s"
														className={s.cardAction}
														label={t(locale, 'Edit task')}
														onClick={(event) => {
															event.stopPropagation();
															editTask(task);
														}}>
														<Glyph name="board-edit" size={13} />
													</IconButton>
												)}
												{task.status === 'completed' && canArchive(task, workspace.tasks) && (
													<IconButton
														size="s"
														className={s.cardAction}
														label={t(locale, 'Archive')}
														data-archive-card
														disabled={busy.includes(task.id)}
														onClick={(event) => {
															event.stopPropagation();
															void action(
																task.id,
																() => archiveTask(task),
																'Could not archive the task.'
															);
														}}>
														<Glyph name="archive-box" size={12} />
													</IconButton>
												)}
											</>
										}
										badges={
											/* spec/projects-and-board#pr-mode: the task's open PR — a click opens its review over the screen. */
											<TaskPRBadges
												task={task}
												items={prs.items}
												locale={locale}
												review={review}
												missing={(owner, url) => void reviewTaskPR(owner, url)}
											/>
										}
										after={
											<RelayLinks
												task={task}
												locale={locale}
												open={(item) => {
													if (item.status === 'backlog' && !item.hasStarted) editTask(item);
													else useWorkspace.getState().selectTask(item.projectId, item.id);
												}}
											/>
										}
									/>
								);
							})}
						</BoardColumnView>
					))}
				</BoardColumns>
			)}
			{reviewing && (
				<ProjectReview
					key={`${reviewing.task.projectId}/${reviewing.target.scopeId}/${reviewing.target.number}`}
					task={reviewing.task}
					target={reviewing.target}
					projectName={
						workspace.projects.find((item) => item.id === reviewing.task.projectId)?.name ?? ''
					}
					locale={locale}
					quickTask={quickTask}
					closed={() => {
						setReviewing(null);
						clearPRReview();
						void prs.refresh();
					}}
				/>
			)}
		</section>
	);
}
