/**
 * spec/editor#editor-groups: editor groups (Split). The documents area is a tree of splits; each leaf is a group with its own tab strip
 * and active tab. Pure state: the renderer keeps the focused group's tabs in its `documents` / `activeDocument` fields
 * and writes them into the tree before an operation (`withFocusedTabs`), then reads them back (`focusedTabs`).
 */
import { closeDocument, isToolTab, type DocumentTab, type DocumentTabs } from './document-tabs';
export type SplitDirection = 'right' | 'down';
export type EditorGroup = { kind: 'group'; id: string } & DocumentTabs;
export type EditorSplit = {
	kind: 'split';
	id: string;
	direction: SplitDirection;
	/** The first child's share, 0..1. */ ratio: number;
	first: EditorGroupNode;
	second: EditorGroupNode;
};
export type EditorGroupNode = EditorGroup | EditorSplit;
export type EditorGroups = {
	root: EditorGroupNode;
	focused: string;
	/** The next free number for a group or split id. */ next: number;
};
/** Where a dragged tab lands on a group: beside it (a new group) or inside it. */
export type GroupDrop = { group: string; at: SplitDirection | 'center' | { index: number } };

export const singleGroup = (
	tabs: DocumentTabs = { documents: [], activeDocument: null }
): EditorGroups => ({ root: { kind: 'group', id: 'g1', ...tabs }, focused: 'g1', next: 2 });
export function groupLeaves(node: EditorGroupNode): EditorGroup[] {
	return node.kind === 'group' ? [node] : [...groupLeaves(node.first), ...groupLeaves(node.second)];
}
export function findGroup(groups: EditorGroups, id: string): EditorGroup | null {
	return groupLeaves(groups.root).find((group) => group.id === id) ?? null;
}
export const groupCount = (groups: EditorGroups) => groupLeaves(groups.root).length;
/** The group whose strip holds `tab`, the focused one first. */
export function groupOf(groups: EditorGroups, tab: string): EditorGroup | null {
	const leaves = groupLeaves(groups.root);
	return (
		leaves.find(
			(group) => group.id === groups.focused && group.documents.some((item) => item.id === tab)
		) ??
		leaves.find((group) => group.documents.some((item) => item.id === tab)) ??
		null
	);
}
/** True when `tab` is open in a group other than `except`: closing it there must not release the buffer. */
export const openElsewhere = (groups: EditorGroups, tab: string, except: string) =>
	groupLeaves(groups.root).some(
		(group) => group.id !== except && group.documents.some((item) => item.id === tab)
	);
/** Every open tab once, in group order: the editor toggle's count and the buffers the LRU must keep. */
export function allGroupTabs(groups: EditorGroups): DocumentTab[] {
	const seen = new Map<string, DocumentTab>();
	for (const group of groupLeaves(groups.root))
		for (const tab of group.documents) if (!seen.has(tab.id)) seen.set(tab.id, tab);
	return [...seen.values()];
}
/** The tab each group shows; the passive groups' ones stay on screen, so their buffers stay loaded. */
export const shownTabs = (groups: EditorGroups) =>
	groupLeaves(groups.root).flatMap((group) =>
		group.documents.filter((tab) => tab.id === group.activeDocument)
	);

function mapNode(
	node: EditorGroupNode,
	id: string,
	change: (node: EditorGroupNode) => EditorGroupNode
): EditorGroupNode {
	if (node.id === id) return change(node);
	if (node.kind === 'group') return node;
	const first = mapNode(node.first, id, change),
		second = mapNode(node.second, id, change);
	return first === node.first && second === node.second ? node : { ...node, first, second };
}
const setGroup = (groups: EditorGroups, id: string, tabs: DocumentTabs): EditorGroups => ({
	...groups,
	root: mapNode(groups.root, id, (node) => ({ ...node, ...tabs }) as EditorGroup),
});
export const withFocusedTabs = (groups: EditorGroups, tabs: DocumentTabs) =>
	setGroup(groups, groups.focused, {
		documents: tabs.documents,
		activeDocument: tabs.activeDocument,
	});
export function focusedTabs(groups: EditorGroups): DocumentTabs {
	const group = findGroup(groups, groups.focused);
	return { documents: group?.documents ?? [], activeDocument: group?.activeDocument ?? null };
}

/** Takes a group out of the tree; its split collapses into the sibling. The last group stays. */
export function removeGroup(groups: EditorGroups, id: string): EditorGroups {
	if (groups.root.kind === 'group') return groups;
	let sibling: EditorGroupNode | null = null;
	const drop = (node: EditorGroupNode): EditorGroupNode => {
		if (node.kind === 'group') return node;
		if (node.first.id === id) {
			sibling = node.second;
			return node.second;
		}
		if (node.second.id === id) {
			sibling = node.first;
			return node.first;
		}
		const first = drop(node.first),
			second = drop(node.second);
		return first === node.first && second === node.second ? node : { ...node, first, second };
	};
	const root = drop(groups.root);
	if (!sibling) return groups;
	// The focus goes to the nearest group of the side that took the place, as JetBrains does.
	const focused = groups.focused === id ? groupLeaves(sibling)[0]!.id : groups.focused;
	return { ...groups, root, focused };
}
/** A tab put into a group: an existing tab with the same identity is activated, a new one goes after the active one or at `index`. */
function putTab(group: DocumentTabs, tab: DocumentTab, index?: number): DocumentTabs {
	if (group.documents.some((item) => item.id === tab.id)) {
		if (index === undefined) return { documents: group.documents, activeDocument: tab.id };
		const rest = group.documents.filter((item) => item.id !== tab.id),
			at = Math.max(
				0,
				Math.min(
					index - (group.documents.findIndex((item) => item.id === tab.id) < index ? 1 : 0),
					rest.length
				)
			);
		return { documents: [...rest.slice(0, at), tab, ...rest.slice(at)], activeDocument: tab.id };
	}
	const active = group.documents.findIndex((item) => item.id === group.activeDocument),
		at =
			index === undefined
				? active < 0
					? group.documents.length
					: active + 1
				: Math.max(0, Math.min(index, group.documents.length));
	return {
		documents: [...group.documents.slice(0, at), tab, ...group.documents.slice(at)],
		activeDocument: tab.id,
	};
}
/** spec/editor#reopen-closed-tab: a reopened tab back at its old place in `group` (the focused one when that group is gone), shown and focused. */
export function reopenTab(
	groups: EditorGroups,
	group: string,
	tab: DocumentTab,
	index: number
): EditorGroups {
	const leaf =
		findGroup(groups, group) ?? findGroup(groups, groups.focused) ?? groupLeaves(groups.root)[0]!;
	return { ...setGroup(groups, leaf.id, putTab(leaf, tab, index)), focused: leaf.id };
}
/** Removes a tab from a group; an emptied group leaves the tree unless it is the last one. */
export function closeInGroup(groups: EditorGroups, group: string, tab: string): EditorGroups {
	const leaf = findGroup(groups, group);
	if (!leaf || !leaf.documents.some((item) => item.id === tab)) return groups;
	const next = closeDocument(leaf, tab);
	return next.documents.length || groups.root.kind === 'group'
		? setGroup(groups, group, next)
		: removeGroup(groups, group);
}
/**
 * JetBrains' Split Right / Split Down (`move` false: the tab is also shown in the new group, one buffer behind both) and
 * Split and Move Right / Down (`move` true). The new group takes half of the group it splits and the focus.
 * Moving the only tab of a group splits nothing: the group would leave the same place it takes.
 */
export function splitGroup(
	groups: EditorGroups,
	group: string,
	tab: string,
	direction: SplitDirection,
	move: boolean
): EditorGroups {
	const leaf = findGroup(groups, group),
		item = leaf?.documents.find((document) => document.id === tab);
	if (!leaf || !item) return groups;
	// spec/task-window-workspace#work-area: a terminal, a browser or the simulator is one live surface; Split moves it, it never shows twice.
	if (isToolTab(item)) move = true;
	if (move && leaf.documents.length === 1) return groups;
	const fresh: EditorGroup = {
		kind: 'group',
		id: `g${groups.next}`,
		documents: [item],
		activeDocument: item.id,
	};
	const kept: EditorGroup = move ? { ...leaf, ...closeDocument(leaf, tab) } : leaf;
	const root = mapNode(groups.root, group, () => ({
		kind: 'split',
		id: `s${groups.next + 1}`,
		direction,
		ratio: 0.5,
		first: kept,
		second: fresh,
	}));
	return { root, focused: fresh.id, next: groups.next + 2 };
}
/**
 * A dragged tab dropped on a group (spec/editor#editor-groups): beside it opens a new group there, inside it (the document or a place in
 * the strip) moves the tab into it. `copy` (⌥) leaves the tab in its own group too.
 */
export function dropTab(
	groups: EditorGroups,
	from: string,
	tab: string,
	drop: GroupDrop,
	copy: boolean
): EditorGroups {
	const source = findGroup(groups, from),
		item = source?.documents.find((document) => document.id === tab),
		target = findGroup(groups, drop.group);
	if (!source || !item || !target) return groups;
	if (isToolTab(item)) copy = false;
	if (typeof drop.at === 'string' && drop.at !== 'center') {
		if (drop.group === from) return splitGroup(groups, from, tab, drop.at, !copy);
		const fresh: EditorGroup = {
			kind: 'group',
			id: `g${groups.next}`,
			documents: [item],
			activeDocument: item.id,
		};
		const direction = drop.at;
		let next: EditorGroups = {
			root: mapNode(groups.root, drop.group, (node) => ({
				kind: 'split',
				id: `s${groups.next + 1}`,
				direction,
				ratio: 0.5,
				first: node,
				second: fresh,
			})),
			focused: fresh.id,
			next: groups.next + 2,
		};
		if (!copy) next = closeInGroup(next, from, tab);
		return { ...next, focused: fresh.id };
	}
	if (drop.group === from) {
		if (drop.at === 'center')
			return {
				...setGroup(groups, from, { documents: source.documents, activeDocument: tab }),
				focused: from,
			};
		return { ...setGroup(groups, from, putTab(source, item, drop.at.index)), focused: from };
	}
	let next = setGroup(
		groups,
		drop.group,
		putTab(target, item, drop.at === 'center' ? undefined : drop.at.index)
	);
	if (!copy) next = closeInGroup(next, from, tab);
	return { ...next, focused: drop.group };
}
/** JetBrains' Move to Opposite Group: the tab goes to the next group in order and the focus follows it. */
export function moveToNextGroup(groups: EditorGroups, from: string, tab: string): EditorGroups {
	const leaves = groupLeaves(groups.root);
	if (leaves.length < 2) return groups;
	const index = leaves.findIndex((group) => group.id === from),
		target = leaves[(index + 1) % leaves.length]!;
	return dropTab(groups, from, tab, { group: target.id, at: 'center' }, false);
}
/** Next or previous group, round the tree in reading order (JetBrains' Goto Next / Previous Splitter). */
export function stepGroup(groups: EditorGroups, step: 1 | -1): EditorGroups {
	const leaves = groupLeaves(groups.root);
	if (leaves.length < 2) return groups;
	const index = leaves.findIndex((group) => group.id === groups.focused);
	return { ...groups, focused: leaves[(index + step + leaves.length) % leaves.length]!.id };
}
export const focusGroup = (groups: EditorGroups, id: string): EditorGroups =>
	findGroup(groups, id) && groups.focused !== id ? { ...groups, focused: id } : groups;
/** JetBrains' Unsplit: the group's tabs join the group that takes its place; the active tab stays in front. */
export function unsplitGroup(groups: EditorGroups, id: string): EditorGroups {
	const leaf = findGroup(groups, id);
	if (!leaf || groups.root.kind === 'group') return groups;
	const removed = removeGroup({ ...groups, focused: id }, id),
		into = findGroup(removed, removed.focused)!;
	let tabs: DocumentTabs = { documents: into.documents, activeDocument: into.activeDocument };
	for (const tab of leaf.documents)
		if (!tabs.documents.some((item) => item.id === tab.id))
			tabs = { documents: [...tabs.documents, tab], activeDocument: tabs.activeDocument };
	if (leaf.activeDocument) tabs = { ...tabs, activeDocument: leaf.activeDocument };
	return setGroup(removed, into.id, tabs);
}
/** JetBrains' Unsplit All: one group with every tab once, in group order; the focused group's tab stays active. */
export function unsplitAll(groups: EditorGroups): EditorGroups {
	if (groups.root.kind === 'group') return groups;
	const active = findGroup(groups, groups.focused)?.activeDocument ?? null;
	return singleGroup({ documents: allGroupTabs(groups), activeDocument: active });
}
/** A dragged split border; each side keeps at least `min` of the split's own length. */
export function resizeSplit(groups: EditorGroups, split: string, ratio: number): EditorGroups {
	const clamped = Math.max(0.1, Math.min(0.9, ratio));
	return {
		...groups,
		root: mapNode(groups.root, split, (node) =>
			node.kind === 'split' ? { ...node, ratio: clamped } : node
		),
	};
}
/** Brings the tree in line with the tabs that still exist: a tab closed from a bulk action leaves every group. */
export function pruneGroups(
	groups: EditorGroups,
	alive: (tab: DocumentTab) => boolean
): EditorGroups {
	let next = groups;
	for (const group of groupLeaves(groups.root))
		for (const tab of group.documents) if (!alive(tab)) next = closeInGroup(next, group.id, tab.id);
	return next;
}

/**
 * spec/task-window-workspace#work-area: the bottom group — the group under the rest of the work area, in the console's place: the second child of
 * a root split downwards. `null` while the work area has no such split.
 */
export function bottomGroup(groups: EditorGroups): EditorGroup | null {
	const root = groups.root;
	return root.kind === 'split' && root.direction === 'down' && root.second.kind === 'group'
		? root.second
		: null;
}
/** The group whose strip holds `tab`, and that tab shown and focused there; unchanged when no group has it. */
export function revealTab(groups: EditorGroups, tab: string): EditorGroups {
	const group = groupOf(groups, tab);
	if (!group) return groups;
	return {
		...setGroup(groups, group.id, { documents: group.documents, activeDocument: tab }),
		focused: group.id,
	};
}
/** The share of the work area's height the rest keeps above a new bottom group (the console's 260 of ~800). */
export const bottomGroupRatio = 0.68;
/**
 * spec/task-window-workspace#work-area: a tool tab opened from Tools or its shortcut. A tab already open anywhere is shown where it is. A new one
 * goes into the focused group, or into the bottom group (`bottom`), which is made under the whole work area when there
 * is none; an empty work area simply takes it. The group that takes the tab takes the focus.
 */
export function openToolTab(
	groups: EditorGroups,
	tab: DocumentTab,
	place: 'focused' | 'bottom',
	/** A command run in the background: its tab joins the group at the end, nothing else moves. */ quiet = false
): EditorGroups {
	if (groupOf(groups, tab.id)) return quiet ? groups : revealTab(groups, tab.id);
	const put = (group: EditorGroup) =>
		quiet && group.activeDocument
			? { documents: [...group.documents, tab], activeDocument: group.activeDocument }
			: putTab(group, tab);
	const empty = groups.root.kind === 'group' && !groups.root.documents.length;
	if (place === 'focused' || empty) {
		const focused = findGroup(groups, groups.focused) ?? groupLeaves(groups.root)[0]!;
		return { ...setGroup(groups, focused.id, put(focused)), focused: focused.id };
	}
	const bottom = bottomGroup(groups);
	if (bottom)
		return {
			...setGroup(groups, bottom.id, put(bottom)),
			focused: quiet ? groups.focused : bottom.id,
		};
	const fresh: EditorGroup = {
		kind: 'group',
		id: `g${groups.next}`,
		documents: [tab],
		activeDocument: tab.id,
	};
	return {
		root: {
			kind: 'split',
			id: `s${groups.next + 1}`,
			direction: 'down',
			ratio: bottomGroupRatio,
			first: groups.root,
			second: fresh,
		},
		focused: quiet ? groups.focused : fresh.id,
		next: groups.next + 2,
	};
}
/** Every tool tab of the work area once, in group order: the Tools button's count and its «Open · N» list. */
export const toolTabs = (groups: EditorGroups) => allGroupTabs(groups).filter(isToolTab);
/** A tab's title changed (a terminal's command, a page's title): every group that holds it shows the new one. */
export function renameTab(groups: EditorGroups, tab: string, title: string): EditorGroups {
	let next = groups;
	for (const group of groupLeaves(groups.root))
		if (group.documents.some((item) => item.id === tab && item.path !== title))
			next = setGroup(next, group.id, {
				documents: group.documents.map((item) =>
					item.id === tab ? { ...item, path: title } : item
				),
				activeDocument: group.activeDocument,
			});
	return next;
}
/** spec/task-window-workspace#restore-window: a tab takes another's place in every group that holds it — a terminal reopened in its folder keeps its slot. */
export function replaceTab(groups: EditorGroups, tab: string, next: DocumentTab): EditorGroups {
	let result = groups;
	for (const group of groupLeaves(groups.root))
		if (group.documents.some((item) => item.id === tab))
			result = setGroup(result, group.id, {
				documents: group.documents
					.filter((item) => item.id !== next.id)
					.map((item) => (item.id === tab ? next : item)),
				activeDocument: group.activeDocument === tab ? next.id : group.activeDocument,
			});
	return result;
}
/**
 * spec/task-window-workspace#empty-work-area: the tabs of the work area, each once — every group's, but the bottom group's while it stands under the
 * chat (`underChat`): that group is the chat column's, not the work area's.
 */
export function workAreaTabs(groups: EditorGroups, underChat: boolean): DocumentTab[] {
	const bottom = underChat ? bottomGroup(groups) : null,
		seen = new Map<string, DocumentTab>();
	for (const group of groupLeaves(groups.root))
		if (group !== bottom)
			for (const tab of group.documents) if (!seen.has(tab.id)) seen.set(tab.id, tab);
	return [...seen.values()];
}
/** spec/task-window-workspace#empty-work-area: the rest of the work area is one empty group above the bottom group — the place it keeps under the chat. */
export function holdsWorkArea(groups: EditorGroups): boolean {
	const root = groups.root;
	return (
		root.kind === 'split' &&
		root.direction === 'down' &&
		root.first.kind === 'group' &&
		!root.first.documents.length &&
		root.second.kind === 'group'
	);
}
/**
 * spec/task-window-workspace#empty-work-area: the last tab of the work area closed while the bottom group stands under the chat. The tree collapsed to
 * that group alone; it goes back under an empty group that holds the work area's place and takes the focus, so the next
 * file opens in the work area, not under the chat.
 */
export function holdWorkArea(groups: EditorGroups, ratio = bottomGroupRatio): EditorGroups {
	if (groups.root.kind !== 'group') return groups;
	const fresh: EditorGroup = {
		kind: 'group',
		id: `g${groups.next}`,
		documents: [],
		activeDocument: null,
	};
	return {
		root: {
			kind: 'split',
			id: `s${groups.next + 1}`,
			direction: 'down',
			ratio,
			first: fresh,
			second: groups.root,
		},
		focused: fresh.id,
		next: groups.next + 2,
	};
}
