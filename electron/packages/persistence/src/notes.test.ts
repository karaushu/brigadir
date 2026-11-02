import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { NotesStore } from './notes';
test('keeps a note as a plain .md file with its project and tasks beside it', async () => {
	const root = await mkdtemp(join(tmpdir(), 'notes-'));
	try {
		const store = new NotesStore(root);
		const id = await store.create('business', '# Checkout після релізу 57\n\n- Кнопка «Далі»\n');
		expect(await readFile(join(root, 'notes', `${id}.md`), 'utf8')).toBe(
			'# Checkout після релізу 57\n\n- Кнопка «Далі»\n'
		);
		const meta = JSON.parse(await readFile(join(root, 'notes', `${id}.json`), 'utf8'));
		expect(meta).toMatchObject({ schemaVersion: 1, project: 'business', tasks: [] });
		await store.addTask(id, { taskId: 'phone-checks', projectId: 'business' });
		await store.setProject(id, null);
		expect(await store.read(id)).toMatchObject({
			id,
			title: 'Checkout після релізу 57',
			project: null,
			tasks: 1,
		});
		await store.write(id, 'Ідеї на тиждень\n');
		expect((await store.list()).map((n) => n.title)).toEqual(['Ідеї на тиждень']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('reads a note written by hand without its JSON and skips other files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'notes-'));
	try {
		const store = new NotesStore(root);
		await store.dir();
		await writeFile(join(root, 'notes', 'note-hand1.md'), '## Hand made');
		await writeFile(join(root, 'notes', 'README.txt'), 'not a note');
		await writeFile(join(root, 'notes', 'other.md'), 'not a note id');
		expect(await store.list()).toEqual([
			expect.objectContaining({ id: 'note-hand1', title: 'Hand made', project: null, tasks: 0 }),
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('deletes the text, the JSON and the chat folder; a late save does not bring the note back', async () => {
	const root = await mkdtemp(join(tmpdir(), 'notes-'));
	try {
		const store = new NotesStore(root);
		const id = await store.create(null);
		await writeFile(join(await store.noteDir(id), 'chat.jsonl'), '');
		await store.delete(id);
		await expect(store.write(id, 'late')).rejects.toThrow();
		expect(await readdir(join(root, 'notes'))).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('refuses ids that are not note ids', async () => {
	const root = await mkdtemp(join(tmpdir(), 'notes-'));
	try {
		const store = new NotesStore(root);
		await expect(store.read('../settings')).rejects.toThrow();
		await expect(store.write('settings', 'x')).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("links a task under the lines it came from and keeps it among the note's tasks", async () => {
	const root = await mkdtemp(join(tmpdir(), 'notes-'));
	try {
		const store = new NotesStore(root);
		const id = await store.create(null, '# Bugs\n- one\n- two\n');
		await store.linkTask(id, { projectId: 'business', taskId: 'phone' }, 'Phone checks', 2);
		expect((await store.read(id)).text).toBe(
			'# Bugs\n- one\n→ [Phone checks](brigadir://task/business/phone)\n- two\n'
		);
		expect((await store.read(id)).tasks).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
