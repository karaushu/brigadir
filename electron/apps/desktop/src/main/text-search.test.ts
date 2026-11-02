import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextSearchEvent, TextSearchRequest } from '@brigadir/core';
import { engineArgs, findTextEngine, TextSearches, type TextFiles } from './text-search';

const key = { projectId: 'p', id: 't' };
const request = (query: string, patch: Partial<TextSearchRequest> = {}): TextSearchRequest => ({
	query,
	caseSensitive: false,
	wholeWord: false,
	regex: false,
	mask: '',
	repo: null,
	...patch,
});
let root = '';
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = '';
});
async function project(files: Record<string, string>) {
	root = await mkdtemp(join(tmpdir(), 'brigadir-text-'));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	const entries = Object.keys(files).map((path, index) => ({
		id: `id${index}`,
		path,
		scope: path.startsWith('kit/') ? 'kit' : path.startsWith('admin/') ? 'admin' : 'choice',
	}));
	return { root, entries, truncated: false } as TextFiles;
}
async function run(files: TextFiles, asked: TextSearchRequest) {
	const events: TextSearchEvent[] = [];
	const searches = new TextSearches(
		async () => files,
		(event) => events.push(event),
		async () => ({ kind: 'git', command: 'git' })
	);
	await searches.start(key, asked, 's1');
	return events;
}

describe('spec/search-menus-and-commands#search-tabs Text search', () => {
	it('finds lines in every repo of the index with ranges, in index order', async () => {
		const files = await project({
			'kit/src/Button.module.css': '.root {\n  &:focus-visible {\n}\n',
			'admin/ui/Drawer.css': '.close:focus-visible { x }\n',
			'README.md': 'nothing here\n',
			'kit/bin.dat': 'focus-visible\u0000\u0001',
		});
		const events = await run(files, request('focus-visible'));
		const matches = events.flatMap((event) => event.matches);
		expect(matches.map((match) => [match.path, match.line, match.scope, match.ranges])).toEqual([
			['kit/src/Button.module.css', 2, 'kit', [[4, 17]]],
			['admin/ui/Drawer.css', 1, 'admin', [[7, 20]]],
		]);
		expect(matches[0]).toMatchObject({ fileId: 'id0', column: 5, text: '  &:focus-visible {' });
		expect(events.at(-1)).toMatchObject({
			done: true,
			scanned: 4,
			total: 4,
			truncated: false,
			error: null,
		});
	});
	it('keeps to the mask and the repo, and honours case, word and regex', async () => {
		const files = await project({
			'kit/a.ts': 'const Focus=1;\nfocused();\n',
			'kit/a.test.ts': 'Focus\n',
			'admin/b.ts': 'Focus\n',
		});
		const lines = async (asked: TextSearchRequest) =>
			(await run(files, asked))
				.flatMap((event) => event.matches)
				.map((match) => `${match.path}:${match.line}`);
		expect(await lines(request('focus', { mask: '*.ts, !*.test.ts', repo: 'kit' }))).toEqual([
			'kit/a.ts:1',
			'kit/a.ts:2',
		]);
		expect(
			await lines(request('Focus', { caseSensitive: true, mask: '*.ts, !*.test.ts' }))
		).toEqual(['kit/a.ts:1', 'admin/b.ts:1']);
		expect(await lines(request('focus', { wholeWord: true, repo: 'kit' }))).toEqual([
			'kit/a.ts:1',
			'kit/a.test.ts:1',
		]);
		expect(await lines(request('focus(ed)?\\(', { regex: true }))).toEqual(['kit/a.ts:2']);
		expect((await run(files, request('(', { regex: true }))).at(-1)).toMatchObject({
			done: true,
			error: 'Invalid regular expression',
		});
	});
	it('sends one event per batch of 200 files with the progress, and stops at the limit', async () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 450; i++)
			many[`f/${String(i).padStart(3, '0')}.txt`] = i % 2 ? 'needle\n' : 'hay\n';
		const files = await project(many);
		const events = await run(files, request('needle'));
		expect(events.map((event) => event.scanned)).toEqual([0, 200, 400, 450]);
		expect(events.flatMap((event) => event.matches)).toHaveLength(225);
		const lots: Record<string, string> = {};
		for (let i = 0; i < 30; i++)
			lots[`g/${i}.txt`] = Array.from({ length: 100 }, () => 'needle').join('\n');
		const limited = await run(await project(lots), request('needle'));
		expect(limited.flatMap((event) => event.matches)).toHaveLength(2000);
		expect(limited.at(-1)).toMatchObject({ done: true, truncated: true });
	});
	it('cancels a search: no events after cancel', async () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) many[`f/${i}.txt`] = 'needle\n';
		const files = await project(many);
		const events: TextSearchEvent[] = [];
		const searches = new TextSearches(
			async () => files,
			(event) => events.push(event),
			async () => ({ kind: 'git', command: 'git' })
		);
		const started = searches.start(key, request('needle'), 's1');
		await new Promise((resolve) => setTimeout(resolve, 5));
		searches.cancel('s1');
		const count = events.length;
		await started;
		expect(events.length).toBe(count);
		expect(events.some((event) => event.done)).toBe(false);
	});
	it('uses rg from PATH when there is one, git grep otherwise', async () => {
		root = await mkdtemp(join(tmpdir(), 'brigadir-rg-'));
		expect((await findTextEngine(root)).kind).toBe(
			process.env.BRIGADIR_TEXT_ENGINE === 'git'
				? 'git'
				: (await findTextEngine('/nonexistent')).kind
		);
		await writeFile(join(root, 'rg'), '#!/bin/sh\n');
		await chmod(join(root, 'rg'), 0o755);
		if (process.env.BRIGADIR_TEXT_ENGINE !== 'git')
			expect(await findTextEngine(root)).toEqual({ kind: 'rg', command: join(root, 'rg') });
		expect(engineArgs({ kind: 'rg', command: 'rg' }, request('a.b'), ['x'])).toEqual(
			expect.arrayContaining(['--null', '--fixed-strings', '--ignore-case', '-e', 'a.b', '--', 'x'])
		);
		expect(
			engineArgs(
				{ kind: 'git', command: 'git' },
				request('a.b', { regex: true, caseSensitive: true, wholeWord: true }),
				['x']
			)
		).toEqual(expect.arrayContaining(['--no-index', '-z', '-E', '-w', '-e', 'a.b', '--', 'x']));
	});
});
