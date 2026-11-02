import { expect, it } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { EditorGutter, GutterHunk } from '@brigadir/core';
import { applyGutter, changeCommands, changeGutter } from './editor-gutter';

const actions = { canEdit: () => true, openDiff: () => {} };
const hunk = (start: number, oldStart = start): GutterHunk => ({
	start,
	oldStart,
	count: 1,
	removedCount: 1,
	removed: ['before'],
});
const answer = (hunks: GutterHunk[]): EditorGutter => ({
	state: 'ready',
	base: 'head',
	head: 'commit',
	target: { scopeId: 'scope', path: 'file.js' },
	hunks,
});
function editor() {
	let state = EditorState.create({
		doc: 'one\ntwo\nchanged\nfour\nfive',
		extensions: changeGutter('en', actions),
	});
	return {
		get state() {
			return state;
		},
		dispatch(spec: TransactionSpec) {
			state = state.update(spec).state;
		},
		focus() {},
	} as unknown as EditorView;
}
it('keeps the opened change during edits outside it and follows it when a new earlier hunk arrives', () => {
	const view = editor();
	applyGutter(view, answer([hunk(3)]), view.state.doc);
	changeCommands.next(view);
	view.dispatch({ selection: { anchor: view.state.doc.length } });
	view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
	expect(changeCommands.at(view)?.hunk.oldStart).toBe(3);
	const stale = view.state.doc;
	view.dispatch({ changes: { from: 0, insert: 'new\n' } });
	applyGutter(view, answer([hunk(3)]), stale);
	expect(changeCommands.at(view)?.hunk.oldStart).toBe(3);
	applyGutter(view, answer([hunk(1, 1), hunk(4, 3), hunk(6, 5)]), view.state.doc);
	expect(changeCommands.at(view)?.hunk.oldStart).toBe(3);
	changeCommands.revert(view, actions);
	expect(view.state.doc.toString()).toBe('new\none\ntwo\nbefore\nfour\nfive!');
});
it('closes the peek for an edit in its hunk, a removed hunk or a changed base', () => {
	for (const kind of ['edit', 'removed', 'base']) {
		const view = editor();
		applyGutter(view, answer([hunk(3)]), view.state.doc);
		changeCommands.next(view);
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		if (kind === 'edit')
			view.dispatch({ changes: { from: view.state.doc.line(3).from, insert: 'x' } });
		else
			applyGutter(
				view,
				kind === 'removed' ? answer([]) : ({ ...answer([hunk(3)]), head: 'new' } as EditorGutter),
				view.state.doc
			);
		expect(changeCommands.at(view)).toBeNull();
	}
});
