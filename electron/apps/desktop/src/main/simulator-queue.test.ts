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
		queue.run('iphone', key(id), queued, async () => {
			log.push(id);
			return id;
		});
}

it('gives the device to the first worker and lets the others wait in the order they asked (spec/browser-and-simulator#sim-lease)', async () => {
	const waiting: string[][] = [],
		log: string[] = [];
	const queue = new SimulatorQueue({ onWaiting: (_project, ids) => waiting.push(ids) }),
		call = caller(queue, log);
	await call('a');
	expect(queue.holder('iphone')?.id).toBe('a');
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
	expect(queue.holder('iphone')?.id).toBe('b');
	expect(queue.waiting('p')).toEqual(['c']);
	queue.release(key('b'));
	await expect(c).resolves.toBe('c');
	expect(log).toEqual(['a', 'a', 'b', 'c']);
	expect(waiting).toEqual([['b'], ['b', 'c'], ['c'], []]);
	// Another device is another lane.
	await expect(queue.run('ipad', { projectId: 'q', id: 'x' }, true, async () => 'x')).resolves.toBe(
		'x'
	);
});

it('lets the foreman and a solo agent go first: they wait for the holder, ahead of the workers (spec/browser-and-simulator#sim-lease)', async () => {
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
	expect(queue.holder('iphone')?.id).toBe('worker');
	expect(queue.waiting('p')).toEqual(['foreman', 'solo', 'worker2']);
	queue.release(key('worker'));
	await expect(foreman).resolves.toBe('foreman');
	queue.release(key('foreman'));
	await expect(solo).resolves.toBe('solo');
	queue.release(key('solo'));
	await expect(second).resolves.toBe('worker2');
	expect(log).toEqual(['worker', 'foreman', 'solo', 'worker2']);
});

it('frees the device after 60 s without a call, and gives up a wait after 60 s (spec/browser-and-simulator#sim-lease)', async () => {
	const log: string[] = [];
	const queue = new SimulatorQueue(),
		call = caller(queue, log);
	await call('a');
	const b = call('b');
	await vi.advanceTimersByTimeAsync(59_000);
	expect(log).toEqual(['a']);
	await vi.advanceTimersByTimeAsync(1_000);
	await expect(b).resolves.toBe('b');
	expect(queue.holder('iphone')?.id).toBe('b');
	// A long call keeps the device while it runs; the minute counts from its end.
	let finish!: () => void;
	const long = queue.run(
		'iphone',
		key('b'),
		true,
		() => new Promise<void>((resolve) => (finish = resolve))
	);
	const c = call('c').catch((error: Error) => error.message);
	await vi.advanceTimersByTimeAsync(60_000);
	// c waited its 60 s while b's call ran: the agent hears that the device is busy.
	await expect(c).resolves.toBe(simulatorBusyMessage);
	expect(queue.waiting('p')).toEqual([]);
	finish();
	await long;
	expect(queue.holder('iphone')?.id).toBe('b');
	await vi.advanceTimersByTimeAsync(60_000);
	expect(queue.holder('iphone')).toBe(null);
	// The queue has no limit.
	const many = Array.from({ length: 50 }, (_, index) => call(`w${index}`));
	await vi.advanceTimersByTimeAsync(0);
	expect(queue.holder('iphone')?.id).toBe('w0');
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
	expect(queue.holder('iphone')?.id).toBe('a');
	queue.release(key('a'));
	await expect(Promise.all([first, second])).resolves.toEqual(['b', 'b']);
});

it('runs two tasks on two devices at once, and queues two tasks that want the same device (spec/browser-and-simulator#sim-lease)', async () => {
	const queue = new SimulatorQueue(),
		started: string[] = [];
	let finishA!: () => void, finishB!: () => void;
	const a = queue.run('iphone', key('a'), true, () => {
		started.push('a');
		return new Promise<void>((resolve) => (finishA = resolve));
	});
	const b = queue.run('ipad', key('b'), true, () => {
		started.push('b');
		return new Promise<void>((resolve) => (finishB = resolve));
	});
	await vi.advanceTimersByTimeAsync(0);
	// Both calls run together: their devices are different lanes.
	expect(started).toEqual(['a', 'b']);
	expect(queue.holder('iphone')?.id).toBe('a');
	expect(queue.holder('ipad')?.id).toBe('b');
	// A third task wants the iPhone: it waits in that lane only.
	const c = queue.run('iphone', key('c'), true, async () => started.push('c'));
	await vi.advanceTimersByTimeAsync(0);
	expect(queue.waitsFor(key('c'))).toBe('iphone');
	expect(queue.waiting('p')).toEqual(['c']);
	finishA();
	finishB();
	await Promise.all([a, b]);
	queue.release(key('a'));
	await c;
	expect(started).toEqual(['a', 'b', 'c']);
	expect(queue.holder('ipad')?.id).toBe('b');
});

it('lets a task leave a lane when its lease moves: its waits end, its hold passes on', async () => {
	const changes: string[] = [];
	const queue = new SimulatorQueue({ onChange: (device) => changes.push(device) });
	await queue.run('iphone', key('a'), true, async () => null);
	const b = queue
		.run('iphone', key('b'), true, async () => 'b')
		.catch((error: Error) => error.message);
	const c = queue.run('iphone', key('c'), true, async () => 'c');
	await vi.advanceTimersByTimeAsync(0);
	queue.leave('iphone', key('b'));
	await expect(b).resolves.toBe('The task moved to another device.');
	queue.leave('iphone', key('a'));
	await expect(c).resolves.toBe('c');
	expect(queue.holder('iphone')?.id).toBe('c');
	expect(changes.every((device) => device === 'iphone')).toBe(true);
	expect(changes.length).toBeGreaterThan(2);
});
