import { afterEach, describe, expect, it } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
	ipcTableHash,
	normalizePairingCode,
	remoteCallRefusal,
	webCallRefusal,
	type RemoteNotice,
} from '@brigadir/core';
import { fromBase64Url, toBase64Url } from './base64';
import { decodeFrame, encodeFrame } from './codec';
import { CPaceParty } from './cpace';
import { RemoteGateway, type RemotePeer } from './gateway';
import { RemoteFiles, type KeyVault } from './store';
import { SoftAuthenticator } from './test-authenticator';
import { forwardedFor, webHeaders, webHostAllowed, webOriginAllowed } from './web-gateway';
import {
	isWebPairClientMessage,
	isWebServerMessage,
	webChannelIdentifier,
	type WebMessage,
} from './web-protocol';
import type { PushFetch } from './web-push';
import type { DeviceRegistry } from './store';
import type { WebDeps } from './web-gateway';

const vault: KeyVault = {
	seal: (text) => Buffer.from(`sealed:${text}`),
	open: (sealed) => sealed.toString().replace(/^sealed:/, ''),
};
const dirs: string[] = [];
const gateways: RemoteGateway[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
	for (const ws of sockets.splice(0)) ws.terminate();
	for (const gateway of gateways.splice(0)) await gateway.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};
async function bundle() {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-bundle-'));
	dirs.push(dir);
	await mkdir(join(dir, 'assets'));
	await writeFile(join(dir, 'index.html'), '<!doctype html><title>sign in</title>');
	await writeFile(join(dir, 'assets/index-1.js'), 'export {}');
	await writeFile(join(dir, 'assets/app-1.js'), 'export const app = 1');
	await writeFile(join(dir, 'sw.js'), '');
	await writeFile(
		join(dir, 'bundle-manifest.json'),
		JSON.stringify({
			'index.html': { file: 'assets/index-1.js', isEntry: true },
			'app.ts': { file: 'assets/app-1.js', isEntry: true },
		})
	);
	return dir;
}
type Phone = {
	gateway: RemoteGateway;
	peers: RemotePeer[];
	notices: RemoteNotice[];
	calls: string[];
	pushes: { url: string; body: Uint8Array }[];
	pushStatus: number;
	port: () => number;
	/** A channel's own answer; undefined — the default. */
	answer?: (channel: string) => unknown;
};
async function machine(web: Partial<WebDeps> = {}): Promise<Phone> {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-web-'));
	dirs.push(dir);
	const phone: Phone = {
		gateway: null!,
		peers: [],
		notices: [],
		calls: [],
		pushes: [],
		pushStatus: 201,
		port: () => phone.gateway.web.port,
	};
	const fetch: PushFetch = async (url, init) => {
		phone.pushes.push({ url, body: init.body });
		return { status: phone.pushStatus };
	};
	phone.gateway = new RemoteGateway({
		files: new RemoteFiles(dir),
		vault: () => vault,
		tableHash: ipcTableHash(),
		defaultName: 'studio',
		// What main's dispatch does for a device and a phone (desktop/main/dispatch.ts has its own test).
		dispatch: async (peer, channel, args) => {
			const refusal =
				remoteCallRefusal(channel) ??
				(peer.kind === 'phone' ? webCallRefusal(channel, args) : null);
			if (refusal) throw new Error(refusal);
			phone.calls.push(channel);
			const own = await phone.answer?.(channel);
			if (own !== undefined) return own;
			return channel === 'workspace:read' ? { projects: [{ name: 'repo' }] } : null;
		},
		attach: (peer) => {
			phone.peers.push(peer);
			return () => {
				phone.peers = phone.peers.filter((item) => item !== peer);
			};
		},
		changed: () => {},
		controlChanged: () => {},
		notice: (notice) => phone.notices.push(notice),
		log: () => {},
		port: 0,
		pairingPort: 0,
		addresses: () => [{ network: 'loopback', address: '127.0.0.1' }],
		scrypt: { N: 1 << 10, r: 8, p: 1 },
		rescanMs: 0,
		web: {
			bundle: await bundle(),
			port: 0,
			testHost: true,
			push: { fetch, hosts: [/^push\.example$/] },
			...web,
		},
	});
	gateways.push(phone.gateway);
	await phone.gateway.setPassword('correct horse battery');
	await phone.gateway.configure({
		module: true,
		enabled: true,
		machineName: null,
		listen: { lan: true, tailscale: true },
		phone: true,
	});
	return phone;
}
const origin = (m: Phone) => `http://localhost:${m.port()}`;
function http(
	m: Phone,
	path: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: '127.0.0.1',
				port: m.port(),
				path,
				method: options.method ?? 'GET',
				headers: { host: `localhost:${m.port()}`, ...options.headers },
			},
			(response) => {
				let body = '';
				response.on('data', (chunk) => (body += chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode!, headers: response.headers, body })
				);
			}
		);
		request.on('error', reject);
		request.end(options.body);
	});
}
/** A page's socket: what it reads, in order. */
function socket(m: Phone, path: string, headers: Record<string, string> = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${m.port()}${path}`, {
		headers: { host: `localhost:${m.port()}`, origin: origin(m), ...headers },
	});
	sockets.push(ws);
	const inbox: WebMessage[] = [];
	let closed: number | null = null;
	ws.on('message', (data) => {
		const message = decodeFrame(data.toString());
		expect(isWebServerMessage(message)).toBe(true);
		inbox.push(message as WebMessage);
	});
	ws.on('close', (code) => (closed = code));
	ws.on('error', () => {});
	return {
		ws,
		send: (message: WebMessage) => ws.send(encodeFrame(message)),
		/** The first message of one of these kinds; throws if the socket closed without one. */
		next: async <T extends WebMessage['t']>(...kinds: T[]) => {
			const has = () => inbox.findIndex((item) => (kinds as string[]).includes(item.t));
			await waitFor(() => has() >= 0 || closed !== null);
			const index = has();
			if (index < 0)
				throw new Error(`closed (${closed}) before ${kinds}: ${JSON.stringify(inbox)}`);
			return inbox.splice(index, 1)[0] as Extract<WebMessage, { t: T }>;
		},
		closed: () => closed,
		inbox,
	};
}
const utf8 = (text: string) => new TextEncoder().encode(text);
async function pair(
	m: Phone,
	code: string,
	authenticator = new SoftAuthenticator(),
	accept = true,
	/** spec/remote-access-and-mobile#phone-app: the name set after the code matched; `confirmed` — what the person at the machine typed (null keeps it). */
	named: { device?: string; confirmed?: string | null } = {}
) {
	const page = socket(m, '/ws/pair');
	const hello = await page.next('pair-hello');
	const party = new CPaceParty(
		'initiator',
		{
			prs: utf8(normalizePairingCode(code)),
			ci: webChannelIdentifier(origin(m)),
			sid: Uint8Array.from(Buffer.from(hello.sid, 'base64')),
		},
		utf8('iPhone')
	);
	page.send({ t: 'pair-a', share: Buffer.from(party.share).toString('base64'), device: 'iPhone' });
	const b = await page.next('pair-b', 'pair-refused');
	if (b.t === 'pair-refused') return { page, refused: b };
	party.finish(Uint8Array.from(Buffer.from(b.share, 'base64')), utf8(hello.machine));
	// The machine proves the code first; a page whose check fails hangs up, as signin.ts does.
	if (!party.verify(Uint8Array.from(Buffer.from(b.tag, 'base64')))) {
		page.ws.close();
		await waitFor(() => page.closed() !== null && !m.gateway.pairing.busy);
		return { page, refused: { t: 'pair-refused', reason: 'code', attemptsLeft: null } as const };
	}
	page.send({ t: 'pair-confirm', tag: Buffer.from(party.tag()).toString('base64') });
	const register = await page.next('pair-register', 'pair-refused');
	if (register.t === 'pair-refused') return { page, refused: register };
	const created = authenticator.create({ ...register.options, origin: origin(m) });
	page.send({
		t: 'pair-credential',
		id: created.id,
		clientDataJSON: toBase64Url(created.clientDataJSON),
		attestationObject: toBase64Url(created.attestationObject),
		...(named.device ? { device: named.device } : {}),
	});
	await page.next('pair-wait');
	await waitFor(() => m.gateway.pairing.current.state === 'confirm');
	m.gateway.confirmPairing(
		accept,
		accept ? (named.confirmed === undefined ? 'Dev’s iPhone' : named.confirmed) : null
	);
	const end = await page.next('paired', 'pair-refused');
	return { page, refused: end.t === 'pair-refused' ? end : null, authenticator };
}
async function signIn(m: Phone, authenticator: SoftAuthenticator, bend = {}) {
	const page = socket(m, '/ws');
	const challenge = await page.next('challenge');
	const answer = authenticator.get(
		{ challenge: challenge.challenge, rpId: challenge.rpId, origin: origin(m) },
		bend
	);
	page.send({
		t: 'assert',
		id: answer.id,
		clientDataJSON: toBase64Url(answer.clientDataJSON),
		authenticatorData: toBase64Url(answer.authenticatorData),
		signature: toBase64Url(answer.signature),
		userHandle: answer.userHandle ? toBase64Url(answer.userHandle) : null,
	});
	const outcome = await page.next('welcome', 'refused');
	return { page, outcome };
}
let calls = 0;
async function invoke(page: ReturnType<typeof socket>, channel: string, args: unknown[] = []) {
	const id = ++calls;
	page.send({ t: 'invoke', id, channel, args });
	await waitFor(() => page.inbox.some((item) => item.t === 'result' && item.id === id));
	return page.inbox.find((item) => item.t === 'result' && item.id === id) as Extract<
		WebMessage,
		{ t: 'result' }
	>;
}
async function paired(m: Phone) {
	await m.gateway.startPairing();
	const code = (m.gateway.pairing.current as { code: string }).code;
	const result = await pair(m, code);
	expect(result.refused).toBeNull();
	return result.authenticator!;
}

describe('the web listener’s boundary (spec/remote-access-and-mobile#phone-network)', () => {
	it('takes only its own Host and Origin', () => {
		const expected = { host: 'studio.tail1234.ts.net', port: null };
		expect(webHostAllowed({ host: 'studio.tail1234.ts.net' }, expected)).toBe(true);
		expect(webHostAllowed({ host: 'studio.tail1234.ts.net:443' }, expected)).toBe(true);
		expect(
			webHostAllowed(
				{ host: 'studio.tail1234.ts.net', 'x-forwarded-host': 'studio.tail1234.ts.net' },
				expected
			)
		).toBe(true);
		for (const host of [
			'evil.example',
			'127.0.0.1:7422',
			'studio.tail1234.ts.net:8443',
			'studio.tail1234.ts.net.evil',
			'',
		])
			expect(webHostAllowed({ host }, expected)).toBe(false);
		expect(webHostAllowed({}, expected)).toBe(false);
		expect(
			webHostAllowed(
				{ host: 'studio.tail1234.ts.net', 'x-forwarded-host': 'evil.example' },
				expected
			)
		).toBe(false);
		expect(webHostAllowed({ host: 'localhost:9' }, { host: 'localhost', port: 9 })).toBe(true);
		expect(webHostAllowed({ host: 'localhost' }, { host: 'localhost', port: 9 })).toBe(false);
		expect(
			webOriginAllowed(
				{ origin: 'https://studio.tail1234.ts.net' },
				'https://studio.tail1234.ts.net'
			)
		).toBe(true);
		expect(
			webOriginAllowed({ origin: 'https://evil.example' }, 'https://studio.tail1234.ts.net')
		).toBe(false);
		expect(webOriginAllowed({}, 'https://studio.tail1234.ts.net')).toBe(false);
		// The address the proxy saw is the last one; what the client wrote before it does not count.
		expect(forwardedFor({ headers: { 'x-forwarded-for': '1.2.3.4, 100.101.102.103' } })).toBe(
			'100.101.102.103'
		);
		expect(forwardedFor({ headers: { 'x-forwarded-for': 'evil' } })).toBe('127.0.0.1');
		expect(forwardedFor({ headers: {} })).toBe('127.0.0.1');
		expect(webHeaders('wss://studio.tail1234.ts.net', true)['content-security-policy']).toContain(
			"script-src 'self'"
		);
	});
	it('answers a foreign Host with 421, serves the sign-in page, hides the app without a sign-in', async () => {
		const m = await machine();
		expect((await http(m, '/', { headers: { host: 'evil.example' } })).status).toBe(421);
		const page = await http(m, '/');
		expect(page.status).toBe(200);
		expect(page.headers['content-security-policy']).toContain("default-src 'none'");
		expect(page.headers['x-content-type-options']).toBe('nosniff');
		expect((await http(m, '/assets/index-1.js')).status).toBe(200);
		expect((await http(m, '/assets/app-1.js')).status).toBe(404);
		expect((await http(m, '/bundle-manifest.json')).status).toBe(404);
		expect((await http(m, '/../package.json')).status).toBe(404);
		expect((await http(m, '/', { method: 'PUT' })).status).toBe(405);
		expect(
			(
				await http(m, '/session', {
					method: 'POST',
					headers: { origin: 'https://evil.example' },
					body: '{"ticket":"x"}',
				})
			).status
		).toBe(403);
		// A WebSocket from another site's page is not even upgraded.
		const other = socket(m, '/ws', { origin: 'https://evil.example' });
		await waitFor(() => other.closed() !== null);
		expect(other.inbox).toEqual([]);
		// Pairing is not there while the window is closed.
		const pairing = socket(m, '/ws/pair');
		await waitFor(() => pairing.closed() !== null);
		expect(pairing.inbox).toEqual([]);
	});
});

describe('a phone pairs and signs in (spec/remote-access-and-mobile#phone-network)', () => {
	it('pairs with the code and a passkey, the person confirms, then the passkey signs in and calls web rows only', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const device = m.gateway.status(false).devices[0]!;
		expect(device).toMatchObject({ kind: 'phone', name: 'Dev’s iPhone' });
		expect((await m.gateway.readAudit(50)).map((entry) => entry.kind)).toContain('paired');
		const { page, outcome } = await signIn(m, authenticator);
		expect(outcome.t).toBe('welcome');
		const welcome = outcome as Extract<WebMessage, { t: 'welcome' }>;
		expect(welcome).toMatchObject({ machine: 'studio', device: 'Dev’s iPhone', version: '' });
		expect(welcome.push).toMatch(/^[A-Za-z0-9_-]{87}$/);
		expect(m.peers.map((peer) => peer.kind)).toEqual(['phone']);
		expect(m.gateway.status(false).devices[0]!.connected).toBe(true);
		// The app's files open with the cookie the ticket buys — once.
		const session = await http(m, '/session', {
			method: 'POST',
			headers: { origin: origin(m), 'content-type': 'application/json' },
			body: JSON.stringify({ ticket: welcome.ticket }),
		});
		expect(session.status).toBe(204);
		const cookie = String(session.headers['set-cookie']).split(';')[0]!;
		expect(String(session.headers['set-cookie'])).toMatch(
			/^__Host-brigadir=.+; Path=\/; Secure; HttpOnly; SameSite=Strict/
		);
		expect((await http(m, '/assets/app-1.js', { headers: { cookie } })).status).toBe(200);
		expect(
			(
				await http(m, '/session', {
					method: 'POST',
					headers: { origin: origin(m) },
					body: JSON.stringify({ ticket: welcome.ticket }),
				})
			).status
		).toBe(403);
		// A web row reaches main; a row a phone may not call is refused before any handler.
		expect(await invoke(page, 'workspace:read')).toMatchObject({
			ok: true,
			value: { projects: [{ name: 'repo' }] },
		});
		expect(await invoke(page, 'keep-awake:read')).toMatchObject({
			ok: false,
			error: 'Not available from a phone.',
		});
		expect(await invoke(page, 'remote:enable', [false])).toMatchObject({ ok: false });
		expect(m.calls).toEqual(['workspace:read']);
		// Revoked: the socket goes with `revoked`, the cookie stops opening files, the passkey no longer signs in.
		await m.gateway.revoke(device.id);
		expect(await page.next('bye')).toEqual({ t: 'bye', reason: 'revoked' });
		expect((await http(m, '/assets/app-1.js', { headers: { cookie } })).status).toBe(404);
		const again = await signIn(m, authenticator);
		expect(again.outcome).toMatchObject({ t: 'refused', reason: 'unknown' });
	});
	it('names the phone as the person set it after the code matched, unless the machine renames it (spec/remote-access-and-mobile#phone-app)', async () => {
		const m = await machine();
		await m.gateway.startPairing();
		const code = (m.gateway.pairing.current as { code: string }).code;
		const result = await pair(m, code, new SoftAuthenticator(), true, {
			device: 'Pixel Dev',
			confirmed: null,
		});
		expect(result.refused).toBeNull();
		expect(m.gateway.status(false).devices[0]).toMatchObject({ kind: 'phone', name: 'Pixel Dev' });
		// A name the machine would not take closes the pairing socket as a protocol error.
		expect(
			isWebPairClientMessage({
				t: 'pair-credential',
				id: 'AA',
				clientDataJSON: 'AA',
				attestationObject: 'AA',
				device: '',
			})
		).toBe(false);
	});
	it('comes back with the resume token after a drop, not after the switch went off', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const { page, outcome } = await signIn(m, authenticator);
		const resume = (outcome as Extract<WebMessage, { t: 'welcome' }>).resume;
		page.ws.terminate();
		await waitFor(() => m.peers.length === 0);
		const back = socket(m, '/ws');
		await back.next('challenge');
		back.send({ t: 'resume', token: resume });
		const welcome = await back.next('welcome');
		expect(await invoke(back, 'workspace:read')).toMatchObject({ ok: true });
		await m.gateway.configure({
			module: true,
			enabled: true,
			machineName: null,
			listen: { lan: true, tailscale: true },
			phone: false,
		});
		expect(await back.next('bye')).toEqual({ t: 'bye', reason: 'off' });
		expect(m.gateway.status(false).phone).toMatchObject({ enabled: false, listening: false });
		await m.gateway.configure({
			module: true,
			enabled: true,
			machineName: null,
			listen: { lan: true, tailscale: true },
			phone: true,
		});
		const later = socket(m, '/ws');
		await later.next('challenge');
		later.send({ t: 'resume', token: welcome.resume });
		expect(await later.next('refused')).toMatchObject({ reason: 'expired' });
	});
	it('counts a passkey that does not verify like a wrong password, and refuses a wrong code', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const bad = await signIn(m, authenticator, {
			signature: (signature: Uint8Array) =>
				signature.map((byte, index) => (index === 8 ? byte ^ 1 : byte)),
		});
		expect(bad.outcome).toMatchObject({ t: 'refused', reason: 'passkey' });
		expect(m.gateway.status(false).devices[0]!.failures).toBe(1);
		expect(m.notices.map((notice) => notice.kind)).toContain('failed');
		// Inside the pause the next try is not checked at all.
		const paused = await signIn(m, authenticator);
		expect(paused.outcome).toMatchObject({ t: 'refused', reason: 'wait' });
		// A passkey of another origin: refused (as the browser would not even offer it).
		await m.gateway.unblock(m.gateway.status(false).devices[0]!.id);
		const elsewhere = await signIn(m, authenticator, { origin: 'https://evil.example' });
		expect(elsewhere.outcome).toMatchObject({ t: 'refused', reason: 'passkey' });

		await m.gateway.startPairing();
		const wrong = await pair(m, 'ZZZZZZZZ');
		expect(wrong.refused).toMatchObject({ reason: 'code' });
		expect(m.gateway.pairing.attemptsLeft).toBe(4);
		const declined = await pair(
			m,
			(m.gateway.pairing.current as { code: string }).code,
			new SoftAuthenticator(),
			false
		);
		expect(declined.refused).toMatchObject({ reason: 'declined' });
		expect(m.gateway.status(false).devices).toHaveLength(1);
	});
});

describe('Web Push to a paired phone (spec/remote-access-and-mobile#phone-network)', () => {
	it('keeps the subscription, sends the task name and kind, forgets a gone one, sends nothing while off', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const { page } = await signIn(m, authenticator);
		const ecdh = createECDH('prime256v1');
		ecdh.generateKeys();
		const subscription = {
			endpoint: 'https://push.example/abc',
			p256dh: toBase64Url(ecdh.getPublicKey()),
			auth: toBase64Url(new Uint8Array(16).fill(1)),
		};
		page.send({ t: 'push', subscription: { ...subscription, endpoint: 'https://10.0.0.1/x' } });
		expect(await page.next('push-saved')).toMatchObject({ ok: false });
		page.send({ t: 'push', subscription });
		expect(await page.next('push-saved')).toEqual({ t: 'push-saved', ok: true, error: null });
		await m.gateway.pushPhones('question', 'Fix login', 'project/task');
		expect(m.pushes).toHaveLength(1);
		expect(m.pushes[0]!.url).toBe(subscription.endpoint);
		expect(fromBase64Url(toBase64Url(m.pushes[0]!.body)).length).toBeGreaterThan(86);
		m.pushStatus = 410;
		await m.gateway.pushPhones('done', 'Fix login', 'project/task');
		await m.gateway.pushPhones('done', 'Fix login', 'project/task');
		expect(m.pushes).toHaveLength(2);
		expect((await m.gateway.readAudit(50)).map((entry) => entry.kind)).toEqual(
			expect.arrayContaining(['push-subscribed', 'push-removed'])
		);
		m.pushStatus = 201;
		page.send({ t: 'push', subscription });
		await page.next('push-saved');
		await m.gateway.configure({
			module: true,
			enabled: false,
			machineName: null,
			listen: { lan: true, tailscale: true },
			phone: true,
		});
		await m.gateway.pushPhones('question', 'Fix login', 'project/task');
		expect(m.pushes).toHaveLength(2);
	});
});

/** The registry the web listener writes to, with a hook before one of its writes (the race window of a sign-in). */
async function hookedRegistry(m: Phone, at: number, hook: () => Promise<void>) {
	const registry = await (
		m.gateway as unknown as { requireRegistry(): Promise<DeviceRegistry> }
	).requireRegistry();
	const update = registry.update.bind(registry);
	let calls = 0;
	registry.update = async (id, change) => {
		if (++calls === at) await hook();
		return update(id, change);
	};
	return registry;
}
const assertWith = (
	page: ReturnType<typeof socket>,
	authenticator: SoftAuthenticator,
	challenge: Extract<WebMessage, { t: 'challenge' }>,
	m: Phone
) => {
	const answer = authenticator.get({
		challenge: challenge.challenge,
		rpId: challenge.rpId,
		origin: origin(m),
	});
	page.send({
		t: 'assert',
		id: answer.id,
		clientDataJSON: toBase64Url(answer.clientDataJSON),
		authenticatorData: toBase64Url(answer.authenticatorData),
		signature: toBase64Url(answer.signature),
		userHandle: answer.userHandle ? toBase64Url(answer.userHandle) : null,
	});
};

describe('security review W0 (spec/remote-access-and-mobile#phone-network)', () => {
	it('W1: a sign-in that loses the race with revocation is refused, not left signed in (S10)', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const id = m.gateway.status(false).devices[0]!.id;
		// The second write of a sign-in is `lastLoginAt`: the person revokes the phone just then.
		await hookedRegistry(m, 2, () => m.gateway.revoke(id));
		const { outcome } = await signIn(m, authenticator);
		expect(outcome).toMatchObject({ t: 'refused', reason: 'unknown' });
		expect(m.peers).toHaveLength(0);
	});
	it('W1: a socket that closed while the sign-in wrote leaves no session behind (S10)', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const page = socket(m, '/ws');
		const challenge = await page.next('challenge');
		await hookedRegistry(m, 2, async () => {
			page.ws.terminate();
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
		assertWith(page, authenticator, challenge, m);
		await waitFor(() => page.closed() !== null);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(m.peers).toHaveLength(0);
		expect(m.gateway.status(false).devices[0]!.connected).toBe(false);
	});
	it('W1: the switch going off while the sign-in wrote leaves no session behind (S10)', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const page = socket(m, '/ws');
		const challenge = await page.next('challenge');
		await hookedRegistry(m, 2, async () => {
			void m.gateway.configure({
				module: true,
				enabled: true,
				machineName: null,
				listen: { lan: true, tailscale: true },
				phone: false,
			});
			await waitFor(() => !m.gateway.status(false).phone.listening);
		});
		assertWith(page, authenticator, challenge, m);
		await waitFor(() => page.closed() !== null);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(m.peers).toHaveLength(0);
	});
	it('W5: a resume token signs in once, even sent on two sockets at the same time', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const { page, outcome } = await signIn(m, authenticator);
		const resume = (outcome as Extract<WebMessage, { t: 'welcome' }>).resume;
		page.ws.terminate();
		await waitFor(() => m.peers.length === 0);
		const one = socket(m, '/ws'),
			two = socket(m, '/ws');
		await one.next('challenge');
		await two.next('challenge');
		one.send({ t: 'resume', token: resume });
		two.send({ t: 'resume', token: resume });
		const answers = [await one.next('welcome', 'refused'), await two.next('welcome', 'refused')];
		expect(answers.map((answer) => answer.t).sort()).toEqual(['refused', 'welcome']);
		expect(m.peers).toHaveLength(1);
	});
	it('W4: a phone repeating its push subscription does not flood the audit or rewrite the registry', async () => {
		const m = await machine();
		const authenticator = await paired(m);
		const { page } = await signIn(m, authenticator);
		const subscription = (fill: number) => {
			const ecdh = createECDH('prime256v1');
			ecdh.generateKeys();
			return {
				endpoint: `https://push.example/${fill}`,
				p256dh: toBase64Url(ecdh.getPublicKey()),
				auth: toBase64Url(new Uint8Array(16).fill(fill)),
			};
		};
		const same = subscription(1);
		for (let index = 0; index < 30; index++) {
			page.send({ t: 'push', subscription: same });
			expect(await page.next('push-saved')).toMatchObject({ ok: true });
		}
		const lines = async (kind: string) =>
			(await m.gateway.readAudit(500)).filter((entry) => entry.kind === kind).length;
		expect(await lines('push-subscribed')).toBe(1);
		// Two subscriptions in turn: within the budget of what a device repeats at will (20 a minute).
		const other = subscription(2);
		for (let index = 0; index < 60; index++) {
			page.send({ t: 'push', subscription: index % 2 ? same : other });
			await page.next('push-saved');
		}
		expect(await lines('push-subscribed')).toBeLessThanOrEqual(20);
	});
	it('W2: a request that came through Tailscale Funnel is refused', async () => {
		const m = await machine();
		const funnel = { 'tailscale-funnel-request': '?1' };
		expect((await http(m, '/', { headers: funnel })).status).toBe(403);
		const ws = socket(m, '/ws', funnel);
		await waitFor(() => ws.closed() !== null);
		expect(ws.inbox).toEqual([]);
	});
	it('W2: Funnel turned on later stops the listener at the next look at Tailscale', async () => {
		const host = 'studio.tail1234.ts.net';
		const state = {
			cli: 'tailscale',
			host,
			https: true,
			serving: true,
			funnel: false,
			shared: false,
		};
		const m = await machine({
			testHost: false,
			tailscale: async () => ({ ...state }),
			limits: { tailscaleMs: 50 },
		});
		expect(m.gateway.status(false).phone).toMatchObject({ listening: true, error: null });
		state.funnel = true;
		await waitFor(() => !m.gateway.status(false).phone.listening);
		expect(m.gateway.status(false).phone.error).toMatch(/Funnel/);
	});
	it('spec/remote-access-and-mobile#tailscale-guidance: without the tailscale command the reason says it is not found, and https follows CertDomains', async () => {
		const missing = await machine({
			testHost: false,
			tailscale: async () => ({
				cli: null,
				host: null,
				https: false,
				serving: false,
				funnel: false,
				shared: false,
			}),
		});
		expect(missing.gateway.status(false).phone).toMatchObject({
			listening: false,
			error: 'Tailscale is not found on this machine.',
			tailscale: { cli: false, https: false, serving: false },
		});
		const stopped = await machine({
			testHost: false,
			tailscale: async () => ({
				cli: 'tailscale',
				host: null,
				https: true,
				serving: false,
				funnel: false,
				shared: false,
			}),
		});
		expect(stopped.gateway.status(false).phone.error).toMatch(/not running/);
		expect(stopped.gateway.status(false).phone.tailscale.https).toBe(true);
	});
	it('W3: another service under the same https origin keeps the listener off', async () => {
		const m = await machine({
			testHost: false,
			tailscale: async () => ({
				cli: 'tailscale',
				host: 'studio.tail1234.ts.net',
				https: true,
				serving: true,
				funnel: false,
				shared: true,
			}),
		});
		expect(m.gateway.status(false).phone).toMatchObject({ listening: false });
		expect(m.gateway.status(false).phone.error).toMatch(/shares/);
	});
});

describe('backpressure to a phone (spec/remote-access-and-mobile#outbox, security review W2 J1)', () => {
	// Random text: the listener deflates frames, and a repeated letter would shrink to nothing.
	const big = (mib: number) => randomBytes((mib * 1024 * 1024 * 3) / 4).toString('base64');
	it('answers a reading phone’s file reads in order, one at a time', async () => {
		const m = await machine();
		let running = 0,
			most = 0;
		m.answer = async (channel) => {
			if (channel !== 'search:peek') return undefined;
			running++;
			most = Math.max(most, running);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running--;
			return big(2);
		};
		const { page } = await signIn(m, await paired(m));
		const ids = [9001, 9002, 9003, 9004];
		for (const id of ids) page.send({ t: 'invoke', id, channel: 'search:peek', args: [] });
		await waitFor(() => page.inbox.filter((item) => item.t === 'result').length === 4, 10_000);
		expect(
			page.inbox.filter((item) => item.t === 'result').map((item) => (item as { id: number }).id)
		).toEqual(ids);
		expect(most).toBe(1);
		expect(m.peers).toHaveLength(1);
	});
	it('closes a phone that stops reading: no second file is read for it, main holds no more than the cap', async () => {
		const m = await machine({
			limits: { outbox: { pendingBytes: 8 * 1024 * 1024, drainMs: 400 } },
		});
		let started = 0;
		m.answer = async (channel) => {
			if (channel !== 'search:peek') return undefined;
			started++;
			// More than the kernel's socket buffers take: the first reply stays half written.
			return big(16);
		};
		const { page } = await signIn(m, await paired(m));
		// The page stops reading its socket and asks for twenty large files.
		page.ws.pause();
		for (let id = 1; id <= 20; id++)
			page.send({ t: 'invoke', id: 9100 + id, channel: 'search:peek', args: [] });
		await waitFor(() => m.peers.length === 0, 10_000);
		expect(started).toBe(1);
		await waitFor(async () =>
			(await m.gateway.readAudit(50)).some((entry) => entry.kind === 'disconnected')
		);
	}, 20_000);
	it('closes a phone whose events pile up past the cap', async () => {
		const m = await machine({ limits: { outbox: { pendingBytes: 4 * 1024 * 1024 } } });
		const { page } = await signIn(m, await paired(m));
		page.send({ t: 'subscribe', channels: ['session:event'] });
		await waitFor(() => m.peers.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		page.ws.pause();
		const peer = m.peers[0]!;
		let refused = 0;
		for (let i = 0; i < 40 && !refused; i++) {
			if (!peer.send('session:event', { text: big(1) })) refused = i;
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(refused).toBeGreaterThan(0);
		await waitFor(() => m.peers.length === 0);
	}, 20_000);
});
