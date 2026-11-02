import { expect, it } from 'vitest';
import { indentLess, indentMore, insertNewlineAndIndent } from '@codemirror/commands';
import { EditorModel } from './editor-model';
import type { EditorDocument, IndentSettings, ProjectIndent } from '@brigadir/core';
const auto: IndentSettings = { indentStyle: 'auto', indentSize: 2, tabWidth: 'auto' };
const open = (path: string, text: string): EditorModel =>
	new EditorModel({
		text,
		lineEnding: '\n',
		id: 'id',
		path,
		version: 'v',
		mode: 0o644,
		locked: false,
		state: 'text',
		large: false,
	} as EditorDocument);
const run = (model: EditorModel, command: typeof insertNewlineAndIndent) =>
	command({
		get state() {
			return model.state;
		},
		dispatch: (transaction) => {
			model.state = transaction.state;
		},
	});
/** `|` marks the caret; returns the document after one Enter with the caret shown again. */
function enter(
	path: string,
	marked: string,
	settings: IndentSettings = auto,
	project: ProjectIndent | null = null,
	times = 1
) {
	const at = marked.indexOf('|');
	const model = open(path, marked.replace('|', ''));
	const effect = model.setIndent(settings, project);
	if (effect) model.state = model.state.update({ effects: effect }).state;
	model.state = model.state.update({ selection: { anchor: at } }).state;
	for (let i = 0; i < times; i++) run(model, insertNewlineAndIndent);
	const head = model.state.selection.main.head;
	return { text: model.text().slice(0, head) + '|' + model.text().slice(head), model };
}
const T = '\t';
it('Enter after an opening brace adds exactly one level in tab, 2, 4 and 8 space files for every language', () => {
	for (const path of ['a.ts', 'a.tsx', 'a.css', 'a.json', 'a.js', 'a.go']) {
		expect(enter(path, `a {\n${T}b {|\n${T}}\n}\n`).text).toBe(
			`a {\n${T}b {\n${T}${T}|\n${T}}\n}\n`
		);
		for (const n of [2, 4, 8]) {
			const sp = ' '.repeat(n);
			expect(enter(path, `a {\n${sp}b {|\n${sp}}\n}\n`).text).toBe(
				`a {\n${sp}b {\n${sp}${sp}|\n${sp}}\n}\n`
			);
			expect(enter(path, `a {\n${sp}b: 1;|\n}\n`).text).toBe(`a {\n${sp}b: 1;\n${sp}|\n}\n`);
		}
	}
});
it('Enter at the end of a plain line keeps its indentation and adds nothing', () => {
	expect(enter('a.ts', `function f() {\n${T}foo();|\n}\n`).text).toBe(
		`function f() {\n${T}foo();\n${T}|\n}\n`
	);
	expect(enter('a.py', `def f():\n${T}return 1|\n`).text).toBe(`def f():\n${T}return 1\n${T}|\n`);
	expect(enter('a.md', '- a\n  - b|\n').text).toBe('- a\n  - b\n  |\n');
	// A file without indentation adds none on Enter.
	expect(enter('a.ts', 'x();|\n').text).toBe('x();\n|\n');
	expect(enter('a.yaml', 'a:\n  b: 1|\n').text).toBe('a:\n  b: 1\n  |\n');
	expect(enter('a.txt', `${T}foo|\n${T}bar\n`).text).toBe(`${T}foo\n${T}|\n${T}bar\n`);
	expect(enter('a.txt', 'x|\n').text).toBe('x\n|\n');
});
it('Enter in the middle of a line keeps the level of that line, and opens one after an opener', () => {
	expect(enter('a.ts', `function f() {\n${T}foo(a,| b);\n}\n`).text).toBe(
		`function f() {\n${T}foo(a,\n${T}|b);\n}\n`
	);
	expect(enter('a.ts', `function f() {\n${T}foo(|a);\n}\n`).text).toBe(
		`function f() {\n${T}foo(\n${T}${T}|a);\n}\n`
	);
	expect(enter('a.ts', `function f() {\n${T}foo(a|);\n}\n`).text).toBe(
		`function f() {\n${T}foo(a\n${T}|);\n}\n`
	);
});
it('Enter between a pair of brackets opens a body and puts the closer at the line level', () => {
	expect(enter('a.ts', 'function f() {|}\n').text).toBe('function f() {\n  |\n}\n');
	expect(enter('a.ts', `function f() {\n${T}if (x) {|}\n}\n`).text).toBe(
		`function f() {\n${T}if (x) {\n${T}${T}|\n${T}}\n}\n`
	);
	expect(enter('a.ts', 'f([|])\n', { ...auto, indentStyle: 'spaces', indentSize: 4 }).text).toBe(
		'f([\n    |\n])\n'
	);
});
it('Enter on an empty or indented-blank line keeps the block level, also three times in a row', () => {
	expect(enter('a.ts', `function f() {\n${T}x();\n${T}|\n}\n`).text).toBe(
		`function f() {\n${T}x();\n\n${T}|\n}\n`
	);
	expect(enter('a.ts', `function f() {\n${T}foo();\n\n|\n}\n`).text).toBe(
		`function f() {\n${T}foo();\n\n\n${T}|\n}\n`
	);
	expect(enter('a.ts', 'if (a) {\n|\n}\n', auto, null, 1).text).toBe('if (a) {\n\n  |\n}\n');
	expect(enter('a.ts', `function f() {|\n}\n`, auto, null, 3).text).toBe(
		'function f() {\n\n\n  |\n}\n'
	);
	expect(enter('a.ts', 'x();\n\n|y();\n').text).toBe('x();\n\n\n|y();\n');
});
it('Enter before a closing bracket at the start of its line puts the bracket at the opener level', () => {
	expect(
		enter('a.ts', `function f() {\n${T}if (x) {\n${T}${T}foo();\n|${T}${T}}\n${T}}\n}\n`).text
	).toBe(`function f() {\n${T}if (x) {\n${T}${T}foo();\n\n${T}|}\n${T}}\n}\n`);
});
it('Python opens a level after a colon in 4 spaces and in tabs; JSON and markdown follow their own file', () => {
	expect(enter('a.py', 'def f():|\n').text).toBe('def f():\n    |\n');
	expect(enter('a.py', 'def f():|\n    pass\n').text).toBe('def f():\n    |\n    pass\n');
	expect(enter('a.py', `if x:|\n${T}pass\n`).text).toBe(`if x:\n${T}|\n${T}pass\n`);
	expect(enter('a.json', '{\n    "a": [|\n}\n').text).toBe('{\n    "a": [\n        |\n}\n');
	expect(enter('a.md', '- a (|\n').text).toBe('- a (\n  |\n');
});
it('a file with 4-space indentation indents by 4 on Enter, Tab and Shift-Tab (the old detector gave 2)', () => {
	const { model, text } = enter('a.ts', 'function f() {\n    if (x) {|\n    }\n}\n');
	expect(text).toBe('function f() {\n    if (x) {\n        |\n    }\n}\n');
	expect(model.resolved).toMatchObject({ insertSpaces: true, indentSize: 4 });
	const plain = open('a.ts', 'function f() {\n    foo();\n}\n');
	plain.state = plain.state.update({ selection: { anchor: 20 } }).state;
	run(plain, indentMore);
	expect(plain.text()).toBe('function f() {\n        foo();\n}\n');
	run(plain, indentLess);
	expect(plain.text()).toBe('function f() {\n    foo();\n}\n');
});
it('the settings decide when the file has no indentation: tabs, 8 spaces, tab width on screen', () => {
	expect(enter('a.ts', 'a {|}\n', { indentStyle: 'tabs', indentSize: 2, tabWidth: 2 }).text).toBe(
		`a {\n${T}|\n}\n`
	);
	expect(enter('a.ts', 'a {|}\n', { indentStyle: 'spaces', indentSize: 8, tabWidth: 4 }).text).toBe(
		`a {\n${' '.repeat(8)}|\n}\n`
	);
	expect(
		enter('a.ts', 'a {|}\n', { indentStyle: 'tabs', indentSize: 2, tabWidth: 8 }).model.state
			.tabSize
	).toBe(8);
	expect(enter('a.py', 'def f():|\n').model.resolved.indentSize).toBe(4);
});
it('a project config beats the settings, and a changed answer reconfigures an open document', () => {
	const project: ProjectIndent = { source: 'prettier', useTabs: true, tabWidth: 8 };
	const forced = enter(
		'a.ts',
		'a {|}\n',
		{ ...auto, indentStyle: 'spaces', indentSize: 4 },
		project
	);
	expect(forced.text).toBe(`a {\n${T}|\n}\n`);
	expect(forced.model.state.tabSize).toBe(8);
	const model = open('a.ts', 'a {\n  b;\n}\n');
	expect(model.resolved).toMatchObject({ insertSpaces: true, indentSize: 2 });
	const effect = model.setIndent(auto, {
		source: 'editorconfig',
		useTabs: false,
		indentSize: 4,
		tabWidth: 4,
	});
	expect(effect).not.toBeNull();
	model.state = model.state.update({ effects: effect!, selection: { anchor: 3 } }).state;
	run(model, insertNewlineAndIndent);
	expect(model.text()).toBe('a {\n    \n  b;\n}\n');
	expect(
		model.setIndent(auto, { source: 'editorconfig', useTabs: false, indentSize: 4, tabWidth: 4 })
	).toBeNull();
});

// A passive group follows the buffer's indentation, so it never depends on which group has the focus.
it('a new indentation answer reaches the buffer and every passive group watching it', () => {
	const model = open('a.ts', `a {\n${T}b;\n}\n`);
	expect(model.state.tabSize).toBe(4);
	let heard = 0;
	model.watch(() => heard++);
	const project: ProjectIndent = { source: 'editorconfig', useTabs: true, tabWidth: 2 };
	model.applyIndent(auto, project);
	expect(model.state.tabSize).toBe(2);
	expect(model.resolved.tabWidth).toBe(2);
	expect(heard).toBe(1);
	const shown = model.resolved;
	model.applyIndent(auto, { ...project });
	expect(heard).toBe(1);
	expect(model.resolved).toBe(shown);
});
// Found in real tab-indented files: the line that ends a statement begun a level out went one tab too far in.
it('Enter after a continuation line that ends a statement goes back to where the statement began', () => {
	expect(
		enter('a.ts', `export const a = (x: number) =>\n${T}api.post(x);|\nexport const b = 1;\n`).text
	).toBe(`export const a = (x: number) =>\n${T}api.post(x);\n|\nexport const b = 1;\n`);
	expect(enter('a.ts', `const a = {\n${T}b: 1,\n};|\n`).text).toBe(
		`const a = {\n${T}b: 1,\n};\n|\n`
	);
	expect(
		enter(
			'a.ts',
			`function f() {\n${T}const v = cond\n${T}${T}? one()\n${T}${T}: await two(x);|\n}\n`
		).text
	).toBe(
		`function f() {\n${T}const v = cond\n${T}${T}? one()\n${T}${T}: await two(x);\n${T}|\n}\n`
	);
	expect(enter('a.ts', `function f() {\n${T}foo(\n${T}${T}a,\n${T}${T}b,\n${T});|\n}\n`).text).toBe(
		`function f() {\n${T}foo(\n${T}${T}a,\n${T}${T}b,\n${T});\n${T}|\n}\n`
	);
	expect(enter('a.ts', `function f() {\n${T}foo();|\n}\n`).text).toBe(
		`function f() {\n${T}foo();\n${T}|\n}\n`
	);
	expect(enter('a.ts', `for (let i = 0;|\n`).text).toBe('for (let i = 0;\n|\n');
	expect(enter('a.css', `a {\n${T}color: red;|\n}\n`).text).toBe(
		`a {\n${T}color: red;\n${T}|\n}\n`
	);
});
it('a tab width picked in Settings beats the project config for what is shown, and Enter still uses the project style (spec/editor#indentation)', () => {
	const project: ProjectIndent = { source: 'prettier', useTabs: true, tabWidth: 4 };
	const shown = enter('a.ts', 'a {|}\n', { ...auto, tabWidth: 2 }, project);
	expect(shown.text).toBe(`a {\n${T}|\n}\n`);
	expect(shown.model.state.tabSize).toBe(2);
	expect(shown.model.resolved.configTabWidth).toBe(4);
	expect(enter('a.ts', 'a {|}\n', auto, project).model.state.tabSize).toBe(4);
});
