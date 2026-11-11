import { isRecord } from './workspace';

/**
 * spec/search-menus-and-commands#menu-glyphs: every glyph a native menu shows beside an item — the context menus and the menu bar. One set for all menus:
 * the renderer rasterizes each name once (the native menu takes no SVG), main makes them template images. A name here
 * must be a `ui/Glyph`; the renderer's type check keeps the two together.
 */
export const menuIconNames = [
	'archive-box',
	'archive-restore',
	'board',
	'archive-warn',
	'agent-backlog',
	'agent-run',
	'back',
	'bell',
	'block-next',
	'block-previous',
	'bold',
	'browser',
	'bubble',
	'camera',
	'change-next',
	'change-previous',
	'chat',
	'check-pass',
	'clear',
	'clock',
	'close',
	'code',
	'collapse-all',
	'command-idle',
	'command-play',
	'command-stop',
	'comment',
	'comment-toggle',
	'commit-dot',
	'completions',
	'console',
	'copy',
	'copy-absolute',
	'copy-line',
	'copy-text',
	'cut',
	'dash',
	'delete',
	'desktop',
	'diff',
	'duplicate',
	'edit',
	'editor',
	'effort',
	'expand-all',
	'external',
	'file-new',
	'filter',
	'find-in-files',
	'folder',
	'font-larger',
	'font-reset',
	'font-smaller',
	'format',
	'format-text',
	'forward',
	'front',
	'fullscreen',
	'generate',
	'group-move',
	'group-next',
	'group-previous',
	'helmet',
	'hide-others',
	'history',
	'image',
	'indent',
	'inspect',
	'italic',
	'knowledge',
	'link',
	'list',
	'md-preview',
	'minimize',
	'mode-next',
	'needs-next',
	'needs-previous',
	'outdent',
	'paperclip',
	'parameters',
	'paste',
	'paste-plain',
	'person',
	'pick',
	'note',
	'pause',
	'schedule',
	'pin',
	'plan-document',
	'plus',
	'pr-branch',
	'problem-next',
	'problem-previous',
	'quit',
	'quotes',
	'redo',
	'references',
	'refresh',
	'relay',
	'remote',
	'replace',
	'resume',
	'revert',
	'review-info',
	'review-warning',
	'save',
	'scope-hidden',
	'search',
	'search-action',
	'search-file',
	'search-more',
	'search-previous',
	'search-setting',
	'select-all',
	'send',
	'send-chat-go',
	'send-context',
	'settings-modules',
	'settings-templates',
	'sidebar-eye',
	'sidebar-toggle',
	'layout-chat',
	'layout-work',
	'layout-panel',
	'layout-all',
	'layout-reset',
	'layout-two',
	'layout-two-panel',
	'layout-three',
	'tools',
	'sim-devtools',
	'sim-home',
	'sim-rotate',
	'simulator',
	'speech',
	'split',
	'split-down',
	'split-move-down',
	'split-move-right',
	'split-right',
	'stop',
	'symbol',
	'tab-close-all',
	'tab-close-clean',
	'tab-close-others',
	'tab-close-right',
	'tab-next',
	'tab-previous',
	'task-new',
	'text-replace',
	'trash',
	'turn-next',
	'turn-previous',
	'undo',
	'unsplit',
	'unsplit-all',
	'why',
	'xmark',
	'zoom',
] as const;
export type MenuIcon = (typeof menuIconNames)[number];

/** A glyph rasterized by the renderer for a native menu: PNG data URLs at 1× (16 px) and 2× (32 px). */
export type MenuIconImages = Partial<Record<MenuIcon, { x1: string; x2: string }>>;
const iconNames = new Set<string>(menuIconNames);
const pngUrl = (value: unknown) =>
	typeof value === 'string' &&
	value.length < 24000 &&
	/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value);
export function isMenuIconImages(value: unknown): value is MenuIconImages {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([key, image]) =>
				iconNames.has(key) &&
				isRecord(image) &&
				Object.keys(image).length === 2 &&
				pngUrl(image.x1) &&
				pngUrl(image.x2)
		)
	);
}

// The menus main builds itself; the editor, chat, console, tab menus and the menu bar's commands keep their glyphs
// beside their items (editor-menu, chat-menu, terminal-menu, document-tabs, menu).

/** spec/tasks#archive: a sidebar task row; `move:*` goes to the board column, shown by the column's status glyph. */
export const taskMenuIcons = {
	open: 'chat',
	resume: 'resume',
	relay: 'relay',
	duplicate: 'duplicate',
	repeat: 'schedule',
	diff: 'diff',
	edit: 'edit',
	'move:backlog': 'agent-backlog',
	'move:progress': 'agent-run',
	'move:completed': 'check-pass',
	rename: 'edit',
	pin: 'pin',
	copy: 'copy-text',
	stop: 'stop',
	archive: 'archive-box',
	delete: 'trash',
	restore: 'archive-restore',
} as const satisfies Record<string, MenuIcon>;
/** spec/search-menus-and-commands#project-commands: a project command row. */
export const commandMenuIcons = {
	run: 'command-play',
	stop: 'command-stop',
	restart: 'refresh',
	show: 'console',
	open: 'browser',
	edit: 'edit',
	duplicate: 'duplicate',
	delete: 'trash',
} as const satisfies Record<string, MenuIcon>;
/** A project row of the sidebar. */
export const projectMenuIcons = {
	'new-task': 'task-new',
	'main-tree': 'editor',
	knowledge: 'knowledge',
	icon: 'image',
	'review-notes': 'review-info',
	finder: 'folder',
	copy: 'copy',
	remove: 'trash',
} as const satisfies Record<string, MenuIcon>;
/** The Files tree and the Changes list (`files:menu`). */
export const fileMenuIcons = {
	open: 'editor',
	'new-file': 'file-new',
	attach: 'send-context',
	terminal: 'console',
	copy: 'copy',
	why: 'why',
	revert: 'revert',
	'copy-absolute': 'copy-absolute',
	finder: 'folder',
	delete: 'trash',
} as const satisfies Record<string, MenuIcon>;
/**
 * spec/appearance#evolution-redesign: a row of the PR list. Review opens a window (`zoom`, as its buttons show it); the agent's ways are the
 * submenu's values, with no glyph of their own; conflicts take the glyph of the Repos menu's «Resolve conflicts…».
 */
export const prMenuIcons = {
	review: 'zoom',
	'agent-review': 'generate',
	'open-review': 'zoom',
	conflicts: 'review-warning',
	github: 'external',
	'copy-link': 'link',
	'copy-branch': 'pr-branch',
} as const satisfies Record<string, MenuIcon>;
/** A turn's menu in the log, and the sheet's attach menu. */
export const turnMenuIcons = { copy: 'copy-text', changes: 'diff' } as const satisfies Record<
	string,
	MenuIcon
>;
/** spec/notifications-slack-notes-and-schedules#notes: a note's «…» menu and the menu bar's Notes items. */
export const noteMenuIcons = {
	notes: 'note',
	'note-new': 'note',
	task: 'task-new',
	chat: 'chat',
	reveal: 'folder',
	copy: 'copy',
	delete: 'trash',
} as const satisfies Record<string, MenuIcon>;
/** spec/notifications-slack-notes-and-schedules#schedules: a schedule's row menu in the Schedules section, and the menu bar's Schedules items. */
export const scheduleMenuIcons = {
	schedules: 'schedule',
	'schedule-new': 'schedule',
	'run-now': 'resume',
	pause: 'pause',
	resume: 'schedule',
	edit: 'edit',
	duplicate: 'duplicate',
	'last-run': 'chat',
	delete: 'trash',
} as const satisfies Record<string, MenuIcon>;
export const attachMenuIcons = {
	files: 'paperclip',
	markdown: 'plan-document',
} as const satisfies Record<string, MenuIcon>;
/** The board card's model and effort pickers: only the header has a glyph; the choices are values with a check mark. */
export const pickerMenuIcons = { model: 'generate', effort: 'effort' } as const satisfies Record<
	string,
	MenuIcon
>;
/** The menu bar's own items (not commands): the app menu, Open Recent, the routes, the submenus' titles. */
export const appMenuIcons = {
	about: 'review-info',
	// spec/architecture-and-platform#auto-update: Brigadir ▸ Check for Updates… (Help on Windows and Linux).
	'check-updates': 'refresh',
	settings: 'search-setting',
	'settings-templates': 'settings-templates',
	intro: 'helmet',
	services: 'settings-modules',
	hide: 'scope-hidden',
	'hide-others': 'hide-others',
	'show-all': 'sidebar-eye',
	quit: 'quit',
	'open-recent': 'clock',
	'recent-project': 'folder',
	'recent-clear': 'clear',
	'recent-retry': 'refresh',
	'recent-error': 'archive-warn',
	'workspace-route': 'desktop',
	'kit-route': 'settings-templates',
	'line-author': 'person',
	'editor-groups': 'split',
	layout: 'layout-work',
	// spec/task-window-workspace#two-columns: View ▸ Layout ▸ Two columns / Three columns.
	'layout-two': 'layout-two',
	'layout-three': 'layout-three',
	// spec/search-menus-and-commands#menu-structure: Panel ⌘3 in two columns shows the panel's state, as the toolbar's Layout button does.
	'layout-two-panel': 'layout-two-panel',
	formatting: 'format-text',
	substitutions: 'text-replace',
	speech: 'speech',
} as const satisfies Record<string, MenuIcon>;
/** Electron roles, lower-cased as `MenuItem.role` reports them: the Edit and Window menus, the text field menu. */
export const roleMenuIcons = {
	undo: 'undo',
	redo: 'redo',
	cut: 'cut',
	copy: 'copy-text',
	paste: 'paste',
	pasteandmatchstyle: 'paste-plain',
	delete: 'delete',
	selectall: 'select-all',
	showsubstitutions: 'list',
	togglesmartquotes: 'quotes',
	togglesmartdashes: 'dash',
	toggletextreplacement: 'text-replace',
	startspeaking: 'command-idle',
	stopspeaking: 'stop',
	minimize: 'minimize',
	zoom: 'zoom',
	close: 'close',
	front: 'front',
	togglefullscreen: 'fullscreen',
	toggledevtools: 'inspect',
} as const satisfies Record<string, MenuIcon>;
