import { describe, expect, it } from 'vitest';
import { cdpColor } from './cdp-color';

describe('cdpColor', () => {
	it('reads the forms a computed style and a token give', () => {
		expect(cdpColor('rgb(0, 100, 225)')).toEqual({ r: 0, g: 100, b: 225, a: 1 });
		expect(cdpColor('rgba(10, 132, 255, 0.5)')).toEqual({ r: 10, g: 132, b: 255, a: 0.5 });
		expect(cdpColor('rgb(10 132 255 / 50%)')).toEqual({ r: 10, g: 132, b: 255, a: 0.5 });
		expect(cdpColor('color(srgb 0 0.392157 0.882353)')).toEqual({ r: 0, g: 100, b: 225, a: 1 });
		expect(cdpColor('color(srgb 1 0 0 / 0.25)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
		expect(cdpColor('#0064e1')).toEqual({ r: 0, g: 100, b: 225, a: 1 });
		expect(cdpColor(' #0AF ')).toEqual({ r: 0, g: 170, b: 255, a: 1 });
	});
	it('gives null for what it cannot read', () => {
		expect(cdpColor('')).toBeNull();
		expect(cdpColor('var(--accent)')).toBeNull();
		expect(cdpColor('color-mix(in srgb, red 10%, transparent)')).toBeNull();
	});
});
