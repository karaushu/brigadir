import { expect, it } from 'vitest';
import type { EventRecord } from '@brigadir/core';
import { rateLimitKey, readOnlyKey, readOnlyViolations, unavailableKey } from './TaskNotices';

const violation = (seq: number, scopeId: string, paths: string[]): EventRecord =>
	({
		schemaVersion: 1,
		seq,
		at: '2026-10-07T12:00:00Z',
		event: { kind: 'scope.violation', scopeId, name: 'kit', paths, checkpoint: seq },
	}) as unknown as EventRecord;
const task = { projectId: 'p', id: 't' };

it('keeps the last read-only warning per repo and marks the files the one before did not list (spec/notifications-slack-notes-and-schedules#notice-chips)', () => {
	const items = readOnlyViolations([
		violation(1, 'a', ['x.ts']),
		violation(2, 'b', ['y.ts']),
		violation(3, 'a', ['x.ts', 'z.ts']),
	]);
	expect(items.map((item) => [item.scopeId, item.paths, item.fresh])).toEqual([
		['a', ['x.ts', 'z.ts'], ['z.ts']],
		['b', ['y.ts'], []],
	]);
});

it('names a fact by the files in any order, so another file is a new fact', () => {
	expect(readOnlyKey(task, { scopeId: 'a', paths: ['b', 'a'] })).toBe(
		readOnlyKey(task, { scopeId: 'a', paths: ['a', 'b'] })
	);
	expect(readOnlyKey(task, { scopeId: 'a', paths: ['a'] })).not.toBe(
		readOnlyKey(task, { scopeId: 'a', paths: ['a', 'b'] })
	);
	expect(unavailableKey(task, [{ id: 'b' }, { id: 'a' }])).toBe(
		unavailableKey(task, [{ id: 'a' }, { id: 'b' }])
	);
	expect(rateLimitKey(task, 100)).not.toBe(rateLimitKey(task, 200));
	expect(rateLimitKey(task, null)).toBe('ratelimit|p/t|unknown');
});
