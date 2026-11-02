import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FrameReader, RpcConnection, frame, type RpcMessage } from './rpc';
import { TextMirror } from './mirror';
import * as convert from './convert';
import { CodeIntel, StaleVersionError, type FallbackDeps } from './intel';
import { syntaxLanguage, type CodeProblem } from '@brigadir/core';
import { serverFor } from './servers';

it('serves CSS and SCSS with one CSS language server, each under its own language id (spec/editor-code-intelligence#css-scss)', () => {
	const server = serverFor(syntaxLanguage('theme.scss'));
	expect(server?.id).toBe('css');
	expect(serverFor(syntaxLanguage('theme.css'))).toBe(server);
	expect([server?.languageId('a/theme.scss'), server?.languageId('a/theme.css')]).toEqual([
		'scss',
		'css',
	]);
});

describe('framing', () => {
	it('reads split, joined and multi-byte messages', () => {
		const seen: RpcMessage[] = [];
		const reader = new FrameReader(
			(message) => seen.push(message),
			(error) => {
				throw error;
			}
		);
		const one = frame({ jsonrpc: '2.0', method: 'a', params: 'привіт 🧱' });
		const two = frame({ jsonrpc: '2.0', id: 1, result: 2 });
		const all = Buffer.concat([one, two]);
		for (let i = 0; i < all.length; i += 7) reader.push(all.subarray(i, i + 7));
		expect(seen).toEqual([
			{ jsonrpc: '2.0', method: 'a', params: 'привіт 🧱' },
			{ jsonrpc: '2.0', id: 1, result: 2 },
		]);
	});
	it('rejects oversized and headerless frames', () => {
		const errors: string[] = [];
		new FrameReader(
			() => {},
			(error) => errors.push(error.message)
		).push(Buffer.from('Content-Length: 99999999999\r\n\r\n'));
		new FrameReader(
			() => {},
			(error) => errors.push(error.message)
		).push(Buffer.from('X: 1\r\n\r\n{}'));
		expect(errors).toEqual(['Message is too large', 'Missing Content-Length']);
	});
	it('times out, cancels and answers server requests', async () => {
		const toServer = new PassThrough();
		const fromServer = new PassThrough();
		const sent: RpcMessage[] = [];
		new FrameReader(
			(message) => sent.push(message),
			() => {}
		).push(Buffer.alloc(0));
		toServer.on('data', (chunk: Buffer) =>
			new FrameReader(
				(message) => sent.push(message),
				() => {}
			).push(chunk)
		);
		const connection = new RpcConnection(fromServer, toServer, (method) =>
			method === 'ping' ? 'pong' : null
		);
		await expect(connection.request('slow', null, 20)).rejects.toThrow('Request timed out');
		expect(sent.map((message) => message.method)).toEqual(['slow', '$/cancelRequest']);
		fromServer.write(frame({ jsonrpc: '2.0', id: 'x', method: 'ping' }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 'x', result: 'pong' });
		const pending = connection.request('never', null, 1000);
		fromServer.end();
		await expect(pending).rejects.toThrow('Connection closed');
	});
});

describe('mirror', () => {
	it('maps UTF-16 offsets and applies sequential changes', () => {
		const mirror = new TextMirror('a🧱b\r\nсвіт\nend');
		expect(mirror.position(3)).toEqual({ line: 0, character: 3 });
		expect(mirror.offset({ line: 1, character: 2 })).toBe(8);
		expect(mirror.offset({ line: 0, character: 99 })).toBe(5);
		expect(mirror.lineText(0)).toBe('a🧱b');
		const lsp = mirror.apply([
			{ from: 0, to: 1, insert: 'AA' },
			{ from: 7, to: 11, insert: 'world' },
		]);
		expect(mirror.text).toBe('AA🧱b\r\nworld\nend');
		expect(lsp).toEqual([
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: 'AA' },
			{
				range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
				text: 'world',
			},
		]);
		expect(() => mirror.apply([{ from: 99, to: 100, insert: '' }])).toThrow();
	});
});

describe('convert', () => {
	it('narrows by the typed prefix before the bound and marks the list incomplete', () => {
		const mirror = new TextMirror('const x = gre');
		const items = [
			...Array.from({ length: 300 }, (_, i) => ({ label: `greet${i}`, sortText: `1${i}` })),
			{ label: 'other', sortText: '0' },
			{ label: 'gxrxe', sortText: '0' },
		];
		const result = convert.completions(mirror, { isIncomplete: false, items }, 13);
		expect(result.items).toHaveLength(200);
		expect(result.incomplete).toBe(true);
		expect(result.items[0]).toMatchObject({ label: 'greet0', from: 10, to: 13, insert: 'greet0' });
		expect(result.items.some((item) => item.label === 'other')).toBe(false);
	});
	it('reads parameter offsets, markdown and deduplicated locations', () => {
		const help = convert.signatures({
			signatures: [
				{
					label: 'f(a: number, b: string)',
					parameters: [{ label: 'a: number' }, { label: [13, 22] }],
					documentation: { kind: 'plaintext', value: 'x_y' },
				},
			],
			activeSignature: 0,
			activeParameter: 1,
		});
		expect(help).toEqual({
			signatures: [
				{
					label: 'f(a: number, b: string)',
					documentation: 'x\\_y',
					parameters: [
						{ from: 2, to: 11 },
						{ from: 13, to: 22 },
					],
				},
			],
			active: 0,
			activeParameter: 1,
		});
		const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } };
		expect(
			convert.locations(
				[
					{ uri: 'file:///a.ts', range },
					{ targetUri: 'file:///a.ts', targetSelectionRange: range, targetRange: range },
					{ uri: 'https://x', range },
				],
				20
			)
		).toEqual({ locations: [{ absolute: '/a.ts', line: 1, character: 2 }], truncated: false });
		expect(
			convert.hover(
				new TextMirror('value'),
				{ contents: [{ language: 'ts', value: 'const value: 1' }, 'doc'] },
				2
			)
		).toEqual({ from: 0, to: 5, markdown: '```ts\nconst value: 1\n```\n\n---\n\ndoc' });
	});
});

const temps: string[] = [];
const intels: CodeIntel[] = [];
afterEach(async () => {
	await Promise.all(intels.splice(0).map((intel) => intel.dispose()));
	await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function project(files: Record<string, string>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-lsp-')));
	temps.push(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return root;
}
const noFallback: FallbackDeps = {
	files: async () => [],
	read: async () => null,
	declarations: async () => [],
};
async function fakeIntel(
	mode: string,
	problems: [string, CodeProblem[]][] = [],
	onRestarted?: (owners: string[]) => void
) {
	const bin = await project({});
	const script = resolve('packages/lsp/src/fixtures/fake-server.mjs');
	await writeFile(
		join(bin, 'intelephense'),
		`#!/bin/sh\nFAKE_MODE=${mode} exec "${process.execPath}" "${script}"\n`
	);
	await chmod(join(bin, 'intelephense'), 0o755);
	const intel = new CodeIntel({
		typescript: null,
		node: process.execPath,
		searchPath: bin,
		limits: { start: 2000, request: 300, completion: 200 },
		fallback: noFallback,
		onProblems: (_owner, absolute, _version, list) => problems.push([absolute, list]),
		...(onRestarted ? { onRestarted } : {}),
	});
	intels.push(intel);
	return intel;
}

describe('code intel with a fake server', () => {
	it('syncs incremental changes, rejects stale versions and forwards problems', async () => {
		const problems: [string, CodeProblem[]][] = [];
		const intel = await fakeIntel('normal', problems);
		const root = await project({ 'a.php': '<?php\n  $x;' });
		const file = join(root, 'a.php');
		const status = await intel.open('task', file, root, '<?php\n  $x;');
		expect(status).toMatchObject({
			source: 'server',
			server: 'PHP',
			features: { definition: true, hover: true, completion: true, signature: false },
			completionTriggers: ['.'],
		});
		for (let i = 0; i < 50 && !problems.length; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(problems[0]).toEqual([
			file,
			[{ from: 0, to: 3, severity: 'warning', message: 'fake warning', source: 'fake' }],
		]);
		expect(intel.change('task', file, 1, [{ from: 6, to: 6, insert: '// ' }])).toEqual({
			status: 'ok',
		});
		expect(intel.change('task', file, 5, [])).toEqual({ status: 'resync' });
		expect(intel.canFormat('task', file)).toBe(false);
		expect(await intel.format('task', file, 1, { tabSize: 2, insertSpaces: true })).toBeNull();
		expect((await intel.hover('task', file, 1, 7))?.markdown).toBe('text: "<?php\\n//   $x;"');
		await expect(intel.hover('task', file, 0, 7)).rejects.toBeInstanceOf(StaleVersionError);
		expect((await intel.definition('task', file, 1, 0)).locations).toEqual([
			{ absolute: file, line: 1, character: 2, byName: false },
		]);
	});
	it('returns nothing after the deadline and falls back after repeated crashes', async () => {
		const slow = await fakeIntel('slow');
		const root = await project({ 'a.php': 'x' });
		const file = join(root, 'a.php');
		await slow.open('task', file, root, 'x');
		const started = Date.now();
		expect(await slow.completion('task', file, 0, 1, { kind: 'invoked' })).toBeNull();
		expect(Date.now() - started).toBeLessThan(1000);
		const crash = await fakeIntel('crash');
		await crash.open('task', file, root, 'x');
		for (let i = 0; i < 8; i++) {
			expect(await crash.hover('task', file, 0, 0)).toBeNull();
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		expect((await crash.open('task', file, root, 'x')).source).toBe('fallback');
	});
	it('gives one owner the server document and the second the fallback', async () => {
		const intel = await fakeIntel('normal');
		const root = await project({ 'a.php': 'x' });
		const file = join(root, 'a.php');
		expect((await intel.open('one', file, root, 'x')).source).toBe('server');
		expect((await intel.open('two', file, root, 'x')).source).toBe('fallback');
		expect((await intel.open('three', file, root, 'x', true)).source).toBe('fallback');
	});
	it('switched off, stops live servers, clears problems and opens in the fallback until switched on (spec/editor-code-intelligence#typing-help)', async () => {
		const problems: [string, CodeProblem[]][] = [];
		const intel = await fakeIntel('normal', problems);
		const root = await project({ 'a.php': 'x' });
		const file = join(root, 'a.php');
		expect((await intel.open('task', file, root, 'x')).source).toBe('server');
		expect(intel.servers).toHaveLength(1);
		await intel.setServers(false);
		expect(intel.servers).toHaveLength(0);
		expect(problems.at(-1)).toEqual([file, []]);
		expect(await intel.hover('task', file, 0, 0)).toBeNull();
		expect((await intel.open('task', file, root, 'x')).source).toBe('fallback');
		expect(intel.servers).toHaveLength(0);
		await intel.setServers(true);
		expect((await intel.open('task', file, root, 'x')).source).toBe('server');
		expect(intel.servers).toHaveLength(1);
		await intel.setServers(false);
		expect(await intel.restart('task')).toEqual({ off: true, restarted: [] });
	});
	it('restarts in place: a new process with the documents of every owner, problems cleared (spec/editor-code-intelligence#language-server-restart)', async () => {
		const problems: [string, CodeProblem[]][] = [];
		const restarted: string[][] = [];
		const intel = await fakeIntel('normal', problems, (owners) => restarted.push(owners));
		const root = await project({ 'a.php': 'x', 'b.php': 'y' });
		expect(await intel.restart('task')).toEqual({ off: false, restarted: [] });
		await intel.open('task', join(root, 'a.php'), root, 'x');
		await intel.open('other', join(root, 'b.php'), root, 'y');
		const before = intel.servers[0]!.pid;
		problems.length = 0;
		expect(await intel.restart('task')).toEqual({ off: false, restarted: ['PHP'] });
		expect(intel.servers).toHaveLength(1);
		expect(intel.servers[0]).toMatchObject({ documents: 2 });
		expect(intel.servers[0]!.pid).not.toBe(before);
		expect(
			problems
				.filter(([, list]) => !list.length)
				.map(([file]) => file)
				.sort()
		).toEqual([join(root, 'a.php'), join(root, 'b.php')]);
		expect(restarted.map((owners) => owners.sort())).toEqual([['other', 'task']]);
		expect((await intel.hover('task', join(root, 'a.php'), 0, 0))?.markdown).toBe('text: "x"');
		expect(await intel.restart('nobody')).toEqual({ off: false, restarted: [] });
	});
	it('a restart brings a language back from the fallback after repeated crashes (spec/editor-code-intelligence#language-server-restart)', async () => {
		const intel = await fakeIntel('crash');
		const root = await project({ 'a.php': 'x' });
		const file = join(root, 'a.php');
		await intel.open('task', file, root, 'x');
		for (let i = 0; i < 8; i++) {
			await intel.hover('task', file, 0, 0);
			await new Promise((resolve) => setTimeout(resolve, 30));
		}
		expect((await intel.open('task', file, root, 'x')).source).toBe('fallback');
		expect(await intel.restart('task')).toEqual({ off: false, restarted: ['PHP'] });
		expect((await intel.open('task', file, root, 'x')).source).toBe('server');
	});
});

describe('fallback by name', () => {
	it('goes from SCSS to a hyphenated custom property declared in CSS, and finds its uses whole (spec/editor-code-intelligence#hyphenated-words)', async () => {
		const tokens = ':root {\n  --page-content: 960px;\n  --page: 1px;\n}\n';
		const card = '.card {\n  width: var(--page-content);\n  min-width: var(--page);\n}\n';
		const root = await project({ 'tokens.css': tokens, 'card.scss': card });
		const texts = new Map([[join(root, 'tokens.css'), tokens]]);
		const asked: string[] = [];
		const intel = new CodeIntel({
			typescript: null,
			node: process.execPath,
			searchPath: '',
			fallback: {
				files: async (_owner, language) => (
					asked.push(language),
					language === 'css' ? [...texts.keys()] : []
				),
				read: async (path) => texts.get(path) ?? null,
				declarations: async (_language, list, name) =>
					list.flatMap((text, index) => {
						const at = text.indexOf(`${name}:`);
						return at >= 0 ? [{ index, from: at }] : [];
					}),
			},
			onProblems: () => {},
		});
		intels.push(intel);
		const main = join(root, 'card.scss');
		await intel.open('task', main, root, card);
		expect(await intel.definition('task', main, 0, card.indexOf('content'))).toEqual({
			source: 'fallback',
			truncated: false,
			locations: [{ absolute: join(root, 'tokens.css'), line: 1, character: 2, byName: true }],
		});
		expect(asked.sort()).toEqual(['css', 'scss']);
		expect(
			(await intel.references('task', main, 0, card.indexOf('page'))).locations.map((location) => [
				location.absolute.slice(root.length + 1),
				location.line,
			])
		).toEqual([
			['card.scss', 1],
			['tokens.css', 1],
		]);
	});
	it('finds a declaration in another file of the same language and textual references', async () => {
		const root = await project({
			'lib/tool.py': 'def helper():\n    return 1\n',
			'main.py': 'from lib.tool import helper\nhelper()\n',
		});
		const texts = new Map<string, string>([
			[join(root, 'lib/tool.py'), 'def helper():\n    return 1\n'],
		]);
		const deps: FallbackDeps = {
			files: async () => [...texts.keys()],
			read: async (path) => texts.get(path) ?? null,
			declarations: async (_language, list, name) =>
				list.flatMap((text, index) => {
					const at = text.indexOf(`def ${name}`);
					return at >= 0 ? [{ index, from: at + 4 }] : [];
				}),
		};
		const intel = new CodeIntel({
			typescript: null,
			node: process.execPath,
			searchPath: '',
			fallback: deps,
			onProblems: () => {},
		});
		intels.push(intel);
		const main = join(root, 'main.py');
		const text = 'from lib.tool import helper\nhelper()\n';
		expect((await intel.open('task', main, root, text)).features).toMatchObject({
			definition: true,
			references: true,
			completion: false,
		});
		expect(await intel.definition('task', main, 0, 29)).toEqual({
			source: 'fallback',
			truncated: false,
			locations: [{ absolute: join(root, 'lib/tool.py'), line: 0, character: 4, byName: true }],
		});
		expect(
			(await intel.references('task', main, 0, 29)).locations.map((location) => [
				location.absolute.slice(root.length),
				location.line,
				location.character,
			])
		).toEqual([
			['/main.py', 0, 21],
			['/main.py', 1, 0],
			['/lib/tool.py', 0, 4],
		]);
		// spec/editor-code-intelligence#definition-and-usages: on the declaration itself the fallback answers with that very place, so ⌘+click shows references.
		const tool = join(root, 'lib/tool.py');
		await intel.open('task', tool, root, texts.get(tool)!);
		expect((await intel.definition('task', tool, 0, 6)).locations).toEqual([
			{ absolute: tool, line: 0, character: 4, byName: true },
		]);
	});
	it('looks through JS, TS and TSX together and parses each file with its own grammar (spec/editor-code-intelligence#typing-help)', async () => {
		const root = await project({});
		const texts = new Map<string, string>([
			[join(root, 'a.ts'), 'export function greet() {}\n'],
			[join(root, 'b.py'), 'def greet(): pass\n'],
		]);
		const asked: string[] = [];
		const deps: FallbackDeps = {
			files: async (_owner, language) =>
				[...texts.keys()].filter((path) => syntaxLanguage(path) === language),
			read: async (path) => texts.get(path) ?? null,
			declarations: async (language, list, name) => {
				asked.push(language);
				return list.flatMap((text, index) => {
					const at = text.indexOf(`function ${name}`);
					return at >= 0 ? [{ index, from: at + 9 }] : [];
				});
			},
		};
		const intel = new CodeIntel({
			typescript: null,
			node: process.execPath,
			searchPath: '',
			fallback: deps,
			onProblems: () => {},
		});
		intels.push(intel);
		const view = join(root, 'c.tsx');
		const text = 'import { greet } from "./a";\ngreet();\n';
		await intel.open('task', view, root, text);
		expect(await intel.definition('task', view, 0, text.lastIndexOf('greet') + 1)).toEqual({
			source: 'fallback',
			truncated: false,
			locations: [{ absolute: join(root, 'a.ts'), line: 0, character: 16, byName: true }],
		});
		expect(asked).toEqual(['tsx', 'typescript']);
	});
});

describe('bundled TypeScript server', () => {
	it('auto-imports a runnable relative path in a standalone Node ESM file', async () => {
		const require = createRequire(resolve('packages/lsp/package.json'));
		const root = await project({
			'math.js': 'export function multiply(a, b) { return a * b; }\n',
			'main.mjs': 'multipl',
		});
		const intel = new CodeIntel({
			typescript: {
				cli: join(
					dirname(require.resolve('typescript-language-server/package.json')),
					'lib/cli.mjs'
				),
				tsserver: join(dirname(require.resolve('typescript/package.json')), 'lib/tsserver.js'),
			},
			node: process.execPath,
			searchPath: '',
			fallback: noFallback,
			onProblems() {},
		});
		intels.push(intel);
		await intel.open(
			'task',
			join(root, 'math.js'),
			root,
			'export function multiply(a, b) { return a * b; }\n'
		);
		const file = join(root, 'main.mjs');
		await intel.open('task', file, root, 'multipl');
		const list = await intel.completion('task', file, 0, 7, { kind: 'invoked' });
		const item = list?.items.find((item) => item.label === 'multiply');
		expect(item).toBeDefined();
		const detail = await intel.resolveCompletion('task', file, 0, list!.list, item!.id);
		expect(detail?.edits.map((edit) => edit.insert).join('')).toMatch(/from ["']\.\/math\.js["']/);
	}, 60000);
	it('goes to a definition in another file, completes with an auto-import, hovers, finds references and reports a problem', async () => {
		const require = createRequire(resolve('packages/lsp/package.json'));
		const cli = join(
			dirname(require.resolve('typescript-language-server/package.json')),
			'lib/cli.mjs'
		);
		const tsserver = join(dirname(require.resolve('typescript/package.json')), 'lib/tsserver.js');
		const a = 'export const answer = 42;\nexport function greet(name: string) { return name; }\n';
		const root = await project({
			'tsconfig.json':
				'{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
			'a.ts': a,
			'b.ts': 'import { answer } from "./a";\nconst n: string = answer;\n',
		});
		const problems: CodeProblem[][] = [];
		const intel = new CodeIntel({
			typescript: { cli, tsserver },
			node: process.execPath,
			searchPath: '',
			fallback: noFallback,
			onProblems: (_owner, absolute, _version, list) => {
				if (absolute.endsWith('b.ts')) problems.push(list);
			},
		});
		intels.push(intel);
		const b = join(root, 'b.ts');
		let text = 'import { answer } from "./a";\nconst n: string = answer;\n';
		const status = await intel.open('task', b, root, text);
		expect(status).toMatchObject({
			source: 'server',
			server: 'TypeScript',
			features: {
				completion: true,
				hover: true,
				signature: true,
				definition: true,
				references: true,
			},
		});
		const definition = await intel.definition('task', b, 0, text.lastIndexOf('answer') + 2);
		expect(definition.locations).toEqual([
			{ absolute: join(root, 'a.ts'), line: 0, character: 13, byName: false },
		]);
		expect((await intel.hover('task', b, 0, text.lastIndexOf('answer') + 2))?.markdown).toContain(
			'const answer: 42'
		);
		expect(
			(await intel.references('task', b, 0, text.lastIndexOf('answer') + 2)).locations.length
		).toBeGreaterThanOrEqual(3);
		// spec/editor-code-intelligence#definition-and-usages: on `export const answer` the server answers with the declaration itself, without the import hop's 500 ms pause.
		const aPath = join(root, 'a.ts');
		await intel.open('task', aPath, root, a);
		const started = Date.now();
		const own = await intel.definition('task', aPath, 0, a.indexOf('answer') + 2);
		expect(own.locations).toEqual([{ absolute: aPath, line: 0, character: 13, byName: false }]);
		expect(Date.now() - started).toBeLessThan(450);
		for (
			let i = 0;
			i < 100 && !problems.some((list) => list.some((problem) => problem.severity === 'error'));
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 100));
		expect(problems.flat().find((problem) => problem.severity === 'error')?.message).toContain(
			"not assignable to type 'string'"
		);
		const insert = '\ngre';
		expect(intel.change('task', b, 1, [{ from: text.length, to: text.length, insert }])).toEqual({
			status: 'ok',
		});
		text += insert;
		const list = await intel.completion('task', b, 1, text.length, { kind: 'invoked' });
		const greet = list?.items.find((item) => item.label === 'greet');
		expect(greet).toMatchObject({
			kind: 'function',
			from: text.length - 3,
			to: text.length,
			resolve: true,
		});
		const detail = await intel.resolveCompletion('task', b, 1, list!.list, greet!.id);
		expect(detail?.edits.map((edit) => edit.insert).join('')).toContain('greet');
		let next = text;
		for (const edit of [...detail!.edits].reverse())
			next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
		next = next.slice(0, -3) + 'greet(';
		expect(intel.change('task', b, 2, [{ from: 0, to: text.length, insert: next }])).toEqual({
			status: 'ok',
		});
		text = next;
		const help = await intel.signature('task', b, 2, text.length, {
			kind: 'character',
			character: '(',
		});
		expect(help?.signatures[0]?.label).toContain('greet(name: string)');
	}, 60000);
	it('restarts by itself once an install writes its marker in node_modules (spec/editor-code-intelligence#language-server-restart)', async () => {
		const require = createRequire(resolve('packages/lsp/package.json'));
		const cli = join(
			dirname(require.resolve('typescript-language-server/package.json')),
			'lib/cli.mjs'
		);
		const tsserver = join(dirname(require.resolve('typescript/package.json')), 'lib/tsserver.js');
		const root = await project({ 'tsconfig.json': '{}', 'a.ts': 'export const a = 1;\n' });
		const restarted: string[][] = [];
		const intel = new CodeIntel({
			typescript: { cli, tsserver },
			node: process.execPath,
			searchPath: '',
			installPollMs: 40,
			fallback: noFallback,
			onProblems: () => {},
			onRestarted: (owners) => restarted.push(owners),
		});
		intels.push(intel);
		await intel.open('task', join(root, 'a.ts'), root, 'export const a = 1;\n');
		const before = intel.servers[0]!.pid;
		// The folder alone, as npm ci leaves it mid-install, is enough only while no marker was there at start.
		await mkdir(join(root, 'node_modules'));
		await writeFile(join(root, 'node_modules/.package-lock.json'), '{}');
		for (let i = 0; i < 100 && !restarted.length; i++)
			await new Promise((resolve) => setTimeout(resolve, 30));
		expect(restarted).toEqual([['task']]);
		await expect.poll(() => intel.servers[0]?.pid).not.toBe(before);
		// The folder gone again while a marker was there at start: nothing restarts until a marker is back.
		await rm(join(root, 'node_modules'), { recursive: true });
		await mkdir(join(root, 'node_modules'));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(restarted).toHaveLength(1);
		await writeFile(join(root, 'node_modules/.package-lock.json'), '{"v":2}');
		await expect.poll(() => restarted.length, { timeout: 3000 }).toBe(2);
	});
	it('formats with the server when it declares documentFormattingProvider (spec/editor-code-intelligence#format-on-save)', async () => {
		const require = createRequire(resolve('packages/lsp/package.json'));
		const cli = join(
			dirname(require.resolve('typescript-language-server/package.json')),
			'lib/cli.mjs'
		);
		const tsserver = join(dirname(require.resolve('typescript/package.json')), 'lib/tsserver.js');
		const text = 'const  a={b:1}\nfunction f( ){return a}\n';
		const root = await project({ 'tsconfig.json': '{}', 'a.ts': text });
		const file = join(root, 'a.ts');
		const intel = new CodeIntel({
			typescript: { cli, tsserver },
			node: process.execPath,
			searchPath: '',
			fallback: noFallback,
			onProblems: () => {},
		});
		intels.push(intel);
		await intel.open('task', file, root, text);
		expect(intel.canFormat('task', file)).toBe(true);
		expect(intel.snapshot('task', file, 0)).toBe(text);
		expect(intel.snapshot('task', file, 1)).toBeNull();
		const edits = await intel.format('task', file, 0, { tabSize: 2, insertSpaces: true });
		const formatted = [...edits!]
			.reverse()
			.reduce(
				(value, edit) => value.slice(0, edit.from) + edit.insert + value.slice(edit.to),
				text
			);
		expect(formatted).toBe('const a = { b: 1 }\nfunction f() { return a }\n');
		await expect(
			intel.format('task', file, 3, { tabSize: 2, insertSpaces: true })
		).rejects.toBeInstanceOf(StaleVersionError);
	}, 60000);
});
