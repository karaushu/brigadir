import { expect, test } from 'vitest';
import {
	changeCountsLabel,
	changeCountsTitle,
	formatChangeCount,
	formatChangeCountFull,
	formatTokenCount,
	isCompactChangeCount,
} from './change-count';
test('below 1000 the counter is the number as is', () => {
	for (const [value, text] of [
		[0, '0'],
		[1, '1'],
		[38, '38'],
		[245, '245'],
		[999, '999'],
	] as const)
		expect(formatChangeCount(value)).toBe(text);
	expect(isCompactChangeCount(999)).toBe(false);
});
test('from 1000 one truncated decimal, a dot, no trailing .0, suffix k (spec/diff-and-review#change-counters)', () => {
	for (const [value, text] of [
		[1000, '1k'],
		[1001, '1k'],
		[1099, '1k'],
		[1100, '1.1k'],
		[1540, '1.5k'],
		[1599, '1.5k'],
		[2480, '2.4k'],
		[3150, '3.1k'],
		[5036, '5k'],
		[9999, '9.9k'],
		[10000, '10k'],
		[12345, '12.3k'],
		[99999, '99.9k'],
		[100000, '100k'],
		[999999, '999.9k'],
	] as const)
		expect(formatChangeCount(value)).toBe(text);
	expect(isCompactChangeCount(1000)).toBe(true);
});
test('from a million the same rule with M', () => {
	for (const [value, text] of [
		[1_000_000, '1M'],
		[1_099_999, '1M'],
		[1_250_000, '1.2M'],
		[12_345_678, '12.3M'],
		[999_999_999, '999.9M'],
		[1_000_000_000, '1000M'],
	] as const)
		expect(formatChangeCount(value)).toBe(text);
});
test('the compact form is locale-free and never rounds up', () => {
	expect(formatChangeCount(1999)).toBe('1.9k');
	expect(formatChangeCount(999_950)).toBe('999.9k');
	expect(formatChangeCount(-5)).toBe('0');
	expect(formatChangeCount(Number.NaN)).toBe('0');
	expect(formatChangeCount(1540.9)).toBe('1.5k');
});
test('the exact value keeps the locale grouping for the tooltip and the accessible name', () => {
	expect(formatChangeCountFull('uk', 3150)).toBe('3 150');
	expect(formatChangeCountFull('en', 3150)).toBe('3,150');
	expect(changeCountsLabel('uk', 3150, 245)).toBe('+3 150 −245');
	expect(changeCountsLabel('en', 5036, 2480)).toBe('+5,036 −2,480');
	expect(changeCountsTitle('en', 999, 12)).toBeUndefined();
	expect(changeCountsTitle('en', 12, 1000)).toBe('+12 −1,000');
});
test('token counters are short with a lowercase m (spec/appearance#evolution-redesignб)', () => {
	for (const [value, text] of [
		[1, '1'],
		[10, '10'],
		[100, '100'],
		[1000, '1k'],
		[1540, '1.5k'],
		[10000, '10k'],
		[156000, '156k'],
		[200000, '200k'],
		[1000000, '1m'],
		[1250000, '1.2m'],
		[10000000, '10m'],
	] as const)
		expect(formatTokenCount(value)).toBe(text);
});
