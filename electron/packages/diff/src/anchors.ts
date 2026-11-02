import type { Anchor, AnchorPosition } from '@brigadir/core';
export const normalizeLine = (line: string) => line.trim().replace(/\s+/g, ' ');
export const textLines = (text: string) =>
	text.match(/[^\n]*\n|[^\n]+$/g)?.map((line) => line.replace(/\r?\n$/, '')) ?? [];
export function anchorContext(text: string, start: number, end: number) {
	const lines = textLines(text);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 1 ||
		end < start ||
		end > lines.length ||
		end - start >= 100
	)
		throw new Error('Invalid line range');
	return {
		quote: lines.slice(start - 1, end),
		before: lines.slice(Math.max(0, start - 3), start - 1).map(normalizeLine),
		after: lines.slice(end, end + 2).map(normalizeLine),
	};
}
/** A linear pattern search avoids repeatedly scanning large selections for each file line. */
function matches(lines: string[], pattern: string[]): number[] {
	if (!pattern.length) return [];
	const prefix = new Uint32Array(pattern.length);
	for (let i = 1, k = 0; i < pattern.length; i++) {
		while (k && pattern[i] !== pattern[k]) k = prefix[k - 1]!;
		if (pattern[i] === pattern[k]) k++;
		prefix[i] = k;
	}
	const result: number[] = [];
	for (let i = 0, k = 0; i < lines.length; i++) {
		while (k && lines[i] !== pattern[k]) k = prefix[k - 1]!;
		if (lines[i] === pattern[k]) k++;
		if (k === pattern.length) {
			result.push(i - k + 1);
			k = prefix[k - 1]!;
		}
	}
	return result;
}
export function reanchor(
	anchor: Anchor,
	blob: string | null,
	text: string,
	normalizedLines?: string[]
): AnchorPosition {
	if (blob === anchor.blob) return { state: 'exact', start: anchor.start, end: anchor.end };
	if (!blob) return { state: 'outdated', start: null, end: null };
	const lines = normalizedLines ?? textLines(text).map(normalizeLine),
		quote = anchor.quote.map(normalizeLine);
	const pattern = [...anchor.before, ...quote, ...anchor.after];
	const found = matches(lines, pattern);
	if (found.length !== 1) return { state: 'outdated', start: null, end: null };
	const start = found[0]! + anchor.before.length + 1;
	return { state: 'relocated', start, end: start + quote.length - 1 };
}
