import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connect as tcpConnect, createServer as tcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ipcTableHash,
	isMachineName,
	remoteCallRefusal,
	type RemoteAddress,
	type RemoteNotice,
	type RemoteSession,
} from '@brigadir/core';
import { RemoteGateway, type GatewayLimits, type RemotePeer } from './gateway';
import { CPaceParty } from './cpace';
import { RemoteLink, pairWithMachine, type LinkOptions } from './connection';
import { touchMachine } from './reach';
import { MachineList, RemoteFiles, loadIdentity, type KeyVault, type MachineRecord } from './store';
import { createIdentity, type Identity } from './cert';
import { WebSocket } from 'ws';
import { decodeFrame, encodeFrame } from './codec';
import { isGatewayServerMessage } from './protocol';

// A key store that only marks what it sealed; the real one is Electron's safeStorage (desktop/main/remote-access).
const vault: KeyVault = {
	seal: (text) => Buffer.from(`sealed:${text}`),
	open: (sealed) => {
		const text = sealed.toString();
		if (!text.startsWith('sealed:')) throw new Error('not sealed');
		return text.slice('sealed:'.length);
	},
};
// A login test may hold the password check here, after it ran, to race it with revocation.
const gate = vi.hoisted(() => ({
	hold: null as Promise<void> | null,
	reached: null as (() => void) | null,
}));
vi.mock('./password', async (load) => {
	const real = await load<typeof import('./password')>();
	return {
		...real,
		verifyPassword: async (...args: Parameters<typeof real.verifyPassword>) => {
			const right = await real.verifyPassword(...args);
			gate.reached?.();
			if (gate.hold) await gate.hold;
			return right;
		},
	};
});
const cheap = { N: 1 << 10, r: 8, p: 1 };
const password = 'correct horse battery';
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

type Machine = {
	gateway: RemoteGateway;
	peers: RemotePeer[];
	notices: RemoteNotice[];
	calls: { channel: string; args: unknown[] }[];
	controlChanges: number;
	dir: string;
	/** Someone works at the machine (spec/remote-access-and-mobile#architecture). */
	present: boolean;
	/** A channel's own answer; undefined — the default. */
	answer?: (channel: string) => unknown;
};
let dirs: string[] = [];
let gateways: RemoteGateway[] = [];
let links: RemoteLink[] = [];
async function temp() {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-remote-'));
	dirs.push(dir);
	return dir;
}
async function workingMachine(
	options: {
		addresses?: string[];
		/** Listeners with their own networks (spec/remote-access-and-mobile#networking: a LAN and a Tailscale address on loopback). */
		networks?: RemoteAddress[];
		limits?: Partial<GatewayLimits>;
	} = {}
): Promise<Machine> {
	const dir = await temp();
	const machine: Machine = {
		gateway: null!,
		peers: [],
		notices: [],
		calls: [],
		controlChanges: 0,
		dir,
		present: false,
	};
	machine.gateway = new RemoteGateway({
		files: new RemoteFiles(dir),
		vault: () => vault,
		tableHash: ipcTableHash(),
		defaultName: 'studio',
		// What main's dispatch does first for a device (desktop/main/dispatch.ts has its own test).
		dispatch: async (_peer, channel, args) => {
			const refusal = remoteCallRefusal(channel);
			if (refusal) throw new Error(refusal);
			machine.calls.push({ channel, args });
			const own = await machine.answer?.(channel);
			if (own !== undefined) return own;
			if (channel === 'workspace:read') return { projects: ['p'], when: undefined };
			return null;
		},
		attach: (peer) => {
			machine.peers.push(peer);
			return () => {
				machine.peers = machine.peers.filter((item) => item !== peer);
			};
		},
		changed: () => {},
		controlChanged: () => {
			machine.controlChanges++;
		},
		notice: (notice) => machine.notices.push(notice),
		log: () => {},
		localPresent: () => machine.present,
		port: 0,
		pairingPort: 0,
		addresses: () =>
			options.networks ??
			(options.addresses ?? ['127.0.0.1']).map((address) => ({ network: 'loopback', address })),
		scrypt: cheap,
		rescanMs: 0,
		// The parallel-login test opens 24 sockets from loopback.
		limits: { connectionsPerAddress: 32, ...options.limits },
	});
	gateways.push(machine.gateway);
	await machine.gateway.setPassword(password);
	await machine.gateway.configure({
		module: true,
		enabled: true,
		machineName: null,
		listen: { lan: true, tailscale: true },
		phone: false,
	});
	return machine;
}
async function deviceIdentity(): Promise<{ identity: Identity; files: RemoteFiles }> {
	const files = new RemoteFiles(await temp());
	return { identity: await loadIdentity(files, vault), files };
}
/** Pairs a device with the machine: the person on the machine reads the code and confirms the name. */
async function pair(
	machine: Machine,
	identity: Identity,
	name = 'laptop',
	host = '127.0.0.1',
	expectedNetwork = 'loopback'
) {
	const opened =
		machine.gateway.pairing.current.state === 'open'
			? machine.gateway.pairing.current
			: await machine.gateway.startPairing();
	if (opened.state !== 'open') throw new Error('not open');
	const pairing = pairWithMachine({
		identity,
		host,
		port: machine.gateway.pairingPort,
		code: `${opened.code.slice(0, 4).toLowerCase()}-${opened.code.slice(4)}`,
		deviceName: name,
		tableHash: ipcTableHash(),
	});
	await waitFor(() => machine.gateway.pairing.current.state === 'confirm');
	// The dialog's «Address» comes with the listener's network, not a guess.
	expect(machine.gateway.pairing.current).toMatchObject({ network: expectedNetwork });
	machine.gateway.confirmPairing(true, null);
	return pairing;
}
function link(
	record: MachineRecord,
	identity: Identity,
	table = ipcTableHash(),
	options: LinkOptions = {}
) {
	const events: { channel: string; value: unknown }[] = [];
	const sessions: RemoteSession[] = [];
	const made = new RemoteLink(
		record,
		identity,
		table,
		{
			event: (channel, value) => events.push({ channel, value }),
			session: (session) => sessions.push(session),
			control: () => {},
			machine: () => {},
		},
		options
	);
	links.push(made);
	return { link: made, events, sessions };
}
beforeEach(() => {
	gate.hold = null;
	gate.reached = null;
	dirs = [];
	gateways = [];
	links = [];
});
afterEach(async () => {
	for (const item of links) item.close();
	await Promise.all(gateways.map((gateway) => gateway.close()));
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A loopback port nothing listens on: the OS gives a free one, the server closes at once. */
async function closedPort(): Promise<number> {
	const server = tcpServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
describe('remote access, two sides in one process (spec/remote-access-and-mobile#architecture)', () => {
	it('pairs, logs in with the password, calls, gets events, refuses a stranger and drops a revoked device', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { result, record } = await pair(machine, device.identity);
		expect(result.ok).toBe(true);
		expect(record!.id).toBe(machine.gateway.fingerprint);
		expect(machine.gateway.status(false).devices.map((item) => item.name)).toEqual(['laptop']);
		await (await MachineList.open(device.files)).put(record!);

		// The password, then a remote-class call through the same table.
		const { link: connection, events, sessions } = link(record!, device.identity);
		connection.subscribe(['session:event', 'remote:control']);
		expect(await connection.connect(password, true)).toEqual({ ok: true });
		expect(connection.session()).toMatchObject({ state: 'connected', active: true });
		await waitFor(() => machine.peers.length === 1);
		expect(machine.gateway.isActive(machine.peers[0]!.id)).toBe(true);
		expect(machine.gateway.isActive(null)).toBe(false);
		// `undefined` crosses the wire as itself, not as null.
		expect(await connection.invoke('workspace:read', [])).toEqual({
			projects: ['p'],
			when: undefined,
		});
		// A forbidden row and a client-class row never reach a handler.
		await expect(connection.invoke('remote:enable', [false])).rejects.toThrow(
			'Not available from a remote device.'
		);
		await expect(connection.invoke('appearance:read', [])).rejects.toThrow(/runs on the device/);
		expect(machine.calls.map((call) => call.channel)).toEqual(['workspace:read']);

		// An event the device subscribed to arrives; one it did not, does not.
		expect(machine.peers[0]!.send('session:event', { key: 1, frame: new Uint8Array([1, 2]) })).toBe(
			true
		);
		expect(machine.peers[0]!.send('terminal:event', {})).toBe(false);
		await waitFor(() => events.length === 1);
		expect(events[0]).toEqual({
			channel: 'session:event',
			value: { key: 1, frame: new Uint8Array([1, 2]) },
		});

		// «Take back» on the machine: the device stays connected but no longer controls.
		await machine.gateway.takeControl(null);
		expect(machine.gateway.isActive(null)).toBe(true);
		expect(machine.gateway.control(machine.peers[0]!.id)).toMatchObject({
			active: 'local',
			self: false,
		});

		// A certificate that never paired is dropped in the TLS handshake and lands in the audit.
		const stranger = createIdentity('stranger');
		const { link: strangerLink } = link(record!, stranger);
		expect(await strangerLink.connect(password, true)).toMatchObject({
			ok: false,
			reason: 'unreachable',
		});
		await waitFor(async () =>
			(await machine.gateway.readAudit(50)).some((entry) => entry.kind === 'tls-rejected')
		);

		// Revoking the device ends its connection at once and no reconnect follows.
		await machine.gateway.revoke(device.identity.fingerprint);
		await waitFor(() => connection.session().state === 'closed');
		expect(connection.session().closedReason).toBe('revoked');
		expect(sessions.at(-1)?.state).toBe('closed');
		await waitFor(() => machine.peers.length === 0);
		// The revoked certificate no longer passes the handshake.
		const again = link(record!, device.identity).link;
		expect(await again.connect(password, true)).toMatchObject({ ok: false, reason: 'unreachable' });

		const audit = await readFile(join(machine.dir, 'remote', 'audit.jsonl'), 'utf8');
		const kinds = audit
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line).kind);
		for (const kind of [
			'password-set',
			'access-enabled',
			'pairing-opened',
			'paired',
			'login',
			'took-back',
			'revoked',
		])
			expect(kinds).toContain(kind);
		// devices.json is pretty and sorted; it never holds the password or a key.
		const devices = await readFile(join(machine.dir, 'remote', 'devices.json'), 'utf8');
		expect(devices).toContain('\n  "devices"');
		expect(devices).not.toContain('PRIVATE KEY');
	});

	it('counts wrong passwords, pauses, blocks after ten and refuses another build', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const { link: wrong } = link(record!, device.identity);
		const first = await wrong.connect('not the password', true);
		expect(first).toMatchObject({
			ok: false,
			reason: 'password',
			attemptsLeft: 9,
			retryAfterMs: 1000,
		});
		// Inside the pause the next try is not even checked.
		expect(await wrong.connect(password, true)).toMatchObject({ ok: false, reason: 'wait' });
		expect(machine.notices.some((notice) => notice.kind === 'failed')).toBe(true);
		// The version handshake: another table hash is refused before the password.
		const { link: old } = link(record!, device.identity, '0000000000000000');
		expect(await old.connect(password, true)).toMatchObject({
			ok: false,
			reason: 'version',
			machine: 'studio',
		});
	});

	it('closes the pairing window after five wrong codes and never trusts the device', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const opened = await machine.gateway.startPairing();
		if (opened.state !== 'open') throw new Error('not open');
		const wrongCode = opened.code.startsWith('0') ? '11111111' : '00000000';
		const port = machine.gateway.pairingPort;
		const results = [];
		for (let index = 0; index < 5; index++)
			results.push(
				(
					await pairWithMachine({
						identity: device.identity,
						host: '127.0.0.1',
						port,
						code: wrongCode,
						deviceName: 'laptop',
						tableHash: ipcTableHash(),
					})
				).result
			);
		expect(results.map((result) => (result.ok ? 'ok' : result.reason))).toEqual([
			'code',
			'code',
			'code',
			'code',
			'exhausted',
		]);
		await waitFor(() => machine.gateway.pairing.current.state === 'exhausted');
		expect(machine.gateway.status(false).devices).toEqual([]);
		// The listener is gone with the window.
		const late = await pairWithMachine({
			identity: device.identity,
			host: '127.0.0.1',
			port,
			code: opened.code,
			deviceName: 'laptop',
			tableHash: ipcTableHash(),
		});
		expect(late.result).toMatchObject({ ok: false, reason: 'unreachable' });
	});

	it('drops everyone when access, the module or the password changes', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const { link: connection } = link(record!, device.identity);
		expect(await connection.connect(password, true)).toEqual({ ok: true });
		await machine.gateway.setPassword('a brand new password');
		await waitFor(() => connection.session().state === 'closed');
		expect(connection.session().closedReason).toBe('password-changed');

		// Someone works at the machine: a login without `takeOver` is refused with `local` so the device can ask first.
		machine.present = true;
		const { link: second } = link(record!, device.identity);
		expect(await second.connect('a brand new password', false)).toMatchObject({
			ok: false,
			reason: 'local',
		});
		expect(machine.gateway.isActive(null)).toBe(true);
		// «Take control» after the question: the device controls, the machine shows its cover.
		expect(await second.connect('a brand new password', true)).toEqual({ ok: true });
		expect(machine.gateway.isActive(null)).toBe(false);
		// «Disconnect <device>» on the cover: the connection goes, the device stays paired.
		await machine.gateway.drop(machine.gateway.status(false).devices[0]!.id);
		await waitFor(() => second.session().state === 'closed');
		expect(second.session().closedReason).toBe('dropped');
		expect(machine.gateway.status(false).devices).toHaveLength(1);
		expect(machine.gateway.isActive(null)).toBe(true);
		// Nobody at the machine: the login takes control without asking.
		machine.present = false;
		const { link: third } = link(record!, device.identity);
		expect(await third.connect('a brand new password', false)).toEqual({ ok: true });
		expect(machine.gateway.isActive(null)).toBe(false);
		await machine.gateway.configure({
			module: false,
			enabled: true,
			machineName: null,
			listen: { lan: true, tailscale: true },
			phone: false,
		});
		await waitFor(() => third.session().state === 'closed');
		expect(third.session().closedReason).toBe('off');
		expect(machine.gateway.status(false).listening).toEqual([]);
	});

	it('shows a device no pairing code and marks the status read-only', async () => {
		const machine = await workingMachine();
		await machine.gateway.startPairing();
		const local = machine.gateway.status(false);
		const remote = machine.gateway.status(true);
		expect(local.pairing).toMatchObject({ state: 'open' });
		expect((local.pairing as { code: string }).code).toHaveLength(8);
		expect(remote.pairing).toMatchObject({ state: 'open', code: '' });
		expect(remote.editable).toBe(false);
	});
});

describe('security review R1 (research spec/chat#row-engine)', () => {
	/** A raw gateway socket with the device's certificate, open and waiting for its first frame. */
	function rawSocket(machine: Machine, identity: Identity, machineCert: string) {
		return new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(`wss://127.0.0.1:${machine.gateway.port}/v1`, {
				key: identity.key,
				cert: identity.cert,
				ca: [machineCert],
				// The test's own loopback machine; the device's pinning is RemoteLink's.
				rejectUnauthorized: false,
				minVersion: 'TLSv1.3',
				perMessageDeflate: false,
			});
			ws.once('open', () => resolve(ws));
			ws.once('error', reject);
		});
	}
	const answer = (ws: WebSocket) =>
		new Promise<Record<string, unknown>>((resolve) => {
			ws.once('message', (data) =>
				resolve(decodeFrame(data.toString()) as Record<string, unknown>)
			);
			ws.once('close', () => resolve({ t: 'closed' }));
		});

	it('checks one password at a time per device: parallel logins do not skip the pause or the block', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const sockets = await Promise.all(
			Array.from({ length: 24 }, () => rawSocket(machine, device.identity, record!.cert))
		);
		const answers = sockets.map(answer);
		for (const ws of sockets)
			ws.send(
				encodeFrame({
					t: 'login',
					v: 1,
					table: ipcTableHash(),
					password: 'not the password',
					resume: null,
					takeOver: true,
				})
			);
		const refusals = (await Promise.all(answers)).map((item) => item.reason ?? item.t);
		for (const ws of sockets) ws.terminate();
		// Exactly one wrong password was checked; the rest waited, and nothing came near the block.
		expect(refusals.filter((reason) => reason === 'password')).toHaveLength(1);
		expect(machine.gateway.status(false).devices[0]).toMatchObject({ failures: 1, blocked: false });
	});

	it('a device window takes only the events it subscribed to, whatever the machine sends', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const { link: connection, events } = link(record!, device.identity);
		connection.subscribe(['session:event']);
		expect(await connection.connect(password, true)).toEqual({ ok: true });
		await waitFor(() => machine.peers.length === 1);
		// A machine that does not play by the rules writes straight to the socket: a client-class event of the device.
		const session = [
			...(machine.gateway as unknown as { sessions: Set<{ ws: WebSocket }> }).sessions,
		][0]!;
		session.ws.send(
			encodeFrame({ t: 'event', channel: 'workspace:action', value: 'open-project' })
		);
		session.ws.send(encodeFrame({ t: 'event', channel: 'session:event', value: { key: 1 } }));
		await waitFor(() => events.some((event) => event.channel === 'session:event'));
		expect(events.map((event) => event.channel)).toEqual(['session:event']);
	});

	it('refuses machine names and ports that machines.json or the window could not take', () => {
		const machine = {
			addresses: [{ network: 'lan', address: '192.168.1.5' }],
			port: 7420,
			pairingPort: 7421,
		};
		const welcome = (name: string, port = 7420) => ({
			t: 'welcome',
			machine: { ...machine, name, port },
			resume: 'AAAA',
			control: {},
		});
		expect(isGatewayServerMessage(welcome('studio'))).toBe(true);
		expect(isGatewayServerMessage(welcome('stu\ud800dio'))).toBe(false);
		expect(isGatewayServerMessage(welcome('stu\u0007dio'))).toBe(false);
		expect(isGatewayServerMessage(welcome('studio', 70000))).toBe(false);
		expect(isMachineName('studio 💻')).toBe(true);
	});

	it('keeps tls-rejected lines bounded when many addresses knock', async () => {
		const machine = await workingMachine();
		const rejected = (
			machine.gateway as unknown as {
				rejected(address: string | null, network: string, detail: string): void;
			}
		).rejected.bind(machine.gateway);
		for (let index = 0; index < 3000; index++)
			rejected(`fd00::${index.toString(16)}`, 'lan', 'unknown certificate');
		await machine.gateway.close();
		const lines = (await machine.gateway.readAudit(500)).filter(
			(entry) => entry.kind === 'tls-rejected'
		);
		// The budget's lines and one line with the count of the rest.
		expect(lines.length).toBeLessThanOrEqual(21);
		expect(lines.some((entry) => entry.detail === '2980 more within a minute')).toBe(true);
		expect(
			machine.notices.filter((notice) => notice.kind === 'tls-rejected').length
		).toBeLessThanOrEqual(30);
	});
});

describe('security review R1, low findings (spec/remote-access-and-mobile#pairing)', () => {
	type Raw = { ws: WebSocket; messages: Record<string, unknown>[]; closed: Promise<number> };
	/** A raw socket to the gateway (`/v1`) or the pairing listener (`/pair`) that records what it gets. */
	function raw(
		port: number,
		path: '/v1' | '/pair',
		identity: Identity,
		options: { host?: string; deflate?: boolean } = {}
	) {
		const host = options.host ?? '127.0.0.1';
		return new Promise<Raw>((resolve, reject) => {
			const ws = new WebSocket(`wss://${host.includes(':') ? `[${host}]` : host}:${port}${path}`, {
				key: identity.key,
				cert: identity.cert,
				rejectUnauthorized: false,
				minVersion: 'TLSv1.3',
				perMessageDeflate: options.deflate ? { threshold: 0 } : false,
			});
			const messages: Record<string, unknown>[] = [];
			const closed = new Promise<number>((done) => ws.once('close', (code) => done(code)));
			ws.on('message', (data) => messages.push(decodeFrame(data.toString()) as never));
			ws.once('open', () => resolve({ ws, messages, closed }));
			ws.once('error', reject);
		});
	}
	const tcp = (port: number, host = '127.0.0.1') =>
		new Promise<{ socket: Socket; closed: () => boolean }>((resolve, reject) => {
			let gone = false;
			const socket = tcpConnect({ port, host }, () => resolve({ socket, closed: () => gone }));
			socket.on('close', () => (gone = true));
			socket.on('error', () => {});
			socket.once('error', reject);
		});
	const sockets: Socket[] = [];
	afterEach(() => {
		for (const socket of sockets.splice(0)) socket.destroy();
	});
	const login = (pass = password) =>
		encodeFrame({
			t: 'login',
			v: 1,
			table: ipcTableHash(),
			password: pass,
			resume: null,
			takeOver: true,
		});

	it('S5: a silent pairing connection holds nothing, one address pairs once at a time, a stalled run holds only its step', async () => {
		const machine = await workingMachine({
			addresses: ['127.0.0.1', '::1'],
			limits: { pairingStepMs: 800 },
		});
		const opened = await machine.gateway.startPairing();
		if (opened.state !== 'open') throw new Error('not open');
		const port = machine.gateway.pairingPort;
		const neighbour = createIdentity('neighbour');
		// A neighbour opens the pairing listener and never sends `pair-a`.
		const silent = await raw(port, '/pair', neighbour);
		await waitFor(() => silent.messages.length === 1);
		expect(silent.messages[0]!.t).toBe('pair-hello');
		// Its second connection from the same address is turned away…
		const second = await raw(port, '/pair', neighbour);
		await second.closed;
		expect(second.messages[0]).toMatchObject({ t: 'pair-refused', reason: 'busy' });
		// …while a device from another address pairs at once; the silent one is cut after its step.
		const device = await deviceIdentity();
		const { result } = await pair(machine, device.identity, 'laptop', '::1');
		expect(result.ok).toBe(true);
		await silent.closed;

		// A run that sent `pair-a` holds the window — with a spent try — and only until its step times out.
		const again = await machine.gateway.startPairing();
		if (again.state !== 'open') throw new Error('not open');
		const stalled = await raw(machine.gateway.pairingPort, '/pair', neighbour);
		await waitFor(() => stalled.messages.length === 1);
		const party = new CPaceParty(
			'initiator',
			{ prs: new Uint8Array(8), ci: new Uint8Array(32), sid: new Uint8Array(16) },
			new Uint8Array(1)
		);
		stalled.ws.send(
			encodeFrame({ t: 'pair-a', share: Buffer.from(party.share).toString('base64'), device: 'x' })
		);
		await waitFor(() => stalled.messages.some((message) => message.t === 'pair-b'));
		expect(machine.gateway.pairing.attemptsLeft).toBe(4);
		const other = await deviceIdentity();
		const busy = await pairWithMachine({
			identity: other.identity,
			host: '::1',
			port: machine.gateway.pairingPort,
			code: again.code,
			deviceName: 'tablet',
			tableHash: ipcTableHash(),
		});
		expect(busy.result).toMatchObject({ ok: false, reason: 'busy' });
		await stalled.closed;
		const { result: later } = await pair(machine, other.identity, 'tablet', '::1');
		expect(later.ok).toBe(true);
	});

	it('S6: 16 KB before login (packed or not), 16 MB after it', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const plain = await raw(machine.gateway.port, '/v1', device.identity);
		plain.ws.send('x'.repeat(20 * 1024));
		expect(await plain.closed).toBe(1009);
		// A deflated megabyte is about a kilobyte on the wire: the limit holds after inflating too.
		const packed = await raw(machine.gateway.port, '/v1', device.identity, { deflate: true });
		packed.ws.send(JSON.stringify({ t: 'login', pad: 'x'.repeat(1 << 20) }));
		expect(await packed.closed).toBe(1009);
		const { link: connection } = link(record!, device.identity);
		expect(await connection.connect(password, true)).toEqual({ ok: true });
		const big = 'y'.repeat(2 << 20);
		await connection.invoke('workspace:read', [big]);
		expect(machine.calls.at(-1)?.args[0]).toBe(big);
	});

	it('S6: caps connections per address and in total before TLS, and times out a silent handshake', async () => {
		const machine = await workingMachine({
			addresses: ['127.0.0.1', '::1'],
			limits: { connections: 3, connectionsPerAddress: 2, handshakeMs: 400 },
		});
		const port = machine.gateway.port;
		const open = async (host?: string) => {
			const made = await tcp(port, host);
			sockets.push(made.socket);
			return made;
		};
		const [a, b, c] = [await open(), await open(), await open()];
		await waitFor(() => c.closed());
		const d = await open('::1');
		const e = await open('::1');
		await waitFor(() => e.closed());
		// Nothing must happen to the admitted ones yet: a fixed pause, shorter than the handshake timeout.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect([a.closed(), b.closed(), d.closed()]).toEqual([false, false, false]);
		// None of them says a word: the handshake timeout ends them all, and the slots come back.
		await waitFor(() => a.closed() && b.closed() && d.closed(), 3000);
		const f = await open();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.closed()).toBe(false);
	});

	it('S9: the audit notes drop, take over and back, module switches, refused calls and settings — the repeatable ones within a budget', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const { link: connection } = link(record!, device.identity);
		expect(await connection.connect(password, true)).toEqual({ ok: true });
		await waitFor(() => machine.peers.length === 1);
		const peer = machine.peers[0]!;
		await machine.gateway.takeControl(null);
		await machine.gateway.takeControl(peer.id);
		for (let index = 0; index < 100; index++)
			machine.gateway.auditPeer(peer.id, 'call-refused', 'remote:enable');
		machine.gateway.auditPeer(peer.id, 'settings-changed', 'accent, editor.format');
		await machine.gateway.drop(device.identity.fingerprint);
		await waitFor(() => connection.session().state === 'closed');
		// Another build knocks again and again: one budget, not a line per knock.
		for (let index = 0; index < 30; index++) {
			const { link: old } = link(record!, device.identity, '0000000000000000');
			await old.connect(password, true);
		}
		const off = {
			module: false,
			enabled: true,
			machineName: null,
			listen: { lan: true, tailscale: true },
			phone: false,
		};
		await machine.gateway.configure(off);
		await machine.gateway.configure({ ...off, module: true });
		await machine.gateway.close();
		const entries = await machine.gateway.readAudit(500);
		const kinds = entries.map((entry) => entry.kind);
		for (const kind of [
			'took-back',
			'took-over',
			'settings-changed',
			'dropped',
			'module-disabled',
			'module-enabled',
		] as const)
			expect(kinds).toContain(kind);
		// The first configure is the app starting, not a switch.
		expect(kinds.filter((kind) => kind === 'module-enabled')).toHaveLength(1);
		expect(entries.find((entry) => entry.kind === 'settings-changed')).toMatchObject({
			device: 'laptop',
			detail: 'accent, editor.format',
		});
		// The network is the listener's, as the gateway decided it: the log never guesses it from the address.
		for (const kind of ['paired', 'login', 'settings-changed', 'disconnected'] as const)
			expect(entries.find((entry) => entry.kind === kind)).toMatchObject({
				address: '127.0.0.1',
				network: 'loopback',
			});
		expect(machine.notices.find((notice) => notice.kind === 'connected')).toMatchObject({
			network: 'loopback',
		});
		const refused = entries.filter((entry) => entry.kind === 'call-refused');
		expect(refused).toHaveLength(21);
		expect(refused.some((entry) => entry.detail === '80 more within a minute')).toBe(true);
		const versions = entries.filter((entry) => entry.kind === 'version-mismatch');
		expect(versions).toHaveLength(21);
		expect(versions.some((entry) => entry.detail === '10 more within a minute')).toBe(true);
	});

	it('S10: a socket without a session goes after its timeout', async () => {
		const machine = await workingMachine({ limits: { sessionlessMs: 300 } });
		const device = await deviceIdentity();
		await pair(machine, device.identity);
		const silent = await raw(machine.gateway.port, '/v1', device.identity);
		await silent.closed;
		expect(machine.peers).toHaveLength(0);
	});

	it('S10: a login that loses the race with revocation is refused and closed, not left open', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		await pair(machine, device.identity);
		const socket = await raw(machine.gateway.port, '/v1', device.identity);
		let release!: () => void;
		gate.hold = new Promise((resolve) => (release = resolve));
		const reached = new Promise<void>((resolve) => (gate.reached = resolve));
		socket.ws.send(login());
		await reached;
		await machine.gateway.revoke(device.identity.fingerprint);
		release();
		await socket.closed;
		expect(socket.messages).toEqual([expect.objectContaining({ t: 'refused', reason: 'unknown' })]);
		expect(machine.peers).toHaveLength(0);
		expect(machine.gateway.status(false).control.active).toBe('local');
	});
});

describe('R4: the network between two machines (spec/remote-access-and-mobile#networking)', () => {
	const fast: LinkOptions = {
		timing: { pingMs: 100, deadMs: 500, checkMs: 300, dialMs: 1500, staggerMs: 50 },
		random: () => 0,
	};
	async function connected(machine: Machine, options: LinkOptions = fast, network = 'loopback') {
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity, 'laptop', '127.0.0.1', network);
		const made = link(record!, device.identity, ipcTableHash(), options);
		made.link.subscribe(['session:event']);
		expect(await made.link.connect(password, true)).toEqual({ ok: true });
		return { ...made, device, record: record! };
	}
	it('touches a paired machine without logging in: answered, refused once revoked, silent elsewhere', async () => {
		const machine = await workingMachine();
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const touch = (patch: Partial<Parameters<typeof touchMachine>[0]> = {}) =>
			touchMachine({
				identity: device.identity,
				cert: record!.cert,
				id: record!.id,
				address: '127.0.0.1',
				port: machine.gateway.port,
				timeoutMs: 1500,
				...patch,
			});
		expect(await touch()).toBe('answered');
		// A touch is not a login: no session, no audit line.
		expect(machine.peers).toHaveLength(0);
		expect((await machine.gateway.readAudit(50)).map((entry) => entry.kind)).not.toContain('login');
		// Another machine's certificate on the address: not ours.
		expect(await touch({ id: 'f'.repeat(64) })).toBeNull();
		// Nothing listens there.
		// A port that was just free and closed again: `pairingPort + 1000` passed 65535 when the OS gave a high port.
		expect(await touch({ port: await closedPort() })).toBeNull();
		await machine.gateway.revoke(machine.gateway.status(false).devices[0]!.id);
		expect(await touch()).toBe('refused');
	});
	it('a machine that sleeps: dead after the silence, back with the resume token when it wakes — no password', async () => {
		const machine = await workingMachine();
		const { link: connection, sessions } = await connected(machine);
		expect(connection.session()).toMatchObject({ state: 'connected', generation: 1 });
		machine.gateway.freeze(true);
		const asleep = Date.now();
		await waitFor(() => connection.session().state === 'reconnecting', 3000);
		// deadMs 500 plus one tick: well within the budget of the real 25 s.
		expect(Date.now() - asleep).toBeLessThan(1500);
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(connection.session().state).toBe('reconnecting');
		machine.gateway.freeze(false);
		await waitFor(() => connection.session().state === 'connected', 8000);
		expect(connection.session()).toMatchObject({ generation: 2, active: true, closedReason: null });
		await waitFor(() => machine.peers.length === 1);
		expect(await connection.invoke('workspace:read', [])).toMatchObject({ projects: ['p'] });
		expect(sessions.some((item) => item.state === 'closed')).toBe(false);
	});
	it('a broken path: reconnecting at once, then back by itself', async () => {
		const machine = await workingMachine();
		const { link: connection } = await connected(machine);
		machine.gateway.cut(700);
		await waitFor(() => connection.session().state === 'reconnecting', 2000);
		await waitFor(() => connection.session().state === 'connected', 8000);
		expect(connection.session().generation).toBe(2);
	});
	it(
		'a reconnect never takes control from a person at the machine; with nobody there it takes its control back (P6)',
		{ timeout: 30_000 },
		async () => {
			const machine = await workingMachine();
			const { link: connection, device, record } = await connected(machine);
			expect(connection.session().active).toBe(true);
			// The path breaks; meanwhile someone sits down at the machine and works there.
			machine.gateway.cut(700);
			await waitFor(() => connection.session().state === 'reconnecting', 2000);
			expect(machine.gateway.isActive(null)).toBe(true);
			machine.present = true;
			await waitFor(() => connection.session().state === 'connected', 8000);
			// Back without the password, but the person keeps the machine: the device sees «taken».
			expect(machine.gateway.isActive(null)).toBe(true);
			expect(connection.session().active).toBe(false);
			machine.present = false;
			// Nobody at the machine: a device that had control gets it back on its reconnect.
			connection.close();
			const { link: again } = link(record, device.identity, ipcTableHash(), fast);
			expect(await again.connect(password, true)).toEqual({ ok: true });
			expect(again.session().active).toBe(true);
			machine.gateway.cut(700);
			await waitFor(() => again.session().state === 'reconnecting', 2000);
			await waitFor(() => again.session().state === 'connected', 8000);
			expect(again.session().active).toBe(true);
			expect(machine.gateway.isActive(null)).toBe(false);
		}
	);
	it('after a network change an unanswered ping drops the link at once instead of waiting for the silence', async () => {
		const machine = await workingMachine();
		const { link: connection } = await connected(machine, {
			...fast,
			timing: { ...fast.timing, pingMs: 5000, deadMs: 20_000 },
		});
		machine.gateway.freeze(true);
		const changed = Date.now();
		connection.networkChanged();
		await waitFor(() => connection.session().state === 'reconnecting', 3000);
		expect(Date.now() - changed).toBeLessThan(1500);
		machine.gateway.freeze(false);
		connection.networkChanged();
		await waitFor(() => connection.session().state === 'connected', 5000);
	});
	it('moves from Tailscale to the home LAN when it answers, keeping the session without a password', async () => {
		const machine = await workingMachine({
			networks: [
				{ network: 'lan', address: '127.0.0.1' },
				{ network: 'tailscale', address: '::1' },
			],
		});
		const nic = (address: string, netmask: string) => ({
			address,
			netmask,
			family: address.includes(':') ? ('IPv6' as const) : ('IPv4' as const),
			mac: '02:00:00:00:00:01',
			internal: false,
			cidr: null,
			scopeid: 0,
		});
		// Away: only Tailscale here, so the LAN address of the machine ranks below its Tailscale one.
		let here: Record<string, ReturnType<typeof nic>[]> = {
			utun4: [nic('fd7a:115c:a1e0::12', 'ffff:ffff:ffff:ffff::')],
		};
		const { link: connection } = await connected(
			machine,
			{ ...fast, interfaces: () => here },
			'lan'
		);
		expect(connection.session().address).toEqual({ network: 'tailscale', address: '::1' });
		// Home: a LAN interface on the machine's subnet comes up.
		here = { ...here, en0: [nic('127.0.0.9', '255.0.0.0')] };
		connection.networkChanged();
		await waitFor(() => connection.session().address?.address === '127.0.0.1', 5000);
		expect(connection.session()).toMatchObject({ state: 'connected', generation: 2 });
		await waitFor(() => machine.peers.length === 1);
		expect(machine.peers[0]!.address.address).toBe('127.0.0.1');
		expect(await connection.invoke('workspace:read', [])).toMatchObject({ projects: ['p'] });
	});
});

describe('backpressure to a device (spec/remote-access-and-mobile#outbox, security review W2 J1)', () => {
	// Random text: the gateway deflates frames, and a repeated letter would shrink to nothing.
	const big = (mib: number) => randomBytes((mib * 1024 * 1024 * 3) / 4).toString('base64');
	async function connected(limits: Partial<GatewayLimits>) {
		const machine = await workingMachine({ limits });
		const device = await deviceIdentity();
		const { record } = await pair(machine, device.identity);
		const { link: connection } = link(record!, device.identity);
		connection.subscribe(['session:event']);
		expect(await connection.connect(password, true)).toEqual({ ok: true });
		await waitFor(() => machine.peers.length === 1);
		return { machine, connection };
	}
	/** The device's window stops reading its socket (a hung renderer, a stalled network). */
	const stopReading = (connection: RemoteLink) =>
		(connection as unknown as { ws: WebSocket }).ws.pause();
	it('closes a device whose events pile up past the cap', async () => {
		const { machine, connection } = await connected({
			outbox: { pendingBytes: 4 * 1024 * 1024 },
		});
		const peer = machine.peers[0]!;
		// The subscription reached the machine.
		await waitFor(() => peer.send('session:event', { text: 'hello' }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		stopReading(connection);
		let refused = -1;
		for (let i = 0; i < 40 && refused < 0; i++) {
			if (!peer.send('session:event', { text: big(1) })) refused = i;
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(refused).toBeGreaterThan(0);
		await waitFor(() => machine.notices.some((notice) => notice.kind === 'disconnected'));
		expect(peer.send('session:event', { text: 'later' })).toBe(false);
	}, 20_000);
	it('reads one large file at a time for a device that stopped reading, then closes it', async () => {
		const { machine, connection } = await connected({
			outbox: { pendingBytes: 8 * 1024 * 1024, drainMs: 400 },
		});
		let started = 0;
		machine.answer = async (channel) => {
			if (channel !== 'search:peek') return undefined;
			started++;
			return big(16);
		};
		stopReading(connection);
		const calls = Array.from({ length: 10 }, () =>
			connection.invoke('search:peek', [{ projectId: 'p', id: 't' }, 'f']).catch(() => null)
		);
		await waitFor(() => machine.notices.some((notice) => notice.kind === 'disconnected'), 10_000);
		expect(started).toBe(1);
		connection.close();
		await Promise.all(calls);
	}, 20_000);
});
