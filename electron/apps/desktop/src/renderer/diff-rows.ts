import type {
	DiffLine,
	FileDiff,
	PRDraft,
	PRSummarySpot,
	PRThread,
	ReviewSnapshot,
} from '@brigadir/core';
type Comment = ReviewSnapshot['comments'][number];
/**
 * spec/pull-requests-and-ci#pr-threads: GitHub threads and PR review drafts become diff rows at the same positions as our comments.
 * spec/appearance#evolution-redesign, diff markers: summary markers too, before the threads and drafts of their line; only on new-side
 * lines the diff shows (the range end, or without it the last shown line of the range).
 */
export function prRows(
	pr: {
		threads: readonly PRThread[];
		drafts: readonly PRDraft[];
		spots?: readonly PRSummarySpot[] | undefined;
	},
	file: Pick<FileDiff['file'], 'scopeId' | 'path'>,
	lines: readonly DiffLine[] = []
): Comment[] {
	const anchor = (side: 'LEFT' | 'RIGHT', start: number, end: number) => ({
		scopeId: file.scopeId,
		path: file.path,
		side: side === 'LEFT' ? ('old' as const) : ('new' as const),
		blob: '',
		start,
		end,
		quote: [],
		before: [],
		after: [],
		contextHash: '',
		symbolPath: null,
	});
	const row = (id: string, side: 'LEFT' | 'RIGHT', start: number, end: number): Comment => ({
		id,
		version: 0,
		text: '',
		at: '',
		anchor: anchor(side, start, end),
		position: { state: 'exact', start, end },
		sent: true,
	});
	const shown = new Set(lines.map((line) => line.newLine).filter((line) => line !== null));
	const spots = (pr.spots ?? []).flatMap((spot) => {
		if (spot.path !== file.path) return [];
		let end = spot.end;
		while (end >= spot.start && !shown.has(end)) end--;
		return end < spot.start ? [] : [row(`pr-spot:${spot.key}`, 'RIGHT', spot.start, end)];
	});
	return [
		...spots,
		...pr.threads
			.filter((thread) => thread.path === file.path && thread.line !== null)
			.map((thread) =>
				row(`pr-thread:${thread.id}`, thread.side, thread.startLine ?? thread.line!, thread.line!)
			),
		...pr.drafts
			.filter((draft) => draft.path === file.path && draft.replyTo === null)
			.map((draft) =>
				row(`pr-draft:${draft.id}`, draft.side, draft.startLine ?? draft.line, draft.line)
			),
	];
}
export type Row = {
	id: string;
	old: DiffLine | null;
	next: DiffLine | null;
	line?: DiffLine;
	hidden?: number;
	comment?: Comment;
	selection?: true;
};
export const lineAt = (row: Row, side: 'old' | 'new') =>
	row.line
		? side === 'old'
			? row.line.oldLine
			: row.line.newLine
		: side === 'old'
			? row.old?.oldLine
			: row.next?.newLine;
/** spec/diff-and-review#open-in-editor: the buffer line a diff line opens at in the editor: its own new line, or for a removed line the line just after its block. */
export function editorLines(lines: readonly DiffLine[]) {
	const removed = new Map<number, number>();
	let above = 0;
	for (const line of lines) {
		if (line.newLine !== null) above = line.newLine;
		else if (line.oldLine !== null) removed.set(line.oldLine, above + 1);
	}
	return (line: DiffLine | null | undefined) =>
		line?.newLine ?? (line?.oldLine != null ? removed.get(line.oldLine) : undefined);
}
/** spec/editor#reopen-closed-tab: the buffer line for a line number on one side of the diff — the new side as it is, an old one where its
 *  line opens (spec/diff-and-review#open-in-editor). Undefined for a number the diff does not show. */
export function sourceLine(lines: readonly DiffLine[], side: 'old' | 'new', number: number) {
	if (side === 'new') return lines.some((line) => line.newLine === number) ? number : undefined;
	return editorLines(lines)(lines.find((line) => line.oldLine === number));
}
/** Stands for "nothing expanded" so the rows memo keeps its identity across renders. */
export const noExpansion: ReadonlySet<string> = new Set();
/** Every context run open: a file shown whole (spec/pull-requests-and-ci#pr-definition). */
export const unfolded: ReadonlySet<string> = new Set(['*']);
/**
 * DiffView rows: collapsed context, the selection or comment-draft row after `range.end`, and comment cards after their
 * end line. It takes the range as primitives and the draft only by its editing id, so typing in a draft does not
 * rebuild the rows; comment ends are looked up in a map instead of a scan per row.
 */
export function diffRows(
	diff: FileDiff,
	mode: string,
	expanded: ReadonlySet<string>,
	comments: ReviewSnapshot['comments'],
	rangeSide: 'old' | 'new' | undefined,
	rangeEnd: number | undefined,
	draft: boolean,
	editingId: string | null
): Row[] {
	const all: Row[] =
		mode === 'unified'
			? diff.lines.map((line, i) => ({ id: String(i), old: null, next: null, line }))
			: diff.pairs.map((p, i) => ({ id: String(i), old: p.old, next: p.new }));
	const relevant = comments.filter((c) => c.position),
		ends = new Map<string, number[]>();
	relevant.forEach((comment, index) => {
		const end = comment.position?.end;
		if (end === null || end === undefined) return;
		const key = `${comment.anchor.side}:${end}`;
		const list = ends.get(key);
		if (list) list.push(index);
		else ends.set(key, [index]);
	});
	// Indexes into `relevant` of comments ending on this row, in `relevant` order.
	const ending = (row: Row) => {
		const old = ends.get(`old:${lineAt(row, 'old')}`),
			next = ends.get(`new:${lineAt(row, 'new')}`);
		return old && next ? [...old, ...next].sort((a, b) => a - b) : (old ?? next);
	};
	const context = (r: Row) =>
		mode === 'unified'
			? r.line?.kind === 'context'
			: r.old?.kind === 'context' && r.next?.kind === 'context';
	const out: Row[] = [];
	for (let i = 0; i < all.length;) {
		if (!context(all[i]!)) {
			out.push(all[i++]!);
			continue;
		}
		let end = i;
		while (end < all.length && context(all[end]!)) end++;
		const start = i === 0 ? i : i + 3;
		const stop = end === all.length ? end : end - 3;
		const id = `context-${mode}-${i}`;
		if (
			stop - start > 3 &&
			!expanded.has('*') &&
			!expanded.has(id) &&
			!all
				.slice(start, stop)
				.some((row) => (rangeSide && lineAt(row, rangeSide) === rangeEnd) || ending(row))
		) {
			out.push(
				...all.slice(i, start),
				{ id, old: null, next: null, hidden: stop - start },
				...all.slice(stop, end)
			);
		} else out.push(...all.slice(i, end));
		i = end;
	}
	const decorated: Row[] = [];
	const placed = new Set<string>();
	let selectionPlaced = false;
	for (const row of out) {
		decorated.push(row);
		if (rangeSide && lineAt(row, rangeSide) === rangeEnd) {
			decorated.push({ id: 'selection', old: null, next: null, selection: true });
			selectionPlaced = true;
		}
		for (const index of ending(row) ?? []) {
			const comment = relevant[index]!;
			if (comment.id === editingId) continue;
			decorated.push({ id: `comment-${comment.id}`, old: null, next: null, comment });
			placed.add(comment.id);
		}
	}
	if (draft && !selectionPlaced)
		decorated.push({ id: 'selection', old: null, next: null, selection: true });
	for (const comment of relevant)
		if (!placed.has(comment.id) && comment.id !== editingId)
			decorated.push({ id: `comment-${comment.id}`, old: null, next: null, comment });
	return decorated;
}
