import { describe, expect, it } from 'vitest';
import { contextTextLimit, type DiffLine } from '@brigadir/core';
import { clipSelections, diffChanges, diffLinesText } from './context-sources';
import { heldDiffSelection, type DiffSelection } from './diff-selection';

const line = (
	kind: DiffLine['kind'],
	oldLine: number | null,
	newLine: number | null
): DiffLine => ({
	kind,
	text: `${kind} ${oldLine ?? '-'}/${newLine ?? '-'}`,
	oldLine,
	newLine,
});
// Old 1–5 → new 1–5: line 2 changed (removed 2, added 2), old 4 removed, new 5 added.
const lines = [
	line('context', 1, 1),
	line('removed', 2, null),
	line('added', null, 2),
	line('context', 3, 3),
	line('removed', 4, null),
	line('context', 5, 4),
	line('added', null, 5),
];

describe('editor_state sources (spec/agents-and-providers#editor-state)', () => {
	it('tells which selected diff lines are changes on their side', () => {
		expect(diffChanges(lines, 'new', 1, 5)).toEqual([
			{ start: 2, end: 2 },
			{ start: 5, end: 5 },
		]);
		expect(diffChanges(lines, 'old', 2, 4)).toEqual([
			{ start: 2, end: 2 },
			{ start: 4, end: 4 },
		]);
		expect(diffChanges(lines, 'new', 3, 4)).toEqual([]);
		expect(diffChanges([line('added', null, 7), line('added', null, 8)], 'new', 7, 8)).toEqual([
			{ start: 7, end: 8 },
		]);
		expect(diffLinesText(lines, 'old', 2, 3)).toBe('removed 2/-\ncontext 3/3');
	});
	it('shares one text limit between the selections', () => {
		const [first, second, third] = clipSelections([
			'a'.repeat(contextTextLimit - 10),
			'b'.repeat(30),
			'c',
		]);
		expect(first).toEqual({ text: 'a'.repeat(contextTextLimit - 10) });
		expect(second).toEqual({ text: 'b'.repeat(10), truncated: true, length: 30 });
		expect(third).toEqual({ text: '', truncated: true, length: 1 });
	});
	it('keeps the diff selection for the agent when the person goes to the chat, drops it on a click in the diff', () => {
		const range = { side: 'new', start: 3, end: 5 } as DiffSelection,
			inside = {} as Node,
			outside = {} as Node,
			root = { contains: (node: Node | null) => node === inside };
		const next = { side: 'old', start: 1, end: 1 } as DiffSelection;
		expect(heldDiffSelection(next, range, root, inside)).toBe(next);
		// The page's selection moved to the composer or the console.
		expect(heldDiffSelection(null, range, root, outside)).toBe(range);
		// A click in the diff collapsed it there; no selection at all.
		expect(heldDiffSelection(null, range, root, inside)).toBeNull();
		expect(heldDiffSelection(null, range, root, null)).toBeNull();
	});
});
