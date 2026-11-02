import { realpathSync } from 'node:fs';
import {
	commandDirectory,
	commandRunSpec,
	runState,
	type ProjectCommand,
	type TerminalInfo,
	isScopeChoice,
	type ScopeChoice,
	isTaskProposal,
	isTaskAgentRequest,
	samePullRequest,
	waitsForPerson,
	type TaskProposal,
	type TaskProposalResult,
	type SaveFileRequest,
	type SaveFileResult,
	contextClosed,
	moduleOffMessages,
	writableByAgent,
	isGitScope,
	blockedRateLimit,
	reduceRateLimits,
	skipsAgentPermission,
	browserShowCard,
} from '@brigadir/core';
import { AgentFiles } from './agent-files';
import { ScopeLocks, type ScopeOwner } from './scope-locks';
import { scopeContext, scopeDirectories } from './scope-context';
import {
	chosenOptionNames,
	promptQueue,
	reducePromptQueue,
	type AttachmentInput,
	type PromptCommand,
	type QueuedPrompt,
} from '@brigadir/core';
import { browserUrl, localBrowserUrl } from './browser-url';
import { Terminals } from './terminals';
import { dirname, isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { chmod, open as openFile, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
	backgroundCommands,
	backgroundSummary,
	backgroundTailBytes,
	isBackgroundId,
	liveBackground,
	outputTail,
	isPlanApproval,
	recordModeId,
	selectOption,
	sessionModeName,
	sessionModes,
	hostIdleReason,
	hostUpdateReason,
	hostStatus,
	isAttachmentId,
	isAttachmentIds,
	type PromptAttachment,
	isFileId,
	isBrowserCommand,
	isTerminalCommand,
	isRecord,
	isSaveFileRequest,
	isSessionCommand,
	isUserQuestion,
	pendingInputs,
	validAnswer,
	type EventRecord,
	type PermissionRequest,
	type QuestionAnswer,
	type SessionCommand,
	type SessionEvent,
	type TaskKey,
	type UserQuestion,
} from '@brigadir/core';
import {
	readOnlyChanges,
	watchScopes,
	Snapshots,
	NewWorktrees,
	worktreeOfRoot,
} from '@brigadir/git';
import {
	Attachments,
	SessionStore,
	ProcessCoordinator,
	atomicJson,
	safePath,
	readDocument,
} from '@brigadir/persistence';
import {
	AgentTransport,
	isAuthRequired,
	cliHook,
	statuslineReadings,
	type AdapterCommand,
	type PromptInput,
} from '@brigadir/transport';
import { cliLaunch } from './cli-launch';
import { revertTaskFile } from './revert-file';
import { saveTaskFile } from './save-file';
import { Peer } from './peer';
import {
	acquireOwner,
	dirMark,
	newIdentity,
	orphanCheckMs,
	orphaned,
	saveIdentity,
} from './runtime';
import {
	readCrewContext,
	sessionBrief,
	crewLinkEvents,
	CrewHost,
	CrewWorker,
	isCrewToolCall,
} from './crew';
import { humanToolsAllowed, isWorkspaceTool, simulatorQueued } from '@brigadir/orchestrator';
import { serveMcp } from './mcp';
import { ModuleSettings } from './modules';
import { terminalColors } from './terminal-colors';
import { idleBlocker, idleTimeout } from './idle';
export type HostConfig = {
	dataDir: string;
	key: TaskKey;
	mcpEntry: string;
	runtime?: string;
	adapter?: AdapterCommand;
	consoleOnly?: boolean;
	allowScopeConflict?: boolean;
	cli?: AdapterCommand;
};
function sameToken(a: unknown, b: string) {
	return (
		typeof a === 'string' &&
		a.length === b.length &&
		timingSafeEqual(Buffer.from(a), Buffer.from(b))
	);
}
export async function startHost(config: HostConfig) {
	const store = await SessionStore.at(config.dataDir);
	let task = await store.task(config.key);
	const project = await store.projectForTask(config.key);
	// spec/tasks#quick-tasks: the main tree has no provider; its host runs only consoles, and `startAgent` refuses.
	if (!task.provider && !config.consoleOnly) throw new Error('Task has no provider');
	const release = await acquireOwner(
		store,
		config.key,
		join(dirname(config.mcpEntry), 'process-owner')
	);
	try {
		task = await store.task(config.key);
	} catch (error) {
		await release();
		throw error;
	}
	let writer: Awaited<ReturnType<SessionStore['writer']>>;
	try {
		writer = await store.writer(config.key);
	} catch (e) {
		await release();
		throw e;
	}
	let identity: Awaited<ReturnType<typeof newIdentity>>;
	try {
		identity = await newIdentity(store, config.key);
	} catch (e) {
		await writer.close();
		await release();
		throw e;
	}
	const records = writer.records;
	const peers = new Set<Peer>();
	let ui: Peer | null = null;
	// spec/crew-templates-and-editor#snapshot: a foreman task carries its crew; a worker points at the crew task. Both get their role brief as `.context` of the first prompt; every session gets the checklist sentence (spec/chat-turns-plans-and-questions#checklist-tools), a Claude session the plan sentence (spec/chat-turns-plans-and-questions#plan-approval).
	const crew = await readCrewContext(store, task).catch(async (error) => {
		await writer.close();
		await release();
		throw error;
	});
	let briefPending = false,
		cliBriefSent = false;
	const crewWorker = crew?.parentKey ? new CrewWorker(store, config.key, crew) : null;
	let crewHost: CrewHost | null = null;
	// spec/settings-modules-and-onboarding#modules: the modules on in Settings decide which human tools the MCP sessions list; a switch reaches open sessions.
	const modules = new ModuleSettings(store.root);
	await modules.load();
	modules.start();
	const brief = sessionBrief(crew, task.provider, {
		commands: modules.current().commands && Boolean(project.commands?.length),
		tools: modules.current(),
		cli: task.transport === 'terminal',
	});
	const scopeLocks = new ScopeLocks(
		store,
		new ProcessCoordinator(join(dirname(config.mcpEntry), 'process-owner'))
	);
	let scopeOwner: ScopeOwner | null = null;
	let initialScopeOverride = config.allowScopeConflict === true;
	async function releaseScopes() {
		if (scopeOwner) {
			await scopeLocks.release(scopeOwner);
			scopeOwner = null;
		}
	}
	let transport: AgentTransport | null = null;
	let busy = false;
	let stopping = false;
	/** spec/chat-turns-plans-and-questions#agent-started-turns: `beginPrompt` runs and has not handed its prompt to the transport yet. */
	let starting = false;
	// `uiVisible` is main's selected task; `idleSince` restarts on any record, command or blocker.
	let uiVisible = false,
		idleSince: number | null = null,
		idleChecking = false,
		/** spec/architecture-and-platform#auto-update: main runs a newer app; stop at the first moment nothing runs. */
		retiring = false,
		idleTimer: ReturnType<typeof setInterval> | undefined,
		orphanTimer: ReturnType<typeof setInterval> | undefined;
	const idleMs = idleTimeout();
	const touchIdle = () => {
		idleSince = null;
	};
	let turnFinished: Promise<unknown> = Promise.resolve();
	/** The turn `busy` belongs to: an adopted turn (spec/composer-steering-queue-and-ghost#steering) may begin before the previous turn's `finally` ran. */
	let turnGen = 0;
	/** A steer is out: the turn it aims at leaves `busy` to it, so nothing slips into the moment an adopted turn begins. */
	let steerPending = false;
	/** spec/composer-steering-queue-and-ghost#steering-hold: when each held message was sent, the window timer of Claude, and the tools of subagents (no step boundary). */
	const heldAt = new Map<string, number>();
	let heldTimer: ReturnType<typeof setTimeout> | undefined;
	const childTools = new Set<string>(),
		boundaryTools = new Set<string>();
	/** Messages held during this turn: once one of them is in the FIFO, the rest of this turn follow it there. */
	const turnHeld = new Set<string>();
	const holdWindowMs = () =>
		task.provider === 'claude' ? Number(process.env.BRIGADIR_STEER_HOLD_MS) || 5000 : null;
	let sentScopeContext = '';
	/** spec/projects-and-board#folders-mid-task: a folder joined the task after the adapter negotiated its roots; the next prompt reconnects it first. */
	let rootsStale = false;
	let queue = promptQueue(records),
		promptTail: Promise<unknown> = Promise.resolve();
	let rateTimer: ReturnType<typeof setTimeout> | undefined;
	const quotaBlocked = () => Boolean(queue.rateLimits?.length);
	function scheduleRateReset() {
		clearTimeout(rateTimer);
		if (stopping) return;
		const times = (queue.rateLimits ?? []).flatMap((item) =>
			item.resetsAt === null ? [] : [item.resetsAt * 1000]
		);
		if (!times.length) return;
		rateTimer = setTimeout(
			() => {
				void (async () => {
					for (const item of queue.rateLimits ?? []) {
						if (stopping) return;
						if (item.resetsAt !== null && item.resetsAt * 1000 <= Date.now())
							await emit({
								kind: 'rate-limit.expired',
								window: item.window,
								resetsAt: item.resetsAt,
							});
					}
					scheduleRateReset();
					kickPrompts();
				})().catch(() => {});
			},
			Math.min(2_147_483_647, Math.max(0, Math.min(...times) - Date.now()))
		);
		rateTimer.unref?.();
	}
	function serialPrompt<T>(work: () => Promise<T>): Promise<T> {
		const result = promptTail
			.catch(() => {})
			.then(() => {
				if (stopping) throw new Error('Host is stopping');
				return work();
			});
		promptTail = result;
		return result;
	}
	function kickPrompts() {
		void serialPrompt(async () => {
			// spec/editor#save-during-turn: saves held during the turn are written before anything starts the next one.
			if (!busy) await runHeldSaves();
			// spec/composer-steering-queue-and-ghost#steering-hold: the turn ended with messages still held — they become the next turns, in order.
			if (!busy && queue.held?.length) {
				for (const item of queue.held) await queueHeld(item);
				scheduleHeld();
			}
			if (
				busy ||
				saving ||
				!ready ||
				!transport ||
				queue.paused ||
				quotaBlocked() ||
				!queue.prompts.length
			)
				return;
			const next = queue.prompts[0]!;
			try {
				await beginPrompt(next.command, next.id);
			} catch (error) {
				await emit({
					kind: 'session.failed',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}).catch(() => {});
	}
	async function beginPrompt(c: PromptCommand, queuedPromptId?: string) {
		if (rootsStale && transport && !busy && !saving && !stopping) {
			rootsStale = false;
			const old = transport;
			transport = null;
			old.close();
			await ensureAgent();
		}
		if (!transport || !ready || busy || saving || stopping || quotaBlocked())
			throw new Error('Agent is not available');
		busy = true;
		starting = true;
		completedTools.clear();
		childTools.clear();
		boundaryTools.clear();
		turnHeld.clear();
		toolCount = 0;
		const manifest = task.launch ? scopeContext(snapshots?.current.scopes ?? []) : '',
			context = manifest !== sentScopeContext ? manifest : '';
		let attachments: Awaited<ReturnType<Attachments['resolve']>>;
		let relay: Awaited<ReturnType<typeof relayContext>> = { attachmentIds: [], resources: [] };
		try {
			if (!records.some((record) => record.event.kind === 'turn.started'))
				relay = await relayContext(store, config.key);
			attachments = await assets.resolve(config.key, [
				...new Set([
					...(c.kind === 'prompt' ? (c.attachmentIds ?? []) : []),
					...relay.attachmentIds,
				]),
			]);
			transport.validateAttachments(attachments.map((value) => value.input));
			await checkpoint('turn');
			await emit({
				kind: 'turn.started',
				text: c.text,
				...(queuedPromptId ? { queuedPromptId } : {}),
				...(c.kind === 'submitReview' ? { review: c.review } : {}),
				...(attachments.length
					? { attachments: attachments.map((value) => value.attachment) }
					: {}),
				...(c.kind === 'prompt' && c.crew ? { crew: c.crew } : {}),
			});
		} catch (error) {
			busy = false;
			starting = false;
			throw error;
		}
		sentScopeContext = manifest;
		const briefBlock =
			briefPending && brief ? [{ kind: 'text' as const, name: 'Brigadir brief', text: brief }] : [];
		briefPending = false;
		const gen = ++turnGen;
		starting = false;
		turnFinished = transport
			.send(
				{ kind: 'prompt', text: c.text },
				[
					...attachments.map((value) => ({ ...value.input, id: value.attachment.id })),
					...briefBlock,
					...(context
						? [{ kind: 'text' as const, name: 'Workspace repositories', text: context }]
						: []),
				],
				relay.resources
			)
			.catch(() => {
				sentScopeContext = '';
				if (briefBlock.length) briefPending = true;
			})
			.finally(() => {
				if (turnGen === gen && !steerPending) busy = false;
				kickPrompts();
			});
	}
	/** spec/composer-steering-queue-and-ghost#steering-hold: the step boundary sends every held message (`all`), Claude's window only those older than it. */
	function flushHeld(all: boolean) {
		void serialPrompt(async () => {
			const limit = holdWindowMs(),
				due = (queue.held ?? []).filter(
					(item) => all || (limit !== null && Date.now() - (heldAt.get(item.id) ?? 0) >= limit)
				);
			// Once one goes to the FIFO the rest follow it, so the agent never reads a later message before an earlier one — also
			// when an earlier flush of this turn put one there.
			let queued = queue.prompts.some((item) => turnHeld.has(item.id));
			for (const item of due) {
				if (!queue.held?.some((entry) => entry.id === item.id)) continue;
				const inputs =
					!queued && busy && transport?.steering && !quotaBlocked()
						? (
								await assets.resolve(
									config.key,
									item.command.kind === 'prompt' ? (item.command.attachmentIds ?? []) : []
								)
							).map((value) => ({ ...value.input, id: value.attachment.id }))
						: null;
				if (!inputs || !(await steerPrompt(item, inputs))) {
					await queueHeld(item);
					queued = true;
				}
			}
			scheduleHeld();
			if (!busy) kickPrompts();
		}).catch(() => {});
	}
	/** A held message moves to the FIFO in front of everything queued after it was held. */
	async function queueHeld(item: QueuedPrompt) {
		// Each entry counts from when it first reached the host: its first prompt.held or prompt.queued. A queued message sent now
		// keeps its place among the queued ones, a held one is not overtaken by what came after it.
		const since = (id: string) =>
			records.find(
				(record) =>
					(record.event.kind === 'prompt.held' || record.event.kind === 'prompt.queued') &&
					record.event.prompt.id === id
			)?.seq ?? -1;
		const heldSeq = since(item.id),
			before = queue.prompts.find((entry) => since(entry.id) > heldSeq)?.id;
		await emit({ kind: 'prompt.queued', prompt: item, ...(before ? { before } : {}) });
	}
	function scheduleHeld() {
		clearTimeout(heldTimer);
		const limit = holdWindowMs(),
			first = queue.held?.[0];
		if (limit === null || !first || stopping) return;
		heldTimer = setTimeout(
			() => flushHeld(false),
			Math.max(0, (heldAt.get(first.id) ?? Date.now()) + limit - Date.now())
		);
		heldTimer.unref?.();
	}
	/** spec/composer-steering-queue-and-ghost#steering: a person's prompt into the running GUI turn. Journaled as `prompt.steered` before the request; false — the agent
	 *  declined it (the turn just ended, or no steering) and the caller queues it as usual. */
	async function steerPrompt(prompt: QueuedPrompt, inputs: PromptInput[]): Promise<boolean> {
		const agent = transport;
		if (!agent) return false;
		await emit({ kind: 'prompt.steered', prompt });
		const before = turnGen;
		let gen = 0;
		steerPending = true;
		let result: Awaited<ReturnType<AgentTransport['steer']>>;
		try {
			result = await agent
				.steer(prompt.command.text, inputs, [], async () => {
					try {
						await checkpoint('turn');
					} catch (error) {
						await emit({
							kind: 'snapshot.failed',
							message: error instanceof Error ? error.message : 'Snapshot failed',
						});
					}
					gen = ++turnGen;
					busy = true;
					completedTools.clear();
					childTools.clear();
					boundaryTools.clear();
					turnHeld.clear();
					toolCount = 0;
					await emit({
						kind: 'turn.started',
						text: prompt.command.text,
						queuedPromptId: prompt.id,
						...(prompt.attachments.length ? { attachments: prompt.attachments } : {}),
					});
				})
				.catch(() => ({ outcome: 'declined' as const }));
		} finally {
			steerPending = false;
		}
		if (result.outcome === 'adopted') {
			turnFinished = result.finished
				.catch(() => {})
				.finally(() => {
					if (turnGen === gen) busy = false;
					kickPrompts();
				});
			return true;
		}
		// The aimed-at turn ended while the steer was out, or an adopted turn failed to open: nothing runs any more.
		if ((turnGen === before || turnGen === gen) && !agent.running) busy = false;
		return result.outcome === 'injected';
	}
	let saving = false;
	let saveFinished: Promise<unknown> = Promise.resolve();
	/** spec/editor#save-during-turn: saves asked during a turn, one per path (a newer one replaces it); they run when the turn ends. */
	const heldSaves = new Map<
		string,
		{
			request: SaveFileRequest;
			resolve(result: SaveFileResult): void;
			reject(error: unknown): void;
		}
	>();
	function holdSave(request: SaveFileRequest) {
		return new Promise<SaveFileResult>((resolve, reject) => {
			heldSaves.get(request.path)?.reject(new Error('A newer save replaced this one'));
			heldSaves.delete(request.path);
			heldSaves.set(request.path, { request, resolve, reject });
		});
	}
	/** Runs on the prompt chain, so the next prompt cannot begin between the end of the turn and these writes. */
	async function runHeldSaves() {
		while (heldSaves.size && !busy && !saving && ready && snapshots && !stopping) {
			const [path, held] = heldSaves.entries().next().value!;
			heldSaves.delete(path);
			saving = true;
			const { afterTurn: _, ...request } = held.request;
			const operation = saveTaskFile(store, config.key, snapshots, request, emit);
			saveFinished = operation.catch(() => {});
			try {
				held.resolve(await operation);
			} catch (error) {
				held.reject(error);
			} finally {
				saving = false;
			}
		}
	}
	let stopScopeWatch = () => {};
	let scopeRefresh: Promise<void> = Promise.resolve();
	let agentFileTail: Promise<unknown> = Promise.resolve();
	const agentFiles = new AgentFiles(
		project.path,
		() => snapshots?.current.scopes ?? [],
		() => task.readOnlyAgent === true
	);
	let ready = false;
	let snapshots: Snapshots | null = null;
	/** spec/tasks#agent-worktrees: a worktree the agent made itself joins the task. A finished tool whose input names `worktree` makes the
	 *  host compare `git worktree list` of the task's writable repos with the last look; the first look is the baseline. */
	const newWorktrees = new NewWorktrees(
		[project.path, join(store.root, 'worktrees')].map((path) => {
			try {
				return realpathSync(path);
			} catch {
				return path;
			}
		})
	);
	const worktreeTools = new Map<string, string>();
	let adopting: Promise<void> = Promise.resolve();
	function agentRepos() {
		return (snapshots?.current.scopes ?? [])
			.filter((scope) => isGitScope(scope) && writableByAgent(scope))
			.map((scope) => scope.path);
	}
	function watchWorktreeTool(event: SessionEvent) {
		if (event.kind !== 'tool.changed') return;
		const { id, input, status } = event.patch;
		if (input) worktreeTools.set(id, input);
		if (worktreeTools.size > 256) worktreeTools.delete(worktreeTools.keys().next().value!);
		if (status !== 'completed' && status !== 'failed') return;
		const text = worktreeTools.get(id);
		worktreeTools.delete(id);
		if (text && /worktree/i.test(text)) adoptAgentWorktrees();
	}
	function adoptAgentWorktrees() {
		adopting = adopting
			.then(async () => {
				// Without the app the folder cannot be described; the next look still finds it new.
				if (!snapshots || !ui || stopping || task.readOnlyAgent === true) return;
				for (const path of await newWorktrees.found(agentRepos())) {
					if (
						snapshots.current.scopes.some(
							(scope) => scope.path === path && scope.selected && scope.available !== false
						)
					)
						continue;
					const choice = await ui.request('folder', { path });
					if (isScopeChoice(choice) && choice.kind === 'external' && choice.path)
						await addTaskFolder(choice);
				}
			})
			.catch((error) => {
				process.stderr.write(
					`[host] worktree adoption failed: ${error instanceof Error ? error.message : String(error)}\n`
				);
			});
	}
	let toolCount = 0;
	let lastCheckpoint: number | undefined;
	const completedTools = new Set<string>();
	let hookTail: Promise<unknown> = Promise.resolve();
	/** Tool checkpoints of a CLI turn run beside the hooks: the agent's next tool does not wait for git. */
	let toolCapture: Promise<unknown> = Promise.resolve();
	let cliSession: string | undefined;
	let cliTurn: string | undefined;
	let queuedReview: Extract<SessionCommand, { kind: 'submitReview' }> | null = null;
	let queuedReviewPath = '';
	const assets = new Attachments(store);
	let contextPath = '';
	let contextQueue: { id: string; ids: string[] } | null = null;
	let pendingAttachments: PromptAttachment[] = [];
	async function saveContext(queue: typeof contextQueue) {
		await atomicJson(contextPath, { schemaVersion: 1, queue });
		contextQueue = queue;
		pendingAttachments = (await assets.resolve(config.key, queue?.ids ?? [])).map(
			(value) => value.attachment
		);
	}
	const terminals = new Terminals(
		project.path,
		task,
		(event) => {
			try {
				ui?.notify('terminal', event);
			} catch {
				ui?.close();
			}
		},
		(code) => {
			if (!stopping) {
				hookTail = hookTail.then(async () => {
					await finishCliTurn(code !== 0);
					await releaseScopes();
				});
				void hookTail.catch(() => {});
			}
		},
		config.cli,
		join(dirname(config.mcpEntry), 'shell'),
		(cwd) => {
			// spec/terminal-and-cli-agents#console: the deepest repo holding the folder; the root repo is shown by the project's name, as in the Repos list.
			// Console folders arrive resolved (safePath), scope paths as discovered: compare both real.
			const real = (path: string) => {
					try {
						return realpathSync(path);
					} catch {
						return path;
					}
				},
				folder = real(cwd);
			const scope = (snapshots?.current.scopes ?? [])
				.map((item) => ({ item, path: real(item.path) }))
				.filter(({ path }) => folder === path || folder.startsWith(`${path}/`))
				.sort((a, b) => b.path.length - a.path.length)[0]?.item;
			return scope
				? scope.name === '.'
					? project.name
					: scope.name
				: folder === real(project.path)
					? project.name
					: undefined;
		},
		(role) => terminalColors(store.root, role)
	);
	// spec/settings-modules-and-onboarding#module-off: switching the commands module off stops the task's live commands even while no window is attached.
	modules.subscribe((value) => {
		if (!value.commands) terminals.stopRuns();
	});
	let startingAgent: Promise<void> | null = null;
	function ensureAgent(allowConflict = false) {
		if (transport || (task.transport === 'terminal' && terminals.agentAlive()))
			return Promise.resolve();
		if (!startingAgent)
			startingAgent = startAgent(allowConflict)
				.catch(async (error) => {
					await releaseScopes();
					throw error;
				})
				.finally(() => {
					startingAgent = null;
				});
		return startingAgent;
	}
	async function finishCliTurn(cancelled: boolean) {
		if (!busy) return;
		try {
			await toolCapture;
			await checkpoint('turn');
			await emit({ kind: 'turn.completed', reason: cancelled ? 'cancelled' : 'end_turn' });
		} finally {
			busy = false;
			void serialPrompt(runHeldSaves).catch(() => {});
		}
	}
	/** spec/agents-and-providers#quota-sources: the terminal statusline repeats `rate_limits` on every refresh; only a change reaches the journal. */
	let lastStatusline = '';
	async function acceptStatusline(value: unknown) {
		if (task.provider !== 'claude') return null;
		const windows = statuslineReadings(value);
		if (!windows.length) return null;
		const key = JSON.stringify(windows);
		if (key === lastStatusline) return null;
		lastStatusline = key;
		await emit({ kind: 'quota.observed', provider: 'claude', windows, complete: false });
		return null;
	}
	/** `after` is work the hook's answer does not wait for; the next hook still does (it stays on hookTail). */
	async function acceptCli(value: unknown): Promise<{ reply: unknown; after?: Promise<unknown> }> {
		const event = cliHook(value);
		if (!event) return { reply: null };
		if (event.kind === 'session') {
			if (cliSession !== event.sessionId) {
				await finishCliTurn(true);
				cliSession = event.sessionId;
				await emit({
					kind: 'session.started',
					sessionId: event.sessionId,
					modes: [],
					modeId: null,
					options: [],
				});
			}
			return { reply: null };
		}
		if (event.sessionId !== cliSession) throw new Error('CLI session does not match');
		if (event.kind === 'prompt') {
			if (event.turnId && event.turnId === cliTurn) return { reply: null };
			const review = queuedReview;
			const queue = contextQueue;
			const relay = records.some((record) => record.event.kind === 'turn.started')
				? { attachmentIds: [], resources: [] }
				: await relayContext(store, config.key);
			const attachments = await assets.resolve(config.key, [
				...new Set([...(queue?.ids ?? []), ...relay.attachmentIds]),
			]);
			await saveFinished;
			await finishCliTurn(true);
			await checkpoint('turn');
			busy = true;
			cliTurn = event.turnId;
			completedTools.clear();
			toolCount = 0;
			await emit({
				kind: 'turn.started',
				text: event.text,
				...(review ? { review: review.review } : {}),
				...(attachments.length
					? { attachments: attachments.map((value) => value.attachment) }
					: {}),
				...(queue ? { attachmentBatchId: queue.id } : {}),
			});
			if (review) {
				await atomicJson(queuedReviewPath, { schemaVersion: 1, command: null });
				queuedReview = null;
			}
			if (queue) await saveContext(null);
			const manifest = task.launch ? scopeContext(snapshots?.current.scopes ?? []) : '',
				scopeMessage = manifest !== sentScopeContext ? manifest : '';
			sentScopeContext = manifest;
			const briefMessage = brief && !cliBriefSent ? brief : '';
			cliBriefSent = true;
			const context = [
				briefMessage,
				scopeMessage,
				review?.text,
				...relay.resources.map(
					(resource) => `File in this task's workspace: ${resource.name} (${resource.uri})`
				),
				...attachments.map((value) =>
					value.input.kind === 'text'
						? `<attached_context name=${JSON.stringify(value.input.name)}>\n${value.input.text}\n</attached_context>`
						: `<attached_image name=${JSON.stringify(value.input.name)}>\nRead this explicitly attached PNG with your image tool: ${value.path}\n</attached_image>`
				),
			]
				.filter(Boolean)
				.join('\n\n');
			if (context)
				return {
					reply: {
						hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
					},
				};
			// The agent has finished: its closing capture need not hold the CLI.
		} else if (event.kind === 'stop' || event.kind === 'end')
			return { reply: null, after: finishCliTurn(event.kind === 'end' || event.cancelled) };
		else if (event.kind === 'tool' && busy) {
			await emit({
				kind: 'tool.changed',
				patch: { id: event.id, name: event.name, title: event.name, status: event.status },
			});
			// A capture failure is journaled as in GUI; the relay can no longer report it.
			if (event.status !== 'in_progress' && !completedTools.has(event.id)) {
				completedTools.add(event.id);
				if (++toolCount % 5 === 0)
					toolCapture = toolCapture
						.then(() => checkpoint('tools'))
						.catch((error) =>
							emit({
								kind: 'snapshot.failed',
								message: error instanceof Error ? error.message : 'Snapshot failed',
							})
						)
						.catch(() => {});
			}
		}
		return { reply: null };
	}
	async function checkpoint(
		reason: Parameters<Snapshots['capture']>[0],
		scopeIds?: readonly string[],
		discover?: false
	) {
		const before = snapshots?.current.checkpoints.at(-1),
			checkReadOnly = busy && !['baseline', 'user-before', 'user-after'].includes(reason);
		const revision = snapshots?.scopeRevision;
		const captured = await snapshots?.capture(reason, {
			scopeIds,
			...(discover === false ? { discover } : {}),
		});
		if (revision !== snapshots?.scopeRevision) await emit({ kind: 'scopes.changed' });
		if (captured && captured.id !== lastCheckpoint) {
			await emit({ kind: 'checkpoint.created', checkpoint: captured.id });
			lastCheckpoint = captured.id;
		}
		if (checkReadOnly && snapshots && captured)
			for (const violation of await readOnlyChanges(snapshots.current.scopes, before, captured))
				await emit({ kind: 'scope.violation', ...violation });
	}
	const crewPeers = new Set<Peer>();
	const permissions = new Map<
		string,
		{
			request: PermissionRequest;
			finish(option: string | null, returnMode?: string): Promise<void>;
		}
	>();
	/** spec/browser-and-simulator#browser-ui-act: domains the person let the agent act on in this task, until the app restarts. */
	const actDomains = new Set<string>();
	/** spec/chat-turns-plans-and-questions#plan-approval: an approved plan whose Approve could not pick the mode before the plan; the first move of the agent out
	 *  of `plan` in this turn is followed by `target`. Dropped at the end of the turn and by the person's own mode change. */
	let modeReturn: { plan: string; target: string } | null = null;
	async function returnMode(target: string) {
		const legacy = records.findLast((record) => record.event.kind === 'session.started')?.event;
		const viaMode =
			legacy?.kind === 'session.started' && legacy.modes.some((mode) => mode.id === target);
		const latest = records.findLast(
				(record) =>
					record.event.kind === 'session.started' || record.event.kind === 'options.changed'
			)?.event,
			option = latest && 'options' in latest ? selectOption(latest.options, 'mode') : undefined;
		try {
			if (viaMode) await transport?.send({ kind: 'setMode', modeId: target });
			else if (option?.choices.some((choice) => choice.value === target))
				await transport?.send({ kind: 'setOption', id: option.id, value: target });
		} catch (error) {
			process.stderr.write(
				`[host] mode return failed: ${error instanceof Error ? error.message : String(error)}\n`
			);
		}
	}
	const questions = new Map<
		string,
		{ question: UserQuestion; finish(answer: QuestionAnswer | null): Promise<void> }
	>();
	const proposals = new Map<
		string,
		{ proposal: TaskProposal; finish(task: TaskProposalResult): Promise<void> }
	>();
	let eventTail: Promise<unknown> = Promise.resolve();
	function emit(event: SessionEvent): Promise<void> {
		const result = eventTail.then(async () => {
			if (
				event.kind === 'scope.violation' &&
				records.some(
					(record) =>
						record.event.kind === 'scope.violation' &&
						record.event.scopeId === event.scopeId &&
						record.event.checkpoint === event.checkpoint
				)
			)
				return;
			if (
				event.kind === 'rate-limit.expired' &&
				!(queue.rateLimits ?? []).some(
					(item) => item.window === event.window && item.resetsAt === event.resetsAt
				)
			)
				return;
			const nextLimits = reduceRateLimits(queue.rateLimits ?? [], event),
				quotaEvent = event.kind === 'rate-limit.changed' || event.kind === 'rate-limit.expired';
			const record = await writer.append(event);
			watchWorktreeTool(event);
			if (event.kind === 'turn.started' && task.transport === 'terminal')
				await terminals.markTurn(record.seq);
			let status: typeof task.status | null = null;
			if (event.kind === 'turn.started') status = 'working';
			if (
				event.kind === 'permission.requested' ||
				event.kind === 'question.requested' ||
				event.kind === 'task.proposal.requested' ||
				event.kind === 'crew.plan.requested'
			)
				status = 'needs-you';
			if (
				event.kind === 'permission.resolved' ||
				event.kind === 'question.resolved' ||
				event.kind === 'task.proposal.resolved' ||
				event.kind === 'crew.plan.resolved'
			) {
				const left = pendingInputs([...records, record]);
				status =
					waitsForPerson(left) || (!busy && left.crewQuestions.length)
						? 'needs-you'
						: busy
							? 'working'
							: 'done';
			}
			// spec/crew#attention: a foreman that ends its turn with a worker's question unanswered relayed it to the person; the crew waits for them.
			if (event.kind === 'turn.completed')
				status =
					event.reason === 'cancelled'
						? 'interrupted'
						: pendingInputs([...records, record]).crewQuestions.length
							? 'needs-you'
							: 'done';
			if (event.kind === 'crew.question.escalated' && !busy) status = 'needs-you';
			if (
				event.kind === 'crew.question.resolved' &&
				!busy &&
				(await store.task(config.key)).status === 'needs-you'
			) {
				const left = pendingInputs([...records, record]);
				status = waitsForPerson(left) || left.crewQuestions.length ? 'needs-you' : 'done';
			}
			if (event.kind === 'session.failed') status = 'failed';
			if (event.kind === 'host.stopped' && busy) status = 'interrupted';
			if (event.kind === 'crew.accepted' && event.conflicts.length) status = 'needs-you';
			// The persisted expiry event is the boundary for both metadata and FIFO dispatch.
			if (nextLimits.length && (status || quotaEvent)) status = 'rate-limited';
			if (quotaEvent) {
				const current = await store.task(config.key);
				if (!nextLimits.length && current.status === 'rate-limited')
					status = busy
						? waitsForPerson(pendingInputs(records))
							? 'needs-you'
							: 'working'
						: 'interrupted';
				await store.updateTask(config.key, {
					rateLimit: blockedRateLimit(nextLimits, Number.NEGATIVE_INFINITY),
				});
			}
			// spec/agents-and-providers#sign-in-recovery: the task remembers a sign-in failure until the next turn or session.
			if (
				event.kind === 'session.failed' ||
				event.kind === 'turn.started' ||
				event.kind === 'session.started'
			) {
				const failure =
					event.kind === 'session.failed' && event.reason === 'auth' ? ('auth' as const) : null;
				if (((await store.task(config.key)).failure ?? null) !== failure)
					await store.updateTask(config.key, { failure });
			}
			if (status) {
				const current = await store.task(config.key);
				if (event.kind === 'turn.started' || !['backlog', 'completed'].includes(current.status))
					await store.setStatus(config.key, status);
			}
			if (
				(status &&
					event.kind !== 'permission.resolved' &&
					event.kind !== 'question.resolved' &&
					event.kind !== 'task.proposal.resolved' &&
					event.kind !== 'crew.plan.resolved' &&
					event.kind !== 'crew.question.resolved') ||
				event.kind === 'scope.violation'
			)
				await store.updateTask(config.key, {
					activitySeq: record.seq,
					...(event.kind === 'turn.started' ? { hasStarted: true } : {}),
				});
			if (snapshots && (event.kind === 'checkpoint.created' || event.kind === 'scopes.changed')) {
				const scopes = snapshots.current.scopes.filter((scope) => scope.available !== false);
				await store.updateTask(config.key, {
					scopeNames: scopes.map((scope) => (scope.kind === 'root' ? project.name : scope.name)),
					worktreeBranch:
						task.launch?.isolation === 'worktree'
							? (scopes.find((scope) => scope.kind === 'root')?.branch ?? task.launch.branch)
							: (scopes.find((scope) => scope.kind === 'worktree')?.branch ?? ''),
				});
			}
			// spec/chat-turns-plans-and-questions#background-commands: the sidebar card reads what still runs in the background from the task, not from the journal.
			if (
				event.kind === 'background.started' ||
				(event.kind === 'background.changed' && event.state) ||
				event.kind === 'host.stopped' ||
				event.kind === 'session.started'
			) {
				const next = backgroundSummary([...records, record]),
					current = (await store.task(config.key)).background ?? null;
				if (JSON.stringify(next) !== JSON.stringify(current))
					await store.updateTask(config.key, { background: next });
			}
			if (event.kind === 'pull-request.changed') {
				const current = await store.task(config.key);
				await store.updateTask(config.key, {
					pullRequests: { ...current.pullRequests, [event.scopeId]: event.pr },
				});
			}
			if (event.kind === 'session.started' || event.kind === 'options.changed') {
				const names = chosenOptionNames(event.options);
				await store
					.updateTask(config.key, {
						agentOptions: event.options,
						...(names.modelName ? { modelName: names.modelName } : {}),
						...(names.effortName ? { effortName: names.effortName } : {}),
					})
					.catch(() => {});
			}
			// Snapshots must not expose an event before its durable metadata and live delivery are ready.
			records.push(record);
			queue = reducePromptQueue(queue, event);
			touchIdle();
			if (quotaEvent) {
				scheduleRateReset();
				if (!quotaBlocked()) kickPrompts();
			}
			try {
				ui?.notify('event', record);
			} catch {
				ui?.close();
			}
			if (crewLinkEvents.has(event.kind))
				for (const peer of crewPeers) {
					try {
						peer.notify('event', record);
					} catch {
						peer.close();
					}
				}
			if (crewWorker && event.kind === 'turn.completed' && !stopping)
				void (async () => {
					if (!crewHost || (await crewHost.branchReady())) await crewWorker.report(record.seq);
				})().catch(() => {});
		});
		eventTail = result;
		void result.catch(() => {
			if (!stopping)
				setImmediate(() => {
					void stop('persistence_failed').catch(() => {});
				});
		});
		return result;
	}
	async function permission(
		request: PermissionRequest,
		signal: AbortSignal
	): Promise<string | null> {
		return new Promise((resolve, reject) => {
			const abort = () => {
				void finish(null).catch(reject);
			};
			const finish = async (optionId: string | null, returnMode?: string) => {
				if (!permissions.delete(request.id)) return;
				signal.removeEventListener('abort', abort);
				try {
					await emit({
						kind: 'permission.resolved',
						id: request.id,
						optionId,
						...(returnMode ? { returnMode } : {}),
					});
					resolve(optionId);
					if (queue.held?.length) flushHeld(true);
				} catch (e) {
					reject(e);
				}
			};
			permissions.set(request.id, { request, finish });
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
	}
	async function ask(value: unknown, signal: AbortSignal): Promise<QuestionAnswer> {
		const question = isRecord(value) ? { ...value, id: randomUUID() } : null;
		if (!isUserQuestion(question) || !busy)
			throw new Error('Question is invalid or no turn is active');
		return new Promise((resolve, reject) => {
			const abort = () => {
				void finish(null).catch(reject);
			};
			const finish = async (answer: QuestionAnswer | null) => {
				if (!questions.delete(question.id)) return;
				signal.removeEventListener('abort', abort);
				try {
					await emit({ kind: 'question.resolved', id: question.id, answer });
					if (answer) resolve(answer);
					else reject(new Error('No answer was provided'));
					if (queue.held?.length) flushHeld(true);
				} catch (e) {
					reject(e);
				}
			};
			questions.set(question.id, { question, finish });
			void emit({ kind: 'question.requested', question }).then(() => {
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) abort();
			}, reject);
		});
	}
	/** spec/tasks#agent-created-tasks: `create_task` — the card waits for the person; main creates the task and answers with `resolveTaskProposal`. */
	async function proposeTask(value: unknown, signal: AbortSignal): Promise<unknown> {
		if (!busy) throw new Error('No turn is active');
		if (!isRecord(value)) throw new Error('Invalid task proposal');
		const root = await realpath(project.path),
			folders: string[] = [];
		for (const folder of Array.isArray(value.folders) ? value.folders : []) {
			if (typeof folder !== 'string' || !isAbsolute(folder))
				throw new Error(`The folder ${String(folder)} must be an absolute path.`);
			const canonical = await realpath(folder).catch(() => null);
			if (!canonical || !(await stat(canonical)).isDirectory())
				throw new Error(`The folder ${folder} does not exist.`);
			if (canonical === root || canonical.startsWith(`${root}/`))
				throw new Error(
					`The folder ${folder} is inside the project; its repos are already in the task's repo list.`
				);
			if (!folders.includes(canonical)) folders.push(canonical);
		}
		for (const item of Array.isArray(value.context) ? value.context : [])
			if (isRecord(item) && item.kind === 'file') {
				if (typeof item.path !== 'string' || !isAbsolute(item.path))
					throw new Error(`The file ${String(item.path)} must be an absolute path.`);
				if (!(await stat(item.path).catch(() => null))?.isFile())
					throw new Error(`The file ${item.path} does not exist.`);
			}
		// spec/tasks#agent-created-tasks: the named agent is checked against main's catalog now, so an unknown model fails the call, not the card.
		let agent: unknown;
		if (value.agent !== undefined) {
			if (!isTaskAgentRequest(value.agent)) throw new Error('Invalid agent');
			if (!ui) throw new Error('Another agent is chosen while the Brigadir app is open.');
			agent = await ui.request('task_agent', value.agent);
		}
		const proposal = {
			id: randomUUID(),
			title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : null,
			prompt: value.prompt,
			context: value.context ?? [],
			folders,
			start: value.start ?? 'now',
			// spec/notifications-slack-notes-and-schedules#schedules: a schedule in this computer's zone unless the agent named one; missed slots caught up once.
			...(value.start === 'schedule' && isRecord(value.schedule)
				? {
						schedule: {
							rule: value.schedule.rule,
							timeZone:
								typeof value.schedule.timeZone === 'string'
									? value.schedule.timeZone
									: Intl.DateTimeFormat().resolvedOptions().timeZone,
							missed: value.schedule.missed ?? 'catch-up',
						},
					}
				: {}),
			...(agent === undefined ? {} : { agent }),
		};
		if (!isTaskProposal(proposal)) throw new Error('Invalid task proposal');
		return new Promise((resolve, reject) => {
			const abort = () => {
				void finish(null).catch(reject);
			};
			const finish = async (created: TaskProposalResult) => {
				if (!proposals.delete(proposal.id)) return;
				signal.removeEventListener('abort', abort);
				try {
					await emit({ kind: 'task.proposal.resolved', id: proposal.id, task: created });
					resolve(
						created
							? {
									created: true,
									task: { id: created.id, title: created.title },
									start: proposal.start,
								}
							: { created: false, reason: 'The person declined the task or the turn stopped.' }
					);
					if (queue.held?.length) flushHeld(true);
				} catch (e) {
					reject(e);
				}
			};
			proposals.set(proposal.id, { proposal, finish });
			void emit({ kind: 'task.proposal.requested', proposal }).then(() => {
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) abort();
			}, reject);
		});
	}
	/** spec/search-menus-and-commands#agent-command-tools: commands the person let the agent run in this task without their `agentRuns` mark, until the app restarts. */
	const commandGrants = new Set<string>();
	/** Polls the command tab until `done` or the time runs out; a cancelled call stops waiting, not the command. */
	async function untilRun(
		commandId: string,
		ms: number,
		signal: AbortSignal,
		done: (run: TerminalInfo) => boolean
	) {
		for (const end = Date.now() + ms; Date.now() < end && !signal.aborted;) {
			const run = terminals.commandRun(commandId);
			if (!run || done(run)) return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	/** spec/search-menus-and-commands#agent-command-tools: `commands_list`, `commands_run`, `commands_output`, `commands_stop`. Reading needs no permission; running and
	 *  stopping a command without `agentRuns` asks the person once per task, and `Always allow agents` sets the mark. */
	async function commandsTool(
		kind: string,
		params: unknown,
		signal: AbortSignal
	): Promise<unknown> {
		if (!modules.current().commands) throw new Error(moduleOffMessages.commands);
		const commands = (await store.project(config.key.projectId)).commands ?? [];
		const describe = (command: ProjectCommand) => {
			const run = terminals.commandRun(command.id),
				port = run?.run?.port ?? null;
			return {
				id: command.id,
				name: command.name,
				command: command.command,
				repo: command.repo || '.',
				folder: command.directory || '.',
				cwd: join(project.path, commandDirectory(command)),
				agentRuns: command.agentRuns === true,
				state: (run ? runState(run) : null) ?? 'not run',
				...(port !== null ? { port, url: `http://localhost:${port}` } : {}),
				...(run?.exited ? { exitCode: run.exitCode } : {}),
			};
		};
		if (kind === 'list')
			return {
				commands: commands.map(describe),
				note: commands.length
					? "A command runs as a tab in the console of this task, in the person's shell; they see and stop it there. Prefer a saved command to starting the same server or script yourself."
					: 'The project has no saved commands; the person adds them with the Commands button of the toolbar.',
			};
		if (!isRecord(params) || typeof params.id !== 'string')
			throw new Error('Pass the id of a command from commands_list.');
		const command =
			commands.find((item) => item.id === params.id) ??
			commands.find((item) => item.name.toLowerCase() === String(params.id).toLowerCase());
		if (!command) throw new Error(`No saved command ${params.id}. Call commands_list for the ids.`);
		const lines = typeof params.lines === 'number' ? params.lines : 40;
		const answer = async (note?: string) => {
			const run = terminals.commandRun(command.id);
			return {
				...describe(command),
				...(note ? { note } : {}),
				...(run ? { output: await terminals.consoleOutput(run.id, lines) } : {}),
			};
		};
		if (kind === 'output')
			return answer(
				terminals.commandRun(command.id) ? undefined : 'The command has not run in this task.'
			);
		if (kind !== 'run' && kind !== 'stop') throw new Error('Invalid command operation');
		const current = terminals.commandRun(command.id),
			alive = current !== null && !current.exited;
		if (kind === 'stop' && !alive) return answer('The command is not running.');
		if (kind === 'run' && alive && params.restart !== true)
			return answer('The command is already running. Pass restart: true to restart it.');
		if (command.agentRuns !== true && !commandGrants.has(command.id)) {
			// The card shows its title line only: the shell line goes there, the folder into the input.
			const verb = kind === 'stop' ? 'Stop' : alive ? 'Restart' : 'Run',
				line = command.command.trim().replace(/\s*\n\s*/g, ' ');
			const request: PermissionRequest = {
				id: randomUUID(),
				tool: {
					id: randomUUID(),
					title: `${verb} ${command.name} · ${line.length > 200 ? `${line.slice(0, 199)}…` : line}`,
					category: 'execute',
					input: `${command.command}\ncwd: ${describe(command).cwd}`,
				},
				options: [
					{ id: 'task', name: 'Allow in this task', kind: 'allow_once' },
					{ id: 'agents', name: 'Always allow agents', kind: 'allow_always' },
					{ id: 'deny', name: 'Deny', kind: 'reject_once' },
				],
			};
			const decided = permission(request, signal);
			await emit({ kind: 'permission.requested', request });
			const choice = await decided;
			if (choice !== 'task' && choice !== 'agents')
				throw new Error(
					`The person did not allow ${kind === 'stop' ? 'stopping' : 'running'} ${command.name}.`
				);
			commandGrants.add(command.id);
			if (choice === 'agents')
				await store.setProjectCommandAgentRuns(config.key.projectId, command.id, true);
		}
		if (kind === 'stop') {
			await terminals.command({ kind: 'stop', id: current!.id });
			await untilRun(command.id, 6000, signal, (run) => run.exited);
			return answer();
		}
		await terminals.command({ kind: 'run', run: commandRunSpec(command) });
		const wait = typeof params.wait === 'number' ? params.wait : 20;
		await untilRun(command.id, wait * 1000, signal, (run) => run.exited || run.run?.port !== null);
		const run = terminals.commandRun(command.id);
		return answer(
			run && !run.exited && run.run?.port === null
				? `No local address in the output after ${wait} s; the command still runs. Read commands_output later.`
				: undefined
		);
	}
	/** spec/terminal-and-cli-agents#agent-console-tools: `console_list`, `console_read` — the person's console sessions of this task, read only; no module turns them off. */
	async function consoleTool(kind: string, params: unknown): Promise<unknown> {
		const describe = (info: TerminalInfo) => {
			const block = info.block;
			return {
				id: info.id,
				title: info.title,
				folder: info.directory || '.',
				cwd: join(terminals.cwd, info.directory ?? ''),
				state: info.exited ? 'exited' : 'running',
				...(info.exited ? { exitCode: info.exitCode } : {}),
				...(info.run
					? {
							command: {
								id: info.run.commandId,
								name: info.run.name,
								line: info.run.line,
								state: runState(info),
								...(info.run.port !== null ? { url: `http://localhost:${info.run.port}` } : {}),
							},
						}
					: {}),
				...(block
					? {
							lastCommand: {
								line: block.command,
								state: block.exitCode === null ? 'running' : 'done',
								...(block.exitCode === null
									? {}
									: { exitCode: block.exitCode, durationMs: block.duration }),
							},
						}
					: {}),
			};
		};
		const consoles = terminals.consoles();
		if (kind === 'list')
			return {
				consoles: consoles.map(describe),
				note: consoles.length
					? 'Each console is a tab the person sees beside you. Read one with console_read; it shows what the person sees, newest lines last.'
					: 'No console is open in this task. The person opens one with View ▸ Terminal.',
			};
		if (kind !== 'read') throw new Error('Invalid console operation');
		const id = isRecord(params) && typeof params.id === 'string' ? params.id : null;
		const info = id ? consoles.find((item) => item.id === id) : consoles.at(-1);
		if (!info)
			throw new Error(
				id
					? `No console ${id} in this task. Call console_list for the ids.`
					: 'No console is open in this task. The person opens one with View ▸ Terminal.'
			);
		const lines = isRecord(params) && typeof params.lines === 'number' ? params.lines : 80;
		return {
			...describe(info),
			...(!id && consoles.length > 1
				? { note: `The newest of ${consoles.length} consoles; pass id for another.` }
				: {}),
			output: await terminals.consoleOutput(info.id, lines),
		};
	}
	/** spec/projects-and-board#folders-mid-task: the folder joins the task now — scope, lock, write policy; the adapter's roots follow at the turn boundary. */
	async function addTaskFolder(choice: ScopeChoice) {
		if (!snapshots) throw new Error('Snapshots are unavailable');
		await saveFinished;
		// spec/tasks#agent-worktrees: another checkout of the root's repo stands for the root in the composer and the sidebar.
		if (choice.kind === 'external' && choice.path) {
			const root = snapshots.current.scopes.find(
					(scope) => scope.kind === 'root' && scope.available !== false
				),
				of = await worktreeOfRoot(choice.path, root);
			choice = { ...choice, ...(of ? { worktreeOf: of } : {}) };
		}
		if (
			choice.kind === 'external' &&
			scopeOwner &&
			task.launch?.isolation !== 'worktree' &&
			task.readOnlyAgent !== true
		) {
			const paths = [
				...snapshots.current.scopes
					.filter((scope) => writableByAgent(scope))
					.map((scope) => scope.path),
				choice.path!,
			];
			const claim = await scopeLocks.claim(scopeOwner, paths);
			if (!claim.acquired) throw new Error(`${choice.name} is locked by another task.`);
		}
		saving = true;
		const operation = (async () => {
			const revision = snapshots.scopeRevision,
				point = await snapshots.addScope(choice);
			task = await store.task(config.key);
			if (revision !== snapshots.scopeRevision) await emit({ kind: 'scopes.changed' });
			if (point && point.id !== lastCheckpoint) {
				await emit({ kind: 'checkpoint.created', checkpoint: point.id });
				lastCheckpoint = point.id;
			}
		})();
		saveFinished = operation.catch(() => {});
		try {
			await operation;
		} finally {
			saving = false;
		}
		if (transport && task.transport !== 'terminal') rootsStale = true;
		kickPrompts();
	}
	/** spec/projects-and-board#folders-mid-task: `add_folder` — the app registers the folder in the project (spec/projects-and-board#external-folders) and adds it to the task once the person allows;
	 *  spec/agents-and-providers#tool-permissions: a read-only folder asks too, since the agent's own permission card no longer stands before our tools. */
	async function addFolderTool(value: unknown, signal: AbortSignal): Promise<unknown> {
		if (
			!isRecord(value) ||
			typeof value.path !== 'string' ||
			!isAbsolute(value.path) ||
			value.path.includes('\0')
		)
			throw new Error('The folder must be an absolute path.');
		const root = await realpath(project.path),
			canonical = await realpath(value.path).catch(() => null);
		if (!canonical || !(await stat(canonical)).isDirectory())
			throw new Error(`The folder ${value.path} does not exist.`);
		if (canonical === root || canonical.startsWith(`${root}/`))
			throw new Error(
				`The folder ${value.path} is inside the project; its repos are already in the repo list.`
			);
		const known = snapshots?.current.scopes.find(
			(scope) => scope.path === canonical && scope.available !== false
		);
		if (known?.selected)
			return {
				added: false,
				reason: 'The folder is already in the task.',
				name: known.name,
				path: canonical,
				writable: writableByAgent(known),
			};
		if (!ui) throw new Error('A folder joins the task while the Brigadir app is open.');
		const choice = await ui.request('folder', { path: canonical });
		if (!isScopeChoice(choice) || !choice.path) throw new Error('The folder could not be added.');
		const request: PermissionRequest = {
			id: randomUUID(),
			tool: {
				id: randomUUID(),
				title: `Add ${choice.name} to the task${choice.kind === 'external' ? '' : ' · read only'}`,
				category: 'edit',
				input: canonical,
			},
			options: [
				{ id: 'add', name: 'Allow', kind: 'allow_once' },
				{ id: 'deny', name: 'Deny', kind: 'reject_once' },
			],
		};
		const answer = permission(request, signal);
		await emit({ kind: 'permission.requested', request });
		if ((await answer) !== 'add')
			return {
				added: false,
				reason: 'The person declined adding the folder.',
				name: choice.name,
				path: canonical,
			};
		await addTaskFolder(choice);
		const writable = choice.kind === 'external';
		return {
			added: true,
			name: choice.name,
			path: canonical,
			git: writable,
			writable,
			note:
				task.transport === 'terminal'
					? 'Use its absolute path; it is listed in the workspace repositories from your next prompt.'
					: 'Use its absolute path now; your workspace roots include it from your next turn.',
		};
	}
	async function settleCompletedTurn() {
		// Completion is persisted before its status update finishes; honor that boundary for new work.
		if (
			busy &&
			['turn.completed', 'session.failed'].includes(
				records.findLast((r) =>
					['turn.started', 'turn.completed', 'session.failed'].includes(r.event.kind)
				)?.event.kind ?? ''
			)
		)
			await turnFinished;
	}
	function knownPullRequest(scopeId: string) {
		for (let i = records.length - 1; i >= 0; i--) {
			const event = records[i]!.event;
			if (event.kind === 'pull-request.changed' && event.scopeId === scopeId) return event.pr;
		}
		return null;
	}
	async function command(c: SessionCommand) {
		// spec/architecture-and-platform#auto-update: a mark, not activity — it waits for nothing and does not restart the idle clock.
		if (c.kind === 'retire') {
			retiring = true;
			setImmediate(() => {
				void idleTick();
			});
			return;
		}
		// spec/tasks#lock-registry: a forge refresh that repeats the known PR is not activity — it neither journals nor resets the idle clock.
		if (c.kind === 'recordPullRequest' && samePullRequest(knownPullRequest(c.scopeId), c.pr))
			return;
		if (c.kind !== 'recordPullRequest') touchIdle();
		await settleCompletedTurn();
		if (stopping) throw new Error('Host is stopping');
		if (c.kind === 'recordPullRequest') {
			await saveFinished;
			if (!snapshots?.current.scopes.some((scope) => scope.id === c.scopeId))
				throw new Error('Repo is unavailable');
			await emit({ kind: 'pull-request.changed', scopeId: c.scopeId, pr: c.pr });
			return;
		}
		if (saving) throw new Error('A file is being saved');
		if (c.kind === 'answerQuestion') {
			const pending = questions.get(c.id);
			if (!pending || (c.answer !== null && !validAnswer(pending.question, c.answer)))
				throw new Error('Question answer is invalid or already resolved');
			await pending.finish(c.answer);
			return;
		}
		if (c.kind === 'resolveTaskProposal') {
			const pending = proposals.get(c.id);
			if (!pending) throw new Error('The task proposal is already resolved');
			await pending.finish(c.task);
			return;
		}
		if (c.kind === 'decidePlan') {
			if (!crewHost) throw new Error('This task has no crew');
			await crewHost.decidePlan(c.decision);
			return;
		}
		if (c.kind === 'answerCrewQuestion') {
			if (!crewHost) throw new Error('This task has no crew');
			await crewHost.answerQuestion(c.id, c.answer, 'human');
			return;
		}
		if (c.kind === 'answerPermission') {
			const pending = permissions.get(c.id);
			if (
				!pending ||
				(c.optionId !== null && !pending.request.options.some((o) => o.id === c.optionId))
			)
				throw new Error('Permission answer is invalid or already resolved');
			// spec/chat-turns-plans-and-questions#plan-approval: only an approved plan asks for its mode back, and only a mode of the agent's catalog other than the plan's.
			const plan = sessionModes(records).at(-1),
				allowed =
					pending.request.options.find((o) => o.id === c.optionId)?.kind.startsWith('allow') ===
					true;
			const wanted =
				c.returnMode !== undefined &&
				isPlanApproval(pending.request) &&
				allowed &&
				plan !== undefined &&
				plan !== c.returnMode &&
				sessionModeName(records, c.returnMode) !== null
					? c.returnMode
					: undefined;
			if (wanted && plan) modeReturn = { plan, target: wanted };
			await pending.finish(c.optionId, wanted);
			return;
		}
		if (c.kind === 'checkpoint') {
			await checkpoint('refresh');
			return;
		}
		// spec/composer-steering-queue-and-ghost#quick-question: a quick question runs beside the task, so its captures do not wait for the turn; the files are its own.
		if (c.kind === 'quickAsk') {
			if (c.phase === 'before') {
				await checkpoint('quick-before');
				return;
			}
			await checkpoint('quick-after');
			const after = snapshots?.current.checkpoints.at(-1)?.id;
			if (after !== undefined && after > c.before)
				await emit({
					kind: 'quick-ask.changed',
					question: c.question,
					files: c.files,
					before: c.before,
					after,
				});
			return;
		}
		if (c.kind === 'addScope') {
			await addTaskFolder(c.choice);
			return;
		}
		if (c.kind === 'setScope') {
			if (!snapshots) throw new Error('Snapshots are unavailable');
			// ACP roots are negotiated at session creation/load, never changed under a running agent.
			if (ready || startingAgent || transport || terminals.agentAlive())
				throw new Error('Stop the task before changing its repos.');
			saving = true;
			const operation = (async () => {
				const before = snapshots.current.checkpoints.at(-1),
					revision = snapshots.scopeRevision,
					point = await snapshots.setScope(c.update);
				if (busy && point)
					for (const violation of await readOnlyChanges(snapshots.current.scopes, before, point))
						await emit({ kind: 'scope.violation', ...violation });
				task = await store.task(config.key);
				if (revision !== snapshots.scopeRevision) await emit({ kind: 'scopes.changed' });
				if (point && point.id !== lastCheckpoint) {
					await emit({ kind: 'checkpoint.created', checkpoint: point.id });
					lastCheckpoint = point.id;
				}
			})();
			saveFinished = operation.catch(() => {});
			try {
				await operation;
			} finally {
				saving = false;
				kickPrompts();
			}
			return;
		}
		if (c.kind === 'shutdown') {
			setImmediate(() => {
				void stop();
			});
			return;
		}
		if (
			c.kind === 'submitReview' &&
			records.some((r) => r.event.kind === 'turn.started' && r.event.review?.id === c.review.id)
		)
			return;
		if (
			task.transport === 'terminal' &&
			(c.kind === 'submitReview' || c.kind === 'discardQueuedReview')
		) {
			const operation = hookTail.then(async () => {
				const command = c.kind === 'submitReview' ? c : null;
				await atomicJson(queuedReviewPath, { schemaVersion: 1, command });
				queuedReview = command;
			});
			hookTail = operation.catch(() => {});
			await operation;
			return;
		}
		if (c.kind === 'attachContext' || c.kind === 'removeContext') {
			if (task.transport !== 'terminal') throw new Error('This task uses GUI transport');
			const operation = hookTail.then(async () => {
				const ids =
					c.kind === 'attachContext'
						? [...new Set([...(contextQueue?.ids ?? []), c.id])]
						: (contextQueue?.ids ?? []).filter((id) => id !== c.id);
				await assets.resolve(config.key, ids);
				await saveContext(ids.length ? { id: randomUUID(), ids } : null);
			});
			hookTail = operation.catch(() => {});
			await operation;
			return;
		}
		if (c.kind === 'discardQueuedReview') throw new Error('This task uses GUI transport');
		if (task.transport === 'terminal' && c.kind === 'cancel') {
			terminals.interruptAgent();
			await Promise.all([...questions.values()].map((q) => q.finish(null)));
			await Promise.all([...proposals.values()].map((p) => p.finish(null)));
			const interrupted = hookTail.then(() => finishCliTurn(true));
			hookTail = interrupted.catch(() => {});
			await interrupted;
			return;
		}
		if (c.kind === 'retryTurn') return serialPrompt(() => retryTurn(c.reason));
		// The snapshot is `connected` while the adapter still starts: a message sent then waits for it, a failed start answers with its own error.
		if (!transport && startingAgent) {
			await startingAgent;
			if (stopping) throw new Error('Host is stopping');
		}
		if (!transport || !ready) throw new Error('Agent is starting');
		// spec/chat-turns-plans-and-questions#background-commands: Stop on a background command; the turn, if any, goes on.
		if (c.kind === 'stopBackground') {
			if (!liveBackground(records).some((command) => command.id === c.id))
				throw new Error('The background command is not running');
			await transport.send(c);
			return;
		}
		if (c.kind === 'cancel') {
			await Promise.all([...questions.values()].map((q) => q.finish(null)));
			await Promise.all([...proposals.values()].map((p) => p.finish(null)));
			await transport.send(c);
			return;
		}
		if (c.kind === 'pausePromptQueue')
			return serialPrompt(async () => {
				if (queue.prompts.length) await emit({ kind: 'queue.paused' });
			});
		if (c.kind === 'steerQueuedPrompt')
			return serialPrompt(async () => {
				const item = queue.prompts.find((entry) => entry.id === c.id);
				if (!item) throw new Error('The prompt is no longer queued');
				if (
					item.command.kind !== 'prompt' ||
					item.command.crew ||
					!busy ||
					!transport?.steering ||
					queue.paused ||
					quotaBlocked()
				)
					throw new Error('This message cannot go into the running turn');
				await emit({ kind: 'prompt.held', prompt: item });
				heldAt.set(item.id, Date.now());
				turnHeld.add(item.id);
				scheduleHeld();
			});
		if (c.kind === 'removeQueuedPrompt')
			return serialPrompt(async () => {
				if (
					!queue.prompts.some((item) => item.id === c.id) &&
					!queue.held?.some((item) => item.id === c.id)
				)
					throw new Error('The prompt is no longer queued');
				await emit({ kind: 'prompt.removed', id: c.id });
				heldAt.delete(c.id);
				scheduleHeld();
			});
		if (c.kind === 'resumePromptQueue') {
			await serialPrompt(() => emit({ kind: 'queue.resumed' }));
			kickPrompts();
			return;
		}
		if (c.kind === 'prompt' || c.kind === 'submitReview')
			return serialPrompt(async () => {
				if (
					c.kind === 'submitReview' &&
					(records.some(
						(record) =>
							record.event.kind === 'turn.started' && record.event.review?.id === c.review.id
					) ||
						queue.prompts.some(
							(item) =>
								item.command.kind === 'submitReview' && item.command.review.id === c.review.id
						))
				)
					return;
				if (!busy && !queue.prompts.length && !queue.paused && !quotaBlocked()) {
					await beginPrompt(c);
					return;
				}
				if (
					queue.prompts.length >= 32 ||
					queue.prompts.reduce((size, item) => size + item.command.text.length, 0) + c.text.length >
						4_000_000
				)
					throw new Error('The prompt queue is full');
				const attachments = await assets.resolve(
					config.key,
					c.kind === 'prompt' ? (c.attachmentIds ?? []) : []
				);
				transport!.validateAttachments(attachments.map((value) => value.input));
				const prompt: QueuedPrompt = {
					id: randomUUID(),
					command: c,
					attachments: attachments.map((value) => value.attachment),
				};
				// spec/composer-steering-queue-and-ghost#steering: the person's own words reach the running turn; crew reports, reviews and an earlier queue keep their FIFO order.
				// spec/composer-steering-queue-and-ghost#steering-hold: the host holds it until the step boundary (Claude: at most its window), so the person can still edit or remove it.
				if (
					c.kind === 'prompt' &&
					c.steer === true &&
					busy &&
					transport!.steering &&
					!queue.prompts.length &&
					!queue.paused &&
					!quotaBlocked()
				) {
					await emit({ kind: 'prompt.held', prompt });
					heldAt.set(prompt.id, Date.now());
					turnHeld.add(prompt.id);
					scheduleHeld();
					return;
				}
				await emit({ kind: 'prompt.queued', prompt });
				kickPrompts();
			});
		if (busy) throw new Error('Wait for the active turn before changing options');
		if (c.kind === 'setMode' || c.kind === 'setOption') modeReturn = null;
		await transport.send(c);
	}
	/** spec/agents-and-providers#sign-in-recovery: the failed turn again, on a fresh adapter process (a process whose token refresh failed need not reread the
	 *  Keychain). `auth`: sent to every host after a sign-in; a host whose last failure was something else ignores it. */
	async function retryTurn(reason?: 'auth') {
		const boundaries = records.filter((record) =>
				['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(
					record.event.kind
				)
			),
			last = boundaries.at(-1),
			failed = last?.event.kind === 'session.failed' ? last.event : null;
		if (!failed || (reason === 'auth' && failed.reason !== 'auth')) {
			if (reason) return;
			throw new Error('There is no failed turn to retry');
		}
		if (task.transport === 'terminal' || busy || saving)
			throw new Error('The agent is not available');
		const turn = boundaries.at(-2)?.event;
		if (transport) {
			const old = transport;
			transport = null;
			old.close();
		}
		await ensureAgent();
		// spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent began on its own has no prompt to send again.
		if (turn?.kind !== 'turn.started' || turn.origin === 'agent') return;
		await beginPrompt(
			turn.review
				? { kind: 'submitReview', text: turn.text, review: turn.review }
				: {
						kind: 'prompt',
						text: turn.text,
						...(turn.attachments?.length
							? { attachmentIds: turn.attachments.map((item) => item.id) }
							: {}),
						...(turn.crew ? { crew: turn.crew } : {}),
					}
		);
	}
	/** The agent's MCP tools (spec/crew#task-type): the relay session (`serveMcp`) and a per-call `mcp` peer reach the same checks. */
	async function mcpRequest(
		method: string,
		params: unknown,
		signal: AbortSignal
	): Promise<unknown> {
		if (method === 'crew_tool') {
			if (!isCrewToolCall(params)) throw new Error('Invalid crew tool call');
			if (stopping) throw new Error('Host is stopping');
			if (crewHost && params.tool !== 'ask_foreman')
				return crewHost.tool(params.tool, params.params, signal);
			if (crewWorker) return crewWorker.tool(params.tool, params.params, signal);
			throw new Error('This task has no crew');
		}
		// spec/agents-and-providers#tools-awareness: crew workers keep the browser, the simulator and the project commands of their own task.
		if (!humanToolsAllowed(crew?.role ?? null) && !isWorkspaceTool(method))
			throw new Error('Method is not available to this role');
		// spec/pull-requests-and-ci#review-with-agent, spec/pull-requests-and-ci#review-drafts: the PR's drafts file in the project — the one every task shows in its PR panel and «Review ▾» form.
		if (method === 'pr_comment') {
			if (!modules.current().pullRequests) throw new Error(moduleOffMessages.pullRequests);
			const review = task.prReview;
			if (
				review?.mode !== 'review' ||
				!isRecord(params) ||
				typeof params.path !== 'string' ||
				!Number.isSafeInteger(params.line) ||
				typeof params.body !== 'string'
			)
				throw new Error('Method is not available to this task');
			const file = await store.pullRequestFile(
					config.key.projectId,
					'review',
					review.scopeId,
					review.number
				),
				found = await store.readPullRequestDocument(
					config.key.projectId,
					'review',
					review.scopeId,
					review.number
				);
			const current: { drafts: unknown[] } & Record<string, unknown> =
				found && Array.isArray(found.drafts)
					? (found as { drafts: unknown[] } & Record<string, unknown>)
					: { body: '', event: 'COMMENT', drafts: [], sendComments: true, last: null };
			const line = Number(params.line),
				start =
					Number.isSafeInteger(params.startLine) && Number(params.startLine) < line
						? Number(params.startLine)
						: null;
			const draft = {
				id: randomUUID(),
				path: params.path.replace(/^\/+/, ''),
				side: params.side === 'LEFT' ? 'LEFT' : 'RIGHT',
				line,
				startLine: start,
				body: params.body.trim(),
				createdAt: new Date().toISOString(),
				replyTo: null,
				fromAgent: true,
				taskId: config.key.id,
			};
			await atomicJson(file, {
				schemaVersion: 1,
				review: { ...current, drafts: [...current.drafts, draft] },
			});
			return `Draft comment ${draft.id} saved on ${draft.path}:${line}. The person sends the review.`;
		}
		// spec/pull-requests-and-ci#review-with-agent: the agent's answer in the thread of its own draft; `text` rewrites the draft.
		if (method === 'pr_comment_reply') {
			if (!modules.current().pullRequests) throw new Error(moduleOffMessages.pullRequests);
			const review = task.prReview;
			if (
				review?.mode !== 'review' ||
				!isRecord(params) ||
				typeof params.id !== 'string' ||
				typeof params.body !== 'string' ||
				(params.text !== undefined && typeof params.text !== 'string')
			)
				throw new Error('Method is not available to this task');
			const file = await store.pullRequestFile(
					config.key.projectId,
					'review',
					review.scopeId,
					review.number
				),
				found = await store.readPullRequestDocument(
					config.key.projectId,
					'review',
					review.scopeId,
					review.number
				);
			if (!found || !Array.isArray(found.drafts))
				throw new Error(`Draft ${params.id} is not in the review.`);
			const current = found as { drafts: Record<string, unknown>[] } & Record<string, unknown>;
			const at = new Date().toISOString(),
				body = params.body.trim(),
				rewrite = typeof params.text === 'string' && params.text.trim() ? params.text.trim() : null;
			let mine = false;
			const drafts = current.drafts.map((draft) => {
				if (
					draft.id !== params.id ||
					draft.fromAgent !== true ||
					(draft.taskId !== undefined && draft.taskId !== config.key.id)
				)
					return draft;
				mine = true;
				return {
					...draft,
					...(rewrite ? { body: rewrite, updatedByAgent: at } : {}),
					discussion: [
						...(Array.isArray(draft.discussion) ? draft.discussion : []),
						{ from: 'agent', body, at },
					],
				};
			});
			if (!mine) throw new Error(`Draft ${params.id} is not one of your drafts.`);
			await atomicJson(file, { schemaVersion: 1, review: { ...current, drafts } });
			return rewrite
				? `Answered in the thread of ${params.id} and rewrote the draft.`
				: `Answered in the thread of ${params.id}.`;
		}
		// spec/browser-and-simulator#background: the agent asks for the page on screen; «Show» opens the task and its browser.
		if (method === 'browser_show') {
			if (!modules.current().browser) throw new Error(moduleOffMessages.browser);
			if (!ui) throw new Error('The browser needs an open application window');
			const request: PermissionRequest = {
				id: randomUUID(),
				tool: {
					id: randomUUID(),
					name: browserShowCard.tool,
					title: browserShowCard.title,
					category: 'other',
				},
				options: [
					{ id: 'show', name: browserShowCard.show, kind: 'allow_once' },
					{ id: 'decline', name: browserShowCard.decline, kind: 'reject_once' },
				],
			};
			const answer = permission(request, signal);
			await emit({ kind: 'permission.requested', request });
			if ((await answer) !== 'show')
				return 'The human declined to show the page. Keep working with it in the background, or leave this step to the human and say what is left.';
			if (!ui) throw new Error('Browser UI is unavailable');
			return ui.request('browser_show', {});
		}
		if (method.startsWith('browser_')) {
			if (!modules.current().browser) throw new Error(moduleOffMessages.browser);
			if (!ui) throw new Error('The browser needs an open application window');
			const kind = method.slice(8);
			const command = { ...(isRecord(params) ? params : {}), kind };
			if (
				!['open', 'state', 'read', 'console', 'network', 'screenshot', 'ui', 'act'].includes(
					kind
				) ||
				!isBrowserCommand(command)
			)
				throw new Error('Invalid browser operation');
			// spec/task-window-workspace#work-area: the permission is about the page the command goes to — the same tab main resolves.
			const before = await ui.request('browser', {
				kind: 'state',
				...(command.tab && command.tab !== 'new' ? { tab: command.tab } : {}),
			});
			// spec/browser-and-simulator#browser-ui-act: acting on a page is a separate permission from opening it; local pages need none.
			// spec/browser-and-simulator#background: reading the task clipboard does not act on the page; `Allow once` lets one action through.
			if (command.kind === 'act' && command.action !== 'clipboard') {
				const page =
					isRecord(before) && typeof before.url === 'string' ? browserUrl(before.url) : null;
				if (!page) throw new Error('No page is open: call browser_open first.');
				if (
					!localBrowserUrl(page.href) &&
					!actDomains.has(page.hostname) &&
					!(await ui.request('browser_act_allowed', { url: page.href }))
				) {
					const request: PermissionRequest = {
						id: randomUUID(),
						tool: {
							id: randomUUID(),
							title: `Act on ${page.hostname}`,
							category: 'other',
							input: `${command.action} · ${page.href}`,
						},
						options: [
							{ id: 'once', name: 'Allow once', kind: 'allow_once' },
							{ id: 'task', name: 'Allow in this task', kind: 'allow_once' },
							{ id: 'domain', name: 'Allow for domain', kind: 'allow_always' },
							{ id: 'deny', name: 'Deny', kind: 'reject_once' },
						],
					};
					const answer = permission(request, signal);
					await emit({ kind: 'permission.requested', request });
					const choice = await answer;
					if (choice !== 'once' && choice !== 'task' && choice !== 'domain')
						throw new Error(`The human did not allow actions on ${page.hostname}.`);
					if (!ui) throw new Error('Browser UI is unavailable');
					if (choice !== 'once') actDomains.add(page.hostname);
					if (choice === 'domain') await ui.request('browser_act_remember', { url: page.href });
				}
			}
			if (command.kind === 'open') {
				if (!browserUrl(command.url)) throw new Error('Only HTTP and HTTPS pages are supported');
				if (
					!localBrowserUrl(command.url) &&
					!(await ui.request('browser_allowed', { url: command.url }))
				) {
					const request: PermissionRequest = {
						id: randomUUID(),
						tool: {
							id: randomUUID(),
							title: `Open ${browserUrl(command.url)!.hostname}`,
							category: 'read',
							input: command.url,
						},
						options: [
							{ id: 'once', name: 'Allow once', kind: 'allow_once' },
							{ id: 'domain', name: 'Allow for domain', kind: 'allow_always' },
							{ id: 'deny', name: 'Deny', kind: 'reject_once' },
						],
					};
					const answer = permission(request, signal);
					await emit({ kind: 'permission.requested', request });
					const choice = await answer;
					if (choice !== 'once' && choice !== 'domain')
						throw new Error('Browser navigation was denied');
					if (!ui) throw new Error('Browser UI is unavailable');
					if (choice === 'domain') await ui.request('browser_remember', { url: command.url });
				}
			}
			return ui!.request('browser', command);
		}
		// spec/browser-and-simulator#simulator: the simulator lives in the app, like the browser; the host checks the module and forwards the call.
		if (method.startsWith('simulator_')) {
			if (!modules.current().simulator) throw new Error(moduleOffMessages.simulator);
			if (!ui) throw new Error('The simulator needs an open application window');
			// spec/agents-and-providers#tools-awareness: main queues a worker for the one device of the project; the foreman and a solo agent go first.
			return ui.request('simulator', {
				...(isRecord(params) ? params : {}),
				tool: method.slice(10),
				queued: simulatorQueued(crew?.role ?? null),
			});
		}
		// spec/agents-and-providers#context-tools: what the person is looking at; the app answers, and a closed window is an answer, not an error.
		if (method === 'editor_state' || method === 'pr_state') {
			const tool = method === 'editor_state' ? ('editor' as const) : ('pr' as const);
			if (tool === 'pr' && !modules.current().pullRequests)
				throw new Error(moduleOffMessages.pullRequests);
			if (!ui) return contextClosed(tool);
			const asked = ui;
			try {
				return await asked.request('context', { tool });
			} catch (error) {
				/* The window closed while the question was on its way: the same answer as a closed window, not a failed tool. */ if (
					asked.signal.aborted
				)
					return contextClosed(tool);
				throw error;
			}
		}
		// spec/editor-code-intelligence#language-server-restart: the language servers live in the app; it restarts those of this task's open files.
		if (method === 'editor_restart_language_servers') {
			if (!ui) throw new Error('The language servers need the application');
			const result = await ui.request('code_restart', {});
			if (!isRecord(result) || !Array.isArray(result.restarted))
				throw new Error('Invalid language server answer');
			if (result.off === true)
				return { restarted: [], note: 'Language servers are off in Settings ▸ Editor ▸ Code.' };
			return result.restarted.length
				? { restarted: result.restarted }
				: {
						restarted: [],
						note: 'No language server runs for the files open in this task. A server starts with the first file of its language the person opens.',
					};
		}
		// spec/search-menus-and-commands#agent-command-tools: the project's saved commands, run in the console of this task as the toolbar runs them.
		if (method.startsWith('commands_')) return commandsTool(method.slice(9), params, signal);
		// spec/terminal-and-cli-agents#agent-console-tools: the console of this task, as the person sees it.
		if (method.startsWith('console_')) return consoleTool(method.slice(8), params);
		if (method === 'create_task') return proposeTask(params, signal);
		if (method === 'add_folder') return addFolderTool(params, signal);
		if (method !== 'ask_user') throw new Error('Method is not available to this role');
		return ask(params, signal);
	}
	const server = createServer((socket) => {
		let role: 'ui' | 'mcp' | 'hook' | 'crew' | null = null;
		const authTimer = setTimeout(() => socket.destroy(), 5000);
		authTimer.unref();
		const peer = new Peer(socket, async (method, params, signal) => {
			if (!role) {
				if (
					method !== 'handshake' ||
					!isRecord(params) ||
					params.protocolVersion !== 1 ||
					params.instance !== identity.instance ||
					!isRecord(params.key) ||
					params.key.id !== config.key.id ||
					params.key.projectId !== config.key.projectId
				)
					throw new Error('Invalid handshake');
				if (params.role === 'ui' && sameToken(params.token, identity.uiToken)) {
					role = 'ui';
					const previous = ui;
					ui = peer;
					previous?.close();
					terminals.unwatchAll();
					uiVisible = false;
				}
				// `stdio` is `mcp-relay`: after this reply the socket carries the agent's MCP session.
				else if (params.role === 'mcp' && sameToken(params.token, identity.mcpToken)) {
					role = 'mcp';
					if (params.stdio === true)
						peer.handOff(
							serveMcp(
								socket,
								crew?.role ?? null,
								mcpRequest,
								modules,
								task.prReview?.mode === 'review'
							)
						);
				} else if (
					params.role === 'hook' &&
					task.transport === 'terminal' &&
					identity.hookToken &&
					sameToken(params.token, identity.hookToken)
				)
					role = 'hook';
				else if (
					params.role === 'crew' &&
					crewWorker &&
					identity.crewToken &&
					sameToken(params.token, identity.crewToken)
				) {
					role = 'crew';
					crewPeers.add(peer);
					const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
					crewWorker.attach(peer, closed);
				} else throw new Error('Invalid client credentials');
				clearTimeout(authTimer);
				return {
					protocolVersion: 1,
					instance: identity.instance,
					key: config.key,
					startedAt: identity.startedAt,
					...(identity.appVersion ? { appVersion: identity.appVersion } : {}),
				};
			}
			// spec/tasks#lock-registry: `recordPullRequest` resets idle only through its journaled event, never as a bare command.
			if (
				method !== 'status' &&
				method !== 'snapshot' &&
				!(method === 'command' && isRecord(params) && params.kind === 'recordPullRequest')
			)
				touchIdle();
			if (role === 'hook') {
				if (method === 'cli_statusline' && !stopping) return acceptStatusline(params);
				if (method !== 'cli_hook' || stopping)
					throw new Error('Method is not available to this role');
				const accepted = hookTail.then(() => acceptCli(params));
				hookTail = accepted.then((value) => value.after).catch(() => {});
				return accepted.then((value) => value.reply);
			}
			if (role === 'mcp') return mcpRequest(method, params, signal);
			// spec/chat-turns-plans-and-questions#background-commands: the tail of a background command's output — only the file the adapter named for it, read only, at most 64 KB.
			if (method === 'background_output') {
				if (!isRecord(params) || !isBackgroundId(params.id))
					throw new Error('Invalid background command');
				const command = backgroundCommands(records).find((item) => item.id === params.id);
				if (!command) throw new Error('Unknown background command');
				if (!command.outputPath) return { text: '', missing: false };
				let file;
				try {
					file = await openFile(command.outputPath, 'r');
				} catch (error) {
					if (isRecord(error) && error.code === 'ENOENT') return { text: '', missing: true };
					throw error;
				}
				try {
					const info = await file.stat();
					if (!info.isFile()) return { text: '', missing: true };
					const size = Math.min(info.size, backgroundTailBytes),
						buffer = Buffer.alloc(size);
					await file.read(buffer, 0, size, info.size - size);
					return { text: outputTail(buffer.toString('utf8'), info.size > size), missing: false };
				} finally {
					await file.close();
				}
			}
			if (method === 'revert_file' && isRecord(params) && isFileId(params.fileId)) {
				const range = params.range;
				if (
					range !== undefined &&
					range !== 'head' &&
					(!isRecord(range) ||
						!Number.isSafeInteger(range.base) ||
						!Number.isSafeInteger(range.current) ||
						Number(range.base) < 0 ||
						Number(range.current) < Number(range.base))
				)
					throw new Error('Invalid snapshot range');
				await settleCompletedTurn();
				if (!ready || !snapshots || busy || saving || stopping)
					throw new Error('Wait for the agent to finish');
				saving = true;
				const operation = revertTaskFile(
					store,
					config.key,
					snapshots,
					params.fileId,
					range as { base: number; current: number } | 'head' | undefined,
					emit
				);
				saveFinished = operation.catch(() => {});
				try {
					await operation;
					return null;
				} finally {
					saving = false;
					kickPrompts();
				}
			}
			if (method === 'terminal' && isTerminalCommand(params)) {
				if (params.kind === 'run' && !modules.current().commands)
					throw new Error(moduleOffMessages.commands);
				if (params.kind === 'create' && params.role === 'agent') {
					if (task.transport !== 'terminal') throw new Error('This task uses GUI transport');
					await ensureAgent();
				}
				const result = await terminals.command(params);
				if (
					params.kind === 'close-consoles' &&
					!transport &&
					!terminals.agentAlive() &&
					!startingAgent
				) {
					setImmediate(() => {
						void stop('console_closed');
					});
					return { stopping: true };
				}
				return result;
			}
			if (role === 'crew' && !['start_agent', 'snapshot', 'status', 'command'].includes(method))
				throw new Error('Method is not available to this role');
			// Main says whether this task is the selected one; a selected task never stops for idleness.
			if (method === 'visible') {
				if (role !== 'ui' || !isRecord(params) || typeof params.visible !== 'boolean')
					throw new Error('Invalid visibility');
				uiVisible = params.visible;
				return null;
			}
			if (method === 'start_agent') {
				if (
					!isRecord(params) ||
					(params.allowScopeConflict !== undefined &&
						typeof params.allowScopeConflict !== 'boolean')
				)
					throw new Error('Invalid start request');
				await ensureAgent(params.allowScopeConflict === true);
				return { accepted: true };
			}
			if (method === 'save_file' && isSaveFileRequest(params)) {
				await settleCompletedTurn();
				// spec/editor#save-during-turn: Save during a turn waits for its end instead of refusing.
				if (
					params.afterTurn &&
					ready &&
					snapshots &&
					!stopping &&
					(busy || saving || heldSaves.size)
				) {
					const result = holdSave(params);
					kickPrompts();
					return await result;
				}
				if (!ready || !snapshots || busy || saving || stopping)
					throw new Error('Wait for the agent to finish');
				saving = true;
				const operation = saveTaskFile(store, config.key, snapshots, params, emit);
				saveFinished = operation.catch(() => {});
				try {
					return await operation;
				} finally {
					saving = false;
					kickPrompts();
				}
			}
			// A few numbers instead of the whole journal: callers that only ask "is it up, has it started" poll this.
			if (method === 'status') return hostStatus(records, ready);
			// `afterSeq` sends only the tail; seq equals index + 1 in a validated journal. A tail past the end is the state without records.
			if (method === 'snapshot') {
				const after =
					isRecord(params) && Number.isSafeInteger(params.afterSeq) && Number(params.afterSeq) > 0
						? Number(params.afterSeq)
						: 0;
				return {
					key: config.key,
					records: after ? records.slice(Math.min(after, records.length)) : records,
					connected: ready,
					issue: null,
					pendingAttachments,
					...(queuedReview ? { pendingReview: queuedReview.review } : {}),
				};
			}
			if (method === 'command' && isSessionCommand(params)) {
				await command(params);
				return { accepted: true };
			}
			throw new Error('Invalid command');
		});
		peers.add(peer);
		socket.once('close', () => {
			clearTimeout(authTimer);
			peers.delete(peer);
			crewPeers.delete(peer);
			if (ui === peer) {
				ui = null;
				terminals.unwatchAll();
				uiVisible = false;
			}
		});
	});
	let resolveClosed: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	async function stop(reason = 'shutdown') {
		if (stopping) return closed;
		stopping = true;
		for (const held of heldSaves.values()) held.reject(new Error('Host is stopping'));
		heldSaves.clear();
		clearTimeout(rateTimer);
		clearInterval(idleTimer);
		clearInterval(orphanTimer);
		stopScopeWatch();
		try {
			await scopeRefresh;
			await saveFinished;
			await agentFileTail.catch(() => {});
			await hookTail;
			await toolCapture;
			await promptTail.catch(() => {});
			await Promise.all([...questions.values()].map((q) => q.finish(null)));
			await Promise.all([...proposals.values()].map((p) => p.finish(null)));
			await Promise.all([...permissions.values()].map((p) => p.finish(null)));
			crewWorker?.stop();
			await crewHost?.stop().catch(() => {});
			terminals.closeAll();
			transport?.close();
			if (transport) await transport.closed;
			// spec/chat-turns-plans-and-questions#background-commands: nothing is stopped on purpose; what ran in the background is journaled as stopped with the host.
			for (const command of liveBackground(records))
				await emit({
					kind: 'background.changed',
					id: command.id,
					state: 'stopped',
					reason: 'closed',
				});
			await emit({ kind: 'host.stopped', reason });
		} finally {
			modules.close();
			for (const peer of peers) peer.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			// spec/architecture-and-platform#host-lifecycle: the task dir may already be gone; the locks go best effort and the host always closes.
			try {
				await writer.close().catch(() => {});
				await unlink(identity.socket).catch(() => {});
				try {
					await releaseScopes();
				} finally {
					await release();
				}
			} finally {
				resolveClosed!();
			}
		}
	}
	/** spec/architecture-and-platform#host-lifecycle: nothing to do for `idleMs` → the same graceful stop as Stop. The repo locks go with the host; the journal keeps the session. */
	function idleState() {
		return {
			background: liveBackground(records).length > 0,
			terminal: task.transport === 'terminal',
			busy,
			starting: startingAgent !== null,
			saving,
			inputs: permissions.size + questions.size + proposals.size,
			queued: queue.prompts.length,
			quota: quotaBlocked(),
			consoles: terminals.consolesAlive(),
			visible: uiVisible,
			crew: crewWorker
				? ('worker' as const)
				: crewHost
					? crewHost.settled()
						? ('settled' as const)
						: ('active' as const)
					: ('none' as const),
		};
	}
	async function idleTick() {
		if (stopping || idleChecking) return;
		// spec/architecture-and-platform#auto-update: a host of an older app stops like an idle stop as soon as nothing runs — the task being on screen does not keep it.
		if (retiring && !idleBlocker({ ...idleState(), visible: false })) {
			idleChecking = true;
			try {
				const current = await store.task(config.key);
				if (!stopping && !idleBlocker({ ...idleState(), visible: false, status: current.status }))
					await stop(hostUpdateReason);
			} catch {
				/* the task file is busy or gone: the next tick looks again */
			} finally {
				idleChecking = false;
			}
			return;
		}
		if (idleBlocker(idleState())) {
			idleSince = null;
			return;
		}
		const now = Date.now();
		if (idleSince === null) {
			idleSince = now;
			return;
		}
		if (now - idleSince < idleMs) return;
		idleChecking = true;
		try {
			const since = idleSince,
				current = await store.task(config.key);
			if (
				!stopping &&
				idleSince === since &&
				!idleBlocker({ ...idleState(), status: current.status })
			)
				await stop(hostIdleReason);
			else idleSince = null;
		} catch {
			idleSince = null;
		} finally {
			idleChecking = false;
		}
	}
	async function startAgent(allowConflict = false) {
		if (!task.provider) throw new Error('Task has no provider');
		await saveFinished;
		// spec/pull-requests-and-ci#review-with-agent: an agent that writes no code (quick review, crew reviewer) holds no repo lock.
		if (task.launch?.isolation !== 'worktree' && task.readOnlyAgent !== true) {
			scopeOwner ??= await scopeLocks.owner(config.key);
			const paths =
				snapshots?.current.scopes
					.filter((scope) => writableByAgent(scope))
					.map((scope) => scope.path) ?? [];
			const claim = await scopeLocks.claim(
				scopeOwner,
				paths,
				allowConflict || initialScopeOverride
			);
			initialScopeOverride = false;
			if (!claim.acquired) throw new Error('A workspace repo is locked by another task.');
		}
		if (task.transport === 'terminal') {
			await hookTail;
			await promptTail.catch(() => {});
			const previous = records.findLast((r) => r.event.kind === 'session.started')?.event;
			sentScopeContext = '';
			cliBriefSent = previous?.kind === 'session.started';
			terminals.configureAgent(
				await cliLaunch(
					store,
					task,
					identity,
					config.mcpEntry,
					config.runtime ?? process.execPath,
					previous?.kind === 'session.started' ? previous.sessionId : undefined,
					crew?.role,
					terminals.cwd
				)
			);
			cliSession = undefined;
			await terminals.command({ kind: 'create', role: 'agent' });
			ready = true;
			return;
		}
		const previous = records.findLast((r) => r.event.kind === 'session.started')?.event;
		const stale = pendingInputs(records);
		for (const q of stale.questions)
			await emit({ kind: 'question.resolved', id: q.id, answer: null });
		for (const p of stale.proposals)
			await emit({ kind: 'task.proposal.resolved', id: p.id, task: null });
		for (const p of stale.permissions)
			await emit({ kind: 'permission.resolved', id: p.id, optionId: null });
		let replaying = previous?.kind === 'session.started';
		sentScopeContext = '';
		briefPending = !replaying;
		transport = await AgentTransport.start({
			provider: task.provider!,
			cwd: project.path,
			additionalDirectories: scopeDirectories(snapshots?.current.scopes ?? []),
			...(config.adapter ? { adapter: config.adapter } : {}),
			readTextFile: (path, line, limit) => agentFiles.read(path, line, limit),
			writeTextFile: (path, content) => {
				const operation = agentFileTail
					.catch(() => {})
					.then(async () => {
						await saveFinished.catch(() => {});
						if (!busy || stopping || saving)
							throw new Error('The agent is not available for a file write');
						saving = true;
						const write = (async () => {
							/* A write touches one repo; the next full checkpoint takes the rest. */ const scopeIds =
								await snapshots?.scopesFor(path);
							await checkpoint('tools', scopeIds);
							await agentFiles.write(path, content);
							await checkpoint('tools', scopeIds);
						})();
						saveFinished = write.catch(() => {});
						try {
							await write;
						} finally {
							saving = false;
							kickPrompts();
						}
					});
				agentFileTail = operation;
				return operation;
			},
			...(previous?.kind === 'session.started' ? { resumeSessionId: previous.sessionId } : {}),
			mcpServers: [
				{
					name: 'brigadir',
					command: config.mcpEntry,
					args: [],
					env: [
						{ name: 'BRIGADIR_HOST_SOCKET', value: identity.socket },
						{ name: 'BRIGADIR_HOST_INSTANCE', value: identity.instance },
						{ name: 'BRIGADIR_MCP_TOKEN', value: identity.mcpToken },
						{ name: 'BRIGADIR_PROJECT_ID', value: config.key.projectId },
						{ name: 'BRIGADIR_TASK_ID', value: config.key.id },
						...(crew ? [{ name: 'BRIGADIR_ROLE', value: crew.role }] : []),
					],
				},
			],
			onEvent: async (event) => {
				if (replaying && event.kind !== 'session.started') return;
				replaying = false;
				const newlyCompleted =
					event.kind === 'tool.changed' &&
					event.patch.status === 'completed' &&
					!completedTools.has(event.patch.id);
				if (newlyCompleted && event.kind === 'tool.changed') {
					completedTools.add(event.patch.id);
					toolCount++;
				}
				// spec/composer-steering-queue-and-ghost#steering-hold: a top-level tool that finished is the step boundary for held messages; a subagent's tools are not.
				let boundary = false;
				if (event.kind === 'tool.changed') {
					if (event.patch.parentId || event.subagentId) childTools.add(event.patch.id);
					if (
						['completed', 'failed'].includes(event.patch.status ?? '') &&
						!childTools.has(event.patch.id) &&
						!boundaryTools.has(event.patch.id)
					) {
						boundaryTools.add(event.patch.id);
						boundary = true;
					}
				}
				if (event.kind === 'turn.completed') await agentFileTail.catch(() => {});
				if (event.kind === 'turn.completed' || (newlyCompleted && toolCount % 5 === 0)) {
					try {
						await checkpoint(event.kind === 'turn.completed' ? 'turn' : 'tools');
					} catch (e) {
						await emit({
							kind: 'snapshot.failed',
							message: e instanceof Error ? e.message : 'Snapshot failed',
						});
					}
				}
				await emit(event);
				if (boundary && queue.held?.length) flushHeld(true);
				// spec/chat-turns-plans-and-questions#plan-approval: the agent left the plan's mode; bring back the one the person had, unless it is already there.
				const mode = recordModeId(event);
				if (modeReturn && mode !== null && mode !== modeReturn.plan) {
					const target = modeReturn.target;
					modeReturn = null;
					if (mode !== target) void returnMode(target);
				}
				if (event.kind === 'turn.completed' || event.kind === 'session.failed') modeReturn = null;
			},
			requestPermission: permission,
			preapprove: (request) =>
				skipsAgentPermission(request.tool)
					? (request.options.find((o) => o.kind === 'allow_once')?.id ?? null)
					: null,
			// spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent began on its own (Claude Code after a background task) is a turn: the same checkpoint, status,
			// busy and end as one the person started, without their row. A prompt of the host that is starting takes it over.
			agentTurn: async (finished) => {
				// The previous turn may have ended a moment ago, its `busy` not yet released; a prompt the host is starting owns it.
				if (busy && !starting) await turnFinished.catch(() => {});
				if (busy || starting || stopping) return false;
				busy = true;
				const gen = ++turnGen;
				completedTools.clear();
				childTools.clear();
				boundaryTools.clear();
				turnHeld.clear();
				toolCount = 0;
				try {
					try {
						await checkpoint('turn');
					} catch (error) {
						await emit({
							kind: 'snapshot.failed',
							message: error instanceof Error ? error.message : 'Snapshot failed',
						});
					}
					await emit({ kind: 'turn.started', text: '', origin: 'agent' });
				} catch (error) {
					if (turnGen === gen) busy = false;
					throw error;
				}
				turnFinished = finished
					.catch(() => {})
					.finally(() => {
						if (turnGen === gen && !steerPending) busy = false;
						kickPrompts();
					});
				return true;
			},
		});
		ready = true;
		kickPrompts();
		// spec/agents-and-providers#sign-in-recovery: `retryTurn` closes this process on purpose; only the current transport's exit stops the host.
		const current = transport;
		void current.closed.then(() => {
			if (!stopping && transport === current) void stop('transport_closed');
		});
	}
	try {
		// A new owner cannot resume the old process's in-flight turn. Preserve history
		// but close its live state before accepting clients or draining queued work.
		if (
			records.findLast((record) =>
				['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(
					record.event.kind
				)
			)?.event.kind === 'turn.started'
		) {
			await emit({
				kind: 'host.stopped',
				reason: 'The previous host exited during an active turn.',
			});
			// spec/composer-steering-queue-and-ghost#steering-hold: messages the old host still held go to the FIFO, which then pauses with them.
			for (const item of queue.held ?? []) await queueHeld(item);
			if (queue.prompts.length && !queue.paused && !quotaBlocked())
				await emit({ kind: 'queue.paused' });
			if (!['backlog', 'completed'].includes(task.status)) {
				await store.setStatus(config.key, quotaBlocked() ? 'rate-limited' : 'interrupted');
				await store.updateTask(config.key, { activitySeq: records.at(-1)!.seq });
			}
		}
		// spec/chat-turns-plans-and-questions#background-commands: a previous host that exited under a background command left it without an end; this adapter is new.
		for (const command of liveBackground(records))
			await emit({
				kind: 'background.changed',
				id: command.id,
				state: 'stopped',
				reason: 'restarted',
			});
		contextPath = await safePath(await store.taskDir(config.key), 'cli-context.json');
		try {
			const doc = await readDocument(contextPath);
			if (doc.queue !== null) {
				if (
					!isRecord(doc.queue) ||
					!isAttachmentId(doc.queue.id) ||
					!isAttachmentIds(doc.queue.ids)
				)
					throw new Error('Invalid context queue');
				const queue = { id: doc.queue.id, ids: doc.queue.ids };
				if (
					!records.some(
						(record) =>
							record.event.kind === 'turn.started' && record.event.attachmentBatchId === queue.id
					)
				) {
					pendingAttachments = (await assets.resolve(config.key, queue.ids)).map(
						(value) => value.attachment
					);
					contextQueue = queue;
				}
			}
		} catch (e) {
			if (!isRecord(e) || e.code !== 'ENOENT') throw e;
		}
		queuedReviewPath = await safePath(await store.taskDir(config.key), 'cli-review.json');
		try {
			const doc = await readDocument(queuedReviewPath, 8 * 1024 * 1024);
			if (
				doc.command !== null &&
				(!isSessionCommand(doc.command) || doc.command.kind !== 'submitReview')
			)
				throw new Error('Invalid queued review');
			if (
				doc.command &&
				isSessionCommand(doc.command) &&
				doc.command.kind === 'submitReview' &&
				!records.some(
					(r) =>
						r.event.kind === 'turn.started' &&
						r.event.review?.id ===
							(doc.command as Extract<SessionCommand, { kind: 'submitReview' }>).review.id
				)
			)
				queuedReview = doc.command;
		} catch (e) {
			if (!isRecord(e) || e.code !== 'ENOENT') throw e;
		}
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(identity.socket, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		await chmod(identity.socket, 0o600);
		await saveIdentity(store, identity);
		// spec/architecture-and-platform#host-lifecycle: a deleted task dir or socket means nobody reaches this host again; no idle blocker keeps it.
		const taskDir = await store.taskDir(config.key),
			taskMark = await dirMark(taskDir);
		let orphanChecking = false;
		orphanTimer = setInterval(() => {
			if (stopping || orphanChecking) return;
			orphanChecking = true;
			void orphaned(taskDir, taskMark, identity.socket)
				.then(
					(gone) => {
						if (gone && !stopping) return stop('orphaned');
					},
					() => {}
				)
				.catch(() => {})
				.finally(() => {
					orphanChecking = false;
				});
		}, orphanCheckMs);
		orphanTimer.unref();
		snapshots = await Snapshots.open(store, config.key);
		await checkpoint('baseline');
		// spec/tasks#agent-worktrees: the worktrees that exist now are the baseline, never adopted.
		adopting = newWorktrees.found(agentRepos()).then(
			() => {},
			() => {}
		);
		// Discovery only when a repo may have appeared or gone; a HEAD change of a known repo snapshots only that repo.
		stopScopeWatch = watchScopes(
			project.path,
			(change) => {
				scopeRefresh = (async () => {
					await saveFinished;
					if (stopping) return;
					const options = snapshots?.refreshOptions(change) ?? {};
					try {
						await checkpoint('refresh', options.scopeIds, options.discover);
					} catch (error) {
						if (!stopping) await emit({ kind: 'snapshot.failed', message: String(error) });
					}
				})();
				return scopeRefresh;
			},
			() => snapshots?.current.scopes.map((scope) => scope.path) ?? []
		);
		if (crew && (crew.role === 'foreman' || crew.role === 'lead')) {
			crewHost = new CrewHost({
				store,
				key: config.key,
				context: crew,
				services: {
					dataDir: config.dataDir,
					mcpEntry: config.mcpEntry,
					runtime: config.runtime ?? process.execPath,
					...(config.adapter ? { adapter: config.adapter } : {}),
				},
				emit,
				records: () => records,
				parent: () => crewWorker?.request() ?? null,
				prompt: (text, marker) =>
					command({ kind: 'prompt', text, ...(marker ? { crew: marker } : {}) }),
			});
			await crewHost.start();
		}
		await crewWorker?.start();
		ready = true;
		if (!config.consoleOnly) await ensureAgent();
		scheduleRateReset();
		if (!stopping)
			idleTimer = setInterval(
				() => {
					void idleTick();
				},
				Math.max(10, Math.min(60_000, Math.floor(idleMs / 4)))
			);
		idleTimer?.unref();
	} catch (e) {
		try {
			await emit({
				kind: 'session.failed',
				message: e instanceof Error ? e.message : 'Agent startup failed',
				...(isAuthRequired(e) ? { reason: 'auth' as const } : {}),
			});
		} finally {
			await stop('startup_failed');
		}
		throw e;
	}
	return {
		identity,
		closed,
		stop,
		get adapterInfo() {
			return transport?.info ?? null;
		},
		get records(): readonly EventRecord[] {
			return records;
		},
	};
}
import { relayContext } from './relay-context';
