import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, connect, type TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, fingerprintOf, isIdentity, isPeerCertificate } from './cert';
import { decodeBinaryFrame, decodeFrame, encodeBinaryFrame, encodeFrame } from './codec';
import { classifyAddress, hostPort, listenAddresses } from './interfaces';
import { PairingWindow, newPairingCode, pairingAttempts } from './pairing';
import {
	blockAfterFailures,
	hashPassword,
	isPasswordHash,
	passwordPauseMs,
	verifyPassword,
} from './password';
import { AuditLog, DeviceRegistry, RemoteFiles, loadIdentity, type KeyVault } from './store';
import { isGatewayClientMessage, isPairClientMessage } from './protocol';
import { isPairingCode, normalizePairingCode, type RemotePairing } from '@brigadir/core';

const dirs: string[] = [];
const temp = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-remote-unit-'));
	dirs.push(dir);
	return dir;
};
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('certificates (spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#transport-and-protocol)', () => {
	it('makes a self-signed P-256 identity that node:crypto reads back', () => {
		const identity = createIdentity('studio');
		expect(identity.cert).toMatch(/^-----BEGIN CERTIFICATE-----/);
		expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(fingerprintOf(identity.cert)).toBe(identity.fingerprint);
		expect(isIdentity(identity)).toBe(true);
		expect(isPeerCertificate(identity.cert)).toBe(true);
		const other = createIdentity('studio');
		expect(other.fingerprint).not.toBe(identity.fingerprint);
		// A key that is not the certificate's is not an identity.
		expect(isIdentity({ ...identity, key: other.key })).toBe(false);
		expect(isPeerCertificate('not a cert')).toBe(false);
	});
	it('pins: a mutual TLS 1.3 server with the paired certificate as its only anchor refuses another one', async () => {
		const server = createIdentity('studio'),
			paired = createIdentity('laptop'),
			stranger = createIdentity('laptop');
		const accepted: string[] = [];
		const tls = createServer({
			key: server.key,
			cert: server.cert,
			minVersion: 'TLSv1.3',
			requestCert: true,
			rejectUnauthorized: true,
			ca: [paired.cert],
		});
		tls.on('secureConnection', (socket: TLSSocket) => {
			accepted.push(fingerprintOf(socket.getPeerX509Certificate()!.raw));
			socket.end('hello');
		});
		await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
		const port = (tls.address() as { port: number }).port;
		const attempt = (who: { key: string; cert: string }) =>
			new Promise<string>((resolve) => {
				const socket = connect({
					host: '127.0.0.1',
					port,
					key: who.key,
					cert: who.cert,
					ca: [server.cert],
					minVersion: 'TLSv1.3',
					checkServerIdentity: (_host, cert) =>
						fingerprintOf(cert.raw) === server.fingerprint ? undefined : new Error('pin'),
				});
				// In TLS 1.3 the client finishes before the server judges its certificate: only data proves acceptance.
				socket.on('data', () => resolve('ok'));
				socket.on('end', () => resolve('closed'));
				socket.on('close', () => resolve('closed'));
				socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
			});
		expect(await attempt(paired)).toBe('ok');
		expect(await attempt(stranger)).not.toBe('ok');
		expect(accepted).toEqual([paired.fingerprint]);
		await new Promise((resolve) => tls.close(resolve));
	});
});

describe('password (spec/remote-access-and-mobile#architecture)', () => {
	const cheap = { N: 1 << 10, r: 8, p: 1 };
	it('keeps only a scrypt hash and checks it', async () => {
		const hash = await hashPassword('correct horse battery', cheap);
		expect(isPasswordHash(hash)).toBe(true);
		expect(JSON.stringify(hash)).not.toContain('horse');
		expect(await verifyPassword('correct horse battery', hash)).toBe(true);
		expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
		expect(await verifyPassword('', hash)).toBe(false);
	});
	it('wants at least ten characters', async () => {
		await expect(hashPassword('short', cheap)).rejects.toThrow('at least 10');
		await expect(hashPassword('ninechars', cheap)).rejects.toThrow();
		await expect(hashPassword('tenchars!!', cheap)).resolves.toBeTruthy();
	});
	it('pauses longer after each wrong try and blocks after ten', () => {
		expect([0, 1, 2, 3, 4, 9].map(passwordPauseMs)).toEqual([0, 1000, 2000, 4000, 8000, 256_000]);
		expect(passwordPauseMs(30)).toBe(300_000);
		expect(blockAfterFailures).toBe(10);
	});
});

describe('pairing window (spec/remote-access-and-mobile#architecture)', () => {
	it('makes 8-character Crockford codes and reads them back however typed', () => {
		for (let index = 0; index < 50; index++) expect(isPairingCode(newPairingCode())).toBe(true);
		expect(normalizePairingCode('ab1o-il2z')).toBe('AB10112Z');
		expect(normalizePairingCode('5ycp yzkr')).toBe('5YCPYZKR');
		expect(isPairingCode('5YCPYZKU')).toBe(false);
	});
	it('expires after five minutes', () => {
		vi.useFakeTimers();
		const states: RemotePairing['state'][] = [];
		const window = new PairingWindow((state) => states.push(state.state));
		window.open('ABCD1234');
		expect(window.isOpen).toBe(true);
		vi.advanceTimersByTime(5 * 60_000 - 1);
		expect(window.current.state).toBe('open');
		vi.advanceTimersByTime(1);
		expect(window.current.state).toBe('expired');
		expect(window.code).toBeNull();
		expect(states).toEqual(['open', 'expired']);
	});
	it('spends a try at the start of each run; the fifth wrong one closes it', () => {
		const window = new PairingWindow(() => {});
		window.open('ABCD1234');
		for (let index = 1; index <= pairingAttempts; index++) {
			expect(window.spend()).toBe(true);
			expect(window.failed()).toBe(pairingAttempts - index);
		}
		expect(window.current.state).toBe('exhausted');
		expect(window.spend()).toBe(false);
	});
	it('waits for the person to confirm a matched device', async () => {
		const window = new PairingWindow(() => {});
		window.open('ABCD1234');
		window.spend();
		const answer = window.matched('laptop', 'cert', 'f'.repeat(64));
		expect(window.current).toMatchObject({ state: 'confirm', device: 'laptop' });
		expect(window.confirm(true, 'ThinkPad')).toBe(true);
		expect(await answer).toEqual({ accept: true, name: 'ThinkPad' });
		// Closing the window while someone waits answers «no».
		window.open('ABCD1234');
		const late = window.matched('laptop', 'cert', 'f'.repeat(64));
		window.close();
		expect(await late).toEqual({ accept: false, name: null });
	});
});

describe('files (spec/remote-access-and-mobile#architecture)', () => {
	const vault: KeyVault = {
		seal: (text) => Buffer.from([...Buffer.from(text)].map((byte) => byte ^ 0x5a)),
		open: (sealed) => Buffer.from([...sealed].map((byte) => byte ^ 0x5a)).toString(),
	};
	it('keeps the private key sealed and reads the same identity back', async () => {
		const files = new RemoteFiles(await temp());
		const first = await loadIdentity(files, vault);
		const second = await loadIdentity(files, vault);
		expect(second).toEqual(first);
		const text = await readFile(await files.path('identity.json'), 'utf8');
		expect(text).not.toContain('PRIVATE KEY');
		expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1 });
		const broken: KeyVault = { seal: vault.seal, open: () => 'garbage' };
		await expect(loadIdentity(files, broken)).rejects.toThrow('damaged');
	});
	it('forgets a device 30 days after its last login and survives a reopen', async () => {
		let now = Date.parse('2026-10-15T10:00:00Z');
		const files = new RemoteFiles(await temp());
		const registry = await DeviceRegistry.open(files, () => now);
		const laptop = createIdentity('laptop'),
			phone = createIdentity('phone');
		await registry.add('laptop', laptop.cert);
		await registry.add('phone', phone.cert);
		now += 20 * 86_400_000;
		await registry.update(laptop.fingerprint, (device) => {
			device.lastLoginAt = new Date(now).toISOString();
		});
		now += 11 * 86_400_000;
		expect(registry.get(phone.fingerprint)).toBeNull();
		expect(registry.get(laptop.fingerprint)?.name).toBe('laptop');
		expect((await registry.expire()).map((device) => device.name)).toEqual(['phone']);
		const reopened = await DeviceRegistry.open(files, () => now);
		expect(reopened.list().map((device) => device.name)).toEqual(['laptop']);
		const text = await readFile(await files.path('devices.json'), 'utf8');
		expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
	});
	it('appends the audit as JSONL and reads the newest first', async () => {
		const files = new RemoteFiles(await temp());
		const audit = new AuditLog(files);
		await audit.append('pairing-opened');
		await audit.append('paired', {
			device: 'laptop',
			deviceId: 'a'.repeat(64),
			address: '10.0.0.2',
		});
		await audit.append('tls-rejected', { address: '10.0.0.9', detail: 'unknown certificate' });
		const entries = await audit.read(2);
		expect(entries.map((entry) => entry.kind)).toEqual(['tls-rejected', 'paired']);
		expect(entries[1]).toMatchObject({ device: 'laptop', address: '10.0.0.2' });
	});
});

describe('wire', () => {
	it('keeps undefined and bytes, drops prototype keys', () => {
		const value = { a: undefined, list: [1, undefined, null], bytes: new Uint8Array([0, 255]) };
		const back = decodeFrame(encodeFrame(value)) as typeof value;
		expect(back).toEqual(value);
		expect('a' in back).toBe(true);
		expect(back.list).toHaveLength(3);
		expect(back.bytes).toBeInstanceOf(Uint8Array);
		const polluted = decodeFrame('{"__proto__":{"admin":true},"x":1}') as Record<string, unknown>;
		expect(({} as Record<string, unknown>).admin).toBeUndefined();
		expect(polluted).toEqual({ x: 1 });
		expect(() => encodeFrame({ big: 1n })).toThrow();
	});
	it('sends bytes as a binary frame and checks every reference (spec/remote-access-and-mobile#browser-from-device)', () => {
		const value = {
			t: 'event',
			channel: 'simulator:frame',
			value: { key: true, a: new Uint8Array([1, 2, 3]), list: [new Uint8Array(0), undefined] },
		};
		const frame = encodeBinaryFrame(value)!;
		expect(frame[0]).toBe(1);
		expect(decodeBinaryFrame(frame)).toEqual(value);
		// A part of a bigger buffer, as ws hands it over.
		const inside = new Uint8Array(frame.length + 8);
		inside.set(frame, 4);
		expect(decodeBinaryFrame(inside.subarray(4, 4 + frame.length))).toEqual(value);
		expect(encodeBinaryFrame({ t: 'event', channel: 'x', value: 1 })).toBeNull();
		// A reference past the end, a cut header and a text frame that names a tail all fail.
		const header = Buffer.from(JSON.stringify({ x: { '\u0000': 'p0:9' } }));
		const bad = Buffer.concat([Buffer.from([1, 0, 0, 0, header.length]), header, Buffer.from([1])]);
		expect(() => decodeBinaryFrame(bad)).toThrow(/out of the frame/);
		expect(() => decodeBinaryFrame(frame.subarray(0, 8))).toThrow(/cut/);
		expect(() => decodeBinaryFrame(Buffer.from([2, 0, 0, 0, 0]))).toThrow();
		expect(() => decodeFrame('{"x":{"\\u0000":"p0:1"}}')).toThrow(/Unknown tag/);
	});
	it('accepts only the frames each listener knows', () => {
		expect(isPairClientMessage({ t: 'pair-a', share: 'AA==', device: 'laptop' })).toBe(true);
		expect(isPairClientMessage({ t: 'invoke', id: 1, channel: 'x', args: [] })).toBe(false);
		expect(
			isGatewayClientMessage({
				t: 'login',
				v: 1,
				table: 'x',
				password: 'p',
				resume: null,
				takeOver: true,
			})
		).toBe(true);
		expect(isGatewayClientMessage({ t: 'login', v: 1, table: 'x', password: 'p' })).toBe(false);
		expect(isGatewayClientMessage({ t: 'invoke', id: 1, channel: 'x', args: new Array(17) })).toBe(
			false
		);
	});
});

describe('interfaces (spec/remote-access-and-mobile#architecture)', () => {
	it('listens on LAN and Tailscale only, never public or link-local', () => {
		expect(classifyAddress('192.168.1.20')).toBe('lan');
		expect(classifyAddress('10.1.2.3')).toBe('lan');
		expect(classifyAddress('172.20.0.1')).toBe('lan');
		expect(classifyAddress('172.32.0.1')).toBeNull();
		// 100.64.0.0/10 alone is carrier-grade NAT; Tailscale only on its interface (security review R1, S7).
		expect(classifyAddress('100.101.102.103')).toBe('lan');
		expect(classifyAddress('100.101.102.103', true)).toBe('tailscale');
		expect(classifyAddress('100.128.0.1', true)).toBeNull();
		expect(classifyAddress('fd7a:115c:a1e0::1')).toBe('tailscale');
		expect(classifyAddress('fd12:3456::1')).toBe('lan');
		expect(classifyAddress('fe80::1')).toBeNull();
		expect(classifyAddress('8.8.8.8')).toBeNull();
		expect(classifyAddress('2001:db8::1')).toBeNull();
		expect(classifyAddress('0.0.0.0')).toBeNull();
		const interfaces = {
			lo0: [{ address: '127.0.0.1', internal: true }],
			en0: [
				{ address: '192.168.1.20', internal: false },
				{ address: 'fe80::1', internal: false },
				{ address: '81.2.3.4', internal: false },
			],
			// macOS: Tailscale's utun carries its IPv6 prefix too.
			utun3: [
				{ address: '100.101.102.103', internal: false },
				{ address: 'fd7a:115c:a1e0::5', internal: false },
			],
			// Linux: tailscale0, here with IPv4 only.
			tailscale0: [{ address: '100.80.1.2', internal: false }],
			// Another VPN or a phone's hotspot with a CGNAT address: LAN, not Tailscale.
			utun5: [{ address: '100.64.0.7', internal: false }],
		} as unknown as Parameters<typeof listenAddresses>[1];
		expect(listenAddresses({ lan: true, tailscale: true }, interfaces)).toEqual([
			{ network: 'lan', address: '192.168.1.20' },
			{ network: 'lan', address: '100.64.0.7' },
			{ network: 'tailscale', address: '100.101.102.103' },
			{ network: 'tailscale', address: 'fd7a:115c:a1e0::5' },
			{ network: 'tailscale', address: '100.80.1.2' },
		]);
		// LAN off: the CGNAT address is not listened on.
		expect(listenAddresses({ lan: false, tailscale: true }, interfaces)).toEqual([
			{ network: 'tailscale', address: '100.101.102.103' },
			{ network: 'tailscale', address: 'fd7a:115c:a1e0::5' },
			{ network: 'tailscale', address: '100.80.1.2' },
		]);
		expect(listenAddresses({ lan: true, tailscale: false }, interfaces)).toEqual([
			{ network: 'lan', address: '192.168.1.20' },
			{ network: 'lan', address: '100.64.0.7' },
		]);
		expect(hostPort('fd7a:115c:a1e0::1', 7420)).toBe('[fd7a:115c:a1e0::1]:7420');
	});
});
