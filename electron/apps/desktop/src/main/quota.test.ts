import { describe, expect, it } from 'vitest';
import type { EventRecord, QuotaReading, QuotaSnapshot } from '@brigadir/core';
import { Quota, testQuota, type QuotaReaders } from './quota';

const reading = (id: string, remaining: number): QuotaReading => ({
	id,
	kind: id === 'five_hour' ? 'five-hour' : 'weekly',
	model: null,
	minutes: id === 'five_hour' ? 300 : 10080,
	remaining,
	resetsAt: 2_000_000_000,
	exhausted: false,
});
function clock() {
	let now = 1_000_000;
	const timers = new Map<number, { at: number; run: () => void }>();
	let next = 0;
	return {
		now: () => now,
		setTimeout: (run: () => void, ms: number) => {
			const id = ++next;
			timers.set(id, { at: now + ms, run });
			return id;
		},
		clearTimeout: (id: unknown) => {
			timers.delete(id as number);
		},
		pending: () => [...timers.values()].map((timer) => timer.at - now),
		async advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.run();
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}
const record = (event: EventRecord['event'], at = '2026-09-24T10:00:00.000Z'): EventRecord => ({
	schemaVersion: 1,
	seq: 1,
	at,
	event,
});
const key = { projectId: 'p', id: 't' };
function setup(readers: Partial<QuotaReaders> = {}, provider: 'claude' | 'codex' = 'claude') {
	const time = clock(),
		published: QuotaSnapshot[] = [],
		calls = { claude: 0, codex: 0 };
	const quota = new Quota(
		{
			claude: async () => {
				calls.claude++;
				return readers.claude
					? await readers.claude()
					: { windows: [reading('five_hour', 0.5)], access: 'subscription', plan: 'Team' };
			},
			codex: async () => {
				calls.codex++;
				return readers.codex
					? await readers.codex()
					: { windows: [reading('codex:10080', 0.55)], access: 'subscription', plan: 'Business' };
			},
		},
		async () => provider,
		(snapshot) => published.push(snapshot),
		{ clock: time }
	);
	return { quota, time, published, calls };
}
const entry = (snapshot: QuotaSnapshot, provider: 'claude' | 'codex') =>
	snapshot.providers.find((item) => item.provider === provider)!;

describe('main quota', () => {
	it('folds journal readings into one global snapshot and publishes each change', () => {
		const { quota, published } = setup();
		quota.observe(
			key,
			record({
				kind: 'quota.observed',
				provider: 'claude',
				complete: false,
				windows: [reading('five_hour', 0.38)],
			})
		);
		quota.observe(
			{ projectId: 'p', id: 'other' },
			record(
				{
					kind: 'quota.observed',
					provider: 'claude',
					complete: false,
					windows: [reading('seven_day', 0.74)],
				},
				'2026-09-24T10:01:00.000Z'
			)
		);
		expect(
			entry(quota.read(), 'claude').windows.map((window) => [window.id, window.remaining])
		).toEqual([
			['five_hour', 0.38],
			['seven_day', 0.74],
		]);
		expect(published).toHaveLength(2);
	});
	it('reads at most once a minute and shares one read between callers', async () => {
		const { quota, time, calls } = setup();
		await Promise.all([quota.refresh('claude'), quota.refresh('claude')]);
		expect(calls.claude).toBe(1);
		expect(entry(quota.read(), 'claude')).toMatchObject({ plan: 'Team', access: 'subscription' });
		await quota.refresh('claude');
		expect(calls.claude).toBe(1);
		await time.advance(60_000);
		await quota.refresh('claude');
		expect(calls.claude).toBe(2);
	});
	it('keeps the last values when a read fails or returns nothing', async () => {
		let fail = false;
		const { quota, time } = setup({
			claude: async () => {
				if (fail) throw new Error('429');
				return { windows: [reading('five_hour', 0.5)], access: 'subscription', plan: null };
			},
		});
		await quota.refresh('claude');
		fail = true;
		await time.advance(61_000);
		await quota.refresh('claude');
		expect(entry(quota.read(), 'claude').windows).toHaveLength(1);
		expect(entry(quota.read(), 'claude').plan).toBeNull();
	});
	it('polls Codex while it works, faster as the window runs out, and stops when idle', async () => {
		let left = 0.55;
		const { quota, time, calls } = setup(
			{
				codex: async () => ({
					windows: [reading('codex:10080', left)],
					access: 'subscription',
					plan: 'Business',
				}),
			},
			'codex'
		);
		quota.observe(key, record({ kind: 'turn.started', text: 'go' }));
		await time.advance(0);
		expect(time.pending()).toEqual([60_000]);
		await time.advance(60_000);
		expect(calls.codex).toBe(1);
		expect(time.pending()).toEqual([60_000]);
		left = 0.08;
		await time.advance(60_000);
		expect(calls.codex).toBe(2);
		expect(time.pending()).toEqual([15_000]);
		await time.advance(10 * 60_000);
		await time.advance(60_000);
		expect(time.pending()).toEqual([]);
		quota.close();
	});
	it('turn boundaries of Claude tasks never start the Codex reader', async () => {
		const { quota, time, calls } = setup({}, 'claude');
		quota.observe(key, record({ kind: 'turn.completed', reason: 'end_turn' }));
		await time.advance(0);
		expect(calls.codex).toBe(0);
		expect(time.pending()).toEqual([]);
	});
	it('an API key login has no subscription windows', async () => {
		const { quota } = setup({
			codex: async () => ({ windows: [], access: 'api-key', plan: null }),
		});
		await quota.refresh('codex');
		expect(entry(quota.read(), 'codex')).toMatchObject({ access: 'api-key', windows: [] });
	});
	it('refreshes both providers every ten minutes while visible and catches up a missed tick when shown', async () => {
		let visible = true;
		const { quota, time, calls } = setup();
		quota.background(() => visible);
		await time.advance(10 * 60_000);
		expect(calls).toEqual({ claude: 1, codex: 1 });
		visible = false;
		await time.advance(10 * 60_000);
		expect(calls).toEqual({ claude: 1, codex: 1 });
		quota.shown();
		expect(calls).toEqual({ claude: 1, codex: 1 });
		visible = true;
		quota.shown();
		await time.advance(0);
		expect(calls).toEqual({ claude: 2, codex: 2 });
		quota.shown();
		await time.advance(0);
		expect(calls).toEqual({ claude: 2, codex: 2 });
		await time.advance(10 * 60_000);
		expect(calls).toEqual({ claude: 3, codex: 3 });
		quota.close();
		await time.advance(10 * 60_000);
		expect(calls).toEqual({ claude: 3, codex: 3 });
		expect(time.pending()).toEqual([]);
	});
	it('keeps the eye choice per provider across a restart and ignores a broken file', async () => {
		const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const dir = await mkdtemp(join(tmpdir(), 'brigadir-quota-view-')),
			viewFile = join(dir, 'quota-view.json');
		try {
			const first = new Quota(
				{ claude: async () => null, codex: async () => null },
				async () => null,
				() => {},
				{ viewFile }
			);
			await first.watch('claude', 'seven_day');
			await first.watch('codex', 'codex:10080');
			await first.watch('codex', null);
			expect(JSON.parse(await readFile(viewFile, 'utf8'))).toEqual({
				schemaVersion: 1,
				watch: { claude: 'seven_day', codex: null },
			});
			const published: QuotaSnapshot[] = [],
				second = new Quota(
					{ claude: async () => null, codex: async () => null },
					async () => null,
					(snapshot) => published.push(snapshot),
					{ viewFile }
				);
			await second.loadView();
			expect(entry(second.read(), 'claude').watch).toBe('seven_day');
			expect(published).toHaveLength(1);
			await writeFile(viewFile, '{broken');
			const third = new Quota(
				{ claude: async () => null, codex: async () => null },
				async () => null,
				() => {},
				{ viewFile }
			);
			await third.loadView();
			expect(entry(third.read(), 'claude').watch).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it('pins a test snapshot and drops malformed entries', () => {
		const snapshot = testQuota(
			JSON.stringify({
				providers: [
					{
						provider: 'claude',
						plan: 'Team',
						access: 'subscription',
						windows: [
							{ ...reading('five_hour', 0.38), observedAt: 5 },
							{ id: 'bad', kind: 'weekly', remaining: 3 },
						],
					},
					{ provider: 'gemini', windows: [] },
				],
			})
		);
		expect(entry(snapshot, 'claude')).toMatchObject({
			plan: 'Team',
			access: 'subscription',
			windows: [{ id: 'five_hour', remaining: 0.38, observedAt: 5 }],
		});
		expect(entry(snapshot, 'codex').windows).toEqual([]);
		expect(testQuota('{').providers).toHaveLength(2);
	});
});
