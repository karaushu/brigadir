import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Scope } from '@brigadir/core';
import { findPRDefinition } from './pr-definition';
import { Syntax } from './syntax';

let root = '',
	tree = '',
	scope: Scope;
const syntax = new Syntax(resolve('apps/desktop/out/services/syntax.cjs'));
const declarations = (language: string, texts: string[], name: string) =>
	syntax.declarations(language, texts, name);
const files: Record<string, string> = {
	'src/cart/Cart.tsx':
		"import { formatPrice } from '../money/format';\nexport function Cart() {\n  return formatPrice(total(1));\n}\nfunction total(n: number) { return n; }\n",
	'src/money/format.ts':
		'export function formatPrice(value: number) {\n  return `${value} ₴`;\n}\n',
	'src/legacy/format.js':
		'function formatPrice(v) { return v; }\nmodule.exports = { formatPrice };\n',
	'src/util/round.ts': 'export const round = (n: number) => Math.round(n);\n',
	'docs/notes.md': 'formatPrice is documented here\n',
};
beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-pr-definition-')));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	const run = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
	run('init', '-q');
	run('add', '.');
	run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
	tree = run('rev-parse', 'HEAD^{tree}');
	scope = { id: 'root', name: 'demo', path: root, kind: 'root' } as Scope;
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
const click = (path: string, line: number, word: string, changed: string[] = []) => {
	const text = files[path]!.split('\n')[line - 1]!;
	return findPRDefinition({
		scope,
		tree,
		path,
		line,
		column: text.indexOf(word) + 2,
		text,
		changed: new Set(changed),
		declarations,
	});
};

it('finds a declaration in the same file first, nearest above or below (spec/pull-requests-and-ci#pr-definition)', async () => {
	expect(await click('src/cart/Cart.tsx', 3, 'total')).toEqual({
		state: 'found',
		word: 'total',
		truncated: false,
		places: [
			{
				path: 'src/cart/Cart.tsx',
				line: 5,
				column: 10,
				preview: 'function total(n: number) { return n; }',
				changed: false,
			},
		],
	});
});

it('searches the whole head tree, files of the PR first, only the script family (spec/pull-requests-and-ci#pr-definition)', async () => {
	const answer = await click('src/cart/Cart.tsx', 3, 'formatPrice', ['src/legacy/format.js']);
	expect(answer.state).toBe('found');
	if (answer.state !== 'found') return;
	expect(answer.places.map((place) => [place.path, place.line, place.changed])).toEqual([
		['src/legacy/format.js', 1, true],
		['src/money/format.ts', 1, false],
	]);
	expect(answer.places[1]!.preview).toBe('export function formatPrice(value: number) {');
});

it('answers stale when the clicked line no longer matches the head blob, and nothing for an unknown name', async () => {
	expect(
		await findPRDefinition({
			scope,
			tree,
			path: 'src/cart/Cart.tsx',
			line: 3,
			column: 10,
			text: '  return somethingElse();',
			changed: new Set(),
			declarations,
		})
	).toEqual({ state: 'stale' });
	expect(
		await findPRDefinition({
			scope,
			tree,
			path: 'src/gone.ts',
			line: 1,
			column: 1,
			text: 'x',
			changed: new Set(),
			declarations,
		})
	).toEqual({ state: 'stale' });
	expect(await click('src/util/round.ts', 1, 'Math')).toEqual({
		state: 'found',
		word: 'Math',
		places: [],
		truncated: false,
	});
});

it('a click on the declaration itself answers with it', async () => {
	const answer = await click('src/money/format.ts', 1, 'formatPrice');
	expect(answer.state === 'found' && answer.places[0]).toMatchObject({
		path: 'src/legacy/format.js',
	});
	const own = await click('src/util/round.ts', 1, 'round');
	expect(own.state === 'found' && own.places).toEqual([
		{
			path: 'src/util/round.ts',
			line: 1,
			column: 14,
			preview: 'export const round = (n: number) => Math.round(n);',
			changed: false,
		},
	]);
});
