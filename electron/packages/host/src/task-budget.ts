import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	budgetJournal,
	budgetToAsk,
	decidedBudget,
	formatTokenCount,
	hasTokens,
	isAgentTask,
	isOpeningShare,
	isRecord,
	ownTokens,
	popoverAnswer,
	providerTokens,
	reduceBudgetJournal,
	reduceTokenTally,
	sumTokens,
	memberTokens,
	tokenHold,
	tokenTally,
	type AgentProvider,
	type AgentTask,
	type BudgetDecision,
	type BudgetJournal,
	type EventRecord,
	type SessionEvent,
	type TaskKey,
	type TaskTokenSum,
	type TokenBudget,
	type TokenHold,
	type TokenTally,
} from '@brigadir/core';
import { atomicJson, safePath, type SessionStore } from '@brigadir/persistence';

/**
 * spec/agents-and-providers#opening-share: what share of a new session's opening context a provider last paid — one document per provider in
 * `token-openings/`, so hosts of different providers never overwrite each other's.
 */
export const openingSharesDir = 'token-openings';
type OpeningShare =
	| { state: 'missing' }
	| { state: 'ok'; share: number }
	| { state: 'unsupported' | 'invalid' | 'unreadable' };
const sharePath = async (root: string, provider: AgentProvider) =>
	safePath(root, openingSharesDir, `${provider}.json`);
export async function readOpeningShare(
	root: string,
	provider: AgentProvider
): Promise<OpeningShare> {
	let text: string;
	try {
		text = await readFile(await sharePath(root, provider), 'utf8');
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
			? { state: 'missing' }
			: { state: 'unreadable' };
	}
	try {
		const doc: unknown = JSON.parse(text);
		if (isRecord(doc) && doc.schemaVersion !== 1 && typeof doc.schemaVersion === 'number')
			return { state: 'unsupported' };
		return isRecord(doc) && isOpeningShare(doc.share)
			? { state: 'ok', share: doc.share }
			: { state: 'invalid' };
	} catch {
		return { state: 'invalid' };
	}
}
/** Writes the share only over nothing or over a document of this schema: an unsupported, invalid or unreadable file is kept and reported. */
export async function writeOpeningShare(
	root: string,
	provider: AgentProvider,
	share: number
): Promise<boolean> {
	const current = await readOpeningShare(root, provider);
	if (current.state !== 'missing' && current.state !== 'ok') {
		console.warn(
			`${openingSharesDir}/${provider}.json: ${current.state}; the learned share is not saved.`
		);
		return false;
	}
	await mkdir(join(root, openingSharesDir), { recursive: true });
	await atomicJson(await sharePath(root, provider), { schemaVersion: 1, share });
	return true;
}

/** spec/agents-and-providers#task-tokens: during a turn the figure is written at most this often, and only when its short number changes. */
export const tokenWriteMs = 3000;
/** spec/agents-and-providers#budget-reached: the root re-reads its members' figures, and a member its root's hold, this often. */
export const budgetPollMs = 3000;
/** spec/agents-and-providers#budget-reached: the root checks after its own usage at most this often. */
const checkMs = 1000;

export type TaskBudgetDeps = {
	store: SessionStore;
	key: TaskKey;
	records(): readonly EventRecord[];
	emit(event: SessionEvent): Promise<void>;
	busy(): boolean;
	/** Cancel this task's running turn. */ cancel(): Promise<void>;
	/** spec/crew#budget-pause: cancel the running turns of this host's crew members. */ stopMembers(): Promise<void>;
	/** The hold lifted: start what waited, in order. */ resume(): void;
};
type Stamped = { stamp: string; task: AgentTask | null };

/**
 * spec/agents-and-providers#task-tokens, spec/agents-and-providers#budget-reached: one host's share of the token budget. Every host keeps its own task's
 * figure in `task.json`; the root task's host (a solo task, a crew's foreman) also sums its members, asks at the budget and keeps the hold in `tokenHold`;
 * a member's host reads that hold and starts nothing while it is set.
 */
export class TaskBudget {
	private tally: TokenTally;
	private journal: BudgetJournal;
	private budget: TokenBudget | undefined;
	private hold: TokenHold | null = null;
	private written = '';
	private writtenShort = '';
	private writtenAt = 0;
	private pendingWrite: ReturnType<typeof setTimeout> | null = null;
	private poll: ReturnType<typeof setInterval> | null = null;
	private checkTimer: ReturnType<typeof setTimeout> | null = null;
	private lastCheck = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private stopped = false;
	/** A member: the hold id whose `stop` it already acted on. */
	private stoppedFor: string | null = null;
	private members = new Map<string, Stamped>();
	readonly root: boolean;
	readonly rootKey: TaskKey;
	private provider: AgentProvider | undefined;
	constructor(
		private deps: TaskBudgetDeps,
		task: AgentTask
	) {
		this.root = !task.crewTaskId || task.crewTaskId === task.id;
		this.rootKey = { projectId: task.projectId, id: task.crewTaskId ?? task.id };
		this.provider = task.provider;
		const records = deps.records();
		this.tally = tokenTally(records);
		// What task.json holds now: a figure left by an earlier host (a turn cancelled with no usage) is rewritten from the journal.
		this.written = task.tokens ? JSON.stringify(task.tokens) : '';
		this.journal = budgetJournal(records);
		this.budget = this.root ? task.tokenBudget : undefined;
		if (this.root) this.hold = tokenHold(this.journal, this.budget);
	}
	/** Writes the figure and, for the root, the hold rebuilt from the journal (a restart while paused keeps the pause). */
	async start() {
		await this.serial(async () => {
			// A share this task's own journal taught is the freshest; otherwise the one the app learned last for this provider.
			const saved = this.provider
				? await readOpeningShare(this.deps.store.root, this.provider)
				: null;
			if (saved?.state === 'ok' && this.tally.learnedShare === null)
				this.tally = { ...this.tally, openingShare: saved.share };
			await this.writeTokens(true);
			if (this.root) await this.writeHold();
			else await this.readRootHold();
		});
		this.poll = setInterval(() => void this.tick(), budgetPollMs);
		this.poll.unref?.();
	}
	stop() {
		this.stopped = true;
		if (this.poll) clearInterval(this.poll);
		if (this.pendingWrite) clearTimeout(this.pendingWrite);
		if (this.checkTimer) clearTimeout(this.checkTimer);
		void this.serial(() => this.writeTokens(true));
	}
	/** spec/agents-and-providers#budget-reached: nothing new starts while the task (or the member's root) is held. */
	held() {
		return this.hold !== null;
	}
	/** The gate before anything starts: a member reads its root's hold first, so it never starts on a stale one. */
	async blocks(): Promise<boolean> {
		if (!this.root) await this.serial(() => this.readRootHold());
		else if (this.budget && !this.hold) {
			// A turn's last usage may still wait for its check: check now, so the next turn never starts past the budget.
			if (this.checkTimer) clearTimeout(this.checkTimer);
			this.checkTimer = null;
			await this.serial(() => this.check());
			await this.tail;
		}
		return this.held();
	}
	currentHold() {
		return this.hold;
	}
	/** Called for every journaled record of this task, in order. Never waits on the journal: what it emits goes through `serial`. */
	observe(record: EventRecord) {
		const event = record.event,
			learned = this.tally.learnedShare;
		this.tally = reduceTokenTally(this.tally, event, record.at);
		const share = this.tally.learnedShare,
			provider = this.provider;
		if (share !== null && share !== learned && provider)
			void this.serial(() =>
				writeOpeningShare(this.deps.store.root, provider, share).then(
					() => {},
					() => {}
				)
			);
		if (event.kind === 'budget.reached' || event.kind === 'budget.decided') {
			this.journal = reduceBudgetJournal(this.journal, record);
			void this.serial(() => this.settleHold());
		}
		if (
			event.kind === 'turn.started' ||
			event.kind === 'turn.usage' ||
			event.kind === 'turn.completed' ||
			event.kind === 'session.failed' ||
			event.kind === 'host.stopped'
		)
			void this.serial(() => this.writeTokens(true));
		else if (event.kind === 'usage.changed' || event.kind === 'quota.observed')
			this.scheduleWrite();
		if (this.root && this.budget && (event.kind === 'turn.usage' || event.kind === 'usage.changed'))
			this.scheduleCheck();
	}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result.catch(() => {});
		return result;
	}
	private scheduleWrite() {
		if (this.pendingWrite || this.stopped) return;
		const wait = Math.max(0, this.writtenAt + tokenWriteMs - Date.now());
		this.pendingWrite = setTimeout(() => {
			this.pendingWrite = null;
			void this.serial(() => this.writeTokens(false));
		}, wait);
		this.pendingWrite.unref?.();
	}
	private scheduleCheck() {
		if (this.checkTimer || this.stopped) return;
		const wait = Math.max(0, this.lastCheck + checkMs - Date.now());
		this.checkTimer = setTimeout(() => {
			this.checkTimer = null;
			void this.serial(() => this.check());
		}, wait);
		this.checkTimer.unref?.();
	}
	private async tick() {
		if (this.stopped) return;
		if (this.root) {
			if (this.budget) await this.serial(() => this.check());
		} else if (this.deps.busy() || this.hold) await this.serial(() => this.readRootHold());
	}
	/** spec/agents-and-providers#task-tokens: `force` at turn boundaries; during a turn only when the short number changed. */
	private async writeTokens(force: boolean) {
		const own = ownTokens(this.tally);
		// Nothing counted and nothing on disk: no figure. Something on disk is replaced, even by zero (a cancelled first turn's estimate).
		if (!hasTokens(own) && !this.written) return;
		const text = JSON.stringify(own),
			short = `${formatTokenCount(own.input + own.cacheWrite + own.output + own.estimate)}:${own.running}`;
		if (text === this.written) return;
		// Between short-number changes, other parts (cache reads, account readings) ride along at most every 30 s.
		if (!force && short === this.writtenShort && Date.now() - this.writtenAt < tokenWriteMs * 10)
			return;
		await this.deps.store.updateTask(this.deps.key, { tokens: own }).then(
			() => {
				this.written = text;
				this.writtenShort = short;
				this.writtenAt = Date.now();
			},
			() => {}
		);
	}
	/** The members' figures from their `task.json`, re-read only when a file's stat changes. */
	private async memberTasks(): Promise<AgentTask[]> {
		const dir = join(this.deps.store.root, 'projects', this.rootKey.projectId, 'tasks');
		let ids: string[];
		try {
			ids = (await readdir(dir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && entry.name !== this.rootKey.id)
				.map((entry) => entry.name);
		} catch {
			return [];
		}
		const next = new Map<string, Stamped>();
		for (const id of ids) {
			try {
				const path = await safePath(dir, id, 'task.json'),
					info = await lstat(path);
				if (!info.isFile() || info.size > 1024 * 1024) continue;
				const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`,
					seen = this.members.get(id);
				if (seen?.stamp === stamp) {
					next.set(id, seen);
					continue;
				}
				const doc: unknown = JSON.parse(await readFile(path, 'utf8')),
					task = isRecord(doc) && isAgentTask(doc.task) && doc.task.id === id ? doc.task : null;
				next.set(id, { stamp, task });
			} catch {
				/* An unreadable member counts nothing. */
			}
		}
		this.members = next;
		return [...next.values()].flatMap((entry) =>
			entry.task?.crewTaskId === this.rootKey.id ? [entry.task] : []
		);
	}
	/** spec/agents-and-providers#task-tokens: the root's own figure from memory, its members' from disk. */
	async sum(): Promise<TaskTokenSum> {
		const own = ownTokens(this.tally);
		return sumTokens([
			this.provider
				? memberTokens({ id: this.deps.key.id, provider: this.provider, tokens: own })
				: null,
			...(await this.memberTasks()).map(memberTokens),
		]);
	}
	/** spec/agents-and-providers#budget-reached: ask once when a provider's count reaches its budget. */
	private async check() {
		this.lastCheck = Date.now();
		if (!this.root || !this.budget || this.stopped) return;
		const ask = budgetToAsk(await this.sum(), this.budget, this.journal);
		if (!ask) return;
		await this.deps.emit({
			kind: 'budget.reached',
			id: randomUUID(),
			provider: ask.provider,
			tokens: ask.tokens,
			budget: ask.budget,
			estimated: ask.estimated,
		});
	}
	private async writeHold() {
		const current = (await this.deps.store.task(this.deps.key)).tokenHold ?? null;
		if (JSON.stringify(current) !== JSON.stringify(this.hold))
			await this.deps.store.updateTask(this.deps.key, { tokenHold: this.hold });
	}
	/** The root: the hold follows the journal and the budget; a lifted hold resumes what waited. */
	private async settleHold() {
		const before = this.hold;
		this.hold = tokenHold(this.journal, this.budget);
		await this.writeHold();
		if (before && !this.hold) this.deps.resume();
	}
	/** A member: the root's hold from its `task.json`. A lifted one resumes; a `stop` cancels the running turn once. */
	private async readRootHold() {
		let hold: TokenHold | null = null;
		try {
			hold = (await this.deps.store.task(this.rootKey)).tokenHold ?? null;
		} catch {
			hold = null;
		}
		const before = this.hold;
		this.hold = hold;
		if (hold?.state === 'stop' && this.stoppedFor !== hold.id) {
			this.stoppedFor = hold.id;
			if (this.deps.busy()) await this.deps.cancel().catch(() => {});
		}
		if (before && !hold) this.deps.resume();
	}
	private async saveBudget(next: TokenBudget | undefined) {
		this.budget = next;
		await this.deps.store.updateTask(this.deps.key, { tokenBudget: next ?? {} });
	}
	/** spec/agents-and-providers#budget-reached: the person's answer to the question. */
	async decide(id: string, decision: BudgetDecision, value?: number) {
		if (!this.root) throw new Error('The budget belongs to the crew’s task');
		await this.serial(async () => {
			const asked = this.journal.pending;
			if (!asked || asked.id !== id) throw new Error('The budget question is no longer open');
			const next = decidedBudget(this.budget, asked, decision, value);
			if (decision === 'raise' || decision === 'unlimited') await this.saveBudget(next);
			await this.deps.emit({
				kind: 'budget.decided',
				id,
				decision,
				...(decision === 'raise' && value !== undefined ? { budget: value } : {}),
			});
		});
		if (decision === 'stop') {
			if (this.deps.busy()) await this.deps.cancel().catch(() => {});
			await this.deps.stopMembers().catch(() => {});
		}
		await this.serial(() => this.check());
	}
	/** spec/agents-and-providers#task-budget: `Task usage` changed this task's budget for one provider; it applies at once. */
	async setBudget(provider: AgentProvider, value: number | null) {
		if (!this.root) throw new Error('The budget belongs to the crew’s task');
		await this.serial(async () => {
			const next: TokenBudget = { ...(this.budget ?? {}) };
			if (value === null) delete next[provider];
			else next[provider] = value;
			const budget = Object.keys(next).length ? next : undefined;
			await this.saveBudget(budget);
			const asked = this.journal.pending;
			if (asked?.provider === provider) {
				const sum = await this.sum(),
					tokens = providerTokens(sum, provider),
					answer = popoverAnswer(asked, budget, tokens);
				if (answer)
					await this.deps.emit({
						kind: 'budget.decided',
						id: asked.id,
						decision: answer.decision,
						...(answer.budget !== undefined ? { budget: answer.budget } : {}),
					});
				// A new budget still at or below the count: the question is asked again with its figures, so `Finish` and `Stop` hold at the budget set.
				else if (value !== null && value !== asked.budget)
					await this.deps.emit({
						kind: 'budget.reached',
						id: randomUUID(),
						provider,
						tokens,
						budget: value,
						estimated: sum.providers.find((item) => item.provider === provider)?.estimated ?? false,
					});
			}
			await this.settleHold();
			await this.check();
		});
	}
}
