/**
 * spec/appearance#evolution-redesign: a ```diff (or ```patch) block of an agent's answer is drawn as a diff, not as text. This is its model: the
 * signs leave the text for their own column, a tab is four spaces and the indent every line shares is gone; «--- path» /
 * «+++ path» becomes a file row with its +N −M, a later «@@» or a lone «...» a thin break. Similar −/+ lines in a row get
 * word spans (the `DiffLine.spans` encoding); each file keeps its old and new text, so the grammar of its path colours it.
 * No React, no DOM: MarkdownBlock draws it.
 */
import { wordSpans } from '@brigadir/diff';
import { syntaxLanguage } from '@brigadir/core';

export type FenceDiffLine = {
	kind: 'context' | 'added' | 'removed';
	text: string;
	spans?: number[];
	/** The file part this line belongs to, and its 1-based line in that part's new text (old text for a removed line). */
	part: number;
	line: number;
};
export type FenceDiffRow =
	| FenceDiffLine
	| { kind: 'gap' }
	| { kind: 'file'; path: string; additions: number; deletions: number; part: number };
/** One file of the block: the fence label of its grammar (null: none) and the texts its lines come from. */
export type FenceDiffPart = { language: string | null; old: string[]; new: string[] };
export type FenceDiff = {
	rows: FenceDiffRow[];
	parts: FenceDiffPart[];
	additions: number;
	deletions: number;
};

export function isDiffFence(label: string): boolean {
	const word = label.trim().toLowerCase().split(/\s+/)[0] ?? '';
	return word === 'diff' || word === 'patch';
}

/** A word diff that changes most of both lines says nothing a −/+ pair does not: such lines are not «similar». */
const similar = (spans: { old: number[]; new: number[] }, before: string, after: string) => {
	let changed = 0;
	for (const list of [spans.old, spans.new]) {
		let from = 0;
		for (const span of list) {
			const to = span >>> 1;
			if (span & 1) changed += to - from;
			from = to;
		}
	}
	return changed <= 0.6 * (before.length + after.length);
};

const header =
	/^(diff --git |index [0-9a-f]+\.\.|(new|deleted) file mode |similarity index |rename (from|to) |old mode |new mode )/;

export function fenceDiff(source: string): FenceDiff {
	const lines = source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
	type Entry =
		| { kind: 'context' | 'added' | 'removed'; text: string; part: number }
		| { kind: 'gap' }
		| { kind: 'file'; path: string; part: number };
	const entries: Entry[] = [],
		parts: FenceDiffPart[] = [];
	let part = -1,
		hunks = 0;
	const open = (language: string | null) => {
		parts.push({ language, old: [], new: [] });
		part = parts.length - 1;
		hunks = 0;
	};
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		if (header.test(raw) || raw.startsWith('\\ ')) continue;
		if (raw.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
			const strip = (path: string) =>
				path
					.replace(/\t.*$/, '')
					.trim()
					.replace(/^[ab]\//, '');
			const from = strip(raw.slice(4)),
				to = strip(lines[i + 1]!.slice(4)),
				path = to === '/dev/null' ? from : to,
				dot = path.lastIndexOf('.'),
				ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
			open(ext && syntaxLanguage(`code.${ext}`) ? ext : null);
			entries.push({ kind: 'file', path, part });
			i++;
			continue;
		}
		if (raw.startsWith('@@')) {
			if (part < 0) open(null);
			if (hunks++ > 0) entries.push({ kind: 'gap' });
			continue;
		}
		if (raw.trim() === '...' || raw.trim() === '…') {
			entries.push({ kind: 'gap' });
			continue;
		}
		if (part < 0) open(null);
		const sign = raw[0],
			kind = sign === '+' ? 'added' : sign === '-' ? 'removed' : 'context',
			body = sign === '+' || sign === '-' || sign === ' ' ? raw.slice(1) : raw;
		entries.push({ kind, text: body.replace(/\t/g, '    '), part });
	}
	// The indent every line with text shares goes; an empty line has none to give.
	let indent = Infinity;
	for (const entry of entries)
		if ('text' in entry && entry.text.trim())
			indent = Math.min(indent, /^ */.exec(entry.text)![0].length);
	const cut = Number.isFinite(indent) ? indent : 0;
	const rows: FenceDiffRow[] = [];
	const files = new Map<number, Extract<FenceDiffRow, { kind: 'file' }>>();
	let additions = 0,
		deletions = 0;
	for (const entry of entries) {
		if (entry.kind === 'gap') {
			rows.push(entry);
			continue;
		}
		if (entry.kind === 'file') {
			const row = {
				kind: 'file' as const,
				path: entry.path,
				additions: 0,
				deletions: 0,
				part: entry.part,
			};
			files.set(entry.part, row);
			rows.push(row);
			continue;
		}
		const text = entry.text.slice(Math.min(cut, /^ */.exec(entry.text)![0].length)),
			side = parts[entry.part]!;
		if (entry.kind !== 'added') side.old.push(text);
		if (entry.kind !== 'removed') side.new.push(text);
		const file = files.get(entry.part);
		if (entry.kind === 'added') {
			additions++;
			if (file) file.additions++;
		}
		if (entry.kind === 'removed') {
			deletions++;
			if (file) file.deletions++;
		}
		rows.push({
			kind: entry.kind,
			text,
			part: entry.part,
			line: entry.kind === 'removed' ? side.old.length : side.new.length,
		});
	}
	// A run of removed lines before a run of added ones: each removed line pairs with the next added line in order that is
	// similar to it (a comment inserted above the changed line does not shift the pair, canvas 2.3).
	for (let i = 0; i < rows.length;) {
		if (rows[i]!.kind !== 'removed') {
			i++;
			continue;
		}
		const removed: FenceDiffLine[] = [],
			added: FenceDiffLine[] = [];
		while (rows[i]?.kind === 'removed') removed.push(rows[i++] as FenceDiffLine);
		while (rows[i]?.kind === 'added') added.push(rows[i++] as FenceDiffLine);
		let from = 0;
		for (const before of removed)
			for (let n = from; n < added.length; n++) {
				const after = added[n]!,
					spans = wordSpans(before.text, after.text);
				if (!similar(spans, before.text, after.text)) continue;
				before.spans = spans.old;
				after.spans = spans.new;
				from = n + 1;
				break;
			}
	}
	return { rows, parts, additions, deletions };
}
