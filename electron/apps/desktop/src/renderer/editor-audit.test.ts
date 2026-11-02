import { expect, it } from 'vitest';
import type { EditorDocument } from '@brigadir/core';
import { EditorModel } from './editor-model';
import { conflictBlocks, resolvedText } from './editor-conflicts';
const document = (text: string, lineEnding: '\n' | '\r\n'): EditorDocument => ({
	text,
	lineEnding,
	id: 'id',
	path: 'file',
	version: 'version',
	mode: 0o644,
	locked: false,
	state: 'text',
	large: false,
});

// Pasted, formatted or resolved text carries LF; in a CRLF document it must still break lines (spec/editor#files-and-save: breaks are kept).
it('keeps a CRLF document CRLF when text with LF breaks is inserted (paste, format edit, quick apply)', () => {
	const model = new EditorModel(document('one\r\ntwo\r\n', '\r\n'));
	model.state = model.state.update({
		changes: { from: 3, insert: '\npasted\nlines' },
		userEvent: 'input.paste',
	}).state;
	expect(model.text()).toBe('one\r\npasted\r\nlines\r\ntwo\r\n');
	expect(model.state.doc.lines).toBe(5);
	// The selection keeps its place: only the representation of the breaks changes.
	const moved = model.state.update({
		changes: { from: 0, insert: 'a\nb' },
		selection: { anchor: 3 },
	});
	expect(moved.state.selection.main.head).toBe(3);
	expect(moved.state.sliceDoc()).toMatch(/^a\r\nb/);
	model.state = moved.state;
	model.state = model.state.update({
		changes: { from: 0, to: model.state.doc.length, insert: 'x\r\ny\nz' },
	}).state;
	expect(model.text()).toBe('x\r\ny\r\nz');
	// An LF document is left as it is.
	const lf = new EditorModel(document('one\ntwo', '\n'));
	lf.state = lf.state.update({ changes: { from: 0, insert: 'a\r\nb' } }).state;
	expect(lf.text()).toBe('a\r\nbone\ntwo');
});
it('resolves a conflict in a CRLF file with CRLF breaks', () => {
	const model = new EditorModel(
		document(
			'top\r\n<<<<<<< ours\r\nA1\r\nA2\r\n=======\r\nB1\r\nB2\r\n>>>>>>> theirs\r\nbottom\r\n',
			'\r\n'
		)
	);
	const block = conflictBlocks(model.state)[0]!;
	model.state = model.state.update({
		changes: { from: block.from, to: block.to, insert: resolvedText(block, 'both') },
	}).state;
	expect(model.text()).toBe('top\r\nA1\r\nA2\r\nB1\r\nB2\r\nbottom\r\n');
});
it('keeps the caret of a clean buffer when the file changes on disk', () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
	const model = new EditorModel(document(lines.join('\n'), '\n'));
	const caret = model.state.doc.line(60).from + 2;
	model.state = model.state.update({ selection: { anchor: caret } }).state;
	const next = [...lines];
	next[2] = 'changed on disk';
	model.replace(document(next.join('\n'), '\n'));
	expect(model.text()).toBe(next.join('\n'));
	expect(model.state.doc.lineAt(model.state.selection.main.head).number).toBe(60);
	expect(model.state.selection.main.head - model.state.doc.line(60).from).toBe(2);
	// A change under the caret moves it to the edge of the change, never to the start of the file.
	next[59] = 'line 59 rewritten';
	model.replace(document(next.join('\n'), '\n'));
	expect(model.state.doc.lineAt(model.state.selection.main.head).number).toBe(60);
	// The separator switches with the text and the caret stays.
	model.replace(document(next.join('\r\n'), '\r\n'));
	expect(model.text()).toBe(next.join('\r\n'));
	expect(model.state.doc.lineAt(model.state.selection.main.head).number).toBe(60);
});
