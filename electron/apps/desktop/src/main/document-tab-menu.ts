import {
	documentTabMenuItems,
	t,
	type DocumentTabMenuState,
	type KeymapSettings,
	type Locale,
	type NativeMenuItem,
} from '@brigadir/core';

/** spec/editor#tab-menu: the native menu of a document tab. Closing goes back to the renderer; paths and Finder finish where it shows. */
export function documentTabMenuTemplate(
	locale: Locale,
	file: { path: string; absolute: string } | null,
	state: DocumentTabMenuState,
	keymap?: KeymapSettings
): NativeMenuItem[] {
	return documentTabMenuItems(state, keymap).map((item): NativeMenuItem => {
		if (!item) return null;
		const base = {
			id: item.id,
			label: t(locale, item.label),
			enabled:
				item.enabled && (!['copy-path', 'copy-absolute', 'finder'].includes(item.id) || !!file),
			...(item.icon ? { icon: item.icon } : {}),
			...(item.checked === undefined ? {} : { checked: item.checked }),
			...(item.accelerator ? { accelerator: item.accelerator } : {}),
		};
		if (file && item.id === 'copy-path') return { ...base, copy: file.path };
		if (file && item.id === 'copy-absolute') return { ...base, copy: file.absolute };
		if (file && item.id === 'finder') return { ...base, reveal: file.absolute };
		return base;
	});
}
