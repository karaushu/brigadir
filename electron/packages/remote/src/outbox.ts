/**
 * spec/remote-access-and-mobile#outbox (security review W2, J1): what one signed-in connection — a phone on the web listener, a computer on the
 * gateway — may hold unsent in main. Before, events stopped at 64 MiB of `bufferedAmount` but replies had no bound: a
 * client that does not read its socket and asks for 64 files of 8 MiB grew main's memory without limit.
 *
 * - Every frame after the sign-in (a reply, an event, a pong) goes through one queue, in order. A frame is handed to the
 *   socket only while less than `highWater` is still being written; the rest wait here, so a large reply goes out one at
 *   a time behind the one before it.
 * - Unsent bytes — the socket's buffer and this queue — stay under `pendingBytes`: a frame past it closes the connection as
 *   `slow`. One frame alone is always taken (a reply main already made is not refused for its size), so the bound is on
 *   what piles up, not on a single file.
 * - While anything waits, the socket stops reading: a client that does not read gets no new calls run either.
 * - A backlog that does not move for `drainMs` closes the connection as `slow`. A slow phone on a weak network still moves:
 *   each written frame restarts the clock. While frames wait, this clock — not the heartbeat — says whether the client is
 *   alive: its pongs wait behind the paused socket.
 * - `serial` runs a bulk call (a file, its highlighting, a diff — `isBulkCall`) only after the calls before it answered and
 *   the socket drained: a connection holds at most one such reply in main at a time.
 */

/**
 * What the outbox needs of a `ws` socket; tests give a fake. Not `bufferedAmount`: a frame `ws` is still deflating is not in
 * it, so a burst of compressible replies looked drained. The outbox counts a frame from `send` until its callback — the
 * moment the socket handed it to the network.
 */
export interface OutboxSocket {
	readonly readyState: number;
	readonly OPEN: number;
	send(
		data: string | Uint8Array,
		options: { binary?: boolean; compress?: boolean },
		cb: (error?: Error) => void
	): void;
	pause(): void;
	resume(): void;
}
export type OutboxLimits = {
	/** Unsent bytes one connection may hold in main (the socket's buffer and the queue); more — `slow`. */
	pendingBytes: number;
	/** Over this much in the socket's buffer, frames wait in the queue and the socket stops reading. */
	highWater: number;
	/** A backlog that does not shrink for this long — `slow`. */
	drainMs: number;
};
export const outboxLimits: OutboxLimits = {
	pendingBytes: 32 * 1024 * 1024,
	highWater: 1024 * 1024,
	drainMs: 60_000,
};
/** spec/remote-access-and-mobile#browser-from-device: a frame that may be skipped is skipped while this much is still unsent — latency over completeness. */
export const streamBacklog = 1024 * 1024;

type Frame = { data: string | Uint8Array; binary: boolean; compress?: boolean; size: number };
const byteLength = (data: string | Uint8Array) =>
	typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;

export class Outbox {
	private readonly queue: Frame[] = [];
	private queued = 0;
	/** Bytes handed to the socket whose write has not finished yet (deflating, in the socket's buffer). */
	private writing = 0;
	private stall: ReturnType<typeof setTimeout> | null = null;
	private paused = false;
	private closed = false;
	private line: Promise<unknown> = Promise.resolve();
	private readonly waiting: (() => void)[] = [];
	private readonly limits: OutboxLimits;
	constructor(
		private readonly ws: OutboxSocket,
		/** The client is too slow to keep: the caller says `bye('slow')` and drops the socket. */
		private readonly onSlow: () => void,
		limits: Partial<OutboxLimits> = {},
		/** A frame left main's buffer: the client reads (the heartbeat counts it as alive while its pongs wait in line). */
		private readonly onProgress: () => void = () => {}
	) {
		this.limits = { ...outboxLimits, ...limits };
	}
	/** Bytes not yet handed to the network: those the socket is writing and the queue. */
	get pending(): number {
		return this.writing + this.queued;
	}
	/** Something waits: frames in the queue or more than `highWater` still being written. */
	get backlogged(): boolean {
		return this.queue.length > 0 || this.writing >= this.limits.highWater;
	}
	/**
	 * Queues a frame; false when it was not taken — the connection is gone, a `droppable` frame met a backlog, or the frame
	 * would take the connection past `pendingBytes` (then the connection goes as `slow`).
	 */
	send(
		data: string | Uint8Array,
		options: { binary?: boolean; compress?: boolean; droppable?: boolean } = {}
	): boolean {
		if (this.closed || this.ws.readyState !== this.ws.OPEN) return false;
		const pending = this.pending;
		if (options.droppable && pending > streamBacklog) return false;
		const size = byteLength(data);
		if (pending > 0 && pending + size > this.limits.pendingBytes) {
			this.slow();
			return false;
		}
		this.queue.push({
			data,
			binary: options.binary ?? false,
			...(options.compress === undefined ? {} : { compress: options.compress }),
			size,
		});
		this.queued += size;
		this.flush();
		return true;
	}
	/**
	 * Runs a bulk call after the bulk calls before it and once the socket drained (spec/remote-access-and-mobile#outbox); a call still waiting when
	 * the connection goes does not run (undefined).
	 */
	serial<T>(task: () => Promise<T>): Promise<T | undefined> {
		const run = this.line.then(() => this.drained()).then(() => (this.closed ? undefined : task()));
		this.line = run.catch(() => {});
		return run;
	}
	/** The connection went: nothing more is written, waiting bulk calls end without running. */
	close() {
		if (this.closed) return;
		this.closed = true;
		this.queue.length = 0;
		this.queued = 0;
		this.clearStall();
		for (const resolve of this.waiting.splice(0)) resolve();
	}
	private drained(): Promise<void> {
		if (this.closed || !this.backlogged) return Promise.resolve();
		return new Promise((resolve) => this.waiting.push(resolve));
	}
	private flush() {
		while (
			!this.closed &&
			this.queue.length &&
			this.ws.readyState === this.ws.OPEN &&
			this.writing < this.limits.highWater
		) {
			const frame = this.queue.shift()!;
			this.queued -= frame.size;
			this.writing += frame.size;
			this.ws.send(
				frame.data,
				{
					binary: frame.binary,
					...(frame.compress === undefined ? {} : { compress: frame.compress }),
				},
				(error) => {
					this.writing -= frame.size;
					if (!error) this.progress();
				}
			);
		}
		this.watch();
	}
	private progress() {
		if (this.closed) return;
		this.onProgress();
		this.clearStall();
		this.flush();
	}
	private watch() {
		if (this.closed) return;
		if (this.backlogged) {
			if (!this.paused) {
				this.paused = true;
				this.ws.pause();
			}
			this.stall ??= setTimeout(() => {
				this.stall = null;
				if (this.backlogged) this.slow();
			}, this.limits.drainMs);
			this.stall.unref?.();
			return;
		}
		this.clearStall();
		if (this.paused) {
			this.paused = false;
			this.ws.resume();
		}
		for (const resolve of this.waiting.splice(0)) resolve();
	}
	private clearStall() {
		if (this.stall) clearTimeout(this.stall);
		this.stall = null;
	}
	private slow() {
		if (this.closed) return;
		this.close();
		this.onSlow();
	}
}
