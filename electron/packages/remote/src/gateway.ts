/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#transport-and-protocol, spec/diff-and-review#snapshots: the working machine's side of remote access.
 *
 * - The gateway (port 7420): TLS 1.3 with mutual authentication; the only trust anchors are the certificates of paired
 *   devices, so an unknown certificate is dropped in the handshake, before any application byte (layer 1), and the
 *   exact fingerprint is checked again on the socket (layer 2). Over it a WebSocket; the first frame must be `login`
 *   with the password (or a resume token of the same device) and the table hash of the same build.
 * - The pairing listener (port 7421): open only for the 5-minute pairing window, takes any client certificate, knows
 *   only the CPace pairing run, whose channel identifier binds both TLS certificates (spec/remote-access-and-mobile#pairing).
 * - Both listen on named LAN and Tailscale addresses only (spec/remote-access-and-mobile#architecture).
 *
 * Main gives the calls to the same handlers and validators as the local window (`dispatch`), adds every connection to
 * its client set (`attach`) and draws the cover from `control`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	isBulkCall,
	isMachineName,
	isRemotePassword,
	normalizePairingCode,
	type RemoteAccessStatus,
	type RemoteAddress,
	type RemoteControl,
	type RemoteNetwork,
	type RemoteDevice,
	type RemoteNotice,
	type RemotePairing,
} from '@brigadir/core';
import { certificateDer, fingerprintOf, isPeerCertificate, type Identity } from './cert';
import { CPaceParty, lvCat } from './cpace';
import { decodeFrame, encodeBinaryFrame, encodeFrame } from './codec';
import { listenAddresses } from './interfaces';
import { PairingWindow } from './pairing';
import { WebGateway, type WebDeps, type WebHost } from './web-gateway';
import { Outbox, type OutboxLimits } from './outbox';
import type { PushKind } from './web-push';
import {
	blockAfterFailures,
	hashPassword,
	passwordPauseMs,
	verifyPassword,
	type PasswordHash,
} from './password';
import {
	connectionLimit,
	connectionsPerAddress,
	defaultPairingPort,
	defaultPort,
	gatewayFrameLimit,
	handshakeTimeoutMs,
	isGatewayClientMessage,
	isPairClientMessage,
	loginTimeoutMs,
	pairingFrameLimit,
	pairingStepTimeoutMs,
	protocolVersion,
	type ByeReason,
	type GatewayMessage,
	type LoginRefusal,
	type MachineInfo,
	type PairMessage,
} from './protocol';
import {
	AuditLog,
	DeviceRegistry,
	deviceExpiresAt,
	loadIdentity,
	readPassword,
	writePassword,
	type DeviceRecord,
	type KeyVault,
	type RemoteFiles,
} from './store';

/** One logged-in connection from a paired device. Main wraps it into a `Client`. */
export interface RemotePeer {
	readonly id: string;
	/** spec/remote-access-and-mobile#phone-network: a phone signed in on the web listener; absent — a computer on the gateway. */
	readonly kind?: 'computer' | 'phone';
	readonly deviceId: string;
	readonly deviceName: string;
	readonly address: RemoteAddress;
	/**
	 * Sends an event if the device subscribed to its channel; false when it did not or the connection is gone. A value with
	 * bytes goes as a binary frame (spec/remote-access-and-mobile#browser-from-device); a `droppable` one (a video or screencast frame) is left out — false —
	 * while the connection still holds more than `streamBacklog` of unsent data, instead of queuing behind it.
	 */
	send(channel: string, value: unknown, droppable?: boolean): boolean;
}
export type GatewayConfig = {
	/** The `remoteAccess` module (spec/remote-access-and-mobile#module-and-settings). */
	module: boolean;
	enabled: boolean;
	machineName: string | null;
	listen: { lan: boolean; tailscale: boolean };
	/** spec/remote-access-and-mobile#phone-network: the web listener for a phone. */
	phone: boolean;
};
export type GatewayDeps = {
	files: RemoteFiles;
	/** Called only when the identity is first needed: turning access on touches the key store, a fresh start does not. */
	vault: () => KeyVault;
	tableHash: string;
	defaultName: string;
	dispatch(peer: RemotePeer, channel: string, args: unknown[]): Promise<unknown>;
	/** A peer logged in; the returned function forgets it. */
	attach(peer: RemotePeer): () => void;
	/** Something in `status()` changed. */
	changed(): void;
	/** Who controls the machine changed (spec/remote-access-and-mobile#architecture). */
	controlChanged(): void;
	notice(notice: RemoteNotice): void;
	log(line: string): void;
	/**
	 * spec/remote-access-and-mobile#architecture: someone works at the machine now (its window in front and in use). A login without `takeOver` is then
	 * refused with `local` so the device can ask «Take control?»; with nobody there it takes control at once. Absent — nobody.
	 */
	localPresent?: () => boolean;
	now?: () => number;
	port?: number;
	pairingPort?: number;
	/** Where to listen; the default reads the interfaces (LAN, Tailscale). Tests and the two-instance e2e use loopback. */
	addresses?: (listen: GatewayConfig['listen']) => RemoteAddress[];
	/** scrypt cost; tests lower it. */
	scrypt?: { N: number; r: number; p: number };
	/** How often interfaces are read again (Wi-Fi changed, Tailscale came up). */
	rescanMs?: number;
	/** Timeouts and connection caps (spec/remote-access-and-mobile#pairing); tests lower them. */
	limits?: Partial<GatewayLimits>;
	/** spec/remote-access-and-mobile#phone-network: the phone's web listener — its bundle, port and e2e switches. */
	web?: WebDeps;
};
export type GatewayLimits = {
	/** TLS handshake, and the wait for the upgrade request after it. */
	handshakeMs: number;
	/** A WebSocket without a session closes this long after it opened. */
	sessionlessMs: number;
	/** Each pairing step before the person's confirmation. */
	pairingStepMs: number;
	connections: number;
	connectionsPerAddress: number;
	/** What a logged-in device may hold unsent (spec/remote-access-and-mobile#outbox); tests lower it. */
	outbox: Partial<OutboxLimits>;
};
const defaultLimits: GatewayLimits = {
	handshakeMs: handshakeTimeoutMs,
	sessionlessMs: loginTimeoutMs,
	pairingStepMs: pairingStepTimeoutMs,
	connections: connectionLimit,
	connectionsPerAddress,
	outbox: {},
};
/** A resume token lets the same device back in after a network blip without the password, for 15 minutes. */
const resumeMs = 15 * 60_000;
/** Pending calls per connection; more is a misbehaving client. */
const inflightLimit = 64;
export { streamBacklog } from './outbox';
/** One `tls-rejected` line per address per minute: a scanner must not grow the audit without bound. */
const rejectionQuietMs = 60_000;
/**
 * Lines of one noisy kind per minute over all addresses; the rest are counted and written as one line when the minute
 * ends. Without it, a knock from many addresses (or a cert holder's refused logins) rotated the real lines out of
 * `audit.jsonl` and flooded the notices (security review R1, S3). The same holds for what a device repeats at will
 * (spec/remote-access-and-mobile#pairing, S9).
 */
const noisyPerMinute = 20;
const noisyKinds = [
	'login-refused',
	'tls-rejected',
	'version-mismatch',
	'call-refused',
	'settings-changed',
	'took-over',
	// spec/remote-access-and-mobile#phone-network: a phone's page can repeat its push subscription at will (security review W0, W4).
	'push-subscribed',
	'push-removed',
] as const;
type NoisyKind = (typeof noisyKinds)[number];
const heartbeatMs = 20_000;

type Listener = { address: RemoteAddress; server: Server; wss: WebSocketServer };
type Session = {
	peer: RemotePeer;
	ws: WebSocket;
	/** Every frame after `welcome`, bounded (spec/remote-access-and-mobile#outbox). */
	outbox: Outbox;
	deviceId: string;
	detach: () => void;
	inflight: number;
	channels: Set<string>;
	alive: boolean;
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const utf8 = (text: string) => new TextEncoder().encode(text);
const bracketless = (address: string) => address.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
/**
 * Before login a frame is at most 16 KB (spec/remote-access-and-mobile#pairing); `ws` fixes `maxPayload` for a connection when it opens, so the
 * login raises it on its own connection. These are ws 8's fields (pinned in package.json): the receiver's limit and the
 * one `permessage-deflate` checks while it inflates. A test sends a big frame before and after login, so a ws that
 * renamed them fails there; until then the connection stays at the small limit rather than the large one.
 */
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

export class RemoteGateway {
	private config: GatewayConfig = {
		module: false,
		enabled: false,
		machineName: null,
		listen: { lan: true, tailscale: true },
		phone: false,
	};
	private identity: Identity | null = null;
	private registry: DeviceRegistry | null = null;
	private password: PasswordHash | null | undefined = undefined;
	private readonly audit: AuditLog;
	private listeners: Listener[] = [];
	private pairingListeners: Listener[] = [];
	private readonly sessions = new Set<Session>();
	private readonly resume = new Map<string, { deviceId: string; expiresAt: number | null }>();
	/**
	 * Devices whose password is being checked now. One check at a time per device: parallel logins would all pass the pause
	 * before the first wrong one is counted and run past the block (security review R1, S1).
	 */
	private readonly checking = new Set<string>();
	private readonly rejections = new Map<string, number>();
	/** Open TCP connections per remote address on every listener, and their sum (spec/remote-access-and-mobile#pairing, S6). */
	private readonly perAddress = new Map<string, number>();
	/** Addresses with a pairing connection open now: one run per address (S5). */
	private readonly pairingFrom = new Set<string>();
	private connectionCount = 0;
	private readonly limits: GatewayLimits;
	private readonly noise = new Map<NoisyKind, { since: number; written: number; held: number }>();
	/** Module switches are logged from the second `configure` on: the first is the app starting (spec/remote-access-and-mobile#pairing). */
	private configured = false;
	private activeId: string | null = null;
	private error: string | null = null;
	private rescan: ReturnType<typeof setInterval> | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private applying: Promise<void> = Promise.resolve();
	readonly pairing: PairingWindow;
	/** spec/remote-access-and-mobile#phone-network: the phone's web listener, on the same registry, audit and pairing window. */
	readonly web: WebGateway;
	private readonly now: () => number;
	/** 0 in tests: the first listener's port is kept for the rest. */
	port: number;
	pairingPort: number;
	constructor(private readonly deps: GatewayDeps) {
		this.now = deps.now ?? Date.now;
		this.limits = { ...defaultLimits, ...deps.limits };
		this.port = deps.port ?? defaultPort;
		this.pairingPort = deps.pairingPort ?? defaultPairingPort;
		this.audit = new AuditLog(deps.files, this.now);
		this.audit.onError = (error) => deps.log(`remote: audit: ${error.message}`);
		this.pairing = new PairingWindow((state, reason) => {
			if (reason === 'expired') void this.audit.append('pairing-expired');
			if (reason === 'exhausted') void this.audit.append('pairing-exhausted');
			if (state.state !== 'open' && state.state !== 'confirm') {
				void this.closePairingListeners();
				this.web?.pairingClosed();
			}
			this.deps.changed();
		}, this.now);
		this.web = new WebGateway(this.webHost(), deps.web ?? { bundle: null });
	}
	/** What the web listener shares with the gateway (spec/remote-access-and-mobile#phone-network). */
	private webHost(): WebHost {
		return {
			pairing: this.pairing,
			audit: this.audit,
			files: this.deps.files,
			vault: () => this.deps.vault(),
			on: () => this.on,
			machineName: () => this.machineName,
			registry: () => this.requireRegistry(),
			noisy: (kind, fields) => void this.noisy(kind, fields),
			notice: (notice) => this.deps.notice(notice),
			changed: () => this.deps.changed(),
			dispatch: (peer, channel, args) => this.deps.dispatch(peer, channel, args),
			attach: (peer) => this.deps.attach(peer),
			log: (line) => this.deps.log(line),
			now: () => this.now(),
		};
	}
	/** spec/remote-access-and-mobile#phone: a Web Push to the subscribed phones. */
	pushPhones(type: PushKind, task: string, key: string): Promise<void> {
		return this.web.push(type, task, key);
	}

	// —— configuration ——

	/** Applies the settings: starts, rebinds or stops the listeners. Turning access or the module off drops everyone. */
	configure(config: GatewayConfig): Promise<void> {
		const run = this.applying
			.then(() => this.apply(config))
			.then(() => this.web.configure({ on: config.module && config.enabled, phone: config.phone }));
		this.applying = run.catch(() => {});
		return run;
	}
	private get on() {
		return this.config.module && this.config.enabled;
	}
	private async apply(config: GatewayConfig) {
		const wasOn = this.on;
		const moduleChanged = this.configured && config.module !== this.config.module;
		this.configured = true;
		const listenChanged = JSON.stringify(config.listen) !== JSON.stringify(this.config.listen);
		const renamed = config.machineName !== this.config.machineName;
		this.config = { ...config, listen: { ...config.listen } };
		// The devices and the password are plain files: Settings ▸ Remote lists and revokes devices with access off too.
		// The key store is touched only when access turns on (`prepare`).
		if (config.module)
			try {
				await this.loadFiles();
			} catch (error) {
				this.deps.log(`remote: ${error instanceof Error ? error.message : String(error)}`);
			}
		if (moduleChanged)
			await this.audit.append(config.module ? 'module-enabled' : 'module-disabled');
		if (!this.on) {
			if (wasOn) {
				this.dropAll('off');
				this.pairing.close();
				await this.audit.append('access-disabled', {
					detail: config.module ? null : 'module off',
				});
			}
			await this.closeListeners();
			this.stopTimers();
			this.error = null;
			this.deps.changed();
			return;
		}
		try {
			await this.prepare();
			if (!this.password) throw new Error('Set a password for remote access first.');
			if (!wasOn) await this.audit.append('access-enabled');
			if (!wasOn || listenChanged || !this.listeners.length) await this.bind();
			if (renamed && wasOn) await this.audit.append('renamed', { detail: this.machineName });
			this.startTimers();
			this.error = this.listeners.length ? null : this.error;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.deps.log(`remote: gateway did not start: ${this.error}`);
			await this.closeListeners();
		}
		this.deps.changed();
	}
	/** Loads the identity (the key store), the registry and the password, once. */
	private async prepare() {
		this.identity ??= await loadIdentity(this.deps.files, this.deps.vault());
		await this.loadFiles();
	}
	/** The registry (forgetting devices idle for 30 days) and the password hash. */
	private async loadFiles() {
		this.registry ??= await DeviceRegistry.open(this.deps.files, this.now);
		if (this.password === undefined) this.password = await readPassword(this.deps.files);
		for (const device of await this.registry.expire())
			await this.audit.append('expired', { device: device.name, deviceId: device.id });
	}
	/** This machine's certificate fingerprint once the identity is loaded (mDNS says it). */
	get fingerprint(): string | null {
		return this.identity?.fingerprint ?? null;
	}
	get machineName(): string {
		return this.config.machineName ?? this.deps.defaultName;
	}
	async hasPassword(): Promise<boolean> {
		if (this.password === undefined) this.password = await readPassword(this.deps.files);
		return this.password !== null;
	}
	/** spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#client-ui-seam: a new password drops every remote connection and every resume token. */
	async setPassword(password: string): Promise<void> {
		if (!isRemotePassword(password)) throw new Error('The password needs at least 10 characters.');
		const had = await this.hasPassword();
		const hash = await hashPassword(password, this.deps.scrypt);
		await writePassword(this.deps.files, hash);
		this.password = hash;
		this.resume.clear();
		this.dropAll('password-changed');
		await this.audit.append(had ? 'password-changed' : 'password-set');
		this.deps.changed();
	}

	// —— status ——

	status(forRemote: boolean): RemoteAccessStatus {
		const connected = new Set([...this.sessions].map((session) => session.deviceId));
		const devices: RemoteDevice[] = (this.registry?.list() ?? []).map((device) => ({
			id: device.id,
			kind: device.kind,
			name: device.name,
			pairedAt: device.pairedAt,
			lastLoginAt: device.lastLoginAt,
			lastAddress: device.lastAddress,
			failures: device.failures,
			blocked: device.blocked,
			lastFailureAt: device.lastFailureAt ?? null,
			expiresAt: deviceExpiresAt(device).toISOString(),
			connected: connected.has(device.id) || this.web.connected(device.id),
		}));
		const pairing = this.pairing.current;
		return {
			module: this.config.module,
			enabled: this.config.enabled,
			passwordSet: Boolean(this.password),
			machineName: this.machineName,
			defaultName: this.deps.defaultName,
			port: this.port,
			pairingPort: this.pairingPort,
			listening: this.listeners.map((listener) => listener.address),
			error: this.on ? this.error : null,
			devices,
			// spec/remote-access-and-mobile#pairing: the code is shown on the working machine only.
			pairing: forRemote && pairing.state === 'open' ? { ...pairing, code: '' } : pairing,
			control: this.control(null),
			editable: !forRemote,
			phone: this.web.status(),
		};
	}
	/** Who controls the machine, as `peerId` (null — the local window) sees it. */
	control(peerId: string | null): RemoteControl {
		const active = this.activeSession();
		return {
			active: active ? 'remote' : 'local',
			device: active?.peer.deviceName ?? null,
			deviceId: active?.deviceId ?? null,
			self: active ? active.peer.id === peerId : peerId === null,
		};
	}
	/** Whether a client may set main's per-client state now (spec/remote-access-and-mobile#architecture). */
	isActive(peerId: string | null): boolean {
		return (this.activeSession()?.peer.id ?? null) === peerId;
	}
	/** «Take back» (`null`, the local window, always wins) or «Take control again» from a device. */
	async takeControl(peerId: string | null): Promise<RemoteControl> {
		const session = peerId ? [...this.sessions].find((item) => item.peer.id === peerId) : null;
		if (peerId && !session) throw new Error('Not connected.');
		const before = this.activeId;
		this.activeId = session?.peer.id ?? null;
		if (before !== this.activeId) {
			// A device may send take-control again and again; the local window's «Take back» is a person at the machine.
			if (session)
				this.noisy('took-over', {
					device: session.peer.deviceName,
					deviceId: session.deviceId,
					address: session.peer.address.address,
					network: session.peer.address.network,
				});
			else await this.audit.append('took-back');
			this.deps.controlChanged();
			this.deps.changed();
		}
		return this.control(peerId);
	}
	private activeSession(): Session | null {
		if (!this.activeId) return null;
		return [...this.sessions].find((session) => session.peer.id === this.activeId) ?? null;
	}
	readAudit(limit: number) {
		return this.audit.read(limit);
	}
	/**
	 * spec/remote-access-and-mobile#pairing: what a logged-in device tried — a refused call (`detail`: the channel) or a settings save (`detail`:
	 * the changed keys, never values). Within the noisy budget: a device can repeat both at will.
	 */
	auditPeer(peerId: string, kind: 'call-refused' | 'settings-changed', detail: string) {
		const peer =
			[...this.sessions].find((item) => item.peer.id === peerId)?.peer ?? this.web.peer(peerId);
		if (!peer) return;
		this.noisy(kind, {
			device: peer.deviceName,
			deviceId: peer.deviceId,
			address: peer.address.address,
			network: peer.address.network,
			detail: detail.slice(0, 500),
		});
	}

	// —— devices ——

	private async requireRegistry() {
		this.registry ??= await DeviceRegistry.open(this.deps.files, this.now);
		return this.registry;
	}
	async revoke(id: string): Promise<void> {
		const device = await (await this.requireRegistry()).remove(id);
		if (!device) throw new Error('No such device.');
		this.forgetDevice(id, 'revoked');
		await this.audit.append('revoked', { device: device.name, deviceId: id });
		this.trustChanged();
	}
	async revokeAll(): Promise<void> {
		const gone = await (await this.requireRegistry()).clear();
		for (const device of gone) this.forgetDevice(device.id, 'revoked');
		await this.audit.append('revoked-all', { detail: String(gone.length) });
		this.trustChanged();
	}
	/** The cover's «Disconnect <device>»: its connection goes now, the device stays paired and may connect again. */
	async drop(id: string): Promise<void> {
		const device = this.registry?.get(id);
		if (!device) throw new Error('No such device.');
		this.forgetDevice(id, 'dropped');
		await this.audit.append('dropped', { device: device.name, deviceId: id });
	}
	async unblock(id: string): Promise<void> {
		const device = await (
			await this.requireRegistry()
		).update(id, (item) => {
			item.blocked = false;
			item.failures = 0;
			item.lastFailureAt = null;
		});
		if (!device) throw new Error('No such device.');
		await this.audit.append('unblocked', { device: device.name, deviceId: id });
		this.deps.changed();
	}
	private forgetDevice(id: string, reason: ByeReason) {
		if (reason === 'revoked' || reason === 'dropped') this.web.forget(id, reason);
		for (const [token, entry] of this.resume) if (entry.deviceId === id) this.resume.delete(token);
		for (const session of [...this.sessions])
			if (session.deviceId === id) this.bye(session, reason);
	}
	/** The trust anchors follow the registry: a revoked certificate fails the next handshake. */
	private trustChanged() {
		for (const listener of this.listeners) listener.server.setSecureContext(this.tlsOptions());
		this.deps.changed();
	}

	// —— pairing ——

	async startPairing(): Promise<RemotePairing> {
		if (!this.on) throw new Error('Turn on remote access first.');
		await this.prepare();
		const state = this.pairing.open();
		await this.audit.append('pairing-opened');
		await this.bindPairing();
		return state;
	}
	async stopPairing(): Promise<RemotePairing> {
		if (this.pairing.isOpen) {
			this.pairing.close();
			await this.audit.append('pairing-closed');
		}
		return this.pairing.current;
	}
	confirmPairing(accept: boolean, name: string | null): RemotePairing {
		if (!this.pairing.confirm(accept, name))
			throw new Error('No device is waiting for confirmation.');
		return this.pairing.current;
	}

	// —— listeners ——

	private tlsOptions() {
		const identity = this.identity!;
		// A phone has no certificate: only computers are TLS anchors (spec/remote-access-and-mobile#phone-network).
		const trusted = (this.registry?.list() ?? []).flatMap((device) =>
			device.kind === 'computer' && device.cert ? [device.cert] : []
		);
		return {
			key: identity.key,
			cert: identity.cert,
			minVersion: 'TLSv1.3' as const,
			requestCert: true,
			rejectUnauthorized: true,
			// Without a paired device the anchor is our own certificate, which nobody else can issue under: an empty `ca`
			// would fall back to Node's public roots.
			ca: trusted.length ? trusted : [identity.cert],
		};
	}
	private addresses(): RemoteAddress[] {
		return (this.deps.addresses ?? listenAddresses)(this.config.listen);
	}
	private async bind() {
		await this.closeListeners();
		const wanted = this.addresses();
		const errors: string[] = [];
		for (const address of wanted) {
			try {
				this.listeners.push(await this.listenGateway(address));
			} catch (error) {
				errors.push(
					`${address.address}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
		this.error = errors.length
			? `Could not listen on port ${this.port} (${errors.join('; ')}).`
			: wanted.length
				? null
				: 'No LAN or Tailscale network.';
		if (this.pairing.isOpen) await this.bindPairing();
	}
	private listenServer(
		address: RemoteAddress,
		port: number,
		options: Parameters<typeof createServer>[0],
		frameLimit: number
	): Promise<Listener> {
		const server = createServer({ ...options, handshakeTimeout: this.limits.handshakeMs });
		const wss = new WebSocketServer({
			noServer: true,
			maxPayload: frameLimit,
			perMessageDeflate: { threshold: 1024 },
		});
		// Plain HTTP gets nothing: the only thing here is the WebSocket.
		server.on('request', (_request, response) => {
			response.writeHead(404, { connection: 'close' }).end();
		});
		server.headersTimeout = this.limits.handshakeMs;
		server.requestTimeout = this.limits.handshakeMs;
		// Idle before the upgrade; `ws` clears the socket timeout once it takes the socket over.
		server.timeout = this.limits.handshakeMs;
		// Caps before TLS: an extra connection costs no handshake (security review R1, S6).
		server.on('connection', (socket: Socket) => {
			// spec/remote-access-and-mobile#networking, e2e: a machine that sleeps or lost its network answers nobody.
			if (this.frozen || this.now() < this.refuseUntil) {
				socket.destroy();
				return;
			}
			const from = bracketless(socket.remoteAddress ?? '?');
			const held = this.perAddress.get(from) ?? 0;
			if (
				this.connectionCount >= this.limits.connections ||
				held >= this.limits.connectionsPerAddress
			) {
				socket.destroy();
				return;
			}
			this.connectionCount++;
			this.perAddress.set(from, held + 1);
			socket.once('close', () => {
				this.connectionCount--;
				const left = (this.perAddress.get(from) ?? 1) - 1;
				if (left > 0) this.perAddress.set(from, left);
				else this.perAddress.delete(from);
			});
		});
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen({ port, host: address.address, exclusive: true }, () => {
				server.off('error', reject);
				server.on('error', (error) =>
					this.deps.log(`remote: ${address.address}:${port}: ${error.message}`)
				);
				resolve({ address, server, wss });
			});
		});
	}
	private async listenGateway(address: RemoteAddress): Promise<Listener> {
		// Before login the gateway takes the small frames of the pairing listener; the login raises its own connection.
		const listener = await this.listenServer(
			address,
			this.port,
			this.tlsOptions(),
			pairingFrameLimit
		);
		if (this.port === 0) this.port = (listener.server.address() as AddressInfo).port;
		listener.server.on('tlsClientError', (error, socket) => {
			this.rejected(
				socket.remoteAddress ?? null,
				address.network,
				(error as { code?: string }).code ?? error.message
			);
		});
		listener.server.on('secureConnection', (socket: TLSSocket) => {
			// Layer 2: the exact fingerprint of a device in the registry, not just any chain to an anchor.
			const device = this.peerDevice(socket);
			if (!device) {
				this.rejected(socket.remoteAddress ?? null, address.network, 'unknown certificate');
				socket.destroy();
			}
		});
		listener.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
			const tls = socket as TLSSocket;
			const device = this.peerDevice(tls);
			if (!device || !this.upgradeAllowed(request, tls, '/v1')) {
				socket.destroy();
				return;
			}
			listener.wss.handleUpgrade(request, socket, head, (ws) =>
				this.acceptGateway(ws, device.id, {
					network: address.network,
					address: bracketless(tls.remoteAddress ?? ''),
				})
			);
		});
		return listener;
	}
	private peerDevice(socket: TLSSocket): DeviceRecord | null {
		const cert = socket.getPeerX509Certificate?.();
		if (!cert) return null;
		const id = cert.fingerprint256.replace(/:/g, '').toLowerCase();
		const device = this.registry?.get(id) ?? null;
		return device?.kind === 'computer' ? device : null;
	}
	/** Origin, Host and path (research spec/chat#row-engine): a browser always sends Origin, our client never does. */
	private upgradeAllowed(request: IncomingMessage, socket: TLSSocket, path: string): boolean {
		if (request.headers.origin !== undefined) return false;
		if (request.url !== path) return false;
		const host = request.headers.host ?? '';
		const name = host.startsWith('[')
			? host.slice(1, host.indexOf(']'))
			: host.replace(/:\d+$/, '');
		const local = bracketless(socket.localAddress ?? '');
		const isIp = /^[0-9.]+$/.test(name) || name.includes(':');
		// An IP literal must be the address the connection reached; a name (typed by hand) is checked by TLS pinning.
		return isIp ? bracketless(name) === local : /^[A-Za-z0-9.-]{1,253}$/.test(name);
	}
	/** Writes a line of a noisy kind within its budget; false when the line was only counted. */
	private noisy(kind: NoisyKind, fields: Parameters<AuditLog['append']>[1]): boolean {
		const now = this.now();
		let budget = this.noise.get(kind);
		if (!budget || now - budget.since >= 60_000) {
			this.flushNoise(kind);
			budget = { since: now, written: 0, held: 0 };
			this.noise.set(kind, budget);
		}
		if (budget.written >= noisyPerMinute) {
			if (!budget.held++) {
				// The count is written when the minute ends even if nothing knocks after it.
				const timer = setTimeout(() => this.flushNoise(kind), 60_000 - (now - budget.since));
				timer.unref?.();
			}
			return false;
		}
		budget.written++;
		void this.audit.append(kind, fields);
		return true;
	}
	private flushNoise(kind: NoisyKind) {
		const budget = this.noise.get(kind);
		if (!budget?.held) return;
		void this.audit.append(kind, { detail: `${budget.held} more within a minute` });
		budget.held = 0;
	}
	/** `network`: the listener's, as the gateway decided it (spec/remote-access-and-mobile#pairing), so the log never guesses it from the address. */
	private rejected(address: string | null, network: RemoteNetwork, detail: string) {
		const key = address ?? '?';
		const now = this.now();
		const last = this.rejections.get(key) ?? 0;
		if (now - last < rejectionQuietMs) return;
		this.rejections.set(key, now);
		// Forget the quiet addresses first; clearing everything let a cycle of 1025 addresses log without end.
		if (this.rejections.size > 1024)
			for (const [item, at] of this.rejections)
				if (now - at >= rejectionQuietMs) this.rejections.delete(item);
		if (this.rejections.size > 4096) this.rejections.clear();
		if (!this.noisy('tls-rejected', { address, network, detail: detail.slice(0, 200) })) return;
		this.deps.notice({
			kind: 'tls-rejected',
			device: null,
			address,
			network,
			at: new Date(this.now()).toISOString(),
		});
	}
	private async closeListeners() {
		const all = [...this.listeners, ...this.pairingListeners];
		this.listeners = [];
		this.pairingListeners = [];
		await Promise.all(all.map((listener) => this.closeListener(listener)));
	}
	private async closePairingListeners() {
		const all = this.pairingListeners;
		this.pairingListeners = [];
		await Promise.all(all.map((listener) => this.closeListener(listener)));
	}
	private closeListener(listener: Listener) {
		for (const client of listener.wss.clients) client.terminate();
		listener.wss.close();
		listener.server.closeAllConnections?.();
		return new Promise<void>((resolve) => listener.server.close(() => resolve()));
	}
	private startTimers() {
		if (!this.rescan && this.deps.rescanMs !== 0) {
			this.rescan = setInterval(() => {
				const now = this.addresses()
					.map((item) => item.address)
					.sort()
					.join(',');
				const bound = this.listeners
					.map((item) => item.address.address)
					.sort()
					.join(',');
				if (now !== bound)
					void this.applying
						.then(() => (this.on ? this.bind() : undefined))
						.then(() => this.deps.changed());
			}, this.deps.rescanMs ?? 15_000);
			this.rescan.unref?.();
		}
		if (!this.heartbeat) {
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
				for (const [token, entry] of this.resume)
					if (entry.expiresAt !== null && entry.expiresAt <= this.now()) this.resume.delete(token);
			}, heartbeatMs);
			this.heartbeat.unref?.();
		}
	}
	private stopTimers() {
		if (this.rescan) clearInterval(this.rescan);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.rescan = this.heartbeat = null;
	}
	private frozen = false;
	private refuseUntil = 0;
	/**
	 * spec/remote-access-and-mobile#networking, e2e only (main exposes it in an unpackaged test run): the machine «sleeps» — its connections are
	 * not read, its timers stand and new connections go nowhere — until `freeze(false)` wakes it.
	 */
	freeze(on: boolean) {
		this.frozen = on;
		for (const session of this.sessions) {
			const socket = (session.ws as unknown as { _socket?: Duplex })._socket;
			if (on) socket?.pause();
			else socket?.resume();
		}
		if (on) this.stopTimers();
		else if (this.on) this.startTimers();
	}
	/** e2e only: the network path breaks — every connection drops without a `bye` and new ones fail for `ms`. */
	cut(ms: number) {
		this.refuseUntil = this.now() + ms;
		for (const session of [...this.sessions]) session.ws.terminate();
	}
	machineInfo(): MachineInfo {
		return {
			name: this.machineName,
			addresses: this.listeners.map((listener) => listener.address),
			port: this.port,
			pairingPort: this.pairingPort,
		};
	}

	// —— the gateway: login, calls, events ——

	private acceptGateway(ws: WebSocket, deviceId: string, address: RemoteAddress) {
		let session: Session | null = null;
		let loggingIn = false;
		// A socket without a session goes after this, whatever happens on it: a login that hangs, waits or lost a race
		// (security review R1, S10). Only a session clears it.
		const timer = setTimeout(() => ws.terminate(), this.limits.sessionlessMs);
		timer.unref?.();
		// A frame over the limit or a broken one: ws closes the socket (1009, 1002) and then emits `error`, which without a
		// listener is an uncaught exception in main.
		ws.on('error', () => {});
		ws.on('close', () => {
			clearTimeout(timer);
			// The session the login opened, even if the socket closed before the login's promise came back.
			for (const item of [...this.sessions]) if (item.ws === ws) this.leave(item);
		});
		ws.on('pong', () => {
			if (session) session.alive = true;
		});
		ws.on('message', (data, binary) => {
			if (binary) return void ws.close(4002, 'protocol');
			const raw = data.toString();
			let message: unknown;
			try {
				if (!session && raw.length > 4096) throw new Error('too long');
				message = decodeFrame(raw);
			} catch {
				return void ws.close(4002, 'protocol');
			}
			if (!isGatewayClientMessage(message)) return void ws.close(4002, 'protocol');
			if (!session) {
				if (message.t !== 'login' || loggingIn) return void ws.close(4002, 'protocol');
				loggingIn = true;
				void this.login(ws, deviceId, address, message).then(
					(made) => {
						if (!made) return;
						clearTimeout(timer);
						session = made;
					},
					(error: unknown) => {
						this.deps.log(
							`remote: login failed: ${error instanceof Error ? error.message : String(error)}`
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
	private refuse(
		ws: WebSocket,
		reason: LoginRefusal,
		extra: { retryAfterMs?: number | null; attemptsLeft?: number | null } = {}
	) {
		if (ws.readyState === ws.OPEN)
			ws.send(
				encodeFrame({
					t: 'refused',
					reason,
					retryAfterMs: extra.retryAfterMs ?? null,
					attemptsLeft: extra.attemptsLeft ?? null,
					machine: reason === 'version' ? this.machineName : null,
				} satisfies GatewayMessage)
			);
		ws.close(4001, reason);
		return null;
	}
	private async login(
		ws: WebSocket,
		deviceId: string,
		address: RemoteAddress,
		message: Extract<GatewayMessage, { t: 'login' }>
	): Promise<Session | null> {
		const registry = this.registry;
		const device = registry?.get(deviceId);
		const at = new Date(this.now()).toISOString();
		if (!registry || !device) return this.refuse(ws, 'unknown');
		const who = {
			device: device.name,
			deviceId,
			address: address.address,
			network: address.network,
		};
		const where = { device: device.name, address: address.address, network: address.network };
		if (!this.on) return this.refuse(ws, 'off');
		if (message.v !== protocolVersion || message.table !== this.deps.tableHash) {
			this.noisy('version-mismatch', who);
			return this.refuse(ws, 'version');
		}
		if (device.blocked) {
			this.noisy('login-refused', { ...who, detail: 'blocked' });
			return this.refuse(ws, 'blocked');
		}
		let viaResume = false;
		if (message.resume) {
			const entry = this.resume.get(sha256(message.resume));
			if (
				entry &&
				entry.deviceId === deviceId &&
				(entry.expiresAt === null || entry.expiresAt > this.now())
			)
				viaResume = true;
			else if (message.password === null) return this.refuse(ws, 'expired');
		}
		if (!viaResume) {
			const pause = passwordPauseMs(device.failures);
			const since = device.lastFailureAt ? this.now() - Date.parse(device.lastFailureAt) : Infinity;
			if (since < pause || this.checking.has(deviceId)) {
				this.noisy('login-refused', { ...who, detail: since < pause ? 'pause' : 'busy' });
				return this.refuse(ws, 'wait', {
					retryAfterMs: since < pause ? pause - since : 1000,
				});
			}
			// The check and its count are one step: the next try of this device waits until the failure is written.
			this.checking.add(deviceId);
			try {
				const right =
					this.password !== null &&
					this.password !== undefined &&
					message.password !== null &&
					(await verifyPassword(message.password, this.password));
				if (!right) {
					const failed = await registry.update(deviceId, (item) => {
						item.failures += 1;
						item.lastFailureAt = new Date(this.now()).toISOString();
						if (item.failures >= blockAfterFailures) item.blocked = true;
					});
					const failures = failed?.failures ?? blockAfterFailures;
					await this.audit.append('login-failed', { ...who, detail: `${failures} in a row` });
					this.deps.notice({ kind: 'failed', ...where, at });
					if (failed?.blocked) {
						await this.audit.append('blocked', who);
						this.deps.notice({
							kind: 'blocked',
							device: device.name,
							address: address.address,
							network: address.network,
							at,
						});
						this.deps.changed();
						return this.refuse(ws, 'blocked');
					}
					this.deps.changed();
					return this.refuse(ws, 'password', {
						retryAfterMs: passwordPauseMs(failures),
						attemptsLeft: blockAfterFailures - failures,
					});
				}
			} finally {
				this.checking.delete(deviceId);
			}
		}
		// A login that lost the race with revocation or access turning off: answered and closed, never left open (S10).
		const raced = (): boolean => {
			if (ws.readyState !== ws.OPEN) return true;
			const reason = !this.on ? 'off' : this.registry?.get(deviceId) ? null : 'unknown';
			if (reason) this.refuse(ws, reason);
			return reason !== null;
		};
		if (raced()) return null;
		// spec/remote-access-and-mobile#architecture: a fresh login while someone works at the machine asks first. A reconnect (the resume token) takes
		// back only the control it still holds, or control nobody uses: never from a person at the machine or another
		// device, whatever `takeOver` says — that takes the password and «Take control?» (spec/remote-access-and-mobile#machine-window, P6).
		const active = this.activeSession();
		const take = viaResume
			? message.takeOver &&
				(active?.deviceId === deviceId || (!active && !this.deps.localPresent?.()))
			: message.takeOver || !active;
		if (take && !message.takeOver && !active && this.deps.localPresent?.()) {
			await registry.update(deviceId, (item) => {
				item.failures = 0;
				item.lastFailureAt = null;
			});
			await this.audit.append('login-refused', { ...who, detail: 'local' });
			return this.refuse(ws, 'local');
		}
		await registry.update(deviceId, (item) => {
			item.failures = 0;
			item.lastFailureAt = null;
			item.lastLoginAt = new Date(this.now()).toISOString();
			item.lastAddress = address;
		});
		if (raced()) return null;
		if (!raiseFrameLimit(ws, gatewayFrameLimit))
			this.deps.log('remote: could not raise the frame limit after login; frames stay at 16 KB');
		// The same device again (a reconnect racing the old socket's timeout): the newer connection wins.
		for (const old of [...this.sessions]) if (old.deviceId === deviceId) this.bye(old, 'replaced');
		for (const [token, entry] of this.resume)
			if (entry.deviceId === deviceId) this.resume.delete(token);
		const token = randomBytes(32).toString('base64');
		this.resume.set(sha256(token), { deviceId, expiresAt: null });
		const session = this.open(ws, device, address);
		await this.audit.append('login', { ...who, detail: viaResume ? 'resumed' : null });
		this.deps.notice({ kind: 'connected', ...where, at });
		if (take) {
			// «Take control?» answered yes: the device takes it from whoever had it (spec/remote-access-and-mobile#pairing).
			if (message.takeOver && this.activeId !== session.peer.id)
				this.noisy('took-over', { ...who, detail: 'login' });
			this.activeId = session.peer.id;
		}
		if (ws.readyState === ws.OPEN)
			ws.send(
				encodeFrame({
					t: 'welcome',
					machine: this.machineInfo(),
					resume: token,
					control: this.control(session.peer.id),
				} satisfies GatewayMessage)
			);
		this.deps.controlChanged();
		this.deps.changed();
		return session;
	}
	private open(ws: WebSocket, device: DeviceRecord, address: RemoteAddress): Session {
		const channels = new Set<string>();
		const peer: RemotePeer = {
			id: `remote:${randomBytes(8).toString('hex')}`,
			deviceId: device.id,
			deviceName: device.name,
			address,
			send: (channel, value, droppable = false) => {
				if (ws.readyState !== ws.OPEN || !channels.has(channel)) return false;
				const message = { t: 'event', channel, value } satisfies GatewayMessage;
				const binary = encodeBinaryFrame(message);
				// Pictures and video are compressed already: deflate would spend CPU for nothing.
				return binary
					? session.outbox.send(binary, { binary: true, compress: false, droppable })
					: session.outbox.send(encodeFrame(message), { droppable });
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
			deviceId: device.id,
			detach: () => {},
			inflight: 0,
			channels,
			alive: true,
		};
		this.sessions.add(session);
		session.detach = this.deps.attach(peer);
		return session;
	}
	private handle(
		session: Session,
		message: GatewayMessage,
		send: (message: GatewayMessage) => void
	) {
		switch (message.t) {
			case 'invoke': {
				if (session.inflight >= inflightLimit) {
					send({ t: 'result', id: message.id, ok: false, error: 'Too many calls at once.' });
					return;
				}
				session.inflight++;
				const call = () =>
					Promise.resolve()
						.then(() => this.deps.dispatch(session.peer, message.channel, message.args))
						.then(
							(value) => send({ t: 'result', id: message.id, ok: true, value }),
							(error: unknown) =>
								send({
									t: 'result',
									id: message.id,
									ok: false,
									error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
								})
						)
						.catch((error: unknown) => {
							// A value that cannot be encoded: the caller still gets an answer.
							send({ t: 'result', id: message.id, ok: false, error: String(error).slice(0, 4096) });
						});
				// A file, its highlighting, a diff: one at a time, after the socket drained (spec/remote-access-and-mobile#outbox).
				void (isBulkCall(message.channel) ? session.outbox.serial(call) : call()).finally(() => {
					session.inflight--;
				});
				return;
			}
			case 'subscribe':
				session.channels.clear();
				for (const channel of message.channels) session.channels.add(channel);
				return;
			case 'take-control':
				void this.takeControl(session.peer.id);
				return;
			case 'ping':
				send({ t: 'pong', at: message.at });
				return;
			default:
				session.ws.close(4002, 'protocol');
		}
	}
	private leave(session: Session) {
		if (!this.sessions.delete(session)) return;
		session.outbox.close();
		session.detach();
		for (const entry of this.resume.values())
			if (entry.deviceId === session.deviceId && entry.expiresAt === null)
				entry.expiresAt = this.now() + resumeMs;
		const wasActive = this.activeId === session.peer.id;
		if (wasActive) this.activeId = null;
		void this.audit.append('disconnected', {
			device: session.peer.deviceName,
			deviceId: session.deviceId,
			address: session.peer.address.address,
			network: session.peer.address.network,
		});
		this.deps.notice({
			kind: 'disconnected',
			device: session.peer.deviceName,
			address: session.peer.address.address,
			network: session.peer.address.network,
			at: new Date(this.now()).toISOString(),
		});
		if (wasActive) this.deps.controlChanged();
		this.deps.changed();
	}
	private bye(session: Session, reason: ByeReason) {
		if (session.ws.readyState === session.ws.OPEN)
			session.ws.send(encodeFrame({ t: 'bye', reason } satisfies GatewayMessage));
		session.ws.close(4003, reason);
		// The socket may take a while to close; the client set forgets it now.
		this.leave(session);
	}
	private dropAll(reason: ByeReason) {
		this.resume.clear();
		for (const session of [...this.sessions]) this.bye(session, reason);
	}
	/** Quit: everyone goes, the listeners close. */
	async close() {
		for (const kind of noisyKinds) this.flushNoise(kind);
		this.pairing.close();
		this.dropAll('shutdown');
		this.stopTimers();
		await this.closeListeners();
		await this.web.close();
		await this.audit.flush();
	}

	// —— pairing listener ——

	private async bindPairing() {
		if (!this.pairing.isOpen || !this.on) return;
		await this.closePairingListeners();
		const identity = this.identity!;
		for (const address of this.listeners.map((listener) => listener.address)) {
			try {
				const listener = await this.listenServer(
					address,
					this.pairingPort,
					{
						key: identity.key,
						cert: identity.cert,
						minVersion: 'TLSv1.3',
						// Any certificate: the device's comes to be trusted only through the code (spec/remote-access-and-mobile#pairing).
						requestCert: true,
						rejectUnauthorized: false,
					},
					pairingFrameLimit
				);
				if (this.pairingPort === 0)
					this.pairingPort = (listener.server.address() as AddressInfo).port;
				listener.server.on('secureConnection', (socket: TLSSocket) => {
					const cert = socket.getPeerX509Certificate?.();
					if (!cert || !isPeerCertificate(cert.toString())) socket.destroy();
				});
				listener.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
					const tls = socket as TLSSocket;
					const cert = tls.getPeerX509Certificate?.();
					if (!cert || !this.pairing.isOpen || !this.upgradeAllowed(request, tls, '/pair')) {
						socket.destroy();
						return;
					}
					listener.wss.handleUpgrade(request, socket, head, (ws) =>
						this.acceptPairing(ws, cert.toString(), {
							network: address.network,
							address: bracketless(tls.remoteAddress ?? ''),
						})
					);
				});
				this.pairingListeners.push(listener);
			} catch (error) {
				this.deps.log(
					`remote: pairing listener ${address.address}:${this.pairingPort}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}
	private acceptPairing(ws: WebSocket, peerCert: string, from: RemoteAddress) {
		const { address, network } = from;
		const send = (message: PairMessage) => {
			if (ws.readyState === ws.OPEN) ws.send(encodeFrame(message));
		};
		// As on the gateway: ws has closed the socket already; unheard, the error would be an uncaught exception.
		ws.on('error', () => {});
		const refuse = (
			reason: Extract<PairMessage, { t: 'pair-refused' }>['reason'],
			attemptsLeft: number | null = null
		) => {
			send({ t: 'pair-refused', reason, attemptsLeft });
			ws.close(4001, reason);
		};
		// The window is held only by a run that sent `pair-a` and so spent a try; a connection that only opened holds
		// nothing, and one address runs one pairing at a time (security review R1, S5).
		if (this.pairing.busy || this.pairingFrom.has(address)) return refuse('busy');
		const code = this.pairing.code;
		if (!code || !this.identity) return refuse('closed');
		this.pairingFrom.add(address);
		let holds = false;
		ws.once('close', () => {
			this.pairingFrom.delete(address);
			if (holds) this.pairing.busy = false;
		});
		const stepMs = this.limits.pairingStepMs;
		let step = setTimeout(() => ws.terminate(), stepMs);
		step.unref?.();
		const sid = randomBytes(16);
		const peerFingerprint = fingerprintOf(peerCert);
		// spec/remote-access-and-mobile#pairing: both TLS certificates go into CPace's channel identifier; a certificate swapped in the middle
		// makes the keys differ and the confirmation fail.
		const ci = channelIdentifier(this.identity.cert, peerCert);
		let party: CPaceParty | null = null;
		let device = '';
		send({
			t: 'pair-hello',
			v: protocolVersion,
			sid: b64(sid),
			machine: this.machineName,
			table: this.deps.tableHash,
		});
		ws.on('message', (data, binary) => {
			let message: unknown;
			try {
				if (binary) throw new Error('binary');
				message = decodeFrame(data.toString());
			} catch {
				return void ws.close(4002, 'protocol');
			}
			if (!isPairClientMessage(message)) return void ws.close(4002, 'protocol');
			clearTimeout(step);
			step = setTimeout(() => ws.terminate(), stepMs);
			step.unref?.();
			if (message.t === 'pair-a' && !party) {
				if (!isMachineName(message.device)) return void ws.close(4002, 'protocol');
				// Another run spent its try first and holds the window until it ends or times out.
				if (this.pairing.busy) return refuse('busy');
				this.pairing.busy = holds = true;
				if (!this.pairing.spend())
					return refuse(
						this.pairing.current.state === 'exhausted' || this.pairing.attemptsLeft === 0
							? 'exhausted'
							: 'closed'
					);
				device = message.device;
				party = new CPaceParty(
					'responder',
					{ prs: utf8(normalizePairingCode(code)), ci, sid },
					utf8(this.machineName)
				);
				try {
					party.finish(unb64(message.share), utf8(device));
				} catch {
					this.pairing.failed();
					return void ws.close(4002, 'protocol');
				}
				send({ t: 'pair-b', share: b64(party.share), tag: b64(party.tag()) });
				return;
			}
			if (message.t === 'pair-confirm' && party) {
				const matched = party.verify(unb64(message.tag));
				party = null;
				if (!matched) {
					const left = this.pairing.attemptsLeft;
					// The last try closes the window once the answer is out: closing it first would cut the answer.
					if (left <= 0) ws.once('close', () => this.pairing.failed());
					void this.audit.append('pairing-failed', {
						device,
						address,
						network,
						detail: `${left} left`,
					});
					this.deps.notice({
						kind: 'pairing-failed',
						device,
						address,
						network,
						at: new Date(this.now()).toISOString(),
					});
					return refuse(left > 0 ? 'code' : 'exhausted', left);
				}
				clearTimeout(step);
				send({ t: 'pair-wait' });
				void this.pairing
					.matched(device, peerCert, peerFingerprint, address, network)
					.then(async ({ accept, name }) => {
						if (!accept || ws.readyState !== ws.OPEN) {
							if (this.pairing.current.state === 'confirm') this.pairing.declined();
							await this.audit.append('pairing-declined', {
								device,
								deviceId: peerFingerprint,
								address,
								network,
							});
							return refuse('declined');
						}
						const named = name ?? device;
						await (await this.requireRegistry()).add(named, peerCert);
						await this.audit.append('paired', {
							device: named,
							deviceId: peerFingerprint,
							address,
							network,
						});
						this.deps.notice({
							kind: 'paired',
							device: named,
							address,
							network,
							at: new Date(this.now()).toISOString(),
						});
						this.trustChanged();
						send({ t: 'paired', machine: this.machineInfo() });
						ws.close(1000, 'paired');
						this.pairing.paired(named);
					});
				return;
			}
			ws.close(4002, 'protocol');
		});
	}
}
/** lv_cat("brigadir-pair-1", SHA-256(DER of the working machine's cert), SHA-256(DER of the device's cert)). */
export function channelIdentifier(machineCert: string, deviceCert: string): Uint8Array {
	const digest = (cert: string) => createHash('sha256').update(certificateDer(cert)).digest();
	return lvCat(utf8('brigadir-pair-1'), digest(machineCert), digest(deviceCert));
}
