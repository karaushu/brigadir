import { describe, expect, it } from 'vitest';
import { listStep } from './list-keys';

describe('listStep', () => {
	it('moves by one row and stops at the ends', () => {
		expect(listStep('ArrowDown', 0, 3)).toBe(1);
		expect(listStep('ArrowUp', 2, 3)).toBe(1);
		expect(listStep('ArrowDown', 2, 3)).toBe(2);
		expect(listStep('ArrowUp', 0, 3)).toBe(0);
	});
	it('goes to the first and the last row on Home and End', () => {
		expect(listStep('Home', 2, 3)).toBe(0);
		expect(listStep('End', 0, 3)).toBe(2);
	});
	it('starts at the first row when no row is current', () => {
		expect(listStep('ArrowDown', -1, 3)).toBe(0);
		expect(listStep('ArrowUp', -1, 3)).toBe(0);
	});
	it('leaves other keys and empty lists alone', () => {
		expect(listStep(' ', 0, 3)).toBeNull();
		expect(listStep('Enter', 0, 3)).toBeNull();
		expect(listStep('ArrowRight', 0, 3)).toBeNull();
		expect(listStep('ArrowDown', 0, 0)).toBeNull();
	});
});
