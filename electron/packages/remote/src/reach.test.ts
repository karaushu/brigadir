import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import type { RemoteAddress } from '@brigadir/core';
import {
	Heartbeat,
	addressRank,
	mergeFoundAddresses,
	mergeLoginAddresses,
	raceAddresses,
	rankAddresses,
	reconnectDelay,
	reconnectPauses,
} from './reach';
import { hasTailscaleInterface, onSameSubnet } from './interfaces';
import { mdnsId, mdnsInstance, toFound } from './mdns';

const nic = (address: string, netmask: string, internal = false): NetworkInterfaceInfo =>
	({
		address,
		netmask,
		family: address.includes(':') ? 'IPv6' : 'IPv4',
		mac: '02:00:00:00:00:01',
		internal,
		cidr: null,
		...(address.includes(':') ? { scopeid: 0 } : {}),
	}) as NetworkInterfaceInfo;
const home = {
	lo0: [nic('127.0.0.1', '255.0.0.0', true)],
	en0: [nic('192.168.1.20', '255.255.255.0'), nic('fd12:3456:789a:1::20', 'ffff:ffff:ffff:ffff::')],
};
const away = {
	lo0: [nic('127.0.0.1', '255.0.0.0', true)],
	en0: [nic('10.20.30.40', '255.255.0.0')],
	utun4: [
		nic('100.101.1.2', '255.255.255.255'),
		nic('fd7a:115c:a1e0::12', 'ffff:ffff:ffff:ffff::'),
	],
};
const lan = (address: string): RemoteAddress => ({ network: 'lan', address });
const tailnet = (address: string): RemoteAddress => ({ network: 'tailscale', address });

describe('which address first (spec/remote-access-and-mobile#networking)', () => {
	it('knows a subnet by the netmask for IPv4 and by /64 for IPv6, and never by link-local', () => {
		expect(onSameSubnet('192.168.1.5', home)).toBe(true);
		expect(onSameSubnet('192.168.2.5', home)).toBe(false);
		expect(onSameSubnet('fd12:3456:789a:1::5', home)).toBe(true);
		expect(onSameSubnet('fd12:3456:789a:2::5', home)).toBe(false);
		expect(onSameSubnet('10.20.99.1', away)).toBe(true);
		expect(onSameSubnet('fe80::1', { en0: [nic('fe80::2', 'ffff:ffff:ffff:ffff::')] })).toBe(false);
		expect(hasTailscaleInterface(away)).toBe(true);
		expect(hasTailscaleInterface(home)).toBe(false);
	});
	it('puts the home LAN first at home and Tailscale first away, the last good one first within a rank', () => {
		const addresses = [
			tailnet('100.64.8.3'),
			lan('fd12:3456:789a:1::24'),
			lan('192.168.1.24'),
			lan('10.0.0.9'),
			tailnet('fd7a:115c:a1e0::3'),
		];
		expect(rankAddresses(addresses, home).map((item) => item.address)).toEqual([
			'192.168.1.24',
			'fd12:3456:789a:1::24',
			'10.0.0.9',
			'100.64.8.3',
			'fd7a:115c:a1e0::3',
		]);
		expect(rankAddresses(addresses, away).map((item) => item.address)).toEqual([
			'100.64.8.3',
			'fd7a:115c:a1e0::3',
			'192.168.1.24',
			'10.0.0.9',
			'fd12:3456:789a:1::24',
		]);
		expect(rankAddresses(addresses, away, 'fd7a:115c:a1e0::3')[0]!.address).toBe(
			'fd7a:115c:a1e0::3'
		);
		expect(addressRank({ network: 'loopback', address: '127.0.0.1' }, away)).toBe(0);
		expect(addressRank(tailnet('100.64.8.3'), home)).toBe(3);
	});
});

describe('racing the addresses (happy eyeballs)', () => {
	it('starts the next address after the stagger or a failure, keeps the first answer and closes the late ones', async () => {
		const started: string[] = [],
			disposed: string[] = [],
			aborted: string[] = [];
		const timings: Record<string, { ms: number; ok: boolean }> = {
			a: { ms: 400, ok: true },
			b: { ms: 10, ok: false },
			c: { ms: 60, ok: true },
			d: { ms: 30, ok: true },
		};
		const won = await raceAddresses(
			['a', 'b', 'c', 'd'].map(lan),
			(address, signal) =>
				new Promise<string | null>((resolve) => {
					started.push(address.address);
					signal.addEventListener('abort', () => aborted.push(address.address));
					setTimeout(
						() => resolve(timings[address.address]!.ok ? address.address : null),
						timings[address.address]!.ms
					);
				}),
			(value) => disposed.push(value),
			100
		);
		// a starts; 100 ms later b, which fails at once and starts c; c answers before a and d.
		expect(won).toEqual({ address: lan('c'), value: 'c' });
		expect(started.slice(0, 3)).toEqual(['a', 'b', 'c']);
		expect(aborted).toContain('a');
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(disposed).toContain('a');
	});
	it('gives null when every address failed, and for none', async () => {
		expect(
			await raceAddresses(
				[lan('a'), lan('b')],
				async () => null,
				() => {},
				10
			)
		).toBeNull();
		expect(
			await raceAddresses(
				[],
				async () => 'x',
				() => {},
				10
			)
		).toBeNull();
	});
});

describe('reconnect and heartbeat (spec/remote-access-and-mobile#networking)', () => {
	it('pauses 0.5 s, 1, 2, 4, 8, 15, then 30 s, each within ±20 %', () => {
		expect(reconnectPauses).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 30_000]);
		expect(reconnectDelay(0, () => 0.5)).toBe(500);
		expect(reconnectDelay(0, () => 0)).toBe(400);
		expect(reconnectDelay(0, () => 1)).toBe(600);
		expect(reconnectDelay(40, () => 0.5)).toBe(30_000);
		expect(reconnectDelay(-3, () => 0.5)).toBe(500);
	});
	it('pings every 10 s and calls a link dead after 25 s of silence; any frame counts as heard', () => {
		const beat = new Heartbeat({ pingMs: 10_000, deadMs: 25_000 }, 0);
		expect(beat.tick(5_000)).toBeNull();
		expect(beat.tick(10_000)).toBe('ping');
		expect(beat.tick(15_000)).toBeNull();
		expect(beat.tick(20_000)).toBe('ping');
		expect(beat.tick(24_999)).toBeNull();
		expect(beat.tick(25_000)).toBe('dead');
		beat.heard(26_000);
		expect(beat.tick(27_000)).toBeNull();
		beat.pingSoon();
		expect(beat.tick(27_001)).toBe('ping');
		expect(beat.sinceHeard(30_000)).toBe(4_000);
	});
});

describe('the addresses a device keeps (spec/remote-access-and-mobile#networking)', () => {
	it('takes the machine’s list at login, the address that worked and remembered Tailscale ones, drops stale LAN', () => {
		expect(
			mergeLoginAddresses(
				[lan('192.168.1.30')],
				[lan('192.168.1.24'), tailnet('100.64.8.3')],
				lan('192.168.1.30')
			)
		).toEqual([lan('192.168.1.30'), tailnet('100.64.8.3')]);
		expect(mergeLoginAddresses([lan('192.168.1.30')], [], lan('studio.local'))).toEqual([
			lan('studio.local'),
			lan('192.168.1.30'),
		]);
		expect(
			mergeLoginAddresses(
				Array.from({ length: 40 }, (_, index) => lan(`10.0.0.${index}`)),
				[],
				null
			)
		).toHaveLength(32);
	});
	it('learns private LAN addresses from mDNS, never 100.64/10, public or link-local ones', () => {
		expect(
			mergeFoundAddresses(
				[lan('192.168.1.24')],
				['192.168.1.24', '192.168.1.25', '100.64.8.3', '8.8.8.8', 'fe80::1%en0', 'fd12::5']
			)
		).toEqual([lan('192.168.1.24'), lan('192.168.1.25'), lan('fd12::5')]);
	});
});

describe('mDNS record (spec/remote-access-and-mobile#networking)', () => {
	it('says a short id of the certificate, not the fingerprint, and a unique instance name', () => {
		const fingerprint = 'a'.repeat(64);
		const id = mdnsId(fingerprint);
		expect(id).toMatch(/^[0-9a-f]{16}$/);
		expect(fingerprint).not.toContain(id);
		expect(mdnsId('b'.repeat(64))).not.toBe(id);
		expect(mdnsInstance('studio', id)).toBe(`studio (${id.slice(0, 6)})`);
	});
	it('reads a record defensively: its name, id, LAN addresses and the pairing port', () => {
		expect(
			toFound({
				name: 'studio (abcdef)',
				port: 7420,
				addresses: ['192.168.1.24', 'fe80::1%en0', '8.8.8.8', '192.168.1.24'],
				txt: { id: 'abcdef0123456789', n: 'studio', pp: '7421', v: '2' },
			})
		).toEqual({
			name: 'studio',
			id: 'abcdef0123456789',
			addresses: ['192.168.1.24'],
			port: 7420,
			pairingPort: 7421,
		});
		expect(
			toFound({
				name: 'old (123456)',
				port: 7420,
				addresses: ['10.0.0.2'],
				txt: { id: 'x'.repeat(64), pp: 'nope' },
			})
		).toMatchObject({ name: 'old', id: null, pairingPort: 7421 });
		// Security review R2–R4, V8: a direction override does not reorder a name in the list.
		expect(
			toFound({
				name: 'x',
				port: 7420,
				addresses: ['10.0.0.2'],
				txt: { n: 'studio\u202Egnp.exe\u202C', v: '2' },
			}).name
		).toBe('studiognp.exe');
	});
});
