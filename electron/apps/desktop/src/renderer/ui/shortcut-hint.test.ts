import { afterEach, expect, it } from 'vitest';
import { setShortcutPlatform } from '@brigadir/core';
import { shortcutHint } from './shortcut-hint';
afterEach(() => setShortcutPlatform('darwin'));
it.each(['darwin', 'win32', 'linux'] as const)(
	'formats the actual fixed gestures on %s',
	(platform) => {
		setShortcutPlatform(platform);
		const mac = platform === 'darwin';
		expect(shortcutHint('en', '⌘+click opens the link')).toBe(
			`${mac ? '⌘' : 'Ctrl'}+click opens the link`
		);
		expect(shortcutHint('uk', '⌘+click opens in editor')).toBe(
			`${mac ? '⌘' : 'Ctrl'}+клік відкриває в редакторі`
		);
		for (const key of ['⌘V or drag: images and files', '⌘↩ send · Esc cancel'] as const) {
			const hint = shortcutHint('en', key);
			expect(hint).not.toContain('{shortcut}');
			expect(hint).toContain(mac ? '⌘' : 'Ctrl+');
		}
	}
);
