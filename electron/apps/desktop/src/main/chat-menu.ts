import {
	Menu,
	clipboard,
	ClipboardItem,
	type BrowserWindow,
	type ContextMenuParams,
} from 'electron';
import {
	chatMenuItems,
	terminalMenuItems,
	roleMenuIcons,
	t,
	type TerminalMenuState,
	type ChatMenuState,
	type KeymapSettings,
	type Locale,
	type NativeMenuItem,
} from '@brigadir/core';
import { menuIcon } from './menu-icons';

/** spec/chat#context-menu: the native chat log menu. Copy is the system role; every other item goes back to the log, which knows the target. */
export function chatMenuTemplate(locale: Locale, state: ChatMenuState): NativeMenuItem[] {
	return chatMenuItems(state).map((item): NativeMenuItem => {
		if (!item) return null;
		return {
			id: item.id,
			label: t(locale, item.label),
			...(item.icon ? { icon: item.icon } : {}),
			enabled: item.enabled,
			...(item.accelerator ? { accelerator: item.accelerator } : {}),
			...(item.id === 'copy' ? { role: 'copy' as const } : {}),
		};
	});
}

/** spec/terminal-and-cli-agents#console-links: the console's menu; xterm keeps its selection to itself, so no item is a system role: all go back to the console. */
export function terminalMenuTemplate(
	locale: Locale,
	state: TerminalMenuState,
	keymap?: KeymapSettings
): NativeMenuItem[] {
	return terminalMenuItems(state, keymap).map((item): NativeMenuItem =>
		item
			? {
					id: item.id,
					label: t(locale, item.label),
					...(item.icon ? { icon: item.icon } : {}),
					enabled: item.enabled,
					...(item.accelerator ? { accelerator: item.accelerator } : {}),
				}
			: null
	);
}

/** spec/chat#context-menu: a text field without its own menu gets the system edit menu; Electron has none by default. */
export function showEditMenu(
	window: BrowserWindow,
	locale: Locale,
	params: Pick<ContextMenuParams, 'isEditable' | 'editFlags'>
) {
	if (!params.isEditable) return false;
	const flags = params.editFlags;
	Menu.buildFromTemplate([
		{
			label: t(locale, 'Cut'),
			role: 'cut',
			...menuIcon(roleMenuIcons.cut),
			enabled: flags.canCut,
			accelerator: 'CmdOrCtrl+X',
			registerAccelerator: false,
		},
		{
			label: t(locale, 'Copy'),
			role: 'copy',
			...menuIcon(roleMenuIcons.copy),
			enabled: flags.canCopy,
			accelerator: 'CmdOrCtrl+C',
			registerAccelerator: false,
		},
		{
			label: t(locale, 'Paste'),
			role: 'paste',
			...menuIcon(roleMenuIcons.paste),
			enabled: flags.canPaste,
			accelerator: 'CmdOrCtrl+V',
			registerAccelerator: false,
		},
		{ type: 'separator' },
		{
			label: t(locale, 'Select all'),
			role: 'selectAll',
			...menuIcon(roleMenuIcons.selectall),
			enabled: flags.canSelectAll,
			accelerator: 'CmdOrCtrl+A',
			registerAccelerator: false,
		},
	]).popup({ window });
	return true;
}

/** spec/chat#context-menu: the whole image of a tile, not its thumbnail; attachments are PNG (spec/composer#paste). */
export function copyImage(png: Buffer) {
	return clipboard.write([
		new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
	]);
}
