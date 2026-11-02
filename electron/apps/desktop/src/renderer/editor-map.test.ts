import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { SearchQuery, search, setSearchQuery } from '@codemirror/search';
import type { GutterHunk } from '@brigadir/core';
import { mapLabel, mapMarks } from './editor-map';
import { findStatus } from './editor-find';

const hunk = (start: number, count: number, removedCount = 0): GutterHunk => ({
	start,
	count,
	oldStart: start,
	removed: Array.from({ length: removedCount }, () => 'old'),
	removedCount,
});

describe('change map (spec/editor#editor-chrome)', () => {
	it('names a change as the canvas does', () => {
		expect(mapLabel('en', 'add', 107, 110, hunk(107, 4))).toBe('Added · 107–110 · +4');
		expect(mapLabel('en', 'mod', 19, 19, hunk(19, 1, 1))).toBe('Changed · 19');
		expect(mapLabel('en', 'mod', 19, 21, hunk(19, 3, 2))).toBe('Changed · 19–21');
		expect(mapLabel('en', 'del', 114, 114, hunk(114, 0, 1))).toBe('Deleted · after 114 · −1');
		expect(mapLabel('en', 'del', 1, 1, hunk(0, 0, 2))).toBe('Deleted · before 1 · −2');
		expect(mapLabel('uk', 'add', 45, 46, hunk(45, 2))).toBe('Додано · 45–46 · +2');
	});
	it('places marks in the scale of the whole document; a deletion on the line boundary', () => {
		const state = EditorState.create({
			doc: Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n'),
		});
		const line = (n: number) => state.doc.line(n);
		const placed = [
			{ from: line(10).from, to: line(12).to, hunk: hunk(10, 3) },
			{ from: line(50).from, to: line(50).to, hunk: hunk(50, 0, 2) },
			{ from: line(1).from, to: line(1).to, hunk: hunk(0, 0, 1) },
		];
		// 10 px a line, 1000 px the document.
		const geometry = {
			top: (pos: number) => (state.doc.lineAt(pos).number - 1) * 10,
			bottom: (pos: number) => state.doc.lineAt(pos).number * 10,
			height: 1000,
		};
		const [added, deleted, top] = mapMarks(state, placed, geometry, 'en');
		expect(added).toMatchObject({
			kind: 'add',
			top: 0.09,
			height: 0.03,
			label: 'Added · 10–12 · +3',
		});
		expect(deleted).toMatchObject({
			kind: 'del',
			top: 0.5,
			height: 0,
			label: 'Deleted · after 50 · −2',
		});
		expect(top).toMatchObject({ kind: 'del', top: 0, label: 'Deleted · before 1 · −1' });
	});
});

describe('find counter (spec/editor#editor-chrome)', () => {
	const at = (doc: string, query: string, anchor: number, head: number) =>
		EditorState.create({
			doc,
			selection: EditorSelection.single(anchor, head),
			extensions: search(),
		}).update({
			effects: setSearchQuery.of(new SearchQuery({ search: query, regexp: query === '(' })),
		}).state;
	it('counts the matches and finds the one under the selection', () => {
		const doc = 'alert a alert b alert';
		expect(findStatus(at(doc, 'alert', 8, 13))).toEqual({
			kind: 'found',
			current: 2,
			total: 3,
			capped: false,
		});
		expect(findStatus(at(doc, 'alert', 6, 6))).toEqual({
			kind: 'found',
			current: null,
			total: 3,
			capped: false,
		});
		expect(findStatus(at(doc, 'zzz', 0, 0))).toEqual({ kind: 'none' });
		expect(findStatus(at(doc, '', 0, 0))).toEqual({ kind: 'empty' });
		expect(findStatus(at(doc, '(', 0, 0))).toEqual({ kind: 'invalid' });
	});
});
