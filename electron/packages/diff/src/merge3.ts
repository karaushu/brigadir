import { myersWork, sequenceDiff } from './index';

/**
 * spec/appearance#evolution-redesign, spec/git#conflicts: the model of the manual merge in three columns — `Yours · <branch>` | `Result` | `Theirs`.
 * The base and both sides are split into lines; a chunk is a run of base lines that one side or both changed. Changes of
 * both sides that touch or overlap are one chunk: a conflict when the two texts differ, a common change when they agree
 * (git conflicts on adjacent lines too). The Result is the base with each chunk replaced by what the person picked.
 */
export type MergeSide = 'ours' | 'theirs';
export type MergeChunkKind = 'conflict' | 'ours' | 'theirs' | 'same';
/** Lines `[start, end)`, zero-based. */
export type LineRange = { start: number; end: number };
export type MergeChunk = {
	kind: MergeChunkKind;
	base: LineRange;
	ours: LineRange;
	theirs: LineRange;
};
export type Merge3 = { base: string[]; ours: string[]; theirs: string[]; chunks: MergeChunk[] };
/**
 * What the person did with a chunk. `taken` — sides in the order they went into the Result (`»` then `«+` is ours then
 * theirs); `ignored` — sides dismissed with ✕; `edited` — typed by hand inside the chunk; `agent` — the agent's text
 * fills it (✦) until the person changes it.
 */
export type ChunkPick = {
	taken: MergeSide[];
	ignored: MergeSide[];
	edited?: boolean;
	agent?: boolean;
};
/** Why the agent's text is what it is, read from the text itself: which sides it equals. */
export type AgentChoice = 'ours' | 'theirs' | 'both' | 'base' | 'own';

/** Lines of a file as the merge view shows them: LF, the final newline ends the last line rather than adding one. */
export function mergeLines(text: string): string[] {
	const normal = text.replace(/\r\n/g, '\n');
	if (!normal) return [];
	return (normal.endsWith('\n') ? normal.slice(0, -1) : normal).split('\n');
}
/** The text of merge lines; `newline` — whether the file ends with one (the side the person keeps decides). */
export function mergeText(lines: readonly string[], newline = true): string {
	return lines.length ? lines.join('\n') + (newline ? '\n' : '') : '';
}

type Hunk = { a0: number; a1: number; b0: number; b1: number };
function hunks(a: string[], b: string[]): Hunk[] {
	const out: Hunk[] = [];
	let i = 0,
		j = 0,
		current: Hunk | null = null;
	for (const edit of sequenceDiff(a, b, 250000, myersWork)) {
		if (edit.kind === 'context') {
			if (current) out.push(current);
			current = null;
			i++;
			j++;
			continue;
		}
		current ??= { a0: i, a1: i, b0: j, b1: j };
		if (edit.kind === 'removed') current.a1 = ++i;
		else current.b1 = ++j;
	}
	if (current) out.push(current);
	return out;
}
const same = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((line, index) => line === b[index]);
const slice = (lines: readonly string[], range: LineRange) => lines.slice(range.start, range.end);
const delta = (hunk: Hunk) => hunk.b1 - hunk.b0 - (hunk.a1 - hunk.a0);

export function merge3(base: string[], ours: string[], theirs: string[]): Merge3 {
	const tagged = [
		...hunks(base, ours).map((hunk) => ({ ...hunk, side: 'ours' as const })),
		...hunks(base, theirs).map((hunk) => ({ ...hunk, side: 'theirs' as const })),
	].sort((x, y) => x.a0 - y.a0 || x.a1 - y.a1);
	const chunks: MergeChunk[] = [];
	let shift = { ours: 0, theirs: 0 };
	for (let index = 0; index < tagged.length;) {
		const group = [tagged[index++]!];
		let end = group[0]!.a1;
		// Touching counts: two changes with no unchanged line between them are one place, as in git.
		while (index < tagged.length && tagged[index]!.a0 <= end) {
			const next = tagged[index++]!;
			group.push(next);
			end = Math.max(end, next.a1);
		}
		const start = group[0]!.a0,
			sides = new Set(group.map((hunk) => hunk.side));
		const range = (side: MergeSide): LineRange => {
			const grown = group
				.filter((hunk) => hunk.side === side)
				.reduce((sum, h) => sum + delta(h), 0);
			return { start: start + shift[side], end: end + shift[side] + grown };
		};
		const chunk: MergeChunk = {
			kind: 'conflict',
			base: { start, end },
			ours: range('ours'),
			theirs: range('theirs'),
		};
		chunk.kind =
			sides.size === 1
				? sides.has('ours')
					? 'ours'
					: 'theirs'
				: same(slice(ours, chunk.ours), slice(theirs, chunk.theirs))
					? 'same'
					: 'conflict';
		shift = {
			ours: chunk.ours.end - end,
			theirs: chunk.theirs.end - end,
		};
		chunks.push(chunk);
	}
	return { base, ours, theirs, chunks };
}

/** The sides that changed something in the chunk: the ones that get » or «. */
export function chunkSides(chunk: MergeChunk): MergeSide[] {
	return chunk.kind === 'ours'
		? ['ours']
		: chunk.kind === 'theirs'
			? ['theirs']
			: ['ours', 'theirs'];
}
/** A conflict is resolved once a side went in, both were dismissed, or the person or the agent wrote it; a change that
 *  does not conflict — once applied or dismissed. */
export function isResolved(chunk: MergeChunk, pick: ChunkPick): boolean {
	if (pick.edited || pick.agent) return true;
	if (chunk.kind === 'conflict') return pick.taken.length > 0 || pick.ignored.length === 2;
	return pick.taken.length > 0 || pick.ignored.length > 0;
}
/** The lines a chunk puts in the Result. */
export function chunkLines(merge: Merge3, chunk: MergeChunk, pick: ChunkPick): string[] {
	if (!pick.taken.length) return slice(merge.base, chunk.base);
	if (chunk.kind === 'same') return slice(merge.ours, chunk.ours);
	return pick.taken.flatMap((side) => slice(merge[side], chunk[side]));
}
/** Fresh picks: conflicts open; with `apply`, each change that does not conflict is already in the Result. */
export function initialPicks(merge: Merge3, apply: boolean): ChunkPick[] {
	return merge.chunks.map((chunk) =>
		apply && chunk.kind !== 'conflict'
			? { taken: [chunk.kind === 'theirs' ? 'theirs' : 'ours'], ignored: [] }
			: { taken: [], ignored: [] }
	);
}
/** `Apply non-conflicting changes` on or off: changes the person typed or the agent wrote stay. */
export function applyNonConflicting(
	merge: Merge3,
	picks: ChunkPick[],
	apply: boolean
): ChunkPick[] {
	return merge.chunks.map((chunk, index) => {
		const pick = picks[index]!;
		if (chunk.kind === 'conflict' || pick.edited || pick.agent) return pick;
		return apply
			? { taken: [chunk.kind === 'theirs' ? 'theirs' : 'ours'], ignored: [] }
			: { taken: [], ignored: [] };
	});
}
/** » / « — the side goes in; after the other side it is added below it (`«+`, both). */
export function takeSide(pick: ChunkPick, side: MergeSide): ChunkPick {
	if (pick.taken.includes(side) && !pick.edited && !pick.agent) return pick;
	const taken = pick.edited || pick.agent ? [] : pick.taken;
	return { taken: [...taken, side], ignored: pick.ignored.filter((item) => item !== side) };
}
/** ✕ — the side is dismissed; what it had put in the Result goes. */
export function ignoreSide(pick: ChunkPick, side: MergeSide): ChunkPick {
	return {
		taken: pick.edited || pick.agent ? [] : pick.taken.filter((item) => item !== side),
		ignored: [...new Set([...pick.ignored, side])],
	};
}
/** `Accept both` — yours, then theirs. */
export function acceptBoth(chunk: MergeChunk): ChunkPick {
	return { taken: chunk.kind === 'same' ? ['ours'] : ['ours', 'theirs'], ignored: [] };
}
/** The whole Result: the base with each chunk replaced, and where each chunk stands in it. */
export function assemble(
	merge: Merge3,
	picks: ChunkPick[]
): { lines: string[]; ranges: LineRange[] } {
	const lines: string[] = [],
		ranges: LineRange[] = [];
	let at = 0;
	merge.chunks.forEach((chunk, index) => {
		lines.push(...merge.base.slice(at, chunk.base.start));
		const start = lines.length;
		lines.push(...chunkLines(merge, chunk, picks[index]!));
		ranges.push({ start, end: lines.length });
		at = chunk.base.end;
	});
	lines.push(...merge.base.slice(at));
	return { lines, ranges };
}
export function conflictsLeft(merge: Merge3, picks: ChunkPick[]): number {
	return merge.chunks.filter(
		(chunk, index) => chunk.kind === 'conflict' && !isResolved(chunk, picks[index]!)
	).length;
}
export function changesApplied(merge: Merge3, picks: ChunkPick[]): number {
	return merge.chunks.filter(
		(chunk, index) => chunk.kind !== 'conflict' && picks[index]!.taken.length > 0
	).length;
}

/** Where a base line boundary stands in a text derived from the base: a boundary inside a change grows to cover it. */
function mapBoundary(changes: Hunk[], at: number, edge: 'start' | 'end'): number {
	let shift = 0;
	for (const hunk of changes) {
		const before =
			edge === 'start' ? hunk.a1 < at || (hunk.a1 === at && hunk.a0 < at) : hunk.a1 < at;
		if (before) {
			shift += delta(hunk);
			continue;
		}
		if (edge === 'start' ? hunk.a0 <= at : hunk.a0 < at || (hunk.a0 === at && hunk.a1 === at))
			return edge === 'start' ? hunk.b0 : hunk.b1;
		break;
	}
	return at + shift;
}
/**
 * The agent's text in the merge view (spec/appearance#evolution-redesign): each chunk is where the agent's text covers its base lines; every
 * conflict is the agent's (✦), and a change that does not conflict is taken when the text kept it.
 */
export function fromResult(
	merge: Merge3,
	result: string[]
): { picks: ChunkPick[]; ranges: LineRange[]; choices: AgentChoice[] } {
	const changes = hunks(merge.base, result);
	const ranges = merge.chunks.map((chunk) => ({
		start: mapBoundary(changes, chunk.base.start, 'start'),
		end: mapBoundary(changes, chunk.base.end, 'end'),
	}));
	for (let i = 1; i < ranges.length; i++)
		if (ranges[i]!.start < ranges[i - 1]!.end) ranges[i]!.start = ranges[i - 1]!.end;
	const choices: AgentChoice[] = [],
		picks: ChunkPick[] = [];
	merge.chunks.forEach((chunk, index) => {
		const text = slice(result, ranges[index]!),
			ours = slice(merge.ours, chunk.ours),
			theirs = slice(merge.theirs, chunk.theirs);
		const choice: AgentChoice = same(text, ours)
			? chunk.kind === 'theirs'
				? 'base'
				: 'ours'
			: same(text, theirs)
				? chunk.kind === 'ours'
					? 'base'
					: 'theirs'
				: same(text, [...ours, ...theirs])
					? 'both'
					: same(text, slice(merge.base, chunk.base))
						? 'base'
						: 'own';
		choices.push(choice);
		if (chunk.kind !== 'conflict' && (choice === 'ours' || choice === 'theirs'))
			picks.push({ taken: [choice], ignored: [] });
		else if (chunk.kind !== 'conflict' && choice === 'base') picks.push({ taken: [], ignored: [] });
		else picks.push({ taken: [], ignored: [], agent: true });
	});
	return { picks, ranges, choices };
}
