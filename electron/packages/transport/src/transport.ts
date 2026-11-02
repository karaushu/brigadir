import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
	type ClientConnection,
} from '@agentclientprotocol/sdk';
import type {
	PromptRequest,
	PromptResponse,
	NewSessionRequest,
	NewSessionResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
	ForkSessionRequest,
	ForkSessionResponse,
	ResumeSessionRequest,
	ResumeSessionResponse,
	DeleteSessionRequest,
	DeleteSessionResponse,
} from '@agentclientprotocol/sdk';
import {
	backgroundPathOf,
	isBackgroundId,
	isRecord,
	promptSequence,
	type PromptResource,
	type AttachmentInput,
	type AgentCommand,
	type AgentEvent,
	type AgentProvider,
	type PermissionRequest,
} from '@brigadir/core';
/** spec/composer#mentions: an attachment input with the id its token carries in the prompt text; inputs the host adds (brief, context) have none. */
export type PromptInput = AttachmentInput & { id?: string };
import { adapterCommand, type AdapterCommand } from './adapter';
import {
	mapOptions,
	mapRateLimitInfo,
	mapPermission,
	mapSession,
	mapSubagentUpdate,
	mapUpdate,
	subagentResult,
} from './mapper';
import { authAccess, claudeRateLimitReadings } from './quota';
import { stopBackgroundProcesses } from './background-stop';
import type { QuotaAccess } from '@brigadir/core';
export type McpCommand = {
	name: string;
	command: string;
	args: string[];
	env: { name: string; value: string }[];
};
export type TransportOptions = {
	signal?: AbortSignal;
	provider: AgentProvider;
	cwd: string;
	adapter?: AdapterCommand;
	startupTimeoutMs?: number;
	resumeSessionId?: string;
	/** spec/composer-steering-queue-and-ghost#quick-question: start as a fork of this session when the adapter advertises `session/fork`; otherwise a new session. */
	forkSessionId?: string;
	mcpServers?: McpCommand[];
	additionalDirectories?: string[];
	onEvent(event: AgentEvent): void | Promise<void>;
	requestPermission?(request: PermissionRequest, signal: AbortSignal): Promise<string | null>;
	/** spec/agents-and-providers#tool-permissions: the option to choose with no card and no event, or null to ask the person as usual. */
	preapprove?(request: PermissionRequest): string | null;
	onDiagnostic?(text: string): void;
	/** Raw Claude SDK messages the adapter should forward (`emitRawSDKMessages`). Claude sessions always ask for
	 *  `rate_limit_event`: the adapter's own `usage_update` drops one that arrives before a turn's first answer (spec/agents-and-providers#quota-sources). */
	sdkMessages?: { types: string[]; onMessage?(message: Record<string, unknown>): void };
	/** spec/chat-turns-plans-and-questions#agent-started-turns: the agent began a turn of its own — Claude Code after a background task (`session_state_changed: running`), or
	 *  `threadStatus: active` — with no prompt of ours running. Runs on the event chain before any update of that turn and resolves
	 *  true once the host journaled its `turn.started`; false — a prompt of the host is starting and takes the turn over. `finished`
	 *  settles after the turn's `turn.completed` is on the event chain. Without this hook such a turn is not tracked. */
	agentTurn?(finished: Promise<void>): Promise<boolean>;
	/** Login kind and plan from `_auth/status_update`; the email never leaves the transport. */
	onAuthStatus?(status: { access: QuotaAccess; plan: string | null }): void;
	readTextFile?(path: string, line?: number | null, limit?: number | null): Promise<string>;
	writeTextFile?(path: string, content: string): Promise<void>;
};
/** A connection owns precisely one adapter and one session. The host owns persistence and task identity. */
/** spec/agents-and-providers#sign-in-recovery: the adapter answered ACP `authRequired` — the agent's sign-in failed, not the task. Never guessed from the message. */
export function isAuthRequired(error: unknown): boolean {
	return error instanceof RequestError && error.code === RequestError.authRequired().code;
}
/**
 * spec/chat#tool-states: claude-agent-acp fails a turn whose tool call a steer cut off while Claude was still writing it — the call never
 * ran, yet the adapter counts it as unfinished (`errorKind: "incomplete_tool_call"`). Returns the calls it names, or null.
 */
export function steerOrphans(error: unknown): string[] | null {
	if (
		!(error instanceof RequestError) ||
		!isRecord(error.data) ||
		error.data.errorKind !== 'incomplete_tool_call'
	)
		return null;
	const ids = (/tool calls: (.+)$/.exec(error.message)?.[1] ?? '')
		.split(/,\s*/)
		.filter((id) => /^[\w-]{1,200}$/.test(id));
	return ids.length ? ids : null;
}
/** spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent began on its own. `taken` — a prompt of the host took it over before it was journaled. */
type AgentTurn = {
	begun: boolean;
	taken: boolean;
	closed: boolean;
	prompts: number;
	reason: string | null;
	close(): void;
};
export class AgentTransport {
	private connection: ClientConnection;
	private child: ChildProcessWithoutNullStreams;
	private eventTail: Promise<void> = Promise.resolve();
	/** spec/chat#tool-states: the turn a steer was injected into. */
	private steeredTurn = 0;
	private permissionControllers = new Set<AbortController>();
	private sessionId: string | null = null;
	private busy = false;
	/** Generation of the turn `busy` belongs to, and the end of the last `send` (its `turn.completed` already on the event chain). */
	private turn = 0;
	private sendDone: Promise<void> = Promise.resolve();
	private cancelling = false;
	private stopping = false;
	private readonly abort = () => this.close();
	private modeIds = new Set<string>();
	private options = new Map<string, import('@brigadir/core').AgentOption>();
	private canLoad = false;
	private canImage = false;
	/** spec/agents-and-providers#one-shot: `sessionCapabilities.delete` of `initialize`; the memoised removal of this session. */
	private canDelete = false;
	private deleting: Promise<void> | null = null;
	/** spec/composer-steering-queue-and-ghost#steering: `_meta.steering.supported` of `initialize`. */
	private canSteer = false;
	/** `_meta.codex.threadStatus` of `session_info_update`: whether the adapter reports it, and the steer waiting for an adopted turn to go idle. */
	private threadStatusSeen = false;
	/** Read in wire order from the adapter's stdout, always, ahead of the SDK. Statuses count only once every prompt we sent is
	 *  answered on the wire: codex-acp answers after the old turn's last notification, so any later active → not-active pair is the
	 *  new turn's, even one that ends before the steer's own answer (observed live). `endAt` is the wire number of the status
	 *  that ends the adopted turn; the turn closes when the SDK reaches that very status, never earlier in the same chunk. */
	private steerWatch: {
		phase: 'pending' | 'adopted';
		active: boolean;
		endAt: number | null;
		done: (() => void) | null;
	} | null = null;
	private wireTail = '';
	private promptsSent = 0;
	private wireAnswers = 0;
	private wireStatuses = 0;
	private sdkStatuses = 0;
	private lastUpdateAt = 0;
	private readonly decoder = new StringDecoder('utf8');
	/** spec/chat-turns-plans-and-questions#agent-started-turns: whether the agent works right now, as it last said (`session_state_changed` of Claude, `threadStatus` of Codex),
	 *  and the turn it began on its own. `begun` — the host journaled it; `prompts` — prompts of ours added to it and not yet
	 *  answered; `reason` — the stop reason of the last of them. Only after `initialize`: a replayed history opens nothing. */
	private agentWorking: boolean | null = null;
	private opened = false;
	private agentTurn: AgentTurn | null = null;
	/** spec/chat-turns-plans-and-questions#agent-started-turns: the number of the turn whose `turn.completed` is already on the event chain while it may still hold `busy` —
	 *  the host journals it, slowly under load. The agent working again after that is a turn of its own (idle → running 50 ms
	 *  apart), opened at once: its `turn.started` queues after that `turn.completed`, its updates after both. */
	private ended = 0;
	/** spec/chat#subagents: what the SDK reads — the adapter's stdout line by line, with the subagent updates its schema does not know yet
	 *  renamed to our `_brigadir/subagent`, so they keep their place among the other updates. */
	private readonly sdkInput = new PassThrough();
	/** spec/chat#subagents: the subagent sessions the adapter announced (`subagent_spawned`), and the tool calls that run them. */
	private subagents = new Map<string, { toolId: string | null }>();
	private subagentTools = new Map<string, string>();
	/** spec/chat-turns-plans-and-questions#background-commands: Claude's background tasks from the raw SDK `task_*` messages: announced once backgrounded, ended once. */
	private background = new Map<
		string,
		{
			toolId: string | null;
			name: string;
			announced: boolean;
			ended: boolean;
			outputPath: string | null;
		}
	>();
	/** Tool result texts that may name a background output file, by tool call, for a task announced after its result. */
	private backgroundTexts = new Map<string, string>();
	get steering(): boolean {
		return this.canSteer;
	}
	/** A prompt of this connection runs, its own or an adopted one, or a turn the agent began on its own (spec/chat-turns-plans-and-questions#agent-started-turns). */
	get running(): boolean {
		return this.busy;
	}
	validateAttachments(inputs: AttachmentInput[]) {
		if (inputs.some((input) => input.kind === 'image') && !this.canImage)
			throw new Error('This agent does not support image prompts');
	}
	private agentInfo: { name: string; version: string } | null = null;
	private lastRateLimit = '';
	get info(): { name: string; version: string } | null {
		return this.agentInfo ? { ...this.agentInfo } : null;
	}
	private forkedFrom = false;
	/** spec/composer-steering-queue-and-ghost#quick-question: the session is a fork of `forkSessionId`. */
	get forked(): boolean {
		return this.forkedFrom;
	}
	get id(): string {
		if (!this.sessionId) throw new Error('Session is not ready');
		return this.sessionId;
	}
	get closed(): Promise<void> {
		return this.connection.closed;
	}
	private emit(event: AgentEvent): Promise<void> {
		if (event.kind === 'options.changed' || event.kind === 'session.started')
			this.options = new Map(event.options.map((option) => [option.id, option]));
		if (event.kind === 'session.started')
			this.modeIds = new Set(event.modes.map((mode) => mode.id));
		this.eventTail = this.eventTail.then(() => this.config.onEvent(event));
		return this.eventTail;
	}
	/** One payload can arrive twice (adapter `usage_update` and the raw SDK event); identical repeats are dropped. */
	private async rateLimit(info: unknown): Promise<void> {
		const limit = mapRateLimitInfo(info);
		if (!limit) return;
		const key = JSON.stringify(info);
		if (key === this.lastRateLimit) return;
		this.lastRateLimit = key;
		await this.emit(limit);
		const windows = this.config.provider === 'claude' ? claudeRateLimitReadings(info) : [];
		if (windows.length)
			await this.emit({
				kind: 'quota.observed',
				provider: this.config.provider,
				windows,
				complete: false,
			});
	}
	private constructor(private config: TransportOptions) {
		const launch = config.adapter ?? adapterCommand(config.provider);
		const env = { ...process.env };
		// spec/chat-turns-plans-and-questions#checklist-tools: an SDK session of Claude has no task tool, so the adapter never sends `plan`; a value the person set stays.
		if (config.provider === 'claude' && env.CLAUDE_CODE_ENABLE_TODO_TOOLS === undefined)
			env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
		// A plan or a question of ours waits for the person; Claude aborts a tool call silent for 30 minutes (Codex: tool_timeout_sec below).
		if (
			config.provider === 'claude' &&
			config.mcpServers?.some((server) => server.name === 'brigadir') &&
			env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT === undefined
		)
			env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(604800 * 1000);
		if (config.provider === 'codex') {
			const overrides: unknown = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {};
			if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
				throw new Error('CODEX_CONFIG must be an object');
			const record = (value: unknown): Record<string, unknown> =>
				value && typeof value === 'object' && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: {};
			const next: Record<string, unknown> = { ...overrides };
			// spec/chat-turns-plans-and-questions#checklist-tools: Codex has no `update_plan` tool unless the config turns it on, so it wrote the checklist as text; a value the person set stays.
			const tools = record(next.tools);
			if (tools.update_plan === undefined)
				next.tools = { ...tools, update_plan: { enabled: true } };
			if (config.mcpServers?.some((server) => server.name === 'brigadir'))
				next.mcp_servers = {
					...record(next.mcp_servers),
					...Object.fromEntries(
						config.mcpServers.map((server) => [
							server.name,
							{
								command: server.command,
								args: server.args,
								env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
								...(server.name === 'brigadir' ? { tool_timeout_sec: 604800 } : {}),
							},
						])
					),
				};
			env.CODEX_CONFIG = JSON.stringify(next);
		}
		this.child = spawn(launch.command, launch.args, {
			env,
			cwd: config.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
			shell: false,
		});
		this.child.stderr.on('data', (chunk: Buffer) => config.onDiagnostic?.(chunk.toString('utf8')));
		this.child.stdout.on('data', (chunk: Buffer) => this.wire(chunk));
		this.child.stdout.once('end', () => {
			const rest = this.wireTail + this.decoder.end();
			this.wireTail = '';
			if (rest) this.sdkInput.write(rest);
			this.sdkInput.end();
		});
		// spec/chat#subagents: the SDK schema drops a client capability it does not know, so `subagents` is added to the `initialize` line here.
		let outTail = '';
		const sdkOutput = new Writable({
			write: (chunk: Buffer, _encoding, done) => {
				outTail += chunk.toString('utf8');
				let index: number,
					text = '';
				while ((index = outTail.indexOf('\n')) >= 0) {
					text += AgentTransport.adapterLine(outTail.slice(0, index)) + '\n';
					outTail = outTail.slice(index + 1);
				}
				if (!text) {
					done();
					return;
				}
				this.child.stdin.write(text, (error) => done(error ?? null));
			},
			final: (done) => {
				if (outTail) this.child.stdin.write(outTail);
				this.child.stdin.end();
				done();
			},
		});
		const stream = ndJsonStream(
			Writable.toWeb(sdkOutput),
			Readable.toWeb(this.sdkInput) as unknown as ReadableStream<Uint8Array>
		);
		this.connection = client({ name: 'brigadir' })
			.onNotification(methods.client.session.update, async ({ params }) => {
				// spec/chat#subagents: a subagent's own session: its text and calls, marked with the subagent; the rest of it stays with the adapter.
				if (this.sessionId && params.sessionId !== this.sessionId) {
					const child = this.subagents.get(params.sessionId);
					if (!child) return;
					const event = mapUpdate(params.update);
					if (event.kind === 'tool.changed') {
						if (!child.toolId && event.patch.parentId) {
							child.toolId = event.patch.parentId;
							this.subagentTools.set(event.patch.parentId, params.sessionId);
						}
						await this.emit({ ...event, subagentId: params.sessionId });
					}
					if (event.kind === 'message.delta' && event.role !== 'user')
						await this.emit({ ...event, subagentId: params.sessionId });
					return;
				}
				// session/new may stream notifications before its response, so accept the pending session.
				this.lastUpdateAt = Date.now();
				const status =
					params.update.sessionUpdate === 'session_info_update'
						? this.threadStatus(params.update._meta)
						: undefined;
				if (params.update.sessionUpdate === 'usage_update') {
					const meta = params.update._meta;
					await this.rateLimit(
						meta && typeof meta === 'object'
							? (meta as Record<string, unknown>)['_claude/rateLimit']
							: null
					);
				}
				// spec/chat#subagents: the tool call that ran a subagent is the subagent block itself: its result gives model, tokens and run time.
				const result = subagentResult(params.update),
					owner =
						result && this.subagents.has(result.agentId)
							? result.agentId
							: 'toolCallId' in params.update
								? this.subagentTools.get(params.update.toolCallId)
								: undefined;
				if (owner) {
					const child = this.subagents.get(owner)!;
					if (!child.toolId && 'toolCallId' in params.update) {
						child.toolId = params.update.toolCallId;
						this.subagentTools.set(child.toolId, owner);
					}
					if (result)
						await this.emit({
							kind: 'subagent.changed',
							id: owner,
							toolId: result.toolId,
							...(result.type ? { type: result.type } : {}),
							...(result.model ? { model: result.model } : {}),
							...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
							...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
						});
					return;
				}
				// spec/chat-turns-plans-and-questions#agent-started-turns: the status record goes first, then the turn it ends or begins.
				const mapped = mapUpdate(params.update);
				const emitted = this.emit(mapped);
				if (status !== undefined) this.agentState(status === 'active');
				await emitted;
				if (mapped.kind === 'tool.changed')
					await this.backgroundOutput(mapped.patch.id, JSON.stringify(mapped.patch));
			})
			.onNotification<Record<string, unknown>>(
				'_brigadir/subagent',
				(params) =>
					params && typeof params === 'object' ? (params as Record<string, unknown>) : {},
				async ({ params }) => {
					if (
						typeof params.sessionId !== 'string' ||
						!this.sessionId ||
						(params.sessionId !== this.sessionId && !this.subagents.has(params.sessionId))
					)
						return;
					const event = mapSubagentUpdate(params.update, params.sessionId, this.sessionId);
					if (!event) return;
					if (event.kind === 'subagent.started') {
						if (this.subagents.has(event.id)) return;
						this.subagents.set(event.id, { toolId: null });
					} else if (!this.subagents.has(event.id)) return;
					await this.emit(event);
				}
			)
			.onNotification<Record<string, unknown>>(
				'_claude/sdkMessage',
				(params) =>
					params && typeof params === 'object' ? (params as Record<string, unknown>) : {},
				async ({ params }) => {
					if (this.sessionId && params.sessionId !== this.sessionId) return;
					const message = params.message;
					if (!message || typeof message !== 'object' || Array.isArray(message)) return;
					const raw = message as Record<string, unknown>;
					if (
						raw.type === 'system' &&
						raw.subtype === 'session_state_changed' &&
						typeof raw.state === 'string'
					)
						this.agentState(raw.state !== 'idle');
					if (raw.type === 'rate_limit_event') await this.rateLimit(raw.rate_limit_info);
					if (
						raw.type === 'system' &&
						(raw.subtype === 'task_started' ||
							raw.subtype === 'task_updated' ||
							raw.subtype === 'task_notification')
					)
						await this.backgroundTask(raw);
					config.sdkMessages?.onMessage?.(raw);
				}
			)
			.onNotification<unknown>(
				'_auth/status_update',
				(params) => params,
				({ params }) => {
					config.onAuthStatus?.(authAccess(params));
				}
			)
			.onRequest(methods.client.fs.readTextFile, async ({ params }) => {
				if (!config.readTextFile || this.stopping || !this.ownSession(params.sessionId))
					throw RequestError.invalidParams('Filesystem read is unavailable for this session');
				try {
					return { content: await config.readTextFile(params.path, params.line, params.limit) };
				} catch (error) {
					throw RequestError.invalidParams(
						undefined,
						error instanceof Error ? error.message : 'Filesystem read failed'
					);
				}
			})
			.onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
				if (
					!config.writeTextFile ||
					this.stopping ||
					this.cancelling ||
					!this.ownSession(params.sessionId)
				)
					throw RequestError.invalidParams('Filesystem write is unavailable for this session');
				try {
					await config.writeTextFile(params.path, params.content);
					return {};
				} catch (error) {
					throw RequestError.invalidParams(
						undefined,
						error instanceof Error ? error.message : 'Filesystem write failed'
					);
				}
			})
			.onRequest(
				methods.client.session.requestPermission,
				async ({ params, requestId, signal }) => {
					if (!this.ownSession(params.sessionId))
						throw RequestError.invalidParams('Unknown session');
					if (this.cancelling || this.stopping) return { outcome: { outcome: 'cancelled' } };
					const controller = new AbortController();
					this.permissionControllers.add(controller);
					const linked = AbortSignal.any([signal, this.connection.signal, controller.signal]);
					const request = mapPermission(String(requestId), params);
					const preset = config.preapprove?.(request) ?? null;
					if (preset !== null && request.options.some((option) => option.id === preset))
						return { outcome: { outcome: 'selected', optionId: preset } };
					try {
						await this.emit({ kind: 'permission.requested', request });
						if (!config.requestPermission || linked.aborted || this.stopping)
							return { outcome: { outcome: 'cancelled' } };
						const choice = await interruptible(config.requestPermission(request, linked), linked);
						if (choice === null || linked.aborted) return { outcome: { outcome: 'cancelled' } };
						if (!request.options.some((option) => option.id === choice))
							throw RequestError.invalidParams('Unknown permission option');
						return { outcome: { outcome: 'selected', optionId: choice } };
					} finally {
						this.permissionControllers.delete(controller);
					}
				}
			)
			.connect(stream);
		this.child.once('error', (error) => this.connection.close(error));
		this.child.stdin.on('error', (error) => this.connection.close(error));
		this.child.once('exit', (code, signal) =>
			this.connection.close(new Error(`Agent exited (${signal ?? code})`))
		);
		this.connection.signal.addEventListener('abort', () => this.close(), { once: true });
		config.signal?.addEventListener('abort', this.abort, { once: true });
	}
	static async start(config: TransportOptions): Promise<AgentTransport> {
		config.signal?.throwIfAborted();
		if (!isAbsolute(config.cwd)) throw new Error('Agent cwd must be absolute');
		if (config.additionalDirectories?.some((path) => !isAbsolute(path) || path.includes('\0')))
			throw new Error('Additional directories must be absolute');
		const transport = new AgentTransport(config);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				transport.initialize().then(() => {
					transport.opened = true;
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('Agent startup timed out')),
						config.startupTimeoutMs ?? 60_000
					);
				}),
			]);
			return transport;
		} catch (error) {
			transport.close();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	private async initialize(): Promise<void> {
		const result = await this.connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			// spec/chat#subagents: `subagents` joins these on the wire (`adapterLine`): a subagent runs in its own session the adapter announces.
			clientCapabilities: {
				fs: {
					readTextFile: Boolean(this.config.readTextFile),
					writeTextFile: Boolean(this.config.writeTextFile),
				},
				terminal: false,
				plan: {},
			},
			clientInfo: { name: 'brigadir', version: '0.0.0' },
		});
		this.canLoad = result.agentCapabilities?.loadSession === true;
		this.canImage = result.agentCapabilities?.promptCapabilities?.image === true;
		this.canDelete = result.agentCapabilities?.sessionCapabilities?.delete != null;
		const steering = isRecord(result._meta) ? result._meta.steering : undefined;
		this.canSteer = isRecord(steering) && steering.supported === true;
		this.agentInfo = result.agentInfo
			? { name: result.agentInfo.name, version: result.agentInfo.version }
			: null;
		if (result.protocolVersion !== PROTOCOL_VERSION)
			throw new Error(`Unsupported ACP protocol version: ${result.protocolVersion}`);
		const directories =
			result.agentCapabilities?.sessionCapabilities?.additionalDirectories != null &&
			this.config.additionalDirectories
				? { additionalDirectories: [...new Set(this.config.additionalDirectories)] }
				: {};
		const raw =
			this.config.provider === 'claude'
				? [...new Set(['rate_limit_event', ...(this.config.sdkMessages?.types ?? [])])]
				: [];
		// spec/chat-turns-plans-and-questions#agent-started-turns: `session_state_changed` says when Claude Code works, also in a turn it began on its own.
		// spec/chat-turns-plans-and-questions#background-commands: `task_*` tell the background commands, without the AIR capability that would change the adapter's other updates.
		const meta = raw.length
			? {
					_meta: {
						claudeCode: {
							emitRawSDKMessages: [
								...raw.map((type) => ({ type })),
								...[
									'session_state_changed',
									'task_started',
									'task_updated',
									'task_notification',
								].map((subtype) => ({ type: 'system', subtype })),
							],
						},
					},
				}
			: {};
		const params = {
			cwd: this.config.cwd,
			...directories,
			...meta,
			mcpServers:
				this.config.provider === 'codex' &&
				this.config.mcpServers?.some((server) => server.name === 'brigadir')
					? []
					: (this.config.mcpServers ?? []),
		};
		// spec/composer-steering-queue-and-ghost#quick-question: claude-agent-acp answers a fork with the new id only (the session opens with `session/resume`, or `session/load`
		// that replays history); codex-acp returns the opened session. A failed fork falls back to a new session.
		const capabilities = result.agentCapabilities?.sessionCapabilities;
		if (this.config.forkSessionId && capabilities?.fork != null && !this.config.resumeSessionId) {
			try {
				const forked = await this.connection.agent.request<ForkSessionResponse, ForkSessionRequest>(
					methods.agent.session.fork,
					{ ...params, sessionId: this.config.forkSessionId }
				);
				let opened: {
					modes?: NewSessionResponse['modes'] | undefined;
					configOptions?: NewSessionResponse['configOptions'] | undefined;
				} = forked;
				if (forked.configOptions === undefined && forked.modes === undefined) {
					if (capabilities?.resume != null)
						opened = await this.connection.agent.request<
							ResumeSessionResponse,
							ResumeSessionRequest
						>(methods.agent.session.resume, { ...params, sessionId: forked.sessionId });
					else if (this.canLoad) {
						this.sessionId = forked.sessionId;
						opened = await this.connection.agent.request<LoadSessionResponse, LoadSessionRequest>(
							methods.agent.session.load,
							{ ...params, sessionId: forked.sessionId }
						);
					} else throw new Error('The forked session cannot be opened');
				}
				this.sessionId = forked.sessionId;
				this.forkedFrom = true;
				await this.emit(
					this.withSteering(
						mapSession({
							sessionId: forked.sessionId,
							...(opened.modes !== undefined ? { modes: opened.modes } : {}),
							...(opened.configOptions !== undefined
								? { configOptions: opened.configOptions }
								: {}),
						})
					)
				);
				return;
			} catch (error) {
				this.config.onDiagnostic?.(
					`Fork failed: ${error instanceof Error ? error.message : String(error)}`
				);
				this.sessionId = null;
			}
		}
		if (this.config.resumeSessionId) {
			if (!this.canLoad) throw new Error('This agent cannot load a previous session');
			this.sessionId = this.config.resumeSessionId;
			const session = await this.connection.agent.request<LoadSessionResponse, LoadSessionRequest>(
				methods.agent.session.load,
				{ ...params, sessionId: this.sessionId }
			);
			await this.emit(this.withSteering(mapSession({ ...session, sessionId: this.sessionId })));
		} else {
			const session = await this.connection.agent.request<NewSessionResponse, NewSessionRequest>(
				methods.agent.session.new,
				params
			);
			this.sessionId = session.sessionId;
			await this.emit(this.withSteering(mapSession(session)));
		}
	}
	/** spec/chat-turns-plans-and-questions#background-commands: a raw SDK `task_started` / `task_updated` / `task_notification`. Subagents (spec/chat#subagents) and Monitor are not
	 *  background commands; a task shows once it is backgrounded (at start, or later by `task_updated`) and ends once. */
	private async backgroundTask(raw: Record<string, unknown>): Promise<void> {
		const id = raw.task_id;
		if (!isBackgroundId(id)) return;
		if (raw.subtype === 'task_started') {
			if (
				raw.subagent_type !== undefined ||
				raw.task_type === 'local_agent' ||
				raw.task_type === 'local_monitor' ||
				raw.task_type === 'remote_agent' ||
				this.background.has(id)
			)
				return;
			const toolId =
				typeof raw.tool_use_id === 'string' && raw.tool_use_id ? raw.tool_use_id : null;
			const name =
				typeof raw.description === 'string' && raw.description.trim()
					? raw.description.trim().slice(0, 4096)
					: typeof raw.task_type === 'string'
						? raw.task_type
						: 'Background task';
			this.background.set(id, { toolId, name, announced: false, ended: false, outputPath: null });
			if (raw.is_backgrounded === true) await this.announceBackground(id);
			return;
		}
		const task = this.background.get(id);
		if (!task) return;
		const patch = isRecord(raw.patch) ? raw.patch : null;
		if (patch?.is_backgrounded === true) await this.announceBackground(id);
		const status = raw.subtype === 'task_notification' ? raw.status : patch?.status;
		if (
			raw.subtype === 'task_notification' &&
			backgroundPathOf(raw.output_file, id) &&
			task.outputPath !== raw.output_file &&
			task.announced &&
			!task.ended
		) {
			task.outputPath = raw.output_file as string;
			await this.emit({ kind: 'background.changed', id, outputPath: task.outputPath });
		}
		const state =
			status === 'completed'
				? 'completed'
				: status === 'failed'
					? 'failed'
					: status === 'stopped' || status === 'killed'
						? 'stopped'
						: null;
		if (!state || task.ended) return;
		task.ended = true;
		if (task.announced)
			await this.emit({
				kind: 'background.changed',
				id,
				state,
				...(state === 'stopped' ? { reason: 'person' as const } : {}),
			});
	}
	private async announceBackground(id: string): Promise<void> {
		const task = this.background.get(id);
		if (!task || task.announced || task.ended) return;
		task.announced = true;
		await this.emit({ kind: 'background.started', id, toolId: task.toolId, name: task.name });
		const text = task.toolId ? this.backgroundTexts.get(task.toolId) : undefined;
		if (task.toolId && text) await this.backgroundOutput(task.toolId, text);
	}
	/** The output file of a background command, from the result of the call that started it (`…/tasks/<id>.output`). */
	private async backgroundOutput(toolId: string, text: string): Promise<void> {
		if (!text.includes('.output')) return;
		for (const [id, task] of this.background) {
			if (task.toolId !== toolId || task.outputPath || !task.announced) continue;
			const path = new RegExp(`(/[^\\s"'\`<>]*?/tasks/${id}\\.output)`).exec(text)?.[1];
			if (path && backgroundPathOf(path, id)) {
				task.outputPath = path;
				await this.emit({ kind: 'background.changed', id, outputPath: path });
			}
			return;
		}
		if (this.config.provider === 'claude' && /Command running in background/.test(text)) {
			this.backgroundTexts.delete(toolId);
			this.backgroundTexts.set(toolId, text);
			while (this.backgroundTexts.size > 64)
				this.backgroundTexts.delete(this.backgroundTexts.keys().next().value!);
		}
	}
	/** spec/chat-turns-plans-and-questions#background-commands: «Зупинити». The processes that write the command's output file, under this adapter, get SIGTERM; the end is
	 *  journaled as stopped by the person at once, and the agent's own report of the killed command is not a second end. */
	async stopBackground(id: string): Promise<void> {
		const task = this.background.get(id);
		if (!task?.announced || task.ended) throw new Error('The background command is not running');
		if (!task.outputPath || this.child.pid === undefined)
			throw new Error('The background command cannot be stopped');
		// Ended first: the SDK's report of the killed shell («failed») may come before the kill returns.
		task.ended = true;
		const stopped = await stopBackgroundProcesses(task.outputPath, this.child.pid).catch(() => 0);
		if (!stopped) {
			task.ended = false;
			throw new Error('The background command cannot be stopped');
		}
		await this.emit({ kind: 'background.changed', id, state: 'stopped', reason: 'person' });
	}
	async send(
		command: AgentCommand,
		attachments: PromptInput[] = [],
		resources: PromptResource[] = []
	): Promise<void> {
		if (this.stopping) throw new Error('Agent connection is closed');
		const sessionId = this.id;
		if (command.kind === 'cancel') {
			this.cancelling = true;
			for (const controller of this.permissionControllers) controller.abort();
			await this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
			// spec/composer-steering-queue-and-ghost#steering-hold: an adopted turn whose end status never comes closes itself 20 s after Stop — codex may take a while to
			// kill a stubborn process, and a FIFO prompt must not go out while its own prompt still runs.
			const watch = this.steerWatch;
			if (watch?.phase === 'adopted')
				setTimeout(
					() => watch.done?.(),
					Number(process.env.BRIGADIR_STEER_STOP_MS) || 20_000
				).unref?.();
			// spec/chat-turns-plans-and-questions#agent-started-turns: the same for a turn the agent began on its own.
			const own = this.agentTurn;
			if (own?.begun)
				setTimeout(
					() => {
						if (this.agentTurn === own) own.close();
					},
					Number(process.env.BRIGADIR_STEER_STOP_MS) || 20_000
				).unref?.();
			return;
		}
		if (command.kind === 'stopBackground') {
			await this.stopBackground(command.id);
			return;
		}
		if (command.kind === 'setMode') {
			if (!this.modeIds.has(command.modeId)) throw new Error('Mode is not in the agent catalog');
			await this.connection.agent.request(methods.agent.session.setMode, {
				sessionId,
				modeId: command.modeId,
			});
			await this.emit({ kind: 'mode.changed', modeId: command.modeId });
			return;
		}
		if (command.kind === 'setOption') {
			const option = this.options.get(command.id);
			if (
				!option ||
				(option.kind === 'boolean'
					? typeof command.value !== 'boolean'
					: !option.choices.some((choice) => choice.value === command.value))
			)
				throw new Error('Value is not in the agent catalog');
			const params =
				typeof command.value === 'boolean'
					? { sessionId, configId: command.id, type: 'boolean' as const, value: command.value }
					: { sessionId, configId: command.id, value: command.value };
			const result = await this.connection.agent.request<
				SetSessionConfigOptionResponse,
				SetSessionConfigOptionRequest
			>(methods.agent.session.setConfigOption, params);
			await this.emit({ kind: 'options.changed', options: mapOptions(result.configOptions) });
			return;
		}
		// spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent just began, whose `turn.started` the host has not journaled: the host's own prompt, already
		// journaled, takes it over (Claude Code adds the prompt to that turn and answers it at its end).
		if (this.busy && !(this.agentTurn && !this.agentTurn.begun))
			throw new Error('A prompt is already running');
		const prompt = this.promptBlocks(command.text, attachments, resources);
		if (this.agentTurn) {
			this.agentTurn.taken = true;
			this.agentTurn = null;
		}
		this.busy = true;
		this.cancelling = false;
		const mine = ++this.turn;
		let settle = () => {};
		this.sendDone = new Promise((resolve) => {
			settle = resolve;
		});
		try {
			this.promptsSent++;
			// A failed prompt is answered with an error, which the wire does not count: once settled, the prompt is answered either way.
			// The end is queued in the same step as the answer, ahead of any status the agent sends after it.
			await this.connection.agent
				.request<PromptResponse, PromptRequest>(methods.agent.session.prompt, { sessionId, prompt })
				.finally(() => {
					this.wireAnswers = Math.max(this.wireAnswers, this.promptsSent);
				})
				.then((result) => {
					const ended = this.emit({ kind: 'turn.completed', reason: result.stopReason });
					if (this.turn === mine) this.ended = mine;
					return ended;
				});
		} catch (error) {
			// spec/chat#tool-states: a call the person's message cut off is interrupted, not a failure of the turn.
			const orphans = this.steeredTurn === mine && !this.stopping ? steerOrphans(error) : null;
			if (orphans) {
				for (const id of orphans)
					await this.emit({
						kind: 'tool.changed',
						patch: { id, status: 'interrupted', content: [] },
					});
				await this.emit({ kind: 'turn.completed', reason: 'end_turn' });
				return;
			}
			if (!this.stopping)
				await this.emit({
					kind: 'session.failed',
					message: error instanceof Error ? error.message : String(error),
					...(isAuthRequired(error) ? { reason: 'auth' as const } : {}),
				});
			throw error;
		} finally {
			if (this.turn === mine) this.busy = false;
			settle();
		}
	}
	private promptBlocks(
		text: string,
		attachments: PromptInput[],
		resources: PromptResource[]
	): PromptRequest['prompt'] {
		if (!text.trim() && !attachments.length) throw new Error('Prompt is empty');
		this.validateAttachments(attachments);
		if (
			resources.length > 20 ||
			resources.some(
				(resource) =>
					!resource.name ||
					resource.name.length > 4096 ||
					resource.uri.length > 8192 ||
					new URL(resource.uri).protocol !== 'file:'
			)
		)
			throw new Error('Invalid resource links');
		const block = (input: AttachmentInput) =>
			input.kind === 'text'
				? {
						type: 'text' as const,
						text: `<attached_context name=${JSON.stringify(input.name)}>\n${input.text}\n</attached_context>`,
					}
				: { type: 'image' as const, data: input.data, mimeType: input.mimeType };
		// spec/composer#mentions: a mention stands where the person wrote it — blocks follow the text; inputs without an id (brief,
		// workspace context) and attachments the text does not place come after it, as before.
		const placed = attachments.filter(
				(input): input is PromptInput & { id: string } => typeof input.id === 'string'
			),
			byId = new Map(placed.map((input) => [input.id, input]));
		const ordered = promptSequence(
			text,
			placed.map((input) => input.id)
		).map((part) =>
			part.kind === 'text' ? { type: 'text' as const, text: part.text } : block(byId.get(part.id)!)
		);
		return [
			...ordered,
			...attachments.filter((input) => typeof input.id !== 'string').map(block),
			...resources.map((resource) => ({ type: 'resource_link' as const, ...resource })),
		];
	}
	/** spec/chat-turns-plans-and-questions#agent-started-turns: the agent says whether it works. Working with no prompt of ours, no steer in flight and no turn open — a turn it
	 *  began on its own; done with no prompt of ours left in that turn — its end. */
	private agentState(working: boolean): void {
		const was = this.agentWorking;
		this.agentWorking = working;
		const own = this.agentTurn;
		if (!working) {
			if (own && own.prompts === 0) own.close();
			return;
		}
		// Idle → working once the turn holding `busy` has its end queued: a new turn of the agent, not the rest of that one.
		const after = this.busy && was === false && this.ended === this.turn;
		if (
			own ||
			(this.busy && !after) ||
			this.steerWatch ||
			!this.opened ||
			this.stopping ||
			!this.config.agentTurn
		)
			return;
		this.openAgentTurn();
	}
	private openAgentTurn(): void {
		const mine = ++this.turn;
		this.busy = true;
		this.cancelling = false;
		let done = () => {};
		const finished = new Promise<void>((resolve) => {
			done = resolve;
		});
		const abort = () => turn.close();
		const turn: AgentTurn = {
			begun: false,
			taken: false,
			closed: false,
			prompts: 0,
			reason: null,
			close: () => {
				if (turn.closed) return;
				turn.closed = true;
				if (this.agentTurn === turn) this.agentTurn = null;
				const reason = this.cancelling ? 'cancelled' : (turn.reason ?? 'end_turn');
				this.connection.signal.removeEventListener('abort', abort);
				// Chained here, in the handler of the status that ended the turn: after everything the turn sent before its end, and
				// before anything of a turn that begins later.
				const step = this.eventTail.then(async () => {
					if (turn.begun && !this.stopping)
						await this.config.onEvent({ kind: 'turn.completed', reason });
				});
				this.eventTail = step.catch(() => {});
				if (this.turn === mine) this.ended = mine;
				void step
					.catch(() => {})
					.finally(() => {
						if (this.turn === mine) this.busy = false;
						done();
					});
			},
		};
		this.agentTurn = turn;
		this.connection.signal.addEventListener('abort', abort, { once: true });
		const begin = this.eventTail
			.then(async () => {
				if (turn.taken || this.stopping) return false;
				try {
					return await this.config.agentTurn!(finished);
				} catch {
					return false;
				}
			})
			.then((opened) => {
				turn.begun = opened;
				// Nobody journaled it (the host's own prompt is starting, or the journal failed): the connection is free for that prompt.
				if (!opened && !turn.taken) {
					turn.close();
					if (this.turn === mine) this.busy = false;
				}
			});
		this.eventTail = begin.catch(() => {});
	}
	/** spec/chat-turns-plans-and-questions#agent-started-turns: the person's message into a turn the agent began on its own, as a prompt that turn answers. */
	private fold(turn: AgentTurn, prompt: PromptRequest['prompt']): void {
		turn.prompts++;
		this.promptsSent++;
		void this.connection.agent
			.request<PromptResponse, PromptRequest>(methods.agent.session.prompt, {
				sessionId: this.id,
				prompt,
			})
			.finally(() => {
				this.wireAnswers = Math.max(this.wireAnswers, this.promptsSent);
			})
			.then(
				(result) => {
					turn.reason = result.stopReason;
				},
				(error) => {
					if (!this.stopping)
						void this.emit({
							kind: 'unhandled',
							name: `agent turn: the added prompt failed: ${error instanceof Error ? error.message : String(error)}`,
						});
				}
			)
			.finally(() => {
				turn.prompts--;
				if (turn.prompts === 0 && this.agentWorking === false) turn.close();
			});
	}
	private withSteering(event: AgentEvent): AgentEvent {
		return event.kind === 'session.started' && this.canSteer ? { ...event, steering: true } : event;
	}
	private threadStatus(meta: unknown): string | undefined {
		const status =
			isRecord(meta) && isRecord(meta.codex) && isRecord(meta.codex.threadStatus)
				? meta.codex.threadStatus.type
				: undefined;
		if (typeof status !== 'string') return undefined;
		this.threadStatusSeen = true;
		this.sdkStatuses++;
		// Closing on the status the wire marked keeps `turn.completed` after its record and after everything before it.
		const watch = this.steerWatch;
		if (watch?.endAt != null && this.sdkStatuses >= watch.endAt) watch.done?.();
		return status;
	}
	/** Lines of a chunk while a steer is watched; the SDK parses the same chunk only after this synchronous listener. */
	/** The pending session, ours, or a subagent session the adapter announced (spec/chat#subagents). */
	private ownSession(sessionId: string): boolean {
		return !this.sessionId || sessionId === this.sessionId || this.subagents.has(sessionId);
	}
	/** spec/chat#subagents: `subagent_spawned` and `subagent_state_update` go to the SDK as our ext notification; every other line as is. */
	private static adapterLine(line: string): string {
		if (!line.includes('"initialize"')) return line;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return line;
		}
		if (
			!isRecord(message) ||
			message.method !== 'initialize' ||
			!isRecord(message.params) ||
			!isRecord(message.params.clientCapabilities)
		)
			return line;
		return JSON.stringify({
			...message,
			params: {
				...message.params,
				clientCapabilities: { ...message.params.clientCapabilities, subagents: {} },
			},
		});
	}
	private static sdkLine(line: string): string {
		if (!line.includes('"subagent_')) return line;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return line;
		}
		if (
			!isRecord(message) ||
			message.method !== 'session/update' ||
			!isRecord(message.params) ||
			!isRecord(message.params.update)
		)
			return line;
		const type = message.params.update.sessionUpdate;
		return type === 'subagent_spawned' || type === 'subagent_state_update'
			? JSON.stringify({ ...message, method: '_brigadir/subagent' })
			: line;
	}
	private wire(chunk: Buffer): void {
		this.wireTail += this.decoder.write(chunk);
		let index: number;
		while ((index = this.wireTail.indexOf('\n')) >= 0) {
			const line = this.wireTail.slice(0, index);
			this.wireTail = this.wireTail.slice(index + 1);
			this.sdkInput.write(AgentTransport.sdkLine(line) + '\n');
			const answer = line.includes('"stopReason"'),
				status = !answer && line.includes('threadStatus');
			if (!answer && !status) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(message)) continue;
			if (answer) {
				if (isRecord(message.result) && 'stopReason' in message.result) this.wireAnswers++;
				continue;
			}
			// The same statuses the SDK path counts: session updates of this session that carry a threadStatus type.
			if (
				message.method !== 'session/update' ||
				!isRecord(message.params) ||
				(this.sessionId && message.params.sessionId !== this.sessionId)
			)
				continue;
			const update = message.params.update,
				meta =
					isRecord(update) && update.sessionUpdate === 'session_info_update'
						? update._meta
						: undefined;
			const type =
				isRecord(meta) && isRecord(meta.codex) && isRecord(meta.codex.threadStatus)
					? meta.codex.threadStatus.type
					: undefined;
			if (typeof type !== 'string') continue;
			const number = ++this.wireStatuses,
				watch = this.steerWatch;
			if (!watch || watch.endAt !== null || this.wireAnswers < this.promptsSent) continue;
			// Any status other than active ends the turn: idle, and also systemError or notLoaded.
			if (type === 'active') watch.active = true;
			else if (watch.active) watch.endAt = number;
		}
	}
	/** spec/composer-steering-queue-and-ghost#steering: a prompt into the running turn through `_session/steering`, only while this connection's own prompt runs.
	 *  `injected` — the agent reads it in this turn, which ends with the one `turn.completed` of `send`. `declined` — no running turn
	 *  (`promptRequired`), no steering or a failed request: the prompt stays with the host. `adopted` — the adapter ignored the
	 *  host-owned fallback and started a turn of its own (codex-acp); `begin` runs on the event chain before any later update of that
	 *  turn, the connection stays busy, and `finished` settles after `turn.completed` once the agent reports `threadStatus: idle`. */
	async steer(
		text: string,
		attachments: PromptInput[],
		resources: PromptResource[],
		begin: () => Promise<void>
	): Promise<
		{ outcome: 'injected' | 'declined' } | { outcome: 'adopted'; finished: Promise<void> }
	> {
		// One adopted turn at a time: a steer during it would replace its watch and leave it open for good.
		if (
			!this.canSteer ||
			!this.busy ||
			this.cancelling ||
			this.stopping ||
			this.steerWatch?.phase === 'adopted'
		)
			return { outcome: 'declined' };
		const sessionId = this.id,
			prompt = this.promptBlocks(text, attachments, resources);
		const watch: NonNullable<typeof this.steerWatch> = {
			phase: 'pending',
			active: false,
			endAt: null,
			done: null,
		};
		this.steerWatch = watch;
		const release = () => {
			if (this.steerWatch === watch) this.steerWatch = null;
		};
		let result: unknown;
		try {
			result = await this.connection.agent.request<unknown, unknown>('_session/steering', {
				sessionId,
				prompt,
				_meta: { steering: { idleBehavior: 'promptRequired' } },
			});
		} catch {
			release();
			return { outcome: 'declined' };
		}
		const outcome = isRecord(result) ? result.outcome : undefined;
		// spec/chat-turns-plans-and-questions#agent-started-turns: to the adapter a turn the agent began on its own is no turn of ours, so claude-agent-acp answers promptRequired.
		// Claude Code adds a prompt that arrives while it works to the running turn and answers it at that turn's end.
		const own = this.agentTurn;
		if (outcome === 'promptRequired' && own?.begun && !this.stopping && !this.cancelling) {
			release();
			this.fold(own, prompt);
			return { outcome: 'injected' };
		}
		if (outcome !== 'startedNewTurn' || this.stopping) {
			release();
			if (outcome === 'injected') this.steeredTurn = this.turn;
			return { outcome: outcome === 'injected' ? 'injected' : 'declined' };
		}
		if (!this.threadStatusSeen) {
			// No end signal to own the turn by: stop it. The agent already has the text, so it counts as delivered, not resent.
			release();
			await this.connection.agent.notify(methods.agent.session.cancel, { sessionId });
			return { outcome: 'injected' };
		}
		// codex-acp starts this turn only after our prompt completed: its `turn.completed` goes first on the event chain.
		const mine = ++this.turn;
		this.busy = true;
		this.cancelling = false;
		watch.phase = 'adopted';
		await this.sendDone;
		const started = this.eventTail.then(begin);
		this.eventTail = started.catch(() => {});
		try {
			await started;
		} catch {
			// The host could not open the turn: stop it. The agent already has the text, so it is delivered, not queued again.
			release();
			if (this.turn === mine) this.busy = false;
			await this.connection.agent
				.notify(methods.agent.session.cancel, { sessionId })
				.catch(() => {});
			return { outcome: 'injected' };
		}
		// A watchdog, so a race this code has not met yet costs a delay rather than a host busy for good: no update and no active
		// for 30 s closes the turn and says so in the journal.
		let watchdog: ReturnType<typeof setInterval> | undefined;
		this.lastUpdateAt = Date.now();
		const finished = new Promise<void>((resolve, reject) => {
			watch.done = resolve;
			if (watch.endAt !== null && this.sdkStatuses >= watch.endAt) resolve();
			watchdog = setInterval(() => {
				if (
					!watch.active &&
					Date.now() - this.lastUpdateAt >
						(Number(process.env.BRIGADIR_STEER_WATCHDOG_MS) || 30_000)
				) {
					void this.emit({
						kind: 'unhandled',
						name: 'steering: the adopted turn sent nothing for 30 s and was closed',
					});
					resolve();
				}
			}, 1000);
			watchdog.unref?.();
			if (this.connection.signal.aborted) reject(new Error('Agent connection is closed'));
			this.connection.signal.addEventListener(
				'abort',
				() => reject(new Error('Agent connection is closed')),
				{ once: true }
			);
		})
			.then(() => {
				const ended = this.emit({
					kind: 'turn.completed',
					reason: this.cancelling ? 'cancelled' : 'end_turn',
				});
				if (this.turn === mine) this.ended = mine;
				return ended;
			})
			.finally(() => {
				clearInterval(watchdog);
				release();
				if (this.turn === mine) this.busy = false;
			});
		return { outcome: 'adopted', finished };
	}
	/** spec/agents-and-providers#one-shot: removes this session from the agent's own history (a Claude transcript, a Codex thread is archived), so a
	 *  disposable call does not show up in the person's Claude or ChatGPT. Never fails: an agent without the capability or a
	 *  slow answer leaves the session as it is. */
	deleteSession(timeoutMs = 3000): Promise<void> {
		if (this.deleting) return this.deleting;
		if (!this.canDelete || !this.sessionId || this.stopping)
			return (this.deleting = Promise.resolve());
		let timer: NodeJS.Timeout | undefined;
		const request = this.connection.agent
			.request<DeleteSessionResponse, DeleteSessionRequest>(methods.agent.session.delete, {
				sessionId: this.sessionId,
			})
			.then(
				() => {},
				(error) => {
					this.config.onDiagnostic?.(
						`Session delete failed: ${error instanceof Error ? error.message : String(error)}`
					);
				}
			);
		return (this.deleting = Promise.race([
			request,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
				timer.unref?.();
			}),
		]).finally(() => clearTimeout(timer)));
	}
	close(): void {
		if (this.stopping) return;
		this.stopping = true;
		this.config.signal?.removeEventListener('abort', this.abort);
		for (const controller of this.permissionControllers) controller.abort();
		this.connection.close();
		if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
			const pid = this.child.pid;
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (process.platform === 'win32') this.child.kill(signal);
					else process.kill(-pid, signal);
				} catch {
					/* already exited */
				}
			};
			kill('SIGTERM');
			const timer = setTimeout(() => kill('SIGKILL'), 1500);
			timer.unref();
			this.child.once('exit', () => clearTimeout(timer));
		}
	}
}
async function interruptible(
	choice: Promise<string | null>,
	signal: AbortSignal
): Promise<string | null> {
	if (signal.aborted) {
		void choice.catch(() => {});
		return null;
	}
	let cancel: () => void = () => {};
	try {
		return await Promise.race([
			choice,
			new Promise<null>((resolve) => {
				cancel = () => resolve(null);
				signal.addEventListener('abort', cancel, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener('abort', cancel);
	}
}
