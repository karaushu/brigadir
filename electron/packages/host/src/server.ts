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
	statusAfterStop,
	workspaceStoppedLimit,
	type WorkspaceStopped,
	statusAfterTurn,
	lastTurnPlanReturned,
	queuedCrewQuestion,
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
	runningHires,
	smokeReviewParagraph,
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
	taskReviewers,
	taskReviewSpec,
	taskReviewRootName,
	specAgents,
	type CrewSpec,
	builtinAgentTemplates,
	isCrewPartBrief,
	providerName,
	resolveCrewAgent,
	templateLookup,
} from '@brigadir/core';
import { browserUrl, localBrowserUrl } from './browser-url';
import { Terminals } from './terminals';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { chmod, open as openFile, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
	backgroundCommands,
	backgroundSummary,
	backgroundTailBytes,
	isBackgroundId,
	liveBackground,
	liveBackgroundSubagents,
	runningSubagents,
	outputTail,
	isPlanApproval,
	planApprovalText,
	planAsks,
	planAsksBrief,
	planChatPrompt,
	planRejectOption,
	splitPlanMarkdown,
	figmaLinks,
	type CrewPlan,
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
	type CrewAssignment,
	type TaskKey,
	type UserQuestion,
	changeSize,
	isMainTree,
} from '@brigadir/core';
import {
	readOnlyChanges,
	watchScopes,
	Snapshots,
	worktreeOfRoot,
	readChanges,
} from '@brigadir/git';
import {
	Attachments,
	SessionStore,
	ProcessCoordinator,
	atomicJson,
	safePath,
	readDocument,
	applyMetroPort,
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
	autoSpecWithReviewers,
	sessionBrief,
	crewLinkEvents,
	CrewHost,
	CrewWorker,
	isCrewToolCall,
	crewHiddenTools,
	partBrief,
	reviewerAnswerOnly,
	type CrewContext,
} from './crew';
import {
	TaskReviewLife,
	closureWaitsForCrew,
	ownReviewCrew,
	ownReviewTool,
	type PresentedPlan,
} from './task-review';
import { TaskClassLife, readSmallTaskLimit } from './task-class';
import { PlanModeLife } from './plan-mode';
import { SmokeLife, readSmokeMinutes } from './smoke';
/** spec/smoke-run#start: the smoke run's tools and `ready_to_look`, also of a crew developer. */
const smokeTools: ReadonlySet<string> = new Set(['smoke_start', 'smoke_report', 'ready_to_look']);
import { readTaskSources, saveTaskSource, sourcePath } from './task-sources';
import { saveShot, submitDesignReview } from './design-review';
import {
	assignmentBlock,
	compactionDue,
	humanToolsAllowed,
	isWorkspaceTool,
	simulatorQueued,
} from '@brigadir/orchestrator';
import { hiddenToolMessages, serveMcp, type HiddenToolSource } from './mcp';
import { AutoCrewHost } from './auto-crew';
import { ModuleSettings } from './modules';
import { claudeSubagentModel, compactionWindow } from './agent-settings';
import { TaskBudget } from './task-budget';
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
	// spec/tasks#quick-tasks: the main tree has no provider; its host runs only consoles, and `startAgent` refuses.
	if (!task.provider && !config.consoleOnly) throw new Error('Task has no provider');
	const release = await acquireOwner(
		store,
		config.key,
		join(dirname(config.mcpEntry), 'process-owner')
	);
	let project: Awaited<ReturnType<SessionStore['projectForTask']>>;
	try {
		// spec/crew#auto-move: a move that stopped while it rewrote the task's documents is finished by the task's owner, before anything reads
		// the task's folder.
		await finishSwitch(store, config.key);
		task = await store.task(config.key);
		project = await store.projectForTask(config.key);
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
	// spec/crew-templates-and-editor#snapshot: a foreman task carries its crew; a worker points at the crew task. Both get their role brief as the session brief (spec/agents-and-providers#session-brief); every session gets the checklist sentence (spec/chat-turns-plans-and-questions#checklist-tools), a Claude session the plan sentence (spec/chat-turns-plans-and-questions#plan-approval).
	const crew = await readCrewContext(store, task).catch(async (error) => {
		await writer.close();
		await release();
		throw error;
	});
	let briefPending = false,
		cliBriefSent = false;
	/** spec/crew#assignment-after-compaction: the newest compaction of a crew member's session that no assignment block answered yet. */
	let assignmentDue = crew && task.transport !== 'terminal' ? compactionDue(records) : null;
	const crewWorker = crew?.parentKey ? new CrewWorker(store, config.key, crew) : null;
	let crewHost: CrewHost | null = null;
	/** spec/reviews#points: the task's review before the PR; a solo task gets a crew host of its reviewers when one starts. An Auto task keeps its reviewers in its own crew. */
	const foremanTask = !!crew && (crew.role === 'foreman' || crew.role === 'auto'),
		autoTask = crew?.role === 'auto';
	/** spec/reviews#plan-review: the root foreman's split that waits for the person (a lead's plan is approved by the host). */
	let waitingSplit: CrewPlan | null = null;
	/** spec/reviews#plan-start: the plan that waits for the person now — a solo task's plan for approval or the root foreman's split. */
	const planWaiting = (): PresentedPlan | null => {
		// An Auto task plans like a solo task (plan approval); only a named crew's foreman presents a split.
		if (crew?.role === 'foreman') {
			if (!waitingSplit) return null;
			const requests = records.filter((record) => record.event.kind === 'crew.plan.requested');
			return {
				kind: 'split',
				id: waitingSplit.id,
				revision: Math.max(1, requests.length),
				text: splitPlanMarkdown(waitingSplit, crew?.spec.root.agents ?? []),
			};
		}
		const pending = [...permissions.values()].find((item) => isPlanApproval(item.request));
		if (!pending) return null;
		const presented = records.filter(
			(record) =>
				record.event.kind === 'permission.requested' && isPlanApproval(record.event.request)
		);
		const at = presented.findLast(
			(record) =>
				record.event.kind === 'permission.requested' &&
				record.event.request.id === pending.request.id
		);
		const text = planApprovalText(pending.request, records, at?.seq ?? Number.MAX_SAFE_INTEGER);
		if (!text) return null;
		return {
			kind: 'approval',
			id: pending.request.id,
			revision: Math.max(1, at ? presented.indexOf(at) + 1 : presented.length),
			text,
		};
	};
	const taskReview: TaskReviewLife = new TaskReviewLife({
		store,
		key: config.key,
		emit: (event) => emit(event),
		records: () => records,
		busy: () => busy,
		foreman: closureWaitsForCrew(crew?.role ?? null),
		existing: () => crewHost,
		settled: () => crewHost?.settled() ?? true,
		submitReview: (text, review, round) =>
			command({
				kind: 'submitReview',
				text,
				review,
				crew: { kind: 'review-comments', round, comments: review.comments.length },
			}),
		// spec/reviews#who: the app resolves the reviewer from the settings, sign-ins and catalogs; without a window, a fresh session of the task's own provider.
		resolve: async (point, auto) => {
			// spec/reviews#plan-start: a plan review the host starts by itself needs the app's answer — it reads `Plan review`; with no app
			// attached, or no answer, none starts.
			if (auto && !ui) return { off: true };
			if (ui) {
				const answer = await ui
					.request('review_reviewer', { point, ...(auto ? { auto: true } : {}) })
					.catch(() => null);
				if (isRecord(answer) && answer.off === true) return { off: true };
				if (isRecord(answer) && typeof answer.failure === 'string')
					return { failure: answer.failure };
				if (isSessionCommand(answer) && answer.kind === 'startReview') return answer;
				if (auto) return { off: true };
			}
			const provider = (await store.task(config.key)).provider ?? 'claude';
			return {
				kind: 'startReview',
				reviewers: [
					resolveCrewAgent(
						{ id: 'reviewer', name: providerName(provider), template: 'reviewer', provider },
						{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: provider },
						[],
						false
					),
				],
				who: { kind: 'agent' },
				instructions: '',
				guidance: '',
				reviewer: { provider, model: null, effort: null, source: 'same' },
			};
		},
		changes: () =>
			readChanges(store, config.key)
				.then((value) => value.files.length)
				.catch(() => 0),
		checkpoint: () => checkpoint('tools'),
		planWaiting,
		// spec/reviews#plan-loop: the findings answer the waiting plan — its reject option (else it is cancelled), or the foreman's propose_plan — and run after the turn.
		planFeedback: async (text, review, round) => {
			// spec/reviews#plan-loop: a batch of a review the plan's approval ended is not sent.
			if (!taskReview.planBatchLive(review.id)) return 'dropped';
			if (foremanTask && (await crewHost?.rejectPlanForReview(text))) return 'answered';
			// An Auto task plans like a solo task (`planWaiting`): its plan waits as a plan approval, and with that request
			// open the turn never ends, so a batch that only queued would never run.
			const pending = [...permissions.values()].find((item) => isPlanApproval(item.request));
			if (pending) {
				await pending.finish(planRejectOption(pending.request)?.id ?? null);
				planAnswered.add(review.id);
			}
			if (!taskReview.planBatchLive(review.id)) {
				planAnswered.delete(review.id);
				return 'dropped';
			}
			// With no split waiting (the person rejected it meanwhile) the foreman gets the batch as its next turn too.
			await command({
				kind: 'submitReview',
				text,
				review,
				crew: { kind: 'review-comments', round, comments: review.comments.length },
			});
			return 'queued';
		},
		dropBatch: (batch) =>
			serialPrompt(async () => {
				for (const item of [...queue.prompts, ...(queue.held ?? [])])
					if (item.command.kind === 'submitReview' && item.command.review.id === batch)
						await emit({ kind: 'prompt.removed', id: item.id });
			}),
		prompt: (text) => command({ kind: 'prompt', text, crew: { kind: 'review-continue' } }),
		// spec/reviews#reviewer-sessions: the task's first prompt, and a crew worker's part with its acceptance criteria.
		brief: async () => {
			const first = records.find(
				(record) =>
					record.event.kind === 'turn.started' && !record.event.crew && !record.event.review
			);
			const prompt = first?.event.kind === 'turn.started' ? first.event.text.trim() : '',
				part = crewWorker ? await readPartBrief() : null;
			return [
				prompt && !part
					? `\nThe task as the person gave it:\n<task_prompt>\n${prompt.slice(0, 20_000)}\n</task_prompt>`
					: '',
				part ? partBrief(crew?.node.name ?? 'the developer', part) : '',
			].join('');
		},
		part: async () => (crewWorker ? ((await readPartBrief())?.part ?? null) : null),
		planAsks: () => planAsksBrief(planAsks(records)),
		// spec/design-review#design-source: Figma links of the task's prompt (a worker's part), its saved sources and the plans it presented.
		// spec/reviews#smoke: with the browser or the simulator on, the reviewer reads the newest smoke report.
		// A crew worker's part is not the integrated work: its reviewer gets no smoke paragraph (spec/reviews#smoke).
		smoke: () =>
			!crew?.parentKey && (modules.current().browser || modules.current().simulator)
				? smokeReviewParagraph(records)
				: '',
		designLinks: async () => {
			const texts = records.flatMap((record) => {
				const event = record.event;
				if (event.kind === 'turn.started' && !event.crew && !event.review) return [event.text];
				if (event.kind === 'permission.requested' && isPlanApproval(event.request))
					return [planApprovalText(event.request, records, record.seq) ?? ''];
				if (event.kind === 'crew.plan.requested')
					return [splitPlanMarkdown(event.plan, crew?.spec.root.agents ?? [])];
				return [];
			});
			const part = crewWorker ? await readPartBrief() : null;
			if (part) texts.push(part.prompt);
			for (const entry of (await readTaskSources(store, config.key)).sources)
				texts.push(
					entry.url ?? '',
					await readFile(await sourcePath(store, config.key, entry), 'utf8').catch(() => '')
				);
			return [...new Set(texts.flatMap((item) => figmaLinks(item)))].slice(0, 20);
		},
		crew: async (start, named): Promise<CrewHost> => {
			const current = await store.task(config.key),
				existing = current.crew ?? current.reviewCrew,
				reviewers = taskReviewers(
					start.reviewers,
					`review-${Date.now().toString(36)}`,
					existing ? specAgents(existing.root).map((agent) => agent.name) : [taskReviewRootName]
				);
			named?.(reviewers.map((agent) => agent.name));
			if (foremanTask && crewHost && current.crew) {
				const spec = {
					...current.crew,
					root: {
						...current.crew.root,
						agents: [...current.crew.root.agents, ...reviewers],
						checkedBy: reviewers.map((agent) => agent.id),
					},
				};
				await store.updateTask(config.key, { crew: spec });
				crewHost.adoptSpec(spec);
				return crewHost;
			}
			// Earlier reviewers stay in the spec, unchecked: their tasks keep a crew to read.
			const spec = taskReviewSpec(current.provider ?? 'claude', reviewers);
			if (current.reviewCrew) spec.root.agents = [...current.reviewCrew.root.agents, ...reviewers];
			await store.updateTask(config.key, { reviewCrew: spec });
			// spec/crew#auto-root: before its first hire an Auto task's crew is its agent; the reviewers join it there, so a hire keeps them.
			if (autoTask && crewHost) {
				crewHost.adoptSpec(autoSpecWithReviewers({ ...current, reviewCrew: spec }));
				return crewHost;
			}
			if (crewHost) {
				crewHost.adoptSpec(spec);
				return crewHost;
			}
			crewHost = await crewHostFor(selfContext(spec));
			return crewHost;
		},
	});
	/** spec/reviews#classes: a solo task or an Auto agent that writes code has a class; a foreman, a worker and a reviewer have none. */
	const classTask =
		(!crew || crew.role === 'auto') && task.readOnlyAgent !== true && !isMainTree(config.key);
	/** spec/reviews#plan-mode: the host switches the session into its plan mode between turns while the class owes a plan. */
	const planMode = new PlanModeLife({
		records: () => records,
		emit: (event) => emit(event),
		eligible: classTask && task.transport !== 'terminal',
		send: async (change) => {
			if (!transport) throw new Error('Agent is not available');
			await transport.send(change);
		},
		ask: (text) => command({ kind: 'prompt', text, crew: { kind: 'plan-ask' } }),
		stopping: () => stopping,
	});
	const taskClass = new TaskClassLife({
		records: () => records,
		emit: (event) => emit(event),
		eligible: classTask,
		readOnly: task.readOnlyAgent === true,
		auto: autoTask,
		planMode: () => planMode.state(),
		limit: () => readSmallTaskLimit(store.root),
		// spec/smoke-run#brief
		smoke: () => modules.current().browser || modules.current().simulator,
		size: () => readChanges(store, config.key).then((value) => changeSize(value.files)),
		// spec/reviews#tripwire: the start of `request_review`; it fired when it recorded a review (running, or failed with no reviewer).
		start: (input) => taskReview.requestByHost(input).catch(() => false),
		stopping: () => stopping,
	});
	/** spec/crew#parts: a crew worker's current part as its crew host saved it. */
	async function readPartBrief() {
		try {
			const doc = await readDocument(
				await safePath(await store.taskDir(config.key), 'crew-part.json')
			);
			return isCrewPartBrief(doc) ? doc : null;
		} catch {
			return null;
		}
	}
	const selfContext = (spec: CrewSpec): CrewContext => ({
		role: 'foreman',
		crewKey: config.key,
		spec,
		node: spec.root,
		parent: null,
		parentKey: null,
		isRoot: true,
	});
	async function crewHostFor(context: CrewContext): Promise<CrewHost> {
		const deps = {
			store,
			key: config.key,
			context,
			services: {
				dataDir: config.dataDir,
				mcpEntry: config.mcpEntry,
				runtime: config.runtime ?? process.execPath,
				...(config.adapter ? { adapter: config.adapter } : {}),
			},
			emit,
			records: () => records,
			parent: () => crewWorker?.request() ?? null,
			prompt: (text: string, marker: Extract<SessionEvent, { kind: 'turn.started' }>['crew']) =>
				command({ kind: 'prompt', text, ...(marker ? { crew: marker } : {}) }),
			self: taskReview.hooks(),
			// spec/crew#budget-pause: waiting hires stay waiting while the task is held at its budget.
			held: () => budgetBlocks(),
			dropQuestion: (questionId: string) =>
				serialPrompt(async () => {
					for (const item of queuedCrewQuestion(queue, questionId))
						await emit({ kind: 'prompt.removed', id: item.id });
				}),
			// spec/crew#ask-foreman, spec/chat-turns-plans-and-questions#plan-chat: a reviewer's question to an agent held by its plan for
			// approval answers that plan with its reject option and runs before what is queued. Only an agent that answers questions
			// (`prompt_task`) gets it: the Auto agent, a solo task's agent and a crew developer (spec/reviews#reviewer-questions); a split waits
			// in the crew host.
			answerPlan: (text: string, marker: Extract<SessionEvent, { kind: 'turn.started' }>['crew']) =>
				serialPrompt(async () => {
					if (crew && !autoTask && crew.role !== 'developer') return false;
					const plan = [...permissions.values()].find((item) => isPlanApproval(item.request)),
						reject = plan ? planRejectOption(plan.request) : null;
					if (!plan || !reject) return false;
					await plan.finish(reject.id);
					const before = queue.prompts[0]?.id;
					await emit({
						kind: 'prompt.queued',
						prompt: {
							id: randomUUID(),
							command: { kind: 'prompt', text, ...(marker ? { crew: marker } : {}) },
							attachments: [],
						},
						...(before ? { before } : {}),
					});
					kickPrompts();
					return true;
				}),
		};
		// spec/crew#auto: the Auto agent's host hires through cards and asks the app about models.
		const host: CrewHost =
			context.role === 'auto'
				? new AutoCrewHost({
						...deps,
						app: (method, params) => (ui ? ui.request(method, params) : null),
						workspace: {
							hold: holdWorkspace,
							gate: gateWorkspace,
							sessionId: () => sessionId(),
							mover,
							restartCommands,
						},
					})
				: new CrewHost(deps);
		await host.start();
		return host;
	}
	// spec/settings-modules-and-onboarding#modules: the modules on in Settings decide which human tools the MCP sessions list; a switch reaches open sessions.
	const modules = new ModuleSettings(store.root);
	/** spec/smoke-run#start: a solo task's agent, an Auto agent and a crew developer run smoke runs and say `Ready to look`. */
	const smokeRole =
		task.readOnlyAgent !== true && (!crew || crew.role === 'auto' || crew.role === 'developer');
	const smoke: SmokeLife = new SmokeLife({
		records: () => records,
		emit: (event) => emit(event),
		eligible: smokeRole,
		modules: () => modules.current(),
		minutes: () => readSmokeMinutes(store.root),
		// spec/smoke-run#who: an Auto task's hired worker leaves the smoke to the agent that hired it.
		hiredWorker: async () =>
			!!crew?.parentKey && !!(await store.task(crew.crewKey).catch(() => null))?.auto,
		workersRun: () => autoTask && runningHires(records).length > 0,
		busy: () => busy,
		steer: (text) =>
			serialPrompt(async () => {
				if (!busy || steerPending || !transport?.steering) return false;
				return steerTurn(text, [], {
					kind: 'turn.started',
					text: '',
					origin: 'agent',
					crew: { kind: 'smoke-report' },
				});
			}),
		prompt: (text) => command({ kind: 'prompt', text, crew: { kind: 'smoke-report' } }),
		dropAsks: () =>
			serialPrompt(async () => {
				for (const item of [...queue.prompts, ...(queue.held ?? [])])
					if (item.command.kind === 'prompt' && item.command.crew?.kind === 'smoke-report')
						await emit({ kind: 'prompt.removed', id: item.id });
			}),
		// spec/smoke-run#start: the host asks a GUI session for the report; a terminal session has no smoke run.
		asks: task.transport !== 'terminal',
		page: async (tab) => {
			if (!ui) return null;
			const state = await ui.request('browser', { kind: 'state', ...(tab ? { tab } : {}) });
			return isRecord(state) && typeof state.url === 'string' && typeof state.tab === 'string'
				? { tab: state.tab, url: state.url }
				: null;
		},
		stopping: () => stopping,
	});
	// spec/browser-and-simulator#metro-port: a task with its own worktree takes its Metro port before its agent and terminals start — a crew
	// worker's host too, which its foreman's host starts with the foreman's environment.
	if (modules.current().simulator)
		await applyMetroPort(store, config.key, process.env).catch(() => null);
	// spec/crew#roles: the root foreman's `create_task` is hidden while its crew plan exists; open MCP sessions hear the change.
	const hiddenListeners = new Set<() => void>();
	const hiddenTools: HiddenToolSource = {
		// spec/smoke-run#start: a terminal session lists no smoke run tools (the host cannot ask it for the report).
		current: () =>
			task.transport === 'terminal'
				? new Set([...crewHiddenTools(crew, records), 'smoke_start', 'smoke_report'])
				: crewHiddenTools(crew, records),
		subscribe(listener) {
			hiddenListeners.add(listener);
			return () => hiddenListeners.delete(listener);
		},
	};
	await modules.load();
	modules.start();
	const brief = sessionBrief(crew, task.provider, {
		...(task.agentRole ? { role: task.agentRole.instructions } : {}),
		subagents: task.provider === 'claude' && Boolean(await claudeSubagentModel(store.root)),
		commands: modules.current().commands && Boolean(project.commands?.length),
		tools: modules.current(),
		cli: task.transport === 'terminal',
		...(classTask ? { classes: autoTask ? ('auto' as const) : ('solo' as const) } : {}),
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
	/** spec/crew#auto-budget: this worker was stopped at its part budget; nothing starts by itself until the person's message continues it. */
	let overBudget = task.overBudget === true;
	/** true — the person continues the part (the stop is lifted on disk too, so a restart keeps a continuation that waits); false — stopped. */
	async function continuePart(go: boolean) {
		overBudget = !go;
		await store.updateTask(config.key, { overBudget: !go });
	}
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
	/**
	 * spec/crew#auto-move: work that needs the task with no session, no capture and no watcher — the move into a worktree. It runs once no turn
	 * runs; returning true stops this host (`moved`) so the next one starts in the new folder.
	 */
	type WorkspaceWork = (hold: MoveHold) => Promise<boolean>;
	let workspaceDue: WorkspaceWork | null = null,
		workspaceHeld = false,
		/** spec/crew#auto-move: the host in the new folder finishes the hire before any prompt starts. */
		workspaceGate = false,
		workspaceTask: Promise<void> = Promise.resolve(),
		restartAfterStop = false;
	function gateWorkspace(work: Promise<void>) {
		workspaceGate = true;
		void work
			.catch(() => {})
			.finally(() => {
				workspaceGate = false;
				kickPrompts();
			});
	}
	function holdWorkspace(work: WorkspaceWork) {
		workspaceDue = work;
		setImmediate(() => void runWorkspaceHold());
	}
	const sessionId = () => {
		const started = records.findLast((record) => record.event.kind === 'session.started')?.event;
		return started?.kind === 'session.started' ? started.sessionId : null;
	};
	/** spec/tasks#move-to-worktree: a move that has not taken the hold yet is dropped; one that runs goes on. */
	function unholdWorkspace() {
		if (!workspaceDue || workspaceHeld) return false;
		workspaceDue = null;
		kickPrompts();
		return true;
	}
	/** spec/crew#auto-move, spec/tasks#move-to-worktree: the one move of the task into a worktree; an Auto hire and the person start it. The
	 *  person's move tells the agent in its next prompt (`mover.note`), so nothing follows it here. */
	const mover = new WorkspaceMover(
		{
			store,
			key: config.key,
			services: { mcpEntry: config.mcpEntry },
			records: () => records,
			emit: (event) => emit(event),
			hold: holdWorkspace,
			unhold: unholdWorkspace,
			gate: gateWorkspace,
			sessionId: () => sessionId(),
			restartCommands: (items) => restartCommands(items),
			worktree: async () => (await store.task(config.key)).launch?.isolation === 'worktree',
		},
		{ moved: async () => {}, failed: async () => {} }
	);
	/** The person's message or a service prompt while the task moves: it waits in the queue for the host in the new folder. */
	function queueWhileMoving(c: Extract<SessionCommand, { kind: 'prompt' | 'submitReview' }>) {
		return serialPrompt(async () => {
			if (queue.prompts.length >= 32) throw new Error('The prompt queue is full');
			const attachments = await assets.resolve(
				config.key,
				c.kind === 'prompt' ? (c.attachmentIds ?? []) : []
			);
			const { answersPlan: _answersPlan, ...command } = c as typeof c & { answersPlan?: boolean };
			await emit({
				kind: 'prompt.queued',
				prompt: {
					id: randomUUID(),
					command,
					attachments: attachments.map((value) => value.attachment),
				},
			});
		});
	}
	function runWorkspaceHold() {
		if (!workspaceDue || workspaceHeld || busy || starting || saving || stopping) return;
		const work = workspaceDue;
		workspaceDue = null;
		workspaceHeld = true;
		// stop() waits for the move, so the host never lets go of the task in the middle of it.
		workspaceTask = holdWorkspaceNow(work);
		return workspaceTask;
	}
	async function holdWorkspaceNow(work: WorkspaceWork) {
		let restart = false;
		try {
			await startingAgent?.catch(() => {});
			stopScopeWatch();
			stopScopeWatch = () => {};
			// spec/crew#auto-move: what stops with the session and the consoles, read while it still runs; the row names it.
			const stopped = stoppedByMove();
			// Consoles of the task stop with the session: nothing writes into the folder while it is captured and restored. A saved
			// command started again later must not meet its old process on its port.
			await terminals.closeAll();
			await scopeRefresh.catch(() => {});
			await saveFinished.catch(() => {});
			await agentFileTail.catch(() => {});
			if (transport) {
				const old = transport;
				transport = null;
				old.close();
				await old.closed.catch(() => {});
			}
			restart = await work({
				...stopped,
				capture: async () => {
					await checkpoint('refresh');
				},
				detach: async () => {
					// No capture runs after this one ends: the moved task's snapshot document is written only by the move.
					const current = snapshots;
					snapshots = null;
					await toolCapture.catch(() => {});
					await current?.settled();
				},
			});
		} catch (error) {
			process.stderr.write(
				`[host] workspace move failed: ${error instanceof Error ? error.message : String(error)}\n`
			);
		} finally {
			if (restart) {
				restartAfterStop = true;
				setImmediate(() => void stop('moved'));
			} else {
				// The move failed and the task stays here: snapshots, the consoles, the watcher and the agent's session come back, then the queue goes on.
				if (!stopping && !snapshots)
					snapshots = await Snapshots.open(store, config.key).catch(() => null);
				workspaceHeld = false;
				terminals.reopen();
				if (!stopping) {
					startScopeWatch();
					void ensureAgent()
						.catch(() => {})
						.finally(() => kickPrompts());
				}
			}
		}
	}
	let queue = promptQueue(records),
		promptTail: Promise<unknown> = Promise.resolve();
	let rateTimer: ReturnType<typeof setTimeout> | undefined;
	const quotaBlocked = () => Boolean(queue.rateLimits?.length);
	/** spec/agents-and-providers#task-tokens, spec/agents-and-providers#budget-reached: the task's own tokens and, for a root task, its budget and hold. */
	const budget: TaskBudget | null = task.provider
		? new TaskBudget(
				{
					store,
					key: config.key,
					records: () => records,
					emit: (event) => emit(event),
					busy: () => busy,
					cancel: () => command({ kind: 'cancel' }),
					stopMembers: async () => {
						await crewHost?.stopWorkers();
					},
					resume: () => kickPrompts(),
				},
				task
			)
		: null;
	/** Nothing new starts while the task, or a member's root, is held at its budget. */
	const budgetBlocks = async () => (budget ? budget.blocks() : false);
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
			// spec/crew#auto-move: the task is moving into a worktree; the queue waits for the host in the new folder.
			if (workspaceDue || workspaceHeld) {
				void runWorkspaceHold();
				return;
			}
			if (workspaceGate) return;
			if (
				busy ||
				saving ||
				!ready ||
				!transport ||
				queue.paused ||
				quotaBlocked() ||
				overBudget ||
				!queue.prompts.length ||
				(await budgetBlocks()) ||
				overBudget
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
		if (
			!transport ||
			!ready ||
			busy ||
			saving ||
			stopping ||
			quotaBlocked() ||
			workspaceDue ||
			workspaceHeld ||
			workspaceGate
		)
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
		let pieces: CrewAssignment[] | null = null;
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
			pieces = await dueAssignment(c.kind === 'prompt' ? (c.assignment ?? null) : null);
			// spec/reviews#plan-mode: between turns only — the session goes into its plan mode before a turn while the class owes a plan.
			await planMode.beforeTurn();
			await checkpoint('turn');
			await emit({
				kind: 'turn.started',
				text: c.text,
				...(queuedPromptId ? { queuedPromptId } : {}),
				...(c.kind === 'submitReview' ? { review: c.review } : {}),
				...(attachments.length
					? { attachments: attachments.map((value) => value.attachment) }
					: {}),
				...((c.kind === 'prompt' || c.kind === 'submitReview') && c.crew ? { crew: c.crew } : {}),
			});
		} catch (error) {
			busy = false;
			starting = false;
			throw error;
		}
		sentScopeContext = manifest;
		const briefBlock =
			briefPending && brief ? [{ kind: 'text' as const, name: 'Brigadir brief', text: brief }] : [];
		// spec/tasks#move-to-worktree: after the person's move the agent's next prompt says where the task now runs.
		const moved = await mover.note().catch(() => null),
			moveBlock = moved ? [{ kind: 'text' as const, name: 'Brigadir workspace', text: moved }] : [];
		briefPending = false;
		// spec/crew#assignment-after-compaction: the prompt answers the newest compaction before it goes out; the answer is journaled once the agent took
		// the turn, so a request that fails — also before a restart — leaves the compaction due for the next prompt.
		const answered = pieces ? assignmentDue : null,
			given = answered === null ? [] : (pieces ?? []);
		if (answered !== null) assignmentDue = null;
		const assignmentInput = given.length
			? [{ kind: 'text' as const, name: 'Brigadir assignment', text: assignmentBlock(given) }]
			: [];
		const gen = ++turnGen;
		starting = false;
		turnFinished = transport
			.send(
				{ kind: 'prompt', text: c.text },
				[
					...attachments.map((value) => ({ ...value.input, id: value.attachment.id })),
					...briefBlock,
					...moveBlock,
					...assignmentInput,
					...(context
						? [{ kind: 'text' as const, name: 'Workspace repositories', text: context }]
						: []),
				],
				relay.resources
			)
			.then(async () => {
				if (moved) await mover.told().catch(() => {});
				if (answered !== null)
					await emit({
						kind: 'crew.assignment.restored',
						compactedSeq: answered,
						assignment: given.map((piece) => piece.kind),
					});
			})
			.catch(() => {
				sentScopeContext = '';
				if (briefBlock.length) briefPending = true;
				if (answered !== null && assignmentDue === null) assignmentDue = answered;
			})
			.finally(() => {
				if (turnGen === gen && !steerPending) busy = false;
				kickPrompts();
			});
	}
	/** spec/composer-steering-queue-and-ghost#steering-hold: the step boundary sends every held message (`all`), Claude's window only those older than it. */
	/** spec/composer-steering-queue-and-ghost#steering-conditions: a hire card's call waits in the turn; held messages wait for its answer. */
	const hireCallWaits = () => crewHost instanceof AutoCrewHost && crewHost.hireWaiting();
	function flushHeld(all: boolean) {
		void serialPrompt(async () => {
			if (busy && hireCallWaits()) return;
			const limit = holdWindowMs(),
				due = (queue.held ?? []).filter(
					(item) => all || (limit !== null && Date.now() - (heldAt.get(item.id) ?? 0) >= limit)
				);
			// Once one goes to the FIFO the rest follow it, so the agent never reads a later message before an earlier one — also
			// when an earlier flush of this turn put one there.
			let queued = queue.prompts.some((item) => turnHeld.has(item.id));
			for (const item of due) {
				if (!queue.held?.some((entry) => entry.id === item.id)) continue;
				// A hire's call that began meanwhile (a parallel tool) holds this one and every later one.
				if (busy && hireCallWaits()) break;
				// spec/crew#auto-move: a hire that moves the task ends the turn; what was held waits for the host in the new folder.
				const inputs =
					!queued &&
					busy &&
					transport?.steering &&
					!quotaBlocked() &&
					!budget?.held() &&
					!workspaceDue &&
					!workspaceHeld
						? (
								await assets.resolve(
									config.key,
									item.command.kind === 'prompt' ? (item.command.attachmentIds ?? []) : []
								)
							).map((value) => ({ ...value.input, id: value.attachment.id }))
						: null;
				if (inputs && busy && hireCallWaits()) break;
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
			// spec/reviews#plan-mode: the host's ask for an owed plan keeps its place in front.
			before = queue.prompts.find(
				(entry) =>
					since(entry.id) > heldSeq &&
					!(entry.command.kind === 'prompt' && entry.command.crew?.kind === 'plan-ask')
			)?.id;
		await emit({ kind: 'prompt.queued', prompt: item, ...(before ? { before } : {}) });
	}
	function scheduleHeld() {
		clearTimeout(heldTimer);
		const limit = holdWindowMs(),
			first = queue.held?.[0];
		if (limit === null || !first || stopping || (busy && hireCallWaits())) return;
		heldTimer = setTimeout(
			() => flushHeld(false),
			Math.max(0, (heldAt.get(first.id) ?? Date.now()) + limit - Date.now())
		);
		heldTimer.unref?.();
	}
	/** spec/composer-steering-queue-and-ghost#steering: a person's prompt into the running GUI turn. Journaled as `prompt.steered` before the request; false — the agent
	 *  declined it (the turn just ended, or no steering) and the caller queues it as usual. */
	async function steerPrompt(prompt: QueuedPrompt, inputs: PromptInput[]): Promise<boolean> {
		if (!transport) return false;
		await emit({ kind: 'prompt.steered', prompt });
		return steerTurn(prompt.command.text, inputs, {
			kind: 'turn.started',
			text: prompt.command.text,
			queuedPromptId: prompt.id,
			...(prompt.attachments.length ? { attachments: prompt.attachments } : {}),
		});
	}
	/** The running turn takes `text` and `inputs` (`_session/steering`); `started` opens the turn the agent adopts instead (codex-acp). False — declined. */
	async function steerTurn(
		text: string,
		inputs: PromptInput[],
		started: Extract<SessionEvent, { kind: 'turn.started' }>
	): Promise<boolean> {
		const agent = transport;
		if (!agent) return false;
		const before = turnGen;
		let gen = 0;
		steerPending = true;
		let result: Awaited<ReturnType<AgentTransport['steer']>>;
		try {
			result = await agent
				.steer(text, inputs, [], async () => {
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
					await emit(started);
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
	/**
	 * spec/crew#assignment-after-compaction: the pieces of the member's current assignment that a prompt does not give itself — `given` is the id
	 * of the assignment the sending host marked the prompt with. Null — no compaction is due, or the assignment could not be read (the parent is
	 * away): the block waits.
	 */
	async function dueAssignment(given: string | null): Promise<CrewAssignment[] | null> {
		if (assignmentDue === null || !crew) return null;
		try {
			const pieces: CrewAssignment[] = [];
			if (crewWorker) {
				const own = await crewWorker.assignment();
				if (own) pieces.push(own);
			}
			if (crewHost && (crew.role === 'foreman' || crew.role === 'lead')) {
				const plan = await crewHost.planAssignment();
				if (plan) pieces.push(plan);
			}
			return pieces.filter((piece) => given === null || piece.id !== given);
		} catch {
			return null;
		}
	}
	/** spec/crew#assignment-after-compaction: at a step boundary of the running turn the block goes in through steering; declined, it waits for the next prompt. */
	function flushAssignment() {
		void serialPrompt(async () => {
			if (assignmentDue === null || !busy || steerPending || !transport?.steering) return;
			const pieces = await dueAssignment(null),
				// The newest compaction at dispatch: one that came while the parent answered is answered by this block too.
				answered = assignmentDue;
			if (!pieces || answered === null || !busy || !transport?.steering) return;
			const record = (given: CrewAssignment[]) =>
				emit({
					kind: 'crew.assignment.restored',
					compactedSeq: answered,
					assignment: given.map((piece) => piece.kind),
				});
			if (!pieces.length) {
				await record([]);
				return;
			}
			const given = await steerTurn(
				'',
				[{ kind: 'text', name: 'Brigadir assignment', text: assignmentBlock(pieces) }],
				{ kind: 'turn.started', text: '', origin: 'agent' }
			);
			if (given) await record(pieces);
		}).catch(() => {});
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
	/** Discovery only when a repo may have appeared or gone; a HEAD change of a known repo snapshots only that repo. */
	function startScopeWatch() {
		stopScopeWatch = watchScopes(
			project.path,
			(change) => {
				scopeRefresh = (async () => {
					await saveFinished;
					if (stopping) return;
					const options = snapshots?.refreshOptions(change) ?? {};
					try {
						await checkpoint(
							'refresh',
							options.scopeIds,
							options.discover,
							change.heads.length > 0
						);
					} catch (error) {
						if (!stopping) await emit({ kind: 'snapshot.failed', message: String(error) });
					}
				})();
				return scopeRefresh;
			},
			() => snapshots?.current.scopes.map((scope) => scope.path) ?? []
		);
	}

	let scopeRefresh: Promise<void> = Promise.resolve();
	let agentFileTail: Promise<unknown> = Promise.resolve();
	const agentFiles = new AgentFiles(
		project.path,
		() => snapshots?.current.scopes ?? [],
		() => task.readOnlyAgent === true,
		// spec/crew#auto-guard: the Auto agent no longer writes inside a zone it hired out.
		(path) => (crewHost instanceof AutoCrewHost ? crewHost.hiredZone(path) : null)
	);
	let ready = false;
	let snapshots: Snapshots | null = null;
	/** spec/tasks#agent-worktrees: a worktree the agent made itself joins the task. The host looks after a finished tool whose input names
	 *  `worktree`, at every turn's end and at its start; `AgentWorktrees` judges each worktree once. */
	const realData = (() => {
		try {
			return realpathSync(store.root);
		} catch {
			return store.root;
		}
	})();
	const agentWorktrees = new AgentWorktrees({
		store,
		key: config.key,
		projectPath: (() => {
			try {
				return realpathSync(project.path);
			} catch {
				return project.path;
			}
		})(),
		dataRoot: realData,
		records: () => records,
		repos: agentRepos,
		inTask: (path) =>
			(snapshots?.current.scopes ?? []).some(
				(scope) => scope.path === path && scope.selected && scope.available !== false
			),
		scopeIdOf: (path) =>
			(snapshots?.current.scopes ?? []).find((scope) => scope.path === path)?.id ?? null,
		join: joinWorktree,
		leave: leaveWorktree,
		ask: askWorktree,
		emit: (event) => emit(event),
	});
	const worktreeTools = new Map<string, string>();
	/** True while `saving` is the host's own scope change, which commands wait for instead of being refused. */
	let hostScopeChange = false;
	/** The worktree cards that wait for the person (they are not the agent's, so a new session does not close them). */
	const worktreeCards = new Set<string>();
	function agentRepos() {
		return (snapshots?.current.scopes ?? [])
			.filter((scope) => isGitScope(scope) && writableByAgent(scope) && scope.available !== false)
			.map((scope) => scope.path);
	}
	function watchWorktreeTool(event: SessionEvent) {
		if (event.kind === 'turn.completed' || event.kind === 'session.failed') {
			adoptAgentWorktrees();
			return;
		}
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
		// Without snapshots (a move holds the task) or for a task that only reads, nothing joins; the next look still finds it.
		if (!snapshots || stopping || workspaceHeld || task.readOnlyAgent === true) return;
		void agentWorktrees.look().catch((error) => {
			process.stderr.write(
				`[host] worktree look failed: ${error instanceof Error ? error.message : String(error)}\n`
			);
		});
	}
	/** spec/tasks#agent-worktrees: the folder joins as `add_folder` adds one, without the card; its diff counts from the commit it was made at. */
	async function joinWorktree(found: FoundWorktree, by: 'agent' | 'person') {
		if (!snapshots || !ui || stopping || workspaceHeld || task.readOnlyAgent === true) return null;
		const choice = await ui.request('folder', { path: found.path });
		if (!isScopeChoice(choice) || choice.kind !== 'external' || !choice.path) return null;
		const repo = snapshots.current.scopes.find((scope) => scope.path === found.repo);
		await addTaskFolder(choice, {
			...(found.start ? { start: found.start } : {}),
			joined: {
				kind: 'worktree.joined',
				scopeId: choice.id,
				name: choice.name,
				path: choice.path,
				repo: !repo ? basename(found.repo) : repo.name === '.' ? project.name : repo.name,
				...(found.branch ? { branch: found.branch } : {}),
				by,
			},
		});
		return choice.id;
	}
	/** spec/tasks#agent-worktrees: a joined worktree whose folder is gone leaves the task; the roots follow at the turn boundary. */
	async function leaveWorktree(scopeId: string) {
		if (!snapshots) return;
		await saveFinished;
		saving = true;
		hostScopeChange = true;
		const current = snapshots;
		const operation = (async () => {
			const revision = current.scopeRevision;
			await current.leaveScope(scopeId);
			task = await store.task(config.key);
			if (revision !== current.scopeRevision) await emit({ kind: 'scopes.changed' });
		})();
		saveFinished = operation.catch(() => {});
		try {
			await operation;
		} finally {
			saving = false;
			hostScopeChange = false;
		}
		if (transport && task.transport !== 'terminal') rootsStale = true;
		kickPrompts();
	}
	/** spec/tasks#agent-worktrees: the host cannot tell whose worktree it is; the person decides on a card. Null — the host stopped first. */
	async function askWorktree(found: FoundWorktree): Promise<boolean | null> {
		if (!ui || stopping) return null;
		const request: PermissionRequest = {
			id: randomUUID(),
			tool: {
				id: randomUUID(),
				name: worktreeCard.tool,
				title: worktreeCardTitle(basename(found.path), found.branch),
				category: 'edit',
				input: found.path,
			},
			options: [
				{ id: 'add', name: 'Allow', kind: 'allow_once' },
				{ id: 'deny', name: 'Deny', kind: 'reject_once' },
			],
		};
		worktreeCards.add(request.id);
		try {
			const answer = permission(request, new AbortController().signal);
			await emit({ kind: 'permission.requested', request });
			const result = await answer;
			if (result === 'add') return true;
			return stopping ? null : false;
		} finally {
			worktreeCards.delete(request.id);
		}
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
		// spec/crew#auto-move: no session starts in the folder the task is leaving.
		if (workspaceHeld) return Promise.reject(new Error('The task is moving into a worktree'));
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
	/** spec/diff-and-review#diff-base: `headMoved` — the watcher saw a commit, reset or checkout; the base of `head` moved even when the tree did not. */
	async function checkpoint(
		reason: Parameters<Snapshots['capture']>[0],
		scopeIds?: readonly string[],
		discover?: false,
		headMoved = false
	) {
		const before = snapshots?.current.checkpoints.at(-1),
			checkReadOnly = busy && !['baseline', 'user-before', 'user-after'].includes(reason);
		const revision = snapshots?.scopeRevision;
		const captured = await snapshots?.capture(reason, {
			scopeIds,
			...(discover === false ? { discover } : {}),
		});
		if (headMoved || revision !== snapshots?.scopeRevision) await emit({ kind: 'scopes.changed' });
		if (captured && captured.id !== lastCheckpoint) {
			await emit({ kind: 'checkpoint.created', checkpoint: captured.id });
			lastCheckpoint = captured.id;
			// spec/reviews#tripwire: a new checkpoint of the agent's work (every fifth tool, each turn end) is a tripwire check.
			if ((reason === 'tools' || reason === 'turn') && !stopping)
				void taskClass.checkpoint().catch(() => {});
		}
		if (checkReadOnly && snapshots && captured)
			for (const violation of await readOnlyChanges(snapshots.current.scopes, before, captured))
				await emit({ kind: 'scope.violation', ...violation });
	}
	/** spec/design-review#shots: a checkpoint of the task's files now, and its trees; a failed checkpoint dates nothing. */
	async function treesNow() {
		await checkpoint('tools');
		return (snapshots?.current.checkpoints.at(-1)?.trees ?? []).map(({ scopeId, tree }) => ({
			scopeId,
			tree,
		}));
	}
	/** spec/design-review#shots: the image a screenshot tool returned, kept in the task's folder; the answer names its id. */
	async function keepShot(
		result: unknown,
		tool: 'simulator' | 'browser',
		trees: { scopeId: string; tree: string }[],
		device: string | undefined
	) {
		if (!isRecord(result) || typeof result.image !== 'string') return result;
		const mimeType = typeof result.mimeType === 'string' ? result.mimeType : 'image/png';
		const shot = await saveShot(store, config.key, {
			data: result.image,
			mimeType,
			tool,
			...(typeof result.device === 'string' ? { device: result.device } : device ? { device } : {}),
			trees,
		}).catch(() => null);
		return shot ? { ...result, shot: shot.id } : result;
	}
	const crewPeers = new Set<Peer>();
	/** spec/reviews#plan-loop: plan review batches whose waiting plan the host just rejected; such a batch runs before what is queued. */
	const planAnswered = new Set<string>();
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
				event.kind === 'crew.plan.requested' ||
				event.kind === 'crew.hire.requested' ||
				event.kind === 'crew.model.requested' ||
				event.kind === 'budget.reached'
			)
				status = 'needs-you';
			// spec/crew#auto-budget: in the worker's own journal the part waits for the person.
			if (event.kind === 'crew.budget.exceeded' && event.taskId === config.key.id)
				status = 'needs-you';
			if (
				event.kind === 'permission.resolved' ||
				event.kind === 'question.resolved' ||
				event.kind === 'task.proposal.resolved' ||
				event.kind === 'crew.plan.resolved' ||
				event.kind === 'crew.hire.resolved' ||
				event.kind === 'crew.model.resolved' ||
				event.kind === 'budget.decided'
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
			// spec/crew#auto-hire, spec/crew#plan: so does a hire card or a split whose call ended with the turn.
			if (event.kind === 'turn.completed')
				status = statusAfterTurn(
					event.reason,
					pendingInputs([...records, record]),
					taskReview.document().review?.state === 'yours',
					lastTurnPlanReturned([...records, record])
				);
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
			// spec/crew#auto-hire: a hire card or a split outlives the turn the host stopped under.
			if (event.kind === 'host.stopped' && busy)
				status = statusAfterStop(
					pendingInputs([...records, record]),
					taskReview.document().review?.state === 'yours'
				);
			if (event.kind === 'crew.accepted' && event.conflicts.length) status = 'needs-you';
			// spec/reviews#loop: the reviewers and the agent did not agree in two rounds; the person decides.
			if (event.kind === 'review.finished' && event.state === 'disputed' && !busy)
				status = 'needs-you';
			// spec/reviews#surfaces: the closure check left findings open; the person decides with `Fix {n}` or `Accept`.
			if (event.kind === 'task-review.verified' && event.open + event.introduced > 0 && !busy)
				status = 'needs-you';
			if (
				event.kind === 'task-review.decided' &&
				event.decision === 'accept' &&
				!busy &&
				!waitsForPerson(pendingInputs(records))
			)
				status = 'done';
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
			// spec/crew#auto-budget: the person's next turn on a worker over its budget takes the part over; the budget is not checked again.
			// A turn the agent began on its own is not the person's.
			if (
				event.kind === 'turn.started' &&
				event.origin !== 'agent' &&
				!overBudget &&
				(await store.task(config.key)).overBudget
			)
				await store.updateTask(config.key, { overBudget: false });
			// spec/crew#auto-guard: after each turn of the Auto agent the host looks for its own changes inside the zones it hired out.
			if (event.kind === 'turn.completed' && autoTask)
				setImmediate(() => {
					if (crewHost instanceof AutoCrewHost && !stopping)
						void crewHost.checkZones().catch(() => {});
				});
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
					event.kind !== 'crew.hire.resolved' &&
					event.kind !== 'crew.model.resolved' &&
					event.kind !== 'crew.question.resolved') ||
				event.kind === 'scope.violation' ||
				// spec/smoke-run#ready-surfaces: `Ready to look` lights the unread dot.
				event.kind === 'task.ready'
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
			// A subagent joins it when its turn ends under it (spec/chat-turns-plans-and-questions#background-subagents).
			if (
				event.kind === 'background.started' ||
				(event.kind === 'background.changed' && event.state) ||
				(event.kind === 'subagent.changed' && event.state) ||
				event.kind === 'turn.completed' ||
				event.kind === 'session.failed' ||
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
			budget?.observe(record);
			if (crew && task.transport !== 'terminal') {
				if (event.kind === 'context.compacted') assignmentDue = record.seq;
				if (
					event.kind === 'crew.assignment.restored' &&
					assignmentDue !== null &&
					event.compactedSeq >= assignmentDue
				)
					assignmentDue = null;
			}
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
			if (event.kind === 'crew.plan.requested' || event.kind === 'crew.plan.resolved')
				for (const listener of hiddenListeners) listener();
			if (crewLinkEvents.has(event.kind))
				for (const peer of crewPeers) {
					try {
						peer.notify('event', record);
					} catch {
						peer.close();
					}
				}
			if (event.kind === 'turn.started' && event.review && !stopping)
				void taskReview.batchTaken(event.review.id).catch(() => {});
			if (event.kind === 'turn.completed' && !stopping) void taskReview.turnEnded().catch(() => {});
			if (event.kind === 'session.failed' && !stopping)
				void taskReview.turnStopped().catch(() => {});
			// spec/smoke-run#limit: a turn that ends with the smoke run open asks for the report once; a stopped turn drops the run.
			if (event.kind === 'turn.completed' && !stopping)
				void smoke.turnEnded(event.reason === 'cancelled', record.seq).catch(() => {});
			// spec/reviews#tripwire, spec/reviews#class-raise, spec/reviews#large-review
			if (!stopping) classEvent(event);
			// spec/reviews#plan-start: a presented plan starts its review or answers one; an approval ends it.
			if (!stopping) planEvent(event);
			if (crewWorker && event.kind === 'turn.completed' && !stopping)
				void (async () => {
					if (!crewHost || (await crewHost.branchReady()))
						await crewWorker.report(record.seq, status ?? undefined);
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
	/** spec/reviews#classes: an approved hire raises the class; a dismissal may bring the hired parts back. */
	function classEvent(event: SessionEvent) {
		if (event.kind === 'crew.hire.resolved' && event.approved && event.hired.length)
			void taskClass.hired().catch(() => {});
		if (event.kind === 'crew.worker.dismissed') void taskClass.dismissed().catch(() => {});
		// spec/reviews#plan-mode: back from the plan mode after an approval, and the ask for a plan still owed.
		if (event.kind === 'turn.completed')
			void planMode.turnEnded(event.reason === 'cancelled').catch(() => {});
	}
	/** The plan requests the review has heard of: the journal row and the waiting request come in either order (the transport writes the row first). */
	const presentedPlans = new Set<string>();
	function presentPlan(id: string) {
		const plan = planWaiting();
		if (plan?.id !== id || presentedPlans.has(id)) return;
		presentedPlans.add(id);
		void taskReview.planPresented(plan).catch(() => {});
	}
	/** spec/reviews#plan-start, spec/reviews#plan-loop: a plan presented, answered or approved — the plan review hears it. */
	function planEvent(event: SessionEvent) {
		if (event.kind === 'permission.requested' && isPlanApproval(event.request)) {
			presentPlan(event.request.id);
			return;
		}
		if (event.kind === 'permission.resolved') {
			const asked = records.findLast(
				(record) =>
					record.event.kind === 'permission.requested' && record.event.request.id === event.id
			);
			if (asked?.event.kind !== 'permission.requested' || !isPlanApproval(asked.event.request))
				return;
			const allowed =
				event.optionId !== null &&
				asked.event.request.options
					.find((option) => option.id === event.optionId)
					?.kind.startsWith('allow') === true;
			void taskReview.planDecided(allowed).catch(() => {});
			return;
		}
		// A lead's plan is approved by the host at once: only the root foreman's split waits for the person.
		if (!foremanTask || crew?.parentKey) return;
		if (event.kind === 'crew.plan.requested') {
			waitingSplit = event.plan;
			const plan = planWaiting();
			if (plan) void taskReview.planPresented(plan).catch(() => {});
		}
		if (event.kind === 'crew.plan.resolved' && waitingSplit?.id === event.id) {
			waitingSplit = null;
			void taskReview.planDecided(event.approved).catch(() => {});
		}
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
			// spec/reviews#plan-start: the agent's plan request is registered after its journal row.
			if (isPlanApproval(request)) presentPlan(request.id);
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
	/** spec/crew#auto-move: the saved commands the agent started with `commands_run` in this host. */
	const agentCommands = new Set<string>();
	/** spec/crew#auto-move: the consoles, saved commands and background commands that run now; the ones the agent started to run again. */
	function stoppedByMove(): { stopped: WorkspaceStopped[]; restart: MoveCommand[] } {
		const stopped: WorkspaceStopped[] = [],
			restart: MoveCommand[] = [];
		for (const info of terminals.consoles()) {
			if (info.exited) continue;
			if (info.run) {
				stopped.push({ kind: 'command', name: info.run.name });
				const id = info.run.commandId;
				if (id && agentCommands.has(id)) restart.push({ id, name: info.run.name });
			} else stopped.push({ kind: 'console', name: info.title });
		}
		for (const command of [...liveBackground(records), ...liveBackgroundSubagents(records)])
			stopped.push({ kind: 'background', name: command.name.slice(0, 200) });
		return { stopped: stopped.slice(0, workspaceStoppedLimit), restart };
	}
	/** spec/crew#auto-move: the saved commands the agent had started, run again in this host's folder after a move (or a failed one). */
	async function restartCommands(items: readonly MoveCommand[]) {
		if (!modules.current().commands) return [];
		terminals.reopen();
		const commands = (await store.project(config.key.projectId)).commands ?? [],
			started: string[] = [];
		for (const item of items) {
			const command = commands.find((value) => value.id === item.id);
			if (!command) continue;
			try {
				await terminals.command({ kind: 'run', run: commandRunSpec(command) });
				agentCommands.add(command.id);
				started.push(command.id);
			} catch {
				/* A command that does not start stays stopped; the row says so. */
			}
		}
		return started;
	}
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
			agentCommands.delete(command.id);
			await terminals.command({ kind: 'stop', id: current!.id });
			await untilRun(command.id, 6000, signal, (run) => run.exited);
			return answer();
		}
		await terminals.command({ kind: 'run', run: commandRunSpec(command) });
		agentCommands.add(command.id);
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
	async function addTaskFolder(
		choice: ScopeChoice,
		join: {
			/** spec/tasks#agent-worktrees: the commit a worktree the agent made was made at. */ start?: string;
			joined?: Omit<WorktreeJoinedEvent, 'standsForRoot'>;
		} = {}
	) {
		if (!snapshots) throw new Error('Snapshots are unavailable');
		await saveFinished;
		// spec/tasks#agent-worktrees: another checkout of the root's repo stands for the root in the composer and the sidebar.
		let of: string | undefined;
		if (choice.kind === 'external' && choice.path) {
			const root = snapshots.current.scopes.find(
				(scope) => scope.kind === 'root' && scope.available !== false
			);
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
		hostScopeChange = !!join.joined;
		const operation = (async () => {
			const revision = snapshots.scopeRevision,
				point = await snapshots.addScope(choice, join.start);
			task = await store.task(config.key);
			// The row comes before the capture's checkpoint, which is the agent's turn (spec/diff-and-review#why-changed).
			if (join.joined) await emit({ ...join.joined, standsForRoot: !!of });
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
			hostScopeChange = false;
		}
		if (transport && task.transport !== 'terminal') rootsStale = true;
		kickPrompts();
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack-agent-post: `slack_post` — main says where and as whom, the person allows or denies
	 * with the text in front of them (unless they let agents post without asking), then main posts it as the bot. The token never leaves main.
	 */
	async function slackPostTool(value: unknown, signal: AbortSignal): Promise<unknown> {
		if (!modules.current().slack) throw new Error(moduleOffMessages.slack);
		if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim())
			throw new Error('text is empty.');
		if (!ui) throw new Error('A Slack message goes out while the Brigadir app is open.');
		const where = {
			...(typeof value.channel === 'string' ? { channel: value.channel } : {}),
			...(typeof value.thread === 'string' ? { thread: value.thread } : {}),
		};
		const target = await ui.request('slack_target', where);
		if (!isRecord(target) || typeof target.bot !== 'string' || typeof target.label !== 'string')
			throw new Error('Slack could not be reached.');
		// `agents.slackPostWithoutAsking` (main answers `ask: false`) skips the card; the MCP row still shows the text.
		if (target.ask !== false) {
			const request: PermissionRequest = {
				id: randomUUID(),
				tool: {
					id: randomUUID(),
					title: `Post to Slack as ${target.bot} · ${target.label}`,
					category: 'other',
					input: value.text,
				},
				options: [
					{ id: 'post', name: 'Allow', kind: 'allow_once' },
					{ id: 'always', name: 'Always allow', kind: 'allow_always' },
					{ id: 'deny', name: 'Deny', kind: 'reject_once' },
				],
			};
			const answer = permission(request, signal);
			await emit({ kind: 'permission.requested', request });
			const choice = await answer;
			if (choice !== 'post' && choice !== 'always')
				return { posted: false, reason: 'The person declined the message.' };
			if (choice === 'always') await ui.request('slack_allow_always', {});
		}
		return ui.request('slack_post', { ...where, text: value.text });
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
		// spec/crew#auto-move: nothing captures or changes the task's repos while it moves into a worktree.
		if (
			workspaceHeld &&
			(c.kind === 'checkpoint' ||
				c.kind === 'quickAsk' ||
				c.kind === 'setScope' ||
				c.kind === 'addScope')
		)
			throw new Error('The task is moving into a worktree');
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
		// spec/browser-and-simulator#sim-chat-row: main's device row, journaled like any event of the task.
		if (c.kind === 'recordDevice') {
			await emit({
				kind: 'simulator.device',
				device: c.device,
				metroPort: c.metroPort,
				lowMemory: c.lowMemory,
			});
			return;
		}
		if (c.kind === 'recordPullRequest') {
			await saveFinished;
			if (!snapshots?.current.scopes.some((scope) => scope.id === c.scopeId))
				throw new Error('Repo is unavailable');
			await emit({ kind: 'pull-request.changed', scopeId: c.scopeId, pr: c.pr });
			return;
		}
		// spec/tasks#agent-worktrees: the host's own scope change (a worktree joins or leaves) is short; a command waits for it.
		if (saving && hostScopeChange) await saveFinished;
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
		// spec/agents-and-providers#budget-reached, spec/agents-and-providers#task-budget
		if (c.kind === 'decideBudget') {
			if (!budget) throw new Error('This task has no agent');
			await budget.decide(c.id, c.decision, c.budget);
			return;
		}
		if (c.kind === 'setTokenBudget') {
			if (!budget) throw new Error('This task has no agent');
			await budget.setBudget(c.provider, c.budget);
			return;
		}
		if (c.kind === 'decidePlan') {
			if (!crewHost) throw new Error('This task has no crew');
			await crewHost.decidePlan(c.decision);
			return;
		}
		// spec/crew#auto-hire, spec/crew#auto-model, spec/crew#auto-dismiss: the person's answers to an Auto task.
		// spec/tasks#move-to-worktree: the person's move — the same move as a hire's, refused by one rule with the menus.
		if (c.kind === 'moveToWorktree') {
			const doc = await mover.read();
			const root = snapshots?.current.scopes.find(
				(scope) => scope.kind === 'root' && scope.available !== false
			);
			task = await store.task(config.key);
			const refusal = moveRefusal(task, {
				moving:
					stopping ||
					!!config.consoleOnly ||
					!!workspaceDue ||
					workspaceHeld ||
					workspaceGate ||
					['pending', 'moving', 'switching', 'switched'].includes(doc?.state ?? ''),
				git: !!root && isGitScope(root),
			});
			if (refusal === 'worktree') throw new Error('The task already has a worktree.');
			if (refusal) throw new Error(refusal);
			await mover.start({ by: 'person' }, busy || starting);
			return;
		}
		if (c.kind === 'cancelMove') {
			if (!(await mover.cancel())) throw new Error('The move has already started.');
			return;
		}
		if (c.kind === 'decideHire' || c.kind === 'answerModel' || c.kind === 'dismissWorker') {
			if (!(crewHost instanceof AutoCrewHost)) throw new Error('This task is not an Auto task');
			if (c.kind === 'decideHire') await crewHost.decideHire(c.decision);
			else if (c.kind === 'answerModel') await crewHost.answerModel(c.id, c.answer);
			else await crewHost.dismissWorker(c.taskId);
			return;
		}
		// spec/crew#auto-budget: the part went over its budget; the turn stops and the worker waits for the person.
		if (c.kind === 'overBudget') {
			// The flag goes first, in the prompt order: a dispatch already under way ends as a turn this stop cancels, and the end of the
			// stopped turn starts nothing queued.
			await serialPrompt(() => continuePart(false));
			if (busy) {
				await command({ kind: 'cancel' });
				for (let waited = 0; busy && waited < 30_000; waited += 200)
					await new Promise((resolve) => setTimeout(resolve, 200));
			}
			await emit({
				kind: 'crew.budget.exceeded',
				taskId: config.key.id,
				name: crew?.node.name ?? '',
				title: c.title,
				budget: c.budget,
				used: c.used,
			});
			return;
		}
		if (c.kind === 'startReview') {
			await taskReview.start(c);
			return;
		}
		if (c.kind === 'stopReview') {
			await taskReview.stop();
			return;
		}
		// spec/smoke-run#limit: the person's `+5 min` and `Stop` on the deck row.
		if (c.kind === 'extendSmoke') {
			await smoke.extend(c.id);
			return;
		}
		if (c.kind === 'stopSmoke') {
			await smoke.stop(c.id);
			return;
		}
		if (c.kind === 'decideReview') {
			await taskReview.decide(c.decision);
			return;
		}
		if (c.kind === 'dismissReviewProposal') {
			await taskReview.dismiss();
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
		// Pausing touches only the journaled queue: a console-only host with no agent takes it too, so Complete and Backlog pass (spec/tasks#archive-actions).
		if (c.kind === 'pausePromptQueue')
			return serialPrompt(async () => {
				if (queue.prompts.length) await emit({ kind: 'queue.paused' });
			});
		// The snapshot is `connected` while the adapter still starts: a message sent then waits for it, a failed start answers with its own error.
		if (!transport && startingAgent) {
			await startingAgent;
			if (stopping) throw new Error('Host is stopping');
		}
		if (!transport || !ready) {
			// spec/crew#auto-move: while the task moves into a worktree there is no session; messages wait in the queue.
			if (workspaceHeld && (c.kind === 'prompt' || c.kind === 'submitReview'))
				return queueWhileMoving(c);
			throw new Error('Agent is starting');
		}
		// spec/chat-turns-plans-and-questions#background-commands: Stop on a background command; the turn, if any, goes on.
		if (c.kind === 'stopBackground') {
			if (!liveBackground(records).some((command) => command.id === c.id))
				throw new Error('The background command is not running');
			await transport.send(c);
			return;
		}
		// spec/chat#subagent-transport: Stop on a running subagent; the turn, if any, goes on.
		if (c.kind === 'stopSubagent') {
			if (!runningSubagents(records).has(c.id)) throw new Error('The subagent is not running');
			await transport.send(c);
			return;
		}
		if (c.kind === 'cancel') {
			await Promise.all([...questions.values()].map((q) => q.finish(null)));
			await Promise.all([...proposals.values()].map((p) => p.finish(null)));
			await transport.send(c);
			return;
		}
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
					quotaBlocked() ||
					budget?.held() ||
					// spec/composer-steering-queue-and-ghost#steering-conditions: a waiting plan takes no steer; a message answers it instead.
					[...permissions.values()].some((entry) => isPlanApproval(entry.request))
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
				// spec/chat-turns-plans-and-questions#plan-chat: Enter while a plan waits answers the plan — the request is rejected and the message runs right after the turn.
				// spec/chat-turns-plans-and-questions#plan-answer: so does the plan card's own answer, with its text as it is; either runs before what is queued.
				const card = c.kind === 'prompt' && c.answersPlan === true,
					plan =
						c.kind === 'prompt' && (c.steer === true || card)
							? [...permissions.values()].find((item) => isPlanApproval(item.request))
							: undefined,
					planReject = plan ? planRejectOption(plan.request) : null;
				if (c.kind === 'prompt' && plan && planReject) {
					const { steer: _steer, answersPlan: _answersPlan, ...rest } = c,
						attachments = await assets.resolve(config.key, rest.attachmentIds ?? []);
					transport!.validateAttachments(attachments.map((value) => value.input));
					await plan.finish(planReject.id);
					const before = queue.prompts[0]?.id;
					await emit({
						kind: 'prompt.queued',
						prompt: {
							id: randomUUID(),
							command: card ? rest : { ...rest, text: planChatPrompt(rest.text) },
							attachments: attachments.map((value) => value.attachment),
						},
						...(before ? { before } : {}),
					});
					kickPrompts();
					return;
				}
				// The plan was answered meanwhile: the card's text is an ordinary message.
				const own: PromptCommand =
					c.kind === 'prompt' && c.answersPlan
						? (({ answersPlan: _answersPlan, ...rest }) => rest)(c)
						: c;
				// spec/reviews#plan-loop: the findings of a plan review answered the waiting plan, so they run before what is queued.
				// spec/reviews#plan-mode: so does the host's ask for the plan a class owes.
				const front =
					(c.kind === 'submitReview' && planAnswered.delete(c.review.id)) ||
					(c.kind === 'prompt' && c.crew?.kind === 'plan-ask');
				// spec/crew#auto-budget: the person's message continues a worker stopped at its part budget, before what waited meanwhile; the
				// stop is lifted once the message is taken.
				const resumes = overBudget && c.kind === 'prompt' && !c.crew;
				if (
					!busy &&
					(!overBudget || resumes) &&
					(!queue.prompts.length || resumes) &&
					!queue.paused &&
					!quotaBlocked() &&
					!workspaceDue &&
					!workspaceHeld &&
					!workspaceGate &&
					!(await budgetBlocks())
				) {
					if (resumes) await continuePart(true);
					try {
						await beginPrompt(own);
					} catch (error) {
						if (resumes) await continuePart(false);
						throw error;
					}
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
					command: own,
					attachments: attachments.map((value) => value.attachment),
				};
				// spec/composer-steering-queue-and-ghost#steering: the person's own words reach the running turn; crew reports, reviews and an earlier queue keep their FIFO order.
				// spec/composer-steering-queue-and-ghost#steering-hold: the host holds it until the step boundary (Claude: at most its window), so the person can still edit or remove it.
				if (
					c.kind === 'prompt' &&
					c.steer === true &&
					!resumes &&
					busy &&
					transport!.steering &&
					!queue.prompts.length &&
					!queue.paused &&
					!quotaBlocked() &&
					!budget?.held()
				) {
					await emit({ kind: 'prompt.held', prompt });
					heldAt.set(prompt.id, Date.now());
					turnHeld.add(prompt.id);
					scheduleHeld();
					return;
				}
				const before = front || resumes ? queue.prompts[0]?.id : undefined;
				await emit({ kind: 'prompt.queued', prompt, ...(before ? { before } : {}) });
				if (resumes) await continuePart(true);
				kickPrompts();
			});
		if (busy) throw new Error('Wait for the active turn before changing options');
		if (c.kind === 'setMode' || c.kind === 'setOption') {
			modeReturn = null;
			// spec/reviews#plan-mode: the person's own move off the plan mode the host set is kept. On the prompt chain, so no turn starts (and
			// switches back) between the change and its record.
			const change = c;
			return serialPrompt(async () => {
				if (busy) throw new Error('Wait for the active turn before changing options');
				if (!transport) throw new Error('Agent is not available');
				await transport.send(change);
				await planMode.person(change).catch(() => {});
			});
		}
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
		// spec/agents-and-providers#budget-reached: a retry is a new turn; while the task is held at its budget it waits (after a sign-in it stays for later).
		if (await budgetBlocks()) {
			if (reason) return;
			throw new Error('The task is paused at its token budget');
		}
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
			// spec/reviews#reviewer-questions: a solo task's agent and a crew developer answer their own reviewers' questions, and only those.
			if ((!crew || crew.role === 'developer') && params.tool === 'prompt_task') {
				if (!crewHost) throw new Error(reviewerAnswerOnly);
				return crewHost.answerSelfQuestion(params.params);
			}
			// A solo task's crew host only runs its review: its own agent has no other crew tools. A developer's crew host runs only its own
			// review (spec/reviews#points): its crew tools go up to its foreman.
			if (crewHost && crew && crew.role !== 'developer' && params.tool !== 'ask_foreman')
				return crewHost.tool(params.tool, params.params, signal);
			if (crewWorker) return crewWorker.tool(params.tool, params.params, signal);
			throw new Error('This task has no crew');
		}
		// spec/agents-and-providers#tools-awareness: crew workers keep the browser, the simulator and the project commands of their own task.
		if (
			!humanToolsAllowed(crew?.role ?? null) &&
			!isWorkspaceTool(method) &&
			!ownReviewTool(crew?.role ?? null, method) &&
			!(smokeRole && smokeTools.has(method))
		)
			throw new Error('Method is not available to this role');
		// spec/smoke-run#limit: from the limit to the report the browser and the simulator answer only that the report is due.
		smoke.gate(method);
		if (method === 'smoke_start') return smoke.start(params);
		if (method === 'smoke_report') return smoke.report(params);
		if (method === 'ready_to_look') return smoke.ready(params);
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
			// spec/design-review#shots: a screenshot is kept with the trees of the task's files taken just before it.
			if (command.kind === 'screenshot') {
				const trees = await treesNow().catch(() => []);
				return keepShot(await ui!.request('browser', command), 'browser', trees, undefined);
			}
			return ui!.request('browser', command);
		}
		// spec/browser-and-simulator#simulator: the simulator lives in the app, like the browser; the host checks the module and forwards the call.
		if (method.startsWith('simulator_')) {
			if (!modules.current().simulator) throw new Error(moduleOffMessages.simulator);
			if (!ui) throw new Error('The simulator needs an open application window');
			// spec/agents-and-providers#tools-awareness: main queues a worker for the one device of the project; the foreman and a solo agent go first.
			const asked = ui,
				shooting = method === 'simulator_screenshot',
				trees = shooting ? await treesNow().catch(() => []) : [];
			const result = await asked.request('simulator', {
				...(isRecord(params) ? params : {}),
				tool: method.slice(10),
				queued: simulatorQueued(crew?.role ?? null),
			});
			return shooting
				? keepShot(
						result,
						'simulator',
						trees,
						isRecord(params) && typeof params.device === 'string' ? params.device : undefined
					)
				: result;
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
		if (method === 'create_task') {
			if (crewHiddenTools(crew, records).has('create_task'))
				throw new Error(hiddenToolMessages.create_task);
			return proposeTask(params, signal);
		}
		// spec/design-review#tool: the host verifies every node itself and keeps the design review.
		if (method === 'submit_design_review') {
			if (!modules.current().simulator && !modules.current().browser)
				throw new Error('The simulator and the browser are off in Settings.');
			return submitDesignReview(
				{ store, key: config.key, trees: treesNow, emit },
				isRecord(params) ? params : {}
			);
		}
		// spec/reviews#save-source: the plan's author saves a ticket or contract next to the plans.
		if (method === 'save_source')
			return saveTaskSource(store, config.key, isRecord(params) ? params : {}, emit);
		if (method === 'review_reply') {
			if (
				!isRecord(params) ||
				typeof params.commentId !== 'string' ||
				typeof params.text !== 'string'
			)
				throw new Error('commentId and text are required');
			return taskReview.reply(params.commentId, params.text);
		}
		// spec/reviews#class-tool
		if (method === 'set_task_class') return taskClass.set(params);
		// spec/reviews#request-tool: the host decides and runs a mid-task review; the agent works on.
		if (method === 'request_review') {
			if (task.readOnlyAgent === true) throw new Error('This task changes no code to review.');
			return taskReview.request({
				point: 'mid',
				startedBy: 'agent',
				reason: isRecord(params) && typeof params.reason === 'string' ? params.reason : '',
			});
		}
		// spec/reviews#start: the proposal card; the call does not wait for the person.
		if (method === 'propose_review') {
			if (task.readOnlyAgent === true) throw new Error('This task changes no code to review.');
			return taskReview.propose(
				isRecord(params) && typeof params.summary === 'string' ? params.summary : ''
			);
		}
		// spec/tasks#task-messages: main knows the project's tasks and delivers the message.
		if (method === 'tasks_list' || method === 'task_send') {
			if (!ui) throw new Error('Messages between tasks need the application');
			return ui.request(method, params);
		}
		if (method === 'add_folder') return addFolderTool(params, signal);
		if (method === 'slack_post') return slackPostTool(params, signal);
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
					// spec/tasks#agent-worktrees: a worktree found while no window could describe it joins once one is there.
					setImmediate(() => adoptAgentWorktrees());
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
								task.prReview?.mode === 'review',
								hiddenTools
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
			if ((method === 'revert_file' || method === 'save_file') && workspaceHeld)
				throw new Error('The task is moving into a worktree');
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
		// spec/crew#auto-move: a move that runs finishes (or fails and rolls back) before the host lets go of the task.
		await workspaceTask.catch(() => {});
		if (restartAfterStop) reason = 'moved';
		for (const held of heldSaves.values()) held.reject(new Error('Host is stopping'));
		heldSaves.clear();
		clearTimeout(rateTimer);
		clearInterval(idleTimer);
		clearInterval(orphanTimer);
		smoke.dispose();
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
			budget?.stop();
			await crewHost?.stop().catch(() => {});
			void terminals.closeAll();
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
	/** spec/architecture-and-platform#host-lifecycle: a hire card or a split waits for the person after its turn; it keeps the host, like a question. */
	let cards = { at: -1, count: 0 };
	function waitingCards() {
		if (cards.at !== records.length) {
			const inputs = pendingInputs(records);
			cards = { at: records.length, count: (inputs.crewHire ? 1 : 0) + (inputs.crewPlan ? 1 : 0) };
		}
		return cards.count;
	}
	function idleState() {
		return {
			background: liveBackground(records).length > 0 || liveBackgroundSubagents(records).length > 0,
			terminal: task.transport === 'terminal',
			busy,
			starting: startingAgent !== null,
			saving,
			// spec/agents-and-providers#budget-reached: a waiting budget question keeps the host, like any question.
			inputs:
				permissions.size +
				questions.size +
				proposals.size +
				(budget?.currentHold()?.state === 'asked' ? 1 : 0) +
				waitingCards(),
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
			// spec/tasks#agent-worktrees: the host's own worktree card outlives the agent's session; it waits for the person.
			if (!worktreeCards.has(p.id))
				await emit({ kind: 'permission.resolved', id: p.id, optionId: null });
		let replaying = previous?.kind === 'session.started';
		sentScopeContext = '';
		briefPending = !replaying;
		const subagentModel = task.provider === 'claude' ? await claudeSubagentModel(store.root) : null;
		// spec/agents-and-providers#compaction-window, spec/agents-and-providers#session-brief
		const window = await compactionWindow(store.root);
		transport = await AgentTransport.start({
			provider: task.provider!,
			cwd: project.path,
			...(subagentModel ? { subagentModel } : {}),
			...(window !== null ? { compactionWindow: window } : {}),
			...(brief ? { systemPrompt: brief } : {}),
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
				if (boundary && assignmentDue !== null) flushAssignment();
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
		// spec/agents-and-providers#session-brief: a brief in the system prompt never goes into the first prompt as well; one the agent refused,
		// on a load too, goes as `.context` of the next prompt.
		if (transport.briefInSystemPrompt) briefPending = false;
		else if (transport.briefRefused) briefPending = true;
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
				await store.setStatus(
					config.key,
					quotaBlocked() ? 'rate-limited' : statusAfterStop(pendingInputs(records))
				);
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
		// spec/agents-and-providers#budget-reached: the figure and the hold are rebuilt from the journal before anything is drained.
		await budget?.start();
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
		// spec/tasks#agent-worktrees: a worktree made in a turn the host did not see end, or one whose folder went while it was down.
		adoptAgentWorktrees();
		startScopeWatch();
		if (crew && (crew.role === 'foreman' || crew.role === 'lead' || crew.role === 'auto'))
			crewHost = await crewHostFor(crew);
		else {
			// spec/reviews#points: a solo task's or a crew developer's own review continues after a restart.
			const spec = ownReviewCrew(task, crew?.role ?? null);
			if (spec) crewHost = await crewHostFor(selfContext(spec));
		}
		// spec/tasks#move-to-worktree: the person's move goes on here (an Auto host resumed a hire's already).
		if (!config.consoleOnly) await mover.resume();
		await taskReview.load();
		// spec/reviews#loop: no turn runs after a restart; a review that waited for the old host's turn reads now.
		void taskReview.turnStopped().catch(() => {});
		// spec/reviews#classes: the class checks start once the review's record is loaded.
		void taskClass.start().catch(() => {});
		// spec/smoke-run#limit: a run that is open arms its limit for the time left, or stops if the limit passed meanwhile.
		void smoke.load().catch(() => {});
		// spec/reviews#plan-review: a root foreman's split that still waits after a restart.
		if (foremanTask && !crew?.parentKey) {
			const requested = records.findLast((record) => record.event.kind === 'crew.plan.requested');
			if (
				requested?.event.kind === 'crew.plan.requested' &&
				!records.some(
					(record) =>
						record.seq > requested.seq &&
						record.event.kind === 'crew.plan.resolved' &&
						record.event.id === (requested.event as { plan: CrewPlan }).plan.id
				)
			)
				waitingSplit = requested.event.plan;
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
		/** spec/crew#auto-move: the host stopped because the task moved; the process starts the next host in the new folder. */
		get restart() {
			return restartAfterStop;
		},
		get adapterInfo() {
			return transport?.info ?? null;
		},
		get records(): readonly EventRecord[] {
			return records;
		},
	};
}
import { relayContext } from './relay-context';
import { WorkspaceMover } from './workspace-mover';
import { AgentWorktrees, type FoundWorktree } from './agent-worktrees';
import {
	moveRefusal,
	worktreeCard,
	worktreeCardTitle,
	type WorktreeJoinedEvent,
} from '@brigadir/core';
import { finishSwitch, type MoveCommand, type MoveHold } from './workspace-move';
