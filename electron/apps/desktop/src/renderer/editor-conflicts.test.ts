import { expect, it } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { conflictMarkers } from './editor-conflicts';
const lines = (state: EditorState) => {
	const found: string[] = [];
	for (const source of state.facet(EditorView.decorations)) {
		const set = typeof source === 'function' ? source(null as never) : source;
		set.between(0, state.doc.length, (from, _to, value) => {
			const name = value.spec.class as string | undefined;
			if (name) found.push(`${state.doc.lineAt(from).number}:${name}`);
		});
	}
	return found;
};
const block = '<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n';
it('finds conflict places after typing, pasting or joining lines without rescanning clean documents (EDIT-04)', () => {
	let state = EditorState.create({ doc: 'a\nb\n', extensions: [conflictMarkers('en')] });
	const apply = (spec: TransactionSpec) => {
		state = state.update(spec).state;
	};
	expect(lines(state)).toEqual([]);
	apply({ changes: { from: 0, insert: 'x' } });
	expect(lines(state)).toEqual([]);
	apply({ changes: { from: state.doc.length, insert: block } });
	expect(lines(state)).toEqual([
		'3:cm-conflict-marker',
		'4:cm-conflict-ours',
		'5:cm-conflict-marker',
		'6:cm-conflict-theirs',
		'7:cm-conflict-marker',
	]);
	// A new line inside the block is decorated too, and resolving the block removes every decoration.
	apply({ changes: { from: state.doc.line(4).to, insert: '\nmore mine' } });
	expect(lines(state)).toContain('5:cm-conflict-ours');
	apply({ changes: { from: state.doc.line(3).from, to: state.doc.line(8).to + 1, insert: '' } });
	expect(lines(state)).toEqual([]);
	// Typed one character at a time, and a marker made by deleting the text between its halves.
	for (const char of '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n')
		apply({ changes: { from: state.doc.length, insert: char } });
	expect(lines(state)).toHaveLength(5);
	state = EditorState.create({
		doc: '<<<<<<< a\nx\n=======\ny\n>>>|>>>> b\n',
		extensions: [conflictMarkers('en')],
	});
	expect(lines(state)).toEqual([]);
	const bar = state.doc.toString().indexOf('|');
	apply({ changes: { from: bar, to: bar + 1, insert: '' } });
	expect(lines(state)).toHaveLength(5);
});
it('costs little per keystroke in a long document without markers', () => {
	let state = EditorState.create({
		doc: Array.from({ length: 47000 }, (_, i) => `const line${i} = ${i};`).join('\n'),
		extensions: [conflictMarkers('en')],
	});
	const start = performance.now();
	for (let i = 0; i < 200; i++)
		state = state.update({ changes: { from: i * 3, insert: 'x' } }).state;
	const perKey = (performance.now() - start) / 200;
	expect(perKey).toBeLessThan(1);
});
