import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultAppSettings } from '@brigadir/core';
import { lspIndent, projectIndent, readEditorConfigs, resolveFor } from './indent';
const temps: string[] = [];
afterEach(async () => {
	await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tree(files: Record<string, string>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-indent-')));
	temps.push(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return root;
}
const noPrettier = { indent: async () => null };
it('reads .editorconfig files up to the project root and the nested repository boundary (spec/editor#indentation)', async () => {
	const root = await tree({
		'.editorconfig': 'root = true\n[*]\nindent_style = tab\n',
		'apps/admin/.git': 'gitdir: x\n',
		'apps/admin/.editorconfig': '[*.ts]\nindent_size = 2\nindent_style = space\n',
		'apps/admin/src/a.ts': '',
		'apps/demo/a.ts': '',
		'apps/demo/b.py': '',
	});
	expect(
		(await readEditorConfigs(join(root, 'apps/admin/src/a.ts'), root)).map((file) => file.relative)
	).toEqual(['src/a.ts']);
	expect(
		(await readEditorConfigs(join(root, 'apps/demo/a.ts'), root)).map((file) => file.relative)
	).toEqual(['apps/demo/a.ts']);
	expect(await projectIndent(noPrettier, join(root, 'apps/admin/src/a.ts'), root)).toEqual({
		source: 'editorconfig',
		useTabs: false,
		tabWidth: 2,
		indentSize: 2,
	});
	expect(await projectIndent(noPrettier, join(root, 'apps/demo/a.ts'), root)).toEqual({
		source: 'editorconfig',
		useTabs: true,
	});
	expect(
		await projectIndent(noPrettier, join(root, 'apps/demo/a.ts'), join(root, 'apps'))
	).toBeNull();
});
it("asks the project's Prettier first and falls back to .editorconfig when it has nothing to say", async () => {
	const root = await tree({
		'node_modules/prettier/package.json': '{"version":"3.0.0"}',
		'.editorconfig': '[*]\nindent_size = 3\n',
		'a.ts': '',
	});
	const answer = { source: 'prettier', useTabs: true, tabWidth: 8 } as const;
	expect(await projectIndent({ indent: async () => answer }, join(root, 'a.ts'), root)).toEqual(
		answer
	);
	expect(await projectIndent({ indent: async () => null }, join(root, 'a.ts'), root)).toEqual({
		source: 'editorconfig',
		tabWidth: 3,
		indentSize: 3,
	});
});
it('gives the language server the same indentation as the editor: config, settings, content', () => {
	const settings = defaultAppSettings.editor;
	expect(lspIndent(resolveFor(settings, null, 'a.ts', 'a\n\tb\n'))).toEqual({
		tabSize: 4,
		insertSpaces: false,
	});
	expect(lspIndent(resolveFor(settings, null, 'a.ts', 'a\n    b\n        c\n'))).toEqual({
		tabSize: 4,
		insertSpaces: true,
	});
	expect(lspIndent(resolveFor(settings, null, 'a.ts', 'a\n  b\n'))).toEqual({
		tabSize: 2,
		insertSpaces: true,
	});
	expect(lspIndent(resolveFor(settings, null, 'a.ts', 'flat'))).toEqual({
		tabSize: 2,
		insertSpaces: true,
	});
	expect(lspIndent(resolveFor(settings, null, 'a.py', 'flat'))).toEqual({
		tabSize: 4,
		insertSpaces: true,
	});
	expect(
		lspIndent(
			resolveFor({ ...settings, indentStyle: 'tabs', tabWidth: 8 }, null, 'a.ts', 'a\n  b\n')
		)
	).toEqual({ tabSize: 8, insertSpaces: false });
	// The shown width of a tab is the author's; the server formats with the project's, as Prettier does.
	expect(
		lspIndent(
			resolveFor(
				{ ...settings, tabWidth: 2 },
				{ source: 'prettier', useTabs: true, tabWidth: 4 },
				'a.ts',
				'a\n\tb\n'
			)
		)
	).toEqual({ tabSize: 4, insertSpaces: false });
	expect(
		lspIndent(
			resolveFor(
				{ ...settings, indentStyle: 'tabs' },
				{ source: 'prettier', useTabs: false, tabWidth: 3 },
				'a.ts',
				'a\n\tb\n'
			)
		)
	).toEqual({ tabSize: 3, insertSpaces: true });
});
