import { t, type Locale } from './messages';
import { isId, isRecord } from './workspace';

/**
 * spec/todo-and-slack-inbox#todo: to-do lists, by project or without one. Each list is `todo/<id>.json` with its items in the person's
 * order (spec/todo-and-slack-inbox#todo-file); a done item keeps its place in that order and shows under `Done · N`, the most recently
 * done first.
 */
export type TodoSource = {
	kind: 'slack';
	permalink: string;
	/** The channel's name without `#`, or the DM's person. */
	channel: string;
	author: string;
	/** The message's Slack timestamp. */
	ts: string;
	/** The Slack section's mention id it came from. */
	mention: string;
};
export type TodoItem = {
	id: string;
	title: string;
	/** Markdown; empty — no description and no chevron. */
	description: string;
	done: boolean;
	doneAt: string | null;
	/** The description is unfolded (spec/todo-and-slack-inbox#todo-item: kept per item). */
	open: boolean;
	createdAt: string;
	source: TodoSource | null;
};
export type TodoList = {
	id: string;
	name: string;
	/** A project id, or null — `No project`. */
	project: string | null;
	createdAt: string;
	updatedAt: string;
	items: TodoItem[];
};
export type TodoDocument = { schemaVersion: 1; list: TodoList };
export type TodoChange = { id: string; kind: 'created' | 'written' | 'deleted' };
export type TodoItemPatch = Partial<Pick<TodoItem, 'title' | 'description' | 'done' | 'open'>>;

export const todoLimits = { name: 120, title: 500, description: 20_000, items: 2000 } as const;

export const isTodoListId = (value: unknown): value is string =>
	isId(value) && /^todo-[a-z0-9]{4,40}$/.test(String(value));
export const isTodoItemId = (value: unknown): value is string =>
	isId(value) && /^item-[a-z0-9]{4,40}$/.test(String(value));
const base36 = (now: number, random: () => number) =>
	`${now.toString(36)}${Math.floor(random() * 36 ** 4)
		.toString(36)
		.padStart(4, '0')}`;
/** `todo-<base36>` (spec/todo-and-slack-inbox#todo-file). */
export function newTodoListId(now = Date.now(), random = Math.random) {
	return `todo-${base36(now, random)}`;
}
export function newTodoItemId(now = Date.now(), random = Math.random) {
	return `item-${base36(now, random)}`;
}
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const time = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
export function isTodoSource(value: unknown): value is TodoSource {
	return (
		isRecord(value) &&
		value.kind === 'slack' &&
		text(value.permalink, 2000) &&
		/^https:\/\//.test(value.permalink as string) &&
		text(value.channel, 200) &&
		text(value.author, 200) &&
		text(value.ts, 64) &&
		text(value.mention, 200)
	);
}
export function isTodoItem(value: unknown): value is TodoItem {
	return (
		isRecord(value) &&
		isTodoItemId(value.id) &&
		text(value.title, todoLimits.title) &&
		text(value.description, todoLimits.description) &&
		typeof value.done === 'boolean' &&
		(value.doneAt === null || time(value.doneAt)) &&
		typeof value.open === 'boolean' &&
		time(value.createdAt) &&
		(value.source === null || isTodoSource(value.source))
	);
}
export function isTodoList(value: unknown): value is TodoList {
	return (
		isRecord(value) &&
		isTodoListId(value.id) &&
		text(value.name, todoLimits.name) &&
		(value.project === null || isId(value.project)) &&
		time(value.createdAt) &&
		time(value.updatedAt) &&
		Array.isArray(value.items) &&
		value.items.length <= todoLimits.items &&
		value.items.every(isTodoItem) &&
		new Set(value.items.map((item) => item.id)).size === value.items.length
	);
}
export function isTodoItemPatch(value: unknown): value is TodoItemPatch {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	return (
		keys.length > 0 &&
		keys.every((key) => ['title', 'description', 'done', 'open'].includes(key)) &&
		(value.title === undefined || text(value.title, todoLimits.title)) &&
		(value.description === undefined || text(value.description, todoLimits.description)) &&
		(value.done === undefined || typeof value.done === 'boolean') &&
		(value.open === undefined || typeof value.open === 'boolean')
	);
}
/** The list's name as the list and the screen show it. */
export function todoListName(locale: Locale, list: Pick<TodoList, 'name'>) {
	return list.name.trim() || t(locale, 'Untitled list');
}
export function todoCounts(list: Pick<TodoList, 'items'>) {
	return { done: list.items.filter((item) => item.done).length, total: list.items.length };
}
/** The list row's second line: `3 of 8 done`, `Empty`, `All done` (spec/todo-and-slack-inbox#todo-entry). */
export function todoCountsLine(locale: Locale, list: Pick<TodoList, 'items'>) {
	const { done, total } = todoCounts(list);
	if (!total) return t(locale, 'Empty');
	if (done === total) return t(locale, 'All done');
	const number = new Intl.NumberFormat(locale);
	return t(locale, '{done} of {total} done')
		.replace('{done}', number.format(done))
		.replace('{total}', number.format(total));
}
/** The open items in the person's order. */
export function openTodoItems(list: Pick<TodoList, 'items'>) {
	return list.items.filter((item) => !item.done);
}
/** `Done · N`: the most recently done first. */
export function doneTodoItems(list: Pick<TodoList, 'items'>) {
	return list.items
		.filter((item) => item.done)
		.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
}
/** The lists newest change first. */
export function sortTodoLists<T extends Pick<TodoList, 'updatedAt' | 'id'>>(lists: readonly T[]) {
	return [...lists].sort(
		(a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
	);
}
/** The filter of the list: the list's name and the text of its items. */
export function todoListMatches(list: TodoList, query: string) {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return (
		list.name.toLowerCase().includes(needle) ||
		list.items.some(
			(item) =>
				item.title.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle)
		)
	);
}
/**
 * ⌥⌘↑ / ⌥⌘↓ (spec/todo-and-slack-inbox#todo-item): the item swaps places with the open item before or after it; done items keep their
 * places in the order. Null when it cannot move.
 */
export function stepTodoItem(items: readonly TodoItem[], id: string, delta: -1 | 1) {
	const index = items.findIndex((item) => item.id === id);
	if (index < 0 || items[index]!.done) return null;
	let other = index + delta;
	while (other >= 0 && other < items.length && items[other]!.done) other += delta;
	if (other < 0 || other >= items.length) return null;
	const next = [...items];
	[next[index], next[other]] = [next[other]!, next[index]!];
	return next;
}
/** A drag puts the item before the open item `before` (null — after the last open item). */
export function placeTodoItem(items: readonly TodoItem[], id: string, before: string | null) {
	const moving = items.find((item) => item.id === id);
	if (!moving || before === id) return null;
	const rest = items.filter((item) => item.id !== id);
	let at = before === null ? -1 : rest.findIndex((item) => item.id === before);
	if (at < 0) {
		const lastOpen = rest.findLastIndex((item) => !item.done);
		at = lastOpen + 1;
	}
	const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
	return next.every((item, index) => item.id === items[index]!.id) ? null : next;
}
/**
 * Where `addItem` puts a to-do (spec/todo-and-slack-inbox#slack-inbox-to-todo): by name, a list of that project with that name (any
 * case); without a name, the project's most recently changed list. Null — a new list is made (the name, else `Inbox`).
 */
export function pickTodoList<T extends Pick<TodoList, 'name' | 'project' | 'updatedAt' | 'id'>>(
	lists: readonly T[],
	project: string | null,
	name: string | null
): T | null {
	const own = sortTodoLists(lists.filter((list) => list.project === project));
	const wanted = name?.trim().toLowerCase();
	if (wanted) return own.find((list) => list.name.trim().toLowerCase() === wanted) ?? null;
	return own[0] ?? null;
}
/** spec/todo-and-slack-inbox#todo-chat-tools: `todo_lists` for the agent — names, counts and open items (English, rule 12). */
export function todoListsText(
	lists: readonly TodoList[],
	projectName: (id: string | null) => string
): string {
	if (!lists.length) return 'No to-do lists.';
	return sortTodoLists(lists)
		.map((list) => {
			const { done, total } = todoCounts(list);
			const open = openTodoItems(list)
				.slice(0, 50)
				.map((item) => `  - ${item.title.slice(0, 200)}`);
			return [
				`${list.name.trim() || 'Untitled list'} (${projectName(list.project)}) — ${done} of ${total} done`,
				...open,
			].join('\n');
		})
		.join('\n');
}
