import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { diffable, diffLines, lineHunks, wordSpans } from './index';
it('aligns unequal replacements and numbers both sides without inventing text', () => {
	const diff = diffLines('one\ntwo\nthree\nend\n', 'one\nTWO\nend\n');
	expect(diff.pairs.map((p) => [p.old?.oldLine ?? null, p.new?.newLine ?? null])).toEqual([
		[1, 1],
		[2, 2],
		[3, null],
		[4, 3],
	]);
	expect(diff.lines.filter((l) => l.kind !== 'added').map((l) => l.text)).toEqual([
		'one',
		'two',
		'three',
		'end',
	]);
	expect(diff.lines.filter((l) => l.kind !== 'removed').map((l) => l.text)).toEqual([
		'one',
		'TWO',
		'end',
	]);
});
it('preserves duplicate lines, Unicode words, empty files and newline-only changes', () => {
	const spans = wordSpans('Привіт, світ!', 'Привіт, друже!');
	const changed = (text: string, ends: number[]) =>
		ends
			.map((end, i) => (end & 1 ? text.slice(i ? ends[i - 1]! >>> 1 : 0, end >>> 1) : ''))
			.join('');
	expect(changed('Привіт, світ!', spans.old)).toBe('світ');
	expect(changed('Привіт, друже!', spans.new)).toBe('друже');
	expect(spans.old).toEqual([12, 14, 16, 25, 26]);
	expect(wordSpans('x'.repeat(20001), '')).toEqual({ old: [40003], new: [1] });
	expect(diffLines('', '').lines).toEqual([]);
	expect(diffLines('line', 'line\n').lines.map((l) => l.kind)).toEqual(['removed', 'added']);
	for (let n = 0; n < 80; n++) {
		const a = Array.from({ length: n }, (_, i) => String((i * 7 + n) % 11));
		const b = [...a];
		b.splice(Math.floor(n / 2), n % 5, 'new', 'new');
		const diff = diffLines(a.join('\n'), b.join('\n'));
		expect(
			diff.lines
				.filter((l) => l.kind !== 'added')
				.map((l) => l.text)
				.join('\n')
		).toBe(a.join('\n'));
		expect(
			diff.lines
				.filter((l) => l.kind !== 'removed')
				.map((l) => l.text)
				.join('\n')
		).toBe(b.join('\n'));
	}
});
it('bounds repeated-line fallback and computes 10,000-line edits promptly', () => {
	const start = performance.now();
	const a = Array.from({ length: 10000 }, (_, i) => `line ${i}\n`).join('');
	expect(diffLines(a, a.replace('line 5000\n', 'changed\n')).pairs).toHaveLength(10000);
	expect(diffLines('a\n'.repeat(10000), 'b\n'.repeat(10000)).pairs).toHaveLength(10000);
	expect(performance.now() - start).toBeLessThan(1000);
});
// DIFF-04: gaps without patience anchors and over the LCS budget go through bounded Myers instead of a full replacement.
const minimal = (a: string[], b: string[]) => {
	const width = b.length + 1,
		dp = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			dp[i * width + j] =
				a[i] === b[j]
					? dp[(i + 1) * width + j + 1]! + 1
					: Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
	return a.length + b.length - 2 * dp[0]!;
};
const sides = (diff: ReturnType<typeof diffLines>) => [
	diff.lines
		.filter((l) => l.kind !== 'added')
		.map((l) => l.text)
		.join('\n'),
	diff.lines
		.filter((l) => l.kind !== 'removed')
		.map((l) => l.text)
		.join('\n'),
];
const random = (seed: number) => () =>
	(seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
it('keeps a few edits in a repeated-row CSV as a few edits', () => {
	const rows = Array.from({ length: 20000 }, (_, i) => `${i % 50},alpha,${(i * 7) % 13},beta`),
		edited = [...rows],
		at = Array.from({ length: 20 }, (_, k) => (k * 7919 + 331) % 20000);
	at.forEach((line, k) => (edited[line] = `edited ${k}`));
	const start = performance.now(),
		diff = diffLines(rows.join('\n') + '\n', edited.join('\n') + '\n');
	expect(diff.lines.filter((l) => l.kind === 'removed').map((l) => l.oldLine)).toEqual(
		at.map((line) => line + 1).sort((x, y) => x - y)
	);
	expect(diff.lines.filter((l) => l.kind === 'added')).toHaveLength(20);
	expect(diff.pairs).toHaveLength(20000);
	expect(performance.now() - start).toBeLessThan(1000);
});
it('finds a minimal diff on repeated lines and orders each change removed-first', () => {
	const next = random(5);
	for (let round = 0; round < 12; round++) {
		const a = Array.from({ length: 520 + round * 7 }, () => String(Math.floor(next() * 4))),
			b = a.flatMap((line) => {
				const r = next();
				return r < 0.04 ? [] : r < 0.08 ? [line, 'x'] : r < 0.12 ? ['y'] : [line];
			});
		const diff = diffLines(a.join('\n') + '\n', b.join('\n') + '\n');
		expect(sides(diff)).toEqual([a.join('\n'), b.join('\n')]);
		expect(diff.lines.filter((l) => l.kind !== 'context').length).toBe(minimal(a, b));
		expect(
			diff.lines.some(
				(l, i) => i > 0 && l.kind === 'removed' && diff.lines[i - 1]!.kind === 'added'
			)
		).toBe(false);
	}
});
it('gives up within the work budget on unrelated repeated lines, as before', () => {
	const next = random(9),
		a = Array.from({ length: 20000 }, () => `${Math.floor(next() * 50)},row`),
		b = Array.from({ length: 20000 }, () => `${Math.floor(next() * 50)},row`);
	const start = performance.now(),
		diff = diffLines(a.join('\n'), b.join('\n'));
	expect(performance.now() - start).toBeLessThan(2000);
	expect(sides(diff)).toEqual([a.join('\n'), b.join('\n')]);
	expect(diff.lines.filter((l) => l.kind === 'context')).toHaveLength(0);
	const plain = Array.from({ length: 8000 }, (_, i) => ((i + 1) % 5 ? `line ${i}` : '')),
		deeper = plain.map((line) => line && '  ' + line);
	expect(
		diffLines(plain.join('\n'), deeper.join('\n')).lines.filter((l) => l.kind === 'context')
	).toHaveLength(0);
});
it('leaves diffs with patience anchors byte-identical to the pre-fallback algorithm', () => {
	const next = random(11),
		code = Array.from({ length: 6000 }, (_, i) =>
			i % 9 === 0
				? ''
				: i % 9 === 8
					? '}'
					: i % 9 === 1
						? `function f${i}(value) {`
						: `  const v${i} = value.map(x => x * ${i % 13});`
		);
	const edited = [...code];
	for (let k = 0; k < 60; k++) {
		const at = Math.floor(next() * edited.length);
		if (k % 3 === 0) edited.splice(at, 1);
		else if (k % 3 === 1) edited.splice(at, 0, `  log(${k});`);
		else edited[at] += ' // edited';
	}
	const moved = [...code];
	moved.splice(4000, 0, ...moved.splice(1000, 300));
	const blank = code.map((line, i) => (i % 4 === 0 ? '' : line)),
		blankEdited = blank.map((line, i) => (i % 500 === 7 ? line + ';' : line));
	const cases = [
		[code.join('\n'), edited.join('\n')],
		[code.join('\n'), moved.join('\n') + '\n'],
		[blank.join('\r\n'), blankEdited.join('\r\n')],
		['a\nb\n'.repeat(200), 'a\nc\n'.repeat(200)],
	] as const;
	// sha256 prefixes of the same inputs through the algorithm before DIFF-04.
	expect(
		cases.map(([a, b]) =>
			createHash('sha256')
				.update(JSON.stringify(diffLines(a, b)))
				.digest('hex')
				.slice(0, 16)
		)
	).toEqual(['7dbdac2e9d419a3d', 'e3254281e82bd1d1', '34728344bdb2f449', 'a8374cc68d9a3f58']);
});
it('formats bounded unified hunks with git-style headers', async () => {
	const { diffLines, unifiedDiff } = await import('./index');
	const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
		after = before.replace('line 5\n', 'line five\n').replace('line 30\n', '');
	const { text, truncated } = unifiedDiff(diffLines(before, after).lines);
	expect(truncated).toBe(false);
	expect(text.split('\n')).toEqual([
		'@@ -2,7 +2,7 @@',
		' line 2',
		' line 3',
		' line 4',
		'-line 5',
		'+line five',
		' line 6',
		' line 7',
		' line 8',
		'@@ -27,7 +27,6 @@',
		' line 27',
		' line 28',
		' line 29',
		'-line 30',
		' line 31',
		' line 32',
		' line 33',
	]);
	expect(unifiedDiff(diffLines(before, after).lines, 3, 40).truncated).toBe(true);
});
it('numbers gutter hunks by editor lines: added, changed and deleted runs, CRLF as LF (spec/editor#change-marks)', () => {
	const before = 'a\r\nb\r\nc\r\nd\r\ne\r\n',
		after = 'a\nB\nc\nnew\nd\n';
	expect(lineHunks(before, after)).toEqual([
		{ start: 2, count: 1, oldStart: 2, removed: ['b'], removedCount: 1 },
		{ start: 4, count: 1, oldStart: 3, removed: [], removedCount: 0 },
		{ start: 5, count: 0, oldStart: 5, removed: ['e'], removedCount: 1 },
	]);
	expect(lineHunks('x\ny\n', 'x\ny\n')).toEqual([]);
	expect(lineHunks('gone\nkeep\n', 'keep\n')).toEqual([
		{ start: 0, count: 0, oldStart: 1, removed: ['gone'], removedCount: 1 },
	]);
	expect(lineHunks('', 'one\ntwo')).toEqual([
		{ start: 1, count: 2, oldStart: 0, removed: [], removedCount: 0 },
	]);
	const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
	const [hunk] = lineHunks(many, '');
	expect(hunk!.removed).toHaveLength(200);
	expect(hunk!.removedCount).toBe(500);
});
it('diffs a hand-written file with an inline SVG path, not a minified line (spec/diff-and-review#file-diff)', () => {
	const svg = `<path d="${'M21.98 1.99C21.72 2 21.47 2.1 21.29 2.29L20.29 3.29'.repeat(120)}" />`;
	expect(svg.length).toBeGreaterThan(5000);
	expect(diffable(`import React from 'react';\n${svg}\nexport default Settings;\n`)).toBe(true);
	expect(diffable(`!function(){${'var a=1;'.repeat(3000)}}();`)).toBe(false);
});
