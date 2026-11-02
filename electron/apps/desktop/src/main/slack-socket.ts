import { isRecord } from '@brigadir/core';

/** The part of a WebSocket the client uses; the global `WebSocket` of Electron's main fits, tests pass a fake. */
export type SocketLike = {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
};
export type SocketFactory = (url: string) => SocketLike;
/** A Socket Mode envelope after its ack: `events_api` (an Events API callback) or `interactive` (a button). */
export type SlackEnvelope = {
	type: 'events_api' | 'interactive';
	payload: Record<string, unknown>;
};
export type SlackSocketState = 'connecting' | 'on' | 'down' | { token: string };
export type SlackSocketDeps = {
	/** `apps.connections.open` with the App-Level Token: the `wss://` URL, or an error with Slack's code. */
	open(): Promise<string>;
	socket: SocketFactory;
	envelope(envelope: SlackEnvelope): void;
	changed(state: SlackSocketState): void;
	/** A refusal of the app token itself — no retry until it is replaced. */
	isTokenError(error: unknown): boolean;
	/** Milliseconds before reconnect attempt `n` (1, 2, …). */
	backoff?: (attempt: number) => number;
};
const defaultBackoff = (attempt: number) => Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6));

/**
 * spec/notifications-slack-notes-and-schedules#slack: Slack Socket Mode without a server — `apps.connections.open` gives a WebSocket URL; every envelope is
 * acknowledged at once with its `envelope_id` (Slack retries otherwise); `hello` means listening; `disconnect` (a refresh
 * Slack asks for) and a closed socket open a new connection, with backoff after failures. Runs while `start()`ed.
 */
export class SlackSocket {
	private ws: SocketLike | null = null;
	private running = false;
	private attempt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Each connection gets a number; the callbacks of a replaced one do nothing. */
	private generation = 0;
	constructor(private readonly deps: SlackSocketDeps) {}
	get active() {
		return this.running;
	}
	start() {
		if (this.running) return;
		this.running = true;
		this.attempt = 0;
		void this.connect();
	}
	stop() {
		this.running = false;
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
			try {
				ws.close(1000, 'stopped');
			} catch {
				// Already closed.
			}
		}
	}
	private async connect() {
		if (!this.running) return;
		const generation = ++this.generation;
		this.deps.changed('connecting');
		let url: string;
		try {
			url = await this.deps.open();
		} catch (error) {
			if (generation !== this.generation) return;
			if (this.deps.isTokenError(error)) {
				this.running = false;
				this.deps.changed({ token: error instanceof Error ? error.message : 'invalid_auth' });
				return;
			}
			this.retry();
			return;
		}
		if (generation !== this.generation || !this.running) return;
		let ws: SocketLike;
		try {
			ws = this.deps.socket(url);
		} catch {
			this.retry();
			return;
		}
		this.ws = ws;
		const current = () => generation === this.generation && this.ws === ws;
		ws.onmessage = (event) => {
			if (current()) this.message(ws, event.data);
		};
		ws.onclose = () => {
			if (!current()) return;
			this.ws = null;
			this.retry();
		};
		ws.onerror = () => {
			// `close` follows an error; the reconnect waits for it.
		};
	}
	private retry() {
		if (!this.running || this.timer) return;
		this.attempt++;
		this.deps.changed('down');
		this.timer = setTimeout(
			() => {
				this.timer = null;
				void this.connect();
			},
			(this.deps.backoff ?? defaultBackoff)(this.attempt)
		);
		this.timer.unref?.();
	}
	/** Slack asked for a new connection: the old one closes quietly, the new one opens now. */
	private reconnect() {
		const ws = this.ws;
		this.ws = null;
		this.generation++;
		if (ws) {
			ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
			try {
				ws.close(1000, 'refresh');
			} catch {
				// Already closed.
			}
		}
		void this.connect();
	}
	private message(ws: SocketLike, data: unknown) {
		let value: unknown;
		try {
			value = JSON.parse(typeof data === 'string' ? data : String(data));
		} catch {
			return;
		}
		if (!isRecord(value)) return;
		if (typeof value.envelope_id === 'string')
			try {
				ws.send(JSON.stringify({ envelope_id: value.envelope_id }));
			} catch {
				// The socket closed under us; Slack sends the envelope again on the next connection.
			}
		if (value.type === 'hello') {
			this.attempt = 0;
			this.deps.changed('on');
			return;
		}
		if (value.type === 'disconnect') {
			this.reconnect();
			return;
		}
		if ((value.type === 'events_api' || value.type === 'interactive') && isRecord(value.payload))
			try {
				this.deps.envelope({ type: value.type, payload: value.payload });
			} catch {
				// A handler's error is the handler's; the socket keeps listening.
			}
	}
}
