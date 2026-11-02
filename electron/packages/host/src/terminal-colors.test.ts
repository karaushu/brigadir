import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '@brigadir/persistence';
import { oscColor, systemDark, terminalColors } from './terminal-colors';

it('follows the appearance chosen in settings; a CLI task has the console background (spec/task-window-workspace#tool-tab-look)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-colors-'));
	try {
		await atomicJson(join(root, 'settings.json'), {
			schemaVersion: 1,
			settings: { appearance: 'light' },
		});
		expect(await terminalColors(root, 'agent')).toEqual({
			background: '#f6f6f7',
			foreground: '#252525',
		});
		expect(await terminalColors(root, 'console')).toEqual(await terminalColors(root, 'agent'));
		await atomicJson(join(root, 'settings.json'), {
			schemaVersion: 1,
			settings: { appearance: 'dark' },
		});
		expect((await terminalColors(root, 'console')).background).toBe('#141414');
		expect((await terminalColors(root, 'agent')).background).toBe('#141414');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('writes a color the way xterm replies to OSC 10/11', () => {
	expect(oscColor('#1e1e1e')).toBe('rgb:1e1e/1e1e/1e1e');
});

it('reads Dark from the system: defaults on macOS, the GNOME color-scheme on Linux (spec/architecture-and-platform#linux-package)', async () => {
	const calls: string[] = [];
	const answer = (value: string | null) => async (file: string, args: string[]) => {
		calls.push([file, ...args].join(' '));
		return value;
	};
	expect(await systemDark('darwin', answer('Dark\n'))).toBe(true);
	expect(await systemDark('darwin', answer(null))).toBe(false);
	expect(await systemDark('linux', answer("'prefer-dark'\n"))).toBe(true);
	expect(await systemDark('linux', answer("'default'\n"))).toBe(false);
	expect(await systemDark('linux', answer(null))).toBe(false);
	expect(await systemDark('win32', answer('Dark'))).toBe(false);
	expect(calls).toContain('gsettings get org.gnome.desktop.interface color-scheme');
	expect(calls).toContain('defaults read -g AppleInterfaceStyle');
});
