import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import {
	atomicJson,
	readDocument,
	ReadFailure,
	safePath,
	SessionStore,
} from '@brigadir/persistence';
import {
	isRecord,
	isTodoList,
	isTodoListId,
	newTodoItemId,
	newTodoListId,
	pickTodoList,
	placeTodoItem,
	sortTodoLists,
	stepTodoItem,
	todoLimits,
	type TodoChange,
	type TodoItem,
	type TodoItemPatch,
	type TodoList,
	type TodoSource,
} from '@brigadir/core';

const missing = (e: unknown) => isRecord(e) && e.code === 'ENOENT';
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);
/** A list is at most 2,000 items of up to 20 KB; a document is never larger than this. */
const maxBytes = 48 * 1024 * 1024;

/**
 * spec/todo-and-slack-inbox#todo-file: the to-do lists, one file per list — `todo/<id>.json` with `{schemaVersion: 1, list}` (rule 10).
 * Writes of one list go one after another (read, change, write in one turn), so the Slack section, the chat and a window never lose
 * each other's change; every change is told to the windows (`todo:changed`).
 */
export class TodoStore {
	private chains = new Map<string, Promise<unknown>>();
	constructor(
		readonly root: string,
		private readonly changed: (change: TodoChange) => void = () => {},
		/** The name of a list made for an item with no list to go to: `Inbox` in the interface language. */
		private readonly inboxName: () => string = () => 'Inbox',
		private readonly now: () => Date = () => new Date()
	) {}
	static async at(
		dataDir: string | undefined,
		changed?: (change: TodoChange) => void,
		inbox?: () => string
	) {
		return new TodoStore((await SessionStore.at(dataDir)).root, changed, inbox);
	}
	/** Resolves once every write begun so far has ended. */
	async waitForWrites() {
		await Promise.all([...this.chains.values()].map((chain) => chain.catch(() => {})));
	}
	private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
		const result = (this.chains.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
		const tail = result.catch(() => {});
		this.chains.set(id, tail);
		void tail.then(() => {
			if (this.chains.get(id) === tail) this.chains.delete(id);
		});
		return result;
	}
	async dir() {
		const dir = await safePath(this.root, 'todo');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	}
	private async path(id: string) {
		if (!isTodoListId(id)) throw new ReadFailure('invalid_document');
		await this.dir();
		return safePath(this.root, 'todo', `${id}.json`);
	}
	async read(id: string): Promise<TodoList> {
		const doc = await readDocument(await this.path(id), maxBytes);
		if (!isTodoList(doc.list) || doc.list.id !== id) throw new ReadFailure('invalid_document');
		return doc.list;
	}
	private async write(list: TodoList) {
		await atomicJson(await this.path(list.id), { schemaVersion: 1, list });
	}
	/** Every list that reads, the most recently changed first; a broken file is left alone. */
	async lists(): Promise<TodoList[]> {
		const dir = await this.dir();
		const ids = (await readdir(dir))
			.filter((name) => name.endsWith('.json'))
			.map((name) => name.slice(0, -5))
			.filter(isTodoListId);
		const lists = await Promise.all(ids.map((id) => this.read(id).catch(() => null)));
		return sortTodoLists(lists.filter((list): list is TodoList => list !== null));
	}
	/** Read, change and write one list in its turn; `change` returns the new list, or null to leave it as it is. */
	private edit<T>(
		id: string,
		change: (list: TodoList) => { list: TodoList | null; result: T }
	): Promise<T> {
		return this.serial(id, async () => {
			const { list, result } = change(await this.read(id));
			if (list) {
				await this.write({ ...list, updatedAt: this.now().toISOString() });
				this.changed({ id, kind: 'written' });
			}
			return result;
		});
	}
	async createList(project: string | null, name: string): Promise<TodoList> {
		const at = this.now().toISOString();
		let id = newTodoListId(this.now().getTime());
		const taken = async (value: string) =>
			stat(await this.path(value)).then(
				() => true,
				() => false
			);
		while (await taken(id)) id = newTodoListId(this.now().getTime());
		const list: TodoList = {
			id,
			name: clip(name.trim(), todoLimits.name),
			project,
			createdAt: at,
			updatedAt: at,
			items: [],
		};
		await this.serial(id, () => this.write(list));
		this.changed({ id, kind: 'created' });
		return list;
	}
	renameList(id: string, name: string) {
		return this.edit(id, (list) => ({
			list: { ...list, name: clip(name.trim(), todoLimits.name) },
			result: undefined,
		}));
	}
	setProject(id: string, project: string | null) {
		return this.edit(id, (list) => ({ list: { ...list, project }, result: undefined }));
	}
	deleteList(id: string) {
		return this.serial(id, async () => {
			await unlink(await this.path(id)).catch((e: unknown) => {
				if (!missing(e)) throw e;
			});
			this.changed({ id, kind: 'deleted' });
		});
	}
	private newItem(title: string, description: string, source: TodoSource | null): TodoItem {
		const trimmed = description.trim();
		return {
			id: newTodoItemId(this.now().getTime()),
			title: clip(title.trim(), todoLimits.title),
			description: clip(trimmed, todoLimits.description),
			done: false,
			doneAt: null,
			// spec/todo-and-slack-inbox#todo-item: a new item with a description starts unfolded.
			open: !!trimmed,
			createdAt: this.now().toISOString(),
			source,
		};
	}
	/** A new item at the top of the open items (the add field is on top); its id. */
	createItem(
		listId: string,
		title: string,
		description: string,
		source: TodoSource | null = null
	): Promise<string> {
		return this.edit(listId, (list) => {
			if (list.items.length >= todoLimits.items) throw new Error('The list is full.');
			const item = this.newItem(title, description, source);
			return { list: { ...list, items: [item, ...list.items] }, result: item.id };
		});
	}
	/**
	 * spec/todo-and-slack-inbox#slack-inbox-to-todo, spec/todo-and-slack-inbox#todo-chat-tools: a to-do from the Slack section or the chat. `list` is a list
	 * name: that project's list with that name in any case, else a new list of that name; null — the project's most recently changed
	 * list, else a new list `Inbox`.
	 */
	async addItem(input: {
		project: string | null;
		list: string | null;
		title: string;
		description: string;
		source: TodoSource | null;
	}): Promise<{ listId: string; listName: string; project: string | null; itemId: string }> {
		// One add at a time picks or makes the list, so two adds into a missing list make it once.
		return this.serial('add', async () => {
			const name = input.list?.trim() ? clip(input.list.trim(), todoLimits.name) : null;
			const found =
				pickTodoList(await this.lists(), input.project, name) ??
				(await this.createList(input.project, name ?? this.inboxName()));
			const itemId = await this.createItem(found.id, input.title, input.description, input.source);
			return { listId: found.id, listName: found.name, project: found.project, itemId };
		});
	}
	updateItem(listId: string, itemId: string, patch: TodoItemPatch) {
		return this.edit(listId, (list) => {
			const index = list.items.findIndex((item) => item.id === itemId);
			if (index < 0) return { list: null, result: undefined };
			const before = list.items[index]!;
			const item: TodoItem = {
				...before,
				...(patch.title !== undefined ? { title: clip(patch.title.trim(), todoLimits.title) } : {}),
				...(patch.description !== undefined
					? { description: clip(patch.description.trim(), todoLimits.description) }
					: {}),
				...(patch.open !== undefined ? { open: patch.open } : {}),
				...(patch.done !== undefined && patch.done !== before.done
					? { done: patch.done, doneAt: patch.done ? this.now().toISOString() : null }
					: {}),
			};
			const items = [...list.items];
			items[index] = item;
			return { list: { ...list, items }, result: undefined };
		});
	}
	/** Deletes an item; the item and its place for Undo, null when it was gone. */
	removeItem(listId: string, itemId: string) {
		return this.edit(listId, (list) => {
			const index = list.items.findIndex((item) => item.id === itemId);
			if (index < 0) return { list: null, result: null };
			return {
				list: { ...list, items: list.items.filter((item) => item.id !== itemId) },
				result: { item: list.items[index]!, index },
			};
		});
	}
	/** Undo of a delete: the item back at its place (or the end). */
	restoreItem(listId: string, item: TodoItem, index: number) {
		return this.edit(listId, (list) => {
			if (list.items.some((one) => one.id === item.id)) return { list: null, result: undefined };
			const items = [...list.items];
			items.splice(Math.min(index, items.length), 0, item);
			return { list: { ...list, items }, result: undefined };
		});
	}
	placeItem(listId: string, itemId: string, before: string | null) {
		return this.edit(listId, (list) => {
			const items = placeTodoItem(list.items, itemId, before);
			return { list: items ? { ...list, items } : null, result: undefined };
		});
	}
	stepItem(listId: string, itemId: string, delta: -1 | 1) {
		return this.edit(listId, (list) => {
			const items = stepTodoItem(list.items, itemId, delta);
			return { list: items ? { ...list, items } : null, result: undefined };
		});
	}
	/** `Move to list…`: the item leaves its list and goes to the top of the other one's open items. */
	async moveItem(listId: string, itemId: string, toListId: string) {
		if (listId === toListId) return;
		const removed = await this.removeItem(listId, itemId);
		if (!removed) return;
		try {
			await this.edit(toListId, (list) => ({
				list: { ...list, items: [removed.item, ...list.items] },
				result: undefined,
			}));
		} catch (error) {
			await this.restoreItem(listId, removed.item, removed.index);
			throw error;
		}
	}
}
