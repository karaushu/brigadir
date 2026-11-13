import { expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import {
	MetroSession,
	appRequests,
	appScheme,
	assignMetroPort,
	connectPort,
	devClientLink,
	portFree,
	formatLogs,
	formatRequest,
	formatRequests,
	type MetroDeps,
} from './metro';
function fakeMetro(root: string) {
	const sockets: {
		url: string;
		origin: string;
		sent: { id: number; method: string; params: Record<string, unknown> }[];
		socket: any;
	}[] = [];
	let now = 1_000_000;
	const deps: MetroDeps = {
		now: () => now,
		fetch: async (url) => {
			const port = Number(/:(\d+)\//.exec(url)?.[1]);
			if (port !== 8082) throw new Error('refused');
			return {
				ok: true,
				headers: { get: (name) => (name === 'x-react-native-project-root' ? root : null) },
				json: async () => [
					{
						id: 'dev-1',
						appId: 'com.example.couriers',
						webSocketDebuggerUrl: 'ws://localhost:8082/inspector/debug?device=dev&page=1',
					},
				],
			};
		},
		socket: (url, origin) => {
			const socket: any = {
				onopen: null,
				onclose: null,
				onerror: null,
				onmessage: null,
				close() {
					socket.onclose?.();
				},
				send(data: string) {
					const message = JSON.parse(data);
					entry.sent.push(message);
					if (message.method === 'Network.getResponseBody')
						queueMicrotask(() =>
							socket.onmessage?.({
								data: JSON.stringify({
									id: message.id,
									result:
										message.params.requestId === '7'
											? { body: '{"ok":false}', base64Encoded: false }
											: {},
								}),
							})
						);
				},
			};
			const entry = { url, origin, sent: [] as any[], socket };
			sockets.push(entry);
			queueMicrotask(() => socket.onopen?.());
			return socket;
		},
	};
	return {
		deps,
		sockets,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
it('finds the Metro of the project, attaches with a 127.0.0.1 origin and buffers console and requests (spec/browser-and-simulator#simulator)', async () => {
	const metro = fakeMetro('/data/worktrees/project/task'),
		changes: number[] = [];
	const session = new MetroSession(
		async () => ['/data/worktrees/project', '/repo'],
		() => changes.push(1),
		metro.deps
	);
	try {
		session.start();
		await expect.poll(() => session.target?.port).toBe(8082);
		expect(metro.sockets[0]).toMatchObject({
			url: 'ws://localhost:8082/inspector/debug?device=dev&page=1',
			origin: 'http://127.0.0.1:8082',
		});
		expect(metro.sockets[0]!.sent.map((message) => message.method)).toEqual([
			'Runtime.enable',
			'Log.enable',
			'Network.enable',
		]);
		const feed = (method: string, params: Record<string, unknown>) =>
			session.receive({ method, params });
		// An exception arrives as console.error with the Error object (probe C0); a replayed entry is dropped.
		feed('Runtime.consoleAPICalled', {
			type: 'log',
			timestamp: 1,
			args: [{ type: 'string', value: 'Running "main"' }],
		});
		feed('Runtime.consoleAPICalled', {
			type: 'error',
			timestamp: 2,
			args: [{ type: 'object', description: 'Error: take failed\n    at take (App.tsx:42)' }],
		});
		feed('Runtime.consoleAPICalled', {
			type: 'log',
			timestamp: 1,
			args: [{ type: 'string', value: 'Running "main"' }],
		});
		expect(formatLogs(session.logs)).toBe(
			'00:00:00.001 log Running "main"\n00:00:00.002 error Error: take failed\n    at take (App.tsx:42)'
		);
		expect(formatLogs(session.logs, 'warn')).toContain('take failed');
		expect(formatLogs(session.logs, undefined, 'RUNNING')).not.toContain('error');
		// XHR comes twice: Expo's numeric id stays, RN's UUID copy goes; Metro's own traffic is not the app's.
		feed('Network.requestWillBeSent', {
			requestId: '0a966b4c-1111-2222-3333-444455556666',
			type: 'XHR',
			request: { method: 'POST', url: 'https://api.test/v2/orders/4821/take' },
		});
		feed('Network.requestWillBeSent', {
			requestId: '7',
			type: 'Other',
			request: {
				method: 'POST',
				url: 'https://api.test/v2/orders/4821/take',
				postData: '{"id":4821}',
			},
		});
		feed('Network.requestWillBeSent', {
			requestId: '8',
			type: 'Other',
			request: { method: 'GET', url: 'http://127.0.0.1:8082/assets/?unstable_path=x' },
		});
		metro.advance(212);
		feed('Network.responseReceived', {
			requestId: '7',
			response: {
				status: 409,
				mimeType: 'application/json',
				headers: { 'content-type': 'application/json' },
			},
		});
		feed('Network.loadingFinished', { requestId: '7', encodedDataLength: 12 });
		await expect.poll(() => session.requests.get('7')?.body).toBe('{"ok":false}');
		expect(appRequests(session).map((item) => item.id)).toEqual(['7']);
		expect(formatRequests(appRequests(session), 1_000_212)).toBe(
			'7 POST 409 212 ms 12 B https://api.test/v2/orders/4821/take'
		);
		expect(formatRequest(session.requests.get('7')!)).toBe(
			'POST https://api.test/v2/orders/4821/take\nStatus: 409 · 212 ms · 12 B\nRequest body:\n{"id":4821}\nResponse headers:\n  content-type: application/json\nBody:\n{"ok":false}'
		);
		// A request that never ends is shown as such after 30 s (no loadingFailed from Expo).
		feed('Network.requestWillBeSent', {
			requestId: '9',
			type: 'Other',
			request: { method: 'GET', url: 'https://nonexistent.invalid/' },
		});
		expect(formatRequests(appRequests(session), 1_000_212 + 31_000, 'nonexistent')).toBe(
			'9 GET no response … https://nonexistent.invalid/'
		);
		// Metro goes away: the target clears and the session looks again.
		metro.sockets[0]!.socket.close();
		expect(session.target).toBeNull();
	} finally {
		session.stop();
	}
});
it('ignores a Metro that serves another project', async () => {
	const metro = fakeMetro('/elsewhere/app');
	const session = new MetroSession(
		async () => ['/data/worktrees/project', '/repo'],
		() => {},
		metro.deps
	);
	expect(await session.discover()).toBeNull();
	session.stop();
});
it("takes the task's own Metro serving its device, then any Metro serving it, and finds a task port beyond the usual ones (spec/browser-and-simulator#metro)", async () => {
	const serve: Record<number, { root: string; device: string | null }> = {
		8081: { root: '/repo', device: 'iPhone Air' },
		8082: { root: '/data/worktrees/project/a', device: 'iPhone 17 Pro' },
		8083: { root: '/data/worktrees/project/b', device: 'iPhone Air' },
		// A task's own port, outside 8081–8090: its Metro runs, the app is not on it yet.
		8140: { root: '/data/worktrees/project/c', device: null },
	};
	const deps: MetroDeps = {
		now: () => 0,
		socket: () => {
			throw new Error('not used');
		},
		fetch: async (url) => {
			const port = Number(/:(\d+)\//.exec(url)?.[1]);
			const metro = serve[port];
			if (!metro) throw new Error('refused');
			return {
				ok: true,
				headers: { get: (name) => (name === 'x-react-native-project-root' ? metro.root : null) },
				json: async () =>
					metro.device
						? [
								{
									appId: 'app',
									title: `app (${metro.device})`,
									deviceName: metro.device,
									webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug`,
								},
							]
						: [],
			};
		},
	};
	let device = 'iPhone 17 Pro',
		own: string | null = '/data/worktrees/project/a';
	const session = new MetroSession(
		async () => [...(own ? [own] : []), '/data/worktrees/project', '/repo'],
		() => {},
		deps,
		() => device,
		() => own,
		() => [8140]
	);
	expect((await session.discover())?.port).toBe(8082);
	expect(session.found).toEqual([
		{ port: 8082, root: '/data/worktrees/project/a', device: true, own: true, attached: true },
		{ port: 8083, root: '/data/worktrees/project/b', device: false, own: false, attached: false },
		{ port: 8081, root: '/repo', device: false, own: false, attached: false },
	]);
	expect(connectPort(session.found)).toBe(null);
	// Two Metros serve an iPhone Air: the task's own tree wins over the order of the roots, not the last agent to call.
	device = 'iPhone Air';
	own = '/data/worktrees/project/b';
	expect((await session.discover())?.port).toBe(8083);
	own = '/repo';
	expect((await session.discover())?.port).toBe(8081);
	// spec/browser-and-simulator#metro-connect: the task's own Metro answers without the device: the client stays on one serving the device, and connects to its port.
	own = '/data/worktrees/project/c';
	expect((await session.discover())?.port).toBe(8083);
	expect(connectPort(session.found)).toBe(8140);
});
it('hands a worktree a free port, keeps a saved one while free or its own Metro holds it, never a busy one (spec/browser-and-simulator#metro-port)', async () => {
	const busy = new Set([8082, 8083]);
	const free = async (port: number) => !busy.has(port);
	expect(await assignMetroPort({ saved: undefined, taken: new Set(), free })).toBe(8084);
	// Another task already has 8084.
	expect(await assignMetroPort({ saved: undefined, taken: new Set([8084]), free })).toBe(8085);
	// The saved port stays while free…
	expect(await assignMetroPort({ saved: 8090, taken: new Set(), free })).toBe(8090);
	// …or while the task's own Metro listens on it.
	expect(
		await assignMetroPort({
			saved: 8082,
			taken: new Set(),
			free,
			ownMetro: async (port) => port === 8082,
		})
	).toBe(8082);
	// A busy saved port of someone else is given up.
	expect(
		await assignMetroPort({ saved: 8083, taken: new Set(), free, ownMetro: async () => false })
	).toBe(8084);
	// A port another task holds is never shared, even when it was saved.
	expect(await assignMetroPort({ saved: 8090, taken: new Set([8090]), free })).toBe(8084);
	await expect(
		assignMetroPort({ saved: undefined, taken: new Set(), free: async () => false })
	).rejects.toThrow('No free port for Metro.');
});
it('knows a port that something listens on is busy (spec/browser-and-simulator#metro-port)', async () => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	try {
		expect(await portFree(port)).toBe(false);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	expect(await portFree(port)).toBe(true);
});
it('reads the app scheme from the task tree, then the project, and builds the dev-client link (spec/browser-and-simulator#metro-connect)', async () => {
	const files: Record<string, string> = {
		'/repo/app.json': JSON.stringify({
			expo: { slug: 'business', scheme: ['choice-business', 'other'] },
		}),
		'/tree/app.config.ts': "export default { expo: { slug: 'tree-app', scheme: 'tree-scheme' } };",
		'/slug/app.json': JSON.stringify({ expo: { slug: 'only-slug' } }),
	};
	const read = async (path: string) => {
		if (!(path in files)) throw new Error('ENOENT');
		return files[path]!;
	};
	expect(await appScheme(['/tree', '/repo'], read)).toBe('tree-scheme');
	expect(await appScheme(['/missing', '/repo'], read)).toBe('choice-business');
	expect(await appScheme(['/slug'], read)).toBe('exp+only-slug');
	expect(await appScheme(['/missing'], read)).toBe(null);
	expect(devClientLink('choice-business', 8083)).toBe(
		'choice-business://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8083'
	);
});
