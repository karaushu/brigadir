import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { SyntaxToken } from '@brigadir/core';
export const setSyntax = StateEffect.define<SyntaxToken[]>();
/** Colors follow an edit until the next parse replaces them: no plain flash while typing (perf review EDIT-01). */
export const syntaxDecorations = StateField.define({
	create: () => Decoration.none,
	update(value, transaction) {
		if (transaction.docChanged) value = value.map(transaction.changes);
		for (const effect of transaction.effects)
			if (effect.is(setSyntax))
				value = Decoration.set(
					effect.value
						.filter((t) => t.from >= 0 && t.to <= transaction.state.doc.length && t.to > t.from)
						.map((token) =>
							Decoration.mark({ class: `syntax-${token.kind}` }).range(token.from, token.to)
						),
					true
				);
		return value;
	},
	provide: (field) => EditorView.decorations.from(field),
});
export function lineTokens(text: string, tokens: SyntaxToken[]): Map<number, SyntaxToken[]> {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	const result = new Map<number, SyntaxToken[]>();
	let line = 0;
	for (const token of tokens) {
		while (line + 1 < starts.length && starts[line + 1]! <= token.from) line++;
		let row = line;
		while (row < starts.length && starts[row]! < token.to) {
			const start = starts[row]!;
			const end = row + 1 < starts.length ? starts[row + 1]! - 1 : text.length;
			const from = Math.max(start, token.from) - start,
				to = Math.min(end, token.to) - start;
			if (to > from) {
				const list = result.get(row + 1) ?? [];
				list.push({ ...token, from, to });
				result.set(row + 1, list);
			}
			row++;
		}
	}
	return result;
}
export function syntaxSegments(text: string, tokens: SyntaxToken[] = [], spans?: number[]) {
	const boundaries = new Set([0, text.length]);
	for (const t of tokens) {
		boundaries.add(Math.min(text.length, t.from));
		boundaries.add(Math.min(text.length, t.to));
	}
	const words: { from: number; to: number; changed: boolean }[] = [];
	let offset = 0;
	for (const span of spans ?? []) {
		const to = span >>> 1;
		words.push({ from: offset, to, changed: (span & 1) === 1 });
		offset = to;
		boundaries.add(offset);
	}
	const points = [...boundaries].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
	let token = 0,
		word = 0;
	return points.slice(0, -1).map((from, i) => {
		const to = points[i + 1]!;
		while (token < tokens.length && tokens[token]!.to <= from) token++;
		while (word < words.length && words[word]!.to <= from) word++;
		const kind = tokens[token] && tokens[token]!.from <= from ? tokens[token]!.kind : undefined;
		return { from, text: text.slice(from, to), kind, changed: words[word]?.changed ?? false };
	});
}

export function SyntaxText({
	text,
	tokens = [],
	spans,
}: {
	text: string;
	tokens?: SyntaxToken[];
	spans?: number[] | undefined;
}) {
	return (
		<>
			{syntaxSegments(text, tokens, spans).map((part) => (
				<span
					key={part.from}
					className={part.kind ? `syntax-${part.kind}` : undefined}
					data-changed={part.changed}>
					{part.text}
				</span>
			))}
		</>
	);
}
