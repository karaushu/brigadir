import { expect, it, vi } from 'vitest';
import type { EventRecord, SessionSnapshot } from '@brigadir/core';
import {
	applySessionEvent,
	contiguousSeq,
	mergeRecords,
	readSession,
	sessionReads,
} from './session-read';
const record = (seq: number): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-09-23T00:00:00.000Z',
	event: { kind: 'turn.started', text: String(seq) },
});
const task = { projectId: 'p', id: 't' };
it('opens a task with one full read shared by its views, then reads only tails', async () => {
	let journal = [record(1), record(2), record(3)];
	const calls: (number | undefined)[] = [];
	let release: () => void = () => {};
	let hold = false;
	const readSessionIpc = vi.fn(
		async (_key: unknown, afterSeq?: number): Promise<SessionSnapshot> => {
			calls.push(afterSeq);
			if (hold)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return {
				key: task,
				records: journal.filter((item) => item.seq > (afterSeq ?? 0)),
				connected: true,
				issue: null,
			};
		}
	);
	(globalThis as any).window = { brigadir: { readSession: readSessionIpc } };
	// Conversation and TaskView mount in one commit: before CHAT-07 each pulled the whole journal.
	const [a, b] = await Promise.all([readSession(task), readSession(task)]);
	expect(a).toBe(b);
	expect(calls).toEqual([undefined]);
	// A later read is not joined to a finished batch.
	await readSession(task);
	expect(calls).toHaveLength(2);
	calls.length = 0;
	const applied: number[][] = [];
	hold = true;
	const reads = sessionReads(task, (value) => applied.push(value.records.map((item) => item.seq)));
	reads.refresh();
	await vi.waitFor(() => expect(calls).toEqual([undefined]));
	// Null events during the first load collapse into one tail after it.
	reads.refresh();
	reads.refresh();
	journal = [...journal, record(4)];
	hold = false;
	release();
	await vi.waitFor(() => expect(applied).toEqual([[1, 2, 3, 4], []]));
	expect(calls).toEqual([undefined, 4]);
	journal = [...journal, record(5)];
	reads.refresh();
	await vi.waitFor(() => expect(applied.at(-1)).toEqual([5]));
	expect(calls.at(-1)).toBe(4);
	reads.refresh();
	await vi.waitFor(() => expect(calls.at(-1)).toBe(5));
	reads.stop();
});
it('merges tails without replacing the held array when nothing is new', () => {
	const held = [record(1), record(2)];
	expect(mergeRecords(held, [record(2)])).toBe(held);
	expect(mergeRecords(held, [record(4), record(3)]).map((item) => item.seq)).toEqual([1, 2, 3, 4]);
	expect(contiguousSeq([record(3), record(4), record(6)], 2)).toBe(4);
	expect(contiguousSeq([], 7)).toBe(7);
});
it('a live event without a record keeps the chat connected and its records: no disconnected strip over a live host', () => {
	let snapshot: SessionSnapshot | null = applySessionEvent(null, task, record(1));
	expect(snapshot).toMatchObject({ connected: true, queued: false });
	// Metadata, read marks and lock changes arrive as null records, often in bursts.
	for (let i = 0; i < 20; i++) snapshot = applySessionEvent(snapshot, task, null);
	expect(snapshot.connected).toBe(true);
	expect(snapshot.records.map((item) => item.seq)).toEqual([1]);
	// A null event never connects a session that was not connected, and keeps a queued start queued.
	const queued = applySessionEvent(
		{ key: task, records: [], connected: false, issue: 'gone', queued: true },
		task,
		null
	);
	expect(queued).toMatchObject({ connected: false, issue: 'gone', queued: true });
});
it('live records append in seq order and a replayed one is not doubled', () => {
	let snapshot = applySessionEvent(null, task, record(1));
	snapshot = applySessionEvent(snapshot, task, record(3));
	snapshot = applySessionEvent(snapshot, task, record(2));
	snapshot = applySessionEvent(snapshot, task, record(3));
	expect(snapshot.records.map((item) => item.seq)).toEqual([1, 2, 3]);
});
