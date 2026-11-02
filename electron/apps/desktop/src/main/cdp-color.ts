/** A colour as the Chrome DevTools Protocol takes it (`DOM.RGBA`): channels 0–255, alpha 0–1. */
export type CdpColor = { r: number; g: number; b: number; a: number };

const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const alpha = (value: number) => Math.max(0, Math.min(1, value));

/** A CSS colour the renderer already resolved (`getComputedStyle(...).color`: `rgb()`, `rgba()`, `color(srgb …)` for a
 *  `color-mix`) or a hex token, as CDP RGBA; `null` for anything else. Rule 4: main draws with the app's tokens, it reads
 *  them from the window rather than keeping its own colours. */
export function cdpColor(value: string): CdpColor | null {
	const text = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
	if (hex) {
		const digits = hex[1]!,
			full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits,
			parts = full.match(/../g)!.map((part) => parseInt(part, 16));
		return {
			r: parts[0]!,
			g: parts[1]!,
			b: parts[2]!,
			a: parts[3] === undefined ? 1 : parts[3] / 255,
		};
	}
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
		text
	);
	if (rgb) {
		const a = rgb[4];
		return {
			r: channel(Number(rgb[1])),
			g: channel(Number(rgb[2])),
			b: channel(Number(rgb[3])),
			a: a === undefined ? 1 : alpha(a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a)),
		};
	}
	const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(
		text
	);
	if (srgb)
		return {
			r: channel(Number(srgb[1]) * 255),
			g: channel(Number(srgb[2]) * 255),
			b: channel(Number(srgb[3]) * 255),
			a: srgb[4] === undefined ? 1 : alpha(Number(srgb[4])),
		};
	return null;
}
