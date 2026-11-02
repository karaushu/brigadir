import { expect, it } from 'vitest';
import { opaqueColor } from '@brigadir/core';
import {
	chromePlatform,
	initialChromeColors,
	isChromeColors,
	titleStripHeight,
	windowFrame,
} from './window-chrome';
/** WCAG relative luminance of an opaque `#rrggbb`. */
const luminance = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const value = parseInt(hex.slice(i, i + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
it('reads the platform override only in a development run (spec/architecture-and-platform#window-frame)', () => {
	expect(chromePlatform('darwin', undefined, false)).toBe('darwin');
	expect(chromePlatform('win32', undefined, true)).toBe('win32');
	expect(chromePlatform('freebsd', undefined, true)).toBe('linux');
	expect(chromePlatform('darwin', 'win32', false)).toBe('win32');
	expect(chromePlatform('darwin', 'linux', false)).toBe('linux');
	expect(chromePlatform('darwin', 'win32', true)).toBe('darwin');
	expect(chromePlatform('darwin', 'beos', false)).toBe('darwin');
});
it('keeps the traffic lights on macOS and puts the OS buttons into the 48 px strip elsewhere (spec/architecture-and-platform#window-frame)', () => {
	expect(windowFrame('darwin', 'darwin', true)).toEqual({
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 14, y: 16 },
	});
	expect(windowFrame('win32', 'win32', true)).toMatchObject({
		titleBarStyle: 'hidden',
		titleBarOverlay: { ...initialChromeColors.dark, height: titleStripHeight },
	});
	expect(windowFrame('linux', 'linux', false)).toMatchObject({
		titleBarStyle: 'hidden',
		titleBarOverlay: { ...initialChromeColors.light, height: titleStripHeight },
	});
	// Electron draws no overlay on macOS: the preview has no titleBarOverlay at all.
	expect(windowFrame('win32', 'darwin', true)).not.toHaveProperty('titleBarOverlay');
});
it('starts with opaque strip colours whose OS buttons stay readable in both themes (spec/architecture-and-platform#window-frame)', () => {
	// The values follow tokens.css by hand; the test holds the invariant, not the theme's exact colours.
	for (const theme of ['light', 'dark'] as const) {
		const colors = initialChromeColors[theme];
		expect(isChromeColors(colors), theme).toBe(true);
		const [a, b] = [luminance(colors.color), luminance(colors.symbolColor)];
		expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), theme).toBeGreaterThanOrEqual(4.5);
	}
	expect(luminance(initialChromeColors.dark.color)).toBeLessThan(
		luminance(initialChromeColors.light.color)
	);
	expect(opaqueColor('rgba(255,255,255,.87)', '#2c2c2e')).toBe('#e4e4e4');
	expect(opaqueColor('rgb(1, 2, 3)', '#ffffff')).toBe('#010203');
	expect(opaqueColor('var(--x)', '#fff')).toBeNull();
	expect(isChromeColors({ color: '#2c2c2e', symbolColor: '#e4e4e4' })).toBe(true);
	expect(isChromeColors({ color: 'red', symbolColor: '#e4e4e4' })).toBe(false);
	expect(isChromeColors({ color: '#2c2c2e', symbolColor: '#e4e4e4', x: 1 })).toBe(false);
});
