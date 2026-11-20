import { randomUUID } from 'node:crypto';
import {
	isRecord,
	isSmokeResult,
	readyScreenKey,
	readyScreens,
	smokeCounts,
	smokeLimits,
	smokeMinutesOf,
	smokeOpen,
	smokeReportSteps,
	smokeRunOf,
	type EventRecord,
	type ReadyWhere,
	type SessionEvent,
	type SmokeRun,
	type SmokeStep,
	type SmokeStopCause,
} from '@brigadir/core';
import { readDocument, safePath } from '@brigadir/persistence';

/** A minute of the limit; the host tests make it short (as `BRIGADIR_STEER_HOLD_MS` does the steering hold). */
const minute = Number(process.env.BRIGADIR_SMOKE_MINUTE_MS) || 60_000;
/** spec/smoke-run#limit: the minutes of a run's limit, as the person and the agent read them. */
const minutes = (ms: number) => {
	const count = Math.round(ms / minute);
	return `${count} ${count === 1 ? 'minute' : 'minutes'}`;
};
/** spec/smoke-run#limit: what the agent is told when the report is due (English, rule 12). */
export function smokeReportDue(run: SmokeRun): string {
	const head =
		run.cause === 'person'
			? 'The person stopped the smoke run.'
			: `The smoke run reached its limit of ${minutes(run.limitMs)}.`;
	return `${head} Stop checking and file the report now with smoke_report: what you checked, what failed, and what you could not check and why.`;
}
/** spec/smoke-run#start: a terminal task's agent cannot be asked for the report, so it runs none. */
export const terminalSmoke =
	'A terminal session runs no smoke run: check the app with the browser or simulator tools and say what you found.';
/** The turns from the run's start up to `seq`: was one of them an ask for the report that ended (its `turn.completed` is in the range)? */
export function askEnded(records: readonly EventRecord[], id: string, seq: number): boolean {
	let started = false,
		inAsk = false;
	for (const record of records) {
		if (record.seq > seq) break;
		const event = record.event;
		if (event.kind === 'smoke.started' && event.id === id) started = true;
		if (!started) continue;
		if (event.kind === 'turn.started') inAsk = event.crew?.kind === 'smoke-report';
		else if (event.kind === 'host.stopped') inAsk = false;
		else if (event.kind === 'turn.completed') {
			if (inAsk) return true;
			inAsk = false;
		}
	}
	return false;
}
/** Asks for the report of the run that wait in the queue: queued, not removed, and not yet begun as a turn. */
export function asksWaiting(records: readonly EventRecord[], id: string): boolean {
	let started = false;
	const queued = new Set<string>();
	let begun = 0;
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'smoke.started' && event.id === id) started = true;
		if (!started) continue;
		if (event.kind === 'prompt.queued' && event.prompt.command.crew?.kind === 'smoke-report')
			queued.add(event.prompt.id);
		else if (event.kind === 'prompt.removed') queued.delete(event.id);
		else if (event.kind === 'turn.started' && event.crew?.kind === 'smoke-report') begun++;
	}
	return queued.size > begun;
}
const stillOpen =
	'Your smoke run is still open. File its report now with smoke_report: what you checked, what failed, and what you could not check and why.';
/** spec/smoke-run#limit: the limit a task's host reads from `settings.json` at `smoke_start`. */
export async function readSmokeMinutes(root: string): Promise<number> {
	try {
		const doc = await readDocument(await safePath(root, 'settings.json'));
		return smokeMinutesOf(doc.settings);
	} catch {
		return smokeMinutesOf(null);
	}
}
export type SmokeDeps = {
	records(): readonly EventRecord[];
	emit(event: SessionEvent): Promise<void>;
	/** spec/smoke-run#start: a solo task's agent, an Auto agent or a crew developer. */
	eligible: boolean;
	/** The browser and the simulator modules as Settings has them now. */
	modules(): { browser: boolean; simulator: boolean };
	minutes(): Promise<number>;
	/** spec/smoke-run#who: this task is a worker an Auto agent hired. */
	hiredWorker(): Promise<boolean>;
	/** spec/smoke-run#who: an Auto agent whose workers still run. */
	workersRun(): boolean;
	busy(): boolean;
	/** The running turn takes the text through steering; false — no steering, or the agent declined it. */
	steer(text: string): Promise<boolean>;
	/** A new turn with the text, marker `smoke-report`. */
	prompt(text: string): Promise<void>;
	/** Take the asks for the report that still wait in the queue out of it (the run they ask about is closed). */
	dropAsks(): Promise<void>;
	/** spec/smoke-run#start: a GUI session — the host can ask it for the report; a terminal one has no smoke run. */
	asks: boolean;
	/** spec/smoke-run#ready: the page of a browser tab of this task; null with no page open. */
	page(tab: string | undefined): Promise<{ tab: string; url: string } | null>;
	stopping(): boolean;
	now?(): number;
};
/**
 * spec/smoke-run: the task's smoke run and its limit in its host — `smoke_start`, the timer, the refusal of the browser and the simulator from the
 * limit to the report, the ask for the report, `smoke_report` — and `ready_to_look`. Everything lives in the journal, so a restart reads it back.
 */
export class SmokeLife {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	private cache: { length: number; run: SmokeRun | null } = { length: -1, run: null };
	/** The run this host asked for the report as a prompt; the journal tells a restarted host the same through the queue and the turn. */
	private asked: string | null = null;
	constructor(private deps: SmokeDeps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	/** The newest run, derived from the journal; cached by its length. */
	run(): SmokeRun | null {
		const records = this.deps.records();
		if (this.cache.length !== records.length)
			this.cache = { length: records.length, run: smokeRunOf(records) };
		return this.cache.run;
	}
	private on() {
		const modules = this.deps.modules();
		return modules.browser || modules.simulator;
	}
	/** spec/smoke-run#limit: a stopped run refuses the browser and the simulator until its report. */
	gate(method: string) {
		if (!method.startsWith('browser_') && !method.startsWith('simulator_')) return;
		const run = this.run();
		if (run?.state === 'stopped') throw new Error(smokeReportDue(run));
	}
	/** spec/smoke-run#start: `smoke_start(steps)`. */
	start(params: unknown) {
		return this.serial(async () => {
			if (!this.deps.eligible) throw new Error('Method is not available to this role');
			if (!this.deps.asks) throw new Error(terminalSmoke);
			if (!this.on()) throw new Error('The simulator and the browser are off in Settings.');
			const input = isRecord(params) ? params : {};
			const steps = Array.isArray(input.steps)
				? input.steps.map((item) => (typeof item === 'string' ? item.trim() : ''))
				: [];
			if (
				!steps.length ||
				steps.length > smokeLimits.steps ||
				steps.some((item) => !item || item.length > smokeLimits.step)
			)
				throw new Error(
					`steps is a list of 1–${smokeLimits.steps} flows of 1–${smokeLimits.step} characters`
				);
			if (smokeOpen(this.run()))
				throw new Error('A smoke run is already open: file its report with smoke_report.');
			if (await this.deps.hiredWorker())
				throw new Error(
					'The smoke runs once on the integrated work: the agent that hired you runs it.'
				);
			if (this.deps.workersRun())
				throw new Error(
					'Workers of this task still run: start the smoke when their parts are back.'
				);
			const limit = await this.deps.minutes(),
				id = randomUUID(),
				limitMs = limit * minute;
			await this.deps.emit({ kind: 'smoke.started', id, steps, limitMs });
			this.arm();
			return {
				started: true,
				limitMinutes: limit,
				endsAt: new Date((this.run()?.startedAt ?? this.now()) + limitMs).toISOString(),
				next: `Go through the steps once with the browser or simulator tools, then call smoke_report. At ${limit} minutes the browser and simulator tools stop answering and the report is due.`,
			};
		});
	}
	/** spec/smoke-run#report: `smoke_report(steps, summary)`. */
	report(params: unknown) {
		return this.serial(async () => {
			if (!this.deps.eligible) throw new Error('Method is not available to this role');
			const run = this.run();
			if (!smokeOpen(run)) throw new Error('No smoke run is open: start one with smoke_start.');
			const input = isRecord(params) ? params : {};
			const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
			if (!summary || summary.length > smokeLimits.summary)
				throw new Error(`summary is 1–${smokeLimits.summary} characters`);
			const list = Array.isArray(input.steps) ? input.steps : [];
			if (!list.length || list.length > smokeLimits.reportSteps)
				throw new Error(`steps is a list of 1–${smokeLimits.reportSteps} items`);
			const reported: SmokeStep[] = [];
			for (const item of list) {
				const step = isRecord(item) && typeof item.step === 'string' ? item.step.trim() : '',
					result = isRecord(item) ? item.result : undefined,
					note = isRecord(item) && typeof item.note === 'string' ? item.note.trim() : '';
				if (!step || step.length > smokeLimits.step || !isSmokeResult(result))
					throw new Error(
						`Each step is {step: 1–${smokeLimits.step} characters, result: passed, failed or unchecked, note?}`
					);
				if (note.length > smokeLimits.note)
					throw new Error(`A note is at most ${smokeLimits.note} characters.`);
				if (result !== 'passed' && !note)
					throw new Error(
						'A failed or unchecked step needs a note: what goes wrong, or why it was not checked.'
					);
				reported.push({ step, result, ...(note ? { note } : {}) });
			}
			const steps = smokeReportSteps(run.steps, reported),
				counts = smokeCounts(steps);
			this.disarm();
			await this.deps.emit({
				kind: 'smoke.reported',
				id: run.id,
				steps,
				summary,
				elapsedMs: Math.max(0, (run.stoppedAt ?? this.now()) - run.startedAt),
				...(run.cause ? { stopped: run.cause } : {}),
			});
			// An ask still in the queue belongs to this run: it must not reach the next one.
			await this.deps.dropAsks().catch(() => {});
			return {
				reported: true,
				failed: counts.failed,
				unchecked: counts.unchecked,
				next: counts.failed
					? 'Fix each failed step now; the review before the pull request reads this report.'
					: 'Go on with the task.',
			};
		});
	}
	/** spec/smoke-run#limit: the person's `+5 min` on the deck row, while the run runs. */
	extend(id: string) {
		return this.serial(async () => {
			const run = this.run();
			if (run?.id !== id || run.state !== 'running') return;
			const limitMs = Math.min(
				smokeLimits.maxMinutes * minute,
				run.limitMs + smokeLimits.extendMinutes * minute
			);
			if (limitMs === run.limitMs) return;
			await this.deps.emit({ kind: 'smoke.extended', id, limitMs, by: 'person' });
			this.arm();
		});
	}
	/** spec/smoke-run#limit: the person's `Stop` on the deck row. */
	stop(id: string) {
		return this.serial(async () => {
			const run = this.run();
			if (run?.id !== id || run.state !== 'running') return;
			await this.halt('person');
		});
	}
	/**
	 * After the host loaded its journal: arm the limit for the time left, or stop a run whose limit passed while the host was down; a run that
	 * waits for its report and has no ask on its way is asked again (the host may have stopped before it asked, or during the ask's turn).
	 */
	load() {
		return this.serial(async () => {
			const run = this.run();
			if (run?.state === 'running') {
				if (run.startedAt + run.limitMs <= this.now()) await this.halt('limit');
				else this.arm();
			} else if (run?.state === 'stopped' && !this.deps.busy()) await this.ask(run);
		});
	}
	/**
	 * spec/smoke-run#limit: a turn ended (`seq` — its `turn.completed`) with the run still open. A stopped turn drops the run; a turn that was
	 * the ask and ended without the report drops it; otherwise the host asks once, unless an ask waits in the queue.
	 */
	turnEnded(cancelled: boolean, seq: number) {
		return this.serial(async () => {
			const run = this.run();
			if (!smokeOpen(run) || this.deps.stopping()) return;
			if (cancelled || askEnded(this.deps.records(), run.id, seq)) {
				await this.drop(run, cancelled ? 'cancelled' : 'no-report');
				return;
			}
			await this.ask(run);
		});
	}
	/** One ask for the report as a prompt (marker `smoke-report`), unless one waits in the queue or this host already sent one. */
	private async ask(run: SmokeRun) {
		if (this.asked === run.id || asksWaiting(this.deps.records(), run.id)) return;
		await this.deps.prompt(run.state === 'stopped' ? smokeReportDue(run) : stillOpen);
		this.asked = run.id;
	}
	private async drop(run: SmokeRun, reason: 'cancelled' | 'no-report') {
		this.disarm();
		await this.deps.emit({
			kind: 'smoke.dropped',
			id: run.id,
			reason,
			elapsedMs: Math.max(0, this.now() - run.startedAt),
		});
		await this.deps.dropAsks().catch(() => {});
	}
	private startSeq(records: readonly EventRecord[], id: string) {
		return (
			records.find((record) => record.event.kind === 'smoke.started' && record.event.id === id)
				?.seq ?? 0
		);
	}
	/** spec/smoke-run#ready: `ready_to_look(screen, where, tab?)`. */
	ready(params: unknown) {
		return this.serial(async () => {
			if (!this.deps.eligible) throw new Error('Method is not available to this role');
			const input = isRecord(params) ? params : {};
			const screen = typeof input.screen === 'string' ? input.screen.trim() : '',
				where = input.where;
			if (!screen || screen.length > smokeLimits.screen)
				throw new Error(`screen is 1–${smokeLimits.screen} characters`);
			if (where !== 'simulator' && where !== 'browser')
				throw new Error('where is simulator or browser');
			const modules = this.deps.modules();
			if (!modules[where])
				throw new Error(
					where === 'simulator'
						? 'The simulator is off in Settings.'
						: 'The browser is off in Settings.'
				);
			const records = this.deps.records();
			if (readyScreens(records).has(readyScreenKey(screen)))
				return {
					notified: false,
					reason: `The person was already told that ${screen} is ready to look at.`,
				};
			const target = await this.target(where, records, input.tab);
			await this.deps.emit({ kind: 'task.ready', id: randomUUID(), screen, where, ...target });
			return { notified: true };
		});
	}
	private async target(
		where: ReadyWhere,
		records: readonly EventRecord[],
		tab: unknown
	): Promise<{ device?: string; tab?: string; url?: string }> {
		if (where === 'simulator') {
			const device = records.findLast((record) => record.event.kind === 'simulator.device')?.event;
			if (device?.kind !== 'simulator.device')
				throw new Error('Open the screen on the device first with simulator_open.');
			return { device: device.device };
		}
		const page = await this.deps.page(typeof tab === 'string' ? tab : undefined).catch(() => null);
		if (!page?.url) throw new Error('Open the page first with browser_open.');
		return { tab: page.tab, url: page.url };
	}
	/** spec/smoke-run#limit: stop the run and ask for the report — into the running turn, else as a prompt. */
	private async halt(cause: SmokeStopCause) {
		const run = this.run();
		if (run?.state !== 'running') return;
		this.disarm();
		await this.deps.emit({ kind: 'smoke.stopped', id: run.id, cause });
		const stopped = this.run();
		if (!stopped || this.deps.stopping()) return;
		const text = smokeReportDue(stopped);
		if (this.deps.busy()) {
			// No steering, or declined: the refused tools say it, and the turn's end asks again.
			await this.deps.steer(text).catch(() => false);
			return;
		}
		await this.ask(stopped);
	}
	private arm() {
		this.disarm();
		const run = this.run();
		if (run?.state !== 'running') return;
		const left = run.startedAt + run.limitMs - this.now(),
			id = run.id;
		// setTimeout holds at most ~24.8 days; a limit is at most an hour.
		this.timer = setTimeout(
			() => {
				this.timer = null;
				// The callback may wait behind a `+5 min` or a new run: it stops only the same run past its own limit.
				void this.serial(async () => {
					const now = this.run();
					if (now?.id !== id || now.state !== 'running') return;
					if (now.startedAt + now.limitMs <= this.now()) await this.halt('limit');
					else this.arm();
				}).catch(() => {});
			},
			Math.max(0, left)
		);
		this.timer.unref?.();
	}
	private disarm() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
	dispose() {
		this.disarm();
	}
}
