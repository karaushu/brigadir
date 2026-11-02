import { expect, it } from 'vitest';
import { bufferToDisk } from '@brigadir/core';
import { lineHunks } from './index';
const words = ['a', 'b', 'c', '', 'd', 'e'];
function random(seed: number) {
	let s = seed;
	return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
// An empty text has no lines (lineHunks and the blame map agree), so [''] is the same text as [].
const make = (rand: () => number) => {
	const lines = Array.from(
		{ length: Math.floor(rand() * 10) },
		() => words[Math.floor(rand() * words.length)]!
	);
	return lines.length === 1 && lines[0] === '' ? [] : lines;
};
it('gutter hunks rebuild the base from the buffer and map unchanged lines back to the disk', () => {
	const rand = random(11);
	for (let i = 0; i < 3000; i++) {
		const before = make(rand),
			after = make(rand),
			hunks = lineHunks(before.join('\n'), after.join('\n'));
		const label = JSON.stringify({ before, after, hunks });
		// The base again: untouched buffer lines plus each hunk's removed lines in place of its added ones.
		const rebuilt: string[] = [];
		let line = 1;
		for (const hunk of hunks) {
			const first = hunk.count ? hunk.start : hunk.start + 1;
			while (line < first) rebuilt.push(after[line++ - 1]!);
			line += hunk.count;
			rebuilt.push(...hunk.removed);
		}
		while (line <= after.length) rebuilt.push(after[line++ - 1]!);
		const base = before;
		expect(rebuilt, label).toEqual(base);
		const map = bufferToDisk(hunks, after.length);
		map.forEach((disk, index) => {
			if (disk !== 0) expect(base[disk - 1], label).toBe(after[index]);
		});
	}
});
