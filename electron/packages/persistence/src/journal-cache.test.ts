import { expect, it } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session';
import { JournalCache, JsonlCache, journalLine, lastSessionStart } from './journal-cache';
const line = (seq: number, text = 'x') =>
	`${JSON.stringify({ schemaVersion: 1, seq, at: '2026-09-23T00:00:00.000Z', event: { kind: 'message.delta', role: 'assistant', messageId: null, content: { kind: 'text', text } } })}\n`;
it('returns what store.journal returns while parsing each appended line once', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-journal-cache-'));
	try {
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(root),
			task = await store.createTask(project.id, 'Cache', 'claude'),
			path = join(await store.taskDir(task), 'events.jsonl');
		let parsed = 0;
		const files = new JsonlCache((text, count) => {
				parsed++;
				return journalLine(text, count);
			}),
			cache = new JournalCache();
		const same = async () => {
			const [expected, actual] = await Promise.all([store.journal(task), cache.read(store, task)]);
			expect(actual).toEqual(expected);
			return actual;
		};
		await same();
		await writeFile(path, line(1) + line(2, 'ї'.repeat(50)));
		await same();
		expect((await files.read(path)).items).toHaveLength(2);
		expect(parsed).toBe(2);
		const kept = (await cache.read(store, task)).records;
		await files.read(path);
		expect(parsed).toBe(2);
		// A half-written line is an issue until its end arrives; the earlier array stays as it was.
		const third = line(3, 'тест');
		await appendFile(path, third.slice(0, 20));
		expect((await same()).issue).toBe('incomplete_record');
		await appendFile(path, third.slice(20));
		expect((await same()).records).toHaveLength(3);
		expect(kept).toHaveLength(2);
		await files.read(path);
		expect(parsed).toBe(3);
		// A broken line stops the journal there, exactly like the full read.
		await appendFile(path, '{"schemaVersion":1,"seq":9}\n' + line(5));
		expect((await same()).issue).toBe('invalid_document');
		// Rewritten or shrunk files are read again from the start.
		await writeFile(path, line(1, 'new'));
		expect((await same()).records).toHaveLength(1);
		await truncate(path, 0);
		expect(await same()).toEqual({ records: [], issue: null });
		await rm(path);
		expect(await same()).toEqual({ records: [], issue: null });
		// Concurrent reads of one file do not parse the same bytes twice.
		await writeFile(path, Array.from({ length: 50 }, (_, index) => line(index + 1)).join(''));
		parsed = 0;
		const [a, b] = await Promise.all([files.read(path), files.read(path)]);
		expect(a.items).toHaveLength(50);
		expect(b.items).toHaveLength(50);
		expect(parsed).toBe(50);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('finds the last session start from the end, across chunk edges, ignoring markers inside text', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-last-start-'));
	try {
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(root),
			task = await store.createTask(project.id, 'Start', 'claude'),
			path = join(await store.taskDir(task), 'events.jsonl');
		expect(await lastSessionStart(store, task)).toBeNull();
		const record = (seq: number, event: unknown) =>
			`${JSON.stringify({ schemaVersion: 1, seq, at: '2026-09-23T00:00:00.000Z', event })}\n`;
		const start = (seq: number, id: string) =>
			record(seq, { kind: 'session.started', sessionId: id, modes: [], modeId: null, options: [] });
		let text = start(1, 'first'),
			seq = 1;
		for (let i = 0; i < 3000; i++) text += line(++seq, '"kind":"session.started" '.repeat(8));
		text += start(++seq, 'second');
		for (let i = 0; i < 3000; i++) text += line(++seq, 'ї'.repeat(60));
		await writeFile(path, text);
		expect(
			(await store.journal(task)).records.findLast((r) => r.event.kind === 'session.started')?.event
		).toEqual(await lastSessionStart(store, task));
		expect((await lastSessionStart(store, task))?.sessionId).toBe('second');
		// A half-written start at the end is not a record yet.
		await appendFile(path, start(++seq, 'third').slice(0, -10));
		expect((await lastSessionStart(store, task))?.sessionId).toBe('second');
		await writeFile(path, start(1, 'only') + line(2, 'x'.repeat(600_000)));
		expect((await lastSessionStart(store, task))?.sessionId).toBe('only');
		await writeFile(
			path,
			start(1, 'first') +
				Array.from({ length: 3000 }, (_, index) =>
					line(index + 2, '"kind":"session.started" '.repeat(8))
				).join('')
		);
		expect((await lastSessionStart(store, task))?.sessionId).toBe('first');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
