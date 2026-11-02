import { create } from 'zustand';
import { t, type Locale } from '@brigadir/core';
import { toastError } from './ui/Toast';
/**
 * spec/sidebar#crew-collapse: which crew cards are folded in the sidebar. It lives outside the card — a remount on opening or switching a task
 * must not unfold it — and persists in sidebar.json like the collapsed projects. Expanded by default.
 */
type CrewCollapse = { collapsed: ReadonlySet<string>; loaded: boolean };
export const useCrewCollapse = create<CrewCollapse>(() => ({
	collapsed: new Set(),
	loaded: false,
}));
let revision = 0,
	writes = Promise.resolve(),
	loading: Promise<void> | null = null;
export function loadCollapsedCrews() {
	loading ??= window.brigadir
		.readCollapsedCrews()
		.then((ids) => {
			useCrewCollapse.setState({ collapsed: new Set(ids), loaded: true });
		})
		.catch(() => {
			loading = null;
		});
	return loading;
}
export function collapseCrew(id: string, collapsed: boolean, locale: Locale) {
	const own = ++revision,
		next = new Set(useCrewCollapse.getState().collapsed);
	if (collapsed) next.add(id);
	else next.delete(id);
	useCrewCollapse.setState({ collapsed: next });
	writes = writes
		.then(async () => {
			const ids = await window.brigadir.collapseCrew(id, collapsed);
			if (revision === own) useCrewCollapse.setState({ collapsed: new Set(ids) });
		})
		.catch(() => {
			if (revision === own) {
				toastError(t(locale, 'Could not save the collapsed crews.'));
				loading = null;
				void loadCollapsedCrews();
			}
		});
}
