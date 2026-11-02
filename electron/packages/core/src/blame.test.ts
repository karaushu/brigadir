import { describe, expect, it } from 'vitest';
import { ageAgo, ageShort, authorInitials, bufferToDisk, fileCommitCount } from './blame';
import type { GutterHunk } from './changes';

const hunk = (
	start: number,
	count: number,
	oldStart: number,
	removedCount: number
): GutterHunk => ({ start, count, oldStart, removed: [], removedCount });
const day = 86_400_000,
	now = Date.UTC(2026, 8, 30, 12);

describe('line author (spec/editor#line-author)', () => {
	it('maps buffer lines to disk lines around added, changed and removed lines', () => {
		expect([...bufferToDisk([], 3)]).toEqual([1, 2, 3]);
		// Line 2 added: buffer 3 is disk 2.
		expect([...bufferToDisk([hunk(2, 1, 2, 0)], 4)]).toEqual([1, 0, 2, 3]);
		// Line 2 changed in place.
		expect([...bufferToDisk([hunk(2, 1, 2, 1)], 3)]).toEqual([1, 0, 3]);
		// Disk line 2 removed after buffer line 1: buffer 2 is disk 3.
		expect([...bufferToDisk([hunk(1, 0, 2, 1)], 2)]).toEqual([1, 3]);
		// Removed at the top of the file.
		expect([...bufferToDisk([hunk(0, 0, 1, 2)], 2)]).toEqual([3, 4]);
		// Two hunks: two lines replace one, then a deletion below.
		expect([...bufferToDisk([hunk(2, 2, 2, 1), hunk(5, 0, 5, 1)], 7)]).toEqual([
			1, 0, 0, 3, 4, 6, 7,
		]);
	});
	it('says the long age with four Ukrainian forms', () => {
		expect(ageAgo('uk', now - 20_000, now)).toBe('щойно');
		expect(ageAgo('uk', now - 5 * 60_000, now)).toBe('5 хвилин тому');
		expect(ageAgo('uk', now - 1 * 60_000, now)).toBe('1 хвилину тому');
		expect(ageAgo('uk', now - 3 * 3_600_000, now)).toBe('3 години тому');
		expect(ageAgo('uk', now - 2 * day, now)).toBe('2 дні тому');
		expect(ageAgo('uk', now - 21 * day, now)).toBe('3 тижні тому');
		expect(ageAgo('uk', now - 125 * day, now)).toBe('4 місяці тому');
		expect(ageAgo('uk', now - (365 + 215) * day, now)).toBe('1 рік 7 місяців тому');
		expect(ageAgo('uk', now - 5 * 366 * day, now)).toBe('5 років тому');
		expect(ageAgo('en', now - (365 + 215) * day, now)).toBe('1 year, 7 months ago');
		expect(ageAgo('en', now - 1 * day, now)).toBe('1 day ago');
	});
	it('says the short age of the History list', () => {
		expect(ageShort('uk', now - 4 * day, now)).toBe('4 дн');
		expect(ageShort('uk', now - 16 * day, now)).toBe('2 тиж');
		expect(ageShort('uk', now - 125 * day, now)).toBe('4 міс');
		expect(ageShort('uk', now - (365 + 215) * day, now)).toBe('1 р 7 міс');
		expect(ageShort('uk', now - 30_000, now)).toBe('зараз');
		expect(ageShort('en', now - 3 * 3_600_000, now)).toBe('3 hr');
	});
	it('counts commits with a file in four forms', () => {
		expect(fileCommitCount('uk', 1)).toBe('1 коміт із цим файлом');
		expect(fileCommitCount('uk', 3)).toBe('3 коміти із цим файлом');
		expect(fileCommitCount('uk', 6)).toBe('6 комітів із цим файлом');
		expect(fileCommitCount('uk', 21)).toBe('21 коміт із цим файлом');
		expect(fileCommitCount('uk', 100, true)).toBe('100+ комітів із цим файлом');
		expect(fileCommitCount('en', 1)).toBe('1 commit with this file');
	});
	it('makes avatar initials', () => {
		expect(authorInitials('Ada Lovelace')).toBe('AL');
		expect(authorInitials('dmytro')).toBe('D');
	});
});
