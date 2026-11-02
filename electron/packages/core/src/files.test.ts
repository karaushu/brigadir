import { expect, it } from 'vitest';
import { fileStatusLetter, sameFileEntries, type FileEntry } from './files';
it('treats a tree refresh as unchanged only when every shown field matches', () => {
	const entries: FileEntry[] = [
		{ id: 'a', name: 'src', path: 'src', kind: 'directory' },
		{ id: 'b', name: 'a.ts', path: 'a.ts', kind: 'file', status: 'modified' },
	];
	expect(
		sameFileEntries(
			entries,
			entries.map((entry) => ({ ...entry }))
		)
	).toBe(true);
	expect(sameFileEntries(undefined, [])).toBe(false);
	expect(sameFileEntries(entries, entries.slice(1))).toBe(false);
	expect(sameFileEntries(entries, [entries[0]!, { ...entries[1]!, status: 'added' }])).toBe(false);
	expect(sameFileEntries(entries, [entries[0]!, { ...entries[1]!, ignored: true }])).toBe(false);
	expect(
		sameFileEntries(entries, [
			{ ...entries[0]!, scopeName: 'repo', scopeKind: 'submodule' },
			entries[1]!,
		])
	).toBe(false);
});
it('ends a changed file row with its git letter, never a folder (spec/appearance#evolution-redesign)', () => {
	const statuses = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflict'] as const;
	expect(statuses.map((status) => fileStatusLetter({ kind: 'file', status }))).toEqual([
		'M',
		'A',
		'D',
		'R',
		'U',
		'C',
	]);
	expect(fileStatusLetter({ kind: 'file' })).toBeNull();
	expect(fileStatusLetter({ kind: 'directory', status: 'modified' })).toBeNull();
	expect(fileStatusLetter({ kind: 'unavailable', status: 'modified' })).toBeNull();
});
