import { describe, expect, it } from 'vitest';
import {
	doneTodoItems,
	isTodoItemPatch,
	isTodoList,
	isTodoListId,
	newTodoItemId,
	newTodoListId,
	openTodoItems,
	pickTodoList,
	placeTodoItem,
	stepTodoItem,
	todoCountsLine,
	todoListMatches,
	todoListName,
	todoListsText,
	type TodoItem,
	type TodoList,
} from './todo';

const at = '2026-11-20T10:00:00.000Z';
const item = (id: string, patch: Partial<TodoItem> = {}): TodoItem => ({
	id: `item-${id}`,
	title: id,
	description: '',
	done: false,
	doneAt: null,
	open: false,
	createdAt: at,
	source: null,
	...patch,
});
const list = (patch: Partial<TodoList> = {}): TodoList => ({
	id: 'todo-abcd1234',
	name: 'Release 1.15',
	project: 'b2c',
	createdAt: at,
	updatedAt: at,
	items: [],
	...patch,
});

describe('to-do lists (spec/todo-and-slack-inbox#todo)', () => {
	it('makes and checks ids and documents', () => {
		expect(isTodoListId(newTodoListId(1, () => 0.5))).toBe(true);
		expect(newTodoItemId(1, () => 0.5)).toMatch(/^item-[a-z0-9]+$/);
		expect(isTodoListId('note-abcd')).toBe(false);
		expect(isTodoListId('todo-../x')).toBe(false);
		expect(isTodoList(list({ items: [item('aaaa')] }))).toBe(true);
		expect(isTodoList(list({ items: [item('aaaa'), item('aaaa')] }))).toBe(false);
		expect(
			isTodoList(
				list({
					items: [
						item('aaaa', {
							source: {
								kind: 'slack',
								permalink: 'https://acme.slack.com/archives/C1/p1',
								channel: 'b2c',
								author: 'Olena',
								ts: '1.2',
								mention: 'm1',
							},
						}),
					],
				})
			)
		).toBe(true);
		expect(
			isTodoList(
				list({
					items: [
						item('aaaa', {
							source: {
								kind: 'slack',
								permalink: 'javascript:alert(1)',
								channel: 'b2c',
								author: 'Olena',
								ts: '1.2',
								mention: 'm1',
							},
						}),
					],
				})
			)
		).toBe(false);
		expect(isTodoItemPatch({ done: true })).toBe(true);
		expect(isTodoItemPatch({})).toBe(false);
		expect(isTodoItemPatch({ id: 'x' })).toBe(false);
	});
	it('says the counts line and the name in both languages', () => {
		expect(todoCountsLine('en', list())).toBe('Empty');
		expect(todoCountsLine('uk', list())).toBe('Порожньо');
		const three = list({ items: [item('aaaa', { done: true }), item('bbbb'), item('cccc')] });
		expect(todoCountsLine('en', three)).toBe('1 of 3 done');
		expect(todoCountsLine('uk', three)).toBe('1 з 3 виконано');
		expect(todoCountsLine('en', list({ items: [item('aaaa', { done: true })] }))).toBe('All done');
		expect(todoListName('en', list({ name: ' ' }))).toBe('Untitled list');
	});
	it('keeps open items in order and shows the most recently done first', () => {
		const items = [
			item('aaaa', { done: true, doneAt: '2026-11-20T10:00:00.000Z' }),
			item('bbbb'),
			item('cccc', { done: true, doneAt: '2026-11-21T10:00:00.000Z' }),
			item('dddd'),
		];
		expect(openTodoItems({ items }).map((one) => one.title)).toEqual(['bbbb', 'dddd']);
		expect(doneTodoItems({ items }).map((one) => one.title)).toEqual(['cccc', 'aaaa']);
	});
	it('steps an open item past done ones and places a dragged one', () => {
		const items = [item('aaaa'), item('bbbb', { done: true }), item('cccc')];
		expect(stepTodoItem(items, 'item-cccc', -1)?.map((one) => one.title)).toEqual([
			'cccc',
			'bbbb',
			'aaaa',
		]);
		expect(stepTodoItem(items, 'item-aaaa', -1)).toBeNull();
		expect(stepTodoItem(items, 'item-bbbb', 1)).toBeNull();
		expect(placeTodoItem(items, 'item-aaaa', null)?.map((one) => one.title)).toEqual([
			'bbbb',
			'cccc',
			'aaaa',
		]);
		expect(placeTodoItem(items, 'item-cccc', 'item-aaaa')?.map((one) => one.title)).toEqual([
			'cccc',
			'aaaa',
			'bbbb',
		]);
		expect(placeTodoItem(items, 'item-aaaa', 'item-aaaa')).toBeNull();
	});
	it('picks a list by name in the project, else the latest one', () => {
		const lists = [
			list({ id: 'todo-aaaa1111', name: 'Release 1.15', updatedAt: '2026-11-19T00:00:00.000Z' }),
			list({ id: 'todo-bbbb2222', name: 'Tech debt', updatedAt: '2026-11-20T00:00:00.000Z' }),
			list({ id: 'todo-cccc3333', name: 'Inbox', project: null }),
		];
		expect(pickTodoList(lists, 'b2c', 'release 1.15')?.id).toBe('todo-aaaa1111');
		expect(pickTodoList(lists, 'b2c', 'Nope')).toBeNull();
		expect(pickTodoList(lists, 'b2c', null)?.id).toBe('todo-bbbb2222');
		expect(pickTodoList(lists, 'admin', null)).toBeNull();
		expect(pickTodoList(lists, null, 'INBOX')?.id).toBe('todo-cccc3333');
	});
	it('filters by list name and item text, and tells the agent the lists', () => {
		const one = list({ items: [item('aaaa', { description: 'Crashlytics: 14 a day' })] });
		expect(todoListMatches(one, 'release')).toBe(true);
		expect(todoListMatches(one, 'crashlytics')).toBe(true);
		expect(todoListMatches(one, 'zzz')).toBe(false);
		expect(todoListsText([one], (id) => id ?? 'No project')).toBe(
			'Release 1.15 (b2c) — 0 of 1 done\n  - aaaa'
		);
		expect(todoListsText([], () => '')).toBe('No to-do lists.');
	});
});
