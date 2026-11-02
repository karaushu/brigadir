import { test, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { TaskLabels } from './task-labels';
test('serializes manual title and pin separately from live task metadata and persists both across restart', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-labels-'));
	try {
		await mkdir(join(root, 'repo'));
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(join(root, 'repo')),
			task = await store.createTask(project.id, 'Original prompt', 'claude'),
			labels = new TaskLabels(store.root),
			path = join(await store.taskDir(task), 'task.json'),
			before = await readFile(path);
		await Promise.all([labels.rename(task, '  Назва людини  '), labels.pin(task, true)]);
		expect(await readFile(path)).toEqual(before);
		await store.updateTask(task, {
			title: 'Updated automatic title',
			prompt: 'Edited backlog prompt',
			activitySeq: 9,
		});
		const restored = new TaskLabels(store.root);
		expect(await restored.task(await store.task(task))).toMatchObject({
			title: 'Назва людини',
			pinned: true,
			prompt: 'Edited backlog prompt',
			activitySeq: 9,
		});
		await restored.pin(task, false);
		expect(await restored.task(task)).toMatchObject({ title: 'Назва людини', pinned: false });
		expect(() => labels.rename(task, '  ')).toThrow('Invalid');
		expect(() => labels.rename(task, 'a\nb')).toThrow('Invalid');
		expect(() => labels.rename(task, 'x'.repeat(161))).toThrow('Invalid');
		await expect(labels.rename({ ...task, id: 'missing' }, 'No task')).rejects.toThrow();
		expect(labels.isSaving).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('never overwrites unsupported presentation metadata, surfaces the issue and retries after repair', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-labels-error-'));
	try {
		await mkdir(join(root, 'repo'));
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(join(root, 'repo')),
			task = await store.createTask(project.id, 'Original', 'claude'),
			labels = new TaskLabels(store.root),
			path = join(store.root, 'task-labels.json');
		await labels.pin(task, true);
		await writeFile(path, '{"schemaVersion":99,"labels":{}}');
		await expect(labels.rename(task, 'Blocked')).rejects.toThrow();
		expect(await readFile(path, 'utf8')).toBe('{"schemaVersion":99,"labels":{}}');
		expect(
			(await labels.decorate({ projects: [project], tasks: [task], issues: [] })).issues
		).toEqual([{ path: 'task-labels.json', code: 'unreadable' }]);
		await writeFile(path, '{"schemaVersion":1,"labels":{}}');
		await labels.rename(task, 'Repaired');
		expect(await labels.title(task, 'fallback')).toBe('Repaired');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
