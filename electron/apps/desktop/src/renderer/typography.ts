import {
	bundledFonts,
	defaultTypography,
	fontFamilyChoice,
	type SurfaceFont,
	type TextSurface,
} from '@brigadir/core';
import { useWorkspace } from './store';
export const systemSans = '-apple-system, "SF Pro Text", system-ui, sans-serif';
export const systemMono = 'ui-monospace, "SF Mono", Menlo, monospace';
/** spec/appearance#evolution-redesign: the app's own fonts (tokens.css `@font-face`), then the OS's for a glyph they lack. */
export const geistSans = `${JSON.stringify(bundledFonts.sans)}, ${systemSans}`;
export const geistMono = `${JSON.stringify(bundledFonts.mono)}, ${systemMono}`;
/** A code surface's stack: Geist Mono by default, the OS mono when chosen; a missing installed family falls to the OS mono. */
export function fontFamily(font: SurfaceFont) {
	const choice = fontFamilyChoice(font.family, 'mono');
	return choice.kind === 'bundled'
		? geistMono
		: choice.kind === 'system'
			? systemMono
			: `${JSON.stringify(choice.name)}, ${systemMono}`;
}
/** The interface stack: Geist by default, the OS font when chosen; a missing installed family falls to the OS font. */
export function interfaceFamily(family: string | null) {
	const choice = fontFamilyChoice(family, 'sans');
	return choice.kind === 'bundled'
		? geistSans
		: choice.kind === 'system'
			? systemSans
			: `${JSON.stringify(choice.name)}, ${systemSans}`;
}
/**
 * spec/appearance#evolution-redesign: the terminal and the diff measure their cell on a canvas once, so Geist and Geist Mono must be in before
 * the first render. They are local files and come in within milliseconds; a slow disk shows the OS font, then Geist.
 */
export function loadBundledFonts(timeout = 1500): Promise<void> {
	if (!('fonts' in document)) return Promise.resolve();
	const fonts = Promise.all([
		document.fonts.load(`13px ${JSON.stringify(bundledFonts.sans)}`),
		document.fonts.load(`13px ${JSON.stringify(bundledFonts.mono)}`),
	]).then(
		() => {},
		() => {}
	);
	return Promise.race([fonts, new Promise<void>((resolve) => setTimeout(resolve, timeout))]);
}
export function useSurfaceFont(surface: TextSurface) {
	return useWorkspace(
		(state) => state.appearance.typography?.[surface] ?? defaultTypography[surface]
	);
}
export function terminalTypography() {
	const style = getComputedStyle(document.documentElement);
	return {
		fontFamily: style.getPropertyValue('--terminal-family').trim() || geistMono,
		fontSize: Number.parseFloat(style.getPropertyValue('--terminal-size')) || 13,
		fontWeight: Number.parseInt(style.getPropertyValue('--terminal-weight')) || 400,
		fontWeightBold: 700,
		lineHeight: 1,
	};
}
