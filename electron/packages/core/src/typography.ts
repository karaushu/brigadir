import { isRecord } from './workspace';
export const textSurfaces = ['terminal', 'diff', 'editor'] as const;
export type TextSurface = (typeof textSurfaces)[number];
export type SurfaceFont = {
	family: string | null;
	size: number;
	lineHeight: number;
	ligatures: boolean;
};
export type Typography = Record<TextSurface, SurfaceFont>;
/**
 * spec/appearance#evolution-redesign: `family` null is the app's own font, Geist for the interface and Geist Mono for code, the same on every
 * OS; the OS font is a choice of its own, stored as these CSS generic names (no installed family is called that).
 * A family the person picked before stays theirs.
 */
export const bundledFonts = { sans: 'Geist', mono: 'Geist Mono' } as const;
export const systemFontFamily = 'system-ui';
export const systemMonoFamily = 'ui-monospace';
/** spec/appearance#evolution-redesign: Geist Mono's ligatures (Stylistic Set 11) are on in the editor and the diff; the terminal draws cell by cell. */
export const defaultTypography: Typography = {
	terminal: { family: null, size: 13, lineHeight: 1, ligatures: false },
	diff: { family: null, size: 11, lineHeight: 1.6, ligatures: true },
	editor: { family: null, size: 12, lineHeight: 1.6, ligatures: true },
};
/** The name a font picker shows for a stored family: the bundled font for null, the OS font for its generic name. */
export function fontFamilyChoice(
	family: string | null,
	kind: 'sans' | 'mono'
): { kind: 'bundled' | 'system' | 'installed'; name: string } {
	if (!family) return { kind: 'bundled', name: bundledFonts[kind] };
	if (family === (kind === 'sans' ? systemFontFamily : systemMonoFamily))
		return { kind: 'system', name: family };
	return { kind: 'installed', name: family };
}
/** spec/appearance#interface-font: the interface font. `family` null is Geist (spec/appearance#evolution-redesign); `size` in px, 13 is the design size and every UI font scales by size / 13. */
export type InterfaceFont = { family: string | null; size: number };
export const interfaceFontSize = { min: 8, max: 24, default: 13 } as const;
/** spec/appearance#interface-font: terminal, diff and editor share the interface range. */
export const codeFontSize = { min: 8, max: 24 } as const;
export const defaultInterfaceFont: InterfaceFont = {
	family: null,
	size: interfaceFontSize.default,
};
/**
 * spec/appearance#chat-text-size: the chat's own text size — `size` in px is the reply's body text (13.5 at the design size, `--text-chat`),
 * 8–24 by 0.5. Null follows the interface: 13.5 × interface size / 13. Every chat text scales by size / 13.5.
 */
export type ChatFont = { size: number | null };
export const chatFontSize = { min: 8, max: 24, step: 0.5, design: 13.5 } as const;
export const defaultChatFont: ChatFont = { size: null };
export function isChatFont(value: unknown): value is ChatFont {
	return (
		isRecord(value) &&
		Object.keys(value).length === 1 &&
		(value.size === null ||
			(typeof value.size === 'number' &&
				Number.isInteger(value.size / chatFontSize.step) &&
				value.size >= chatFontSize.min &&
				value.size <= chatFontSize.max))
	);
}
/** spec/appearance#chat-text-size: the chat's body text in px — its own size or the interface's, unrounded so a follower moves with it. */
export function chatTextSize(chat: ChatFont | null | undefined, ui: InterfaceFont): number {
	return chat?.size ?? (chatFontSize.design * ui.size) / interfaceFontSize.default;
}
/** spec/appearance#chat-text-size: `--chat-scale` — every chat text is its design size × this, as the rest of the UI is × `--ui-scale`. */
export function chatScale(chat: ChatFont | null | undefined, ui: InterfaceFont): number {
	return chatTextSize(chat, ui) / chatFontSize.design;
}
/** spec/appearance#chat-text-size: the stepper's value — a follower shows the interface's size on the 0.5 grid, clamped to the range. */
export function shownChatSize(chat: ChatFont | null | undefined, ui: InterfaceFont): number {
	return chatFontStep(chatTextSize(chat, ui));
}
/** A typed or stepped size on the 0.5 grid within 8–24. */
export function chatFontStep(size: number): number {
	return Math.min(
		chatFontSize.max,
		Math.max(chatFontSize.min, Math.round(size / chatFontSize.step) * chatFontSize.step)
	);
}
function isFamilyName(value: unknown) {
	return (
		value === null ||
		(typeof value === 'string' &&
			value.length > 0 &&
			value.length <= 200 &&
			!/[\x00-\x1f]/.test(value))
	);
}
export function isInterfaceFont(value: unknown): value is InterfaceFont {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		isFamilyName(value.family) &&
		typeof value.size === 'number' &&
		Number.isInteger(value.size) &&
		value.size >= interfaceFontSize.min &&
		value.size <= interfaceFontSize.max
	);
}
/** `mono` marks fixed-pitch families: only they are offered to terminal, diff and editor; the interface may use any family. */
export type FontFamily = { family: string; mono: boolean; boxDrawing: boolean };
export type FontCatalog = { fonts: FontFamily[] };
export function isTypography(value: unknown): value is Typography {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		textSurfaces.every((surface) => {
			const font = value[surface];
			return (
				isRecord(font) &&
				Object.keys(font).length === 4 &&
				isFamilyName(font.family) &&
				typeof font.size === 'number' &&
				Number.isInteger(font.size) &&
				font.size >= codeFontSize.min &&
				font.size <= codeFontSize.max &&
				typeof font.lineHeight === 'number' &&
				Number.isFinite(font.lineHeight) &&
				font.lineHeight >= 1 &&
				font.lineHeight <= 2 &&
				typeof font.ligatures === 'boolean' &&
				(surface !== 'terminal' || (font.lineHeight === 1 && !font.ligatures))
			);
		})
	);
}
export function resizedTypography(
	value: Typography,
	surface: TextSurface,
	action: 'increase' | 'decrease' | 'reset'
): Typography {
	const font = value[surface],
		size =
			action === 'reset'
				? defaultTypography[surface].size
				: Math.max(
						codeFontSize.min,
						Math.min(codeFontSize.max, font.size + (action === 'increase' ? 1 : -1))
					);
	return { ...value, [surface]: { ...font, size } };
}
