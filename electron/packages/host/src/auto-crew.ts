import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	autoHireGates,
	countedTokens,
	tokenTally,
	autoHireable,
	autoRole,
	autoHirePartLimit,
	autoSummaryLimit,
	autoPartPromptLimit,
	autoAcceptanceLimit,
	autoZoneLimit,
	autoModelReasonLimit,
	clampAutoBudget,
	crewName,
	crewWorkerClosed,
	editedHireParts,
	isAutoHire,
	isAutoHireDecision,
	isAutoModelAnswer,
	isRecord,
	modelRole,
	normalizeZonePath,
	zoneOwns,
	type AutoHire,
	type AutoHireDecision,
	type AutoHired,
	type AutoHirePart,
	type AutoModelAnswer,
	type AutoModelRequest,
	type AutoTask,
	type CrewSpec,
	type CrewSpecAgent,
	type CrewWorkerRecord,
	type EventRecord,
} from '@brigadir/core';
import { atomicJson, readDocument } from '@brigadir/persistence';
import {
	commitMessageContext,
	commitMessagePrompt,
	commitMessageText,
	commitPreview,
	gitText,
	previewCommits,
	readSnapshots,
	type CommitMessageSource,
} from '@brigadir/git';
import { oneShotText } from '@brigadir/transport';
import { CrewHost, type CrewHostDeps } from './crew';
import {
	applySwitch,
	movedScopes,
	newMoveId,
	prepareMove,
	readMove,
	repoNames,
	restoreProject,
	rollbackMove,
	saveMove,
	type MoveDocument,
} from './workspace-move';
/** spec/crew#auto-move: the stay reasons as the agent reads them. */
const stayReason = {
	person: 'changed outside your turns',
	moving: 'changed while the task moved',
	conflict: 'changed before the task too, and your change does not merge',
	ignored: 'ignored by git',
	outside: 'outside git',
} as const;

/**
 * spec/crew#auto: the host of an `Auto` task. Its agent writes code itself and hires workers through a card the person approves; each hire is a
 * new worker task. A named crew's foreman stays a `CrewHost`.
 */
export type AutoCrewDeps = CrewHostDeps & {
	/** Ask the app (the window's peer); null when no window is connected. */
	app(method: string, params: unknown): Promise<unknown> | null;
	/** spec/crew#auto-move: the host's hold for moving the task into a worktree; absent where the host cannot restart (unit tests). */
	workspace?: {
		hold(
			work: (hold: { capture(): Promise<void>; detach(): Promise<void> }) => Promise<boolean>
		): void;
		/** No prompt starts until `work` settles: the host in the worktree finishes the hire first. */
		gate?(work: Promise<void>): void;
		sessionId(): string | null;
	};
};
type HireResult = { approved: boolean; parts: AutoHirePart[]; hired: AutoHired[]; moving?: true };
const hireFile = 'crew-hire.json';
/** spec/crew#auto-budget: how often the host looks at its workers' working time and tokens. */
export const budgetCheckMs = 30_000;
/**
 * spec/crew#auto-budget: working minutes are the minutes inside turns; tokens are the task counter's figure (spec/agents-and-providers#task-tokens):
 * input, cache writes and output, with the running turn's estimate — one implementation with the task budget.
 */
export function partUsage(records: readonly EventRecord[], now = Date.now()) {
	let minutes = 0,
		started: number | null = null;
	for (const record of records) {
		const event = record.event,
			at = Date.parse(record.at);
		if (event.kind === 'turn.started') started = Number.isFinite(at) ? at : started;
		else if (
			(event.kind === 'turn.completed' ||
				event.kind === 'session.failed' ||
				event.kind === 'host.stopped') &&
			started !== null
		) {
			if (Number.isFinite(at)) minutes += Math.max(0, at - started) / 60_000;
			started = null;
		}
	}
	if (started !== null) minutes += Math.max(0, now - started) / 60_000;
	const tally = tokenTally(records);
	return { minutes: Math.round(minutes * 10) / 10, tokens: countedTokens(tally) + tally.estimate };
}
/** A name not in `taken`: `base`, then `base 2`, `base 3`, … — the base shortened first so the suffix always fits the name limit. */
export function uniqueName(base: string, taken: ReadonlySet<string>, limit = 80): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = ` ${n}`,
			name = `${base.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
		if (!taken.has(name)) return name;
	}
}
export class AutoCrewHost extends CrewHost {
	private hireWaiter: {
		hire: AutoHire;
		resolve(result: HireResult): void;
		reject(error: Error): void;
	} | null = null;
	private modelWaiters = new Map<
		string,
		{
			request: AutoModelRequest;
			resolve(role: CrewSpecAgent | null): void;
			reject(error: Error): void;
		}
	>();
	private budgetTimer: ReturnType<typeof setInterval> | null = null;
	/** spec/crew#auto-guard: paths already reported per worker, so a file is named once. */
	private touched = new Map<string, Set<string>>();
	constructor(private autoDeps: AutoCrewDeps) {
		super(autoDeps);
	}
	private get auto(): AutoTask {
		const auto = this.deps.context.auto;
		if (!auto) throw new Error('This task is not an Auto task');
		return auto;
	}
	/** spec/composer-steering-queue-and-ghost#steering-conditions: the agent's `hire_workers` call waits for the person's answer in this host. */
	hireWaiting() {
		return this.hireWaiter !== null;
	}
	override async start() {
		await super.start();
		// spec/crew#auto-move: a move that waited for the turn, stopped half-way, or switched the task before this host started goes on. A
		// switched one finishes its hire before any prompt of this host starts.
		const move = await readMove(this.deps.store, this.deps.key).catch(() => null);
		if (move?.state === 'switched' && this.deps.context.worktree) {
			const finishing = this.finishMove(move);
			if (this.autoDeps.workspace?.gate) this.autoDeps.workspace.gate(finishing);
			else void finishing.catch(() => {});
		} else if (move) setImmediate(() => void this.resumeMove(move).catch(() => {}));
		this.budgetTimer = setInterval(() => void this.checkBudgets().catch(() => {}), budgetCheckMs);
		this.budgetTimer.unref?.();
	}
	override async stop() {
		if (this.budgetTimer) clearInterval(this.budgetTimer);
		this.hireWaiter?.reject(new Error('Host is stopping'));
		this.hireWaiter = null;
		for (const waiter of this.modelWaiters.values()) waiter.reject(new Error('Host is stopping'));
		this.modelWaiters.clear();
		await super.stop();
	}
	override async tool(tool: string, params: unknown, signal: AbortSignal): Promise<unknown> {
		const input = isRecord(params) ? params : {};
		switch (tool) {
			case 'hire_workers':
				return this.hireWorkers(input, signal);
			case 'dismiss_worker':
				return this.dismissTool(input);
			case 'request_model':
				return this.requestModel(input, signal);
			// spec/crew#auto-dismiss, spec/crew#auto-budget: every path that gives a worker another turn.
			case 'prompt_task':
			case 'submit_review': {
				if (tool === 'submit_review' && input.taskId === this.deps.key.id)
					return super.tool(tool, params, signal);
				const worker = this.worker(input.taskId);
				if (worker.dismissedAt)
					throw new Error(
						`${worker.name} was dismissed; its task keeps its diff. Hire again for more work on «${worker.title}».`
					);
				if (worker.exceededAt && (!worker.budgetStopped || (await this.overBudgetNow(worker))))
					throw new Error(
						`«${worker.title}» went over its budget and waits for the person: they continue it or dismiss ${worker.name}.`
					);
				return super.tool(tool, params, signal);
			}
			default:
				return super.tool(tool, params, signal);
		}
	}

	// ── hire ────────────────────────────────────────────────────────────

	/**
	 * spec/crew#auto-isolation: a hire needs the task in a worktree. A task in the project's checkout is moved into one when the person approves
	 * (spec/crew#auto-move); only a project without git, or a host that cannot move, refuses.
	 */
	private async hireIsolation(): Promise<string | null> {
		if (this.deps.context.worktree) return null;
		const refusal =
			'Hiring needs a worktree, and this project has no Git repository. Do these parts yourself.';
		if (!this.autoDeps.workspace)
			return 'Hiring needs a worktree, and this host cannot move the task into one. Do these parts yourself.';
		const [snapshots, project] = await Promise.all([
			readSnapshots(this.deps.store, this.deps.key).catch(() => null),
			this.deps.store.project(this.deps.key.projectId),
		]);
		return snapshots &&
			movedScopes(snapshots, await realpath(project.path)).some((scope) => scope.kind === 'root')
			? null
			: refusal;
	}
	private running() {
		return this.workers
			.filter((worker) => !crewWorkerClosed(worker) && worker.zone?.length)
			.map((worker) => ({ name: worker.name, zone: worker.zone!, hireId: worker.hireId }));
	}
	private parseParts(input: unknown): AutoHirePart[] {
		if (!Array.isArray(input) || !input.length) throw new Error('Pass parts: at least one part.');
		if (input.length > autoHirePartLimit)
			throw new Error(`A hire has at most ${autoHirePartLimit} parts.`);
		const roles = () => this.auto.roles.map((role) => role.name).join(', ') || 'none';
		return input.map((item, index) => {
			const n = index + 1;
			if (!isRecord(item)) throw new Error(`Part ${n} must be an object.`);
			const title = typeof item.title === 'string' ? crewName(item.title).slice(0, 80) : '';
			if (!title) throw new Error(`Part ${n} needs a title.`);
			const role = typeof item.role === 'string' ? autoRole(this.auto, item.role) : undefined;
			if (!role)
				throw new Error(
					`Unknown role ${String(item.role)} for part ${n}. Roles: ${roles()}. For another model, call request_model first.`
				);
			const prompt = typeof item.prompt === 'string' ? item.prompt : '';
			if (!prompt.trim()) throw new Error(`Part ${n} needs a prompt.`);
			if (prompt.length > autoPartPromptLimit)
				throw new Error(`The prompt of part ${n} is too long.`);
			const zoneInput = Array.isArray(item.zone) ? item.zone : [];
			if (!zoneInput.length || zoneInput.length > autoZoneLimit)
				throw new Error(`Part ${n} needs its zone: the paths or globs it writes.`);
			const zone = zoneInput.map((path) =>
				typeof path === 'string' ? normalizeZonePath(path) : null
			);
			if (zone.some((path) => path === null))
				throw new Error(`The zone of part ${n} has an invalid path.`);
			const lines = Number(item.lines);
			if (!Number.isFinite(lines) || lines < 0)
				throw new Error(`Part ${n} needs lines: your estimate of the lines it changes.`);
			const files = Number.isFinite(Number(item.files))
				? Math.max(1, Math.round(Number(item.files)))
				: 1;
			const acceptance = typeof item.acceptance === 'string' ? item.acceptance.trim() : '';
			if (acceptance.length > autoAcceptanceLimit)
				throw new Error(`The acceptance of part ${n} is too long.`);
			const scopes = Array.isArray(item.scopes)
				? item.scopes.filter((scope): scope is string => typeof scope === 'string').slice(0, 512)
				: [];
			return {
				id: randomUUID(),
				title,
				role: role.id,
				roleName: role.name,
				prompt,
				zone: [...new Set(zone as string[])],
				scopes,
				...(acceptance ? { acceptance } : {}),
				budget: clampAutoBudget({ minutes: item.minutes, tokens: item.tokens }, this.auto.budget),
				estimate: { files, lines: Math.round(lines) },
			};
		});
	}
	private async pendingHire(): Promise<AutoHire | null> {
		try {
			const doc = await readDocument(await this.file(hireFile));
			return doc.decision === null && isAutoHire(doc.hire) ? doc.hire : null;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
	}
	/** spec/crew#auto-hire: one hire at a time, reserved before anything is awaited, so two calls in one turn cannot both reach the card. */
	private hiring = false;
	private async hireWorkers(input: Record<string, unknown>, signal: AbortSignal) {
		if (this.hiring || this.hireWaiter)
			throw new Error('A hire is already waiting for the person.');
		this.hiring = true;
		try {
			const refusedHere = await this.hireIsolation();
			if (refusedHere) throw new Error(refusedHere);
			const move = await readMove(this.deps.store, this.deps.key).catch(() => null);
			if (move && ['pending', 'moving', 'switching', 'switched'].includes(move.state))
				throw new Error('The task is moving into a worktree for the previous hire.');
			return await this.hireNow(input, signal);
		} finally {
			this.hiring = false;
		}
	}
	private async hireNow(input: Record<string, unknown>, signal: AbortSignal) {
		if (await this.pendingHire()) throw new Error('A hire is already waiting for the person.');
		const summary =
			typeof input.summary === 'string' ? input.summary.slice(0, autoSummaryLimit) : '';
		const parts = autoHireGates(this.parseParts(input.parts), this.running());
		const refused = parts.filter((part) => part.refused);
		if (!autoHireable(parts).length)
			return {
				approved: false,
				hired: [],
				refused: refused.map((part) => ({ title: part.title, reason: part.refused!.message })),
				note: 'No part can be hired. Do these parts yourself.',
			};
		const hire: AutoHire = { id: randomUUID(), summary, parts };
		await atomicJson(await this.file(hireFile), { schemaVersion: 1, hire, decision: null });
		await this.deps.emit({ kind: 'crew.hire.requested', hire });
		const result = await new Promise<HireResult>((resolve, reject) => {
			this.hireWaiter = { hire, resolve, reject };
			const abort = () => {
				if (this.hireWaiter?.hire.id === hire.id) {
					this.hireWaiter = null;
					reject(new Error('The hire was cancelled'));
				}
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
		return this.hireReply(result);
	}
	/** What the agent reads back: who started, what stays with it, and the person's edits in full (the model wrote the rest itself). */
	private hireReply(result: HireResult) {
		const stays = result.parts.filter((part) => part.refused);
		if (!result.approved)
			return {
				approved: false,
				note: 'The person declined the hire. Do these parts yourself.',
			};
		if (result.moving)
			return {
				approved: true,
				moving: true,
				note: "The person approved the hire. This task runs in the project's own folder, so it moves into a worktree of its own when your turn ends: end your turn now. Your uncommitted edits move with it and are committed, the workers start from that commit, and you continue in the worktree. The result comes to you as a message.",
			};
		return {
			approved: true,
			hired: result.hired.map((item) => {
				const part = result.parts.find((candidate) => candidate.id === item.partId)!;
				return {
					taskId: item.taskId,
					worker: item.name,
					role: item.role,
					title: part.title,
					budget: part.budget,
				};
			}),
			...(stays.length
				? {
						staysWithYou: stays.map((part) => ({
							title: part.title,
							reason: part.refused!.message,
						})),
					}
				: {}),
			note: 'The workers start from the commit of your edits. Keep working on what stays with you; reports arrive by themselves.',
		};
	}
	/** spec/crew#auto-hire: `Hire {n}` or `Do it yourself`. The card survives a restart: a decision with no waiting call goes as a prompt. */
	private deciding = false;
	async decideHire(decision: AutoHireDecision, preface = '') {
		if (!isAutoHireDecision(decision)) throw new Error('Invalid hire decision');
		// A second press while the first decision still starts workers would start them twice.
		if (this.deciding) throw new Error('The hire is being decided');
		this.deciding = true;
		try {
			await this.decideNow(decision, preface);
		} finally {
			this.deciding = false;
		}
	}
	private async decideNow(decision: AutoHireDecision, preface = '') {
		const pending = this.hireWaiter?.hire ?? (await this.pendingHire());
		if (!pending || pending.id !== decision.id) throw new Error('The hire is no longer pending');
		const moving = await readMove(this.deps.store, this.deps.key).catch(() => null);
		if (
			moving?.hireId === pending.id &&
			(moving.state === 'pending' || moving.state === 'moving' || moving.state === 'switching')
		)
			throw new Error('The hire is being decided');
		const edited = decision.parts ? editedHireParts(pending.parts, decision.parts) : null;
		if (decision.parts && !edited) throw new Error('The edited parts do not match the hire');
		for (const part of edited ?? [])
			if (!this.auto.roles.some((role) => role.id === part.role))
				throw new Error(`Unknown role for «${part.title}»`);
		// The gates read the workers running now: one may have started since the card showed. Workers of this hire that started
		// before a crash are its own parts, not someone else's zone.
		const parts = autoHireGates(
			edited ?? pending.parts,
			this.running().filter((item) => item.hireId !== pending.id)
		);
		// spec/crew#auto-move: a task without isolation moves into a worktree first; the hire goes on in the host that starts there.
		if (decision.approved && !this.deps.context.worktree && autoHireable(parts).length) {
			await this.startMove(pending, decision);
			if (this.hireWaiter?.hire.id === pending.id) {
				const waiter = this.hireWaiter;
				this.hireWaiter = null;
				waiter.resolve({ approved: true, parts, hired: [], moving: true });
			}
			return;
		}
		const hired = decision.approved ? await this.executeHire(pending.id, parts) : [];
		await atomicJson(await this.file(hireFile), { schemaVersion: 1, hire: pending, decision });
		await this.deps.emit({
			kind: 'crew.hire.resolved',
			id: pending.id,
			approved: decision.approved,
			parts: edited ? parts : null,
			hired,
		});
		const result: HireResult = { approved: decision.approved, parts, hired };
		if (this.hireWaiter?.hire.id === pending.id) {
			const waiter = this.hireWaiter;
			this.hireWaiter = null;
			waiter.resolve(result);
			if (
				!this.callEnded(
					'crew.hire.requested',
					(event) => event.kind === 'crew.hire.requested' && event.hire.id === pending.id
				)
			)
				return;
		}
		await this.deps.prompt(
			`${preface}The person decided your hire. ${JSON.stringify(this.hireReply(result), null, 2)}`,
			{ kind: 'hire-decision', hireId: pending.id, approved: decision.approved }
		);
	}

	// ── moving into a worktree ─────────────────────────────────────────

	private moveDeps() {
		return {
			store: this.deps.store,
			key: this.deps.key,
			services: this.deps.services,
			records: () => this.deps.records(),
		};
	}
	/** spec/crew#auto-move, step 1: the approval is written down and the card closes; the move waits for the turn to end. */
	private async startMove(hire: AutoHire, decision: AutoHireDecision) {
		const [snapshots, project] = await Promise.all([
			readSnapshots(this.deps.store, this.deps.key).catch(() => null),
			this.deps.store.project(this.deps.key.projectId),
		]);
		const doc: MoveDocument = {
			schemaVersion: 1,
			id: newMoveId(),
			hireId: hire.id,
			decision,
			state: 'pending',
			repos: snapshots
				? repoNames(movedScopes(snapshots, await realpath(project.path)), project.name)
				: [],
		};
		await saveMove(this.deps.store, this.deps.key, doc);
		await this.deps.emit({
			kind: 'workspace.move',
			id: doc.id,
			hireId: doc.hireId,
			state: 'moving',
			repos: doc.repos,
		});
		this.holdMove(doc);
	}
	private holdMove(doc: MoveDocument) {
		const workspace = this.autoDeps.workspace;
		if (!workspace) return;
		workspace.hold((hold) => this.runMove(doc, hold));
	}
	/** spec/crew#auto-move, steps 2–8, in the host that still runs in the project folder. True: the host restarts in the worktree. */
	private async runMove(
		doc: MoveDocument,
		hold: { capture(): Promise<void>; detach(): Promise<void> }
	): Promise<boolean> {
		const store = this.deps.store,
			key = this.deps.key;
		const sessionId =
			(await store.task(key)).provider === 'claude' ? this.autoDeps.workspace?.sessionId() : null;
		let current: MoveDocument = { ...doc, state: 'moving', ...(sessionId ? { sessionId } : {}) };
		try {
			await saveMove(store, key, current);
			await hold.capture();
			await hold.detach();
			current = await prepareMove(this.moveDeps(), current);
			await saveMove(store, key, current);
		} catch (error) {
			await rollbackMove(this.moveDeps(), current.branch).catch(() => {});
			await this.failMove(current, error instanceof Error ? error.message : String(error));
			return false;
		}
		try {
			current = await applySwitch(store, key, current);
			current = await restoreProject(store, key, current);
		} catch (error) {
			// The next host finishes a switch it finds half-written (finishSwitch) and restores the project folder.
			process.stderr.write(
				`[host] workspace switch: ${error instanceof Error ? error.message : String(error)}\n`
			);
		}
		return true;
	}
	/** spec/crew#auto-move: nothing moved; the hire resolves as not approved and the agent does the parts itself. */
	private async failMove(doc: MoveDocument, message: string) {
		const store = this.deps.store,
			key = this.deps.key;
		await saveMove(store, key, { ...doc, state: 'failed', message });
		await this.deps.emit({
			kind: 'workspace.move',
			id: doc.id,
			hireId: doc.hireId,
			state: 'failed',
			repos: doc.repos,
			message,
		});
		const hire = await this.pendingHire();
		if (hire?.id === doc.hireId) {
			await atomicJson(await this.file(hireFile), {
				schemaVersion: 1,
				hire,
				decision: { ...doc.decision, approved: false },
			});
			await this.deps.emit({
				kind: 'crew.hire.resolved',
				id: hire.id,
				approved: false,
				parts: null,
				hired: [],
				reason: 'no-worktree',
			});
		}
		await this.deps.prompt(
			`The task could not move into a worktree: ${message}. The hire did not start and the task keeps running in the project folder, with your edits where they were. Do these parts yourself.`,
			{ kind: 'hire-decision', hireId: doc.hireId, approved: false }
		);
	}
	/** spec/crew#auto-move: what a host finds at its start. */
	private async resumeMove(doc: MoveDocument) {
		if (doc.state === 'pending' && !this.deps.context.worktree) return this.holdMove(doc);
		if (doc.state === 'moving' && !this.deps.context.worktree) {
			// The host stopped before the switch: the project folder never changed; the copies go.
			await rollbackMove(this.moveDeps(), doc.branch).catch(() => {});
			return this.failMove(doc, 'The move stopped before it finished');
		}
	}
	/**
	 * spec/crew#auto-move, step 9, in the host that starts in the worktree: the commit, the workers, the row and the agent's message. The
	 * document stays `switched` until the hire is decided, so a restart in between finishes it again; the hire's own record starts only the
	 * parts that have no worker yet.
	 */
	private async finishMove(doc: MoveDocument) {
		const store = this.deps.store,
			key = this.deps.key;
		const current = await restoreProject(store, key, doc);
		const announced = this.deps
			.records()
			.some(
				({ event }) =>
					event.kind === 'workspace.move' && event.id === current.id && event.state === 'moved'
			);
		if (!announced)
			await this.deps.emit({
				kind: 'workspace.move',
				id: current.id,
				hireId: current.hireId,
				state: 'moved',
				repos: current.repos,
				...(current.branch ? { branch: current.branch } : {}),
				...(current.base ? { base: current.base } : {}),
				stayed: current.stayed ?? [],
			});
		const stayed = current.stayed ?? [];
		const preface = `The task moved into a worktree: ${current.to} on branch ${current.branch} (from ${current.base}). Your edits moved with it; work there from now on.${
			stayed.length
				? ` These paths stayed in the project folder (${current.from}): ${stayed
						.slice(0, 50)
						.map((item) => `${item.path} (${stayReason[item.reason]})`)
						.join(', ')}.`
				: ''
		}\n\n`;
		const hire = await this.pendingHire();
		if (hire?.id === current.hireId)
			try {
				await this.decideHire(current.decision, preface);
			} catch (error) {
				await this.hireFailed(
					hire,
					preface,
					error instanceof Error ? error.message : String(error)
				);
			}
		await saveMove(store, key, { ...current, state: 'moved' });
	}
	/** The hire stopped half-way: the workers that started stay hired, the rest goes back to the agent. */
	private async hireFailed(hire: AutoHire, preface: string, message: string) {
		const started = this.workers.filter((worker) => worker.hireId === hire.id && worker.planPartId);
		const hired: AutoHired[] = started.map((worker) => ({
			partId: worker.planPartId!,
			taskId: worker.taskId,
			name: worker.name,
			role: hire.parts.find((part) => part.id === worker.planPartId)?.roleName ?? worker.name,
		}));
		const decision = await readMove(this.deps.store, this.deps.key)
			.then((doc) => doc?.decision)
			.catch(() => undefined);
		await atomicJson(await this.file(hireFile), {
			schemaVersion: 1,
			hire,
			decision: { ...(decision ?? { id: hire.id, parts: null }), approved: hired.length > 0 },
		});
		await this.deps.emit({
			kind: 'crew.hire.resolved',
			id: hire.id,
			approved: hired.length > 0,
			parts: null,
			hired,
		});
		await this.deps.prompt(
			`${preface}The hire could not start all its workers: ${message}. ${
				hired.length
					? `Started: ${hired.map((item) => `${item.name} (task ${item.taskId})`).join(', ')}. `
					: ''
			}Do the other parts yourself.`,
			{ kind: 'hire-decision', hireId: hire.id, approved: hired.length > 0 }
		);
	}

	/** Codex may end a turn with an MCP call still open; the result alone cannot wake that turn (spec/crew#plan). */
	private callEnded(_kind: string, match: (event: EventRecord['event']) => boolean) {
		const records = this.deps.records();
		const requested = records.findLastIndex(({ event }) => match(event));
		return (
			requested >= 0 &&
			records
				.slice(requested + 1)
				.some(
					({ event }) =>
						event.kind === 'turn.completed' ||
						event.kind === 'session.failed' ||
						event.kind === 'host.stopped'
				)
		);
	}
	/**
	 * spec/crew#auto-hire: commit the agent's edits, add the parts to the crew and start one worker task per part. A worker carries its hire
	 * and part from the moment its record is written, so a decision made again after a crash starts only the parts that have no worker yet.
	 */
	private async executeHire(hireId: string, parts: readonly AutoHirePart[]): Promise<AutoHired[]> {
		const hireable = autoHireable(parts);
		if (!hireable.length) return [];
		const started = new Map(
			this.workers
				.filter((worker) => worker.hireId === hireId && worker.planPartId)
				.map((worker) => [worker.planPartId!, worker])
		);
		const pending = hireable.filter((part) => !started.has(part.id));
		if (pending.length) {
			if (!this.deps.context.worktree) throw new Error('Hiring needs this task in a worktree.');
			await this.commitLead('hire', pending.map((part) => part.title).join(', '));
			const from = await this.leadHeads();
			const spec = this.deps.context.spec,
				taken = new Set(this.specNames(spec.root));
			// A part's node id comes from its hire and part, so a decision made again after a crash finds the node it already added.
			const nodeId = (part: AutoHirePart) =>
				`w-${createHash('sha256').update(`${hireId}\0${part.id}`).digest('hex').slice(0, 16)}`;
			const nodes = pending.map((part) => {
				const existing = spec.root.agents.find((agent) => agent.id === nodeId(part));
				if (existing) return { part, node: existing, added: false };
				const role = this.auto.roles.find((item) => item.id === part.role)!;
				const name = uniqueName(role.name, taken);
				taken.add(name);
				const node: CrewSpecAgent = {
					...role,
					id: nodeId(part),
					name,
					template: role.id,
					zone: part.zone,
					checkedBy: [],
					agents: [],
				};
				return { part, node, added: true };
			});
			const next: CrewSpec = {
				...spec,
				root: {
					...spec.root,
					agents: [
						...spec.root.agents,
						...nodes.filter((item) => item.added).map((item) => item.node),
					],
				},
			};
			const task = await this.deps.store.task(this.deps.key);
			await this.deps.store.updateTask(task, { crew: next });
			this.adoptSpec(next);
			for (const { part, node } of nodes) {
				const record = await this.spawnWorkerTask(
					node,
					part.title,
					part.prompt,
					part.scopes,
					false,
					{
						budget: part.budget,
						zone: part.zone,
						hiredFrom: from,
						hireId,
						planPartId: part.id,
					}
				);
				await this.savePartBrief(record, part.prompt, part.acceptance ?? '');
				started.set(part.id, record);
			}
		}
		return hireable.map((part) => {
			const record = started.get(part.id)!;
			return { partId: part.id, taskId: record.taskId, name: record.name, role: part.roleName };
		});
	}
	private specNames(node: CrewSpecAgent): string[] {
		return [node.name, ...node.agents.flatMap((child) => this.specNames(child))];
	}
	/** The agent's tree as `{project-relative repo path → HEAD}` after its commit: where its hired workers start. */
	private async leadHeads(): Promise<Record<string, string>> {
		const project = await this.deps.store.projectForTask(this.deps.key),
			snapshots = await readSnapshots(this.deps.store, this.deps.key).catch(() => null),
			heads: Record<string, string> = {};
		for (const scope of (snapshots?.scopes ?? []).filter((item) => item.available !== false)) {
			if (scope.path !== project.path && !scope.path.startsWith(`${project.path}/`)) continue;
			const head = await gitText(scope.path, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
				() => ''
			);
			if (/^[0-9a-f]{40,64}$/.test(head))
				heads[scope.path === project.path ? '' : scope.path.slice(project.path.length + 1)] = head;
		}
		return heads;
	}

	/** spec/crew#auto-hire: a hired reviewer does a part of its own (a check the agent handed out), so its turns report like a developer's. */
	protected override isReviewWorker(agent: CrewSpecAgent | null | undefined) {
		return (
			super.isReviewWorker(agent) ||
			(agent?.role === 'reviewer' &&
				this.workers.some((worker) => worker.nodeId === agent.id && worker.hireId !== undefined))
		);
	}

	// ── the agent's own commit ────────────────────────────────────────────

	/**
	 * spec/crew#auto-commit: before a hire and before an accept, the agent's uncommitted edits become a commit of its own on the task's branch,
	 * so workers start from it and a squash finds a clean tree. The snapshot diff of the task does not change: it diffs trees, not commits.
	 */
	private async commitLead(reason: 'hire' | 'accept', subject: string) {
		const store = this.deps.store,
			snapshots = await readSnapshots(store, this.deps.key).catch(() => null);
		if (!snapshots) return;
		const scopes = snapshots.scopes.filter((scope) => scope.available !== false);
		const preview = await previewCommits(scopes, snapshots);
		if (!preview.scopes.length) return;
		const task = await store.task(this.deps.key),
			fallback = `${task.title}`.trim() || subject;
		const message = await this.leadMessage(
			preview.scopes.map((item) => ({
				name: item.scope.name,
				path: item.scope.path,
				base: item.head,
				tree: item.tree,
			})),
			reason === 'hire' ? `${task.title} (before hiring: ${subject})` : task.title,
			fallback
		);
		const result = await commitPreview(preview, scopes, message, snapshots);
		if (result.error) throw new Error(`Committing your edits failed: ${result.error}`);
		if (result.committed.length)
			await this.deps.emit({
				kind: 'crew.lead.committed',
				reason,
				commits: result.committed.map((item) => ({ scope: item.name, sha: item.sha })),
			});
	}
	private async leadMessage(sources: CommitMessageSource[], title: string, fallback: string) {
		let cwd: string | undefined;
		try {
			const context = await commitMessageContext(sources);
			cwd = await mkdtemp(join(tmpdir(), 'brigadir-commit-message-'));
			const text = commitMessageText(
				await oneShotText({
					cwd,
					prompt: commitMessagePrompt(context, title),
					timeoutMs: 60_000,
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
	protected override async beforeAccept(worker: CrewWorkerRecord) {
		await this.commitLead('accept', worker.title);
	}
	protected override async afterAccept(worker: CrewWorkerRecord) {
		await this.markDismissed(worker, 'accepted');
	}

	// ── dismiss ──────────────────────────────────────────────────────────

	private async markDismissed(
		worker: CrewWorkerRecord,
		reason: 'accepted' | 'discarded' | 'person'
	) {
		if (worker.dismissedAt) return;
		worker.dismissedAt = new Date().toISOString();
		worker.dismissReason = reason;
		await this.saveWorkers();
		await this.deps.emit({
			kind: 'crew.worker.dismissed',
			taskId: worker.taskId,
			nodeId: worker.nodeId,
			name: worker.name,
			title: worker.title,
			reason,
		});
	}
	private async dismissTool(input: Record<string, unknown>) {
		const worker = this.worker(input.taskId);
		if (worker.acceptedAt || worker.dismissedAt)
			throw new Error(`${worker.name} is already dismissed.`);
		await this.dismiss(worker, 'discarded');
		return {
			dismissed: true,
			taskId: worker.taskId,
			note: `${worker.name} is dismissed; its task keeps its diff and nothing of it is merged. «${worker.title}» is yours again.`,
		};
	}
	/** spec/crew#auto-dismiss: the person's `Dismiss` on a worker row. The agent hears of it with its next report or prompt. */
	async dismissWorker(taskId: string) {
		const worker = this.worker(taskId);
		if (worker.acceptedAt || worker.dismissedAt) return;
		await this.dismiss(worker, 'person');
	}
	private async dismiss(worker: CrewWorkerRecord, reason: 'discarded' | 'person') {
		const key = this.workerKey(worker);
		const link = await this.link(key).catch(() => null);
		if (link) {
			await link.peer.request('command', { kind: 'cancel' }).catch(() => {});
			await link.peer.request('command', { kind: 'shutdown' }).catch(() => {});
		}
		await this.deps.store.setStatus(key, 'completed').catch(() => {});
		await this.markDismissed(worker, reason);
	}

	// ── budget ───────────────────────────────────────────────────────────

	private async overBudgetNow(worker: CrewWorkerRecord) {
		const task = await this.deps.store.task(this.workerKey(worker)).catch(() => null);
		return task?.overBudget === true;
	}
	/** spec/crew#auto-budget: a part over its working time or tokens stops and goes to the person; the budget is not checked again after that. */
	async checkBudgets(now = Date.now()) {
		for (const worker of this.workers) {
			if (!worker.budget || crewWorkerClosed(worker)) continue;
			if (!worker.exceededAt) {
				const used = partUsage((await this.journal(this.workerKey(worker))).records, now);
				if (used.minutes < worker.budget.minutes && used.tokens < worker.budget.tokens) continue;
				worker.exceededAt = new Date(now).toISOString();
				await this.saveWorkers();
				await this.deps.emit({
					kind: 'crew.budget.exceeded',
					taskId: worker.taskId,
					name: worker.name,
					title: worker.title,
					budget: worker.budget,
					used,
				});
			}
			// spec/crew#auto-budget: the stop is sent until the worker's host takes it, also after a disconnect or a restart of either host.
			if (!worker.budgetStopped) await this.sendBudgetStop(worker, now);
		}
	}
	private async sendBudgetStop(worker: CrewWorkerRecord, now: number) {
		const link = await this.link(this.workerKey(worker)).catch(() => null);
		if (!link) return;
		const used = partUsage((await this.journal(this.workerKey(worker))).records, now);
		try {
			await link.peer.request('command', {
				kind: 'overBudget',
				title: worker.title,
				budget: worker.budget!,
				used,
			});
		} catch {
			return;
		}
		worker.budgetStopped = new Date(now).toISOString();
		await this.saveWorkers();
	}

	// ── the lead's writes in hired zones ──────────────────────────────────

	/** spec/crew#auto-guard: the zones of running workers; the file layer refuses the agent's writes there. */
	hiredZone(projectPath: string): { name: string; title: string } | null {
		for (const worker of this.workers) {
			if (crewWorkerClosed(worker) || !worker.zone?.length) continue;
			if (zoneOwns(worker.zone, projectPath)) return { name: worker.name, title: worker.title };
		}
		return null;
	}
	/**
	 * spec/crew#auto-guard: Claude and Codex write files themselves, not through the app's file layer, so after each turn of the agent the host
	 * compares its tree with the commit the hire started from and names the files it changed inside a hired zone.
	 */
	async checkZones(): Promise<void> {
		const project = await this.deps.store.projectForTask(this.deps.key).catch(() => null);
		if (!project) return;
		for (const worker of this.workers) {
			if (crewWorkerClosed(worker) || !worker.zone?.length || !worker.hiredFrom) continue;
			const paths: string[] = [];
			for (const [relativePath, sha] of Object.entries(worker.hiredFrom)) {
				const repo = relativePath ? join(project.path, relativePath) : project.path;
				const changed = [
					...(await gitText(repo, ['diff', '--name-only', sha, '--']).catch(() => '')).split('\n'),
					...(
						await gitText(repo, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
					).split('\n'),
				].filter(Boolean);
				for (const path of changed) {
					const full = relativePath ? `${relativePath}/${path}` : path;
					if (zoneOwns(worker.zone, full)) paths.push(full);
				}
			}
			const seen = this.touched.get(worker.taskId) ?? new Set<string>(),
				fresh = [...new Set(paths)].filter((path) => !seen.has(path));
			if (!fresh.length) continue;
			for (const path of fresh) seen.add(path);
			this.touched.set(worker.taskId, seen);
			await this.deps.emit({
				kind: 'crew.zone.touched',
				taskId: worker.taskId,
				name: worker.name,
				title: worker.title,
				paths: fresh.slice(0, 50),
			});
			await this.deps.prompt(
				`You changed files inside «${worker.title}», the part you hired out to ${worker.name}: ${fresh.slice(0, 20).join(', ')}. Put them back as they were at the hire, or hand the change to ${worker.name} with prompt_task; otherwise accepting its part will conflict.`,
				{ kind: 'zone-touched', taskId: worker.taskId, agent: worker.name }
			);
		}
	}

	// ── another model ────────────────────────────────────────────────────

	/** spec/crew#auto-model: a model outside the roles. With `Any catalog model` the app resolves it at once; otherwise the person answers a card. */
	private async requestModel(input: Record<string, unknown>, signal: AbortSignal) {
		const reason =
			typeof input.reason === 'string' ? input.reason.trim().slice(0, autoModelReasonLimit) : '';
		if (!reason) throw new Error('Say why no role fits: pass reason.');
		const base =
			(typeof input.role === 'string' && autoRole(this.auto, input.role)) ||
			this.auto.roles.find((role) => role.role === 'developer');
		if (!base)
			throw new Error(
				`Unknown role ${String(input.role)}. Roles: ${this.auto.roles.map((role) => role.name).join(', ')}.`
			);
		const provider =
			input.provider === 'claude' || input.provider === 'codex'
				? input.provider
				: typeof input.provider === 'string' && /^openai$/i.test(input.provider)
					? 'codex'
					: undefined;
		const request: AutoModelRequest = {
			id: randomUUID(),
			reason,
			role: base.name,
			...(typeof input.part === 'string' && input.part.trim()
				? { part: crewName(input.part).slice(0, 80) }
				: {}),
			...(provider ? { provider } : {}),
			...(typeof input.model === 'string' && input.model.trim()
				? { model: input.model.trim().slice(0, 200) }
				: {}),
			...(typeof input.effort === 'string' && input.effort.trim()
				? { effort: input.effort.trim().slice(0, 200) }
				: {}),
		};
		// spec/crew#auto-model: with `Any catalog model` the app checks the names against the provider's catalog; no card.
		const chosen = this.autoDeps.app('auto_model', request);
		if (chosen) {
			const answer = await chosen;
			if (isRecord(answer) && answer.ask !== true) {
				if (!isAutoModelAnswer(answer)) throw new Error('The model could not be resolved.');
				const role = await this.addModelRole(base, answer);
				await this.deps.emit({
					kind: 'crew.model.resolved',
					id: request.id,
					answer,
					by: 'agent',
					role: role.name,
					...(request.part ? { part: request.part } : {}),
				});
				return { role: role.name, note: `Hire the part with role «${role.name}».` };
			}
		}
		await this.deps.emit({ kind: 'crew.model.requested', request });
		const role = await new Promise<CrewSpecAgent | null>((resolve, reject) => {
			this.modelWaiters.set(request.id, { request, resolve, reject });
			const abort = () => {
				if (!this.modelWaiters.delete(request.id)) return;
				reject(new Error('The question was cancelled'));
				// spec/crew#auto-model: the card closes with the call, so nobody answers a question that is gone.
				void this.deps
					.emit({
						kind: 'crew.model.resolved',
						id: request.id,
						answer: null,
						by: 'agent',
						role: base.name,
						cancelled: true,
						...(request.part ? { part: request.part } : {}),
					})
					.catch(() => {});
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
		if (!role)
			return {
				role: base.name,
				note: `The person keeps «${base.name}». Hire the part with it and write what it needs into its prompt, or do it yourself.`,
			};
		return { role: role.name, note: `Hire the part with role «${role.name}».` };
	}
	/** spec/crew#auto-model: the person's answer. The new role is stored on the task; `Save as role` also reaches the library through the app. */
	async answerModel(id: string, answer: AutoModelAnswer | null) {
		const waiter = this.modelWaiters.get(id);
		if (!waiter) throw new Error('The question is no longer open');
		if (answer !== null && !isAutoModelAnswer(answer)) throw new Error('Invalid answer');
		const base = autoRole(this.auto, waiter.request.role) ?? this.auto.roles[0]!;
		const role = answer ? await this.addModelRole(base, answer) : null;
		this.modelWaiters.delete(id);
		await this.deps.emit({
			kind: 'crew.model.resolved',
			id,
			answer,
			by: 'person',
			role: (role ?? base).name,
			...(waiter.request.part ? { part: waiter.request.part } : {}),
		});
		waiter.resolve(role);
	}
	private async addModelRole(base: CrewSpecAgent, answer: AutoModelAnswer): Promise<CrewSpecAgent> {
		const made = modelRole(base, answer, `role-${randomUUID().slice(0, 12)}`),
			role = {
				...made,
				name: uniqueName(made.name, new Set(this.auto.roles.map((item) => item.name))),
			};
		const task = await this.deps.store.task(this.deps.key),
			auto: AutoTask = { ...this.auto, roles: [...this.auto.roles, role] };
		await this.deps.store.updateTask(task, { auto });
		this.deps.context.auto = auto;
		return role;
	}
}
