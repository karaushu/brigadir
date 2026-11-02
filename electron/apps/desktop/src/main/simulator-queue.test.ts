import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SimulatorQueue, simulatorBusyMessage } from './simulator-queue';
const key = (id: string) => ({ projectId: 'p', id });
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});
/** A call that records when it ran and finishes at once. */
function caller(queue: SimulatorQueue, log: string[]) {
	return (id: string, queued = true) =>
		queue.run(key(id), queued, async () => {
			log.push(id);
			return id;
		});
}

it('gives the device to the first worker and lets the others wait in the order they asked (spec/agents-and-providers#tools-awareness)', async () => {
	const waiting: string[][] = [],
		log: string[] = [];
	const queue = new SimulatorQueue({ onWaiting: (_project, ids) => waiting.push(ids) }),
		call = caller(queue, log);
	await call('a');
	expect(queue.holder('p')).toBe('a');
	const b = call('b'),
		c = call('c');
	await vi.advanceTimersByTimeAsync(0);
	expect(log).toEqual(['a']);
	expect(queue.waiting('p')).toEqual(['b', 'c']);
	// The holder keeps calling without waiting.
	await call('a');
	expect(log).toEqual(['a', 'a']);
	// Its turn ends: the next in line takes the device, the one after it still waits.
	queue.release(key('a'));
	await expect(b).resolves.toBe('b');
	expect(queue.holder('p')).toBe('b');
	expect(queue.waiting('p')).toEqual(['c']);
	queue.release(key('b'));
	await expect(c).resolves.toBe('c');
	expect(log).toEqual(['a', 'a', 'b', 'c']);
	expect(waiting).toEqual([['b'], ['b', 'c'], ['c'], []]);
	// Another project has its own device.
	await expect(queue.run({ projectId: 'q', id: 'x' }, true, async () => 'x')).resolves.toBe('x');
});

it('lets the foreman and a solo agent go first: they wait for the holder, ahead of the workers (spec/agents-and-providers#tools-awareness)', async () => {
	const log: string[] = [];
	const queue = new SimulatorQueue(),
		call = caller(queue, log);
	await call('worker');
	// A second worker asks first, then the foreman and a solo agent: they stand ahead of it, in their own order.
	const second = call('worker2');
	await vi.advanceTimersByTimeAsync(0);
	const foreman = call('foreman', false);
	await vi.advanceTimersByTimeAsync(0);
	const solo = call('solo', false);
	await vi.advanceTimersByTimeAsync(0);
	// The foreman does not take the device from the worker that holds it.
	expect(queue.holder('p')).toBe('worker');
	expect(queue.waiting('p')).toEqual(['foreman', 'solo', 'worker2']);
	queue.release(key('worker'));
	await expect(foreman).resolves.toBe('foreman');
	queue.release(key('foreman'));
	await expect(solo).resolves.toBe('solo');
	queue.release(key('solo'));
	await expect(second).resolves.toBe('worker2');
	expect(log).toEqual(['worker', 'foreman', 'solo', 'worker2']);
});

it('frees the device after 60 s without a call, and gives up a wait after 60 s (spec/agents-and-providers#tools-awareness)', async () => {
	const log: string[] = [];
	const queue = new SimulatorQueue(),
		call = caller(queue, log);
	await call('a');
	const b = call('b');
	await vi.advanceTimersByTimeAsync(59_000);
	expect(log).toEqual(['a']);
	await vi.advanceTimersByTimeAsync(1_000);
	await expect(b).resolves.toBe('b');
	expect(queue.holder('p')).toBe('b');
	// A long call keeps the device while it runs; the minute counts from its end.
	let finish!: () => void;
	const long = queue.run(key('b'), true, () => new Promise<void>((resolve) => (finish = resolve)));
	const c = call('c').catch((error: Error) => error.message);
	await vi.advanceTimersByTimeAsync(60_000);
	// c waited its 60 s while b's call ran: the agent hears that the device is busy.
	await expect(c).resolves.toBe(simulatorBusyMessage);
	expect(queue.waiting('p')).toEqual([]);
	finish();
	await long;
	expect(queue.holder('p')).toBe('b');
	await vi.advanceTimersByTimeAsync(60_000);
	expect(queue.holder('p')).toBe(null);
	// The queue has no limit.
	const many = Array.from({ length: 50 }, (_, index) => call(`w${index}`));
	await vi.advanceTimersByTimeAsync(0);
	expect(queue.holder('p')).toBe('w0');
	expect(queue.waiting('p')).toHaveLength(49);
	for (let index = 0; index < 50; index++) queue.release(key(`w${index}`));
	await Promise.all(many);
	expect(log.slice(-50)).toEqual(Array.from({ length: 50 }, (_, index) => `w${index}`));
});

it('lets several waiting calls of one worker go on together, and ignores the release of a task that holds nothing', async () => {
	const log: string[] = [];
	const queue = new SimulatorQueue(),
		call = caller(queue, log);
	await call('a');
	const first = call('b'),
		second = call('b');
	await vi.advanceTimersByTimeAsync(0);
	expect(queue.waiting('p')).toEqual(['b']);
	queue.release(key('c'));
	expect(queue.holder('p')).toBe('a');
	queue.release(key('a'));
	await expect(Promise.all([first, second])).resolves.toEqual(['b', 'b']);
});
