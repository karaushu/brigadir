import { create } from 'zustand';
import {
	pushClosedTab,
	takeClosedTab,
	type ClosedTab,
	type EditorGroups,
	type TaskKey,
} from '@brigadir/core';
import type { EvictedEditor } from './editor-buffers';
import type { CommitDiffEntry } from './commit-diffs';
/**
 * spec/editor#reopen-closed-tab: the closed tabs of every task for the whole app session, outside the task state the LRU of five tasks
 * drops. A file keeps its caret and scroll; a commit, History or PR diff keeps the entry its tab reads the diff from.
 */
export type ClosedExtra = { place?: EvictedEditor; commitDiff?: CommitDiffEntry };
type Store = { stacks: Record<string, ClosedTab<ClosedExtra>[]> };
export const useClosedTabs = create<Store>(() => ({ stacks: {} }));
export const closedTabsKey = (task: TaskKey) => `${task.projectId}/${task.id}`;
export function rememberClosedTab(task: TaskKey, entry: ClosedTab<ClosedExtra>) {
	const key = closedTabsKey(task);
	useClosedTabs.setState((state) => ({
		stacks: { ...state.stacks, [key]: pushClosedTab(state.stacks[key] ?? [], entry) },
	}));
}
/** Takes the tab Reopen brings back into `group`, or null when its stack has none. */
export function takeClosed(task: TaskKey, groups: EditorGroups, group: string) {
	const key = closedTabsKey(task),
		taken = takeClosedTab(useClosedTabs.getState().stacks[key] ?? [], groups, group);
	if (!taken) return null;
	useClosedTabs.setState((state) => ({ stacks: { ...state.stacks, [key]: taken.stack } }));
	return taken.entry;
}
