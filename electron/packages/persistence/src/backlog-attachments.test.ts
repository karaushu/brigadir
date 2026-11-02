import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attachments, SessionStore } from './index';
const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// spec/tasks#backlog-edit: a launch sheet keeps its attachments in a draft until the task exists; the task adopts them without a copy.
it('keeps sheet draft attachments apart and moves them into the created task', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sheet-draft-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			assets = new Attachments(store);
		const draft = { projectId: project.id, id: '7b0f7c43-4b55-4d55-9d1a-3c3b0c6a1f10' },
			owner = { ...draft, draft: true as const };
		const image = await assets.create(owner, {
				kind: 'image',
				name: 'Pasted image',
				mimeType: 'image/png',
				data: png,
			}),
			notes = await assets.create(owner, {
				kind: 'text',
				name: 'notes.md',
				text: 'File reference',
				fileBytes: 12000,
			});
		expect((await assets.thumbnail(owner, image.id, (bytes) => bytes)).length).toBeGreaterThan(8);
		// A draft is not a task: without the flag the same ID names no task.
		await expect(assets.read(draft, image.id)).rejects.toThrow();
		const task = await store.createTask(
			project.id,
			'fixture',
			'claude',
			'gui',
			'New task',
			'backlog'
		);
		const moved = await assets.adopt(draft, task, [image.id, notes.id]);
		expect(moved.map((item) => item.name)).toEqual(['Pasted image', 'notes.md']);
		expect((await assets.read(task, image.id)).input.kind).toBe('image');
		expect(await assets.list(task, [notes.id])).toEqual([notes]);
		await expect(stat(await store.draftDir(draft))).rejects.toThrow();
		await expect(assets.list(task, Array(11).fill(image.id))).rejects.toThrow();
		// A draft left by a crash goes away on the next start.
		await assets.create(
			{ projectId: project.id, id: '8b0f7c43-4b55-4d55-9d1a-3c3b0c6a1f10', draft: true },
			{ kind: 'text', name: 'left', text: 'x' }
		);
		await store.clearDrafts();
		await expect(stat(join(store.root, 'drafts'))).rejects.toThrow();
		const updated = await store.updateTask(task, { attachments: moved });
		expect(updated.attachments).toHaveLength(2);
		await expect(
			store.updateTask(task, {
				attachments: Array.from({ length: 11 }, (_, index) => ({
					...moved[0]!,
					id: `${'0'.repeat(7)}${index % 10}-0000-4000-8000-00000000000${index % 10}`,
				})),
			})
		).rejects.toThrow('Invalid task');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
