import {
	editorMenuItems,
	pathWithLines,
	t,
	type EditorMenuState,
	type KeymapSettings,
	type Locale,
	type NativeMenuItem,
} from '@brigadir/core';

/** spec/editor#editor-context-menu: the native editor menu. Clipboard, path and Finder items finish where it shows; the rest go back to the editor. */
export function editorMenuTemplate(
	locale: Locale,
	file: { path: string; absolute: string; external: boolean },
	state: EditorMenuState,
	keymap: KeymapSettings
): NativeMenuItem[] {
	return editorMenuItems(state, keymap).map((item): NativeMenuItem => {
		if (!item) return null;
		// The menu bar owns these keys; here they are only shown. A file outside the project has no directory to open a terminal
		// in, and its package.json is not one of the project's (spec/search-menus-and-commands#package-scripts).
		const outside =
			file.external &&
			(item.id === 'terminal' || item.id === 'script-run' || item.id === 'script-command');
		const base = {
			id: item.id,
			label: t(locale, item.label),
			...(item.icon ? { icon: item.icon } : {}),
			enabled: item.enabled && !outside,
			...(item.accelerator ? { accelerator: item.accelerator } : {}),
		};
		if (item.id === 'cut' || item.id === 'copy' || item.id === 'paste')
			return { ...base, role: item.id };
		if (item.id === 'copy-line') return { ...base, copy: pathWithLines(file.path, state.lines) };
		if (item.id === 'copy-path') return { ...base, copy: file.path };
		if (item.id === 'finder') return { ...base, reveal: file.absolute };
		return base;
	});
}
