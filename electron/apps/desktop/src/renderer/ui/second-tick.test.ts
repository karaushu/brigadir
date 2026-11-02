import { afterEach, expect, it, vi } from 'vitest';
import { catchUpClock, subscribeSecondTick } from './second-tick';
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
it('serves every live counter from one timer that stops with the last listener', () => {
	vi.useFakeTimers();
	const start = vi.spyOn(globalThis, 'setInterval'),
		stop = vi.spyOn(globalThis, 'clearInterval');
	const a = vi.fn(),
		b = vi.fn();
	const offA = subscribeSecondTick(a),
		offB = subscribeSecondTick(b);
	expect(start).toHaveBeenCalledTimes(1);
	a.mockClear();
	b.mockClear();
	vi.advanceTimersByTime(3000);
	expect(a).toHaveBeenCalledTimes(3);
	expect(b).toHaveBeenCalledTimes(3);
	offA();
	expect(stop).not.toHaveBeenCalled();
	offB();
	expect(stop).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(3000);
	expect(a).toHaveBeenCalledTimes(3);
});
it('catches a stopped clock up once a second, so counters rendered in a row share one snapshot', () => {
	const first = catchUpClock(Date.now() + 5000);
	expect(catchUpClock(first + 1)).toBe(first);
	expect(catchUpClock(first + 999)).toBe(first);
	expect(catchUpClock(first + 1000)).toBe(first + 1000);
});
