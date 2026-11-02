import {
	isMarkdownPath,
	selectDocument,
	documentForBrowser,
	documentForDiff,
	documentForFile,
	documentForSimulator,
	documentForTerminal,
	allGroupTabs,
	bottomGroup,
	groupLeaves,
	chatTabAfter,
	firstTaskLayout,
	fitWorkArea,
	holdWorkArea,
	holdsWorkArea,
	focusedTabs,
	isMainTree,
	isToolTab,
	openToolTab,
	removeGroup,
	shownTabs,
	singleGroup,
	withFocusedTabs,
	workAreaTabs,
	MAIN_TREE_ID,
	type DocumentTab,
	type DocumentTabs,
	type EditorGroups,
	type TaskLayout,
	type ToolTabKind,
	type CommitBasket,
} from '@brigadir/core';
import type { EditorModel } from './editor-model';
import { evictBuffers, restoreBuffer, touchBuffer, type EvictedEditor } from './editor-buffers';
import { keepCommitDiff, type CommitDiffEntry } from './commit-diffs';
import { readSessionState } from './session-read';
import { opensEditor } from './panel-visibility';
import { draftsOf, trackSurface, untrackSurface } from './task-surface';
import type { RowsPosition } from './ui/Rows';
import { useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import { createStore } from 'zustand';
import {
	attachmentToken,
	attachmentTotalLimit,
	type AttachmentInput,
	type PromptAttachment,
	type ChangeRange,
	AgentTask,
	EditorDocument,
	FileEntry,
	QuestionAnswer,
} from '@brigadir/core';
/** One step of the editor location history (spec/editor-code-intelligence#typescript-features). */
export type CodePlace = { fileId: string; line: number; column: number };
export type CommentDraftState = {
	fileId: string;
	side: 'old' | 'new';
	start: number;
	end: number;
	text: string;
	editingId: string | null;
	/** spec/appearance#evolution-redesign: the selected text the draft quotes, and its characters to keep painted while the draft is open. */
	quote?: string | undefined;
	marks?: import('./code-selection').CodeMark[] | undefined;
	/** spec/appearance#evolution-redesign: opened by «Comment on it» on a summary marker — no selection, so no selection panel above it. */
	fromSpot?: true | undefined;
};
export type TaskState = DocumentTabs & {
	/** spec/editor#editor-groups: the editor groups (Split). `documents` / `activeDocument` hold the focused group's tabs; its leaf in the tree is
	 *  refreshed from them before every group operation (`groupsNow`). */
	editorGroups: EditorGroups;
	/** spec/git#merge: the changes panel switch and the History selection live with the task while the app is open. */
	changesView: 'diff' | 'history' | 'turns';
	historyScope: string | null;
	historyBranch: string | null;
	/** spec/pull-requests-and-ci#pr-list: the PR panel — the repo filter from the counter, the open PR and its tab; the list search. */
	/** spec/pull-requests-and-ci#pr-summary: a PR file opened from the summary — the «From the summary: … · Back to Overview» strip and highlighted lines. */
	/** `overview` — the tab «Back» returns to: Overview, or the file a definition jump came from (`from`, spec/pull-requests-and-ci#pr-definition). */
	prCrumb: {
		key: string;
		text: string;
		start: number | null;
		end: number | null;
		overview: string;
		from?: { path: string; line: number };
	} | null;
	/** spec/pull-requests-and-ci#hand-to-agent: threads of one's own PR handed to the agent in this app run (the «Handed to the agent» mark). */
	prHanded: string[];
	prFilter: string | null;
	prOpen: { scopeId: string; number: number } | null;
	prLast: { scopeId: string; number: number } | null;
	prTab: 'comments' | 'files' | 'commits' | 'checks';
	prSearch: string | null;
	/** spec/pull-requests-and-ci#ci: the PR panel segment — the PR list or CI runs; a run's page and the run list filters. */
	prSegment: 'prs' | 'ci';
	ciOpen: { scopeId: string; runId: number } | null;
	ciBranch: string | null;
	ciWorkflow: string | null;
	/** spec/pull-requests-and-ci#pr-panel: the search in the changes panel header is expanded to the whole row. */
	changesSearch: boolean;
	/** spec/editor#line-author: History narrowed to one file of `historyScope`, a path inside that repo; `null` is the whole branch. */
	historyPath: string | null;
	ghostDismissedTurn: number | null;
	commitMessage: string | null;
	/** spec/git#commit-dialog: the commit dialog — open (with the repo it was opened for), its baskets and set-aside files
	 *  (`fileKey`), and the baskets before the agent's split for Undo. They live with the task while the app is open. */
	commitDialog: { scopeId: string | null } | null;
	/** spec/appearance#evolution-redesign: the Conflicts dialog of a repo and, over it, the merge in three columns of one file. */
	conflictsDialog: { scopeId: string; file: string | null; abort?: boolean } | null;
	commitBaskets: { baskets: CommitBasket[]; aside: string[] } | null;
	commitUndo: { baskets: CommitBasket[]; aside: string[]; before: number; after: number } | null;
	commitDiffs: Record<string, CommitDiffEntry>;
	scopeTarget: string | null;
	activityExpanded: Map<string, boolean>;
	activityTarget: string | null;
	/** spec/appearance#evolution-redesign: code blocks shown whole past their first 8 lines, by `<row>/<index>`. */
	codeShown: Set<string>;
	/** `focus`: the editor takes the keyboard there (spec/editor#new-file, a new file). */
	editorTarget: {
		id: string;
		line: number;
		/** spec/chat#code-pills: the last line of a selection from `line` (a pill of lines). */
		end?: number;
		column?: number;
		definition?: { text: string };
		focus?: boolean;
	} | null;
	locationHistory: { back: CodePlace[]; forward: CodePlace[] };
	codeNotice: string;
	reviewTarget: string | null;
	/** spec/editor#change-marks: «Open diff» from the editor peek scrolls the diff to the hunk at this buffer line, then clears it. */
	diffLineTarget: number | null;
	fileSelection: string | null;
	/** spec/chat#folder-links: a folder link asks Files to scroll to this row once it is listed. */ fileReveal:
		string | null;
	fileFilter: string;
	showIgnored: boolean;
	reviewOpen: boolean;
	whyFile: string | null;
	focusTurn: number | null;
	focusTurnNumber: number | null;
	returnToDiff: boolean;
	changeRange: ChangeRange | null;
	/** spec/task-window-workspace#layout-switch: the Layout switches — the chat, the work area and the panel (Files · Changes · PR). The chat and the work area
	 *  are never both off (the setter keeps one). spec/task-window-workspace#empty-work-area: a work area without tabs is off — a new task shows only the chat.
	 *  spec/task-window-workspace#restore-window keeps the three per task on disk. */
	chatShown: boolean;
	workShown: boolean;
	panelShown: boolean;
	/** spec/task-window-workspace#two-columns: two columns — the pinned Chat tab is the one the work area's first group shows (a group without a tab
	 *  shows the chat anyway). Kept in three columns too, so switching back and forth keeps the place. */
	chatTab: boolean;
	/** spec/task-window-workspace#two-columns: a turn ended while the Chat tab was not on screen; the tab carries an accent dot until it is opened. */
	chatUnread: boolean;
	/** spec/task-window-workspace#work-area: where Tools opens a new terminal, browser or the simulator; remembered for the task. */
	toolPlace: 'focused' | 'bottom';
	/** spec/task-window-workspace#work-area: the bottom group stands under the chat — the work area hidden or beside it (menu item or drag). */
	bottomUnderChat: boolean;
	/** spec/task-window-workspace#restore-window: the task's own column widths (the chat, the panel, the bottom group under the chat); a width it never set
	 *  follows `surface-layout.json`, the default of every new task. */
	widths: Partial<Record<'chatWidth' | 'changesWidth' | 'consoleHeight', number>>;
	/** spec/task-window-workspace#restore-window: terminal tabs a restart brought back — session id → its folder (`null`: the task root). A session the
	 *  host no longer has stays as «Session ended · Open again» instead of taking its tab with it. */
	terminalRestored: Record<string, string | null>;
	/** spec/task-window-workspace#work-area: the tool tab of each kind shown last; ⇧⌘B / ⇧⌘Y / ⇧⌘M go back to it. */
	lastTools: Partial<Record<ToolTabKind, string>>;
	/** The CLI agent's terminal (spec/terminal-and-cli-agents#cli-transport); the console's sessions are tabs of the work area (spec/task-window-workspace#work-area). */
	terminalActive: Record<'console' | 'agent', string | null>;
	/** spec/task-window-workspace#work-area: a terminal tab's × while its process lives — the tab asks to stop it first. */
	terminalClosing: string | null;
	reviewCompact: boolean;
	generalDraft: string;
	attachments: PromptAttachment[];
	/** spec/composer#mentions: attachments waiting for their token in the composer text, at the caret or the end. */ composerInserts: string[];
	terminalScroll: Map<string, { distance: number; follow: boolean }>;
	positions: Map<string, RowsPosition>;
	fileChildren: Record<string, FileEntry[]>;
	fileExpanded: Set<string>;
	/** spec/appearance#evolution-redesign: the repo roots folded in Changes (Files keeps its own in `fileExpanded`). */ changesFolded: Set<string>;
	diffExpanded: Map<string, Set<string>>;
	editorDraft: {
		fileId: string;
		version: string;
		start: number;
		end: number;
		text: string;
		editingId: string | null;
		/** spec/appearance#evolution-redesign */ quote?: string | undefined;
	} | null;
	/** spec/composer-steering-queue-and-ghost#quick-question: the open quick question popover — its surface, file and lines (the thread itself lives in quick-ask-store).
	 *  spec/appearance#evolution-redesign: `quote` is the selected text, `marks` its characters in a diff, painted while the popover is open. */
	quickAsk:
		| (import('./quick-ask-store').QuickAnchor & {
				fileId: string;
				quote?: string | undefined;
				marks?: import('./code-selection').CodeMark[] | undefined;
		  })
		| null;
	/** spec/search-menus-and-commands#project-commands: the command the toolbar button shows; the last one run or picked in this task. */
	commandCurrent: string | null;
	commentDraft: CommentDraftState | null;
	surface: 'chat' | 'diff' | 'editor';
	editorTabs: EditorModel[];
	activeEditor: string | null;
	/** File tabs whose clean buffer the LRU dropped (editor-buffers.ts); activating one reads the file again. */
	evictedEditors: Map<string, EvictedEditor>;
	panel: 'changes' | 'files' | 'prs';
	selected: string | null;
	filter: string;
	mode: string;
	wrap: boolean;
	/** spec/editor#markdown-views: the view of each Markdown editor tab (none: a new tab, Preview) and the diff's rendered view, one per task like `wrap`. */
	markdownViews: Map<string, MarkdownView>;
	diffPreview: boolean;
	composerLoaded: boolean;
	composerRevision: number;
	focusComposer: boolean;
	text: string;
	answers: Record<string, QuestionAnswer>;
	historyLoaded: boolean;
};
const parked = new Map<string, ReturnType<typeof makeState>>();
function makeState(task: AgentTask) {
	const mainTree = isMainTree(task);
	const store = createStore<TaskState>(() => ({
		changesView: 'diff',
		prFilter: null,
		prOpen: null,
		prLast: null,
		prCrumb: null,
		prHanded: [],
		prTab: 'comments',
		prSearch: null,
		prSegment: 'prs',
		ciOpen: null,
		ciBranch: null,
		ciWorkflow: null,
		changesSearch: false,
		historyScope: null,
		historyBranch: null,
		historyPath: null,
		ghostDismissedTurn: null,
		commitMessage: null,
		commitDialog: null,
		conflictsDialog: null,
		commitBaskets: null,
		commitUndo: null,
		commitDiffs: {},
		scopeTarget: null,
		activityExpanded: new Map(),
		activityTarget: null,
		codeShown: new Set(),
		editorTarget: null,
		locationHistory: { back: [], forward: [] },
		codeNotice: '',
		reviewTarget: null,
		diffLineTarget: null,
		fileSelection: null,
		fileReveal: null,
		fileFilter: '',
		showIgnored: false,
		documents: [],
		activeDocument: null,
		editorGroups: singleGroup(),
		reviewOpen: false,
		whyFile: null,
		focusTurn: null,
		focusTurnNumber: null,
		returnToDiff: false,
		changeRange: null,
		chatShown: true,
		// spec/task-window-workspace#empty-work-area: a new task has no tabs, so no work area; the first tab it opens shows it. The main tree's work area always
		// stays: without a tab it shows its empty state.
		workShown: mainTree,
		panelShown: firstTaskLayout(mainTree).panel,
		chatTab: true,
		chatUnread: false,
		toolPlace: 'focused',
		bottomUnderChat: false,
		widths: {},
		terminalRestored: {},
		lastTools: {},
		terminalActive: { console: null, agent: null },
		terminalClosing: null,
		reviewCompact: false,
		generalDraft: '',
		attachments: [],
		composerInserts: [],
		terminalScroll: new Map(),
		positions: new Map(),
		fileChildren: {},
		fileExpanded: new Set(['root']),
		changesFolded: new Set(),
		diffExpanded: new Map(),
		composerLoaded: false,
		composerRevision: 0,
		focusComposer: false,
		editorDraft: null,
		quickAsk: null,
		editorTabs: [],
		activeEditor: null,
		evictedEditors: new Map(),
		panel: 'changes',
		commandCurrent: null,
		commentDraft: null,
		surface: 'chat',
		selected: null,
		filter: '',
		mode: 'unified',
		// spec/chat#code-pills: lines wrap by default, in the diff and the editor.
		wrap: true,
		markdownViews: new Map(),
		diffPreview: false,
		text: task.prompt ?? '',
		answers: {},
		historyLoaded: false,
	}));
	const write = store.setState;
	store.setState = ((
		update: Partial<TaskState> | ((state: TaskState) => Partial<TaskState>),
		replace?: boolean
	) => {
		write((current) => {
			const patch = typeof update === 'function' ? update(current) : update;
			// An updater that returns the state itself changes nothing and wakes no subscriber.
			if (patch === current) return current;
			const opened = replace ? (patch as TaskState) : { ...current, ...patch };
			// spec/task-window-workspace#layout-switch: anything that puts a document on screen shows the work area; the chat's own surface shows the chat.
			// A patch that sets the switch itself decides. All three may go: the task then shows its empty state.
			const laid = {
				...opened,
				...(!opened.workShown &&
				!('workShown' in patch) &&
				opensEditor(patch, current.documents.length)
					? { workShown: true }
					: {}),
				...(!opened.chatShown && !('chatShown' in patch) && patch.surface === 'chat'
					? { chatShown: true }
					: {}),
			};
			// spec/task-window-workspace#work-area: the tool tab of each kind shown last, for its shortcut.
			const tool =
				laid.activeDocument !== current.activeDocument
					? laid.documents.find((tab) => tab.id === laid.activeDocument)
					: undefined;
			const next =
				tool && isToolTab(tool) && laid.lastTools[tool.kind] !== tool.id
					? { ...laid, lastTools: { ...laid.lastTools, [tool.kind]: tool.id } }
					: laid;
			return withChatTab(
				fitShown(arrange(next, patch, current), current, mainTree),
				patch,
				current
			);
		}, true);
	}) as typeof store.setState;
	// spec/task-window-workspace#restore-window: the task reads its surface.json now and writes it after each change.
	trackSurface(task, store, applyGroups);
	return store;
}
/** The documents of a change put in line: every entry point (search, attribution, file tree and tabs) shares identities. */
function arrange(next: TaskState, patch: Partial<TaskState>, current: TaskState): TaskState {
	if (!('documents' in patch)) {
		if (patch.surface === 'diff' && next.selected)
			return { ...next, ...selectDocument(next, documentForDiff(next.selected)) };
		if ((patch.surface === 'editor' || 'activeEditor' in patch) && next.activeEditor) {
			const buffer = next.editorTabs.find((tab) => tab.document.id === next.activeEditor),
				path = buffer?.document.path ?? next.evictedEditors.get(next.activeEditor)?.path;
			if (path !== undefined)
				return settle(
					{ ...next, ...selectDocument(next, documentForFile(next.activeEditor, path)) },
					current
				);
		}
	}
	return settle(collapseEmpty(next), current);
}
/**
 * spec/task-window-workspace#empty-work-area: an empty work area is never shown. With the bottom group under the chat, the rest of the work area keeps its
 * place as one empty group when its last tab closes; that place goes once the group is back in the work area. Then
 * a work area without tabs hides; nothing comes back in its place. The main tree's stays and shows its empty
 * state.
 */
function fitShown(next: TaskState, current: TaskState, mainTree: boolean): TaskState {
	let state = next;
	const underChat = !mainTree && state.bottomUnderChat && state.chatShown,
		groups = groupsNow(state),
		before = current.editorGroups.root;
	if (underChat && groups.root.kind === 'group' && before.kind === 'split') {
		const bottom = bottomGroup(groupsNow(current));
		if (bottom && bottom.id === groups.root.id)
			state = { ...state, ...applyGroups(holdWorkArea(groups, before.ratio)) };
	} else if (!underChat && holdsWorkArea(groups) && groups.root.kind === 'split')
		state = { ...state, ...applyGroups(removeGroup(groups, groups.root.first.id)) };
	const tabs = workAreaTabs(groupsNow(state), underChat).length,
		layout = layoutOf(state),
		fitted = fitWorkArea(layout, tabs, mainTree);
	return fitted === layout
		? state
		: { ...state, chatShown: fitted.chat, workShown: fitted.work, panelShown: fitted.panel };
}
/**
 * spec/task-window-workspace#two-columns: the pinned Chat tab of two columns. The chat's own surface shows it; a document the person chooses for the
 * focused first group, or a tab that group switches to, hides it (core `chatTabAfter`). A patch that names `chatTab` decides.
 */
function withChatTab(next: TaskState, patch: Partial<TaskState>, current: TaskState): TaskState {
	const chatTab = chatTabAfter(current.chatTab, groupsNow(current), groupsNow(next), {
		chat: 'chatTab' in patch ? patch.chatTab : patch.surface === 'chat' ? true : undefined,
		explicit:
			(patch.surface === 'diff' || patch.surface === 'editor') && !('editorGroups' in patch),
	});
	return chatTab === next.chatTab ? next : { ...next, chatTab };
}
/** spec/task-window-workspace#layout-switch: the three Layout switches of a task. */
export const layoutOf = (
	state: Pick<TaskState, 'chatShown' | 'workShown' | 'panelShown'>
): TaskLayout => ({
	chat: state.chatShown,
	work: state.workShown,
	panel: state.panelShown,
});
/** spec/editor#editor-groups: the groups with the focused group's leaf brought up to date from the flat tab fields. */
export const groupsNow = (
	state: Pick<TaskState, 'editorGroups' | 'documents' | 'activeDocument'>
) => withFocusedTabs(state.editorGroups, state);
/** The state fields for a new group tree: the focused group's tabs go to the flat fields and its active tab on screen. */
export function applyGroups(groups: EditorGroups): Partial<TaskState> {
	const tabs = focusedTabs(groups),
		active = tabs.documents.find((tab) => tab.id === tabs.activeDocument);
	return {
		editorGroups: groups,
		documents: tabs.documents,
		activeDocument: tabs.activeDocument,
		...(active && !isToolTab(active)
			? active.kind === 'diff'
				? { surface: 'diff' as const, selected: active.target }
				: { surface: 'editor' as const, activeEditor: active.target }
			: {}),
	};
}
/** A focused group whose last tab closed leaves the tree when another group stays; the neighbour takes the focus (spec/editor#editor-groups). */
function collapseEmpty(next: TaskState): TaskState {
	if (next.documents.length || next.editorGroups.root.kind === 'group') return next;
	// spec/task-window-workspace#empty-work-area: the empty group that holds the work area's place above the bottom group under the chat stays.
	if (next.bottomUnderChat && next.chatShown && holdsWorkArea(groupsNow(next))) return next;
	return { ...next, ...applyGroups(removeGroup(groupsNow(next), next.editorGroups.focused)) };
}
/** Buffer recency and the clean-buffer LRU follow each change of the active buffer or the buffer list. */
function settle(next: TaskState, current: TaskState): TaskState {
	if (next.activeEditor === current.activeEditor && next.editorTabs === current.editorTabs)
		return next;
	const active = next.editorTabs.find((tab) => tab.document.id === next.activeEditor);
	if (active) touchBuffer(active);
	let evictedEditors = next.evictedEditors;
	if (evictedEditors.size && next.editorTabs.some((tab) => evictedEditors.has(tab.document.id)))
		evictedEditors = new Map(
			[...evictedEditors].filter(([id]) => !next.editorTabs.some((tab) => tab.document.id === id))
		);
	// spec/editor#editor-groups: a passive group's shown file stays on screen, so its buffer stays loaded.
	const shown = new Set(
		shownTabs(next.editorGroups)
			.filter((tab) => tab.kind === 'file')
			.map((tab) => tab.target)
	);
	const evicted = evictBuffers(
		next.editorTabs,
		next.activeEditor,
		next.editorDraft?.fileId ?? null,
		evictedEditors,
		shown
	);
	return evicted
		? { ...next, ...evicted }
		: evictedEditors === next.evictedEditors
			? next
			: { ...next, evictedEditors };
}
/** The buffer list with `document` open: an existing buffer stays, an evicted one comes back at its place. */
export function withBuffer(
	state: { editorTabs: EditorModel[]; evictedEditors: Map<string, EvictedEditor> },
	document: EditorDocument
): EditorModel[] {
	return state.editorTabs.some((tab) => tab.document.id === document.id)
		? state.editorTabs
		: [...state.editorTabs, restoreBuffer(document, state.evictedEditors.get(document.id))];
}
/**
 * spec/architecture-and-platform#dev-reload: the unsaved buffers of this window that a hot exit does not keep (spec/task-window-workspace#restore-window: the main tree, past the draft limit,
 * read only); a reload would lose them.
 */
export function unkeptBuffers(): number {
	let count = 0;
	for (const [key, store] of parked) {
		const state = store.getState(),
			kept = new Set(
				key.endsWith(`/${MAIN_TREE_ID}`) ? [] : draftsOf(state).map((draft) => draft.id)
			);
		count += state.editorTabs.filter((tab) => tab.dirty && !kept.has(tab.document.id)).length;
	}
	return count;
}
/** spec/agents-and-providers#context-tools: the task's state as this window holds it, without touching its recency; `null` — never opened here. */
export function parkedTaskState(key: { projectId: string; id: string }) {
	return parked.get(`${key.projectId}/${key.id}`)?.getState() ?? null;
}
export function useTaskState(task: AgentTask) {
	const store = useMemo(() => {
		const key = `${task.projectId}/${task.id}`;
		const existing = parked.get(key) ?? makeState(task);
		parked.delete(key);
		parked.set(key, existing);
		while (parked.size > 5) {
			const entry = [...parked.entries()].find(
				([id, model]) =>
					id !== key &&
					!model.getState().attachments.length &&
					!model.getState().text.trim() &&
					!model.getState().generalDraft.trim() &&
					!model.getState().editorDraft?.text.trim() &&
					!model.getState().commentDraft?.text.trim() &&
					!model.getState().editorTabs.some((tab) => tab.dirty || tab.saving)
			);
			if (!entry) break;
			for (const tab of [
				...entry[1].getState().editorTabs.map((tab) => tab.document.id),
				...entry[1].getState().evictedEditors.keys(),
			])
				void window.brigadir
					.releaseEditorFile(
						{ projectId: entry[0].split('/')[0]!, id: entry[0].split('/')[1]! },
						tab
					)
					.catch(() => {});
			// spec/task-window-workspace#restore-window: its surface is written (with the pages' addresses and the terminals' folders) before they go.
			const leaving = { projectId: entry[0].split('/')[0]!, id: entry[0].split('/')[1]! };
			void untrackSurface(entry[0]).finally(() => {
				void window.brigadir.browserCommand(leaving, { kind: 'discard' }).catch(() => {});
				void window.brigadir.terminalCommand(leaving, { kind: 'close-consoles' }).catch(() => {});
			});
			parked.delete(entry[0]);
		}
		return existing;
	}, [task.id, task.projectId]);
	return [useTrackedState(store), store.setState] as const;
}
/**
 * The task store re-renders a component only for the fields it reads: a composer
 * keystroke does not re-render the diff, tree and conversation. Reads are recorded through a proxy; destructuring in
 * render is the common case. A field first read after the store moved on is re-checked after commit.
 */
function useTrackedState(store: ReturnType<typeof makeState>): TaskState {
	const tracked = useRef<{
		store: typeof store;
		keys: Set<PropertyKey>;
		shown: TaskState | null;
		added: boolean;
	} | null>(null);
	if (tracked.current?.store !== store)
		tracked.current = { store, keys: new Set(), shown: null, added: false };
	const current = tracked.current;
	const snapshot = useSyncExternalStore(store.subscribe, () => {
		const state = store.getState(),
			shown = current.shown;
		if (shown && shown !== state) {
			let same = true;
			for (const key of current.keys)
				if (!Object.is((state as any)[key], (shown as any)[key])) {
					same = false;
					break;
				}
			if (same) return shown;
		}
		current.shown = state;
		return state;
	});
	const [, refresh] = useReducer((value: number) => value + 1, 0);
	useLayoutEffect(() => {
		if (!current.added) return;
		current.added = false;
		const state = store.getState();
		if (state !== snapshot)
			for (const key of current.keys)
				if (!Object.is((state as any)[key], (snapshot as any)[key])) {
					refresh();
					return;
				}
	});
	return useMemo(
		() =>
			new Proxy(snapshot, {
				get(target, key) {
					if (!current.keys.has(key)) {
						current.keys.add(key);
						current.added = true;
					}
					return Reflect.get(target, key);
				},
			}),
		[snapshot, current]
	);
}

/** spec/editor#markdown-views: Code, Side by side or Preview; `shown` is the last view with the preview, the one ⇧⌘V returns to from Code. */
export type MarkdownView = { view: 'code' | 'side' | 'preview'; shown: 'side' | 'preview' };
export const newMarkdownView: MarkdownView = { view: 'preview', shown: 'preview' };
/** The next state of a tab's view; opening the file at a line shows the code (spec/editor#markdown-views). */
export function withMarkdownView(
	views: Map<string, MarkdownView>,
	id: string,
	view: MarkdownView['view']
): Map<string, MarkdownView> {
	const current = views.get(id) ?? newMarkdownView;
	return new Map(views).set(id, { view, shown: view === 'code' ? current.shown : view });
}
export async function openTaskEditor(
	task: AgentTask,
	document: EditorDocument,
	line?: number,
	column?: number,
	definition?: { text: string },
	/** spec/chat#code-pills: select `line`…`end` and take the keyboard. */ end?: number
) {
	if (document.state !== 'text') throw new Error('File is not text');
	const key = `${task.projectId}/${task.id}`;
	const store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState((state) => ({
		editorTabs: withBuffer(state, document),
		activeEditor: document.id,
		surface: 'editor',
		...(line && isMarkdownPath(document.path)
			? { markdownViews: withMarkdownView(state.markdownViews, document.id, 'code') }
			: {}),
		...(line
			? {
					editorTarget: {
						id: document.id,
						line,
						...(column ? { column } : {}),
						...(definition ? { definition } : {}),
						...(end ? { end, focus: true } : {}),
					},
				}
			: {}),
	}));
}
/** Moves through the task's location history; the caller supplies where the cursor is now. */
export function stepLocation(
	task: AgentTask,
	direction: 'back' | 'forward',
	current: CodePlace | null
): CodePlace | null {
	const key = `${task.projectId}/${task.id}`;
	const store = parked.get(key);
	if (!store) return null;
	const history = store.getState().locationHistory;
	const from = direction === 'back' ? history.back : history.forward;
	const target = from.at(-1);
	if (!target) return null;
	const to = direction === 'back' ? history.forward : history.back;
	store.setState({
		locationHistory:
			direction === 'back'
				? { back: from.slice(0, -1), forward: current ? [...to, current] : to }
				: { forward: from.slice(0, -1), back: current ? [...to, current].slice(-50) : to },
	});
	return target;
}
export function recordLocation(task: AgentTask, place: CodePlace) {
	const key = `${task.projectId}/${task.id}`;
	const store = parked.get(key);
	if (!store) return;
	const back = store.getState().locationHistory.back;
	const last = back.at(-1);
	if (
		last &&
		last.fileId === place.fileId &&
		last.line === place.line &&
		last.column === place.column
	)
		return;
	store.setState({ locationHistory: { back: [...back, place].slice(-50), forward: [] } });
}

export function rowPosition(positions: Map<string, RowsPosition>, id: string, follow = false) {
	let value = positions.get(id);
	if (!value) {
		value = { top: 0, left: 0, follow, sizes: new Map() };
		positions.set(id, value);
	}
	return value;
}

/** `after`: composer text that follows the pill (spec/composer-steering-queue-and-ghost#quick-question); both land in one state change, so the pill is never homeless. */
export async function attachTaskContext(task: AgentTask, input: AttachmentInput, after?: string) {
	return attachTaskAsset(
		task,
		await window.brigadir.createAttachment(task, input),
		true,
		true,
		after
	);
}
export async function pickTaskFiles(task: AgentTask) {
	addTaskFiles(task, await window.brigadir.pickAttachments(task), true);
}
/** spec/composer#paste: files dropped from Finder or copied there and pasted; the number attached, 0 when none was a file on disk. */
export async function dropTaskFiles(task: AgentTask, files: File[], focus: boolean) {
	const added = await window.brigadir.attachDroppedFiles(task, files);
	addTaskFiles(task, added, focus);
	return added.length;
}
function addTaskFiles(task: AgentTask, picked: PromptAttachment[], focus: boolean) {
	if (!picked.length) return;
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	const attachments = [...store.getState().attachments, ...picked];
	if (
		attachments.length > 10 ||
		attachments.reduce((sum, item) => sum + item.bytes, 0) > attachmentTotalLimit
	)
		throw new Error('Attachments are too large');
	store.setState((state) => ({
		attachments,
		composerInserts: [...state.composerInserts, ...picked.map((item) => item.id)],
		surface: 'chat',
		...(focus ? { focusComposer: true } : {}),
	}));
}
/** `place: false` — the caller puts the token in the text itself (a pick in the `@` menu stands in place of its word). */
export async function attachTaskFile(task: AgentTask, id: string, place = true) {
	return attachTaskAsset(task, await window.brigadir.attachFile(task, id), true, place);
}
/** spec/composer#paste: ⌘V with an image on the clipboard. The caret stays where the person pasted, so the composer is not refocused. */
export async function pasteTaskImage(task: AgentTask, name: string) {
	const attachment = await window.brigadir.pasteAttachment(task, name);
	return attachment && attachTaskAsset(task, attachment, false);
}
async function attachTaskAsset(
	task: AgentTask,
	attachment: PromptAttachment,
	focus = true,
	place = true,
	after?: string
) {
	const key = `${task.projectId}/${task.id}`;
	const store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	if (task.transport === 'terminal') {
		await window.brigadir.terminalCommand(task, { kind: 'list' });
		await window.brigadir.sendCommand(task, { kind: 'attachContext', id: attachment.id });
		const snapshot = await readSessionState(task);
		store.setState({ attachments: snapshot.pendingAttachments ?? [], surface: 'chat' });
	} else {
		const current = store.getState().attachments;
		if (
			current.length >= 10 ||
			current.reduce((sum, item) => sum + item.bytes, attachment.bytes) > attachmentTotalLimit
		)
			throw new Error('Attachments are too large');
		if (after !== undefined) {
			store.setState((state) => ({
				attachments: [...current, attachment],
				text: `${state.text.replace(/\s+$/, '')}${state.text.trim() ? '\n' : ''}${attachmentToken(attachment.id)}\n${after}`,
				surface: 'chat',
				...(focus ? { focusComposer: true } : {}),
			}));
			return attachment;
		}
		store.setState((state) => ({
			attachments: [...current, attachment],
			composerInserts: place ? [...state.composerInserts, attachment.id] : state.composerInserts,
			surface: 'chat',
			...(focus ? { focusComposer: true } : {}),
		}));
	}
	return attachment;
}

/**
 * spec/task-window-workspace#work-area: a tool tab of the task shown — opened where `place` says (the task's choice in Tools by default) or revealed
 * where it already is — and the work area with it, unless the bottom group stands under the chat.
 */
export function showTaskTool(
	task: AgentTask,
	tab: DocumentTab,
	place?: 'focused' | 'bottom',
	quiet = false,
	/** spec/task-window-workspace#empty-work-area: the agent's tab joins its group; a hidden work area stays hidden. */ agent = false
) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState((state) => {
		const groups = openToolTab(groupsNow(state), tab, place ?? state.toolPlace, quiet);
		// spec/task-window-workspace#two-columns: nor does it take the place of the pinned Chat tab in two columns.
		if (quiet || agent)
			return { ...applyGroups(groups), workShown: state.workShown, chatTab: state.chatTab };
		const underChat =
			!state.workShown &&
			state.bottomUnderChat &&
			groups.root.kind === 'split' &&
			groups.root.direction === 'down' &&
			groups.root.second.kind === 'group' &&
			groups.root.second.documents.some((item) => item.id === tab.id);
		return { ...applyGroups(groups), workShown: state.workShown || !underChat };
	});
}
/**
 * spec/editor#new-file: a file the person just made (or the one already there), opened where Tools opens (`Where to open`) with its
 * editor focused; the work area shows with it. The group under the chat is the chat's: the file goes to the work area.
 */
export function openTaskFileTab(task: AgentTask, document: EditorDocument) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState((state) => {
		let groups = groupsNow(state),
			place = state.toolPlace;
		const bottom = bottomGroup(groups);
		if (state.bottomUnderChat && state.chatShown && bottom && groups.root.kind === 'split') {
			place = 'focused';
			if (groups.focused === bottom.id)
				groups = { ...groups, focused: groupLeaves(groups.root.first)[0]!.id };
		}
		return {
			editorTabs: withBuffer(state, document),
			...applyGroups(openToolTab(groups, documentForFile(document.id, document.path), place)),
			editorTarget: { id: document.id, line: 1, focus: true },
		};
	});
}
export async function openTaskTerminal(task: AgentTask, id: string) {
	const item = await window.brigadir.openFileTerminal(task, id);
	showTaskTool(task, documentForTerminal(item.id, item.title), 'bottom');
}

/** spec/search-menus-and-commands#project-commands: a command tab shown in the bottom group, and remembered as the task's current command when it has one. */
export function showTaskCommand(task: AgentTask, id: string, commandId: string | null, title = '') {
	showTaskTool(task, documentForTerminal(id, title), 'bottom');
	if (commandId) setTaskCommand(task, commandId);
}
export function setTaskCommand(task: AgentTask, commandId: string) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({ commandCurrent: commandId });
}
/** spec/browser-and-simulator#simulator, spec/task-window-workspace#work-area: `simulator_open` shows the simulator's tab in the agent's task, shown or parked. */
export function setTaskSimulator(task: AgentTask, title = '') {
	showTaskTool(task, documentForSimulator(title));
}
/** spec/browser-and-simulator#opening-tabs, spec/task-window-workspace#work-area: the agent's browser tab, opened or brought to the front in its task. */
/**
 * spec/task-window-workspace#work-area: a browser tab of the task. The agent's call opens its new tab in front; a tab that is already there stays
 * where the person left it, since the agent works with it off screen too (spec/browser-and-simulator#background). `front` brings it forward.
 */
export function setTaskBrowser(
	task: AgentTask,
	tab: string,
	title = '',
	how: 'front' | 'agent' = 'front'
) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task),
		document = documentForBrowser(tab, title),
		there =
			how === 'agent' &&
			allGroupTabs(groupsNow(store.getState())).some((item) => item.id === document.id);
	showTaskTool(task, document, undefined, there, how === 'agent');
}

export function openTaskScope(task: AgentTask, scopeId: string, firstFile: string | null) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({ scopeTarget: null });
	store.setState({
		surface: 'diff',
		panel: 'changes',
		panelShown: true,
		filter: '',
		selected: firstFile,
		scopeTarget: `scope-${scopeId}`,
	});
}

export async function openTaskQuestion(task: AgentTask, turn: number) {
	const snapshot = await window.brigadir.readSession(task),
		start = snapshot.records.filter((record) => record.event.kind === 'turn.started')[turn - 1];
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({
		surface: 'chat',
		focusTurn: start?.seq ?? null,
		focusTurnNumber: turn,
		returnToDiff: false,
	});
}

/** spec/pull-requests-and-ci#repo-counter: the counter in a repo row opens the right panel on the PR tab filtered to that repo. */
export function openTaskPullRequests(task: AgentTask, scopeId: string | null) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({ panel: 'prs', panelShown: true, prFilter: scopeId, prOpen: null });
}
/** spec/pull-requests-and-ci#review-with-agent: a new review task opens straight on its PR. */
export function openTaskPR(
	task: AgentTask,
	ref: { scopeId: string; number: number },
	tab: TaskState['prTab'] = 'comments'
) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({
		panel: 'prs',
		panelShown: true,
		prFilter: ref.scopeId,
		prOpen: ref,
		prLast: ref,
		prTab: tab,
	});
}
/** spec/pull-requests-and-ci#ci-bell: the run page in the CI segment of the PR panel — from a toast or an OS notification about a watched run. */
export function openTaskRun(task: AgentTask, ref: { scopeId: string; runId: number }) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({
		panel: 'prs',
		panelShown: true,
		prFilter: ref.scopeId,
		prOpen: null,
		prSegment: 'ci',
		ciOpen: ref,
	});
}
/** spec/chat#folder-links: a folder named in the chat or the console opens in Files: the tree expands down to it and into it, selects it and scrolls to it. */
export function revealTaskFolder(task: AgentTask, id: string, parents: string[]) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState((state) => ({
		panel: 'files',
		panelShown: true,
		fileFilter: '',
		fileExpanded: new Set([...state.fileExpanded, 'root', ...parents, id]),
		fileSelection: id,
		fileReveal: id,
	}));
}
/** A native menu action can target a parked task rather than the selected one. */
/** A change of a task's state from outside its view (spec/git#commit-dialog: the commit run that outlives its dialog). */
export function updateTaskState(
	task: AgentTask,
	update: Partial<TaskState> | ((state: TaskState) => Partial<TaskState>)
) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState(update);
}
/** spec/git#commit-dialog: the commit dialog of the task; `scopeId` — the repo it was opened for (the repo «…» menu). */
export function openCommitDialog(task: AgentTask, scopeId: string | null = null) {
	updateTaskState(task, { commitDialog: { scopeId } });
}
export function showTaskDiff(task: AgentTask) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({ panel: 'changes', panelShown: true, surface: 'diff' });
}

/**
 * spec/appearance#evolution-redesign: the Conflicts dialog of a repo (the banner in Changes, the repo «…» menu, the PR's merge card), over the
 * task's Changes; `file` opens the merge in three columns of that file over it.
 */
/** A window event: the Conflicts dialog committed (Continue) or aborted a merge; History reads the branch again. */
export const mergeEnded = 'brigadir:merge-ended';
export function openConflictsDialog(
	task: AgentTask,
	scopeId: string,
	file: string | null = null,
	/** `Abort merge…` of the repo «…» menu: the dialog opens with its abort confirmation. */ abort = false
) {
	updateTaskState(task, { conflictsDialog: { scopeId, file, ...(abort ? { abort } : {}) } });
}
/** spec/editor#line-author: History narrowed to one file, in the repo that owns it, on that repo's current branch. */
export function openTaskFileHistory(task: AgentTask, scopeId: string, path: string) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState({
		panel: 'changes',
		panelShown: true,
		changesView: 'history',
		historyScope: scopeId,
		historyBranch: null,
		historyPath: path,
	});
}
/** spec/editor#line-author: a file's diff in one commit as a read-only commit tab, scrolled to `line` of that commit. */
export async function openTaskHistoryFile(
	task: AgentTask,
	scopeId: string,
	sha: string,
	path: string,
	line?: number
) {
	const files = await window.brigadir.readHistoryCommit(task, scopeId, sha);
	const file =
		files.files.find((item) => item.path === path) ??
		files.files.find((item) => item.oldPath === path);
	if (!file) throw new Error('File is unavailable');
	const diff = await window.brigadir.readHistoryFile(task, scopeId, sha, file.id),
		tab = `history:${sha.slice(0, 7)}:${scopeId}/${file.path}`;
	const entry = keepCommitDiff(task, tab, diff, { kind: 'history', scopeId, sha, id: file.id });
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	store.setState((state) => ({
		commitDiffs: { ...state.commitDiffs, [tab]: entry },
		selected: tab,
		surface: 'diff',
		diffLineTarget: line ?? null,
	}));
	return tab;
}

/** spec/task-window-workspace#work-area: a new browser tab's id, unique within the task. */
export const newBrowserTab = () =>
	`b${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join('')}`;
/**
 * spec/task-window-workspace#work-area: the tab ⇧⌘B / ⇧⌘Y / ⇧⌘M go to — the one of that kind shown last, else the last one open; `null` when the
 * task has none, and the caller opens a new one.
 */
export function lastToolTab(
	state: Pick<TaskState, 'editorGroups' | 'documents' | 'activeDocument' | 'lastTools'>,
	kind: ToolTabKind
): DocumentTab | null {
	const tabs = allGroupTabs(groupsNow(state)).filter((tab) => tab.kind === kind);
	return tabs.find((tab) => tab.id === state.lastTools[kind]) ?? tabs.at(-1) ?? null;
}
/** A page of the person's (a link, a command's port) opens in the task's last browser tab, or in a new one. */
export function openTaskBrowser(task: AgentTask, url: string) {
	const key = `${task.projectId}/${task.id}`,
		store = parked.get(key) ?? makeState(task);
	parked.set(key, store);
	const tab = lastToolTab(store.getState(), 'browser')?.target ?? newBrowserTab();
	setTaskBrowser(task, tab);
	return window.brigadir.browserCommand(task, { kind: 'open', url, tab });
}
