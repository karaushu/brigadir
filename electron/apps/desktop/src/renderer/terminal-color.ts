/**
 * spec/terminal-and-cli-agents#console-selection: xterm reads a theme colour through a canvas and drops one that is not opaque there, so `--accent-soft`
 * (`color-mix(…, transparent)`) fell back to white at 30 % and the selection vanished on the light console.
 * The page resolves the colour itself and hands xterm `rgba()`, which xterm parses without the canvas.
 */
export function terminalColor(value: string) {
	const color = value.trim();
	if (!color || !document.body) return color;
	const probe = document.createElement('span');
	probe.style.display = 'none';
	probe.style.color = color;
	document.body.append(probe);
	const computed = getComputedStyle(probe).color;
	probe.remove();
	return parseComputedColor(computed) ?? color;
}

/** `rgb(…)` / `rgba(…)`, or `color(srgb r g b / a)` that Chromium gives for `color-mix` in srgb. */
export function parseComputedColor(computed: string) {
	const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
		computed
	);
	if (rgb) return rgba(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha(rgb[4]));
	const srgb =
		/^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(
			computed
		);
	if (srgb)
		return rgba(
			Number(srgb[1]) * 255,
			Number(srgb[2]) * 255,
			Number(srgb[3]) * 255,
			alpha(srgb[4])
		);
	return null;
}

function alpha(value: string | undefined) {
	if (value === undefined) return 1;
	return value.endsWith('%') ? Number.parseFloat(value) / 100 : Number(value);
}
function rgba(r: number, g: number, b: number, a: number) {
	const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
	return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.max(0, Math.min(1, Math.round(a * 1000) / 1000))})`;
}
