import { it, expect } from 'vitest';
import { boardColumn, boardMove, boardSections, projectColors, taskDescription } from './board';
import type { AgentTask } from './workspace';
import { relativeAge } from './messages';
const task = (id: string, status: AgentTask['status'], updatedAt?: string): AgentTask => ({
	id,
	projectId: 'p',
	title: id,
	status,
	...(updatedAt ? { updatedAt } : {}),
});
it('groups the same statuses into three columns and orders In progress by attention, then activity', () => {
	const sections = boardSections([
		task('a', 'done', '2026-09-18T10:00:00Z'),
		task('b', 'needs-you', '2026-09-18T09:00:00Z'),
		task('c', 'backlog'),
		task('d', 'completed'),
		task('e', 'working', '2026-09-18T11:00:00Z'),
		task('f', 'done', '2026-09-18T12:00:00Z'),
		task('g', 'interrupted'),
		task('h', 'failed'),
		task('i', 'queued'),
	]);
	expect(sections.backlog.map((t) => t.id)).toEqual(['c']);
	expect(sections.completed.map((t) => t.id)).toEqual(['d']);
	expect(sections.progress.map((t) => t.id)).toEqual(['b', 'e', 'i', 'h', 'g', 'f', 'a']);
	for (const status of ['queued', 'working', 'needs-you', 'done', 'interrupted', 'failed'] as const)
		expect(boardColumn(status)).toBe('progress');
	expect(boardSections([])).toEqual({ backlog: [], progress: [], completed: [] });
});
it('allows only drops that map to existing actions', () => {
	expect(boardMove('backlog', 'progress')).toBe('start');
	expect(boardMove('completed', 'progress')).toBe('await-input');
	expect(boardMove('progress', 'completed')).toBe('stop-complete');
	expect(boardMove('progress', 'backlog')).toBe('stop-backlog');
	expect(boardMove('backlog', 'completed')).toBeNull();
	expect(boardMove('completed', 'backlog')).toBeNull();
	expect(boardMove('progress', 'progress')).toBeNull();
});
it('assigns distinct, stable project colors independent of open order', () => {
	const ids = ['a1', 'b2', 'c3', 'd4', 'e5'];
	const colors = projectColors(ids);
	expect(new Set(colors.values()).size).toBe(5);
	expect(projectColors([...ids].reverse())).toEqual(colors);
	expect(projectColors(['choice']).get('choice')).toBe(8);
	const many = projectColors(Array.from({ length: 12 }, (_, i) => `id-${i}`));
	expect(new Set(many.values()).size).toBe(9);
});
it('formats short relative ages in both languages and takes the description from the prompt', () => {
	const now = Date.parse('2026-09-18T12:00:00Z');
	expect(relativeAge('en', '2026-09-18T11:59:50Z', now)).toBe('now');
	expect(relativeAge('uk', '2026-09-18T11:57:00Z', now)).toBe('3 хв');
	expect(relativeAge('en', '2026-09-18T09:00:00Z', now)).toBe('3 hr');
	expect(relativeAge('uk', '2026-09-13T12:00:00Z', now)).toBe('5 дн');
	expect(relativeAge('en', undefined, now)).toBe('');
	expect(relativeAge('en', 'nope', now)).toBe('');
	expect(
		taskDescription({ ...task('t', 'backlog'), title: 'Fix it', prompt: 'Fix it properly' })
	).toBe('Fix it properly');
	expect(taskDescription({ ...task('t', 'backlog'), title: 'Fix it', prompt: 'Fix it' })).toBe('');
});
