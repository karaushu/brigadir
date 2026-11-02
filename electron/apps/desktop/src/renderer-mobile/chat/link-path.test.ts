import { describe, expect, it } from 'vitest';
import { linkPath, matchFile } from './link-path';

describe('a link in the chat on the phone', () => {
	it('names a file by its path, without the position, the query or `./`', () => {
		expect(linkPath('src/app.ts')).toBe('src/app.ts');
		expect(linkPath('./src/app.ts:12')).toBe('src/app.ts');
		expect(linkPath('src/app.ts:12:3')).toBe('src/app.ts');
		expect(linkPath('src/app.ts#L12')).toBe('src/app.ts');
		expect(linkPath('/Users/a/repo/src/app%20one.ts')).toBe('/Users/a/repo/src/app one.ts');
		expect(linkPath('file:///Users/a/repo/README.md')).toBe('/Users/a/repo/README.md');
	});
	it('is no file for an address with a scheme, an anchor, a folder or a broken escape', () => {
		expect(linkPath('https://example.com/x')).toBeNull();
		expect(linkPath('mailto:a@b.c')).toBeNull();
		expect(linkPath('javascript:alert(1)')).toBeNull();
		expect(linkPath('#top')).toBeNull();
		expect(linkPath('//host/x')).toBeNull();
		expect(linkPath('src/')).toBeNull();
		expect(linkPath('src/%E0.ts')).toBeNull();
		expect(linkPath('')).toBeNull();
	});
	it('finds the task file the path names, the longest match for an absolute path', () => {
		const entries = [
			{ path: 'app.ts', kind: 'file' },
			{ path: 'src/app.ts', kind: 'file' },
			{ path: 'src', kind: 'directory' },
		];
		expect(matchFile('src/app.ts', entries)?.path).toBe('src/app.ts');
		expect(matchFile('/Users/a/repo/src/app.ts', entries)?.path).toBe('src/app.ts');
		expect(matchFile('app.ts', entries)?.path).toBe('app.ts');
		expect(matchFile('lib/other.ts', entries)).toBeNull();
		expect(matchFile('src', entries)).toBeNull();
	});
});
