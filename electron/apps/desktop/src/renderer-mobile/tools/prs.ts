/**
 * spec/remote-access-and-mobile#phone-pr-list: what the project's PR segment reads from the machine — the PR list of the project's main tree
 * (`readPullRequests(project, null)`, main's 20 s cache; `fresh` past it when pulled to refresh), kept per project so the
 * segment's count and the list share one read; and the key of the main tree's hidden record that a PR without a task writes
 * with (spec/tasks#quick-tasks, `openMainTree`).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { PullRequestsSnapshot, TaskKey } from '@brigadir/core';

export type PRListEntry = {
	value: PullRequestsSnapshot | null;
	error: string | null;
	loading: boolean;
};
export const usePRLists = create<{ lists: Record<string, PRListEntry> }>(() => ({ lists: {} }));
const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		''
	);
const flights = new Map<string, Promise<void>>();
function update(projectId: string, patch: Partial<PRListEntry>) {
	usePRLists.setState((state) => {
		const entry = state.lists[projectId] ?? { value: null, error: null, loading: false };
		return { lists: { ...state.lists, [projectId]: { ...entry, ...patch } } };
	});
}
export function loadPRList(projectId: string, fresh: boolean): Promise<void> {
	const name = `${projectId}:${fresh}`,
		running = flights.get(name);
	if (running) return running;
	update(projectId, { loading: true });
	const flight = window.brigadir
		.readPullRequests(projectId, null, fresh)
		.then(
			(value) => update(projectId, { value, error: null }),
			// The last list stays: an error is a banner over it, never «no PRs» (spec/pull-requests-and-ci#reading-and-refresh).
			(error) => update(projectId, { error: message(error) })
		)
		.finally(() => {
			flights.delete(name);
			update(projectId, { loading: false });
		});
	flights.set(name, flight);
	return flight;
}
/** The project's PR list, read when its screen opens; no polling (spec/pull-requests-and-ci#reading-and-refresh). */
export function usePRList(projectId: string): PRListEntry | undefined {
	const entry = usePRLists((state) => state.lists[projectId]);
	useEffect(() => {
		void loadPRList(projectId, false);
	}, [projectId]);
	return entry;
}
const mainTrees = new Map<string, Promise<TaskKey>>();
/** The main tree's hidden record of the project, created once per machine session before a PR without a task writes. */
export function mainTreeKey(projectId: string): Promise<TaskKey> {
	let key = mainTrees.get(projectId);
	if (!key) {
		key = window.brigadir
			.openMainTree(projectId)
			.then((task) => ({ projectId: task.projectId, id: task.id }));
		key.catch(() => mainTrees.delete(projectId));
		mainTrees.set(projectId, key);
	}
	return key;
}
