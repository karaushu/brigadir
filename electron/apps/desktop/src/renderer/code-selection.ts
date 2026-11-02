/**
 * spec/appearance#evolution-redesign: code is selected as text, in the editor and in every diff. The anchor of a comment or a quick question
 * stays the lines the selection touches (spec/diff-and-review#review-comments); the selected text itself travels with it as the quote.
 */
/** One line's part of a diff text selection: UTF-16 columns of the line text, `to` exclusive. */
export type CodeMark = { side: 'old' | 'new'; line: number; from: number; to: number };
/** A text selection in a diff: the lines it anchors to, the text verbatim, and where the characters lie (to paint them
 *  again while a draft or a popover holds the focus). */
export type CodeSelection = {
	side: 'old' | 'new';
	start: number;
	end: number;
	quote: string;
	marks: CodeMark[];
};
/** `110` or `110–111`. */
export const lineSpan = (start: number, end: number) =>
	start === end ? String(start) : `${start}–${end}`;
/** The panel's caption: the symbol or the file, the lines, and the side only for the old one (`index.tsx · 18–19 · old`). */
export const selectionCaption = (
	name: string,
	start: number,
	end: number,
	side: 'old' | 'new' = 'new'
) => `${name} · ${lineSpan(start, end)}${side === 'old' ? ' · old' : ''}`;
/**
 * The pieces of a selection in document order → its anchor and quote. A unified selection over removed and added lines
 * anchors to the new lines it covers; only removed lines anchor to the old side. A piece that holds no characters (the
 * selection starts at the very end of a line, or a triple click reaches the start of the next one) touches no line,
 * unless it is a blank line inside the selection.
 */
export function codeSelection(
	pieces: (CodeMark & { text: string })[],
	limit = 5000
): CodeSelection | null {
	const kept = pieces.filter(
		(piece, index) => piece.to > piece.from || (index > 0 && index < pieces.length - 1)
	);
	if (!kept.length || kept.every((piece) => piece.to <= piece.from)) return null;
	const side = kept.some((piece) => piece.side === 'new') ? 'new' : 'old',
		lines = kept.filter((piece) => piece.side === side).map((piece) => piece.line);
	return {
		side,
		start: Math.min(...lines),
		end: Math.max(...lines),
		quote: kept.map((piece) => piece.text.slice(piece.from, piece.to)).join('\n'),
		marks: kept.slice(0, limit).map(({ side, line, from, to }) => ({ side, line, from, to })),
	};
}
/**
 * The quote as a draft or a card shows it: its first `max` lines without the indent they share (a first line that
 * starts mid-line has none to give), and how many lines follow (`+N lines`).
 */
export function quoteLines(text: string, max = 3): { lines: string[]; more: number } {
	const all = text.replace(/\t/g, '    ').replace(/\n+$/, '').split('\n');
	let indent = Infinity;
	for (const line of all.slice(1))
		if (line.trim()) indent = Math.min(indent, /^ */.exec(line)![0].length);
	const cut = Number.isFinite(indent) ? indent : 0;
	const lines = all.map((line, index) => (index === 0 ? line.trimStart() : line.slice(cut)));
	return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}
