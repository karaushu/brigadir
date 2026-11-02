import type { DiffLine } from './changes';
import { isRecord } from './workspace';

export type AttributionRange = { start: number; end: number };
export type DeltaHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number };
export function isAttributionRange(value: unknown): value is AttributionRange {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.start) &&
		Number.isSafeInteger(value.end) &&
		Number(value.start) > 0 &&
		Number(value.end) >= Number(value.start) &&
		Number(value.end) <= 100001 &&
		Number(value.end) - Number(value.start) < 5000 &&
		Object.keys(value).every((key) => key === 'start' || key === 'end')
	);
}
export function patchHunks(patch: string): DeltaHunk[] {
	return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	}));
}
/** Only unchanged text can be followed exactly across a rewrite. */
export function traceAttributionRange(
	range: AttributionRange,
	hunks: DeltaHunk[]
): { hit: boolean; previous: AttributionRange | null } {
	let offset = 0;
	for (const hunk of hunks) {
		const start = hunk.newCount ? hunk.newStart : hunk.newStart + 1;
		const end = hunk.newCount ? start + hunk.newCount - 1 : start;
		if (start <= range.end && end >= range.start) return { hit: true, previous: null };
		if (end < range.start) offset += hunk.oldCount - hunk.newCount;
	}
	return { hit: false, previous: { start: range.start + offset, end: range.end + offset } };
}
/** Removed rows ask about their whole replacement hunk, or its deletion point. */
export function attributionRangeForLine(
	lines: DiffLine[],
	side: 'old' | 'new',
	number: number
): AttributionRange | null {
	if (side === 'new') return { start: number, end: number };
	const index = lines.findIndex((line) => line.oldLine === number);
	if (index < 0) return null;
	const line = lines[index]!;
	if (line.newLine !== null) return { start: line.newLine, end: line.newLine };
	let start = index,
		end = index;
	while (start > 0 && lines[start - 1]!.kind !== 'context') start--;
	while (end + 1 < lines.length && lines[end + 1]!.kind !== 'context') end++;
	const numbers = lines
		.slice(start, end + 1)
		.flatMap((line) => (line.newLine === null ? [] : [line.newLine]));
	if (numbers.length) return { start: numbers[0]!, end: numbers.at(-1)! };
	const point = lines[end + 1]?.newLine ?? (lines[start - 1]?.newLine ?? 0) + 1;
	return { start: point, end: point };
}
