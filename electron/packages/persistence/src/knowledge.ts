import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
	emptyJournalCursor,
	isRecord,
	isSessionEvent,
	knowledgeAnswer,
	type JournalCursor,
	type KnowledgeExchange,
} from '@brigadir/core';
/** One bounded read. Non-question JSON (including tool output) is never parsed. */
export async function scanQuestions(
	path: string,
	taskId: string,
	previous: JournalCursor,
	budget = 256 * 1024
): Promise<{ cursor: JournalCursor; exchanges: KnowledgeExchange[]; bytes: number }> {
	let file;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT')
			return { cursor: previous, exchanges: [], bytes: 0 };
		throw error;
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error('Invalid journal');
		const identity = `${stat.dev}:${stat.ino}`;
		const cursor =
			identity === previous.identity && stat.size >= previous.offset
				? structuredClone(previous)
				: emptyJournalCursor();
		cursor.identity = identity;
		const bytes = Buffer.alloc(Math.min(Math.max(0, stat.size - cursor.offset), budget));
		const read = await file.read(bytes, 0, bytes.length, cursor.offset);
		cursor.offset += read.bytesRead;
		let buffer = Buffer.concat([
			Buffer.from(cursor.carry, 'base64'),
			bytes.subarray(0, read.bytesRead),
		]);
		cursor.carry = '';
		const exchanges: KnowledgeExchange[] = [];
		let start = 0;
		while (start < buffer.length) {
			const end = buffer.indexOf(10, start);
			if (end < 0) break;
			const line = buffer.subarray(start, end);
			start = end + 1;
			if (cursor.discard) {
				cursor.discard = false;
				continue;
			}
			const header = line.subarray(0, 512).toString('utf8');
			if (/"kind"\s*:\s*"turn.started"/.test(header)) cursor.turn++;
			if (line.length > 64 * 1024 || !header.includes('"question.')) continue;
			let record: unknown;
			try {
				record = JSON.parse(line.toString('utf8'));
			} catch {
				continue;
			}
			if (
				!isRecord(record) ||
				record.schemaVersion !== 1 ||
				!Number.isInteger(record.seq) ||
				!isSessionEvent(record.event)
			)
				continue;
			const event = record.event;
			if (event.kind === 'question.requested') {
				Object.defineProperty(cursor.pending, event.question.id, {
					value: { question: event.question, turn: cursor.turn, seq: record.seq as number },
					enumerable: true,
					writable: true,
					configurable: true,
				});
				while (Object.keys(cursor.pending).length > 32)
					delete cursor.pending[Object.keys(cursor.pending)[0]!];
			}
			if (event.kind === 'question.resolved') {
				const pending = Object.hasOwn(cursor.pending, event.id)
					? cursor.pending[event.id]
					: undefined;
				delete cursor.pending[event.id];
				if (pending && event.answer) {
					const answer = knowledgeAnswer(event.answer);
					if (answer.trim())
						exchanges.push({
							taskId,
							questionId: event.id,
							turn: pending.turn,
							seq: pending.seq,
							question: pending.question.question.slice(0, 8000),
							answer,
						});
				}
			}
		}
		buffer = buffer.subarray(start);
		if (!cursor.discard) {
			if (buffer.length > 64 * 1024) {
				if (/"kind"\s*:\s*"turn.started"/.test(buffer.subarray(0, 512).toString('utf8')))
					cursor.turn++;
				cursor.discard = true;
			} else cursor.carry = buffer.toString('base64');
		}
		return { cursor, exchanges, bytes: read.bytesRead };
	} finally {
		await file.close();
	}
}
