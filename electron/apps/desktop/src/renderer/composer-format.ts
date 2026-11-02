import {
	ChangeSet,
	EditorSelection,
	type ChangeSpec,
	type EditorState,
	type Text,
	type TransactionSpec,
} from '@codemirror/state';

/**
 * spec/composer#formatting: Markdown a person types in the composer — what ⇧↩, Tab, ⇧Tab, ⌘B ⌘I ⌘E ⌘K and a paste do with it. The text stays Markdown
 * the agent reads as it is (spec/tasks#sheet-layout); these are commands over the text and never a second model of it. Everything here works on a
 * CodeMirror state, so it is tested without a DOM.
 */
export type Block = {
	kind: 'bullet' | 'ordered' | 'task' | 'quote';
	/** Characters of leading whitespace. */ indent: number;
	/** The marker as typed, with its trailing space: `- `, `1. `, `- [ ] `, `> `. */ marker: string;
	/** The offset where the item's own text starts. */ contentFrom: number;
	/** The digits of an ordered item. */ number: number;
	/** The bullet character of a bullet or a task. */ bullet: string;
	/** A task's box is ticked. */ done: boolean;
};
/** The Markdown block marker a line starts with; null for any other line. */
export function parseBlock(text: string): Block | null {
	let match = /^([ \t]*)([-*]) \[([ xX])\](?: |$)/.exec(text);
	if (match)
		return {
			kind: 'task',
			indent: match[1]!.length,
			marker: match[0],
			contentFrom: match[0].length,
			number: 0,
			bullet: match[2]!,
			done: match[3] !== ' ',
		};
	match = /^([ \t]*)([-*]) /.exec(text);
	if (match)
		return {
			kind: 'bullet',
			indent: match[1]!.length,
			marker: match[0],
			contentFrom: match[0].length,
			number: 0,
			bullet: match[2]!,
			done: false,
		};
	match = /^([ \t]*)(\d{1,9})\. /.exec(text);
	if (match)
		return {
			kind: 'ordered',
			indent: match[1]!.length,
			marker: match[0],
			contentFrom: match[0].length,
			number: Number(match[2]),
			bullet: '',
			done: false,
		};
	match = /^([ \t]*)>(?: |$)/.exec(text);
	if (match)
		return {
			kind: 'quote',
			indent: match[1]!.length,
			marker: match[0],
			contentFrom: match[0].length,
			number: 0,
			bullet: '',
			done: false,
		};
	return null;
}
const isItem = (block: Block | null): block is Block => block !== null && block.kind !== 'quote';
const fence = /^[ \t]*```/;
/** Whether the line stands inside a fenced block (the fence lines themselves count as outside). */
export function insideFence(doc: Text, lineNumber: number): boolean {
	let inside = false;
	for (let number = 1; number < lineNumber; number++)
		if (fence.test(doc.line(number).text)) inside = !inside;
	return inside && !fence.test(doc.line(lineNumber).text);
}
/** The caret is on a list item (not a quote, not a code block): ⇧Tab and Tab mean the item's level there, not the agent's mode. */
export function inListLine(state: EditorState): boolean {
	const line = state.doc.lineAt(state.selection.main.head);
	return isItem(parseBlock(line.text)) && !insideFence(state.doc, line.number);
}

/** The marker the next line of the same block starts with, without its indent. */
export function nextMarker(block: Block): string {
	if (block.kind === 'ordered') return `${block.number + 1}. `;
	if (block.kind === 'task') return `${block.bullet} [ ] `;
	if (block.kind === 'quote') return '> ';
	return `${block.bullet} `;
}

type Host = { state: EditorState; dispatch(spec: TransactionSpec): void };

/** Renumber the ordered items from `fromLine` on, inside the list block that holds it. Items count per level; a level's first item keeps
 *  its number (a list may start at 5) unless it is `resetLine`, the item that was just moved to a new level, or a nested level, which starts at 1. */
export function renumber(
	doc: Text,
	fromLine: number,
	resetLine = 0
): { from: number; to: number; insert: string }[] {
	let start = Math.min(Math.max(fromLine, 1), doc.lines);
	while (start > 1 && isItem(parseBlock(doc.line(start - 1).text)) && !insideFence(doc, start - 1))
		start--;
	const changes: { from: number; to: number; insert: string }[] = [],
		levels = new Map<number, number>();
	for (let number = start; number <= doc.lines; number++) {
		const line = doc.line(number),
			block = parseBlock(line.text);
		if (!isItem(block) || insideFence(doc, number)) break;
		for (const level of [...levels.keys()]) if (level > block.indent) levels.delete(level);
		if (block.kind !== 'ordered') {
			levels.delete(block.indent);
			continue;
		}
		const previous = levels.get(block.indent);
		let expected = block.number;
		if (number >= fromLine || number === resetLine)
			expected =
				previous === undefined
					? number === resetLine || block.indent > 0
						? 1
						: block.number
					: previous + 1;
		if (expected !== block.number) {
			const digits = String(block.number).length;
			changes.push({
				from: line.from + block.indent,
				to: line.from + block.indent + digits,
				insert: String(expected),
			});
		}
		levels.set(block.indent, expected);
	}
	return changes;
}
/** `first` and the renumbering of the ordered items after it as one change, so ⌘Z undoes both. `caret` is in the document after `first`. */
function commit(host: Host, first: ChangeSpec, caret: number, fromLine: number) {
	const state = host.state,
		set = state.changes(first),
		after = set.apply(state.doc),
		fix = renumber(after, fromLine);
	const second = fix.length ? ChangeSet.of(fix, after.length) : null,
		changes = second ? set.compose(second) : set;
	host.dispatch({
		changes,
		selection: EditorSelection.cursor(second ? second.mapPos(caret, 1) : caret),
		scrollIntoView: true,
		userEvent: 'input',
	});
}

/** The leading whitespace of the line, up to the caret. */
const indentOf = (text: string, limit: number) => /^[ \t]*/.exec(text.slice(0, limit))![0];

/**
 * ⇧↩. In a list item it starts the next item of the block (`-`, `*`, `1.` → `2.`, `- [ ]`, `>`) at the same indent, and the following ordered
 * items of the level are renumbered. On an empty item it ends the list: a nested item first goes up one level, a top-level one loses its
 * marker. In a code block it keeps the indent and starts no marker. Anywhere else it returns false: a plain line break.
 */
export function continueBlock(host: Host): boolean {
	const state = host.state,
		range = state.selection.main;
	if (state.selection.ranges.length > 1 || !range.empty) return false;
	const line = state.doc.lineAt(range.head);
	if (insideFence(state.doc, line.number) || fence.test(line.text)) {
		const indent = indentOf(line.text, range.head - line.from),
			insert = `\n${indent}`;
		host.dispatch({
			changes: { from: range.head, insert },
			selection: { anchor: range.head + insert.length },
			scrollIntoView: true,
			userEvent: 'input',
		});
		return true;
	}
	const block = parseBlock(line.text);
	if (!block) return false;
	const column = range.head - line.from;
	if (column < block.contentFrom) return false;
	const empty = line.text.slice(block.contentFrom).trim() === '';
	if (empty && column >= line.text.trimEnd().length) {
		if (block.kind !== 'quote' && block.indent > 0) {
			outdent(host, line.number);
			return true;
		}
		host.dispatch({
			changes: { from: line.from, to: line.to, insert: '' },
			selection: { anchor: line.from },
			scrollIntoView: true,
			userEvent: 'delete',
		});
		return true;
	}
	const marker = nextMarker(block),
		insert = `\n${line.text.slice(0, block.indent)}${marker}`;
	commit(host, { from: range.head, insert }, range.head + insert.length, line.number + 1);
	return true;
}

/** The indent of the closest item before this one that is shallower: where ⇧Tab puts the item (0 when it has no parent). */
function parentIndent(doc: Text, lineNumber: number): number {
	const here = parseBlock(doc.line(lineNumber).text);
	if (!isItem(here)) return 0;
	for (let number = lineNumber - 1; number >= 1; number--) {
		const block = parseBlock(doc.line(number).text);
		if (!isItem(block) || insideFence(doc, number)) break;
		if (block.indent < here.indent) return block.indent;
	}
	return 0;
}
/** The lines a level change moves: the selected items and the deeper lines under the last of them. */
function moved(doc: Text, from: number, to: number): number[] {
	const lines: number[] = [];
	for (let number = from; number <= to; number++)
		if (isItem(parseBlock(doc.line(number).text))) lines.push(number);
	const last = lines.at(-1);
	if (last === undefined) return lines;
	const base = parseBlock(doc.line(last).text)!.indent;
	for (let number = last + 1; number <= doc.lines; number++) {
		const block = parseBlock(doc.line(number).text);
		if (!isItem(block) || block.indent <= base || insideFence(doc, number)) break;
		lines.push(number);
	}
	return lines;
}
/** Tab in a list item: one level deeper, under the item before it (2 spaces under `- `, 3 under `1. `). The item takes the lines under it along. */
export function indentItem(host: Host): boolean {
	const state = host.state,
		range = state.selection.main;
	if (!inListLine(state)) return false;
	const first = state.doc.lineAt(range.from).number,
		last = state.doc.lineAt(range.to).number;
	const target = childIndent(state.doc, first);
	if (target === null) return true;
	const lines = moved(state.doc, first, last),
		current = parseBlock(state.doc.line(first).text)!.indent,
		delta = target - current;
	if (delta <= 0) return true;
	const changes: ChangeSpec[] = lines.map((number) => ({
		from: state.doc.line(number).from,
		insert: ' '.repeat(delta),
	}));
	levelChange(host, changes, first);
	return true;
}
/** ⇧Tab in a list item: one level up, to the indent of its parent. At the top level nothing moves, and the key is still the item's. */
export function outdentItem(host: Host): boolean {
	const state = host.state,
		range = state.selection.main;
	if (!inListLine(state)) return false;
	const first = state.doc.lineAt(range.from).number,
		last = state.doc.lineAt(range.to).number;
	outdentLines(host, first, last);
	return true;
}
function outdent(host: Host, lineNumber: number) {
	outdentLines(host, lineNumber, lineNumber);
}
function outdentLines(host: Host, first: number, last: number) {
	const doc = host.state.doc,
		current = parseBlock(doc.line(first).text)!.indent;
	if (current === 0) return;
	const target = parentIndent(doc, first),
		lines = moved(doc, first, last);
	const changes: ChangeSpec[] = lines.flatMap((number) => {
		const line = doc.line(number),
			remove = Math.min(current - target, parseBlock(line.text)!.indent);
		return remove > 0 ? [{ from: line.from, to: line.from + remove }] : [];
	});
	levelChange(host, changes, first);
}
function levelChange(host: Host, changes: ChangeSpec[], first: number) {
	const state = host.state,
		set = state.changes(changes),
		after = set.apply(state.doc);
	const fix = renumber(after, first, first);
	const second = fix.length ? ChangeSet.of(fix, after.length) : null,
		all = second ? set.compose(second) : set;
	host.dispatch({
		changes: all,
		selection: state.selection.map(all),
		scrollIntoView: true,
		userEvent: 'input',
	});
}
/** The indent a Tab gives the item: the content column of the closest item before it that is not deeper than this one; null when none. */
function childIndent(doc: Text, lineNumber: number): number | null {
	const here = parseBlock(doc.line(lineNumber).text);
	if (!isItem(here)) return null;
	for (let number = lineNumber - 1; number >= 1; number--) {
		const block = parseBlock(doc.line(number).text);
		if (!isItem(block) || insideFence(doc, number)) return null;
		if (block.indent <= here.indent) {
			const content = block.indent + (block.marker.length - block.indent);
			return content > here.indent ? content : null;
		}
	}
	return null;
}

/** What ⌘B ⌘I ⌘E ⌘K wrap the selection in. */
export type Wrap = 'bold' | 'italic' | 'code' | 'link';
const marks: Record<Exclude<Wrap, 'link'>, string> = { bold: '**', italic: '*', code: '`' };
/** The positions of this mark in a line. A run of `*` is one mark when it has the mark's own length (`*`, `**`), two empty marks when it has twice
 *  that, and nothing otherwise: `***` is both at once and no command can tell which half it is. */
function markPositions(text: string, mark: string): number[] {
	const found: number[] = [];
	if (mark !== '*' && mark !== '**') {
		for (
			let index = text.indexOf(mark);
			index >= 0;
			index = text.indexOf(mark, index + mark.length)
		)
			found.push(index);
		return found;
	}
	const size = mark.length;
	for (let index = 0; index < text.length;) {
		if (text[index] !== '*') {
			index++;
			continue;
		}
		let end = index;
		while (text[end] === '*') end++;
		const run = end - index;
		if (run === size) found.push(index);
		else if (run === 2 * size) found.push(index, index + size);
		index = end;
	}
	return found;
}
/** The span of this mark around `[from,to]` on its line: `**bold**` with the range inside or the caret in its text. */
function enclosing(
	state: EditorState,
	mark: string,
	from: number,
	to: number
): { open: number; close: number } | null {
	const line = state.doc.lineAt(from);
	if (state.doc.lineAt(to).number !== line.number) return null;
	const found = markPositions(line.text, mark),
		start = from - line.from,
		end = to - line.from,
		length = mark.length;
	for (let pair = 0; pair + 1 < found.length; pair += 2) {
		const open = found[pair]!,
			close = found[pair + 1]!;
		if (open + length <= start && end <= close)
			return { open: line.from + open, close: line.from + close };
	}
	return null;
}
/** ⌘B ⌘I ⌘E: wrap the selection in the mark, or take the mark off when it is already there; with no selection, a pair with the caret between. */
export function toggleWrap(host: Host, wrap: Exclude<Wrap, 'link'>): boolean {
	const state = host.state,
		mark = marks[wrap],
		length = mark.length;
	const spec = state.changeByRange((range) => {
		const text = state.sliceDoc(range.from, range.to);
		if (
			!range.empty &&
			text.length >= 2 * length &&
			text.startsWith(mark) &&
			text.endsWith(mark) &&
			wholeSpan(text, mark)
		)
			return {
				changes: [
					{ from: range.from, to: range.from + length },
					{ from: range.to - length, to: range.to },
				],
				range: EditorSelection.range(range.from, range.to - 2 * length),
			};
		const around = enclosing(state, mark, range.from, range.to);
		if (around)
			return {
				changes: [
					{ from: around.open, to: around.open + length },
					{ from: around.close, to: around.close + length },
				],
				range: EditorSelection.range(range.from - length, range.to - length),
			};
		if (range.empty)
			return {
				changes: { from: range.from, insert: mark + mark },
				range: EditorSelection.cursor(range.from + length),
			};
		return {
			changes: [
				{ from: range.from, insert: mark },
				{ from: range.to, insert: mark },
			],
			range: EditorSelection.range(range.from + length, range.to + length),
		};
	});
	host.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input' });
	return true;
}
/** `**a**` in full, not `**a** and **b**`. */
function wholeSpan(text: string, mark: string): boolean {
	const inner = text.slice(mark.length, text.length - mark.length);
	return !inner.includes(mark) && (mark !== '*' || !/^\*|\*$/.test(inner));
}
/** ⌘K: the selection becomes `[text](url)` with the caret in the address; on a link already there it goes back to its text. With no selection: `[]()` with the caret in the text. */
export function toggleLink(host: Host): boolean {
	const state = host.state,
		link = /\[([^\]\n]*)\]\(([^)\n]*)\)/g;
	const spec = state.changeByRange((range) => {
		const line = state.doc.lineAt(range.from);
		if (state.doc.lineAt(range.to).number === line.number)
			for (const match of line.text.matchAll(link)) {
				const from = line.from + match.index!,
					to = from + match[0].length;
				if (range.from >= from && range.to <= to) {
					const label = match[1]!,
						caret = Math.min(Math.max(range.from - from - 1, 0), label.length);
					return {
						changes: { from, to, insert: label },
						range: range.empty
							? EditorSelection.cursor(from + caret)
							: EditorSelection.range(from, from + label.length),
					};
				}
			}
		const text = state.sliceDoc(range.from, range.to);
		if (range.empty)
			return {
				changes: { from: range.from, insert: '[]()' },
				range: EditorSelection.cursor(range.from + 1),
			};
		return {
			changes: { from: range.from, to: range.to, insert: `[${text}]()` },
			range: EditorSelection.cursor(range.from + text.length + 3),
		};
	});
	host.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input' });
	return true;
}

/** The menu actions of Edit ▸ Formatting and what each does. */
export const formatActions = {
	'format-bold': 'bold',
	'format-italic': 'italic',
	'format-code': 'code',
	'format-link': 'link',
} as const satisfies Record<string, Wrap>;
export function applyFormat(host: Host, wrap: Wrap): boolean {
	return wrap === 'link' ? toggleLink(host) : toggleWrap(host, wrap);
}

// ---- paste ----

const glyphs = /^([ \t]*)([•◦▪▫‣⁃●○■□])[ \t ]+(?=\S)/;
const glyphLevel: Record<string, number> = {
	'•': 0,
	'●': 0,
	'‣': 0,
	'⁃': 0,
	'◦': 1,
	'○': 1,
	'▪': 2,
	'■': 2,
	'▫': 2,
	'□': 2,
};
/** Slack, Notion and Pages copy a list as `•` / `◦` / `▪` lines: they become `- ` items, nested by their indent, or by the glyph when there is none. */
export function bulletGlyphsToMarkdown(text: string): string | null {
	const lines = text.split('\n'),
		matches = lines.map((line) => glyphs.exec(line));
	if (!matches.some(Boolean)) return null;
	const flat = matches.every((match) => !match || match[1] === ''),
		levels = new Set(matches.flatMap((match) => (match ? [glyphLevel[match[2]!]!] : [])));
	return lines
		.map((line, index) => {
			const match = matches[index];
			if (!match) return line;
			const indent =
				flat && levels.size > 1
					? '  '.repeat(glyphLevel[match[2]!]!)
					: match[1]!.replace(/\t/g, '  ');
			return `${indent}- ${line.slice(match[0].length)}`;
		})
		.join('\n');
}
const entities: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};
const decode = (text: string) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] === '#') {
			const code =
				name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
			return Number.isFinite(code) && code > 0 && code < 0x110000
				? String.fromCodePoint(code)
				: whole;
		}
		return entities[name.toLowerCase()] ?? whole;
	});
/** A list in the clipboard's HTML (`<ul>`, `<ol>`, `<li>`, nested) as Markdown items; null when the HTML holds no list. */
export function htmlListToMarkdown(html: string): string | null {
	if (!/<li[\s>]/i.test(html)) return null;
	const parts = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
		.split(/(<[^>]*>)/);
	const lists: { ordered: boolean; count: number; indent: string }[] = [],
		out: string[] = [];
	let item: { indent: string; marker: string; text: string } | null = null,
		paragraph = '';
	const flush = () => {
		if (item) {
			out.push(`${item.indent}${item.marker}${item.text.replace(/\s+/g, ' ').trim()}`);
			item = null;
		}
		if (paragraph.trim()) {
			out.push(paragraph.replace(/\s+/g, ' ').trim());
		}
		paragraph = '';
	};
	for (const part of parts) {
		if (part.startsWith('<')) {
			const tag = /^<\/?([a-z0-9]+)/i.exec(part)?.[1]?.toLowerCase(),
				closing = part.startsWith('</');
			if (tag === 'ul' || tag === 'ol') {
				flush();
				if (closing) lists.pop();
				else {
					const parent = lists.at(-1);
					lists.push({
						ordered: tag === 'ol',
						count: 0,
						indent: parent ? parent.indent + (parent.ordered ? '   ' : '  ') : '',
					});
				}
			} else if (tag === 'li') {
				flush();
				if (!closing) {
					const list = lists.at(-1) ?? { ordered: false, count: 0, indent: '' };
					list.count++;
					item = { indent: list.indent, marker: list.ordered ? `${list.count}. ` : '- ', text: '' };
				}
			} else if (tag === 'br' || tag === 'p' || tag === 'div' || /^h[1-6]$/.test(tag ?? '')) {
				if (item) item.text += ' ';
				else flush();
			}
			continue;
		}
		const text = decode(part);
		if (item) item.text += text;
		else paragraph += text;
	}
	flush();
	return out.length ? out.join('\n') : null;
}
/**
 * What a paste becomes, or null to leave it as the browser pastes it. An address pasted over a selected word makes a link; `•` lines and an HTML
 * list become Markdown items; any other text stays as it is.
 */
export function pasteAsMarkdown(plain: string, html: string, selected: string): string | null {
	const address = plain.trim();
	if (selected && !selected.includes('\n') && /^https?:\/\/\S+$/.test(address))
		return `[${selected}](${address})`;
	const converted = bulletGlyphsToMarkdown(plain);
	if (converted !== null) return converted;
	if (!/^[ \t]*(?:[-*]|\d+\.) /m.test(plain)) {
		const list = htmlListToMarkdown(html);
		if (list !== null) return list;
	}
	return null;
}
