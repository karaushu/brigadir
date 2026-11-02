import type { BrowserWindowConstructorOptions } from 'electron';
import type { ShortcutPlatform } from '@brigadir/core';
/** spec/architecture-and-platform#window-frame: the frame the window wears. macOS keeps its traffic lights; Windows and Linux put the OS buttons into
 *  our top strip (titleBarOverlay, 48 px — the renderer's --strip-h) and open the app menu from ☰. */
export type ChromePlatform = ShortcutPlatform;
export const titleStripHeight = 48;
/** `BRIGADIR_CHROME_PLATFORM=win32|linux` previews the Windows/Linux layout on a Mac; a packaged app ignores it. */
export function chromePlatform(
	platform: NodeJS.Platform,
	override: string | undefined,
	packaged: boolean
): ChromePlatform {
	if (!packaged && (override === 'win32' || override === 'linux' || override === 'darwin'))
		return override;
	return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux';
}
/** The strip's colours before the renderer reports its own: `--strip-bg` (= `--win`) and `--fg` over it from tokens.css,
 *  copied by hand (spec/task-window#repo-line); window-chrome.test.ts holds only opacity and contrast. */
export const initialChromeColors = {
	dark: { color: '#1e1e1e', symbolColor: '#e2e2e2' },
	light: { color: '#ffffff', symbolColor: '#262626' },
} as const;
import { isChromeColors, type ChromeColors } from '@brigadir/core';
export { isChromeColors, type ChromeColors };
/** Frame options per platform. The overlay exists only where Electron draws it (Windows, Linux): on a Mac with the
 *  override the strip keeps an empty 138 px where the OS buttons would be. */
export function windowFrame(
	chrome: ChromePlatform,
	host: NodeJS.Platform,
	dark: boolean
): BrowserWindowConstructorOptions {
	if (chrome === 'darwin')
		return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } };
	const colors = initialChromeColors[dark ? 'dark' : 'light'];
	return {
		titleBarStyle: 'hidden',
		autoHideMenuBar: false,
		backgroundColor: colors.color,
		...(host === 'darwin' ? {} : { titleBarOverlay: { ...colors, height: titleStripHeight } }),
	};
}
