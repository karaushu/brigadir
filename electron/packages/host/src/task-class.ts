import {
	classBelow,
	hiredPartsBack,
	isTaskClass,
	newestHire,
	owedRaise,
	overSmallTask,
	runningHires,
	smallTaskLimitOf,
	taskClassOf,
	taskClassReasonLimit,
	tripwireArmed,
	type AgentProvider,
	type EventRecord,
	type SessionEvent,
	type SmallTaskLimit,
	type TaskClass,
} from '@brigadir/core';
import { readDocument, safePath } from '@brigadir/persistence';

/** What a host start of a mid-task review carries (spec/reviews#tripwire, spec/reviews#large-review). */
export type ClassReviewStart = {
	point: 'mid';
	startedBy: 'host';
	reason: string;
	threshold?: { files: number; lines: number };
	hired?: boolean;
};
export type TaskClassDeps = {
	records(): readonly EventRecord[];
	emit(event: SessionEvent): Promise<void>;
	/** spec/reviews#classes: a solo task or an Auto agent that writes code; anyone else has no class and no tripwire. */
	eligible: boolean;
	/** The task writes no code: `set_task_class` says so. */
	readOnly: boolean;
	auto: boolean;
	provider: AgentProvider;
	/** spec/reviews#tripwire: the limit as Settings has it now. */
	limit(): Promise<SmallTaskLimit>;
	/** spec/reviews#tripwire: the task's change from its change base, as the tripwire counts it. */
	size(): Promise<{ files: number; lines: number }>;
	/** The review start `request_review` uses; true when it recorded a review (running, or failed for want of a reviewer). */
	start(input: ClassReviewStart): Promise<boolean>;
	stopping(): boolean;
};
/** spec/reviews#tripwire: the limit from `settings.json`; the host reads it at each check, so a change reaches running tasks. */
export async function readSmallTaskLimit(root: string): Promise<SmallTaskLimit> {
	try {
		const doc = await readDocument(await safePath(root, 'settings.json'));
		return smallTaskLimitOf(doc.settings);
	} catch {
		return smallTaskLimitOf(null);
	}
}
/** spec/reviews#classes: one sentence of the session brief (English, rule 12) for the agents that state a class. */
export function classBrief(auto: boolean): string {
	return `Before your first edit, after reading the task and the code it touches, state the task's class once with set_task_class: small — one chain of steps with no contract change; medium — the task comes from a ticket or a contract, or touches the data layer, an API or migrations; large — ${auto ? 'you are going to hire workers for independent parts, or ' : ''}the work comes in layers that other work builds on. Its answer says what the class needs next. Call it again only when the task turns out larger or smaller.`;
}
/** spec/reviews#class-tool: what the class asks of the agent now (English, rule 12). */
export function classNext(
	value: TaskClass,
	options: { provider: AgentProvider; auto: boolean; limit: SmallTaskLimit }
): string {
	if (value === 'small')
		return `Small: do the task from start to end without a plan card. A review runs before the pull request. If the change grows past ${options.limit.files} files or ${options.limit.lines} changed lines, Brigadir starts a mid-task review by itself.`;
	const plan =
		options.provider === 'claude'
			? 'enter plan mode with EnterPlanMode and present the plan with ExitPlanMode; a reviewer checks the plan before the person approves it.'
			: 'write the plan in your reply and end your turn without editing files; start the work when the person answers.';
	const head = `${value === 'medium' ? 'Medium' : 'Large'}: before you edit any file, save the ticket or the contract with save_source if there is one, then present a plan for approval: ${plan}`;
	if (value === 'medium') return head;
	return `${head} After a layer that other work builds on, call request_review.${options.auto ? ' Hire workers only for parts that are independent, with hire_workers; when the hired parts are back, Brigadir starts a mid-task review.' : ''}`;
}
/**
 * spec/reviews#classes: the task's class in its host — the agent's `set_task_class`, the host's raise on a hire, the tripwire on a small task
 * that grows and the mid-task review of a Large task's hired parts. The class lives in the journal, so a restart reads it back.
 */
export class TaskClassLife {
	private tail: Promise<unknown> = Promise.resolve();
	private queued = false;
	/** Checks wait for the review's record: a tripwire before it loads could miss a review that lives. */
	private ready = false;
	/** spec/reviews#large-review: the hires whose hired-parts review this host tried; a refused start is not tried again. */
	private tried = new Set<string>();
	constructor(private deps: TaskClassDeps) {}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	/** spec/reviews#class-tool: `set_task_class(class, reason)`. */
	set(params: unknown) {
		return this.serial(async () => {
			if (this.deps.readOnly) throw new Error('This task changes no code.');
			if (!this.deps.eligible) throw new Error('Method is not available to this role');
			const input = (typeof params === 'object' && params ? params : {}) as Record<string, unknown>;
			const value = input.class,
				reason = typeof input.reason === 'string' ? input.reason.trim() : '';
			if (!isTaskClass(value)) throw new Error('class is one of small, medium, large');
			if (!reason || reason.length > taskClassReasonLimit)
				throw new Error(`reason is one line of 1–${taskClassReasonLimit} characters`);
			const records = this.deps.records(),
				previous = taskClassOf(records);
			if (classBelow(value, 'large') && runningHires(records).length)
				throw new Error('Workers run in this task: it stays Large until they are dismissed.');
			if (previous !== value)
				await this.deps.emit({
					kind: 'task.class',
					class: value,
					reason,
					by: 'agent',
					...(previous ? { previous } : {}),
				});
			return {
				class: value,
				...(previous && previous !== value ? { previous } : {}),
				next: classNext(value, {
					provider: this.deps.provider,
					auto: this.deps.auto,
					limit: await this.deps.limit(),
				}),
			};
		});
	}
	/**
	 * After the host loaded the task's review: what a host that stopped mid-way still owes — the class raise of a tripwire or a hire, the
	 * hired-parts review — then the first tripwire check.
	 */
	start() {
		if (!this.deps.eligible) return Promise.resolve();
		this.ready = true;
		return this.serial(async () => {
			const owed = owedRaise(this.deps.records());
			if (owed && (owed.cause === 'threshold' || this.deps.auto)) await this.deps.emit(owed);
		}).then(async () => {
			if (this.deps.auto) await this.dismissed();
			await this.checkpoint();
		});
	}
	/** After each new checkpoint of the agent's work: the tripwire. Checks coalesce — one waits behind the running one. */
	checkpoint() {
		if (!this.deps.eligible || !this.ready || this.queued || !tripwireArmed(this.deps.records()))
			return Promise.resolve();
		this.queued = true;
		return this.serial(async () => {
			this.queued = false;
			await this.trip();
		});
	}
	/** spec/reviews#tripwire: a Small task (or one with no class) past the limit — the host starts a mid-task review, once per task. */
	private async trip() {
		const records = this.deps.records();
		if (this.deps.stopping() || !tripwireArmed(records)) return;
		const [limit, size] = await Promise.all([this.deps.limit(), this.deps.size()]);
		if (!overSmallTask(size, limit)) return;
		const previous = taskClassOf(records);
		// A refused start (a review lives, nothing changed since the last one) leaves the tripwire armed for the next checkpoint.
		if (!(await this.deps.start({ point: 'mid', startedBy: 'host', reason: '', threshold: size })))
			return;
		await this.deps.emit({
			kind: 'task.class',
			class: 'medium',
			reason: '',
			by: 'host',
			...(previous ? { previous } : {}),
			cause: 'threshold',
			files: size.files,
			lines: size.lines,
		});
	}
	/** spec/reviews#class-raise: an approved hire that started a worker makes the task Large. */
	hired() {
		if (!this.deps.eligible || !this.deps.auto) return Promise.resolve();
		return this.serial(async () => {
			const previous = taskClassOf(this.deps.records());
			if (previous === 'large') return;
			await this.deps.emit({
				kind: 'task.class',
				class: 'large',
				reason: '',
				by: 'host',
				...(previous ? { previous } : {}),
				cause: 'hire',
			});
		});
	}
	/** spec/reviews#large-review: a worker was dismissed — when the hired parts are back, the host starts a mid-task review once for that hire. */
	dismissed() {
		if (!this.deps.eligible || !this.deps.auto) return Promise.resolve();
		return this.serial(async () => {
			const records = this.deps.records();
			const hire = newestHire(records);
			if (
				!this.ready ||
				this.deps.stopping() ||
				!hire ||
				hire.event.kind !== 'crew.hire.resolved' ||
				this.tried.has(hire.event.id) ||
				taskClassOf(records) !== 'large' ||
				!hiredPartsBack(records)
			)
				return;
			this.tried.add(hire.event.id);
			await this.deps.start({ point: 'mid', startedBy: 'host', reason: '', hired: true });
		});
	}
}
