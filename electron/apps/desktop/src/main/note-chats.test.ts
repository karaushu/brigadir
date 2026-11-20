import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { Attachments, NotesStore, SessionStore } from '@brigadir/persistence';
import { attachmentToken, taskToken, type NoteChatEvent } from '@brigadir/core';
import { NoteChats, projectReference, type NoteChatDeps } from './note-chats';
const fixture = fileURLToPath(
	new URL('../../../../packages/transport/fixtures/agent.mjs', import.meta.url)
);
const roots: string[] = [];
const chats: NoteChats[] = [];
afterEach(async () => {
	for (const chat of chats.splice(0)) chat.closeAll();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(over: Partial<NoteChatDeps> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'note-chat-'));
	roots.push(root);
	const store = new NotesStore(root),
		events: NoteChatEvent[] = [],
		changed: string[] = [];
	const chat = new NoteChats({
		store: Promise.resolve(store),
		projectPath: async () => null,
		send: (event) => events.push(event),
		changed: (id) => changed.push(id),
		adapter: { command: process.execPath, args: [fixture, 'normal', join(root, 'wire.jsonl')] },
		...over,
	});
	chats.push(chat);
	return { root, store, chat, events, changed };
}
test('answers about the note, keeps the chat in its journal and lets the agent edit only the note, with Undo', async () => {
	const { root, store, chat, changed } = await setup();
	const id = await store.create(null, '# Checkout\n- Кнопка «Далі»\n');
	await chat.send(id, 'Що тут незрозуміло?', { provider: 'claude', model: null });
	let state = await chat.read(id);
	expect(state.rows.map((row) => row.kind)).toContain('prompt');
	expect(state.rows.at(-1)).toMatchObject({ kind: 'done', stopped: false });
	const wire = await readFile(join(root, 'wire.jsonl'), 'utf8');
	expect(wire).toContain('"note-chat"');
	expect(wire).toContain(join(root, 'notes'));
	await chat.send(id, 'edit please', { provider: 'claude', model: null });
	expect((await store.read(id)).text).toContain('- Перевірити ще на Android');
	state = await chat.read(id);
	const edit = state.rows.find((row) => row.kind === 'edit');
	expect(edit).toMatchObject({ kind: 'edit', added: 1, removed: 0 });
	expect(changed).toContain(id);
	await chat.undo(id, edit!.seq);
	expect((await store.read(id)).text).toBe('# Checkout\n- Кнопка «Далі»\n');
	await expect(chat.undo(id, edit!.seq)).rejects.toThrow();
});
test("the person's edit between messages is a row of the chat", async () => {
	const { store, chat } = await setup();
	const id = await store.create(null, 'one\n');
	await chat.send(id, 'hi', { provider: 'claude', model: null });
	await store.write(id, 'one\ntwo\n');
	await chat.send(id, 'again', { provider: 'claude', model: null });
	const rows = (await chat.read(id)).rows;
	expect(rows.find((row) => row.kind === 'person-edit')).toMatchObject({ added: 1, removed: 0 });
});
test('idle waits for the note agent’s answer, so a Slack addition lands after its edit', async () => {
	const { store, chat } = await setup();
	const id = await store.create(null, '# Checkout\n- Кнопка «Далі»\n');
	await expect(chat.idle(id)).resolves.toBeUndefined();
	const turn = chat.send(id, 'edit please', { provider: 'claude', model: null });
	// What idle sees is the finished answer: the agent's edit and the end of the turn are already in the chat.
	const seen = chat.idle(id).then(async () => (await chat.read(id)).rows.map((row) => row.kind));
	await expect(chat.send(id, 'again', { provider: 'claude', model: null })).rejects.toThrow();
	await turn;
	expect((await seen).slice(-2)).toEqual(['edit', 'done']);
	const rows = (await chat.read(id)).rows;
	expect(rows.filter((row) => row.kind === 'edit')).toHaveLength(1);
});

const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
test('a message carries its attachments and task pills to the agent, each in its place (spec/composer#chat-composer)', async () => {
	let assets: Attachments | null = null;
	const { chat, store, root } = await setup({
		attachments: (note, ids) => assets!.resolve({ chat: 'note', id: note }, ids),
		taskSummary: async (task) =>
			task === 't1' ? { name: 'Task summary · ATT', text: 'Task: ATT\nState: working' } : null,
	});
	assets = new Attachments(await SessionStore.at(root));
	const id = await store.create(null, '# A\n');
	const image = await assets.create(
		{ chat: 'note', id },
		{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: png }
	);
	await chat.send(
		id,
		`see ${attachmentToken(image.id)} and ${taskToken('t1')} or ${taskToken('gone')}`,
		{ provider: 'claude', model: null },
		[image.id]
	);
	const rows = (await chat.read(id)).rows;
	expect(rows.find((row) => row.kind === 'prompt')).toMatchObject({
		text: `see ${attachmentToken(image.id)} and ${taskToken('t1')} or ${taskToken('gone')}`,
		attachments: [{ id: image.id, name: 'shot.png', kind: 'image' }],
	});
	const wire = (await readFile(join(root, 'wire.jsonl'), 'utf8'))
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; params: unknown });
	const blocks = wire.find((line) => line.event === 'prompt-blocks')!.params as {
		type: string;
		text?: string;
		data?: string;
	}[];
	expect(blocks.map((block) => block.type)).toEqual(['text', 'image', 'text', 'text', 'text']);
	expect(blocks[0]!.text).toMatch(/The person writes:\nsee $/);
	expect(blocks[1]!.data).toBe(png);
	expect(blocks[3]!.text).toBe(
		'<attached_context name="Task summary · ATT">\nTask: ATT\nState: working\n</attached_context>'
	);
	expect(blocks[4]!.text).toBe(' or the task with id gone');
	await expect(
		chat.send(id, 'again', { provider: 'claude', model: null }, [
			'0b1c2d3e-0000-4000-8000-000000000009',
		])
	).rejects.toThrow();
});
test("a file of the note's project is a reference inside its main tree (spec/composer#chat-composer)", async () => {
	const root = await mkdtemp(join(tmpdir(), 'note-chat-files-'));
	roots.push(root);
	await mkdir(join(root, 'src'), { recursive: true });
	await writeFile(join(root, 'src', 'a.ts'), 'x');
	expect(await projectReference(root, 'src/a.ts')).toEqual({
		name: 'a.ts',
		text: `File reference:\nProject-relative path: "src/a.ts"\nAbsolute path: ${JSON.stringify(join(root, 'src', 'a.ts'))}\nRead the current contents from disk when needed.`,
	});
	expect((await projectReference(root, 'src/')).name).toBe('src/');
	await expect(projectReference(root, '../outside')).rejects.toThrow('outside');
	await expect(projectReference(root, '/etc/hosts')).rejects.toThrow('outside');
	await expect(projectReference(root, 'missing.ts')).rejects.toThrow();
});
