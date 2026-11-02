/**
 * spec/browser-and-simulator#simulator: React Native data through Metro's CDP proxy. Metro is found by `/status` and its
 * `X-React-Native-Project-Root`; the client speaks from main with `Origin: http://127.0.0.1:<port>` (Expo's Metro
 * closes `localhost`). Console, exceptions and requests land in ring buffers from the moment the client
 * attaches; text bodies up to 64 KiB are taken right after `loadingFinished`.
 */
/** Metro takes the next free port when 8081 is busy: several task trees run 8081, 8082, 8083… */
export const metroPorts = [
	...Array.from({ length: 10 }, (_, index) => 8081 + index),
	19000,
	19001,
	19002,
];
export type MetroLog = {
	at: number;
	level: 'log' | 'info' | 'warn' | 'error' | 'debug';
	text: string;
};
export type MetroRequest = {
	id: string;
	at: number;
	method: string;
	url: string;
	status: number | null;
	duration: number | null;
	bytes: number | null;
	mimeType: string | null;
	failed: string | null;
	requestHeaders: Record<string, string>;
	responseHeaders: Record<string, string>;
	postData: string | null;
	body: string | null;
	base64: boolean;
};
type Target = { port: number; root: string; appId: string; url: string };
/** A Metro of the project seen on the last look: its root, whether this device's app is on it, whether we attached. */
export type MetroFound = { port: number; root: string; device: boolean; attached: boolean };
type Fetcher = (
	url: string,
	init?: { signal?: AbortSignal }
) => Promise<{
	ok: boolean;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}>;
type SocketLike = {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
};
export type MetroDeps = {
	fetch: Fetcher;
	socket: (url: string, origin: string) => SocketLike;
	now: () => number;
};
const defaultDeps: MetroDeps = {
	fetch: (url, init) => fetch(url, init),
	socket: (url, origin) =>
		new WebSocket(url, {
			headers: { Origin: origin },
		} as unknown as string[]) as unknown as SocketLike,
	now: () => Date.now(),
};
const logLimit = 1000,
	requestLimit = 500,
	eagerBody = 64 * 1024;
/** One project's Metro: found, attached and buffered; `stop` detaches. */
export class MetroSession {
	logs: MetroLog[] = [];
	requests = new Map<string, MetroRequest>();
	target: Target | null = null;
	private socket: SocketLike | null = null;
	private nextId = 1;
	private pending = new Map<number, (value: unknown) => void>();
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	private seenLogs = new Set<string>();
	found: MetroFound[] = [];
	private preferred: string | null = null;
	constructor(
		private roots: () => Promise<string[]>,
		private changed: () => void,
		private deps: MetroDeps = defaultDeps,
		private deviceName: () => string | null = () => null
	) {}
	/** The task tree of the agent that last asked: it wins a tie between Metros. */
	prefer(root: string) {
		this.preferred = root;
	}
	/** Looks for Metro every 3 s until one of the project's roots answers, then attaches; again after it goes away. */
	start() {
		if (this.timer || this.socket) return;
		this.stopped = false;
		void this.tick();
	}
	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.socket?.close();
		this.socket = null;
		if (this.target) {
			this.target = null;
			this.changed();
		}
	}
	private async tick() {
		this.timer = null;
		if (this.stopped || this.socket) return;
		try {
			const target = await this.discover();
			if (target && !this.stopped) {
				this.attach(target);
				return;
			}
		} catch {
			/* Metro is not up yet. */
		}
		if (!this.stopped) {
			this.timer = setTimeout(() => void this.tick(), 3000);
			this.timer.unref();
		}
	}
	/**
	 * Every Metro of the project's roots. The app on the device is connected to one of them: the Metro listing a target
	 * of this device wins; then the preferred task tree, then the order of the roots (worktrees, the project).
	 */
	async discover(): Promise<Target | null> {
		const roots = await this.roots(),
			device = this.deviceName(),
			candidates: { target: Target; device: boolean; rank: number }[] = [];
		await Promise.all(
			metroPorts.map(async (port) => {
				try {
					const status = await this.deps.fetch(`http://127.0.0.1:${port}/status`, {
						signal: AbortSignal.timeout(500),
					});
					const root = status.headers.get('x-react-native-project-root');
					if (!status.ok || !root) return;
					const index = roots.findIndex(
						(prefix) => root === prefix || root.startsWith(`${prefix}/`)
					);
					if (index < 0) return;
					const list = await (
						await this.deps.fetch(`http://127.0.0.1:${port}/json/list`, {
							signal: AbortSignal.timeout(1000),
						})
					).json();
					const targets = Array.isArray(list)
						? list.filter((item) => item && typeof item.webSocketDebuggerUrl === 'string')
						: [];
					const mine = device
							? targets.find(
									(item) =>
										item.deviceName === device ||
										(typeof item.title === 'string' && item.title.endsWith(`(${device})`))
								)
							: undefined,
						target = mine ?? targets[0];
					if (!target) return;
					const preferred =
						this.preferred && (root === this.preferred || root.startsWith(`${this.preferred}/`));
					candidates.push({
						target: {
							port,
							root,
							appId: typeof target.appId === 'string' ? target.appId : '',
							url: target.webSocketDebuggerUrl,
						},
						device: !!mine,
						rank: preferred ? -1 : index,
					});
				} catch {
					/* nothing on this port */
				}
			})
		);
		candidates.sort(
			(a, b) =>
				Number(b.device) - Number(a.device) || a.rank - b.rank || a.target.port - b.target.port
		);
		const chosen = candidates[0]?.target ?? null;
		this.found = candidates.map((item) => ({
			port: item.target.port,
			root: item.target.root,
			device: item.device,
			attached: item.target === chosen,
		}));
		return chosen;
	}
	private attach(target: Target) {
		const socket = this.deps.socket(target.url, `http://127.0.0.1:${target.port}`);
		this.socket = socket;
		socket.onopen = () => {
			this.target = target;
			this.changed();
			for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable'])
				void this.call(method);
		};
		socket.onmessage = (event) => {
			try {
				this.receive(JSON.parse(String(event.data)));
			} catch {
				/* not JSON */
			}
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			this.socket = null;
			for (const resolve of this.pending.values()) resolve(null);
			this.pending.clear();
			if (this.target) {
				this.target = null;
				this.changed();
			}
			if (!this.stopped) {
				this.timer = setTimeout(() => void this.tick(), 1000);
				this.timer.unref();
			}
		};
		socket.onerror = () => socket.close();
	}
	call(method: string, params: Record<string, unknown> = {}) {
		const socket = this.socket;
		if (!socket) return Promise.resolve(null);
		const id = this.nextId++;
		return new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve(null);
			}, 5000);
			timer.unref();
			this.pending.set(id, (value) => {
				clearTimeout(timer);
				resolve(value);
			});
			socket.send(JSON.stringify({ id, method, params }));
		});
	}
	receive(message: Record<string, unknown>) {
		if (typeof message.id === 'number') {
			this.pending.get(message.id)?.('error' in message ? null : (message.result ?? null));
			this.pending.delete(message.id);
			return;
		}
		const params = (message.params ?? {}) as Record<string, any>,
			now = this.deps.now();
		switch (message.method) {
			case 'Runtime.consoleAPICalled': {
				const level =
					(
						{ warning: 'warn', error: 'error', info: 'info', debug: 'debug' } as Record<
							string,
							MetroLog['level']
						>
					)[params.type] ?? 'log';
				const text = (Array.isArray(params.args) ? params.args : [])
					.map((arg: any) =>
						typeof arg?.value === 'string'
							? arg.value
							: arg?.value !== undefined
								? JSON.stringify(arg.value)
								: (arg?.description ?? arg?.unserializableValue ?? String(arg?.type))
					)
					.join(' ');
				// Reconnecting replays the console; one entry per timestamp and text is enough.
				const seen = `${params.timestamp}|${text}`;
				if (this.seenLogs.has(seen)) return;
				this.seenLogs.add(seen);
				if (this.seenLogs.size > logLimit * 2)
					this.seenLogs = new Set([...this.seenLogs].slice(-logLimit));
				this.push({
					at: typeof params.timestamp === 'number' ? params.timestamp : now,
					level,
					text,
				});
				return;
			}
			case 'Runtime.exceptionThrown':
				this.push({
					at: now,
					level: 'error',
					text:
						params.exceptionDetails?.exception?.description ??
						params.exceptionDetails?.text ??
						'Exception',
				});
				return;
			case 'Log.entryAdded': {
				const entry = params.entry ?? {};
				this.push({
					at: typeof entry.timestamp === 'number' ? entry.timestamp : now,
					level: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'log',
					text: String(entry.text ?? ''),
				});
				return;
			}
			case 'Network.requestWillBeSent': {
				const request = params.request ?? {},
					id = String(params.requestId);
				// Expo's interceptor (numeric ids) sees every request; RN's own domain repeats XHR under a UUID.
				if (
					params.type === 'XHR' &&
					!/^\d+$/.test(id) &&
					[...this.requests.values()].some(
						(item) =>
							/^\d+$/.test(item.id) &&
							item.method === request.method &&
							item.url === request.url &&
							Math.abs(item.at - now) < 2000
					)
				)
					return;
				if (/^\d+$/.test(id))
					for (const [key, item] of this.requests)
						if (
							!/^\d+$/.test(key) &&
							item.method === request.method &&
							item.url === request.url &&
							Math.abs(item.at - now) < 2000
						)
							this.requests.delete(key);
				this.requests.set(id, {
					id,
					at: now,
					method: String(request.method ?? 'GET'),
					url: String(request.url ?? ''),
					status: null,
					duration: null,
					bytes: null,
					mimeType: null,
					failed: null,
					requestHeaders: request.headers ?? {},
					responseHeaders: {},
					postData: typeof request.postData === 'string' ? request.postData : null,
					body: null,
					base64: false,
				});
				while (this.requests.size > requestLimit)
					this.requests.delete(this.requests.keys().next().value!);
				this.changed();
				return;
			}
			case 'Network.responseReceived': {
				const item = this.requests.get(String(params.requestId));
				if (!item) return;
				item.status = Number(params.response?.status) || null;
				item.mimeType = params.response?.mimeType ?? null;
				item.responseHeaders = params.response?.headers ?? {};
				return;
			}
			case 'Network.loadingFinished': {
				const item = this.requests.get(String(params.requestId));
				if (!item) return;
				item.duration = now - item.at;
				item.bytes = typeof params.encodedDataLength === 'number' ? params.encodedDataLength : null;
				if (textual(item.mimeType) && (item.bytes ?? 0) <= eagerBody) void this.body(item.id);
				return;
			}
			case 'Network.loadingFailed': {
				const item = this.requests.get(String(params.requestId));
				if (item) {
					item.failed = String(params.errorText ?? 'failed');
					item.duration = now - item.at;
				}
				return;
			}
		}
	}
	/** The body from Metro, cached on the record; Metro keeps the last 512 and cannot hand over very large ones. */
	async body(id: string) {
		const item = this.requests.get(id);
		if (!item) return null;
		if (item.body !== null) return item;
		const result = (await this.call('Network.getResponseBody', { requestId: id })) as {
			body?: unknown;
			base64Encoded?: unknown;
		} | null;
		if (result && typeof result.body === 'string') {
			item.body = result.body;
			item.base64 = result.base64Encoded === true;
		}
		return item;
	}
	private push(log: MetroLog) {
		this.logs.push(log);
		if (this.logs.length > logLimit) this.logs.splice(0, this.logs.length - logLimit);
	}
}
const textual = (mime: string | null) =>
	!!mime &&
	/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+json)/.test(mime);
/** Metro's own traffic (bundles, assets, symbolication) is the dev server talking to itself, not the app. */
export function appRequests(session: MetroSession) {
	const origin = session.target
		? [`http://127.0.0.1:${session.target.port}`, `http://localhost:${session.target.port}`]
		: [];
	return [...session.requests.values()].filter(
		(item) => !origin.some((prefix) => item.url.startsWith(prefix))
	);
}
/** `simulator_network` without an id: one request a line, newest last, 100 lines and 32 KiB (spec/architecture-and-platform#perf-agent-responses). */
export function formatRequests(items: MetroRequest[], now: number, filter?: string) {
	const chosen = (filter ? items.filter((item) => item.url.includes(filter)) : items).slice(-100),
		lines: string[] = [];
	let size = 0;
	for (const item of chosen.reverse()) {
		const status = item.failed
			? `failed (${item.failed})`
			: (item.status ?? (now - item.at > 30_000 ? 'no response' : 'pending'));
		const line = `${item.id} ${item.method} ${status} ${item.duration === null ? '…' : `${item.duration} ms`} ${item.bytes === null ? '' : `${item.bytes} B `}${item.url}`;
		if (size + line.length + 1 > 32 * 1024) break;
		lines.unshift(line);
		size += line.length + 1;
	}
	return lines.length ? lines.join('\n') : 'No requests yet.';
}
/** One request: headers and the body, text up to 16 KiB; binary bodies are named by type and size. */
export function formatRequest(item: MetroRequest) {
	const head = [
		`${item.method} ${item.url}`,
		`Status: ${item.failed ? `failed (${item.failed})` : (item.status ?? 'pending')}${item.duration === null ? '' : ` · ${item.duration} ms`}${item.bytes === null ? '' : ` · ${item.bytes} B`}`,
	];
	const headers = (title: string, value: Record<string, string>) =>
		Object.keys(value).length
			? [`${title}:`, ...Object.entries(value).map(([name, text]) => `  ${name}: ${text}`)]
			: [];
	const body =
		item.body === null
			? 'Body: unavailable (Metro keeps the last 512 bodies and cannot hand over very large ones).'
			: item.base64 || !textual(item.mimeType)
				? `Body: ${item.mimeType ?? 'binary'}, ${item.bytes ?? '?'} B.`
				: item.body.length > 16 * 1024
					? `Body (first 16 KiB of ${item.body.length} characters):\n${item.body.slice(0, 16 * 1024)}`
					: `Body:\n${item.body}`;
	return [
		...head,
		...headers('Request headers', item.requestHeaders),
		...(item.postData ? [`Request body:\n${item.postData.slice(0, 16 * 1024)}`] : []),
		...headers('Response headers', item.responseHeaders),
		body,
	].join('\n');
}
/** `simulator_logs`: newest last, 100 lines and 32 KiB; errors carry their stack in the text. */
export function formatLogs(logs: MetroLog[], level?: MetroLog['level'], grep?: string) {
	const order = ['debug', 'log', 'info', 'warn', 'error'],
		minimum = level ? order.indexOf(level) : 0;
	const chosen = logs
			.filter(
				(log) =>
					order.indexOf(log.level) >= minimum &&
					(!grep || log.text.toLocaleLowerCase().includes(grep.toLocaleLowerCase()))
			)
			.slice(-100),
		lines: string[] = [];
	let size = 0;
	for (const log of chosen.reverse()) {
		const line = `${new Date(log.at).toISOString().slice(11, 23)} ${log.level} ${log.text}`;
		if (size + line.length + 1 > 32 * 1024) break;
		lines.unshift(line);
		size += line.length + 1;
	}
	return lines.length ? lines.join('\n') : 'No log entries yet.';
}
