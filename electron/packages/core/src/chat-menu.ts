import { isRecord } from './workspace';
import type { MessageKey } from './messages';
import type { MenuIcon } from './menu-icons';

/** spec/chat#context-menu: what is under the right click in the chat log; main turns it into the native menu. */
export type ChatMenuState = {
	/** Text is selected in the log. */
	selection: boolean;
	/** An http(s)/mailto link (spec/chat#web-links; `pr` — a GitHub PR page that opens in the PR panel, spec/pull-requests-and-ci#pr-links), a file path link (spec/chat#file-links), a folder path link (spec/chat#folder-links) or neither; `line`: the path names a line. */
	link: 'web' | 'pr' | 'file' | 'folder' | null;
	line: boolean;
	/** A code block (its header included), an image tile of the person's message (spec/chat#images), a message (spec/chat#context-menu). */
	code: boolean;
	image: boolean;
	message: boolean;
};
/** `copy` is the system copy role and finishes in main; the rest go back to the log. */
export type ChatMenuAction =
	| 'open-link'
	| 'open-browser'
	| 'copy-link'
	| 'open-file'
	| 'copy-path'
	| 'copy-line'
	| 'copy-code'
	| 'copy-image'
	| 'copy-message';
export type ChatMenuItem = {
	id: ChatMenuAction | 'copy';
	label: MessageKey;
	enabled: boolean;
	accelerator?: string;
	/** spec/search-menus-and-commands#menu-glyphs: the glyph beside the item. */ icon: MenuIcon;
};
/** The glyph follows the target, so one id over two targets has two: `open-link` of a PR, `open-file` of a folder (spec/search-menus-and-commands#menu-glyphs). */
const chatMenuIcons = {
	'open-link': 'external',
	'open-browser': 'external',
	'copy-link': 'link',
	'open-file': 'editor',
	'copy-path': 'copy',
	'copy-line': 'copy-line',
	'copy-code': 'code',
	'copy-image': 'image',
	'copy-message': 'bubble',
	copy: 'copy-text',
} as const satisfies Record<ChatMenuItem['id'], MenuIcon>;

const item = (
	id: ChatMenuItem['id'],
	label: MessageKey,
	enabled = true,
	accelerator?: string,
	icon: MenuIcon = chatMenuIcons[id]
): ChatMenuItem => ({ id, label, enabled, icon, ...(accelerator ? { accelerator } : {}) });

/** Groups by what is under the click (spec/chat#context-menu); an empty list means no menu. */
export function chatMenuItems(state: ChatMenuState): (ChatMenuItem | null)[] {
	const link =
		state.link === 'web'
			? [item('open-link', 'Open link'), item('copy-link', 'Copy link')]
			: state.link === 'pr'
				? [
						item('open-link', 'Open in the PR panel', true, undefined, 'pr-branch'),
						item('open-browser', 'Open in system browser'),
						item('copy-link', 'Copy link'),
					]
				: state.link === 'file'
					? [
							item('open-file', 'Open in editor'),
							item('copy-path', 'Copy relative path'),
							...(state.line ? [item('copy-line', 'Copy path:line')] : []),
						]
					: state.link === 'folder'
						? [
								item('open-file', 'Show in Files', true, undefined, 'folder'),
								item('copy-path', 'Copy relative path'),
							]
						: [];
	const target = [
		...(state.code ? [item('copy-code', 'Copy code')] : []),
		...(state.image ? [item('copy-image', 'Copy image')] : []),
		...(state.message ? [item('copy-message', 'Copy message')] : []),
	];
	const groups = [link, [item('copy', 'Copy', state.selection, 'CmdOrCtrl+C')], target].filter(
		(group) => group.length
	);
	if (!groups.flat().some((entry) => entry.enabled)) return [];
	return groups.flatMap((group, index) => (index ? [null, ...group] : group));
}

export function isChatMenuState(value: unknown): value is ChatMenuState {
	if (!isRecord(value) || Object.keys(value).length !== 6) return false;
	if (!(
		value.link === null ||
		value.link === 'web' ||
		value.link === 'pr' ||
		value.link === 'file' ||
		value.link === 'folder'
	))
		return false;
	return (['selection', 'line', 'code', 'image', 'message'] as const).every(
		(key) => typeof value[key] === 'boolean'
	);
}
