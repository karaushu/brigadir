import { createHash, randomUUID } from 'node:crypto';
import { diffLines, unifiedDiff } from '@brigadir/diff';
import {
	authorFindings,
	openPlanFindings,
	parsePlanVerdict,
	planFindingsText,
	planFindingState,
	planReadLimit,
	planReviewItemLimit,
	planFindingStoreLimit,
	taskReviewDocumentBytes,
	emptyTaskReviewDocument,
	readTaskReviewDocument,
	reviewLoop,
	reviewPointPrompt,
	taskReviewLive,
	taskReviewReasonLimit,
	taskReviewSummaryLimit,
	withNextReview,
	type EventRecord,
	type CrewSpec,
	type ReviewBatch,
	type ReviewLoopEvent,
	type ReviewPoint,
	type ReviewRun,
	type SessionCommand,
	type SessionEvent,
	type TaskKey,
	type TaskReview,
	type TaskReviewDocument,
	type TaskReviewStarter,
	type TaskReviewTree,
	type PlanFinding,
} from '@brigadir/core';
import { readSnapshots } from '@brigadir/git';
import { atomicJson, readDocument, safePath, type SessionStore } from '@brigadir/persistence';
import type { CrewHost, SelfReviewHooks } from './crew';
import {
	acceptFindings,
	findingBatch,
	findingCounts,
	findingsText,
	openFindings,
	reviewFindings,
} from './review-findings';
import { readSourcesForReview } from './task-sources';

/** spec/reviews#plan-review: a plan presented for approval — a solo task's plan for approval or the root foreman's split. */
export type PresentedPlan = {
	kind: 'approval' | 'split';
	id: string;
	revision: number;
	text: string;
};
const cut = (value: string) =>
	value.length > planReadLimit
		? `${value.slice(0, planReadLimit - 80)}\n\n[The plan is cut here at ${planReadLimit} characters.]`
		: value;

export type StartReview = Extract<SessionCommand, { kind: 'startReview' }>;
/** spec/reviews#tripwire, spec/reviews#large-review: what a host start of a mid-task review carries into its `task-review.started`. */
export type ReviewTrigger = { threshold?: { files: number; lines: number }; hired?: boolean };
type ReviewRequest = {
	point: ReviewPoint;
	startedBy: TaskReviewStarter;
	reason: string;
} & ReviewTrigger;
/** spec/reviews#points: the roles whose task has reviews of its own — a solo task, a foreman, a crew developer (its part is a task). */
const ownReviewRoles: readonly (string | null)[] = [null, 'foreman', 'developer'];
/** spec/reviews#request-tool: `request_review` and `review_reply` belong to a task with reviews of its own. */
export const ownReviewTool = (role: string | null, method: string) =>
	(method === 'request_review' || method === 'review_reply') && ownReviewRoles.includes(role);
/** The review crew a host restores at start: a solo task's or a developer's own (a foreman keeps its reviewers in its crew). */
export function ownReviewCrew(
	task: { reviewCrew?: CrewSpec },
	role: string | null
): CrewSpec | null {
	return task.reviewCrew && (role === null || role === 'developer') ? task.reviewCrew : null;
}
/** What the crew host offers the task's review: its rounds on the task itself (`checkSelf`), the agent's replies and the stop. */
export type SelfReviewHost = Pick<CrewHost, 'checkSelf' | 'replySelf' | 'stopSelf' | 'selfTrees'>;
export type TaskReviewDeps = {
	store: SessionStore;
	key: TaskKey;
	emit(event: SessionEvent): Promise<void>;
	records(): readonly EventRecord[];
	/** A turn of the task's agent runs now. */
	busy(): boolean;
	/** The crew host of the task with the reviewers as the root's checkers: created for a solo task, extended for a foreman. */
	crew(start: StartReview): Promise<SelfReviewHost>;
	/** The crew host that already runs the task's review after a restart, if any. */
	existing(): SelfReviewHost | null;
	/** A foreman's crew has no open work: the fixes it handed to workers are accepted (spec/reviews#loop). */
	settled(): boolean;
	/** A batch of findings as the task's own review batch (the `submitReview` command). */
	submitReview(text: string, review: ReviewBatch, round: number): Promise<void>;
	/** spec/reviews#who: the reviewer of a start the host or the agent makes — asked of the app, else a fresh session of the task's own provider.
	 *  `auto`: the host starts a plan review by itself; `{off: true}` — `Plan review` is `Off`. */
	resolve(
		point: ReviewPoint,
		auto?: boolean
	): Promise<StartReview | { failure: string } | { off: true }>;
	/** spec/reviews#plan-review: the plan that waits for the person now, if any. */
	planWaiting(): PresentedPlan | null;
	/** spec/reviews#plan-loop: findings to the plan's author — the waiting plan is answered (its reject option, or `propose_plan` returns
	 *  them), then the batch runs. The same batch twice only answers the waiting plan again. */
	planFeedback(
		text: string,
		batch: ReviewBatch,
		round: number
	): Promise<'answered' | 'queued' | 'dropped'>;
	/** spec/reviews#plan-loop: an approval ended the review — a batch still in the author's queue is taken out. */
	dropBatch(batch: string): Promise<void>;
	/** The task's changed files from its start. */
	changes(): Promise<number>;
	/** A snapshot of the task's files now: a review the agent asks for reads its state at the call. */
	checkpoint(): Promise<void>;
	/** A service prompt to the task's agent (spec/reviews#loop: a mid-task review that ended while the agent waits). */
	prompt(text: string): Promise<void>;
	/** The task's prompt and, for a crew worker, its part: what every reviewer reads (spec/reviews#reviewer-sessions). */
	brief(): Promise<string>;
	/** spec/reviews#points: a crew worker's part number. */
	part(): Promise<number | null>;
	/** A task in a crew of its own: its closure check starts only when its tree changed, since it hands fixes to workers. */
	foreman: boolean;
};
/**
 * spec/reviews#loop: the task side of its reviews — the agent's proposal, the review the person, the agent or the host started, and where it is
 * in the loop of one read, one fix, one closure check and the person. The rounds themselves are the crew host's check edge on the task
 * (`CrewHost.checkSelf`), which calls back through `hooks()`.
 */
export class TaskReviewLife {
	private doc: TaskReviewDocument = emptyTaskReviewDocument;
	private host: SelfReviewHost | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private deps: TaskReviewDeps) {}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	private async file() {
		return safePath(await this.deps.store.taskDir(this.deps.key), 'task-review.json');
	}
	private async save() {
		await atomicJson(await this.file(), this.doc);
	}
	async load() {
		try {
			// spec/reviews#data: version 1 reads as a review before the PR; it is written back as version 2.
			const value = await readDocument(await this.file(), taskReviewDocumentBytes, [1, 2]);
			this.doc = readTaskReviewDocument(value, this.deps.key.id) ?? emptyTaskReviewDocument;
		} catch (error) {
			if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
		}
		this.host = this.deps.existing();
		// spec/reviews#data: a version-1 review read while the agent fixed has no batch id; the journal holds the batch it was sent.
		const review = this.doc.review;
		if (review?.state === 'fixing' && !review.batch) {
			const batch = lastReviewBatch(this.deps.records());
			if (batch) this.doc = { ...this.doc, review: { ...review, batch } };
		}
	}
	document(): TaskReviewDocument {
		return this.doc;
	}
	private review(): TaskReview | null {
		return this.doc.review;
	}
	private async update(patch: Partial<TaskReview>) {
		const review = this.doc.review;
		if (!review) return;
		this.doc = { ...this.doc, review: { ...review, ...patch } };
		await this.save();
	}
	/** One step of the loop; false when the review's state does not take the event (a late verdict, a second decision). */
	private async step(event: ReviewLoopEvent) {
		const review = this.doc.review;
		const next = review && reviewLoop(review.state, event);
		if (!review || !next) return null;
		await this.update({
			state: next.state,
			...(next.action === 'finish' ? { finishedAt: new Date().toISOString() } : {}),
		});
		return next;
	}
	/** spec/reviews#start: `propose_review` — the proposal waits for the person; a new one replaces it. */
	propose(summary: string) {
		return this.serial(async () => {
			if (taskReviewLive(this.doc.review))
				throw new Error('A review of this task is already running.');
			const text = summary.trim().slice(0, taskReviewSummaryLimit);
			this.doc = { ...this.doc, proposal: { summary: text, at: new Date().toISOString() } };
			await this.save();
			await this.deps.emit({ kind: 'review.proposed', summary: text });
			return { proposed: true };
		});
	}
	dismiss() {
		return this.serial(async () => {
			if (!this.doc.proposal) return;
			this.doc = { ...this.doc, proposal: null };
			await this.save();
			await this.deps.emit({ kind: 'review.dismissed' });
		});
	}
	/** spec/reviews#start: a review the person or the host started with resolved reviewers; a start without reviewers records why it did not. */
	start(command: StartReview) {
		return this.serial(() => this.begin(command));
	}
	/** `trigger`: spec/reviews#tripwire, spec/reviews#large-review — why the host started a mid-task review, for its chat row. */
	private async begin(command: StartReview, trigger: ReviewTrigger = {}) {
		if (taskReviewLive(this.doc.review))
			throw new Error('A review of this task is already running.');
		// spec/reviews#plan-start: a plan review reads the plan that waits for the person.
		const presented = command.point === 'plan' ? this.deps.planWaiting() : null;
		if (command.point === 'plan' && !presented && !command.failure)
			throw new Error('No plan waits for approval.');
		const point = command.point ?? 'pre-pr',
			startedBy = command.startedBy ?? 'person',
			id = randomUUID(),
			previous = this.doc.review,
			base =
				command.since === 'last' && previous?.trees.length && previous.point === point
					? previous.trees
					: undefined,
			part = await this.deps.part();
		const review: TaskReview = {
			id,
			point,
			target: { taskId: this.deps.key.id, ...(part ? { part } : {}) },
			startedBy,
			...(command.reason ? { reason: command.reason.slice(0, taskReviewReasonLimit) } : {}),
			who: command.who,
			...(command.reviewer ? { reviewer: command.reviewer } : {}),
			instructions: command.instructions,
			guidance: command.guidance,
			startedAt: new Date().toISOString(),
			state: 'waiting',
			round: 0,
			passes: 0,
			reviewers: command.reviewers.map((agent) => agent.name),
			trees: [],
			...(base ? { base } : {}),
			...(presented
				? {
						plan: {
							kind: presented.kind,
							id: presented.id,
							revision: presented.revision,
							text: cut(presented.text),
							read: presented.revision,
							seen: presented.revision,
						},
						findings: [],
					}
				: {}),
		};
		if (command.failure || !command.reviewers.length) {
			// spec/reviews#who: nobody can review; the strip says `Review did not start`.
			const failure = command.failure ?? 'No reviewer is available.';
			this.doc = withNextReview(this.doc, {
				...review,
				state: 'failed',
				failure,
				finishedAt: review.startedAt,
			});
			await this.save();
			await this.emitStarted(this.doc.review!, trigger);
			await this.deps.emit({
				kind: 'task-review.finished',
				id,
				point,
				state: 'failed',
				failure,
			});
			return review;
		}
		this.host = await this.deps.crew(command);
		this.doc = withNextReview(this.doc, review);
		await this.save();
		await this.emitStarted(review, trigger);
		// spec/reviews#start: a mid-task review — the agent's or the host's — reads at once (`request` took a checkpoint); the others wait for a
		// running turn to end. A plan review reads at once: the agent's turn waits for the plan's answer.
		if (point === 'plan' || point === 'mid' || !this.deps.busy()) await this.read();
		return review;
	}
	private emitStarted(review: TaskReview, trigger: ReviewTrigger = {}) {
		return this.deps.emit({
			kind: 'task-review.started',
			id: review.id,
			point: review.point,
			startedBy: review.startedBy,
			reviewers: review.reviewers,
			...(review.reason ? { reason: review.reason } : {}),
			...(trigger.threshold ? { threshold: trigger.threshold } : {}),
			...(trigger.hired ? { hired: true } : {}),
		});
	}
	/**
	 * spec/reviews#request-tool: the agent, or the host (the tripwire, a Large task's hired parts), asks for a review; the host decides — refuses while one lives or when nothing
	 * changed, resolves the reviewer, records a review that could not start, else starts it.
	 */
	request(input: ReviewRequest) {
		return this.serial(async () => (await this.ask(input)).answer);
	}
	/** spec/reviews#tripwire, spec/reviews#large-review: the host's own start — true only when this call recorded a review (running, or failed
	 *  for want of a reviewer), decided inside the serial step so a review another caller started meanwhile never counts. */
	requestByHost(input: ReviewRequest & { startedBy: 'host' }) {
		return this.serial(async () => (await this.ask(input)).recorded);
	}
	private async ask(input: ReviewRequest): Promise<{
		answer: { started: boolean; reviewer?: string; reason?: string };
		recorded: boolean;
	}> {
		const refuse = (reason: string) => ({ answer: { started: false, reason }, recorded: false });
		{
			if (taskReviewLive(this.doc.review))
				return refuse('A review of this task is already running.');
			// The agent may have written through its own shell since the last checkpoint: look at the files now.
			await this.deps.checkpoint().catch(() => {});
			if (!(await this.deps.changes()) || !(await this.changedSinceLast()))
				return refuse('Nothing changed since the last review.');
			const resolved = await this.deps.resolve(input.point);
			if ('off' in resolved) return refuse('Reviews are off.');
			const command: StartReview =
				'failure' in resolved
					? {
							kind: 'startReview',
							reviewers: [],
							who: { kind: 'agent' },
							instructions: '',
							guidance: '',
							failure: resolved.failure,
						}
					: resolved;
			const review = await this.begin(
				{
					...command,
					point: input.point,
					startedBy: input.startedBy,
					reason: input.reason.trim(),
				},
				{
					...(input.threshold ? { threshold: input.threshold } : {}),
					...(input.hired ? { hired: true } : {}),
				}
			);
			return {
				answer:
					review.reviewers.length && !('failure' in resolved)
						? { started: true, reviewer: review.reviewers.join(', ') }
						: { started: false, reason: 'failure' in resolved ? resolved.failure : '' },
				recorded: true,
			};
		}
	}
	/** The task's trees differ from every tree an earlier review read: something is left to review. */
	private async changedSinceLast() {
		const reviews = [...this.doc.past, ...(this.doc.review ? [this.doc.review] : [])].filter(
			(item) => item.trees.length
		);
		const last = reviews.at(-1);
		if (!last) return true;
		return this.differs(last.trees);
	}
	private async currentTrees(): Promise<TaskReviewTree[]> {
		if (this.host) return this.host.selfTrees();
		const snapshots = await readSnapshots(this.deps.store, this.deps.key).catch(() => null);
		return (snapshots?.checkpoints.at(-1)?.trees ?? []).map((tree) => ({
			scopeId: tree.scopeId,
			tree: tree.tree,
		}));
	}
	private async differs(trees: readonly TaskReviewTree[]) {
		if (!trees.length) return false;
		const now = await this.currentTrees();
		return trees.some(
			(tree) => now.find((item) => item.scopeId === tree.scopeId)?.tree !== tree.tree
		);
	}
	/** spec/reviews#loop: the agent's `review_reply` — it objects to a finding with a reason, in its thread. */
	reply(commentId: string, text: string) {
		return this.serial(async () => {
			const review = this.doc.review;
			if (!review || !this.host) throw new Error('This task has no review.');
			if (review.point === 'plan') {
				// spec/reviews#plan-loop: the author objects to a plan finding; the closure check reads the objection.
				const own = authorFindings(review.findings);
				if (!own.some((item) => item.id === commentId))
					throw new Error(
						`No finding ${commentId} in the plan review. Findings: ${own.map((item) => item.id).join(', ') || 'none'}`
					);
				if (!text.trim() || text.length > 10_000) throw new Error('A reply needs text');
				await this.update({
					findings: (review.findings ?? []).map((item) =>
						item.id === commentId ? { ...item, answer: text.trim() } : item
					),
				});
				await this.deps.emit({ kind: 'review.replied', commentId });
				return { replied: true };
			}
			await this.host.replySelf(commentId, text, Math.max(1, review.round));
			await this.deps.emit({ kind: 'review.replied', commentId });
			return { replied: true };
		});
	}
	stop() {
		return this.serial(async () => {
			const review = this.doc.review;
			if (!review || !taskReviewLive(review)) return;
			await this.host?.stopSelf();
			if (await this.step({ kind: 'stop' })) await this.finished('stopped');
		});
	}
	/** spec/reviews#loop: the person's answer to the open findings — `Fix {n}` sends them to the agent once more, `Accept` ends the review. */
	decide(decision: 'fix' | 'accept') {
		return this.serial(async () => {
			const review = this.doc.review;
			if (!review || review.state !== 'yours') throw new Error('No review waits for your call.');
			if (review.point === 'plan') return this.decidePlan(review, decision);
			const open = openFindings(await reviewFindings(this.deps.store, this.deps.key, review.id));
			await this.deps.emit({
				kind: 'task-review.decided',
				id: review.id,
				point: review.point,
				decision,
				findings: open.length,
			});
			if (decision === 'accept') {
				await acceptFindings(
					this.deps.store,
					this.deps.key,
					open.map((item) => item.id)
				);
				await this.step({ kind: 'decided', decision });
				await this.finished('accepted');
				if (review.point === 'mid' && !this.deps.busy())
					await this.deps
						.prompt(
							'The person accepted the open findings of the mid-task review as they are. Continue the task.'
						)
						.catch(() => {});
				return;
			}
			await this.step({ kind: 'decided', decision });
			const names = [...new Set(open.map((item) => item.review?.reviewer ?? ''))].join(', '),
				pass = review.passes + 1,
				batch = findingBatch(`${review.id}/${pass}`, open);
			await this.update({ passes: pass, batch: batch.id });
			await this.deps.submitReview(
				`The person asks you to fix ${open.length} ${open.length === 1 ? 'finding' : 'findings'} of the ${reviewPointPrompt[review.point]} that ${open.length === 1 ? 'is' : 'are'} still open. Fix each one, or object to it with review_reply(commentId, reason); ${names} then ${open.length === 1 ? 'checks' : 'check'} only whether each finding is closed.\n\n${findingsText(open, true)}`,
				batch,
				Math.max(1, review.round)
			);
		});
	}
	/**
	 * spec/reviews#loop: after a turn of the task's agent — the waiting review starts, the answered batch opens the closure check, and a later
	 * change makes a passed review before the PR outdated.
	 */
	turnEnded() {
		return this.serial(async () => {
			const review = this.doc.review;
			if (!review) return;
			if (review.state === 'waiting') return this.read();
			if (!this.host) return;
			if (review.point === 'plan') {
				// spec/reviews#plan-loop: the author's turn ended without presenting the plan again — the closure check reads the plan as it was.
				if (review.state === 'fixing' && this.planAnswered(review) && !this.deps.planWaiting())
					await this.planClosure();
				return;
			}
			if (
				(review.state === 'passed' || review.state === 'accepted') &&
				review.point === 'pre-pr' &&
				(await this.differs(review.trees))
			) {
				if (await this.step({ kind: 'changed' })) await this.finished('outdated');
				return;
			}
			if (review.state !== 'fixing') return;
			// spec/reviews#loop: the turn that took the batch has ended. A foreman hands fixes to its workers: its closure check waits until
			// they are accepted (an objection without edits leaves nothing open, so it runs at once).
			if (!this.taken(review.batch) || (this.deps.foreman && !this.deps.settled())) return;
			const list = await reviewFindings(this.deps.store, this.deps.key, review.id),
				sent = review.passes > 1 ? openFindings(list) : list,
				counts = findingCounts(sent);
			await this.deps.emit({
				kind: 'task-review.answered',
				id: review.id,
				point: review.point,
				fixed: sent.length - counts.answered,
				answered: counts.answered,
			});
			if (await this.step({ kind: 'answered' })) await this.round();
		});
	}
	/** A turn took the last batch; this runs when a turn ends, so that turn or a later one has ended. */
	private taken(batch: string | undefined) {
		if (!batch) return false;
		return this.deps
			.records()
			.some((record) => record.event.kind === 'turn.started' && record.event.review?.id === batch);
	}
	private async read() {
		if (await this.step({ kind: 'begin' })) await this.round();
	}
	private async round() {
		// spec/reviews#plan-loop: the round reads the plan presented last; a closure check's diff starts from what the previous round read.
		const review = this.doc.review;
		if (review?.plan) {
			const plan = review.plan;
			await this.update({
				plan: {
					...plan,
					...(review.round >= 1 ? { base: plan.seen, baseText: plan.seenText ?? plan.text } : {}),
					seen: plan.revision,
					seenText: plan.text,
				},
			});
		}
		const task = await this.deps.store.task(this.deps.key);
		const seq = this.deps.records().at(-1)?.seq ?? 0;
		await this.host!.checkSelf(seq, task.title);
	}
	private async finished(
		state: 'passed' | 'accepted' | 'stopped' | 'outdated',
		approval?: { open: number }
	) {
		const review = this.doc.review;
		if (!review) return;
		await this.deps.emit({
			kind: 'task-review.finished',
			id: review.id,
			point: review.point,
			state,
			...(approval ? { approval: true, open: approval.open } : {}),
		});
	}
	// ── the plan review (spec/reviews#plan-review) ─────────────────────────────

	/** The last plan review of the task: the current review, else the newest earlier one. */
	private lastPlanReview(): TaskReview | null {
		if (this.doc.review?.point === 'plan') return this.doc.review;
		return this.doc.past.findLast((review) => review.point === 'plan') ?? null;
	}
	/**
	 * spec/reviews#plan-start: a plan was presented — a new plan gets one full read when `Plan review` is on and no other review lives; a revision
	 * of a plan under review is the author's answer (closure check) or, while the person decides, a revision whose open findings get checked.
	 */
	planPresented(presented: PresentedPlan) {
		return this.serial(async () => {
			const review = this.doc.review;
			if (review?.point === 'plan' && taskReviewLive(review) && review.plan) {
				await this.update({
					plan: {
						...review.plan,
						kind: presented.kind,
						id: presented.id,
						revision: presented.revision,
						text: cut(presented.text),
					},
				});
				if (review.state === 'fixing') {
					// The batch still waits behind this plan (it was presented before the author's turn took the findings): answer it again.
					if (!this.planAnswered(review, true)) return this.redeliver();
					return this.planClosure();
				}
				if (review.state === 'yours' && (await this.step({ kind: 'revised' }))) {
					await this.deps.emit({
						kind: 'task-review.answered',
						id: review.id,
						point: review.point,
						fixed: openPlanFindings(review.findings).length,
						answered: 0,
					});
					await this.round();
				}
				return;
			}
			if (taskReviewLive(review)) return;
			const last = this.lastPlanReview();
			if (last && !last.plan?.approved) return;
			const resolved = await this.deps.resolve('plan', true);
			if ('off' in resolved) return;
			await this.begin(
				'failure' in resolved
					? {
							kind: 'startReview',
							reviewers: [],
							who: { kind: 'agent' },
							instructions: '',
							guidance: '',
							point: 'plan',
							startedBy: 'host',
							failure: resolved.failure,
						}
					: { ...resolved, point: 'plan', startedBy: 'host' }
			);
		});
	}
	/**
	 * spec/reviews#plan-loop: the person answered the plan. An approval ends a live plan review — the open round is cancelled and the findings
	 * still open are recorded as accepted — and marks the plan approved, so the next presentation is a new plan. A rejection changes nothing.
	 */
	planDecided(approved: boolean) {
		return this.serial(async () => {
			if (!approved) return;
			const review = this.doc.review;
			if (review?.point === 'plan' && taskReviewLive(review)) {
				const open = authorFindings(review.findings).filter((item) =>
					['sent', 'open', 'new'].includes(planFindingState(item))
				);
				await this.host?.stopSelf().catch(() => {});
				// A batch still in the author's queue would send the author back to a plan the person approved.
				if (review.batch) await this.deps.dropBatch(review.batch).catch(() => {});
				const state = open.length ? 'accepted' : 'stopped';
				await this.update({
					state,
					finishedAt: new Date().toISOString(),
					findings: (review.findings ?? []).map((item) =>
						open.includes(item) ? { ...item, accepted: true } : item
					),
					...(review.plan ? { plan: { ...review.plan, approved: true } } : {}),
				});
				await this.finished(state, { open: open.length });
				return;
			}
			const last = this.lastPlanReview();
			if (!last?.plan || last.plan.approved) return;
			const mark = (item: TaskReview) =>
				item === last ? { ...item, plan: { ...item.plan!, approved: true } } : item;
			this.doc = {
				...this.doc,
				review: this.doc.review && mark(this.doc.review),
				past: this.doc.past.map(mark),
			};
			await this.save();
		});
	}
	/** The author has taken the last batch: a solo task's batch turn started; a foreman got it as its `propose_plan` result. `presenting`: a
	 *  plan is being presented now, which for a foreman is its answer. */
	private planAnswered(review: TaskReview, presenting = false) {
		if (review.plan?.kind === 'split' && !review.plan.queued) {
			const sent = review.plan.sentAt;
			if (sent === undefined) return false;
			return (
				presenting ||
				this.deps
					.records()
					.some((record) => record.seq > sent && record.event.kind === 'turn.completed')
			);
		}
		return this.taken(review.batch);
	}
	/** spec/reviews#plan-loop: the author answered — the closure check reads the revision against the one the reviewer read. */
	private async planClosure() {
		const review = this.doc.review;
		if (!review) return;
		const sent =
			review.passes > 1 ? openPlanFindings(review.findings) : authorFindings(review.findings);
		const answered = sent.filter((item) => item.answer).length;
		await this.deps.emit({
			kind: 'task-review.answered',
			id: review.id,
			point: review.point,
			fixed: sent.length - answered,
			answered,
		});
		if (await this.step({ kind: 'answered' })) await this.round();
	}
	/** The batch of one author pass: the first pass takes every finding for the author, a `Fix {n}` pass the ones still open. */
	private planBatch(review: TaskReview, pass: number, person: boolean) {
		const list = pass > 1 ? openPlanFindings(review.findings) : authorFindings(review.findings),
			ids = list.map((item) => ({ id: item.id, version: 1 })),
			names = [...new Set(list.map((item) => item.reviewer))].join(', '),
			n = list.length,
			findings = `${n} ${n === 1 ? 'finding' : 'findings'}`,
			again =
				review.plan?.kind === 'split'
					? 'then call propose_plan again with the revised split, unchanged if you object to every finding'
					: 'then present the plan for approval again with ExitPlanMode, unchanged if you object to every finding',
			checks = `${names} then ${names.includes(',') ? 'check' : 'checks'} only whether each finding is closed.`;
		const text = person
			? `The person asks you to fix ${findings} of the plan review that ${n === 1 ? 'is' : 'are'} still open. Revise the plan: fix each one in the plan, or object to it with review_reply(commentId, reason) where commentId is the finding's id; ${again}. ${checks}\n\n${planFindingsText(list, true)}`
			: `${names} left ${findings} in the plan review. Revise the plan once: fix each finding in the plan, or object to it with review_reply(commentId, reason) where commentId is the finding's id; ${again}. ${checks}\n\n${planFindingsText(list)}`;
		return {
			text,
			batch: {
				id: createHash('sha256')
					.update(`${review.id}/${pass}\0${JSON.stringify(ids)}`)
					.digest('hex'),
				comments: ids,
			},
		};
	}
	private async deliverPlan(person: boolean) {
		const review = this.doc.review;
		if (!review?.plan) return;
		const pass = review.passes + 1,
			{ text, batch } = this.planBatch(review, pass, person);
		await this.update({
			passes: pass,
			batch: batch.id,
			plan: { ...review.plan, sentAt: this.deps.records().at(-1)?.seq ?? 0 },
		});
		await this.sendPlan(text, batch, review.round);
	}
	/**
	 * spec/reviews#plan-loop: the batch reaches the author — as the answer to the waiting plan, or queued when none waits. An approval that ended
	 * the review meanwhile drops it (the host checks again right before sending).
	 */
	private async sendPlan(text: string, batch: ReviewBatch, round: number) {
		const how = await this.deps.planFeedback(text, batch, Math.max(1, round));
		const review = this.doc.review;
		if (how === 'dropped' || !review?.plan || review.batch !== batch.id) return;
		// The waiting plan took the batch after it was queued: the queued copy goes, so the author reads it once.
		if (how === 'answered' && review.plan.queued)
			await this.deps.dropBatch(batch.id).catch(() => {});
		await this.update({ plan: { ...review.plan, queued: how === 'queued' } });
	}
	/** The batch the author may still get: the plan review is with the author and this is its last batch. */
	planBatchLive(batch: string) {
		const review = this.doc.review;
		return review?.point === 'plan' && review.state === 'fixing' && review.batch === batch;
	}
	/** The batch waits behind a plan presented before the author took it: answer that plan so the batch runs. */
	private async redeliver() {
		const review = this.doc.review;
		if (!review?.plan || !review.passes) return;
		const { text, batch } = this.planBatch(review, review.passes, review.passes > 1);
		await this.sendPlan(text, batch, review.round);
	}
	private async decidePlan(review: TaskReview, decision: 'fix' | 'accept') {
		const open = openPlanFindings(review.findings);
		await this.deps.emit({
			kind: 'task-review.decided',
			id: review.id,
			point: review.point,
			decision,
			findings: open.length,
		});
		if (decision === 'accept') {
			await this.update({
				findings: (review.findings ?? []).map((item) =>
					open.includes(item) ? { ...item, accepted: true } : item
				),
			});
			await this.step({ kind: 'decided', decision });
			await this.finished('accepted');
			return;
		}
		await this.step({ kind: 'decided', decision });
		await this.deliverPlan(true);
	}
	/** spec/reviews#plan-inputs: `read_plan` — the revision the round reads, and in a closure check the diff from the previous round's. */
	private async planRead(round: number) {
		const plan = this.doc.review?.plan;
		if (!plan) throw new Error('This review has no plan.');
		const text = plan.seenText ?? plan.text;
		const closure =
			round > 1 && plan.base !== undefined
				? {
						read: plan.read,
						previous: plan.base,
						diff:
							plan.base === plan.seen && (plan.baseText ?? '') === text
								? 'The plan did not change since your last read.'
								: unifiedDiff(diffLines(plan.baseText ?? '', text).lines, 3, planReadLimit).text,
					}
				: {};
		return {
			kind: plan.kind === 'split' ? 'the foreman’s split' : 'plan for approval',
			revision: plan.seen,
			text,
			...closure,
		};
	}
	/**
	 * spec/reviews#plan-loop, spec/reviews#plan-split: the reviewer's prompt (English, rule 12) — the first read with the verdict's shape and, for a
	 * foreman's split, the split checks; a closure check with this reviewer's findings and the author's objections.
	 */
	private async planPrompt(taskId: string, reviewId: string, round: number, reviewer: string) {
		const review = this.doc.review,
			plan = review?.plan,
			brief = await this.deps.brief().catch(() => ''),
			guidance = review?.guidance ?? '',
			what = plan?.kind === 'split' ? "the foreman's split of task" : 'the plan of task';
		if (round <= 1)
			return `Check ${what} ${taskId} (reviewId ${reviewId}, plan review, first read).${brief}\nThe plan waits for the person's approval; nothing is built yet. Read it with read_plan(taskId, reviewId) and the sources its author saved (the ticket, a spec, an API contract) with read_sources(taskId, reviewId). The files of your tree are the repo as the task has it now: read the code the plan relies on. Read once and in full: this is the only read, nothing new can be raised later.\nAnswer with one call submit_plan_review(taskId, reviewId, findings, gaps), at most ${planReviewItemLimit} items in all, the most severe first:\n- findings of the plan against the ticket: kind missed (a requirement the plan misses), contradicts (the plan contradicts the ticket or the contract), out-of-scope (the plan does what the ticket does not ask);\n- findings of the plan against the repo and the contract: kind assumption (a wrong assumption about existing code), left-open (a decision left open that will produce defects: concurrency, failures and retries, data loss, empty and error states, how many requests a screen fires), unverifiable (a check that cannot be verified as written);${plan?.kind === 'split' ? '\n- findings of the split itself, kind split: parts that are not independent, a part that depends on files of another part while both run in parallel, an executor that does not fit its part (its role, provider or model);' : ''}\n- gaps: what the ticket itself leaves open — questions for the person, not for the author.\nEach finding is {kind, text, where?} and each gap {text, where?}; where names the place in the ticket, the contract or the plan (for example "CRM-412 · Notes", "api-contract.yaml:88", "plan.md:41"). Count the network requests the plan makes one screen or action fire: a plan that opens a screen with more than three requests at once, or requests data an existing query already holds, gets a left-open finding that names the requests and proposes fewer. Leave only real findings you can show from the plan, the sources and the code. When the plan needs no change and the ticket has no gaps, call approve(taskId, reviewId). Do not change files.${guidance}`;
		const own = authorFindings(review?.findings).filter(
			(item) => item.reviewer === reviewer && !item.accepted && item.round < round
		);
		const list = own
			.map(
				(item) =>
					`- id ${item.id} [${item.kind}]${item.where ? ` (${item.where})` : ''}: ${item.text}${item.answer ? `\n  Author's objection: ${item.answer}` : ''}${item.reason ? `\n  Your reason last time: ${item.reason}` : ''}`
			)
			.join('\n');
		return `Check ${what} ${taskId} (reviewId ${reviewId}, closure check).${brief}\nThis is the closure check of the plan review. The author revised the plan or objected to your findings. read_plan(taskId, reviewId) returns the revision and its diff from the one you read. For each of your findings below decide only whether it is closed — an objection you accept counts as closed:\n${list || '- (none)'}\nWhen every finding is closed and the revision brought in no problem, call approve(taskId, reviewId). Otherwise call submit_plan_review(taskId, reviewId, findings) with one item {replyTo: <finding id>, text: why it is still open} per open finding and, only for a problem the revision itself brought in, an item {kind, text, where?, introduced: true}. Raise nothing else, and do not ask about gaps again. Do not change files.${guidance}`;
	}
	/** spec/reviews#plan-verdict: `submit_plan_review` — checked, then stored as the review's findings with the closure marks. Returns the items. */
	private async planVerdict(reviewer: string, round: number, input: Record<string, unknown>) {
		const review = this.doc.review;
		if (!review?.plan || !['reading', 'verifying'].includes(review.state))
			throw new Error('No plan review waits for your verdict.');
		const closure = round > 1,
			own = authorFindings(review.findings).filter(
				(item) => item.reviewer === reviewer && !item.accepted
			),
			{ items, replies } = parsePlanVerdict(input, closure, own),
			findings = review.findings ?? [];
		// spec/reviews#plan-verdict: the record holds at most this many items; past it only replies to open findings are taken.
		if (findings.length + items.length > planFindingStoreLimit)
			throw new Error(
				`This review holds at most ${planFindingStoreLimit} findings and has ${findings.length}: answer the open ones with replyTo only.`
			);
		// Ids as a code finding's: a review batch names its findings by UUID.
		const added: PlanFinding[] = items.map((item) => ({
			...item,
			id: randomUUID(),
			reviewer,
			round,
			...(closure ? { introduced: round } : {}),
		}));
		const marked = closure
			? findings.map((item) => {
					if (!own.includes(item) || item.round >= round) return item;
					const reply = replies.find((entry) => entry.id === item.id);
					return reply ? { ...item, open: round, reason: reply.text } : { ...item, closed: round };
				})
			: findings;
		await this.update({ findings: [...marked, ...added] });
		return added.length + replies.length;
	}
	/** spec/reviews#plan-loop: an approval of a closure check closes every finding of this reviewer. */
	private async planApprove(reviewer: string, round: number) {
		const review = this.doc.review;
		if (!review?.plan || round <= 1) return;
		await this.update({
			findings: (review.findings ?? []).map((item) =>
				item.reviewer === reviewer && item.kind !== 'gap' && !item.accepted && item.round < round
					? { ...item, closed: round }
					: item
			),
		});
	}
	private async onPlanRound(run: ReviewRun, state: 'comments' | 'approved' | 'disputed') {
		const review = this.doc.review!,
			reviewers = run.verdicts.map((item) => item.reviewer),
			findings = review.findings ?? [];
		if (review.state === 'reading') {
			const own = state === 'approved' ? 0 : authorFindings(findings).length,
				gaps = findings.filter((item) => item.kind === 'gap').length;
			await this.deps.emit({
				kind: 'task-review.findings',
				id: review.id,
				point: review.point,
				findings: own,
				reviewers,
				...(gaps ? { gaps } : {}),
			});
			const next = await this.step({ kind: 'read', findings: own });
			if (next?.state === 'passed') await this.finished('passed');
			else if (next?.state === 'fixing') await this.deliverPlan(false);
			return;
		}
		if (review.state !== 'verifying') return;
		const closed = findings.filter((item) => item.closed === run.round).length,
			introduced = findings.filter((item) => item.introduced === run.round).length,
			open = state === 'approved' ? 0 : openPlanFindings(findings).length;
		await this.deps.emit({
			kind: 'task-review.verified',
			id: review.id,
			point: review.point,
			closed,
			open: state === 'approved' ? 0 : open - introduced,
			introduced: state === 'approved' ? 0 : introduced,
		});
		const next = await this.step({ kind: 'verified', open });
		if (next?.state === 'passed') await this.finished('passed');
	}
	/** What the crew host calls back on each round of the task's review. */
	hooks(): SelfReviewHooks {
		return {
			id: () => this.doc.review?.id ?? '',
			point: () => this.doc.review?.point ?? 'pre-pr',
			base: () => this.doc.review?.base ?? null,
			guidance: () => this.doc.review?.guidance ?? '',
			rounds: () => this.doc.review?.round ?? 0,
			brief: () => this.deps.brief(),
			planRead: (round) => this.planRead(round),
			planVerdict: (reviewer, round, input) => this.planVerdict(reviewer, round, input),
			planApprove: (reviewer, round) => this.planApprove(reviewer, round),
			planPrompt: (taskId, reviewId, round, reviewer) =>
				this.planPrompt(taskId, reviewId, round, reviewer),
			sources: (sourceId) => readSourcesForReview(this.deps.store, this.deps.key, sourceId),
			submitReview: async (text, batch) => {
				await this.update({ batch: batch.id, passes: (this.doc.review?.passes ?? 0) + 1 });
				await this.deps.submitReview(text, batch, Math.max(1, this.doc.review?.round ?? 1));
			},
			// Not through `serial`: a round opens from inside a serial step (`read`, `turnEnded`), and the crew host calls back before it returns.
			round: (run, state) => this.onRound(run, state),
		};
	}
	private async onRound(run: ReviewRun, state: 'reviewing' | 'comments' | 'approved' | 'disputed') {
		const review = this.doc.review;
		if (!review || !taskReviewLive(review)) return;
		const trees = run.scopeSnapshots.map((item) => ({ scopeId: item.scopeId, tree: item.result }));
		await this.update({ round: run.round, trees });
		if (state === 'reviewing') return;
		if (review.point === 'plan') return this.onPlanRound(run, state);
		const list = await reviewFindings(this.deps.store, this.deps.key, review.id),
			reviewers = run.verdicts.map((item) => item.reviewer);
		if (review.state === 'reading') {
			const findings = state === 'approved' ? 0 : list.length;
			await this.deps.emit({
				kind: 'task-review.findings',
				id: review.id,
				point: review.point,
				findings,
				reviewers,
			});
			const next = await this.step({ kind: 'read', findings });
			if (next?.state === 'passed') {
				await this.finished('passed');
				// spec/reviews#loop: a clean mid-task review while the agent waits — it goes on with the task.
				if (review.point === 'mid' && !this.deps.busy())
					await this.deps.prompt('The mid-task review passed. Continue the task.').catch(() => {});
			}
			return;
		}
		if (review.state !== 'verifying') return;
		const counts = findingCounts(list),
			open = state === 'approved' ? 0 : counts.open + counts.introduced;
		await this.deps.emit({
			kind: 'task-review.verified',
			id: review.id,
			point: review.point,
			closed: counts.closed,
			open: state === 'approved' ? 0 : counts.open,
			introduced: state === 'approved' ? 0 : counts.introduced,
		});
		const next = await this.step({ kind: 'verified', open });
		if (next?.state === 'passed') await this.finished('passed');
	}
}
/** The newest review batch of the task's own review in the journal: the turn that took it, else the queued prompt that holds it. */
export function lastReviewBatch(records: readonly EventRecord[]): string | null {
	for (let index = records.length - 1; index >= 0; index--) {
		const event = records[index]!.event;
		if (event.kind === 'turn.started' && event.review && event.crew?.kind === 'review-comments')
			return event.review.id;
		if (
			event.kind === 'prompt.queued' &&
			event.prompt.command.kind === 'submitReview' &&
			event.prompt.command.crew?.kind === 'review-comments'
		)
			return event.prompt.command.review.id;
	}
	return null;
}
