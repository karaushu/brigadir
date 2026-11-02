import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './index';
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-writer-'));
	dirs.push(root);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(root);
	const task = await store.createTask(project.id, 'Test', 'codex');
	return { root, store, task, dir: await store.taskDir(task) };
}
it('serializes acknowledged records and preserves extra metadata on atomic status changes', async () => {
	const { store, task, dir } = await setup();
	const path = join(dir, 'task.json');
	const doc = JSON.parse(await readFile(path, 'utf8'));
	doc.extra = 'retain';
	doc.task.extra = [42];
	await writeFile(path, JSON.stringify(doc));
	const writer = await store.writer(task);
	const records = await Promise.all(
		Array.from({ length: 20 }, (_, i) => writer.append({ kind: 'turn.started', text: `turn ${i}` }))
	);
	await writer.close();
	expect(records.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	expect(await store.journal(task)).toEqual({ records, issue: null });
	await store.setStatus(task, 'done');
	expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
		extra: 'retain',
		task: { extra: [42], status: 'done' },
	});
});
it.each(['{"schemaVersion":99,"seq":1,"event":{}}\n', '{"schemaVersion":1'])(
	'refuses to append to incompatible or torn journal without changing bytes',
	async (contents) => {
		const { store, task, dir } = await setup();
		const path = join(dir, 'events.jsonl');
		await writeFile(path, contents);
		expect((await store.journal(task)).issue).not.toBeNull();
		await expect(store.writer(task)).rejects.toThrow();
		expect(await readFile(path, 'utf8')).toBe(contents);
	}
);
it('rejects symlink destinations and future task schemas before writes', async () => {
	const { store, task, dir, root } = await setup();
	const outside = join(root, 'outside');
	await writeFile(outside, 'untouched');
	await symlink(outside, join(dir, 'events.jsonl'));
	await expect(store.writer(task)).rejects.toThrow('unsafe_path');
	expect(await readFile(outside, 'utf8')).toBe('untouched');
	const path = join(dir, 'task.json');
	const value = JSON.stringify({ schemaVersion: 99, task });
	await writeFile(path, value);
	await expect(store.setStatus(task, 'working')).rejects.toThrow('unsupported_schema');
	expect(await readFile(path, 'utf8')).toBe(value);
});
it('syncs streamed records together and every other record before it returns', async () => {
	const { store, task } = await setup();
	const { open } = await import('node:fs/promises');
	const { vi } = await import('vitest');
	const probe = await open(join(tmpdir(), `brigadir-probe-${process.pid}`), 'w');
	const prototype = Object.getPrototypeOf(probe);
	await probe.close();
	const sync = vi.spyOn(prototype, 'sync');
	try {
		const writer = await store.writer(task);
		sync.mockClear();
		const deltas = await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				writer.append({
					kind: 'message.delta',
					role: 'assistant',
					messageId: 'm',
					content: { kind: 'text', text: `t${index}` },
				})
			)
		);
		expect(deltas.map((record) => record.seq)).toEqual(
			Array.from({ length: 200 }, (_, index) => index + 1)
		);
		expect(sync.mock.calls.length).toBeLessThanOrEqual(1);
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' } as Parameters<
			typeof writer.append
		>[0]);
		const afterBoundary = sync.mock.calls.length;
		expect(afterBoundary).toBeGreaterThanOrEqual(1);
		await writer.append({
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'm',
			content: { kind: 'text', text: 'tail' },
		});
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(sync.mock.calls.length).toBe(afterBoundary + 1);
		await writer.close();
		const journal = await store.journal(task);
		expect(journal.issue).toBeNull();
		expect(journal.records).toHaveLength(202);
	} finally {
		sync.mockRestore();
	}
});
it('stamps completedAt on completion, drops it on any other status, archives and restores the status (spec/tasks#archive)', async () => {
	const { store, task } = await setup();
	await store.setStatus(task, 'completed');
	const completed = await store.task(task);
	expect(completed.completedAt).toBeTruthy();
	await store.setStatus(task, 'completed');
	expect((await store.task(task)).completedAt).toBe(completed.completedAt);
	await store.setStatus(task, 'interrupted');
	expect((await store.task(task)).completedAt).toBeUndefined();
	await store.stampCompleted(task, '2026-01-01T00:00:00.000Z');
	expect((await store.task(task)).completedAt).toBeUndefined();
	await store.setStatus(task, 'done');
	const archived = await store.archive(task, {
		at: '2026-10-06T10:00:00.000Z',
		by: 'manual',
		status: 'done',
		worktree: 'none',
	});
	expect(archived).toMatchObject({ status: 'done', archived: { by: 'manual', status: 'done' } });
	await store.setStatus(task, 'interrupted');
	expect((await store.task(task)).archived?.status).toBe('done');
	const restored = await store.unarchive(task);
	expect(restored.status).toBe('done');
	expect(restored.archived).toBeUndefined();
	expect((await store.unarchive(task)).status).toBe('done');
	await expect(
		store.archive(task, { at: 'never', by: 'manual', status: 'done', worktree: 'none' })
	).rejects.toThrow('Invalid task');
});
