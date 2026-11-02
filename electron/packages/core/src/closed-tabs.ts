/**
 * spec/editor#reopen-closed-tab: the closed tabs of a task, newest last; each entry belongs to the editor group it was closed in. Reopen
 * takes the newest entry of the focused group, or of a group that is gone (its tabs belong to the focused one now), and
 * skips a tab that group already shows again. Tool tabs (terminal, browser, simulator) never get here: their session or
 * page ended with the tab. `extra` is the renderer's place to come back to: the caret and scroll of a file, the diff's
 * source of a commit, History or PR tab.
 */
import { isToolTab, type DocumentTab } from './document-tabs';
import { findGroup, type EditorGroups } from './editor-groups';

export type ClosedTab<T = unknown> = {
	tab: DocumentTab;
	group: string;
	/** The tab's place in its strip when it closed. */ index: number;
	extra?: T;
};
export const closedTabLimit = 30;

/** A closed tab on top of the stack; an older entry of the same tab in the same group goes, the oldest beyond the limit too. */
export function pushClosedTab<T>(
	stack: readonly ClosedTab<T>[],
	entry: ClosedTab<T>
): ClosedTab<T>[] {
	if (isToolTab(entry.tab)) return [...stack];
	const rest = stack.filter(
		(item) => !(item.tab.id === entry.tab.id && item.group === entry.group)
	);
	return [...rest, entry].slice(-closedTabLimit);
}

const reachable = <T>(item: ClosedTab<T>, groups: EditorGroups, group: string) =>
	item.group === group || !findGroup(groups, item.group);
const shownIn = (groups: EditorGroups, group: string, tab: DocumentTab) =>
	!!findGroup(groups, group)?.documents.some((item) => item.id === tab.id);

/** The entry Reopen would bring back into `group`, or null: the menu item is enabled only when there is one. */
export function nextClosedTab<T>(
	stack: readonly ClosedTab<T>[],
	groups: EditorGroups,
	group: string
): ClosedTab<T> | null {
	for (let index = stack.length - 1; index >= 0; index--) {
		const item = stack[index]!;
		if (reachable(item, groups, group) && !shownIn(groups, group, item.tab)) return item;
	}
	return null;
}

/** Takes the next entry for `group` off the stack, with the skipped ones of that group the strip shows again. */
export function takeClosedTab<T>(
	stack: readonly ClosedTab<T>[],
	groups: EditorGroups,
	group: string
): { entry: ClosedTab<T>; stack: ClosedTab<T>[] } | null {
	const entry = nextClosedTab(stack, groups, group);
	if (!entry) return null;
	const at = stack.indexOf(entry);
	return {
		entry,
		stack: stack.filter(
			(item, index) =>
				index !== at &&
				!(index > at && reachable(item, groups, group) && shownIn(groups, group, item.tab))
		),
	};
}
