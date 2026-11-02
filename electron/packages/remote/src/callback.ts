/**
 * spec/remote-access-and-mobile#networking: an agent's sign-in started from a device comes back to `localhost:<port>` — the device's browser asks
 * the device's loopback, but the sign-in's server runs on the machine. The device listens on that port once, for this
 * sign-in, and passes each request through the authenticated connection; the machine asks its own loopback port, the
 * one in the sign-in page's `redirect_uri`, and nothing else.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import {
	agentRelayHeaders,
	agentRelayLimits,
	isAgentLoginRelayRequest,
	type AgentLoginRelayRequest,
	type AgentLoginRelayResponse,
	type LoopbackRedirect,
} from '@brigadir/core';

const keptHeaders = ['content-type', 'cache-control'] as const;
/** A `location` the browser may follow back to the same server, as a path; anything else is dropped. */
export function relayLocation(location: string, redirect: LoopbackRedirect): string | null {
	if (location.startsWith('/') && !location.startsWith('//')) return location.slice(0, 2048);
	try {
		const url = new URL(location);
		const host = url.hostname.replace(/^\[|\]$/g, '');
		if (
			url.protocol === 'http:' &&
			['localhost', '127.0.0.1', '::1'].includes(host) &&
			Number(url.port) === redirect.port
		)
			return `${url.pathname}${url.search}`.slice(0, 2048);
	} catch {
		return null;
	}
	return null;
}
/**
 * The machine's side: one request of the device's browser to the sign-in's own server on this machine's loopback.
 * `localhost` tries IPv4 first, then IPv6. The answer is cut at 1 MB and 10 s.
 */
export async function relayToLoopback(
	redirect: LoopbackRedirect,
	request: AgentLoginRelayRequest,
	timeoutMs: number = agentRelayLimits.timeoutMs
): Promise<AgentLoginRelayResponse> {
	if (!isAgentLoginRelayRequest(request)) throw new Error('The sign-in request is not valid.');
	const hosts = redirect.host === 'localhost' ? ['127.0.0.1', '::1'] : [redirect.host];
	let last: Error | null = null;
	for (const host of hosts) {
		try {
			return await once(host, redirect, request, timeoutMs);
		} catch (error) {
			last = error instanceof Error ? error : new Error(String(error));
			if ((last as NodeJS.ErrnoException).code !== 'ECONNREFUSED') break;
		}
	}
	throw last ?? new Error('The sign-in server did not answer.');
}
function once(
	host: string,
	redirect: LoopbackRedirect,
	request: AgentLoginRelayRequest,
	timeoutMs: number
): Promise<AgentLoginRelayResponse> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { host: `localhost:${redirect.port}` };
		for (const name of agentRelayHeaders) {
			const value = request.headers[name];
			if (value) headers[name] = value;
		}
		const outgoing = httpRequest(
			{ host, port: redirect.port, method: request.method, path: request.path, headers },
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > agentRelayLimits.bodyBytes) {
						response.destroy();
						return reject(new Error('The sign-in answer is too large.'));
					}
					chunks.push(chunk);
				});
				response.on('error', reject);
				response.on('end', () => {
					const kept: Record<string, string> = {};
					for (const name of keptHeaders) {
						const value = response.headers[name];
						if (typeof value === 'string') kept[name] = value.slice(0, 512);
					}
					const location = response.headers.location;
					if (typeof location === 'string') {
						const path = relayLocation(location, redirect);
						if (path) kept.location = path;
					}
					resolve({
						status: Math.min(599, Math.max(100, response.statusCode ?? 502)),
						headers: kept,
						body: new Uint8Array(Buffer.concat(chunks)),
					});
				});
			}
		);
		outgoing.setTimeout(timeoutMs, () => {
			outgoing.destroy(new Error('The sign-in server did not answer in time.'));
		});
		outgoing.on('error', reject);
		outgoing.end();
	});
}

/** The request a browser made to the device's listener, as the relay row takes it; null — not one we pass. */
export function relayRequestOf(
	incoming: Pick<IncomingMessage, 'method' | 'url' | 'headers'>
): AgentLoginRelayRequest | null {
	const headers: AgentLoginRelayRequest['headers'] = {};
	for (const name of agentRelayHeaders) {
		const value = incoming.headers[name];
		if (typeof value === 'string') headers[name] = value.slice(0, agentRelayLimits.headerValue);
	}
	const request = { method: incoming.method ?? '', path: incoming.url ?? '', headers };
	return isAgentLoginRelayRequest(request) ? request : null;
}

/**
 * What the machine's answer may do in the device's browser: it is drawn, never run on the device's `localhost` origin —
 * cookies there are shared by every local port, so a script the machine served would read the device's local apps'
 * cookies (security review R2–R4, V6).
 */
const relayedPageHeaders = {
	'content-security-policy':
		"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
};
/** `localhost`, `127.0.0.1` or `[::1]` with this port: the names a sign-in's `redirect_uri` uses. */
function loopbackHost(host: string | undefined, port: number | null): boolean {
	const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host ?? '');
	return !!match && port !== null && Number(match[2] ?? 80) === port;
}
/**
 * The device's side: a one-shot HTTP listener on this computer's loopback, on the sign-in's port, alive while the
 * sign-in waits (at most `listenMs`, 16 requests). Each request goes to the machine through `relay`.
 */
export class CallbackListener {
	private servers: Server[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private served = 0;
	private closed = false;
	constructor(
		private readonly relay: (request: AgentLoginRelayRequest) => Promise<AgentLoginRelayResponse>,
		private readonly onClose: () => void = () => {},
		private readonly log: (line: string) => void = () => {}
	) {}
	/** Listens on 127.0.0.1 (and ::1 when it can); false when the port is taken here. */
	async listen(port: number, listenMs: number = agentRelayLimits.listenMs): Promise<boolean> {
		for (const host of ['127.0.0.1', '::1']) {
			const server = createServer((incoming, response) => void this.serve(incoming, response));
			const ok = await new Promise<boolean>((resolve) => {
				server.once('error', () => resolve(false));
				server.listen({ port, host, exclusive: true }, () => resolve(true));
			});
			if (ok) {
				server.on('error', (error) => this.log(`remote: sign-in listener: ${error.message}`));
				this.servers.push(server);
			} else if (host === '127.0.0.1') return false;
		}
		this.timer = setTimeout(() => this.close(), listenMs);
		this.timer.unref?.();
		return true;
	}
	get port(): number | null {
		const address = this.servers[0]?.address();
		return address && typeof address === 'object' ? address.port : null;
	}
	private async serve(incoming: IncomingMessage, response: import('node:http').ServerResponse) {
		incoming.resume();
		// Only the loopback name the sign-in uses: a site the device's browser resolves to 127.0.0.1 (DNS rebinding) is
		// not let through to the machine (security review R2–R4, V6).
		if (!loopbackHost(incoming.headers.host, this.port)) {
			response.writeHead(421, { connection: 'close' }).end();
			return;
		}
		const request = relayRequestOf(incoming);
		if (!request) {
			response.writeHead(405, { connection: 'close' }).end();
			return;
		}
		if (++this.served > agentRelayLimits.requests) {
			response.writeHead(429, { connection: 'close' }).end();
			return;
		}
		try {
			const answer = await this.relay(request);
			response.writeHead(answer.status, {
				...answer.headers,
				...relayedPageHeaders,
				connection: 'close',
			});
			response.end(request.method === 'HEAD' ? undefined : Buffer.from(answer.body));
		} catch (error) {
			this.log(`remote: sign-in relay: ${error instanceof Error ? error.message : String(error)}`);
			response.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
			response.end('The sign-in could not reach the working machine.');
		}
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		for (const server of this.servers) {
			server.close();
			server.closeAllConnections?.();
		}
		this.servers = [];
		this.onClose();
	}
}
