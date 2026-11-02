import { describe, expect, it } from 'vitest';
import { pasteKind } from './composer-paste';

describe('composer paste (spec/composer#paste)', () => {
	it('attaches an image when the clipboard has no text', () => {
		expect(pasteKind('', true)).toBe('image');
		// A clipboard the event does not show as a file still goes to main, which answers null when it holds no image.
		expect(pasteKind('', false)).toBe('image');
	});
	it('keeps text paste as it was', () => {
		expect(pasteKind('hello', false)).toBe('text');
		expect(pasteKind('  ', false)).toBe('text');
		expect(pasteKind('https://example.com/a.png', false)).toBe('text');
	});
	it('lets text win over the picture a spreadsheet adds', () => {
		expect(pasteKind('a\tb\n1\t2', true)).toBe('text');
		expect(pasteKind('Screenshot 2026-10-01.png', true)).toBe('text');
	});
	it('attaches the image when the text is only its address', () => {
		expect(pasteKind('https://example.com/a.png', true)).toBe('image');
		expect(pasteKind(' https://example.com/a.png\n', true)).toBe('image');
		expect(pasteKind('see https://example.com/a.png', true)).toBe('text');
	});
});
