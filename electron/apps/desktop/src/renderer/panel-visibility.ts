/** spec/task-window-workspace#layout-switch: the panel (Files · Changes · PR) — its tabs stand in its own header, its switch is the third of Layout. */
export type PanelTab = 'changes' | 'files' | 'prs';
/** ⇧⌘E / ⇧⌘D / ⇧⌘P: open the panel on that tab; the same key again while it shows that tab hides the panel. */
export function panelShortcut(
	current: { panel: PanelTab; shown: boolean },
	value: PanelTab
): { panel: PanelTab; panelShown: boolean } {
	return { panel: value, panelShown: !(current.shown && current.panel === value) };
}
/** spec/task-window-workspace#layout-switch: anything that puts a document on screen (a new tab, another active tab, a diff or a file chosen as the surface)
 *  shows the work area first; a patch that sets the switch itself decides. */
export function opensEditor(
	patch: {
		workShown?: boolean;
		documents?: readonly unknown[];
		activeDocument?: string | null;
		surface?: 'chat' | 'diff' | 'editor';
	},
	documentCount: number
): boolean {
	if ('workShown' in patch) return false;
	return (
		(patch.documents !== undefined && patch.documents.length > documentCount) ||
		typeof patch.activeDocument === 'string' ||
		patch.surface === 'diff' ||
		patch.surface === 'editor'
	);
}
