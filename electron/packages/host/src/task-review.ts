import { randomUUID } from 'node:crypto';
import {
	emptyTaskReviewDocument,
	readTaskReviewDocument,
	reviewLoop,
	reviewPointPrompt,
	taskReviewLive,
	taskReviewReasonLimit,
	taskReviewSummaryLimit,
	withNextReview,
	type EventRecord,
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

export type StartReview = Extract<SessionCommand, { kind: 'startReview' }>;
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
	/** A batch of findings as the task's own review batch (the `submitReview` command). */
	submitReview(text: string, review: ReviewBatch, round: number): Promise<void>;
	/** spec/reviews#who: the reviewer of a start the host or the agent makes — asked of the app, else a fresh session of the task's own provider. */
	resolve(point: ReviewPoint): Promise<StartReview | { failure: string }>;
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
			const value = await readDocument(await this.file(), undefined, [1, 2]);
			this.doc = readTaskReviewDocument(value, this.deps.key.id) ?? emptyTaskReviewDocument;
		} catch (error) {
			if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
		}
		this.host = this.deps.existing();
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
	private async begin(command: StartReview) {
		if (taskReviewLive(this.doc.review))
			throw new Error('A review of this task is already running.');
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
			await this.emitStarted(this.doc.review!);
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
		await this.emitStarted(review);
		// spec/reviews#start: the agent's review reads at once (after a checkpoint); the others wait for a running turn to end.
		if (startedBy === 'agent') {
			await this.deps.checkpoint().catch(() => {});
			await this.read();
		} else if (!this.deps.busy()) await this.read();
		return review;
	}
	private emitStarted(review: TaskReview) {
		return this.deps.emit({
			kind: 'task-review.started',
			id: review.id,
			point: review.point,
			startedBy: review.startedBy,
			reviewers: review.reviewers,
			...(review.reason ? { reason: review.reason } : {}),
		});
	}
	/**
	 * spec/reviews#request-tool: the agent (or, later, a threshold) asks for a review; the host decides — refuses while one lives or when nothing
	 * changed, resolves the reviewer, records a review that could not start, else starts it.
	 */
	request(input: { point: ReviewPoint; startedBy: TaskReviewStarter; reason: string }) {
		return this.serial(async () => {
			if (taskReviewLive(this.doc.review))
				return { started: false, reason: 'A review of this task is already running.' };
			if (!(await this.deps.changes()) || !(await this.changedSinceLast()))
				return { started: false, reason: 'Nothing changed since the last review.' };
			const resolved = await this.deps.resolve(input.point);
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
			const review = await this.begin({
				...command,
				point: input.point,
				startedBy: input.startedBy,
				reason: input.reason.trim(),
			});
			return review.reviewers.length && !('failure' in resolved)
				? { started: true, reviewer: review.reviewers.join(', ') }
				: { started: false, reason: 'failure' in resolved ? resolved.failure : '' };
		});
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
			if (
				(review.state === 'passed' || review.state === 'accepted') &&
				review.point === 'pre-pr' &&
				(await this.differs(review.trees))
			) {
				if (await this.step({ kind: 'changed' })) await this.finished('outdated');
				return;
			}
			if (review.state !== 'fixing') return;
			const answered = this.answered(review.batch);
			if (!answered || (this.deps.foreman && !(await this.differs(review.trees)))) return;
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
	/** The turn that took the last batch has ended (the newest turn start carries it). */
	private answered(batch: string | undefined) {
		if (!batch) return false;
		const records = this.deps.records(),
			start = records.findLast((record) => record.event.kind === 'turn.started');
		return start?.event.kind === 'turn.started' && start.event.review?.id === batch;
	}
	private async read() {
		if (await this.step({ kind: 'begin' })) await this.round();
	}
	private async round() {
		const task = await this.deps.store.task(this.deps.key);
		const seq = this.deps.records().at(-1)?.seq ?? 0;
		await this.host!.checkSelf(seq, task.title);
	}
	private async finished(state: 'passed' | 'accepted' | 'stopped' | 'outdated') {
		const review = this.doc.review;
		if (!review) return;
		await this.deps.emit({
			kind: 'task-review.finished',
			id: review.id,
			point: review.point,
			state,
		});
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
