import { Worker } from 'node:worker_threads';
type Job = {
	data: unknown;
	supersede: string | undefined;
	resolve(value: unknown): void;
	reject(error: Error): void;
};
type Slot = {
	worker: Worker;
	job: Job | null;
	deadline?: ReturnType<typeof setTimeout>;
	idle?: ReturnType<typeof setTimeout>;
};
export type PoolOptions = { size?: number; idleMs?: number; deadlineMs?: number; queue?: number };
/** A queued job whose place a newer one for the same editor/file took; its caller is already stale. */
export class Superseded extends Error {
	constructor() {
		super('Superseded by a newer request');
	}
}
/**
 * Keep-alive workers for one kind of job (perf review R7): no spawn and WASM init per request. A job keeps the old
 * bounds of a per-request worker: a 256 MiB heap, and past the deadline the worker is terminated and replaced.
 * A crash fails only the job it was running. Idle workers exit, so a large parse does not hold memory.
 */
export class WorkerPool {
	private slots: Slot[] = [];
	private queue: Job[] = [];
	constructor(
		readonly path: string,
		readonly options: PoolOptions = {}
	) {}
	get pending() {
		return this.queue.length + this.slots.filter((slot) => slot.job).length;
	}
	/** `supersede` replaces a queued job with the same key; a running one finishes. */
	run<T>(data: unknown, supersede?: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (supersede) {
				const index = this.queue.findIndex((job) => job.supersede === supersede);
				if (index >= 0) this.queue.splice(index, 1)[0]!.reject(new Superseded());
			}
			if (this.queue.length >= (this.options.queue ?? Infinity)) {
				reject(new Error('Worker queue is full'));
				return;
			}
			this.queue.push({ data, supersede, resolve: resolve as (value: unknown) => void, reject });
			this.pump();
		});
	}
	close() {
		for (const slot of [...this.slots]) this.drop(slot, new Error('Worker stopped'));
		for (const job of this.queue.splice(0)) job.reject(new Error('Worker stopped'));
	}
	private pump() {
		while (this.queue.length) {
			let slot = this.slots.find((slot) => !slot.job);
			if (!slot) {
				if (this.slots.length >= (this.options.size ?? 1)) return;
				slot = this.spawn();
			}
			const job = this.queue.shift()!;
			clearTimeout(slot.idle);
			slot.job = job;
			slot.worker.ref();
			const current = slot;
			slot.deadline = setTimeout(() => {
				this.drop(current, new Error('Computation exceeded its resource limit'));
				this.pump();
			}, this.options.deadlineMs ?? 10000);
			slot.worker.postMessage(job.data);
		}
	}
	private spawn() {
		const slot: Slot = {
			worker: new Worker(this.path, { resourceLimits: { maxOldGenerationSizeMb: 256 } }),
			job: null,
		};
		this.slots.push(slot);
		slot.worker.on('message', (reply: { value?: unknown; error?: string }) => {
			const job = slot.job;
			if (!job) return;
			clearTimeout(slot.deadline);
			slot.job = null;
			if (reply.error !== undefined) job.reject(new Error(reply.error));
			else job.resolve(reply.value);
			this.rest(slot);
			this.pump();
		});
		slot.worker.on('error', (error) => {
			this.drop(slot, error);
			this.pump();
		});
		slot.worker.on('exit', () => {
			this.drop(slot, new Error('Worker stopped'));
			this.pump();
		});
		return slot;
	}
	private rest(slot: Slot) {
		if (slot.job || this.queue.length) return;
		slot.worker.unref();
		slot.idle = setTimeout(() => this.drop(slot, null), this.options.idleMs ?? 30000);
		slot.idle.unref();
	}
	private drop(slot: Slot, error: Error | null) {
		const index = this.slots.indexOf(slot);
		if (index < 0) return;
		this.slots.splice(index, 1);
		clearTimeout(slot.deadline);
		clearTimeout(slot.idle);
		const job = slot.job;
		slot.job = null;
		void slot.worker.terminate();
		if (job) job.reject(error ?? new Error('Worker stopped'));
	}
}
