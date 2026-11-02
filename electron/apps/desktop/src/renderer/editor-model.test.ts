import { expect, it } from 'vitest';
import { EditorModel } from './editor-model';
import type { EditorDocument } from '@brigadir/core';
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
it('retains BOM, uniform or mixed endings and changes separator on an explicit reload', () => {
	for (const [text, separator] of [
		['\uFEFFone\r\ntwo\r\n', '\r\n'],
		['one\r\ntwo\n', '\n'],
	] as const) {
		const model = new EditorModel(document(text, separator));
		expect(model.text()).toBe(text);
		model.state = model.state.update({ changes: { from: 0, to: 0, insert: 'prefix' } }).state;
		expect(model.dirty).toBe(true);
		expect(model.text()).toBe('prefix' + text);
		model.replace(document('external\ncontent\n', '\n'));
		expect(model.text()).toBe('external\ncontent\n');
		expect(model.dirty).toBe(false);
		model.replace(document('windows\r\ncontent\r\n', '\r\n'));
		expect(model.text()).toBe('windows\r\ncontent\r\n');
	}
});
it('tracks the save held until the turn ends and lands it when the disk holds its text (spec/editor#save-during-turn)', () => {
	const model = new EditorModel(document('base\n', '\n'));
	const edit = (insert: string) => {
		model.state = model.state.update({
			changes: { from: model.state.doc.length, insert },
		}).state;
	};
	edit('one\n');
	model.queued = { doc: model.state.doc, text: model.text() };
	expect(model.waiting).toBe(true);
	edit('two\n');
	expect(model.waiting).toBe(false);
	expect(model.landed({ ...document('other\n', '\n'), version: 'v2' })).toBe(false);
	expect(model.landed({ ...document('base\none\n', '\n'), version: 'v2' })).toBe(true);
	expect(model.queued).toBeNull();
	expect(model.document.version).toBe('v2');
	expect(model.dirty).toBe(true);
	model.queued = { doc: model.state.doc, text: model.text() };
	model.keepMine({ ...document('agent\n', '\n'), version: 'v3' });
	expect(model.queued).toBeNull();
	model.queued = { doc: model.state.doc, text: model.text() };
	model.replace({ ...document('agent\n', '\n'), version: 'v3' });
	expect(model.queued).toBeNull();
	expect(model.dirty).toBe(false);
});

import {
	insertNewlineAndIndent,
	toggleComment,
	undo,
	indentMore,
	indentLess,
} from '@codemirror/commands';
import { matchBrackets } from '@codemirror/language';
it('indents nested code, matches brackets, comments a selection and preserves undo', () => {
	const model = new EditorModel({
		...document('function run() {\n  work();\n}', '\n'),
		path: 'run.ts',
	});
	const command = (run: typeof insertNewlineAndIndent) =>
		run({
			get state() {
				return model.state;
			},
			dispatch: (transaction) => {
				model.state = transaction.state;
			},
		});
	model.state = model.state.update({ selection: { anchor: 16 } }).state;
	expect(command(insertNewlineAndIndent)).toBe(true);
	expect(model.text()).toBe('function run() {\n  \n  work();\n}');
	command(undo);
	model.state = model.state.update({ selection: { anchor: 16 } }).state;
	command(insertNewlineAndIndent);
	expect(model.text()).toBe('function run() {\n  \n  work();\n}');
	command(undo);
	model.state = model.state.update({ selection: { anchor: 17, head: 25 } }).state;
	command(toggleComment);
	expect(model.text()).toContain('  // work();');
	command(toggleComment);
	expect(model.text()).toContain('  work();');
	command(indentMore);
	expect(model.text()).toContain('    work();');
	command(indentLess);
	expect(model.text()).toContain('  work();');
	expect(matchBrackets(model.state, 15, 1)?.matched).toBe(true);
});
it('uses Python indentation and comment markers without a language parser', () => {
	const model = new EditorModel({ ...document('def run():', '\n'), path: 'run.py' });
	model.state = model.state.update({ selection: { anchor: model.state.doc.length } }).state;
	insertNewlineAndIndent({
		state: model.state,
		dispatch: (tr) => {
			model.state = tr.state;
		},
	});
	expect(model.text()).toBe('def run():\n    ');
	model.state = model.state.update({ selection: { anchor: 0 } }).state;
	toggleComment({
		state: model.state,
		dispatch: (tr) => {
			model.state = tr.state;
		},
	});
	expect(model.text()).toMatch(/^# def run/);
});
