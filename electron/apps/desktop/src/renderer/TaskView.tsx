import { AgentsButton, useAgentsEntry } from './LiveAgents';
import { registerTaskView } from './context-sources';
import { ToolbarMore, type MoreEntry } from './ToolbarMore';
import {
	defaultToolbarWidths,
	fitToolbar,
	narrower,
	toolbarSteps,
	type CommandsSize,
	type OverflowKey,
	type ToolbarWidths,
} from './toolbar-overflow';
import { CommandsButton } from './ProjectCommands';
import { onSessionEvent } from './session-events';
import { ScopeForgeActions, requestForgeAction, useForge } from './Forge';
import { CommitStrip } from './CommitStrip';
import { CommitDialog } from './CommitDialog';
import { ConflictsDialog } from './ConflictsDialog';
import { ConflictsBanner } from './ConflictsBanner';
import { TaskProposalCard } from './TaskProposal';
import { TaskLinksChip } from './RelayLinks';
import { useScopeLocks } from './use-scope-locks';
import { ContentionChip } from './ContentionChip';
import { ReadOnlyChip, UnavailableChip } from './TaskNotices';
import { Preparation } from './Preparation';
import { useWorkspace } from './store';
import {
	AddFolderRow,
	PanelRepoRoot,
	RepoLock,
	ReposProvider,
	TaskRepoLine,
	useReposState,
	type RepoScope,
} from './Repos';
import { ReviewDeleteDialog } from './ui/ReviewDeleteDialog';
import { DiffOptions } from './ui/DiffOptions';
import { TextInput } from './ui/Input';
import { useTabStrip } from './ui/use-tab-strip';
import { ResizeHandle } from './ui/ResizeHandle';
import { useSurfaceLayout } from './surface-layout';
import { panelShortcut, type PanelTab } from './panel-visibility';
import { LayoutSwitch } from './LayoutSwitch';
import { ToolsButton, ToolsMenu, toolGlyph, toolTabName, useAgentOnTools } from './ToolsMenu';
import { tabStripStyles } from './ui/TabStrip';
import { FileIcon } from './ui/FileIcon';
import {
	agentMark,
	agentStepText,
	freshBrowserTabs,
	useTaskBrowserTabs,
	watchBrowserTabs,
} from './browser-tabs';
import { useSecondTick } from './ui/second-tick';
import { TurnsPanel } from './TurnsPanel';
import { PullRequestPanel, openReviewTask } from './PullRequestPanel';
import type { ReviewChoice } from './ReviewLaunch';
import { QuickTaskBar, type QuickTaskRequest } from './QuickTask';
import { ToastHost, showToast, notify, toastError, toastWarning, resolveToast } from './ui/Toast';
import { restartLanguageServers } from './code-intel';
import { PopupClose } from './ui/PopupClose';
import { PanelSearch, SearchToggle } from './ui/PanelSearch';
import { CliAttachments } from './ui/AttachmentChips';
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from 'react';
import {
	type TaskProposal,
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	menuCommands,
	idleStopped,
	headerLabelsMinimumWidth,
	headerLabelsTitleMinimum,
	reviewFiles,
	commentCount,
	handedCount,
	fileCount,
	closeDocument,
	selectDocument,
	documentForDiff,
	documentsToClose,
	documentTabTails,
	type DocumentTab,
	type DocumentTabMenuAction,
	validAnswer,
	pendingInputs,
	t,
	type EventRecord,
	type SessionCommand,
	type TimelineEntry,
	type AgentTask,
	type ChangesSnapshot,
	type FileDiff,
	type Locale,
	type ReviewSnapshot,
	type Scope,
	type ChangedFile,
	type PullRequestDetail,
	type PRThread,
	type CIRunDetail,
	type CIJob,
	type CIStep,
	defaultSurfaceLayout,
	documentForBrowser,
	documentForSimulator,
	documentForTerminal,
	isToolTab,
	newFileFolder,
	opensToolsInstead,
	showsEmptyPlace,
	toggleColumn,
	workAreaTabs,
	chatGroup,
	chatTabState,
	chatUnreadAfter,
	twoColumnsLayout,
	twoColumnsShortcut,
	type TaskColumns,
	type EditorDocument,
	type LayoutColumn,
	type TerminalInfo,
	type ToolTabKind,
	type HelperRun,
} from '@brigadir/core';
import {
	useTaskState,
	parkedTaskState,
	attachTaskContext,
	rowPosition,
	openTaskEditor,
	withBuffer,
	openTaskPR,
	openConflictsDialog,
	withMarkdownView,
	groupsNow,
	applyGroups,
	layoutOf,
	lastToolTab,
	newBrowserTab,
	showTaskTool,
	openTaskFileTab,
	type MarkdownView,
} from './task-state';
import { NewFilePopover } from './NewFile';
import { EmptyPlace, type EmptyPlaceAction } from './EmptyPlace';
import {
	ColumnDropTarget,
	GroupDropTarget,
	GroupTree,
	PassiveDiff,
	PassiveEditor,
	draggedTab,
	endTabDrag,
	startTabDrag,
} from './EditorGroups';
import groupStyles from './EditorGroups.module.css';
import { bufferPlace, conflictMarked, restoreBuffer, type EvictedEditor } from './editor-buffers';
import { closedTabsKey, rememberClosedTab, takeClosed, useClosedTabs } from './closed-tabs-store';
import {
	forgetCommitDiff,
	keepCommitDiff,
	readCommitDiff,
	type CommitDiffSource,
} from './commit-diffs';
import { PRDiffView, PRFileOpening, type PRCrumb, type PROpening } from './PRDiffView';
import { closeReview, readReview, readDetail, useReviewOpen } from './pr-review';
import { PROverview } from './PROverview';
import { PRReviewModal } from './PRReviewModal';
import { deliverPrompt, prFixQuickTask } from './pr-agent';
import { mergeRecords, readSessionState, sessionReads } from './session-read';
import { BrowserPanel } from './BrowserPanel';
watchBrowserTabs();
import { SimulatorPanel } from './SimulatorPanel';
import { CodeEditor } from './CodeEditor';
import type { EditorModel } from './editor-model';
import { FileTree } from './FileTree';
import editorStyles from './CodeEditor.module.css';
import { Conversation } from './Conversation';
import { DiffView } from './DiffView';
import { ReviewList } from './ReviewList';
import { GitHistory, ChangesViewSwitch } from './GitHistory';
import { DiffBaseChip } from './ui/DiffBaseChip';
import { QuestionText } from './QuestionText';
import { useHeaderMinimum } from './header-minimum';
import { Rows } from './ui/Rows';
import { Question, PermissionCard } from './ui/SessionInputs';
import { PlanApprovalNotice } from './PlanApproval';
import { SkeletonText } from './ui/Loading';
import {
	isPlanApproval,
	planApprovalText,
	isMarkdownPath,
	isMessageKey,
	type MessageKey,
} from '@brigadir/core';
import {
	allGroupTabs,
	bottomGroup,
	groupOf,
	nextClosedTab,
	reopenTab,
	documentTabSplitActions,
	pruneGroups,
	renameTab,
	replaceTab,
	revealTab,
	toolTabs,
	dropTab,
	focusGroup,
	groupCount,
	moveToNextGroup,
	openElsewhere,
	resizeSplit,
	splitGroup,
	stepGroup,
	unsplitAll,
	unsplitGroup,
	withFocusedTabs,
	type EditorGroup,
	type EditorGroups,
} from '@brigadir/core';
import { ReviewFooter } from './ui/ReviewControls';
import { Glyph } from './ui/Glyph';
import { SurfaceBoundary } from './ui/ErrorBoundary';
import { Button, Chevron, IconButton, Segments } from './ui/Controls';
import styles from './TaskView.module.css';
import { ChangeCounts } from './ui/ChangeCounts';
import { chatCeiling, chatMinimum } from './chat-width';
const TerminalPanel = lazy(() => import('./TerminalPanel'));
/** spec/task-window-workspace#work-area: Tools («+ ▾») at the end of a group's strip; a new tool opens in this group. */
function StripTools({
	group,
	locale,
	hint,
	menu,
	onNew,
}: {
	group: string;
	locale: Locale;
	hint: string;
	menu: Omit<Parameters<typeof ToolsMenu>[0], 'open' | 'anchor' | 'onClose' | 'locale'>;
	onNew(kind: ToolTabKind): void;
}) {
	const [open, setOpen] = useState(false),
		button = useRef<HTMLButtonElement>(null);
	return (
		<>
			<IconButton
				ref={button}
				shape="auto"
				className={tabStripStyles.add}
				data-strip-tools={group}
				label={t(locale, 'Task tools')}
				hint={hint}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}>
				{/* «+ ▾»: a 13 px plus in the row's M (the strip's data-size). */}
				<span className={tabStripStyles.addGlyph}>
					<Glyph name="plus" size={13} />
				</span>
				<Chevron />
			</IconButton>
			<ToolsMenu
				{...menu}
				locale={locale}
				open={open}
				anchor={button}
				onClose={() => setOpen(false)}
				onNew={onNew}
			/>
		</>
	);
}
/** spec/search-menus-and-commands#project-commands: the older width rule for Commands — only the state and the menu beside labels near their threshold. */
const commandsRule = (labels: boolean, width: number): CommandsSize =>
	labels && width < headerLabelsMinimumWidth + 160 ? 'minimal' : width < 620 ? 'compact' : 'full';
/** spec/tasks#quick-tasks: `mainTree` — the repo's main tree: the same task view without a chat, changes since the last commit, «To agent» makes a quick task. */
export function TaskView({
	task,
	locale,
	projectName,
	onSearch,
	onRelay,
	onProposal,
	onOpenTask,
	onEditorSettings,
	mainTree = null,
	onQuickTask,
}: {
	task: AgentTask;
	locale: Locale;
	projectName: string;
	onSearch(): void;
	onRelay(): void;
	/** spec/tasks#agent-created-tasks: `Open in the sheet…` on a proposed task. */ onProposal(
		proposal: TaskProposal
	): void;
	onOpenTask(task: AgentTask): void;
	onEditorSettings(): void;
	mainTree?: { task: AgentTask; scopeId: string | null } | null;
	onQuickTask?(request: Omit<QuickTaskRequest, 'projectId'>): void;
}) {
	const { locks, error: locksError } = useScopeLocks(task);
	const prReviewOpen = useReviewOpen(task);
	// spec/notifications-slack-notes-and-schedules#notice-chips: the class S chips of the task view — read-only changes from the log, unavailable repos from the snapshot.
	const contended = useMemo(
		() =>
			locks.filter(
				(scope) =>
					scope.contended &&
					scope.owners.some(
						(owner) => owner.key.projectId === task.projectId && owner.key.id === task.id
					)
			),
		[locks, task.projectId, task.id]
	);
	// spec/notifications-slack-notes-and-schedules#notice-chips: the other tasks holding each repo, for the lock of an old repo heading (no repo read behind it).
	const heldByOthers = useMemo(
		() =>
			new Map(
				locks.map((scope) => [
					scope.path,
					scope.owners.filter(
						(owner) => owner.key.projectId !== task.projectId || owner.key.id !== task.id
					),
				])
			),
		[locks, task.projectId, task.id]
	);
	const { layout, resize, save: saveLayout, error: layoutError } = useSurfaceLayout();
	// spec/notifications-slack-notes-and-schedules#message-classes: background reads retry by themselves; the toast shows once per failure streak (the same key folds into ×N).
	useEffect(() => {
		if (locksError) toastWarning(t(locale, 'Repo locks could not be read.'));
		else resolveToast(t(locale, 'Repo locks could not be read.'));
	}, [locksError]);
	// A task view's background reads stop with it; their warnings go with them.
	useEffect(
		() => () => {
			for (const key of [
				'Repo locks could not be read.',
				'Could not read the task changes.',
				'Could not read the review comments.',
			] as const)
				resolveToast(t(locale, key));
		},
		[]
	);
	useEffect(() => {
		if (layoutError) toastWarning(t(locale, 'The layout could not be saved or restored.'));
		else resolveToast(t(locale, 'The layout could not be saved or restored.'));
	}, [layoutError]);
	const [
		{
			prCrumb,
			changesView,
			changesSearch,
			changesFolded,
			commitDiffs,
			scopeTarget,
			documents,
			activeDocument,
			editorGroups,
			reviewOpen,
			positions,
			answers,
			changeRange,
			chatShown,
			workShown,
			panelShown,
			chatTab,
			chatUnread,
			toolPlace,
			bottomUnderChat,
			generalDraft,
			reviewCompact,
			surface,
			selected,
			filter,
			commentDraft,
			editorDraft,
			editorTabs,
			activeEditor,
			evictedEditors,
			panel: storedPanel,
			mode,
			diffPreview,
			widths: taskWidths,
			terminalRestored,
			commitDialog,
			conflictsDialog,
		},
		setTask,
	] = useTaskState(task);
	// spec/task-window-workspace#restore-window: the task's own column widths over the defaults of surface-layout.json; a drag sets both.
	type TaskWidth = 'chatWidth' | 'changesWidth' | 'consoleHeight';
	const columnWidth = (key: TaskWidth) => taskWidths[key] ?? layout[key];
	const resizeTask = (key: TaskWidth, value: number) => {
		resize(key, value);
		const next = useSurfaceLayout.getState().layout[key];
		setTask((state) =>
			state.widths[key] === next ? state : { widths: { ...state.widths, [key]: next } }
		);
	};
	// spec/editor#editor-groups: the groups with the focused one up to date; the toolbar counts the tabs of every group.
	const groups = withFocusedTabs(editorGroups, { documents, activeDocument }),
		openTabs = allGroupTabs(groups),
		groupTotal = groupCount(groups);
	// spec/task-window-workspace#two-columns: two columns — no chat column; the chat is the pinned first tab of the work area's first group, which is always
	// on screen. The main tree has no chat, so the choice leaves it as it is.
	const taskColumns: TaskColumns = useWorkspace((state) => state.appearance.taskColumns) ?? 'three';
	const two = !mainTree && taskColumns === 'two';
	const chatHome = two ? chatGroup(groups) : null;
	// The chat's group shows the chat while its tab is chosen, and always while the group has no tab of its own.
	const chatInTab = !!chatHome && (chatTab || !chatHome.activeDocument);
	// spec/task-window-workspace#empty-work-area: the tabs of the work area itself — the group under the chat is the chat's; none, and the work area is hidden.
	// spec/task-window-workspace#two-columns: two columns have no group under the chat.
	const workTabs = workAreaTabs(groups, !two && !mainTree && chatShown && bottomUnderChat);
	const toolbar = useRef<HTMLElement>(null),
		[wideToolbar, setWideToolbar] = useState(false),
		[toolbarWidth, setToolbarWidth] = useState(0);
	const view = useRef<HTMLElement>(null);
	const toolbarLabels = useWorkspace((state) => state.appearance.toolbarLabels);
	const reposProject = useWorkspace((state) =>
		state.workspace?.projects.find((item) => item.id === task.projectId)
	);
	const reposState = useReposState(
			reposProject,
			task,
			Boolean(mainTree),
			locale,
			mainTree?.scopeId ?? null
		),
		repos = reposState.repos;
	const modules = useWorkspace((state) => state.appearance.modules);
	// spec/settings-modules-and-onboarding#module-off: with pull requests off a stored `prs` panel shows Changes and comes back with the module, like the browser column.
	const panel = storedPanel === 'prs' && !modules.pullRequests ? 'changes' : storedPanel;
	// spec/diff-and-review#diff-base: switching the base re-reads the changes and the open diff.
	const settingsBase = useWorkspace((state) => state.appearance.diffBase),
		diffBase = mainTree ? ('head' as const) : settingsBase;
	// spec/task-window#narrow-toolbar: which buttons fit is decided from their measured widths; a button that left keeps its last measure.
	const agentsEntry = useAgentsEntry();
	// spec/task-window-workspace#work-area: only Commands and Agents may leave for «…»; Search, Tools and Layout always stay.
	const toolbarPresent: OverflowKey[] = [
		...(modules.commands ? ['commands' as const] : []),
		...(agentsEntry ? ['agents' as const] : []),
	];
	const toolbarKey = toolbarPresent.join(',');
	const toolbarWidths = useRef<ToolbarWidths>({
		...defaultToolbarWidths,
		items: { ...defaultToolbarWidths.items },
		commands: { ...defaultToolbarWidths.commands! },
	});
	const [toolbarFit, setToolbarFit] = useState(() => ({
		step: toolbarSteps(toolbarPresent)[0]!,
		floor: 0,
		key: '',
	}));
	const measureToolbar = useRef(() => {});
	measureToolbar.current = () => {
		const node = toolbar.current;
		if (!node) return;
		const width = node.getBoundingClientRect().width;
		setWideToolbar(width >= headerLabelsMinimumWidth);
		setToolbarWidth(Math.round(width));
		const widths = toolbarWidths.current,
			style = getComputedStyle(node),
			title = node.firstElementChild as HTMLElement;
		widths.padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
		widths.gap = parseFloat(style.columnGap) || widths.gap;
		widths.title = parseFloat(getComputedStyle(title).minWidth) || widths.title;
		for (const item of node.querySelectorAll<HTMLElement>('[data-toolbar-item=agents]'))
			widths.items.agents = item.getBoundingClientRect().width;
		const commands = node.querySelector<HTMLElement>('[data-quick-commands]');
		widths.commands = modules.commands
			? { ...defaultToolbarWidths.commands!, ...widths.commands }
			: null;
		if (commands && widths.commands)
			widths.commands[commands.dataset.fit as CommandsSize] =
				commands.getBoundingClientRect().width;
		const more = node.querySelector<HTMLElement>('[data-toolbar-more]'),
			fixed = node.querySelector<HTMLElement>('[data-toolbar-fixed]');
		if (more) widths.more = more.getBoundingClientRect().width;
		if (fixed) widths.fixed = fixed.getBoundingClientRect().width;
		// spec/task-window#narrow-toolbar: with labels the title keeps its readable 180 (spec/sidebar#layout), so buttons leave for «…» before it drops under;
		// Commands count at the size the older width rule draws them (spec/search-menus-and-commands#project-commands).
		const labels = toolbarLabels === 'labels' && width >= headerLabelsMinimumWidth;
		const fit = fitToolbar(node.clientWidth, toolbarPresent, widths, {
				title: labels ? Math.max(widths.title, headerLabelsTitleMinimum) : widths.title,
				commands: commandsRule(labels, Math.round(width)),
			}),
			key = `${toolbarKey}:${fit.step.commands}:${fit.step.out.join(',')}:${fit.floor}`;
		setToolbarFit((current) => (current.key === key ? current : { ...fit, key }));
	};
	useLayoutEffect(() => {
		const node = toolbar.current!;
		const measure = () => measureToolbar.current();
		// The toolbar's buttons change size without the toolbar resizing (labels, the Commands name, the agents count).
		const observer = new ResizeObserver(measure),
			watch = () => {
				observer.disconnect();
				observer.observe(node);
				for (const child of node.querySelectorAll(':scope > *, :scope > [data-toolbar-item] > *'))
					observer.observe(child);
			};
		watch();
		const children = new MutationObserver(() => {
			watch();
			measure();
		});
		children.observe(node, { childList: true });
		return () => {
			observer.disconnect();
			children.disconnect();
		};
	}, []);
	useLayoutEffect(() => measureToolbar.current(), [toolbarKey, toolbarLabels]);
	// spec/task-window-workspace#layout-switch: the three Layout switches; all may go. The main tree has no chat; its work area stays without a
	// tab and shows its empty state there (spec/task-window-workspace#empty-work-area).
	// spec/task-window-workspace#two-columns: two columns show the work area always and no chat column; the task keeps its three switches for three columns.
	const threeColumns = !mainTree;
	const storedLayout = {
		chat: !mainTree && chatShown,
		work: workShown,
		panel: panelShown,
	};
	const layoutNow = two ? twoColumnsLayout(storedLayout) : storedLayout;
	const panelOpen = layoutNow.panel;
	/** The choice now, for handlers registered once (the menu bar's actions). */
	const twoNow = () =>
		!mainTree && (useWorkspace.getState().appearance.taskColumns ?? 'three') === 'two';
	/** spec/task-window-workspace#two-columns: `Layout ▾` sets the app's choice; Settings and View ▸ Layout show the same. */
	const setTaskColumns = (value: TaskColumns) => {
		void window.brigadir
			.readSettings()
			.then((snapshot) =>
				window.brigadir.saveSettings({ ...snapshot.settings, taskColumns: value })
			)
			.catch(() => fail('The settings could not be saved.'));
	};
	const keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap;
	const shortcutHint = (label: string, id: string) => {
		const command = menuCommands.find((item) => item.id === id),
			key = command && commandAccelerator(command, keymap);
		return key ? `${label} · ${formatAccelerator(key)}` : label;
	};
	/** A column that hides with the focus in it hands the focus to its switch, so Space brings it back. */
	const focusSwitch = (column: LayoutColumn) =>
		requestAnimationFrame(() =>
			toolbar.current
				// spec/task-window-workspace#two-columns: two columns have one Layout button.
				?.querySelector<HTMLButtonElement>(`[data-switch="${twoNow() ? 'layout' : column}"]`)
				?.focus()
		);
	const columnNode = (column: LayoutColumn) =>
		column === 'chat'
			? view.current?.querySelector('[data-task-chat]')
			: column === 'work'
				? view.current?.querySelector('[data-task-documents]')
				: changesPanel.current;
	/** spec/task-window-workspace#empty-work-area, spec/editor#new-file: Tools opened by the view — the work area turned on with no tab, ⇧⌘I. */
	const [toolsOpen, setToolsOpen] = useState(false);
	/** The toolbar's Tools button: where Tools and New file open when no other button asked. */
	const toolsAnchor = useRef<HTMLElement | null>(null);
	const toolbarTools = () => {
		toolsAnchor.current =
			toolbar.current?.querySelector<HTMLElement>('[data-tools-button]') ?? null;
		return toolsAnchor;
	};
	/** spec/task-window-workspace#layout-switch: a switch, ⌘1–⌘3 or the ▾ menu. Each flips its column; none stays on by force. */
	const toggleLayout = (column: LayoutColumn) => {
		if (mainTree && column === 'chat') return;
		const current = parkedTaskState(task);
		if (!current) return;
		// spec/task-window-workspace#two-columns: two columns — ⌘1 shows the Chat tab (again does not hide it), ⌘2 the file its group showed last (or
		// Tools with no tab at all), ⌘3 flips the panel as in three columns.
		if (twoNow() && column !== 'panel') {
			const groupsThen = groupsNow(current),
				home = chatGroup(groupsThen);
			const step = twoColumnsShortcut(column, {
				groupFile: !!home.activeDocument,
				workTabs: allGroupTabs(groupsThen).length,
			});
			if (step === 'chat') setTask({ chatTab: true, focusComposer: true });
			else if (step === 'file')
				setTask((state) => ({
					...applyGroups(focusGroup(groupsNow(state), home.id)),
					chatTab: false,
				}));
			else if (step === 'tools') {
				toolbarTools();
				setToolsOpen(true);
			}
			return;
		}
		// spec/task-window-workspace#empty-work-area: a task's empty work area is not shown; turning it on is choosing what to open. The main tree shows its
		// empty work area, so its switch just flips.
		const tabs = workAreaTabs(
			groupsNow(current),
			!mainTree && current.chatShown && current.bottomUnderChat
		).length;
		if (!mainTree && opensToolsInstead(layoutOf(current), column, tabs)) {
			toolbarTools();
			setToolsOpen(true);
			return;
		}
		const next = toggleColumn(layoutOf(current), column);
		const inside = !next[column] && !!columnNode(column)?.contains(document.activeElement);
		setTask({ chatShown: next.chat, workShown: next.work, panelShown: next.panel });
		if (inside) focusSwitch(column);
	};
	/** Hides the panel; focus inside it goes to its switch (spec/task-window-workspace#layout-switch). */
	const hidePanel = () => {
		const inside = !!changesPanel.current?.contains(document.activeElement);
		setTask({ panelShown: false });
		if (inside) focusSwitch('panel');
	};
	// spec/task-window-workspace#two-columns: two columns already show the chat and the work area; Show all brings the panel.
	const showAll = () =>
		setTask(
			twoNow() ? { panelShown: true } : { chatShown: true, workShown: true, panelShown: true }
		);
	const resetWidths = () => {
		resize('chatWidth', defaultSurfaceLayout.chatWidth);
		resize('changesWidth', defaultSurfaceLayout.changesWidth);
		resize('consoleHeight', defaultSurfaceLayout.consoleHeight);
		setTask({ widths: {} });
		saveLayout();
	};
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (document.querySelector('dialog[open]')) return;
				if (action === 'layout-chat') toggleLayout('chat');
				if (action === 'layout-work') toggleLayout('work');
				if (action === 'layout-panel') toggleLayout('panel');
				if (action === 'layout-all') showAll();
				if (action === 'layout-reset') resetWidths();
				if (action === 'tools') {
					toolbarTools();
					setToolsOpen((open) => !open);
				}
				if (action === 'new-file') newFileNow.current(toolbarTools());
				// spec/git#commit-dialog: Diff ▸ Commit… (⌥⌘K) — the commit dialog of this task.
				if (action === 'commit') setTask({ commitDialog: { scopeId: null } });
				if (action === 'language-servers-restart') void restartLanguageServers(task, locale);
			}),
		[task.id, task.projectId, Boolean(mainTree), locale]
	);
	// spec/task-window-workspace#work-area: the work area — the editor groups with files, diffs and the tools.
	const middleShown = layoutNow.work;
	const unsaved = editorTabs.some((model) => model.dirty);
	const activeTab = documents.find((tab) => tab.id === activeDocument);
	const documentSurface: 'editor' | 'diff' | 'tool' =
		activeTab && isToolTab(activeTab) ? 'tool' : activeTab?.kind === 'diff' ? 'diff' : 'editor';
	// spec/task-window#tab-strips: the document strip scrolls without a scrollbar; the active tab slides into view once the strip is shown.
	const documentStrip = useTabStrip(activeDocument);
	// spec/agents-and-providers#context-tools: `editor_state` says whether the documents area and the right panel are on screen right now.
	const contextView = useRef({ documentsShown: false, panelShown: false });
	// spec/task-window-workspace#two-columns: in two columns the documents hide behind the Chat tab when it is chosen in the only group.
	contextView.current = {
		documentsShown: middleShown && !(two && chatInTab && groupTotal === 1),
		panelShown: panelOpen,
	};
	useEffect(() => registerTaskView(task, () => contextView.current), [task.projectId, task.id]);
	const chatVisible = layoutNow.chat;
	// spec/task-window-workspace#two-columns: the chat on screen at all — its column, or in two columns its tab chosen in the first group.
	const chatOnScreen = two ? chatInTab : chatVisible;
	// spec/task-window-workspace#two-columns: the strip of the chat's group scrolls under the pinned Chat tab and fades at its edges.
	const pinnedStrip = useTabStrip(chatHome?.activeDocument, '[aria-selected=true]', true);
	// spec/task-window-workspace#empty-work-area: neither the chat nor the work area on screen — their place shows the empty state.
	const emptyPlace = showsEmptyPlace(layoutNow);
	// spec/task-window-workspace#work-area: the bottom group stands under the chat — with the work area hidden, and after a drag also
	// beside it; the work area then shows the rest of its groups.
	const bottom = bottomGroup(groups),
		underChat = chatVisible && bottomUnderChat && !!bottom;
	const fromBottom = (from: { group: string }) => !!bottom && from.group === bottom.id;
	const setSurface = (surface: 'chat' | 'diff' | 'editor') => setTask({ surface });
	const setSelected = (selected: string) => setTask({ selected });
	const setFilter = (filter: string) => setTask({ filter });
	const [records, setRecords] = useState<EventRecord[]>([]);
	const pending = useMemo(() => pendingInputs(records), [records]);
	const [answering, setAnswering] = useState(false);
	const [queuedReview, setQueuedReview] = useState(false);
	/** spec/notifications-slack-notes-and-schedules#message-classes: a failure is its own toast that names the action and the file, not one shared line of the window. */
	const fileName = (path: string) => path.split('/').at(-1) || path;
	const nameOf = (id: string) => {
		const path =
			changes?.files.find((item) => item.id === id)?.path ??
			evictedEditors.get(id)?.path ??
			editorTabs.find((tab) => tab.document.id === id)?.document.path;
		return path ? fileName(path) : undefined;
	};
	/** A file id is a hash; without a known path the text names «the file», never the id. */
	const unnamed: Partial<Record<MessageKey, MessageKey>> = {
		'Could not open {file}.': 'Could not open the file.',
		'Could not close {file}.': 'Could not close the file.',
	};
	function fail(
		key: MessageKey,
		options: {
			file?: string | undefined;
			retry?: () => void;
			kind?: 'error' | 'warning' | 'info';
		} = {}
	) {
		if (key.includes('{file}') && !options.file) key = unnamed[key] ?? key;
		const text = options.file ? t(locale, key).replace('{file}', options.file) : t(locale, key);
		notify(options.kind ?? 'error', text, {
			bold: options.file,
			action: options.retry ? { label: t(locale, 'Retry'), run: options.retry } : undefined,
		});
	}
	async function compose(
		text: string,
		focus = true,
		immediate = false,
		name?: string,
		after?: string
	): Promise<boolean> {
		if (mainTree) {
			onQuickTask?.({
				scopeId: mainTree.scopeId,
				context: [
					{
						icon: 'code',
						label: name ? name.split('/').at(-1)! : t(locale, 'Selected code'),
						text: [name, text, after].filter(Boolean).join('\n\n'),
					},
				],
			});
			return true;
		}
		try {
			if (immediate && task.transport !== 'terminal') {
				await window.brigadir.sendCommand(task, { kind: 'prompt', text });
				if (focus) setTask({ surface: 'chat', focusComposer: true });
			} else
				await attachTaskContext(
					task,
					{
						kind: 'text',
						name: name
							? name.length > 200
								? '…' + name.slice(-199)
								: name
							: t(locale, immediate ? 'Comment' : 'Selected code'),
						text: after && task.transport === 'terminal' ? `${text}\n\n${after}` : text,
					},
					after && task.transport !== 'terminal' ? after : undefined
				);
			return true;
		} catch {
			fail(
				immediate && task.transport !== 'terminal'
					? 'Could not send the message.'
					: 'Could not attach the selection to the chat.'
			);
			return false;
		}
	}
	async function answer(command: SessionCommand) {
		setAnswering(true);
		try {
			await window.brigadir.sendCommand(task, command);
		} catch {
			fail('Could not send the answer to the agent.');
		} finally {
			setAnswering(false);
		}
	}
	/** spec/git#merge: History mounts its Merge button into the shared header of the changes panel. */
	const [historyActions, setHistoryActions] = useState<HTMLSpanElement | null>(null);
	/** spec/diff-and-review#changes-header: the Changes tab gives way only down to its header in one line; 360 is where the base chip keeps its icon. */
	const [changesHeader, setChangesHeader] = useState<HTMLElement | null>(null);
	const changesMinimum = useHeaderMinimum(changesSearch ? null : changesHeader, 360, locale);
	/** spec/diff-and-review#changes-header: past that minimum the header scrolls sideways, by wheel too, like a tab strip. */
	const changesStrip = useTabStrip(null);
	const changesHeaderRef = useCallback(
		(node: HTMLElement | null) => {
			setChangesHeader(node);
			changesStrip(node);
		},
		[changesStrip]
	);
	/** spec/task-window#width-rules: the chat handle goes as far as the work area keeps its minimum; past that ceiling it starts from the ceiling. */
	const taskBody = useRef<HTMLDivElement>(null),
		[bodyWidth, setBodyWidth] = useState(0);
	useLayoutEffect(() => {
		const body = taskBody.current;
		if (!body) return;
		const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth));
		observer.observe(body);
		setBodyWidth(body.clientWidth);
		return () => observer.disconnect();
	}, []);
	const chatMax = bodyWidth
			? chatCeiling(
					bodyWidth,
					panelOpen ? Math.max(columnWidth('changesWidth'), changesMinimum ?? 200) : null
				)
			: columnWidth('chatWidth'),
		chatNow = Math.min(columnWidth('chatWidth'), chatMax);
	/** Search in the History and Turns modes; in Changes the field filters the files. */
	const [changesQuery, setChangesQuery] = useState('');
	/** ⌘F in the changes or PR panel expands its search (spec/pull-requests-and-ci#pr-panel); in the file tree, the tree's own. */
	const changesPanel = useRef<HTMLElement>(null);
	useEffect(
		() =>
			window.brigadir.onEditorAction((action) => {
				if (action !== 'find' || !changesPanel.current?.contains(document.activeElement)) return;
				if (panel === 'changes') setTask({ changesSearch: true });
				if (panel === 'prs')
					setTask((state) => (state.prOpen ? {} : { prSearch: state.prSearch ?? '' }));
			}),
		[panel]
	);
	const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
	const [changes, setChanges] = useState<ChangesSnapshot | null>(null);
	const treeScope = mainTree
		? (changes?.scopes.find((scope) => scope.id === mainTree.scopeId) ?? changes?.scopes[0] ?? null)
		: null;
	// spec/tasks#quick-tasks: the main tree has no host or watchScopes; the snapshot refreshes on window focus.
	useEffect(() => {
		if (!mainTree) return;
		const focus = () => {
			void window.brigadir.sendCommand(task, { kind: 'checkpoint' }).catch(() => {});
		};
		window.addEventListener('focus', focus);
		return () => window.removeEventListener('focus', focus);
	}, [Boolean(mainTree), task.projectId]);
	const [review, setReview] = useState<ReviewSnapshot>({ comments: [] });
	const [reviewBusy, setReviewBusy] = useState(false);
	const [agentBusy, setAgentBusy] = useState(false);
	// spec/task-window-workspace#two-columns: a turn that ended while the Chat tab was not on screen leaves its accent dot until the chat is opened.
	const busyBefore = useRef(agentBusy);
	useEffect(() => {
		const before = busyBefore.current;
		busyBefore.current = agentBusy;
		if (!two) return;
		const unread = chatUnreadAfter(chatUnread, before, agentBusy, chatOnScreen);
		if (unread !== chatUnread) setTask({ chatUnread: unread });
	}, [two, agentBusy, chatOnScreen, chatUnread]);
	const chatTabShows = chatTabState({
		waiting:
			pending.permissions.length > 0 ||
			pending.questions.length > 0 ||
			pending.proposals.length > 0 ||
			task.status === 'needs-you',
		running: agentBusy,
		unread: chatUnread,
	});
	const [diff, setDiff] = useState<FileDiff | null>(null);
	const [loading, setLoading] = useState(false);
	const [connected, setConnected] = useState(false);
	const request = useRef(0);
	// spec/architecture-and-platform#host-lifecycle: a review for a task whose host stopped for idleness starts the host first, through the normal launch path.
	const resumable = task.transport !== 'terminal' && idleStopped(records);
	const loadRequest = useRef(0),
		currentRange = useRef(changeRange);
	currentRange.current = changeRange;
	// spec/tasks#archive: an archived task reads its log even when the archive removed its worktree; Continue prepares it again after Restore.
	// spec/git#main-tree-branches: a task without isolation shows the step too while it switches its branches, and the reason if it failed.
	const needsPreparation =
		(task.launch?.isolation === 'worktree' ||
			(!!(task.launch?.switches?.length || task.launch?.pull?.length) && !!task.preparation)) &&
		task.preparation?.state !== 'ready' &&
		!task.archived;
	const load = useCallback(async () => {
		if (needsPreparation) return;
		const request = ++loadRequest.current;
		try {
			const [value, steps] = await Promise.all([
				window.brigadir.selectChangeRange(task, currentRange.current),
				window.brigadir.readTimeline(task),
			]);
			if (request !== loadRequest.current) return;
			setChanges(value);
			setTimeline(steps);
			resolveToast(t(locale, 'Could not read the task changes.'));
		} catch {
			if (request === loadRequest.current)
				fail('Could not read the task changes.', {
					kind: 'warning',
					retry: () => {
						void load();
					},
				});
		}
	}, [task.id, task.projectId, locale, changeRange, needsPreparation, diffBase]);
	useEffect(() => {
		void load();
		let latestLiveSeq = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// One full read, then tails after it; a tail without a turn boundary leaves the busy state live events keep.
		const reads = sessionReads(task, (s, after) => {
			setRecords((current) => mergeRecords(current, s.records));
			if ((s.records.at(-1)?.seq ?? after) >= latestLiveSeq) {
				setQueuedReview(Boolean(s.pendingReview));
				setConnected(s.connected);
				const boundary = s.records.findLast((r) =>
					['turn.started', 'turn.completed', 'host.stopped', 'session.failed'].includes(
						r.event.kind
					)
				);
				if (!after || boundary) setAgentBusy(boundary?.event.kind === 'turn.started');
			}
		});
		const refreshSession = () => reads.refresh();
		refreshSession();
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id !== task.id || key.projectId !== task.projectId) return;
			// A null event also means metadata/read-watermark changed. It is not a disconnect.
			if (record) {
				latestLiveSeq = Math.max(latestLiveSeq, record.seq);
				setConnected(record.event.kind !== 'host.stopped');
				setRecords((current) =>
					current.some((item) => item.seq === record.seq) ? current : [...current, record]
				);
			} else refreshSession();
			if (record?.event.kind === 'turn.started') {
				setAgentBusy(true);
				setQueuedReview(false);
			}
			if (
				record &&
				['turn.completed', 'host.stopped', 'session.failed'].includes(record.event.kind)
			)
				setAgentBusy(false);
			if (record?.event.kind === 'snapshot.failed')
				fail('Could not take a snapshot of the changes.', { kind: 'warning' });
			if (
				!record ||
				record.event.kind === 'scopes.changed' ||
				record.event.kind === 'checkpoint.created' ||
				record.event.kind === 'file.saved'
			) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					void load();
				}, 100);
			}
		});
		return () => {
			reads.stop();
			loadRequest.current++;
			stop();
			clearTimeout(timer);
		};
	}, [load, task.id, task.projectId, locale]);
	// Match by scope/path across snapshots; immutable IDs prevent stale blobs being shown as current.
	const commitDiff = selected ? commitDiffs[selected] : undefined;
	const file =
		commitDiff?.file ?? changes?.files.find((f) => `${f.scopeId}/${f.path}` === selected);
	const reviewRequest = useRef(0),
		reviewFile = useRef<string | null>(null);
	reviewFile.current = commitDiff ? null : (file?.id ?? null);
	const reloadReview = useCallback(async () => {
		const request = ++reviewRequest.current;
		try {
			const value = await window.brigadir.readReview(task, reviewFile.current);
			if (request === reviewRequest.current) {
				setReview(value);
				resolveToast(t(locale, 'Could not read the review comments.'));
			}
		} catch {
			if (request === reviewRequest.current)
				fail('Could not read the review comments.', { kind: 'warning' });
		}
	}, [task.id, task.projectId, file?.id, locale]);
	useEffect(() => {
		void reloadReview();
	}, [reloadReview, reviewOpen]);
	useEffect(
		() =>
			window.brigadir.onReviewChanged((key) => {
				if (key.projectId === task.projectId && key.id === task.id) void reloadReview();
			}),
		[reloadReview, task.projectId, task.id]
	);
	useEffect(() => {
		if (
			['turn.started', 'turn.completed', 'checkpoint.created'].includes(
				records.at(-1)?.event.kind ?? ''
			)
		)
			void reloadReview();
	}, [records.at(-1)?.seq]);
	async function sendReview() {
		setReviewBusy(true);
		try {
			if (resumable) {
				const value = await window.brigadir.startSession(task);
				if (!value.connected || value.queued || idleStopped(value.records)) return;
			}
			const command = await window.brigadir.prepareReview(task);
			await window.brigadir.sendCommand(task, command);
			setQueuedReview(Boolean((await readSessionState(task)).pendingReview));
			await reloadReview();
		} catch {
			fail('Could not send the review to the agent.', {
				retry: () => {
					void sendReview();
				},
			});
		} finally {
			setReviewBusy(false);
		}
	}
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (document.querySelector('dialog[open]')) return;
				if (action === 'cancel') {
					if (document.activeElement?.closest('[data-role="console"]')) return;
					void window.brigadir
						.sendCommand(task, { kind: 'cancel' })
						.catch(() => fail('Could not stop the turn.'));
				}
				if (action === 'turns')
					setTask({ panel: 'changes', changesView: 'turns', panelShown: true });
				// spec/task-window-workspace#layout-switch: ⇧⌘E / ⇧⌘D / ⇧⌘P open the panel on their tab; again — hide it.
				const panelKey =
					action === 'pull-requests' && modules.pullRequests
						? 'prs'
						: action === 'diff'
							? 'changes'
							: action === 'files'
								? 'files'
								: null;
				if (panelKey) {
					const current = parkedTaskState(task);
					const next = panelShortcut(
						{ panel: current?.panel ?? 'changes', shown: current?.panelShown ?? false },
						panelKey
					);
					if (next.panelShown) setTask(next);
					else hidePanel();
				}
				// spec/task-window-workspace#work-area: ⇧⌘B / ⇧⌘M / ⇧⌘Y go to the last tab of their kind or open one; ⌃⇧` always opens a terminal.
				if (action === 'browser' && modules.browser) void goToTool('browser');
				if (action === 'simulator' && modules.simulator) void goToTool('simulator');
				if (action === 'terminal') void goToTool('terminal');
				if (action === 'terminal-new') void openTool('terminal');
				if (action === 'composer') setTask({ surface: 'chat', focusComposer: true });
				if (['review-send', 'review-send-go', 'permission-deny'].includes(action)) {
					if (document.activeElement?.closest('[data-comment-draft]')) return;
					const focusedPermission =
						document.activeElement?.closest<HTMLElement>('[data-permission-id]')?.dataset
							.permissionId;
					const permission = pending.permissions.find((item) => item.id === focusedPermission);
					if (permission) {
						if (!connected || answering) return;
						const kind =
							action === 'permission-deny'
								? 'reject_once'
								: action === 'review-send-go'
									? 'allow_always'
									: 'allow_once';
						const option = permission.options.find((item) => item.kind === kind);
						if (option || action === 'permission-deny')
							void answer({
								kind: 'answerPermission',
								id: permission.id,
								optionId: option?.id ?? null,
							});
						return;
					}
					const focusedQuestion =
						document.activeElement?.closest<HTMLElement>('[data-question-id]')?.dataset.questionId;
					const question = pending.questions.find((item) => item.id === focusedQuestion);
					if (question) {
						const response = answers[question.id];
						if (
							action === 'review-send' &&
							connected &&
							!answering &&
							response &&
							validAnswer(question, response)
						)
							void answer({ kind: 'answerQuestion', id: question.id, answer: response });
						return;
					}
					if (action !== 'review-send') return;
					if (pending.permissions.length || pending.questions.length || pending.proposals.length)
						return;
				}
				if (
					action === 'review-send' &&
					(connected || resumable) &&
					!reviewBusy &&
					(review.comments.some((comment) => !comment.sent) ||
						(review.notes ?? []).some((note) => !note.sent))
				)
					void sendReview();
			}),
		[
			connected,
			resumable,
			agentBusy,
			reviewBusy,
			review,
			pending,
			setTask,
			answers,
			answering,
			modules.browser,
			modules.simulator,
			modules.pullRequests,
		]
	);
	useEffect(() => {
		const id = ++request.current;
		setDiff(null);
		setLoading(Boolean(file));
		if (!file) return;
		void (
			commitDiff
				? readCommitDiff(task, selected!, commitDiff)
				: window.brigadir.readFileDiff(task, file.id)
		)
			.then(
				(value) => {
					if (request.current !== id) return;
					setDiff(value);
					// Highlighting follows the shown diff; a stale or failed reply leaves the rows plain.
					if (!commitDiff && !value.binary && !value.tooLarge && !value.file.gitlink)
						void window.brigadir.readFileSyntax(task, value.file.id).then(
							(syntax) => {
								if (request.current === id)
									setDiff((current) => (current === value ? { ...value, ...syntax } : current));
							},
							() => {}
						);
				},
				() => {
					if (request.current === id)
						fail('Could not read the changes in {file}.', {
							kind: 'warning',
							file: fileName(file.path),
							retry: () => {
								void window.brigadir
									.sendCommand(task, { kind: 'checkpoint' })
									.then(load, () => fail('Could not refresh the changes.'));
							},
						});
				}
			)
			.finally(() => {
				if (request.current === id) setLoading(false);
			});
		return () => {
			request.current++;
		};
	}, [file?.id, task.id, task.projectId, locale, diffBase]);
	const [closing, setClosing] = useState<EditorModel[]>([]);
	const activeBuffer = editorTabs.find((tab) => tab.document.id === activeEditor);
	function changed() {
		setTask((state) => ({ editorTabs: [...state.editorTabs] }));
	}
	/**
	 * spec/editor#markdown-views: `view` is the Markdown view the new tab shows; a line always opens the code. spec/diff-and-review#open-in-editor:
	 * a line puts the caret there and scrolls it to the middle of the editor, an open tab scrolled elsewhere included.
	 */
	async function openEditor(
		id: string,
		fromDiff = false,
		line?: number,
		view?: MarkdownView['view'],
		path?: string
	) {
		try {
			const document = await (fromDiff
				? window.brigadir.openDiffFile(task, id)
				: window.brigadir.readEditorFile(task, id));
			if (document.state !== 'text') {
				fail(
					document.state === 'binary'
						? 'The binary file {file} does not open in the editor.'
						: '{file} is too large for the editor.',
					{ kind: 'info', file: fileName(document.path) }
				);
				return;
			}
			const shown = line !== undefined ? 'code' : view;
			setTask((state) => ({
				editorTabs: withBuffer(state, document),
				activeEditor: document.id,
				surface: 'editor',
				...(shown && isMarkdownPath(document.path)
					? { markdownViews: withMarkdownView(state.markdownViews, document.id, shown) }
					: {}),
				...(line !== undefined ? { editorTarget: { id: document.id, line, focus: true } } : {}),
			}));
		} catch {
			fail('Could not open {file}.', {
				file: path ? fileName(path) : nameOf(id),
				retry: () => {
					void openEditor(id, fromDiff, line, view, path);
				},
			});
		}
	}
	// A tab whose clean buffer the LRU dropped reads its file again when it becomes active.
	const evictedActive =
		!activeBuffer && activeEditor !== null && evictedEditors.has(activeEditor)
			? activeEditor
			: null;
	useEffect(() => {
		if (!evictedActive) return;
		let current = true;
		void window.brigadir.readEditorFile(task, evictedActive).then(
			(document) => {
				if (!current) return;
				if (document.state !== 'text') {
					fail(
						document.state === 'binary'
							? 'The binary file {file} does not open in the editor.'
							: '{file} is too large for the editor.',
						{ kind: 'info', file: fileName(document.path) }
					);
					return;
				}
				setTask((state) => ({ editorTabs: withBuffer(state, document) }));
			},
			() => {
				if (current) fail('Could not open {file}.', { file: nameOf(evictedActive) });
			}
		);
		return () => {
			current = false;
		};
	}, [evictedActive, task.id, task.projectId, locale]);
	async function closeEvicted(id: string) {
		try {
			await window.brigadir.releaseEditorFile(task, id);
			const place = parkedTaskState(task)?.evictedEditors.get(id);
			setTask((state) => {
				const evictedEditors = new Map(state.evictedEditors);
				evictedEditors.delete(id);
				return { evictedEditors };
			});
			afterClose(`file:${id}`, place);
		} catch {
			fail('Could not close {file}.', { file: nameOf(id) });
		}
	}
	function activateDocument(tab: DocumentTab) {
		setTask(
			isToolTab(tab)
				? { activeDocument: tab.id }
				: tab.kind === 'diff'
					? { surface: 'diff', selected: tab.target }
					: { surface: 'editor', activeEditor: tab.target }
		);
	}
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (
					!['document-next', 'document-previous'].includes(action) ||
					document.querySelector('dialog[open]') ||
					!documents.length
				)
					return;
				const index = documents.findIndex((tab) => tab.id === activeDocument),
					step = action === 'document-next' ? 1 : -1;
				activateDocument(documents[(index + step + documents.length) % documents.length]!);
			}),
		[documents, activeDocument]
	);
	/** `place` (spec/editor#reopen-closed-tab): where a closed file's buffer stood; `record` false — the tab goes for good (a module off). */
	function afterClose(id: string, place?: EvictedEditor, record = true) {
		setTask((state) => {
			const next = closeDocument(state, id),
				active = next.documents.find((tab) => tab.id === next.activeDocument);
			// A closed commit or History tab drops its entry and cached diff.
			const key = id.startsWith('diff:') ? id.slice(5) : null,
				entry = key ? state.commitDiffs[key] : undefined,
				commitDiffs = entry
					? Object.fromEntries(Object.entries(state.commitDiffs).filter(([item]) => item !== key))
					: state.commitDiffs;
			if (entry) forgetCommitDiff(task, key!, entry);
			// spec/editor#reopen-closed-tab: the closed tab goes on its group's stack, with its place or its diff's source.
			const index = state.documents.findIndex((tab) => tab.id === id),
				closed = state.documents[index];
			if (record && closed)
				rememberClosedTab(task, {
					tab: closed,
					group: state.editorGroups.focused,
					index,
					extra: { ...(place ? { place } : {}), ...(entry ? { commitDiff: entry } : {}) },
				});
			return {
				...next,
				commitDiffs,
				...(active && isToolTab(active)
					? {}
					: active?.kind === 'diff'
						? { surface: 'diff' as const, selected: active.target }
						: { surface: 'editor' as const, activeEditor: active?.target ?? null }),
			};
		});
	}
	// spec/settings-modules-and-onboarding#module-off: pull requests off close the Overview and PR file tabs; drafts and the summary stay on disk for the module.
	useEffect(() => {
		if (modules.pullRequests) return;
		for (const tab of documents)
			if (tab.target.startsWith('pr:') || tab.target.startsWith('overview:'))
				afterClose(tab.id, undefined, false);
	}, [modules.pullRequests, documents]);
	async function closeEditor(model: EditorModel) {
		try {
			await window.brigadir.releaseEditorFile(task, model.document.id);
			const place = bufferPlace(model);
			setTask((state) => ({ editorTabs: state.editorTabs.filter((tab) => tab !== model) }));
			afterClose(`file:${model.document.id}`, place);
			setClosing((list) => list.filter((item) => item !== model));
		} catch {
			fail('Could not close {file}.', { file: fileName(model.document.path) });
		}
	}
	// spec/editor#editor-groups: editor groups. Every operation reads the groups as they are now and puts the focused group's tabs on screen.
	function runGroups(op: (groups: EditorGroups) => EditorGroups) {
		setTask((state) => {
			const before = groupsNow(state),
				next = op(before);
			return next === before ? state : applyGroups(next);
		});
	}
	function shownElsewhere(tab: DocumentTab) {
		const now = parkedTaskState(task);
		return !!now && openElsewhere(groupsNow(now), tab.id, now.editorGroups.focused);
	}
	/** A strip of a group without the focus acts on its group: the group takes the focus first. */
	function inGroup(group: EditorGroup, run: () => void) {
		if (parkedTaskState(task)?.editorGroups.focused !== group.id)
			runGroups((groups) => focusGroup(groups, group.id));
		run();
	}
	/** JetBrains' split items from the tab menu or the menu bar, on `tab` of the focused group; the focus follows into the new group. */
	function runSplit(action: string, tab: string | null) {
		runGroups((groups) => {
			const id = groups.focused;
			if (
				action === 'split-right' ||
				action === 'split-down' ||
				action === 'split-move-right' ||
				action === 'split-move-down'
			)
				return tab
					? splitGroup(
							groups,
							id,
							tab,
							action.endsWith('right') ? 'right' : 'down',
							action.includes('move')
						)
					: groups;
			if (action === 'move-other-group') return tab ? moveToNextGroup(groups, id, tab) : groups;
			if (action === 'unsplit') return unsplitGroup(groups, id);
			if (action === 'unsplit-all') return unsplitAll(groups);
			if (action === 'group-next' || action === 'group-previous')
				return stepGroup(groups, action === 'group-next' ? 1 : -1);
			return groups;
		});
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const group = view.current?.querySelector('[data-editor-group][data-focused=true]');
				(
					group?.querySelector<HTMLElement>('.cm-content') ??
					group?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
				)?.focus();
			})
		);
	}
	const splitActions: Record<string, string> = {
		'editor-split-right': 'split-right',
		'editor-split-down': 'split-down',
		'editor-split-move-right': 'split-move-right',
		'editor-split-move-down': 'split-move-down',
		'editor-group-move': 'move-other-group',
		'editor-unsplit': 'unsplit',
		'editor-unsplit-all': 'unsplit-all',
		'editor-group-next': 'group-next',
		'editor-group-previous': 'group-previous',
	};
	/**
	 * spec/search-menus-and-commands#menu-structure: File ▸ Close tab (⌘W) closes the focused group's tab the way its × does — a dirty file asks first,
	 * a terminal asks to stop. Nothing with no tab, with the work area hidden, or on the pinned Chat tab (spec/task-window-workspace#two-columns).
	 */
	const closeFocusedTab = useRef(() => {});
	closeFocusedTab.current = () => {
		const now = parkedTaskState(task);
		if (!now) return;
		const tab = now.documents.find((item) => item.id === now.activeDocument);
		if (!tab) return;
		if (twoNow()) {
			const home = chatGroup(groupsNow(now));
			if (home.id === now.editorGroups.focused && now.chatTab) return;
		} else if (!now.workShown) return;
		closeTabs(tab, 'close');
	};
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (document.querySelector('dialog[open]')) return;
				if (action === 'reopen-tab') {
					void reopenClosedTab();
					return;
				}
				if (action === 'close-tab') {
					closeFocusedTab.current();
					return;
				}
				const split = splitActions[action];
				if (split) runSplit(split, parkedTaskState(task)?.activeDocument ?? null);
			}),
		[task.id, task.projectId]
	);
	/**
	 * spec/editor#reopen-closed-tab: the last closed tab of `group` (the focused one) back at its place — a file at its caret and scroll, a
	 * commit, History or PR diff with its source; the group takes the focus.
	 */
	async function reopenClosedTab(group?: string) {
		const now = parkedTaskState(task);
		if (!now) return;
		const groups = groupsNow(now),
			into = group ?? groups.focused,
			entry = takeClosed(task, groups, into);
		if (!entry) return;
		const { tab, extra } = entry;
		if (tab.kind === 'file' && !now.editorTabs.some((model) => model.document.id === tab.target)) {
			try {
				const document = await window.brigadir.readEditorFile(task, tab.target);
				if (document.state !== 'text') {
					fail(
						document.state === 'binary'
							? 'The binary file {file} does not open in the editor.'
							: '{file} is too large for the editor.',
						{ kind: 'info', file: fileName(document.path) }
					);
					return;
				}
				setTask((state) =>
					state.editorTabs.some((model) => model.document.id === document.id)
						? state
						: { editorTabs: [...state.editorTabs, restoreBuffer(document, extra?.place)] }
				);
			} catch {
				fail('Could not open {file}.', { file: fileName(tab.path) });
				return;
			}
		}
		const commitDiff = extra?.commitDiff;
		if (commitDiff)
			setTask((state) => ({ commitDiffs: { ...state.commitDiffs, [tab.target]: commitDiff } }));
		runGroups((current) => reopenTab(current, into, tab, entry.index));
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const shown = view.current?.querySelector('[data-editor-group][data-focused=true]');
				(
					shown?.querySelector<HTMLElement>('.cm-content') ??
					shown?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
				)?.focus();
			})
		);
	}
	// spec/editor#reopen-closed-tab: whether the focused group has a closed tab, for File ▸ Reopen closed tab.
	const canReopen = useClosedTabs(
		(state) =>
			!!nextClosedTab(
				state.stacks[closedTabsKey(task)] ?? [],
				groupsNow({ editorGroups, documents, activeDocument }),
				editorGroups.focused
			)
	);
	// A tab dragged over a strip: the place it lands, before the tab under the pointer's left half.
	const [stripTarget, setStripTarget] = useState<{ group: string; index: number } | null>(null);
	function stripIndex(event: React.DragEvent<HTMLElement>) {
		const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-document-tab]')];
		const index = tabs.findIndex((item) => {
			const box = item.getBoundingClientRect();
			return event.clientX < box.left + box.width / 2;
		});
		return index < 0 ? tabs.length : index;
	}
	function stripDragOver(event: React.DragEvent<HTMLElement>, group: EditorGroup) {
		if (!draggedTab()) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
		const index = stripIndex(event);
		setStripTarget((current) =>
			current?.group === group.id && current.index === index ? current : { group: group.id, index }
		);
	}
	function stripDrop(event: React.DragEvent<HTMLElement>, group: EditorGroup) {
		const from = draggedTab();
		if (!from) return;
		event.preventDefault();
		const index = stripIndex(event);
		setStripTarget(null);
		endTabDrag();
		runGroups((groups) =>
			dropTab(groups, from.group, from.tab, { group: group.id, at: { index } }, event.altKey)
		);
	}
	// A passive group's shown file whose buffer the LRU dropped or another group closed is read again.
	const passiveMissing =
		groups.root.kind === 'group'
			? []
			: [...new Set(openTabs.filter((tab) => tab.kind === 'file').map((tab) => tab.target))].filter(
					(id) => !editorTabs.some((model) => model.document.id === id) && shownInPassive(id)
				);
	function shownInPassive(id: string) {
		const stack = [groups.root];
		while (stack.length) {
			const node = stack.pop()!;
			if (node.kind === 'split') {
				stack.push(node.first, node.second);
				continue;
			}
			if (
				node.id !== groups.focused &&
				node.documents.some((tab) => tab.id === node.activeDocument && tab.target === id)
			)
				return true;
		}
		return false;
	}
	useEffect(() => {
		if (!passiveMissing.length) return;
		let current = true;
		for (const id of passiveMissing)
			void window.brigadir.readEditorFile(task, id).then(
				(document) => {
					if (current && document.state === 'text')
						setTask((state) => ({ editorTabs: withBuffer(state, document) }));
				},
				() => {}
			);
		return () => {
			current = false;
		};
	}, [passiveMissing.join('|')]);
	// spec/editor#closing-tabs: × and a middle click on the tab close it the same way; a dirty buffer asks first.
	function closeDocumentTab(tab: DocumentTab, buffer: EditorModel | null | undefined) {
		// spec/task-window-workspace#work-area: a terminal asks to stop its process first (its tab shows the question); a browser tab drops its page.
		if (tab.kind === 'terminal') {
			runGroups((groups) => revealTab(groups, tab.id));
			setTask({ terminalClosing: tab.target });
			return;
		}
		if (tab.kind === 'browser')
			void window.brigadir
				.browserCommand(task, { kind: 'discard', tab: tab.target })
				.catch(() => {});
		if (isToolTab(tab)) {
			dropTool(tab.id);
			return;
		}
		// spec/editor#editor-groups: a file still open in another group keeps its buffer; only this group's tab goes, with no question.
		if (tab.kind === 'file' && shownElsewhere(tab)) {
			afterClose(tab.id, buffer ? bufferPlace(buffer) : undefined);
			return;
		}
		if (buffer) {
			if (buffer.dirty) setClosing([buffer]);
			else void closeEditor(buffer);
		} else if (tab.kind === 'file' && evictedEditors.has(tab.target)) void closeEvicted(tab.target);
		else afterClose(tab.id);
	}
	// spec/editor#tab-menu: the tab's native menu, JetBrains' close group. A bulk close takes the same path as ×; dirty buffers stay and ask together.
	function documentTabMenu(
		tab: DocumentTab,
		at: { x: number; y: number } | null,
		tabs: DocumentTab[] = documents
	) {
		const index = tabs.findIndex((item) => item.id === tab.id),
			buffer =
				tab.kind === 'file' ? editorTabs.find((model) => model.document.id === tab.target) : null;
		const modified = (item: DocumentTab) =>
			item.kind === 'file' &&
			!!editorTabs.find((model) => model.document.id === item.target)?.dirty;
		const changed =
			tab.kind === 'diff'
				? changes?.files.find((item) => `${item.scopeId}/${item.path}` === tab.target)?.id
				: undefined;
		const file =
			tab.kind === 'file'
				? { id: tab.target, source: 'editor' as const }
				: changed
					? { id: changed, source: 'changes' as const }
					: null;
		void window.brigadir
			.documentTabMenu(task, {
				close: !buffer?.saving,
				others: tabs.length > 1,
				right: index < tabs.length - 1,
				unmodified: tabs.some((item) => !modified(item)),
				reopen: (() => {
					const now = groupsNow(
						parkedTaskState(task) ?? { editorGroups, documents, activeDocument }
					);
					return !!nextClosedTab(
						useClosedTabs.getState().stacks[closedTabsKey(task)] ?? [],
						now,
						groupOf(now, tab.id)?.id ?? now.focused
					);
				})(),
				groups: groupCount(
					groupsNow(parkedTaskState(task) ?? { editorGroups, documents, activeDocument })
				),
				file,
				at,
				// spec/task-window-workspace#two-columns: two columns have no chat column to stand under.
				underChat:
					!two && bottomGroup(groups)?.documents.some((item) => item.id === tab.id)
						? bottomUnderChat
						: null,
			})
			.then(
				(action) => {
					if (action === 'under-chat') setTask({ bottomUnderChat: !bottomUnderChat });
					else if (action === 'reopen-tab') {
						const now = parkedTaskState(task);
						void reopenClosedTab(now ? groupOf(groupsNow(now), tab.id)?.id : undefined);
					} else if (action) closeTabs(tab, action);
				},
				() => fail('Could not open the menu.')
			);
	}
	function closeTabs(tab: DocumentTab, action: DocumentTabMenuAction) {
		if ((documentTabSplitActions as readonly string[]).includes(action)) {
			runSplit(action, tab.id);
			return;
		}
		// The menu is async: read the tabs as they are now, not as they were at the click.
		const now = parkedTaskState(task),
			tabs = now?.documents ?? documents,
			buffers = now?.editorTabs ?? editorTabs,
			bufferOf = (item: DocumentTab) =>
				item.kind === 'file' ? buffers.find((model) => model.document.id === item.target) : null;
		const targets = documentsToClose(tabs, tab.id, action, (item) => !!bufferOf(item)?.dirty);
		// Closing the others or those to the right keeps the clicked tab in front, as in JetBrains.
		if (
			action !== 'close' &&
			targets.some((item) => item.id === (now?.activeDocument ?? activeDocument)) &&
			!targets.includes(tab)
		) {
			activateDocument(tab);
			setTask({ activeDocument: tab.id });
		}
		const dirty: EditorModel[] = [];
		for (const item of targets) {
			const buffer = bufferOf(item);
			if (buffer?.saving) continue;
			if (buffer?.dirty && !shownElsewhere(item)) {
				dirty.push(buffer);
				continue;
			}
			closeDocumentTab(item, buffer);
		}
		if (dirty.length) setClosing(dirty);
	}
	/** spec/task-window-workspace#work-area: a tool tab goes from every group (closed, or its session gone on the host). */
	function dropTool(id: string) {
		runGroups((groups) => pruneGroups(groups, (tab) => tab.id !== id));
	}
	/** spec/task-window-workspace#work-area: a new terminal, browser tab or the simulator, in the focused group or the bottom one. */
	async function openTool(kind: ToolTabKind, place?: 'focused' | 'bottom') {
		if (kind === 'browser') {
			const tab = newBrowserTab();
			freshBrowserTabs.add(tab);
			showTaskTool(task, documentForBrowser(tab, ''), place);
			return;
		}
		if (kind === 'simulator') {
			showTaskTool(task, documentForSimulator(''), place);
			return;
		}
		try {
			const item = (await window.brigadir.terminalCommand(task, {
				kind: 'create',
				role: 'console',
			})) as TerminalInfo;
			showTaskTool(task, documentForTerminal(item.id, item.title), place);
		} catch {
			fail('Could not open a new terminal.', {
				retry: () => {
					void openTool(kind, place);
				},
			});
		}
	}
	/** ⇧⌘B / ⇧⌘Y / ⇧⌘M: the last tab of the kind; a terminal the host still runs without a tab gets one; else a new one. */
	async function goToTool(kind: ToolTabKind) {
		const current = parkedTaskState(task),
			last = current && lastToolTab(current, kind);
		if (last) {
			showTaskTool(task, last);
			return;
		}
		if (kind === 'terminal') {
			const all = (await window.brigadir
				.terminalCommand(task, { kind: 'list' })
				.catch(() => [])) as TerminalInfo[];
			const live = all.filter((item) => item.role === 'console' && !item.exited).at(-1);
			if (live) {
				showTaskTool(task, documentForTerminal(live.id, live.title), 'bottom');
				return;
			}
		}
		await openTool(kind);
	}
	// spec/task-window-workspace#work-area: a terminal tab is named by its command; the names follow the host's list. Only a task with terminal tabs
	// asks: a list is a command to the task's host, and it would start the host of a task nobody runs.
	const terminalTabs = openTabs.some((tab) => tab.kind === 'terminal');
	useEffect(() => {
		if (!terminalTabs) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const rename = () =>
			void window.brigadir.terminalCommand(task, { kind: 'list' }).then(
				(value) => {
					const all = value as TerminalInfo[];
					runGroups((groups) => {
						let next = groups;
						for (const item of all)
							if (item.role === 'console')
								next = renameTab(
									next,
									`terminal:${item.id}`,
									item.block?.exitCode === null ? item.block.command.slice(0, 40) : item.title
								);
						return next;
					});
				},
				() => {}
			);
		rename();
		const stop = window.brigadir.onTerminalEvent(({ key, event }) => {
			if (
				key.id !== task.id ||
				key.projectId !== task.projectId ||
				(!event.run && !event.exited && !event.block)
			)
				return;
			clearTimeout(timer);
			timer = setTimeout(rename, 120);
		});
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [task.id, task.projectId, terminalTabs]);
	const reviewDialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (!reviewOpen) return;
		const previous = document.activeElement,
			dialog = reviewDialog.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [reviewOpen]);
	const reviewSummary = reviewFiles(review, changes);
	const unavailable = (changes?.scopes ?? []).filter((scope) => scope.available === false);
	const notices = (placement: 'composer' | 'shelf') => (
		<>
			<ReadOnlyChip
				task={task}
				locale={locale}
				records={records}
				projectName={projectName}
				placement={placement}
			/>
			<UnavailableChip
				task={task}
				locale={locale}
				scopes={unavailable}
				projectName={projectName}
				placement={placement}
			/>
		</>
	);
	const chat = (
		<SurfaceBoundary surface="chat" locale={locale}>
			{needsPreparation ? (
				<Preparation task={task} locale={locale} />
			) : task.transport === 'terminal' ? (
				<>
					{/* spec/terminal-and-cli-agents#cli-context: the shelf spans the CLI column only, like the composer's inside the chat. */}
					<CliAttachments
						task={task}
						locale={locale}
						notices={
							<>
								{contended.length > 0 && (
									<ContentionChip
										task={task}
										locale={locale}
										placement="shelf"
										scopes={contended}
									/>
								)}
								{notices('shelf')}
							</>
						}
					/>
					<Suspense fallback={<SkeletonText lines={4} />}>
						<TerminalPanel task={task} locale={locale} role="agent" onRelay={onRelay} />
					</Suspense>
				</>
			) : (
				<Conversation
					onRelay={onRelay}
					onProposal={onProposal}
					task={task}
					locale={locale}
					contended={contended}
					notices={notices('composer')}
					reviewPending={reviewSummary.pending}
					onSendReview={
						(connected || resumable) && !reviewBusy
							? () => {
									void sendReview();
								}
							: null
					}
				/>
			)}
		</SurfaceBoundary>
	);
	const [deletion, setDeletion] = useState<{
		selection: { id: string; version: number }[];
		draft: string;
		count: number;
		files: number;
		hasNote: boolean;
	} | null>(null);
	function deleteReview() {
		setDeletion({
			selection: [...review.comments, ...(review.notes ?? [])].map(({ id, version }) => ({
				id,
				version,
			})),
			draft: generalDraft,
			count: reviewSummary.count,
			files: reviewSummary.fileCount,
			hasNote: Boolean(generalDraft.trim() || review.notes?.length),
		});
	}
	async function confirmDeleteReview() {
		if (!deletion) return;
		setReviewBusy(true);
		try {
			await window.brigadir.removeReviewSelection(task, deletion.selection);
			setTask((state) => ({
				generalDraft: state.generalDraft === deletion.draft ? '' : state.generalDraft,
			}));
			await reloadReview();
			setDeletion(null);
		} catch (error) {
			await reloadReview();
			throw error;
		} finally {
			setReviewBusy(false);
		}
	}

	const refreshControl = (
		<IconButton
			label={t(locale, 'Create snapshot and refresh changes')}
			onClick={() => {
				void window.brigadir
					.sendCommand(task, { kind: 'checkpoint' })
					.then(load, () => fail('Could not refresh the changes.'));
			}}>
			<Glyph name="refresh" size={14} />
		</IconButton>
	);
	const reviewDraft = Boolean(
		generalDraft.trim() || commentDraft?.text.trim() || editorDraft?.text.trim()
	);
	const reviewFooter = (
		<ReviewFooter
			compact={reviewCompact}
			onCompact={(reviewCompact) => setTask({ reviewCompact })}
			totalCount={reviewSummary.count}
			files={reviewSummary.fileCount}
			{...(!reviewOpen
				? {
						onOpenReview: () => setTask({ reviewOpen: true }),
						onDeleteAll: () => {
							void deleteReview();
						},
					}
				: {})}
			locale={locale}
			terminal={task.transport === 'terminal'}
			generalNote={generalDraft}
			onGeneralNote={(generalDraft) => setTask({ generalDraft })}
			onAddNote={() => {
				setReviewBusy(true);
				void window.brigadir
					.addReviewNote(task, generalDraft)
					.then(() => {
						setTask({ generalDraft: '' });
						return reloadReview();
					})
					.catch(() => fail('Could not add the note to the review.'))
					.finally(() => setReviewBusy(false));
			}}
			count={reviewSummary.pending}
			draft={reviewDraft}
			busy={reviewBusy}
			canSend={connected || resumable}
			onSend={() => {
				void sendReview();
			}}
		/>
	);
	// An empty review has no panel: it appears with the first comment, note or draft text.
	// spec/diff-and-review#footer: under the document; without one — the work area hidden, empty or not (spec/task-window-workspace#empty-work-area) — under the chat; with
	// neither of them on screen, under the task's empty state.
	const showReviewFooter = !mainTree && !reviewOpen && (reviewSummary.count > 0 || reviewDraft);
	const forge = useForge();
	/** spec/pull-requests-and-ci#pr-threads: a PR file is an editor diff tab (`File.tsx · #421`), scrolled to the thread's line or the summary. */
	const prDiffKey = (ref: { scopeId: string; number: number }, path: string) =>
		`pr:${ref.number}:${ref.scopeId}/${path}`;
	/**
	 * spec/pull-requests-and-ci#pr-files: a PR file opens its tab at the click. Until the diff comes, the tab and the diff area show that it is opening and
	 * why it waits (the first file of a PR may wait for `git fetch`); a failure stays in the diff area with «Retry». A second
	 * click on the same file does not read again; a click on another file replaces a tab that never got its diff, so a quick
	 * walk with the arrows (spec/pull-requests-and-ci#pr-keyboard) leaves one placeholder, and only the file clicked last opens.
	 */
	const [prFileOpening, setPRFileOpening] = useState<PROpening | null>(null),
		prFileRequest = useRef(''),
		prOpening = useRef<PROpening | null>(null);
	const showOpening = (value: PROpening | null) => {
		prOpening.current = value;
		setPRFileOpening(value);
	};
	async function openPRFile(
		ref: { scopeId: string; number: number },
		path: string,
		line: number | null,
		crumb?: PRCrumb,
		back?: string
	) {
		const request = prDiffKey(ref, path);
		if (prFileRequest.current === request) return;
		prFileRequest.current = request;
		const previous = prOpening.current;
		let placeholder = false;
		setTask((state) => {
			const superseded =
				previous &&
				previous.key !== request &&
				previous.placeholder &&
				!state.commitDiffs[previous.key]
					? closeDocument(state, `diff:${previous.key}`)
					: state;
			placeholder = !superseded.documents.some((tab) => tab.id === `diff:${request}`);
			const opened = selectDocument(superseded, documentForDiff(request));
			return {
				selected: request,
				surface: 'diff',
				documents: opened.documents,
				activeDocument: opened.activeDocument,
			};
		});
		const opening: PROpening = {
			...ref,
			path,
			key: request,
			phase: 'file',
			placeholder,
			retry: () => {
				void openPRFile(ref, path, line, crumb, back);
			},
		};
		showOpening(opening);
		const current = () => prFileRequest.current === request;
		try {
			// The branch phase shows only when the PR trees are not ready at once: main fetches the head and base then.
			const trees = window.brigadir.preparePullRequestTrees(task, ref);
			let ready = false;
			void trees.then(
				() => {
					ready = true;
				},
				() => {
					ready = true;
				}
			);
			const slow = setTimeout(() => {
				if (!ready && current()) showOpening({ ...opening, phase: 'branch' });
			}, 150);
			await trees.catch(() => {});
			clearTimeout(slow);
			if (current() && prOpening.current?.phase === 'branch')
				showOpening({ ...opening, phase: 'file' });
			const value = await window.brigadir.readPullRequestFileDiff(task, ref, path),
				key = prDiffKey(ref, value.file.path),
				entry = keepCommitDiff(task, key, value, {
					kind: 'pr',
					ref,
					path: value.file.path,
					revision: value.afterLabel ?? '',
					id: value.file.id,
				});
			if (!current()) {
				forgetCommitDiff(task, key, entry);
				return;
			}
			setTask((state) => {
				const commitDiffs = { ...state.commitDiffs, [key]: entry };
				if (!state.documents.some((tab) => tab.id === `diff:${request}`)) return { commitDiffs };
				// The person may have gone to another tab meanwhile: the diff waits in its tab and takes no focus.
				const active = state.activeDocument === `diff:${request}`;
				let tabs: { documents: DocumentTab[]; activeDocument: string | null } = state;
				if (key !== request) {
					const renamed = selectDocument(
						closeDocument(state, `diff:${request}`),
						documentForDiff(key)
					);
					tabs = active
						? renamed
						: { documents: renamed.documents, activeDocument: state.activeDocument };
				}
				return {
					commitDiffs,
					documents: tabs.documents,
					activeDocument: tabs.activeDocument,
					...(active
						? {
								selected: key,
								surface: 'diff' as const,
								prCrumb: crumb ? { key, ...crumb, overview: back ?? overviewKey(ref) } : null,
								...(line ? { diffLineTarget: line } : {}),
							}
						: {}),
				};
			});
			showOpening(null);
		} catch {
			if (current()) showOpening({ ...opening, phase: 'failed' });
		} finally {
			if (current()) prFileRequest.current = '';
		}
	}
	/** spec/pull-requests-and-ci#review-modal, spec/pull-requests-and-ci#hand-to-agent: a prompt to an existing task (the task of one's own PR); its host starts if it was asleep. */
	const deliver = deliverPrompt;
	const openToast = (text: string, target: AgentTask) =>
		showToast(
			text,
			target.id === task.id && target.projectId === task.projectId
				? undefined
				: { label: t(locale, 'Open'), run: () => onOpenTask(target) }
		);
	async function agentFix(
		ref: { scopeId: string; number: number },
		sendComments: boolean
	): Promise<boolean> {
		// spec/tasks#quick-tasks: in the main tree «To agent» is a quick task without isolation on the PR branch (it switches the tree if the tree is clean).
		if (mainTree) {
			try {
				onQuickTask?.(await prFixQuickTask(task, ref, locale));
				return true;
			} catch {
				fail('Could not read the pull request.');
				return false;
			}
		}
		try {
			const result = await window.brigadir.startPullRequestAgent(task, ref, 'fix', sendComments);
			void readReview(task, ref);
			void readDetail(task, ref, true);
			if (!result.created) await deliver(result.task, result.prompt);
			openToast(
				t(locale, '{n} handed to the agent').replace(
					'{n}',
					handedCount(locale, result.count, result.threads ?? 0)
				),
				result.task
			);
			return true;
		} catch {
			fail('Could not hand the fixes to the agent.');
			return false;
		}
	}
	/** spec/pull-requests-and-ci#review-launch: a failure stays in the launch dialog, so it answers false and shows nothing itself. */
	async function agentReview(
		ref: { scopeId: string; number: number },
		{ where, agent, crew, notes }: ReviewChoice,
		suggestions = false
	): Promise<boolean> {
		try {
			const result = await window.brigadir.startPullRequestAgent(
				task,
				ref,
				'review',
				false,
				where,
				crew ? null : agent,
				suggestions,
				crew,
				notes
			);
			// spec/pull-requests-and-ci#review-drafts: the new task opens the PR by the main-tree repo id; the clicked ref may carry another worktree's id.
			openTaskPR(result.task, {
				scopeId: result.task.prReview?.scopeId ?? ref.scopeId,
				number: ref.number,
			});
			const started = t(locale, 'The task «{title}» started').replace('{title}', result.task.title);
			// spec/pull-requests-and-ci#review-with-agent: from the review modal the modal steps aside and the review task opens.
			if (suggestions) {
				closeReview(task);
				if (result.task.id !== task.id || result.task.projectId !== task.projectId)
					onOpenTask(result.task);
				showToast(started);
			} else openToast(started, result.task);
			return true;
		} catch {
			return false;
		}
	}
	/**
	 * spec/pull-requests-and-ci#resolve-conflicts: «Resolve conflicts» — the base merges into the PR branch in that branch's task (or a new one). The task opens on the
	 * merge strip; a merge that went through by itself offers push at once. Returns the refusal reason in words, or null.
	 */
	async function resolveConflicts(
		ref: { scopeId: string; number: number },
		how: 'agent' | 'manual'
	): Promise<string | null> {
		try {
			const result = await window.brigadir.resolvePullRequestConflicts(task, ref, how);
			if (result.prompt) await deliver(result.task, result.prompt);
			await useWorkspace.getState().load();
			void readDetail(task, ref, true);
			if (result.status === 'up-to-date') {
				showToast(
					t(locale, 'The PR branch already has the base. GitHub updates the state shortly.')
				);
				return null;
			}
			if (result.status === 'merged') requestForgeAction(result.task, 'push', result.scopeId);
			// spec/appearance#evolution-redesign: the same Conflicts dialog, in the task on the PR branch.
			else openConflictsDialog(result.task, result.scopeId);
			if (result.task.id !== task.id || result.task.projectId !== task.projectId)
				onOpenTask(result.task);
			if (result.status === 'merged' || how === 'agent')
				showToast(
					t(
						locale,
						result.status === 'merged'
							? 'The merge went through by itself: push it to update the PR.'
							: 'The agent is resolving the conflict.'
					)
				);
			return null;
		} catch (error) {
			const reason =
				error instanceof Error
					? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
					: '';
			return reason && isMessageKey(reason)
				? t(locale, reason)
				: t(locale, 'Could not start resolving the conflict.');
		}
	}
	/**
	 * spec/pull-requests-and-ci#ci: a failed GitHub Actions job goes to an agent: the PR branch's task if there is one; in the main tree, a quick task on
	 * the run's branch; otherwise this task. The agent gets the run, job and step names and the annotation; it reads the log itself.
	 */
	async function ciFix(
		scopeId: string,
		detail: CIRunDetail,
		job: CIJob,
		step: CIStep | null,
		pr?: number
	) {
		await useWorkspace.getState().load();
		const run = detail.run;
		const owner = pr
			? (useWorkspace
					.getState()
					.workspace?.tasks.find(
						(item) =>
							item.projectId === task.projectId && item.pullRequests?.[scopeId]?.number === pr
					) ?? null)
			: null;
		const where = `${run.workflow} #${run.number} · ${job.name}`,
			note = detail.annotation?.jobId === job.id ? detail.annotation.message : '';
		const text = `The GitHub Actions run "${run.workflow}" #${run.number} on ${run.branch || 'its branch'} (commit ${run.sha.slice(0, 7)}) failed in job "${job.name}"${step ? ` at step ${step.number} "${step.name}"` : ''}. Read the failed log with \`gh run view ${run.id} --log-failed\`, find the cause and fix it. Do not push: the person confirms the push.`;
		const body = `${where}${step ? ` · ${step.name}` : ''}\n${run.link}${note ? `\nAnnotation: ${note}` : ''}`;
		try {
			if (owner) {
				await deliver(owner, text, { name: where, text: body });
				openToast(t(locale, 'The failure is with the agent'), owner);
				return;
			}
			if (mainTree && onQuickTask) {
				onQuickTask({
					scopeId,
					title: `${t(locale, 'Fixes')} · ${job.name}`,
					prompt: text,
					branch: run.branch,
					context: [{ icon: 'github', label: where, text: body }],
				});
				return;
			}
			await deliver(task, text, { name: where, text: body });
			openToast(t(locale, 'The failure is with the agent'), task);
		} catch {
			fail('Could not hand the failure to the agent.');
		}
	}
	/** spec/pull-requests-and-ci#hand-to-agent: a reviewer's threads on one's own PR go to the PR's task as a message with an «N comments · #N» attachment. */
	async function handThreads(
		detail: PullRequestDetail,
		ref: { scopeId: string; number: number },
		threads: PRThread[]
	) {
		// The task's PR record may have just appeared (recordPullRequest): look the PR's task up in the fresh workspace.
		await useWorkspace.getState().load();
		const owner =
			useWorkspace
				.getState()
				.workspace?.tasks.find(
					(item) =>
						item.projectId === task.projectId &&
						item.pullRequests?.[ref.scopeId]?.number === ref.number
				) ?? null;
		const authors = [
				...new Set(threads.map((thread) => thread.comments[0]?.author).filter(Boolean)),
			].join(', '),
			body = threads
				.map(
					(thread) =>
						`- ${thread.path}:${thread.line ?? '?'}\n${thread.comments.map((comment) => `  ${comment.author}: ${comment.body.replace(/\n/g, '\n  ')}`).join('\n')}`
				)
				.join('\n');
		const text = `Address the review from ${authors || 'the reviewers'} on PR #${ref.number} "${detail.summary.title}". Change the code where the comments ask for it; for the rest, draft a reply. Do not push: the person confirms the push.`;
		if (mainTree && !owner) {
			onQuickTask?.({
				scopeId: ref.scopeId,
				title: t(locale, 'Reply to the review #{n}').replace('{n}', String(ref.number)),
				prompt: text,
				branch: detail.summary.head,
				context: [
					{
						icon: 'github',
						label: `${commentCount(locale, threads.length)} · #${ref.number}`,
						text: body,
					},
					{
						icon: 'pr-branch',
						label: `PR #${ref.number} · ${detail.summary.head}`,
						text: `Pull request #${ref.number}: ${detail.summary.head} → ${detail.summary.base}.`,
					},
				],
			});
			setTask((state) => ({
				prHanded: [...new Set([...state.prHanded, ...threads.map((thread) => thread.id)])],
			}));
			return;
		}
		try {
			if (owner) {
				await deliver(owner, text, {
					name: `${commentCount(locale, threads.length)} · #${ref.number}`,
					text: body,
				});
				openToast(
					t(locale, '{n} handed to the agent').replace('{n}', commentCount(locale, threads.length)),
					owner
				);
			} else {
				for (const thread of threads)
					await window.brigadir.addPullRequestDraft(task, ref, {
						path: thread.path,
						side: thread.side,
						line: thread.line ?? 1,
						startLine: null,
						body: thread.comments.map((comment) => `${comment.author}: ${comment.body}`).join('\n'),
						replyTo: thread.comments[0]!.databaseId,
					});
				await agentFix(ref, false);
			}
			setTask((state) => ({
				prHanded: [...new Set([...state.prHanded, ...threads.map((thread) => thread.id)])],
			}));
		} catch {
			fail('Could not hand the threads to the agent.');
		}
	}
	function openHistoryDiff(key: string, value: FileDiff, source: CommitDiffSource) {
		const entry = keepCommitDiff(task, key, value, source);
		setTask((state) => ({
			commitDiffs: { ...state.commitDiffs, [key]: entry },
			selected: key,
			surface: 'diff',
		}));
	}
	/** spec/pull-requests-and-ci#pr-overview: the PR Overview is an editor tab `Overview · #421`; the document key carries the repo and the number. */
	const overviewKey = (ref: { scopeId: string; number: number }) =>
		`overview:${ref.number}:${ref.scopeId}/overview`;
	const selectedOverview = selected?.startsWith('overview:')
		? (([, number, rest]) => ({
				number: Number(number),
				scopeId: rest!.slice(0, rest!.lastIndexOf('/')),
			}))(selected.split(/:(.*?):/))
		: null;
	const selectedPR = selected?.startsWith('pr:')
		? (([, number, rest]) => ({
				number: Number(number),
				scopeId: rest!.slice(0, rest!.indexOf('/')),
			}))(selected.split(/:(.*?):/))
		: null;
	// spec/editor#reopen-closed-tab: a PR file whose path is in the task's own tree (the repo's folder + the path) opens there on F4.
	const prRepo = selectedPR && changes?.scopes.find((scope) => scope.id === selectedPR.scopeId),
		prSourcePath =
			prRepo && diff && !diff.file.gitlink && diff.file.after
				? prRepo.path
					? `${prRepo.path}/${diff.file.path}`
					: diff.file.path
				: null;
	const [prSource, setPrSource] = useState<{ path: string; id: string } | null>(null);
	useEffect(() => {
		if (!prSourcePath) return;
		let current = true;
		void window.brigadir.readFileLinks(task, [{ text: prSourcePath, literal: true }]).then(
			([links]) => {
				const link = links?.find((item) => item.path === prSourcePath && !item.folder);
				if (current) setPrSource(link ? { path: prSourcePath, id: link.id } : null);
			},
			() => {
				if (current) setPrSource(null);
			}
		);
		return () => {
			current = false;
		};
	}, [prSourcePath, task.id, task.projectId]);
	const prJump =
		prSource && prSource.path === prSourcePath
			? (line?: number) => {
					void openEditor(prSource.id, false, line, undefined, prSource.path);
				}
			: undefined;
	/** A git change of the task (a checkpoint, the changed files): History, the conflicts banner and dialog read again. */
	const changesKey = `${changes?.checkpoint ?? ''}:${changes?.files.map((file) => file.id).join(',') ?? ''}`;
	// spec/appearance#evolution-redesign: each repo of the task is a root of Changes with its files under it; «Add folder…» ends the list.
	const repoScopes = repos?.data?.scopes;
	const fileRows = useMemo(() => {
		const rows: (
			| { id: string; scope: Scope; repo?: RepoScope }
			| { id: string; file: ChangedFile }
			| { id: 'add-folder'; add: true }
		)[] = [];
		// A repo the changes know and the repo read does not (a released worktree, a read that failed) keeps its old header.
		const roots: (Scope & { repo?: RepoScope })[] = [
			...(repoScopes ?? []).map((repo) => ({ ...repo, repo })),
			...(changes?.scopes ?? []).filter(
				(scope) => !repoScopes?.some((repo) => repo.id === scope.id)
			),
		];
		for (const scope of roots) {
			const files = (changes?.files ?? []).filter(
				(f) =>
					f.scopeId === scope.id && f.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
			);
			if (
				scope.repo ||
				files.length ||
				forge?.data?.scopes.some((item) => item.scope.id === scope.id && item.git.remote)
			) {
				rows.push({ id: `scope-${scope.id}`, scope, ...(scope.repo ? { repo: scope.repo } : {}) });
				if (!changesFolded.has(scope.id))
					rows.push(...files.map((file) => ({ id: file.id, file })));
			}
		}
		if (repos && !repos.mainTree) rows.push({ id: 'add-folder', add: true });
		return rows;
	}, [changes, filter, forge?.data, repoScopes, changesFolded, repos?.mainTree]);
	const shownInToolbar = (key: OverflowKey) =>
		toolbarPresent.includes(key) && !toolbarFit.step.out.includes(key);
	const accelerator = (id: string) => {
		const command = menuCommands.find((item) => item.id === id),
			key = command && commandAccelerator(command, keymap);
		return key ? formatAccelerator(key) : undefined;
	};
	// spec/task-window-workspace#work-area: in a narrow toolbar «…» holds only Commands and Agents, in the toolbar's order.
	const moreEntries: MoreEntry[] = [];
	if (toolbarFit.step.out.includes('commands') && modules.commands)
		moreEntries.push({
			key: 'commands',
			section: t(locale, 'Toolbar'),
			label: t(locale, 'Commands'),
			icon: 'command-play',
			kbd: accelerator('commands'),
			kind: 'action',
			hands: true,
			run: () => window.brigadir.dispatchWorkspaceAction('commands'),
		});
	if (toolbarFit.step.out.includes('agents') && agentsEntry)
		moreEntries.push({
			key: 'agents',
			...(moreEntries.length ? {} : { section: t(locale, 'Toolbar') }),
			label: t(locale, 'Agents in work'),
			icon: 'activity',
			tail: agentsEntry.count,
			kind: 'action',
			hands: true,
			run: (anchor) => agentsEntry.show(anchor),
		});
	// spec/task-window-workspace#work-area: the task's tools — the Tools button's count and list, its agent dot, the strips' «+ ▾».
	// spec/settings-modules-and-onboarding#module-off, spec/task-window-workspace#work-area: a module switched off hides its tabs (they come back with it); its pages leave main meanwhile.
	const tabOn = (tab: DocumentTab) =>
		!(tab.kind === 'browser' && !modules.browser) &&
		!(tab.kind === 'simulator' && !modules.simulator);
	const tools = toolTabs(groups).filter(tabOn);
	const browserInfo = useTaskBrowserTabs(task);
	const toolsAgent = useAgentOnTools(task, tools);
	/**
	 * spec/editor#new-file: New file… at `anchor` — prefilled with the folder selected in Files, else the active file's, else the folder of
	 * the file selected in Files; the root otherwise.
	 */
	const [newFile, setNewFile] = useState<{
		anchor: RefObject<HTMLElement | null>;
		initial: string;
	} | null>(null);
	function openNewFile(anchor: RefObject<HTMLElement | null>, folder?: string) {
		const state = parkedTaskState(task);
		const entry = (id: string | null) =>
			id
				? Object.values(state?.fileChildren ?? {})
						.flat()
						.find((item) => item.id === id)
				: undefined;
		const selected = entry(state?.fileSelection ?? null),
			active = state?.documents.find((tab) => tab.id === state.activeDocument),
			activePath = active?.kind === 'file' && !/^[~/]/.test(active.path) ? active.path : null;
		const initial =
			folder ??
			(selected?.kind === 'directory' && state?.panelShown && state.panel === 'files'
				? newFileFolder(selected.path, 'directory')
				: activePath
					? newFileFolder(activePath)
					: selected
						? newFileFolder(selected.path, selected.kind === 'directory' ? 'directory' : 'file')
						: '');
		setToolsOpen(false);
		setNewFile({ anchor, initial });
	}
	const newFileNow = useRef(openNewFile);
	newFileNow.current = openNewFile;
	// spec/editor#new-file: the Files tree's «New file…» on a folder or a file.
	useEffect(() => {
		const listen = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					projectId: string;
					id: string;
					folder: string;
					anchor: HTMLElement | null;
				}>
			).detail;
			if (detail.projectId !== task.projectId || detail.id !== task.id) return;
			newFileNow.current({ current: detail.anchor ?? toolbarTools().current }, detail.folder);
		};
		addEventListener('brigadir:new-file', listen);
		return () => removeEventListener('brigadir:new-file', listen);
	}, [task.projectId, task.id]);
	const rootScope =
		(changes?.scopes ?? []).length > 1
			? ((changes?.scopes ?? []).find((scope) => scope.kind === 'root')?.name ?? null)
			: null;
	/** spec/task-window-workspace#empty-work-area: the empty state's rows — each runs the command of its menu item. */
	const emptyActions: EmptyPlaceAction[] = [
		...(mainTree
			? []
			: [
					{
						id: 'show-chat',
						icon: <Glyph name="layout-chat-off" size={14} />,
						label: t(locale, 'Show the chat'),
						kbd: accelerator('layout-chat'),
						run: () => toggleLayout('chat'),
					},
				]),
		{
			id: 'new-file',
			icon: <Glyph name="file-new" size={14} />,
			label: t(locale, 'New file…'),
			kbd: accelerator('new-file'),
			run: (row) => openNewFile({ current: row }),
		},
		{
			id: 'quick-open',
			icon: <Glyph name="search" size={14} />,
			label: t(locale, 'Open Quickly…'),
			kbd: accelerator('quick-open-alias'),
			run: () => window.brigadir.dispatchWorkspaceAction('quick-open'),
		},
		...(mainTree && modules.browser
			? [
					{
						id: 'browser',
						icon: <Glyph name="browser" size={14} />,
						label: t(locale, 'New browser'),
						kbd: accelerator('browser'),
						run: () => void openTool('browser'),
					},
				]
			: []),
	];
	const toolsMenu = {
		task,
		tabs: tools,
		place: toolPlace,
		onPlace: (toolPlace: 'focused' | 'bottom') => setTask({ toolPlace }),
		onNew: (kind: ToolTabKind) => {
			void openTool(kind);
		},
		onNewFile: (anchor: RefObject<HTMLElement | null>) => openNewFile(anchor),
		onReveal: (tab: DocumentTab) => showTaskTool(task, tab),
		modules: { browser: modules.browser, simulator: modules.simulator },
		kbd: accelerator,
	};
	// The agent's minute on a browser tab runs out on its own: the strip re-reads it every second while one lingers.
	const lingering = tools.some(
		(tab) =>
			tab.kind === 'browser' &&
			!!browserInfo?.[tab.target]?.agent?.last &&
			!browserInfo[tab.target]!.agent!.acting
	);
	const tick = useSecondTick(lingering);
	/** A tool tab live in its group, focused or not: the terminal, the page, the device. */
	const toolSurface = (tab: DocumentTab, group: EditorGroup) => (
		<SurfaceBoundary
			surface={
				tab.kind === 'terminal' ? 'console' : tab.kind === 'browser' ? 'browser' : 'simulator'
			}
			locale={locale}
			resetKey={tab.id}>
			{tab.kind === 'terminal' ? (
				<Suspense fallback={<SkeletonText lines={4} />}>
					<TerminalPanel
						key={tab.id}
						task={task}
						locale={locale}
						session={tab.target}
						{...(Object.hasOwn(terminalRestored, tab.target)
							? {
									restored: { directory: terminalRestored[tab.target] ?? null },
									// spec/task-window-workspace#restore-window: the new shell takes the ended session's place in its group.
									onReopen: (item: TerminalInfo) => {
										runGroups((groups) =>
											replaceTab(groups, tab.id, documentForTerminal(item.id, item.title))
										);
										setTask((state) => {
											const terminalRestored = { ...state.terminalRestored };
											delete terminalRestored[tab.target];
											return { terminalRestored };
										});
									},
								}
							: {})}
						onClosed={() => dropTool(tab.id)}
						onStep={(step) => {
							const terminals = group.documents.filter((item) => item.kind === 'terminal');
							const index = terminals.findIndex((item) => item.id === tab.id),
								next = terminals[(index + step + terminals.length) % terminals.length];
							if (next) runGroups((groups) => revealTab(groups, next.id));
						}}
					/>
				</Suspense>
			) : tab.kind === 'browser' ? (
				<BrowserPanel
					key={tab.id}
					task={task}
					locale={locale}
					tab={tab.target}
					{...(mainTree
						? {}
						: {
								onChat: () =>
									setTask({ chatShown: true, surface: 'chat', activityTarget: 'browser-tools' }),
							})}
				/>
			) : (
				<SimulatorPanel key={tab.id} task={task} locale={locale} />
			)}
		</SurfaceBoundary>
	);
	// spec/editor#editor-groups: editor groups. The focused group is the live documents surface; the others show their tab passively.
	const closingNotice = closing.length > 0 && (
		// Closing with unsaved changes: the strip over the editor in the row's S, Discard solid red.
		<div role="alert" className={editorStyles.notice} data-size="s" data-closing-notice>
			{t(locale, 'There are unsaved changes.')}{' '}
			{closing.map((model) => model.document.path).join(', ')}{' '}
			<Button onClick={() => setClosing([])}>{t(locale, 'Keep editing')}</Button>{' '}
			<Button
				appearance="danger"
				variant="solid"
				disabled={closing.some((model) => model.saving)}
				onClick={() => {
					for (const model of closing) void closeEditor(model);
				}}>
				{t(locale, 'Discard changes')}
			</Button>
		</div>
	);
	const liveDocument = (
		<SurfaceBoundary surface="documents" locale={locale} resetKey={activeDocument ?? ''}>
			{documentSurface === 'tool' ? null : documentSurface === 'editor' ? (
				activeBuffer ? (
					<CodeEditor
						key={activeBuffer.document.id}
						model={activeBuffer}
						task={task}
						locale={locale}
						agentBusy={agentBusy}
						changed={changed}
						onReviewChanged={reloadReview}
						onCompose={compose}
					/>
				) : evictedActive ? (
					<SkeletonText lines={12} />
				) : (
					<p className={editorStyles.empty}>{t(locale, 'Select a file')}</p>
				)
			) : selectedOverview ? (
				<PROverview
					key={selected!}
					task={task}
					target={selectedOverview}
					locale={locale}
					projectName={projectName}
					links={{
						openFile: (path, line, crumb) => {
							void openPRFile(selectedOverview, path, line, crumb);
						},
						openCommitFile: (sha, value, fileId) =>
							openHistoryDiff(
								`history:${sha.slice(0, 7)}:${selectedOverview.scopeId}/${value.file.path}`,
								value,
								{ kind: 'history', scopeId: selectedOverview.scopeId, sha, id: fileId }
							),
						resolveConflicts: (how) => resolveConflicts(selectedOverview, how),
						handToAgent: async (text) => {
							const owner =
								useWorkspace
									.getState()
									.workspace?.tasks.find(
										(item) =>
											item.projectId === task.projectId &&
											item.pullRequests?.[selectedOverview.scopeId]?.number ===
												selectedOverview.number
									) ?? task;
							try {
								await deliver(owner, text);
								openToast(t(locale, 'Handed to the agent'), owner);
								return true;
							} catch {
								fail('Could not send the text to the agent.');
								return false;
							}
						},
					}}
				/>
			) : selectedPR && !commitDiff && prFileOpening?.key === selected ? (
				<PRFileOpening opening={prFileOpening} locale={locale} />
			) : loading ? (
				<SkeletonText lines={12} />
			) : diff && selectedPR ? (
				<PRDiffView
					key={diff.file.id}
					task={task}
					target={selectedPR}
					diff={diff}
					locale={locale}
					onCompose={compose}
					onDeliver={(text, to) => deliver(to, text)}
					crumb={prCrumb?.key === selected ? prCrumb : null}
					onJumpToSource={prJump}
					onBack={() => {
						if (prCrumb)
							setTask({
								selected: prCrumb.overview,
								surface: 'diff',
								...(prCrumb.from ? { diffLineTarget: prCrumb.from.line } : {}),
							});
					}}
					onGoTo={(place, word, from) => {
						void openPRFile(
							selectedPR,
							place.path,
							place.line,
							{
								text: word,
								start: place.line,
								end: place.line,
								from: { path: diff.file.path, line: from },
							},
							selected ?? undefined
						);
					}}
				/>
			) : diff ? (
				<DiffView
					key={diff.file.id}
					diff={diff}
					locale={locale}
					task={task}
					canOpenEditor={!selected?.startsWith('history:')}
					onOpenEditor={(line) => {
						if (selected?.startsWith('history:')) return;
						if (commitDiff)
							void window.brigadir
								.openCommitFile(task, commitDiff.revision, diff.file.id)
								.then((document) => openTaskEditor(task, document, line))
								.catch(() => fail('Could not open {file}.', { file: fileName(diff.file.path) }));
						else
							void openEditor(
								diff.file.id,
								true,
								line,
								line === undefined ? (diffPreview ? 'preview' : 'code') : 'code'
							);
					}}
					onDefinition={
						commitDiff || selected?.startsWith('history:') || diff.baseLabel
							? undefined
							: (line, column, text) => {
									void window.brigadir
										.openDiffFile(task, diff.file.id)
										.then((document) => openTaskEditor(task, document, line, column, { text }))
										.catch(() =>
											fail('Could not open {file}.', { file: fileName(diff.file.path) })
										);
								}
					}
					onRevert={() => {
						void window.brigadir.revertFile(task, diff.file.id).then(
							() => load(),
							() => fail('Could not revert {file}.', { file: fileName(diff.file.path) })
						);
					}}
					comments={commitDiff ? [] : review.comments}
					onReviewChanged={reloadReview}
					onCompose={compose}
				/>
			) : (
				<p className={styles.empty}>
					{t(
						locale,
						changes?.files.length
							? 'Select a file'
							: changes?.checkpoint === null
								? 'No Git snapshots'
								: 'No changes'
					)}
				</p>
			)}
		</SurfaceBoundary>
	);
	/**
	 * spec/task-window-workspace#two-columns: the pinned Chat tab of two columns — no ×, not dragged, never scrolled away.
	 * Its glyph says what the agent does while a file is shown: the chat bubble, the spinner, amber with a dot while it waits
	 * for the person, an accent dot for a turn the person has not seen.
	 */
	const chatTabNode = (group: EditorGroup, focused: boolean) => {
		const state = chatInTab ? 'idle' : chatTabShows;
		const key = accelerator('layout-chat');
		return (
			<div
				className={`${tabStripStyles.tab} ${tabStripStyles.pin}`}
				data-chat-tab
				data-active={chatInTab}
				data-state={state}>
				<button
					role="tab"
					aria-selected={chatInTab}
					tabIndex={chatInTab ? 0 : -1}
					aria-label={`${t(locale, 'Chat')}${
						state === 'waiting'
							? ` · ${t(locale, 'Needs you')}`
							: state === 'running'
								? ` · ${t(locale, 'Working')}`
								: state === 'unread'
									? ` · ${t(locale, 'Unread')}`
									: ''
					}`}
					title={`${t(locale, 'Chat')}${key ? ` · ${key}` : ''}`}
					onClick={() =>
						setTask((current) => ({
							...(focused ? {} : applyGroups(focusGroup(groupsNow(current), group.id))),
							chatTab: true,
						}))
					}>
					<span className={tabStripStyles.glyph} data-pin-glyph={state}>
						<Glyph
							name={
								state === 'waiting'
									? 'agent-permission'
									: state === 'running'
										? 'agent-spinner'
										: 'chat'
							}
							size={14}
						/>
					</span>
					<span className={tabStripStyles.label}>
						<span className={tabStripStyles.name}>{t(locale, 'Chat')}</span>
					</span>
					{(state === 'waiting' || state === 'unread') && (
						<span className={tabStripStyles.pinDot} data-state={state} aria-hidden="true" />
					)}
				</button>
			</div>
		);
	};
	const documentTabStrip = (group: EditorGroup, focused: boolean) => {
		const shownTabs = group.documents.filter(tabOn),
			// spec/appearance#evolution-redesign: namesakes of this strip get the folder tail that tells them apart.
			tails = documentTabTails(shownTabs);
		// spec/task-window-workspace#two-columns: the first group of two columns starts with the pinned Chat tab; its own tabs scroll after a divider.
		// The pinned row is the tablist then (the Chat tab is one of its tabs); its own tabs scroll in a run inside it.
		const pinned = !!chatHome && chatHome.id === group.id,
			shownId = pinned && chatInTab ? null : group.activeDocument;
		const stripKeys = (event: React.KeyboardEvent<HTMLElement>) => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
			const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
			const index = tabs.indexOf(event.target as HTMLButtonElement);
			if (index < 0) return;
			event.preventDefault();
			const next =
				event.key === 'Home'
					? 0
					: event.key === 'End'
						? tabs.length - 1
						: (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
			tabs[next]?.click();
			tabs[next]?.focus();
		};
		const strip = (
			<div
				ref={pinned ? pinnedStrip : focused ? documentStrip : undefined}
				className={
					pinned
						? `${tabStripStyles.tabs} ${tabStripStyles.run} ${tabStripStyles.fade}`
						: `${tabStripStyles.tabs} ${tabStripStyles.documents}`
				}
				data-size="m"
				data-group-focused={focused}
				onDragOver={(event) => stripDragOver(event, group)}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null))
						setStripTarget(null);
				}}
				onDrop={(event) => stripDrop(event, group)}
				{...(pinned
					? {}
					: { role: 'tablist', 'aria-label': t(locale, 'Documents'), onKeyDown: stripKeys })}>
				{shownTabs.map((tab, index) => {
					const buffer =
						tab.kind === 'file'
							? editorTabs.find((model) => model.document.id === tab.target)
							: null;
					const overview = tab.target.startsWith('overview:') ? tab.target.split(':')[1] : null,
						prFile = tab.target.startsWith('pr:') ? tab.target.split(':')[1] : null,
						commit = tab.target.startsWith('history:') ? tab.target.split(':')[1] : null,
						tail = tails.get(tab.id),
						opening =
							!!(prFile || overview) &&
							prFileOpening?.key === tab.target &&
							prFileOpening.phase !== 'failed';
					// spec/task-window-workspace#work-area: a browser tab the agent acts on, or just acted on.
					const agent = tab.kind === 'browser' ? browserInfo?.[tab.target]?.agent : undefined,
						mark = agent ? agentMark(agent, tick || Date.now()) : null,
						tool = isToolTab(tab) ? toolTabName(locale, tab, browserInfo) : null;
					const step = agent && (agent.waiting ?? agent.acting ?? agent.step);
					// spec/browser-and-simulator#tab-sound: a browser tab that plays sound, or that the person muted, shows the speaker.
					const sound = tab.kind === 'browser' ? browserInfo?.[tab.target] : undefined;
					return (
						<div
							key={tab.id}
							className={tabStripStyles.tab}
							data-tool={isToolTab(tab) ? tab.kind : undefined}
							data-agent={mark ?? undefined}
							data-document-tab
							data-active={shownId === tab.id}
							data-dirty={!!buffer?.dirty && !buffer.saving}
							data-drop-before={
								(stripTarget?.group === group.id && stripTarget.index === index) || undefined
							}
							draggable
							onDragStart={(event) =>
								startTabDrag(event, { group: group.id, tab: tab.id }, tab.path)
							}
							onDragEnd={() => {
								endTabDrag();
								setStripTarget(null);
							}}
							onMouseDown={(event) => {
								if (event.button === 1) event.preventDefault();
							}}
							onAuxClick={(event) => {
								if (event.button !== 1) return;
								event.preventDefault();
								if (!buffer?.saving) inGroup(group, () => closeDocumentTab(tab, buffer));
							}}
							onContextMenu={(event) => {
								event.preventDefault();
								inGroup(group, () => documentTabMenu(tab, null, group.documents));
							}}
							onKeyDown={(event) => {
								if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
									event.preventDefault();
									event.stopPropagation();
									const box = event.currentTarget.getBoundingClientRect();
									inGroup(group, () =>
										documentTabMenu(tab, { x: box.left, y: box.bottom }, group.documents)
									);
								}
							}}>
							<button
								role="tab"
								aria-selected={shownId === tab.id}
								tabIndex={shownId === tab.id ? 0 : -1}
								aria-label={
									tool ??
									(overview
										? `${t(locale, 'Overview')} · #${overview}`
										: tab.kind === 'diff'
											? `${t(locale, 'Diff')} · ${tab.path}`
											: tab.path)
								}
								// spec/appearance#evolution-redesign: the whole path from the repo's root on every tab.
								title={
									mark && step
										? `${t(locale, 'Agent in the browser')} · ${agentStepText(locale, step, mark === 'waiting')}`
										: (tool ?? (overview ? `${t(locale, 'Overview')} · #${overview}` : tab.path))
								}
								onClick={() => {
									if (focused) activateDocument(tab);
									else
										runGroups((groups) =>
											dropTab(groups, group.id, tab.id, { group: group.id, at: 'center' }, false)
										);
									// spec/task-window-workspace#two-columns: a tab of the chat's group takes the group back from the Chat tab.
									if (pinned) setTask({ chatTab: false });
								}}>
								{opening ? (
									<span
										className={tabStripStyles.opening}
										data-opening
										role="img"
										aria-label={t(locale, 'Opening…')}>
										<Glyph name="check-run" size={12} />
									</span>
								) : overview ? (
									<span className={tabStripStyles.glyph}>
										<Glyph name="pr-branch" size={14} />
									</span>
								) : tab.kind === 'diff' && !prFile && !commit ? (
									<span className={tabStripStyles.diffSign}>±</span>
								) : isToolTab(tab) ? (
									mark === 'acting' || mark === 'waiting' ? (
										<span className={tabStripStyles.glyph}>
											<Glyph name="agent-spinner" size={12} />
										</span>
									) : (
										<span className={tabStripStyles.glyph}>
											<Glyph name={toolGlyph[tab.kind]} size={12} />
										</span>
									)
								) : (
									<FileIcon name={tab.path.split('/').at(-1) ?? tab.path} />
								)}
								<span className={tabStripStyles.label}>
									<span className={tabStripStyles.name}>
										{tool ?? (overview ? t(locale, 'Overview') : tab.path.split('/').at(-1))}
									</span>
									{/* The marks keep `…/` before the folder while the tail gives way from its head. */}
									{tail && <span className={tabStripStyles.tail}>{`‎${tail}‎`}</span>}
								</span>
								{(mark === 'acting' || mark === 'waiting') && (
									<span className={tabStripStyles.agentTag}>{t(locale, 'agent (tab)')}</span>
								)}
								{mark === 'recent' && (
									<span
										className={tabStripStyles.agentDot}
										role="img"
										aria-label={t(locale, 'Agent in the browser')}
									/>
								)}
								{(overview || prFile) && (
									<small className={tabStripStyles.mark}>#{overview ?? prFile}</small>
								)}
								{commit && <small className={tabStripStyles.mark}>@{commit}</small>}
								{(buffer
									? conflictMarked(buffer.state.doc)
									: tab.kind === 'file' && evictedEditors.get(tab.target)?.conflict) && (
									<span
										className={tabStripStyles.conflictDot}
										role="img"
										aria-label={t(locale, 'Conflict place')}
									/>
								)}
								{/* Unsaved: a dot in the ×'s place (the × comes back under the pointer). */}
								{buffer?.dirty && !buffer.saving && (
									<span
										className={tabStripStyles.dirty}
										role="img"
										aria-label={t(locale, 'Unsaved')}
									/>
								)}
							</button>
							{sound && (sound.audible || sound.muted) && (
								<button
									className={tabStripStyles.sound}
									data-muted={sound.muted}
									aria-label={t(locale, sound.muted ? 'Unmute tab' : 'Mute tab')}
									title={t(locale, sound.muted ? 'Unmute tab' : 'Mute tab')}
									onClick={() => {
										void window.brigadir
											.browserCommand(task, {
												kind: 'mute',
												muted: !sound.muted,
												tab: tab.target,
											})
											.catch(() => {});
									}}>
									<Glyph name={sound.muted ? 'speaker-muted' : 'speaker'} size={12} />
								</button>
							)}
							<button
								className={tabStripStyles.close}
								disabled={buffer?.saving}
								aria-label={`${t(
									locale,
									tab.kind === 'terminal'
										? 'Close terminal'
										: isToolTab(tab)
											? 'Close tab'
											: tab.kind === 'diff'
												? 'Close diff'
												: 'Close file'
								)} · ${tool ?? tab.path}`}
								onClick={() => inGroup(group, () => closeDocumentTab(tab, buffer))}>
								<Glyph name="close" size={9} />
							</button>
						</div>
					);
				})}
				{stripTarget?.group === group.id && stripTarget.index === group.documents.length && (
					<span className={tabStripStyles.dropEnd} />
				)}
				<StripTools
					group={group.id}
					locale={locale}
					hint={shortcutHint(t(locale, 'Task tools'), 'tools')}
					menu={toolsMenu}
					onNew={(kind) => {
						runGroups((groups) => focusGroup(groups, group.id));
						void openTool(kind, 'focused');
					}}
				/>
			</div>
		);
		return pinned ? (
			<div
				className={`${tabStripStyles.tabs} ${tabStripStyles.documents} ${tabStripStyles.pinned}`}
				data-size="m"
				data-group-focused={focused}
				role="tablist"
				aria-label={t(locale, 'Documents')}
				onKeyDown={stripKeys}>
				{chatTabNode(group, focused)}
				{/* spec/task-window-workspace#two-columns (chat only): no file tabs — Tools follows the Chat tab without a divider. */}
				{group.documents.length > 0 && (
					<span className={tabStripStyles.pinSep} aria-hidden="true" />
				)}
				{strip}
			</div>
		) : (
			strip
		);
	};
	const passiveDocument = (group: EditorGroup) => {
		const tab = group.documents.find((item) => item.id === group.activeDocument),
			activate = () => runGroups((groups) => focusGroup(groups, group.id));
		if (!tab) return <p className={editorStyles.empty}>{t(locale, 'Select a file')}</p>;
		if (isToolTab(tab))
			return tabOn(tab) ? (
				toolSurface(tab, group)
			) : (
				<p className={editorStyles.empty}>{t(locale, 'Select a file')}</p>
			);
		if (tab.kind === 'file') {
			const model = editorTabs.find((item) => item.document.id === tab.target);
			return model ? (
				<PassiveEditor
					key={`${group.id}:${tab.id}`}
					task={task}
					model={model}
					label={tab.path}
					onActivate={activate}
				/>
			) : (
				<SkeletonText lines={12} />
			);
		}
		const changed = changes?.files.find((item) => `${item.scopeId}/${item.path}` === tab.target);
		return (
			<PassiveDiff
				key={`${group.id}:${tab.id}`}
				task={task}
				locale={locale}
				target={tab.target}
				entry={commitDiffs[tab.target]}
				fileId={changed?.id}
				label={tab.path}
				onActivate={activate}
			/>
		);
	};
	const documentGroup = (group: EditorGroup) => {
		const focused = group.id === groups.focused,
			shown = group.documents.find((item) => item.id === group.activeDocument),
			shownTool = shown && isToolTab(shown) && tabOn(shown) ? shown : null,
			off = !!shown && !tabOn(shown),
			// spec/task-window-workspace#two-columns: the Chat tab chosen — the group shows the transcript and the composer, 760 px at most, centred.
			chatHere = chatInTab && chatHome?.id === group.id;
		return (
			<div
				key={group.id}
				className={groupStyles.group}
				role="group"
				aria-label={t(locale, 'Editor group')}
				data-editor-group={group.id}
				data-focused={focused}>
				{documentTabStrip(group, focused)}
				{focused && closingNotice}
				<div
					className={groupStyles.body}
					onMouseDownCapture={() => {
						if (!focused && (shownTool || chatHere))
							runGroups((groups) => focusGroup(groups, group.id));
					}}>
					{chatHere ? (
						<div className={styles.chatTab} data-task-chat data-chat-tab-body>
							<div className={styles.chatTabColumn}>{chat}</div>
						</div>
					) : focused ? (
						shownTool ? (
							toolSurface(shownTool, group)
						) : off ? (
							<p className={editorStyles.empty}>{t(locale, 'Select a file')}</p>
						) : (
							liveDocument
						)
					) : (
						passiveDocument(group)
					)}
					<GroupDropTarget
						group={group.id}
						locale={locale}
						// spec/task-window-workspace#work-area: the group under the chat goes back whole (the work area's own target); a split
						// inside it would take it out from under the chat, so its document takes no tab — its strip does.
						accepts={(from) => !underChat || (group.id !== bottom?.id && !fromBottom(from))}
						onDrop={(drop, copy) => {
							const from = draggedTab();
							endTabDrag();
							if (from) runGroups((groups) => dropTab(groups, from.group, from.tab, drop, copy));
						}}
					/>
				</div>
			</div>
		);
	};
	const content = (
		<section
			ref={view}
			className={styles.task}
			data-menu-task="true"
			data-menu-review={
				(connected || resumable) && reviewSummary.pending > 0 && !reviewBusy && showReviewFooter
			}
			data-menu-running={agentBusy || task.status === 'preparing'}
			data-menu-documents={middleShown ? openTabs.length : 0}
			data-menu-reopen={canReopen}
			// spec/task-window-workspace#two-columns: View ▸ Layout ▸ Chat ticks while the chat is on screen — its column, or the Chat tab in two columns.
			data-layout={`${(two ? chatInTab : layoutNow.chat) ? 'chat' : ''},${layoutNow.work ? 'work' : ''},${layoutNow.panel ? 'panel' : ''}`}>
			<div className={styles.main} data-task-main>
				<header
					ref={toolbar}
					className={styles.toolbar}
					data-labels={toolbarLabels === 'labels' && wideToolbar}
					aria-label={t(locale, 'View')}>
					<div className={styles.title}>
						<h1>{mainTree ? projectName : task.title}</h1>
						{mainTree ? (
							<span>
								{t(locale, 'main tree')}
								{treeScope ? ` · ${treeScope.name === '.' ? projectName : treeScope.name}` : ''}
							</span>
						) : (
							<TaskRepoLine
								links={<TaskLinksChip task={task} locale={locale} open={onOpenTask} />}
								status={
									task.archived
										? t(locale, 'in the archive')
										: task.status === 'completed'
											? t(locale, 'Completed task')
											: task.status === 'backlog'
												? t(locale, 'Backlog')
												: task.status === 'failed' && task.failure === 'auth'
													? t(locale, '{agent} sign-in needed').replace(
															'{agent}',
															task.provider === 'codex' ? 'Codex' : 'Claude'
														)
													: t(
															locale,
															task.status === 'rate-limited'
																? 'Rate limited'
																: task.status === 'preparing'
																	? 'Preparing…'
																	: task.status === 'working'
																		? 'Working'
																		: task.status === 'needs-you'
																			? 'Needs you'
																			: task.status === 'done'
																				? 'Done'
																				: task.status === 'failed'
																					? 'Error'
																					: task.status === 'interrupted'
																						? 'Interrupted'
																						: 'Queued'
														)
								}
							/>
						)}
					</div>
					{/* spec/search-menus-and-commands#project-commands, spec/task-window-workspace#work-area: title · Commands · Agents · Search · Tools · Layout; Commands and Agents leave for «…». */}
					{modules.commands && shownInToolbar('commands') && (
						<CommandsButton
							task={task}
							locale={locale}
							size={narrower(
								toolbarFit.step.commands,
								commandsRule(toolbarLabels === 'labels' && wideToolbar, toolbarWidth)
							)}
						/>
					)}
					{shownInToolbar('agents') && (
						<span className={styles.slot} data-toolbar-item="agents">
							<AgentsButton />
						</span>
					)}
					<span className={styles.fixed} data-toolbar-fixed>
						{/* 1 × 20 px rules round Search, between the task's buttons and the window's. */}
						{((modules.commands && shownInToolbar('commands')) || shownInToolbar('agents')) && (
							<span className={styles.rule} aria-hidden="true" />
						)}
						<IconButton
							label={t(locale, 'Search Everywhere')}
							hint={shortcutHint(t(locale, 'Search Everywhere'), 'search')}
							onClick={onSearch}>
							<Glyph name="search" size={15} />
						</IconButton>
						<span className={styles.rule} aria-hidden="true" />
						{moreEntries.length > 0 && (
							<ToolbarMore
								locale={locale}
								count={toolbarFit.step.out.filter((key) => toolbarPresent.includes(key)).length}
								entries={moreEntries}
								attention={!!agentsEntry?.attention && toolbarFit.step.out.includes('agents')}
							/>
						)}
						<ToolsButton
							locale={locale}
							count={tools.length}
							agent={toolsAgent}
							hint={shortcutHint(t(locale, 'Task tools'), 'tools')}
							menu={toolsMenu}
							open={toolsOpen}
							onOpen={setToolsOpen}
						/>
						{newFile && (
							<NewFilePopover
								task={task}
								locale={locale}
								open
								anchor={newFile.anchor}
								initial={newFile.initial}
								root={rootScope}
								onClose={() => setNewFile(null)}
								onOpen={(document: EditorDocument) => openTaskFileTab(task, document)}
							/>
						)}
						<LayoutSwitch
							locale={locale}
							layout={layoutNow}
							columns={mainTree ? ['work', 'panel'] : ['chat', 'work', 'panel']}
							taskColumns={mainTree ? null : taskColumns}
							onColumns={setTaskColumns}
							tabs={workTabs.length}
							unsaved={unsaved}
							kbd={accelerator}
							onToggle={toggleLayout}
							onShowAll={showAll}
							onReset={resetWidths}
						/>
					</span>
				</header>
				{/* spec/task-window-workspace#two-columns: two columns — the same row over the document while a file, not the Chat tab, is shown. */}
				{(!chatOnScreen || task.transport === 'terminal') &&
					(pending.permissions.length > 0 ||
						pending.questions.length > 0 ||
						pending.proposals.length > 0) && (
						<div className={styles.pending} aria-label={t(locale, 'Needs you')}>
							{pending.permissions.map((request) => {
								const plan = isPlanApproval(request)
									? planApprovalText(request, records, Number.MAX_SAFE_INTEGER)
									: null;
								return plan !== null && task.transport !== 'terminal' ? (
									<PlanApprovalNotice
										key={request.id}
										text={plan}
										task={task}
										locale={locale}
										onChat={() => setSurface('chat')}
									/>
								) : (
									<PermissionCard
										key={request.id}
										request={request}
										locale={locale}
										disabled={!connected || answering}
										send={(command) => {
											void answer(command);
										}}
										// spec/task-window-workspace#two-columns: Deny · Allow · Open chat — the way back while the chat is not on screen.
										{...(!chatOnScreen ? { onChat: () => setSurface('chat') } : {})}
									/>
								);
							})}
							{pending.questions.map((question) => (
								<Question
									key={question.id}
									question={question}
									body={
										<QuestionText
											id={question.id}
											text={question.question}
											task={task}
											locale={locale}
										/>
									}
									locale={locale}
									disabled={!connected || answering}
									answer={answers[question.id] ?? { labels: [], text: '' }}
									onChange={(answer) =>
										setTask((state) => ({ answers: { ...state.answers, [question.id]: answer } }))
									}
									send={(command) => {
										void answer(command);
									}}
								/>
							))}
							{pending.proposals.map((proposal) => (
								<TaskProposalCard
									key={proposal.id}
									proposal={proposal}
									task={task}
									locale={locale}
									disabled={!connected}
									onSheet={onProposal}
								/>
							))}
						</div>
					)}

				{/* spec/notifications-slack-notes-and-schedules#repo-contention: contention is a chip in the composer and the Changes heading, not a banner; a read-only violation stays here. */}
				<div ref={taskBody} className={styles.body} data-columns={threeColumns ? 3 : 2}>
					{chatVisible && (
						<>
							<div
								className={styles.chatColumn}
								data-task-chat
								data-sized={middleShown}
								style={middleShown ? { width: columnWidth('chatWidth') } : undefined}>
								{chat}
								{!middleShown && showReviewFooter && reviewFooter}
								{/* spec/task-window-workspace#work-area: a tab of the work area's bottom group dragged here takes the group under the chat. */}
								{bottom && !underChat && (
									<ColumnDropTarget
										column="chat"
										label={t(locale, 'Under the chat')}
										glyph="under-chat"
										accepts={fromBottom}
										onDrop={() => setTask({ bottomUnderChat: true })}
									/>
								)}
								{/* spec/task-window-workspace#work-area: the bottom group under the chat. */}
								{underChat && (
									<>
										<ResizeHandle
											axis="y"
											label={t(locale, 'Resize the bottom group')}
											value={columnWidth('consoleHeight')}
											min={120}
											max={600}
											onChange={(value) => resizeTask('consoleHeight', value)}
											onCommit={saveLayout}
										/>
										<div
											className={styles.underChat}
											style={{ height: columnWidth('consoleHeight') }}
											data-under-chat>
											{documentGroup(bottom!)}
										</div>
									</>
								)}
							</div>
							{middleShown && (
								<ResizeHandle
									edge="end"
									label={t(locale, 'Resize chat')}
									value={chatNow}
									min={chatMinimum}
									max={chatMax}
									onChange={(value) => resizeTask('chatWidth', value)}
									onCommit={saveLayout}
								/>
							)}
						</>
					)}
					{(middleShown || emptyPlace) && (
						<div
							className={styles.surface}
							data-task-documents={middleShown || undefined}
							data-work-area={middleShown || undefined}>
							{emptyPlace || (mainTree && workTabs.length === 0) ? (
								// spec/task-window-workspace#empty-work-area: the main tree's work area without a tab, or the chat and the work area off —
								// the helmet and its actions in their place.
								<EmptyPlace variant={mainTree ? 'main-tree' : 'task'} actions={emptyActions} />
							) : (
								<GroupTree
									node={underChat && groups.root.kind === 'split' ? groups.root.first : groups.root}
									locale={locale}
									onResize={(split, ratio) =>
										runGroups((groups) => resizeSplit(groups, split, ratio))
									}
									leaf={documentGroup}
								/>
							)}
							{/* Under the document, or under the empty state with neither the chat nor the work area. */}
							{showReviewFooter && reviewFooter}
							{/* spec/task-window-workspace#work-area: a tab of the group under the chat dragged here brings the group back. */}
							{underChat && (
								<ColumnDropTarget
									column="work"
									label={t(locale, 'Work area')}
									glyph="layout-work"
									accepts={fromBottom}
									onDrop={() => setTask({ bottomUnderChat: false })}
								/>
							)}
							<ToastHost locale={locale} anchored />
							{mainTree && (
								<QuickTaskBar
									locale={locale}
									branch={treeScope?.branch ?? null}
									open={() => onQuickTask?.({ scopeId: mainTree.scopeId ?? treeScope?.id ?? null })}
								/>
							)}
						</div>
					)}
					{panelOpen && (
						<>
							<ResizeHandle
								label={t(locale, 'Resize files panel')}
								value={columnWidth('changesWidth')}
								min={200}
								max={500}
								onChange={(value) => resizeTask('changesWidth', value)}
								onCommit={saveLayout}
							/>
							<aside
								ref={changesPanel}
								data-task-right
								data-menu-find={panel !== 'files' || undefined}
								style={{
									width: columnWidth('changesWidth'),
									minWidth: panel === 'changes' ? (changesMinimum ?? undefined) : undefined,
								}}
								className={styles.changes}
								aria-label={t(locale, 'Changes')}
								onKeyDown={(event) => {
									if (event.key === 'Escape' && !event.defaultPrevented) {
										event.preventDefault();
										hidePanel();
									}
								}}>
								{/* spec/task-window-workspace#layout-switch, spec/task-window#panel: Files · Changes · PR — the panel's own tabs, a capsule over its width. */}
								<div className={styles.panelTabs} data-size="m">
									<Segments
										tablist
										stretch
										optionAttribute="panel-tab"
										label={t(locale, 'Panel')}
										value={panel}
										onChange={(value) => setTask({ panel: value as PanelTab })}
										options={[
											{
												value: 'files',
												label: t(locale, 'Files'),
												icon: <Glyph name="folder" size={12} />,
												hint: shortcutHint(t(locale, 'Files'), 'files'),
											},
											{
												value: 'changes',
												label: t(locale, 'Changes'),
												icon: <Glyph name="diff" size={12} />,
												...(changes?.files.length ? { tail: String(changes.files.length) } : {}),
												hint: shortcutHint(t(locale, 'Changes'), 'diff'),
											},
											...(modules.pullRequests
												? [
														{
															value: 'prs',
															label: 'PR',
															icon: <Glyph name="pr-branch" size={12} />,
															hint: shortcutHint(t(locale, 'Pull requests'), 'pull-requests'),
														},
													]
												: []),
										]}
									/>
								</div>
								<SurfaceBoundary surface="panel" locale={locale} resetKey={panel}>
									{panel === 'changes' && (
										<header ref={changesHeaderRef} className={styles.diffToolbar}>
											{changesSearch ? (
												<PanelSearch
													locale={locale}
													label={t(
														locale,
														changesView === 'turns'
															? 'Find a turn'
															: changesView === 'history'
																? 'Find a commit'
																: 'Find file'
													)}
													value={changesView === 'diff' ? filter : changesQuery}
													count={
														changesView === 'diff'
															? fileCount(locale, fileRows.filter((row) => 'file' in row).length)
															: undefined
													}
													onChange={(value) =>
														changesView === 'diff' ? setFilter(value) : setChangesQuery(value)
													}
													onClose={() => setTask({ changesSearch: false })}
												/>
											) : (
												<>
													<div className={styles.diffModes}>
														<ChangesViewSwitch
															locale={locale}
															value={changesView}
															onChange={(changesView) => {
																setChangesQuery('');
																setTask({ changesView });
															}}
														/>
													</div>
													{changesView === 'history' ? (
														<span ref={setHistoryActions} className={styles.historyActions} />
													) : changesView === 'turns' ? (
														<span className={styles.headerSpace} />
													) : (
														<>
															<DiffBaseChip
																locale={locale}
																base={diffBase}
																range={changeRange}
																onSettings={onEditorSettings}
																onAllChanges={() => setTask({ changeRange: null })}
															/>
															<span className={styles.headerSpace} />
														</>
													)}
													<SearchToggle
														label={t(
															locale,
															changesView === 'turns'
																? 'Find a turn'
																: changesView === 'history'
																	? 'Find a commit'
																	: 'Find file'
														)}
														onOpen={() => setTask({ changesSearch: true })}
													/>
													{changesView === 'diff' && (
														<>
															{refreshControl}
															<DiffOptions
																locale={locale}
																range={changeRange}
																timeline={timeline}
																onRange={(changeRange) => setTask({ changeRange })}
															/>
														</>
													)}
												</>
											)}
										</header>
									)}
									{/* spec/appearance#evolution-redesign: a merge or rebase that stopped — the way into the Conflicts dialog. */}
									{panel === 'changes' && changesView !== 'turns' && (
										<ConflictsBanner
											task={task}
											locale={locale}
											agentBusy={agentBusy}
											refreshKey={changesKey}
										/>
									)}
									{panel === 'changes' && changesView === 'history' ? (
										<GitHistory
											task={task}
											locale={locale}
											projectName={projectName}
											agentBusy={agentBusy}
											query={changesQuery}
											refreshKey={changesKey}
											actions={historyActions}
											onOpenDiff={(key, diff, source) => {
												const entry = keepCommitDiff(task, key, diff, source);
												setTask((state) => ({
													commitDiffs: { ...state.commitDiffs, [key]: entry },
													selected: key,
													surface: 'diff',
												}));
											}}
											onOpenFile={(scopeId, path) => {
												const file = changes?.files.find(
													(item) => item.scopeId === scopeId && item.path === path
												);
												if (file) void openEditor(file.id, true);
												else
													fail('{file} is not among the task changes.', {
														kind: 'info',
														file: fileName(path),
													});
											}}
										/>
									) : panel === 'changes' && changesView === 'turns' ? (
										<TurnsPanel
											task={task}
											locale={locale}
											records={records}
											query={changesQuery}
											changes={changes}
										/>
									) : panel === 'prs' ? (
										<PullRequestPanel
											task={task}
											locale={locale}
											projectName={projectName}
											onOpenTask={onOpenTask}
											onAgentFix={(detail, scopeId, _drafts, _body, sendComments) =>
												agentFix({ scopeId, number: detail.summary.number }, sendComments)
											}
											onCIFix={(scopeId, detail, job, step, pr) => {
												void ciFix(scopeId, detail, job, step, pr);
											}}
											onAgentReview={(detail, scopeId, choice) =>
												agentReview({ scopeId, number: detail.summary.number }, choice)
											}
											onResolveConflicts={(ref) => {
												void resolveConflicts(ref, 'manual').then(
													(reason) => reason && toastError(reason)
												);
											}}
											onHandThreads={(detail, scopeId, threads) =>
												handThreads(detail, { scopeId, number: detail.summary.number }, threads)
											}
											onOverview={(ref) => setTask({ selected: overviewKey(ref), surface: 'diff' })}
											activeFile={
												selectedPR && commitDiff?.file.path
													? { ...selectedPR, path: commitDiff.file.path }
													: null
											}
											openingFile={
												prFileOpening && prFileOpening.phase !== 'failed' ? prFileOpening : null
											}
											onOpenFile={(ref, path, line) => {
												void openPRFile(ref, path, line);
											}}
											onOpenCommitFile={(scopeId, sha, value, fileId) =>
												openHistoryDiff(
													`history:${sha.slice(0, 7)}:${scopeId}/${value.file.path}`,
													value,
													{ kind: 'history', scopeId, sha, id: fileId }
												)
											}
										/>
									) : panel === 'files' ? (
										<FileTree
											task={task}
											locale={locale}
											projectName={projectName}
											scopes={changes?.scopes ?? []}
											refreshControl={refreshControl}
											changeCount={changes?.files.length ?? 0}
											openChanges={() => setTask({ panel: 'changes', changesView: 'diff' })}
											open={(id, path) => {
												void openEditor(id, false, undefined, undefined, path);
											}}
										/>
									) : (
										<>
											<div className={styles.files}>
												<Rows
													targetId={scopeTarget ?? undefined}
													onInteract={() => setTask({ scopeTarget: null })}
													position={rowPosition(positions, 'changes')}
													rows={fileRows}
													role="list"
													label={t(locale, 'Files')}
													followOutput={false}
													estimatedHeight={28}
													render={(row) =>
														'add' in row ? (
															<AddFolderRow />
														) : 'scope' in row && row.repo ? (
															<PanelRepoRoot
																scope={row.repo}
																expanded={!changesFolded.has(row.scope.id)}
																onToggle={() =>
																	setTask((state) => {
																		const next = new Set(state.changesFolded);
																		if (next.has(row.scope.id)) next.delete(row.scope.id);
																		else next.add(row.scope.id);
																		return { changesFolded: next };
																	})
																}
																rowProps={{ role: 'listitem', className: styles.changesRoot }}
																lock={!contended.some((scope) => scope.path === row.scope.path)}
																notices={
																	<>
																		{row.scope.available === false && (
																			<UnavailableChip
																				task={task}
																				locale={locale}
																				scopes={[row.scope]}
																				projectName={projectName}
																				placement="repo"
																			/>
																		)}
																		{contended.some((scope) => scope.path === row.scope.path) && (
																			<ContentionChip
																				task={task}
																				locale={locale}
																				placement="repo"
																				scopes={contended.filter(
																					(scope) => scope.path === row.scope.path
																				)}
																			/>
																		)}
																	</>
																}
															/>
														) : 'scope' in row ? (
															<h3 title={row.scope.path}>
																{row.scope.kind === 'root' && row.scope.name === '.'
																	? projectName
																	: row.scope.name}
																<small>{row.scope.branch}</small>
																{row.scope.available === false && (
																	<UnavailableChip
																		task={task}
																		locale={locale}
																		scopes={[row.scope]}
																		projectName={projectName}
																		placement="repo"
																	/>
																)}
																{contended.some((scope) => scope.path === row.scope.path) ? (
																	<ContentionChip
																		task={task}
																		locale={locale}
																		placement="repo"
																		scopes={contended.filter(
																			(scope) => scope.path === row.scope.path
																		)}
																	/>
																) : heldByOthers.get(row.scope.path)?.length ? (
																	<RepoLock
																		locale={locale}
																		owners={heldByOthers.get(row.scope.path)!}
																	/>
																) : null}
																<ScopeForgeActions scopeId={row.scope.id} />
															</h3>
														) : (
															<button
																title={
																	row.file.oldPath !== row.file.path
																		? `${row.file.oldPath} → ${row.file.path}`
																		: row.file.path
																}
																className={styles.file}
																aria-pressed={
																	file?.id === row.file.id && documentSurface === 'diff'
																}
																onContextMenu={(event) => {
																	event.preventDefault();
																	void window.brigadir.fileMenu(task, row.file.id, 'changes').then(
																		(action) => {
																			if (action === 'open') void openEditor(row.file.id, true);
																			if (action === 'revert')
																				void window.brigadir
																					.revertFile(task, row.file.id)
																					.then(load, () =>
																						fail('Could not revert {file}.', {
																							file: fileName(row.file.path),
																						})
																					);
																			if (action === 'why')
																				setTask({
																					selected: `${row.file.scopeId}/${row.file.path}`,
																					surface: 'diff',
																					whyFile: row.file.id,
																				});
																		},
																		() => fail('Could not open the menu.')
																	);
																}}
																onClick={() => {
																	setSelected(`${row.file.scopeId}/${row.file.path}`);
																	setSurface('diff');
																}}>
																{/* spec/task-window#panel: one line — icon, name, its folder; the repo is the root above. */}
																<FileIcon name={row.file.path.split('/').at(-1) ?? row.file.path} />
																<span className={styles.fileName}>
																	{row.file.path.split('/').at(-1)}
																</span>
																<span className={styles.fileDir}>
																	{row.file.path.includes('/')
																		? row.file.path.slice(0, row.file.path.lastIndexOf('/'))
																		: ''}
																</span>
																{row.file.binary ? (
																	<span className={styles.fileBinary}>
																		{t(locale, 'Binary file')}
																	</span>
																) : (
																	<ChangeCounts
																		additions={row.file.additions}
																		deletions={row.file.deletions}
																		locale={locale}
																		className={styles.counts}
																		split
																	/>
																)}
															</button>
														)
													}
												/>
												{changes && !changes.files.length && (
													<p className={styles.hint}>
														{t(
															locale,
															changes.checkpoint === null ? 'No Git snapshots' : 'No changes'
														)}
													</p>
												)}
											</div>
											{/* spec/git#commit-dialog: the foot of the Diff tab is one row — the snapshot picker and the commit. */}
											<CommitStrip
												task={task}
												locale={locale}
												commit={!needsPreparation}
												snapshot={`${t(locale, connected ? 'Current snapshot' : 'Saved snapshots')}${
													changes?.checkpoint !== null && changes?.checkpoint !== undefined
														? ` · ${changes.checkpoint}`
														: ''
												}`}
												range={changeRange}
												timeline={timeline}
												onRange={(changeRange) => setTask({ changeRange })}
											/>
										</>
									)}
								</SurfaceBoundary>
							</aside>
						</>
					)}
				</div>
				{commitDialog && <CommitDialog task={task} locale={locale} agentBusy={agentBusy} />}
				{/* spec/appearance#evolution-redesign: the review modal over the work area — opened from the PR panel footer or Overview. */}
				{prReviewOpen && (
					<PRReviewModal
						key={`${prReviewOpen.scopeId}/${prReviewOpen.number}`}
						task={task}
						target={prReviewOpen}
						locale={locale}
						projectName={projectName}
						mainTree={Boolean(mainTree)}
						onCompose={compose}
						onDeliver={(text, to) => deliver(to, text)}
						// spec/appearance#evolution-redesign: from the review modal it is «agent suggestions in review».
						onAgentReview={(choice) => agentReview(prReviewOpen, choice, true)}
						onOpenReview={(review) => openReviewTask(review, onOpenTask)}
						onAgentFix={(sendComments) => agentFix(prReviewOpen, sendComments)}
						onResolveConflicts={async (how) => {
							// spec/appearance#evolution-redesign: the Conflicts dialog opens in the PR branch's task; the review steps aside for it.
							const reason = await resolveConflicts(prReviewOpen, how);
							if (!reason) closeReview(task);
							return reason;
						}}
					/>
				)}
				{conflictsDialog && (
					<ConflictsDialog
						task={task}
						locale={locale}
						agentBusy={agentBusy}
						projectName={projectName}
						refreshKey={changesKey}
					/>
				)}
				{queuedReview && (
					<p className={styles.queuedReview} role="status">
						{t(locale, 'Review attached to your next CLI prompt.')}{' '}
						<Button
							onClick={() => {
								void window.brigadir.sendCommand(task, { kind: 'discardQueuedReview' }).then(
									() => setQueuedReview(false),
									() => fail('Could not remove the queued review.')
								);
							}}>
							{t(locale, 'Remove queued review')}
						</Button>
					</p>
				)}
			</div>
			{deletion && (
				<ReviewDeleteDialog
					locale={locale}
					count={deletion.count}
					files={deletion.files}
					hasNote={deletion.hasNote}
					cancel={() => setDeletion(null)}
					confirm={confirmDeleteReview}
				/>
			)}
			{reviewOpen && (
				<dialog
					ref={reviewDialog}
					className={styles.reviewDialog}
					aria-label={t(locale, 'Review')}
					onCancel={(event) => {
						event.preventDefault();
						setTask({ reviewOpen: false });
					}}>
					<header>
						<Glyph name="comment" size={15} />
						<h2>{t(locale, 'Review comments')}</h2>
						<small>
							{commentCount(locale, reviewSummary.count)} ·{' '}
							{fileCount(locale, reviewSummary.fileCount)}
						</small>
						<PopupClose locale={locale} close={() => setTask({ reviewOpen: false })} />
					</header>
					<ReviewList
						task={task}
						locale={locale}
						review={review}
						changes={changes}
						projectName={projectName}
						reload={reloadReview}
						openFile={(scopeId, path, id, line) => {
							setTask({ reviewOpen: false });
							if (changes?.files.some((file) => file.scopeId === scopeId && file.path === path)) {
								setTask({ selected: `${scopeId}/${path}`, surface: 'diff', reviewTarget: id });
							} else
								void window.brigadir
									.readCommentFile(task, id)
									.then(
										async (document) => {
											await openTaskEditor(task, document);
											const comment = review.comments.find((comment) => comment.id === id);
											if (comment) setTask({ editorTarget: { id: document.id, line } });
										},
										() =>
											fail('Could not open {file}.', {
												file: fileName(
													review.comments.find((comment) => comment.id === id)?.anchor.path ?? id
												),
											})
									)
									.catch(() =>
										fail('Could not open {file}.', {
											file: fileName(
												review.comments.find((comment) => comment.id === id)?.anchor.path ?? id
											),
										})
									);
						}}
					/>
					{(reviewSummary.count > 0 || Boolean(generalDraft.trim())) && (
						<div className={styles.reviewActions}>
							<span>
								↑↓ {t(locale, 'Select result')} · {formatAccelerator('Enter')}{' '}
								{t(locale, 'Open result')}
							</span>
							{(reviewSummary.count > 0 || Boolean(generalDraft.trim())) && (
								<Button
									disabled={reviewBusy}
									onClick={() => {
										void deleteReview();
									}}>
									<Glyph name="trash" /> {t(locale, 'Delete all')}
								</Button>
							)}
						</div>
					)}
				</dialog>
			)}
		</section>
	);
	// spec/appearance#evolution-redesign: one read of the task's repos for its header, the «Repos k/n» popover and the panel's roots.
	return <ReposProvider value={reposState}>{content}</ReposProvider>;
}
