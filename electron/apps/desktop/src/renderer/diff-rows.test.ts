import { expect, it } from 'vitest';
import type { FileDiff, ReviewSnapshot } from '@brigadir/core';
import { diffLines } from '../../../../packages/diff/src/index';
import {
	diffRows,
	editorLines,
	lineAt,
	noExpansion,
	prRows,
	sourceLine,
	type Row,
} from './diff-rows';
type Comments = ReviewSnapshot['comments'];
// DiffView's rows before DIFF-09, kept as the reference.
function reference(
	diff: FileDiff,
	mode: string,
	expanded: ReadonlySet<string>,
	comments: Comments,
	range: { side: 'old' | 'new'; end: number } | null,
	draft: { editingId: string | null } | null
): Row[] {
	const relevant = comments.filter((c) => c.position);
	const all: Row[] =
		mode === 'unified'
			? diff.lines.map((line, i) => ({ id: String(i), old: null, next: null, line }))
			: diff.pairs.map((p, i) => ({ id: String(i), old: p.old, next: p.new }));
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
				.some(
					(row) =>
						(range && lineAt(row, range.side) === range.end) ||
						relevant.some((c) => c.position?.end === lineAt(row, c.anchor.side))
				)
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
		if (range && lineAt(row, range.side) === range.end) {
			decorated.push({ id: 'selection', old: null, next: null, selection: true });
			selectionPlaced = true;
		}
		for (const comment of relevant)
			if (
				comment.id !== draft?.editingId &&
				comment.position?.end !== null &&
				comment.position?.end === lineAt(row, comment.anchor.side)
			) {
				decorated.push({ id: `comment-${comment.id}`, old: null, next: null, comment });
				placed.add(comment.id);
			}
	}
	if (draft && !selectionPlaced)
		decorated.push({ id: 'selection', old: null, next: null, selection: true });
	for (const comment of relevant)
		if (!placed.has(comment.id) && comment.id !== draft?.editingId)
			decorated.push({ id: `comment-${comment.id}`, old: null, next: null, comment });
	return decorated;
}
const random = (seed: number) => () =>
	(seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
function fixture(lines: number, edits: number, count: number, seed: number) {
	const next = random(seed),
		before = Array.from({ length: lines }, (_, i) => `line ${i}`),
		after = [...before];
	for (let k = 0; k < edits; k++) {
		const at = Math.floor(next() * after.length);
		if (k % 3 === 0) after.splice(at, 1);
		else if (k % 3 === 1) after.splice(at, 0, `added ${k}`);
		else after[at] += ' changed';
	}
	const diff = {
		...diffLines(before.join('\n'), after.join('\n')),
		file: { id: 'f', scopeId: 's', path: 'a.ts' },
		beforeText: '',
		afterText: '',
		binary: false,
		tooLarge: false,
	} as unknown as FileDiff;
	const comments = Array.from({ length: count }, (_, i) => {
		const side = next() < 0.5 ? ('old' as const) : ('new' as const),
			end = next() < 0.1 ? null : 1 + Math.floor(next() * lines);
		return {
			id: `c${i}`,
			anchor: { side },
			position: i % 7 === 6 ? undefined : { state: 'exact', start: end, end },
		};
	}) as unknown as Comments;
	return { diff, comments, next };
}
it('builds the same rows as before for ranges, drafts, expansions and comments on both sides (DIFF-09)', () => {
	for (let seed = 1; seed <= 30; seed++) {
		const { diff, comments, next } = fixture(400, 12, (seed % 6) * 3, seed);
		for (const mode of ['unified', 'sbs']) {
			const range =
					next() < 0.3
						? null
						: {
								side: next() < 0.5 ? ('old' as const) : ('new' as const),
								start: 1,
								end: 1 + Math.floor(next() * 400),
							},
				draft =
					next() < 0.5 ? null : { editingId: next() < 0.5 ? null : `c${Math.floor(next() * 6)}` };
			const expanded =
				next() < 0.2 ? new Set(['*']) : next() < 0.3 ? new Set([`context-${mode}-0`]) : noExpansion;
			expect(
				diffRows(
					diff,
					mode,
					expanded,
					comments,
					range?.side,
					range?.end,
					Boolean(draft),
					draft?.editingId ?? null
				)
			).toEqual(reference(diff, mode, expanded, comments, range, draft));
		}
	}
});
it('builds 12k-line rows with 60 comments faster than the per-row comment scan', () => {
	const { diff, comments } = fixture(12000, 50, 60, 99),
		range = { side: 'new' as const, end: 6000 };
	const time = (build: () => Row[]) => {
		build();
		const start = performance.now();
		for (let i = 0; i < 10; i++) build();
		return (performance.now() - start) / 10;
	};
	const before = time(() =>
			reference(diff, 'sbs', noExpansion, comments, range, { editingId: null })
		),
		after = time(() => diffRows(diff, 'sbs', noExpansion, comments, 'new', 6000, true, null));
	expect(after).toBeLessThan(before);
});
it('opens a removed line at the place of its block and a new line at itself (spec/diff-and-review#open-in-editor)', () => {
	const { lines } = diffLines(
		['a', 'b', 'gone 1', 'gone 2', 'c', 'tail'].join('\n') + '\n',
		['a', 'B', 'c'].join('\n') + '\n'
	);
	const at = editorLines(lines);
	const old = (n: number) => lines.find((line) => line.oldLine === n && line.newLine === null)!;
	const next = (n: number) => lines.find((line) => line.newLine === n)!;
	expect(at(next(1))).toBe(1);
	expect(at(next(2))).toBe(2);
	expect(at(next(3))).toBe(3);
	// A replaced block lists its removed lines first: they open at the first line that replaced them.
	expect(at(old(2))).toBe(2);
	expect(at(old(3))).toBe(2);
	expect(at(old(4))).toBe(2);
	expect(at(old(6))).toBe(4);
	expect(at(null)).toBeUndefined();
});
it('reads the source line of either side for Jump to source (spec/editor#reopen-closed-tab)', () => {
	const { lines } = diffLines(
		['a', 'b', 'gone 1', 'gone 2', 'c', 'tail'].join('\n') + '\n',
		['a', 'B', 'c'].join('\n') + '\n'
	);
	expect(sourceLine(lines, 'new', 3)).toBe(3);
	expect(sourceLine(lines, 'new', 9)).toBeUndefined();
	expect(sourceLine(lines, 'old', 1)).toBe(1);
	expect(sourceLine(lines, 'old', 4)).toBe(2);
	expect(sourceLine(lines, 'old', 6)).toBe(4);
});
it('puts the summary markers under their line, before the thread there; a line the diff lacks gets none (spec/appearance#evolution-redesign)', () => {
	const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`),
		after = [...before];
	after[19] = 'line 20 changed';
	const { lines, pairs } = diffLines(before.join('\n') + '\n', after.join('\n') + '\n');
	const diff = {
		lines,
		pairs,
		file: { id: 'f', scopeId: 's', path: 'a.ts' },
	} as unknown as FileDiff;
	const spot = (key: string, start: number, end: number, path = 'a.ts') => ({
		key,
		kind: 'risk' as const,
		path,
		start,
		end,
		text: key,
	});
	const thread = { id: 't', path: 'a.ts', side: 'RIGHT', line: 20, startLine: null, comments: [] };
	const comments = prRows(
		{
			threads: [thread] as never,
			drafts: [],
			spots: [
				spot('h:risk:0', 20, 20),
				spot('h:check:1', 2, 40),
				spot('h:risk:1', 31, 33),
				spot('h:risk:2', 20, 20, 'b.ts'),
			],
		},
		diff.file,
		diff.lines
	);
	// The range 2–40 lands on the last line the diff shows (30); 31–33 and another file's marker give none.
	expect(comments.map((comment) => [comment.id, comment.position?.end])).toEqual([
		['pr-spot:h:risk:0', 20],
		['pr-spot:h:check:1', 30],
		['pr-thread:t', 20],
	]);
	const rows = diffRows(diff, 'unified', noExpansion, comments, undefined, undefined, false, null);
	const at = rows.findIndex((row) => row.line?.newLine === 20 && row.line.kind === 'added');
	expect(rows.slice(at + 1, at + 3).map((row) => row.comment?.id)).toEqual([
		'pr-spot:h:risk:0',
		'pr-thread:t',
	]);
	expect(rows.at(-1)?.comment?.id).toBe('pr-spot:h:check:1');
	expect(rows.at(-2)?.line?.newLine).toBe(30);
});
