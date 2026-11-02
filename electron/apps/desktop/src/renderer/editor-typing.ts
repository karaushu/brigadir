import { closeBrackets, closeBracketsKeymap, insertBracket } from '@codemirror/autocomplete';
import { getIndentUnit, indentString } from '@codemirror/language';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxLanguage, type EditorTyping } from '@brigadir/core';
import { syntaxDecorations } from './syntax';
/** spec/editor-code-intelligence#typing-help: typing aids without a second parser. Tags and strings are read from the text and the highlight tokens. */
export type TypingFlags = Pick<EditorTyping, 'closeBrackets' | 'closeTags'>;
const markup = /\.(?:html?|xhtml|xml|svg|vue|svelte|astro)$/i;
const backtick = new Set(['javascript', 'typescript', 'tsx', 'go', 'bash']);
const voids = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
]);
export type TagSyntax = { jsx: boolean; code(offset: number): boolean };
/** The tag a `>` typed at the end of `before` opens, or null: `''` is a JSX fragment. */
export function openTagBefore(before: string, syntax: TagSyntax): string | null {
	let at = before.length;
	for (let tries = 0; tries < 32; tries++) {
		at = at > 0 ? before.lastIndexOf('<', at - 1) : -1;
		if (at < 0) return null;
		if (!syntax.code(at)) continue;
		const found = scanTag(before, at, syntax.jsx);
		if (found === 'closed') return null;
		if (found !== 'skip') return found.void ? null : found.name;
	}
	return null;
}
function scanTag(
	text: string,
	at: number,
	jsx: boolean
): 'closed' | 'skip' | { name: string; void: boolean } {
	// `a<b`, `f()<`, `list[0]<` compare or open a generic; `return <div` and `Hello <b` start JSX.
	if (jsx && /[\p{L}\p{N}_$)\]]/u.test(text[at - 1] ?? '')) return 'skip';
	const name = /^[A-Za-z_$][\w$.:-]*/.exec(text.slice(at + 1, at + 200))?.[0] ?? '';
	if (!name) return jsx && at + 1 === text.length ? { name: '', void: false } : 'skip';
	let index = at + 1 + name.length;
	if (index < text.length && !/[\s/]/.test(text[index]!)) return 'skip';
	let quote = '',
		depth = 0;
	for (; index < text.length; index++) {
		const char = text[index]!;
		if (quote) {
			if (char === '\\' && jsx) index++;
			else if (char === quote) quote = '';
			continue;
		}
		if (char === '"' || char === "'" || (char === '`' && depth > 0)) {
			quote = char;
			continue;
		}
		if (jsx && char === '{') {
			depth++;
			continue;
		}
		if (jsx && char === '}') {
			if (!depth) return 'skip';
			depth--;
			continue;
		}
		if (depth) continue;
		if (char === '>') return 'closed';
		if (char === '<') return 'skip';
	}
	if (quote || depth) return 'skip';
	const last = text.trimEnd().at(-1);
	if (last === '/' || last === '=') return 'skip';
	return { name, void: jsx ? voids.has(name) : voids.has(name.toLowerCase()) };
}
/** spec/editor-code-intelligence#typing-help: `Array<`, `Promise<`, `useState<` open a generic in TS; `i<n` does not. */
export function opensGeneric(line: string) {
	const word = /(?<![\p{L}\p{N}_$])[A-Za-z_$][\w$]*$/u.exec(line)?.[0];
	return Boolean(word && (/^[A-Z]/.test(word) || /^use[A-Z]/.test(word)));
}
/** spec/editor-code-intelligence#typing-help call parentheses: text around a completed function name decides whether `()` follows it. */
export function wantsCallParens(before: string, after: string) {
	if (after.startsWith('(')) return false;
	if (/<\/?[\w$.]*$/.test(before)) return false;
	if (/=\{\s*[\w$.]*$/.test(before)) return false;
	if (/\b(?:typeof|keyof)\s+[\w$.]*$/.test(before)) return false;
	if (/\b(?:import|export)\s+(?:type\s+)?\{[^}]*$/.test(before)) return false;
	if (/(?:^|\n)\s*import\s+(?:type\s+)?[\w$]*$/.test(before)) return false;
	return true;
}
/** The highlight class of the token that holds [from, to]: the character at `from`, or a cursor strictly inside. */
/** spec/editor-code-intelligence#typing-help: the resolved detail of a completion names a callable — `function`, a method, or a value of a function type. */
export function callableDetail(detail: string) {
	const head = (detail.split('\n')[0] ?? '').replace(/^\(alias\)\s+/, '');
	return (
		/^(?:function|\((?:method|function|local function)\))\s/.test(head) ||
		/^(?:const|let|var|\((?:property|parameter)\))\s+[\w$.]+\??\s*:\s*(?:<[^>]*>\s*)?\(/.test(head)
	);
}
function tokenClass(state: EditorState, from: number, to: number) {
	let found: string | null = null;
	state.field(syntaxDecorations, false)?.between(from, to, (start, end, value) => {
		if (start <= from && to <= end) {
			found = String(value.spec.class ?? '');
			return false;
		}
		return undefined;
	});
	return found as string | null;
}
const inCode = (state: EditorState, index: number) => {
	const kind = tokenClass(state, index, index + 1);
	return kind !== 'syntax-string' && kind !== 'syntax-comment';
};
function plain(view: EditorView, from: number, to: number, text: string) {
	view.dispatch({
		changes: { from, to, insert: text },
		selection: { anchor: from + text.length },
		userEvent: 'input.type',
		scrollIntoView: true,
	});
	return true;
}
export function editorTyping(path: string, flags: TypingFlags): Extension {
	const language = syntaxLanguage(path);
	const jsx = language === 'tsx' || language === 'javascript';
	const tags = flags.closeTags && (jsx || markup.test(path));
	const generics = flags.closeBrackets && (language === 'typescript' || language === 'tsx');
	const extensions: Extension[] = [];
	if (flags.closeBrackets) {
		const brackets = [
			'(',
			'[',
			'{',
			"'",
			'"',
			...(backtick.has(language ?? '') ? ['`'] : []),
			...(generics ? ['<'] : []),
		];
		extensions.push(
			EditorState.languageData.of(() => [{ closeBrackets: { brackets, before: ')]}:;>,' } }]),
			closeBrackets(),
			keymap.of(closeBracketsKeymap)
		);
	}
	if (!flags.closeBrackets && !tags) return extensions;
	extensions.push(
		Prec.high(
			EditorView.inputHandler.of((view, from, to, text) => {
				const state = view.state;
				if (
					view.composing ||
					state.readOnly ||
					state.selection.ranges.length > 1 ||
					from !== state.selection.main.from ||
					to !== state.selection.main.to
				)
					return false;
				if (text === '<' && generics) {
					// closeBrackets would pair every `<`; only a generic gets `<>`, the rest is plain text.
					const line = state.doc.lineAt(from);
					const pair =
						from === to &&
						opensGeneric(line.text.slice(0, from - line.from)) &&
						inCode(state, from - 1)
							? insertBracket(state, '<')
							: null;
					if (pair) {
						view.dispatch(pair);
						return true;
					}
					return plain(view, from, to, text);
				}
				if (text === '>' && from === to) {
					const over = flags.closeBrackets ? insertBracket(state, '>') : null;
					if (over) {
						view.dispatch(over);
						return true;
					}
					if (!tags) return false;
					const start = Math.max(0, from - 4000);
					const name = openTagBefore(state.sliceDoc(start, from), {
						jsx,
						code: (offset) => inCode(state, start + offset),
					});
					if (name === null) return false;
					const close = `</${name}>`;
					if (state.sliceDoc(from, from + close.length) === close) return false;
					view.dispatch({
						changes: { from, insert: '>' + close },
						selection: { anchor: from + 1 },
						userEvent: 'input.type',
						scrollIntoView: true,
					});
					return true;
				}
				if (
					flags.closeBrackets &&
					(text === '"' || text === "'" || text === '`') &&
					from === to &&
					tokenClass(state, from - 1, from + 1) === 'syntax-string'
				) {
					// Inside a highlighted string a quote is text; the string's own closing quote is stepped over.
					if (state.sliceDoc(from, from + 1) === text) {
						view.dispatch({
							selection: { anchor: from + 1 },
							userEvent: 'select',
							scrollIntoView: true,
						});
						return true;
					}
					return plain(view, from, to, text);
				}
				return false;
			})
		)
	);
	if (tags)
		extensions.push(
			Prec.high(
				keymap.of([
					{
						key: 'Enter',
						run: (view) => {
							const { state } = view;
							const range = state.selection.main;
							if (!range.empty || state.readOnly) return false;
							const line = state.doc.lineAt(range.head);
							const before = line.text.slice(0, range.head - line.from),
								after = line.text.slice(range.head - line.from);
							if (!/>$/.test(before) || /\/>$/.test(before) || !/^<\//.test(after)) return false;
							const indent = /^\s*/.exec(line.text)![0];
							const inner = indent + indentString(state, getIndentUnit(state));
							view.dispatch({
								changes: { from: range.head, insert: `\n${inner}\n${indent}` },
								selection: { anchor: range.head + 1 + inner.length },
								userEvent: 'input',
								scrollIntoView: true,
							});
							return true;
						},
					},
				])
			)
		);
	return extensions;
}
