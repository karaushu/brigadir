import { EditorState, type Extension } from '@codemirror/state';
import { bracketMatching, indentService, indentUnit } from '@codemirror/language';
import { indentUnitString, syntaxLanguage, type ResolvedIndent } from '@brigadir/core';
/** spec/editor#indentation: what Tab, Enter and the language server use; one compartment, reconfigured when the answer changes. */
export function indentExtensions(resolved: ResolvedIndent): Extension {
	return [EditorState.tabSize.of(resolved.tabWidth), indentUnit.of(indentUnitString(resolved))];
}
/** The text of the line the cursor sits in before `pos`, or the nearest non-blank line above (at most 200 lines up). */
function sourceLine(context: Parameters<Parameters<typeof indentService.of>[0]>[0], pos: number) {
	const doc = context.state.doc;
	const line = doc.lineAt(pos);
	// `context.lineAt` hides the text after a simulated break; the same cut is what the new line follows.
	const own = context.lineAt(pos, -1);
	const before = own.text.slice(0, Math.max(0, pos - own.from));
	const real = line.text.slice(0, pos - line.from);
	if (before.trim()) return before;
	if (real.trim()) return real;
	for (let number = line.number - 1, left = 200; number >= 1 && left > 0; number--, left--) {
		const text = doc.line(number).text;
		if (text.trim()) return text;
	}
	return '';
}
/** Brackets opened minus closed on a line, ignoring quoted text; enough to find where a statement began. */
function bracketBalance(text: string) {
	let balance = 0,
		quote = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = '';
			continue;
		}
		if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c === '/' && text[i + 1] === '/') break;
		else if ('([{'.includes(c)) balance++;
		else if (')]}'.includes(c)) balance--;
	}
	return balance;
}
/**
 * The column of the line a statement ending on `line` began on: a continuation line (`\tapi.post(x);` after `) =>`) ends its
 * statement, so the next line goes back to where the statement started, not one level in. Null when it cannot be told.
 */
function statementStart(
	doc: { line(n: number): { text: string }; lineAt(pos: number): { number: number } },
	number: number,
	text: string,
	count: (text: string) => number
) {
	let balance = 0;
	for (let n = number, steps = 0; n >= 1 && steps < 80; n--, steps++) {
		const line = n === number ? text : doc.line(n).text;
		if (!line.trim()) {
			if (balance === 0 && n !== number) return null;
			continue;
		}
		balance += bracketBalance(line);
		if (balance === 0) {
			let above = n - 1;
			while (above >= 1 && !doc.line(above).text.trim()) above--;
			if (
				above < 1 ||
				/[;{}]\s*$/.test(doc.line(above).text) ||
				/^\s*(\/\/|\/?\*)/.test(doc.line(above).text)
			)
				return count(line);
		}
	}
	return null;
}
/** No second parser: these are editing services, independent of highlighting. */
export function editingServices(path: string): Extension {
	const language = syntaxLanguage(path);
	const commentTokens = ['python', 'bash', 'ruby', 'powershell'].includes(language ?? '')
		? { line: '#' }
		: language === 'ini'
			? { line: ';' }
			: language === 'css'
				? { block: { open: '/*', close: '*/' } }
				: language
					? { line: '//', block: { open: '/*', close: '*/' } }
					: undefined;
	return [
		bracketMatching({ maxScanDistance: 10000 }),
		EditorState.languageData.of(() => (commentTokens ? [{ commentTokens }] : [])),
		indentService.of((context, pos) => {
			const own = context.lineAt(pos, -1);
			const typed = own.text.slice(0, Math.max(0, pos - own.from));
			const source = sourceLine(context, pos);
			const base = context.countColumn(source, source.search(/\S|$/));
			const opens =
				/[[{(]\s*$/.test(source) || (language === 'python' && /:\s*(?:#.*)?$/.test(source));
			if (
				typed.trim() &&
				/;\s*$/.test(typed) &&
				language &&
				!['python', 'ruby', 'bash', 'ini', 'powershell'].includes(language)
			) {
				const doc = context.state.doc,
					line = doc.lineAt(pos);
				const start = statementStart(doc, line.number, typed, (text) =>
					context.countColumn(text, text.search(/\S|$/))
				);
				if (start !== null) return start;
			}
			const closes = /^\s*[\]})]/.test(context.textAfterPos(pos));
			// Enter mid-line only cancels an opener (`{|}`); a line re-indented from its start also leaves the block a `}` closes.
			return Math.max(
				0,
				base + (opens ? context.unit : 0) - (closes && (opens || !typed.trim()) ? context.unit : 0)
			);
		}),
	];
}
