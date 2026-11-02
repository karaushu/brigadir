import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fuzzy, rankProjectFiles, searchProjectFiles, type ProjectFileHit } from './project-files';

describe('spec/tasks#sheet-layout: пошук файлів для меню @', () => {
	it('ставить точний підрядок вище за розкидані літери й відкидає те, що не збігається', () => {
		const exact = fuzzy('apps/desktop/scopepanel.tsx', 'scopepanel')!,
			scattered = fuzzy('apps/desktop/src/cloud/pane.tsx', 'scopepan');
		expect(exact).toBeLessThan(1000);
		expect(scattered === null || scattered > exact).toBe(true);
		expect(fuzzy('readme.md', 'zzz')).toBeNull();
		expect(fuzzy('readme.md', '')).toBe('readme.md'.length);
	});
	it('spec/composer#mention-menu: збіг у назві файла вище за збіг лише в теках', () => {
		const paths = [
			'src/assets/ai/news.jpg',
			'src/hooks/useSse.ts',
			'src/live/sse.ts',
			'src/session/events.ts',
		].map((path) => path.toLocaleLowerCase());
		const order = (needle: string) =>
			paths
				.filter((path) => fuzzy(path, needle) !== null)
				.sort((a, b) => fuzzy(a, needle)! - fuzzy(b, needle)!);
		expect(order('sse')).toEqual([
			'src/live/sse.ts',
			'src/hooks/usesse.ts',
			'src/assets/ai/news.jpg',
			'src/session/events.ts',
		]);
		// Scattered letters in the name still lose to an exact substring anywhere in the path.
		expect(fuzzy('src/btn/index.ts', 'btn')!).toBeLessThan(fuzzy('src/button.tsx', 'btn')!);
		expect(fuzzy('src/button.tsx', 'btn')!).toBeLessThan(fuzzy('b/t/n/index.ts', 'btn')!);
	});
	// TREE-03 / APP-05: the order of the old sort with fuzzy in its comparator, computed once per path.
	const reference = (
		groups: { scope: string; scopePath: string; paths: string[] }[],
		query: string
	) => {
		const needle = query.toLocaleLowerCase().trim();
		const hits: ProjectFileHit[] = [];
		for (const group of groups)
			for (const path of group.paths)
				if (fuzzy(path.toLocaleLowerCase(), needle) !== null)
					hits.push({ path, scope: group.scope, scopePath: group.scopePath });
		return hits
			.sort(
				(a, b) =>
					(fuzzy(a.path.toLocaleLowerCase(), needle) ?? 0) -
						(fuzzy(b.path.toLocaleLowerCase(), needle) ?? 0) || a.path.length - b.path.length
			)
			.slice(0, 20);
	};
	it('ранжує так само, як сортування з fuzzy у компараторі, але рахує score раз на шлях', () => {
		let seed = 3;
		const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
		const words = ['app', 'src', 'scope', 'panel', 'main', 'test', 'ui', 'Rows', 'diff', 'index'];
		const group = (scope: string, count: number) => {
			const paths = Array.from(
				{ length: count },
				() =>
					Array.from(
						{ length: 2 + Math.floor(next() * 4) },
						() => words[Math.floor(next() * words.length)]
					).join('/') + ['.ts', '.tsx', '.md'][Math.floor(next() * 3)]
			);
			return {
				scope,
				scopePath: scope === '.' ? '.' : scope,
				paths,
				lower: paths.map((path) => path.toLocaleLowerCase()),
				folders: [],
				lowerFolders: [],
			};
		};
		const groups = [group('.', 30000), group('ui', 20000)];
		for (const query of ['', 'a', 'sc', 'scope/panel', 'rows.tsx', 'ZZZ', '  Diff ']) {
			const started = performance.now(),
				before = reference(groups, query),
				old = performance.now() - started,
				start = performance.now(),
				after = rankProjectFiles(groups, query),
				now = performance.now() - start;
			expect(after).toEqual(before);
			if (query === 'a') expect(now).toBeLessThan(old);
		}
	});
	it('spec/composer#mention-menu: знаходить і теки файлів repo; тека з назвою запиту стоїть над своїми файлами', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-mention-folders-'));
		try {
			execFileSync('git', ['init', '-q'], { cwd: root });
			await mkdir(join(root, 'src/ui/VibePreview'), { recursive: true });
			for (const file of [
				'src/ui/VibePreview/VibePreviewPane.tsx',
				'src/ui/VibePreview/const.ts',
				'src/ui/Other.tsx',
			])
				await writeFile(join(root, file), '');
			const hits = await searchProjectFiles(
				root,
				[{ id: 'root', name: '.', selected: true }],
				'VibePreview'
			);
			expect(hits.slice(0, 2)).toEqual([
				{ path: 'src/ui/VibePreview', scope: '.', scopePath: '.', directory: true },
				{ path: 'src/ui/VibePreview/VibePreviewPane.tsx', scope: '.', scopePath: '.' },
			]);
			expect(
				(await searchProjectFiles(root, [{ id: 'root', name: '.', selected: true }], ''))
					.filter((hit) => hit.directory)
					.map((hit) => hit.path)
			).toEqual(['src', 'src/ui', 'src/ui/VibePreview']);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it('тримає список repo 5 с від завершення: новий файл видно після цього', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-mentions-'));
		try {
			execFileSync('git', ['init', '-q'], { cwd: root });
			await writeFile(join(root, 'first.ts'), '');
			let clock = 0;
			const now = () => clock;
			const scopes = [{ id: 'root', name: '.', selected: true }];
			expect((await searchProjectFiles(root, scopes, 'ts', now)).map((hit) => hit.path)).toEqual([
				'first.ts',
			]);
			await writeFile(join(root, 'second.ts'), '');
			clock = 4000;
			expect(await searchProjectFiles(root, scopes, 'second', now)).toEqual([]);
			clock = 10000;
			expect(await searchProjectFiles(root, scopes, 'second', now)).toEqual([
				{ path: 'second.ts', scope: '.', scopePath: '.' },
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
