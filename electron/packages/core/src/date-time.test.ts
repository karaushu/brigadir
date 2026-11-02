import { expect, test } from 'vitest';
import { formatDate, formatTime, formatDateTime } from './date-time';
test('European dates and 24-hour clocks include midnight and optional seconds', () => {
	expect(formatDate('2026-09-04T16:05:09Z', { timeZone: 'UTC' })).toBe('04.09.2026');
	expect(formatTime('2026-09-04T16:05:09Z', { timeZone: 'UTC' })).toBe('16:05');
	expect(formatDateTime('2026-09-04T00:05:09Z', { timeZone: 'UTC', seconds: true })).toBe(
		'04.09.2026 · 00:05:09'
	);
});
test('date and time use the same local day across timezone and daylight-saving boundaries', () => {
	expect(formatDateTime('2026-01-01T22:30:00Z', { timeZone: 'Europe/Bucharest' })).toBe(
		'02.01.2026 · 00:30'
	);
	expect(formatDateTime('2026-07-01T21:30:00Z', { timeZone: 'Europe/Bucharest' })).toBe(
		'02.07.2026 · 00:30'
	);
});
