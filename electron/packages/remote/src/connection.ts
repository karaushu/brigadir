/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: the device's side — pair with a machine once, then connect by password and keep the
 * connection: reconnect with backoff using the resume token the machine gave, forward calls and receive events.
 */
import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import {
	isPairingCode,
	normalizePairingCode,
	type RemoteAddress,
	type RemoteConnectResult,
	type RemoteControl,
	type RemotePairResult,
	type RemoteSession,
} from '@brigadir/core';
import { fingerprintOf, isPeerCertificate, type Identity } from './cert';
import { CPaceParty } from './cpace';
import { decodeBinaryFrame, decodeFrame, encodeFrame } from './codec';
import { channelIdentifier } from './gateway';
import { hostPort } from './interfaces';
import {
	Heartbeat,
	addressRank,
	defaultLinkTiming,
	mergeLoginAddresses,
	raceAddresses,
	rankAddresses,
	reconnectDelay,
	type LinkTiming,
	type LocalInterfaces,
} from './reach';
import {
	defaultPairingPort,
	gatewayFrameLimit,
	isGatewayServerMessage,
	isPairServerMessage,
	pairingFrameLimit,
	protocolVersion,
	type GatewayMessage,
	type PairMessage,
} from './protocol';
import type { MachineRecord } from './store';

const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
/** A ws message as one byte array (ws hands a Buffer, or fragments, or an ArrayBuffer by `binaryType`). */
const asBytes = (data: Buffer | ArrayBuffer | Buffer[]): Uint8Array =>
	Array.isArray(data)
		? Buffer.concat(data)
		: data instanceof ArrayBuffer
			? new Uint8Array(data)
			: data;
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const utf8 = (text: string) => new TextEncoder().encode(text);
const fingerprint256 = (socket: TLSSocket) =>
	socket.getPeerX509Certificate?.()?.fingerprint256.replace(/:/g, '').toLowerCase() ?? null;
/** How long one address may take to answer before the next one is tried. */
const connectTimeoutMs = 5_000;
/** The person's answer on the working machine may take the rest of the pairing window. */
const pairingWaitMs = 5 * 60_000 + 10_000;

/**
 * spec/remote-access-and-mobile#architecture: pairs with the machine at `host`. The machine's certificate is not known yet, so TLS accepts it and
 * CPace authenticates it: both certificates are in the channel identifier, a swapped one fails the confirmation.
 */
export function pairWithMachine(options: {
	identity: Identity;
	host: string;
	port: number | null;
	code: string;
	deviceName: string;
	tableHash: string;
	/** The code went through; the machine now asks its person (the device shows «Waiting for confirmation»). */
	onWait?: (machine: string) => void;
	/** The person cancels on the device: the pairing connection closes. */
	signal?: AbortSignal;
}): Promise<{ result: RemotePairResult; record: MachineRecord | null }> {
	const code = normalizePairingCode(options.code);
	const fail = (
		reason: Extract<RemotePairResult, { ok: false }>['reason'],
		message: string,
		attemptsLeft: number | null = null
	) => ({ result: { ok: false as const, reason, attemptsLeft, message }, record: null });
	if (!isPairingCode(code))
		return Promise.resolve(fail('code', 'The code has 8 characters: digits and letters.'));
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: { result: RemotePairResult; record: MachineRecord | null }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.removeAllListeners();
			ws.on('error', () => {});
			ws.close();
			resolve(value);
		};
		const host = options.host.replace(/^\[|\]$/g, '');
		const ws = new WebSocket(`wss://${hostPort(host, options.port ?? defaultPairingPort)}/pair`, {
			key: options.identity.key,
			cert: options.identity.cert,
			minVersion: 'TLSv1.3',
			// The machine's certificate is checked by CPace, not by a CA (see above).
			rejectUnauthorized: false,
			maxPayload: pairingFrameLimit,
			handshakeTimeout: connectTimeoutMs,
			perMessageDeflate: false,
		});
		let timer = setTimeout(
			() => done(fail('unreachable', 'The machine did not answer.')),
			connectTimeoutMs * 2
		);
		options.signal?.addEventListener('abort', () => done(fail('closed', 'Pairing cancelled.')), {
			once: true,
		});
		let machineCert: string | null = null;
		let party: CPaceParty | null = null;
		let machineName = '';
		/**
		 * The machine proved the code: its tag checked out and ours went back. Only then may it say `pair-wait` or
		 * `paired`; a listener that skips CPace or failed it is not a machine this device pairs with (security review
		 * R2–R4, V1).
		 */
		let proven = false;
		const send = (message: PairMessage) => ws.send(encodeFrame(message));
		ws.on('upgrade', (response: IncomingMessage) => {
			const cert = (response.socket as TLSSocket).getPeerX509Certificate?.();
			machineCert = cert ? cert.toString() : null;
		});
		ws.on('error', (error) =>
			done(fail('unreachable', `Could not reach ${options.host}: ${error.message}`))
		);
		ws.on('close', () => done(fail('closed', 'The machine closed the pairing.')));
		ws.on('message', (data) => {
			let message: unknown;
			try {
				message = decodeFrame(data.toString());
			} catch {
				return done(fail('closed', 'The machine sent something unexpected.'));
			}
			if (!isPairServerMessage(message))
				return done(fail('closed', 'The machine sent something unexpected.'));
			switch (message.t) {
				case 'pair-hello': {
					if (message.v !== protocolVersion || message.table !== options.tableHash)
						return done(fail('version', `Update Brigadir on ${message.machine}.`));
					if (!machineCert || !isPeerCertificate(machineCert))
						return done(fail('closed', 'The machine has no valid certificate.'));
					machineName = message.machine;
					party = new CPaceParty(
						'initiator',
						{
							prs: utf8(code),
							ci: channelIdentifier(machineCert, options.identity.cert),
							sid: unb64(message.sid),
						},
						utf8(options.deviceName)
					);
					send({ t: 'pair-a', share: b64(party.share), device: options.deviceName });
					return;
				}
				case 'pair-b': {
					if (!party || proven)
						return done(fail('closed', 'The machine sent something unexpected.'));
					try {
						party.finish(unb64(message.share), utf8(machineName));
					} catch {
						return done(fail('code', 'The code did not match.'));
					}
					// The machine's tag first: a wrong code is seen here, and our tag is never sent for it.
					if (!party.verify(unb64(message.tag))) {
						send({ t: 'pair-confirm', tag: b64(new Uint8Array(64)) });
						return;
					}
					proven = true;
					send({ t: 'pair-confirm', tag: b64(party.tag()) });
					return;
				}
				case 'pair-wait':
					if (!proven) return done(fail('code', 'The code did not match.'));
					options.onWait?.(machineName);
					clearTimeout(timer);
					timer = setTimeout(
						() => done(fail('closed', 'Nobody confirmed the device.')),
						pairingWaitMs
					);
					return;
				case 'paired': {
					if (!proven || !machineCert) return done(fail('code', 'The code did not match.'));
					const cert = machineCert;
					return done({
						result: {
							ok: true,
							machine: {
								id: fingerprintOf(cert),
								name: message.machine.name,
								addresses: withHost(message.machine.addresses, host),
								port: message.machine.port,
								pairingPort: message.machine.pairingPort,
								pairedAt: new Date().toISOString(),
								lastConnectedAt: null,
							},
						},
						record: {
							id: fingerprintOf(cert),
							name: message.machine.name,
							cert,
							addresses: withHost(message.machine.addresses, host),
							port: message.machine.port,
							pairingPort: message.machine.pairingPort,
							pairedAt: new Date().toISOString(),
							lastConnectedAt: null,
						},
					});
				}
				case 'pair-refused': {
					const words: Record<string, string> = {
						code: 'The code did not match.',
						exhausted: 'Too many wrong codes: start pairing again on the machine.',
						closed: 'The pairing window on the machine is closed.',
						declined: 'The machine declined this device.',
						busy: 'Another device is pairing now.',
						version: 'Update Brigadir on the machine.',
					};
					return done(fail(message.reason, words[message.reason]!, message.attemptsLeft));
				}
			}
		});
	});
}
/** The address that answered stays first in the machine's list. */
function withHost(addresses: RemoteAddress[], host: string): RemoteAddress[] {
	if (addresses.some((item) => item.address === host)) return addresses;
	return [{ network: addresses[0]?.network ?? 'lan', address: host }, ...addresses].slice(0, 32);
}

export type LinkEvents = {
	event(channel: string, value: unknown): void;
	session(session: RemoteSession): void;
	control(control: RemoteControl): void;
	/** The machine sent its current name and addresses at login. */
	machine(record: MachineRecord): void;
};
export type LinkOptions = {
	log?: (line: string) => void;
	/** Heartbeat, handshake and racing times (spec/remote-access-and-mobile#networking); tests shorten them. */
	timing?: Partial<LinkTiming>;
	/** This computer's interfaces, for the order of addresses; tests pass their own. */
	interfaces?: () => LocalInterfaces;
	random?: () => number;
};
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type Opened = { ws: WebSocket; address: RemoteAddress };

/** One device → machine connection. */
export class RemoteLink {
	private ws: WebSocket | null = null;
	private resume: string | null = null;
	private pending = new Map<number, Pending>();
	private next = 1;
	private address: RemoteAddress | null = null;
	private state: RemoteSession['state'] = 'connecting';
	private closedReason: string | null = null;
	private latency: number | null = null;
	private active = false;
	private attempt = 0;
	private attempting = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private ticker: ReturnType<typeof setInterval> | null = null;
	private checkTimer: ReturnType<typeof setTimeout> | null = null;
	private beat: Heartbeat | null = null;
	private nextAttemptMs: number | null = null;
	private since: string | null = null;
	private generation = 0;
	/** Pongs so far: a network change waits for one more. */
	private pongs = 0;
	private channels: string[] = [];
	/** A move to a better address is under way: calls wait for it (spec/remote-access-and-mobile#networking). */
	private moving: Promise<void> | null = null;
	private readonly timing: LinkTiming;
	private readonly log: (line: string) => void;
	private readonly interfaces: () => LocalInterfaces;
	private readonly random: () => number;
	constructor(
		private machine: MachineRecord,
		private readonly identity: Identity,
		private readonly tableHash: string,
		private readonly on: LinkEvents,
		options: LinkOptions | ((line: string) => void) = {}
	) {
		const settings = typeof options === 'function' ? { log: options } : options;
		this.timing = { ...defaultLinkTiming, ...settings.timing };
		this.log = settings.log ?? (() => {});
		this.interfaces = settings.interfaces ?? (() => networkInterfaces());
		this.random = settings.random ?? Math.random;
	}
	get machineId() {
		return this.machine.id;
	}
	/** The machine as this link knows it now: its name and addresses from the last login. */
	get record(): MachineRecord {
		return this.machine;
	}
	/** spec/remote-access-and-mobile#networking: addresses heard over mDNS join the ones the next reconnect tries. */
	learn(addresses: readonly RemoteAddress[]) {
		const known = new Set(this.machine.addresses.map((item) => item.address));
		const fresh = addresses.filter((item) => !known.has(item.address));
		if (fresh.length)
			this.machine = {
				...this.machine,
				addresses: [...this.machine.addresses, ...fresh].slice(0, 32),
			};
	}
	session(): RemoteSession {
		return {
			machineId: this.machine.id,
			machineName: this.machine.name,
			state: this.state,
			address: this.address,
			latencyMs: this.latency,
			active: this.active,
			closedReason: this.closedReason,
			nextAttemptMs: this.nextAttemptMs,
			since: this.since,
			generation: this.generation,
		};
	}
	/** The event channels the window listens to; sent again after every reconnect. */
	subscribe(channels: string[]) {
		this.channels = [...channels];
		this.sendFrame({ t: 'subscribe', channels: this.channels });
	}
	/** The first connection: the password, never stored. */
	async connect(password: string, takeOver: boolean): Promise<RemoteConnectResult> {
		this.state = 'connecting';
		this.publish();
		const result = await this.login({ password, resume: null, takeOver });
		if (!result.ok) {
			this.state = 'closed';
			this.closedReason = result.reason;
			this.publish();
		}
		return result;
	}
	invoke(channel: string, args: readonly unknown[]): Promise<unknown> {
		// A move to a better address finishes first: the call goes over the new connection.
		if (this.moving) return this.moving.then(() => this.invoke(channel, args));
		const ws = this.ws;
		if (!ws || ws.readyState !== ws.OPEN || this.state !== 'connected')
			return Promise.reject(new Error(`Not connected to ${this.machine.name}.`));
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				ws.send(
					encodeFrame({ t: 'invoke', id, channel, args: [...args] } satisfies GatewayMessage)
				);
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	takeControl() {
		this.sendFrame({ t: 'take-control' });
	}
	/** The person disconnects: no reconnect. */
	close(reason = 'user') {
		this.stop(reason);
	}
	/**
	 * spec/remote-access-and-mobile#networking: this computer's network changed (an interface came or went, the lid opened). A live connection is
	 * asked to answer within `checkMs` — else it is dropped and dialled again at once; one already reconnecting tries now;
	 * one that answers moves to a better address if one answers too.
	 */
	networkChanged() {
		if (this.state === 'reconnecting') {
			this.attempt = 0;
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
			void this.attemptNow();
			return;
		}
		const ws = this.ws,
			beat = this.beat;
		if (this.state !== 'connected' || !ws || !beat) return;
		const pongs = this.pongs;
		beat.pingSoon();
		this.tick(ws);
		if (this.checkTimer) clearTimeout(this.checkTimer);
		this.checkTimer = setTimeout(() => {
			this.checkTimer = null;
			if (this.ws !== ws) return;
			// The answer to this very ping: a frame that was already on its way says nothing about the new network.
			if (this.pongs === pongs) {
				this.log(`remote: ${this.machine.name}: no answer after a network change`);
				this.attempt = 0;
				ws.terminate();
				return;
			}
			void this.moveToBetter();
		}, this.timing.checkMs);
		this.checkTimer.unref?.();
	}
	private stop(reason: string) {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.nextAttemptMs = null;
		this.resume = null;
		this.state = 'closed';
		this.closedReason = reason;
		this.active = false;
		const ws = this.ws;
		this.ws = null;
		this.teardown(ws, `Disconnected from ${this.machine.name}.`);
		ws?.close(1000, reason);
		this.publish();
	}
	private stopBeat() {
		if (this.ticker) clearInterval(this.ticker);
		if (this.checkTimer) clearTimeout(this.checkTimer);
		this.ticker = this.checkTimer = null;
		this.beat = null;
	}
	private teardown(ws: WebSocket | null, message: string) {
		this.stopBeat();
		ws?.removeAllListeners();
		ws?.on('error', () => {});
		for (const pending of this.pending.values()) pending.reject(new Error(message));
		this.pending.clear();
	}
	private sendFrame(message: GatewayMessage) {
		const ws = this.ws;
		if (ws && ws.readyState === ws.OPEN && this.state === 'connected')
			ws.send(encodeFrame(message));
	}
	private publish() {
		this.on.session(this.session());
	}
	/** spec/remote-access-and-mobile#networking: the remembered addresses in rank order, raced; the first pinned WebSocket wins. */
	private async open(only?: (address: RemoteAddress) => boolean): Promise<Opened | null> {
		const ranked = rankAddresses(
			this.machine.addresses.filter((address) => !only || only(address)),
			this.interfaces(),
			this.address?.address ?? null
		);
		const won = await raceAddresses(
			ranked,
			(address, signal) => this.dial(address, signal),
			(ws) => ws.terminate(),
			this.timing.staggerMs
		);
		return won ? { ws: won.value, address: won.address } : null;
	}
	private dial(address: RemoteAddress, signal: AbortSignal): Promise<WebSocket | null> {
		return new Promise((resolve) => {
			// `checkServerIdentity` goes to `tls.connect` as is; ws types it after its own older signature.
			const options = {
				key: this.identity.key,
				cert: this.identity.cert,
				ca: [this.machine.cert],
				minVersion: 'TLSv1.3',
				// Pinned: the machine's exact certificate from pairing; its name does not matter.
				checkServerIdentity: (_host: string, cert: PeerCertificate) =>
					cert.fingerprint256.replace(/:/g, '').toLowerCase() === this.machine.id
						? undefined
						: new Error('The machine presented another certificate.'),
				maxPayload: gatewayFrameLimit,
				handshakeTimeout: this.timing.dialMs,
				perMessageDeflate: { threshold: 1024 },
			};
			let settled = false;
			const settle = (value: WebSocket | null) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const ws = new WebSocket(
				`wss://${hostPort(address.address, this.machine.port)}/v1`,
				options as unknown as ClientOptions
			);
			// The race went to another address: this one closes, whatever stage it is in.
			signal.addEventListener(
				'abort',
				() => {
					if (settled) return;
					ws.removeAllListeners();
					ws.on('error', () => {});
					ws.terminate();
					settle(null);
				},
				{ once: true }
			);
			let pinnedOk = false;
			ws.once('upgrade', (response: IncomingMessage) => {
				pinnedOk = fingerprint256(response.socket as TLSSocket) === this.machine.id;
			});
			ws.once('open', () => {
				ws.removeAllListeners('error');
				if (!pinnedOk) {
					ws.terminate();
					return settle(null);
				}
				settle(ws);
			});
			ws.once('error', (error) => {
				this.log(`remote: ${address.address}: ${error.message}`);
				settle(null);
			});
		});
	}
	private async login(
		credentials: {
			password: string | null;
			resume: string | null;
			takeOver: boolean;
		},
		ready?: Opened
	): Promise<RemoteConnectResult> {
		const refused = (
			reason: Extract<RemoteConnectResult, { ok: false }>['reason'],
			message: string,
			extra: {
				retryAfterMs?: number | null;
				attemptsLeft?: number | null;
				machine?: string | null;
			} = {}
		): RemoteConnectResult => ({
			ok: false,
			reason,
			message,
			retryAfterMs: extra.retryAfterMs ?? null,
			attemptsLeft: extra.attemptsLeft ?? null,
			machine: extra.machine ?? null,
		});
		const opened = ready ?? (await this.open());
		if (!opened) return refused('unreachable', `${this.machine.name} is not reachable.`);
		if (!ready) this.address = opened.address;
		const ws = opened.ws;
		return new Promise<RemoteConnectResult>((resolve) => {
			let welcomed = false;
			const fail = (result: RemoteConnectResult) => {
				ws.removeAllListeners();
				ws.on('error', () => {});
				ws.close();
				resolve(result);
			};
			ws.on('error', () => {});
			ws.on('close', () => {
				if (!welcomed) fail(refused('unreachable', `${this.machine.name} closed the connection.`));
			});
			ws.on('message', (data, binary) => {
				let message: unknown;
				try {
					// spec/remote-access-and-mobile#browser-from-device: events with bytes come as binary frames, and only after the welcome.
					if (binary && !welcomed) throw new Error('binary before welcome');
					message = binary ? decodeBinaryFrame(asBytes(data)) : decodeFrame(data.toString());
					if (binary && (message as { t?: unknown } | null)?.t !== 'event')
						throw new Error('only events are binary');
				} catch {
					return welcomed ? ws.terminate() : fail(refused('unreachable', 'Unexpected answer.'));
				}
				if (!isGatewayServerMessage(message))
					return welcomed ? ws.terminate() : fail(refused('unreachable', 'Unexpected answer.'));
				if (!welcomed) {
					if (message.t === 'refused') {
						const words: Record<string, string> = {
							password: 'Wrong password.',
							wait: 'Too many tries: wait a little.',
							blocked: `This device is blocked on ${this.machine.name}: unblock it there.`,
							version: `Update Brigadir on ${message.machine ?? this.machine.name}.`,
							unknown: `${this.machine.name} does not know this device any more: pair again.`,
							off: `Remote access is off on ${this.machine.name}.`,
							expired: 'Enter the password again.',
							local: `Someone works on ${this.machine.name} now.`,
						};
						const reason = message.reason === 'expired' ? 'password' : message.reason;
						return fail(
							refused(reason, words[message.reason]!, {
								retryAfterMs: message.retryAfterMs,
								attemptsLeft: message.attemptsLeft,
								machine: message.machine,
							})
						);
					}
					if (message.t !== 'welcome') return fail(refused('unreachable', 'Unexpected answer.'));
					welcomed = true;
					// A move: the old connection goes quietly; the machine closes it as `replaced` anyway.
					const previous = this.ws;
					if (previous && previous !== ws) {
						this.stopBeat();
						previous.removeAllListeners();
						previous.on('error', () => {});
						previous.close(1000, 'moved');
					}
					this.ws = ws;
					this.address = opened.address;
					this.resume = message.resume;
					this.state = 'connected';
					this.closedReason = null;
					this.attempt = 0;
					this.nextAttemptMs = null;
					this.generation++;
					this.active = message.control.self;
					this.since ??= new Date().toISOString();
					this.machine = {
						...this.machine,
						name: message.machine.name,
						addresses: mergeLoginAddresses(
							message.machine.addresses,
							this.machine.addresses,
							this.address
						),
						port: message.machine.port,
						pairingPort: message.machine.pairingPort,
						lastConnectedAt: new Date().toISOString(),
					};
					this.on.machine(this.machine);
					ws.removeAllListeners('close');
					ws.on('close', (code, reason) => this.lost(ws, code, reason.toString()));
					this.startBeat(ws);
					if (this.channels.length) this.sendFrame({ t: 'subscribe', channels: this.channels });
					this.on.control(message.control);
					this.publish();
					return resolve({ ok: true });
				}
				this.receive(message);
			});
			ws.send(
				encodeFrame({
					t: 'login',
					v: protocolVersion,
					table: this.tableHash,
					password: credentials.password,
					resume: credentials.resume,
					takeOver: credentials.takeOver,
				} satisfies GatewayMessage)
			);
		});
	}
	private receive(message: GatewayMessage) {
		switch (message.t) {
			case 'result': {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				if (message.ok) pending.resolve(message.value);
				else pending.reject(new Error(message.error));
				return;
			}
			case 'event':
				// Only what the window subscribed to: a machine must not reach the device's own channels — its menu
				// actions, navigation, theme, pairing and session state (security review R1, S2).
				if (!this.channels.includes(message.channel)) return;
				if (message.channel === 'remote:control') {
					const control = message.value as RemoteControl;
					this.active = Boolean(control?.self);
					this.publish();
				}
				// What the device makes of a machine's event is the device's own business: a throw there must not stop the
				// socket's reader and lose every frame after it (security review R2–R4, V4).
				try {
					this.on.event(message.channel, message.value);
				} catch (error) {
					this.log(
						`remote: ${this.machine.name}: ${message.channel}: ${error instanceof Error ? error.message : String(error)}`
					);
				}
				return;
			case 'pong':
				this.pongs++;
				this.latency = Math.max(0, Date.now() - message.at);
				this.publish();
				return;
			case 'bye':
				// The machine ends it on purpose: revoked, access off, a new password, a newer connection — no reconnect.
				this.stop(message.reason);
				return;
		}
	}
	/** spec/remote-access-and-mobile#networking: a ping every `pingMs`; nothing from the machine for `deadMs` — the socket goes, a reconnect follows. */
	private startBeat(ws: WebSocket) {
		this.stopBeat();
		const beat = new Heartbeat(this.timing, Date.now());
		this.beat = beat;
		ws.on('message', () => beat.heard(Date.now()));
		this.ticker = setInterval(
			() => this.tick(ws),
			Math.max(50, Math.min(1000, this.timing.pingMs / 4))
		);
		this.ticker.unref?.();
	}
	private tick(ws: WebSocket) {
		const beat = this.beat;
		if (!beat || this.ws !== ws || ws.readyState !== ws.OPEN) return;
		const now = Date.now(),
			what = beat.tick(now);
		if (what === 'dead') {
			this.log(
				`remote: ${this.machine.name}: nothing for ${beat.sinceHeard(now)} ms, reconnecting`
			);
			ws.terminate();
		} else if (what === 'ping')
			ws.send(encodeFrame({ t: 'ping', at: now } satisfies GatewayMessage));
	}
	/** The network dropped it: reconnect with the resume token, with backoff. */
	private lost(ws: WebSocket, code: number, reason: string) {
		if (this.ws !== ws || this.state === 'closed') return;
		this.ws = null;
		this.teardown(ws, `Connection to ${this.machine.name} was lost.`);
		if (code === 4003 || code === 4001) return this.stop(reason || 'closed');
		this.state = 'reconnecting';
		this.schedule();
	}
	/**
	 * spec/remote-access-and-mobile#networking: the next try after a pause. The device keeps trying while its window is open; whether the token still
	 * holds is the machine's call (`expired` asks for the password) — a machine that slept has not counted its minutes.
	 */
	private schedule() {
		if (!this.resume) return this.stop('expired');
		const delay = reconnectDelay(this.attempt, this.random);
		this.attempt++;
		this.nextAttemptMs = delay;
		this.publish();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.attemptNow();
		}, delay);
		this.reconnectTimer.unref?.();
	}
	private async attemptNow() {
		if (this.attempting || this.state !== 'reconnecting' || !this.resume) return;
		this.attempting = true;
		try {
			const result = await this.login({
				password: null,
				resume: this.resume,
				takeOver: this.active,
			});
			if (result.ok || this.state !== 'reconnecting') return;
			if (result.reason === 'unreachable') return this.schedule();
			this.stop(result.reason === 'password' ? 'expired' : result.reason);
		} finally {
			this.attempting = false;
		}
	}
	/**
	 * spec/remote-access-and-mobile#networking: connected through a worse address (Tailscale or another LAN) while a better one answers now — the
	 * same session moves there with its resume token once no call is on the way. No password, no new window state.
	 */
	private async moveToBetter() {
		const current = this.address;
		if (this.state !== 'connected' || this.moving || !current || !this.resume) return;
		const local = this.interfaces(),
			rank = addressRank(current, local),
			better = new Set(
				this.machine.addresses
					.filter((item) => item.address !== current.address && addressRank(item, local) < rank)
					.map((item) => item.address)
			);
		if (!better.size) return;
		const until = Date.now() + 5000;
		while (this.pending.size && Date.now() < until)
			await new Promise((resolve) => setTimeout(resolve, 50));
		if (this.pending.size || this.state !== 'connected' || this.moving) return;
		const resume = this.resume;
		this.moving = (async () => {
			const opened = await this.open((item) => better.has(item.address));
			if (!opened) return;
			if (this.state !== 'connected' || this.resume !== resume) return void opened.ws.terminate();
			const result = await this.login({ password: null, resume, takeOver: this.active }, opened);
			if (result.ok) this.log(`remote: ${this.machine.name}: moved to ${opened.address.address}`);
		})()
			.catch(() => {})
			.finally(() => {
				this.moving = null;
			});
		await this.moving;
	}
}
