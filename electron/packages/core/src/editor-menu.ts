import { isRecord } from './workspace';
import { menuCommands } from './menu';
import { commandAccelerator, defaultKeymap, type KeymapSettings } from './keymap';
import type { MessageKey } from './messages';
import type { MenuIcon } from './menu-icons';

/** spec/editor#editor-context-menu: what the renderer knows at the click; main turns it into the native menu. */
export type EditorMenuState = {
	selection: boolean;
	word: boolean;
	change: boolean;
	revert: boolean;
	editable: boolean;
	format: boolean;
	comment: boolean;
	lines: { start: number; end: number };
	at: { x: number; y: number } | null;
	/** spec/editor#line-author: the file is in a Git root; the caret line has a commit. */
	git: EditorMenuGit;
	/** spec/search-menus-and-commands#package-scripts: null outside a `package.json`; there, whether the caret line is a pair of its top-level `scripts`. */
	script: boolean | null;
};
export type EditorMenuGit = { history: boolean; commit: boolean };
export type EditorMenuAction =
	| 'script-run'
	| 'script-command'
	| 'ask'
	| 'comment'
	| 'compose'
	| 'definition'
	| 'references'
	| 'diff'
	| 'revert'
	| 'toggle-comment'
	| 'format'
	| 'terminal'
	| GitMenuAction;
export type GitMenuAction = 'history' | 'line-commit';
/** Handled in main; the renderer never gets them back. */
type MainAction = 'cut' | 'copy' | 'paste' | 'copy-line' | 'copy-path' | 'finder';
export type EditorMenuItem = {
	id: EditorMenuAction | MainAction;
	label: MessageKey;
	enabled: boolean;
	accelerator?: string;
	/** spec/search-menus-and-commands#menu-glyphs: the glyph beside the item. */ icon: MenuIcon;
};
export const editorMenuIcons = {
	'script-run': 'command-play',
	'script-command': 'plus',
	ask: 'generate',
	comment: 'comment',
	compose: 'send-context',
	definition: 'symbol',
	references: 'references',
	diff: 'diff',
	revert: 'revert',
	history: 'history',
	'line-commit': 'commit-dot',
	cut: 'cut',
	copy: 'copy-text',
	paste: 'paste',
	'toggle-comment': 'comment-toggle',
	format: 'format',
	'copy-line': 'copy-line',
	'copy-path': 'copy',
	terminal: 'console',
	finder: 'folder',
} as const satisfies Record<EditorMenuItem['id'], MenuIcon>;

const item = (
	id: EditorMenuItem['id'],
	label: MessageKey,
	enabled: boolean,
	shortcut?: string
): EditorMenuItem => ({
	id,
	label,
	enabled,
	icon: editorMenuIcons[id],
	...(shortcut ? { accelerator: shortcut } : {}),
});

/** Always the same items in the same order; what does not apply is disabled, not hidden (spec/editor#editor-context-menu). */
/** Each command's key is the keymap's, the one the menu bar has on this platform, never the command's raw default. */
export function editorMenuItems(
	state: EditorMenuState,
	keymap: KeymapSettings = defaultKeymap
): (EditorMenuItem | null)[] {
	const accelerator = (id: string) => {
		const command = menuCommands.find((item) => item.id === id);
		return command && commandAccelerator(command, keymap);
	};
	return [
		// spec/search-menus-and-commands#package-scripts: only a `package.json` has this group; in it, the items stay and are disabled off a script line.
		...(state.script === null
			? []
			: [
					item('script-run', 'Run script', state.script),
					item('script-command', 'Add to commands…', state.script),
					null,
				]),
		// spec/composer-steering-queue-and-ghost#quick-question: the quick question about these lines, above the comment.
		item('ask', 'Ask the agent', true, accelerator('ask-agent')),
		item('comment', 'Add a comment', state.comment),
		item('compose', 'To composer', true),
		null,
		item('definition', 'Go to definition', state.word, accelerator('editor-definition')),
		item('references', 'Find references', state.word, accelerator('editor-references')),
		null,
		item('diff', 'Open diff', state.change),
		item('revert', 'Revert change', state.revert, accelerator('editor-change-revert')),
		null,
		// spec/editor#line-author: the file's history and the caret line's commit, disabled outside Git.
		item('history', 'File history', state.git.history),
		item('line-commit', 'Commit of this line', state.git.commit),
		null,
		item('cut', 'Cut', state.selection && state.editable, 'CmdOrCtrl+X'),
		item('copy', 'Copy', state.selection, 'CmdOrCtrl+C'),
		item('paste', 'Paste', state.editable, 'CmdOrCtrl+V'),
		item('toggle-comment', 'Toggle comment', state.editable, accelerator('editor-comment')),
		item('format', 'Format document', state.format, accelerator('editor-format')),
		null,
		item('copy-line', 'Copy path:line', true),
		item('copy-path', 'Copy relative path', true),
		item('terminal', 'Open terminal here', true),
		item('finder', 'Reveal in Finder', true),
	];
}

/** `src/a.ts:12` or `src/a.ts:12-20`, the name a composer attachment of these lines carries. */
export function pathWithLines(path: string, lines: { start: number; end: number }) {
	return lines.end > lines.start ? `${path}:${lines.start}-${lines.end}` : `${path}:${lines.start}`;
}

const line = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1;
const coordinate = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function isEditorMenuState(value: unknown): value is EditorMenuState {
	if (!isRecord(value) || Object.keys(value).length !== 11) return false;
	if (value.script !== null && typeof value.script !== 'boolean') return false;
	if (
		!isRecord(value.git) ||
		Object.keys(value.git).length !== 2 ||
		typeof value.git.history !== 'boolean' ||
		typeof value.git.commit !== 'boolean'
	)
		return false;
	if (
		!(['selection', 'word', 'change', 'revert', 'editable', 'format', 'comment'] as const).every(
			(key) => typeof value[key] === 'boolean'
		)
	)
		return false;
	const lines = value.lines,
		at = value.at;
	if (
		!isRecord(lines) ||
		!line(lines.start) ||
		!line(lines.end) ||
		Number(lines.end) < Number(lines.start)
	)
		return false;
	return at === null || (isRecord(at) && coordinate(at.x) && coordinate(at.y));
}
