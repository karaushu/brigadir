import type MarkdownIt from 'markdown-it';
import type { StateBlock } from 'markdown-it';

/**
 * HTML comments are not shown, as on GitHub: `<!-- … -->` disappears as a block (one or several lines, several comments
 * in a row) and inside a paragraph, while the text around it renders as usual. The renderers have no raw HTML, so without
 * this a comment was text, `<name>` inside it included. A comment in a code span or a code block stays as it is written.
 * An unclosed `<!--` stays text: a streaming answer does not lose its tail.
 */
export function htmlComments(md: MarkdownIt) {
	md.block.ruler.before('html_block', 'html_comment_block', commentBlock, {
		alt: ['paragraph', 'reference', 'blockquote'],
	});
	md.inline.ruler.before('html_inline', 'html_comment_inline', (state) => {
		const end = commentEnd(state.src, state.pos);
		if (end < 0 || end > state.posMax) return false;
		state.pos = end;
		return true;
	});
}

/** The index right after the comment that opens at `pos`, or -1 (CommonMark 0.31: `<!-->` and `<!--->` count too). */
function commentEnd(src: string, pos: number) {
	if (!src.startsWith('<!--', pos)) return -1;
	if (src.startsWith('>', pos + 4)) return pos + 5;
	if (src.startsWith('->', pos + 4)) return pos + 6;
	const close = src.indexOf('-->', pos + 4);
	return close < 0 ? -1 : close + 3;
}

/** Lines made only of comments; a line with text after its comment is left to the paragraph and the inline rule. */
function commentBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
	if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
	let pos = state.bMarks[startLine]! + state.tShift[startLine]!,
		line = startLine;
	for (;;) {
		const end = commentEnd(state.src, pos);
		if (end < 0) return false;
		while (line < endLine && state.eMarks[line]! < end) line++;
		if (line >= endLine) return false;
		pos = end;
		while (pos < state.eMarks[line]! && (state.src[pos] === ' ' || state.src[pos] === '\t')) pos++;
		if (pos >= state.eMarks[line]!) break;
	}
	if (!silent) state.line = line + 1;
	return true;
}
