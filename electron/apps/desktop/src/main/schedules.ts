import {
	dueDecision,
	nextRun,
	quietRunFinished,
	runNeedsPerson,
	type AgentTask,
	type Schedule,
	type ScheduleRun,
	type ScheduleRunReason,
	type ScheduleSummary,
	type TaskKey,
} from '@brigadir/core';
import type { SchedulesStore } from '@brigadir/persistence';

/** A previous run in one of these still holds its schedule: the next slot is skipped (spec/notifications-slack-notes-and-schedules#schedules). */
const holding = new Set<AgentTask['status']>([
	'queued',
	'preparing',
	'working',
	'needs-you',
	'rate-limited',
]);
/** A timer never sleeps longer than this: the clock may jump, and a long `setTimeout` overflows. */
const maxSleepMs = 3_600_000;
/** Missed slots written to `runs.jsonl` per pass; a week of hourly slots is not 168 lines. */
const maxSkippedLines = 20;

export type ScheduleNotice =
	| { kind: 'started'; schedule: Schedule; task: AgentTask }
	| { kind: 'finished'; schedule: Schedule | null; task: AgentTask }
	| { kind: 'start-failed'; schedule: Schedule; error: string }
	| { kind: 'missed'; schedule: Schedule; count: number; latest: number; asked: boolean };

export type SchedulerDeps = {
	store: Pick<
		SchedulesStore,
		'list' | 'read' | 'save' | 'update' | 'delete' | 'appendRuns' | 'runs'
	>;
	/** The tasks as the sidebar reads them, with their change counts. */
	tasks(): Promise<AgentTask[]>;
	/** Creates the run's task from the blank (the same path as `task:create`) and marks it `scheduleRun`. */
	createRun(schedule: Schedule, due: number, quiet: boolean): Promise<AgentTask>;
	/** Puts the task into the launch queue (`session:start`). */
	start(key: TaskKey): Promise<unknown> | unknown;
	/** The run task reaches Tasks: `scheduleRun.quiet` off. */
	markLoud(task: AgentTask): Promise<unknown>;
	/** A quiet run that ended with nothing to look at goes to Completed, as a drag to that column does. */
	complete(task: AgentTask): Promise<unknown>;
	notify(notice: ScheduleNotice): void;
	changed(): void;
	enabled(): boolean;
	now?(): number;
};

/**
 * spec/notifications-slack-notes-and-schedules#schedules: the scheduler in main. One timer to the nearest slot of all schedules; on it, on start, on wake and on any
 * change of a schedule — one pass over all of them. A pass never overlaps another.
 */
export class Scheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pass: Promise<void> | null = null;
	private again = false;
	private running = false;
	/** Quiet run tasks, `projectId/id`: their events are watched until they reach Tasks or finish. */
	private quiet = new Set<string>();
	private watches = new Map<string, ReturnType<typeof setTimeout>>();
	constructor(private deps: SchedulerDeps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	start() {
		this.running = true;
		void this.deps
			.tasks()
			.then((tasks) => {
				for (const task of tasks)
					if (task.scheduleRun?.quiet && !task.archived) this.quiet.add(name(task));
				for (const task of tasks) if (this.quiet.has(name(task))) this.observe(task);
			})
			.catch(() => {});
		this.kick();
	}
	stop() {
		this.running = false;
		clearTimeout(this.timer);
		this.timer = undefined;
		for (const timer of this.watches.values()) clearTimeout(timer);
		this.watches.clear();
	}
	/** Run a pass now (start, wake, a schedule changed, the module switched on). */
	kick(): Promise<void> {
		if (!this.running) return Promise.resolve();
		if (this.pass) {
			this.again = true;
			return this.pass;
		}
		const run = (async () => {
			do {
				this.again = false;
				await this.check().catch(() => {});
			} while (this.again);
		})();
		this.pass = run.finally(() => {
			this.pass = null;
			this.arm().catch(() => {});
		});
		return this.pass;
	}
	private async arm() {
		clearTimeout(this.timer);
		if (!this.running || !this.deps.enabled()) return;
		const now = this.now();
		let next = Infinity;
		for (const schedule of await this.deps.store.list().catch(() => [])) {
			if (schedule.paused || schedule.pendingMissed) continue;
			const at = nextRun(
				schedule.rule,
				schedule.timeZone,
				Math.max(Date.parse(schedule.checkedUntil), now - 1)
			);
			if (at !== null) next = Math.min(next, at);
		}
		const wait = Math.max(1_000, Math.min(next - now + 250, maxSleepMs));
		this.timer = setTimeout(() => void this.kick(), wait);
		this.timer.unref?.();
	}
	private async check() {
		if (!this.deps.enabled()) return;
		const schedules = await this.deps.store.list();
		let touched = false;
		for (const schedule of schedules) {
			const now = this.now(),
				decision = dueDecision(schedule, now);
			if (decision.kind === 'none') continue;
			touched = true;
			const skipped = decision.kind === 'ask' ? [] : decision.skipped;
			await this.writeSkipped(schedule, skipped, now);
			if (decision.kind === 'run') {
				await this.update(schedule, (s) => ({ ...s, checkedUntil: new Date(now).toISOString() }));
				await this.fire(schedule, decision.due);
			} else if (decision.kind === 'skip') {
				const latest = skipped[skipped.length - 1]!;
				await this.update(schedule, (s) => ({ ...s, checkedUntil: new Date(now).toISOString() }));
				this.deps.notify({ kind: 'missed', schedule, count: skipped.length, latest, asked: false });
			} else {
				const latest = decision.missed[decision.missed.length - 1]!,
					count = (schedule.pendingMissed?.count ?? 0) + decision.missed.length;
				const next = await this.update(schedule, (s) => ({
					...s,
					checkedUntil: new Date(now).toISOString(),
					pendingMissed: { count, latest: new Date(latest).toISOString() },
				}));
				this.deps.notify({
					kind: 'missed',
					schedule: next ?? schedule,
					count,
					latest,
					asked: true,
				});
			}
		}
		if (touched) this.deps.changed();
	}
	private async writeSkipped(schedule: Schedule, slots: number[], now: number) {
		if (!slots.length) return;
		const at = new Date(now).toISOString();
		await this.deps.store
			.appendRuns(
				schedule.projectId,
				schedule.id,
				slots.slice(-maxSkippedLines).map((due) => ({
					due: new Date(due).toISOString(),
					at,
					status: 'missed',
					reason: 'missed',
				}))
			)
			.catch(() => {});
	}
	private async update(schedule: Schedule, change: (s: Schedule) => Schedule) {
		return this.deps.store.update(schedule.projectId, schedule.id, change).catch(() => null);
	}
	/** One run of a slot: skipped while the previous run still holds the schedule, else a new task in the launch queue. */
	private async fire(
		schedule: Schedule,
		due: number,
		reason?: ScheduleRunReason
	): Promise<ScheduleRun> {
		const at = new Date(this.now()).toISOString(),
			dueText = new Date(due).toISOString();
		const previous = schedule.lastRun?.taskId;
		if (previous && reason !== 'run-now') {
			const task = (await this.deps.tasks().catch(() => [])).find(
				(item) => item.projectId === schedule.projectId && item.id === previous
			);
			if (task && !task.archived && holding.has(task.status)) {
				const run: ScheduleRun = {
					due: dueText,
					at,
					status: 'skipped',
					reason: 'previous-run-active',
				};
				await this.record(schedule, run, false);
				return run;
			}
		}
		const quiet = schedule.inTasks === 'needs-you';
		let run: ScheduleRun;
		try {
			const task = await this.deps.createRun(schedule, due, quiet);
			if (quiet) this.quiet.add(name(task));
			await this.deps.start({ projectId: task.projectId, id: task.id });
			run = { due: dueText, at, status: 'started', taskId: task.id, ...(reason ? { reason } : {}) };
			this.deps.notify({ kind: 'started', schedule, task });
		} catch (error) {
			run = { due: dueText, at, status: 'failed-to-start', reason: 'start-failed' };
			this.deps.notify({
				kind: 'start-failed',
				schedule,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await this.record(schedule, run, true);
		return run;
	}
	private async record(schedule: Schedule, run: ScheduleRun, last: boolean) {
		await this.deps.store.appendRuns(schedule.projectId, schedule.id, [run]).catch(() => {});
		if (last) await this.update(schedule, (s) => ({ ...s, lastRun: run }));
	}

	// ── what the person does ─────────────────────────────────────────────────────────────────────────────────────
	async list(): Promise<ScheduleSummary[]> {
		const now = this.now();
		return (await this.deps.store.list()).map((schedule) => ({
			...schedule,
			nextRun: schedule.paused
				? null
				: ((at) => (at === null ? null : new Date(at).toISOString()))(
						nextRun(
							schedule.rule,
							schedule.timeZone,
							Math.max(Date.parse(schedule.checkedUntil), now)
						)
					),
		}));
	}
	async save(schedule: Schedule) {
		const saved = await this.deps.store.save(schedule);
		this.deps.changed();
		void this.kick();
		return saved;
	}
	async remove(projectId: string, id: string) {
		await this.deps.store.delete(projectId, id);
		this.deps.changed();
		void this.kick();
	}
	/** Pause keeps the rule; resume starts from now — a paused stretch is not «missed». */
	async setPaused(projectId: string, id: string, paused: boolean) {
		const now = new Date(this.now()).toISOString();
		const next = await this.deps.store.update(projectId, id, (s) => ({
			...s,
			paused,
			...(paused ? {} : { checkedUntil: now }),
		}));
		this.deps.changed();
		void this.kick();
		return next;
	}
	/** «Run now»: a run outside the rule; it works while paused and does not move the cursor. */
	async runNow(projectId: string, id: string) {
		const schedule = await this.deps.store.read(projectId, id);
		const run = await this.fire(schedule, this.now(), 'run-now');
		this.deps.changed();
		return run;
	}
	/** «Ask»: the person's answer to the missed slots — one run now, or skip them all. */
	async resolveMissed(projectId: string, id: string, answer: 'run' | 'skip') {
		const schedule = await this.deps.store.read(projectId, id);
		const pending = schedule.pendingMissed;
		if (!pending) return null;
		const cleared = await this.deps.store.update(projectId, id, (s) => {
			const { pendingMissed: _gone, ...rest } = s;
			return rest;
		});
		let run: ScheduleRun | null = null;
		if (answer === 'run') run = await this.fire(cleared, Date.parse(pending.latest));
		else
			await this.deps.store
				.appendRuns(projectId, id, [
					{
						due: pending.latest,
						at: new Date(this.now()).toISOString(),
						status: 'skipped',
						reason: 'asked-skip',
					},
				])
				.catch(() => {});
		this.deps.changed();
		void this.kick();
		return run;
	}
	runs(projectId: string, id: string, limit?: number) {
		return this.deps.store.runs(projectId, id, limit);
	}

	// ── quiet runs ──────────────────────────────────────────────────────────────────────────────────────────────
	/** A journal record of a task: a quiet run is looked at again a moment later (status and changes settle first). */
	taskEvent(key: TaskKey) {
		const id = name(key);
		if (!this.quiet.has(id) || !this.running) return;
		clearTimeout(this.watches.get(id));
		const timer = setTimeout(() => {
			this.watches.delete(id);
			void this.deps
				.tasks()
				.then((tasks) => {
					const task = tasks.find((item) => item.projectId === key.projectId && item.id === key.id);
					if (task) return this.observe(task);
					this.quiet.delete(id);
				})
				.catch(() => {});
		}, 800);
		timer.unref?.();
		this.watches.set(id, timer);
	}
	private async observe(task: AgentTask) {
		const run = task.scheduleRun;
		if (!run?.quiet || task.archived) {
			this.quiet.delete(name(task));
			return;
		}
		if (runNeedsPerson(task)) {
			this.quiet.delete(name(task));
			await this.deps.markLoud(task);
			this.deps.changed();
		} else if (quietRunFinished(task)) {
			this.quiet.delete(name(task));
			await this.deps.complete(task);
			const schedule = await this.deps.store.read(task.projectId, run.scheduleId).catch(() => null);
			this.deps.notify({ kind: 'finished', schedule, task });
			this.deps.changed();
		}
	}
}
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
