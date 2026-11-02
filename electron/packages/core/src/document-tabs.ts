/** Stable document identities; snapshot IDs are deliberately not tab identities. */
import { isRecord } from './workspace';
import type { MessageKey } from './messages';
import { isFileId } from './files';
import type { MenuIcon } from './menu-icons';
import { commandAccelerator, defaultKeymap, type KeymapSettings } from './keymap';
import { menuCommands } from './menu';
/** spec/task-window-workspace#work-area: the work area's tabs — files and diffs, and the tools: a terminal session, a browser tab, the simulator.
 *  A tool tab's `path` is its last known title; `target` is the session id, the browser tab id or `simulator`. */
export type ToolTabKind = 'terminal' | 'browser' | 'simulator';
export type DocumentTab = {
	id: string;
	kind: 'file' | 'diff' | ToolTabKind;
	path: string;
	target: string;
};
export const toolTabKinds: readonly ToolTabKind[] = ['terminal', 'browser', 'simulator'];
export const isToolTab = (
	tab: Pick<DocumentTab, 'kind'>
): tab is DocumentTab & { kind: ToolTabKind } =>
	(toolTabKinds as readonly string[]).includes(tab.kind);
export function documentForTerminal(id: string, title: string): DocumentTab {
	return { id: `terminal:${id}`, kind: 'terminal', path: title, target: id };
}
/** A browser tab's id is the renderer's or the agent's: `b` and a few letters or digits, unique within the task. */
export const isBrowserTabId = (value: unknown): value is string =>
	typeof value === 'string' && /^b[0-9a-z]{1,16}$/.test(value);
export function documentForBrowser(tab: string, title: string): DocumentTab {
	return { id: `browser:${tab}`, kind: 'browser', path: title, target: tab };
}
/** spec/task-window-workspace#work-area: the project has one simulator; its tab shows that device in any task. */
export function documentForSimulator(title: string): DocumentTab {
	return { id: 'simulator', kind: 'simulator', path: title, target: 'simulator' };
}
export type DocumentTabs = { documents: DocumentTab[]; activeDocument: string | null };
export function selectDocument(state: DocumentTabs, tab: DocumentTab): DocumentTabs {
	const existing = state.documents.some((item) => item.id === tab.id);
	if (existing)
		return {
			documents: state.documents.map((item) => (item.id === tab.id ? tab : item)),
			activeDocument: tab.id,
		};
	const source = state.documents.findIndex(
		(item) => item.id === state.activeDocument && item.kind === 'diff' && item.path === tab.path
	);
	const documents = [...state.documents];
	documents.splice(tab.kind === 'file' && source >= 0 ? source + 1 : documents.length, 0, tab);
	return { documents, activeDocument: tab.id };
}
export function closeDocument(state: DocumentTabs, id: string): DocumentTabs {
	const index = state.documents.findIndex((tab) => tab.id === id);
	if (index < 0) return state;
	const documents = state.documents.filter((tab) => tab.id !== id);
	return {
		documents,
		activeDocument:
			state.activeDocument === id
				? (documents[Math.min(index, documents.length - 1)]?.id ?? null)
				: state.activeDocument,
	};
}
export function documentForFile(id: string, path: string): DocumentTab {
	return { id: `file:${id}`, kind: 'file', path, target: id };
}
export function documentForDiff(scopePath: string): DocumentTab {
	return {
		id: `diff:${scopePath}`,
		kind: 'diff',
		path: scopePath.slice(scopePath.indexOf('/') + 1),
		target: scopePath,
	};
}

/** spec/editor#tab-menu: the tab's native menu. Closing goes back to the renderer; the path items finish in main. */
export type DocumentTabMenuAction =
	| 'close'
	| 'close-others'
	| 'close-all'
	| 'close-unmodified'
	| 'close-right'
	| 'reopen-tab'
	| 'under-chat'
	| DocumentTabSplitAction;
/** spec/editor#editor-groups: JetBrains' split group of the tab menu; the renderer runs them on the clicked tab's group. */
export type DocumentTabSplitAction =
	| 'split-right'
	| 'split-down'
	| 'split-move-right'
	| 'split-move-down'
	| 'move-other-group'
	| 'unsplit'
	| 'unsplit-all';
export const documentTabSplitActions: readonly DocumentTabSplitAction[] = [
	'split-right',
	'split-down',
	'split-move-right',
	'split-move-down',
	'move-other-group',
	'unsplit',
	'unsplit-all',
];
type DocumentTabMainAction = 'copy-path' | 'copy-absolute' | 'finder';
/** What the renderer knows at the click. `file` is the local file behind the tab; a PR, commit or Overview tab has none. */
/** `groups`: the editor groups on screen (spec/editor#editor-groups); `others` also tells whether the tab's group holds another tab to keep. */
/** `underChat` (spec/task-window-workspace#work-area): the tab is in the bottom group — whether that group stays under the chat while the work
 *  area is hidden; `null` for a tab of any other group. */
export type DocumentTabMenuState = {
	close: boolean;
	others: boolean;
	right: boolean;
	unmodified: boolean;
	/** spec/editor#reopen-closed-tab: the clicked tab's group has a closed tab to reopen. */
	reopen: boolean;
	groups: number;
	file: { id: string; source: 'editor' | 'changes' } | null;
	at: { x: number; y: number } | null;
	underChat: boolean | null;
};
export type DocumentTabMenuItem = {
	id: DocumentTabMenuAction | DocumentTabMainAction;
	label: MessageKey;
	enabled: boolean;
	/** The renderer glyph the native menu shows beside the item (spec/editor#editor-groups). */ icon: MenuIcon;
	/** A check item: its tick (spec/task-window-workspace#work-area, Under the chat). */ checked?: boolean;
	/** The menu bar's key of the same command, shown beside the item (spec/editor#reopen-closed-tab). */ accelerator?: string;
};
/** spec/editor#editor-groups: every item of the tab menu has its glyph; the renderer draws them, the menu shows them as template images. */
export const documentTabMenuIcons = {
	close: 'close',
	'close-others': 'tab-close-others',
	'close-all': 'tab-close-all',
	'close-unmodified': 'tab-close-clean',
	'close-right': 'tab-close-right',
	'reopen-tab': 'undo',
	'copy-path': 'copy',
	'copy-absolute': 'copy-absolute',
	finder: 'folder',
	'split-right': 'split-right',
	'split-down': 'split-down',
	'split-move-right': 'split-move-right',
	'split-move-down': 'split-move-down',
	'move-other-group': 'group-move',
	unsplit: 'unsplit',
	'unsplit-all': 'unsplit-all',
	'under-chat': 'layout-chat',
} as const satisfies Record<DocumentTabMenuAction | DocumentTabMainAction, MenuIcon>;
const tabItem = (
	id: DocumentTabMenuItem['id'],
	label: MessageKey,
	enabled: boolean
): DocumentTabMenuItem => ({ id, label, enabled, icon: documentTabMenuIcons[id] });
/** The same items in the same order on every tab; what does not apply is disabled, not hidden (as spec/editor#editor-context-menu). */
export function documentTabMenuItems(
	state: DocumentTabMenuState,
	keymap: KeymapSettings = defaultKeymap
): (DocumentTabMenuItem | null)[] {
	const reopen = menuCommands.find((command) => command.id === 'reopen-tab'),
		reopenKey = reopen && commandAccelerator(reopen, keymap);
	return [
		tabItem('close', 'Close', state.close),
		tabItem('close-others', 'Close other tabs', state.others),
		tabItem('close-all', 'Close all tabs', true),
		tabItem('close-unmodified', 'Close unmodified tabs', state.unmodified),
		tabItem('close-right', 'Close tabs to the right', state.right),
		// spec/editor#reopen-closed-tab: the clicked tab's group gets its last closed tab back.
		{
			...tabItem('reopen-tab', 'Reopen closed tab', state.reopen),
			...(reopenKey ? { accelerator: reopenKey } : {}),
		},
		null,
		tabItem('copy-path', 'Copy relative path', !!state.file),
		tabItem('copy-absolute', 'Copy absolute path', !!state.file),
		tabItem('finder', 'Reveal in Finder', !!state.file),
		null,
		// spec/editor#editor-groups: Split copies the tab into a new group, Move takes it there; moving a group's only tab would split nothing.
		tabItem('split-right', 'Split right', true),
		tabItem('split-down', 'Split down', true),
		tabItem('split-move-right', 'Split and move right', state.others),
		tabItem('split-move-down', 'Split and move down', state.others),
		tabItem('move-other-group', 'Move to the other group', state.groups > 1),
		tabItem('unsplit', 'Unsplit', state.groups > 1),
		tabItem('unsplit-all', 'Unsplit all', state.groups > 1),
		// spec/task-window-workspace#work-area: the bottom group may stay under the chat while the work area is hidden.
		...(state.underChat === null
			? []
			: [null, { ...tabItem('under-chat', 'Under the chat', true), checked: state.underChat }]),
	];
}
/** The tabs a menu action closes, in strip order. `modified` marks a buffer with unsaved edits; diffs never have one. */
export function documentsToClose(
	documents: readonly DocumentTab[],
	id: string,
	action: DocumentTabMenuAction,
	modified: (tab: DocumentTab) => boolean
): DocumentTab[] {
	const index = documents.findIndex((tab) => tab.id === id);
	if (index < 0) return [];
	if (action === 'close') return [documents[index]!];
	if (action === 'close-others') return documents.filter((tab) => tab.id !== id);
	if (action === 'close-right') return documents.slice(index + 1);
	if (action === 'close-unmodified') return documents.filter((tab) => !modified(tab));
	return [...documents];
}
const tabCoordinate = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function isDocumentTabMenuState(value: unknown): value is DocumentTabMenuState {
	if (!isRecord(value) || Object.keys(value).length !== 9) return false;
	if (value.underChat !== null && typeof value.underChat !== 'boolean') return false;
	if (
		!(['close', 'others', 'right', 'unmodified', 'reopen'] as const).every(
			(key) => typeof value[key] === 'boolean'
		)
	)
		return false;
	if (
		typeof value.groups !== 'number' ||
		!Number.isInteger(value.groups) ||
		value.groups < 1 ||
		value.groups > 64
	)
		return false;
	const file = value.file,
		at = value.at;
	if (
		file !== null &&
		!(
			isRecord(file) &&
			Object.keys(file).length === 2 &&
			isFileId(file.id) &&
			(file.source === 'editor' || file.source === 'changes')
		)
	)
		return false;
	return at === null || (isRecord(at) && tabCoordinate(at.x) && tabCoordinate(at.y));
}

/**
 * spec/appearance#evolution-redesign: tabs of one strip whose file names clash get the shortest folder tail that
 * tells them apart, as VS Code does: `…/FeedbackListItem` against `…/FeedbackListItemInner`; when the parent folders are
 * the same too, the tail grows to the first folder that differs (`Orders/…/Header` against `Feedbacks/…/Header`). Tabs
 * without a namesake get none, and nor do the tools and a PR's Overview. A diff tab's path is relative to its repo, so a
 * file tab whose path ends with it is taken for the same file, not a namesake. Returns the tail by tab id.
 */
export function documentTabTails(tabs: readonly DocumentTab[]): Map<string, string> {
	const name = (path: string) => path.slice(path.lastIndexOf('/') + 1),
		same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`),
		folders = (tab: DocumentTab) => tab.path.split('/').slice(0, -1);
	const byName = new Map<string, DocumentTab[]>();
	for (const tab of tabs)
		if ((tab.kind === 'file' || tab.kind === 'diff') && !tab.target.startsWith('overview:'))
			byName.set(name(tab.path), [...(byName.get(name(tab.path)) ?? []), tab]);
	const tails = new Map<string, string>();
	for (const group of byName.values()) {
		const clashing = group.filter((tab) => group.some((other) => !same(tab.path, other.path)));
		if (clashing.length < 2) continue;
		const shown = new Map<string, { folders: string[]; depth: number }>();
		for (const tab of clashing) {
			const mine = folders(tab);
			let depth = 1;
			for (const other of clashing) {
				if (same(tab.path, other.path)) continue;
				const theirs = folders(other);
				// Walking up from the parent folder: the first depth where the two differ (or one runs out).
				let at = 1;
				while (at <= Math.max(mine.length, theirs.length) && mine.at(-at) === theirs.at(-at)) at++;
				depth = Math.max(depth, at);
			}
			shown.set(tab.id, { folders: mine, depth: Math.min(depth, mine.length) });
		}
		const tail = ({ folders, depth }: { folders: string[]; depth: number }, whole = false) => {
			if (!depth) return '';
			const parent = folders.at(-1)!;
			if (depth === 1) return folders.length > 1 ? `…/${parent}` : parent;
			if (whole || depth === 2) return folders.slice(-depth).join('/');
			return `${folders.at(-depth)}/…/${parent}`;
		};
		const text = new Map([...shown].map(([id, value]) => [id, tail(value)]));
		// Two tabs that differ only between the shown folders: their whole run of folders tells them apart.
		for (const [id, value] of shown) {
			const twin = [...text].some(([other, label]) => other !== id && label === text.get(id));
			const label = twin ? tail(value, true) : text.get(id)!;
			if (label) tails.set(id, label);
		}
	}
	return tails;
}
