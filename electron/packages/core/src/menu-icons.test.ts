import { describe, expect, it } from 'vitest';
import {
	appMenuIcons,
	attachMenuIcons,
	commandMenuIcons,
	fileMenuIcons,
	isMenuIconImages,
	menuIconNames,
	pickerMenuIcons,
	projectMenuIcons,
	prMenuIcons,
	roleMenuIcons,
	scheduleMenuIcons,
	taskMenuIcons,
	turnMenuIcons,
} from './menu-icons';
import { menuCommandIcons, menuCommands } from './menu';
import { editorMenuIcons, editorMenuItems, type EditorMenuState } from './editor-menu';
import { chatMenuItems, type ChatMenuState } from './chat-menu';
import { terminalMenuItems, type TerminalMenuState } from './terminal-menu';
import { documentTabMenuIcons } from './document-tabs';

const editor: EditorMenuState = {
	selection: true,
	word: true,
	change: true,
	revert: true,
	editable: true,
	format: true,
	comment: true,
	lines: { start: 1, end: 1 },
	at: null,
	git: { history: true, commit: true },
	script: true,
};
const chats: ChatMenuState[] = (['web', 'pr', 'file', 'folder', null] as const).map((link) => ({
	selection: true,
	link,
	line: true,
	code: true,
	image: true,
	message: true,
}));
const terminals: TerminalMenuState[] = (['web', 'pr', 'mail', 'file', 'folder', null] as const).map(
	(link) => ({ selection: true, link, browser: true, canPaste: true })
);
const icons = <T extends { icon: string }>(items: readonly (T | null)[]) =>
	items.filter((item): item is T => item !== null).map((item) => item.icon);

describe('native menu glyphs (spec/search-menus-and-commands#menu-glyphs)', () => {
	it('gives every menu-bar command a glyph and names no command that is gone', () => {
		expect(
			menuCommands.filter((command) => !menuCommandIcons[command.id]).map((command) => command.id)
		).toEqual([]);
		expect(
			Object.keys(menuCommandIcons).filter(
				(id) => !menuCommands.some((command) => command.id === id)
			)
		).toEqual([]);
	});
	it('gives every context menu item a glyph from the one set', () => {
		const names = new Set<string>(menuIconNames);
		const all = [
			...icons(editorMenuItems(editor)),
			...chats.flatMap((state) => icons(chatMenuItems(state))),
			...terminals.flatMap((state) => icons(terminalMenuItems(state))),
		];
		expect(all.filter((name) => !names.has(name))).toEqual([]);
		// One glyph per item inside a menu: the target tells two items with one action apart.
		expect(new Set(icons(editorMenuItems(editor))).size).toBe(
			icons(editorMenuItems(editor)).length
		);
		for (const list of [
			...chats.map((state) => icons(chatMenuItems(state))),
			...terminals.map((state) => icons(terminalMenuItems(state))),
		])
			expect(new Set(list).size, list.join()).toBe(list.length);
		expect(icons(chatMenuItems(chats[1]!))[0]).toBe('pr-branch');
		expect(icons(terminalMenuItems(terminals[4]!))[0]).toBe('folder');
	});
	it('rasterizes only glyphs some menu shows', () => {
		const used = new Set<string>([
			...Object.values(menuCommandIcons),
			...Object.values(editorMenuIcons),
			...Object.values(documentTabMenuIcons),
			...chats.flatMap((state) => icons(chatMenuItems(state))),
			...terminals.flatMap((state) => icons(terminalMenuItems(state))),
			...[
				taskMenuIcons,
				commandMenuIcons,
				projectMenuIcons,
				prMenuIcons,
				fileMenuIcons,
				turnMenuIcons,
				attachMenuIcons,
				pickerMenuIcons,
				appMenuIcons,
				roleMenuIcons,
				scheduleMenuIcons,
			].flatMap((map) => Object.values(map)),
		]);
		expect(menuIconNames.filter((name) => !used.has(name))).toEqual([]);
		expect(new Set(menuIconNames).size).toBe(menuIconNames.length);
	});
	it('accepts only PNG icons it knows', () => {
		const png = 'data:image/png;base64,iVBORw0KGgo=';
		expect(isMenuIconImages({ close: { x1: png, x2: png }, cut: { x1: png, x2: png } })).toBe(true);
		expect(isMenuIconImages({ nope: { x1: png, x2: png } })).toBe(false);
		expect(isMenuIconImages({ close: { x1: 'data:image/svg+xml;base64,AA==', x2: png } })).toBe(
			false
		);
		expect(isMenuIconImages({ close: { x1: png } })).toBe(false);
		expect(isMenuIconImages({ close: { x1: png, x2: png, x3: png } })).toBe(false);
		expect(
			isMenuIconImages({ close: { x1: `data:image/png;base64,${'A'.repeat(24000)}`, x2: png } })
		).toBe(false);
	});
});
