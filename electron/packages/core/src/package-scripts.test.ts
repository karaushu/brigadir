import { describe, expect, it } from 'vitest';
import {
	declaredManager,
	isPackageJsonPath,
	isProjectScripts,
	packageScripts,
	repoOf,
	scriptAt,
	scriptLine,
} from './package-scripts';

const text = `{
  "name": "choice.business",
  "scripts": {
    "web": "expo start --web",
    "i18n:get": "node scripts/i18n/get.js",
    "say \\"hi\\"": "echo {\\"a\\": 1}",
    // a comment with "quotes": {
    "build:web": "expo export -p web"
  },
  "jest": { "scripts": { "inner": "x" } },
  "workspaces": [{ "scripts": "no" }]
}
`;
const at = (fragment: string) => scriptAt(text, text.indexOf(fragment) + 2);

describe('package.json scripts (spec/search-menus-and-commands#package-scripts)', () => {
	it('names the top-level script on the caret line', () => {
		expect(at('"web"')).toBe('web');
		expect(scriptAt(text, text.indexOf('expo start --web'))).toBe('web');
		expect(at('"i18n:get"')).toBe('i18n:get');
		expect(at('"say')).toBe('say "hi"');
		expect(at('"build:web"')).toBe('build:web');
	});
	it('knows no script off the scripts object, in comments or nested objects', () => {
		expect(at('"name"')).toBeNull();
		expect(at('"scripts": {\n    "web"')).toBeNull();
		expect(at('// a comment')).toBeNull();
		expect(at('"inner"')).toBeNull();
		expect(at('"workspaces"')).toBeNull();
		expect(scriptAt('', 0)).toBeNull();
		expect(scriptAt('{"scripts": {"a": ', 14)).toBe('a');
	});
	it('reads string scripts in file order', () => {
		expect(packageScripts({ scripts: { dev: 'vite', bad: 1, '': 'x', test: 'vitest' } })).toEqual([
			{ name: 'dev', body: 'vite' },
			{ name: 'test', body: 'vitest' },
		]);
		expect(packageScripts({ scripts: ['a'] })).toEqual([]);
		expect(packageScripts(null)).toEqual([]);
	});
	it('takes the manager from packageManager and quotes unusual names', () => {
		expect(declaredManager({ packageManager: 'pnpm@9.12.0+sha512.abc' })).toBe('pnpm');
		expect(declaredManager({ packageManager: 'deno@2' })).toBeNull();
		expect(declaredManager({})).toBeNull();
		expect(scriptLine('pnpm', 'i18n:get')).toBe('pnpm run i18n:get');
		expect(scriptLine('npm', '@scope/build.web')).toBe('npm run @scope/build.web');
		expect(scriptLine('yarn', "it's on")).toBe(`yarn run 'it'\\''s on'`);
		expect(scriptLine('bun', 'a;rm -rf')).toBe("bun run 'a;rm -rf'");
	});
	it('finds the repo of a folder and recognizes the file', () => {
		expect(repoOf(['', 'mobile/business', 'mobile'], 'mobile/business/app')).toBe(
			'mobile/business'
		);
		expect(repoOf(['', 'mobile'], 'mobilex')).toBe('');
		expect(repoOf([], 'a')).toBe('');
		expect(isPackageJsonPath('business/package.json')).toBe(true);
		expect(isPackageJsonPath('package.json')).toBe(true);
		expect(isPackageJsonPath('my-package.json')).toBe(false);
	});
	it('validates the IPC answer', () => {
		const good = {
			repos: ['', 'business'],
			packages: [
				{ repo: 'business', directory: '', manager: 'npm', scripts: [{ name: 'web', body: 'x' }] },
			],
		};
		expect(isProjectScripts(good)).toBe(true);
		expect(isProjectScripts({ ...good, repos: ['../x'] })).toBe(false);
		expect(
			isProjectScripts({ ...good, packages: [{ ...good.packages[0], manager: 'deno' }] })
		).toBe(false);
	});
});
