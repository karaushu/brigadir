/**
 * spec/remote-access-and-mobile#browser-from-device: the pace of a page streamed to a device. Chromium keeps at most two screencast frames unacknowledged
 * (`Page.screencastFrameAck`) and paints no further one until it gets an ack. This pacer holds both: one frame sent and
 * waiting for the device to draw it (its `ack`), and the newest one not sent yet. The next frame goes once the device drew
 * the one before and `interval` ms have passed since it went (≤ 20 frames a second); a newer frame replaces a waiting one.
 * A frame the connection had no room for is let go after a pause, so the backlog drains; a device that never answers does
 * not stop the stream (`patience`).
 */
export type PacerTimers = {
	now(): number;
	set(run: () => void, ms: number): unknown;
	clear(timer: unknown): void;
};
const realTimers: PacerTimers = {
	now: () => Date.now(),
	set: (run, ms) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return timer;
	},
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export const screenInterval = 50,
	screenPatience = 1000,
	screenDropPause = 200;
type Waiting = { session: number; bytes: number; send: (frame: number) => boolean };
export class ScreenPacer {
	/** The number of the last frame sent; the device acks by it. */
	frame = 0;
	/** Sent, not drawn yet. */
	private inflight: { session: number; frame: number } | null = null;
	/** The newest frame from Chromium, not sent yet. */
	private next: Waiting | null = null;
	private sentAt = -Infinity;
	/** Until then nothing is sent: the connection had no room a moment ago. */
	private pausedUntil = -Infinity;
	private timer: unknown = null;
	private patienceTimer: unknown = null;
	private stopped = false;
	/** What went in the last `rates()` window, for the debug log (spec/remote-access-and-mobile#browser-from-device). */
	private stats = { since: 0, frames: 0, bytes: 0, skipped: 0, dropped: 0 };
	constructor(
		/** Chromium may paint the next frame: `Page.screencastFrameAck` with this session. */
		private readonly release: (session: number) => void,
		private readonly timers: PacerTimers = realTimers,
		private readonly interval = screenInterval,
		private readonly patience = screenPatience
	) {
		this.stats.since = timers.now();
	}
	/** A frame from Chromium: `send` gets its number when it goes and says whether the connection took it. */
	frameIn(session: number, bytes: number, send: (frame: number) => boolean) {
		if (this.stopped) return;
		if (this.next) {
			// Never sent: a newer picture of the page replaces it.
			this.stats.skipped++;
			this.release(this.next.session);
		}
		this.next = { session, bytes, send };
		this.pump();
	}
	/** The device drew `frame`: Chromium may paint again, and the waiting frame goes when its time comes. */
	ack(frame: number) {
		const inflight = this.inflight;
		if (!inflight || frame < inflight.frame) return;
		this.settle();
		this.pump();
	}
	private settle() {
		const inflight = this.inflight;
		this.inflight = null;
		if (this.patienceTimer !== null) this.timers.clear(this.patienceTimer);
		this.patienceTimer = null;
		if (inflight && !this.stopped) this.release(inflight.session);
	}
	private pump() {
		if (this.stopped || !this.next || this.inflight) return;
		const now = this.timers.now(),
			wait = Math.max(this.sentAt + this.interval, this.pausedUntil) - now;
		if (wait > 0) {
			if (this.timer === null)
				this.timer = this.timers.set(() => {
					this.timer = null;
					this.pump();
				}, wait);
			return;
		}
		const next = this.next;
		this.next = null;
		const frame = ++this.frame;
		this.sentAt = now;
		if (!next.send(frame)) {
			this.stats.dropped++;
			this.pausedUntil = now + screenDropPause;
			this.release(next.session);
			return;
		}
		this.stats.frames++;
		this.stats.bytes += next.bytes;
		this.inflight = { session: next.session, frame };
		this.patienceTimer = this.timers.set(() => {
			this.patienceTimer = null;
			this.settle();
			this.pump();
		}, this.patience);
	}
	/** Frames and kilobytes a second since the last call, frames a newer one replaced and frames the connection refused. */
	rates() {
		const now = this.timers.now(),
			seconds = Math.max(0.001, (now - this.stats.since) / 1000),
			rates = {
				fps: Math.round((this.stats.frames / seconds) * 10) / 10,
				kbps: Math.round(this.stats.bytes / 1024 / seconds),
				skipped: this.stats.skipped,
				dropped: this.stats.dropped,
			};
		this.stats = { since: now, frames: 0, bytes: 0, skipped: 0, dropped: 0 };
		return rates;
	}
	stop() {
		this.stopped = true;
		for (const timer of [this.timer, this.patienceTimer])
			if (timer !== null) this.timers.clear(timer);
		this.timer = this.patienceTimer = null;
		this.inflight = null;
		this.next = null;
	}
}
