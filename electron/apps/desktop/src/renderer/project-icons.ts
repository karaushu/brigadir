import { useEffect, useSyncExternalStore } from 'react';
/**
 * spec/appearance#evolution-redesign: the Lucide set (`lucide/`), loaded once and lazily — the sidebar needs the icons as soon as a project has one,
 * the tags only when the picker searches. Each icon is its node list on the 24 × 24 grid.
 */
export type LucideNode = [string, Record<string, string>];
type Lucide = { icons: Record<string, LucideNode[]> | null; tags: Record<string, string[]> | null };
let state: Lucide = { icons: null, tags: null },
	iconsLoading = false,
	tagsLoading = false;
const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};
function loadIcons() {
	if (iconsLoading) return;
	iconsLoading = true;
	void import('./lucide/icons.json').then((module) => {
		state = { ...state, icons: module.default as unknown as Record<string, LucideNode[]> };
		notify();
	});
}
function loadTags() {
	if (tagsLoading) return;
	tagsLoading = true;
	void import('./lucide/tags.json').then((module) => {
		state = { ...state, tags: module.default as unknown as Record<string, string[]> };
		notify();
	});
}
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
/** The icons (and, with `tags`, the search words); null until their chunk has loaded. */
export function useLucide(tags = false): Lucide {
	const value = useSyncExternalStore(subscribe, () => state);
	useEffect(() => {
		loadIcons();
		if (tags) loadTags();
	}, [tags]);
	return value;
}
