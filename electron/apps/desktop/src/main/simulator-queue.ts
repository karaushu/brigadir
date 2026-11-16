import type { TaskKey } from '@brigadir/core';
/**
 * spec/browser-and-simulator#sim-lease, spec/agents-and-providers#tools-awareness: one lane per device. Tasks whose leases are on the same
 * device take it in turns; tasks on different devices never wait for each other. The first `simulator_*` call of a task takes the
 * device; other tasks wait until it is released — the end of the holder's turn or `idleMs` without a call — in the order they asked.
 * The person, the foreman and a solo agent go first: they also wait for the holder to release the device, but stand in the lane ahead
 * of every waiting worker. The lane has no limit; a waiting call gives up after `waitMs` with a sentence for the agent.
 */
export const simulatorBusyMessage =
	'The simulator is busy: another agent of the crew is using it. Do other work and retry later.';
type Waiter = {
	key: TaskKey;
	/** The person, the foreman or a solo agent: ahead of the workers in the lane. */
	first: boolean;
	resolve(): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};
type Lane = {
	holder: TaskKey | null;
	running: number;
	idle: ReturnType<typeof setTimeout> | undefined;
	waiters: Waiter[];
};
export type SimulatorQueueOptions = {
	waitMs?: number;
	idleMs?: number;
	/** The tasks of a project waiting for any of its devices now, in queue order (the card line `Waiting for the simulator`). */
	onWaiting?(projectId: string, ids: string[]): void;
	/** A lane's holder or waiters changed: the pickers redraw who holds what. */
	onChange?(device: string): void;
};
const same = (a: TaskKey | null, b: TaskKey) => !!a && a.projectId === b.projectId && a.id === b.id;
export class SimulatorQueue {
	private lanes = new Map<string, Lane>();
	private waitMs: number;
	private idleMs: number;
	constructor(private options: SimulatorQueueOptions = {}) {
		this.waitMs = options.waitMs ?? 60_000;
		this.idleMs = options.idleMs ?? 60_000;
	}
	private lane(device: string): Lane {
		let lane = this.lanes.get(device);
		if (!lane) {
			lane = { holder: null, running: 0, idle: undefined, waiters: [] };
			this.lanes.set(device, lane);
		}
		return lane;
	}
	/** Who holds a device now. */
	holder(device: string): TaskKey | null {
		return this.lanes.get(device)?.holder ?? null;
	}
	/** The device a task waits for now, if any. */
	waitsFor(key: TaskKey): string | null {
		for (const [device, lane] of this.lanes)
			if (lane.waiters.some((waiter) => same(waiter.key, key))) return device;
		return null;
	}
	/** The tasks of a project waiting in any lane, in the order they asked within each lane. */
	waiting(projectId: string): string[] {
		const ids: string[] = [];
		for (const lane of this.lanes.values())
			for (const waiter of lane.waiters)
				if (waiter.key.projectId === projectId && !ids.includes(waiter.key.id))
					ids.push(waiter.key.id);
		return ids;
	}
	/** Runs one simulator call of a task on a device; `queued` — a crew worker, which waits behind the person, the foreman and a solo agent. */
	async run<T>(device: string, key: TaskKey, queued: boolean, work: () => Promise<T>): Promise<T> {
		const lane = this.lane(device);
		if (lane.holder === null || same(lane.holder, key)) this.take(device, lane, key);
		else await this.wait(device, key, lane, !queued);
		lane.running++;
		clearTimeout(lane.idle);
		try {
			return await work();
		} finally {
			lane.running--;
			if (!lane.running) this.armIdle(device, lane);
		}
	}
	/** The turn of a task ended (or its session failed or stopped): every device it holds goes to the next task in line. */
	release(key: TaskKey) {
		for (const [device, lane] of this.lanes) if (same(lane.holder, key)) this.next(device, lane);
	}
	/** A task left a device (its lease moved, or the device is gone): it neither holds it nor waits for it. */
	leave(device: string, key: TaskKey) {
		const lane = this.lanes.get(device);
		if (!lane) return;
		const leaving = lane.waiters.filter((waiter) => same(waiter.key, key));
		lane.waiters = lane.waiters.filter((waiter) => !same(waiter.key, key));
		for (const waiter of leaving) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error('The task moved to another device.'));
		}
		if (same(lane.holder, key)) this.next(device, lane);
		else if (leaving.length) this.changed(device, key.projectId);
	}
	private take(device: string, lane: Lane, key: TaskKey) {
		const changed = !same(lane.holder, key);
		lane.holder = key;
		if (changed) this.options.onChange?.(device);
	}
	private wait(device: string, key: TaskKey, lane: Lane, first: boolean) {
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				key,
				first,
				resolve,
				reject,
				timer: setTimeout(() => {
					lane.waiters = lane.waiters.filter((item) => item !== waiter);
					this.changed(device, key.projectId);
					reject(new Error(simulatorBusyMessage));
				}, this.waitMs),
			};
			// The person, the foreman and a solo agent stand after the others like them, ahead of every worker.
			const at = first ? lane.waiters.findIndex((item) => !item.first) : -1;
			if (at < 0) lane.waiters.push(waiter);
			else lane.waiters.splice(at, 0, waiter);
			this.changed(device, key.projectId);
		});
	}
	private armIdle(device: string, lane: Lane) {
		clearTimeout(lane.idle);
		if (lane.holder === null) return;
		const holder = lane.holder;
		lane.idle = setTimeout(() => {
			if (lane.holder === holder && !lane.running) this.next(device, lane);
		}, this.idleMs);
		lane.idle.unref?.();
	}
	/** The first waiting task takes the device; all of its waiting calls go on together. */
	private next(device: string, lane: Lane) {
		clearTimeout(lane.idle);
		const previous = lane.holder,
			first = lane.waiters[0];
		lane.holder = first?.key ?? null;
		if (!first) {
			this.options.onChange?.(device);
			return;
		}
		const granted = lane.waiters.filter((waiter) => same(waiter.key, first.key));
		lane.waiters = lane.waiters.filter((waiter) => !same(waiter.key, first.key));
		for (const waiter of granted) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.changed(device, first.key.projectId);
		if (previous && previous.projectId !== first.key.projectId)
			this.options.onWaiting?.(previous.projectId, this.waiting(previous.projectId));
		// A worker that got the device and then makes no call keeps it no longer than an idle holder would.
		if (!lane.running) this.armIdle(device, lane);
	}
	private changed(device: string, projectId: string) {
		this.options.onWaiting?.(projectId, this.waiting(projectId));
		this.options.onChange?.(device);
	}
}
