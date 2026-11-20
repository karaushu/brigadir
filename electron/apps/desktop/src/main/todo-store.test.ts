import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TodoChange } from '@brigadir/core';
import { TodoStore } from './todo-store';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'todo-'));
	roots.push(root);
	const changes: TodoChange[] = [];
	let tick = Date.parse('2026-11-21T09:00:00.000Z');
	const store = new TodoStore(
		root,
		(change) => changes.push(change),
		() => 'Inbox',
		() => new Date((tick += 1000))
	);
	return { root, store, changes };
}

it('keeps each list as todo/<id>.json with sorted keys and a schema version (spec/todo-and-slack-inbox#todo-file)', async () => {
	const { root, store, changes } = await setup();
	const list = await store.createList('b2c', 'Release 1.15');
	expect(list.id).toMatch(/^todo-[a-z0-9]+$/);
	const item = await store.createItem(list.id, ' Зібрати TestFlight 1.15 ', '');
	const text = await readFile(join(root, 'todo', `${list.id}.json`), 'utf8');
	const doc = JSON.parse(text);
	expect(doc.schemaVersion).toBe(1);
	expect(Object.keys(doc)).toEqual(['list', 'schemaVersion']);
	expect(text).toContain('\n  "list": {');
	expect(doc.list.items[0]).toMatchObject({
		id: item,
		title: 'Зібрати TestFlight 1.15',
		description: '',
		done: false,
		doneAt: null,
		open: false,
		source: null,
	});
	expect(changes.map((change) => change.kind)).toEqual(['created', 'written']);
});

it('adds new items on top, folds a new item without a description and opens one with it', async () => {
	const { store } = await setup();
	const list = await store.createList(null, '');
	await store.createItem(list.id, 'first', '');
	await store.createItem(list.id, 'second', 'Crashlytics: **14** a day');
	const [top, next] = (await store.read(list.id)).items;
	expect([top?.title, next?.title]).toEqual(['second', 'first']);
	expect([top?.open, next?.open]).toEqual([true, false]);
});

it('marks done with its time, unmarks, reorders, deletes and puts back (Undo)', async () => {
	const { store } = await setup();
	const list = await store.createList('b2c', 'Release');
	const a = await store.createItem(list.id, 'a', '');
	const b = await store.createItem(list.id, 'b', '');
	const c = await store.createItem(list.id, 'c', '');
	await store.updateItem(list.id, b, { done: true });
	let items = (await store.read(list.id)).items;
	expect(items.find((item) => item.id === b)?.doneAt).toMatch(/^2026-11-21T/);
	await store.stepItem(list.id, c, 1);
	expect((await store.read(list.id)).items.map((item) => item.title)).toEqual(['a', 'b', 'c']);
	await store.placeItem(list.id, c, a);
	expect((await store.read(list.id)).items.map((item) => item.title)).toEqual(['c', 'a', 'b']);
	await store.updateItem(list.id, b, { done: false });
	items = (await store.read(list.id)).items;
	expect(items.find((item) => item.id === b)).toMatchObject({ done: false, doneAt: null });
	const removed = await store.removeItem(list.id, a);
	expect(removed?.index).toBe(1);
	expect((await store.read(list.id)).items.map((item) => item.title)).toEqual(['c', 'b']);
	await store.restoreItem(list.id, removed!.item, removed!.index);
	expect((await store.read(list.id)).items.map((item) => item.title)).toEqual(['c', 'a', 'b']);
	expect(await store.removeItem(list.id, 'item-gone1')).toBeNull();
});

it('moves an item to another list and renames, re-projects and deletes lists', async () => {
	const { root, store, changes } = await setup();
	const from = await store.createList('b2c', 'Release');
	const to = await store.createList('b2c', 'Tech debt');
	const item = await store.createItem(from.id, 'Move me', 'body');
	await store.moveItem(from.id, item, to.id);
	expect((await store.read(from.id)).items).toEqual([]);
	expect((await store.read(to.id)).items.map((one) => one.title)).toEqual(['Move me']);
	await store.renameList(to.id, 'Debt');
	await store.setProject(to.id, null);
	expect(await store.read(to.id)).toMatchObject({ name: 'Debt', project: null });
	await store.deleteList(from.id);
	expect(await readdir(join(root, 'todo'))).toEqual([`${to.id}.json`]);
	expect(changes.at(-1)).toEqual({ id: from.id, kind: 'deleted' });
	expect((await store.lists()).map((list) => list.id)).toEqual([to.id]);
});

it('adds from Slack or the chat: a list by name in any case, else the latest, else a new Inbox (spec/todo-and-slack-inbox#slack-inbox-to-todo)', async () => {
	const { store } = await setup();
	const source = {
		kind: 'slack' as const,
		permalink: 'https://acme.slack.com/archives/C1/p1700000000000100',
		channel: '#b2c',
		author: 'Olena',
		ts: '1700000000.000100',
		mention: 'm-1',
	};
	const first = await store.addItem({
		project: 'b2c',
		list: null,
		title: 'Відповісти Максиму',
		description: '',
		source,
	});
	expect(first).toMatchObject({ listName: 'Inbox', project: 'b2c' });
	const release = await store.createList('b2c', 'Release 1.15');
	const byName = await store.addItem({
		project: 'b2c',
		list: 'release 1.15',
		title: 'ATT texts',
		description: 'uk, en, pl',
		source: null,
	});
	expect(byName.listId).toBe(release.id);
	const latest = await store.addItem({
		project: 'b2c',
		list: null,
		title: 'Latest',
		description: '',
		source: null,
	});
	expect(latest.listId).toBe(release.id);
	const made = await store.addItem({
		project: null,
		list: 'Personal',
		title: 'Buy',
		description: '',
		source: null,
	});
	expect(made).toMatchObject({ listName: 'Personal', project: null });
	expect((await store.read(first.listId)).items[0]?.source).toEqual(source);
	// Two adds at once into a missing list make it once.
	const [x, y] = await Promise.all([
		store.addItem({ project: 'admin', list: 'Sale', title: 'x', description: '', source: null }),
		store.addItem({ project: 'admin', list: 'Sale', title: 'y', description: '', source: null }),
	]);
	expect(x.listId).toBe(y.listId);
	expect((await store.read(x.listId)).items).toHaveLength(2);
});

it('skips a broken file and refuses unsafe ids', async () => {
	const { root, store } = await setup();
	await store.createList(null, 'ok');
	await writeFile(join(root, 'todo', 'todo-broken1.json'), '{"schemaVersion":1,"list":{}}');
	expect((await store.lists()).map((list) => list.name)).toEqual(['ok']);
	await expect(store.read('../x')).rejects.toThrow();
});
