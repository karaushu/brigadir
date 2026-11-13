import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SimulatorUi } from '@brigadir/core';
import {
	androidQuietBytes,
	ScreenWatch,
	settleCapMs,
	settleLine,
	settleQuietMs,
	waitForElement,
} from './simulator-settle';
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
const frame = (bytes: number) => ({ data: new Uint8Array(bytes) });
/** A fake helper: `bytes` every `every` ms until `until` ms after the start. */
function stream(watch: ScreenWatch, bytes: number, every: number, until: number) {
	const timer = setInterval(() => watch.frame(frame(bytes)), every);
	setTimeout(() => clearInterval(timer), until);
}
it('iOS: any frame is a change; the screen settles 400 ms after the last one (spec/browser-and-simulator#sim-act-settle)', async () => {
	const watch = new ScreenWatch('ios');
	stream(watch, 50, 16, 300);
	const settled = watch.settle();
	await vi.advanceTimersByTimeAsync(2000);
	const result = await settled;
	expect(result.settled).toBe(true);
	expect(result.moving).toBeGreaterThanOrEqual(288);
	expect(result.moving).toBeLessThan(300);
	expect(result.waited).toBe(result.moving + settleQuietMs);
	expect(settleLine(result)).toBe('Screen settled in 0.7 s.');
});
it('iOS: a still screen after the action settles after the quiet period alone', async () => {
	const watch = new ScreenWatch('ios');
	// Frames before the action ended do not delay the settle.
	watch.frame(frame(10_000));
	await vi.advanceTimersByTimeAsync(100);
	const settled = watch.settle();
	await vi.advanceTimersByTimeAsync(1000);
	expect(await settled).toEqual({ settled: true, waited: settleQuietMs, moving: 0 });
});
it('stops at the 5 s cap and says the screen was still changing', async () => {
	const watch = new ScreenWatch('ios');
	stream(watch, 50, 100, 60_000);
	const settled = watch.settle();
	await vi.advanceTimersByTimeAsync(10_000);
	const result = await settled;
	expect(result).toMatchObject({ settled: false, waited: settleCapMs });
	expect(settleLine(result)).toBe(
		'The screen was still changing after 5 s (an animation, a video or a spinner).'
	);
});
it('Android: quiet repeats of scrcpy (under 200 bytes every 100 ms) do not count; a bigger chunk does', async () => {
	const still = new ScreenWatch('android');
	stream(still, androidQuietBytes, 100, 60_000);
	const settled = still.settle();
	await vi.advanceTimersByTimeAsync(1000);
	expect(await settled).toEqual({ settled: true, waited: settleQuietMs, moving: 0 });
	const moving = new ScreenWatch('android');
	stream(moving, androidQuietBytes, 100, 60_000);
	stream(moving, 4000, 16, 500);
	const animated = moving.settle();
	await vi.advanceTimersByTimeAsync(2000);
	const result = await animated;
	expect(result.settled).toBe(true);
	expect(result.moving).toBeGreaterThan(480);
	expect(result.waited).toBe(result.moving + settleQuietMs);
});
const ui = (...labels: string[]): SimulatorUi => ({
	width: 402,
	height: 874,
	elements: labels.map((label, index) => ({
		role: 'Text',
		label,
		id: label.toLowerCase().replace(/\W+/g, '-'),
		frame: [0, index * 20, 200, 20],
	})),
});
it('simulator_wait reads again when the screen changes and answers with what it found (spec/browser-and-simulator#sim-wait)', async () => {
	const watch = new ScreenWatch('ios');
	let screen = ui('Order #4821', 'Saving…');
	const read = vi.fn(async () => screen);
	setTimeout(() => {
		screen = ui('Order #4821', 'Saved');
		watch.frame(frame(100));
	}, 1300);
	const answer = waitForElement({ text: 'saved' }, read, watch);
	await vi.advanceTimersByTimeAsync(5000);
	expect(await answer).toBe('Found Text "Saved" #saved 0,20 200×20 after 1.3 s.');
	// At once, a second after the first read began (no frames), then on the frame.
	expect(read).toHaveBeenCalledTimes(3);
	const gone = waitForElement({ id: 'saved', gone: true }, read, watch);
	setTimeout(() => {
		screen = ui('Order #4821');
		watch.frame(frame(100));
	}, 600);
	await vi.advanceTimersByTimeAsync(5000);
	expect(await gone).toBe('#saved is gone after 0.6 s.');
});
it('simulator_wait times out with the last tree, and a failed read does not end it', async () => {
	const watch = new ScreenWatch('android');
	let calls = 0;
	const read = async () => {
		if (++calls === 1) throw new Error('The device sent no accessibility tree.');
		return ui('Order #4821');
	};
	const answer = waitForElement({ label: 'Saved', timeoutMs: 3000 }, read, watch);
	await vi.advanceTimersByTimeAsync(5000);
	expect(await answer).toBe(
		'Timed out after 3 s: no element with label "Saved" appeared.\nScreen 402×874 pt · 1 elements\nText "Order #4821" #order-4821 0,0 200×20'
	);
	expect(calls).toBe(3);
});
it('simulator_wait reads at least once a second from the start of the read before: a failed first read is retried in time', async () => {
	const watch = new ScreenWatch('ios');
	const starts: number[] = [];
	const start = Date.now();
	const read = async () => {
		starts.push(Date.now() - start);
		if (starts.length === 1) throw new Error('The device did not describe its screen.');
		return ui('Saved');
	};
	const answer = waitForElement({ text: 'Saved', timeoutMs: 1100 }, read, watch);
	await vi.advanceTimersByTimeAsync(2000);
	expect(await answer).toBe('Found Text "Saved" #saved 0,0 200×20 after 1 s.');
	expect(starts).toEqual([0, 1000]);
});
it('simulator_wait does not wait past its deadline for a slow read, and says why no tree was read', async () => {
	const watch = new ScreenWatch('android');
	const read = () =>
		new Promise<SimulatorUi>((_, reject) =>
			setTimeout(() => reject(new Error('The device did not answer.')), 40_000)
		);
	const answer = waitForElement({ id: 'spinner', gone: true, timeoutMs: 2000 }, read, watch);
	let result: string | null = null;
	void answer.then((text) => (result = text));
	await vi.advanceTimersByTimeAsync(2000);
	expect(result).toBe(
		'Timed out after 2 s: #spinner is still on the screen.\nThe accessibility tree could not be read.'
	);
	const failing = waitForElement(
		{ text: 'Saved', timeoutMs: 600 },
		async () => {
			throw new Error('The device sent no accessibility tree.');
		},
		watch
	);
	await vi.advanceTimersByTimeAsync(1000);
	expect(await failing).toBe(
		'Timed out after 0.6 s: no element with text "Saved" appeared.\nThe accessibility tree could not be read: The device sent no accessibility tree.'
	);
});
