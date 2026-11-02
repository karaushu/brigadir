import type { TaskKey } from '@brigadir/core';
/**
 * spec/agents-and-providers#tools-awareness: the project has one simulator device, so crew workers take it in turns. The first `simulator_*` call of a
 * worker takes the device; other workers wait until it is released — the end of the holder's turn or `idleMs` without a
 * call — in the order they asked. The foreman and a solo agent go first: they also wait for the holder to release the
 * device, but stand in the queue ahead of every waiting worker.
 * The queue has no limit; a waiting call gives up after `waitMs` with a sentence for the agent.
 */
export const simulatorBusyMessage =
	'The simulator is busy: another agent of the crew is using it. Do other work and retry later.';
type Waiter = {
	id: string;
	/** The foreman or a solo agent: ahead of the workers in the queue. */
	first: boolean;
	resolve(): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};
type Lane = {
	holder: string | null;
	running: number;
	idle: ReturnType<typeof setTimeout> | undefined;
	waiters: Waiter[];
};
export type SimulatorQueueOptions = {
	waitMs?: number;
	idleMs?: number;
	/** The tasks of a project waiting for its device now, in queue order (the card line `Чекає симулятор`). */
	onWaiting?(projectId: string, ids: string[]): void;
};
export class SimulatorQueue {
	private lanes = new Map<string, Lane>();
	private waitMs: number;
	private idleMs: number;
	constructor(private options: SimulatorQueueOptions = {}) {
		this.waitMs = options.waitMs ?? 60_000;
		this.idleMs = options.idleMs ?? 60_000;
	}
	private lane(projectId: string): Lane {
		let lane = this.lanes.get(projectId);
		if (!lane) {
			lane = { holder: null, running: 0, idle: undefined, waiters: [] };
			this.lanes.set(projectId, lane);
		}
		return lane;
	}
	/** Who holds the device of a project now; for the test. */
	holder(projectId: string): string | null {
		return this.lanes.get(projectId)?.holder ?? null;
	}
	waiting(projectId: string): string[] {
		return [...new Set(this.lanes.get(projectId)?.waiters.map((waiter) => waiter.id) ?? [])];
	}
	/** Runs one simulator call of a task; `queued` — a crew worker, which waits behind the foreman and a solo agent. */
	async run<T>(key: TaskKey, queued: boolean, work: () => Promise<T>): Promise<T> {
		const lane = this.lane(key.projectId);
		if (lane.holder === null || lane.holder === key.id) this.take(lane, key.id);
		else await this.wait(key, lane, !queued);
		lane.running++;
		clearTimeout(lane.idle);
		try {
			return await work();
		} finally {
			lane.running--;
			if (!lane.running) this.armIdle(key.projectId, lane);
		}
	}
	/** The turn of a task ended (or its session failed or stopped): its device goes to the next worker in line. */
	release(key: TaskKey) {
		const lane = this.lanes.get(key.projectId);
		if (lane?.holder === key.id) this.next(key.projectId, lane);
	}
	private take(lane: Lane, id: string) {
		lane.holder = id;
	}
	private wait(key: TaskKey, lane: Lane, first: boolean) {
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				id: key.id,
				first,
				resolve,
				reject,
				timer: setTimeout(() => {
					lane.waiters = lane.waiters.filter((item) => item !== waiter);
					this.changed(key.projectId);
					reject(new Error(simulatorBusyMessage));
				}, this.waitMs),
			};
			// The foreman and a solo agent stand after the others like them, ahead of every worker.
			const at = first ? lane.waiters.findIndex((item) => !item.first) : -1;
			if (at < 0) lane.waiters.push(waiter);
			else lane.waiters.splice(at, 0, waiter);
			this.changed(key.projectId);
		});
	}
	private armIdle(projectId: string, lane: Lane) {
		clearTimeout(lane.idle);
		if (lane.holder === null) return;
		const holder = lane.holder;
		lane.idle = setTimeout(() => {
			if (lane.holder === holder && !lane.running) this.next(projectId, lane);
		}, this.idleMs);
		lane.idle.unref?.();
	}
	/** The first waiting task takes the device; all of its waiting calls go on together. */
	private next(projectId: string, lane: Lane) {
		clearTimeout(lane.idle);
		const first = lane.waiters[0];
		lane.holder = first?.id ?? null;
		if (!first) return;
		const granted = lane.waiters.filter((waiter) => waiter.id === first.id);
		lane.waiters = lane.waiters.filter((waiter) => waiter.id !== first.id);
		for (const waiter of granted) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.changed(projectId);
		// A worker that got the device and then makes no call keeps it no longer than an idle holder would.
		if (!lane.running) this.armIdle(projectId, lane);
	}
	private changed(projectId: string) {
		this.options.onWaiting?.(projectId, this.waiting(projectId));
	}
}
