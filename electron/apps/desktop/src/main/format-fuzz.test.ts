import { expect, it } from 'vitest';
import { formatEdits } from './format';
const words = ['a', 'b', '  c', '', '\t d', '😀x', 'é', 'foo(', ')', '{', '}', 'x;'];
function random(seed: number) {
	let s = seed;
	return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
function make(rand: () => number) {
	const lines = Array.from(
		{ length: Math.floor(rand() * 9) },
		() => words[Math.floor(rand() * words.length)]!
	);
	return lines.join('\n') + (rand() < 0.5 ? '\n' : '');
}
function apply(text: string, edits: ReturnType<typeof formatEdits>) {
	let out = '',
		at = 0;
	for (const edit of edits) {
		expect(edit.from).toBeGreaterThanOrEqual(at);
		expect(edit.to).toBeGreaterThanOrEqual(edit.from);
		out += text.slice(at, edit.from) + edit.insert;
		at = edit.to;
	}
	return out + text.slice(at);
}
it('formatEdits turns before into after for random documents', () => {
	const rand = random(7);
	for (let i = 0; i < 3000; i++) {
		const before = make(rand),
			after = make(rand);
		expect(apply(before, formatEdits(before, after)), JSON.stringify({ before, after })).toBe(
			after
		);
	}
});
