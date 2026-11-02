/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network: the web listener for a phone. Plain HTTP on `127.0.0.1:7422` behind `tailscale serve`, which holds
 * the TLS of `https://<machine>.<tailnet>.ts.net`; so the boundary here is the request's `Host` and `Origin`, and the
 * sign-in of the app — a passkey checked on every visit.
 *
 * - `GET` the sign-in page and what it imports; the app's files only with the cookie a signed-in WebSocket gave.
 * - `/ws/pair` while the pairing window is open: the same code and CPace as a computer, then a new passkey, then the
 *   person at the machine confirms the name (spec/remote-access-and-mobile#phone-network).
 * - `/ws`: a challenge, the passkey's assertion (or the resume token of the same phone), then the gateway's own
 *   `invoke`/`subscribe` through main's `dispatch` — where the `web` class refuses what a phone may not call.
 *
 * The phone is a device of the same registry, audit and pairing window as a computer (`RemoteGateway` owns them and
 * hands them in as `WebHost`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	isBulkCall,
	isMachineName,
	normalizePairingCode,
	webEventAllowed,
	type RemoteAddress,
	type RemoteNotice,
	type RemotePhoneStatus,
} from '@brigadir/core';
import { fromBase64Url, toBase64Url } from './base64';
import { decodeFrame, encodeFrame } from './codec';
import { CPaceParty } from './cpace';
import type { PairingWindow } from './pairing';
import { blockAfterFailures, passwordPauseMs } from './password';
import { gatewayFrameLimit, pairingFrameLimit, pairingStepTimeoutMs } from './protocol';
import type { AuditLog, DeviceRecord, DeviceRegistry, KeyVault, RemoteFiles } from './store';
import { loadVapidKeys } from './store';
import { readTailscale, tailscaleServeCommand, type TailscaleState } from './tailscale';
import { loadWebBundle, type WebBundle } from './web-bundle';
import { Outbox, type OutboxLimits } from './outbox';
import {
	isPushSubscription,
	sendPush,
	type PushFetch,
	type PushKind,
	type VapidKeys,
} from './web-push';
import {
	defaultWebPort,
	isWebClientMessage,
	isWebPairClientMessage,
	webCeremonyMs,
	webChannelIdentifier,
	webProtocolVersion,
	type WebByeReason,
	type WebLoginRefusal,
	type WebMessage,
	type WebPairRefusal,
} from './web-protocol';
import {
	passkeyAlgorithms,
	passkeyDeviceId,
	verifyAssertion,
	verifyRegistration,
	WebAuthnError,
	type PasskeyRecord,
} from './webauthn';

/** What the web listener borrows from `RemoteGateway`: the one registry, audit, pairing window and dispatch. */
export interface WebHost {
	readonly pairing: PairingWindow;
	readonly audit: AuditLog;
	readonly files: RemoteFiles;
	vault(): KeyVault;
	/** The module and access are on (spec/remote-access-and-mobile#module-and-settings). */
	on(): boolean;
	machineName(): string;
	registry(): Promise<DeviceRegistry>;
	/** Writes a line of a kind a peer can repeat at will, within its budget (spec/remote-access-and-mobile#pairing). */
	noisy(
		kind:
			'login-refused' | 'call-refused' | 'settings-changed' | 'push-subscribed' | 'push-removed',
		fields: Parameters<AuditLog['append']>[1]
	): void;
	notice(notice: RemoteNotice): void;
	changed(): void;
	dispatch(peer: WebPeer, channel: string, args: unknown[]): Promise<unknown>;
	attach(peer: WebPeer): () => void;
	log(line: string): void;
	now(): number;
}
/** A signed-in phone: main wraps it into a `Client` of the `web` class. */
export interface WebPeer {
	readonly id: string;
	readonly kind: 'phone';
	readonly deviceId: string;
	readonly deviceName: string;
	readonly address: RemoteAddress;
	send(channel: string, value: unknown, droppable?: boolean): boolean;
}
export type WebConfig = { on: boolean; phone: boolean };
export type WebDeps = {
	/** The phone's bundle (`out/renderer-mobile`); null — not built (the listener says so and serves nothing). */
	bundle: string | null;
	port?: number;
	/**
	 * e2e only (spec/remote-access-and-mobile#phone-network): `localhost` instead of the tailnet name, origin `http://localhost:<port>`, no Tailscale.
	 * Main passes it in an unpackaged run with `BRIGADIR_DATA_DIR` only.
	 */
	testHost?: boolean;
	tailscale?: (port: number) => Promise<TailscaleState>;
	push?: { fetch?: PushFetch; hosts?: readonly RegExp[] };
	limits?: Partial<WebLimits>;
	/** spec/remote-access-and-mobile#phone-task-tools: the app's version, for the phone's machine sheet. */
	version?: string;
};
export type WebLimits = {
	connections: number;
	/** Per address as `tailscale serve` says it (`X-Forwarded-For`): every connection comes from loopback here. */
	connectionsPerAddress: number;
	/** A pairing step before the registration (as on the pairing listener). */
	stepMs: number;
	/** A WebSocket without a session: the page waits for a tap and Face ID. */
	sessionlessMs: number;
	/** The bundle's cookie. */
	cookieMs: number;
	ticketMs: number;
	/** How often a listening machine looks at Tailscale again: Funnel turned on later stops the listener. */
	tailscaleMs: number;
	/** What a signed-in phone may hold unsent (spec/remote-access-and-mobile#outbox); tests lower it. */
	outbox: Partial<OutboxLimits>;
};
const defaultLimits: WebLimits = {
	connections: 64,
	connectionsPerAddress: 8,
	stepMs: pairingStepTimeoutMs,
	sessionlessMs: webCeremonyMs,
	cookieMs: 60 * 60_000,
	ticketMs: 60_000,
	tailscaleMs: 60_000,
	outbox: {},
};
const resumeMs = 15 * 60_000;
const inflightLimit = 64;
const heartbeatMs = 20_000;
const cookieName = '__Host-brigadir';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const random = (length: number) => toBase64Url(randomBytes(length));

type Session = {
	peer: WebPeer;
	ws: WebSocket;
	/** Every frame after `welcome`, bounded (spec/remote-access-and-mobile#outbox). */
	outbox: Outbox;
	detach: () => void;
	inflight: number;
	channels: Set<string>;
	alive: boolean;
};
/** `Host` without the port, lowercase; the port separately (null — none given). */
function splitHost(value: string | undefined): { name: string; port: string | null } | null {
	if (!value || value.length > 300) return null;
	const match = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
	return match ? { name: match[1]!.toLowerCase(), port: match[2] ?? null } : null;
}
/**
 * spec/remote-access-and-mobile#phone-network: the request names this machine. `Host` (and `X-Forwarded-Host` that `tailscale serve` adds) must be the
 * tailnet name, port 443 or none; in an e2e run `localhost:<port>`. A page of another site that resolves to 127.0.0.1
 * (DNS rebinding) sends its own name and gets 421.
 */
export function webHostAllowed(
	headers: IncomingMessage['headers'],
	expected: { host: string; port: number | null }
): boolean {
	const check = (value: string | string[] | undefined) => {
		if (value === undefined) return true;
		if (Array.isArray(value)) return false;
		const host = splitHost(value);
		if (!host || host.name !== expected.host) return false;
		return expected.port === null
			? host.port === null || host.port === '443'
			: host.port === String(expected.port);
	};
	return headers.host !== undefined && check(headers.host) && check(headers['x-forwarded-host']);
}
/**
 * `tailscale serve` marks a request that came from the internet through Funnel with
 * `Tailscale-Funnel-Request` (and drops one a client sent itself). Such a request is refused whatever the last look at
 * Tailscale said — Funnel may have been turned on since.
 */
export function webFunneled(headers: IncomingMessage['headers']): boolean {
	return headers['tailscale-funnel-request'] !== undefined;
}
/** The WebSocket's (and `POST /session`'s) `Origin`: exactly this machine's page. */
export function webOriginAllowed(headers: IncomingMessage['headers'], origin: string): boolean {
	return headers.origin === origin;
}
/** The security headers of every answer (spec/remote-access-and-mobile#phone-network). */
export function webHeaders(connect: string, https: boolean): Record<string, string> {
	return {
		'content-security-policy': [
			"default-src 'none'",
			"script-src 'self'",
			"style-src 'self'",
			"img-src 'self' data: blob:",
			`connect-src 'self' ${connect}`,
			"manifest-src 'self'",
			"worker-src 'self'",
			"font-src 'self'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
		].join('; '),
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin',
		'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
		'cache-control': 'no-store',
		...(https ? { 'strict-transport-security': 'max-age=31536000' } : {}),
	};
}
/**
 * `X-Forwarded-For` from `tailscale serve`: the phone's tailnet address, for the audit and the per-address cap. The last
 * entry is the one the proxy saw; earlier ones are whatever the client sent. Loopback when absent.
 */
export function forwardedFor(request: Pick<IncomingMessage, 'headers'>): string {
	const value = request.headers['x-forwarded-for'];
	const last = (Array.isArray(value) ? value.at(-1) : value)?.split(',').at(-1)?.trim() ?? '';
	return /^[0-9A-Fa-f:.]{2,45}$/.test(last) ? last : '127.0.0.1';
}
function raiseFrameLimit(ws: WebSocket, limit: number): boolean {
	const inner = ws as unknown as {
		_receiver?: { _maxPayload?: unknown };
		_extensions?: Record<string, { _maxPayload?: unknown } | undefined>;
	};
	const receiver = inner._receiver;
	if (!receiver || typeof receiver._maxPayload !== 'number') return false;
	const deflate = inner._extensions?.['permessage-deflate'];
	if (deflate && typeof deflate._maxPayload !== 'number') return false;
	receiver._maxPayload = limit;
	if (deflate) deflate._maxPayload = limit;
	return true;
}

export class WebGateway {
	private config: WebConfig = { on: false, phone: false };
	private server: Server | null = null;
	private wss: WebSocketServer | null = null;
	private bundle: WebBundle | null = null;
	private tailscale: TailscaleState = {
		cli: null,
		host: null,
		https: false,
		serving: false,
		funnel: false,
		shared: false,
	};
	private error: string | null = null;
	private readonly sessions = new Set<Session>();
	private readonly pairSockets = new Set<WebSocket>();
	private readonly resume = new Map<string, { deviceId: string; expiresAt: number | null }>();
	private readonly tickets = new Map<string, { session: Session; expiresAt: number }>();
	private readonly cookies = new Map<string, { deviceId: string; expiresAt: number }>();
	/** One sign-in check per phone at a time: parallel ones would all pass the pause (as for passwords). */
	private readonly checking = new Set<string>();
	private readonly perAddress = new Map<string, number>();
	private connectionCount = 0;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private looking: ReturnType<typeof setInterval> | null = null;
	private applying: Promise<void> = Promise.resolve();
	private vapid: Promise<VapidKeys> | null = null;
	private readonly limits: WebLimits;
	port: number;
	constructor(
		private readonly host: WebHost,
		private readonly deps: WebDeps
	) {
		this.limits = { ...defaultLimits, ...deps.limits };
		this.port = deps.port ?? defaultWebPort;
	}

	// —— configuration and status ——

	/** The tailnet name the passkeys belong to; `localhost` in an e2e run. */
	get rpId(): string | null {
		return this.deps.testHost ? 'localhost' : this.tailscale.host;
	}
	get origin(): string | null {
		if (this.deps.testHost) return `http://localhost:${this.port}`;
		return this.tailscale.host ? `https://${this.tailscale.host}` : null;
	}
	private get on() {
		return this.config.on && this.config.phone && this.host.on();
	}
	configure(config: WebConfig): Promise<void> {
		const run = this.applying.then(() => this.apply(config));
		this.applying = run.catch(() => {});
		return run;
	}
	/** Tailscale asked again (`remote:phone-check`); the listener follows a new name. */
	check(): Promise<void> {
		return this.configure(this.config);
	}
	private readTailscale() {
		return (this.deps.tailscale ?? ((port) => readTailscale(port)))(this.port);
	}
	/** The minute's look at Tailscale; the listener is set up again only when something changed (Funnel, the name). */
	private async lookAgain() {
		if (this.deps.testHost || !this.server) return;
		let state: TailscaleState;
		try {
			state = await this.readTailscale();
		} catch {
			return;
		}
		const was = this.tailscale;
		if (
			state.cli !== was.cli ||
			state.host !== was.host ||
			state.https !== was.https ||
			state.serving !== was.serving ||
			state.funnel !== was.funnel ||
			state.shared !== was.shared
		)
			await this.check();
	}
	private async apply(config: WebConfig) {
		const was = this.config.on && this.config.phone;
		this.config = { ...config };
		const now = config.on && config.phone;
		if (was !== now && this.host.on())
			await this.host.audit.append(now ? 'phone-enabled' : 'phone-disabled');
		if (!now) {
			this.dropAll('off');
			await this.stop();
			this.error = null;
			this.host.changed();
			return;
		}
		const before = this.rpId;
		if (!this.deps.testHost) this.tailscale = await this.readTailscale();
		// A new tailnet name is another origin: sessions of the old one go, and their passkeys no longer sign in.
		if (before && before !== this.rpId) this.dropAll('off');
		this.error = this.deps.bundle ? null : 'The phone bundle is not built (out/renderer-mobile).';
		// spec/remote-access-and-mobile#tailscale-guidance: no CLI at all is its own reason — the settings put the download link next to it.
		if (!this.rpId)
			this.error = this.tailscale.cli
				? 'Tailscale is not running here, or this machine has no name in the tailnet.'
				: 'Tailscale is not found on this machine.';
		else if (this.tailscale.funnel)
			this.error =
				'Tailscale Funnel publishes this address on the internet; turn Funnel off for it.';
		// A page of another service under the same origin could use the passkey and the signed-in socket.
		else if (this.tailscale.shared)
			this.error = `Another service shares https://${this.rpId} through tailscale serve; give it another port.`;
		if (this.error) {
			this.dropAll('off');
			await this.stop();
		} else
			try {
				this.bundle = await loadWebBundle(this.deps.bundle!);
				if (!this.server) await this.listen();
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
				this.host.log(`remote: web listener did not start: ${this.error}`);
				await this.stop();
			}
		this.host.changed();
	}
	status(): RemotePhoneStatus {
		return {
			enabled: this.config.phone,
			listening: this.server !== null,
			port: this.port,
			host: this.rpId,
			tailscale: {
				cli: this.deps.testHost ? true : this.tailscale.cli !== null,
				https: this.deps.testHost ? true : this.tailscale.https || this.tailscale.serving,
				serving: this.deps.testHost ? true : this.tailscale.serving,
				command: tailscaleServeCommand(this.port),
			},
			error: this.config.on && this.config.phone ? this.error : null,
		};
	}
	connected(deviceId: string): boolean {
		return [...this.sessions].some((session) => session.peer.deviceId === deviceId);
	}

	// —— the listener ——

	private listen(): Promise<void> {
		const server = createServer();
		server.headersTimeout = 10_000;
		server.requestTimeout = 10_000;
		server.timeout = 10_000;
		const wss = new WebSocketServer({
			noServer: true,
			maxPayload: pairingFrameLimit,
			perMessageDeflate: { threshold: 1024 },
		});
		server.on('connection', (socket: Socket) => {
			if (this.connectionCount >= this.limits.connections) {
				socket.destroy();
				return;
			}
			this.connectionCount++;
			socket.once('close', () => this.connectionCount--);
		});
		server.on('request', (request, response) => void this.request(request, response));
		server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
			this.upgrade(request, socket, head)
		);
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen({ port: this.port, host: '127.0.0.1', exclusive: true }, () => {
				server.off('error', reject);
				server.on('error', (error) => this.host.log(`remote: web listener: ${error.message}`));
				if (this.port === 0) this.port = (server.address() as AddressInfo).port;
				this.server = server;
				this.wss = wss;
				this.startTimers();
				resolve();
			});
		});
	}
	private async stop() {
		this.stopTimers();
		const server = this.server,
			wss = this.wss;
		this.server = this.wss = null;
		if (wss) {
			// A socket that was told `bye` closes on its own first, so the page reads why (≤ 1 s); the rest go now.
			const closing = [...wss.clients].filter((client) => client.readyState === client.CLOSING);
			await Promise.race([
				Promise.all(closing.map((client) => new Promise((done) => client.once('close', done)))),
				new Promise((done) => setTimeout(done, 1000).unref?.()),
			]);
			for (const client of wss.clients) client.terminate();
			wss.close();
		}
		if (server) {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		this.tickets.clear();
		this.cookies.clear();
	}
	private expectedHost() {
		return { host: this.rpId!, port: this.deps.testHost ? this.port : null };
	}
	private headers() {
		const connect = this.deps.testHost ? `ws://localhost:${this.port}` : `wss://${this.rpId}`;
		return webHeaders(connect, !this.deps.testHost);
	}
	private answer(response: ServerResponse, status: number, extra: Record<string, string> = {}) {
		response.writeHead(status, { ...this.headers(), ...extra, connection: 'close' }).end();
	}
	private async request(request: IncomingMessage, response: ServerResponse) {
		if (!this.on || !this.rpId || !webHostAllowed(request.headers, this.expectedHost()))
			return this.answer(response, 421);
		if (webFunneled(request.headers)) return this.answer(response, 403);
		const path = (request.url ?? '/').split('?')[0]!;
		if (request.method === 'POST' && path === '/session')
			return this.issueCookie(request, response);
		if (request.method !== 'GET' && request.method !== 'HEAD')
			return this.answer(response, 405, { allow: 'GET, HEAD' });
		const file = this.bundle?.files.get(path === '/' ? '/index.html' : path);
		// A file of the app without the cookie of a live sign-in is not there at all: the same 404 as a wrong name.
		if (!file || (!file.public && !this.cookieValid(request))) return this.answer(response, 404);
		let body: Buffer;
		try {
			body = await readFile(file.file);
		} catch {
			return this.answer(response, 404);
		}
		response.writeHead(200, {
			...this.headers(),
			'content-type': file.type,
			'content-length': String(body.length),
			...(path === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
		});
		response.end(request.method === 'HEAD' ? undefined : body);
	}
	/** `POST /session {ticket}` from this machine's page: the cookie that opens the app's files while the sign-in lives. */
	private issueCookie(request: IncomingMessage, response: ServerResponse) {
		if (!webOriginAllowed(request.headers, this.origin!)) return this.answer(response, 403);
		let size = 0;
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > 512) request.destroy();
			else chunks.push(chunk);
		});
		request.on('end', () => {
			let ticket: unknown;
			try {
				ticket = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ticket?: unknown })
					.ticket;
			} catch {
				return this.answer(response, 400);
			}
			const entry = typeof ticket === 'string' ? this.tickets.get(sha256(ticket)) : undefined;
			if (typeof ticket === 'string') this.tickets.delete(sha256(ticket));
			if (!entry || entry.expiresAt <= this.host.now() || !this.sessions.has(entry.session))
				return this.answer(response, 403);
			const cookie = random(32);
			this.cookies.set(sha256(cookie), {
				deviceId: entry.session.peer.deviceId,
				expiresAt: this.host.now() + this.limits.cookieMs,
			});
			this.answer(response, 204, {
				'set-cookie': `${cookieName}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.limits.cookieMs / 1000)}`,
			});
		});
	}
	private cookieValid(request: IncomingMessage): boolean {
		const header = request.headers.cookie ?? '';
		for (const part of header.split(';')) {
			const [name, value] = part.trim().split('=');
			if (name !== cookieName || !value) continue;
			const entry = this.cookies.get(sha256(value));
			if (entry && entry.expiresAt > this.host.now() && this.connected(entry.deviceId)) return true;
		}
		return false;
	}
	private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
		const path = (request.url ?? '').split('?')[0];
		const pairing = path === '/ws/pair';
		if (
			!this.on ||
			!this.rpId ||
			!this.wss ||
			!webHostAllowed(request.headers, this.expectedHost()) ||
			webFunneled(request.headers) ||
			!webOriginAllowed(request.headers, this.origin!) ||
			(path !== '/ws' && !pairing) ||
			(pairing && !this.host.pairing.isOpen)
		) {
			socket.destroy();
			return;
		}
		const from = forwardedFor(request);
		const held = this.perAddress.get(from) ?? 0;
		if (held >= this.limits.connectionsPerAddress) {
			socket.destroy();
			return;
		}
		this.perAddress.set(from, held + 1);
		socket.once('close', () => {
			const left = (this.perAddress.get(from) ?? 1) - 1;
			if (left > 0) this.perAddress.set(from, left);
			else this.perAddress.delete(from);
		});
		const address: RemoteAddress = {
			network: this.deps.testHost ? 'loopback' : 'tailscale',
			address: from,
		};
		this.wss.handleUpgrade(request, socket, head, (ws) => {
			// A frame over the limit: ws closes the socket and then emits `error` (as on the gateway).
			ws.on('error', () => {});
			if (pairing) this.acceptPair(ws, address);
			else this.acceptLogin(ws, address);
		});
	}
	private startTimers() {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			for (const session of this.sessions) {
				// While frames wait, the socket reads nothing — pongs neither; the outbox's drain clock decides (spec/remote-access-and-mobile#outbox).
				if (session.outbox.backlogged) continue;
				if (!session.alive) {
					session.ws.terminate();
					continue;
				}
				session.alive = false;
				session.ws.ping();
			}
			const now = this.host.now();
			for (const [token, entry] of this.resume)
				if (entry.expiresAt !== null && entry.expiresAt <= now) this.resume.delete(token);
			for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
			for (const [key, entry] of this.cookies) if (entry.expiresAt <= now) this.cookies.delete(key);
		}, heartbeatMs);
		this.heartbeat.unref?.();
		if (!this.deps.testHost) {
			this.looking = setInterval(() => void this.lookAgain(), this.limits.tailscaleMs);
			this.looking.unref?.();
		}
	}
	private stopTimers() {
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.looking) clearInterval(this.looking);
		this.heartbeat = this.looking = null;
	}

	// —— pairing: the code, then a passkey ——

	private acceptPair(ws: WebSocket, from: RemoteAddress) {
		const pairing = this.host.pairing;
		const send = (message: WebMessage) => {
			if (ws.readyState === ws.OPEN) ws.send(encodeFrame(message));
		};
		const refuse = (reason: WebPairRefusal, attemptsLeft: number | null = null) => {
			send({ t: 'pair-refused', reason, attemptsLeft });
			ws.close(4001, reason);
		};
		if (pairing.busy) return refuse('busy');
		const code = pairing.code,
			origin = this.origin,
			rpId = this.rpId;
		if (!code || !origin || !rpId) return refuse('closed');
		this.pairSockets.add(ws);
		let holds = false;
		ws.once('close', () => {
			this.pairSockets.delete(ws);
			if (holds) pairing.busy = false;
		});
		let step = setTimeout(() => ws.terminate(), this.limits.stepMs);
		step.unref?.();
		const restep = (ms: number) => {
			clearTimeout(step);
			step = setTimeout(() => ws.terminate(), ms);
			step.unref?.();
		};
		const sid = randomBytes(16);
		const ci = webChannelIdentifier(origin);
		const utf8 = (text: string) => new TextEncoder().encode(text);
		let stage: 'a' | 'confirm' | 'credential' | 'waiting' = 'a';
		let party: CPaceParty | null = null;
		let device = '';
		let ceremony: { challenge: Uint8Array; userId: string } | null = null;
		const { address, network } = from;
		send({
			t: 'pair-hello',
			v: webProtocolVersion,
			sid: Buffer.from(sid).toString('base64'),
			machine: this.host.machineName(),
		});
		ws.on('message', (data, binary) => {
			let message: unknown;
			try {
				if (binary) throw new Error('binary');
				message = decodeFrame(data.toString());
			} catch {
				return void ws.close(4002, 'protocol');
			}
			if (!isWebPairClientMessage(message)) return void ws.close(4002, 'protocol');
			if (message.t === 'pair-a' && stage === 'a') {
				restep(this.limits.stepMs);
				if (!isMachineName(message.device)) return void ws.close(4002, 'protocol');
				if (pairing.busy) return refuse('busy');
				pairing.busy = holds = true;
				if (!pairing.spend())
					return refuse(
						pairing.current.state === 'exhausted' || pairing.attemptsLeft === 0
							? 'exhausted'
							: 'closed'
					);
				device = message.device;
				party = new CPaceParty(
					'responder',
					{ prs: utf8(normalizePairingCode(code)), ci, sid },
					utf8(this.host.machineName())
				);
				try {
					party.finish(Uint8Array.from(Buffer.from(message.share, 'base64')), utf8(device));
				} catch {
					pairing.failed();
					return void ws.close(4002, 'protocol');
				}
				stage = 'confirm';
				send({
					t: 'pair-b',
					share: Buffer.from(party.share).toString('base64'),
					tag: Buffer.from(party.tag()).toString('base64'),
				});
				return;
			}
			if (message.t === 'pair-confirm' && stage === 'confirm' && party) {
				const matched = party.verify(Uint8Array.from(Buffer.from(message.tag, 'base64')));
				party = null;
				if (!matched) {
					const left = pairing.attemptsLeft;
					if (left <= 0) ws.once('close', () => pairing.failed());
					void this.host.audit.append('pairing-failed', {
						device,
						address,
						network,
						detail: `${left} left`,
					});
					this.host.notice({
						kind: 'pairing-failed',
						device,
						address,
						network,
						at: new Date(this.host.now()).toISOString(),
					});
					return refuse(left > 0 ? 'code' : 'exhausted', left);
				}
				// The code matched: a passkey for this machine's name, made when the person taps (Safari wants a gesture).
				stage = 'credential';
				restep(webCeremonyMs);
				ceremony = { challenge: randomBytes(32), userId: random(16) };
				send({
					t: 'pair-register',
					options: {
						challenge: toBase64Url(ceremony.challenge),
						rpId,
						rpName: this.host.machineName(),
						userId: ceremony.userId,
						userName: device,
						algorithms: [...passkeyAlgorithms],
						timeoutMs: webCeremonyMs,
					},
				});
				return;
			}
			if (message.t === 'pair-credential' && stage === 'credential' && ceremony) {
				let passkey: PasskeyRecord;
				try {
					passkey = verifyRegistration(
						{
							id: message.id,
							clientDataJSON: fromBase64Url(message.clientDataJSON),
							attestationObject: fromBase64Url(message.attestationObject),
						},
						{ challenge: ceremony.challenge, origin, rpId, userId: ceremony.userId }
					);
				} catch (error) {
					void this.host.audit.append('pairing-failed', {
						device,
						address,
						network,
						detail: `passkey: ${error instanceof WebAuthnError ? error.reason : 'invalid'}`,
					});
					return refuse('passkey');
				}
				ceremony = null;
				stage = 'waiting';
				clearTimeout(step);
				// spec/remote-access-and-mobile#phone-app: the name the person gave after the code matched; the machine still confirms or renames it.
				if (message.device !== undefined) device = message.device;
				const id = passkeyDeviceId(passkey.credentialId);
				send({ t: 'pair-wait' });
				void pairing.matched(device, '', id, address, network).then(async ({ accept, name }) => {
					if (!accept || ws.readyState !== ws.OPEN) {
						// The answer first: closing the window terminates the pairing sockets still open.
						refuse('declined');
						if (pairing.current.state === 'confirm') pairing.declined();
						await this.host.audit.append('pairing-declined', {
							device,
							deviceId: id,
							address,
							network,
						});
						return;
					}
					const named = name ?? device;
					await (await this.host.registry()).addPhone(named, passkey);
					await this.host.audit.append('paired', {
						device: named,
						deviceId: id,
						address,
						network,
						detail: 'phone',
					});
					this.host.notice({
						kind: 'paired',
						device: named,
						address,
						network,
						at: new Date(this.host.now()).toISOString(),
					});
					send({ t: 'paired', machine: this.host.machineName() });
					ws.close(1000, 'paired');
					pairing.paired(named);
					this.host.changed();
				});
				return;
			}
			ws.close(4002, 'protocol');
		});
	}
	/** The pairing window closed: a page still in it goes. */
	pairingClosed() {
		for (const ws of this.pairSockets) if (ws.readyState === ws.OPEN) ws.terminate();
	}
	/** The signed-in phone with this peer id (the audit of a refused call names it). */
	peer(peerId: string): WebPeer | null {
		return [...this.sessions].find((session) => session.peer.id === peerId)?.peer ?? null;
	}

	// —— sign-in and the session ——

	private acceptLogin(ws: WebSocket, address: RemoteAddress) {
		let session: Session | null = null;
		let busy = false;
		const send = (message: WebMessage) => {
			if (ws.readyState === ws.OPEN) ws.send(encodeFrame(message));
		};
		const timer = setTimeout(() => ws.terminate(), this.limits.sessionlessMs);
		timer.unref?.();
		ws.on('close', () => {
			clearTimeout(timer);
			for (const item of [...this.sessions]) if (item.ws === ws) this.leave(item);
		});
		ws.on('pong', () => {
			if (session) session.alive = true;
		});
		const challenge = randomBytes(32);
		send({
			t: 'challenge',
			v: webProtocolVersion,
			challenge: toBase64Url(challenge),
			rpId: this.rpId!,
			timeoutMs: this.limits.sessionlessMs,
		});
		ws.on('message', (data, binary) => {
			if (binary) return void ws.close(4002, 'protocol');
			const raw = data.toString();
			let message: unknown;
			try {
				if (!session && raw.length > 16_384) throw new Error('too long');
				message = decodeFrame(raw);
			} catch {
				return void ws.close(4002, 'protocol');
			}
			if (!isWebClientMessage(message)) return void ws.close(4002, 'protocol');
			if (!session) {
				// One challenge, one try per connection: the page opens a new one after a refusal.
				if ((message.t !== 'assert' && message.t !== 'resume') || busy)
					return void ws.close(4002, 'protocol');
				busy = true;
				void this.signIn(ws, message, challenge, address).then(
					(made) => {
						if (!made) return;
						clearTimeout(timer);
						session = made;
					},
					(error: unknown) => {
						this.host.log(
							`remote: phone sign-in failed: ${error instanceof Error ? error.message : String(error)}`
						);
						ws.close(1011, 'error');
					}
				);
				return;
			}
			const current = session;
			this.handle(current, message, (reply) => void current.outbox.send(encodeFrame(reply)));
		});
	}
	private refuse(ws: WebSocket, reason: WebLoginRefusal, retryAfterMs: number | null = null) {
		if (ws.readyState === ws.OPEN)
			ws.send(encodeFrame({ t: 'refused', reason, retryAfterMs } satisfies WebMessage));
		ws.close(4001, reason);
		return null;
	}
	private async signIn(
		ws: WebSocket,
		message: Extract<WebMessage, { t: 'assert' } | { t: 'resume' }>,
		challenge: Uint8Array,
		address: RemoteAddress
	): Promise<Session | null> {
		const registry = await this.host.registry();
		if (!this.on) return this.refuse(ws, 'off');
		let deviceId: string;
		if (message.t === 'resume') {
			// Spent at once: the same token on two sockets signs in once.
			const entry = this.resume.get(sha256(message.token));
			this.resume.delete(sha256(message.token));
			if (!entry || (entry.expiresAt !== null && entry.expiresAt <= this.host.now()))
				return this.refuse(ws, 'expired');
			deviceId = entry.deviceId;
		} else
			try {
				deviceId = passkeyDeviceId(message.id);
			} catch {
				return this.refuse(ws, 'unknown');
			}
		const device = registry.get(deviceId);
		const who = {
			device: device?.name ?? null,
			deviceId,
			address: address.address,
			network: address.network,
		};
		// A key of no phone here, or of a machine name that changed since (the browser would not offer it then).
		if (
			!device ||
			device.kind !== 'phone' ||
			!device.passkey ||
			device.passkey.rpId !== this.rpId
		) {
			this.host.noisy('login-refused', { ...who, detail: 'unknown passkey' });
			return this.refuse(ws, 'unknown');
		}
		if (device.blocked) {
			this.host.noisy('login-refused', { ...who, detail: 'blocked' });
			return this.refuse(ws, 'blocked');
		}
		const at = new Date(this.host.now()).toISOString();
		const where = { device: device.name, address: address.address, network: address.network };
		if (message.t === 'assert') {
			const pause = passwordPauseMs(device.failures);
			const since = device.lastFailureAt
				? this.host.now() - Date.parse(device.lastFailureAt)
				: Infinity;
			if (since < pause || this.checking.has(deviceId)) {
				this.host.noisy('login-refused', { ...who, detail: since < pause ? 'pause' : 'busy' });
				return this.refuse(ws, 'wait', since < pause ? pause - since : 1000);
			}
			this.checking.add(deviceId);
			try {
				let signCount: number;
				try {
					({ signCount } = verifyAssertion(
						{
							id: message.id,
							clientDataJSON: fromBase64Url(message.clientDataJSON),
							authenticatorData: fromBase64Url(message.authenticatorData),
							signature: fromBase64Url(message.signature),
							userHandle: message.userHandle ? fromBase64Url(message.userHandle) : null,
						},
						device.passkey,
						{ challenge, origin: this.origin!, rpId: this.rpId! }
					));
				} catch (error) {
					const reason = error instanceof WebAuthnError ? error.reason : 'invalid';
					const failed = await registry.update(deviceId, (item) => {
						item.failures += 1;
						item.lastFailureAt = new Date(this.host.now()).toISOString();
						if (item.failures >= blockAfterFailures) item.blocked = true;
					});
					await this.host.audit.append('login-failed', {
						...who,
						detail: `passkey: ${reason}, ${failed?.failures ?? blockAfterFailures} in a row`,
					});
					this.host.notice({ kind: 'failed', ...where, at });
					if (failed?.blocked) {
						await this.host.audit.append('blocked', who);
						this.host.notice({ kind: 'blocked', ...where, at });
						this.host.changed();
						return this.refuse(ws, 'blocked');
					}
					this.host.changed();
					return this.refuse(ws, 'passkey', passwordPauseMs(failed?.failures ?? 0));
				}
				await registry.update(deviceId, (item) => {
					item.failures = 0;
					item.lastFailureAt = null;
					if (item.passkey) item.passkey.signCount = signCount;
				});
			} finally {
				this.checking.delete(deviceId);
			}
		}
		// Lost the race with revocation, a block or the switch going off: answered and closed. Checked again after the
		// last write, right before the session opens: a session for a revoked phone or a closed socket never stays.
		const raced = (): boolean => {
			if (ws.readyState !== ws.OPEN) return true;
			const current = registry.get(deviceId);
			const reason: WebLoginRefusal | null =
				!this.on || !this.server
					? 'off'
					: !current || current.kind !== 'phone'
						? 'unknown'
						: current.blocked
							? 'blocked'
							: null;
			if (reason) this.refuse(ws, reason);
			return reason !== null;
		};
		if (raced()) return null;
		await registry.update(deviceId, (item) => {
			item.lastLoginAt = new Date(this.host.now()).toISOString();
			item.lastAddress = address;
		});
		if (raced()) return null;
		if (!raiseFrameLimit(ws, gatewayFrameLimit))
			this.host.log('remote: could not raise the web frame limit; frames stay at 16 KB');
		for (const [token, entry] of this.resume)
			if (entry.deviceId === deviceId) this.resume.delete(token);
		const resume = random(32);
		this.resume.set(sha256(resume), { deviceId, expiresAt: null });
		const session = this.open(ws, registry.get(deviceId)!, address);
		const ticket = random(32);
		this.tickets.set(sha256(ticket), {
			session,
			expiresAt: this.host.now() + this.limits.ticketMs,
		});
		await this.host.audit.append('login', {
			...who,
			detail: message.t === 'resume' ? 'passkey, resumed' : 'passkey',
		});
		this.host.notice({ kind: 'connected', ...where, at });
		let push: string | null = null;
		try {
			push = (await this.vapidKeys()).publicKey;
		} catch (error) {
			this.host.log(
				`remote: Web Push key: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		send(ws, {
			t: 'welcome',
			machine: this.host.machineName(),
			device: device.name,
			resume,
			ticket,
			app: this.bundle?.app ?? { script: '/assets/app.js', styles: [] },
			push,
			version: this.deps.version ?? '',
		});
		this.host.changed();
		return session;
	}
	private vapidKeys() {
		this.vapid ??= loadVapidKeys(this.host.files, this.host.vault()).catch((error: unknown) => {
			this.vapid = null;
			throw error;
		});
		return this.vapid;
	}
	private open(ws: WebSocket, device: DeviceRecord, address: RemoteAddress): Session {
		const channels = new Set<string>();
		const peer: WebPeer = {
			id: `web:${randomBytes(8).toString('hex')}`,
			kind: 'phone',
			deviceId: device.id,
			deviceName: device.name,
			address,
			send: (channel, value, droppable = false) => {
				if (ws.readyState !== ws.OPEN || !channels.has(channel) || !webEventAllowed(channel))
					return false;
				// Text frames only: the page decodes JSON with base64 inside, never the binary frames of spec/remote-access-and-mobile#browser-from-device.
				return session.outbox.send(
					encodeFrame({ t: 'event', channel, value } satisfies WebMessage),
					{ droppable }
				);
			},
		};
		const session: Session = {
			peer,
			ws,
			outbox: new Outbox(
				ws,
				() => {
					this.bye(session, 'slow');
					// What it did not read stays unread: the socket goes now, not after the close handshake's 30 s.
					ws.terminate();
				},
				this.limits.outbox,
				() => {
					session.alive = true;
				}
			),
			detach: () => {},
			inflight: 0,
			channels,
			alive: true,
		};
		this.sessions.add(session);
		session.detach = this.host.attach(peer);
		return session;
	}
	private handle(session: Session, message: WebMessage, reply: (message: WebMessage) => void) {
		switch (message.t) {
			case 'invoke': {
				if (session.inflight >= inflightLimit) {
					reply({ t: 'result', id: message.id, ok: false, error: 'Too many calls at once.' });
					return;
				}
				session.inflight++;
				const call = () =>
					Promise.resolve()
						.then(() => this.host.dispatch(session.peer, message.channel, message.args))
						.then(
							(value) => reply({ t: 'result', id: message.id, ok: true, value }),
							(error: unknown) =>
								reply({
									t: 'result',
									id: message.id,
									ok: false,
									error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
								})
						)
						.catch((error: unknown) =>
							reply({ t: 'result', id: message.id, ok: false, error: String(error).slice(0, 4096) })
						);
				// A file, its highlighting, a diff: one at a time, after the socket drained (spec/remote-access-and-mobile#outbox).
				void (isBulkCall(message.channel) ? session.outbox.serial(call) : call()).finally(() => {
					session.inflight--;
				});
				return;
			}
			case 'subscribe':
				session.channels.clear();
				for (const channel of message.channels)
					if (webEventAllowed(channel)) session.channels.add(channel);
				return;
			case 'push':
				void this.savePush(session, message.subscription).then(
					(error) => reply({ t: 'push-saved', ok: error === null, error }),
					() => reply({ t: 'push-saved', ok: false, error: 'The subscription was not saved.' })
				);
				return;
			case 'ping':
				reply({ t: 'pong', at: message.at });
				return;
			default:
				session.ws.close(4002, 'protocol');
		}
	}
	/** spec/remote-access-and-mobile#phone-network: the phone's subscription, from a push service browsers use only; null forgets it. */
	private async savePush(
		session: Session,
		subscription: Extract<WebMessage, { t: 'push' }>['subscription']
	): Promise<string | null> {
		if (subscription && !isPushSubscription(subscription, this.deps.push?.hosts))
			return 'Not a push service this machine sends to.';
		const registry = await this.host.registry();
		const current = registry.get(session.peer.deviceId);
		if (!current) return 'This phone is not paired.';
		// The same subscription again is not a change — no write, no line.
		const key = (item: typeof subscription | undefined) =>
			item ? `${item.endpoint} ${item.p256dh} ${item.auth}` : '';
		if (key(current.push) === key(subscription)) return null;
		const updated = await registry.update(session.peer.deviceId, (item) => {
			item.push = subscription ? { ...subscription } : null;
		});
		if (!updated) return 'This phone is not paired.';
		// A page can repeat it at will: within the budget of what a device repeats.
		this.host.noisy(subscription ? 'push-subscribed' : 'push-removed', {
			device: session.peer.deviceName,
			deviceId: session.peer.deviceId,
			address: session.peer.address.address,
			network: session.peer.address.network,
			detail: subscription ? new URL(subscription.endpoint).hostname : null,
		});
		return null;
	}
	private leave(session: Session) {
		if (!this.sessions.delete(session)) return;
		session.outbox.close();
		session.detach();
		for (const entry of this.resume.values())
			if (entry.deviceId === session.peer.deviceId && entry.expiresAt === null)
				entry.expiresAt = this.host.now() + resumeMs;
		for (const [key, entry] of this.tickets)
			if (entry.session === session) this.tickets.delete(key);
		const fields = {
			device: session.peer.deviceName,
			deviceId: session.peer.deviceId,
			address: session.peer.address.address,
			network: session.peer.address.network,
		};
		void this.host.audit.append('disconnected', fields);
		this.host.notice({
			kind: 'disconnected',
			device: fields.device,
			address: fields.address,
			network: fields.network,
			at: new Date(this.host.now()).toISOString(),
		});
		this.host.changed();
	}
	private bye(session: Session, reason: WebByeReason) {
		if (session.ws.readyState === session.ws.OPEN)
			session.ws.send(encodeFrame({ t: 'bye', reason } satisfies WebMessage));
		session.ws.close(4003, reason);
		this.leave(session);
	}
	/** Revoked or dropped: its sessions, resume tokens and bundle cookies go now. */
	forget(deviceId: string, reason: WebByeReason) {
		for (const [token, entry] of this.resume)
			if (entry.deviceId === deviceId) this.resume.delete(token);
		for (const [key, entry] of this.cookies)
			if (entry.deviceId === deviceId) this.cookies.delete(key);
		for (const session of [...this.sessions])
			if (session.peer.deviceId === deviceId) this.bye(session, reason);
	}
	dropAll(reason: WebByeReason) {
		this.resume.clear();
		this.cookies.clear();
		this.tickets.clear();
		for (const session of [...this.sessions]) this.bye(session, reason);
		for (const ws of this.pairSockets) ws.terminate();
	}

	// —— Web Push ——

	/**
	 * spec/remote-access-and-mobile#phone: tells every subscribed phone that a task needs it — the task's name and the kind, nothing more. Nothing
	 * goes while the module, access or the phone's switch is off. A subscription the service forgot is dropped.
	 */
	async push(type: PushKind, task: string, key: string): Promise<void> {
		if (!this.config.on || !this.config.phone || !this.host.on() || !this.rpId) return;
		const registry = await this.host.registry();
		const phones = registry.list().filter((device) => device.kind === 'phone' && device.push);
		if (!phones.length) return;
		let keys: VapidKeys;
		try {
			keys = await this.vapidKeys();
		} catch (error) {
			this.host.log(
				`remote: Web Push key: ${error instanceof Error ? error.message : String(error)}`
			);
			return;
		}
		await Promise.all(
			phones.map(async (device) => {
				const subscription = device.push!;
				const result = await sendPush(subscription, { task: task.slice(0, 200), type, key }, keys, {
					subject: this.deps.testHost ? 'https://localhost' : `https://${this.rpId}`,
					...(this.deps.push?.fetch ? { fetch: this.deps.push.fetch } : {}),
					...(this.deps.push?.hosts ? { hosts: this.deps.push.hosts } : {}),
				});
				if (result === 'gone') {
					await registry.update(device.id, (item) => {
						if (item.push?.endpoint === subscription.endpoint) item.push = null;
					});
					await this.host.audit.append('push-removed', {
						device: device.name,
						deviceId: device.id,
						detail: 'gone',
					});
				} else if (result === 'failed') this.host.log(`remote: Web Push to ${device.name} failed`);
			})
		);
	}
	async close() {
		this.dropAll('shutdown');
		await this.stop();
	}
}
function send(ws: WebSocket, message: WebMessage) {
	if (ws.readyState === ws.OPEN) ws.send(encodeFrame(message));
}
