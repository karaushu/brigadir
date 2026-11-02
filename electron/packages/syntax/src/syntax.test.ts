import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { analyze, declarations } from './index';
const assets = resolve('apps/desktop/out/services/syntax-assets');
it('finds declarations by name for the code-intelligence fallback, not imports or uses', async () => {
	const ts =
		'import { LIMIT } from "./a";\nexport const LIMIT = 3;\nfunction run() { return LIMIT; }\nclass Box { LIMIT = 1; }\n';
	expect(
		(await declarations('typescript', [ts], 'LIMIT', assets)).map(
			(found) =>
				ts.slice(found.from, found.from + 5) + '@' + ts.slice(0, found.from).split('\n').length
		)
	).toEqual(['LIMIT@2', 'LIMIT@4']);
	const py = 'MAX = 3\ndef helper():\n    return MAX\nclass Tool:\n    def helper(self): pass\n';
	expect(
		(await declarations('python', ['x = 1', py], 'helper', assets)).map((found) => [
			found.index,
			py.slice(0, found.from).split('\n').length,
		])
	).toEqual([
		[1, 2],
		[1, 5],
	]);
	expect((await declarations('python', [py], 'MAX', assets)).length).toBe(1);
	const go = 'package main\nconst Limit = 3\nfunc Run() int { return Limit }\n';
	expect((await declarations('go', [go], 'Limit', assets)).map((found) => found.from)).toEqual([
		go.indexOf('Limit'),
	]);
});
it('uses matched WASM grammars for tokens and nested declarations with UTF-16 offsets', async () => {
	const text = '// 🧱 привіт\nexport class Box {\n  value() { return "hello"; }\n}\n';
	const result = await analyze('file.ts', text, assets);
	expect(result.status).toBe('ready');
	expect(result.tokens.map((t) => [text.slice(t.from, t.to), t.kind])).toContainEqual([
		'return',
		'keyword',
	]);
	expect(result.tokens.map((t) => [text.slice(t.from, t.to), t.kind])).toContainEqual([
		'"hello"',
		'string',
	]);
	expect(result.symbols.map((s) => s.path)).toEqual(['Box', 'Box > value']);
	expect(text.slice(result.symbols[1]!.from, result.symbols[1]!.to)).toBe(
		'value() { return "hello"; }'
	);
});
it('handles JSX, CSS and Python with explicit fallback and bounds', async () => {
	for (const [path, text, symbol] of [
		['file.jsx', 'function View() { return <div title="ok"/>; }', 'View'],
		['file.tsx', 'const View = () => <div/>;', 'View'],
		['file.css', '.card { color: red; }', '.card'],
		['file.py', 'class Box:\n  def value(self):\n    return "ok"\n', 'Box > value'],
	]) {
		const result = await analyze(path!, text!, assets);
		expect(result.status).toBe('ready');
		expect(result.symbols.map((s) => s.path)).toContain(symbol);
	}
	expect((await analyze('file.txt', 'text', assets)).status).toBe('plain');
	expect((await analyze('file.ts', '\n'.repeat(50001), assets)).status).toBe('large');
});
it('loads the additional shipped grammars without network access', async () => {
	for (const [path, text] of [
		['run.sh', 'echo "hello"'],
		['run.rs', 'fn run() { return; }'],
		['run.go', 'package main\nfunc run() {}'],
		['run.rb', 'def run\n  "hello"\nend'],
		['Run.java', 'class Run { void run() {} }'],
		['run.cpp', 'int run() { return 1; }'],
		['Run.cs', 'class Run { void run() {} }'],
		['run.php', '<?php function run() { return 1; }'],
		['run.ini', '[section]\nkey=value'],
		['run.ps1', 'function Run { Write-Host "hello" }'],
	]) {
		expect((await analyze(path!, text!, assets)).status, path).toBe('ready');
	}
});
it('highlights a 12k-line file past the old 20k-token cap and gives up on 150k tokens (SYN-02)', async () => {
	const code = Array.from(
		{ length: 12000 },
		(_, i) => `export const value${i} = compute(${i}, "text");`
	).join('\n');
	const result = await analyze('big.js', code, assets);
	expect(result.status).toBe('ready');
	expect(result.tokens.length).toBeGreaterThan(20000);
	expect(
		(
			await analyze(
				'dense.js',
				Array.from(
					{ length: 20000 },
					(_, i) => `[${i}, ${i}, ${i}, ${i}, "a", "b", "c", "d"],`
				).join('\n'),
				assets
			)
		).status
	).toBe('large');
});
const kinds = async (path: string, text: string) => {
	const result = await analyze(path, text, assets);
	expect(result.status).toBe('ready');
	return result.tokens.map((t) => [text.slice(t.from, t.to), t.kind]);
};
it('highlights this, super and literal nodes as keywords in TS and TSX (spec/editor-code-intelligence#font-styles)', async () => {
	const ts =
		'class Box extends Base {\n  run() { super.run(); return this.x ?? null ?? undefined ?? true ?? false; }\n}\n';
	const tokens = await kinds('file.ts', ts);
	for (const word of ['this', 'super', 'null', 'undefined', 'true', 'false'])
		expect(tokens, word).toContainEqual([word, 'keyword']);
	const tsx = 'const View = () => <div hidden={false} title={this ? null : undefined}/>;\n';
	const jsx = await kinds('file.tsx', tsx);
	for (const word of ['false', 'this', 'null', 'undefined'])
		expect(jsx, word).toContainEqual([word, 'keyword']);
});
it('colours class methods as functions and keeps object properties as properties (spec/editor-code-intelligence#font-styles)', async () => {
	const ts =
		'class Guard {\n  private armed = true;\n  arm(): void { this.armed = true; }\n  get state() { return this.armed; }\n}\ninterface Port { open(): void }\nconst options = { mode: 1 };\nguard.arm();\n';
	const tokens = await kinds('file.ts', ts);
	for (const name of ['arm', 'state', 'open'])
		expect(tokens, name).toContainEqual([name, 'function']);
	expect(tokens).toContainEqual(['armed', 'property']);
	expect(tokens).toContainEqual(['mode', 'property']);
	expect(tokens.filter(([text]) => text === 'arm').map(([, kind]) => kind)).toEqual([
		'function',
		'property',
	]);
});
it('colours Python calls and keeps None, True and False as keywords (spec/editor-code-intelligence#font-styles)', async () => {
	const py =
		'def fit(rows):\n    value = sorted(rows)\n    if value is None:\n        raise ValueError("empty")\n    return helper.compute(value, True, False)\n';
	const tokens = await kinds('file.py', py);
	for (const name of ['fit', 'sorted', 'ValueError', 'compute'])
		expect(tokens, name).toContainEqual([name, 'function']);
	for (const word of ['None', 'True', 'False'])
		expect(tokens, word).toContainEqual([word, 'keyword']);
	expect(tokens.find(([text]) => text === 'helper')).toBeUndefined();
	expect(tokens.find(([text]) => text === 'rows')).toBeUndefined();
});
it('colours CSS at-rules, selectors, functions and !important (spec/editor-code-intelligence#css-scss)', async () => {
	const css =
		'@import url("a.css");\n@media (max-width: 600px) {\n  body > .card:hover, a::before { color: #fff !important; background: var(--x, red); }\n}\n@keyframes spin { to { opacity: 1 } }\n';
	const tokens = await kinds('file.css', css);
	for (const word of ['@import', '@media', '@keyframes', 'body', 'a', '!important'])
		expect(tokens, word).toContainEqual([word, 'keyword']);
	for (const name of ['url', 'var']) expect(tokens, name).toContainEqual([name, 'function']);
	for (const name of ['max-width', 'card', 'hover', 'before', 'color'])
		expect(tokens, name).toContainEqual([name, 'property']);
	expect(tokens).toContainEqual(['"a.css"', 'string']);
	expect(tokens).toContainEqual(['#fff', 'number']);
	expect(tokens).toContainEqual(['spin', 'type']);
});
it('parses SCSS with its own grammar: nesting, variables, mixins and // comments (spec/editor-code-intelligence#css-scss)', async () => {
	const scss =
		"// tokens\n@use 'sass:math';\n$gap: 4px;\n@mixin pad($n) { padding: $n * 2; }\n.card {\n  &:hover { color: #fff; }\n  .title { @include pad(3); width: math.div(10px, 2); }\n}\n";
	const result = await analyze('file.scss', scss, assets);
	expect(result).toMatchObject({ status: 'ready', language: 'scss' });
	const tokens = result.tokens.map((t) => [scss.slice(t.from, t.to), t.kind]);
	expect(tokens).toContainEqual(['// tokens', 'comment']);
	for (const word of ['@use', '@mixin', '@include', '&'])
		expect(tokens, word).toContainEqual([word, 'keyword']);
	for (const name of ['$gap', '$n', 'padding', 'title'])
		expect(tokens, name).toContainEqual([name, 'property']);
	for (const name of ['pad', 'math.div']) expect(tokens, name).toContainEqual([name, 'function']);
	expect(result.symbols.map((s) => s.path)).toEqual([
		'pad',
		'.card',
		'.card > &:hover',
		'.card > .title',
	]);
	const found = await declarations('scss', [scss], 'pad', assets);
	expect(found.map((item) => scss.slice(item.from, item.from + 3))).toEqual(['pad']);
	expect((await declarations('scss', [scss], '$gap', assets)).map((item) => item.from)).toEqual([
		scss.indexOf('$gap'),
	]);
});
it('parses the Sass the reference repo writes, which the stock 1.0.0 grammar rejects (spec/editor-code-intelligence#css-scss)', async () => {
	const scss =
		"@use '/src/styles/variables' as variables;\n@use 'theme' with ($accent: red !default);\n@forward 'src/list' hide list-reset, $horizontal-list-gap;\n$gap: 4px !default;\n.row {\n  > .col,\n  ~ p { @include variables.label; @extend %base; }\n  @container style(--kit-viewport: mobile) { width: 100%; }\n  @each $k in a, b { top: 0; }\n}\n";
	const result = await analyze('file.scss', scss, assets);
	const tokens = result.tokens.map((t) => [scss.slice(t.from, t.to), t.kind]);
	expect(tokens).toContainEqual(['!default', 'keyword']);
	expect(tokens).toContainEqual(['variables.label', 'function']);
	expect(tokens).toContainEqual(['--kit-viewport', 'property']);
	const { Parser, Language } = await import('@vscode/tree-sitter-wasm');
	const parser = new Parser();
	parser.setLanguage(await Language.load(resolve(assets, 'tree-sitter-scss.wasm')));
	const tree = parser.parse(scss)!;
	expect(tree.rootNode.hasError).toBe(false);
	tree.delete();
	parser.delete();
});
it('declares custom properties in CSS and SCSS by their whole name (spec/editor-code-intelligence#hyphenated-words)', async () => {
	const css = ':root {\n  --page-content: 960px;\n}\n.a { width: var(--page-content); }\n';
	for (const language of ['css', 'scss'])
		expect(
			(await declarations(language, [css], '--page-content', assets)).map((item) => item.from),
			language
		).toEqual([css.indexOf('--page-content')]);
});
it('colors JSON and JSONC: keys are properties, values strings, numbers and literals', async () => {
	const json =
		'{\n  // jsonc\n  "name": "choice",\n  "private": true,\n  "port": 5174,\n  "main": null,\n  "scripts": { "web": "expo start --web" }\n}\n';
	for (const path of ['package.json', 'tsconfig.jsonc']) {
		const result = await analyze(path, json, assets);
		expect(result, path).toMatchObject({ status: 'ready', language: 'json' });
		const tokens = result.tokens.map((t) => [json.slice(t.from, t.to), t.kind]);
		expect(tokens).toContainEqual(['// jsonc', 'comment']);
		for (const key of ['"name"', '"private"', '"scripts"', '"web"'])
			expect(tokens, key).toContainEqual([key, 'property']);
		for (const value of ['"choice"', '"expo start --web"'])
			expect(tokens, value).toContainEqual([value, 'string']);
		expect(tokens).toContainEqual(['5174', 'number']);
		for (const word of ['true', 'null']) expect(tokens, word).toContainEqual([word, 'keyword']);
	}
});
