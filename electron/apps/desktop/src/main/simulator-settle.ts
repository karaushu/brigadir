import {
	describeWaitTarget,
	findWaitTarget,
	formatElement,
	formatUi,
	simulatorWaitDefaultMs,
	type SimulatorUi,
	type SimulatorWaitRequest,
} from '@brigadir/core';
/**
 * spec/browser-and-simulator#sim-act-settle: when the screen of a device has stopped changing, told from the frames of its helper, which reach
 * main whether or not a tab watches.
 */
/** Still for this long = settled. A tap's highlight, a push or a sheet animate for 250–350 ms on iOS and Android. */
export const settleQuietMs = 400;
/** The longest `simulator_act` waits: an endless animation (a spinner, a video) must not hold the agent. */
export const settleCapMs = 5000;
/**
 * Android: scrcpy-server v4.1 (`native/scrcpy-server-v4.1`) sets MediaCodec's `repeat-previous-frame-after` to 100 ms, so a still screen
 * still sends chunks; `native/android-helper.check.mjs` measured those repeats under 200 bytes (`data.length > 200` marks a real change
 * there). iOS: `sim-helper` encodes only when SimulatorKit's frame callback brings a new surface seed, so every frame is a change.
 */
export const androidQuietBytes = 200;
export type Platform = 'ios' | 'android';
export type Clock = {
	now(): number;
	sleep(ms: number): Promise<void>;
};
export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
};
export function isChange(platform: Platform, frame: { data: Uint8Array }) {
	return platform === 'ios' || frame.data.length > androidQuietBytes;
}
export type Settled = {
	/** False when the cap was reached with the screen still changing. */
	settled: boolean;
	/** How long the wait took, from the end of the action. */
	waited: number;
	/** How long the screen kept changing after the action. */
	moving: number;
};
/**
 * Counts the changing frames from the moment it is made, so frames drawn while the action itself runs (a long press, a swipe) count;
 * `settle` then waits from the end of the action.
 */
export class ScreenWatch {
	private last = -Infinity;
	/** Changing frames so far. */
	changes = 0;
	private wakes = new Set<() => void>();
	constructor(
		private platform: Platform,
		private clock: Clock = realClock
	) {}
	frame(frame: { data: Uint8Array }) {
		if (!isChange(this.platform, frame)) return;
		this.last = this.clock.now();
		this.changes++;
		for (const wake of [...this.wakes]) wake();
	}
	async settle(quiet = settleQuietMs, cap = settleCapMs): Promise<Settled> {
		const start = this.clock.now();
		for (;;) {
			const now = this.clock.now(),
				since = Math.max(start, this.last),
				left = since + quiet - now;
			if (left <= 0)
				return { settled: true, waited: now - start, moving: Math.max(0, this.last - start) };
			if (now - start >= cap)
				return { settled: false, waited: now - start, moving: Math.max(0, this.last - start) };
			await this.clock.sleep(Math.min(left, start + cap - now));
		}
	}
	/** Resolves at once when the screen changed after `seen` (a count of `changes`), else on the next change or after `ms`. */
	changed(ms: number, seen = this.changes) {
		return new Promise<void>((resolve) => {
			if (this.changes > seen) return resolve();
			const done = () => {
				this.wakes.delete(done);
				resolve();
			};
			this.wakes.add(done);
			void this.clock.sleep(ms).then(done);
		});
	}
}
export function settleLine(result: Settled) {
	return result.settled
		? `Screen settled in ${seconds(result.waited)}.`
		: `The screen was still changing after ${seconds(result.waited)} (an animation, a video or a spinner).`;
}
/** `0.6 s`, `5 s`. */
const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
/** spec/browser-and-simulator#sim-wait: reads between screen changes, at least once a second, never closer than this. */
export const waitPollMs = 1000;
export const waitGapMs = 250;
/**
 * spec/browser-and-simulator#sim-wait: reads the tree until the element appears (or, with `gone`, disappears) or the time is up. A read that
 * fails does not end the wait; a read still running at the deadline is not waited for.
 */
export async function waitForElement(
	query: SimulatorWaitRequest,
	read: () => Promise<SimulatorUi>,
	watch: Pick<ScreenWatch, 'changed' | 'changes'>,
	clock: Clock = realClock
): Promise<string> {
	const timeout = query.timeoutMs ?? simulatorWaitDefaultMs,
		start = clock.now(),
		deadline = start + timeout,
		target = describeWaitTarget(query);
	let last: SimulatorUi | null = null,
		failure: string | null = null;
	for (;;) {
		const before = clock.now(),
			seen = watch.changes;
		const outcome = await Promise.race([
			read().then(
				(ui) => ({ ui }),
				(error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
			),
			clock.sleep(Math.max(0, deadline - before)).then(() => null),
		]);
		if (outcome && 'ui' in outcome) {
			last = outcome.ui;
			const found = findWaitTarget(outcome.ui, query);
			const took = seconds(clock.now() - start);
			if (found && !query.gone) return `Found ${formatElement(found)} after ${took}.`;
			if (!found && query.gone) return `${target} is gone after ${took}.`;
		} else if (outcome) failure = outcome.error;
		const now = clock.now();
		if (now >= deadline) break;
		// Never closer than the gap, at least once a second, sooner when the screen changes.
		const gap = before + waitGapMs - now;
		if (gap > 0) await clock.sleep(Math.min(gap, deadline - now));
		if (clock.now() >= deadline) break;
		await watch.changed(Math.min(waitPollMs, deadline - clock.now()), seen);
		if (clock.now() >= deadline) break;
	}
	const head = `Timed out after ${seconds(timeout)}: ${
		query.gone ? `${target} is still on the screen.` : `no element with ${target} appeared.`
	}`;
	if (last) return `${head}\n${formatUi(last, 0, 60, 'call simulator_ui')}`;
	return `${head}\nThe accessibility tree could not be read${failure ? `: ${failure}` : '.'}`;
}
