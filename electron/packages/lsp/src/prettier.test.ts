import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PrettierPool, findPrettier, prettierIgnore } from './prettier';
// The worker runs bundled, as in the app: `pnpm test` builds services first (spec/editor-code-intelligence#format-on-save).
const worker = resolve('apps/desktop/out/services/prettier.cjs');
const temps: string[] = [];
const pools: PrettierPool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) pool.dispose();
	await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function project(files: Record<string, string>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-prettier-')));
	temps.push(root);
	await cp(
		resolve('packages/lsp/src/fixtures/fake-prettier'),
		join(root, 'node_modules/prettier'),
		{ recursive: true }
	);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return root;
}
const pool = (limits = { start: 10000, request: 3000, idle: 60000 }) => {
	const value = new PrettierPool(worker, process.execPath, limits);
	pools.push(value);
	return value;
};
describe("the project's Prettier", () => {
	it('is found upward from the file, bounded by the project root, with the nearest ignore file', async () => {
		const root = await project({
			'apps/admin/src/a.ts': '',
			'apps/admin/.prettierignore': 'gen.ts\n',
		});
		const file = join(root, 'apps/admin/src/a.ts');
		expect(findPrettier(file, root)).toEqual({
			directory: join(root, 'node_modules/prettier'),
			version: '9.9.9',
		});
		expect(findPrettier(file, join(root, 'apps'))).toBeNull();
		expect(prettierIgnore(file, root)).toBe(join(root, 'apps/admin/.prettierignore'));
	});
	it("stops the ignore search at the file's own git root", async () => {
		const root = await project({
			'.prettierignore': 'apps/*\n',
			'apps/admin/.git': 'gitdir: ../../.git/modules/admin\n',
			'apps/admin/src/a.ts': '',
			'apps/demo/a.ts': '',
		});
		expect(prettierIgnore(join(root, 'apps/admin/src/a.ts'), root)).toBeNull();
		expect(prettierIgnore(join(root, 'apps/demo/a.ts'), root)).toBe(join(root, '.prettierignore'));
	});
	it('formats with the config next to the file, skips ignored and unknown files and reports the syntax line', async () => {
		const root = await project({
			'src/.prettierrc': '{"singleQuote":true}',
			'.prettierignore': 'src/gen.ts\n',
		});
		const prettier = pool();
		const directory = join(root, 'node_modules/prettier');
		const ignore = join(root, '.prettierignore');
		expect(
			await prettier.format(directory, join(root, 'src/a.ts'), ignore, 'const  a = "x";\n')
		).toEqual({ status: 'formatted', text: "const a = 'x';\n" });
		expect(await prettier.format(directory, join(root, 'src/gen.ts'), ignore, 'x')).toEqual({
			status: 'ignored',
		});
		expect(await prettier.format(directory, join(root, 'src/notes.txt'), ignore, 'x')).toEqual({
			status: 'unsupported',
		});
		expect(await prettier.format(directory, join(root, 'src/a.ts'), ignore, 'a\nSYNTAX')).toEqual({
			status: 'syntax',
			line: 2,
		});
		expect(await prettier.info(directory, join(root, 'src/a.ts'), ignore)).toEqual({
			version: '9.9.9',
			ignored: false,
			parser: 'babel',
		});
		expect(prettier.running).toHaveLength(1);
	});
	// The synced text holds LF breaks whatever the file has, so `endOfLine: crlf | auto`
	// of the project must not turn into a CRLF result that differs on every line. The worker pins LF; the file keeps its own breaks.
	it('formats to LF breaks even when the project config asks for crlf or auto', async () => {
		for (const endOfLine of ['crlf', 'auto', 'cr']) {
			const root = await project({
				'src/.prettierrc': JSON.stringify({ singleQuote: true, endOfLine }),
			});
			const result = await pool().format(
				join(root, 'node_modules/prettier'),
				join(root, 'src/a.ts'),
				join(root, '.prettierignore'),
				'const  a = "x";\nconst b = "y";\n'
			);
			expect(result).toEqual({ status: 'formatted', text: "const a = 'x';\nconst b = 'y';\n" });
		}
	});
	it('reads indentation from the file config, and from .editorconfig only when Prettier has none of its own (spec/editor#indentation)', async () => {
		const root = await project({
			'a/.prettierrc': '{"useTabs":true,"tabWidth":8}',
			'a/.editorconfig': 'indent_style = space\nindent_size = 2\n',
			'b/.editorconfig': 'indent_style = space\nindent_size = 3\n',
			'c/.prettierrc': '{"singleQuote":true}',
		});
		const prettier = pool();
		const directory = join(root, 'node_modules/prettier');
		expect(await prettier.indent(directory, join(root, 'a/x.ts'))).toEqual({
			source: 'prettier',
			useTabs: true,
			tabWidth: 8,
		});
		expect(await prettier.indent(directory, join(root, 'b/x.ts'))).toEqual({
			source: 'editorconfig',
			useTabs: false,
			tabWidth: 3,
		});
		expect(await prettier.indent(directory, join(root, 'c/x.ts'))).toBeNull();
	});
	it('times out a stuck format and starts a new worker for the next one', async () => {
		const root = await project({});
		const prettier = pool({ start: 10000, request: 300, idle: 60000 });
		const directory = join(root, 'node_modules/prettier');
		expect((await prettier.format(directory, join(root, 'a.ts'), null, 'x')).status).toBe(
			'formatted'
		);
		const started = Date.now();
		expect(await prettier.format(directory, join(root, 'a.ts'), null, 'HANG')).toEqual({
			status: 'timeout',
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(prettier.running).toHaveLength(0);
		expect(await prettier.format(directory, join(root, 'a.ts'), null, '"y"')).toEqual({
			status: 'formatted',
			text: '"y"',
		});
	});
});
