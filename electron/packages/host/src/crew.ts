import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	approvedSpec,
	composeCrew,
	composedSpec,
	isComposing,
	isCrewSpec,
	baseTree,
	changeBaseOf,
	inTask,
	isRecord,
	isCrewPlanDecision,
	isCrewNote,
	isCrewQuestion,
	isCrewWorkerRecord,
	findSpecAgent,
	specParent,
	specChildByName,
	zoneOwns,
	crewName,
	suggestedBranch,
	transliterate,
	crewQuestionEscalationMs,
	crewNoteLimit,
	crewNotePageLimit,
	isAgentOption,
	effortLevel,
	type AgentOption,
	type AgentProvider,
	type AgentTask,
	type CrewNote,
	type CrewPlan,
	type CrewPlanDecision,
	type CrewPlanPart,
	type CrewQuestion,
	type CrewReportSummary,
	type ReviewRun,
	isReviewRun,
	crewReviewRounds,
	type CrewSpec,
	type CrewSpecAgent,
	type CrewWorkerRecord,
	type CrewNextPart,
	type EventRecord,
	type ReviewComment,
	type SessionCommand,
	type SessionEvent,
	type SessionSnapshot,
	type TaskKey,
	type ChangedFile,
	type Scope,
} from '@brigadir/core';
import {
	buildReport,
	crewProcessRole,
	humanToolsAllowed,
	foremanBrief,
	rosterBrief,
	parsePlan,
	planBlocked,
	planDifferences,
	toolAllowed,
	toolsBrief,
	workerContext,
	type CrewProcessRole,
	type CrewToolName,
	type WorkspaceTools,
} from '@brigadir/orchestrator';
import { anchorContext, diffLines, normalizeLine, unifiedDiff } from '@brigadir/diff';
import {
	readChanges,
	readBlobs,
	readSnapshots,
	changedFiles,
	gitText,
	GitError,
	squashBranch,
	syncFromParent,
	hasUnmergedPaths,
	mergeInProgress,
	rememberMerge,
	commitMessageContext,
	commitMessagePrompt,
	commitMessageText,
	previewCommits,
	commitPreview,
	Worktrees,
	discoverScopes,
	type CommitMessageSource,
} from '@brigadir/git';
import {
	atomicJson,
	readDocument,
	safePath,
	ActiveTasks,
	ProcessCoordinator,
	JournalCache,
	JsonlCache,
	type SessionStore,
} from '@brigadir/persistence';
import { oneShotText, type AdapterCommand } from '@brigadir/transport';
import { Peer } from './peer';
import { readStatus } from './client';
import { readIdentity, reclaimAbsentOwner, type HostIdentity } from './runtime';

export type CrewContext = {
	role: CrewProcessRole;
	crewKey: TaskKey;
	spec: CrewSpec;
	node: CrewSpecAgent;
	parent: CrewSpecAgent | null;
	parentKey: TaskKey | null;
	isRoot: boolean;
};
/** Which crew role this host plays: the foreman task carries the spec, a worker points at it (spec/crew-templates-and-editor#snapshot). */
export async function readCrewContext(
	store: SessionStore,
	task: AgentTask
): Promise<CrewContext | null> {
	if (task.crew)
		return {
			role: 'foreman',
			crewKey: task,
			spec: task.crew,
			node: task.crew.root,
			parent: null,
			parentKey: null,
			isRoot: true,
		};
	if (!task.crewTaskId || !task.crewNodeId) return null;
	const crewKey = { projectId: task.projectId, id: task.crewTaskId },
		crewTask = await store.task(crewKey);
	if (!crewTask.crew) throw new Error('The crew task has no crew');
	const node = findSpecAgent(crewTask.crew.root, task.crewNodeId);
	if (!node) throw new Error('The crew node is missing');
	const parentKey = task.parentTaskId
		? { projectId: task.projectId, id: task.parentTaskId }
		: crewKey;
	return {
		role: crewProcessRole(node.role, false),
		crewKey,
		spec: crewTask.crew,
		node,
		parent: specParent(crewTask.crew.root, node.id),
		parentKey,
		isRoot: false,
	};
}
/** The `.context` block of the first prompt in a session (spec/crew#task-type, spec/crew#worker-context); a foreman learns its crew's tools (spec/agents-and-providers#tools-awareness). */
export function crewBrief(context: CrewContext, tools?: WorkspaceTools): string {
	return context.node.role === 'foreman'
		? foremanBrief(context.spec, context.node.id, tools)
		: workerContext(context.spec, context.node.id, tools);
}
/** spec/chat-turns-plans-and-questions#checklist-tools: English by rule 12; the adapter turns the checklist into ACP `plan`, the chat shows it as the plan row. */
export const checklistBrief =
	'For work with three or more steps, keep a step checklist with your todo, task or plan tool (`update_plan` in Codex) and mark each step as you finish it; the person sees that checklist in the chat, so do not repeat it as a list in your messages.';
/** spec/tasks#agent-worktrees: the agent works in the checkouts it was given; a worktree of its own hides its branch and diff from the person. */
export const worktreeBrief =
	"Work in the workspace repositories as they are. Do not create git worktrees yourself (`git worktree add`): if the work needs a separate branch or checkout, ask the person first, since Brigadir runs a task in its own worktree when the person chooses that. A worktree you create at the person's request joins this task, and the app shows its branch and diff.";
/** spec/agents-and-providers#context-tools: sessions with the person's tools learn that they can see what the person has open and selected. */
export const contextBrief =
	'When the person points at something without naming it ("this", "here", "the selected code", a pull request comment), call editor_state, or pr_state for a pull request, to see what is open and selected in their window.';
/** spec/search-menus-and-commands#agent-command-tools, spec/agents-and-providers#tools-awareness: the person's saved commands come before a server the agent would start itself. */
export const commandsBrief =
	'Before you start a dev server, a watcher or a script yourself, call commands_list: the person may have saved it as a project command. Start a dev server as a project command rather than in your shell: commands_run starts it in the console of this task, where the person sees it, and waits for its local address.';
/** spec/chat-turns-plans-and-questions#plan-approval: English by rule 12; `ExitPlanMode` reaches the chat as the plan for approval (spec/chat-turns-plans-and-questions#plan-approval), `EnterPlanMode` gets there from any mode. */
export const planApprovalBrief =
	'When the person asks for a plan before the work starts (for example "make a plan first" or "I want a full plan before you do anything"), enter plan mode with EnterPlanMode, research without changing anything, and present the plan with ExitPlanMode so the person can read, edit and approve it; do not give such a plan only as a message.';
/** What the brief of a session knows: `commands` — the module is on and the project has saved commands (spec/search-menus-and-commands#agent-command-tools); `tools` — the
 *  modules on (spec/agents-and-providers#tools-awareness); `cli` — the agent runs in the terminal (spec/terminal-and-cli-agents#cli-start). */
export type BriefOptions = { commands?: boolean; tools?: WorkspaceTools; cli?: boolean };
/** Every session gets a brief: the role brief of a crew node first, then the checklist sentence (spec/chat-turns-plans-and-questions#checklist-tools), then for a Claude session that
 *  talks to the person (no crew, or the foreman) the plan sentence (spec/chat-turns-plans-and-questions#plan-approval), then for sessions with the person's tools the context sentence (spec/agents-and-providers#context-tools),
 *  then for Codex and the CLI the tools line (spec/agents-and-providers#tools-awareness: they may not show our MCP instructions to the model), then the commands sentence.
 *  Codex cannot enter its Plan mode itself; a worker answers to its foreman. */
export function sessionBrief(
	context: CrewContext | null,
	provider: AgentProvider | undefined,
	options: BriefOptions = {}
): string {
	const talksToPerson = !context || context.role === 'foreman',
		human = humanToolsAllowed(context?.role ?? null);
	return [
		context ? crewBrief(context, options.tools) : '',
		checklistBrief,
		worktreeBrief,
		provider === 'claude' && talksToPerson ? planApprovalBrief : '',
		human ? contextBrief : '',
		options.tools && (provider === 'codex' || options.cli)
			? toolsBrief(context?.role ?? null, options.tools)
			: '',
		options.commands ? commandsBrief : '',
	]
		.filter(Boolean)
		.join('\n\n');
}

/** The only records a parent acts on (`childEvent`, `awaitSessionStarted`); a worker host sends its crew peers nothing else. */
export const crewLinkEvents: ReadonlySet<SessionEvent['kind']> = new Set([
	'session.started',
	'session.failed',
	'turn.completed',
	'host.stopped',
]);
type Link = {
	key: TaskKey;
	peer: Peer;
	identity: HostIdentity;
	closed: Promise<void>;
	events: Set<(record: EventRecord) => void>;
};
export type CrewHostDeps = {
	store: SessionStore;
	key: TaskKey;
	context: CrewContext;
	services: { dataDir: string; mcpEntry: string; runtime: string; adapter?: AdapterCommand };
	emit(event: SessionEvent): Promise<void>;
	/** Prompt this host's own agent with a service message (report, question, plan decision). */
	prompt(
		text: string,
		marker: Extract<SessionEvent, { kind: 'turn.started' }>['crew']
	): Promise<void>;
	records(): readonly EventRecord[];
	/** A worker connects up to its parent through this link; leads forward notes upward. */
	parent(): { request(method: string, params: unknown): Promise<unknown> } | null;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const slug = (text: string) =>
	transliterate(text)
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'part';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Reply bounds for the model: long lines and pages would only hit the client's output limit. */
const transcriptLine = 2000,
	transcriptBytes = 64 * 1024,
	notePageBytes = 64 * 1024 - 256;
function lastMessage(records: readonly EventRecord[]): string {
	let text = '';
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'turn.started') text = '';
		if (
			event.kind === 'message.delta' &&
			event.role === 'assistant' &&
			event.content.kind === 'text'
		)
			text += event.content.text;
	}
	return text;
}
/** The model wrote the prompts it proposed; only the human's edits go back in full, otherwise which part went to whom. */
function planReply(proposed: readonly CrewPlanPart[], edited: readonly CrewPlanPart[] | null) {
	return edited
		? { edited: true, parts: edited }
		: { edited: false, parts: proposed.map((part) => ({ title: part.title, agent: part.agent })) };
}
/** spec/crew#reports: the tokens of a task so far, summed from its `turn.usage` records; null when the provider reported none. */
function taskUsage(records: readonly EventRecord[]) {
	const total = { turns: 0, input: 0, output: 0, cached: 0 };
	for (const record of records) {
		const event = record.event;
		if (event.kind !== 'turn.usage') continue;
		total.turns++;
		total.input += event.input + event.cacheWrite;
		total.output += event.output;
		total.cached += event.cacheRead;
	}
	return total.turns ? total : null;
}
/** The options the worker's session advertised last (`session.started`, then every `options.changed`). */
function sessionOptions(records: readonly EventRecord[]): AgentOption[] {
	let options: AgentOption[] = [];
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'session.started' || event.kind === 'options.changed')
			options = event.options.filter(isAgentOption);
	}
	return options;
}
function busyIn(records: readonly EventRecord[]) {
	return (
		records.findLast((record) =>
			['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(
				record.event.kind
			)
		)?.event.kind === 'turn.started'
	);
}
/**
 * The first `session.started` of a worker: its host pushes every record on the crew link, so the wait subscribes
 * first and then reads the small status once for what happened before. Only a journal that already has a start takes
 * the snapshot, to return that record. The host emits the start while its transport is still starting and refuses
 * commands until then, so the wait ends when the status says connected; that gap is the only thing polled.
 */
export async function awaitSessionStarted(
	link: Pick<Link, 'peer' | 'closed' | 'events'>,
	timeout: number
): Promise<EventRecord> {
	const found = await sessionStartRecord(link, timeout),
		end = Date.now() + timeout;
	while (!(await readStatus(link.peer)).connected) {
		if (Date.now() >= end) throw new Error('Worker startup timed out');
		await delay(25);
	}
	return found;
}
async function sessionStartRecord(
	link: Pick<Link, 'peer' | 'closed' | 'events'>,
	timeout: number
): Promise<EventRecord> {
	let listener!: (record: EventRecord) => void, timer: ReturnType<typeof setTimeout> | undefined;
	const pushed = new Promise<EventRecord>((resolve, reject) => {
		listener = (record) => {
			if (record.event.kind === 'session.started') resolve(record);
			else if (record.event.kind === 'session.failed')
				reject(new Error('Worker agent startup failed'));
		};
		timer = setTimeout(() => reject(new Error('Worker startup timed out')), timeout);
		void link.closed.then(() => reject(new Error('Host disconnected')));
	});
	pushed.catch(() => {});
	link.events.add(listener);
	try {
		const status = await readStatus(link.peer);
		if (status.started !== null) {
			const found = ((await link.peer.request('snapshot', {})) as SessionSnapshot).records.find(
				(record) => record.event.kind === 'session.started'
			);
			if (found) return found;
		}
		if (status.failed !== null) throw new Error('Worker agent startup failed');
		return await pushed;
	} finally {
		link.events.delete(listener);
		clearTimeout(timer);
	}
}
/** Foreman or lead side: plans, workers, reports, reviews and acceptance (spec/crew#task-type, spec/crew#communication). Owns crew-*.json in this task's directory. */
export class CrewHost {
	private workers: CrewWorkerRecord[] = [];
	private links = new Map<string, Link>();
	private connecting = new Map<string, Promise<Link | null>>();
	private planWaiter: {
		plan: CrewPlan;
		resolve(decision: CrewPlanDecision): void;
		reject(error: Error): void;
	} | null = null;
	private questions: CrewQuestion[] = [];
	private questionWaiters = new Map<
		string,
		{ resolve(answer: string): void; reject(error: Error): void }
	>();
	private escalations = new Map<string, ReturnType<typeof setTimeout>>();
	private waiting: string[] = [];
	private waitTimer: ReturnType<typeof setTimeout> | null = null;
	private stopping = false;
	private tail: Promise<unknown> = Promise.resolve();
	private reportSeqs = new Map<string, number>();
	private reviews: ReviewRun[] = [];
	/** Worker journals and crew notes are append-only: each tool call reads only what was appended since. */
	private journals = new JournalCache(4);
	private notes = new JsonlCache<CrewNote>((line, count) => {
		const value: unknown = JSON.parse(line);
		if (!isCrewNote(value) || value.seq !== count + 1) throw new Error('invalid_note');
		return value;
	}, 1);
	constructor(private deps: CrewHostDeps) {}
	/**
	 * spec/pull-requests-and-ci#review-crew: the crew task reviews a PR (`prReview.mode === 'review'`). Its reviewers are then the workers: they start
	 * without a plan, read-only, on the PR head (`refs/brigadir-v2/pr/N`, no setup command in a quick review), report their
	 * findings up and are accepted without a merge. Any other crew keeps the rules of spec/crew#communication.
	 */
	private reviewing: { number: number; scopeId: string; quick: boolean } | null | undefined;
	private async review() {
		if (this.reviewing === undefined) {
			const task = await this.deps.store.task(this.deps.context.crewKey);
			this.reviewing =
				task.prReview?.mode === 'review'
					? {
							number: task.prReview.number,
							scopeId: task.prReview.scopeId,
							quick: task.launch?.isolation !== 'worktree',
						}
					: null;
		}
		return this.reviewing;
	}
	/** A reviewer some sibling names in `checkedBy` checks that sibling; one nobody names is a review worker in a PR review. */
	private checks(agent: CrewSpecAgent) {
		return this.node.agents.some((item) => item.checkedBy.includes(agent.id));
	}
	private isReviewWorker(agent: CrewSpecAgent | null | undefined) {
		return !!this.reviewing && agent?.role === 'reviewer' && !this.checks(agent);
	}
	/** The parts of the crew: every worker but a checker; in a PR review the reviewers are its parts. */
	private isPart(worker: CrewWorkerRecord) {
		const agent = findSpecAgent(this.deps.context.spec.root, worker.nodeId);
		return agent?.role !== 'reviewer' || this.isReviewWorker(agent);
	}
	private journal(key: TaskKey) {
		return this.journals.read(this.deps.store, key);
	}
	private get node() {
		return this.deps.context.node;
	}
	private async file(part: string) {
		return safePath(await this.deps.store.taskDir(this.deps.key), part);
	}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	async start() {
		await this.review().catch(() => {});
		try {
			const doc = await readDocument(await this.file('crew-workers.json'));
			if (Array.isArray(doc.workers) && doc.workers.every(isCrewWorkerRecord))
				this.workers = doc.workers;
			if (isRecord(doc.reportSeqs))
				for (const [id, seq] of Object.entries(doc.reportSeqs))
					if (Number.isSafeInteger(seq)) this.reportSeqs.set(id, Number(seq));
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
		}
		try {
			const doc = await readDocument(await this.file('crew-reviews.json'), 16 * 1024 * 1024);
			if (Array.isArray(doc.reviews) && doc.reviews.every(isReviewRun)) this.reviews = doc.reviews;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
		}
		try {
			const doc = await readDocument(await this.file('crew-questions.json'));
			if (Array.isArray(doc.questions) && doc.questions.every(isCrewQuestion))
				this.questions = doc.questions;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
		}
		for (const question of this.questions.filter(
			(item) => item.state === 'pending' || item.state === 'escalated'
		))
			this.scheduleEscalation(question);
		for (const worker of this.workers.filter((worker) => !worker.acceptedAt)) {
			const key = { projectId: this.deps.key.projectId, id: worker.taskId };
			void this.link(key).then(
				(link) => {
					if (!link) this.awaitHost(key);
				},
				() => this.awaitHost(key)
			);
		}
		void this.serial(async () => {
			await this.dispatchReviews().catch(() => {});
			for (const worker of this.workers.filter((worker) => !worker.acceptedAt)) {
				const task = await this.deps.store
					.task({ projectId: this.deps.key.projectId, id: worker.taskId })
					.catch(() => null);
				if ((task?.status === 'queued' && !task.hasStarted) || worker.next?.state === 'queued')
					this.waiting.push(worker.taskId);
			}
			this.watchSlots();
			this.watchMerges();
		});
	}
	async stop() {
		this.stopping = true;
		this.launchAbort.abort();
		for (const watcher of this.hostWatchers.values()) watcher.close();
		this.hostWatchers.clear();
		if (this.waitTimer) clearTimeout(this.waitTimer);
		if (this.mergeTimer) clearTimeout(this.mergeTimer);
		for (const timer of this.escalations.values()) clearTimeout(timer);
		this.planWaiter?.reject(new Error('Host is stopping'));
		for (const waiter of this.questionWaiters.values())
			waiter.reject(new Error('Host is stopping'));
		for (const link of this.links.values()) link.peer.close();
		await this.tail.catch(() => {});
		await Promise.allSettled(this.launching.values());
		// Work that was in flight may have linked a worker after the first pass; an open crew socket would keep this host alive.
		for (const link of this.links.values()) link.peer.close();
	}
	private async saveWorkers() {
		await atomicJson(await this.file('crew-workers.json'), {
			schemaVersion: 1,
			workers: this.workers,
			reportSeqs: Object.fromEntries(this.reportSeqs),
		});
	}
	private async saveReviews() {
		await atomicJson(await this.file('crew-reviews.json'), {
			schemaVersion: 1,
			reviews: this.reviews,
		});
	}
	private async saveQuestions() {
		await atomicJson(await this.file('crew-questions.json'), {
			schemaVersion: 1,
			questions: this.questions,
		});
	}
	private worker(taskId: unknown): CrewWorkerRecord {
		const worker =
			typeof taskId === 'string' ? this.workers.find((item) => item.taskId === taskId) : undefined;
		if (!worker)
			throw new Error(
				`Unknown worker task ${String(taskId)}. Your workers: ${this.workers.map((item) => `${item.name} (${item.taskId})`).join(', ') || 'none'}.`
			);
		return worker;
	}
	private workerKey(worker: CrewWorkerRecord): TaskKey {
		return { projectId: this.deps.key.projectId, id: worker.taskId };
	}
	/** Two guards (spec/crew#task-type): the MCP server lists tools by role, and the host refuses anything else. */
	async tool(tool: string, params: unknown, signal: AbortSignal): Promise<unknown> {
		if (!toolAllowed(this.deps.context.role, tool))
			throw new Error(`Tool ${tool} is not available to this agent`);
		const input = isRecord(params) ? params : {};
		switch (tool as CrewToolName) {
			case 'propose_plan':
				return this.proposePlan(input, signal);
			case 'create_worker_task':
				return this.createWorkerTask(input);
			case 'prompt_task':
				return this.promptTask(input);
			case 'task_status':
				return this.taskStatus(input);
			case 'read_report':
				return this.readReport(input);
			case 'read_transcript':
				return this.readTranscript(input);
			case 'read_diff':
				return this.readDiff(input);
			case 'submit_review':
				return this.submitReview(input);
			case 'accept_task':
				return this.acceptTask(input);
			case 'post_note':
				return this.postNote(
					input,
					this.deps.key,
					this.node.id,
					this.node.name,
					typeof input.callId === 'string' ? input.callId : randomUUID()
				);
			case 'read_notes':
				return this.readNotes(input);
			case 'ask_foreman':
				throw new Error('ask_foreman is handled by the worker side');
			default:
				throw new Error(`Unknown tool ${tool}`);
		}
	}
	// ── plan ──────────────────────────────────────────────────────────────
	private async proposePlan(input: Record<string, unknown>, signal: AbortSignal) {
		if (this.planWaiter) throw new Error('A plan is already waiting for the human');
		const parsed = parsePlan(input, () => randomUUID());
		// spec/crew#compose: a composing foreman proposes its crew with the plan; parts are checked against that crew.
		const composing = this.deps.context.isRoot && isComposing(this.deps.context.spec);
		if (!composing && input.crew !== undefined)
			throw new Error('Your crew is already set; call propose_plan without crew.');
		const plan = composing
			? { ...parsed, crew: composeCrew(this.deps.context.spec, input.crew, () => randomUUID()) }
			: parsed;
		const differences = planDifferences(this.planSpec(plan), this.node.id, plan.parts);
		const blocking = differences.filter((item) => item.code !== 'idle_agent');
		if (blocking.length)
			throw new Error(
				`The plan does not match the crew: ${blocking.map((item) => item.message).join(' ')}`
			);
		if (!this.deps.context.isRoot) {
			// spec/crew#subordinates: a lead's plan is visible in its activity as a plan, but only the root foreman's plan waits for the human.
			const decision: CrewPlanDecision = { id: plan.id, approved: true, parts: null };
			await atomicJson(await this.file('crew-plan.json'), { schemaVersion: 1, plan, decision });
			await this.deps.emit({ kind: 'crew.plan.requested', plan });
			await this.deps.emit({
				kind: 'crew.plan.resolved',
				id: plan.id,
				approved: true,
				parts: null,
			});
			return {
				approved: true,
				...planReply(plan.parts, null),
				differences: differences.map((item) => item.message),
				note: 'Your parent accepts the branch as one report; the human confirms only the root plan.',
			};
		}
		await atomicJson(await this.file('crew-plan.json'), { schemaVersion: 1, plan, decision: null });
		await this.deps.emit({ kind: 'crew.plan.requested', plan });
		const decision = await new Promise<CrewPlanDecision>((resolve, reject) => {
			this.planWaiter = { plan, resolve, reject };
			const abort = () => {
				if (this.planWaiter?.plan.id === plan.id) {
					this.planWaiter = null;
					reject(new Error('Plan proposal was cancelled'));
				}
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
		return {
			approved: decision.approved,
			...planReply(plan.parts, decision.parts),
			...(plan.crew && decision.approved
				? {
						crew: `${decision.crew ? 'The human edited your crew. ' : ''}${rosterBrief(this.deps.context.spec)}`,
					}
				: {}),
			differences: differences.map((item) => item.message),
		};
	}
	/** Human decision (spec/crew#task-type rule 2, spec/crew#plan). A completed proposing turn needs a prompt even if its MCP call survived. */
	async decidePlan(decision: CrewPlanDecision) {
		if (!isCrewPlanDecision(decision)) throw new Error('Invalid plan decision');
		const pending = this.planWaiter?.plan ?? (await this.pendingPlan());
		if (!pending || pending.id !== decision.id) throw new Error('The plan is no longer pending');
		if (decision.crew && !pending.crew) throw new Error('This plan has no crew to edit');
		const crew = decision.crew ?? pending.crew,
			spec = crew ? composedSpec(this.deps.context.spec, crew) : this.deps.context.spec;
		if (crew && !isCrewSpec(spec)) throw new Error('The crew is invalid');
		if (decision.approved) {
			const parts = decision.parts ?? pending.parts,
				differences = planDifferences(spec, this.node.id, parts);
			if (planBlocked(differences))
				throw new Error(
					`The plan does not match the crew: ${differences
						.filter((item) => item.code !== 'idle_agent')
						.map((item) => item.message)
						.join(' ')}`
				);
		}
		await atomicJson(await this.file('crew-plan.json'), {
			schemaVersion: 1,
			plan: pending,
			decision,
		});
		// spec/crew#compose: the approved crew becomes the task's snapshot; this host and every worker read it from there.
		if (decision.approved && crew) await this.adoptCrew(crew);
		await this.deps.emit({
			kind: 'crew.plan.resolved',
			id: decision.id,
			approved: decision.approved,
			parts: decision.parts,
			...(decision.crew ? { crew: decision.crew } : {}),
		});
		if (this.planWaiter?.plan.id === decision.id) {
			const waiter = this.planWaiter;
			this.planWaiter = null;
			waiter.resolve(decision);
			// Codex may finish a turn with an MCP call still pending. Returning its result alone cannot wake that turn.
			const records = this.deps.records();
			const requested = records.findLastIndex(
				({ event }) => event.kind === 'crew.plan.requested' && event.plan.id === decision.id
			);
			const ended =
				requested >= 0 &&
				records
					.slice(requested + 1)
					.some(
						({ event }) =>
							event.kind === 'turn.completed' ||
							event.kind === 'session.failed' ||
							event.kind === 'host.stopped'
					);
			if (!ended) return;
		}
		const parts = decision.parts ?? pending.parts,
			approvedCrew =
				decision.approved && crew
					? ` ${decision.crew ? 'The human edited your crew. ' : ''}${rosterBrief(this.deps.context.spec)}`
					: '';
		await this.deps.prompt(
			decision.approved
				? `The human approved your plan${decision.parts ? ' with edits' : ''}.${approvedCrew} Create the worker tasks now with create_worker_task, one per part, using these agent names and prompts:\n${JSON.stringify(parts, null, 2)}`
				: 'The human rejected your plan. Ask what to change or propose a different split.',
			{ kind: 'plan-decision', planId: decision.id, approved: decision.approved }
		);
	}
	/** The spec a plan is checked against: the proposed crew while the foreman composes (spec/crew#compose). */
	private planSpec(plan: CrewPlan): CrewSpec {
		return plan.crew ? composedSpec(this.deps.context.spec, plan.crew) : this.deps.context.spec;
	}
	private async adoptCrew(crew: readonly CrewSpecAgent[]) {
		const spec = approvedSpec(this.deps.context.spec, crew),
			task = await this.deps.store.task(this.deps.key);
		await this.deps.store.updateTask(task, { crew: spec });
		this.deps.context.spec = spec;
		this.deps.context.node = spec.root;
	}
	private async pendingPlan(): Promise<CrewPlan | null> {
		try {
			const doc = await readDocument(await this.file('crew-plan.json'));
			return doc.decision === null && isRecord(doc.plan) ? (doc.plan as CrewPlan) : null;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
	}
	private async planApproved() {
		const records = this.deps.records();
		return records.some(
			(record) => record.event.kind === 'crew.plan.resolved' && record.event.approved
		);
	}
	// ── workers ───────────────────────────────────────────────────────────
	private resolveAgent(nameInput: unknown): CrewSpecAgent {
		const children = this.node.agents.filter((agent) => agent.role !== 'reviewer');
		if (nameInput === undefined || nameInput === null || nameInput === '') {
			if (children.length === 1) return children[0]!;
			throw new Error(
				`Pass agent: one of ${this.node.agents.map((agent) => agent.name).join(', ')}.`
			);
		}
		if (typeof nameInput !== 'string') throw new Error('agent must be a string');
		const agent = specChildByName(this.node, nameInput);
		if (!agent)
			throw new Error(
				`No agent named ${crewName(nameInput)}. Your agents: ${this.node.agents.map((item) => item.name).join(', ')}.`
			);
		return agent;
	}
	private async createWorkerTask(input: Record<string, unknown>) {
		// spec/pull-requests-and-ci#review-crew: the person chose the crew and asked for the review, so a PR review has no plan to approve.
		const review = await this.review();
		if (!review && !(await this.planApproved()))
			throw new Error('Call propose_plan first; workers start after the human confirms the plan.');
		const agent = this.resolveAgent(input.agent);
		if (agent.role === 'reviewer' && !this.isReviewWorker(agent))
			throw new Error(
				`${agent.name} is a reviewer and takes no part of the code; the host starts reviewers itself.`
			);
		// spec/crew#parts: one task per member for the whole crew; its newest record when an older crew made several.
		const own = this.workers.filter((worker) => worker.nodeId === agent.id).at(-1);
		if (own?.next?.state === 'merging')
			throw new Error(
				`The next part «${own.title}» of ${agent.name} waits for the human: merging your tree into its branch stopped at a conflict. It starts by itself when the merge is finished.`
			);
		if (own && !own.acceptedAt)
			throw new Error(
				`${agent.name} works on part «${own.title}» in task ${own.taskId}. Change or return that part with prompt_task; after you accept it, call create_worker_task for the next part, and it continues in the same task.`
			);
		const title = typeof input.title === 'string' ? crewName(input.title).slice(0, 80) : '';
		if (!title) throw new Error('title is required');
		const prompt = typeof input.prompt === 'string' ? input.prompt : '';
		if (!prompt.trim()) throw new Error('prompt is required');
		if (prompt.length > 200_000) throw new Error('prompt is too long');
		const files = Array.isArray(input.files)
			? input.files.filter((file): file is string => typeof file === 'string')
			: [];
		const outside = files.filter((file) => agent.zone.length && !zoneOwns(agent.zone, file));
		if (outside.length)
			throw new Error(
				`Files outside the zone of ${agent.name} (${agent.zone.join(', ')}): ${outside.slice(0, 5).join(', ')}`
			);
		const scopes = Array.isArray(input.scopes)
			? input.scopes.filter((scope): scope is string => typeof scope === 'string')
			: [];
		if (own) {
			const task = await this.deps.store.task(this.workerKey(own)).catch(() => null);
			if (task) return this.continueWorker(own, title, prompt, scopes, task);
			// The human deleted the finished worker task (spec/tasks#delete-task): the member starts over in a new one.
			this.workers = this.workers.filter((worker) => worker !== own);
			await this.saveWorkers();
		}
		const record = await this.spawnWorkerTask(agent, title, prompt, scopes);
		// spec/crew#reviewer: reviewers of this agent start with it, as workers without files, and wait for reports.
		for (const checkerId of agent.checkedBy) {
			const checker = this.node.agents.find((item) => item.id === checkerId);
			if (checker) await this.ensureReviewer(checker).catch(() => {});
		}
		return { taskId: record.taskId, agent: agent.name, title, status: 'queued' };
	}
	private async spawnWorkerTask(
		agent: CrewSpecAgent,
		title: string,
		prompt: string,
		requestedScopes: string[]
	): Promise<CrewWorkerRecord> {
		const store = this.deps.store,
			parentTask = await store.task(this.deps.key),
			project = await store.project(this.deps.key.projectId);
		const scopes = await this.scopesOf(project.path);
		const root = scopes.find((scope) => scope.kind === 'root');
		if (!root) throw new Error('Workers need a Git repository: the project root is not one.');
		const parentLaunch = parentTask.launch,
			review = await this.review(),
			// spec/pull-requests-and-ci#review-crew: a PR review's workers stand on the PR head that `pullRequests.prepare` fetched into the PR's repo.
			baseRef = review
				? `refs/brigadir-v2/pr/${review.number}`
				: parentLaunch?.isolation === 'worktree'
					? parentLaunch.branch
					: 'HEAD';
		// Git refs are files: `parent/child` cannot exist next to `parent`, so worker branches hang off the parent's name with a dash.
		const base =
			`${parentLaunch?.isolation === 'worktree' ? parentLaunch.branch : suggestedBranch('', parentTask.title, parentTask.id)}-${slug(agent.name)}`.slice(
				0,
				180
			);
		// Names, not ids: `<parent>-<agent>`, then `-2`, `-3` only when that branch already exists somewhere in the project.
		// One `for-each-ref` per repo lists the taken `<base>*` names.
		const taken = new Set(
			(
				await Promise.all(
					scopes.map((scope) =>
						gitText(scope.path, [
							'for-each-ref',
							'--format=%(refname)',
							`refs/heads/${base}*`,
						]).catch(() => '')
					)
				)
			)
				.flatMap((text) => text.split('\n'))
				.filter(Boolean)
				.map((ref) => ref.slice('refs/heads/'.length))
		);
		let branch = base;
		for (let attempt = 2; attempt < 100 && taken.has(branch); attempt++)
			branch = `${base}-${attempt}`;
		// spec/pull-requests-and-ci#review-crew: every worker of a PR review only reads, and only the PR's repo has the PR head.
		const reviewer = agent.role === 'reviewer' || !!review,
			prScope = review ? scopes.some((scope) => scope.id === review.scopeId) : false;
		// spec/projects-and-board#repo-selection: a reviewer takes the SAME repos as the parent task. It gets no write access
		// because the host refuses its writes by role (`readOnlyAgent`), not by the repo set.
		const launchScopes = scopes.map((scope) => {
			if (review && prScope)
				return {
					id: scope.id,
					name: scope.name,
					kind: scope.kind,
					selected: scope.id === review.scopeId,
				};
			const chosen = parentLaunch?.scopes.find((choice) => choice.id === scope.id);
			const selected = reviewer
				? chosen
					? chosen.selected
					: true
				: requestedScopes.length
					? requestedScopes.includes(scope.name) ||
						requestedScopes.includes(scope.id) ||
						(scope.kind === 'root' && requestedScopes.includes('.'))
					: chosen
						? chosen.selected
						: true;
			return { id: scope.id, name: scope.name, kind: scope.kind, selected };
		});
		let task = await store.createTask(
			this.deps.key.projectId,
			prompt,
			agent.provider,
			'gui',
			title,
			'queued',
			{
				isolation: 'worktree',
				branch,
				baseRef,
				// spec/pull-requests-and-ci#review-crew: a quick review installs nothing — the reviewers read the PR.
				setupCommand: review?.quick ? '' : (parentLaunch?.setupCommand ?? ''),
				copyEnvFiles: parentLaunch?.copyEnvFiles === true,
				scopes: launchScopes,
			}
		);
		const planPart = (await this.approvedParts()).find(
			(part) => crewName(part.agent) === agent.name
		);
		task = await store.updateTask(task, {
			title,
			crewTaskId: this.deps.context.crewKey.id,
			crewNodeId: agent.id,
			parentTaskId: this.deps.key.id,
			...(reviewer ? { readOnlyAgent: true } : {}),
			launchOptions: Object.entries(agent.requestedChoices.configOptions ?? {}).map(
				([id, value]) => ({ id, value })
			),
		});
		const record: CrewWorkerRecord = {
			taskId: task.id,
			nodeId: agent.id,
			name: agent.name,
			title,
			createdAt: new Date().toISOString(),
			planPartId: planPart?.id ?? null,
		};
		this.workers.push(record);
		await this.saveWorkers();
		await this.deps.emit({
			kind: 'crew.worker.created',
			taskId: task.id,
			nodeId: agent.id,
			name: agent.name,
			title,
		});
		this.waiting.push(task.id);
		this.watchSlots();
		return record;
	}
	/** One discovery serves a burst of worker creations (the parts of a plan and their reviewers), for 10 s. */
	private discovered: { path: string; at: number; scopes: Promise<Scope[]> } | null = null;
	private scopesOf(path: string): Promise<Scope[]> {
		if (
			!this.discovered ||
			this.discovered.path !== path ||
			Date.now() - this.discovered.at > 10_000
		) {
			const scopes = discoverScopes(path);
			this.discovered = { path, at: Date.now(), scopes };
			scopes.catch(() => {
				if (this.discovered?.scopes === scopes) this.discovered = null;
			});
		}
		return this.discovered.scopes;
	}
	private async ensureReviewer(checker: CrewSpecAgent): Promise<CrewWorkerRecord> {
		const existing = this.workers.find(
			(worker) => worker.nodeId === checker.id && !worker.acceptedAt
		);
		if (existing) return existing;
		const checks = this.node.agents
			.filter((agent) => agent.checkedBy.includes(checker.id))
			.map((agent) => agent.name);
		return this.spawnWorkerTask(
			checker,
			`checks ${checks.join(', ')}`.slice(0, 80),
			`You check the work of ${checks.map((name) => `\`${name}\``).join(', ')}. Reports to check arrive as prompts with a reviewId. Until then, wait; do not modify files.`,
			[]
		);
	}
	// ── next parts of a member (spec/crew#parts) ───────────────────────────────────
	/**
	 * spec/crew#parts: the next part of a member whose part was accepted goes into the same task and session. The crew tree is merged
	 * into the worker branch first; a conflict waits for the human in the worker's task and the part starts when the merge is done.
	 */
	private async continueWorker(
		worker: CrewWorkerRecord,
		title: string,
		prompt: string,
		requestedScopes: string[],
		task: AgentTask
	) {
		const key = this.workerKey(worker),
			store = this.deps.store;
		if (busyIn((await this.journal(key)).records))
			throw new Error(
				`${worker.name} is busy in task ${worker.taskId}: the human is talking to it. Give it the next part after its turn ends.`
			);
		// ACP roots are negotiated when the session starts: a later part keeps the repos of the task.
		const chosen = (task.launch?.scopes ?? []).filter((scope) => scope.selected),
			missing = requestedScopes.filter(
				(name) =>
					!chosen.some(
						(scope) =>
							scope.name === name || scope.id === name || (scope.kind === 'root' && name === '.')
					)
			);
		if (missing.length)
			throw new Error(
				`A next part keeps the repos of task ${worker.taskId} (${chosen.map((scope) => scope.name).join(', ') || 'none'}); it cannot add ${missing.join(', ')}.`
			);
		// spec/pull-requests-and-ci#review-crew: a PR review merges nothing — the reviewer's tree stays the PR head.
		const review = await this.review();
		const part = (worker.part ?? 1) + 1,
			sync = review ? { conflicts: [], heads: {} } : await this.syncWorker(worker, part);
		const next: CrewNextPart = {
			prompt: review
				? `Part ${part} of your work: ${title}.\nYour previous part was accepted.\n\n${prompt}`
				: `Part ${part} of your work: ${title}.\nYour previous part was accepted. The crew's tree, with everything accepted so far, was merged into your branch before this part, so read a file again before you change it.\n\n${prompt}`,
			state: sync.conflicts.length ? 'merging' : 'queued',
			previous: { title: worker.title, acceptedAt: worker.acceptedAt! },
			...(sync.conflicts.length ? { heads: sync.heads } : {}),
		};
		worker.title = title;
		worker.part = part;
		delete worker.acceptedAt;
		worker.next = next;
		const planPart = (await this.approvedParts()).find(
			(item) => crewName(item.agent) === worker.name
		);
		if (planPart) worker.planPartId = planPart.id;
		await this.saveWorkers();
		await store.updateTask(key, { title });
		await this.deps.emit({
			kind: 'crew.part.started',
			taskId: worker.taskId,
			nodeId: worker.nodeId,
			name: worker.name,
			title,
			part,
		});
		if (sync.conflicts.length) {
			await store.setStatus(key, 'needs-you');
			this.watchMerges();
			return {
				taskId: worker.taskId,
				agent: worker.name,
				title,
				part,
				continued: true,
				status: 'needs-you',
				conflicts: sync.conflicts,
				note: 'Merging your tree into the worker branch stopped at a conflict. The human resolves it in the worker task; the part starts by itself when the merge is finished. Do not resolve it yourself.',
			};
		}
		await store.setStatus(key, 'queued');
		this.waiting.push(worker.taskId);
		this.watchSlots();
		return {
			taskId: worker.taskId,
			agent: worker.name,
			title,
			part,
			continued: true,
			status: 'queued',
		};
	}
	/** The repos a part moves through: the worker's repos whose branch the parent's tree has (spec/crew#task-type, spec/crew#accept). */
	private async partTargets(worker: CrewWorkerRecord) {
		const key = this.workerKey(worker),
			store = this.deps.store;
		const parentProject = await store.projectForTask(this.deps.key),
			workerProject = await store.projectForTask(key);
		const snapshots = await readSnapshots(store, key);
		const scopes = (snapshots?.scopes ?? []).filter((scope) => scope.available !== false);
		const branch = (await store.task(key)).launch?.branch;
		if (!branch) throw new Error('The worker has no branch');
		const targets: { scope: Scope; relativePath: string; target: string }[] = [];
		for (const scope of scopes) {
			const relativePath =
				scope.path === workerProject.path ? '' : scope.path.slice(workerProject.path.length + 1);
			const target = relativePath ? join(parentProject.path, relativePath) : parentProject.path;
			const hasBranch = await gitText(target, [
				'rev-parse',
				'--verify',
				'--quiet',
				`refs/heads/${branch}`,
			]).catch(() => '');
			if (hasBranch) targets.push({ scope, relativePath, target });
		}
		return { snapshots, scopes, branch, targets };
	}
	/** spec/crew#parts: the parent's HEAD into each worker repo; nothing starts while the parent's own merge or squash is unfinished. */
	private async syncWorker(
		worker: CrewWorkerRecord,
		part: number
	): Promise<{ conflicts: string[]; heads: Record<string, string> }> {
		const { branch, targets } = await this.partTargets(worker);
		for (const { scope, target } of targets)
			if (
				(await mergeInProgress({ ...scope, path: target }).catch(() => false)) ||
				(await hasUnmergedPaths(target).catch(() => false))
			)
				throw new Error(
					`The merge of an accepted part into your tree is not finished (a conflict for the human). ${worker.name} starts its next part on your tree after that.`
				);
		const conflicts: string[] = [],
			heads: Record<string, string> = {};
		for (const { scope, relativePath, target } of targets) {
			const head = await gitText(target, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
				() => ''
			);
			if (!head) continue;
			const into =
				(await gitText(target, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')) ||
				'HEAD';
			const result = await syncFromParent(
				scope.path,
				head,
				worker.acceptedTips?.[relativePath] ?? null,
				`Brigadir: ${into} into ${branch} for part ${part}`
			);
			if (!result.conflicts.length) continue;
			heads[relativePath] = head;
			conflicts.push(
				...result.conflicts.map((path) => (relativePath ? `${relativePath}/${path}` : path))
			);
			// The merge strip of the worker task names the crew branch instead of a bare commit (spec/git#merge).
			await rememberMerge(this.deps.store, this.workerKey(worker), scope.id, {
				from: into,
				into: branch,
				conflicts: result.conflicts,
				agent: [],
			}).catch(() => {});
		}
		return { conflicts, heads };
	}
	/**
	 * The waiting part of a member: the host starts again and resumes the session; its checkpoint after the merge is the part's
	 * change base (spec/crew#parts), written before the prompt so the first turn of the part already counts from it.
	 */
	private async startNextPart(worker: CrewWorkerRecord) {
		const key = this.workerKey(worker),
			store = this.deps.store,
			next = worker.next!;
		const stopped =
			(await this.journal(key)).records.findLast((record) => record.event.kind === 'host.stopped')
				?.seq ?? 0;
		await store.setStatus(key, 'preparing');
		const link = await this.spawn(key);
		await link.peer.request('start_agent', { allowScopeConflict: false });
		// The session of this host instance: its metadata is on disk before the record shows, so task.json is not written twice at once.
		const end = Date.now() + 90_000;
		for (;;) {
			const status = await readStatus(link.peer);
			if (status.failed !== null && status.failed > stopped)
				throw new Error('Worker agent startup failed');
			if (status.connected && status.started !== null && status.started > stopped) break;
			if (Date.now() >= end) throw new Error('Worker startup timed out');
			if (this.stopping) throw new Error('Host is stopping');
			await delay(50);
		}
		await link.peer.request('command', { kind: 'checkpoint' });
		const base = (await readSnapshots(store, key))?.checkpoints.at(-1)?.id;
		if (base !== undefined) await store.updateTask(key, { changeBase: base });
		await link.peer.request('command', { kind: 'prompt', text: next.prompt });
		await this.serial(async () => {
			delete worker.next;
			await this.saveWorkers();
		});
	}
	/** spec/crew#parts: a part held by a merge conflict starts when the human finishes the merge; an aborted merge withdraws it. */
	private mergeTimer: ReturnType<typeof setTimeout> | null = null;
	private watchMerges() {
		if (
			this.stopping ||
			this.mergeTimer ||
			!this.workers.some((worker) => worker.next?.state === 'merging')
		)
			return;
		this.mergeTimer = setTimeout(() => {
			this.mergeTimer = null;
			void this.serial(() => this.checkMerges())
				.catch(() => {})
				.finally(() => this.watchMerges());
		}, 3000);
		this.mergeTimer.unref?.();
	}
	private async checkMerges() {
		for (const worker of this.workers.filter((item) => item.next?.state === 'merging')) {
			const next = worker.next!,
				key = this.workerKey(worker),
				store = this.deps.store;
			const { targets } = await this.partTargets(worker).catch(() => ({
				targets: [] as { scope: Scope; relativePath: string; target: string }[],
			}));
			let open = false,
				aborted = false;
			for (const { scope, relativePath } of targets) {
				const head = next.heads?.[relativePath];
				if (!head) continue;
				if (
					(await mergeInProgress(scope).catch(() => true)) ||
					(await hasUnmergedPaths(scope.path).catch(() => true))
				) {
					open = true;
					break;
				}
				if (
					!(await gitText(scope.path, ['merge-base', '--is-ancestor', head, 'HEAD']).then(
						() => true,
						() => false
					))
				)
					aborted = true;
			}
			if (open) continue;
			for (const { scope, relativePath } of targets)
				if (next.heads?.[relativePath])
					await rememberMerge(store, key, scope.id, null).catch(() => {});
			if (aborted) {
				const title = worker.title,
					part = worker.part ?? 2;
				worker.title = next.previous.title;
				worker.acceptedAt = next.previous.acceptedAt;
				worker.part = Math.max(1, part - 1);
				delete worker.next;
				await this.saveWorkers();
				await store.updateTask(key, { title: worker.title }).catch(() => {});
				await store.setStatus(key, 'completed').catch(() => {});
				await this.deps.emit({
					kind: 'crew.part.dropped',
					taskId: worker.taskId,
					nodeId: worker.nodeId,
					name: worker.name,
					title,
					part,
				});
				await this.deps.prompt(
					`The human cancelled merging your tree into the branch of \`${worker.name}\`, so its part ${part} «${title}» did not start. ${worker.name} keeps its accepted part. Call create_worker_task again to retry, or split the work differently.`,
					{ kind: 'part-dropped', taskId: worker.taskId, agent: worker.name, part }
				);
				continue;
			}
			next.state = 'queued';
			delete next.heads;
			await this.saveWorkers();
			await store.setStatus(key, 'queued').catch(() => {});
			this.waiting.push(worker.taskId);
			this.watchSlots();
		}
	}
	private async approvedParts(): Promise<CrewPlanPart[]> {
		const record = this.deps
			.records()
			.findLast((record) => record.event.kind === 'crew.plan.resolved' && record.event.approved);
		if (!record || record.event.kind !== 'crew.plan.resolved') return [];
		if (record.event.parts) return record.event.parts;
		const requested = this.deps
			.records()
			.findLast(
				(item) =>
					item.event.kind === 'crew.plan.requested' &&
					item.event.plan.id === (record.event as { id: string }).id
			);
		return requested?.event.kind === 'crew.plan.requested' ? requested.event.plan.parts : [];
	}
	/** spec/tasks#launch-sheet: workers count against the agent limit; beyond it they wait as queued and start when a slot frees. */
	/**
	 * Only choosing the next worker is serial. Its launch (worktree, setup command, host, handshake) runs beside
	 * notes, questions, reviews and stop, at most two at a time; a launching worker holds its slot until it is working.
	 */
	private launching = new Map<string, Promise<void>>();
	private launchAbort = new AbortController();
	private watchSlots() {
		if (this.stopping) return;
		if (this.waitTimer) clearTimeout(this.waitTimer);
		this.waitTimer = null;
		void this.serial(async () => {
			while (this.waiting.length && !this.stopping && this.launching.size < 2) {
				if (!(await this.hasSlot())) break;
				const taskId = this.waiting.shift()!;
				const worker = this.workers.find((item) => item.taskId === taskId);
				if (!worker || this.launching.has(taskId)) continue;
				this.launching.set(
					taskId,
					(async () => {
						try {
							await this.launchWorker(worker);
							await this.serial(() => this.dispatchReviews());
						} catch (error) {
							// A stop interrupts the launch: the worker waits as queued for the next start instead of failing.
							if (this.stopping) {
								await this.deps.store.setStatus(this.workerKey(worker), 'queued').catch(() => {});
								return;
							}
							const message = error instanceof Error ? error.message : String(error);
							await this.deps.store.setStatus(this.workerKey(worker), 'failed').catch(() => {});
							await this.deps.emit({
								kind: 'crew.worker.stopped',
								taskId: worker.taskId,
								nodeId: worker.nodeId,
								name: worker.name,
								reason: message,
							});
						}
					})().finally(() => {
						this.launching.delete(taskId);
						this.watchSlots();
					})
				);
			}
			if (this.waiting.length && !this.stopping) {
				this.waitTimer = setTimeout(() => this.watchSlots(), 3000);
				this.waitTimer.unref?.();
			}
		});
	}
	/** Settings and every task.json are re-read only when their stat changes; the 3 s wait loop stays. */
	private limit: { stamp: string; value: number | null } | null = null;
	private active = new ActiveTasks();
	private async hasSlot() {
		const path = await safePath(this.deps.store.root, 'settings.json'),
			info = await lstat(path).catch(() => null),
			stamp = info ? `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : '';
		if (this.limit?.stamp !== stamp) {
			let value: number | null = null;
			try {
				const doc = await readDocument(path);
				const agents =
					isRecord(doc.settings) && isRecord(doc.settings.agents) ? doc.settings.agents : null;
				if (agents && Number.isSafeInteger(agents.maxConcurrent))
					value = Number(agents.maxConcurrent);
			} catch {
				/* No settings means no limit. */
			}
			this.limit = { stamp, value };
		}
		if (this.limit.value === null) return true;
		return (
			(await this.active.count(this.deps.store.root, new Set(this.launching.keys()))) +
				this.launching.size <
			this.limit.value
		);
	}
	private async launchWorker(worker: CrewWorkerRecord) {
		const key = this.workerKey(worker),
			store = this.deps.store,
			task = await store.task(key);
		if (worker.next?.state === 'queued' && task.hasStarted) return this.startNextPart(worker);
		if (task.status !== 'queued' || task.hasStarted) return;
		const launch = task.launch!;
		await store.setStatus(key, 'preparing');
		const trees = new Worktrees(
			store,
			new ProcessCoordinator(join(dirname(this.deps.services.mcpEntry), 'process-owner'))
		);
		try {
			const result = await trees.prepare(
				key,
				{
					branch: launch.branch,
					baseRef: launch.baseRef,
					scopeIds: launch.scopes
						.filter((scope) => scope.kind !== 'external' && scope.kind !== 'folder')
						.map((scope) => scope.id),
					setupCommand: launch.setupCommand,
					copyEnvFiles: launch.copyEnvFiles === true,
				},
				async (state) => {
					await store.updateTask(key, {
						preparation: {
							state: state.state,
							step: state.step,
							...(state.error ? { error: state.error } : {}),
						},
						worktreeBranch: state.branch,
					});
				},
				this.launchAbort.signal
			);
			await store.updateTask(key, {
				preparation: { state: result.state, step: result.step },
				worktreeBranch: result.branch,
			});
			await store.setStatus(key, 'queued');
		} catch (error) {
			if (!this.stopping) {
				await store.setStatus(key, 'failed');
				await store
					.updateTask(key, {
						preparation: {
							state: 'failed',
							step: 'repositories',
							error: error instanceof Error ? error.message : String(error),
						},
					})
					.catch(() => {});
			}
			throw error;
		}
		if (this.stopping) throw new Error('Host is stopping');
		const link = await this.spawn(key);
		await link.peer.request('start_agent', { allowScopeConflict: false });
		const session = await awaitSessionStarted(link, 90_000);
		const node = findSpecAgent(this.deps.context.spec.root, worker.nodeId)!;
		const catalog = session.event.kind === 'session.started' ? session.event.options : [],
			modes = session.event.kind === 'session.started' ? session.event.modes : [];
		const effective: { modeId?: string; configOptions: Record<string, string | boolean> } = {
				configOptions: {},
			},
			unavailable: string[] = [];
		for (const [id, value] of Object.entries(node.requestedChoices.configOptions ?? {})) {
			const option = catalog.find((item) => item.id === id && isAgentOption(item)) as
				AgentOption | undefined;
			const valid =
				option &&
				(option.kind === 'boolean'
					? typeof value === 'boolean'
					: typeof value === 'string' && option.choices.some((choice) => choice.value === value));
			if (!valid) {
				unavailable.push(id);
				continue;
			}
			try {
				await link.peer.request('command', { kind: 'setOption', id, value });
				effective.configOptions[id] = value;
			} catch {
				unavailable.push(id);
			}
		}
		if (node.requestedChoices.modeId) {
			if (modes.some((mode) => mode.id === node.requestedChoices.modeId)) {
				try {
					await link.peer.request('command', {
						kind: 'setMode',
						modeId: node.requestedChoices.modeId,
					});
					effective.modeId = node.requestedChoices.modeId;
				} catch {
					unavailable.push('mode');
				}
			} else unavailable.push('mode');
		}
		await this.serial(async () => {
			worker.effectiveChoices = effective;
			worker.unavailableOptions = unavailable;
			await this.saveWorkers();
		});
		await store.updateTask(key, { launchOptions: [] });
		await link.peer.request('command', { kind: 'prompt', text: task.prompt ?? '' });
	}
	/** Spawns the worker host the same way the desktop does: config file, detached process, identity file, then a `crew` peer. */
	private async spawn(key: TaskKey): Promise<Link> {
		const existing = await this.link(key);
		if (existing) return existing;
		const store = this.deps.store,
			dir = await store.taskDir(key),
			journal = await store.journal(key);
		if (journal.issue) throw new Error(journal.issue);
		await reclaimAbsentOwner(
			store,
			key,
			join(dirname(this.deps.services.mcpEntry), 'process-owner')
		);
		const configPath = await safePath(dir, 'host-config.json');
		await atomicJson(configPath, {
			schemaVersion: 1,
			consoleOnly: false,
			allowScopeConflict: false,
			dataDir: store.root,
			key,
			mcpEntry: this.deps.services.mcpEntry,
			runtime: this.deps.services.runtime,
			...(this.deps.services.adapter ? { adapter: this.deps.services.adapter } : {}),
		});
		const log = await open(await safePath(dir, 'host.log'), 'a', 0o600);
		const child = spawn(
			this.deps.services.runtime,
			[join(dirname(this.deps.services.mcpEntry), 'host.cjs'), configPath],
			{
				detached: true,
				stdio: ['ignore', log.fd, log.fd],
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			}
		);
		await log.close();
		child.unref();
		let failure: Error | null = null;
		child.once('error', (error) => {
			failure = error;
		});
		const end = Date.now() + 90_000;
		while (Date.now() < end) {
			if (failure) throw failure;
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error('Worker host stopped during startup. See host.log.');
			if (this.stopping) throw new Error('Host is stopping');
			const identity = await readIdentity(store, key);
			if (identity && identity.pid === child.pid) {
				const link = await this.link(key);
				if (link) return link;
			}
			await delay(100);
		}
		throw new Error('Worker host startup timed out');
	}
	/**
	 * A worker host can restart without this host (the user reopens the task); its reports wait in its outbox until
	 * a parent links. While an unaccepted worker has no link, its task directory is watched for a new host.json.
	 */
	private hostWatchers = new Map<string, FSWatcher>();
	private awaitHost(key: TaskKey) {
		const worker = this.workers.find((item) => item.taskId === key.id);
		if (
			!worker ||
			worker.acceptedAt ||
			this.stopping ||
			this.hostWatchers.has(name(key)) ||
			this.links.has(name(key))
		)
			return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const retry = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				void this.link(key).then(
					(link) => {
						if (link) this.stopWatching(key);
					},
					() => {}
				);
			}, 200);
			timer.unref?.();
		};
		void this.deps.store
			.taskDir(key)
			.then((dir) => {
				if (this.stopping || this.hostWatchers.has(name(key)) || this.links.has(name(key))) return;
				const watcher = watch(dir, (_event, file) => {
					if (file === null || file === 'host.json') retry();
				});
				watcher.on('error', () => this.stopWatching(key));
				watcher.unref();
				this.hostWatchers.set(name(key), watcher);
				retry();
			})
			.catch(() => {});
	}
	private stopWatching(key: TaskKey) {
		this.hostWatchers.get(name(key))?.close();
		this.hostWatchers.delete(name(key));
	}
	private link(key: TaskKey): Promise<Link | null> {
		const current = this.links.get(name(key));
		if (current) return Promise.resolve(current);
		const pending = this.connecting.get(name(key));
		if (pending) return pending;
		const promise = this.connect(key).finally(() => this.connecting.delete(name(key)));
		this.connecting.set(name(key), promise);
		return promise;
	}
	private async connect(key: TaskKey): Promise<Link | null> {
		const identity = await readIdentity(this.deps.store, key);
		if (!identity?.crewToken) return null;
		const socket = createConnection(identity.socket);
		const peer = new Peer(socket, (method, params, signal) =>
			this.fromChild(key, method, params, signal)
		);
		const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
		const timer = setTimeout(() => peer.close(), 5000);
		timer.unref();
		try {
			const reply = await peer.request('handshake', {
				protocolVersion: 1,
				key: identity.key,
				instance: identity.instance,
				role: 'crew',
				token: identity.crewToken,
			});
			if (!isRecord(reply) || reply.instance !== identity.instance)
				throw new Error('Worker identity mismatch');
		} catch {
			peer.close();
			return null;
		} finally {
			clearTimeout(timer);
		}
		if (this.stopping) {
			peer.close();
			return null;
		}
		const link: Link = { key, peer, identity, closed, events: new Set() };
		this.links.set(name(key), link);
		this.stopWatching(key);
		peer.onNotification = (method, params) => {
			if (method === 'event' && isRecord(params) && isRecord(params.event)) {
				for (const listener of link.events) listener(params as EventRecord);
				void this.childEvent(key, params as EventRecord);
			}
		};
		void closed.then(() => {
			if (this.links.get(name(key)) === link) this.links.delete(name(key));
			if (!this.stopping) {
				this.watchSlots();
				this.awaitHost(key);
			}
		});
		return link;
	}
	private async childEvent(key: TaskKey, record: EventRecord) {
		if (
			record.event.kind === 'turn.completed' ||
			record.event.kind === 'host.stopped' ||
			record.event.kind === 'session.failed'
		)
			this.watchSlots();
		if (record.event.kind === 'session.started' || record.event.kind === 'turn.completed')
			void this.serial(async () => {
				await this.dispatchReviews();
				if (record.event.kind === 'turn.completed') await this.retireReviewers();
			}).catch(() => {});
	}
	/** Requests a child host raises on the crew link: reports, questions and notes (spec/crew#ask-foreman, spec/crew#notes). */
	private async fromChild(
		key: TaskKey,
		method: string,
		params: unknown,
		signal: AbortSignal
	): Promise<unknown> {
		const worker = this.workers.find((item) => item.taskId === key.id);
		if (!worker) throw new Error('Unknown worker');
		const input = isRecord(params) ? params : {};
		if (method === 'report') {
			const seq = Number(input.seq);
			if (!Number.isSafeInteger(seq)) throw new Error('Invalid report');
			if ((this.reportSeqs.get(key.id) ?? 0) >= seq) return { accepted: true, duplicate: true };
			this.reportSeqs.set(key.id, seq);
			await this.saveWorkers();
			await this.handleReport(worker, seq);
			return { accepted: true };
		}
		if (
			method === 'read_report' ||
			method === 'read_diff' ||
			method === 'submit_review' ||
			method === 'approve'
		)
			return this.reviewerTool(worker, method, input);
		if (method === 'ask_foreman') return this.askForeman(worker, input, signal);
		if (method === 'post_note')
			return this.postNote(
				input,
				key,
				worker.nodeId,
				worker.name,
				typeof input.callId === 'string' ? input.callId : randomUUID()
			);
		if (method === 'read_notes') return this.readNotes(input);
		throw new Error(`Unknown crew request ${method}`);
	}
	// ── check edges (spec/crew#reviewer) ─────────────────────────────────
	/** A worker's report goes to its checkers first when the tree has edges; otherwise straight to this agent. */
	private async handleReport(worker: CrewWorkerRecord, seq: number) {
		const node = findSpecAgent(this.deps.context.spec.root, worker.nodeId)!;
		// A reviewer's own turns are verdicts, not reports: nothing of theirs goes up (spec/crew#reviewer). In a PR review the reviewers are the
		// workers and their findings are the report (spec/pull-requests-and-ci#review-crew).
		await this.review().catch(() => null);
		if (node.role === 'reviewer' && !this.isReviewWorker(node)) {
			await this.dispatchReviews();
			return;
		}
		const reviewers = node.checkedBy
			.map((id) => this.node.agents.find((agent) => agent.id === id))
			.filter((agent): agent is CrewSpecAgent => Boolean(agent));
		if (!reviewers.length || node.role !== 'developer') {
			const report = await this.buildWorkerReport(worker);
			await this.deps.emit({ kind: 'crew.report', report: report.summary });
			await this.deps.prompt(
				node.role === 'foreman'
					? `Branch report from lead \`${worker.name}\`: every part of the branch was accepted and merged into its tree.\n${report.text}`
					: report.text,
				{ kind: node.role === 'foreman' ? 'branch-report' : 'report', report: report.summary }
			);
			return;
		}
		const previous = this.reviews
			.filter(
				(run) => run.taskId === worker.taskId && ['reviewing', 'comments'].includes(run.state)
			)
			.at(-1);
		// A new report cancels every earlier approval; a change during a check spends the next round (spec/crew#reviewer).
		const round = previous ? previous.round + 1 : 1;
		for (const run of this.reviews)
			if (run.taskId === worker.taskId && run.state === 'reviewing') {
				run.state = 'superseded';
			}
		if (round > crewReviewRounds) {
			await this.saveReviews();
			await this.finishDisputed(
				worker,
				previous!,
				'The developer changed the work again after the second round.'
			);
			return;
		}
		const key = this.workerKey(worker),
			snapshots = await readSnapshots(this.deps.store, key);
		// spec/crew#parts: the reviewer checks the part, from its change base.
		const from = changeBaseOf(
			snapshots,
			(await this.deps.store.task(key).catch(() => null))?.changeBase
		);
		const scopeSnapshots = (snapshots?.scopes ?? [])
			.filter((scope) => inTask(scope) && scope.available !== false)
			.flatMap((scope) => {
				const base = baseTree(snapshots!, scope.id, from),
					result = snapshots!.checkpoints.at(-1)?.trees.find((tree) => tree.scopeId === scope.id);
				return base && result ? [{ scopeId: scope.id, base: base.tree, result: result.tree }] : [];
			});
		const report = await this.buildWorkerReport(worker, 'pending', round);
		const run: ReviewRun = {
			reviewId: randomUUID(),
			taskId: worker.taskId,
			nodeId: worker.nodeId,
			name: worker.name,
			title: worker.title,
			reportSeq: seq,
			reportHash: sha(report.text),
			scopeSnapshots,
			round,
			reviewerNodeIds: reviewers.map((agent) => agent.id),
			dispatched: [],
			verdicts: [],
			state: 'reviewing',
			createdAt: new Date().toISOString(),
		};
		this.reviews.push(run);
		await this.saveReviews();
		for (const worker of this.workers)
			if (run.reviewerNodeIds.includes(worker.nodeId)) this.retired.delete(worker.taskId);
		await this.deps.emit({ kind: 'crew.report', report: report.summary });
		for (const reviewer of reviewers) await this.ensureReviewer(reviewer).catch(() => {});
		await this.dispatchReviews();
	}
	/** One reviewer serves one check at a time; the rest wait FIFO and survive a restart (spec/crew#reviewer). */
	private async dispatchReviews() {
		for (const reviewerId of new Set(
			this.reviews.filter((run) => run.state === 'reviewing').flatMap((run) => run.reviewerNodeIds)
		)) {
			const reviewer = this.workers.find(
				(worker) => worker.nodeId === reviewerId && !worker.acceptedAt
			);
			if (!reviewer) continue;
			const runs = this.reviews.filter(
				(run) =>
					run.state === 'reviewing' &&
					run.reviewerNodeIds.includes(reviewerId) &&
					!run.verdicts.some((verdict) => verdict.reviewerNodeId === reviewerId)
			);
			if (!runs.length || runs.some((run) => run.dispatched.includes(reviewerId))) continue;
			const run = runs[0]!,
				worker = this.workers.find((item) => item.taskId === run.taskId);
			if (!worker) continue;
			const key = this.workerKey(reviewer),
				task = await this.deps.store.task(key).catch(() => null);
			if (!task || task.status === 'queued' || task.status === 'preparing') continue;
			const link = await this.spawn(key).catch(() => null);
			if (!link) continue;
			const report = await this.buildWorkerReport(worker, 'pending', run.round);
			run.dispatched.push(reviewerId);
			await this.saveReviews();
			await link.peer
				.request('command', {
					kind: 'prompt',
					text: `Check task ${run.taskId} of \`${worker.name}\` (reviewId ${run.reviewId}, round ${run.round} of ${crewReviewRounds}).\n${report.text}\nRead with read_report and read_diff passing this reviewId, then either submit_review(taskId, reviewId, comments) or approve(taskId, reviewId).`,
					crew: { kind: 'report', report: report.summary },
				})
				.catch(async () => {
					run.dispatched = run.dispatched.filter((id) => id !== reviewerId);
					await this.saveReviews();
				});
		}
	}
	private openRun(reviewer: CrewWorkerRecord, input: Record<string, unknown>): ReviewRun {
		const target = this.worker(input.taskId);
		const node = findSpecAgent(this.deps.context.spec.root, target.nodeId);
		if (!node || !node.checkedBy.includes(reviewer.nodeId))
			throw new Error(`${reviewer.name} does not check ${target.name}`);
		const run = this.reviews.find(
			(item) => item.taskId === target.taskId && item.state === 'reviewing'
		);
		// A reviewer serves one check at a time: a missing reviewId means its open check, not a schema error (live G3 finding).
		if (
			(typeof input.reviewId !== 'string' || !input.reviewId) &&
			run &&
			run.dispatched.includes(reviewer.nodeId)
		)
			return run;
		if (typeof input.reviewId !== 'string' || !input.reviewId)
			throw new Error('reviewId is required for a reviewer');
		if (!run || run.reviewId !== input.reviewId) {
			const known = this.reviews.find((item) => item.reviewId === input.reviewId);
			throw new Error(
				known
					? `stale_review: this check was superseded (${known.state}); wait for the next report`
					: 'stale_review: unknown reviewId'
			);
		}
		return run;
	}
	private async reviewerTool(
		reviewer: CrewWorkerRecord,
		method: string,
		input: Record<string, unknown>
	) {
		const node = findSpecAgent(this.deps.context.spec.root, reviewer.nodeId);
		if (node?.role !== 'reviewer')
			throw new Error('Only a reviewer uses this tool through the crew');
		if (method === 'read_report') {
			const run = this.openRun(reviewer, input);
			const worker = this.worker(run.taskId);
			return {
				reviewId: run.reviewId,
				round: run.round,
				report: (await this.buildWorkerReport(worker, 'pending', run.round)).text,
			};
		}
		if (method === 'read_diff') {
			const run = this.openRun(reviewer, input);
			return this.readDiff(input, run);
		}
		const run = this.openRun(reviewer, input);
		if (run.verdicts.some((verdict) => verdict.reviewerNodeId === reviewer.nodeId))
			throw new Error('You already gave a verdict for this reviewId');
		const target = this.worker(run.taskId);
		if (method === 'approve') {
			run.verdicts.push({
				reviewerNodeId: reviewer.nodeId,
				reviewer: reviewer.name,
				approved: true,
				comments: 0,
				at: new Date().toISOString(),
			});
			await this.saveReviews();
			if (run.reviewerNodeIds.length > 1)
				await this.deps.emit({
					kind: 'crew.review',
					reviewId: run.reviewId,
					taskId: run.taskId,
					name: target.name,
					reviewer: reviewer.name,
					round: run.round,
					approved: true,
					comments: 0,
					state: 'reviewing',
				});
			await this.settleRun(run);
			return { approved: true, reviewId: run.reviewId };
		}
		const items = Array.isArray(input.comments) ? input.comments : [];
		if (!items.length) throw new Error('comments is required, or call approve');
		const comments = await this.anchorComments(
			target,
			items,
			`${reviewer.name} · checks ${target.name}`,
			run
		);
		await this.storeComments(target, comments);
		run.verdicts.push({
			reviewerNodeId: reviewer.nodeId,
			reviewer: reviewer.name,
			approved: false,
			comments: comments.length,
			at: new Date().toISOString(),
		});
		this.pendingBatches.set(`${run.reviewId}/${reviewer.nodeId}`, comments);
		await this.saveReviews();
		// One row per verdict only when several reviewers share a round; a single reviewer's verdict is the round's summary row.
		if (run.reviewerNodeIds.length > 1)
			await this.deps.emit({
				kind: 'crew.review',
				reviewId: run.reviewId,
				taskId: run.taskId,
				name: target.name,
				reviewer: reviewer.name,
				round: run.round,
				approved: false,
				comments: comments.length,
				state: 'reviewing',
			});
		await this.settleRun(run);
		return { sent: comments.length, reviewId: run.reviewId };
	}
	private pendingBatches = new Map<string, ReviewComment[]>();
	/** All verdicts in: comments go to the developer as one batch (round 1), or the dispute goes up (round 2); approvals go up as the report (spec/crew#reviewer). */
	private async settleRun(run: ReviewRun) {
		if (run.state !== 'reviewing' || run.verdicts.length < run.reviewerNodeIds.length) return;
		const worker = this.worker(run.taskId);
		const comments = run.reviewerNodeIds.flatMap(
			(id) => this.pendingBatches.get(`${run.reviewId}/${id}`) ?? []
		);
		for (const id of run.reviewerNodeIds) this.pendingBatches.delete(`${run.reviewId}/${id}`);
		if (run.verdicts.every((verdict) => verdict.approved)) {
			// Re-check the trees: nothing may slip in after the last approval.
			const snapshots = await readSnapshots(this.deps.store, this.workerKey(worker));
			const current = snapshots?.checkpoints.at(-1);
			const changed = run.scopeSnapshots.some(
				(item) => current?.trees.find((tree) => tree.scopeId === item.scopeId)?.tree !== item.result
			);
			if (changed) {
				run.state = 'superseded';
				await this.saveReviews();
				return;
			}
			run.state = 'approved';
			await this.saveReviews();
			const report = await this.buildWorkerReport(
				worker,
				'approved',
				run.round,
				run.verdicts.map((verdict) => ({
					reviewer: verdict.reviewer,
					comments: verdict.comments,
					approved: true,
				}))
			);
			await this.deps.emit({
				kind: 'crew.review',
				reviewId: run.reviewId,
				taskId: run.taskId,
				name: worker.name,
				reviewer: run.verdicts.map((item) => item.reviewer).join(', '),
				round: run.round,
				approved: true,
				comments: 0,
				state: 'approved',
			});
			await this.deps.prompt(report.text, { kind: 'report', report: report.summary });
			await this.dispatchReviews();
			return;
		}
		if (run.round >= crewReviewRounds) {
			run.state = 'disputed';
			await this.saveReviews();
			await this.finishDisputed(worker, run, 'The reviewer did not agree after two rounds.');
			await this.dispatchReviews();
			return;
		}
		run.state = 'comments';
		await this.saveReviews();
		if (comments.length) {
			const stored = comments;
			await this.deliverReview(worker, stored);
		}
		await this.deps.emit({
			kind: 'crew.review',
			reviewId: run.reviewId,
			taskId: run.taskId,
			name: worker.name,
			reviewer: run.verdicts
				.filter((item) => !item.approved)
				.map((item) => item.reviewer)
				.join(', '),
			round: run.round,
			approved: false,
			comments: comments.length,
			state: 'comments',
		});
		await this.dispatchReviews();
	}
	private async finishDisputed(worker: CrewWorkerRecord, run: ReviewRun, why: string) {
		const report = await this.buildWorkerReport(
			worker,
			'disputed',
			run.round,
			run.verdicts.map((verdict) => ({
				reviewer: verdict.reviewer,
				comments: verdict.comments,
				approved: verdict.approved,
			}))
		);
		await this.deps.emit({
			kind: 'crew.review',
			reviewId: run.reviewId,
			taskId: run.taskId,
			name: worker.name,
			reviewer: run.verdicts.map((item) => item.reviewer).join(', '),
			round: run.round,
			approved: false,
			comments: run.verdicts.reduce((sum, item) => sum + item.comments, 0),
			state: 'disputed',
		});
		await this.deps.prompt(
			`${report.text}\n\n${why} Both sides are in the review thread of task ${worker.taskId}; you decide: return the work with prompt_task or accept it.`,
			{ kind: 'report', report: report.summary }
		);
	}
	// ── questions (spec/crew#ask-foreman) ────────────────────────────────────────
	private async askForeman(
		worker: CrewWorkerRecord,
		input: Record<string, unknown>,
		signal: AbortSignal
	): Promise<{ answer: string }> {
		const callId = typeof input.callId === 'string' && input.callId ? input.callId : randomUUID();
		const existing = this.questions.find(
			(item) => item.workerTaskId === worker.taskId && item.callId === callId
		);
		if (existing?.state === 'answered') return { answer: existing.answer ?? '' };
		const question = existing ?? (await this.registerQuestion(worker, callId, input));
		return new Promise<{ answer: string }>((resolve, reject) => {
			this.questionWaiters.set(question.id, { resolve: (answer) => resolve({ answer }), reject });
			const abort = () => {
				this.questionWaiters.delete(question.id);
				void this.resolveQuestion(question.id, null, null, 'cancelled').catch(() => {});
				reject(new Error('The question was cancelled'));
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
	}
	private async registerQuestion(
		worker: CrewWorkerRecord,
		callId: string,
		input: Record<string, unknown>
	): Promise<CrewQuestion> {
		const text = typeof input.question === 'string' ? input.question.trim() : '';
		if (!text) throw new Error('question is required');
		if (text.length > 100_000) throw new Error('question is too long');
		const options = Array.isArray(input.options)
			? input.options
					.filter((option): option is string => typeof option === 'string' && option.length <= 1000)
					.slice(0, 100)
			: [];
		const now = Date.now(),
			question: CrewQuestion = {
				id: randomUUID(),
				workerTaskId: worker.taskId,
				parentTaskId: this.deps.key.id,
				callId,
				agent: worker.name,
				question: text,
				options,
				createdAt: new Date(now).toISOString(),
				escalateAt: new Date(now + crewQuestionEscalationMs).toISOString(),
				state: 'pending',
			};
		this.questions.push(question);
		await this.saveQuestions();
		await this.deps.emit({ kind: 'crew.question.requested', question });
		this.scheduleEscalation(question);
		await this.deps.prompt(
			`Worker \`${worker.name} · ${worker.title}\` asks (questionId ${question.id}):\n${text}${options.length ? `\nOptions: ${options.join(' | ')}` : ''}\nAnswer with prompt_task(taskId "${worker.taskId}", text, questionId "${question.id}"). The worker is blocked until you answer.`,
			{ kind: 'question', questionId: question.id, agent: worker.name }
		);
		return question;
	}
	private scheduleEscalation(question: CrewQuestion) {
		const wait = Math.max(0, Date.parse(question.escalateAt) - Date.now());
		const timer = setTimeout(
			() => {
				void this.serial(async () => {
					const current = this.questions.find((item) => item.id === question.id);
					if (!current || current.state !== 'pending') return;
					current.state = 'escalated';
					await this.saveQuestions();
					await this.deps.emit({ kind: 'crew.question.escalated', id: question.id });
					await this.deps.store
						.setStatus(
							{ projectId: this.deps.key.projectId, id: question.workerTaskId },
							'needs-you'
						)
						.catch(() => {});
				});
			},
			Math.min(wait, 2_147_483_647)
		);
		timer.unref?.();
		this.escalations.set(question.id, timer);
	}
	/** First valid answer wins: the foreman via prompt_task or the human after escalation (spec/crew#ask-foreman). */
	async answerQuestion(id: string, answer: string, by: 'foreman' | 'human') {
		const question = this.questions.find((item) => item.id === id);
		if (!question) throw new Error('Unknown question');
		if (question.state === 'answered') {
			if (question.answer === answer) return;
			throw new Error('The question is already answered');
		}
		if (question.state === 'cancelled') throw new Error('The question was cancelled');
		if (by === 'human' && question.state !== 'escalated')
			throw new Error('The foreman has five minutes to answer first');
		await this.resolveQuestion(id, answer, by, 'answered');
	}
	private async resolveQuestion(
		id: string,
		answer: string | null,
		by: 'foreman' | 'human' | null,
		state: 'answered' | 'cancelled'
	) {
		const question = this.questions.find((item) => item.id === id);
		if (!question || question.state === 'answered' || question.state === 'cancelled') return;
		question.state = state;
		if (answer !== null) question.answer = answer;
		if (by) question.answeredBy = by;
		await this.saveQuestions();
		const timer = this.escalations.get(id);
		if (timer) clearTimeout(timer);
		this.escalations.delete(id);
		await this.deps.emit({ kind: 'crew.question.resolved', id, answer, answeredBy: by });
		const waiter = this.questionWaiters.get(id);
		this.questionWaiters.delete(id);
		if (waiter) {
			if (answer !== null) waiter.resolve(answer);
			else waiter.reject(new Error('The question was cancelled'));
			return;
		}
		// The blocked call is gone (worker restarted): the stored answer travels as the next prompt with the same id.
		if (answer !== null) {
			const key = { projectId: this.deps.key.projectId, id: question.workerTaskId };
			const link = await this.link(key);
			if (link)
				await link.peer
					.request('command', {
						kind: 'prompt',
						text: `Answer to your question ${id} ("${question.question.slice(0, 200)}"): ${answer}`,
					})
					.catch(() => {});
		}
	}
	// ── notes (spec/crew#notes) ─────────────────────────────────────────────────────
	private async postNote(
		input: Record<string, unknown>,
		authorKey: TaskKey,
		nodeId: string,
		author: string,
		callId: string
	): Promise<CrewNote> {
		const text = typeof input.text === 'string' ? input.text : '';
		if (!text.trim()) throw new Error('text is required');
		if (Buffer.byteLength(text, 'utf8') > crewNoteLimit) throw new Error('A note is at most 8 KiB');
		const files = Array.isArray(input.files)
			? input.files
					.filter(
						(file): file is string =>
							typeof file === 'string' &&
							file.length <= 1024 &&
							!file.startsWith('/') &&
							!file.split('/').includes('..')
					)
					.slice(0, 64)
			: [];
		if (!this.deps.context.isRoot) {
			const parent = this.deps.parent();
			if (!parent) throw new Error('The crew host is not connected');
			const note = await parent.request('post_note', {
				text,
				files,
				callId,
				authorTaskId: authorKey.id,
				crewNodeId: nodeId,
				author,
			});
			if (!isCrewNote(note)) throw new Error('Invalid note');
			return note;
		}
		return this.serial(async () => {
			const notes = await this.allNotes();
			const authorTaskId =
					typeof input.authorTaskId === 'string' ? input.authorTaskId : authorKey.id,
				crewNodeId = typeof input.crewNodeId === 'string' ? input.crewNodeId : nodeId,
				authorName = typeof input.author === 'string' ? input.author : author;
			if (!findSpecAgent(this.deps.context.spec.root, crewNodeId))
				throw new Error('Unknown crew node');
			const existing = notes.find(
				(note) =>
					note.authorTaskId === authorTaskId &&
					note.id === sha(`${authorTaskId}/${callId}`).slice(0, 32)
			);
			if (existing) return existing;
			const note: CrewNote = {
				id: sha(`${authorTaskId}/${callId}`).slice(0, 32),
				seq: (notes.at(-1)?.seq ?? 0) + 1,
				authorTaskId,
				crewNodeId,
				author: authorName,
				createdAt: new Date().toISOString(),
				text,
				...(files.length ? { files } : {}),
			};
			const path = await this.file('crew-notes.jsonl');
			const handle = await open(path, 'a', 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(note)}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.deps.emit({ kind: 'crew.note', note });
			return note;
		});
	}
	/** Notes up to the first unreadable line; a half-written last line is not a note yet. */
	private async allNotes(): Promise<readonly CrewNote[]> {
		return (await this.notes.read(await this.file('crew-notes.jsonl'))).items;
	}
	private async readNotes(
		input: Record<string, unknown>
	): Promise<{ notes: CrewNote[]; nextCursor: number; hasMore: boolean }> {
		if (!this.deps.context.isRoot) {
			const parent = this.deps.parent();
			if (!parent) throw new Error('The crew host is not connected');
			return parent.request('read_notes', input) as Promise<{
				notes: CrewNote[];
				nextCursor: number;
				hasMore: boolean;
			}>;
		}
		// Note seq is its line number (JsonlCache checks it), so the page starts by index. 64 KiB per page, at least one note.
		const since = Number.isSafeInteger(input.since) ? Number(input.since) : 0,
			notes = (await this.allNotes()).slice(Math.max(0, since)),
			page: CrewNote[] = [];
		let bytes = 0;
		for (const note of notes) {
			const size = Buffer.byteLength(JSON.stringify(note)) + 1;
			if (page.length >= crewNotePageLimit || (page.length && bytes + size > notePageBytes)) break;
			bytes += size;
			page.push(note);
		}
		return {
			notes: page,
			nextCursor: page.at(-1)?.seq ?? since,
			hasMore: notes.length > page.length,
		};
	}
	// ── reading workers ───────────────────────────────────────────────────
	private async promptTask(input: Record<string, unknown>) {
		const worker = this.worker(input.taskId),
			text = typeof input.text === 'string' ? input.text : '';
		if (!text.trim()) throw new Error('text is required');
		const wanted = typeof input.effort === 'string' ? input.effort.trim() : '';
		if (typeof input.questionId === 'string' && input.questionId) {
			if (wanted)
				throw new Error(
					'effort goes with returned work, not with an answer: the answer returns into the running turn.'
				);
			const question = this.questions.find((item) => item.id === input.questionId);
			if (!question || question.workerTaskId !== worker.taskId)
				throw new Error('Unknown questionId for this worker');
			await this.answerQuestion(question.id, text, 'foreman');
			return { answered: question.id };
		}
		if (worker.next)
			throw new Error(
				`The next part «${worker.title}» of ${worker.name} has not started yet (${worker.next.state === 'merging' ? 'a merge conflict waits for the human' : 'it waits for a free agent slot'}); its prompt goes with it.`
			);
		if (worker.acceptedAt)
			throw new Error(
				`The part «${worker.title}» of ${worker.name} was accepted. Give its next part with create_worker_task; it continues in the same task and session.`
			);
		const link = await this.spawn(this.workerKey(worker));
		const effort = wanted ? await this.raiseEffort(worker, link, wanted) : null;
		await link.peer.request('command', { kind: 'prompt', text });
		return { sent: true, taskId: worker.taskId, ...(effort ? { effort } : {}) };
	}
	/** spec/crew#return-effort: a level of the worker's current model, by the catalog's name or value; set before the prompt, kept for the rest of its task. */
	private async raiseEffort(worker: CrewWorkerRecord, link: Link, wanted: string) {
		const level = effortLevel(
			sessionOptions((await this.journal(this.workerKey(worker))).records),
			wanted
		);
		if (!level) throw new Error(`The model of ${worker.name} has no effort levels.`);
		const { option, choice } = level;
		if (!choice)
			throw new Error(
				`Unknown effort «${wanted}» for ${worker.name}. Its levels: ${level.levels.join(', ')}.`
			);
		if (choice.value !== option.value) {
			await link.peer.request('command', { kind: 'setOption', id: option.id, value: choice.value });
			await this.serial(async () => {
				worker.effectiveChoices = {
					...worker.effectiveChoices,
					configOptions: { ...worker.effectiveChoices?.configOptions, [option.id]: choice.value },
				};
				await this.saveWorkers();
			});
		}
		return choice.name;
	}
	private async taskStatus(input: Record<string, unknown>) {
		const worker = this.worker(input.taskId),
			key = this.workerKey(worker),
			task = await this.deps.store.task(key),
			journal = await this.journal(key);
		const snapshots = await readSnapshots(this.deps.store, key).catch(() => null),
			changes = snapshots ? await readChanges(this.deps.store, key) : null;
		const question = this.questions.find(
			(item) =>
				item.workerTaskId === worker.taskId &&
				(item.state === 'pending' || item.state === 'escalated')
		);
		return {
			taskId: worker.taskId,
			agent: worker.name,
			title: worker.title,
			status: task.status,
			busy: busyIn(journal.records),
			turns: journal.records.filter((record) => record.event.kind === 'turn.completed').length,
			changedFiles: changes?.files.length ?? 0,
			accepted: Boolean(worker.acceptedAt),
			part: worker.part ?? 1,
			...(worker.next ? { nextPart: worker.next.state } : {}),
			...(question ? { pendingQuestion: { id: question.id, question: question.question } } : {}),
		};
	}
	private async workerChanges(worker: CrewWorkerRecord) {
		const key = this.workerKey(worker);
		const changes = await readChanges(this.deps.store, key);
		const project = await this.deps.store.projectForTask(key);
		return { key, changes, project };
	}
	private async buildWorkerReport(
		worker: CrewWorkerRecord,
		verdict: CrewReportSummary['verdict'] = null,
		round: number | null = null,
		reviews: { reviewer: string; comments: number; approved: boolean }[] = []
	) {
		const key = this.workerKey(worker),
			task = await this.deps.store.task(key),
			journal = await this.journal(key);
		let files: ChangedFile[] = [],
			scopes: Scope[] = [],
			projectPath = '';
		try {
			const { changes, project } = await this.workerChanges(worker);
			files = changes.files;
			scopes = changes.scopes;
			projectPath = project.path;
		} catch {
			/* An unprepared worker has no snapshots yet. */
		}
		const node = findSpecAgent(this.deps.context.spec.root, worker.nodeId)!;
		const question = this.questions.find(
			(item) =>
				item.workerTaskId === worker.taskId &&
				(item.state === 'pending' || item.state === 'escalated')
		);
		const seenNotes = Number(this.reportSeqs.get(`notes:${worker.taskId}`) ?? 0),
			notes = this.deps.context.isRoot ? await this.allNotes() : [];
		const newNotes = notes.filter(
			(note) => note.seq > seenNotes && note.authorTaskId !== worker.taskId
		).length;
		this.reportSeqs.set(`notes:${worker.taskId}`, notes.at(-1)?.seq ?? seenNotes);
		const usage = taskUsage(journal.records);
		return buildReport({
			taskId: worker.taskId,
			nodeId: worker.nodeId,
			name: worker.name,
			title: worker.title,
			status: task.status,
			zone: node.zone,
			projectPath,
			scopes,
			files,
			lastMessage: lastMessage(journal.records),
			question: question?.question ?? null,
			newNotes,
			verdict,
			round,
			reviews,
			part: worker.part ?? 1,
			...(usage ? { usage } : {}),
		});
	}
	private async readReport(input: Record<string, unknown>) {
		const worker = this.worker(input.taskId);
		return { report: (await this.buildWorkerReport(worker)).text };
	}
	private async readTranscript(input: Record<string, unknown>) {
		const worker = this.worker(input.taskId),
			limit = Math.min(
				200,
				Math.max(1, Number.isSafeInteger(input.limit) ? Number(input.limit) : 40)
			),
			journal = await this.journal(this.workerKey(worker));
		// A line is at most 2000 characters and the page at most 64 KiB, newest lines kept; `total` counts every line.
		const lines: string[] = [];
		let assistant = '';
		const clip = (text: string) =>
			text.length > transcriptLine ? `${text.slice(0, transcriptLine)}…` : text;
		const flush = () => {
			const text = assistant.trim();
			if (text) lines.push(`assistant: ${clip(text)}`);
			assistant = '';
		};
		for (const record of journal.records) {
			const event = record.event;
			if (event.kind === 'turn.started') {
				flush();
				if (event.origin !== 'agent') lines.push(`prompt: ${clip(event.text)}`);
			}
			if (
				event.kind === 'message.delta' &&
				event.role === 'assistant' &&
				event.content.kind === 'text' &&
				assistant.length <= 2 * transcriptLine
			)
				assistant += event.content.text;
			if (
				event.kind === 'tool.changed' &&
				event.patch.title &&
				event.patch.status === 'completed'
			) {
				flush();
				lines.push(`tool: ${clip(event.patch.title)}`);
			}
			if (event.kind === 'turn.completed') flush();
		}
		flush();
		const page = lines.slice(-limit);
		let start = page.length,
			bytes = 0;
		while (start > 0) {
			const size = Buffer.byteLength(JSON.stringify(page[start - 1])) + 1;
			if (bytes + size > transcriptBytes) break;
			bytes += size;
			start--;
		}
		return { lines: page.slice(start), total: lines.length, ...(start ? { omitted: start } : {}) };
	}
	private async workerChangesAt(worker: CrewWorkerRecord, run: ReviewRun | null) {
		const { key, changes, project } = await this.workerChanges(worker);
		if (!run) return { key, changes, project };
		const files: ChangedFile[] = [];
		for (const item of run.scopeSnapshots) {
			const scope = changes.scopes.find((scope) => scope.id === item.scopeId);
			if (scope && item.base !== item.result)
				files.push(...(await changedFiles(scope, item.base, item.result)));
		}
		return { key, changes: { ...changes, files }, project };
	}
	private async readDiff(input: Record<string, unknown>, run: ReviewRun | null = null) {
		const worker = this.worker(input.taskId),
			{ changes, project } = await this.workerChangesAt(worker, run);
		const rel = (file: ChangedFile) => {
			const scope = changes.scopes.find((item) => item.id === file.scopeId);
			const prefix =
				scope && scope.path !== project.path ? scope.path.slice(project.path.length + 1) + '/' : '';
			return `${prefix}${file.path}`;
		};
		// The model reads a bounded list and unified hunks; full text only on request, capped too.
		if (typeof input.path !== 'string' || !input.path) {
			return {
				files: changes.files.slice(0, 200).map((file) => ({
					path: rel(file),
					status: file.status,
					additions: file.additions,
					deletions: file.deletions,
					binary: file.binary,
				})),
				...(changes.files.length > 200 ? { more: changes.files.length - 200 } : {}),
			};
		}
		const wanted = input.path.replace(/^\.\//, ''),
			file = changes.files.find((item) => rel(item) === wanted || item.path === wanted);
		if (!file)
			throw new Error(
				`No changed file ${wanted}. Files: ${changes.files.slice(0, 50).map(rel).join(', ')}`
			);
		const scope = changes.scopes.find((item) => item.id === file.scopeId)!;
		if (file.binary) return { path: wanted, binary: true };
		const [before, after] = await readBlobs(scope, [file.before, file.after]);
		if (before!.tooLarge || after!.tooLarge) return { path: wanted, tooLarge: true };
		const cap = (text: string) =>
			text.length > 64 * 1024
				? { text: text.slice(0, 64 * 1024), truncated: true }
				: { text, truncated: false };
		if (input.full === true) {
			const old = cap(before!.text),
				next = cap(after!.text);
			return {
				path: wanted,
				status: file.status,
				before: old.text,
				after: next.text,
				...(old.truncated || next.truncated ? { truncated: true } : {}),
			};
		}
		const diff = unifiedDiff(diffLines(before!.text, after!.text).lines);
		return {
			path: wanted,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			diff: diff.text,
			...(diff.truncated ? { truncated: true } : {}),
		};
	}
	// ── review and acceptance (spec/crew#task-type, spec/crew#reviewer) ──────────
	private async submitReview(input: Record<string, unknown>, author = this.node.name) {
		const worker = this.worker(input.taskId);
		const items = Array.isArray(input.comments) ? input.comments : [];
		if (!items.length) throw new Error('comments is required: [{path, start, end, text}]');
		if (items.length > 200) throw new Error('At most 200 comments');
		const comments = await this.anchorComments(worker, items, author, null);
		await this.storeComments(worker, comments);
		const batch = await this.deliverReview(worker, comments);
		return { sent: comments.length, reviewBatch: batch };
	}
	/** Comments anchor to the new side of the worker's diff (the run's snapshot for a reviewer); the author is the agent (spec/crew#reviewer). */
	private async anchorComments(
		worker: CrewWorkerRecord,
		items: unknown[],
		author: string,
		run: ReviewRun | null
	): Promise<ReviewComment[]> {
		if (items.length > 200) throw new Error('At most 200 comments');
		const { changes, project } = await this.workerChangesAt(worker, run);
		const rel = (file: ChangedFile) => {
			const scope = changes.scopes.find((item) => item.id === file.scopeId);
			const prefix =
				scope && scope.path !== project.path ? scope.path.slice(project.path.length + 1) + '/' : '';
			return `${prefix}${file.path}`;
		};
		// Check every comment first, then read the new-side blobs up to the first failing one in one batch per repo
		// rather than two git processes per comment; errors still surface in comment order.
		const checked = items.map((item, index) => {
			if (
				!isRecord(item) ||
				typeof item.text !== 'string' ||
				!item.text.trim() ||
				item.text.length > 10000
			)
				return new Error(`Comment ${index + 1} needs text`);
			const path = typeof item.path === 'string' ? item.path.replace(/^\.\//, '') : '';
			const file = changes.files.find((entry) => rel(entry) === path || entry.path === path);
			if (!file) return new Error(`Comment ${index + 1}: no changed file ${path}`);
			if (file.binary || !file.after)
				return new Error(`Comment ${index + 1}: ${path} has no text diff on the new side`);
			return { item, text: item.text, path, file, after: file.after };
		});
		const failed = checked.findIndex((entry) => entry instanceof Error),
			blobs = new Map<string, { text: string; lines: number; tooLarge: boolean } | Error>(),
			wanted = new Map<string, Set<string>>();
		for (const entry of failed < 0 ? checked : checked.slice(0, failed))
			if (!(entry instanceof Error))
				(
					wanted.get(entry.file.scopeId) ??
					wanted.set(entry.file.scopeId, new Set()).get(entry.file.scopeId)!
				).add(entry.after);
		const keep = (blob: string, value: { text: string; tooLarge: boolean }) =>
			blobs.set(blob, {
				text: value.text,
				lines: value.text.split('\n').length,
				tooLarge: value.tooLarge,
			});
		for (const [scopeId, set] of wanted) {
			const scope = changes.scopes.find((entry) => entry.id === scopeId)!,
				ids = [...set];
			// One batch holds at most 5 MiB of blobs; past that, or on any failure, each blob is read alone as before.
			try {
				(await readBlobs(scope, ids)).forEach((value, index) => keep(ids[index]!, value));
			} catch {
				for (const blob of ids) {
					try {
						keep(blob, (await readBlobs(scope, [blob]))[0]!);
					} catch (error) {
						blobs.set(blob, error instanceof Error ? error : new Error(String(error)));
					}
				}
			}
		}
		const comments: ReviewComment[] = [];
		for (const [index, entry] of checked.entries()) {
			if (entry instanceof Error) throw entry;
			const { item, text, path, file, after } = entry,
				blob = blobs.get(after)!;
			if (blob instanceof Error) throw blob;
			if (blob.tooLarge) throw new Error(`Comment ${index + 1}: ${path} is too large`);
			const lineCount = blob.lines;
			const start = Number.isSafeInteger(item.start)
					? Math.max(1, Math.min(lineCount, Number(item.start)))
					: 1,
				end = Number.isSafeInteger(item.end)
					? Math.max(start, Math.min(lineCount, Number(item.end), start + 99))
					: start;
			const context = anchorContext(blob.text, start, end);
			comments.push({
				id: randomUUID(),
				version: 1,
				author,
				text,
				at: new Date().toISOString(),
				anchor: {
					scopeId: file.scopeId,
					path: file.path,
					side: 'new',
					blob: after,
					start,
					end,
					...context,
					contextHash: sha(JSON.stringify({ ...context, quote: context.quote.map(normalizeLine) })),
					symbolPath: null,
				},
			});
		}
		return comments;
	}
	private async storeComments(worker: CrewWorkerRecord, comments: ReviewComment[]) {
		const path = await safePath(
			await this.deps.store.taskDir(this.workerKey(worker)),
			'review.json'
		);
		let doc: Record<string, unknown>;
		try {
			doc = await readDocument(path, 16 * 1024 * 1024);
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
			doc = { schemaVersion: 1, comments: [], notes: [] };
		}
		const existing = Array.isArray(doc.comments) ? (doc.comments as ReviewComment[]) : [];
		if (existing.length + comments.length > 500)
			throw new Error('The review holds at most 500 comments');
		await atomicJson(path, {
			...doc,
			comments: [...existing, ...comments],
			notes: Array.isArray(doc.notes) ? doc.notes : [],
		});
	}
	/** The same batch a human sends (spec/diff-and-review#review-comments, spec/crew#task-type): the worker sees `<review_comment>`s, the UI shows the author. */
	private async deliverReview(
		worker: CrewWorkerRecord,
		comments: ReviewComment[]
	): Promise<string> {
		const batch = {
			id: sha(JSON.stringify(comments.map((comment) => ({ id: comment.id, version: 1 })))),
			comments: comments.map((comment) => ({ id: comment.id, version: 1 })),
		};
		const text =
			'Address the following review comments for this task. The quoted code belongs to the specified snapshot; verify its current location before editing.\n\n' +
			comments
				.map(
					(comment, index) =>
						`${index + 1}. File ${JSON.stringify(comment.anchor.path)}, scope ${comment.anchor.scopeId}, new side, blob ${comment.anchor.blob}, lines ${comment.anchor.start}-${comment.anchor.end}.\nComment: ${comment.text}\nQuoted code: ${JSON.stringify(comment.anchor.quote.join('\n'))}`
				)
				.join('\n\n');
		const link = await this.spawn(this.workerKey(worker));
		await link.peer.request('command', { kind: 'submitReview', text, review: batch });
		return batch.id;
	}
	/** spec/crew#accept: the message is written before the merge; a second acceptance of the same part waits for nothing and fails. */
	private accepting = new Set<string>();
	private async acceptTask(input: Record<string, unknown>) {
		const worker = this.worker(input.taskId);
		if (worker.acceptedAt) throw new Error('The task is already accepted');
		if (this.accepting.has(worker.taskId)) throw new Error('The task is already being accepted');
		this.accepting.add(worker.taskId);
		try {
			return await this.acceptNow(worker);
		} finally {
			this.accepting.delete(worker.taskId);
		}
	}
	private async acceptNow(worker: CrewWorkerRecord) {
		const key = this.workerKey(worker),
			store = this.deps.store,
			journal = await this.journal(key);
		if (busyIn(journal.records))
			throw new Error('The worker is still working; wait for its report');
		if (worker.next)
			throw new Error(`The part «${worker.title}» has not started yet; wait for its report`);
		if (!journal.records.some((record) => record.event.kind === 'turn.completed'))
			throw new Error('The worker has not reported yet');
		// spec/crew#parts: an open check of this part ends with it, so the member's next part starts again from round 1.
		for (const run of this.reviews)
			if (run.taskId === worker.taskId && (run.state === 'reviewing' || run.state === 'comments')) {
				run.state = 'cancelled';
			}
		await this.saveReviews();
		if (await this.review()) return this.acceptReview(worker);
		const { snapshots, scopes, branch, targets } = await this.partTargets(worker);
		const preview = await previewCommits(scopes, snapshots ?? undefined);
		// spec/crew#accept: `--squash` takes the worker's branch, so its tree is committed there first; that commit stays in the worker's branch.
		let committed: { name: string; sha: string }[] = [];
		if (preview.scopes.length) {
			const result = await commitPreview(
				preview,
				scopes,
				`${worker.name}: ${worker.title}`,
				snapshots ?? undefined
			);
			if (result.error) throw new Error(`Commit failed: ${result.error}`);
			committed = result.committed.map((item) => ({ name: item.name, sha: item.sha }));
		}
		const message = await this.partMessage(worker, branch, targets);
		if (this.stopping) throw new Error('Host is stopping');
		const own = (await readSnapshots(store, this.deps.key).catch(() => null))?.scopes ?? [];
		const conflicts: string[] = [],
			merged: string[] = [];
		for (const { scope, relativePath, target } of targets) {
			const result = await squashBranch(target, branch, message);
			if (result.conflicts.length) {
				conflicts.push(
					...result.conflicts.map((path) => (relativePath ? `${relativePath}/${path}` : path))
				);
				// The merge strip names the worker's branch instead of a bare `SQUASH_MSG` (spec/crew#accept).
				const mine = own.find((item) => item.path === target);
				if (mine)
					await rememberMerge(store, this.deps.key, mine.id, {
						from: branch,
						into:
							(await gitText(target, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')) ||
							'HEAD',
						conflicts: result.conflicts,
						agent: [],
					}).catch(() => {});
			} else if (result.merged) merged.push(scope.name);
		}
		// spec/crew#parts: the next part's merge of the crew tree takes these tips as its base.
		const tips: Record<string, string> = { ...worker.acceptedTips };
		for (const { relativePath, target } of targets) {
			const tip = await gitText(target, [
				'rev-parse',
				'--verify',
				'--quiet',
				`refs/heads/${branch}^{commit}`,
			]).catch(() => '');
			if (/^[0-9a-f]{40,64}$/.test(tip)) tips[relativePath] = tip;
		}
		worker.acceptedTips = tips;
		worker.acceptedAt = new Date().toISOString();
		await this.saveWorkers();
		await this.deps.emit({
			kind: 'crew.accepted',
			taskId: worker.taskId,
			nodeId: worker.nodeId,
			name: worker.name,
			conflicts,
		});
		const link = await this.link(key);
		if (link) {
			await link.peer.request('command', { kind: 'shutdown' }).catch(() => {});
		}
		await store.setStatus(key, 'completed').catch(() => {});
		await this.retireReviewers().catch(() => {});
		if (conflicts.length)
			return {
				accepted: true,
				merged,
				conflicts,
				note: 'Merge conflicts are left in your tree for the human to resolve. Do not resolve them yourself.',
			};
		return { accepted: true, merged, committed };
	}
	/**
	 * spec/pull-requests-and-ci#review-crew: a reviewer of a PR review changed no code and its tree is the PR head, so accepting it commits and merges
	 * nothing — squashing that branch into a quick review's tree would bring the whole PR onto the person's branch.
	 */
	private async acceptReview(worker: CrewWorkerRecord) {
		const key = this.workerKey(worker);
		worker.acceptedAt = new Date().toISOString();
		await this.saveWorkers();
		await this.deps.emit({
			kind: 'crew.accepted',
			taskId: worker.taskId,
			nodeId: worker.nodeId,
			name: worker.name,
			conflicts: [],
		});
		const link = await this.link(key);
		if (link) await link.peer.request('command', { kind: 'shutdown' }).catch(() => {});
		await this.deps.store.setStatus(key, 'completed').catch(() => {});
		await this.retireReviewers().catch(() => {});
		return { accepted: true, merged: [], committed: [] };
	}
	/**
	 * spec/crew#accept: the commit message generator of spec/agents-and-providers#one-shot (one shared prompt) writes the part's commit from the foreman's `git log`
	 * and the part's diff (merge base → worker branch). Any failure, timeout or empty answer falls back to «agent: title».
	 */
	private async partMessage(
		worker: CrewWorkerRecord,
		branch: string,
		targets: readonly { scope: Scope; target: string }[]
	): Promise<string> {
		const fallback = `${worker.name}: ${worker.title}`,
			sources: CommitMessageSource[] = [];
		for (const { scope, target } of targets) {
			const head = await gitText(target, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
					() => ''
				),
				tip = await gitText(target, [
					'rev-parse',
					'--verify',
					'--quiet',
					`refs/heads/${branch}^{commit}`,
				]).catch(() => '');
			if (!tip) continue;
			if (
				head &&
				(await gitText(target, ['merge-base', '--is-ancestor', tip, head])
					.then(
						() => true,
						(error) => {
							if (error instanceof GitError && error.code === 1) return false;
							throw error;
						}
					)
					.catch(() => true))
			)
				continue;
			sources.push({
				name: scope.name,
				path: target,
				base: head ? await gitText(target, ['merge-base', head, tip]).catch(() => null) : null,
				tree: tip,
			});
		}
		if (!sources.length) return fallback;
		let cwd: string | undefined;
		try {
			const context = await commitMessageContext(sources);
			cwd = await mkdtemp(join(tmpdir(), 'brigadir-commit-message-'));
			const text = commitMessageText(
				await oneShotText({
					cwd,
					prompt: commitMessagePrompt(context, worker.title),
					timeoutMs: 60_000,
					signal: this.launchAbort.signal,
					...(this.deps.services.adapter ? { adapter: this.deps.services.adapter } : {}),
				})
			);
			return text || fallback;
		} catch {
			return fallback;
		} finally {
			if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
		}
	}
	/** spec/crew#subordinates: a lead hands one branch report up only after it accepted every part and its tree has no merge conflict or unfinished squash left (spec/crew#accept). */
	async branchReady(): Promise<boolean> {
		const parts = this.workers.filter((worker) => this.isPart(worker));
		if (!parts.length || parts.some((worker) => !worker.acceptedAt)) return false;
		const snapshots = await readSnapshots(this.deps.store, this.deps.key).catch(() => null);
		// spec/crew#parts: a part the lead gave in its own next part reopens that worker, so the report waits for its
		// acceptance above; a next part of the lead that assigned nothing reports its branch at once.
		for (const scope of (snapshots?.scopes ?? []).filter((scope) => scope.available !== false))
			if (
				(await hasUnmergedPaths(scope.path).catch(() => false)) ||
				(await mergeInProgress(scope).catch(() => false))
			)
				return false;
		return true;
	}
	/** spec/architecture-and-platform#host-lifecycle: nothing of the crew waits on this host — every part accepted, no plan, question, check or launch in flight. */
	settled() {
		const parts = this.workers.filter((worker) => this.isPart(worker));
		return (
			!this.planWaiter &&
			!this.launching.size &&
			!this.waiting.length &&
			parts.every((worker) => worker.acceptedAt) &&
			!this.reviews.some((run) => run.state === 'reviewing') &&
			!this.questions.some((item) => item.state === 'pending' || item.state === 'escalated')
		);
	}
	/**
	 * spec/architecture-and-platform#host-lifecycle: a reviewer whose parts are all accepted and whose checks are over stops with its agent; its worktree stays.
	 * A new round starts it again through `dispatchReviews` → `spawn`, which resumes its session. A turn still running finishes first.
	 */
	private retired = new Set<string>();
	private async retireReviewers() {
		const root = this.deps.context.spec.root;
		for (const reviewer of this.workers) {
			if (
				reviewer.acceptedAt ||
				this.retired.has(reviewer.taskId) ||
				findSpecAgent(root, reviewer.nodeId)?.role !== 'reviewer'
			)
				continue;
			const parts = this.workers.filter((worker) =>
				findSpecAgent(root, worker.nodeId)?.checkedBy.includes(reviewer.nodeId)
			);
			if (
				!parts.length ||
				parts.some((worker) => !worker.acceptedAt) ||
				this.reviews.some(
					(run) => run.state === 'reviewing' && run.reviewerNodeIds.includes(reviewer.nodeId)
				)
			)
				continue;
			const link = this.links.get(name(this.workerKey(reviewer)));
			if (!link) continue;
			const status = await readStatus(link.peer).catch(() => null);
			if (status?.busy !== false) continue;
			// Once per finished check: a reviewer the human resumes by hand is not stopped again until a new round.
			this.retired.add(reviewer.taskId);
			await link.peer.request('command', { kind: 'shutdown' }).catch(() => {});
		}
	}
	async stopWorkers() {
		for (const worker of this.workers.filter((worker) => !worker.acceptedAt)) {
			const link = await this.link(this.workerKey(worker));
			if (link) await link.peer.request('command', { kind: 'cancel' }).catch(() => {});
		}
	}
}

/** Worker side: the parent connects as a `crew` peer; the worker raises questions, notes and reports on that link (spec/crew#ask-foreman, spec/crew#notes). */
export class CrewWorker {
	private parentPeer: Peer | null = null;
	private waiters: (() => void)[] = [];
	private outbox: { seq: number }[] = [];
	private stopping = false;
	constructor(
		private store: SessionStore,
		private key: TaskKey,
		readonly context: CrewContext
	) {}
	async start() {
		try {
			const doc = await readDocument(
				await safePath(await this.store.taskDir(this.key), 'crew-outbox.json')
			);
			if (Array.isArray(doc.reports))
				this.outbox = doc.reports.filter(
					(item): item is { seq: number } => isRecord(item) && Number.isSafeInteger(item.seq)
				);
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
		}
	}
	stop() {
		this.stopping = true;
		for (const wake of this.waiters.splice(0)) wake();
	}
	attach(peer: Peer, closed: Promise<void>) {
		const previous = this.parentPeer;
		this.parentPeer = peer;
		previous?.close();
		for (const wake of this.waiters.splice(0)) wake();
		void closed.then(() => {
			if (this.parentPeer === peer) this.parentPeer = null;
		});
		void this.flush();
	}
	get connected() {
		return this.parentPeer !== null;
	}
	private async parent(signal?: AbortSignal): Promise<Peer> {
		while (!this.parentPeer) {
			if (this.stopping) throw new Error('Host is stopping');
			if (signal?.aborted) throw new Error('Cancelled');
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
				signal?.addEventListener('abort', () => resolve(), { once: true });
			});
		}
		return this.parentPeer;
	}
	request() {
		return this.parentPeer
			? { request: (method: string, params: unknown) => this.parentPeer!.request(method, params) }
			: null;
	}
	async tool(tool: string, params: unknown, signal: AbortSignal): Promise<unknown> {
		if (!toolAllowed(this.context.role, tool))
			throw new Error(`Tool ${tool} is not available to this agent`);
		if (
			![
				'ask_foreman',
				'post_note',
				'read_notes',
				'read_report',
				'read_diff',
				'submit_review',
				'approve',
			].includes(tool)
		)
			throw new Error(`Tool ${tool} is handled elsewhere`);
		const peer = await this.parent(signal);
		const callId =
			isRecord(params) && typeof params.callId === 'string' ? params.callId : randomUUID();
		return peer.request(tool, { ...(isRecord(params) ? params : {}), callId });
	}
	/** Reports push up when a turn ends; a missing parent keeps them in the outbox (spec/crew#task-type: push, not polling). */
	async report(seq: number) {
		this.outbox.push({ seq });
		await this.saveOutbox();
		await this.flush();
	}
	private async saveOutbox() {
		await atomicJson(await safePath(await this.store.taskDir(this.key), 'crew-outbox.json'), {
			schemaVersion: 1,
			reports: this.outbox,
		});
	}
	private flushing = false;
	private async flush() {
		if (this.flushing || !this.parentPeer) return;
		this.flushing = true;
		try {
			while (this.outbox.length && this.parentPeer) {
				const next = this.outbox[0]!;
				try {
					await this.parentPeer.request('report', next);
				} catch {
					break;
				}
				this.outbox.shift();
				await this.saveOutbox();
			}
		} finally {
			this.flushing = false;
		}
	}
}
export type CrewToolCall = { tool: string; params: unknown };
export function isCrewToolCall(value: unknown): value is CrewToolCall {
	return isRecord(value) && typeof value.tool === 'string' && /^[a-z_]{1,40}$/.test(value.tool);
}
