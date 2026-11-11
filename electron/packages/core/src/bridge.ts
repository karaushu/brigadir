import type { TextSearchEvent, TextSearchRequest } from './search';
import type { RendererErrorReport } from './renderer-error';
import type { AppModules } from './modules';
import type {
	FoundMachine,
	PairedMachine,
	RemoteAccessStatus,
	RemoteAuditEntry,
	RemoteConnectResult,
	RemoteControl,
	RemoteNotice,
	RemotePairProgress,
	RemotePairResult,
	RemotePairing,
	RemoteSession,
	RemoteReach,
	RemoteKeyStore,
} from './remote-access';
import type {
	RemoteDialog,
	RemoteFsListing,
	RemoteMenu,
	RemoteNotify,
	RemoteSave,
	RemoteFileChoice,
	RemoteUiAnswer,
} from './remote-ui';
import type { LiveAgentRef, LiveAgentsSnapshot } from './live-agents';
import type { QuotaSnapshot } from './quota';
import type {
	BranchList,
	CommitFiles,
	HistoryPage,
	HistoryScope,
	MergePreview,
	MergeState,
	MergeOutcome,
} from './git-history';
import type {
	KnowledgeSnapshot,
	KnowledgeTarget,
	KnowledgePreview,
	KnowledgeReceipt,
} from './knowledge';
import type { LaunchConflict, LaunchConflictChoice, ScopeLockView } from './scope-locks';
import type { BoardColumn, ProjectView } from './board';
import type { ScopeChoice, LaunchSettings, TaskLaunch } from './launch';
import type { AgentTemplate, CrewLaunch, CrewLibrary, CrewTemplate, ProviderCatalog } from './crew';
import type { Typography, FontCatalog, InterfaceFont, ChatFont } from './typography';
import type { AppSettings, DiffBase, EditorTyping, SettingsSnapshot } from './settings';
import type { FilePathLink, FilePathText } from './file-path-links';
import type { ToolDiffPreview, TurnChanges } from './activity';
import type { AttributionRange } from './attribution';
import type { EditorMenuAction, EditorMenuState } from './editor-menu';
import type { DocumentTabMenuAction, DocumentTabMenuState } from './document-tabs';
import type { MenuIconImages } from './menu-icons';
import type { ChatMenuAction, ChatMenuState } from './chat-menu';
import type { TerminalMenuAction, TerminalMenuState } from './terminal-menu';
import type { SurfaceLayout } from './layout';
import type { SurfaceDraft, TaskSurface } from './surface';
import type { AttachmentInput, AttachmentOwner, PromptAttachment } from './attachments';
/** spec/tasks#sheet-model, spec/tasks#backlog-edit: what the launch sheet adds to a task besides its prompt. `draftId` names the sheet's draft attachments. */
export type TaskSheet = {
	name?: string;
	options?: { id: string; value: string }[];
	attachments?: string[];
	draftId?: string;
	/** spec/tasks#sheet-role: the id of the agent template the solo agent works as; null — no role. */
	role?: string | null;
};
import type { BrowserCommand, BrowserEvent, BrowserTabInfo } from './browser';
import type { BrowserScreenCommand, BrowserScreenEvent } from './browser-screen';
import type {
	SimulatorCommand,
	SimulatorEvent,
	SimulatorFrame,
	SimulatorToolchain,
} from './simulator';
import type { TerminalCommand, TerminalEvent, TerminalInfo, TerminalSnapshot } from './terminal';
import type { SyntaxSnapshot } from './syntax';
import type {
	CodeChange,
	CodeChangeResult,
	CodeCompletionDetail,
	CodeCompletionList,
	CodeFormatInfo,
	CodeIndentInfo,
	CodeRestartResult,
	CodeFormatReason,
	CodeFormatResult,
	CodeHover,
	CodeLocations,
	CodeProblemsEvent,
	CodeSignatureHelp,
	CodeStatus,
	CodeTrigger,
	ProjectFormatterInfo,
} from './code-intel';
import type { EditorCommentInput } from './review';
import type {
	FileContent,
	FileSearchResult,
	WorkspaceAction,
	EditorAction,
	EditorDocument,
	FileListing,
	SaveFileResult,
} from './files';
import type { CommentInput, ReviewPosition, ReviewSnapshot } from './review';
import type {
	Attribution,
	TimelineEntry,
	ChangeRange,
	ChangesSnapshot,
	EditorGutter,
	FileDiff,
} from './changes';
import type { TaskKey, SessionSnapshot, SessionCommand, EventRecord } from './session';
import type { NotificationMode, NotificationPermission } from './notifications';
import type { AgentTask, Project, ProjectFormatter } from './workspace';
import type { WorkspaceSnapshot } from './workspace';
import type { ProjectIcon, ProjectIconColor, RepoIconCandidate } from './project-icon';
import type { Locale } from './messages';
import type { EditorBlame } from './blame';
/** `accent` is the macOS accent (RRGGBBAA); `accentColor` is the Settings choice that decides whether it is used (spec/appearance#accent). */
export type Appearance = {
	suggestNextPrompt: boolean;
	terminalScrollSpeed?: number;
	terminalFontWeight?: number;
	modules: AppModules;
	reviewWhere?: AppSettings['agents']['reviewWhere'];
	/** spec/appearance#evolution-redesign: the review writes the PR summary by itself; which agents may write it. */ prSummary?: boolean;
	agentsEnabled?: AppSettings['agents']['enabled'];
	agentProvider?: AppSettings['agents']['provider'];
	codeTheme?: AppSettings['editor']['codeTheme'];
	keymap?: AppSettings['keymap'];
	dark: boolean;
	accent: string;
	accentColor: AppSettings['accent'];
	locale: Locale;
	toolbarLabels: AppSettings['toolbarLabels'];
	/** spec/task-window-workspace#two-columns: two or three columns in a task window; absent reads as three. */
	taskColumns?: AppSettings['taskColumns'];
	interfaceFont: InterfaceFont;
	/** spec/appearance#chat-text-size: the chat's text size; absent (a machine from before it) or null follows the interface. */
	chatFont?: ChatFont;
	typography: Typography;
	fonts: FontCatalog | null;
	missingFonts: string[];
	/** spec/diff-and-review#diff-base: the base every change surface counts from; switching it re-reads changes and the gutter. */
	diffBase: DiffBase;
	/** spec/notifications-slack-notes-and-schedules#macos-permission: the sidebar banner shows only while notifications are wanted. */
	notificationMode: NotificationMode;
	/** spec/editor-code-intelligence#typing-help: language servers and the typing aids; open editors reconfigure when these change. */
	editing: EditorTyping;
	/** spec/editor#line-author: the line author after the caret line; the menu item and Settings share it. Absent reads as on. */
	lineAuthor?: boolean;
	/** spec/editor#indentation: how the editor indents when no project config says otherwise. Absent reads as the defaults. */
	indent?: import('./indent').IndentSettings;
	/** spec/editor-code-intelligence#font-styles: bold keywords and italic comments in every highlighted surface. Absent reads as on. */
	syntaxStyles?: boolean;
	/** spec/tasks#archive: the card clock and the Archive window footer; absent reads as 7 days. */
	archiveAfterDays?: import('./archive').ArchiveAfterDays;
};
export type DesktopBridge = {
	readLiveAgents(): Promise<LiveAgentsSnapshot>;
	/** Global subscription limits per provider account (spec/agents-and-providers#usage, spec/agents-and-providers#quota-sources). `refreshQuota` is throttled in main. */
	readQuota(): Promise<QuotaSnapshot>;
	refreshQuota(): Promise<void>;
	/** The eye in the popover: which window of a provider the indicator shows; null returns to the tightest. */
	watchQuota(provider: 'claude' | 'codex', window: string | null): Promise<void>;
	onQuotaChanged(listener: (snapshot: QuotaSnapshot) => void): () => void;
	controlLiveAgent(ref: LiveAgentRef, action: 'stop' | 'terminate'): Promise<void>;
	readSidebarState(): Promise<string[]>;
	collapseProject(id: string, collapsed: boolean): Promise<string[]>;
	/** spec/sidebar#crew-collapse: foreman tasks whose crew card is folded in the sidebar; expanded by default. */
	readCollapsedCrews(): Promise<string[]>;
	collapseCrew(id: string, collapsed: boolean): Promise<string[]>;
	/** spec/sidebar#completed-fold: projects whose completed tasks are folded in the sidebar; open by default. */
	readCollapsedCompleted(): Promise<string[]>;
	collapseCompleted(projectId: string, collapsed: boolean): Promise<string[]>;
	/** spec/sidebar#open-last: the project (`*` — All projects) and task open last; reopened on launch. */
	readSelection(): Promise<{ project: string; task?: string } | null>;
	saveSelection(value: { project: string; task?: string }): Promise<void>;
	/** spec/notifications-slack-notes-and-schedules#notes: the notes in `~/.brigadir/notes/`, newest edit first. */
	/** spec/notifications-slack-notes-and-schedules#schedules: every schedule of every project, with its next slot. */
	listSchedules(): Promise<import('./schedules').ScheduleSummary[]>;
	/** The newest runs of a schedule first. */
	readScheduleRuns(projectId: string, id: string): Promise<import('./schedules').ScheduleRun[]>;
	createSchedule(
		projectId: string,
		draft: import('./schedules').ScheduleDraft
	): Promise<import('./schedules').Schedule>;
	editSchedule(
		projectId: string,
		id: string,
		draft: import('./schedules').ScheduleDraft
	): Promise<import('./schedules').Schedule>;
	deleteSchedule(projectId: string, id: string): Promise<void>;
	setSchedulePaused(projectId: string, id: string, paused: boolean): Promise<void>;
	/** A run outside the rule; works while paused. */
	runScheduleNow(projectId: string, id: string): Promise<import('./schedules').ScheduleRun>;
	/** «If missed: Ask» — one run now, or skip the missed slots. */
	resolveScheduleMissed(projectId: string, id: string, answer: 'run' | 'skip'): Promise<void>;
	onSchedulesChanged(listener: () => void): () => void;
	listNotes(): Promise<import('./notes').NoteSummary[]>;
	readNote(id: string): Promise<import('./notes').NoteDocument>;
	/** A new empty note; `project` null — a note without a project. Returns its id. */
	createNote(project: string | null, text: string): Promise<string>;
	/** Writes the whole text; returns the note's new `updatedAt`. */
	writeNote(id: string, text: string): Promise<string>;
	setNoteProject(id: string, project: string | null): Promise<void>;
	deleteNote(id: string): Promise<void>;
	onNotesChanged(listener: (change: import('./notes').NotesChange) => void): () => void;
	/** spec/notifications-slack-notes-and-schedules#notes: the note's one chat — its rows, and whether the agent answers now. */
	readNoteChat(id: string): Promise<import('./note-chat').NoteChatState>;
	/** A message to the note's agent; the current note goes with it. A new choice of provider or model starts a new session. */
	sendNoteChat(
		id: string,
		text: string,
		choice: import('./note-chat').NoteChatChoice
	): Promise<void>;
	stopNoteChat(id: string): Promise<void>;
	/** Undo of the agent's edit `seq`: the note goes back to its text before it, when it still holds the edit's text. */
	undoNoteEdit(id: string, seq: number): Promise<void>;
	onNoteChatEvent(listener: (event: import('./note-chat').NoteChatEvent) => void): () => void;
	/** The «…» menu of a note: what the person chose; `reveal` and `copy` are done by the menu itself. */
	noteMenu(id: string): Promise<'task' | 'chat' | 'delete' | null>;
	/** The project picker of a note's header: a project id, `none` — no project, null — nothing chosen. */
	noteProjectMenu(id: string, x: number, y: number): Promise<string | null>;
	/** A note without a project: the project of the task made from it; null — nothing chosen. */
	noteTaskProjectMenu(): Promise<string | null>;
	/** The whole note as a text attachment of the sheet's draft (spec/notifications-slack-notes-and-schedules#notes). */
	attachNote(owner: AttachmentOwner, id: string): Promise<PromptAttachment>;
	/**
	 * The link back (spec/notifications-slack-notes-and-schedules#notes): the task joins the note's tasks and a Markdown link to it goes under line `after`
	 * (1-based), or at the end of the note when null.
	 */
	linkNoteTask(
		id: string,
		task: { projectId: string; id: string; title: string },
		after: number | null
	): Promise<void>;
	readKnowledge(projectId: string): Promise<KnowledgeSnapshot>;
	prepareKnowledge(
		projectId: string,
		signature: string,
		target: KnowledgeTarget
	): Promise<KnowledgePreview>;
	generateKnowledge(projectId: string, signature: string, previewId: string): Promise<string>;
	cancelKnowledge(projectId: string): Promise<void>;
	rejectKnowledge(projectId: string, signature: string): Promise<void>;
	restoreKnowledge(projectId: string, signature: string): Promise<void>;
	addKnowledge(
		projectId: string,
		signature: string,
		previewId: string,
		text: string
	): Promise<KnowledgeReceipt>;
	dismissKnowledge(projectId: string, id: string): Promise<void>;
	undoKnowledge(projectId: string, id: string): Promise<void>;
	readKnowledgeFile(
		projectId: string,
		target: KnowledgeTarget
	): Promise<{ path: string; text: string | null }>;
	requestGhost(key: TaskKey, turn: number, id: string): Promise<string | null>;
	cancelGhost(key: TaskKey, id: string): Promise<void>;
	/** spec/composer-steering-queue-and-ghost#quick-question: a quick question from a selection: a separate session of the task's provider, streamed by `onQuickAskEvent`. */
	askQuickQuestion(key: TaskKey, request: import('./quick-ask').QuickAskRequest): Promise<void>;
	/** A follow-up in the same quick session (`Ask more…`). */
	askQuickFollowUp(key: TaskKey, id: string, question: string): Promise<void>;
	stopQuickQuestion(id: string): Promise<void>;
	/** Closes the quick session; the answer stays in the renderer. */
	closeQuickQuestion(id: string): Promise<void>;
	answerQuickPermission(id: string, requestId: string, optionId: string | null): Promise<void>;
	/** Reverts one file the quick question changed, to its checkpoint before the question. */
	revertQuickChange(
		key: TaskKey,
		fileId: string,
		range: import('./changes').ChangeRange
	): Promise<void>;
	onQuickAskEvent(listener: (event: import('./quick-ask').QuickAskEvent) => void): () => void;
	/** `fresh`: window focus, Retry and Checks re-read auth and PR state past the short GitHub cache; a task switch may use it. */
	readForge(
		key: TaskKey,
		remote: boolean,
		fresh?: boolean
	): Promise<import('./forge').ForgeSnapshot>;
	preparePush(key: TaskKey, scopeId: string): Promise<import('./forge').PushDraft>;
	pushChanges(key: TaskKey, id: string): Promise<import('./forge').ForgeSnapshot>;
	preparePullRequest(key: TaskKey, scopeId: string): Promise<import('./forge').PullRequestDraft>;
	/** spec/pull-requests-and-ci#from-into: checks the dialog's `From → Into` pair; `createPullRequest` takes only a pair checked this way. */
	checkPullRequest(
		key: TaskKey,
		id: string,
		pair: { head: string; base: string }
	): Promise<import('./forge').PullRequestPair>;
	createPullRequest(
		key: TaskKey,
		id: string,
		input: { title: string; body: string; branch: string; head: string; base: string; web: boolean }
	): Promise<import('./forge').ForgeSnapshot>;
	/** spec/appearance#evolution-redesign: `run` — the capsule's one-time Helper agent; none is the one in Settings. */
	generatePullRequest(
		key: TaskKey,
		id: string,
		run?: import('./settings').HelperRun | null
	): Promise<{ title: string; body: string }>;
	discardForgeDraft(key: TaskKey, id: string): Promise<void>;
	/** spec/pull-requests-and-ci#ready-card: × on the card of a branch ready for a PR hides it until that branch is pushed again. */
	hidePullRequestSuggestion(
		key: TaskKey,
		scopeId: string
	): Promise<import('./forge').ForgeSnapshot>;
	readPullRequest(key: TaskKey, scopeId: string): Promise<import('./forge').PRDetails>;
	openPullRequest(key: TaskKey, scopeId: string): Promise<void>;
	createScopeBranch(
		key: TaskKey,
		scopeId: string,
		branch: string
	): Promise<import('./forge').ForgeSnapshot>;
	/** spec/pull-requests-and-ci#pr-panel: the PR of the task's repo, or without a task, of the project's main tree; `fresh` — focus, a click, the person's own action. */
	/** spec/tasks#quick-tasks: opens the project's main tree — the hidden `main-tree` record, refreshed by a snapshot. */
	openMainTree(projectId: string): Promise<import('./workspace').AgentTask>;
	readMainTreeBranch(
		projectId: string,
		scopeId: string,
		branch: string
	): Promise<import('./workspace').MainTreeBranch>;
	switchMainTreeBranch(
		projectId: string,
		scopeId: string,
		branch: string
	): Promise<import('./workspace').MainTreeBranch>;
	/** spec/git#main-tree-branches: the branch picker and the git tools of a main-tree repo. */
	readBranchSwitch(
		projectId: string,
		scopeId: string,
		fetch?: boolean
	): Promise<import('./branch-switch').BranchSwitchState>;
	switchBranchTo(
		projectId: string,
		scopeId: string,
		request: import('./branch-switch').SwitchRequest
	): Promise<import('./branch-switch').SwitchResult>;
	createMainTreeBranch(
		projectId: string,
		scopeId: string,
		request: import('./branch-switch').CreateBranchRequest
	): Promise<import('./branch-switch').SwitchResult>;
	readStashes(projectId: string, scopeId: string): Promise<import('./branch-switch').StashEntry[]>;
	stashChanges(projectId: string, scopeId: string): Promise<string>;
	restoreStash(projectId: string, scopeId: string, sha: string): Promise<void>;
	dropStash(projectId: string, scopeId: string, sha: string): Promise<void>;
	pullBranch(projectId: string, scopeId: string, taskId?: string | null): Promise<number>;
	undoLastCommit(projectId: string, scopeId: string): Promise<import('./branch-switch').LastCommit>;
	discardChanges(projectId: string, scopeId: string, untracked: string[]): Promise<void>;
	readPullRequests(
		projectId: string,
		taskId: string | null,
		fresh?: boolean
	): Promise<import('./pull-requests').PullRequestsSnapshot>;
	readPullRequestDetail(
		projectId: string,
		taskId: string | null,
		ref: import('./pull-requests').PRRefKey,
		fresh?: boolean
	): Promise<import('./pull-requests').PullRequestDetail>;
	/** spec/pull-requests-and-ci#ci: a repo's GitHub Actions runs (by commit, branch or workflow) and one run down to its steps and deploy. */
	readCIRuns(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		query: import('./pull-requests').CIRunsQuery,
		fresh?: boolean
	): Promise<import('./pull-requests').CIRun[]>;
	readCIRun(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		runId: number,
		fresh?: boolean
	): Promise<import('./pull-requests').CIRunDetail>;
	/** spec/pull-requests-and-ci#ci-bell: the bell on a run — watch it or not; the list of watches and main's events. */
	watchCIRun(
		watch: import('./pull-requests').CIWatch,
		on: boolean
	): Promise<import('./pull-requests').CIWatch[]>;
	readCIWatches(): Promise<import('./pull-requests').CIWatch[]>;
	onCIWatches(listener: (watches: import('./pull-requests').CIWatch[]) => void): () => void;
	onCIFinished(listener: (event: import('./pull-requests').CIFinished) => void): () => void;
	/** The run of a bell or of a notification center row (spec/notifications-slack-notes-and-schedules#notification-center): only its watch is certain. */
	onCIOpen(
		listener: (event: Pick<import('./pull-requests').CIFinished, 'watch'>) => void
	): () => void;
	preparePullRequestTrees(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey
	): Promise<{ base: string; head: string }>;
	readPullRequestFiles(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey
	): Promise<import('./changes').ChangedFile[]>;
	readPullRequestFileDiff(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		path: string
	): Promise<import('./changes').FileDiff>;
	/** spec/pull-requests-and-ci#pr-definition: ⌘+click in the new side of a PR file — `line`/`column` are 1-based, `text` is the clicked diff line. */
	findPullRequestDefinition(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		path: string,
		line: number,
		column: number,
		text: string
	): Promise<import('./pull-requests').PRDefinitionAnswer>;
	readPullRequestReview(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey
	): Promise<import('./pull-requests').PRReviewDraft>;
	/** spec/projects-and-board#pr-mode: whether a review was started here for a project's PR; key — `prKeyOf(scopeId, number)`, a PR without a review file is absent. */
	readPullRequestReviewStates(
		projectId: string,
		refs: import('./pull-requests').PRRefKey[]
	): Promise<Record<string, import('./pr-board').PRLocalReview>>;
	/** spec/projects-and-board#pr-mode: the modal writes «Viewed» progress into the PR's review file. */
	notePullRequestViewed(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		viewed: number,
		of: number
	): Promise<void>;
	/** spec/appearance#evolution-redesign: the native menu of a PR list row; the copies finish in main and answer null. */
	pullRequestMenu(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		pr: import('./pull-requests').PRMenuRow
	): Promise<import('./pull-requests').PRMenuAction | null>;
	addPullRequestDraft(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		input: import('./pull-requests').PRDraftInput
	): Promise<import('./pull-requests').PRReviewDraft>;
	editPullRequestDraft(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		id: string,
		body: string
	): Promise<import('./pull-requests').PRReviewDraft>;
	removePullRequestDraft(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		id: string
	): Promise<import('./pull-requests').PRReviewDraft>;
	/** spec/pull-requests-and-ci#review-with-agent: a reply to an agent's draft — into its thread; the prompt goes to the review task. */
	discussPullRequestDraft(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		id: string,
		body: string
	): Promise<{ review: import('./pull-requests').PRReviewDraft; prompt: string }>;
	setPullRequestReview(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		patch: {
			body?: string;
			event?: import('./pull-requests').PRReviewEvent;
			sendComments?: boolean;
		}
	): Promise<import('./pull-requests').PRReviewDraft>;
	submitPullRequestReview(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey
	): Promise<import('./pull-requests').PRReviewDraft>;
	commentPullRequestNow(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		input: import('./pull-requests').PRDraftInput
	): Promise<void>;
	commentPullRequest(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		body: string
	): Promise<void>;
	resolvePullRequestThread(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		threadId: string,
		resolved: boolean
	): Promise<void>;
	markPullRequestFileViewed(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		path: string,
		viewed: boolean
	): Promise<void>;
	readPullRequestSummary(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey
	): Promise<import('./pull-requests').PRSummary | null>;
	generatePullRequestSummary(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		run?: import('./settings').HelperRun | null
	): Promise<import('./pull-requests').PRSummary>;
	/** spec/appearance#evolution-redesign: `Stop` while the summary is written; the call that waits for it fails as cancelled. */
	stopPullRequestSummary(key: TaskKey, ref: import('./pull-requests').PRRefKey): Promise<void>;
	/** spec/appearance#evolution-redesign: `Accept` on an agent's suggestion — the draft stays and moves to «Yours». */
	acceptPullRequestDraft(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		id: string
	): Promise<import('./pull-requests').PRReviewDraft>;
	/** spec/appearance#evolution-redesign: `Generate from the drafts` — the reviewer's word over the review, written from the drafts. */
	writePullRequestReviewBody(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		run?: import('./settings').HelperRun | null
	): Promise<string>;
	/** spec/appearance#evolution-redesign: the agent's hint on step 3; null — it has none. */
	suggestPullRequestVerdict(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey
	): Promise<import('./pull-requests').PRVerdictHint | null>;
	askPullRequestAgent(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		question: import('./pull-requests').PRAgentQuestion
	): Promise<import('./pull-requests').PRAgentAnswer>;
	/** spec/pull-requests-and-ci#review-modal, spec/pull-requests-and-ci#review-with-agent: `created: false` — your own PR already has a task; the prompt and the count go there. */
	startPullRequestAgent(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		mode: 'review' | 'fix',
		sendComments: boolean,
		where?: 'quick' | 'worktree',
		/** spec/appearance#evolution-redesign: the «Agent» section of «Review with an agent ▾»; none is the Default agent. */
		agent?: import('./settings').HelperRun | null,
		/** spec/appearance#evolution-redesign: started from step 2 of the review modal — the action «agent suggestions in review». */
		suggestions?: boolean,
		/** spec/pull-requests-and-ci#review-crew: the Crew segment — a library crew reviews instead of one agent; excludes `agent`. */
		crew?: string | null,
		/** spec/pull-requests-and-ci#review-launch: the person's instructions for this review, as typed. */
		notes?: string
	): Promise<{
		task: import('./workspace').AgentTask;
		created: boolean;
		prompt: string;
		count: number;
		/** spec/appearance#evolution-redesign: open reviewer threads handed with the drafts (your own PR). */ threads?: number;
	}>;
	/**
	 * spec/pull-requests-and-ci#resolve-conflicts: merges the PR base into the PR branch in the task of that branch (or a new worktree task) to resolve the conflicts.
	 * `prompt` — for the agent in a task that already exists; the renderer delivers it (a new task starts with it).
	 */
	resolvePullRequestConflicts(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		how: 'agent' | 'manual'
	): Promise<{
		task: import('./workspace').AgentTask;
		created: boolean;
		scopeId: string;
		status: 'merged' | 'conflicts' | 'up-to-date';
		prompt: string | null;
	}>;
	/** spec/pull-requests-and-ci#merge-card: takes a draft PR out of draft (`markPullRequestReadyForReview`). */
	readyPullRequest(key: TaskKey, ref: import('./pull-requests').PRRefKey): Promise<void>;
	mergePullRequest(
		key: TaskKey,
		ref: import('./pull-requests').PRRefKey,
		method: import('./pull-requests').PRMergeMethod,
		deleteBranch: boolean
	): Promise<void>;
	/** `number: null` — the repo's PR list on GitHub (older closed PRs are there). */
	openPullRequestPage(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		number: number | null
	): Promise<void>;
	/** A link from a PR page (a check's log, a comment) — only to the repository's host. */
	openPullRequestLink(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		url: string
	): Promise<void>;
	/** spec/editor#markdown-views, spec/chat#web-links: a link the person clicked in Markdown (chat, plan, preview); http(s) and mailto only, checked again in main. */
	openWebLink(url: string): Promise<void>;
	/** spec/pull-requests-and-ci#pr-links: a GitHub PR address from the chat → the PR of this task's repo; null for another repository, throws when the PR cannot be read. */
	resolvePullRequestLink(
		projectId: string,
		taskId: string | null,
		url: string
	): Promise<{ scopeId: string; number: number } | null>;
	readCommits(key: TaskKey): Promise<{
		preview: import('./commits').CommitPreview;
		result: import('./commits').CommitResult | null;
	}>;
	commitChanges(
		key: TaskKey,
		revision: string,
		message: string
	): Promise<import('./commits').CommitResult>;
	generateCommitMessage(
		key: TaskKey,
		revision: string,
		run?: import('./settings').HelperRun | null
	): Promise<string>;
	/** spec/git#commit-dialog: the commit dialog's baskets, committed one by one in order; each step comes by `onCommitProgress`. */
	commitBaskets(
		key: TaskKey,
		revision: string,
		plan: import('./commits').CommitBasketPlan[]
	): Promise<import('./commits').CommitBasketsResult>;
	onCommitProgress(listener: (progress: import('./commits').CommitProgress) => void): () => void;
	generateBasketMessage(
		key: TaskKey,
		revision: string,
		scopeId: string,
		paths: string[],
		run?: import('./settings').HelperRun | null
	): Promise<string>;
	/** spec/git#commit-dialog: «Split with the agent» — only on the person's click; `stopCommitSplit` cancels it. */
	splitCommits(
		key: TaskKey,
		revision: string,
		run?: import('./settings').HelperRun | null
	): Promise<import('./commits').CommitSplitProposal>;
	stopCommitSplit(key: TaskKey): Promise<void>;
	readCommitFile(key: TaskKey, revision: string, id: string): Promise<FileDiff>;
	openCommitFile(key: TaskKey, revision: string, id: string): Promise<EditorDocument>;
	/** spec/git#merge: History of the changes panel. */
	readHistoryScopes(key: TaskKey): Promise<HistoryScope[]>;
	readBranches(key: TaskKey, scopeId: string): Promise<BranchList>;
	/** spec/editor#line-author: `path` narrows the page to one file; `limit` grows by pages of 100. spec/git#history-search: `query` searches the whole
	 * history of the branch by message, author or SHA prefix. */
	readHistory(
		key: TaskKey,
		scopeId: string,
		branch: string,
		path?: string | null,
		limit?: number,
		query?: string | null
	): Promise<HistoryPage>;
	readHistoryCommit(key: TaskKey, scopeId: string, sha: string): Promise<CommitFiles>;
	readHistoryFile(key: TaskKey, scopeId: string, sha: string, id: string): Promise<FileDiff>;
	/** spec/git#merge: merge and conflicts. */
	previewMerge(key: TaskKey, scopeId: string, into: string, from: string): Promise<MergePreview>;
	startMerge(key: TaskKey, scopeId: string, into: string, from: string): Promise<MergeOutcome>;
	readMergeState(key: TaskKey, scopeId: string): Promise<MergeState | null>;
	resolveConflict(
		key: TaskKey,
		scopeId: string,
		path: string,
		take: 'ours' | 'theirs' | 'both'
	): Promise<MergeState | null>;
	markConflictResolved(key: TaskKey, scopeId: string, path: string): Promise<MergeState | null>;
	finishMerge(key: TaskKey, scopeId: string): Promise<MergeOutcome>;
	abortMerge(key: TaskKey, scopeId: string): Promise<void>;
	/** spec/appearance#evolution-redesign: `paths` — the files given to the agent; none — every file with conflict places. */
	askAgentToResolve(key: TaskKey, scopeId: string, paths?: string[] | null): Promise<void>;
	/** `Stop` of the agent's banner: its turn ends, unfinished files are plain conflicts again. */
	stopConflictAgent(key: TaskKey, scopeId: string): Promise<MergeState | null>;
	/** Every repo of the task where a merge or rebase stopped (the banner in Changes). */
	readMergeStates(key: TaskKey): Promise<MergeState[]>;
	readConflictTexts(
		key: TaskKey,
		scopeId: string,
		path: string
	): Promise<import('./git-history').ConflictTexts>;
	/** `Apply` of the merge view: writes the Result and resolves the file (`git add`). */
	applyConflict(
		key: TaskKey,
		scopeId: string,
		path: string,
		text: string
	): Promise<MergeState | null>;
	/** `Back to the conflict` (`git checkout -m`). */
	reopenConflict(key: TaskKey, scopeId: string, path: string): Promise<MergeState | null>;
	prepareRelay(key: TaskKey): Promise<import('./relay').RelayDraft>;
	summarizeRelay(id: string): Promise<string>;
	stopRelaySummary(id: string): Promise<void>;
	discardRelay(id: string): Promise<void>;
	createRelayTask(input: import('./relay').RelayCreate): Promise<AgentTask>;
	/** spec/tasks#agent-created-tasks: the card of a task the agent proposed — create it, open it in the sheet, link the sheet's task, or decline. */
	createProposedTask(key: TaskKey, id: string): Promise<AgentTask>;
	draftProposedTask(
		key: TaskKey,
		id: string,
		owner: import('./attachments').AttachmentOwner
	): Promise<import('./task-proposal').TaskProposalDraft>;
	adoptProposedTask(key: TaskKey, id: string, created: TaskKey): Promise<void>;
	declineProposedTask(key: TaskKey, id: string): Promise<void>;
	readScopePanel(
		projectId: string,
		taskId: string | null
	): Promise<import('./scope-controls').ScopePanelSnapshot>;
	updateScope(
		projectId: string,
		taskId: string | null,
		update: import('./scope-controls').ScopeUpdate
	): Promise<void>;
	collapseScopes(projectId: string, collapsed: boolean): Promise<void>;
	updateMenuContext(context: import('./menu').MenuContext): Promise<void>;
	readSettings(): Promise<SettingsSnapshot>;
	readSounds(): Promise<string[]>;
	previewSound(name: string): Promise<boolean>;
	openNotificationSettings(): Promise<void>;
	/** spec/notifications-slack-notes-and-schedules#macos-permission: macOS authorization of the app; `request` shows the system prompt only while undecided. */
	readNotificationPermission(): Promise<NotificationPermission>;
	requestNotificationPermission(): Promise<NotificationPermission>;
	onNotificationPermission(listener: (value: NotificationPermission) => void): () => void;
	setVisibleTask(key: TaskKey | null): Promise<void>;
	onProjectOpen(listener: (id: string) => void): () => void;
	onNotificationOpen(listener: (key: TaskKey) => void): () => void;
	/** spec/notifications-slack-notes-and-schedules#notification-center: the notification center — history and live requests, its actions, a toast the window hands over. */
	readNoticeCenter(): Promise<import('./notice-center').NoticeCenter>;
	noticeCenterAction(action: import('./notice-center').NoticeCenterAction): Promise<void>;
	addToastNotice(toast: import('./notice-center').ToastNotice): Promise<void>;
	onNoticeCenter(listener: (center: import('./notice-center').NoticeCenter) => void): () => void;
	/** spec/notifications-slack-notes-and-schedules#slack: Settings ▸ Modules ▸ Slack — the bot's state; the token itself is never read back. */
	readSlack(): Promise<import('./slack').SlackState>;
	/** `Retry now`: reads the token again and asks Slack. */
	retrySlack(): Promise<import('./slack').SlackState>;
	/** `Connect` / `Replace token…`: sealed in the Keychain only after Slack accepts it. */
	connectSlack(token: string): Promise<import('./slack').SlackState>;
	moveSlackToKeychain(): Promise<import('./slack').SlackState>;
	disconnectSlack(): Promise<import('./slack').SlackState>;
	/** spec/notifications-slack-notes-and-schedules#slack: the App-Level Token (`xapp-…`) of `@ mentions in Slack`; sealed after Slack accepts it, never read back. */
	connectSlackApp(token: string): Promise<import('./slack').SlackState>;
	disconnectSlackApp(): Promise<import('./slack').SlackState>;
	onSlack(listener: (state: import('./slack').SlackState) => void): () => void;
	saveSettings(settings: AppSettings): Promise<SettingsSnapshot>;
	/** spec/appearance#evolution-redesign: `Remember for …` of the in-place capsule and `Reset` of Customize per action — one action's agent; null
	 *  inherits again. Main changes only that entry of the settings it holds. */
	saveActionAgent(
		action: import('./action-agents').AgentAction,
		agent: import('./settings').HelperAgent | null
	): Promise<SettingsSnapshot>;
	/** spec/pull-requests-and-ci#review-crew: `Remember for …` on the Crew segment and `Reset` of Customize per action — one review action's crew; it clears
	 *  that action's agent, as saving an agent clears its crew. */
	saveActionCrew(
		action: import('./action-agents').CrewAction,
		crew: import('./action-agents').ActionCrew | null
	): Promise<SettingsSnapshot>;
	restartApp(): Promise<void>;
	readProjectViews(): Promise<Record<string, ProjectView>>;
	readLaunchConflict(): Promise<LaunchConflict | null>;
	resolveLaunchConflict(id: string, choice: LaunchConflictChoice): Promise<void>;
	onLaunchConflict(listener: (conflict: LaunchConflict | null) => void): () => void;
	readScopeLocks(key: TaskKey): Promise<ScopeLockView[]>;
	readPreparationLog(key: TaskKey): Promise<string>;
	/** Removes the task's worktree copy; branches and commits stay (spec/sidebar#layout). */
	removeWorktree(key: TaskKey): Promise<void>;
	/** Branches the project can start a worktree from, newest first (spec/tasks#sheet-base-ref). */
	readBaseRefs(projectId: string): Promise<string[]>;
	/** spec/projects-and-board#external-folders: the person brings a folder from outside the root for a task from the sheet; it does not join the project. `names` are the sheet's repo names, so a clash takes the parent's name. */
	addProjectFolder(projectId: string, names: string[]): Promise<ScopeChoice | null>;
	/** spec/projects-and-board#folders-mid-task, spec/projects-and-board#external-folders: «Add folder…» in the Repos panel of a task; the folder joins it, also while it runs. */
	addScopeFolder(projectId: string, taskId: string): Promise<ScopeChoice | null>;
	/** spec/tasks#sheet-layout, spec/composer#mention-menu: file and folder search for the `@` menu while there is no task yet. */
	searchProjectFiles(
		projectId: string,
		query: string
	): Promise<{ path: string; scope: string; scopePath: string; directory?: true }[]>;
	readLaunchSettings(projectId: string): Promise<LaunchSettings>;
	saveProjectView(projectId: string, view: ProjectView): Promise<Record<string, ProjectView>>;
	/** spec/projects-and-board#pr-mode: the `Tasks` / `Pull requests` tab and the PR filter of each project (`*` — All projects). */
	readProjectModes(): Promise<Record<string, import('./pr-board').ProjectMode>>;
	saveProjectMode(projectId: string, mode: import('./pr-board').ProjectMode): Promise<void>;
	/** spec/settings-modules-and-onboarding#intro: while a shortcut is being recorded the menu gives up its accelerators, so the keys reach the recorder. */
	setShortcutRecording(recording: boolean): Promise<void>;
	/** spec/settings-modules-and-onboarding#settings-keys: agents, sign-in, git and gh on this Mac. */
	checkEnvironment(): Promise<import('./environment').EnvironmentCheck>;
	/** spec/agents-and-providers#cli-updates: the last CLI update run; «Check now» runs one (or joins the one going) and resolves with its result. */
	readCliUpdates(): Promise<import('./cli-updates').CliUpdateStatus>;
	checkCliUpdates(): Promise<import('./cli-updates').CliUpdateStatus>;
	onCliUpdates(listener: (status: import('./cli-updates').CliUpdateStatus) => void): () => void;
	/** spec/architecture-and-platform#auto-update: Brigadir's own update — read, check now (the menu item, «Check now»), download a found version
	 *  (a build that only notifies opens its release page), restart to install (waits while turns run), cancel that wait. */
	readAppUpdate(): Promise<import('./app-updates').AppUpdateState>;
	checkAppUpdate(): Promise<import('./app-updates').AppUpdateState>;
	downloadAppUpdate(): Promise<import('./app-updates').AppUpdateState>;
	installAppUpdate(): Promise<import('./app-updates').AppUpdateState>;
	cancelAppUpdateRestart(): Promise<import('./app-updates').AppUpdateState>;
	onAppUpdate(listener: (state: import('./app-updates').AppUpdateState) => void): () => void;
	/** spec/architecture-and-platform#keep-awake: agents working now and whether main holds the Mac awake; the line under «Mac sleep». */
	readKeepAwake(): Promise<import('./keep-awake').KeepAwakeStatus>;
	onKeepAwake(listener: (status: import('./keep-awake').KeepAwakeStatus) => void): () => void;
	/** Opens macOS Terminal with the provider's sign-in command. */
	/** spec/agents-and-providers#sign-in-recovery: starts the agent's own sign-in in the app (browser), or returns the one already running. */
	signInAgent(provider: 'claude' | 'codex'): Promise<import('./environment').AgentLoginState>;
	readAgentLogin(provider: 'claude' | 'codex'): Promise<import('./environment').AgentLoginState>;
	submitAgentLoginCode(provider: 'claude' | 'codex', code: string): Promise<void>;
	cancelAgentLogin(provider: 'claude' | 'codex'): Promise<void>;
	reopenAgentLogin(provider: 'claude' | 'codex'): Promise<void>;
	/** spec/remote-access-and-mobile#networking: a window of another machine opens its sign-in page on this device, with a way back to it. */
	openAgentSignIn(provider: 'claude' | 'codex', url: string): Promise<void>;
	/** The device's loopback listener passes the browser's return to the sign-in's server on the machine. */
	relayAgentLogin(
		provider: 'claude' | 'codex',
		request: import('./remote-access').AgentLoginRelayRequest
	): Promise<import('./remote-access').AgentLoginRelayResponse>;
	onAgentLogin(listener: (state: import('./environment').AgentLoginState) => void): () => void;
	moveTask(key: TaskKey, column: BoardColumn): Promise<void>;
	taskOptionMenu(key: TaskKey, kind: 'model' | 'effort'): Promise<string | null>;
	deleteCompletedTask(key: TaskKey): Promise<boolean>;
	clearCompletedTasks(projectId: string | null): Promise<number>;
	/** spec/tasks#backlog-edit: `sheet` carries the sheet's name, model options and the task's attachment list (ids of its own attachments). */
	editBacklogTask(
		key: TaskKey,
		text: string,
		provider: 'claude' | 'codex',
		transport: 'gui' | 'terminal',
		launch?: TaskLaunch,
		sheet?: TaskSheet
	): Promise<AgentTask>;
	renameTask(key: TaskKey, title: string): Promise<void>;
	taskMenu(
		key: TaskKey
	): Promise<
		| 'open'
		| 'edit'
		| 'rename'
		| 'relay'
		| 'duplicate'
		| 'repeat'
		| 'diff'
		| 'deleted'
		| 'archived'
		| 'restored'
		| null
	>;
	/** spec/tasks#archive: archive by hand; Restore takes tasks back with their statuses; delete from the Archive window after its own dialog. */
	archiveTask(key: TaskKey): Promise<import('./archive').TaskArchive>;
	archiveCompletedTasks(projectId: string | null): Promise<number>;
	restoreTasks(keys: TaskKey[]): Promise<void>;
	deleteArchivedTasks(keys: TaskKey[]): Promise<number>;
	/** spec/tasks#archive: projects whose «Archive · N» section is open; closed by default. */
	readArchiveSections(): Promise<string[]>;
	openArchiveSection(id: string, open: boolean): Promise<string[]>;
	projectMenu(
		id: string
	): Promise<'new-task' | 'main-tree' | 'knowledge' | 'icon' | 'review-notes' | 'removed' | null>;
	copyText(text: string): Promise<void>;
	/** spec/terminal-and-cli-agents#console-links: the system clipboard's text for Paste in the console; the page may not read it itself. */
	readClipboardText(): Promise<string>;
	/** spec/architecture-and-platform#crash-recovery: a boundary caught an error, or a missing chunk reloaded the window. */
	reportRendererError(report: RendererErrorReport): Promise<void>;
	/** spec/architecture-and-platform#crash-recovery: main reloads the window; a reload from the page would meet the navigation guard (`will-navigate`). */
	reloadWindow(): Promise<void>;
	/** e2e only (`BRIGADIR_TEST_CRASH`): the surface that throws once in render; null in the app. */
	readonly testCrash: string | null;
	/** `BRIGADIR_TEST_ATTENTION_MS` (e2e only): the repeat of a waiting row's flash, 30 s otherwise (spec/crew#attention). */
	readonly testAttentionMs: number | null;
	/** spec/architecture-and-platform#window-frame: the frame the window wears — macOS traffic lights, or Windows/Linux OS buttons with ☰ (dev override included). */
	readonly chromePlatform: 'darwin' | 'win32' | 'linux';
	/** spec/remote-access-and-mobile#module-and-settings: the window shows another machine (its id and name when the window opened); null for this machine's own window. */
	/** `device` — this computer's own name (spec/remote-access-and-mobile#remote-button, «Go to»). */
	readonly remoteMachine: { id: string; name: string; device: string } | null;
	/** spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#identity-and-keys: whether this computer can keep its remote access key in the OS key store. */
	readRemoteKeyStore(): Promise<RemoteKeyStore>;
	/** spec/architecture-and-platform#window-frame: main shows the app menu under ☰; resolves once it closes. */
	openAppMenu(x?: number, y?: number): Promise<boolean>;
	/** Open and close of the app menu, also from F10 or a lone Alt (spec/architecture-and-platform#window-frame). */
	onAppMenu(listener: (open: boolean) => void): () => void;
	/** spec/architecture-and-platform#window-frame: `--tb` and `--fg` over it, so the OS buttons sit on the strip's own colour. */
	setChromeColors(colors: { color: string; symbolColor: string }): Promise<void>;
	readComposer(key: TaskKey): Promise<string | null>;
	saveComposer(key: TaskKey, text: string): Promise<void>;
	readToolChange(
		key: TaskKey,
		seq: number,
		index: number
	): Promise<{ scopeId: string; path: string } | null>;
	turnMenu(key: TaskKey, seq: number): Promise<'copy' | 'changes' | null>;
	readToolDiff(key: TaskKey, seq: number, index: number): Promise<ToolDiffPreview>;
	readTurnChanges(key: TaskKey, seq: number): Promise<TurnChanges>;
	readSurfaceLayout(): Promise<SurfaceLayout>;
	/** spec/task-window-workspace#restore-window: the task's surface.json (file tabs with ids again) and its unsaved buffers from a hot exit. */
	readSurface(key: TaskKey): Promise<{ surface: TaskSurface | null; drafts: SurfaceDraft[] }>;
	writeSurface(key: TaskKey, surface: TaskSurface): Promise<void>;
	writeSurfaceDrafts(key: TaskKey, drafts: SurfaceDraft[]): Promise<void>;
	/** Main asks for every task's surface now — before the window closes; `drafts` on a hot exit. */
	onSurfaceFlush(listener: (request: { id: number; drafts: boolean }) => void): () => void;
	surfaceFlushed(id: number): Promise<void>;
	saveSurfaceLayout(layout: SurfaceLayout): Promise<void>;
	pickAttachments(key: AttachmentOwner): Promise<PromptAttachment[]>;
	createAttachment(key: TaskKey, input: AttachmentInput): Promise<PromptAttachment>;
	/** spec/composer#paste: the image on the system clipboard as a prompt attachment, or null when the clipboard holds none. */
	pasteAttachment(key: AttachmentOwner, name: string): Promise<PromptAttachment | null>;
	/** spec/composer#paste: files dropped from Finder or copied there and pasted; `[]` when none of them is a file on disk. */
	attachDroppedFiles(key: AttachmentOwner, files: object[]): Promise<PromptAttachment[]>;
	readAttachment(key: AttachmentOwner, id: string): Promise<AttachmentInput>;
	/** spec/composer#mentions: an attachment's record (name, kind, size), to show the pill of a draft token after a restart. */
	readAttachmentInfo(key: AttachmentOwner, id: string): Promise<PromptAttachment>;
	/** spec/composer#mentions: attaches a snapshot summary of `source` (same project) to `key`'s next prompt. */
	attachTaskSummary(key: TaskKey, source: TaskKey): Promise<PromptAttachment>;
	/** spec/chat#images: a small PNG of an image attachment for its tile, as a `data:` URL; rejects when the image is gone or changed. */
	readAttachmentThumbnail(key: AttachmentOwner, id: string): Promise<string>;
	/** spec/chat#context-menu: the whole image attachment onto the system clipboard. */
	copyAttachmentImage(key: AttachmentOwner, id: string): Promise<void>;
	readAttribution(key: TaskKey, fileId: string, range?: AttributionRange): Promise<Attribution>;
	attachFile(key: TaskKey, fileId: string): Promise<PromptAttachment>;
	openFileTerminal(key: TaskKey, fileId: string): Promise<TerminalInfo>;
	fileMenu(
		key: TaskKey,
		fileId: string,
		source: 'tree' | 'changes'
	): Promise<'open' | 'why' | 'revert' | 'attach' | 'terminal' | 'new-file' | 'delete' | null>;
	/** spec/task-window#files-delete: asks, then moves a tree file or folder to the Trash; false when the person cancelled. */
	deleteTreeFile(key: TaskKey, fileId: string): Promise<boolean>;
	/** spec/editor#editor-context-menu: the native editor menu; path items run in main, the rest come back to the editor. */
	editorMenu(
		key: TaskKey,
		fileId: string,
		state: EditorMenuState
	): Promise<EditorMenuAction | null>;
	/** spec/editor#tab-menu: the native menu of a document tab. */
	documentTabMenu(key: TaskKey, state: DocumentTabMenuState): Promise<DocumentTabMenuAction | null>;
	/** spec/search-menus-and-commands#menu-glyphs: the glyphs of the native menus, drawn once by the renderer (the menu takes no SVG). */
	setMenuIcons(icons: MenuIconImages): Promise<void>;
	/** spec/chat#context-menu: the native chat log menu; Copy runs in main, the rest come back to the log. */
	chatMenu(state: ChatMenuState): Promise<ChatMenuAction | null>;
	terminalMenu(state: TerminalMenuState): Promise<TerminalMenuAction | null>;
	readTimeline(key: TaskKey): Promise<TimelineEntry[]>;
	selectChangeRange(key: TaskKey, range: ChangeRange | null): Promise<ChangesSnapshot>;
	revertFile(key: TaskKey, fileId: string): Promise<boolean>;
	/** spec/chat-turns-plans-and-questions#background-commands: the last lines of a background command's output (the host reads the adapter's file, at most 64 KB). */
	backgroundOutput(key: TaskKey, id: string): Promise<{ text: string; missing: boolean }>;
	browserCommand(key: TaskKey, command: BrowserCommand): Promise<unknown>;
	onBrowserEvent(listener: (value: { key: TaskKey; event: BrowserEvent }) => void): () => void;
	/** spec/remote-access-and-mobile#browser-from-device: a window of another machine streams a tab: start, stop, acks and the person's input. */
	browserScreen(key: TaskKey, command: BrowserScreenCommand): Promise<unknown>;
	onBrowserScreen(listener: (event: BrowserScreenEvent) => void): () => void;
	/** spec/remote-access-and-mobile#browser-from-device: one file the device chose for a page's file input `id`. */
	uploadPageFile(id: number, name: string, bytes: Uint8Array): Promise<void>;
	/**
	 * spec/browser-and-simulator#opening-tabs, spec/task-window-workspace#work-area: an agent's browser call opens its tab in its task (a new one for its first browser_open);
	 * `front` brings an existing tab forward (browser_show, spec/browser-and-simulator#background).
	 */
	onBrowserShow(
		listener: (value: { key: TaskKey; tab: string; front?: boolean }) => void
	): () => void;
	/** spec/task-window-workspace#work-area: a browser tab's name, address and agent state, on screen or not. */
	onBrowserTab(listener: (value: { key: TaskKey; info: BrowserTabInfo }) => void): () => void;
	/** spec/browser-and-simulator#background: tasks whose browser page lives off screen, for the sidebar marker; the listener hears every change. */
	readBrowserLive(): Promise<TaskKey[]>;
	onBrowserLive(listener: (keys: TaskKey[]) => void): () => void;
	/** spec/agents-and-providers#context-tools: main asks what the person is looking at in a task (`editor_state`, `pr_state`); the window answers by id. */
	onContextRequest(listener: (value: { id: string; key: TaskKey }) => void): () => void;
	answerContextRequest(
		id: string,
		report: import('./context-state').ContextReport | null
	): Promise<void>;
	simulatorCommand(projectId: string, command: SimulatorCommand): Promise<unknown>;
	readSimulatorToolchain(): Promise<SimulatorToolchain>;
	onSimulatorEvent(listener: (value: SimulatorEvent) => void): () => void;
	onSimulatorFrame(listener: (value: SimulatorFrame & { projectId: string }) => void): () => void;
	terminalCommand(
		key: TaskKey,
		command: TerminalCommand
	): Promise<TerminalInfo[] | TerminalInfo | TerminalSnapshot | string | null>;
	/** spec/search-menus-and-commands#project-commands: a saved command runs by id (main reads its line from project.json); «Run once» sends the line. */
	readCommandRuns(key: TaskKey): Promise<TerminalInfo[]>;
	runProjectCommand(
		key: TaskKey,
		ref: import('./project-commands').CommandRunRef
	): Promise<TerminalInfo>;
	/** spec/search-menus-and-commands#package-scripts: the `package.json` scripts of every repo of a project, read from its main tree. */
	readProjectScripts(projectId: string): Promise<import('./package-scripts').ProjectScripts>;
	saveProjectCommands(
		projectId: string,
		commands: import('./project-commands').ProjectCommand[]
	): Promise<Project>;
	projectCommandMenu(state: {
		running: boolean;
		shown: boolean;
		port: boolean;
	}): Promise<
		'run' | 'stop' | 'restart' | 'show' | 'open' | 'edit' | 'duplicate' | 'delete' | null
	>;
	onTerminalEvent(listener: (value: { key: TaskKey; event: TerminalEvent }) => void): () => void;
	/** spec/composer#mention-menu: `folders` — the `@` menu also lists folders (`kind: 'directory'`). */
	searchFiles(
		key: TaskKey,
		query: string,
		showIgnored?: boolean,
		folders?: boolean
	): Promise<FileSearchResult>;
	/** spec/search-menus-and-commands#search-tabs: Text of Search Everywhere; results arrive through `onTextSearch` under `id`. */
	searchText(key: TaskKey, request: TextSearchRequest, id: string): Promise<void>;
	cancelTextSearch(id: string): Promise<void>;
	/** spec/search-menus-and-commands#search-tabs: a file for the Text preview, read without the editor's lease. */
	peekFile(key: TaskKey, id: string): Promise<FileContent>;
	readTextSearchRepos(key: TaskKey): Promise<string[]>;
	onTextSearch(listener: (event: TextSearchEvent) => void): () => void;
	/** spec/search-menus-and-commands#search-tabs: runs a menu item, as its click would. */
	runMenuCommand(id: string): Promise<void>;
	onWorkspaceAction(listener: (action: WorkspaceAction) => void): () => void;
	/** spec/composer#slash-menu: a menu action run from the app itself (the `/` menu's actions); it reaches the same listeners as a menu-bar click. */
	dispatchWorkspaceAction(action: WorkspaceAction): void;
	/** spec/composer#slash-menu: what the agent will see in `/`, read from disk: a task's (its tree, crew role, PR review) or a project's for the New task sheet. */
	readSlashCatalog(request: {
		projectId: string;
		provider: 'claude' | 'codex';
		taskId?: string;
		crew?: boolean;
	}): Promise<import('./slash-menu').SlashCatalog>;
	onReviewChanged(listener: (key: TaskKey) => void): () => void;
	compareEditorFile(
		key: TaskKey,
		id: string,
		text: string
	): Promise<Pick<FileDiff, 'lines' | 'pairs' | 'tooLarge'>>;
	readEditorSyntax(key: TaskKey, id: string, text: string): Promise<SyntaxSnapshot>;
	/** spec/editor#change-marks: the buffer's change hunks against the base setting. */
	readEditorGutter(key: TaskKey, id: string, text: string): Promise<EditorGutter>;
	/** spec/editor#line-author: the line author of every buffer line, and one commit's message for the card. */
	readEditorBlame(key: TaskKey, id: string, text: string): Promise<EditorBlame>;
	readBlameMessage(key: TaskKey, id: string, sha: string): Promise<string>;
	/**
	 * Null when the buffer has no review: not in the latest snapshot, or changed since (spec/diff-and-review#scope-kinds); `outside` when the file is
	 * in no repo of the task, so the editor says that instead of «save or refresh».
	 */
	readEditorReview(
		key: TaskKey,
		id: string,
		version: string
	): Promise<ReviewSnapshot | 'outside' | null>;
	addEditorComment(key: TaskKey, input: EditorCommentInput): Promise<void>;
	listFiles(key: TaskKey, directoryId: string | null, showIgnored?: boolean): Promise<FileListing>;
	readEditorFile(key: TaskKey, id: string): Promise<EditorDocument>;
	/** spec/editor#new-file: an empty file at a path in the task's root (folders included); `created` false — it was there and is opened. */
	createEditorFile(
		key: TaskKey,
		path: string
	): Promise<{ created: boolean; document: EditorDocument }>;
	/** spec/chat-turns-plans-and-questions#plan-approval: the copy of a plan for approval in the task folder, written once per request and opened in the editor. */
	openPlanFile(key: TaskKey, requestId: string, text: string): Promise<EditorDocument>;
	/** The copy's current text (`null` before it is opened) and its `~/…` path. */
	readPlanFile(
		key: TaskKey,
		requestId: string,
		text: string
	): Promise<{ text: string | null; path: string }>;
	/** The open editor's disk poll: the document only when its version differs from `version`, else the lease state. */
	checkEditorFile(
		key: TaskKey,
		id: string,
		version: string
	): Promise<EditorDocument | { locked: boolean }>;
	openDiffFile(key: TaskKey, fileId: string): Promise<EditorDocument>;
	/** `afterTurn` (spec/editor#save-during-turn): during a turn the host writes it when the turn ends; the promise settles then. */
	saveEditorFile(
		key: TaskKey,
		id: string,
		version: string,
		text: string,
		afterTurn?: boolean
	): Promise<SaveFileResult>;
	setEditorDirty(key: TaskKey, id: string, dirty: boolean): Promise<void>;
	releaseEditorFile(key: TaskKey, id: string): Promise<void>;
	/** spec/editor-code-intelligence#architecture: offsets are UTF-16 in the renderer's own document `version`; a stale version answers null. */
	openCode(key: TaskKey, id: string, text: string): Promise<CodeStatus>;
	changeCode(
		key: TaskKey,
		id: string,
		version: number,
		changes: CodeChange[]
	): Promise<CodeChangeResult>;
	closeCode(key: TaskKey, id: string): Promise<void>;
	completeCode(
		key: TaskKey,
		id: string,
		version: number,
		offset: number,
		trigger: CodeTrigger
	): Promise<CodeCompletionList | null>;
	resolveCompletion(
		key: TaskKey,
		id: string,
		version: number,
		list: number,
		item: number
	): Promise<CodeCompletionDetail | null>;
	hoverCode(key: TaskKey, id: string, version: number, offset: number): Promise<CodeHover | null>;
	signatureCode(
		key: TaskKey,
		id: string,
		version: number,
		offset: number,
		trigger: CodeTrigger
	): Promise<CodeSignatureHelp | null>;
	definitionCode(
		key: TaskKey,
		id: string,
		version: number,
		offset: number
	): Promise<CodeLocations | null>;
	referencesCode(
		key: TaskKey,
		id: string,
		version: number,
		offset: number
	): Promise<CodeLocations | null>;
	onCodeProblems(listener: (event: CodeProblemsEvent) => void): () => void;
	/** spec/editor-code-intelligence#format-on-save: edits in the synced document `version`; the source for the footer; Settings ▸ Editor rows. */
	formatCode(
		key: TaskKey,
		id: string,
		version: number,
		reason: CodeFormatReason
	): Promise<CodeFormatResult>;
	formatInfoCode(key: TaskKey, id: string): Promise<CodeFormatInfo>;
	/** spec/editor#indentation: what the project's Prettier or .editorconfig says about this file's indentation. */
	indentInfoCode(key: TaskKey, id: string): Promise<CodeIndentInfo>;
	/** spec/editor-code-intelligence#language-server-restart: restarts the language servers of the task's documents; the names of those restarted. */
	restartCode(key: TaskKey): Promise<CodeRestartResult>;
	/** spec/editor-code-intelligence#language-server-restart: tasks whose documents went through a restart; their editors reopen them. */
	onCodeRestarted(listener: (keys: TaskKey[]) => void): () => void;
	/** spec/pull-requests-and-ci#review-notes: saves the project's review notes (null removes them); the workspace reloads. */
	setProjectReviewNotes(
		projectId: string,
		notes: import('./workspace').ProjectReviewNotes | null
	): Promise<void>;
	readFormatters(): Promise<ProjectFormatterInfo[]>;
	setProjectFormatter(
		projectId: string,
		formatter: ProjectFormatter
	): Promise<ProjectFormatterInfo[]>;
	onNavigate(listener: (route: 'workspace' | 'kit') => void): () => void;
	onEditorAction(listener: (action: EditorAction) => void): () => void;
	addProject(): Promise<Project | null>;
	/** spec/appearance#evolution-redesign: the person's icon from the picker (`null` — back to the monogram of the name). */
	setProjectIcon(projectId: string, icon: ProjectIcon | null): Promise<Project>;
	/** «Pick again»: the agent picks once more; `off` — no hint model, `failed` — no usable answer (the icon stays). */
	pickProjectIcon(projectId: string): Promise<'picked' | 'failed' | 'off'>;
	/** «From repo»: the app icons found in the project's repo, each as a small PNG. */
	readProjectRepoIcons(projectId: string): Promise<RepoIconCandidate[]>;
	setProjectRepoIcon(projectId: string, path: string, color: ProjectIconColor): Promise<Project>;
	/** spec/projects-and-board#project-icon: the person's image, already a square PNG; main keeps it as the project's `icon.png`. */
	setProjectImageIcon(projectId: string, png: Uint8Array): Promise<Project>;
	/** «Your image»: the project's `icon.png` as a 72 px PNG, also while another icon is chosen; null — none yet. */
	readProjectImageIcon(projectId: string): Promise<string | null>;
	/** «Generate with Codex»: `off` — Codex is off, missing or out of quota; `failed` — no image (the icon stays). */
	generateProjectIcon(projectId: string, hint: string): Promise<'generated' | 'failed' | 'off'>;
	/** spec/settings-modules-and-onboarding#intro: a folder dropped on the intro's first-project step; the preload turns the File into its path. */
	addDroppedProject(file: object): Promise<Project | null>;
	/** `prompt` is the message; `sheet` carries the manual name and the model choice made on the sheet (spec/tasks#sheet-model). */
	createTask(
		projectId: string,
		prompt: string,
		provider: 'claude' | 'codex',
		transport?: 'gui' | 'terminal',
		backlog?: boolean,
		launch?: TaskLaunch,
		crew?: CrewLaunch,
		sheet?: TaskSheet
	): Promise<AgentTask>;
	/** spec/tasks#backlog-edit: the text of a .md file the person picks, pasted into the description once; null when cancelled. */
	readMarkdownDescription(): Promise<{ name: string; text: string } | null>;
	/** spec/tasks#backlog-edit: the sheet's «+» menu, natively at the button. */
	sheetAttachMenu(x: number, y: number): Promise<'files' | 'markdown' | null>;
	/** spec/tasks#backlog-edit: a sheet closed without a task drops its draft attachments. */
	discardAttachmentDraft(owner: AttachmentOwner): Promise<void>;
	readTemplates(): Promise<CrewLibrary>;
	saveAgentTemplate(template: AgentTemplate): Promise<CrewLibrary>;
	saveCrewTemplate(template: CrewTemplate): Promise<CrewLibrary>;
	deleteTemplate(kind: 'agent' | 'crew', id: string): Promise<CrewLibrary>;
	/** spec/pull-requests-and-ci#review-crew: built-in crews deleted in Settings ▸ Templates come back. */
	restoreCrewTemplates(): Promise<CrewLibrary>;
	exportTemplate(kind: 'agent' | 'crew', id: string): Promise<boolean>;
	importTemplate(): Promise<CrewLibrary | null>;
	readProviderCatalog(provider: 'claude' | 'codex'): Promise<ProviderCatalog | null>;
	readFileLinks(key: TaskKey, texts: FilePathText[]): Promise<FilePathLink[][]>;
	readCodeSyntax(language: string, text: string): Promise<SyntaxSnapshot>;
	readReviewPositions(key: TaskKey, commentId: string): Promise<ReviewPosition[]>;
	readReview(key: TaskKey, fileId: string | null): Promise<ReviewSnapshot>;
	addReviewNote(key: TaskKey, text: string): Promise<void>;
	addComment(key: TaskKey, input: CommentInput): Promise<void>;
	editComment(key: TaskKey, id: string, text: string): Promise<void>;
	readCommentFile(key: TaskKey, id: string): Promise<EditorDocument>;
	resolveComment(key: TaskKey, id: string, resolved: boolean): Promise<void>;
	removeReviewSelection(
		key: TaskKey,
		selection: import('./review').ReviewSelection
	): Promise<boolean>;
	removeComment(key: TaskKey, id: string): Promise<void>;
	prepareReview(key: TaskKey): Promise<SessionCommand>;
	readChanges(key: TaskKey): Promise<ChangesSnapshot>;
	readFileDiff(key: TaskKey, fileId: string): Promise<FileDiff>;
	/** Highlighting of a `readFileDiff` result, asked after the diff is shown. */
	readFileSyntax(
		key: TaskKey,
		fileId: string
	): Promise<Pick<FileDiff, 'beforeSyntax' | 'afterSyntax'>>;
	/** `afterSeq` returns only newer records (the rest of the snapshot is current); `sessionStateOnly` returns none. */
	readSession(key: TaskKey, afterSeq?: number): Promise<SessionSnapshot>;
	/** Readiness, a running turn and whether an agent ever started, without the journal. */
	readSessionActivity(
		key: TaskKey
	): Promise<{ connected: boolean; busy: boolean; started: boolean }>;
	startSession(key: TaskKey): Promise<SessionSnapshot>;
	sendCommand(key: TaskKey, command: SessionCommand): Promise<void>;
	onSessionEvent(
		listener: (value: { key: TaskKey; record: EventRecord | null }) => void
	): () => void;
	readWorkspace(): Promise<WorkspaceSnapshot>;
	readAppearance(): Promise<Appearance>;
	onAppearanceChanged(listener: (appearance: Appearance) => void): () => void;
	// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: remote access. The working machine's side (Settings ▸ Remote, the cover):
	/** Read-only from a remote client: `editable` false and no pairing code. */
	readRemoteAccess(): Promise<RemoteAccessStatus>;
	/** Turning on needs a password the first time; any change drops every remote connection. */
	setRemoteAccess(enabled: boolean, password?: string): Promise<RemoteAccessStatus>;
	/** Sets or changes the password; drops every remote connection (spec/remote-access-and-mobile#client-ui-seam). */
	setRemotePassword(password: string): Promise<RemoteAccessStatus>;
	/** null — back to the system's name. */
	renameRemoteMachine(name: string | null): Promise<RemoteAccessStatus>;
	revokeRemoteDevice(deviceId: string): Promise<RemoteAccessStatus>;
	revokeAllRemoteDevices(): Promise<RemoteAccessStatus>;
	unblockRemoteDevice(deviceId: string): Promise<RemoteAccessStatus>;
	/** The cover's «Disconnect <device>»: drops its connection now, the device stays paired. */
	disconnectRemoteDevice(deviceId: string): Promise<RemoteAccessStatus>;
	/** Opens the 5-minute pairing window with a fresh code. */
	startRemotePairing(): Promise<RemotePairing>;
	stopRemotePairing(): Promise<RemotePairing>;
	/** The person confirms (or declines) the device whose code matched; `name` overrides the name it sent. */
	confirmRemotePairing(accept: boolean, name: string | null): Promise<RemotePairing>;
	/** The newest entries of `remote/audit.jsonl` first. */
	readRemoteAudit(limit: number): Promise<RemoteAuditEntry[]>;
	/** «Show in file manager» under the log: `remote/audit.jsonl` on the working machine (hidden from a device, spec/remote-access-and-mobile#architecture). */
	revealRemoteAudit(): Promise<void>;
	/** spec/remote-access-and-mobile#phone-network: the web listener for a phone on or off; its state comes in `phone` of the status. */
	setRemotePhone(enabled: boolean): Promise<RemoteAccessStatus>;
	/** Asks Tailscale again for the machine's name and `tailscale serve`. */
	checkRemotePhone(): Promise<RemoteAccessStatus>;
	/** The caller takes control: «Take back» in the local window, «Take control again» from a device (spec/remote-access-and-mobile#architecture). */
	takeRemoteControl(): Promise<RemoteControl>;
	onRemoteStatus(listener: (status: RemoteAccessStatus) => void): () => void;
	onRemoteControl(listener: (control: RemoteControl) => void): () => void;
	onRemoteNotice(listener: (notice: RemoteNotice) => void): () => void;
	// The device's side (`File ▸ Connect…`), run by the main of the machine showing the window:
	readRemoteMachines(): Promise<PairedMachine[]>;
	/** mDNS search while the Connect list is open; results come as `onRemoteFound`. */
	browseRemoteMachines(on: boolean): Promise<void>;
	pairRemoteMachine(
		host: string,
		port: number | null,
		code: string,
		deviceName: string | null
	): Promise<RemotePairResult>;
	/** Stops the pairing in progress (the device side's «Cancel» while the machine asks its person). */
	cancelPairRemoteMachine(): Promise<void>;
	/** The code went through: the machine asks its person to confirm the device. */
	onRemotePairProgress(listener: (progress: RemotePairProgress) => void): () => void;
	forgetRemoteMachine(machineId: string): Promise<void>;
	/** Connects and opens the machine's window; the password is never stored. */
	connectRemoteMachine(
		machineId: string,
		password: string,
		takeOver: boolean
	): Promise<RemoteConnectResult>;
	disconnectRemoteMachine(machineId: string): Promise<void>;
	/** spec/remote-access-and-mobile#remote-button: shows the window of `machineId` when it is open; otherwise this machine's task window, with the list
	 *  «Connect» open when `connect` (it hears `onRemoteOpen`): on that machine, or on `New machine…` for null. */
	showRemoteWindow(machineId: string | null, connect: boolean): Promise<void>;
	onRemoteOpen(listener: (machineId: string | null) => void): () => void;
	readRemoteSessions(): Promise<RemoteSession[]>;
	onRemoteSessions(listener: (sessions: RemoteSession[]) => void): () => void;
	onRemoteFound(listener: (machines: FoundMachine[]) => void): () => void;
	/** spec/remote-access-and-mobile#networking: each paired machine's answer to a TLS touch while the list is open. */
	onRemoteReach(listener: (reach: RemoteReach[]) => void): () => void;
	// spec/remote-access-and-mobile#client-ui-seam: what the working machine asks a device to show, and the device's answers.
	/** A menu item id or null, a button index, a chosen path or null, whether the file was saved. */
	answerRemoteUi(id: number, answer: RemoteUiAnswer): Promise<void>;
	/** The folder browser of an open choice `id`: a folder of the working machine (its home for null). */
	listRemoteFolder(id: number, path: string | null, hidden: boolean): Promise<RemoteFsListing>;
	/** `New folder…` in the folder browser; the new folder's path. */
	createRemoteFolder(id: number, parent: string, name: string): Promise<string>;
	/** A notice's button on the device in control. */
	actOnRemoteNotice(id: number, action: 'allow' | 'deny'): Promise<void>;
	/** The device's main shows these itself; a window never sees them. */
	onRemoteMenu(listener: (menu: RemoteMenu) => void): () => void;
	onRemoteSave(listener: (save: RemoteSave) => void): () => void;
	/** spec/remote-access-and-mobile#browser-from-device: a page's file input — the device's main chooses files on its own disk. */
	onRemoteFiles(listener: (request: RemoteFileChoice) => void): () => void;
	/** spec/remote-access-and-mobile#browser-from-device: the device closes its window of this machine; `flush` answers the buffers hot exit could not keep. */
	closingRemoteWindow(phase: 'flush' | 'keep'): Promise<string[] | null>;
	onRemoteNotify(listener: (notify: RemoteNotify) => void): () => void;
	onRemoteAppearance(listener: (appearance: MachineAppearance) => void): () => void;
	/** A message box or a choice of the working machine, for the window that shows it. */
	onRemoteDialog(listener: (dialog: RemoteDialog) => void): () => void;
	/** The working machine's part of the appearance: its settings, without the device's theme and fonts. */
	readMachineAppearance(): Promise<MachineAppearance>;
	readPullRequestPageUrl(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		number: number | null
	): Promise<string>;
	readPullRequestLinkUrl(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		url: string
	): Promise<string>;
	readPullRequestUrl(key: TaskKey, scopeId: string): Promise<string>;
	/** A file a device read on its own disk, into the owner's attachments on the working machine. */
	uploadAttachment(
		key: AttachmentOwner,
		name: string,
		bytes: Uint8Array,
		image: boolean
	): Promise<PromptAttachment>;
};
/** spec/remote-access-and-mobile#client-ui-seam: the appearance a device takes from the working machine; the device adds its theme, accent and fonts. */
export type MachineAppearance = Omit<Appearance, 'dark' | 'accent' | 'fonts' | 'missingFonts'>;
