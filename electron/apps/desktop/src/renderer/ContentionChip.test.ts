import { describe, expect, it } from 'vitest';
import { taskCount } from '@brigadir/core';
import { contentionKey } from './ContentionChip';
const owner = (id: string) => ({ key: { projectId: 'p', id }, title: id, acquiredAt: '' });
describe('spec/notifications-slack-notes-and-schedules#repo-contention contention memory', () => {
	it('keys a repo by the task and its owner set, not by owner order', () => {
		const a = { name: 'kit', path: '/r/kit', contended: true, owners: [owner('a'), owner('b')] };
		const b = { ...a, owners: [owner('b'), owner('a')] };
		expect(contentionKey({ projectId: 'p', id: 'a' }, a)).toBe(
			contentionKey({ projectId: 'p', id: 'a' }, b)
		);
	});
	it('gives a new key when another task joins, so the popover opens once more', () => {
		const two = { name: 'kit', path: '/r/kit', contended: true, owners: [owner('a'), owner('b')] };
		const three = { ...two, owners: [...two.owners, owner('c')] };
		expect(contentionKey({ projectId: 'p', id: 'a' }, two)).not.toBe(
			contentionKey({ projectId: 'p', id: 'a' }, three)
		);
		expect(contentionKey({ projectId: 'p', id: 'a' }, two)).not.toBe(
			contentionKey({ projectId: 'p', id: 'b' }, two)
		);
	});
	it.each([
		[2, '2 задачі'],
		[5, '5 задач'],
		[11, '11 задач'],
		[21, '21 задача'],
		[22, '22 задачі'],
		[25, '25 задач'],
	])('labels the repo chip with %s owners', (count, label) => {
		expect(taskCount('uk', count)).toBe(label);
	});
});
