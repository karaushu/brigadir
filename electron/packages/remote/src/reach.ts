/**
 * spec/remote-access-and-mobile#networking: how a device reaches a paired machine over a real network — which address first, racing the rest,
 * the heartbeat that tells a sleeping machine from a quiet one, the reconnect pauses, the addresses it keeps, and the
 * TLS touch that says whether a machine answers before anyone types a password.
 */
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { RemoteAddress } from '@brigadir/core';
import type { Identity } from './cert';
import { classifyAddress, hasTailscaleInterface, ipv4, isCgnat, onSameSubnet } from './interfaces';

export type LocalInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;
/**
 * The rank of an address from this computer (lower first): 0 — loopback or a LAN address on one of our subnets;
 * 1 — Tailscale while Tailscale is up here; 2 — another LAN (routed, a VPN); 3 — Tailscale without Tailscale here.
 */
export function addressRank(
	address: RemoteAddress,
	local: LocalInterfaces = networkInterfaces()
): number {
	if (address.network === 'loopback') return 0;
	if (address.network === 'lan') return onSameSubnet(address.address, local) ? 0 : 2;
	return hasTailscaleInterface(local) ? 1 : 3;
}
/** spec/remote-access-and-mobile#networking: the order to try a machine's addresses in — by rank, the last good one first, IPv4 before IPv6. */
export function rankAddresses(
	addresses: readonly RemoteAddress[],
	local: LocalInterfaces = networkInterfaces(),
	last: string | null = null
): RemoteAddress[] {
	const keyed = addresses.map((address, index) => ({
		address,
		key: [
			addressRank(address, local),
			address.address === last ? 0 : 1,
			ipv4(address.address) ? 0 : 1,
			index,
		],
	}));
	keyed.sort((a, b) => {
		for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! - b.key[i]!;
		return 0;
	});
	return keyed.map((item) => item.address);
}

/**
 * spec/remote-access-and-mobile#networking, happy eyeballs: the next address starts `staggerMs` after the one before or as soon as it fails; the
 * first value wins, the others are aborted, and a late value is handed to `dispose`. Null when every address failed.
 */
export function raceAddresses<T>(
	addresses: readonly RemoteAddress[],
	dial: (address: RemoteAddress, signal: AbortSignal) => Promise<T | null>,
	dispose: (value: T) => void,
	staggerMs = 250
): Promise<{ address: RemoteAddress; value: T } | null> {
	return new Promise((resolve) => {
		if (!addresses.length) return resolve(null);
		const controllers: AbortController[] = [];
		let next = 0,
			running = 0,
			done = false,
			timer: ReturnType<typeof setTimeout> | null = null;
		const finish = (result: { address: RemoteAddress; value: T } | null) => {
			done = true;
			if (timer) clearTimeout(timer);
			for (const controller of controllers) controller.abort();
			resolve(result);
		};
		const start = () => {
			if (done || next >= addresses.length) return;
			if (timer) clearTimeout(timer);
			timer = null;
			const address = addresses[next++]!,
				controller = new AbortController();
			controllers.push(controller);
			running++;
			void dial(address, controller.signal)
				.catch(() => null)
				.then((value) => {
					running--;
					if (value !== null && value !== undefined) {
						if (done) return dispose(value);
						return finish({ address, value });
					}
					if (done) return;
					if (next < addresses.length) start();
					else if (running === 0) finish(null);
				});
			if (next < addresses.length) {
				timer = setTimeout(start, staggerMs);
				timer.unref?.();
			}
		};
		start();
	});
}

/** spec/remote-access-and-mobile#networking: reconnect pauses — 0.5, 1, 2, 4, 8, 15, then 30 s, each ±20 % so devices do not knock together. */
export const reconnectPauses = [500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const;
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
	const base = reconnectPauses[Math.min(Math.max(0, attempt), reconnectPauses.length - 1)]!;
	return Math.round(base * (0.8 + 0.4 * random()));
}

export type LinkTiming = {
	/** A ping goes this often. */
	pingMs: number;
	/** Nothing from the machine for this long: the connection is dead (spec/remote-access-and-mobile#networking). */
	deadMs: number;
	/** After a network change a ping must be answered within this. */
	checkMs: number;
	/** One address's TLS and WebSocket handshake. */
	dialMs: number;
	/** The next address starts this long after the one before. */
	staggerMs: number;
};
export const defaultLinkTiming: LinkTiming = {
	pingMs: 10_000,
	deadMs: 25_000,
	checkMs: 3_000,
	dialMs: 4_000,
	staggerMs: 250,
};
/**
 * spec/remote-access-and-mobile#networking: a ping every `pingMs`; nothing heard for `deadMs` — dead. Any frame from the machine counts as heard,
 * so a busy stream never looks dead and a quiet one is pinged. `tick` says what to do now.
 */
export class Heartbeat {
	private heardAt: number;
	private pingedAt: number;
	constructor(
		private readonly timing: Pick<LinkTiming, 'pingMs' | 'deadMs'>,
		now: number
	) {
		this.heardAt = now;
		this.pingedAt = now;
	}
	heard(now: number) {
		this.heardAt = now;
	}
	/** Ask now (a network change): the next tick pings. */
	pingSoon() {
		this.pingedAt = -Infinity;
	}
	sinceHeard(now: number) {
		return now - this.heardAt;
	}
	tick(now: number): 'dead' | 'ping' | null {
		if (now - this.heardAt >= this.timing.deadMs) return 'dead';
		if (now - this.pingedAt >= this.timing.pingMs) {
			this.pingedAt = now;
			return 'ping';
		}
		return null;
	}
}

/**
 * spec/remote-access-and-mobile#networking: what a device keeps of a machine's addresses after a login — the machine's own list first (it knows
 * its networks), the address that worked, and remembered Tailscale addresses (stable for a node); LAN addresses the
 * machine no longer names are dropped. At most 32.
 */
export function mergeLoginAddresses(
	fresh: readonly RemoteAddress[],
	remembered: readonly RemoteAddress[],
	used: RemoteAddress | null
): RemoteAddress[] {
	const out: RemoteAddress[] = [];
	const add = (item: RemoteAddress) => {
		if (!out.some((known) => known.address === item.address)) out.push(item);
	};
	for (const item of fresh) add(item);
	if (used && !out.some((known) => known.address === used.address)) out.unshift(used);
	for (const item of remembered) if (item.network === 'tailscale') add(item);
	return out.slice(0, 32);
}
/**
 * spec/remote-access-and-mobile#networking: addresses heard over mDNS join a paired machine's list — private LAN only. A 100.64/10 address may be
 * Tailscale or a hotspot's carrier NAT, and Tailscale's own come from the machine at login with their network.
 */
export function mergeFoundAddresses(
	remembered: readonly RemoteAddress[],
	found: readonly string[]
): RemoteAddress[] {
	const out = [...remembered];
	for (const address of found) {
		const plain = address.replace(/%.*$/, '');
		if (isCgnat(plain) || classifyAddress(plain) !== 'lan') continue;
		if (!out.some((known) => known.address === plain)) out.push({ network: 'lan', address: plain });
	}
	return out.slice(0, 32);
}

export type TouchResult = 'answered' | 'refused' | null;
/**
 * spec/remote-access-and-mobile#networking: one address of a paired machine — a TLS 1.3 handshake with its pinned certificate and ours, nothing
 * after it. `answered`: our machine is there; `refused`: it is there but turned our certificate down (revoked); null:
 * nothing answered within `timeoutMs`, or another certificate did.
 */
export function touchMachine(options: {
	identity: Identity;
	cert: string;
	id: string;
	address: string;
	port: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<TouchResult> {
	return new Promise((resolve) => {
		let settled = false,
			secure = false,
			grace: ReturnType<typeof setTimeout> | null = null;
		const done = (result: TouchResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (grace) clearTimeout(grace);
			socket.removeAllListeners();
			socket.on('error', () => {});
			socket.destroy();
			resolve(result);
		};
		const socket = tlsConnect({
			host: options.address.replace(/^\[|\]$/g, ''),
			port: options.port,
			key: options.identity.key,
			cert: options.identity.cert,
			ca: [options.cert],
			minVersion: 'TLSv1.3',
			checkServerIdentity: (_host: string, cert: PeerCertificate) =>
				cert.fingerprint256.replace(/:/g, '').toLowerCase() === options.id
					? undefined
					: new Error('Another certificate.'),
		});
		const timer = setTimeout(() => done(null), options.timeoutMs ?? 3000);
		timer.unref?.();
		options.signal?.addEventListener('abort', () => done(null), { once: true });
		socket.once('secureConnect', () => {
			secure = true;
			// TLS 1.3 completes here for the client before the machine checked our certificate: a refusal comes as an alert
			// right after, so wait a moment for it; a quiet socket means the machine took us.
			grace = setTimeout(() => done('answered'), 300);
			grace.unref?.();
		});
		socket.on('error', (error: NodeJS.ErrnoException) => {
			const alert = /ALERT|CERTIFICATE/i.test(`${error.code ?? ''} ${error.message}`);
			done(secure && alert ? 'refused' : secure ? 'answered' : null);
		});
		// Closed before the grace ran out: the machine dropped our certificate without an alert (not in its registry).
		socket.on('close', () => done(secure ? 'refused' : null));
	});
}
