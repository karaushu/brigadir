import type { Socket } from 'node:net';
import { isRecord } from '@brigadir/core';
const frameLimit = 32 * 1024 * 1024;
/** Linear newline framing: only the new chunk is scanned and measured, a split frame is joined once. `line` returns false to stop; the unread rest of the chunk is returned. */
export function framer(
	line: (text: string) => boolean,
	tooLarge: () => void,
	limit = frameLimit
): (chunk: string) => string {
	let parts: string[] = [],
		bytes = 0;
	return (chunk) => {
		let start = 0,
			split: number;
		while ((split = chunk.indexOf('\n', start)) >= 0) {
			const piece = chunk.slice(start, split);
			start = split + 1;
			if (bytes + Buffer.byteLength(piece) > limit) {
				tooLarge();
				return '';
			}
			const text = parts.length ? (parts.push(piece), parts.join('')) : piece;
			parts = [];
			bytes = 0;
			if (!line(text)) return chunk.slice(start);
		}
		if (start < chunk.length) {
			const rest = start ? chunk.slice(start) : chunk;
			parts.push(rest);
			bytes += Buffer.byteLength(rest);
			if (bytes > limit) tooLarge();
		}
		return '';
	};
}
/** Local JSON-RPC framing; ACP framing stays with its SDK, and MCP arrives through `mcp-relay` after a handshake here (`handOff`). */
export class Peer {
	private next = 0;
	private handoff: ((chunk: string) => void) | null = null;
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	private controller = new AbortController();
	readonly signal = this.controller.signal;
	onNotification: (method: string, params: unknown) => void = () => {};
	constructor(
		readonly socket: Socket,
		readonly handle: (
			method: string,
			params: unknown,
			signal: AbortSignal
		) => Promise<unknown> = async () => {
			throw new Error('Unknown method');
		}
	) {
		socket.setEncoding('utf8');
		const read = framer(
			(line) => {
				try {
					this.receive(JSON.parse(line));
				} catch {
					socket.destroy(new Error('Invalid frame'));
					return false;
				}
				return !this.handoff;
			},
			() => socket.destroy(new Error('Frame too large'))
		);
		const data = (chunk: string) => {
			const rest = read(chunk),
				next = this.handoff;
			if (!next || socket.destroyed) return;
			socket.off('data', data);
			socket.on('data', next);
			if (rest) next(rest);
		};
		socket.on('data', data);
		socket.on('error', () => {});
		socket.once('close', () => {
			this.controller.abort();
			for (const waiter of this.pending.values()) waiter.reject(new Error('Host disconnected'));
			this.pending.clear();
		});
	}
	private send(value: unknown) {
		if (this.socket.destroyed) throw new Error('Host disconnected');
		if (this.socket.writableLength > 32 * 1024 * 1024) {
			this.socket.destroy();
			throw new Error('Client too slow');
		}
		this.socket.write(`${JSON.stringify(value)}\n`);
	}
	private receive(value: unknown) {
		if (!isRecord(value) || value.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC');
		if (typeof value.method === 'string') {
			if (value.id === undefined) {
				this.onNotification(value.method, value.params);
				return;
			}
			if (typeof value.id !== 'number') throw new Error('Invalid request ID');
			const id = value.id;
			void this.handle(value.method, value.params, this.signal)
				.then(
					(result) => {
						if (!this.signal.aborted) this.send({ jsonrpc: '2.0', id, result });
					},
					(e) => {
						if (!this.signal.aborted)
							this.send({
								jsonrpc: '2.0',
								id,
								error: { code: -32000, message: e instanceof Error ? e.message : 'Request failed' },
							});
					}
				)
				.catch(() => this.close());
		} else if (typeof value.id === 'number') {
			const waiter = this.pending.get(value.id);
			if (!waiter) return;
			this.pending.delete(value.id);
			if (isRecord(value.error)) waiter.reject(new Error(String(value.error.message)));
			else waiter.resolve(value.result);
		}
	}
	request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.send({ jsonrpc: '2.0', id, method, params });
			} catch (e) {
				this.pending.delete(id);
				reject(e);
			}
		});
	}
	notify(method: string, params: unknown) {
		this.send({ jsonrpc: '2.0', method, params });
	}
	/** The frames after the current one belong to another protocol on the same socket (the MCP relay after its handshake). */
	handOff(next: (chunk: string) => void) {
		this.handoff = next;
	}
	close() {
		this.socket.destroy();
	}
}
