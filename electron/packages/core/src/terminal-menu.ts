import { isRecord } from './workspace';
import { commandAccelerator, defaultKeymap, type KeymapSettings } from './keymap';
import { menuCommands } from './menu';
import type { MessageKey } from './messages';
import type { MenuIcon } from './menu-icons';

/**
 * spec/terminal-and-cli-agents#console-links: what is under the right click in the console. `web`: an http(s) link, `pr`: a GitHub PR page while the PR module is on (spec/terminal-and-cli-agents#console-menu, it may open in the PR panel), `mail`: a mailto link, `file`: a path
 * of a file of the task (spec/chat#file-links), `folder`: of its folder (spec/chat#folder-links); `browser`: the Browser module is on (spec/settings-modules-and-onboarding#module-off), so the link may open in the task's browser.
 */
export type TerminalMenuState = {
	selection: boolean;
	link: 'web' | 'pr' | 'mail' | 'file' | 'folder' | null;
	browser: boolean;
	canPaste: boolean;
};
/** Every item goes back to the console: its selection lives in xterm, not in the page, so no system role can copy it. */
export type TerminalMenuAction =
	| 'open-pr'
	| 'open-task-browser'
	| 'open-system'
	| 'copy-link'
	| 'open-file'
	| 'copy'
	| 'paste'
	| 'select-all'
	| 'show-agent'
	| 'clear';
export type TerminalMenuItem = {
	id: TerminalMenuAction;
	label: MessageKey;
	enabled: boolean;
	accelerator?: string;
	/** spec/search-menus-and-commands#menu-glyphs: the glyph beside the item. */ icon: MenuIcon;
};
/** `open-file` of a folder shows the folder (spec/search-menus-and-commands#menu-glyphs). */
const terminalMenuIcons = {
	'open-pr': 'pr-branch',
	'open-task-browser': 'browser',
	'open-system': 'external',
	'copy-link': 'link',
	'open-file': 'editor',
	copy: 'copy-text',
	paste: 'paste',
	'select-all': 'select-all',
	'show-agent': 'send-context',
	clear: 'clear',
} as const satisfies Record<TerminalMenuAction, MenuIcon>;

const item = (
	id: TerminalMenuAction,
	label: MessageKey,
	enabled = true,
	accelerator?: string,
	icon: MenuIcon = terminalMenuIcons[id]
): TerminalMenuItem => ({ id, label, enabled, icon, ...(accelerator ? { accelerator } : {}) });

/** Groups: the link, then edit, then the agent and Clear (spec/terminal-and-cli-agents#console-links); `null` is a separator. Clear shows the keymap's
 *  key of Console ▸ Clear terminal, as the menu bar has it on this platform (spec/search-menus-and-commands#menu-structure). */
export function terminalMenuItems(
	state: TerminalMenuState,
	keymap: KeymapSettings = defaultKeymap
): (TerminalMenuItem | null)[] {
	const clear = menuCommands.find((command) => command.id === 'terminal-clear'),
		clearKey = clear && commandAccelerator(clear, keymap);
	const web = [
		...(state.browser ? [item('open-task-browser', 'Open in task browser')] : []),
		item('open-system', 'Open in system browser'),
		item('copy-link', 'Copy link'),
	];
	const link =
		state.link === 'web'
			? web
			: state.link === 'pr'
				? [item('open-pr', 'Open in the PR panel'), ...web]
				: state.link === 'mail'
					? [item('open-system', 'Open in system browser'), item('copy-link', 'Copy link')]
					: state.link === 'file'
						? [item('open-file', 'Open in editor')]
						: state.link === 'folder'
							? [item('open-file', 'Show in Files', true, undefined, 'folder')]
							: [];
	const groups = [
		link,
		[
			item('copy', 'Copy', state.selection, 'CmdOrCtrl+C'),
			item('paste', 'Paste', state.canPaste, 'CmdOrCtrl+V'),
			item('select-all', 'Select all', true, 'CmdOrCtrl+A'),
		],
		[item('show-agent', 'Show the agent'), item('clear', 'Clear terminal', true, clearKey)],
	].filter((group) => group.length);
	return groups.flatMap((group, index) => (index ? [null, ...group] : group));
}

export function isTerminalMenuState(value: unknown): value is TerminalMenuState {
	if (!isRecord(value) || Object.keys(value).length !== 4) return false;
	if (!(
		value.link === null ||
		value.link === 'web' ||
		value.link === 'pr' ||
		value.link === 'mail' ||
		value.link === 'file' ||
		value.link === 'folder'
	))
		return false;
	return (['selection', 'browser', 'canPaste'] as const).every(
		(key) => typeof value[key] === 'boolean'
	);
}
