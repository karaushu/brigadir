import {
	sessionStateOnly,
	type EventRecord,
	type SessionSnapshot,
	type TaskKey,
} from '@brigadir/core';
const batch = new Map<string, Promise<SessionSnapshot>>();
/**
 * Opening a task mounts Conversation and TaskView together and both read the journal (CHAT-07). Reads issued for the same
 * task and cursor in one synchronous run share one IPC reply. The batch closes at the next microtask, so no session event
 * can arrive between a caller's subscription and a read it joins. The reply is shared: callers must not mutate it.
 */
export function readSession(task: TaskKey, afterSeq = 0): Promise<SessionSnapshot> {
	const id = `${task.projectId}/${task.id}/${afterSeq}`;
	let read = batch.get(id);
	if (!read) {
		read = window.brigadir.readSession(task, afterSeq || undefined);
		batch.set(id, read);
		queueMicrotask(() => batch.delete(id));
	}
	return read;
}
/** Connected, queued review and pending attachments without any records. */
export function readSessionState(task: TaskKey) {
	return readSession(task, sessionStateOnly);
}
/** Adds records not held yet (held ones win), sorted by seq. Nothing new keeps the held array, so projections stay memoized. */
export function mergeRecords(held: EventRecord[], incoming: readonly EventRecord[]): EventRecord[] {
	if (!held.length) return incoming as EventRecord[];
	const known = new Set(held.map((record) => record.seq)),
		added = incoming.filter((record) => !known.has(record.seq));
	return added.length ? [...held, ...added].sort((a, b) => a.seq - b.seq) : held;
}
/** The last seq up to which sorted `records` continue `afterSeq` without a gap: the cursor for the next tail read. */
export function contiguousSeq(records: readonly EventRecord[], afterSeq: number) {
	let seq = afterSeq;
	for (const record of records) {
		if (record.seq === seq + 1) seq++;
		else if (record.seq > seq + 1) break;
	}
	return seq;
}
/**
 * Full read once, then only tails after what reads delivered. A refresh while a read is in flight runs once more after it,
 * from the new cursor, so a reconnect during the first load still closes any gap. `apply` gets the cursor the read used.
 */
export function sessionReads(
	task: TaskKey,
	apply: (snapshot: SessionSnapshot, afterSeq: number) => void,
	fail: (error: unknown, afterSeq: number) => void = () => {}
) {
	let held = 0,
		reading = false,
		again = false,
		active = true;
	const run = () => {
		reading = true;
		const after = held;
		void readSession(task, after)
			.then(
				(value) => {
					if (!active) return;
					held = contiguousSeq(value.records, after);
					apply(value, after);
				},
				(error) => {
					if (active) fail(error, after);
				}
			)
			.finally(() => {
				reading = false;
				if (again && active) {
					again = false;
					run();
				}
			});
	};
	return {
		refresh() {
			if (!active) return;
			if (reading) {
				again = true;
				return;
			}
			run();
		},
		stop() {
			active = false;
		},
	};
}
/** Records arrive in seq order: append after the last one in O(1); a replayed or out-of-order record takes the slow path. */
function appendRecord(records: EventRecord[], record: EventRecord) {
	const last = records.at(-1);
	if (!last || record.seq > last.seq) return [...records, record];
	return records.some((item) => item.seq === record.seq)
		? records
		: [...records, record].sort((a, b) => a.seq - b.seq);
}
/**
 * The chat's snapshot after one live session event. A null record is metadata, a read mark or a reconnect, not a
 * disconnect: it keeps the connected state and the records; the refresh it triggers brings the host's own state.
 */
export function applySessionEvent(
	current: SessionSnapshot | null,
	key: TaskKey,
	record: EventRecord | null
): SessionSnapshot {
	return {
		key,
		issue: current?.issue ?? null,
		connected: record ? true : Boolean(current?.connected),
		...(record ? { queued: false } : current?.queued ? { queued: true } : {}),
		records: record ? appendRecord(current?.records ?? [], record) : (current?.records ?? []),
	};
}
