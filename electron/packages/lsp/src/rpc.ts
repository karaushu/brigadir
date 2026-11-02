import type { Readable, Writable } from 'node:stream';
/** JSON-RPC 2.0 over LSP base-protocol framing (`Content-Length` headers). */
export type RpcMessage = {
	jsonrpc: '2.0';
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};
export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string
	) {
		super(message);
	}
}
export const messageLimit = 64 * 1024 * 1024;

export class FrameReader {
	private buffer: Buffer = Buffer.alloc(0);
	constructor(
		private onMessage: (message: RpcMessage) => void,
		private onError: (error: Error) => void
	) {}
	push(chunk: Buffer) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		for (;;) {
			const end = this.buffer.indexOf('\r\n\r\n');
			if (end < 0) {
				if (this.buffer.length > 8192) {
					this.fail('Header is too long');
				}
				return;
			}
			const header = this.buffer.subarray(0, end).toString('ascii');
			const length = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1];
			if (length === undefined) return this.fail('Missing Content-Length');
			const size = Number(length);
			if (size > messageLimit) return this.fail('Message is too large');
			if (this.buffer.length < end + 4 + size) return;
			const body = this.buffer.subarray(end + 4, end + 4 + size).toString('utf8');
			this.buffer = this.buffer.subarray(end + 4 + size);
			let message: RpcMessage;
			try {
				message = JSON.parse(body) as RpcMessage;
			} catch {
				this.fail('Invalid JSON');
				return;
			}
			if (message && typeof message === 'object') this.onMessage(message);
		}
	}
	private fail(reason: string) {
		this.buffer = Buffer.alloc(0);
		this.onError(new Error(reason));
	}
}
export function frame(message: RpcMessage) {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

type Pending = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};
export type RequestHandler = (method: string, params: unknown) => unknown;
export class RpcConnection {
	private next = 1;
	private pending = new Map<number, Pending>();
	private closed = false;
	private notifications = new Set<(method: string, params: unknown) => void>();
	constructor(
		input: Readable,
		private output: Writable,
		private handleRequest: RequestHandler = () => null,
		private onFailure: (error: Error) => void = () => {}
	) {
		const reader = new FrameReader(
			(message) => this.receive(message),
			(error) => {
				this.onFailure(error);
				this.close(error);
			}
		);
		input.on('data', (chunk: Buffer) => reader.push(chunk));
		input.on('end', () => this.close(new Error('Connection closed')));
		output.on('error', (error) => this.close(error));
	}
	get isClosed() {
		return this.closed;
	}
	onNotification(listener: (method: string, params: unknown) => void) {
		this.notifications.add(listener);
		return () => {
			this.notifications.delete(listener);
		};
	}
	request<T>(method: string, params: unknown, timeout = 5000, signal?: AbortSignal): Promise<T> {
		if (this.closed) return Promise.reject(new Error('Connection closed'));
		const id = this.next++;
		return new Promise<T>((resolve, reject) => {
			const cancel = (reason: string) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				this.notify('$/cancelRequest', { id });
				reject(new RpcError(-32800, reason));
			};
			const timer = setTimeout(() => cancel('Request timed out'), timeout);
			signal?.addEventListener('abort', () => cancel('Request cancelled'), { once: true });
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}
	notify(method: string, params: unknown) {
		if (!this.closed) this.send({ jsonrpc: '2.0', method, params });
	}
	close(error = new Error('Connection closed')) {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
	private send(message: RpcMessage) {
		try {
			this.output.write(frame(message));
		} catch (error) {
			this.close(error as Error);
		}
	}
	private receive(message: RpcMessage) {
		if (message.method !== undefined && message.id !== undefined && message.id !== null) {
			const id = message.id;
			Promise.resolve()
				.then(() => this.handleRequest(message.method!, message.params))
				.then(
					(result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
					(error: Error) =>
						this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } })
				);
			return;
		}
		if (message.method !== undefined) {
			for (const listener of this.notifications) listener(message.method, message.params);
			return;
		}
		if (typeof message.id !== 'number') return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(new RpcError(message.error.code, message.error.message));
		else pending.resolve(message.result);
	}
}
