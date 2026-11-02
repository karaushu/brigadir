/**
 * spec/remote-access-and-mobile#phone-network: the phone's one connection to the working machine — the WebSocket that signed in, the same frames as
 * the gateway (`@brigadir/remote/web`) and the bridge transport the app builds `createDesktopBridge` on (spec/remote-access-and-mobile#phone).
 * A dropped connection comes back with the resume token while the page lives; after that the passkey again.
 */
import type { BridgeTransport } from '@brigadir/core';
import {
	decodeFrame,
	encodeFrame,
	isWebServerMessage,
	type WebMessage,
	type WebPushSubscription,
} from '@brigadir/remote/web';

export const socketUrl = (path: string) =>
	`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
/** Messages a page reads from a socket: checked, or the socket closes as the listener's would. */
export function readMessages(ws: WebSocket, take: (message: WebMessage) => void) {
	ws.addEventListener('message', (event) => {
		let message: unknown;
		try {
			message = typeof event.data === 'string' ? decodeFrame(event.data) : null;
		} catch {
			message = null;
		}
		if (!isWebServerMessage(message)) return ws.close(4002, 'protocol');
		take(message);
	});
}
export const send = (ws: WebSocket, message: WebMessage) => {
	if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(message));
};
export type Welcome = Extract<WebMessage, { t: 'welcome' }>;

export class Connection implements BridgeTransport {
	private next = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private readonly pushes: ((error: string | null) => void)[] = [];
	private resumeToken: string;
	private closedBy: string | null = null;
	private readonly pongs = new Map<number, (at: number) => void>();
	/** Called when the machine said goodbye or the resume token ran out: the page signs in again. */
	onEnd: ((reason: string) => void) | null = null;
	/** spec/remote-access-and-mobile#phone-app: the socket dropped (`down`) and came back with the resume token (`up`): the machine chip follows. */
	onLink: ((state: 'up' | 'down') => void) | null = null;
	private readonly links = new Set<(state: 'up' | 'down') => void>();
	/** The reconnect loop runs (one at a time); `wakeUp` ends its current wait at once. */
	private reconnecting = false;
	private wakeUp: (() => void) | null = null;
	/** A socket given up for dead before the OS closed it: its late `close` changes nothing. */
	private readonly abandoned = new WeakSet<WebSocket>();
	/**
	 * A screen that keeps a stream on the machine (the terminal's watch, spec/remote-access-and-mobile#outbox) asks again after `up`: the old
	 * connection's client went away on the machine, and its watches with it.
	 */
	watchLink(listener: (state: 'up' | 'down') => void): () => void {
		this.links.add(listener);
		return () => this.links.delete(listener);
	}
	private link(state: 'up' | 'down') {
		this.onLink?.(state);
		for (const listener of [...this.links]) listener(state);
	}
	constructor(
		private ws: WebSocket,
		readonly welcome: Welcome
	) {
		this.resumeToken = welcome.resume;
		this.attach(ws);
	}
	private attach(ws: WebSocket) {
		this.ws = ws;
		readMessages(ws, (message) => this.take(message));
		ws.addEventListener('close', () => this.lost(ws));
	}
	private lost(ws: WebSocket) {
		if (ws !== this.ws || this.abandoned.has(ws)) return;
		this.abandoned.add(ws);
		for (const call of this.pending.values()) call.reject(new Error('The connection closed.'));
		this.pending.clear();
		for (const pong of this.pongs.values()) pong(-1);
		this.pongs.clear();
		if (this.closedBy) this.onEnd?.(this.closedBy);
		else {
			this.link('down');
			void this.reconnect();
		}
	}
	/**
	 * The app came back to the screen (unlocked, switched to, restored from the back-forward cache) or the network returned
	 * (spec/remote-access-and-mobile#phone-chat): a socket that is down reconnects now instead of at the end of its backoff (up to 15 s); one that
	 * looks open but does not answer a ping in 2.5 s — iOS froze it in the background — is given up and replaced.
	 */
	async wake() {
		if (this.closedBy) return;
		if (this.ws.readyState !== WebSocket.OPEN) {
			this.wakeUp?.();
			return;
		}
		const ws = this.ws;
		if ((await this.ping(2500)) >= 0 || ws !== this.ws) return;
		try {
			ws.close(4000, 'stale');
		} catch {
			// Already closing.
		}
		this.lost(ws);
	}
	private take(message: WebMessage) {
		switch (message.t) {
			case 'result': {
				const call = this.pending.get(message.id);
				if (!call) return;
				this.pending.delete(message.id);
				if (message.ok) call.resolve(message.value);
				else call.reject(new Error(message.error));
				return;
			}
			case 'event':
				for (const listener of this.listeners.get(message.channel) ?? []) listener(message.value);
				return;
			case 'push-saved':
				this.pushes.shift()?.(message.ok ? null : (message.error ?? 'error'));
				return;
			case 'bye':
				this.closedBy = message.reason;
				return;
			case 'pong':
				this.pongs.get(message.at)?.(Date.now() - message.at);
				this.pongs.delete(message.at);
				return;
		}
	}
	/** The resume token while the page lives (spec/remote-access-and-mobile#pairing): no Face ID after a phone locked for a minute. */
	private async reconnect() {
		if (this.reconnecting) return;
		this.reconnecting = true;
		try {
			await this.reconnectLoop();
		} finally {
			this.reconnecting = false;
			this.wakeUp = null;
		}
	}
	private async reconnectLoop() {
		for (let attempt = 0, step = 0; attempt < 60; attempt++, step++) {
			const woken = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), Math.min(500 * 2 ** step, 15_000));
				this.wakeUp = () => {
					clearTimeout(timer);
					resolve(true);
				};
			});
			this.wakeUp = null;
			// Woken by the person coming back: the backoff starts over.
			if (woken) step = 0;
			const outcome = await new Promise<'ok' | 'refused' | 'error'>((resolve) => {
				const ws = new WebSocket(socketUrl('/ws'));
				let done = false;
				readMessages(ws, (message) => {
					if (message.t === 'challenge') send(ws, { t: 'resume', token: this.resumeToken });
					else if (message.t === 'welcome') {
						done = true;
						this.resumeToken = message.resume;
						this.attach(ws);
						this.subscribeAll();
						this.link('up');
						resolve('ok');
					} else if (message.t === 'refused') {
						done = true;
						resolve('refused');
					}
				});
				ws.addEventListener('close', () => {
					if (!done) resolve('error');
				});
			});
			if (outcome === 'ok') return;
			if (outcome === 'refused') break;
		}
		this.onEnd?.('expired');
	}
	invoke(channel: string, args: readonly unknown[]): Promise<unknown> {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected.'));
			this.pending.set(id, { resolve, reject });
			send(this.ws, { t: 'invoke', id, channel, args: [...args] });
		});
	}
	subscribe(channel: string, listener: (value: unknown) => void): () => void {
		const set = this.listeners.get(channel) ?? new Set();
		set.add(listener);
		this.listeners.set(channel, set);
		this.subscribeAll();
		return () => {
			set.delete(listener);
			if (!set.size) this.listeners.delete(channel);
			this.subscribeAll();
		};
	}
	emit(channel: string, value: unknown) {
		for (const listener of this.listeners.get(channel) ?? []) listener(value);
	}
	private subscribeAll() {
		send(this.ws, { t: 'subscribe', channels: [...this.listeners.keys()] });
	}
	/** spec/remote-access-and-mobile#phone-app: the round trip to the machine in ms; -1 when the socket is down or the answer took over 5 s. */
	ping(timeout = 5000): Promise<number> {
		return new Promise((resolve) => {
			if (this.ws.readyState !== WebSocket.OPEN) return resolve(-1);
			let at = Date.now();
			while (this.pongs.has(at)) at++;
			const timer = setTimeout(() => {
				this.pongs.delete(at);
				resolve(-1);
			}, timeout);
			this.pongs.set(at, (ms) => {
				clearTimeout(timer);
				resolve(ms);
			});
			send(this.ws, { t: 'ping', at });
		});
	}
	/** The person signs out on this phone (spec/remote-access-and-mobile#phone-app, «Вийти на цьому телефоні»): the socket closes as the machine's `bye` would. */
	close(reason = 'signed-out') {
		this.closedBy = reason;
		this.ws.close(1000, reason);
	}
	/** spec/remote-access-and-mobile#phone-network: this phone's push subscription to the machine; null forgets it. */
	savePush(subscription: WebPushSubscription | null): Promise<string | null> {
		return new Promise((resolve) => {
			this.pushes.push(resolve);
			send(this.ws, { t: 'push', subscription });
		});
	}
}
