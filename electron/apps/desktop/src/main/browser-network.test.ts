import { it, expect, vi } from 'vitest';
import type { BrowserLog } from '@brigadir/core';
import { BrowserNetwork } from './browser-network';
it('tracks one Fetch row, filters credential headers without reading values, bounds bodies and drops old requests', async () => {
	const logs: BrowserLog[] = [];
	const network = new BrowserNetwork(
		(log) => logs.push(log),
		() => {}
	);
	network.event('Network.requestWillBeSent', {
		requestId: 'request',
		timestamp: 2,
		type: 'Fetch',
		request: { method: 'GET', url: 'https://fixture.test/api' },
	});
	const headers = {
		'Content-Type': 'application/json',
		get 'Set-Cookie'(): string {
			throw new Error('Credential read');
		},
		get Authorization(): string {
			throw new Error('Credential read');
		},
	};
	network.event('Network.responseReceived', {
		requestId: 'request',
		response: { status: 503, headers },
	});
	network.event('Network.loadingFinished', {
		requestId: 'request',
		timestamp: 2.1,
		encodedDataLength: 200,
	});
	expect(logs).toHaveLength(1);
	expect(logs[0]).toMatchObject({
		error: true,
		request: { method: 'GET', status: 503, duration: 100, bytes: 200 },
	});
	const result = await network.details(logs[0]!.id, async () => ({
		body: 'x'.repeat(32000),
		base64Encoded: false,
	}));
	expect(result.body).toHaveLength(16384);
	expect(result.truncated).toBe(true);
	expect(result.headers).toEqual({ 'content-type': 'application/json' });
	network.clear();
	await expect(
		network.details(logs[0]!.id, async () => {
			throw new Error('Must not call CDP');
		})
	).rejects.toThrow('no longer');
});
// spec/browser-and-simulator#network-streams: open requests and streams for agents.
it('lists an EventSource only for the agent, with its state, elapsed time, heartbeat bytes and the newest bounded messages', async () => {
	const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
	try {
		const logs: BrowserLog[] = [];
		let changes = 0;
		const network = new BrowserNetwork(
			(log) => logs.push(log),
			() => changes++
		);
		network.event('Network.requestWillBeSent', {
			requestId: 'sse',
			timestamp: 10,
			type: 'EventSource',
			request: { method: 'GET', url: 'http://localhost:3000/api/menu-point/events' },
		});
		expect(logs).toHaveLength(0);
		expect(network.list(1_004_000)[0]).toMatchObject({
			text: 'GET · … · http://localhost:3000/api/menu-point/events · EventSource · pending 4.0 s · 0 messages',
			request: { type: 'EventSource', state: 'pending', elapsed: 4000, received: 0, messages: 0 },
		});
		network.event('Network.responseReceived', {
			requestId: 'sse',
			type: 'EventSource',
			response: {
				status: 200,
				mimeType: 'text/event-stream',
				headers: { 'Content-Type': 'text/event-stream', Cookie: 'secret' },
			},
		});
		const before = changes;
		now.mockReturnValue(1_010_000);
		network.event('Network.dataReceived', {
			requestId: 'sse',
			timestamp: 20,
			dataLength: 8,
			encodedDataLength: 14,
		});
		expect(changes).toBe(before);
		expect(network.list(1_012_000)[0]!.text).toBe(
			'GET · 200 · http://localhost:3000/api/menu-point/events · EventSource · streaming 12.0 s · 8 B received · last data 2.0 s ago · 0 messages'
		);
		for (let index = 0; index < 60; index++)
			network.event('Network.eventSourceMessageReceived', {
				requestId: 'sse',
				timestamp: 21,
				eventName: index % 2 ? 'update' : 'message',
				eventId: String(index),
				data: index === 59 ? 'x'.repeat(5000) : `{"n":${index}}`,
			});
		expect(changes).toBe(before);
		const details = await network.details(network.list()[0]!.id, async () => {
			throw new Error('A stream body is not read');
		});
		expect(details).toMatchObject({
			body: null,
			error: null,
			headers: { 'content-type': 'text/event-stream' },
			messageCount: 60,
			request: { state: 'streaming', messages: 60 },
		});
		expect(details.messages!.length).toBeLessThanOrEqual(50);
		expect(
			details.messages!.reduce((sum, message) => sum + message.data.length, 0)
		).toBeLessThanOrEqual(16384);
		expect(details.messages!.at(-1)).toMatchObject({
			direction: 'in',
			id: '59',
			truncated: true,
			data: 'x'.repeat(2048),
		});
		expect(details.messages!.at(-2)).toMatchObject({ id: '58', data: '{"n":58}' });
		expect(details.messages!.at(-2)!.event).toBeUndefined();
		expect(details.messages!.at(-3)).toMatchObject({ event: 'update', id: '57' });
		network.event('Network.loadingFinished', {
			requestId: 'sse',
			timestamp: 70,
			encodedDataLength: 900,
		});
		expect(network.list()[0]).toMatchObject({
			text: 'GET · 200 · http://localhost:3000/api/menu-point/events · EventSource · 60000 ms · 900 B · 60 messages',
			request: { state: 'done', duration: 60000, bytes: 900 },
		});
		expect(network.list()[0]!.request!.elapsed).toBeUndefined();
	} finally {
		now.mockRestore();
	}
});
it('follows a WebSocket from handshake to close with text and binary frames in both directions', async () => {
	const logs: BrowserLog[] = [];
	const network = new BrowserNetwork(
		(log) => logs.push(log),
		() => {}
	);
	network.event('Network.webSocketCreated', { requestId: 'ws', url: 'ws://localhost:3000/live' });
	network.event('Network.webSocketWillSendHandshakeRequest', {
		requestId: 'ws',
		timestamp: 5,
		wallTime: 1,
		request: { headers: {} },
	});
	network.event('Network.webSocketHandshakeResponseReceived', {
		requestId: 'ws',
		timestamp: 5.01,
		response: { status: 101, headers: { Upgrade: 'websocket', 'Set-Cookie': 'secret' } },
	});
	network.event('Network.webSocketFrameSent', {
		requestId: 'ws',
		timestamp: 5.1,
		response: { opcode: 1, mask: true, payloadData: 'hello' },
	});
	network.event('Network.webSocketFrameReceived', {
		requestId: 'ws',
		timestamp: 5.2,
		response: { opcode: 1, mask: false, payloadData: 'world!' },
	});
	network.event('Network.webSocketFrameReceived', {
		requestId: 'ws',
		timestamp: 5.3,
		response: { opcode: 2, mask: false, payloadData: Buffer.from([1, 2, 3]).toString('base64') },
	});
	network.event('Network.webSocketFrameReceived', {
		requestId: 'ws',
		timestamp: 5.3,
		response: { opcode: 9, mask: false, payloadData: '' },
	});
	expect(logs).toHaveLength(0);
	expect(network.list()[0]!.request).toMatchObject({
		type: 'WebSocket',
		status: 101,
		state: 'streaming',
		received: 9,
		messages: 3,
	});
	const details = await network.details(network.list()[0]!.id, async () => {
		throw new Error('A socket has no body');
	});
	expect(details.headers).toEqual({ upgrade: 'websocket' });
	expect(details.messages!.map(({ direction, data }) => [direction, data])).toEqual([
		['out', 'hello'],
		['in', 'world!'],
		['in', '[binary 3 B]'],
	]);
	network.event('Network.webSocketClosed', { requestId: 'ws', timestamp: 7 });
	expect(network.list()[0]).toMatchObject({
		error: false,
		request: { state: 'done', duration: 2000, bytes: 9 },
	});
});
it('parses an event stream read by fetch from streamed bytes in order, ignores heartbeats and keeps the drawer row', async () => {
	const logs: BrowserLog[] = [];
	let release!: (value: { bufferedData: string }) => void;
	const streamed: string[] = [];
	const network = new BrowserNetwork(
		(log) => logs.push(log),
		() => {},
		async (requestId) => {
			streamed.push(requestId);
			return new Promise((resolve) => {
				release = resolve;
			});
		}
	);
	const chunk = (text: string) => Buffer.from(text).toString('base64');
	network.event('Network.requestWillBeSent', {
		requestId: 'fetch',
		timestamp: 1,
		type: 'Fetch',
		request: { method: 'GET', url: 'http://localhost:3000/stream' },
	});
	network.event('Network.responseReceived', {
		requestId: 'fetch',
		type: 'Fetch',
		response: { status: 200, mimeType: 'text/event-stream', headers: {} },
	});
	expect(streamed).toEqual(['fetch']);
	network.event('Network.dataReceived', {
		requestId: 'fetch',
		dataLength: 20,
		data: chunk('data: second\r\n\r\n: ping\n\nevent: done\nda'),
	});
	release({ bufferedData: chunk(': ping\n\nid: 7\ndata: first\ndata: line\n\n') });
	await new Promise((resolve) => setTimeout(resolve, 0));
	network.event('Network.dataReceived', {
		requestId: 'fetch',
		dataLength: 9,
		data: chunk('ta: {}\n\n'),
	});
	expect(logs).toHaveLength(1);
	expect(network.list()[0]!.request).toMatchObject({
		type: 'Fetch',
		state: 'streaming',
		received: 29,
		messages: 3,
	});
	const details = await network.details(logs[0]!.id, async () => {
		throw new Error('Still open');
	});
	expect(details.error).toBe('Response body is unavailable');
	expect(details.messages!.map(({ event, id, data }) => ({ event, id, data }))).toEqual([
		{ event: undefined, id: '7', data: 'first\nline' },
		{ event: undefined, id: undefined, data: 'second' },
		{ event: 'done', id: undefined, data: '{}' },
	]);
});
it('keeps an old open stream listed and in the buffer among hundreds of newer requests, and reports a page that is a stream', async () => {
	const network = new BrowserNetwork(
		() => {},
		() => {}
	);
	const opened = network.documentStream('http://localhost/events');
	let other = false;
	void network.documentStream('http://localhost/').promise.then(() => {
		other = true;
	});
	let resolved = false;
	void opened.promise.then(() => {
		resolved = true;
	});
	network.event('Network.requestWillBeSent', {
		requestId: 'sse',
		timestamp: 1,
		type: 'EventSource',
		request: { method: 'GET', url: 'http://localhost/events' },
	});
	for (let index = 0; index < 700; index++) {
		network.event('Network.requestWillBeSent', {
			requestId: `r${index}`,
			timestamp: 1,
			type: 'XHR',
			request: { method: 'GET', url: `http://localhost/api/${index}` },
		});
		network.event('Network.loadingFinished', {
			requestId: `r${index}`,
			timestamp: 1.01,
			encodedDataLength: 1,
		});
	}
	const list = network.list();
	expect(list.length).toBeLessThanOrEqual(101);
	expect(list[0]!.request!.url).toBe('http://localhost/events');
	expect(list.at(-1)!.request!.url).toBe('http://localhost/api/699');
	expect(list.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(32 * 1024 + 200);
	network.event('Network.responseReceived', {
		requestId: 'page',
		type: 'Document',
		timestamp: 2,
		response: {
			url: 'http://localhost/events',
			status: 200,
			mimeType: 'text/event-stream',
			headers: {},
		},
	});
	await Promise.resolve();
	expect(resolved).toBe(true);
	expect(other).toBe(false);
	expect(network.list().at(-1)!.request).toMatchObject({ type: 'Document', state: 'streaming' });
});
