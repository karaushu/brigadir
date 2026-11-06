import { create } from 'zustand';
import { t, type Locale } from '@brigadir/core';
import { toastError } from './ui/Toast';
/**
 * spec/sidebar#completed-fold: projects whose completed tasks are folded under «Completed · N». It persists in sidebar.json like the
 * folded projects and crews. Open by default.
 */
type CompletedCollapse = { collapsed: ReadonlySet<string>; loaded: boolean };
export const useCompletedCollapse = create<CompletedCollapse>(() => ({
	collapsed: new Set(),
	loaded: false,
}));
let revision = 0,
	writes = Promise.resolve(),
	loading: Promise<void> | null = null;
export function loadCollapsedCompleted() {
	loading ??= window.brigadir
		.readCollapsedCompleted()
		.then((ids) => {
			useCompletedCollapse.setState({ collapsed: new Set(ids), loaded: true });
		})
		.catch(() => {
			loading = null;
		});
	return loading;
}
export function collapseCompleted(projectId: string, collapsed: boolean, locale: Locale) {
	const own = ++revision,
		next = new Set(useCompletedCollapse.getState().collapsed);
	if (collapsed) next.add(projectId);
	else next.delete(projectId);
	useCompletedCollapse.setState({ collapsed: next });
	writes = writes
		.then(async () => {
			const ids = await window.brigadir.collapseCompleted(projectId, collapsed);
			if (revision === own) useCompletedCollapse.setState({ collapsed: new Set(ids) });
		})
		.catch(() => {
			if (revision === own) {
				toastError(t(locale, 'Could not save the collapsed completed tasks.'));
				loading = null;
				void loadCollapsedCompleted();
			}
		});
}
