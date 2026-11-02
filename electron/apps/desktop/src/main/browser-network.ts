import type {
	BrowserLog,
	BrowserNetworkDetails,
	BrowserRequest,
	BrowserStreamMessage,
} from '@brigadir/core';
/**
 * Requests of the page from CDP Network events (spec/browser-and-simulator#console-network). Fetch and XHR are drawer rows; spec/browser-and-simulator#network-streams adds what an agent needs to
 * see a live connection: EventSource, WebSocket and a page that is itself an event stream, the state of every request
 * (pending, streaming, done, failed) and the newest messages of a stream. Messages and live counters never reach the
 * renderer: they would republish every row on every heartbeat; an agent's reply works them out when asked.
 */
type Sse = {
	decoder: TextDecoder;
	buffer: string;
	event: string;
	id: string;
	data: string[];
	chars: number;
	queue: string[] | null;
};
type Request = {
	requestId: string;
	log: BrowserLog;
	start: number | null;
	headers: Record<string, string>;
	received: number;
	lastData: number | null;
	messages: BrowserStreamMessage[];
	stored: number;
	count: number;
	sse?: Sse | undefined;
};
const requestsKept = 500,
	messageChars = 2048,
	streamChars = 16384,
	streamMessages = 50,
	streamsWithMessages = 20,
	openListed = 20,
	listed = 100,
	listChars = 32 * 1024,
	detailChars = 16384;
const open = (data: BrowserRequest) => data.state === 'pending' || data.state === 'streaming';
const seconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
export class BrowserNetwork {
	private requests = new Map<string, Request>();
	private counter = 0;
	private documentWaiters = new Map<() => void, string>();
	/** stream: Network.streamResourceContent, so dataReceived carries the bytes of an event stream read by fetch or opened as the page. */
	constructor(
		private add: (log: BrowserLog) => void,
		private changed: () => void,
		private stream: (requestId: string) => Promise<{ bufferedData: string }> = async () => {
			throw new Error('No streaming');
		}
	) {}
	clear() {
		this.requests.clear();
	}
	/** Resolves when the page being opened at url turns out to be an event stream: its load never finishes while the stream is open. A frame of another address does not count. */
	documentStream(url: string) {
		let done!: () => void;
		const promise = new Promise<void>((resolve) => {
			done = resolve;
		});
		this.documentWaiters.set(done, url);
		return { promise, cancel: () => this.documentWaiters.delete(done) };
	}
	event(method: string, params: any) {
		if (
			method === 'Network.requestWillBeSent' &&
			['Fetch', 'XHR', 'EventSource'].includes(params.type)
		) {
			if (!this.requests.has(params.requestId))
				this.track(
					params.requestId,
					params.type,
					params.request.method,
					params.request.url,
					params.timestamp
				);
			return;
		}
		if (method === 'Network.webSocketCreated') {
			if (!this.requests.has(params.requestId))
				this.track(params.requestId, 'WebSocket', 'GET', params.url, null);
			return;
		}
		if (
			method === 'Network.responseReceived' &&
			params.type === 'Document' &&
			streamType(params.response?.mimeType) &&
			!this.requests.has(params.requestId)
		) {
			this.track(params.requestId, 'Document', 'GET', params.response.url, params.timestamp);
			for (const [done, url] of this.documentWaiters)
				if (url === params.response.url) {
					done();
					this.documentWaiters.delete(done);
				}
		}
		const request = this.requests.get(params.requestId);
		if (!request) return;
		const data = request.log.request!;
		if (method === 'Network.responseReceived') {
			data.status = params.response.status;
			data.state = 'streaming';
			request.log.error = data.status !== null && data.status >= 400;
			request.headers = safeHeaders(params.response.headers ?? {});
			if (data.type !== 'EventSource' && streamType(params.response.mimeType)) this.follow(request);
		} else if (method === 'Network.dataReceived') {
			request.received += Math.max(0, Number(params.dataLength) || 0);
			request.lastData = Date.now();
			if (typeof params.data === 'string' && request.sse) {
				if (request.sse.queue) request.sse.queue.push(params.data);
				else this.feed(request, params.data);
			}
			return;
		} else if (method === 'Network.eventSourceMessageReceived') {
			this.message(request, {
				direction: 'in',
				event:
					params.eventName && params.eventName !== 'message' ? String(params.eventName) : undefined,
				id: params.eventId ? String(params.eventId) : undefined,
				data: String(params.data ?? ''),
			});
			return;
		} else if (method === 'Network.webSocketWillSendHandshakeRequest') {
			request.start = params.timestamp;
			return;
		} else if (method === 'Network.webSocketHandshakeResponseReceived') {
			data.status = Number(params.response.status);
			data.state = 'streaming';
			request.log.error = data.status >= 400;
			request.headers = safeHeaders(params.response.headers ?? {});
		} else if (
			method === 'Network.webSocketFrameReceived' ||
			method === 'Network.webSocketFrameSent'
		) {
			const frame = params.response ?? {};
			const payload = String(frame.payloadData ?? '');
			if (frame.opcode !== 1 && frame.opcode !== 2) return;
			const size =
					frame.opcode === 1 ? Buffer.byteLength(payload) : Buffer.from(payload, 'base64').length,
				incoming = method === 'Network.webSocketFrameReceived';
			if (incoming) {
				request.received += size;
				request.lastData = Date.now();
			}
			this.message(request, {
				direction: incoming ? 'in' : 'out',
				data: frame.opcode === 1 ? payload : `[binary ${size} B]`,
			});
			return;
		} else if (method === 'Network.webSocketFrameError') {
			request.log.error = true;
			request.log.failure = String(params.errorMessage).slice(0, 1000);
		} else if (method === 'Network.webSocketClosed') {
			data.duration = this.duration(request, params.timestamp);
			data.bytes = request.received;
			data.state = request.log.error ? 'failed' : 'done';
		} else if (method === 'Network.loadingFinished') {
			data.duration = this.duration(request, params.timestamp);
			data.bytes = Math.max(0, params.encodedDataLength);
			data.state = 'done';
		} else if (method === 'Network.loadingFailed') {
			data.duration = this.duration(request, params.timestamp);
			data.state = 'failed';
			request.log.error = true;
			request.log.failure = String(params.errorText).slice(0, 1000);
		} else return;
		this.describe(request.log);
		this.changed();
	}
	private track(
		requestId: string,
		type: BrowserRequest['type'],
		method: unknown,
		url: unknown,
		start: number | null
	) {
		const log: BrowserLog = {
			id: `network-${++this.counter}`,
			kind: 'network',
			at: Date.now(),
			error: false,
			text: '',
			request: {
				method: String(method).slice(0, 20),
				url: String(url).slice(0, 8192),
				type,
				status: null,
				duration: null,
				bytes: null,
				state: 'pending',
			},
		};
		this.requests.set(requestId, {
			requestId,
			log,
			start,
			headers: {},
			received: 0,
			lastData: null,
			messages: [],
			stored: 0,
			count: 0,
		});
		// A long stream is often the oldest request of the page: evict finished requests first.
		while (this.requests.size > requestsKept) {
			const evicted =
				[...this.requests.entries()].find(([, request]) => !open(request.log.request!))?.[0] ??
				this.requests.keys().next().value!;
			this.requests.delete(evicted);
		}
		this.describe(log);
		if (type === 'Fetch' || type === 'XHR') this.add(log);
	}
	private duration(request: Request, timestamp: number) {
		return request.start === null || !Number.isFinite(timestamp)
			? Math.max(0, Date.now() - request.log.at)
			: Math.max(0, Math.round((timestamp - request.start) * 1000));
	}
	/** An event stream read by fetch or opened as the page: Chromium hands its bytes over only on request. */
	private follow(request: Request) {
		if (request.sse) return;
		request.sse = {
			decoder: new TextDecoder(),
			buffer: '',
			event: '',
			id: '',
			data: [],
			chars: 0,
			queue: [],
		};
		this.prune();
		this.stream(request.requestId).then(
			({ bufferedData }) => {
				const sse = request.sse;
				if (!sse || this.requests.get(request.requestId) !== request) return;
				const queued = sse.queue ?? [];
				sse.queue = null;
				if (bufferedData) this.feed(request, bufferedData);
				for (const chunk of queued) this.feed(request, chunk);
			},
			() => {
				request.sse = undefined;
			}
		);
	}
	/** The text/event-stream format: a blank line ends an event, `:` starts a comment (the heartbeat), data lines join with newlines. */
	private feed(request: Request, chunk: string) {
		const sse = request.sse!;
		sse.buffer += sse.decoder.decode(Buffer.from(chunk, 'base64'), { stream: true });
		const lines = sse.buffer.split(/\r\n|\n|\r/);
		sse.buffer = lines.pop()!;
		if (sse.buffer.length > 65536) sse.buffer = '';
		for (const line of lines) {
			if (line === '') {
				if (sse.data.length)
					this.message(request, {
						direction: 'in',
						event: sse.event || undefined,
						id: sse.id || undefined,
						data: sse.data.join('\n'),
					});
				sse.data = [];
				sse.chars = 0;
				sse.event = '';
				sse.id = '';
				continue;
			}
			if (line.startsWith(':')) continue;
			const colon = line.indexOf(':'),
				field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) value = value.slice(1);
			if (field === 'data') {
				if (sse.chars <= messageChars) {
					sse.data.push(value);
					sse.chars += value.length + 1;
				}
			} else if (field === 'event') sse.event = value.slice(0, 200);
			else if (field === 'id') sse.id = value.slice(0, 200);
		}
	}
	private message(
		request: Request,
		message: {
			direction: 'in' | 'out';
			event?: string | undefined;
			id?: string | undefined;
			data: string;
		}
	) {
		const first = request.count === 0;
		request.count++;
		if (message.direction === 'in') request.lastData = Date.now();
		const kept: BrowserStreamMessage = {
			ms: Math.max(0, Date.now() - request.log.at),
			direction: message.direction,
			...(message.event ? { event: message.event } : {}),
			...(message.id ? { id: message.id } : {}),
			data: message.data.slice(0, messageChars),
			...(message.data.length > messageChars ? { truncated: true as const } : {}),
		};
		request.messages.push(kept);
		request.stored += kept.data.length;
		while (
			request.messages.length > streamMessages ||
			(request.stored > streamChars && request.messages.length > 1)
		)
			request.stored -= request.messages.shift()!.data.length;
		if (first) this.prune();
	}
	/** Messages are kept for the newest 20 streams; an older finished one keeps only its count. */
	private prune() {
		const holding = [...this.requests.values()].filter(
			(request) => request.messages.length > 0 || request.sse
		);
		for (const request of holding.slice(0, Math.max(0, holding.length - streamsWithMessages)))
			if (!open(request.log.request!)) {
				request.messages = [];
				request.stored = 0;
			}
	}
	private describe(log: BrowserLog) {
		const data = log.request!;
		log.text = `${data.method} · ${data.status ?? '…'} · ${data.url} · ${data.type}${data.duration !== null ? ` · ${data.duration} ms` : ''}${data.bytes !== null ? ` · ${data.bytes} B` : ''}${log.failure ? ` · ${log.failure}` : ''}`;
	}
	private streamed(request: Request) {
		const type = request.log.request!.type;
		return (
			type === 'EventSource' || type === 'WebSocket' || Boolean(request.sse) || request.count > 0
		);
	}
	/** A request as an agent reads it: the state, how long an open one has been open, bytes so far and the message count. */
	private live(request: Request, now: number): BrowserLog {
		const data = request.log.request!,
			elapsed = open(data) ? Math.max(0, now - request.log.at) : null,
			streamed = this.streamed(request);
		const parts = [data.method, String(data.status ?? '…'), data.url, data.type];
		if (data.state === 'pending') parts.push(`pending ${seconds(elapsed!)}`);
		else if (data.state === 'streaming')
			parts.push(
				`streaming ${seconds(elapsed!)}`,
				`${request.received} B received`,
				request.lastData === null
					? 'no data yet'
					: `last data ${seconds(now - request.lastData)} ago`
			);
		else {
			if (data.duration !== null) parts.push(`${data.duration} ms`);
			if (data.bytes !== null) parts.push(`${data.bytes} B`);
		}
		if (streamed) parts.push(`${request.count} message${request.count === 1 ? '' : 's'}`);
		if (request.log.failure) parts.push(request.log.failure);
		return {
			...request.log,
			text: parts.join(' · '),
			request: {
				...data,
				...(elapsed !== null ? { elapsed, received: request.received } : {}),
				...(streamed ? { messages: request.count } : {}),
			},
		};
	}
	/** What browser_network lists: the newest 100 requests within 32 KiB of text (spec/architecture-and-platform#perf-agent-responses), plus up to 20 open ones however old, oldest first. */
	list(now = Date.now()): BrowserLog[] {
		const all = [...this.requests.values()],
			rows = new Map<Request, BrowserLog>();
		let chars = 0;
		for (const request of all.filter((request) => open(request.log.request!)).slice(-openListed)) {
			const row = this.live(request, now);
			rows.set(request, row);
			chars += row.text.length;
		}
		for (let index = all.length - 1; index >= 0 && rows.size < listed; index--) {
			const request = all[index]!;
			if (rows.has(request)) continue;
			const row = this.live(request, now);
			chars += row.text.length;
			if (chars > listChars && rows.size) break;
			rows.set(request, row);
		}
		return all.filter((request) => rows.has(request)).map((request) => rows.get(request)!);
	}
	async details(
		id: string,
		read: (requestId: string) => Promise<{ body: string; base64Encoded: boolean }>
	): Promise<BrowserNetworkDetails> {
		const request = [...this.requests.values()].find((request) => request.log.id === id);
		if (!request) throw new Error('Request is no longer in the browser buffer');
		const data = this.live(request, Date.now()).request!,
			streamed = this.streamed(request);
		// Newest messages within 16 KiB, like a body; the count says how many arrived in all.
		const messages: BrowserStreamMessage[] = [];
		let chars = 0;
		for (let index = request.messages.length - 1; index >= 0; index--) {
			chars += request.messages[index]!.data.length;
			if (chars > detailChars && messages.length) break;
			messages.unshift(request.messages[index]!);
		}
		const stream = streamed ? { messages, messageCount: request.count } : {};
		if (data.type === 'EventSource' || data.type === 'WebSocket' || data.type === 'Document')
			return {
				request: data,
				headers: request.headers,
				body: null,
				truncated: false,
				error: null,
				...stream,
			};
		try {
			const result = await read(request.requestId);
			const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
			const body = bytes.subarray(0, 16384).toString('utf8');
			return {
				request: data,
				headers: request.headers,
				body,
				truncated: bytes.length > 16384,
				error: null,
				...stream,
			};
		} catch {
			return {
				request: data,
				headers: request.headers,
				body: null,
				truncated: false,
				error: 'Response body is unavailable',
				...stream,
			};
		}
	}
}
const streamType = (mime: unknown) =>
	typeof mime === 'string' && mime.split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
function safeHeaders(headers: Record<string, unknown>) {
	const result: Record<string, string> = {};
	let bytes = 0;
	for (const name of Object.keys(headers)) {
		if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name)) continue;
		const value = String(headers[name]).slice(0, 16384);
		const size = Buffer.byteLength(name + value);
		if (bytes + size > 16384) break;
		result[name.toLowerCase()] = value;
		bytes += size;
	}
	return result;
}
