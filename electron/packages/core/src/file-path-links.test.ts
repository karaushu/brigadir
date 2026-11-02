import { expect, it } from 'vitest';
import { filePathCandidates } from './file-path-links';
it('recognizes bounded paths and line suffixes without turning URLs or versions into files', () => {
	const text =
		'Open src/файл.ts:42:3, `src/My file.ts:9` and README.md. Skip https://host/file.ts, user@host.ts and 2.23.1.';
	const result = filePathCandidates(text);
	expect(result.map(({ path, line }) => ({ path, line }))).toEqual([
		{ path: 'src/файл.ts', line: 42 },
		{ path: 'src/My file.ts', line: 9 },
		{ path: 'README.md', line: null },
	]);
	expect(result.map((item) => text.slice(item.from, item.to))).toEqual([
		'src/файл.ts:42:3',
		'src/My file.ts:9',
		'README.md',
	]);
	expect(filePathCandidates('Dockerfile', true)[0]?.path).toBe('Dockerfile');
	expect(filePathCandidates('src/My file.ts:4', true)[0]?.path).toBe('src/My file.ts');
	expect(filePathCandidates('../outside/file.ts file.ts:0 file.ts:999999999999999999')).toEqual([]);
	expect(
		filePathCandidates(Array.from({ length: 100 }, (_, i) => `file${i}.ts`).join(' ')).length
	).toBe(64);
});
