import { isRecord } from './workspace';
import type { MessageKey } from './messages';
import type { EditorAction, WorkspaceAction } from './files';
import type { MenuIcon } from './menu-icons';
export const menuContextKeys = [
	'relay',
	'project',
	'task',
	'needsYou',
	'modal',
	'editor',
	'document',
	'diff',
	'activity',
	'console',
	'terminal',
	'font',
	'review',
	'permission',
	'question',
	'comment',
	'browser',
	'simulator',
	'simulatorFocus',
	'running',
	'find',
	'composerMode',
	'save',
	'permissionAlways',
	'permissionDeny',
	'commentGo',
	'terminalTabs',
	'terminalOutput',
	'diffSelection',
	'sidebar',
	'turnRail',
	'markdown',
	'markdownPreview',
	'composerQueue',
	'pullRequests',
	'askAgent',
	'archivable',
	'composerFormat',
	'threeColumns',
	'editorGroups',
	'layoutChat',
	'layoutWork',
	'layoutPanel',
	'diffSource',
	'reopenTab',
	'commit',
	'prSection',
	'noteChat',
	'fileTree',
] as const;
export type MenuContext = Record<(typeof menuContextKeys)[number], boolean>;
export const emptyMenuContext = Object.fromEntries(
	menuContextKeys.map((key) => [key, false])
) as MenuContext;
export function isMenuContext(value: unknown): value is MenuContext {
	return (
		isRecord(value) &&
		Object.keys(value).length === menuContextKeys.length &&
		menuContextKeys.every((key) => typeof value[key] === 'boolean')
	);
}
type Command = {
	id: string;
	group: MessageKey;
	label: MessageKey;
	accelerator?: string | undefined;
	channel: 'workspace' | 'editor';
	action: WorkspaceAction | EditorAction;
	when: keyof MenuContext | 'always';
};
const workspace = (
	group: MessageKey,
	label: MessageKey,
	action: WorkspaceAction,
	accelerator: string | undefined,
	when: Command['when']
): Command => ({ id: action, group, label, action, accelerator, when, channel: 'workspace' });
const editor = (label: MessageKey, action: EditorAction, accelerator?: string): Command => ({
	id: `editor-${action}`,
	group: action === 'save' ? 'File' : action.startsWith('location-') ? 'Navigate' : 'Editor',
	label,
	action,
	accelerator,
	when: action === 'find' ? 'find' : action === 'save' ? 'save' : 'editor',
	channel: 'editor',
});
export const menuCommands: readonly Command[] = [
	workspace('File', 'Open a project…', 'open-project', 'CmdOrCtrl+O', 'always'),
	// spec/remote-access-and-mobile#client-ui-seam: third in File, after Open Recent (main places it); the remote access module's (spec/remote-access-and-mobile#module-and-settings).
	// spec/remote-access-and-mobile#remote-button: ⌥⌘O, the pair of ⌘O; it opens the «Remote» chip's popover when the chip is shown.
	workspace('File', 'Connect…', 'connect', 'CmdOrCtrl+Alt+O', 'always'),
	workspace('File', 'Close task', 'close-task', 'CmdOrCtrl+Shift+W', 'task'),
	// spec/search-menus-and-commands#menu-structure: the focused group's tab, as its × closes it; the window closes the system's way. Like the other
	// document commands, not while typing, in a terminal or in the browser.
	workspace('File', 'Close tab', 'close-tab', 'CmdOrCtrl+W', 'document'),
	// spec/editor#reopen-closed-tab: the last closed tab of the focused editor group, as in browsers, VS Code and JetBrains.
	workspace('File', 'Reopen closed tab', 'reopen-tab', 'CmdOrCtrl+Shift+T', 'reopenTab'),
	workspace('File', 'Continue in a new task', 'relay', undefined, 'relay'),
	workspace('File', 'New task', 'new-task', 'CmdOrCtrl+N', 'project'),
	// spec/editor#new-file: a file at a path in the task (⌘N is New task), the first item of Tools too.
	workspace('File', 'New file…', 'new-file', 'CmdOrCtrl+Alt+N', 'task'),
	// spec/task-window#files-delete: the selected file or folder of the Files tree goes to the Trash; ⌘⌫ as in Finder, Delete on a PC.
	workspace('File', 'Delete…', 'file-delete', 'CmdOrCtrl+Backspace', 'fileTree'),
	workspace('File', 'Open Quickly…', 'quick-open', 'CmdOrCtrl+Shift+O', 'task'),
	workspace('File', 'Open Quickly (alias)', 'quick-open-alias', 'CmdOrCtrl+P', 'task'),
	workspace('File', 'Search Everywhere…', 'search', 'CmdOrCtrl+Shift+K', 'always'),
	// spec/search-menus-and-commands#search-tabs: Search Everywhere opened on Text (Find in Files, as in WebStorm and VS Code) and on Actions (Find Action).
	workspace('File', 'Find in Files…', 'find-in-files', 'CmdOrCtrl+Shift+F', 'always'),
	workspace('File', 'Find Action…', 'find-action', 'CmdOrCtrl+Shift+A', 'always'),
	// spec/tasks#archive: ⌃⌘A archives the open task, like Mail; inactive while its agent works. The Archive window is ⌥⌘A (⇧⌘A is Find Action, spec/search-menus-and-commands#search-tabs).
	workspace('File', 'Archive task', 'archive-task', 'Ctrl+CmdOrCtrl+A', 'archivable'),
	// spec/search-menus-and-commands#project-commands: project commands, right under Search Everywhere; ⌘. stays the turn's Stop.
	workspace('File', 'Project commands…', 'commands', 'CmdOrCtrl+Alt+R', 'always'),
	workspace('File', 'Run current command', 'command-run', 'Ctrl+Command+R', 'task'),
	workspace('File', 'Stop current command', 'command-stop', 'Ctrl+Command+.', 'task'),
	workspace('File', 'New command…', 'command-new', undefined, 'project'),
	// spec/notifications-slack-notes-and-schedules#notes: a note without a project; the Notes screen opens on it.
	workspace('File', 'New note', 'note-new', undefined, 'always'),
	workspace('File', 'New schedule…', 'schedule-new', undefined, 'project'),
	editor('Save', 'save', 'CmdOrCtrl+S'),
	editor('Find', 'find', 'CmdOrCtrl+F'),
	editor('Find and replace', 'replace', 'CmdOrCtrl+Alt+F'),
	// spec/search-menus-and-commands#menu-structure: the find panel's steps and Replace all (F3 / Shift+F3 on a PC, keymap.ts); the editor acts on them
	// only while its find panel is open.
	editor('Find next', 'find-next', 'CmdOrCtrl+G'),
	editor('Find previous', 'find-previous', 'CmdOrCtrl+Shift+G'),
	editor('Replace all', 'replace-all', 'CmdOrCtrl+Alt+Enter'),
	editor('Indent', 'indent', 'CmdOrCtrl+]'),
	editor('Outdent', 'outdent', 'CmdOrCtrl+['),
	editor('Toggle comment', 'comment', 'CmdOrCtrl+/'),
	editor('Format document', 'format', 'Shift+Alt+F'),
	editor('Go to definition', 'definition', 'CmdOrCtrl+B'),
	editor('Find references', 'references', 'Alt+F7'),
	editor('Show completions', 'completions', 'Ctrl+Space'),
	editor('Show parameters', 'parameters', 'CmdOrCtrl+Shift+Space'),
	editor('Next problem', 'problem-next', 'F2'),
	editor('Previous problem', 'problem-previous', 'Shift+F2'),
	// spec/editor#change-marks: gutter hunks, the JetBrains keys the rest of this menu follows.
	editor('Next change', 'change-next', 'Ctrl+Alt+Shift+Down'),
	editor('Previous change', 'change-previous', 'Ctrl+Alt+Shift+Up'),
	editor('Revert change', 'change-revert', 'CmdOrCtrl+Alt+Z'),
	editor('Previous location', 'location-previous', 'Ctrl+-'),
	editor('Next location', 'location-next', 'Ctrl+Shift+-'),
	// spec/editor#line-author: no default shortcut (⌥⌘H is macOS Hide Others); the keymap may give it one.
	editor('File history', 'history'),
	// spec/editor-code-intelligence#language-server-restart: the servers of the open task's files; acts with the focus anywhere in the task, no default shortcut.
	workspace('Editor', 'Restart language servers', 'language-servers-restart', undefined, 'task'),
	// spec/composer-steering-queue-and-ghost#quick-question: the quick question from a selection in the editor or the diff.
	workspace('Editor', 'Ask the agent', 'ask-agent', 'CmdOrCtrl+I', 'askAgent'),
	// spec/notifications-slack-notes-and-schedules#notification-center: the notification center over the sidebar; again closes it.
	workspace('Navigate', 'Notifications', 'notifications', 'CmdOrCtrl+Shift+N', 'always'),
	workspace('Navigate', 'Next agent needing you', 'needs-next', 'CmdOrCtrl+J', 'needsYou'),
	workspace(
		'Navigate',
		'Previous agent needing you',
		'needs-previous',
		'CmdOrCtrl+Shift+J',
		'needsYou'
	),
	workspace('Navigate', 'Next document', 'document-next', 'CmdOrCtrl+Alt+Right', 'document'),
	workspace('Navigate', 'Previous document', 'document-previous', 'CmdOrCtrl+Alt+Left', 'document'),
	workspace('Navigate', 'Next tool or hunk', 'next-block', 'Alt+Down', 'find'),
	workspace('Navigate', 'Previous tool or hunk', 'previous-block', 'Alt+Up', 'find'),
	// spec/chat-turns-plans-and-questions#turn-rail: between turns, from the conversation or its composer while the turn rail is shown.
	workspace('Navigate', 'Next turn', 'turn-next', 'CmdOrCtrl+Alt+Down', 'turnRail'),
	workspace('Navigate', 'Previous turn', 'turn-previous', 'CmdOrCtrl+Alt+Up', 'turnRail'),
	workspace('Navigate', 'Expand conversation', 'activity-expand', 'CmdOrCtrl+Alt+]', 'activity'),
	workspace(
		'Navigate',
		'Collapse conversation',
		'activity-collapse',
		'CmdOrCtrl+Alt+[',
		'activity'
	),
	workspace('Diff', 'Toggle diff layout', 'diff-toggle', 'CmdOrCtrl+Alt+U', 'diff'),
	workspace('Diff', 'Expand all context', 'diff-expand', 'CmdOrCtrl+Alt+]', 'diff'),
	workspace('Diff', 'Collapse all context', 'diff-collapse', 'CmdOrCtrl+Alt+[', 'diff'),
	workspace('Diff', 'Comment on selection', 'diff-comment', 'CmdOrCtrl+Alt+C', 'diff'),
	workspace('Diff', 'Next hunk', 'diff-next', undefined, 'diff'),
	workspace('Diff', 'Previous hunk', 'diff-previous', undefined, 'diff'),
	// spec/editor#reopen-closed-tab: JetBrains' Jump to Source — the file of the diff in the editor at the line of the selection or caret.
	workspace('Diff', 'Jump to source', 'diff-jump-to-source', 'F4', 'diffSource'),
	// spec/appearance#evolution-redesign, spec/git#commit-dialog: the commit dialog of the open task; the strip's «Commit…» opens it too (no ⌘↩).
	workspace('Diff', 'Commit…', 'commit', 'CmdOrCtrl+Alt+K', 'commit'),
	...(
		[
			['Focus address', 'browser-address', 'CmdOrCtrl+Shift+L'],
			['Select node', 'browser-pick', 'CmdOrCtrl+Shift+C'],
			['Screenshot to chat', 'browser-screenshot', 'CmdOrCtrl+Alt+B'],
			['DevTools', 'browser-inspect', 'CmdOrCtrl+Alt+I'],
			['Reload', 'browser-reload', 'CmdOrCtrl+R'],
			['Back', 'browser-back', 'CmdOrCtrl+['],
			['Forward', 'browser-forward', 'CmdOrCtrl+]'],
		] as const
	).map(([label, action, key]) => workspace('Browser', label, action, key, 'browser')),
	// spec/browser-and-simulator#simulator: the simulator menu; Home acts only while the column has focus, like the browser's reload.
	...(
		[
			['Home', 'simulator-home', 'CmdOrCtrl+Shift+H'],
			['Rotate', 'simulator-rotate', 'CmdOrCtrl+Right'],
			['Reload app', 'simulator-reload', 'CmdOrCtrl+R'],
			['Screenshot to chat', 'simulator-screenshot', 'CmdOrCtrl+Alt+M'],
			['React Native DevTools', 'simulator-devtools', undefined],
			['Shut down simulator', 'simulator-shutdown', undefined],
		] as const
	).map(([label, action, key]) => workspace('Simulator', label, action, key, 'simulator')),
	...(
		[
			['Clear terminal', 'terminal-clear', 'CmdOrCtrl+K'],
			['Next terminal', 'terminal-next', 'Ctrl+Tab'],
			['Previous terminal', 'terminal-previous', 'Ctrl+Shift+Tab'],
			['Show the agent', 'terminal-compose', 'CmdOrCtrl+Alt+Y'],
		] as const
	).map(([label, action, key]) => workspace('Console', label, action, key, 'console')),
	// spec/task-window-workspace#work-area: a new terminal tab wherever the task is open (VS Code's ⌃⇧`), not only from the console's focus.
	workspace('Console', 'New terminal', 'terminal-new', 'Ctrl+Shift+`', 'task'),
	workspace('View', 'Toggle sidebar', 'sidebar-toggle', 'Ctrl+Command+S', 'sidebar'),
	// spec/sidebar#section-rail: the rail's sections, ⌃⌘1… in rail order; the open section's key hides and shows the sidebar.
	workspace('View', 'Tasks (section)', 'section-tasks', 'Ctrl+Command+1', 'sidebar'),
	workspace('View', 'Pull requests (section)', 'section-prs', 'Ctrl+Command+2', 'prSection'),
	// spec/sidebar#section-rail: the sections are ⌃⌘1…4, Notes the third (spec/notifications-slack-notes-and-schedules#notes).
	workspace('View', 'Notes', 'notes', 'Ctrl+Command+3', 'always'),
	// spec/notifications-slack-notes-and-schedules#schedules: Schedules is the fourth section; File ▸ New schedule… opens the sheet with When = Repeat.
	workspace('View', 'Schedules', 'schedules', 'Ctrl+Command+4', 'always'),
	// spec/task-window-workspace#layout-switch: View ▸ Layout — the three switches of the task toolbar's Layout, ⌘1–⌘3 (the routes are ⇧⌘1 / ⇧⌘2),
	// then Show all and Reset column widths.
	workspace('Layout', 'Chat', 'layout-chat', 'CmdOrCtrl+1', 'task'),
	workspace('Layout', 'Work area', 'layout-work', 'CmdOrCtrl+2', 'task'),
	workspace('Layout', 'Panel', 'layout-panel', 'CmdOrCtrl+3', 'task'),
	workspace('Layout', 'Show all', 'layout-all', undefined, 'task'),
	workspace('Layout', 'Reset column widths', 'layout-reset', undefined, 'task'),
	// spec/task-window-workspace#work-area: the toolbar's Tools menu.
	workspace('View', 'Tools…', 'tools', 'CmdOrCtrl+Shift+I', 'task'),
	// spec/editor#editor-groups: editor groups, JetBrains' split items on the focused group's active tab, a View submenu right under Layout.
	// Split has no key there; ⌥⇥ / ⌥⇧⇥ walk the groups.
	workspace('Editor groups', 'Split right', 'editor-split-right', undefined, 'document'),
	workspace('Editor groups', 'Split down', 'editor-split-down', undefined, 'document'),
	workspace(
		'Editor groups',
		'Split and move right',
		'editor-split-move-right',
		undefined,
		'document'
	),
	workspace(
		'Editor groups',
		'Split and move down',
		'editor-split-move-down',
		undefined,
		'document'
	),
	workspace(
		'Editor groups',
		'Move to the other group',
		'editor-group-move',
		undefined,
		'editorGroups'
	),
	workspace('Editor groups', 'Next group', 'editor-group-next', 'Alt+Tab', 'editorGroups'),
	workspace(
		'Editor groups',
		'Previous group',
		'editor-group-previous',
		'Alt+Shift+Tab',
		'editorGroups'
	),
	workspace('Editor groups', 'Unsplit', 'editor-unsplit', undefined, 'editorGroups'),
	workspace('Editor groups', 'Unsplit all', 'editor-unsplit-all', undefined, 'editorGroups'),
	workspace('View', 'Filter tasks', 'sidebar-filter', 'CmdOrCtrl+Alt+Shift+F', 'sidebar'),
	...(
		[
			['Increase font size', 'font-increase', 'CmdOrCtrl+Plus'],
			['Decrease font size', 'font-decrease', 'CmdOrCtrl+-'],
			['Reset font size', 'font-reset', 'CmdOrCtrl+0'],
		] as const
	).map(([label, action, key]) => workspace('View', label, action, key, 'font')),
	workspace('View', 'Archive…', 'archive', 'Alt+CmdOrCtrl+A', 'always'),
	workspace('View', 'Stop', 'cancel', 'CmdOrCtrl+.', 'running'),
	// spec/composer-steering-queue-and-ghost#steering-hold: ⌘↩ in the task composer while the agent works queues the message; ↩ sends it into the running turn.
	// Only with the composer focused, so it never shares ⌘↩ with Submit (review, permission, question, comment).
	workspace('View', 'Add to queue', 'composer-queue', 'CmdOrCtrl+Enter', 'composerQueue'),
	...(
		[
			['Turns', 'turns', 'CmdOrCtrl+Shift+U'],
			['Pull requests', 'pull-requests', 'CmdOrCtrl+Shift+P'],
			// spec/task-window-workspace#work-area: each goes to the last tab of its kind, or opens one.
			['Browser', 'browser', 'CmdOrCtrl+Shift+B'],
			['Simulator', 'simulator', 'CmdOrCtrl+Shift+M'],
			['Terminal', 'terminal', 'CmdOrCtrl+Shift+Y'],
			['Show changes', 'diff', 'CmdOrCtrl+Shift+D'],
			['Show files', 'files', 'CmdOrCtrl+Shift+E'],
			['Focus composer', 'composer', 'CmdOrCtrl+L'],
		] as const
	).map(([label, action, key]) => workspace('View', label, action, key, 'task')),
	// spec/pull-requests-and-ci#reading-and-refresh: ⌘R reads the PR list and the open PR again, only with the focus in the PR panel; the browser's and the
	// simulator's ⌘R act only with their own focus, IntelliJ's ⌘R Replace only in the editor.
	workspace(
		'View',
		'Refresh pull requests',
		'pull-requests-refresh',
		'CmdOrCtrl+R',
		'pullRequests'
	),
	// spec/editor#markdown-views: one toggle for the active Markdown document, editor or diff; a checkbox that shows whether the preview is on.
	workspace('View', 'Markdown preview', 'markdown-preview', 'CmdOrCtrl+Shift+V', 'markdown'),
	workspace('View', 'Next agent mode', 'composer-mode', 'Shift+Tab', 'composerMode'),
	// spec/composer#formatting: Edit ▸ Formatting. They act while the focus is in the composer's text, where ⌘B is not Go to definition, ⌘I not Ask the agent and ⌘K not Clear terminal.
	workspace('Formatting', 'Bold', 'format-bold', 'CmdOrCtrl+B', 'composerFormat'),
	workspace('Formatting', 'Italic', 'format-italic', 'CmdOrCtrl+I', 'composerFormat'),
	workspace('Formatting', 'Code', 'format-code', 'CmdOrCtrl+E', 'composerFormat'),
	workspace('Formatting', 'Link', 'format-link', 'CmdOrCtrl+K', 'composerFormat'),
	workspace('View', 'Submit', 'review-send', 'CmdOrCtrl+Enter', 'review'),
	workspace(
		'View',
		'Submit and go or allow always',
		'review-send-go',
		'CmdOrCtrl+Shift+Enter',
		'permission'
	),
	workspace('View', 'Deny permission', 'permission-deny', 'CmdOrCtrl+Backspace', 'permission'),
];
/** spec/search-menus-and-commands#menu-glyphs: the glyph of every menu-bar command; next/previous pairs show their object with the arrow. A test keeps it whole. */
export const menuCommandIcons: Readonly<Record<string, MenuIcon>> = {
	'open-project': 'folder',
	connect: 'remote',
	'close-task': 'close',
	'close-tab': 'close',
	'reopen-tab': 'undo',
	relay: 'relay',
	'new-task': 'task-new',
	'new-file': 'file-new',
	'file-delete': 'trash',
	'quick-open': 'search-file',
	'quick-open-alias': 'search-file',
	search: 'search',
	'find-in-files': 'find-in-files',
	'find-action': 'search-action',
	'archive-task': 'archive-box',
	commands: 'command-idle',
	'command-run': 'command-play',
	'command-stop': 'command-stop',
	'command-new': 'plus',
	'editor-save': 'save',
	'editor-find': 'search',
	'editor-replace': 'replace',
	'editor-find-next': 'search-more',
	'editor-find-previous': 'search-previous',
	'editor-replace-all': 'text-replace',
	'editor-indent': 'indent',
	'editor-outdent': 'outdent',
	'editor-comment': 'comment-toggle',
	'editor-format': 'format',
	'editor-definition': 'symbol',
	'editor-references': 'references',
	'editor-completions': 'completions',
	'editor-parameters': 'parameters',
	'editor-problem-next': 'problem-next',
	'editor-problem-previous': 'problem-previous',
	'editor-change-next': 'change-next',
	'editor-change-previous': 'change-previous',
	'editor-change-revert': 'revert',
	'editor-location-previous': 'back',
	'editor-location-next': 'forward',
	'editor-history': 'history',
	'language-servers-restart': 'refresh',
	'ask-agent': 'generate',
	notifications: 'bell',
	'needs-next': 'needs-next',
	'needs-previous': 'needs-previous',
	'document-next': 'tab-next',
	'document-previous': 'tab-previous',
	'next-block': 'block-next',
	'previous-block': 'block-previous',
	'turn-next': 'turn-next',
	'turn-previous': 'turn-previous',
	'activity-expand': 'expand-all',
	'activity-collapse': 'collapse-all',
	'diff-toggle': 'split',
	'diff-expand': 'expand-all',
	'diff-collapse': 'collapse-all',
	'diff-comment': 'comment',
	'diff-next': 'change-next',
	'diff-previous': 'change-previous',
	'diff-jump-to-source': 'editor',
	commit: 'commit-dot',
	'browser-address': 'browser',
	'browser-pick': 'pick',
	'browser-screenshot': 'camera',
	'browser-inspect': 'inspect',
	'browser-reload': 'refresh',
	'browser-back': 'back',
	'browser-forward': 'forward',
	'simulator-home': 'sim-home',
	'simulator-rotate': 'sim-rotate',
	'simulator-reload': 'refresh',
	'simulator-screenshot': 'camera',
	'simulator-devtools': 'sim-devtools',
	'simulator-shutdown': 'quit',
	'terminal-new': 'plus',
	'terminal-clear': 'clear',
	'terminal-next': 'tab-next',
	'terminal-previous': 'tab-previous',
	'terminal-compose': 'send-context',
	'sidebar-toggle': 'sidebar-toggle',
	'section-tasks': 'board',
	'section-prs': 'pr-branch',
	notes: 'note',
	'note-new': 'note',
	schedules: 'schedule',
	'schedule-new': 'schedule',
	'layout-chat': 'layout-chat',
	'layout-work': 'layout-work',
	'layout-panel': 'layout-panel',
	'layout-all': 'layout-all',
	'layout-reset': 'layout-reset',
	tools: 'tools',
	'editor-split-right': 'split-right',
	'editor-split-down': 'split-down',
	'editor-split-move-right': 'split-move-right',
	'editor-split-move-down': 'split-move-down',
	'editor-group-move': 'group-move',
	'editor-group-next': 'group-next',
	'editor-group-previous': 'group-previous',
	'editor-unsplit': 'unsplit',
	'editor-unsplit-all': 'unsplit-all',
	'sidebar-filter': 'filter',
	'font-increase': 'font-larger',
	'font-decrease': 'font-smaller',
	'font-reset': 'font-reset',
	archive: 'archive-box',
	cancel: 'stop',
	'composer-queue': 'clock',
	turns: 'list',
	'pull-requests': 'pr-branch',
	browser: 'browser',
	simulator: 'simulator',
	terminal: 'console',
	diff: 'diff',
	files: 'folder',
	composer: 'chat',
	'pull-requests-refresh': 'refresh',
	'markdown-preview': 'md-preview',
	'composer-mode': 'mode-next',
	'format-bold': 'bold',
	'format-italic': 'italic',
	'format-code': 'code',
	'format-link': 'link',
	'review-send': 'send',
	'review-send-go': 'send-chat-go',
	'permission-deny': 'xmark',
};
export function menuCommandEnabled(command: Command, context: MenuContext, browserFocused = false) {
	if (context.modal) return false;
	if (
		browserFocused &&
		[
			'editor',
			'document',
			'markdown',
			'diff',
			'diffSource',
			'reopenTab',
			'activity',
			'console',
			'terminal',
			'font',
			'review',
			'permission',
			'question',
			'comment',
			'find',
			'save',
			'composerMode',
			'composerQueue',
			'composerFormat',
			'pullRequests',
		].includes(command.when)
	)
		return false;
	if (['browser-back', 'browser-forward', 'browser-reload'].includes(command.id))
		return context.browser && browserFocused;
	// spec/browser-and-simulator#simulator: ⇧⌘H, ⌘→ and ⌘R reach the device only from a focused screen; elsewhere ⌘→ stays the end of a line.
	if (['simulator-home', 'simulator-rotate', 'simulator-reload'].includes(command.id))
		return context.simulatorFocus && !browserFocused;
	if (command.id === 'review-send-go') return context.permissionAlways || context.commentGo;
	if (command.id === 'permission-deny') return context.permissionDeny;
	if (command.id === 'diff-comment') return context.diff && context.diffSelection;
	if (command.id === 'diff-jump-to-source') return context.diff && context.diffSource;
	if (command.id === 'terminal-next' || command.id === 'terminal-previous')
		return context.console && context.terminalTabs;
	if (command.id === 'terminal-compose') return context.console && context.terminalOutput;
	if (command.id === 'review-send')
		return context.review || context.permission || context.question || context.comment;
	// The two ⌘↩ items: the renderer publishes composerQueue only for the focused composer, where the others are false.
	if (command.id === 'composer-queue')
		return (
			context.composerQueue &&
			!(context.review || context.permission || context.question || context.comment)
		);
	// spec/notifications-slack-notes-and-schedules#notes: ⌘1 is the note's chat too, on the Notes screen.
	if (command.id === 'layout-chat') return context.task || context.noteChat;
	if (command.id === 'next-block' || command.id === 'previous-block')
		return !browserFocused && (context.activity || context.diff);
	return command.when === 'always' || context[command.when];
}

/**
 * spec/search-menus-and-commands#menu-structure: the long Editor and View menus are split into groups by meaning — a separator before the first item of
 * each group; the order of the items does not change. Editor: search · text editing · language server · changes and Git ·
 * services (then Show line author). View: window layout · font · Archive… · the turn · the task's sections · focus actions ·
 * the answer card (then Workspace and Kit, then the developer tools).
 */
export const menuGroupStarts: ReadonlySet<string> = new Set([
	'editor-indent',
	'editor-definition',
	'editor-change-next',
	'language-servers-restart',
	'font-increase',
	'archive',
	'cancel',
	'turns',
	'pull-requests-refresh',
	'review-send',
]);
/** Puts a separator before each group start that has items above it; hidden modules never leave two in a row. */
export function withGroupSeparators<T extends { id?: string; type?: string }>(
	items: readonly T[]
): T[] {
	const out: T[] = [];
	for (const item of items) {
		if (
			item.id &&
			menuGroupStarts.has(item.id) &&
			out.length &&
			out[out.length - 1]!.type !== 'separator'
		)
			out.push({ type: 'separator' } as T);
		out.push(item);
	}
	return out;
}
