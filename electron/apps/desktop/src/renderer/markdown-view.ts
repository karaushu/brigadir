import type { DiffLine } from '@brigadir/core';
import { markdown, type MarkdownTokens } from './markdown';

/** spec/editor#markdown-views: a block of a Markdown document as the preview shows it, with its source lines (1-based, inclusive).
 *  Lists split into items and tables into rows, so a changed item or row is marked alone, not its whole list. */
export type MarkdownUnit = {
	open: number;
	close: number;
	start: number;
	end: number;
	kind: 'block' | 'item' | 'row';
};
type Token = MarkdownTokens[number];

function closeOf(tokens: MarkdownTokens, open: number): number {
	const token = tokens[open]!;
	if (token.nesting !== 1) return open;
	for (let i = open + 1; i < tokens.length; i++) {
		const next = tokens[i]!;
		if (next.level === token.level && next.nesting === -1) return i;
	}
	return tokens.length - 1;
}
const lines = (token: Token): [number, number] | null =>
	token.map ? [token.map[0] + 1, Math.max(token.map[0] + 1, token.map[1])] : null;

export function markdownUnits(tokens: MarkdownTokens): MarkdownUnit[] {
	const units: MarkdownUnit[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.level !== 0 || token.nesting === -1) continue;
		const close = closeOf(tokens, i),
			range = lines(token);
		if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
			for (let j = i + 1; j < close; j++) {
				const item = tokens[j]!;
				if (item.type === 'list_item_open' && item.level === 1) {
					const end = closeOf(tokens, j),
						own = lines(item);
					if (own) units.push({ open: j, close: end, start: own[0], end: own[1], kind: 'item' });
					j = end;
				}
			}
		} else if (token.type === 'table_open') {
			for (let j = i + 1; j < close; j++) {
				const row = tokens[j]!;
				if (row.type === 'tr_open') {
					const end = closeOf(tokens, j),
						own = lines(row);
					if (own) units.push({ open: j, close: end, start: own[0], end: own[1], kind: 'row' });
					j = end;
				}
			}
		} else if (range) units.push({ open: i, close, start: range[0], end: range[1], kind: 'block' });
		i = close;
	}
	return units;
}

/** Tokens of the preview: every block-level token with a source map carries `data-line="start-end"`, which the
 *  preview uses to keep the place when it switches to the code, scrolls beside it or finds a match. */
export function markdownViewTokens(text: string): MarkdownTokens {
	const tokens = markdown.parse(text, {});
	for (const token of tokens) {
		const range = lines(token);
		if (range && token.nesting >= 0 && token.block)
			token.attrSet('data-line', `${range[0]}-${range[1]}`);
	}
	return tokens;
}

/** The new line before which a run of removed lines stood: the first added line of the run, else the new line after
 *  the context above it (the same landing rule as spec/diff-and-review#open-in-editor). */
function runs(lines: DiffLine[]) {
	const result: { removed: number[]; added: number[]; at: number }[] = [];
	let above = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.kind === 'context') {
			above = line.newLine ?? above;
			continue;
		}
		const run = { removed: [] as number[], added: [] as number[], at: 0 };
		for (; i < lines.length && lines[i]!.kind !== 'context'; i++) {
			const part = lines[i]!;
			if (!part.text.trim()) continue;
			if (part.kind === 'removed' && part.oldLine) run.removed.push(part.oldLine);
			if (part.kind === 'added' && part.newLine) run.added.push(part.newLine);
		}
		i--;
		run.at = run.added[0] ?? above + 1;
		result.push(run);
	}
	return result;
}
const overlaps = (unit: MarkdownUnit, set: number[]) =>
	set.some((line) => line >= unit.start && line <= unit.end);
function htmlToken(template: Token, content: string): Token {
	const token = new (
		template.constructor as new (type: string, tag: string, nesting: number) => Token
	)('html_block', '', 0);
	token.content = content;
	token.block = true;
	return token;
}

export type MarkdownDiff = { tokens: MarkdownTokens; newFile: boolean };
/** spec/editor#markdown-views: the new version of the document with the changed blocks marked. A block whose lines the diff added is
 *  `added`; the old version of every block whose lines it removed stands, `removed`, right before the place where it
 *  was, so a changed block reads old above new, as in the unified diff. A new file is one `added` document. */
export function markdownDiffTokens(
	beforeText: string,
	afterText: string,
	diffLines: DiffLine[]
): MarkdownDiff {
	const after = markdownViewTokens(afterText);
	const changed = runs(diffLines);
	if (!beforeText && changed.every((run) => !run.removed.length))
		return { tokens: after, newFile: true };
	const before = markdownViewTokens(beforeText),
		afterUnits = markdownUnits(after),
		beforeUnits = markdownUnits(before);
	const added = changed.flatMap((run) => run.added);
	const removedAt = new Map<number, Token[]>(),
		openAt = new Map<number, Token[]>(),
		closeAt = new Map<number, Token[]>();
	const push = (map: Map<number, Token[]>, index: number, tokens: Token[]) =>
		map.set(index, [...(map.get(index) ?? []), ...tokens]);
	for (const unit of afterUnits) {
		if (!overlaps(unit, added)) continue;
		const open = after[unit.open]!;
		if (unit.kind === 'block') {
			push(openAt, unit.open, [htmlToken(open, '<div data-change="added">')]);
			push(closeAt, unit.close, [htmlToken(open, '</div>')]);
		} else open.attrSet('data-change', 'added');
	}
	const top = (index: number) => {
		while (index > 0 && after[index]!.level > 0) index--;
		return index;
	};
	for (const run of changed) {
		const target = afterUnits.find((unit) => unit.end >= run.at) ?? null;
		for (const unit of beforeUnits.filter((unit) => overlaps(unit, run.removed))) {
			const same = Boolean(target && target.kind === unit.kind && target.kind !== 'block');
			const index = target ? (same ? target.open : top(target.open)) : after.length;
			let slice = before.slice(unit.open, unit.close + 1);
			const first = slice[0]!;
			// Old line numbers are not this document's: a removed block has no place to map to.
			for (const token of slice)
				if (token.attrs) token.attrs = token.attrs.filter(([name]) => name !== 'data-line');
			if (unit.kind === 'block')
				slice = [
					htmlToken(first, '<div data-change="removed">'),
					...slice,
					htmlToken(first, '</div>'),
				];
			else {
				first.attrSet('data-change', 'removed');
				if (!same && unit.kind === 'item') {
					const list = before
						.slice(0, unit.open)
						.reverse()
						.find(
							(token) => token.type === 'bullet_list_open' || token.type === 'ordered_list_open'
						)!;
					slice = [htmlToken(list, `<${list.tag}>`), ...slice, htmlToken(list, `</${list.tag}>`)];
				}
				if (!same && unit.kind === 'row')
					slice = [
						htmlToken(first, '<table><tbody>'),
						...slice,
						htmlToken(first, '</tbody></table>'),
					];
			}
			push(removedAt, index, slice);
		}
	}
	const tokens: Token[] = [];
	for (let i = 0; i <= after.length; i++) {
		tokens.push(...(removedAt.get(i) ?? []), ...(openAt.get(i) ?? []));
		if (i < after.length) tokens.push(after[i]!, ...(closeAt.get(i) ?? []));
	}
	return { tokens, newFile: false };
}

/** The unit of the preview's source that holds `line`, else the first after it. */
export function unitForLine(units: { start: number; end: number }[], line: number) {
	return units.find((unit) => line <= unit.end) ?? units.at(-1) ?? null;
}
