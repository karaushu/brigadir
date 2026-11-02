import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
	isRecord,
	isSessionEvent,
	type EventRecord,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import { safePath, type SessionStore } from './session';

type Entry<T> = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	offset: number;
	items: readonly T[];
	issue: string | null;
	stopped: boolean;
};
/**
 * An append-only JSONL file parsed once and then read from where the last complete line ended.
 * The identity is (dev, ino, size, mtime): an unchanged file costs one fstat, a grown one reads only the new bytes,
 * anything else (replaced, shrunk, rewritten in place) is read again from the start. Lines split at '\n' bytes,
 * which never occur inside a UTF-8 sequence. `parse` gets the count of accepted lines and throws to stop at a bad
 * line; its message becomes the issue. A returned array never changes afterwards (growth makes a new one), so
 * callers may keep it but must not mutate it. Reads of one path run one at a time; at most `limit` files stay parsed.
 */
export class JsonlCache<T> {
	private entries = new Map<string, Entry<T>>();
	private tails = new Map<string, Promise<unknown>>();
	constructor(
		private parse: (line: string, count: number) => T,
		private limit = 2
	) {}
	read(path: string): Promise<{ items: readonly T[]; issue: string | null }> {
		const next = (this.tails.get(path) ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.readNow(path));
		this.tails.set(path, next);
		void next
			.finally(() => {
				if (this.tails.get(path) === next) this.tails.delete(path);
			})
			.catch(() => {});
		return next;
	}
	private async readNow(path: string): Promise<{ items: readonly T[]; issue: string | null }> {
		let file;
		try {
			file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (e) {
			if (isRecord(e) && e.code === 'ENOENT') {
				this.entries.delete(path);
				return { items: [], issue: null };
			}
			throw e;
		}
		try {
			const stat = await file.stat();
			let entry = this.entries.get(path);
			if (
				entry &&
				(entry.dev !== stat.dev ||
					entry.ino !== stat.ino ||
					stat.size < entry.size ||
					(stat.size === entry.size && stat.mtimeMs !== entry.mtimeMs))
			)
				entry = undefined;
			// The byte before the resume point must still end a line, or the file changed under the cached prefix.
			if (entry && entry.offset > 0 && stat.size > entry.size && !entry.stopped) {
				const probe = Buffer.alloc(1);
				await file.read(probe, 0, 1, entry.offset - 1);
				if (probe[0] !== 0x0a) entry = undefined;
			}
			entry = entry
				? { ...entry }
				: {
						dev: stat.dev,
						ino: stat.ino,
						size: 0,
						mtimeMs: 0,
						offset: 0,
						items: [],
						issue: null,
						stopped: false,
					};
			if (!entry.stopped && stat.size > entry.offset && stat.size !== entry.size) {
				const bytes = Buffer.alloc(stat.size - entry.offset);
				let read = 0;
				while (read < bytes.length) {
					const { bytesRead } = await file.read(
						bytes,
						read,
						bytes.length - read,
						entry.offset + read
					);
					if (!bytesRead) break;
					read += bytesRead;
				}
				const chunk = bytes.subarray(0, read),
					base = entry.offset,
					added: T[] = [];
				let start = 0,
					split: number;
				entry.issue = null;
				while ((split = chunk.indexOf(0x0a, start)) >= 0) {
					try {
						added.push(
							this.parse(chunk.toString('utf8', start, split), entry.items.length + added.length)
						);
					} catch (e) {
						entry.issue = e instanceof Error ? e.message : 'invalid_document';
						entry.stopped = true;
						break;
					}
					start = split + 1;
					entry.offset = base + start;
				}
				if (!entry.stopped && start < chunk.length) entry.issue = 'incomplete_record';
				if (added.length) entry.items = entry.items.concat(added);
			}
			entry.size = stat.size;
			entry.mtimeMs = stat.mtimeMs;
			this.entries.delete(path);
			this.entries.set(path, entry);
			while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
			return { items: entry.items, issue: entry.issue };
		} finally {
			await file.close();
		}
	}
}
/** The same validation as SessionStore.journal: seq runs from 1 without gaps, events are known. */
export function journalLine(line: string, count: number): EventRecord {
	const v: unknown = JSON.parse(line);
	if (!isRecord(v) || !Number.isInteger(v.schemaVersion)) throw new Error('invalid_document');
	if (v.schemaVersion !== 1) throw new Error('unsupported_schema');
	if (v.seq !== count + 1 || typeof v.at !== 'string' || !isSessionEvent(v.event))
		throw new Error('invalid_document');
	return v as EventRecord;
}
/** Task journals read incrementally (perf review CHAT-10, MCP-03): the records and issue of `store.journal`, each appended byte parsed once. */
export class JournalCache {
	private files: JsonlCache<EventRecord>;
	constructor(limit = 2) {
		this.files = new JsonlCache(journalLine, limit);
	}
	async read(
		store: SessionStore,
		key: TaskKey
	): Promise<{ records: readonly EventRecord[]; issue: string | null }> {
		const { items, issue } = await this.files.read(
			await safePath(await store.taskDir(key), 'events.jsonl')
		);
		return { records: items, issue };
	}
}
/**
 * The last `session.started` of a task journal, scanning back from the end: only lines that contain the marker are
 * parsed (APP-05: the New task sheet needs the modes of the latest session, not the history). A marker inside a
 * message is escaped in JSON, and every candidate is validated, so only a real record counts.
 */
export async function lastSessionStart(
	store: SessionStore,
	key: TaskKey
): Promise<Extract<SessionEvent, { kind: 'session.started' }> | null> {
	let file;
	try {
		file = await open(
			await safePath(await store.taskDir(key), 'events.jsonl'),
			constants.O_RDONLY | constants.O_NOFOLLOW
		);
	} catch (e) {
		if (isRecord(e) && e.code === 'ENOENT') return null;
		throw e;
	}
	try {
		const marker = Buffer.from('"kind":"session.started"'),
			chunk = 256 * 1024;
		let position = (await file.stat()).size,
			tail = Buffer.alloc(0);
		while (position > 0) {
			const start = Math.max(0, position - chunk),
				head = Buffer.alloc(position - start);
			let read = 0;
			while (read < head.length) {
				const { bytesRead } = await file.read(head, read, head.length - read, start + read);
				if (!bytesRead) break;
				read += bytesRead;
			}
			// Complete lines begin after the first '\n' unless the chunk starts the file; the cut line waits for the next chunk.
			const buffer = tail.length ? Buffer.concat([head, tail]) : head,
				first = start === 0 ? 0 : buffer.indexOf(0x0a) + 1;
			if (start > 0 && first === 0) {
				tail = buffer;
				position = start;
				continue;
			}
			let hit = buffer.lastIndexOf(marker);
			while (hit >= first) {
				const lineStart = buffer.lastIndexOf(0x0a, hit) + 1,
					lineEnd = buffer.indexOf(0x0a, hit);
				if (lineEnd >= 0) {
					try {
						const value: unknown = JSON.parse(buffer.toString('utf8', lineStart, lineEnd));
						if (
							isRecord(value) &&
							value.schemaVersion === 1 &&
							isSessionEvent(value.event) &&
							value.event.kind === 'session.started'
						)
							return value.event;
					} catch {
						/* not a record */
					}
				}
				hit = lineStart > first ? buffer.lastIndexOf(marker, lineStart - 1) : -1;
			}
			tail = buffer.subarray(0, first);
			position = start;
		}
		return null;
	} finally {
		await file.close();
	}
}
