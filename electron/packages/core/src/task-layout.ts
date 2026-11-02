import { groupLeaves, type EditorGroup, type EditorGroups } from './editor-groups';
/**
 * spec/task-window-workspace#layout-switch: the layout of a task window — three independent switches, the chat, the work area and the panel. Every
 * one of them may go, all three too: with neither the chat nor the work area on
 * screen the task shows its empty state (spec/task-window-workspace#empty-work-area). spec/task-window-workspace#empty-work-area: a work area without tabs is hidden. The shape is the one
 * spec/task-window-workspace#restore-window keeps per task on disk.
 */
export type LayoutColumn = 'chat' | 'work' | 'panel';
export type TaskLayout = Record<LayoutColumn, boolean>;
export const layoutColumns: readonly LayoutColumn[] = ['chat', 'work', 'panel'];
/**
 * A task with no remembered layout (spec/task-window-workspace#layout-switch): the chat and the work area, the panel off — all three
 * at their spec/task-window#layout-overview minimums (380 + 400 + 400) and the sidebar do not fit a 1280 window and it scrolls sideways.
 */
export const defaultTaskLayout: TaskLayout = { chat: true, work: true, panel: false };
/** The first layout of a task's window. The main tree has no chat, so its panel (Files) has the room and stays. */
export const firstTaskLayout = (mainTree: boolean): TaskLayout =>
	mainTree ? { ...defaultTaskLayout, panel: true } : defaultTaskLayout;
/** A click on a switch or ⌘1–⌘3: the column flips; none is kept on. */
export const toggleColumn = (layout: TaskLayout, column: LayoutColumn): TaskLayout => ({
	...layout,
	[column]: !layout[column],
});
/**
 * spec/task-window-workspace#empty-work-area: an empty work area is never shown. Without a tab (`workTabs`, its own groups — not the bottom group under the
 * chat) it goes; a work area with tabs stays as the switches say. Nothing else comes back in its place: with
 * the chat and the panel off too the task shows its empty state. The main tree keeps a
 * work area without a tab — it shows the empty state with the brigadier's helmet there.
 */
export function fitWorkArea(layout: TaskLayout, workTabs: number, mainTree = false): TaskLayout {
	if (mainTree || workTabs > 0 || !layout.work) return layout;
	return { ...layout, work: false };
}
/** spec/task-window-workspace#empty-work-area: turning a task's work area on while it has no tab opens Tools instead — there is nothing to show yet. */
export const opensToolsInstead = (layout: TaskLayout, column: LayoutColumn, workTabs: number) =>
	column === 'work' && !layout.work && workTabs === 0;
/** spec/task-window-workspace#empty-work-area: neither the chat nor the work area is on screen — the place of both shows the empty state. */
export const showsEmptyPlace = (layout: TaskLayout) => !layout.chat && !layout.work;
export function isTaskLayout(value: unknown): value is TaskLayout {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.keys(value).length === 3 &&
		layoutColumns.every((key) => typeof (value as Record<string, unknown>)[key] === 'boolean')
	);
}

/**
 * spec/task-window-workspace#two-columns: how a task window is laid out — the app's choice in `Layout ▾` and Settings ▸ Appearance, never by the window's
 * width. `three`: the chat is a column beside the work area (spec/task-window-workspace#layout-switch). `two`: there is no chat column; the chat is the first,
 * pinned tab of the work area's first group, and the work area is always on screen. The main tree has no chat and ignores it.
 */
export const taskColumnChoices = ['two', 'three'] as const;
export type TaskColumns = (typeof taskColumnChoices)[number];
export const defaultTaskColumns: TaskColumns = 'three';
export const isTaskColumns = (value: unknown): value is TaskColumns =>
	taskColumnChoices.includes(value as TaskColumns);
/**
 * spec/task-window-workspace#two-columns: what the pinned Chat tab says while a file is open: the agent waits for the person (amber glyph and dot),
 * works (the spinner), finished a turn the person has not seen (an accent dot), or nothing (the chat glyph).
 */
export type ChatTabState = 'waiting' | 'running' | 'unread' | 'idle';
export function chatTabState(agent: {
	waiting: boolean;
	running: boolean;
	unread: boolean;
}): ChatTabState {
	return agent.waiting ? 'waiting' : agent.running ? 'running' : agent.unread ? 'unread' : 'idle';
}
/**
 * spec/task-window-workspace#two-columns: a turn that ended while the chat was not on screen leaves the tab unread; the chat on screen reads it.
 * `before` / `now` — whether the agent worked; `shown` — the chat is on screen now.
 */
export function chatUnreadAfter(unread: boolean, before: boolean, now: boolean, shown: boolean) {
	if (shown) return false;
	return unread || (before && !now);
}
/**
 * spec/task-window-workspace#two-columns: ⌘1–⌘3 in two columns. ⌘1 always shows the Chat tab (again does not hide it); ⌘2 goes back to the file the
 * chat's group showed last, or opens Tools when the work area has no tab at all (spec/task-window-workspace#empty-work-area); ⌘3 flips the panel.
 */
export type TwoColumnsStep = 'chat' | 'file' | 'tools' | 'panel' | 'none';
export function twoColumnsShortcut(
	column: LayoutColumn,
	place: { groupFile: boolean; workTabs: number }
): TwoColumnsStep {
	if (column === 'chat') return 'chat';
	if (column === 'panel') return 'panel';
	return place.groupFile ? 'file' : place.workTabs === 0 ? 'tools' : 'none';
}
/** spec/task-window-workspace#two-columns: the group that holds the pinned Chat tab — the first group of the work area. */
export const chatGroup = (groups: EditorGroups): EditorGroup => groupLeaves(groups.root)[0]!;
/**
 * spec/task-window-workspace#two-columns: whether the pinned Chat tab is the one its group shows after a change. `chat` — the change says so itself
 * (the chat's own surface, a restored window, an agent's tab that must not move the person's view); `explicit` — the person
 * chose a document to show in the focused group (a file from the tree, a diff). Otherwise a tab the chat's group switched to
 * hides the chat; a closed tab, a split or a resize does not.
 */
export function chatTabAfter(
	shown: boolean,
	before: EditorGroups,
	after: EditorGroups,
	change: { chat?: boolean | undefined; explicit?: boolean | undefined }
): boolean {
	if (change.chat !== undefined) return change.chat;
	const old = chatGroup(before),
		now = chatGroup(after);
	if (!now.activeDocument) return shown;
	if (change.explicit && after.focused === now.id) return false;
	if (
		old.id === now.id &&
		old.activeDocument !== now.activeDocument &&
		now.documents.length >= old.documents.length
	)
		return false;
	return shown;
}
/**
 * spec/task-window-workspace#two-columns: the switches of a two-column window — no chat column, the work area always there (the Chat tab holds it), the
 * panel as the task keeps it. The task's own `chat` / `work` stay stored for three columns.
 */
export const twoColumnsLayout = (layout: TaskLayout): TaskLayout => ({
	chat: false,
	work: true,
	panel: layout.panel,
});
