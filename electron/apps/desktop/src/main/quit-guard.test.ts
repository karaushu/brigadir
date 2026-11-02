import { test, expect } from 'vitest';
import { QuitGuard, type PendingWrite } from './quit-guard';
const write = (name: string, wait: () => Promise<unknown>, busy = true): PendingWrite => ({
	name,
	busy: () => busy,
	wait,
});
test('a failed write settles its wait and the continuation runs after the current event, not inside it', async () => {
	const log: string[] = [],
		guard = new QuitGuard((text) => log.push(text));
	const order: string[] = [];
	// The stale rejected tail that once stranded quit inside Promise.all.
	const settled = guard
		.settle('quit', [
			write('taskReads', () => Promise.reject(new Error('disk full'))),
			write('layout', async () => {}),
			write('idle', () => new Promise(() => {}), false),
		])
		.then(() => order.push('continued'));
	await Promise.resolve();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	order.push('event returned');
	await settled;
	expect(order).toEqual(['event returned', 'continued']);
	expect(log).toEqual(['[quit] quit: taskReads failed: disk full']);
});
test('names what a quit still waits for and gives up at the deadline', async () => {
	const log: string[] = [],
		guard = new QuitGuard((text) => log.push(text), 120, 40, 10);
	const writes = [write('consoles', () => new Promise(() => {})), write('files', async () => {})];
	expect(guard.busy(writes)).toEqual(['consoles', 'files']);
	// Without a quit request a window close waits as long as its writes take.
	let closed = false;
	void guard.settle('close', writes).then(() => {
		closed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 160));
	expect(closed).toBe(false);
	expect(log.some((line) => /^\[quit\] close: waiting \d+ s for consoles$/.test(line))).toBe(true);
	guard.begin();
	await new Promise((resolve) => setTimeout(resolve, 160));
	expect(closed).toBe(true);
	expect(log.filter((line) => line.includes('gave up'))[0]).toMatch(
		/^\[quit\] close: gave up after \d+ s waiting for consoles; quitting without them$/
	);
	expect(guard.busy(writes)).toEqual([]);
	await guard.run('quit', 'consoles', () => new Promise(() => {}));
	guard.cancel();
	expect(guard.busy(writes)).toEqual(['consoles', 'files']);
});
