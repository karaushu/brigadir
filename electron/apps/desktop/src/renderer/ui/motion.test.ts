import { describe, expect, it } from 'vitest';
import { cssTime } from './motion';

describe('cssTime', () => {
	it('reads authored and minified token forms alike', () => {
		expect(cssTime('180ms')).toBe(180);
		expect(cssTime('.18s')).toBe(180);
		expect(cssTime(' 0.24s')).toBe(240);
		expect(cssTime('1.5e2ms')).toBe(150);
	});
	it('treats zero, missing and malformed values as no motion', () => {
		for (const value of ['0ms', '0s', '', 'none', '180', '-.1s']) expect(cssTime(value)).toBe(0);
	});
});
