import { afterEach, describe, expect, it } from 'vitest';
import {
	commandShortcut,
	defaultKeymap,
	formatAccelerator,
	setShortcutPlatform,
	withPlatformKeys,
	withShortcut,
	type ShortcutPlatform,
} from './keymap';
afterEach(() => setShortcutPlatform('darwin'));
/** A command's key beside its name in the UI comes from the keymap, spelled for the platform (spec/architecture-and-platform#window-frame). */
const pc = {
	'new-task': 'Ctrl+N',
	commands: 'Ctrl+Shift+R',
	'command-run': 'Ctrl+Alt+Shift+R',
	'command-stop': 'Ctrl+Shift+.',
	archive: 'Alt+Shift+A',
	'archive-task': 'Ctrl+Alt+Shift+A',
	'editor-find': 'Ctrl+F',
	'editor-change-revert': 'Ctrl+Alt+Shift+Z',
};
const labels: Record<ShortcutPlatform, Record<string, string>> = {
	darwin: {
		'new-task': '⌘N',
		commands: '⌥⌘R',
		'command-run': '⌃⌘R',
		'command-stop': '⌃⌘.',
		archive: '⌥⌘A',
		'archive-task': '⌃⌘A',
		'editor-find': '⌘F',
		'editor-change-revert': '⌥⌘Z',
	},
	win32: pc,
	linux: pc,
};
describe('commandShortcut', () => {
	it.each(['darwin', 'win32', 'linux'] as const)('spells the keymap’s key on %s', (platform) => {
		setShortcutPlatform(platform);
		const shown = Object.fromEntries(
			Object.keys(labels.darwin).map((id) => [id, commandShortcut(id)])
		);
		expect(shown).toEqual(labels[platform]);
		if (platform !== 'darwin')
			for (const label of Object.values(shown)) expect(label).not.toMatch(/[⌘⌥⌃⇧↩]/);
	});
	it.each(['darwin', 'win32', 'linux'] as const)(
		'follows the person’s keymap and a preset on %s',
		(platform) => {
			setShortcutPlatform(platform);
			const mac = platform === 'darwin';
			expect(
				commandShortcut('new-task', {
					preset: 'brigadir',
					overrides: { 'new-task': 'CmdOrCtrl+Shift+H' },
				})
			).toBe(mac ? '⇧⌘H' : 'Ctrl+Shift+H');
			expect(
				commandShortcut('new-task', { preset: 'brigadir', overrides: { 'new-task': null } })
			).toBeUndefined();
			expect(commandShortcut('editor-find', { preset: 'intellij', overrides: {} })).toBe(
				mac ? '⌘F' : 'Ctrl+F'
			);
			expect(commandShortcut('quick-open', { preset: 'vscode', overrides: {} })).toBe(
				mac ? '⌘P' : 'Ctrl+P'
			);
			expect(commandShortcut('no-such-command', defaultKeymap)).toBeUndefined();
		}
	);
});
describe('bare keys', () => {
	it.each(['darwin', 'win32', 'linux'] as const)(
		'are glyphs on macOS and names on %s',
		(platform) => {
			setShortcutPlatform(platform);
			const mac = platform === 'darwin';
			expect(['Enter', 'Tab', 'Escape', 'Backspace', 'Up'].map(formatAccelerator)).toEqual(
				mac ? ['↩', '⇥', '⎋', '⌫', '↑'] : ['Enter', 'Tab', 'Esc', 'Backspace', '↑']
			);
			expect(withPlatformKeys('↩ send now · ⇥ ⎋ ⌫ ↑↓')).toBe(
				mac ? '↩ send now · ⇥ ⎋ ⌫ ↑↓' : 'Enter send now · Tab Esc Backspace ↑↓'
			);
		}
	);
});
describe('withShortcut', () => {
	it('adds the key after a middle dot, or leaves the label bare', () => {
		expect(withShortcut('Archive', '⌃⌘A')).toBe('Archive · ⌃⌘A');
		expect(withShortcut('Archive', undefined)).toBe('Archive');
	});
});
