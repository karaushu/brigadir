import type { DiffLine, DiffPair, GutterHunk } from '@brigadir/core';
type Edit = { kind: 'context' | 'removed' | 'added'; value: string };
/** Linear-space Myers (bisect with a middle snake) over interned line ids, spending at most `work` diagonal and snake
 *  steps (perf review DIFF-04). It runs only where patience found no anchor and the LCS table exceeds its budget, so
 *  ordinary code keeps patience hunks. A subrange that runs out of work, or whose lower bound on edits already exceeds
 *  it, falls back to "all removed + all added". Each change run comes out removed-first, like the rest of the diff. */
function myers(
	a: string[],
	b: string[],
	a0: number,
	a1: number,
	b0: number,
	b1: number,
	out: Edit[],
	left: { work: number }
) {
	const ids = new Map<string, number>(),
		A = new Int32Array(a1 - a0),
		B = new Int32Array(b1 - b0),
		counts: number[] = [];
	for (let i = a0; i < a1; i++) {
		let id = ids.get(a[i]!);
		if (id === undefined) {
			id = ids.size;
			ids.set(a[i]!, id);
			counts.push(0);
		}
		A[i - a0] = id;
		counts[id]!++;
	}
	let common = 0;
	for (let j = b0; j < b1; j++) {
		const id = ids.get(b[j]!);
		if (id !== undefined && counts[id]! > 0) {
			counts[id]!--;
			common++;
		}
		B[j - b0] = id ?? -1;
	}
	const minEdits = A.length + B.length - 2 * common,
		start = out.length;
	const replace = (x0: number, x1: number, y0: number, y1: number) => {
		for (let i = x0; i < x1; i++) out.push({ kind: 'removed', value: a[a0 + i]! });
		for (let j = y0; j < y1; j++) out.push({ kind: 'added', value: b[b0 + j]! });
	};
	// The bisect needs about (edits/2)² diagonal steps: skip the search when even the multiset bound cannot fit.
	if ((minEdits * minEdits) / 4 > left.work) {
		replace(0, A.length, 0, B.length);
		return;
	}
	const range = (x0: number, x1: number, y0: number, y1: number) => {
		while (x0 < x1 && y0 < y1 && A[x0] === B[y0]) {
			out.push({ kind: 'context', value: a[a0 + x0]! });
			x0++;
			y0++;
		}
		let suffix = 0;
		while (x0 < x1 - suffix && y0 < y1 - suffix && A[x1 - suffix - 1] === B[y1 - suffix - 1])
			suffix++;
		const xe = x1 - suffix,
			ye = y1 - suffix;
		if (x0 === xe || y0 === ye || left.work <= 0) replace(x0, xe, y0, ye);
		else {
			const split = bisect(x0, xe, y0, ye);
			if (split && split[0] + split[1] > x0 + y0 && split[0] + split[1] < xe + ye) {
				range(x0, split[0], y0, split[1]);
				range(split[0], xe, split[1], ye);
			} else replace(x0, xe, y0, ye);
		}
		for (let i = x1 - suffix; i < x1; i++) out.push({ kind: 'context', value: a[a0 + i]! });
	};
	// Myers 1986 spec/diff-and-review#snapshotsb; the split point lies strictly inside the box, so both halves are smaller.
	const bisect = (x0: number, x1: number, y0: number, y1: number): [number, number] | null => {
		const n = x1 - x0,
			m = y1 - y0,
			maxD = Math.ceil((n + m) / 2),
			offset = maxD,
			length = 2 * maxD + 2,
			v1 = new Int32Array(length).fill(-1),
			v2 = new Int32Array(length).fill(-1);
		v1[offset + 1] = 0;
		v2[offset + 1] = 0;
		const delta = n - m,
			front = (delta & 1) !== 0;
		let k1start = 0,
			k1end = 0,
			k2start = 0,
			k2end = 0,
			work = left.work;
		for (let d = 0; d < maxD; d++) {
			for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
				const k1o = offset + k1;
				let x =
						k1 === -d || (k1 !== d && v1[k1o - 1]! < v1[k1o + 1]!)
							? v1[k1o + 1]!
							: v1[k1o - 1]! + 1,
					y = x - k1;
				const from = x;
				while (x < n && y < m && A[x0 + x] === B[y0 + y]) {
					x++;
					y++;
				}
				v1[k1o] = x;
				work -= 1 + x - from;
				if (x > n) k1end += 2;
				else if (y > m) k1start += 2;
				else if (front) {
					const k2o = offset + delta - k1;
					if (k2o >= 0 && k2o < length && v2[k2o] !== -1 && x >= n - v2[k2o]!) {
						left.work = work;
						return [x0 + x, y0 + y];
					}
				}
			}
			for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
				const k2o = offset + k2;
				let x =
						k2 === -d || (k2 !== d && v2[k2o - 1]! < v2[k2o + 1]!)
							? v2[k2o + 1]!
							: v2[k2o - 1]! + 1,
					y = x - k2;
				const from = x;
				while (x < n && y < m && A[x1 - x - 1] === B[y1 - y - 1]) {
					x++;
					y++;
				}
				v2[k2o] = x;
				work -= 1 + x - from;
				if (x > n) k2end += 2;
				else if (y > m) k2start += 2;
				else if (!front) {
					const k1o = offset + delta - k2;
					if (k1o >= 0 && k1o < length && v1[k1o] !== -1) {
						const fx = v1[k1o]!;
						if (fx >= n - x) {
							left.work = work;
							return [x0 + fx, y0 + fx - (k1o - offset)];
						}
					}
				}
			}
			if (work <= 0) break;
		}
		left.work = work;
		return null;
	};
	range(0, A.length, 0, B.length);
	for (let i = start; i < out.length;) {
		if (out[i]!.kind === 'context') {
			i++;
			continue;
		}
		let end = i;
		while (end < out.length && out[end]!.kind !== 'context') end++;
		const run = out.slice(i, end);
		let at = i;
		for (const edit of run) if (edit.kind === 'removed') out[at++] = edit;
		for (const edit of run) if (edit.kind === 'added') out[at++] = edit;
		i = end;
	}
}
/** `work` > 0 enables the bounded Myers fallback for gaps without patience anchors that exceed the LCS `budget`;
 *  all such gaps of one diff share it. */
export function sequenceDiff(a: string[], b: string[], budget = 250000, work = 0): Edit[] {
	const out: Edit[] = [],
		left = { work };
	function range(a0: number, a1: number, b0: number, b1: number) {
		while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
			out.push({ kind: 'context', value: a[a0]! });
			a0++;
			b0++;
		}
		let suffix = 0;
		while (a0 < a1 - suffix && b0 < b1 - suffix && a[a1 - suffix - 1] === b[b1 - suffix - 1])
			suffix++;
		const ae = a1 - suffix,
			be = b1 - suffix;
		if (a0 === ae) {
			for (let j = b0; j < be; j++) out.push({ kind: 'added', value: b[j]! });
		} else if (b0 === be) {
			for (let i = a0; i < ae; i++) out.push({ kind: 'removed', value: a[i]! });
		} else {
			const ac = new Map<string, number>(),
				bc = new Map<string, number>();
			for (let i = a0; i < ae; i++) ac.set(a[i]!, ac.has(a[i]!) ? -1 : i);
			for (let j = b0; j < be; j++) bc.set(b[j]!, bc.has(b[j]!) ? -1 : j);
			const candidates: { a: number; b: number }[] = [];
			for (let i = a0; i < ae; i++) {
				const j = bc.get(a[i]!);
				if (ac.get(a[i]!) === i && j !== undefined && j >= 0) candidates.push({ a: i, b: j });
			}
			const tails: number[] = [],
				parents: number[] = [];
			candidates.forEach((pair, index) => {
				let lo = 0,
					hi = tails.length;
				while (lo < hi) {
					const mid = (lo + hi) >>> 1;
					if (candidates[tails[mid]!]!.b < pair.b) lo = mid + 1;
					else hi = mid;
				}
				parents[index] = lo ? tails[lo - 1]! : -1;
				tails[lo] = index;
			});
			const anchors: { a: number; b: number }[] = [];
			let cursor = tails.at(-1) ?? -1;
			while (cursor >= 0) {
				anchors.push(candidates[cursor]!);
				cursor = parents[cursor]!;
			}
			anchors.reverse();
			if (anchors.length) {
				let ai = a0,
					bi = b0;
				for (const anchor of anchors) {
					range(ai, anchor.a, bi, anchor.b);
					out.push({ kind: 'context', value: a[anchor.a]! });
					ai = anchor.a + 1;
					bi = anchor.b + 1;
				}
				range(ai, ae, bi, be);
			} else if ((ae - a0) * (be - b0) <= budget) {
				const width = be - b0 + 1,
					dp = new Uint32Array((ae - a0 + 1) * width);
				for (let i = ae - a0 - 1; i >= 0; i--)
					for (let j = be - b0 - 1; j >= 0; j--)
						dp[i * width + j] =
							a[a0 + i] === b[b0 + j]
								? dp[(i + 1) * width + j + 1]! + 1
								: Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
				let i = 0,
					j = 0;
				while (i < ae - a0 || j < be - b0) {
					if (i < ae - a0 && j < be - b0 && a[a0 + i] === b[b0 + j]) {
						out.push({ kind: 'context', value: a[a0 + i]! });
						i++;
						j++;
					} else if (
						i < ae - a0 &&
						(j === be - b0 || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)
					) {
						out.push({ kind: 'removed', value: a[a0 + i++]! });
					} else out.push({ kind: 'added', value: b[b0 + j++]! });
				}
			} else if (left.work > 0) myers(a, b, a0, ae, b0, be, out, left);
			else {
				for (let i = a0; i < ae; i++) out.push({ kind: 'removed', value: a[i]! });
				for (let j = b0; j < be; j++) out.push({ kind: 'added', value: b[j]! });
			}
		}
		for (let i = a1 - suffix; i < a1; i++) out.push({ kind: 'context', value: a[i]! });
	}
	range(0, a.length, 0, b.length);
	return out;
}
/** Token ends of both sides in the `DiffLine.spans` encoding: offset × 2, plus 1 for a changed token. */
export function wordSpans(before: string, after: string): { old: number[]; new: number[] } {
	const tokenize = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu) ?? [];
	if (before.length + after.length > 20000)
		return { old: [before.length * 2 + 1], new: [after.length * 2 + 1] };
	const edits = sequenceDiff(tokenize(before), tokenize(after), 10000),
		old: number[] = [],
		next: number[] = [];
	let a = 0,
		b = 0;
	for (const edit of edits) {
		const changed = edit.kind === 'context' ? 0 : 1;
		if (edit.kind !== 'added') {
			a += edit.value.length;
			old.push(a * 2 + changed);
		}
		if (edit.kind !== 'removed') {
			b += edit.value.length;
			next.push(b * 2 + changed);
		}
	}
	return { old, new: next };
}
/** spec/diff-and-review#file-diff: a side the diff worker takes. A line over 20 000 characters is generated data (a minified bundle); a
 *  hand-written file with an inline SVG path of a few thousand still diffs. */
export function diffable(text: string) {
	const lines = text.split('\n');
	return lines.length <= 100000 && lines.every((l) => l.length <= 20000);
}
/** Myers steps per file diff: a search that gives up costs ~100 ms on Apple Silicon, far inside the worker's 10 s
 *  limit (DIFF-04). */
export const myersWork = 10_000_000;
export function diffLines(before: string, after: string): { lines: DiffLine[]; pairs: DiffPair[] } {
	const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const edits = sequenceDiff(split(before), split(after), 250000, myersWork);
	let oldLine = 1,
		newLine = 1;
	const lines: DiffLine[] = edits.map((e) => ({
		kind: e.kind,
		text: e.value.replace(/\r?\n$/, ''),
		...(!e.value.endsWith('\n')
			? { ending: 'none' as const }
			: e.value.endsWith('\r\n')
				? { ending: 'crlf' as const }
				: {}),
		oldLine: e.kind === 'added' ? null : oldLine++,
		newLine: e.kind === 'removed' ? null : newLine++,
	}));
	const pairs: DiffPair[] = [];
	for (let i = 0; i < lines.length;) {
		const line = lines[i]!;
		if (line.kind === 'context') {
			pairs.push({ old: line, new: line });
			i++;
			continue;
		}
		const removed: DiffLine[] = [],
			added: DiffLine[] = [];
		while (i < lines.length && lines[i]!.kind !== 'context') {
			const current = lines[i++]!;
			(current.kind === 'removed' ? removed : added).push(current);
		}
		for (let n = 0; n < Math.max(removed.length, added.length); n++) {
			const old = removed[n] ?? null,
				next = added[n] ?? null;
			if (old && next) {
				const spans = wordSpans(old.text, next.text);
				old.spans = spans.old;
				next.spans = spans.new;
			}
			pairs.push({ old, new: next });
		}
	}
	return { lines, pairs };
}
/**
 * Editor gutter hunks (spec/editor#change-marks): line runs of `after` against `before`, no word spans. Lines are compared without their
 * endings (CRLF reads as LF), so numbers match the editor's lines. `start` is the first changed line of `after`; a pure
 * deletion has `count` 0 and `start` the line above it (0 at the top). Removed text is kept for the peek, bounded.
 */
export function lineHunks(before: string, after: string, keep = 200): GutterHunk[] {
	// An empty text has no lines, so a new file reads as added, not as a changed first line.
	const split = (text: string) => (text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n'));
	const edits = sequenceDiff(split(before), split(after), 250000, myersWork),
		hunks: GutterHunk[] = [];
	let line = 0,
		old = 0,
		kept = 0;
	for (let i = 0; i < edits.length;) {
		if (edits[i]!.kind === 'context') {
			line++;
			old++;
			i++;
			continue;
		}
		const hunk: GutterHunk = { start: line, count: 0, oldStart: old, removed: [], removedCount: 0 };
		while (i < edits.length && edits[i]!.kind !== 'context') {
			const edit = edits[i++]!;
			if (edit.kind === 'added') {
				if (!hunk.count) hunk.start = line + 1;
				hunk.count++;
				line++;
			} else {
				if (!hunk.removedCount) hunk.oldStart = old + 1;
				old++;
				hunk.removedCount++;
				if (hunk.removed.length < keep && kept < keep * 10) {
					hunk.removed.push(edit.value);
					kept++;
				}
			}
		}
		hunks.push(hunk);
	}
	return hunks;
}
/**
 * Unified hunks with `context` lines around changes, cut at `limit` UTF-16 units: what an agent reads instead of two
 * full texts (perf review MCP-02). Line numbers are in the hunk headers, as in `git diff`.
 */
export function unifiedDiff(
	lines: readonly DiffLine[],
	context = 3,
	limit = 64 * 1024
): { text: string; truncated: boolean } {
	const changes: number[] = [];
	lines.forEach((line, index) => {
		if (line.kind !== 'context') changes.push(index);
	});
	const hunks: [number, number][] = [];
	for (const index of changes) {
		const last = hunks.at(-1);
		if (last && index - last[1] <= 2 * context + 1) last[1] = index;
		else hunks.push([index, index]);
	}
	const out: string[] = [];
	let size = 0;
	for (const [first, last] of hunks) {
		const hunk = lines.slice(
			Math.max(0, first - context),
			Math.min(lines.length, last + context + 1)
		);
		const header = `@@ -${hunk.find((line) => line.oldLine !== null)?.oldLine ?? 0},${hunk.filter((line) => line.kind !== 'added').length} +${hunk.find((line) => line.newLine !== null)?.newLine ?? 0},${hunk.filter((line) => line.kind !== 'removed').length} @@`;
		for (const text of [
			header,
			...hunk.map(
				(line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`
			),
		]) {
			if (size + text.length + 1 > limit) return { text: out.join('\n'), truncated: true };
			out.push(text);
			size += text.length + 1;
		}
	}
	return { text: out.join('\n'), truncated: false };
}
export * from './anchors';
export * from './merge3';
export * from './plan-diff';
