import { expect, it } from 'vitest';
import { parseComputedColor } from './terminal-color';

// spec/terminal-and-cli-agents#console-selection: xterm parses rgba() itself; every computed form becomes one it reads.
const xtermRgba =
	/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*(0|1|\d?\.(\d+))\s*)?\)$/;

it('turns color-mix in srgb into rgba with its alpha', () => {
	expect(parseComputedColor('color(srgb 0.0392157 0.517647 1 / 0.14)')).toBe(
		'rgba(10, 132, 255, 0.14)'
	);
	expect(parseComputedColor('color(srgb 0.96 0.74 0 / 18%)')).toBe('rgba(245, 189, 0, 0.18)');
});

it('keeps rgb and rgba', () => {
	expect(parseComputedColor('rgb(246, 246, 247)')).toBe('rgba(246, 246, 247, 1)');
	expect(parseComputedColor('rgba(0, 0, 0, 0.85)')).toBe('rgba(0, 0, 0, 0.85)');
});

it('gives xterm a colour it parses without a canvas', () => {
	for (const value of [
		'color(srgb 0.0392157 0.517647 1 / 0.14)',
		'rgb(20, 20, 20)',
		'rgba(255, 255, 255, 0.87)',
	])
		expect(parseComputedColor(value)).toMatch(xtermRgba);
});

it('leaves an unknown form to the caller', () => {
	expect(parseComputedColor('oklch(0.7 0.1 250)')).toBeNull();
});
