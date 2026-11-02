import { expect, it } from 'vitest';
import { refreshFlight } from './refresh-flight';

/**
 * spec/pull-requests-and-ci#reading-and-refresh: the race behind the flaky ⌘R step of `pull-requests.spec.ts`. In the PR, Refresh reads the PR and the list;
 * the PR half answers first, the person (or ⌘R) asks again while the list half still reads. The old guard dropped that
 * request, so a change made after the first read never showed. Now it runs one more pass, started after the request.
 */
function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it('runs one more pass for a request made during a read, however many came, and only after the read ends', async () => {
	// The «GitHub» value each pass sees is the one current when the pass starts.
	let remote = 'v2';
	const seen: string[] = [],
		passes: ReturnType<typeof deferred>[] = [],
		busy: boolean[] = [];
	const flight = refreshFlight(
		() => {
			seen.push(remote);
			const pass = deferred();
			passes.push(pass);
			return pass.promise;
		},
		(value) => busy.push(value)
	);
	const first = flight.request();
	expect(seen).toEqual(['v2']);
	expect(flight.reading).toBe(true);
	// The PR changes on GitHub and ⌘R comes while the first pass still reads: no second read beside it…
	remote = 'v3';
	const again = flight.request(),
		more = flight.request();
	expect(seen).toEqual(['v2']);
	expect(again).toBe(first);
	expect(more).toBe(first);
	// …but one after it, which sees the change.
	passes[0]!.resolve();
	await tick();
	expect(seen).toEqual(['v2', 'v3']);
	expect(flight.reading).toBe(true);
	passes[1]!.resolve();
	await first;
	expect(seen).toEqual(['v2', 'v3']);
	expect(flight.reading).toBe(false);
	// Busy once for the whole run, not per pass: the glyph keeps turning.
	expect(busy).toEqual([true, false]);
	// A request after the run starts a new one.
	const next = flight.request();
	expect(next).not.toBe(first);
	expect(seen).toEqual(['v2', 'v3', 'v3']);
	passes[2]!.resolve();
	await next;
	expect(busy).toEqual([true, false, true, false]);
});

it('keeps going after a failed pass and ends busy', async () => {
	const passes: ReturnType<typeof deferred>[] = [];
	let calls = 0;
	const flight = refreshFlight(() => {
		calls++;
		const pass = deferred();
		passes.push(pass);
		return pass.promise;
	});
	const run = flight.request();
	flight.request();
	passes[0]!.reject(new Error('network'));
	await tick();
	expect(calls).toBe(2);
	passes[1]!.resolve();
	await expect(run).resolves.toBeUndefined();
	expect(flight.reading).toBe(false);
});
