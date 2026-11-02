import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { NotesStore } from '@brigadir/persistence';
import type { NoteChatEvent } from '@brigadir/core';
import { NoteChats } from './note-chats';
const fixture = fileURLToPath(
	new URL('../../../../packages/transport/fixtures/agent.mjs', import.meta.url)
);
const roots: string[] = [];
const chats: NoteChats[] = [];
afterEach(async () => {
	for (const chat of chats.splice(0)) chat.closeAll();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
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
