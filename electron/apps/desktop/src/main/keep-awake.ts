import type { KeepAwakeStatus, TaskStatus } from '@brigadir/core';
/**
 * spec/architecture-and-platform#keep-awake: agents that work now — a task `working` with a live host, read like the sidebar reads it. `needs-you`
 * (waiting for the person), queued and preparing tasks do not hold the computer.
 */
export function workingAgents(tasks: readonly { status: TaskStatus }[]): number {
	return tasks.filter((task) => task.status === 'working').length;
}
/** Session events that may change a task's status: each one recounts (debounced). */
export const keepAwakeKinds: ReadonlySet<string> = new Set([
	'turn.started',
	'turn.completed',
	'permission.requested',
	'permission.resolved',
	'question.requested',
	'question.resolved',
	'task.proposal.requested',
	'task.proposal.resolved',
	'crew.plan.requested',
	'crew.plan.resolved',
	'session.failed',
	'host.stopped',
	'rate-limit.changed',
	'rate-limit.expired',
	'crew.accepted',
]);
export type KeepAwakeDeps = {
	/** Tasks whose agent works now: status `working` with a live host (spec/architecture-and-platform#keep-awake). */
	count(): Promise<number>;
	/** Settings ▸ Agents ▸ «Keep awake» (`agents.keepAwake`). */
	enabled(): boolean;
	/** spec/remote-access-and-mobile#architecture: remote access is on — hold the machine awake with no agent working and whatever the switch says. */
	held?(): boolean;
	/** `powerSaveBlocker` in the app; a fake in tests. */
	blocker: { start(): number; stop(id: number): void };
	/** Every change of the count or of the hold; Settings show it. */
	changed(status: KeepAwakeStatus): void;
	log(line: string): void;
};
export type KeepAwakeTimes = { releaseMs: number; debounceMs: number; pollMs: number };
export const keepAwakeTimes: KeepAwakeTimes = {
	releaseMs: 30_000,
	debounceMs: 500,
	pollMs: 60_000,
};
/**
 * spec/architecture-and-platform#keep-awake: one `prevent-app-suspension` blocker while at least one agent works. The last one stopping releases it 30 s later,
 * so the pause between turns of a queue or a crew does not flip the assertion; work coming back meanwhile cancels the release.
 * The switch turned off releases at once. Counts run one at a time; a request during a count runs one more after it.
 */
export class KeepAwake {
	private id: number | null = null;
	private working = 0;
	private sent = '';
	private release: ReturnType<typeof setTimeout> | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private poll: ReturnType<typeof setInterval> | null = null;
	private counting: Promise<void> | null = null;
	private again = false;
	private stopped = false;
	constructor(
		private deps: KeepAwakeDeps,
		private times: KeepAwakeTimes = keepAwakeTimes
	) {}
	status(): KeepAwakeStatus {
		return { working: this.working, holding: this.id !== null };
	}
	/** The first count now, then on events (`refresh`) and once a minute for hosts main has not attached to yet. */
	start() {
		this.stopped = false;
		if (!this.poll) {
			this.poll = setInterval(() => this.refresh(), this.times.pollMs);
			this.poll.unref?.();
		}
		void this.recount();
	}
	/** An event that may change a task's status: one count after a short quiet. */
	refresh() {
		if (this.stopped || this.debounce) return;
		this.debounce = setTimeout(() => {
			this.debounce = null;
			void this.recount();
		}, this.times.debounceMs);
	}
	/** The switch changed: off releases at once, on counts again. */
	settingChanged() {
		this.apply(this.working);
		void this.recount();
	}
	recount(): Promise<void> {
		if (this.counting) {
			this.again = true;
			return this.counting;
		}
		const run = (async () => {
			do {
				this.again = false;
				// Nothing to hold with the switch off: no workspace read either.
				if (!this.deps.enabled()) {
					if (!this.stopped) this.apply(0);
					continue;
				}
				let count: number;
				try {
					count = await this.deps.count();
				} catch (error) {
					this.deps.log(
						`keep-awake: agents could not be counted: ${error instanceof Error ? error.message : String(error)}`
					);
					continue;
				}
				if (!this.stopped) this.apply(count);
			} while (this.again && !this.stopped);
		})().finally(() => {
			this.counting = null;
		});
		this.counting = run;
		return run;
	}
	/** The decision itself, synchronous: take, keep, schedule the release or release now. */
	apply(count: number) {
		this.working = count;
		const held = this.deps.held?.() ?? false;
		if ((this.deps.enabled() && count > 0) || held) {
			this.cancelRelease();
			if (this.id === null) this.id = this.deps.blocker.start();
		} else if (this.id !== null) {
			if (!this.deps.enabled()) this.drop();
			else if (!this.release) {
				this.release = setTimeout(() => {
					this.release = null;
					this.drop();
					this.publish();
				}, this.times.releaseMs);
				this.release.unref?.();
			}
		}
		this.publish();
	}
	/** Quit: timers stop and the blocker goes (process exit would drop it too). */
	stop() {
		this.stopped = true;
		for (const timer of [this.release, this.debounce]) if (timer) clearTimeout(timer);
		if (this.poll) clearInterval(this.poll);
		this.release = this.debounce = this.poll = null;
		this.drop();
	}
	private cancelRelease() {
		if (this.release) {
			clearTimeout(this.release);
			this.release = null;
		}
	}
	private drop() {
		this.cancelRelease();
		if (this.id === null) return;
		const id = this.id;
		this.id = null;
		try {
			this.deps.blocker.stop(id);
		} catch (error) {
			this.deps.log(
				`keep-awake: the blocker could not be stopped: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	private publish() {
		const status = this.status(),
			key = JSON.stringify(status);
		if (key === this.sent) return;
		this.sent = key;
		this.deps.changed(status);
	}
}
