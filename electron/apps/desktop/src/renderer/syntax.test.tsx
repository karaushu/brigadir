import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorState } from '@codemirror/state';
import { lineTokens, SyntaxText, syntaxDecorations, setSyntax } from './syntax';
it('splits multiline syntax into CRLF rows and composes colors with word changes', () => {
	const text = '/* a\r\nb */\r\n';
	const tokens = lineTokens(text, [{ from: 0, to: 10, kind: 'comment' }]);
	expect(tokens.get(2)?.[0]?.from).toBe(0);
	const html = renderToStaticMarkup(
		<SyntaxText
			text="return 42"
			tokens={[
				{ from: 0, to: 6, kind: 'keyword' },
				{ from: 7, to: 9, kind: 'number' },
			]}
			spans={[14, 19]}
		/>
	);
	expect(html).toContain('class="syntax-number" data-changed="true">42');
});
it('maps editor decorations through an edit until the next parse and accepts exact document offsets', () => {
	let state = EditorState.create({ doc: 'return 42', extensions: [syntaxDecorations] });
	state = state.update({ effects: setSyntax.of([{ from: 0, to: 6, kind: 'keyword' }]) }).state;
	expect(state.field(syntaxDecorations).size).toBe(1);
	state = state.update({ changes: { from: 0, insert: 'x' } }).state;
	const ranges: [number, number][] = [];
	state.field(syntaxDecorations).between(0, state.doc.length, (from, to) => {
		ranges.push([from, to]);
	});
	expect(ranges).toEqual([[1, 7]]);
	state = state.update({ changes: { from: 0, to: state.doc.length, insert: 'other' } }).state;
	expect(state.field(syntaxDecorations).size).toBe(0);
	state = state.update({
		effects: setSyntax.of([
			{ from: 0, to: 5, kind: 'keyword' },
			{ from: 3, to: 99, kind: 'string' },
		]),
	}).state;
	expect(state.field(syntaxDecorations).size).toBe(1);
});
