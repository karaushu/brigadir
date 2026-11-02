import { describe, expect, it } from 'vitest';
import { ScreenPacer, type PacerTimers } from './browser-stream';

function clock() {
	let now = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	let next = 1;
	const api: PacerTimers & { advance(ms: number): void } = {
		now: () => now,
		set: (run, ms) => {
			const id = next++;
			timers.set(id, { at: now + ms, run });
			return id;
		},
		clear: (id) => {
			timers.delete(id as number);
		},
		advance(ms) {
			const until = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= until)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].run();
			}
			now = until;
		},
	};
	return api;
}
describe('screencast pace (spec/remote-access-and-mobile#browser-from-device)', () => {
	it('sends the next frame only after the device drew the last one and 50 ms passed', () => {
		const timers = clock(),
			released: number[] = [],
			sent: number[] = [];
		const pacer = new ScreenPacer((session) => released.push(session), timers);
		const send = (session: number) => (frame: number) => {
			sent.push(session);
			return frame > 0;
		};
		pacer.frameIn(1, 100, send(1));
		expect(sent).toEqual([1]);
		// Chromium's second frame waits: the device has not drawn the first.
		pacer.frameIn(2, 100, send(2));
		timers.advance(100);
		expect(sent).toEqual([1]);
		expect(released).toEqual([]);
		// Drawn: Chromium may paint again, and frame 2 goes at once (50 ms have passed).
		pacer.ack(1);
		expect(released).toEqual([1]);
		expect(sent).toEqual([1, 2]);
		// The device draws fast: the third frame still waits for the 50 ms after the second.
		pacer.frameIn(3, 100, send(3));
		timers.advance(10);
		pacer.ack(2);
		expect(sent).toEqual([1, 2]);
		timers.advance(39);
		expect(sent).toEqual([1, 2]);
		timers.advance(1);
		expect(sent).toEqual([1, 2, 3]);
		expect(released).toEqual([1, 2]);
	});
	it('replaces a waiting frame, lets a frame the connection refused go, and does not wait forever', () => {
		const timers = clock(),
			released: number[] = [],
			sent: number[] = [];
		let room = true;
		const pacer = new ScreenPacer((session) => released.push(session), timers);
		const send = (session: number) => () => {
			if (room) sent.push(session);
			return room;
		};
		pacer.frameIn(1, 10, send(1));
		pacer.frameIn(2, 10, send(2));
		pacer.ack(1);
		timers.advance(50);
		pacer.frameIn(3, 10, send(3));
		pacer.frameIn(4, 10, send(4));
		// 3 never went: 4 replaced it.
		expect(released).toEqual([1, 3]);
		timers.advance(1000);
		// The device never acked 2: after a second it goes anyway, and 4 follows.
		expect(released).toEqual([1, 3, 2]);
		expect(sent).toEqual([1, 2, 4]);
		room = false;
		pacer.ack(4);
		pacer.frameIn(5, 10, send(5));
		timers.advance(50);
		expect(released).toEqual([1, 3, 2, 4, 5]);
		room = true;
		pacer.frameIn(6, 10, send(6));
		timers.advance(100);
		expect(sent).toEqual([1, 2, 4]);
		timers.advance(100);
		expect(sent).toEqual([1, 2, 4, 6]);
		expect(pacer.rates()).toMatchObject({ skipped: 1, dropped: 1 });
		pacer.stop();
		pacer.frameIn(7, 10, send(7));
		timers.advance(5000);
		expect(sent).toEqual([1, 2, 4, 6]);
	});
});
