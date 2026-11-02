import { describe, expect, it } from 'vitest';
import { codeSelection, quoteLines, selectionCaption } from './code-selection';

const piece = (side: 'old' | 'new', line: number, text: string, from = 0, to = text.length) => ({
	side,
	line,
	text,
	from,
	to,
});

describe('code selection (spec/appearance#evolution-redesign)', () => {
	it('anchors to the lines the text touches and quotes the text itself', () => {
		const selection = codeSelection([
			piece('new', 109, '    if (isJustEat) {', 8),
			piece('new', 110, '      return alert(x);'),
			piece('new', 111, '      return Alert.alert', 0, 18),
		]);
		expect(selection).toMatchObject({ side: 'new', start: 109, end: 111 });
		expect(selection?.quote).toBe('isJustEat) {\n      return alert(x);\n      return Alert');
		expect(selection?.marks.map((mark) => [mark.line, mark.from, mark.to])).toEqual([
			[109, 8, 20],
			[110, 0, 22],
			[111, 0, 18],
		]);
	});
	it('drops an empty edge: a selection from the end of a line, a triple click into the next one', () => {
		expect(
			codeSelection([piece('new', 4, 'abc', 3), piece('new', 5, 'def'), piece('new', 6, 'x', 0, 0)])
		).toMatchObject({ start: 5, end: 5, quote: 'def' });
		// A blank line inside the selection stays.
		expect(
			codeSelection([piece('new', 1, 'a'), piece('new', 2, ''), piece('new', 3, 'b')])?.quote
		).toBe('a\n\nb');
		expect(codeSelection([piece('new', 1, 'a', 1)])).toBeNull();
	});
	it('a unified selection over removed and added lines anchors to the new ones; removed only — to the old side', () => {
		expect(
			codeSelection([piece('old', 19, 'import { Modal }', 9), piece('new', 19, 'import { Alert }')])
		).toMatchObject({ side: 'new', start: 19, end: 19, quote: 'Modal }\nimport { Alert }' });
		expect(codeSelection([piece('old', 18, 'a'), piece('old', 19, 'b')])).toMatchObject({
			side: 'old',
			start: 18,
			end: 19,
		});
	});
	it('names the side only for the old one', () => {
		expect(selectionCaption('handleToggleStatus', 110, 111)).toBe('handleToggleStatus · 110–111');
		expect(selectionCaption('handleToggleStatus', 110, 110)).toBe('handleToggleStatus · 110');
		expect(selectionCaption('index.tsx', 18, 19, 'old')).toBe('index.tsx · 18–19 · old');
	});
	it('shows three lines without their shared indent, then how many follow', () => {
		expect(quoteLines('isJustEat) {\n      if (a) {\n      return b;\n    }\n  };')).toEqual({
			lines: ['isJustEat) {', '    if (a) {', '    return b;'],
			more: 2,
		});
		expect(quoteLines('  const a = 1;\n')).toEqual({ lines: ['const a = 1;'], more: 0 });
	});
});
