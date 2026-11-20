import { useSyncExternalStore } from 'react';
import type { TodoList } from '@brigadir/core';

/**
 * spec/todo-and-slack-inbox#todo-file: the to-do lists as main has them, one copy for the sidebar, the screen and the rail. A change from
 * any writer (this window, another one, the Slack section, the chat) comes as `todo:changed` and the lists are read again; a change made
 * here shows at once (`patchTodoList`) and the read that follows confirms it.
 */
let lists: TodoList[] | null = null;
const listeners = new Set<() => void>();
let off: (() => void) | null = null,
	reads = 0;
const notify = () => {
	for (const listener of listeners) listener();
};
function read() {
	const read = ++reads;
	void window.brigadir.todoLists().then(
		(next) => {
			if (read !== reads) return;
			lists = next;
			notify();
		},
		() => {
			if (read !== reads || lists) return;
			lists = [];
			notify();
		}
	);
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!off) {
		off = window.brigadir.onTodoChanged(() => read());
		read();
	}
	return () => {
		listeners.delete(listener);
		if (!listeners.size) {
			off?.();
			off = null;
		}
	};
}
/** Every list with its items; null until the first read. */
export function useTodoLists(): TodoList[] | null {
	return useSyncExternalStore(subscribe, () => lists);
}
/** Shows a change of one list before main confirms it. */
export function patchTodoList(id: string, change: (list: TodoList) => TodoList) {
	if (!lists) return;
	lists = lists.map((list) => (list.id === id ? change(list) : list));
	notify();
}
/** A list just made here shows before the read that follows its `todo:changed`. */
export function addTodoListToCache(list: TodoList) {
	if (!lists || lists.some((item) => item.id === list.id)) return;
	lists = [list, ...lists];
	notify();
}
/** A list just made with `New list`: its screen starts with the name being typed. */
let fresh: string | null = null;
export const markFreshTodoList = (id: string) => void (fresh = id);
export function takeFreshTodoList(id: string) {
	if (fresh !== id) return false;
	fresh = null;
	return true;
}
