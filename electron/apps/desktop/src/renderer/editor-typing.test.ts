import { describe, expect, it } from 'vitest';
import { deleteBracketPair } from '@codemirror/autocomplete';
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxToken } from '@brigadir/core';
import {
	callableDetail,
	editorTyping,
	openTagBefore,
	opensGeneric,
	wantsCallParens,
	type TypingFlags,
} from './editor-typing';
import { setSyntax, syntaxDecorations } from './syntax';
const on: TypingFlags = { closeBrackets: true, closeTags: true };
/** A document with `|` as the cursor; `type` runs the input handlers the way EditorView does, without a DOM. */
function editor(path: string, text: string, flags = on, tokens: SyntaxToken[] = []) {
	const cursor = text.indexOf('|');
	let state = EditorState.create({
		doc: text.replace('|', ''),
		selection: { anchor: cursor },
		extensions: [syntaxDecorations, editorTyping(path, flags)],
	});
	if (tokens.length) state = state.update({ effects: setSyntax.of(tokens) }).state;
	const view = {
		get state() {
			return state;
		},
		composing: false,
		compositionStarted: false,
		dispatch(spec: Transaction | TransactionSpec) {
			state = 'startState' in spec ? spec.state : state.update(spec).state;
		},
	};
	return {
		type(input: string) {
			for (const char of input) {
				const { from, to } = state.selection.main;
				const handled = state
					.facet(EditorView.inputHandler)
					.some((handler) =>
						handler(view as unknown as EditorView, from, to, char, () =>
							state.update({ changes: { from, to, insert: char } })
						)
					);
				if (!handled)
					view.dispatch({
						changes: { from, to, insert: char },
						selection: { anchor: from + char.length },
					});
			}
			return this;
		},
		backspace() {
			deleteBracketPair({ state, dispatch: (tr) => view.dispatch(tr) });
			return this;
		},
		get text() {
			const head = state.selection.main.head;
			return state.sliceDoc(0, head) + '|' + state.sliceDoc(head);
		},
	};
}
const tsx = { jsx: true, code: () => true };
describe('closing tags (spec/editor-code-intelligence#typing-help)', () => {
	it('finds the open tag before a typed `>`', () => {
		expect(openTagBefore('return <div', tsx)).toBe('div');
		expect(openTagBefore('<Card.Header title="a > b" onClick={() => go(1)}', tsx)).toBe(
			'Card.Header'
		);
		expect(openTagBefore('<Button\n  disabled\n  size="sm"', tsx)).toBe('Button');
		expect(openTagBefore('(\n  <', tsx)).toBe('');
		expect(openTagBefore('<p>Hello <b', tsx)).toBe('b');
		expect(openTagBefore('{items.map(item => <Item key={item.id}', tsx)).toBe('Item');
	});
	it('leaves self-closing, closed, void and non-tag `<` alone', () => {
		for (const before of [
			'<Icon /',
			'<div>text',
			'</div',
			'<br',
			'<input type="text"',
			'if (a<b',
			'useState<string',
			'list[0]<n',
			'f()<n',
			'<div onClick={() =',
			'<div title="a',
			'<!-- a',
			'<T,',
			'<div>{a ',
			'a < b && c ',
		])
			expect(openTagBefore(before, tsx), before).toBeNull();
		expect(openTagBefore('<Input', tsx)).toBe('Input');
		expect(openTagBefore('<BR', { jsx: false, code: () => true })).toBeNull();
		expect(openTagBefore('a <', { jsx: false, code: () => true })).toBeNull();
	});
	it('skips a `<` inside a comment or a string', () => {
		const text = '// <div\n<span';
		expect(openTagBefore(text, { jsx: true, code: (offset) => offset > 7 })).toBe('span');
		expect(openTagBefore('// <div', { jsx: true, code: () => false })).toBeNull();
	});
	it('closes the tag in TSX, HTML and Vue, but not in TS', () => {
		expect(editor('a.tsx', 'const a = <div|;').type('>').text).toBe('const a = <div>|</div>;');
		expect(editor('a.tsx', 'return (<MyComponent value={x}|').type('>').text).toBe(
			'return (<MyComponent value={x}>|</MyComponent>'
		);
		expect(editor('a.tsx', 'return <|').type('>').text).toBe('return <>|</>');
		expect(editor('a.jsx', '<section|').type('>').text).toBe('<section>|</section>');
		expect(editor('index.html', '<body><main class="x"|').type('>').text).toBe(
			'<body><main class="x">|</main>'
		);
		expect(editor('App.vue', '<template|').type('>').text).toBe('<template>|</template>');
		expect(editor('a.ts', 'const a = <div|').type('>').text).toBe('const a = <div>|');
		expect(editor('a.tsx', '<div|</div>').type('>').text).toBe('<div>|</div>');
		expect(editor('a.tsx', '<div|', { closeBrackets: true, closeTags: false }).type('>').text).toBe(
			'<div>|'
		);
	});
	it('does not close a tag inside a highlighted string', () => {
		expect(
			editor('a.tsx', "const s = '<b|';", on, [{ from: 10, to: 15, kind: 'string' }]).type('>').text
		).toBe("const s = '<b>|';");
	});
});
describe('bracket and quote pairs (spec/editor-code-intelligence#typing-help)', () => {
	it('pairs brackets and quotes, steps over the closing one and deletes an empty pair', () => {
		expect(editor('a.ts', 'call|').type('(').text).toBe('call(|)');
		expect(editor('a.ts', 'call|').type('(x)').text).toBe('call(x)|');
		expect(editor('a.ts', 'const s = |').type('"').text).toBe('const s = "|"');
		expect(editor('a.ts', 'const s = |').type('`').text).toBe('const s = `|`');
		expect(editor('a.py', 's = |').type('`').text).toBe('s = `|');
		expect(editor('a.ts', 'const o = |').type('{').backspace().text).toBe('const o = |');
		expect(editor('a.md', 'don|').type("'").text).toBe("don'|");
		expect(editor('a.ts', 'call|', { closeBrackets: false, closeTags: true }).type('(').text).toBe(
			'call(|'
		);
	});
	it('types a quote inside a highlighted string as text and steps over its closing quote', () => {
		const string = [{ from: 10, to: 15, kind: 'string' as const }];
		expect(editor('a.ts', 'const s = "it|s";', on, string).type("'").text).toBe(
			'const s = "it\'|s";'
		);
		expect(editor('a.ts', 'const s = "its|";', on, string).type('"').text).toBe(
			'const s = "its"|;'
		);
	});
	it('pairs `<` only after a type name or a hook in TS', () => {
		expect(opensGeneric('const list: Array')).toBe(true);
		expect(opensGeneric('const [a, set] = useState')).toBe(true);
		expect(opensGeneric('for (let i = 0; i')).toBe(false);
		expect(editor('a.ts', 'let a: Promise|').type('<').text).toBe('let a: Promise<|>');
		expect(editor('a.ts', 'let a: Promise|').type('<void>').text).toBe('let a: Promise<void>|');
		expect(editor('a.ts', 'if (i|) {}').type('<').text).toBe('if (i<|) {}');
		expect(editor('a.tsx', 'return |').type('<').text).toBe('return <|');
		expect(editor('a.js', 'let a = Map|').type('<').text).toBe('let a = Map<|');
	});
});
describe('call parentheses (spec/editor-code-intelligence#typing-help)', () => {
	it('follow a function name in code, not in imports, types, tags or JSX values', () => {
		expect(wantsCallParens('const get = ', ';')).toBe(true);
		expect(wantsCallParens('items.', '')).toBe(true);
		expect(wantsCallParens('const get = ', '(1)')).toBe(false);
		expect(wantsCallParens('import { a, ', ' } from "x";')).toBe(false);
		expect(wantsCallParens('import {\n  a,\n  ', '\n} from "x";')).toBe(false);
		expect(wantsCallParens('export { ', ' };')).toBe(false);
		expect(wantsCallParens('type A = typeof ', ';')).toBe(false);
		expect(wantsCallParens('return <', ' />')).toBe(false);
		expect(wantsCallParens('</', '>')).toBe(false);
		expect(wantsCallParens('<button onClick={', '}>')).toBe(false);
		expect(wantsCallParens('import { a } from "x";\nconst b = ', '')).toBe(true);
	});
	it('read a callable from the resolved detail, as tsserver reports imports and arrow constants as variables', () => {
		for (const detail of [
			'(alias) function greet(name: string): string\nimport greet',
			'(alias) const getPlace: (id: number) => number\nimport getPlace',
			'const local: () => number',
			'function fn(): void',
			'(method) m(): number',
			'(property) p: (x: number) => number',
			'const pick: <T>(list: T[]) => T',
		])
			expect(callableDetail(detail), detail).toBe(true);
		for (const detail of [
			'(alias) const answer: 1\nimport answer',
			'(alias) class Box\nimport Box',
			'const list: string[]',
			'(property) size: number',
			'let handler: Handler',
		])
			expect(callableDetail(detail), detail).toBe(false);
	});
});
