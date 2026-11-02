import { describe, expect, it } from 'vitest';
import type { PairedMachine, RemoteSession } from '@brigadir/core';
import { addressNetwork, machineReach, reachDot, reachLine, reachShort } from './remote-text';

describe('the network next to an address (spec/remote-access-and-mobile#pairing, security review R1, S7)', () => {
	it('shows what the gateway decided, not a guess from 100.64.0.0/10', () => {
		// A phone's hotspot: CGNAT on a LAN listener.
		expect(addressNetwork('100.64.0.7', 'lan')).toBe('LAN');
		expect(addressNetwork('100.101.1.1', 'tailscale')).toBe('Tailscale');
		expect(addressNetwork('127.0.0.1', 'loopback')).toBe('loopback');
	});
	it('reads lines written before the network was stored as that gateway did', () => {
		expect(addressNetwork('100.101.1.1')).toBe('Tailscale');
		expect(addressNetwork('100.101.1.1', null)).toBe('Tailscale');
		expect(addressNetwork('fd7a:115c:a1e0::5')).toBe('Tailscale');
		expect(addressNetwork('192.168.1.2')).toBe('LAN');
	});
});

describe('a paired machine in the chip and in Settings ▸ Remote (spec/remote-access-and-mobile#remote-button)', () => {
	const now = new Date(2026, 9, 16, 19, 0).getTime();
	const studio: PairedMachine = {
		id: 'a'.repeat(64),
		name: 'studio',
		addresses: [{ network: 'lan', address: '192.168.1.24' }],
		port: 7420,
		pairingPort: 7421,
		pairedAt: new Date(2026, 9, 1).toISOString(),
		lastConnectedAt: new Date(2026, 9, 16, 18, 5).toISOString(),
	};
	it('checks until the touch answers, then names the network that answered', () => {
		const checking = machineReach(studio, [], []);
		expect(checking.state).toBe('check');
		expect(reachDot(checking)).toBeUndefined();
		expect(reachShort('uk', checking)).toBe('Перевіряю…');
		expect(reachLine('uk', studio, checking, now)).toBe('Перевіряю LAN і Tailscale…');
		const answered = machineReach(
			studio,
			[
				{
					machineId: studio.id,
					state: 'answered',
					network: 'tailscale',
					address: '100.64.8.3',
					tailscale: true,
				},
			],
			[]
		);
		expect(reachDot(answered)).toBe('on');
		expect(reachShort('uk', answered)).toBe('Tailscale · доступна');
		expect(reachLine('uk', studio, answered, now)).toMatch(
			/^Tailscale · 100\.64\.8\.3 · востаннє /
		);
	});
	it('says a machine that does not answer, and an open window first', () => {
		const silent = machineReach(
			studio,
			[{ machineId: studio.id, state: 'silent', network: null, address: null, tailscale: false }],
			[]
		);
		expect(reachDot(silent)).toBe('off');
		expect(reachShort('en', silent)).toBe('Unavailable');
		expect(reachLine('uk', studio, silent, now)).toMatch(/^Недоступна поза LAN без Tailscale · /);
		const session: RemoteSession = {
			machineId: studio.id,
			machineName: 'studio',
			state: 'connected',
			address: { network: 'lan', address: '192.168.1.24' },
			latencyMs: 4,
			active: true,
			closedReason: null,
			nextAttemptMs: null,
			since: new Date(2026, 9, 16, 19, 20).toISOString(),
		} as RemoteSession;
		const live = machineReach(studio, [], [], [session]);
		expect(live.state).toBe('live');
		expect(reachShort('uk', live)).toBe('Вікно відкрите · LAN · 4 мс');
		expect(reachLine('uk', studio, live, now)).toBe('LAN · 192.168.1.24 · 4 мс · з 19:20');
	});
});
