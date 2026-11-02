import { describe, expect, it } from 'vitest';
import {
	handedCount,
	locationCount,
	newCommitCount,
	riskyCount,
	selectLocale,
	subordinateCount,
	taskCount,
} from './messages';
describe('Ukrainian messages', () => {
	it.each([
		[1, '1 місце'],
		[3, '3 місця'],
		[11, '11 місць'],
		[22, '22 місця'],
		[1.5, '1,5 місця'],
	])('counts %s code locations', (count, expected) => {
		expect(locationCount('uk', count as number)).toBe(expected);
	});
	it.each([
		[1, '1 задача'],
		[2, '2 задачі'],
		[5, '5 задач'],
		[21, '21 задача'],
		[1.5, '1,5 задачі'],
	])('formats %s with the correct plural', (count, expected) => {
		expect(taskCount('uk', count as number)).toBe(expected);
	});
	it.each([
		['uk', 1, '1 підлеглий'],
		['uk', 2, '2 підлеглі'],
		['uk', 5, '5 підлеглих'],
		['uk', 11, '11 підлеглих'],
		['uk', 21, '21 підлеглий'],
		['uk', 22, '22 підлеглі'],
		['uk', 25, '25 підлеглих'],
		['en', 1, '1 subordinate'],
		['en', 2, '2 subordinates'],
	] as const)('counts %s subordinates: %s', (locale, count, expected) => {
		expect(subordinateCount(locale, count)).toBe(expected);
	});
	it('uses the system language with an English fallback', () => {
		expect(selectLocale('uk-UA')).toBe('uk');
		expect(selectLocale('fr-FR')).toBe('en');
	});
});

describe('the review counts (spec/appearance#evolution-redesign, four uk forms)', () => {
	it.each([
		[1, '1 ризикове місце', '1 новий коміт'],
		[2, '2 ризикові місця', '2 нові коміти'],
		[5, '5 ризикових місць', '5 нових комітів'],
		[11, '11 ризикових місць', '11 нових комітів'],
		[21, '21 ризикове місце', '21 новий коміт'],
		[22, '22 ризикові місця', '22 нові коміти'],
	])('%i', (count, risky, commits) => {
		expect(riskyCount('uk', count)).toBe(risky);
		expect(newCommitCount('uk', count)).toBe(commits);
	});
	it('names comments and threads handed to the agent together', () => {
		expect(handedCount('en', 2, 1)).toBe('2 comments and 1 thread');
		expect(handedCount('uk', 2, 5)).toBe('2 коментарі й 5 тредів');
		expect(handedCount('en', 4, 0)).toBe('4 comments');
		expect(riskyCount('en', 1)).toBe('1 risky spot');
		expect(newCommitCount('en', 2)).toBe('2 new commits');
	});
});
