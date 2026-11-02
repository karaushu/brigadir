import type { MentionMenuItem } from './MentionMenu';

/**
 * spec/composer#mentions: the sources of a menu (`@`: files, tasks, models; `/`: commands) are groups, and two groups or more
 * become tabs with `All` first. `section` is a sub-heading inside a group (a provider under Models).
 */
export type MentionGroupItem = Omit<MentionMenuItem, 'group'> & { section?: string };
export type MentionGroup = {
	id: string;
	label: string;
	items: readonly MentionGroupItem[];
	/** The name of the wait while the group loads, e.g. `Searching…`: skeleton rows show it (spec/appearance#loading). */ status?:
		string | null;
};
export type MentionTab = { id: string; label: string; count: number };
export const allTab = 'all';

export function mentionView(
	groups: readonly MentionGroup[],
	tab: string,
	allLabel: string
): { tabs: MentionTab[] | null; tab: string; items: MentionMenuItem[]; status: string | null } {
	const tabbed = groups.length > 1;
	const tabs = tabbed
		? [
				{
					id: allTab,
					label: allLabel,
					count: groups.reduce((sum, group) => sum + group.items.length, 0),
				},
				...groups.map((group) => ({ id: group.id, label: group.label, count: group.items.length })),
			]
		: null;
	const current = tabs?.some((item) => item.id === tab)
		? tab
		: tabbed
			? allTab
			: (groups[0]?.id ?? allTab);
	const shown =
		!tabbed || current === allTab ? groups : groups.filter((group) => group.id === current);
	// In `All` (and a menu of one group) a row's caption is its group, `Group · section` under a sub-heading; inside a
	// group's own tab only sub-headings remain.
	const items = shown.flatMap((group) =>
		group.items.map(({ section, ...item }): MentionMenuItem => ({
			...item,
			group:
				tabbed && current !== allTab
					? (section ?? '')
					: section
						? `${group.label} · ${section}`
						: group.label,
		}))
	);
	const status = items.length ? null : (shown.map((group) => group.status).find(Boolean) ?? null);
	return { tabs, tab: current, items, status };
}
/** `Tab` / `⇧Tab`: the next or previous tab, round the end. */
export function nextTab(tabs: readonly MentionTab[] | null, tab: string, step: 1 | -1): string {
	if (!tabs?.length) return tab;
	const index = Math.max(
		0,
		tabs.findIndex((item) => item.id === tab)
	);
	return tabs[(index + step + tabs.length) % tabs.length]!.id;
}
