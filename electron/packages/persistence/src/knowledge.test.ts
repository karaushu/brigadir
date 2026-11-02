import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { emptyJournalCursor } from '@brigadir/core';
import { scanQuestions } from './knowledge';
const record = (seq: number, event: unknown) =>
	JSON.stringify({ schemaVersion: 1, seq, at: '2026-09-21', event }) + '\n';
const question = {
	id: 'q',
	question: 'How do we run tests?',
	header: 'Tests',
	options: [],
	allowsFreeText: true,
	allowsMultiple: false,
};
test('resumes partial UTF-8 lines across restarts, pairs only structured answers, and counts oversized turns', async () => {
	const root = await mkdtemp(join(tmpdir(), 'knowledge-scan-')),
		path = join(root, 'events.jsonl');
	try {
		const data =
			record(1, { kind: 'turn.started', text: 'x'.repeat(180000) }) +
			record(2, {
				kind: 'message.delta',
				role: 'assistant',
				content: { kind: 'text', text: 'question.requested: invented answer' },
			}) +
			record(3, { kind: 'question.requested', question }) +
			record(4, {
				kind: 'question.resolved',
				id: 'q',
				answer: { labels: [], text: 'Запусти pnpm test' },
			});
		await writeFile(path, data.slice(0, -9));
		let cursor = emptyJournalCursor(),
			found: any[] = [];
		for (let i = 0; i < 30; i++) {
			const result = await scanQuestions(path, 'task-a', cursor, 9000);
			expect(result.bytes).toBeLessThanOrEqual(9000);
			cursor = JSON.parse(JSON.stringify(result.cursor));
			found.push(...result.exchanges);
			if (!result.bytes) break;
		}
		expect(found).toEqual([]);
		expect(cursor.turn).toBe(1);
		await appendFile(path, data.slice(-9));
		const result = await scanQuestions(path, 'task-a', cursor);
		expect(result.exchanges).toEqual([
			{
				taskId: 'task-a',
				questionId: 'q',
				turn: 1,
				seq: 3,
				question: question.question,
				answer: 'Запусти pnpm test',
			},
		]);
		expect((await scanQuestions(path, 'task-a', result.cursor)).exchanges).toEqual([]);
		await writeFile(
			path,
			record(1, { kind: 'question.requested', question }) +
				record(2, { kind: 'question.resolved', id: 'q', answer: null })
		);
		expect((await scanQuestions(path, 'task-a', result.cursor)).exchanges).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
import { readKnowledgeFile, replaceKnowledgeFile } from './knowledge-file';
import { symlink, readFile } from 'node:fs/promises';
test('append/undo compare whole contents, preserve foreign edits and refuse symlinks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'knowledge-file-'));
	try {
		await replaceKnowledgeFile(root, 'CLAUDE.md', null, 'First\n');
		expect(await readKnowledgeFile(root, 'CLAUDE.md')).toBe('First\n');
		await expect(replaceKnowledgeFile(root, 'CLAUDE.md', null, 'Oops')).rejects.toThrow('changed');
		await replaceKnowledgeFile(root, 'CLAUDE.md', 'First\n', 'First\n\nTests\n');
		await writeFile(join(root, 'CLAUDE.md'), 'Foreign\n\nTests\n');
		await expect(
			replaceKnowledgeFile(root, 'CLAUDE.md', 'First\n\nTests\n', 'First\n')
		).rejects.toThrow('changed');
		expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('Foreign\n\nTests\n');
		await symlink(join(root, 'CLAUDE.md'), join(root, 'link.md'));
		await expect(
			replaceKnowledgeFile(root, 'link.md', 'Foreign\n\nTests\n', 'Oops')
		).rejects.toThrow();
		await replaceKnowledgeFile(root, 'new.md', null, 'New\n');
		await replaceKnowledgeFile(root, 'new.md', 'New\n', null);
		expect(await readKnowledgeFile(root, 'new.md')).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
