import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserAgentClock } from './browser-clock';
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
it('spec/browser-and-simulator#background: a view freezes 60 s after the last agent call, and each call starts the 60 s again', () => {
	const expired: string[] = [];
	const clock = new BrowserAgentClock((id) => expired.push(id));
	expect(clock.ms).toBe(60_000);
	clock.touch('p/a');
	expect(clock.active('p/a')).toBe(true);
	vi.advanceTimersByTime(59_000);
	expect(expired).toEqual([]);
	clock.touch('p/a');
	vi.advanceTimersByTime(59_000);
	expect(expired).toEqual([]);
	expect(clock.active('p/a')).toBe(true);
	vi.advanceTimersByTime(1_000);
	expect(expired).toEqual(['p/a']);
	expect(clock.active('p/a')).toBe(false);
	// A closed view never expires later.
	clock.touch('p/b');
	clock.clear('p/b');
	vi.advanceTimersByTime(120_000);
	expect(expired).toEqual(['p/a']);
	clock.touch('p/c');
	clock.dispose();
	vi.advanceTimersByTime(120_000);
	expect(expired).toEqual(['p/a']);
});
