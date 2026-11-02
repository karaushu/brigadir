import { execFile } from 'node:child_process';
import { isRecord } from '@brigadir/core';
import { readDocument, safePath } from '@brigadir/persistence';
export type TerminalColors = { background: string; foreground: string };
type Role = 'console' | 'agent';
/**
 * The colors the window's terminal shows, as `tokens.css` defines them: background `--term`, foreground `--fg` blended
 * over it — the console and a CLI task alike (spec/task-window-workspace#tool-tab-look). The host answers OSC 10/11 with them,
 * so a CLI that picks its theme from the background (Claude Code's `auto`) matches the window, not a guessed dark one.
 */
const palette: Record<'light' | 'dark', TerminalColors> = {
	light: { background: '#f6f6f7', foreground: '#252525' },
	dark: { background: '#141414', foreground: '#e0e0e0' },
};
type Read = (file: string, args: string[]) => Promise<string | null>;
const read: Read = (file, args) =>
	new Promise((resolve) =>
		execFile(file, args, { timeout: 1000 }, (error, stdout) => resolve(error ? null : stdout))
	);
/**
 * Whether the system shows Dark. macOS: the global key exists only in Dark mode, a missing key (exit 1) is Light. Linux
 * (spec/architecture-and-platform#linux-package): GNOME 42+ keeps it in `color-scheme`, and KDE Plasma writes the same key; anything else reads as Light.
 */
export async function systemDark(
	platform: NodeJS.Platform = process.platform,
	run: Read = read
): Promise<boolean> {
	if (platform === 'darwin')
		return (await run('defaults', ['read', '-g', 'AppleInterfaceStyle']))?.trim() === 'Dark';
	if (platform === 'linux')
		return (
			(await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']))?.trim() ===
			"'prefer-dark'"
		);
	return false;
}
/** The window's appearance from the app's `settings.json`, `system` resolved the way macOS shows it. */
export async function terminalColors(root: string, _role: Role): Promise<TerminalColors> {
	let appearance: unknown = 'system';
	try {
		const doc = await readDocument(await safePath(root, 'settings.json'));
		if (isRecord(doc.settings)) appearance = doc.settings.appearance;
	} catch {
		/* No settings: follow the system. */
	}
	const dark = appearance === 'dark' || (appearance !== 'light' && (await systemDark()));
	return palette[dark ? 'dark' : 'light'];
}
/** `#rrggbb` as an XParseColor reply, the form xterm sends back. */
export function oscColor(hex: string) {
	const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
	return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}
