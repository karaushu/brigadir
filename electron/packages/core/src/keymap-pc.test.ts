import { afterEach, describe, expect, it } from 'vitest';
import { menuCommands } from './menu';
import {
	acceleratorFromKey,
	altGrUnsafe,
	assignShortcut,
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	isAccelerator,
	keymapConflicts,
	keymapPresets,
	matchesAccelerator,
	pcCandidates,
	pcReservedAccelerators,
	setShortcutPlatform,
	shortcutConflict,
	type ShortcutPlatform,
} from './keymap';
const command = (id: string) => menuCommands.find((item) => item.id === id)!;
const pc = (id: string, keymap = defaultKeymap) => commandAccelerator(command(id), keymap);
afterEach(() => setShortcutPlatform('darwin'));
describe('shortcuts on Windows and Linux (spec/architecture-and-platform#window-frame)', () => {
	it('reads ⌘ as Ctrl, ⌥ as Alt and keeps ⇧', () => {
		expect(pcCandidates('CmdOrCtrl+Shift+K')[0]).toBe('Ctrl+Shift+K');
		expect(pcCandidates('Alt+Shift+F')[0]).toBe('Alt+Shift+F');
		expect(pcCandidates('Alt+F7')[0]).toBe('Alt+F7');
		// ⌃ beside ⌘ becomes Alt; alone it is Ctrl, then Alt if that Ctrl is taken.
		expect(pcCandidates('Ctrl+CmdOrCtrl+S')).toEqual([
			'Ctrl+Alt+S',
			'Ctrl+Shift+S',
			'Ctrl+Alt+Shift+S',
		]);
		expect(pcCandidates('Ctrl+-')).toEqual(['Ctrl+-', 'Alt+-']);
		expect(pcCandidates('Ctrl+Alt+Shift+Down')).toEqual(['Ctrl+Alt+Shift+Down']);
	});
	it('never lands on AltGr: Ctrl+Alt on a typing key moves to Ctrl+Shift or Ctrl+Alt+Shift', () => {
		expect(altGrUnsafe('Ctrl+Alt+S')).toBe(true);
		expect(altGrUnsafe('Ctrl+Alt+]')).toBe(true);
		expect(altGrUnsafe('Ctrl+Alt+Shift+S')).toBe(false);
		expect(altGrUnsafe('Ctrl+Alt+PageDown')).toBe(false);
		for (const platform of ['win32', 'linux'] as const) {
			setShortcutPlatform(platform);
			expect(pc('sidebar-toggle')).toBe('Ctrl+Shift+S');
			// spec/task-window-workspace#layout-switch: ⌘1–⌘3 are the Layout switches; the routes took Ctrl+Shift+1 / 2.
			expect(pc('layout-chat')).toBe('Ctrl+1');
			expect(pc('layout-panel')).toBe('Ctrl+3');
			expect(pc('tools')).toBe('Ctrl+Shift+I');
			expect(pc('browser-inspect')).toBe('F12');
			expect(pc('commands')).toBe('Ctrl+Shift+R');
			expect(pc('command-run')).toBe('Ctrl+Alt+Shift+R');
			expect(pc('editor-replace')).toBe('Ctrl+Alt+Shift+F');
			expect(pc('editor-change-revert')).toBe('Ctrl+Alt+Shift+Z');
		}
	});
	it('keeps the plain readings and the Windows convention where a desktop owns the straight one', () => {
		setShortcutPlatform('win32');
		expect(pc('new-task')).toBe('Ctrl+N');
		expect(pc('search')).toBe('Ctrl+Shift+K');
		expect(pc('editor-format')).toBe('Alt+Shift+F');
		expect(pc('editor-completions')).toBe('Ctrl+Space');
		expect(pc('document-next')).toBe('Ctrl+PageDown');
		expect(pc('turn-previous')).toBe('Alt+PageUp');
		expect(pc('editor-change-next')).toBe('Alt+F5');
		expect(pc('editor-location-previous')).toBe('Alt+Left');
		// spec/editor#reopen-closed-tab: Ctrl+Shift+T reopens a closed tab, as in browsers and VS Code; Turns keeps U with Alt+Shift.
		expect(pc('reopen-tab')).toBe('Ctrl+Shift+T');
		expect(pc('turns')).toBe('Alt+Shift+U');
		expect(pc('diff-jump-to-source')).toBe('F4');
		// spec/search-menus-and-commands#menu-structure: Ctrl+W closes the tab, not the window; the find panel steps with F3 / Shift+F3.
		expect(pc('close-tab')).toBe('Ctrl+W');
		expect(pc('editor-find-next')).toBe('F3');
		expect(pc('editor-find-previous')).toBe('Shift+F3');
		expect(pc('editor-replace-all')).toBe('Ctrl+Alt+Enter');
		// spec/sidebar#section-rail: the rail's sections, ⌃⌘1… on macOS, read Alt+1… (Ctrl+Alt+digit is AltGr).
		expect(pc('section-tasks')).toBe('Alt+1');
		expect(pc('section-prs')).toBe('Alt+2');
		// spec/tasks#archive: the archive keys do not take Find Action's Ctrl+Shift+A or an AltGr chord.
		expect(pc('archive-task')).toBe('Ctrl+Alt+Shift+A');
		expect(pc('archive')).toBe('Alt+Shift+A');
		expect(pc('find-action')).toBe('Ctrl+Shift+A');
	});
	it.each(['win32', 'linux'] as ShortcutPlatform[])(
		'ships every preset on %s without a conflict, a reserved key or a lost shortcut',
		(platform) => {
			for (const preset of keymapPresets) {
				setShortcutPlatform('darwin');
				const mac = new Map(
					menuCommands.map((item) => [item.id, commandAccelerator(item, { preset, overrides: {} })])
				);
				setShortcutPlatform(platform);
				const keymap = { preset, overrides: {} };
				expect(keymapConflicts(keymap)).toEqual([]);
				for (const item of menuCommands) {
					const key = commandAccelerator(item, keymap);
					expect(Boolean(key), `${preset} ${item.id}`).toBe(Boolean(mac.get(item.id)));
					if (!key) continue;
					expect(isAccelerator(key), key).toBe(true);
					expect(key).not.toMatch(/CmdOrCtrl|Command/);
					expect(pcReservedAccelerators[key], `${preset} ${item.id} ${key}`).toBeUndefined();
					expect(altGrUnsafe(key), `${preset} ${item.id} ${key}`).toBe(false);
				}
			}
		}
	);
	it('spells shortcuts in words and records Ctrl, never the Windows key', () => {
		setShortcutPlatform('win32');
		expect(formatAccelerator('Ctrl+Shift+K')).toBe('Ctrl+Shift+K');
		expect(formatAccelerator('Alt+PageDown')).toBe('Alt+PgDn');
		expect(formatAccelerator('Ctrl+Plus')).toBe('Ctrl++');
		const key = (over: Partial<Parameters<typeof acceleratorFromKey>[0]>) => ({
			key: 'k',
			code: 'KeyK',
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			...over,
		});
		expect(acceleratorFromKey(key({ ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+K');
		expect(acceleratorFromKey(key({ metaKey: true }))).toBeNull();
		expect(
			acceleratorFromKey({
				key: 'PageDown',
				metaKey: false,
				ctrlKey: true,
				altKey: false,
				shiftKey: false,
			})
		).toBe('Ctrl+PageDown');
		expect(matchesAccelerator(key({ ctrlKey: true, shiftKey: true }), pc('search'))).toBe(true);
		expect(matchesAccelerator(key({ metaKey: true, shiftKey: true }), pc('search'))).toBe(false);
	});
	it('reads an override as recorded and refuses keys the desktop keeps', () => {
		setShortcutPlatform('linux');
		expect(
			pc('new-task', { preset: 'brigadir', overrides: { 'new-task': 'CmdOrCtrl+Shift+N' } })
		).toBe('Ctrl+Shift+N');
		expect(shortcutConflict(defaultKeymap, 'new-task', 'Alt+F4')).toEqual({
			kind: 'reserved',
			owner: 'system',
			name: 'Close the window',
		});
		expect(shortcutConflict(defaultKeymap, 'new-task', 'Ctrl+Alt+T')).toEqual({
			kind: 'reserved',
			owner: 'system',
			name: 'Terminal',
		});
		expect(shortcutConflict(defaultKeymap, 'new-task', 'F10')).toEqual({
			kind: 'reserved',
			owner: 'app',
			name: 'Application menu',
		});
		expect(shortcutConflict(defaultKeymap, 'search', 'Ctrl+J')).toEqual({
			kind: 'command',
			commandId: 'needs-next',
		});
		expect(() => assignShortcut(defaultKeymap, 'new-task', 'Ctrl+Q', true)).toThrow();
	});
	it('leaves macOS as it was', () => {
		expect(pc('sidebar-toggle')).toBe('Ctrl+CmdOrCtrl+S');
		expect(formatAccelerator('Ctrl+CmdOrCtrl+S')).toBe('⌃⌘S');
		expect(
			acceleratorFromKey({
				key: 'k',
				code: 'KeyK',
				metaKey: true,
				ctrlKey: false,
				altKey: false,
				shiftKey: false,
			})
		).toBe('CmdOrCtrl+K');
	});
});
