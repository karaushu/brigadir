import { describe, expect, it } from 'vitest';
import { menuCommands } from './menu';
import {
	codeMirrorKey,
	matchesAccelerator,
	keymapSection,
	keymapSections,
	acceleratorFromKey,
	assignShortcut,
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	isAccelerator,
	isKeymapSettings,
	keymapConflicts,
	keymapPresets,
	normalizeAccelerator,
	shortcutConflict,
	shortcutScope,
} from './keymap';
const command = (id: string) => menuCommands.find((item) => item.id === id)!;
describe('keymap (spec/settings-modules-and-onboarding#settings-keys)', () => {
	it('keeps the menu shortcuts in the Brigadir preset, in one spelling', () => {
		for (const item of menuCommands)
			expect(commandAccelerator(item, defaultKeymap)).toBe(
				item.accelerator && normalizeAccelerator(item.accelerator)
			);
		expect(commandAccelerator(command('sidebar-toggle'), defaultKeymap)).toBe('Ctrl+CmdOrCtrl+S');
		expect(commandAccelerator(command('editor-format'), defaultKeymap)).toBe('Alt+Shift+F');
	});
	it('ships every preset without a conflict', () => {
		for (const preset of keymapPresets)
			expect(keymapConflicts({ preset, overrides: {} })).toEqual([]);
	});
	it('replaces only the commands a preset knows', () => {
		const vscode = { preset: 'vscode' as const, overrides: {} };
		expect(commandAccelerator(command('editor-definition'), vscode)).toBe('F12');
		expect(commandAccelerator(command('quick-open-alias'), vscode)).toBeUndefined();
		expect(commandAccelerator(command('new-task'), vscode)).toBe('CmdOrCtrl+N');
		expect(
			commandAccelerator(command('editor-definition'), { preset: 'intellij', overrides: {} })
		).toBe('CmdOrCtrl+B');
	});
	it('lets an override win over the preset, null meaning no shortcut', () => {
		const keymap = {
			preset: 'vscode' as const,
			overrides: { 'editor-definition': 'CmdOrCtrl+B', 'new-task': null },
		};
		expect(commandAccelerator(command('editor-definition'), keymap)).toBe('CmdOrCtrl+B');
		expect(commandAccelerator(command('new-task'), keymap)).toBeUndefined();
	});
	it('finds a conflict only where both commands act', () => {
		expect(shortcutScope(command('editor-outdent'))).toBe('editor');
		expect(shortcutScope(command('browser-back'))).toBe('browser');
		expect(shortcutConflict(defaultKeymap, 'browser-back', 'CmdOrCtrl+[')).toBeNull();
		expect(shortcutConflict(defaultKeymap, 'search', 'CmdOrCtrl+J')).toEqual({
			kind: 'command',
			commandId: 'needs-next',
		});
		expect(shortcutConflict(defaultKeymap, 'editor-comment', 'CmdOrCtrl+N')).toEqual({
			kind: 'command',
			commandId: 'new-task',
		});
		expect(shortcutConflict(defaultKeymap, 'diff-toggle', 'CmdOrCtrl+B')).toBeNull();
		// spec/pull-requests-and-ci#reading-and-refresh: ⌘R refreshes PRs only from the PR panel, beside the browser's, the simulator's and IntelliJ's Replace.
		expect(shortcutScope(command('pull-requests-refresh'))).toBe('pullRequests');
		for (const preset of ['brigadir', 'vscode', 'intellij'] as const)
			expect(
				shortcutConflict({ preset, overrides: {} }, 'pull-requests-refresh', 'CmdOrCtrl+R')
			).toBeNull();
		expect(shortcutConflict(defaultKeymap, 'pull-requests-refresh', 'CmdOrCtrl+N')).toEqual({
			kind: 'command',
			commandId: 'new-task',
		});
	});
	it('refuses shortcuts that macOS or fixed app items keep', () => {
		expect(shortcutConflict(defaultKeymap, 'new-task', 'Command+Space')).toEqual({
			kind: 'reserved',
			owner: 'macOS',
			name: 'Spotlight',
		});
		expect(shortcutConflict(defaultKeymap, 'new-task', 'CmdOrCtrl+,')).toEqual({
			kind: 'reserved',
			owner: 'app',
			name: 'Settings…',
		});
		expect(() => assignShortcut(defaultKeymap, 'new-task', 'CmdOrCtrl+Q', true)).toThrow();
	});
	it('replaces the other command only when asked', () => {
		expect(() => assignShortcut(defaultKeymap, 'search', 'CmdOrCtrl+J')).toThrow();
		const next = assignShortcut(defaultKeymap, 'search', 'CmdOrCtrl+J', true);
		expect(next.overrides).toEqual({ search: 'CmdOrCtrl+J', 'needs-next': null });
		expect(keymapConflicts(next)).toEqual([]);
	});
	it('reads a pressed key as an accelerator and prints it as macOS does', () => {
		expect(
			acceleratorFromKey({
				key: 'k',
				code: 'KeyK',
				metaKey: true,
				shiftKey: true,
				altKey: false,
				ctrlKey: false,
			})
		).toBe('Shift+CmdOrCtrl+K');
		expect(
			acceleratorFromKey({
				key: 'ArrowDown',
				metaKey: true,
				altKey: true,
				shiftKey: false,
				ctrlKey: false,
			})
		).toBe('Alt+CmdOrCtrl+Down');
		expect(
			acceleratorFromKey({
				key: 'F7',
				altKey: true,
				metaKey: false,
				shiftKey: false,
				ctrlKey: false,
			})
		).toBe('Alt+F7');
		expect(
			acceleratorFromKey({
				key: 'F12',
				metaKey: false,
				altKey: false,
				shiftKey: false,
				ctrlKey: false,
			})
		).toBe('F12');
		expect(
			acceleratorFromKey({
				key: 'a',
				code: 'KeyA',
				metaKey: false,
				altKey: false,
				shiftKey: false,
				ctrlKey: false,
			})
		).toBeNull();
		expect(
			acceleratorFromKey({
				key: 'Meta',
				metaKey: true,
				altKey: false,
				shiftKey: false,
				ctrlKey: false,
			})
		).toBeNull();
		expect(formatAccelerator('CmdOrCtrl+Shift+K')).toBe('⇧⌘K');
		expect(formatAccelerator('Ctrl+Alt+Shift+Down')).toBe('⌃⌥⇧↓');
		expect(formatAccelerator('Alt+F7')).toBe('⌥F7');
	});
	it('validates stored keymaps', () => {
		expect(isKeymapSettings(defaultKeymap)).toBe(true);
		expect(
			isKeymapSettings({
				preset: 'intellij',
				overrides: { 'new-task': 'CmdOrCtrl+Shift+N', search: null },
			})
		).toBe(true);
		for (const bad of [
			{ preset: 'emacs', overrides: {} },
			{ preset: 'brigadir', overrides: { 'no-such-command': 'CmdOrCtrl+N' } },
			{ preset: 'brigadir', overrides: { 'new-task': 'Hyper+N' } },
			{ preset: 'brigadir' },
			null,
		])
			expect(isKeymapSettings(bad)).toBe(false);
		expect(isAccelerator('CmdOrCtrl+Plus')).toBe(true);
		expect(isAccelerator('CmdOrCtrl')).toBe(false);
	});
	it('sorts every menu command into one section', () => {
		for (const item of menuCommands) expect(keymapSections).toContain(keymapSection(item));
		expect(keymapSection(command('new-task'))).toBe('General');
		expect(keymapSection(command('composer'))).toBe('Chat');
		expect(keymapSection(command('turn-next'))).toBe('Chat');
		expect(keymapSection(command('editor-save'))).toBe('Editor');
		expect(keymapSection(command('diff-toggle'))).toBe('Changes');
		expect(keymapSection(command('terminal-new'))).toBe('Console');
		expect(keymapSection(command('browser-reload'))).toBe('Browser');
		expect(keymapSection(command('font-increase'))).toBe('View');
	});
	it('lets Add to queue share ⌘↩ with Submit only, never with another chat command (spec/composer-steering-queue-and-ghost#steering-hold)', () => {
		expect(keymapSection(command('composer-queue'))).toBe('Chat');
		expect(shortcutConflict(defaultKeymap, 'composer-queue', 'CmdOrCtrl+Enter')).toBeNull();
		expect(shortcutConflict(defaultKeymap, 'composer-queue', 'Shift+Tab')).toEqual({
			kind: 'command',
			commandId: 'composer-mode',
		});
		expect(shortcutConflict(defaultKeymap, 'composer-queue', 'CmdOrCtrl+.')).toEqual({
			kind: 'command',
			commandId: 'cancel',
		});
	});
	it('hands the same shortcuts to CodeMirror and to renderer key handlers', () => {
		expect(codeMirrorKey('CmdOrCtrl+S')).toBe('Mod-s');
		expect(codeMirrorKey('CmdOrCtrl+Alt+F')).toBe('Alt-Mod-f');
		expect(codeMirrorKey('Shift+F2')).toBe('Shift-F2');
		expect(codeMirrorKey('Alt+CmdOrCtrl+Down')).toBe('Alt-Mod-ArrowDown');
		const press = (key: string, mods: { meta?: boolean; shift?: boolean } = {}) => ({
			key,
			metaKey: Boolean(mods.meta),
			shiftKey: Boolean(mods.shift),
			altKey: false,
			ctrlKey: false,
		});
		expect(matchesAccelerator(press('=', { meta: true }), 'CmdOrCtrl+Plus')).toBe(true);
		expect(matchesAccelerator(press('+', { meta: true, shift: true }), 'CmdOrCtrl+Plus')).toBe(
			true
		);
		expect(matchesAccelerator(press('0', { meta: true }), 'CmdOrCtrl+0')).toBe(true);
		expect(matchesAccelerator(press('0', { meta: true }), undefined)).toBe(false);
		expect(matchesAccelerator(press('Tab', { shift: true }), 'Shift+Tab')).toBe(true);
		expect(matchesAccelerator(press('Tab'), 'Shift+Tab')).toBe(false);
	});
	it('gives the archive ⌃⌘A and its window ⌥⌘A without a conflict in any preset (spec/tasks#archive)', () => {
		for (const preset of keymapPresets) {
			const keymap = { preset, overrides: {} };
			expect(commandAccelerator(command('archive-task'), keymap)).toBe('Ctrl+CmdOrCtrl+A');
			expect(commandAccelerator(command('archive'), keymap)).toBe('Alt+CmdOrCtrl+A');
			for (const id of ['archive-task', 'archive'])
				expect(shortcutConflict(keymap, id, commandAccelerator(command(id), keymap)!)).toBeNull();
		}
		expect(formatAccelerator('Ctrl+CmdOrCtrl+A')).toBe('⌃⌘A');
		expect(formatAccelerator('Alt+CmdOrCtrl+A')).toBe('⌥⌘A');
	});
});
