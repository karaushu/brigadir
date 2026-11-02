import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, readWorkspace } from '@brigadir/persistence';
import { taskActivity, type EventRecord, type SessionEvent } from '@brigadir/core';
import { TaskActivities } from './task-activity';
const records = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: new Date().toISOString(),
		event,
	}));
test('keeps patch title/path across updates but clears at input and turn boundaries', () => {
	const tool: SessionEvent = {
			kind: 'tool.changed',
			patch: {
				id: 'edit',
				title: 'Edit',
				locations: [{ path: '/repo/file.ts', line: null }],
				status: 'in_progress',
			},
		},
		question: SessionEvent = {
			kind: 'question.requested',
			question: {
				id: 'q',
				question: 'Which branch?',
				header: 'Branch',
				options: [],
				allowsFreeText: true,
				allowsMultiple: false,
			},
		};
	expect(
		taskActivity(
			records([tool, { kind: 'tool.changed', patch: { id: 'edit', status: 'completed' } }])
		)
	).toEqual({ kind: 'tool', title: 'Edit', path: '/repo/file.ts' });
	expect(taskActivity(records([tool, question]))).toEqual({
		kind: 'question',
		title: 'Which branch?',
		path: null,
	});
	expect(
		taskActivity(records([tool, question, { kind: 'question.resolved', id: 'q', answer: null }]))
	).toBeNull();
	expect(taskActivity(records([tool, { kind: 'turn.completed', reason: 'end_turn' }]))).toBeNull();
});
test('uses a bounded complete journal tail and never reads a linked journal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-activity-'));
	try {
		await mkdir(join(root, 'repo'));
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(join(root, 'repo')),
			task = await store.createTask(project.id, 'Activity', 'claude');
		await store.setStatus(task, 'working');
		const path = join(await store.taskDir(task), 'events.jsonl'),
			events = records([
				{
					kind: 'message.delta',
					role: 'assistant',
					messageId: null,
					content: { kind: 'text', text: 'x'.repeat(100000) },
				},
				{
					kind: 'tool.changed',
					patch: { id: 'edit', title: 'Edit', locations: [{ path: 'file.ts', line: null }] },
				},
			]);
		await writeFile(path, events.map((record) => JSON.stringify(record) + '\n').join(''));
		const activities = new TaskActivities(store.root),
			read = async () => activities.decorate(await readWorkspace({ dataDir: store.root }));
		expect((await read()).tasks[0]?.activity).toEqual({
			kind: 'tool',
			title: 'Edit',
			path: 'file.ts',
		});
		await appendFile(path, '{"unfinished":');
		expect((await read()).tasks[0]?.activity?.title).toBe('Edit');
		await writeFile(
			path,
			JSON.stringify({
				...events[1],
				seq: 3,
				event: { kind: 'turn.completed', reason: 'end_turn' },
			}) + '\n'
		);
		expect((await read()).tasks[0]?.activity).toBeNull();
		await rm(path);
		await symlink(join(root, 'repo', 'secret'), path);
		expect((await read()).issues[0]?.code).toBe('unreadable');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
