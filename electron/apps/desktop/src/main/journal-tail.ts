import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isRecord, isSessionEvent, type EventRecord, type TaskKey } from '@brigadir/core';
import { safePath, type SessionStore } from '@brigadir/persistence';
/** Bounded complete JSONL records only; never follow a journal symlink. */
export async function journalTail(store: SessionStore, key: TaskKey) {
	let file;
	try {
		file = await open(
			await safePath(await store.taskDir(key), 'events.jsonl'),
			constants.O_RDONLY | constants.O_NOFOLLOW
		);
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') return [];
		throw error;
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error('Invalid journal');
		const length = Math.min(stat.size, 65536),
			buffer = Buffer.alloc(length),
			{ bytesRead } = await file.read(buffer, 0, length, stat.size - length);
		let text = buffer.subarray(0, bytesRead).toString('utf8');
		if (stat.size > length) {
			const start = text.indexOf('\n');
			if (start < 0) return [];
			text = text.slice(start + 1);
		}
		const end = text.lastIndexOf('\n');
		if (end < 0) return [];
		const records: EventRecord[] = [];
		for (const line of text.slice(0, end).split('\n')) {
			if (!line) continue;
			const value: unknown = JSON.parse(line);
			if (
				!isRecord(value) ||
				value.schemaVersion !== 1 ||
				!Number.isSafeInteger(value.seq) ||
				Number(value.seq) < 1 ||
				typeof value.at !== 'string' ||
				!isSessionEvent(value.event)
			)
				throw new Error('Invalid journal tail');
			records.push(value as EventRecord);
		}
		return records;
	} finally {
		await file.close();
	}
}
