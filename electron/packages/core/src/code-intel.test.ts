import { describe, expect, it } from 'vitest';
import { codeWordAt, onDeclaration, type CodeLocation } from './code-intel';

const at = (fileId: string, line: number, column: number): CodeLocation => ({
	fileId,
	path: `${fileId}.ts`,
	line,
	column,
	preview: '',
	readOnly: false,
	byName: false,
});
/** The click the editor builds: the word under a 0-based offset of a line, as 1-based columns. */
function click(fileId: string, line: number, text: string, offset: number) {
	const word = codeWordAt(text, offset)!;
	return { fileId, line, from: word.from + 1, to: word.to + 1 };
}

describe('onDeclaration (spec/editor-code-intelligence#definition-and-usages)', () => {
	const declaration = 'export const Button = forwardRef(';
	const here = click('a', 10, declaration, declaration.indexOf('Button') + 3);
	it('is true when the server answers with the clicked name itself', () => {
		expect(onDeclaration([at('a', 10, 14)], here)).toBe(true);
	});
	it('is true when the clicked declaration is one of several (overloads, merged declarations)', () => {
		expect(onDeclaration([at('a', 4, 17), at('b', 1, 1), at('a', 10, 14)], here)).toBe(true);
	});
	it('is false for a usage: the definition is elsewhere', () => {
		expect(onDeclaration([at('b', 10, 14)], here)).toBe(false);
		expect(onDeclaration([at('a', 3, 14)], here)).toBe(false);
		expect(onDeclaration([], here)).toBe(false);
	});
	it('is false for another name on the same line', () => {
		const call = click('a', 10, declaration, declaration.indexOf('forwardRef') + 1);
		expect(onDeclaration([at('a', 10, 14)], call)).toBe(false);
		expect(onDeclaration([at('a', 10, 20)], here)).toBe(false);
	});
	it('holds for the name-based fallback, which points at the declared name too', () => {
		const python = 'def helper():';
		expect(
			onDeclaration([{ ...at('tool', 1, 5), byName: true }], click('tool', 1, python, 6))
		).toBe(true);
		expect(
			onDeclaration([{ ...at('tool', 1, 5), byName: true }], click('main', 2, 'helper()', 2))
		).toBe(false);
	});
});

describe('codeWordAt in style sheets (spec/editor-code-intelligence#hyphenated-words)', () => {
	const line = '--container-medium: calc(var(--page-content) + var(--page-gutter) * 2);';
	const word = (text: string, offset: number, language: string | null) =>
		codeWordAt(text, offset, language)?.word ?? null;
	it('takes a hyphenated name whole, from any of its parts', () => {
		for (const part of ['--page', 'page-', '-content'])
			expect(word(line, line.indexOf('--page-content') + part.length - 1, 'css')).toBe(
				'--page-content'
			);
		expect(word(line, 3, 'scss')).toBe('--container-medium');
		expect(word('padding: $gap-sm;', 12, 'scss')).toBe('$gap-sm');
		expect(word('@include pad-x;', 11, 'scss')).toBe('pad-x');
	});
	it('keeps numbers, a bare minus and other languages as before', () => {
		expect(word('margin: -4px;', 9, 'css')).toBeNull();
		expect(word('calc(a - b)', 7, 'css')).toBeNull();
		expect(word(line, line.indexOf('page-content') + 6, 'typescript')).toBe('content');
		expect(word(line, line.indexOf('page-content') + 6, null)).toBe('content');
	});
});
