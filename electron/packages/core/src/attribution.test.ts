import { expect, it } from 'vitest';
import {
	attributionRangeForLine,
	isAttributionRange,
	patchHunks,
	traceAttributionRange,
} from './attribution';
it('traces unchanged lines through insertions and stops exact lineage at a rewrite', () => {
	const hunks = patchHunks(
		'@@ -0,0 +1,2 @@\n+header\n+header2\n@@ -8 +10 @@ function\n-old\n+new\n'
	);
	expect(traceAttributionRange({ start: 9, end: 9 }, hunks)).toEqual({
		hit: false,
		previous: { start: 7, end: 7 },
	});
	expect(traceAttributionRange({ start: 10, end: 10 }, hunks)).toEqual({
		hit: true,
		previous: null,
	});
	expect(traceAttributionRange({ start: 11, end: 13 }, hunks)).toEqual({
		hit: false,
		previous: { start: 9, end: 11 },
	});
	expect(traceAttributionRange({ start: 1, end: 1 }, hunks)).toEqual({ hit: true, previous: null });
});
it('keeps deletion-only changes at their new-side point, including an empty file', () => {
	expect(traceAttributionRange({ start: 3, end: 3 }, patchHunks('@@ -3,2 +2,0 @@'))).toEqual({
		hit: true,
		previous: null,
	});
	expect(traceAttributionRange({ start: 4, end: 4 }, patchHunks('@@ -3,2 +2,0 @@'))).toEqual({
		hit: false,
		previous: { start: 6, end: 6 },
	});
	expect(
		attributionRangeForLine(
			[{ kind: 'removed', oldLine: 1, newLine: null, text: 'gone' }],
			'old',
			1
		)
	).toEqual({ start: 1, end: 1 });
	expect(
		attributionRangeForLine(
			[
				{ kind: 'removed', oldLine: 1, newLine: null, text: 'old' },
				{ kind: 'added', oldLine: null, newLine: 1, text: 'new' },
				{ kind: 'added', oldLine: null, newLine: 2, text: 'more' },
			],
			'old',
			1
		)
	).toEqual({ start: 1, end: 2 });
});
it('rejects unbounded, reversed, fractional and extra-field ranges', () => {
	expect(isAttributionRange({ start: 1, end: 5000 })).toBe(true);
	for (const range of [
		{ start: 0, end: 1 },
		{ start: 2, end: 1 },
		{ start: 1.5, end: 2 },
		{ start: 1, end: 5001 },
		{ start: 1, end: 100002 },
		{ start: 1, end: 2, path: '/tmp/file' },
	])
		expect(isAttributionRange(range)).toBe(false);
});
