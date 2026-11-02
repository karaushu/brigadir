import { test, expect } from 'vitest';
import { blockedRateLimit, reduceRateLimits, isRateReset, rateLimits } from './rate-limit';
import { promptQueue } from './prompt-queue';
import type { SessionEvent, EventRecord } from './session';
const records = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date(100000 + index).toISOString(),
		event,
	}));
const rejected: SessionEvent = {
	kind: 'rate-limit.changed',
	status: 'rejected',
	window: 'five_hour',
	resetsAt: 200,
};
const queued: SessionEvent = {
	kind: 'prompt.queued',
	prompt: {
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		command: { kind: 'prompt', text: 'next' },
		attachments: [],
	},
};
test('uses only structured rejection, keeps independent windows and never invents an unknown reset', () => {
	let limits = reduceRateLimits([], rejected);
	expect(blockedRateLimit(limits, 100000)).toEqual({ resetsAt: 200 });
	expect(blockedRateLimit(limits, 200000)).toBeNull();
	limits = reduceRateLimits(limits, { ...rejected, window: 'weekly', resetsAt: null });
	expect(blockedRateLimit(limits, 300000)).toEqual({ resetsAt: null });
	limits = reduceRateLimits(limits, { ...rejected, status: 'allowed', window: 'five_hour' });
	expect(blockedRateLimit(limits, 100000)).toEqual({ resetsAt: null });
	limits = reduceRateLimits(limits, { ...rejected, status: 'allowed_warning', window: 'weekly' });
	expect(limits).toEqual([]);
	expect(isRateReset(Infinity)).toBe(false);
	expect(isRateReset(-1)).toBe(false);
	expect(isRateReset(1e30)).toBe(false);
});
test('an old expiry cannot clear a newer rejection and queued recovery does not undo an explicit pause', () => {
	expect(
		reduceRateLimits([{ window: 'five_hour', resetsAt: 300 }], {
			kind: 'rate-limit.expired',
			window: 'five_hour',
			resetsAt: 200,
		})
	).toEqual([{ window: 'five_hour', resetsAt: 300 }]);
	const expiry: SessionEvent = { kind: 'rate-limit.expired', window: 'five_hour', resetsAt: 200 };
	const events: SessionEvent[] = [
		rejected,
		{ kind: 'session.failed', message: 'Adapter ended the turn' },
		expiry,
	];
	expect(promptQueue(records(events)).paused).toBe(false);
	expect(rateLimits(records(events))).toEqual([]);
	expect(promptQueue(records([{ kind: 'queue.paused' }, ...events])).paused).toBe(true);
	expect(
		promptQueue(records([queued, { kind: 'session.failed', message: 'Ordinary failure' }])).paused
	).toBe(true);
	expect(
		promptQueue(
			records([
				queued,
				{ ...rejected, status: 'allowed_warning' },
				{ kind: 'session.failed', message: 'Ordinary failure' },
			])
		).paused
	).toBe(true);
});
