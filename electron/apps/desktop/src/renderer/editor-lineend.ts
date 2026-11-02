import { EditorState, Text, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars } from '@codemirror/view';
import { t, type Locale } from '@brigadir/core';
/**
 * spec/editor#files-and-save: line breaks are kept. A CRLF document uses `lineSeparator('\r\n')`, and CodeMirror splits an inserted string
 * only by that separator, so a paste, a formatter edit, a language server edit, a conflict resolution or an agent's
 * suggestion with LF breaks lands as ONE line holding raw `\n` characters, and the file is saved with mixed endings.
 * An LF break is one character, like a real break, so this follow-up turns each of those characters into a break
 * without moving any position of the transaction.
 */
const crlfBreaksOnly: Extension = EditorState.transactionFilter.of((transaction) => {
	if (!transaction.docChanged || transaction.state.lineBreak !== '\r\n') return transaction;
	const found: number[] = [];
	transaction.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
		let at = fromB;
		for (const line of inserted.iterLines()) {
			for (let index = line.indexOf('\n'); index >= 0; index = line.indexOf('\n', index + 1))
				found.push(at + index);
			at += line.length + 1;
		}
	});
	if (!found.length) return transaction;
	return [
		transaction,
		{
			changes: found.map((from) => ({ from, to: from + 1, insert: Text.of(['', '']) })),
			sequential: true,
		},
	];
});
/**
 * The other direction: an LF document (or a mixed one, which is read with LF breaks) splits text only by LF, so text
 * copied from a CRLF source would keep a stray CR at the end of each pasted line. Pasted breaks take the document's.
 */
const pastedBreaks: Extension = EditorView.clipboardInputFilter.of((text, state) =>
	state.lineBreak === '\n' ? text.replace(/\r\n?/g, '\n') : text
);
export const crlfBreaks: Extension = [crlfBreaksOnly, pastedBreaks];
/**
 * spec/editor#disk-vs-buffer: in a mixed LF/CRLF file the CR of a CRLF line stays in its line as a character (spec/editor#files-and-save). It is drawn as the
 * control picture ␍ in a muted token, so a person sees what is there instead of an invisible character. Only the CR is
 * marked: a document with CRLF breaks has none in its lines.
 */
export const rawCarriageReturn = (locale: Locale): Extension =>
	highlightSpecialChars({
		specialChars: /\r/g,
		render: (code, _description, placeholder) => {
			const span = document.createElement('span');
			span.className = 'cm-specialChar cm-raw-cr';
			span.textContent = placeholder;
			span.title = t(locale, 'A stray carriage return (CR) in this line');
			span.dataset.code = String(code);
			return span;
		},
	});
