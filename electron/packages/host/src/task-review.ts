import { randomUUID } from 'node:crypto';
import {
	emptyTaskReviewDocument,
	isTaskReviewDocument,
	taskReviewLive,
	taskReviewSummaryLimit,
	type EventRecord,
	type ReviewBatch,
	type ReviewRun,
	type SessionCommand,
	type SessionEvent,
	type TaskKey,
	type TaskReviewDocument,
	type TaskReviewTree,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath, type SessionStore } from '@brigadir/persistence';
import type { CrewHost, SelfReviewHooks } from './crew';

type StartReview = Extract<SessionCommand, { kind: 'startReview' }>;
export type TaskReviewDeps = {
	store: SessionStore;
	key: TaskKey;
	emit(event: SessionEvent): Promise<void>;
	records(): readonly EventRecord[];
	/** A turn of the task's agent runs now. */
	busy(): boolean;
	/** The crew host of the task with the reviewers as the root's checkers: created for a solo task, extended for a foreman. */
	crew(start: StartReview): Promise<CrewHost>;
	/** The crew host that already runs the task's review after a restart, if any. */
	existing(): CrewHost | null;
	/** The round's comments as the task's own review batch (the `submitReview` command). */
	submitReview(text: string, review: ReviewBatch): Promise<void>;
	/** A task in a crew of its own: its rounds start only when its tree changed, since it hands fixes to workers. */
	foreman: boolean;
};
/**
 * spec/diff-and-review#agent-review: the task side of a review before the PR — the agent's proposal, the review the person started, and when its
 * rounds begin. The rounds themselves are the crew host's check edge on the task (`CrewHost.checkSelf`).
 */
export class TaskReviewLife {
	private doc: TaskReviewDocument = emptyTaskReviewDocument;
	private host: CrewHost | null = null;
	/** The batch of the last round with comments: the turn that answers it ends the wait for round 2. */
	private batch: string | null = null;
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
			const value = await readDocument(await this.file());
			if (isTaskReviewDocument(value)) this.doc = value;
		} catch (error) {
			if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error;
		}
		this.host = this.deps.existing();
	}
	document(): TaskReviewDocument {
		return this.doc;
	}
	/** spec/diff-and-review#agent-review-start: `propose_review` — the proposal waits for the person; a new one replaces it. */
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
	start(command: StartReview) {
		return this.serial(async () => {
			if (taskReviewLive(this.doc.review))
				throw new Error('A review of this task is already running.');
			this.host = await this.deps.crew(command);
			const id = randomUUID();
			this.doc = {
				schemaVersion: 1,
				proposal: null,
				review: {
					id,
					who: command.who,
					instructions: command.instructions,
					guidance: command.guidance,
					startedAt: new Date().toISOString(),
					state: 'waiting',
					round: 0,
					reviewers: command.reviewers.map((agent) => agent.name),
					trees: [],
				},
			};
			this.batch = null;
			await this.save();
			await this.deps.emit({
				kind: 'review.started',
				id,
				reviewers: command.reviewers.map((agent) => agent.name),
				who: command.who,
			});
			// spec/diff-and-review#agent-review-start: a turn that runs now ends first; the review starts from its snapshot.
			if (!this.deps.busy()) await this.round();
		});
	}
	stop() {
		return this.serial(async () => {
			const review = this.doc.review;
			if (!review || !taskReviewLive(review)) return;
			await this.host?.stopSelf();
			await this.finish('stopped');
		});
	}
	/** spec/diff-and-review#agent-review-rounds: after a turn of the task's agent — the waiting review starts, the answered comments go back to the reviewers,
	 *  and a later change makes an approval outdated. */
	turnEnded() {
		return this.serial(async () => {
			const review = this.doc.review;
			if (!review || !this.host) return;
			if (review.state === 'waiting') return this.round();
			const changed = await this.changed(review.trees);
			if (review.state === 'approved' && changed) return this.finish('outdated');
			if (review.state !== 'comments') return;
			const answered = this.answered();
			if (changed || (answered && !this.deps.foreman)) await this.round();
		});
	}
	private answered() {
		if (!this.batch) return false;
		const records = this.deps.records(),
			start = records.findLast((record) => record.event.kind === 'turn.started');
		return start?.event.kind === 'turn.started' && start.event.review?.id === this.batch;
	}
	private async changed(trees: readonly TaskReviewTree[]) {
		if (!this.host || !trees.length) return false;
		const now = await this.host.selfTrees();
		return trees.some(
			(tree) => now.find((item) => item.scopeId === tree.scopeId)?.tree !== tree.tree
		);
	}
	private async round() {
		const task = await this.deps.store.task(this.deps.key);
		const seq = this.deps.records().at(-1)?.seq ?? 0;
		await this.host!.checkSelf(seq, task.title);
	}
	private async finish(state: 'approved' | 'disputed' | 'outdated' | 'stopped') {
		const review = this.doc.review;
		if (!review) return;
		this.doc = {
			...this.doc,
			review: { ...review, state, finishedAt: new Date().toISOString() },
		};
		this.batch = null;
		await this.save();
		await this.deps.emit({ kind: 'review.finished', id: review.id, state });
	}
	/** What the crew host calls back on each round of the task's review. */
	hooks(): SelfReviewHooks {
		return {
			guidance: () => this.doc.review?.guidance ?? '',
			submitReview: async (text, review) => {
				this.batch = review.id;
				await this.deps.submitReview(text, review);
			},
			round: (run, state) => this.onRound(run, state),
		};
	}
	private async onRound(run: ReviewRun, state: 'reviewing' | 'comments' | 'approved' | 'disputed') {
		const review = this.doc.review;
		if (!review || !taskReviewLive(review)) return;
		const trees = run.scopeSnapshots.map((item) => ({ scopeId: item.scopeId, tree: item.result }));
		if (state === 'approved' || state === 'disputed') {
			this.doc = { ...this.doc, review: { ...review, round: run.round, trees } };
			return this.finish(state);
		}
		this.doc = { ...this.doc, review: { ...review, state, round: run.round, trees } };
		await this.save();
	}
}
