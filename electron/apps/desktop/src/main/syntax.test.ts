import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { syntaxFencePath } from '@brigadir/core';
import { Syntax } from './syntax';
it('loads packaged WASM in an isolated worker, caches results and rejects unsupported files', async () => {
	const syntax = new Syntax(resolve('apps/desktop/out/services/syntax.cjs'));
	const result = await syntax.read('a.ts', 'function value() { return 42; }');
	expect(result.status).toBe('ready');
	expect(result.symbols[0]?.path).toBe('value');
	expect(await syntax.read('a.ts', 'function value() { return 42; }')).toBe(result);
	expect((await syntax.read('a.unknown', 'text')).status).toBe('plain');
	expect((await syntax.read('a.ts', '\n'.repeat(50001))).status).toBe('large');
	syntax.close();
});
const code = (n: number, tag: string) =>
	Array.from(
		{ length: n },
		(_, i) =>
			`export function ${tag}${i}(value: number): string { return String(value + ${i}); } // ${tag}`
	).join('\n');
it('answers many concurrent requests without a false failure and keeps the open file ahead of answer fences', async () => {
	const syntax = new Syntax(resolve('apps/desktop/out/services/syntax.cjs'));
	// The old single queue of 12 answered 8 of these 20 with `failed`.
	const burst = await Promise.all(
		Array.from({ length: 20 }, (_, i) => syntax.read('a.ts', `const q${i} = ${i};`))
	);
	expect(burst.filter((result) => result.status !== 'ready')).toEqual([]);
	let fences = 0;
	const answer = Array.from({ length: 5 }, (_, i) =>
		syntax.read('a.ts', code(1500, `fence${i}_`), 'code').then((result) => {
			fences++;
			return result;
		})
	);
	const open = await syntax.read('b.ts', code(1500, 'open'));
	expect(open.status).toBe('ready');
	expect(fences).toBeLessThan(3);
	expect((await Promise.all(answer)).every((result) => result.status === 'ready')).toBe(true);
	syntax.close();
});
it('keeps the cache under its token budget as well as 16 entries', async () => {
	const syntax = new Syntax(resolve('apps/desktop/out/services/syntax.cjs'), 1000);
	const first = syntax.read('a.ts', code(60, 'a'));
	expect((await first).tokens.length).toBeGreaterThan(500);
	expect(syntax.read('a.ts', code(60, 'a'))).toBe(first);
	await syntax.read('b.ts', code(60, 'b'));
	expect(syntax.read('a.ts', code(60, 'a'))).not.toBe(first);
	syntax.close();
});
// From e2e code-syntax: an answer's fence and the open file share one grammar and one result.
it('colours a ```typescript fence of an answer exactly as the same text in the editor; an unknown label stays plain', async () => {
	const syntax = new Syntax(resolve('apps/desktop/out/services/syntax.cjs'));
	const text = 'export const count = 1;\n';
	const fence = await syntax.read(syntaxFencePath('typescript'), text, 'code'),
		editor = await syntax.read('src/example.ts', text);
	expect(fence.status).toBe('ready');
	expect(fence.tokens.length).toBeGreaterThan(0);
	expect(fence.tokens).toEqual(editor.tokens);
	const unknown = await syntax.read(syntaxFencePath('unknown'), '<raw> stays literal\n', 'code');
	expect(unknown.status).toBe('plain');
	syntax.close();
});
