import { expect, it } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorDocument } from '@brigadir/core';
import { EditorModel } from './editor-model';
import { formatEdits } from '../main/format';
const document = (
	text: string,
	version = 'v0',
	lineEnding: '\n' | '\r\n' = '\n'
): EditorDocument => ({
	text,
	lineEnding,
	id: 'id',
	path: 'file.txt',
	version,
	mode: 0o644,
	locked: false,
	state: 'text',
	large: false,
});
const type = (model: EditorModel, at: number, insert: string) => {
	model.state = model.state.update({
		changes: { from: at, insert },
		userEvent: 'input.type',
	}).state;
};
const undoOn = (model: EditorModel) =>
	undo({
		state: model.state,
		dispatch: (transaction) => {
			model.state = transaction.state;
		},
	});

// ⌘Z after a reload from disk is allowed, but never leaves a clean buffer.
it('marks the buffer dirty after ⌘Z takes a disk reload back, and keeps the reload apart from the typing before it', () => {
	const model = new EditorModel(document('one\ntwo\n'));
	type(model, 0, 'x');
	expect(model.dirty).toBe(true);
	model.replace(document('one\ntwo\nthree\n', 'v1'));
	expect(model.dirty).toBe(false);
	expect(model.text()).toBe('one\ntwo\nthree\n');
	// One ⌘Z undoes the reload only: the typing before it is a separate step.
	expect(undoOn(model)).toBe(true);
	expect(model.text()).toBe('xone\ntwo\n');
	expect(model.dirty).toBe(true);
	// The save that follows is a deliberate overwrite against the disk version, which the document already holds.
	expect(model.document.version).toBe('v1');
	expect(undoOn(model)).toBe(true);
	expect(model.text()).toBe('one\ntwo\n');
	expect(model.dirty).toBe(true);
	// Typing right after a reload does not join the reload's undo step.
	const quiet = new EditorModel(document('a\n'));
	quiet.replace(document('a\nb\n', 'v1'));
	type(quiet, 0, 'z');
	expect(undoOn(quiet)).toBe(true);
	expect(quiet.text()).toBe('a\nb\n');
	expect(quiet.dirty).toBe(false);
});
it('is dirty after undo to the old text even when the reload changed nothing but the version', () => {
	const model = new EditorModel(document('same\n'));
	type(model, 0, 'x');
	model.replace(document('same\n', 'v1'));
	expect(undoOn(model)).toBe(true);
	expect(model.dirty).toBe(true);
});

// Suspicion 2: «Keep mine» makes the disk text the base, so undo to the old base is dirty, not a silent stale buffer.
it('compares the buffer with the disk text after «Keep mine»', () => {
	const model = new EditorModel(document('base\n'));
	type(model, 0, 'mine ');
	expect(model.dirty).toBe(true);
	model.conflict = document('disk\n', 'v1');
	model.keepMine(model.conflict);
	expect(model.conflict).toBeNull();
	expect(model.document.version).toBe('v1');
	expect(model.dirty).toBe(true);
	expect(undoOn(model)).toBe(true);
	expect(model.text()).toBe('base\n');
	expect(model.dirty).toBe(true); // the old base is no longer what the disk holds
	// A buffer that equals the disk text is clean.
	model.state = model.state.update({
		changes: { from: 0, to: model.state.doc.length, insert: 'disk\n' },
	}).state;
	expect(model.dirty).toBe(false);
	// The buffer keeps its own line breaks.
	const crlf = new EditorModel(document('a\r\nb\r\n', 'v0', '\r\n'));
	type(crlf, 0, 'x');
	crlf.keepMine(document('a\nb\nc\n', 'v1'));
	expect(crlf.document.lineEnding).toBe('\r\n');
	expect(crlf.text()).toBe('xa\r\nb\r\n');
});

// Suspicion 3: the conflict goes away by itself when the disk text is the buffer text again.
it('settles a conflict when the disk holds the buffer text', () => {
	const model = new EditorModel(document('base\n'));
	type(model, 0, 'mine ');
	model.conflict = document('other\n', 'v1');
	expect(model.settle(document('other again\n', 'v2'))).toBe(false);
	expect(model.dirty).toBe(true);
	expect(model.settle(document('mine base\n', 'v3'))).toBe(true);
	expect(model.conflict).toBeNull();
	expect(model.dirty).toBe(false);
	expect(model.document.version).toBe('v3');
	// A disk that cannot be read as text never settles.
	expect(
		model.settle({ ...document('mine base\n', 'v4'), state: 'binary' } as EditorDocument)
	).toBe(false);
});

// Suspicion 4: the synced text of a CRLF document holds LF breaks, so edits come only where the text changed.
it('makes formatter edits only on the lines that changed in a CRLF document', () => {
	const model = new EditorModel(
		document('const  a = "x";\r\nconst b = 1;\r\nconst c = 2;\r\n', 'v0', '\r\n')
	);
	const mirror = model.state.doc.toString();
	expect(mirror).not.toContain('\r');
	const edits = formatEdits(mirror, mirror.replace('const  a', 'const a'));
	expect(edits).toHaveLength(1);
	expect(edits[0]).toEqual({ from: 6, to: 7, insert: '' });
	model.state = model.state.update({ changes: edits }).state;
	expect(model.text()).toBe('const a = "x";\r\nconst b = 1;\r\nconst c = 2;\r\n');
});
