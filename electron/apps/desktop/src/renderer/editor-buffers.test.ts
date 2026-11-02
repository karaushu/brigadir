import { expect, it } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorDocument } from '@brigadir/core';
import { EditorModel } from './editor-model';
import {
	bufferChars,
	bufferLimit,
	evictBuffers,
	restoreBuffer,
	touchBuffer,
} from './editor-buffers';
const file = (id: string, text = `${id}\n`): EditorDocument => ({
	text,
	lineEnding: '\n',
	id,
	path: `src/${id}.ts`,
	version: 'v',
	mode: 0o644,
	locked: false,
	state: 'text',
	large: false,
});
const open = (count: number) =>
	Array.from({ length: count }, (_, i) => {
		const model = new EditorModel(file(`f${i}`));
		touchBuffer(model);
		return model;
	});
it('evicts the least recently used clean buffers past the limit and keeps their place', () => {
	const tabs = open(bufferLimit + 2);
	touchBuffer(tabs[0]!);
	tabs[1]!.state = tabs[1]!.state.update({ selection: { anchor: 2 } }).state;
	tabs[1]!.scrollTop = 40;
	expect(evictBuffers(tabs.slice(0, bufferLimit), 'f0', null, new Map())).toBeNull();
	const result = evictBuffers(tabs, `f${bufferLimit + 1}`, null, new Map())!;
	expect(result.editorTabs.map((tab) => tab.document.id)).toEqual(
		tabs.filter((_, i) => i !== 1 && i !== 2).map((tab) => tab.document.id)
	);
	expect(result.evictedEditors.get('f1')).toEqual({
		path: 'src/f1.ts',
		anchor: { line: 1, column: 2 },
		head: { line: 1, column: 2 },
		scrollTop: 40,
		scrollLeft: 0,
		conflict: false,
	});
	expect(
		restoreBuffer({ ...file('f1'), text: 'f' }, result.evictedEditors.get('f1')).state.selection
			.main.head
	).toBe(1);
	const back = restoreBuffer(
		{ ...file('f1'), text: 'new first line\nf1 and more\n' },
		{ ...result.evictedEditors.get('f1')!, head: { line: 2, column: 3 } }
	);
	expect(back.state.selection.main.anchor).toBe(2);
	expect(back.state.selection.main.head).toBe(18);
	expect(back.scrollTop).toBe(40);
});
it('never evicts the active, dirty, saving, conflicted, drafted or undoable buffer', () => {
	const tabs = open(bufferLimit + 6),
		[active, dirty, saving, conflict, draft, saved] = tabs;
	dirty!.state = dirty!.state.update({ changes: { from: 0, insert: 'x' } }).state;
	saving!.saving = true;
	conflict!.conflict = file('f3', 'disk\n');
	saved!.state = saved!.state.update({ changes: { from: 0, insert: 'x' } }).state;
	undo({
		state: saved!.state,
		dispatch: (tr) => {
			saved!.state = tr.state;
		},
	});
	expect(saved!.dirty).toBe(false);
	const result = evictBuffers(tabs, active!.document.id, draft!.document.id, new Map())!;
	expect([...result.evictedEditors.keys()]).toEqual(['f6', 'f7', 'f8', 'f9', 'f10', 'f11']);
	expect(result.editorTabs).toHaveLength(bufferLimit);
	const conflicted = new EditorModel(file('c', '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n'));
	touchBuffer(conflicted);
	expect(
		evictBuffers([conflicted, ...open(bufferLimit)], null, null, new Map())!.evictedEditors.get('c')
			?.conflict
	).toBe(true);
});
it('also evicts by total text size', () => {
	const big = (id: string) => {
		const model = new EditorModel(file(id, 'x'.repeat(bufferChars / 2 + 1)));
		touchBuffer(model);
		return model;
	};
	const result = evictBuffers([big('a'), big('b')], 'b', null, new Map())!;
	expect(result.editorTabs.map((tab) => tab.document.id)).toEqual(['b']);
	expect(result.evictedEditors.has('a')).toBe(true);
});
