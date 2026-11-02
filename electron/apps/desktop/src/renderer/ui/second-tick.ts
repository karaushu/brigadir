import { useSyncExternalStore } from 'react';
/** spec/chat-turns-plans-and-questions#turn-status-row, spec/sidebar#layout: every live seconds counter ticks from one shared timer, not one interval per row.
 *  It runs only while someone listens and the window is visible; a hidden window catches up on return. */
const listeners = new Set<() => void>();
let now = Date.now(),
	timer: ReturnType<typeof setInterval> | null = null;
function tick() {
	now = Date.now();
	for (const listener of listeners) listener();
}
function sync() {
	const run =
		listeners.size > 0 &&
		(typeof document === 'undefined' || document.visibilityState !== 'hidden');
	if (run && timer === null) {
		tick();
		timer = setInterval(tick, 1000);
	}
	if (!run && timer !== null) {
		clearInterval(timer);
		timer = null;
	}
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync);
/** Exported for the one-timer test; components use `useSecondTick`. */
export function subscribeSecondTick(listener: () => void) {
	listeners.add(listener);
	sync();
	return () => {
		listeners.delete(listener);
		sync();
	};
}
const idle = () => 0,
	unsubscribed = () => () => {},
	current = () => now;
/** With no timer running (hidden window) the cached time is stale: a new counter catches it up on render.
 *  At most once a second, as the timer would: a fresh value on every render changed the snapshot of the
 *  counters rendered before it, each re-render moved it again — «Maximum update depth exceeded».
 *  Exported for the test. */
export function catchUpClock(at = Date.now()) {
	if (timer === null && at - now >= 1000) now = at;
	return now;
}
/** The current time, refreshed every second while `active`; 0 when inactive (the caller has a fixed end). */
export function useSecondTick(active: boolean): number {
	if (active) catchUpClock();
	return useSyncExternalStore(active ? subscribeSecondTick : unsubscribed, active ? current : idle);
}
