import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { Outbox, type OutboxSocket } from './outbox';

/** A socket whose buffer empties only when the test says the reader took it. */
class SlowSocket implements OutboxSocket {
	readonly OPEN = 1;
	readyState = 1;
	bufferedAmount = 0;
	paused = false;
	readonly sent: string[] = [];
	private readonly inFlight: { size: number; cb: (error?: Error) => void }[] = [];
	send(data: string | Uint8Array, _options: unknown, cb: (error?: Error) => void) {
		const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
		this.sent.push(typeof data === 'string' ? data : `<${size} bytes>`);
		this.bufferedAmount += size;
		this.inFlight.push({ size, cb });
	}
	pause() {
		this.paused = true;
	}
	resume() {
		this.paused = false;
	}
	/** The reader takes the oldest frame. */
	read() {
		const frame = this.inFlight.shift();
		if (!frame) return false;
		this.bufferedAmount -= frame.size;
		frame.cb();
		return true;
	}
}
const kib = (n: number) => 'x'.repeat(n * 1024);
afterEach(() => {
	vi.useRealTimers();
});

describe('the outbox of a remote connection (spec/remote-access-and-mobile#outbox, security review W2 J1)', () => {
	it('writes while the buffer is low, queues the rest in order and stops reading the socket meanwhile', () => {
		const ws = new SlowSocket(),
			slow = vi.fn();
		const outbox = new Outbox(ws, slow, { highWater: 100 * 1024, pendingBytes: 1024 * 1024 });
		expect(outbox.send(kib(80))).toBe(true);
		expect(outbox.send(kib(80))).toBe(true);
		expect(outbox.send('small')).toBe(true);
		// The second frame went (80 KiB < 100 KiB), the third waits behind the buffer that is now over the mark.
		expect(ws.sent).toHaveLength(2);
		expect(outbox.backlogged).toBe(true);
		expect(outbox.pending).toBe(160 * 1024 + 5);
		expect(ws.paused).toBe(true);
		ws.read();
		expect(ws.sent).toEqual([kib(80), kib(80), 'small']);
		expect(outbox.backlogged).toBe(false);
		expect(ws.paused).toBe(false);
		expect(slow).not.toHaveBeenCalled();
	});
	it('closes a reader that piles up more than the cap, but takes one large frame alone', () => {
		const ws = new SlowSocket(),
			slow = vi.fn();
		const outbox = new Outbox(ws, slow, { highWater: 64 * 1024, pendingBytes: 512 * 1024 });
		// One reply over the cap with nothing waiting: main already made it, it goes.
		expect(outbox.send(kib(600))).toBe(true);
		expect(slow).not.toHaveBeenCalled();
		ws.read();
		for (let i = 0; i < 8; i++) expect(outbox.send(kib(64))).toBe(true);
		expect(outbox.pending).toBe(512 * 1024);
		// The reader takes nothing; the next frame would pass 512 KiB.
		expect(outbox.send(kib(64))).toBe(false);
		expect(slow).toHaveBeenCalledTimes(1);
		// Closed: nothing is taken any more and the queue is gone.
		expect(outbox.send('late')).toBe(false);
		expect(outbox.pending).toBe(64 * 1024);
	});
	it('skips a droppable frame while a backlog waits', () => {
		const ws = new SlowSocket();
		const outbox = new Outbox(ws, () => {}, { highWater: 4 * 1024 * 1024 });
		expect(outbox.send(kib(2048))).toBe(true);
		expect(outbox.send('frame', { droppable: true })).toBe(false);
		ws.read();
		expect(outbox.send('frame', { droppable: true })).toBe(true);
	});
	it('closes a backlog that does not move within the drain time; a slow reader that moves stays', () => {
		vi.useFakeTimers();
		const ws = new SlowSocket(),
			slow = vi.fn(),
			progress = vi.fn();
		const outbox = new Outbox(
			ws,
			slow,
			{ highWater: 10, pendingBytes: 1024 * 1024, drainMs: 1000 },
			progress
		);
		outbox.send(kib(1));
		outbox.send(kib(1));
		outbox.send(kib(1));
		vi.advanceTimersByTime(900);
		ws.read();
		expect(progress).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(900);
		ws.read();
		vi.advanceTimersByTime(900);
		expect(slow).not.toHaveBeenCalled();
		// Now it stops reading.
		vi.advanceTimersByTime(200);
		expect(slow).toHaveBeenCalledTimes(1);
	});
	it('runs bulk calls one at a time, each after the socket drained', async () => {
		const ws = new SlowSocket();
		const outbox = new Outbox(ws, () => {}, { highWater: 1024, pendingBytes: 64 * 1024 * 1024 });
		let running = 0,
			most = 0,
			started = 0;
		const call = () =>
			outbox.serial(async () => {
				started++;
				running++;
				most = Math.max(most, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				outbox.send(kib(256));
				running--;
			});
		const calls = [call(), call(), call()];
		await calls[0];
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The first reply sits unread: the second call has not started.
		expect(started).toBe(1);
		ws.read();
		await calls[1];
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toBe(2);
		ws.read();
		await calls[2];
		expect(most).toBe(1);
		// A call still waiting when the connection goes does not run.
		const late = call();
		outbox.close();
		await late;
		expect(started).toBe(3);
	});
});

describe('the outbox over a real socket with a reader that stops (spec/remote-access-and-mobile#outbox)', () => {
	let server: Server | null = null;
	const clients: WebSocket[] = [];
	afterEach(async () => {
		for (const client of clients.splice(0)) client.terminate();
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = null;
	});
	it('holds no more than the cap in main and closes the reader that never drains', async () => {
		server = createServer();
		const wss = new WebSocketServer({ server });
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
		const accepted = new Promise<WebSocket>((resolve) => wss.on('connection', resolve));
		const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
		clients.push(client);
		client.on('error', () => {});
		await new Promise((resolve) => client.once('open', resolve));
		// The page stops reading its socket.
		client.pause();
		const ws = await accepted;
		const cap = 8 * 1024 * 1024;
		let slow = false,
			most = 0;
		const outbox = new Outbox(
			ws,
			() => {
				slow = true;
				ws.terminate();
			},
			{ pendingBytes: cap, drainMs: 2000 }
		);
		const reply = 'y'.repeat(1024 * 1024);
		for (let i = 0; i < 64 && !slow; i++) {
			outbox.send(reply);
			most = Math.max(most, outbox.pending);
			await new Promise((resolve) => setImmediate(resolve));
		}
		// The kernel takes a few megabytes; past that main holds at most the cap, then the reader goes.
		if (!slow) await new Promise((resolve) => setTimeout(resolve, 2500));
		expect(slow).toBe(true);
		expect(most).toBeLessThanOrEqual(cap);
		await expect.poll(() => ws.readyState).toBe(ws.CLOSED);
		wss.close();
	});
	it('gives a reader that reads every frame in order', async () => {
		server = createServer();
		const wss = new WebSocketServer({ server });
		await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
		const accepted = new Promise<WebSocket>((resolve) => wss.on('connection', resolve));
		const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
		clients.push(client);
		const got: number[] = [];
		client.on('message', (data) => got.push(Number(String(data).slice(0, 8))));
		await new Promise((resolve) => client.once('open', resolve));
		const ws = await accepted;
		let slow = false;
		const outbox = new Outbox(ws, () => (slow = true), { pendingBytes: 8 * 1024 * 1024 });
		const body = 'z'.repeat(512 * 1024);
		for (let i = 0; i < 40; i++) {
			expect(outbox.send(`${String(i).padStart(8, '0')}${body}`)).toBe(true);
			// Paced as replies come: each one after the reader drained enough.
			while (outbox.pending > 4 * 1024 * 1024)
				await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await expect.poll(() => got.length, { timeout: 10_000 }).toBe(40);
		expect(got).toEqual(Array.from({ length: 40 }, (_, i) => i));
		expect(slow).toBe(false);
		wss.close();
	});
});
