import { expect, it } from 'vitest';
import {
	MetroSession,
	appRequests,
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
it('takes the Metro this device is connected to among several, then the preferred task tree (spec/browser-and-simulator#simulator)', async () => {
	const serve: Record<number, { root: string; device: string }> = {
		8081: { root: '/repo', device: 'iPhone Air' },
		8082: { root: '/data/worktrees/project/a', device: 'iPhone 17 Pro' },
		8083: { root: '/data/worktrees/project/b', device: 'iPhone Air' },
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
				json: async () => [
					{
						appId: 'app',
						title: `app (${metro.device})`,
						deviceName: metro.device,
						webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug`,
					},
				],
			};
		},
	};
	let device = 'iPhone 17 Pro';
	const session = new MetroSession(
		async () => ['/data/worktrees/project', '/repo'],
		() => {},
		deps,
		() => device
	);
	expect((await session.discover())?.port).toBe(8082);
	expect(session.found).toEqual([
		{ port: 8082, root: '/data/worktrees/project/a', device: true, attached: true },
		{ port: 8083, root: '/data/worktrees/project/b', device: false, attached: false },
		{ port: 8081, root: '/repo', device: false, attached: false },
	]);
	// Two Metros serve an iPhone Air: the task tree of the agent that asked wins over the order of the roots.
	device = 'iPhone Air';
	expect((await session.discover())?.port).toBe(8083);
	session.prefer('/repo');
	expect((await session.discover())?.port).toBe(8081);
});
