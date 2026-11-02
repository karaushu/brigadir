import { randomUUID } from 'node:crypto';
import { atomicJson, readDocument } from '@brigadir/persistence';
import {
	ciLive,
	isRecord,
	isSlackWatch,
	slackLocalize,
	slackText,
	slackWatchDays,
	slackWatchLimit,
	slackWatchReply,
	type CIFinished,
	type CIRun,
	type CIRunDetail,
	type CIWatch,
	type PRState,
	type SlackWatch,
	type SlackWatchPR,
	type TaskKey,
	type TaskStatus,
} from '@brigadir/core';

/** What a watch reads in Brigadir: the PR as GitHub has it now, its runs, the bells (spec/pull-requests-and-ci#ci-bell), the task's state. */
export type SlackWatching = {
	pr(pr: SlackWatchPR): Promise<{
		state: PRState;
		repo: string;
		head: string;
		base: string;
		url: string;
		headSha: string;
		mergeSha: string | null;
	}>;
	/** The runs on a commit (newest first, as GitHub lists them). */
	runs(pr: SlackWatchPR, sha: string): Promise<CIRun[]>;
	run(pr: SlackWatchPR, runId: number): Promise<CIRunDetail>;
	bells(): Promise<CIWatch[]>;
	bell(watch: CIWatch, on: boolean): Promise<unknown>;
	/** `null` — the task is gone. */
	task(key: TaskKey): Promise<{ status: TaskStatus; repo: string; branch: string } | null>;
};
export type SlackWatchInput = Omit<SlackWatch, 'id' | 'created' | 'run' | 'outbox'>;
export type SlackWatchesDeps = SlackWatching & {
	/** `<dataRoot>/slack/watches.json`; `write` makes the folder. */
	file(write: boolean): Promise<string>;
	post(thread: { channel: string; ts: string }, text: string): Promise<unknown>;
	/** Slack can take a message now (the module on, a token Slack accepted). */
	ready(): boolean;
	now?(): number;
	pollMs?: number;
};
export const slackWatchPollMs = 60_000;
const dayMs = 86_400_000,
	done = (status: TaskStatus) => status === 'done' || status === 'completed',
	repoOf = (link: string) => /github\.com\/[^/]+\/([^/]+)/.exec(link)?.[1] ?? '';

/**
 * spec/notifications-slack-notes-and-schedules#slack: «watch and tell me here». A watch lives in `slack/watches.json` (at most 50) and survives a restart; while
 * any exists, one pass a minute: a PR's state read fresh from GitHub (once per PR), a CI run found and given a bell, a task's
 * state. It fires once in its own thread, mentioning who asked, and goes; after 7 days it goes with a short note.
 */
export class SlackWatches {
	private watches: SlackWatch[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private passing = false;
	readonly loaded: Promise<void>;
	constructor(private readonly deps: SlackWatchesDeps) {
		this.loaded = this.load();
	}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private async load() {
		try {
			const value = await readDocument(await this.deps.file(false));
			if (isRecord(value) && Array.isArray(value.watches))
				this.watches = value.watches.filter(isSlackWatch).slice(0, slackWatchLimit);
		} catch {
			// No file yet.
		}
		this.schedule();
	}
	private async save() {
		await atomicJson(await this.deps.file(true), {
			schemaVersion: 1,
			watches: this.watches,
		}).catch(() => {});
		this.schedule();
	}
	private schedule() {
		if (this.watches.length && !this.timer) {
			this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? slackWatchPollMs);
			this.timer.unref?.();
		} else if (!this.watches.length && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
	async list(): Promise<SlackWatch[]> {
		await this.loaded;
		return [...this.watches];
	}
	/** New watches; the same one in the same thread is not added twice. `full` — the 50 are taken. */
	async add(inputs: readonly SlackWatchInput[]): Promise<'ok' | 'full'> {
		await this.loaded;
		const fresh = inputs.filter(
			(input) =>
				!this.watches.some(
					(watch) =>
						watch.channel === input.channel &&
						watch.ts === input.ts &&
						watch.kind === input.kind &&
						(watch.kind === 'task-done'
							? watch.task?.projectId === input.task?.projectId && watch.task?.id === input.task?.id
							: watch.pr?.projectId === input.pr?.projectId &&
								watch.pr?.scopeId === input.pr?.scopeId &&
								watch.pr?.number === input.pr?.number)
				)
		);
		if (this.watches.length + fresh.length > slackWatchLimit) return 'full';
		const created = this.now();
		this.watches.push(
			...fresh.map((input) => ({
				...input,
				id: randomUUID().replace(/-/g, '').slice(0, 16),
				created,
			}))
		);
		await this.save();
		return 'ok';
	}
	/** «Stop watching» in a thread: its watches go, and the bells they put. */
	async cancel(channel: string, ts: string): Promise<number> {
		await this.loaded;
		const gone = this.watches.filter((watch) => watch.channel === channel && watch.ts === ts);
		if (!gone.length) return 0;
		await this.drop(gone);
		return gone.length;
	}
	private async drop(gone: readonly SlackWatch[]) {
		this.watches = this.watches.filter((watch) => !gone.includes(watch));
		for (const watch of gone)
			if (watch.run?.bell && watch.pr)
				await this.deps.bell(this.bellOf(watch.pr, watch.run.id), false).catch(() => {});
		await this.save();
	}
	private bellOf(pr: SlackWatchPR, runId: number): CIWatch {
		return {
			projectId: pr.projectId,
			taskId: pr.taskId,
			scopeId: pr.scopeId,
			runId,
			label: `#${pr.number}`,
		};
	}
	/**
	 * A bell's run ended (CIWatches' `finished`): the CI watches on it answer in their threads. `true` — the bell was a
	 * watch's own, so the task's thread gets no second CI message.
	 */
	async ciFinished(event: CIFinished, detail: CIRunDetail): Promise<boolean> {
		await this.loaded;
		const fired = this.watches.filter(
			(watch) =>
				watch.kind === 'ci' &&
				watch.run?.id === event.run.id &&
				watch.pr?.projectId === event.watch.projectId
		);
		if (!fired.length) return false;
		// CIWatches has taken the bell off already.
		for (const watch of fired) if (watch.run) watch.run.bell = false;
		await Promise.all(fired.map((watch) => this.fire(watch, this.ciText(watch, detail))));
		await this.save();
		return true;
	}
	/** A task's turn ended: a task-done watch on it fires when the task is Done (or Completed) now. */
	async taskEnded(key: TaskKey): Promise<void> {
		await this.loaded;
		const mine = this.watches.filter(
			(watch) =>
				watch.kind === 'task-done' &&
				watch.task?.projectId === key.projectId &&
				watch.task.id === key.id
		);
		if (!mine.length) return;
		const task = await this.deps.task(key).catch(() => null);
		if (!task || !done(task.status)) return;
		await Promise.all(mine.map((watch) => this.fire(watch, this.taskText(watch, task))));
		await this.save();
	}
	/** One pass over every watch; the timer calls it each minute, tests call it directly. */
	async poll(): Promise<void> {
		await this.loaded;
		if (this.passing) return;
		this.passing = true;
		const prs = new Map<string, ReturnType<SlackWatching['pr']>>();
		const readPR = (pr: SlackWatchPR) => {
			const key = `${pr.projectId}\0${pr.scopeId}\0${pr.number}`;
			if (!prs.has(key)) prs.set(key, this.deps.pr(pr));
			return prs.get(key)!;
		};
		try {
			for (const watch of [...this.watches]) {
				if (!this.watches.includes(watch)) continue;
				if (this.now() - watch.created > slackWatchDays * dayMs) {
					if (!watch.outbox && this.deps.ready())
						await this.deps
							.post(watch, slackLocalize(slackWatchReply.expired(watch), watch.language))
							.catch(() => {});
					await this.drop([watch]);
					continue;
				}
				if (watch.outbox) {
					await this.fire(watch, watch.outbox);
					continue;
				}
				try {
					await this.check(watch, readPR);
				} catch {
					// GitHub or the store did not answer: the next pass tries again.
				}
			}
		} finally {
			this.passing = false;
			await this.save();
		}
	}
	private async check(
		watch: SlackWatch,
		readPR: (pr: SlackWatchPR) => ReturnType<SlackWatching['pr']>
	) {
		if (watch.kind === 'task-done') {
			const task = await this.deps.task(watch.task!);
			if (!task) {
				this.watches = this.watches.filter((item) => item !== watch);
				return;
			}
			if (done(task.status) && task.status !== watch.last)
				await this.fire(watch, this.taskText(watch, task));
			else watch.last = task.status;
			return;
		}
		const pr = watch.pr!;
		if (watch.kind === 'pr-merged') {
			const state = await readPR(pr);
			if (state.state === 'MERGED')
				await this.fire(
					watch,
					slackText(
						{
							kind: 'prMerged',
							repo: state.repo,
							head: state.head,
							base: state.base,
							task: watch.task,
							number: pr.number,
							url: state.url,
						},
						`<@${watch.by}>`
					)
				);
			else if (state.state === 'CLOSED')
				await this.fire(watch, `<@${watch.by}>\n${slackWatchReply.prClosed(pr, state.repo)}`);
			return;
		}
		// ci: a run with a bell waits for CIWatches; a bell gone (taken off, expired) — the run is read here.
		if (watch.run) {
			const runId = watch.run.id,
				belled = (await this.deps.bells()).some(
					(bell) =>
						bell.runId === runId && bell.projectId === pr.projectId && bell.scopeId === pr.scopeId
				);
			if (belled) return;
			const detail = await this.deps.run(pr, runId);
			if (running(detail)) {
				await this.deps.bell(this.bellOf(pr, runId), true);
				watch.run = { id: runId, bell: true };
			} else await this.fire(watch, this.ciText(watch, detail));
			return;
		}
		const state = await readPR(pr),
			sha = state.state === 'MERGED' ? (state.mergeSha ?? state.headSha) : state.headSha,
			runs = await this.deps.runs(pr, sha);
		if (!runs.length) return;
		const newest = (items: CIRun[]) =>
				[...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
			live = newest(runs.filter((run) => ciLive(run.state))),
			run = live ?? newest(runs)!;
		const detail = live ? null : await this.deps.run(pr, run.id);
		if (detail && !running(detail)) {
			// It ended before anyone asked: the answer is now.
			await this.fire(watch, this.ciText(watch, detail));
			return;
		}
		const had = (await this.deps.bells()).some(
			(bell) =>
				bell.runId === run.id && bell.projectId === pr.projectId && bell.scopeId === pr.scopeId
		);
		if (!had) await this.deps.bell(this.bellOf(pr, run.id), true);
		watch.run = { id: run.id, bell: !had };
	}
	private ciText(watch: SlackWatch, detail: CIRunDetail) {
		const run = detail.run;
		return slackText(
			{
				kind: 'ci',
				state:
					run.state === 'pass'
						? 'pass'
						: run.state === 'cancelled' || run.state === 'skipped'
							? 'cancelled'
							: 'fail',
				repo: repoOf(run.link) || repoOf(watch.pr?.url ?? '') || `#${watch.pr?.number ?? ''}`,
				branch: run.branch,
				environment: detail.deploy?.environment ?? null,
				task: watch.task,
				seconds: run.seconds,
				link: run.link,
				error: detail.annotation?.message ?? null,
			},
			`<@${watch.by}>`
		);
	}
	private taskText(watch: SlackWatch, task: { repo: string; branch: string }) {
		return slackText(
			{ kind: 'taskDone', repo: task.repo, branch: task.branch, task: watch.task!, summary: null },
			`<@${watch.by}>`
		);
	}
	/** The answer in the watch's thread, in its language; the watch goes once Slack took it, else it waits in `outbox`. */
	private async fire(watch: SlackWatch, text: string) {
		const message = watch.outbox ?? slackLocalize(text, watch.language);
		try {
			if (!this.deps.ready()) throw new Error('Slack is not ready');
			await this.deps.post(watch, message);
			this.watches = this.watches.filter((item) => item !== watch);
		} catch {
			watch.outbox = message;
		}
	}
	dispose() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
function running(detail: CIRunDetail) {
	return ciLive(detail.run.state) || detail.deploy?.state === 'running';
}
