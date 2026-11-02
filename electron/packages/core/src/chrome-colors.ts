/** spec/architecture-and-platform#window-frame: the strip colours the renderer reports for the OS window buttons, opaque `#rrggbb`. */
export type ChromeColors = { color: string; symbolColor: string };
export function isChromeColors(value: unknown): value is ChromeColors {
	if (!value || typeof value !== 'object') return false;
	const colors = value as Record<string, unknown>;
	return (
		Object.keys(colors).length === 2 &&
		[colors.color, colors.symbolColor].every(
			(item) => typeof item === 'string' && /^#[0-9a-f]{6}$/i.test(item)
		)
	);
}
/** spec/architecture-and-platform#window-frame: the OS buttons on Windows and Linux take opaque colours, so `--fg` (with alpha) is laid over `--tb`. */
function channels(color: string): [number, number, number, number] | null {
	const value = color.trim().toLowerCase();
	const hex = /^#([0-9a-f]{6})$/.exec(value);
	if (hex) {
		const n = parseInt(hex[1]!, 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
	}
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
		value
	);
	if (!rgb) return null;
	const alpha =
		rgb[4] === undefined
			? 1
			: rgb[4].endsWith('%')
				? Number(rgb[4].slice(0, -1)) / 100
				: Number(rgb[4]);
	return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
}
const hex = (parts: number[]) =>
	'#' +
	parts
		.map((part) =>
			Math.round(Math.min(255, Math.max(0, part)))
				.toString(16)
				.padStart(2, '0')
		)
		.join('');
/** `color` over an opaque `background` as `#rrggbb`; null when either is not a hex or rgb()/rgba() colour. */
export function opaqueColor(color: string, background: string): string | null {
	const top = channels(color),
		bottom = channels(background);
	if (!top || !bottom) return null;
	const alpha = top[3];
	return hex([0, 1, 2].map((index) => top[index]! * alpha + bottom[index]! * (1 - alpha)));
}
