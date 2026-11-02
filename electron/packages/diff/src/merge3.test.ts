import { expect, it } from 'vitest';
import {
	acceptBoth,
	applyNonConflicting,
	assemble,
	changesApplied,
	conflictsLeft,
	fromResult,
	ignoreSide,
	initialPicks,
	isResolved,
	merge3,
	mergeLines,
	mergeText,
	takeSide,
} from './merge3';

// The board's Printers.ts in miniature: a conflict in the import, ours-only and theirs-only changes, a common change.
const base = mergeLines(
	[
		"import { api } from './client';",
		"import type { Printer } from '../types';",
		'',
		'export function list() {',
		"  return api.get('/printers');",
		'}',
		'',
		'export function test() {',
		"  return api.post('/test');",
		'}',
		'// end',
		'',
	].join('\n')
);
const ours = [
	"import { api, rawApi } from './client';",
	"import type { PrintMethod } from '../types';",
	"import type { Printer } from '../types';",
	'',
	'export function list() {',
	"  return api.get('/printers');",
	'}',
	'',
	'export function test() {',
	"  return api.post('/test');",
	'}',
	'// the end',
];
const theirs = [
	"import { http } from './http';",
	"import type { Printer } from '../types';",
	'',
	'export function list() {',
	"  return http.get('/printers') ?? [];",
	'}',
	'',
	'export function test() {',
	"  return http.post('/test');",
	'}',
	'// the end',
];

it('splits a three-way merge into conflicts, one-sided changes and common changes', () => {
	const merge = merge3(base, ours, theirs);
	expect(merge.chunks.map((chunk) => chunk.kind)).toEqual([
		'conflict', // the import line, and PrintMethod (ours) right under it
		'theirs',
		'theirs',
		'same',
	]);
	expect(merge.chunks[0]).toMatchObject({
		base: { start: 0, end: 1 },
		ours: { start: 0, end: 2 },
		theirs: { start: 0, end: 1 },
	});
	expect(merge.chunks[3]!.base).toEqual({ start: 10, end: 11 });
	expect(merge.chunks[3]!.ours).toEqual({ start: 11, end: 12 });
	expect(merge.chunks[3]!.theirs).toEqual({ start: 10, end: 11 });
	expect(mergeLines('a\r\nb\r\n')).toEqual(['a', 'b']);
	expect(mergeText(['a', 'b'])).toBe('a\nb\n');
	expect(mergeText(['a'], false)).toBe('a');
	expect(mergeLines('')).toEqual([]);
});

it('resolves chunks with » « ✕, Accept both and the non-conflicting toggle', () => {
	const merge = merge3(base, ours, theirs);
	let picks = initialPicks(merge, true);
	expect(conflictsLeft(merge, picks)).toBe(1);
	expect(changesApplied(merge, picks)).toBe(3);
	let result = assemble(merge, picks);
	expect(result.lines[4]).toBe("  return http.get('/printers') ?? [];");
	expect(result.lines.at(-1)).toBe('// the end');
	// The conflict stays the base until a side goes in.
	expect(result.lines.slice(0, 2)).toEqual(base.slice(0, 2));
	expect(result.ranges[0]).toEqual({ start: 0, end: 1 });

	// » — yours; the conflict is resolved and «+ would add theirs below.
	picks[0] = takeSide(picks[0]!, 'ours');
	expect(isResolved(merge.chunks[0]!, picks[0]!)).toBe(true);
	expect(conflictsLeft(merge, picks)).toBe(0);
	picks[0] = takeSide(picks[0]!, 'theirs');
	result = assemble(merge, picks);
	expect(result.lines.slice(0, 4)).toEqual([...ours.slice(0, 2), ...theirs.slice(0, 2)]);
	expect(result.ranges[0]).toEqual({ start: 0, end: 3 });
	// ✕ on yours leaves theirs only.
	picks[0] = ignoreSide(picks[0]!, 'ours');
	expect(assemble(merge, picks).lines.slice(0, 2)).toEqual(theirs.slice(0, 2));
	// ✕ on one side of a fresh conflict does not resolve it; on both it does (the base stays).
	let fresh = ignoreSide({ taken: [], ignored: [] }, 'ours');
	expect(isResolved(merge.chunks[0]!, fresh)).toBe(false);
	fresh = ignoreSide(fresh, 'theirs');
	expect(isResolved(merge.chunks[0]!, fresh)).toBe(true);
	// Accept both: yours, then theirs.
	expect(acceptBoth(merge.chunks[0]!)).toEqual({ taken: ['ours', 'theirs'], ignored: [] });

	// The toggle off: the Result keeps the base for changes that do not conflict; a typed chunk stays.
	picks[1] = { taken: [], ignored: [], edited: true };
	const off = applyNonConflicting(merge, picks, false);
	expect(off[1]).toEqual({ taken: [], ignored: [], edited: true });
	expect(off[2]).toEqual({ taken: [], ignored: [] });
	expect(changesApplied(merge, off)).toBe(0);
	expect(assemble(merge, off).lines.at(-1)).toBe('// end');
	expect(applyNonConflicting(merge, off, true)[3]).toEqual({ taken: ['ours'], ignored: [] });
});

it('reads the agent’s text back into chunks with ✦ and says which side each one kept', () => {
	const merge = merge3(base, ours, theirs);
	const agent = [
		"import { rawApi } from './client';",
		"import { http } from './http';",
		"import type { PrintMethod } from '../types';",
		"import type { Printer } from '../types';",
		'',
		'export function list() {',
		"  return http.get('/printers') ?? [];",
		'}',
		'',
		'export function test() {',
		"  return http.post('/test');",
		'}',
		'// the end',
	];
	const read = fromResult(merge, agent);
	expect(read.ranges[0]).toEqual({ start: 0, end: 3 });
	expect(read.choices).toEqual(['own', 'theirs', 'theirs', 'ours']);
	expect(read.picks[0]).toEqual({ taken: [], ignored: [], agent: true });
	expect(read.picks[1]).toEqual({ taken: ['theirs'], ignored: [] });
	expect(conflictsLeft(merge, read.picks)).toBe(0);
	// Taking a side after the agent replaces its text.
	expect(takeSide(read.picks[0]!, 'ours')).toEqual({ taken: ['ours'], ignored: [] });
	// An insertion of both sides at the same place is one empty-base conflict.
	const both = merge3(['a', 'z'], ['a', 'b', 'z'], ['a', 'c', 'z']);
	expect(both.chunks).toEqual([
		{
			kind: 'conflict',
			base: { start: 1, end: 1 },
			ours: { start: 1, end: 2 },
			theirs: { start: 1, end: 2 },
		},
	]);
	expect(fromResult(both, ['a', 'b', 'c', 'z'])).toMatchObject({
		ranges: [{ start: 1, end: 3 }],
		choices: ['both'],
	});
});
