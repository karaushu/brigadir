/**
 * spec/task-window-workspace#restore-window: the task window as it was closed — `surface.json` of the task. The renderer sends the tree of groups with each
 * tab's identity; main fills in what only it knows (a terminal's folder, a browser tab's address, the simulator's device),
 * turns opaque file ids into paths and writes the file. Reading goes back the same way: paths become ids again.
 */
import type { ChangeRange } from './changes';
import {
	documentForBrowser,
	documentForDiff,
	documentForFile,
	documentForSimulator,
	documentForTerminal,
	isBrowserTabId,
	type DocumentTab,
} from './document-tabs';
import { groupLeaves, type EditorGroupNode, type EditorGroups } from './editor-groups';
import { isRecord } from './workspace';

export const surfaceSchemaVersion = 1;
/** A buffer's caret and scroll by lines and columns: the file may change on disk before the tab reads it again. */
export type SurfacePlace = {
	anchor: { line: number; column: number };
	head: { line: number; column: number };
	scrollTop: number;
	scrollLeft: number;
};
/** `id` travels only between the renderer and main (the opaque file id, spec/editor#files-and-save); the file on disk holds the path. */
export type SurfaceTab =
	| { kind: 'file'; path: string; id?: string; place?: SurfacePlace }
	| { kind: 'diff'; scope: string; path: string; range: ChangeRange | null }
	/** `directory` — the session's folder inside the task, `null` for its root. */
	| { kind: 'terminal'; session: string; title: string; directory: string | null }
	| { kind: 'browser'; tab: string; title: string; url: string; mobile: boolean }
	| { kind: 'simulator'; title: string; device: string | null };
export type SurfaceNode =
	| { kind: 'group'; id: string; tabs: SurfaceTab[]; active: number | null }
	| {
			kind: 'split';
			id: string;
			direction: 'right' | 'down';
			ratio: number;
			first: SurfaceNode;
			second: SurfaceNode;
	  };
export type SurfaceWidths = { chat: number; panel: number; bottom: number };
export type TaskSurface = {
	groups: { root: SurfaceNode; focused: string; next: number };
	/** The three Layout switches (spec/task-window-workspace#layout-switch). */
	columns: { chat: boolean; work: boolean; panel: boolean };
	/** The chat and the panel columns and the bottom group under the chat (spec/task-window-workspace#work-area), px. */
	widths: SurfaceWidths;
	/** The panel's tab (Files · Changes · PR) and the Changes mode. */
	panel: { tab: 'changes' | 'files' | 'prs'; mode: 'diff' | 'history' | 'turns' };
	/** «Where to open» of Tools (spec/task-window-workspace#work-area). */
	toolPlace: 'focused' | 'bottom';
	/** The bottom group stands under the chat while the work area is hidden (spec/task-window-workspace#work-area). */
	bottomUnderChat: boolean;
	/** spec/task-window-workspace#two-columns: two columns show the pinned Chat tab in the first group; absent (an older file) — the chat. */
	chatTab?: boolean;
};
export type SurfaceDocument = { schemaVersion: typeof surfaceSchemaVersion; surface: TaskSurface };

const text = (value: unknown, max = 4096): value is string =>
	typeof value === 'string' && value.length <= max && !value.includes('\0');
const count = (value: unknown, max = 1e7): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const point = (value: unknown) =>
	isRecord(value) &&
	Number.isInteger(value.line) &&
	Number(value.line) >= 1 &&
	Number.isInteger(value.column) &&
	Number(value.column) >= 0;
/** A path inside the task: relative, no `..`, `.git` or empty parts. */
export function isSurfacePath(value: unknown): value is string {
	return (
		text(value) &&
		value.length > 0 &&
		!value.startsWith('/') &&
		value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git')
	);
}
const isPlace = (value: unknown): value is SurfacePlace =>
	isRecord(value) &&
	point(value.anchor) &&
	point(value.head) &&
	count(value.scrollTop) &&
	count(value.scrollLeft);
const isRange = (value: unknown): value is ChangeRange =>
	isRecord(value) &&
	Number.isSafeInteger(value.base) &&
	Number(value.base) >= 0 &&
	Number.isSafeInteger(value.current) &&
	Number(value.current) >= 0;
const isScope = (value: unknown): value is string =>
	text(value, 256) && value.length > 0 && !value.includes('/');
export function isSurfaceTab(value: unknown): value is SurfaceTab {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'file':
			return (
				isSurfacePath(value.path) &&
				(value.id === undefined ||
					(typeof value.id === 'string' && /^[a-f0-9]{64}$/.test(value.id))) &&
				(value.place === undefined || isPlace(value.place))
			);
		case 'diff':
			return (
				isScope(value.scope) &&
				isSurfacePath(value.path) &&
				(value.range === null || isRange(value.range))
			);
		case 'terminal':
			return (
				typeof value.session === 'string' &&
				/^[a-zA-Z0-9-]{1,128}$/.test(value.session) &&
				text(value.title, 512) &&
				(value.directory === null || isSurfacePath(value.directory))
			);
		case 'browser':
			return (
				isBrowserTabId(value.tab) &&
				text(value.title, 1024) &&
				text(value.url, 8192) &&
				(value.url === '' || /^https?:\/\//i.test(value.url)) &&
				typeof value.mobile === 'boolean'
			);
		case 'simulator':
			return text(value.title, 512) && (value.device === null || text(value.device, 256));
		default:
			return false;
	}
}
const isGroupId = (value: unknown): value is string =>
	typeof value === 'string' && /^[gs][0-9]{1,6}$/.test(value);
function isNode(value: unknown, depth: number): value is SurfaceNode {
	if (!isRecord(value) || depth > 16 || !isGroupId(value.id)) return false;
	if (value.kind === 'group')
		return (
			Array.isArray(value.tabs) &&
			value.tabs.length <= 500 &&
			value.tabs.every(isSurfaceTab) &&
			(value.active === null ||
				(Number.isInteger(value.active) &&
					Number(value.active) >= 0 &&
					Number(value.active) < value.tabs.length))
		);
	return (
		value.kind === 'split' &&
		(value.direction === 'right' || value.direction === 'down') &&
		typeof value.ratio === 'number' &&
		value.ratio >= 0.05 &&
		value.ratio <= 0.95 &&
		isNode(value.first, depth + 1) &&
		isNode(value.second, depth + 1)
	);
}
export function isTaskSurface(value: unknown): value is TaskSurface {
	if (!isRecord(value)) return false;
	const { groups, columns, widths, panel } = value;
	return (
		isRecord(groups) &&
		isNode(groups.root, 0) &&
		isGroupId(groups.focused) &&
		Number.isInteger(groups.next) &&
		Number(groups.next) >= 1 &&
		Number(groups.next) <= 1e6 &&
		isRecord(columns) &&
		typeof columns.chat === 'boolean' &&
		typeof columns.work === 'boolean' &&
		typeof columns.panel === 'boolean' &&
		isRecord(widths) &&
		count(widths.chat, 8000) &&
		count(widths.panel, 8000) &&
		count(widths.bottom, 8000) &&
		isRecord(panel) &&
		['changes', 'files', 'prs'].includes(String(panel.tab)) &&
		['diff', 'history', 'turns'].includes(String(panel.mode)) &&
		(value.toolPlace === 'focused' || value.toolPlace === 'bottom') &&
		typeof value.bottomUnderChat === 'boolean' &&
		(value.chatTab === undefined || typeof value.chatTab === 'boolean')
	);
}
/**
 * The schema version of a stored document: `null` — not one of ours (unreadable, not an object); a number the app does not
 * know is never written over (spec/task-window-workspace#restore-window), the file belongs to a newer Brigadir.
 */
export function surfaceVersionOf(value: unknown): number | null {
	return isRecord(value) && Number.isInteger(value.schemaVersion)
		? Number(value.schemaVersion)
		: null;
}
/** The stored surface, or `null` when the document is not a valid one of this version. */
export function readSurfaceDocument(value: unknown): TaskSurface | null {
	if (surfaceVersionOf(value) !== surfaceSchemaVersion || !isRecord(value)) return null;
	return isTaskSurface(value.surface) ? value.surface : null;
}

/** The tree of groups as `surface.json` holds it; a tab `tabOf` cannot keep (a commit's diff, a plan) leaves its group. */
export function surfaceGroups(
	groups: EditorGroups,
	tabOf: (tab: DocumentTab) => SurfaceTab | null
): TaskSurface['groups'] {
	const node = (value: EditorGroupNode): SurfaceNode => {
		if (value.kind === 'split')
			return {
				kind: 'split',
				id: value.id,
				direction: value.direction,
				ratio: Math.min(0.95, Math.max(0.05, value.ratio)),
				first: node(value.first),
				second: node(value.second),
			};
		const kept: { id: string; tab: SurfaceTab }[] = [];
		for (const document of value.documents) {
			const tab = tabOf(document);
			if (tab) kept.push({ id: document.id, tab });
		}
		const active = kept.findIndex((item) => item.id === value.activeDocument);
		return {
			kind: 'group',
			id: value.id,
			tabs: kept.map((item) => item.tab),
			active: active >= 0 ? active : kept.length ? 0 : null,
		};
	};
	return { root: node(groups.root), focused: groups.focused, next: groups.next };
}
/** The work-area tab of a stored one; `null` for a file main could not give an id (gone, outside the task). */
export function documentOfSurfaceTab(tab: SurfaceTab): DocumentTab | null {
	switch (tab.kind) {
		case 'file':
			return tab.id ? documentForFile(tab.id, tab.path) : null;
		case 'diff':
			return documentForDiff(`${tab.scope}/${tab.path}`);
		case 'terminal':
			return documentForTerminal(tab.session, tab.title);
		case 'browser':
			return documentForBrowser(tab.tab, tab.title);
		case 'simulator':
			return documentForSimulator(tab.title);
	}
}
/**
 * The group tree back from `surface.json`. A group whose tabs all went leaves the tree, as closing its last tab does
 * (spec/editor#editor-groups); the focus goes to the first group that is left, and `next` stays past every id in the tree.
 */
export function restoreSurfaceGroups(stored: TaskSurface['groups']): EditorGroups {
	const node = (value: SurfaceNode): EditorGroupNode | null => {
		if (value.kind === 'split') {
			const first = node(value.first),
				second = node(value.second);
			if (!first || !second) return first ?? second;
			return {
				kind: 'split',
				id: value.id,
				direction: value.direction,
				ratio: value.ratio,
				first,
				second,
			};
		}
		const documents: DocumentTab[] = [];
		let activeDocument: string | null = null;
		value.tabs.forEach((item, index) => {
			const tab = documentOfSurfaceTab(item);
			if (!tab || documents.some((other) => other.id === tab.id)) return;
			documents.push(tab);
			if (index === value.active) activeDocument = tab.id;
		});
		if (!documents.length) return null;
		return {
			kind: 'group',
			id: value.id,
			documents,
			activeDocument: activeDocument ?? documents[0]!.id,
		};
	};
	const root: EditorGroupNode = node(stored.root) ?? {
		kind: 'group',
		id: 'g1',
		documents: [],
		activeDocument: null,
	};
	const leaves = groupLeaves(root),
		ids = (value: EditorGroupNode): number[] =>
			value.kind === 'group'
				? [Number(value.id.slice(1))]
				: [Number(value.id.slice(1)), ...ids(value.first), ...ids(value.second)];
	return {
		root,
		focused: leaves.some((group) => group.id === stored.focused) ? stored.focused : leaves[0]!.id,
		next: Math.max(stored.next, ...ids(root).map((value) => value + 1)),
	};
}
/** Every stored tab once, in group order. */
export function surfaceTabs(surface: Pick<TaskSurface, 'groups'>): SurfaceTab[] {
	const walk = (node: SurfaceNode): SurfaceTab[] =>
		node.kind === 'group' ? node.tabs : [...walk(node.first), ...walk(node.second)];
	return walk(surface.groups.root);
}
/** The same tree with each tab replaced (`null` drops it): main turns ids into paths and back, and fills addresses. */
export function mapSurfaceTabs(
	surface: TaskSurface,
	change: (tab: SurfaceTab) => SurfaceTab | null
): TaskSurface {
	const walk = (node: SurfaceNode): SurfaceNode => {
		if (node.kind === 'split')
			return { ...node, first: walk(node.first), second: walk(node.second) };
		const tabs: SurfaceTab[] = [];
		let active: number | null = null;
		node.tabs.forEach((tab, index) => {
			const next = change(tab);
			if (!next) return;
			if (index === node.active) active = tabs.length;
			tabs.push(next);
		});
		return { ...node, tabs, active: active ?? (tabs.length ? 0 : null) };
	};
	return { ...surface, groups: { ...surface.groups, root: walk(surface.groups.root) } };
}

/** spec/task-window-workspace#restore-window: an unsaved buffer kept over a restart (hot exit). `state` is CodeMirror's `EditorState.toJSON` with its history. */
export type SurfaceDraft = {
	path: string;
	/** The opaque file id, between the renderer and main only. */ id?: string;
	/** The version of the disk text the buffer was based on: a different one on disk is a write conflict (spec/editor#files-and-save). */
	version: string;
	state: { doc: string; selection?: unknown; history?: unknown };
	scrollTop: number;
	scrollLeft: number;
};
export const draftTextLimit = 8 * 1024 * 1024;
export function isSurfaceDraft(value: unknown): value is SurfaceDraft {
	return (
		isRecord(value) &&
		isSurfacePath(value.path) &&
		(value.id === undefined || (typeof value.id === 'string' && /^[a-f0-9]{64}$/.test(value.id))) &&
		typeof value.version === 'string' &&
		/^[a-f0-9]{64}$/.test(value.version) &&
		isRecord(value.state) &&
		typeof value.state.doc === 'string' &&
		value.state.doc.length <= draftTextLimit &&
		count(value.scrollTop) &&
		count(value.scrollLeft)
	);
}

/** spec/task-window-workspace#restore-window: the app window's place. */
export type WindowBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
	maximized: boolean;
};
export type DisplayArea = { x: number; y: number; width: number; height: number };
export function isWindowBounds(value: unknown): value is WindowBounds {
	return (
		isRecord(value) &&
		['x', 'y', 'width', 'height'].every(
			(key) => Number.isInteger(value[key]) && Math.abs(Number(value[key])) <= 100_000
		) &&
		Number(value.width) > 0 &&
		Number(value.height) > 0 &&
		typeof value.maximized === 'boolean'
	);
}
/**
 * The saved window back on screen: it stays where it was while a connected display shows at least 100 × 60 px of its top
 * strip (where the title bar is); otherwise it goes to the primary display's work area, centred. Either way it is no larger
 * than the display that takes it and no smaller than the window's minimum.
 */
export function fitWindowBounds(
	saved: WindowBounds,
	displays: readonly DisplayArea[],
	primary: DisplayArea,
	minimum = { width: 820, height: 560 }
): WindowBounds {
	const strip = { x: saved.x, y: saved.y, width: saved.width, height: Math.min(saved.height, 60) };
	const shown = (area: DisplayArea) => {
		const width = Math.min(strip.x + strip.width, area.x + area.width) - Math.max(strip.x, area.x),
			height = Math.min(strip.y + strip.height, area.y + area.height) - Math.max(strip.y, area.y);
		return width >= 100 && height >= Math.min(60, strip.height) ? width * height : 0;
	};
	const best = [...displays].sort((a, b) => shown(b) - shown(a))[0];
	const size = (area: DisplayArea) => ({
		width: Math.max(Math.min(saved.width, area.width), Math.min(minimum.width, area.width)),
		height: Math.max(Math.min(saved.height, area.height), Math.min(minimum.height, area.height)),
	});
	if (best && shown(best) > 0) {
		const { width, height } = size(best);
		return {
			x: Math.min(Math.max(saved.x, best.x), best.x + best.width - Math.min(width, best.width)),
			y: Math.min(Math.max(saved.y, best.y), best.y + best.height - Math.min(height, best.height)),
			width,
			height,
			maximized: saved.maximized,
		};
	}
	const { width, height } = size(primary);
	return {
		x: primary.x + Math.round((primary.width - width) / 2),
		y: primary.y + Math.round((primary.height - height) / 2),
		width,
		height,
		maximized: saved.maximized,
	};
}
