import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Syntax } from './syntax';
it('finds fallback declarations through the bundled syntax worker (spec/editor-code-intelligence#fallback-mode)', async () => {
	const syntax = new Syntax(resolve('apps/desktop/out/services/syntax.cjs'));
	expect(
		await syntax.declarations(
			'python',
			['from lib.tool import helper\nhelper()\n', 'def helper():\n    return 1\n'],
			'helper'
		)
	).toEqual([{ index: 1, from: 4 }]);
});
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultAppSettings, type AppSettings, type Project } from '@brigadir/core';
import { CodeIntelBridge } from './code-intel';
import type { Files } from './files';
it('formats on save with the project Prettier, honours off, overrides and ignore files (spec/editor-code-intelligence#format-on-save)', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-format-')));
	try {
		await cp(
			resolve('packages/lsp/src/fixtures/fake-prettier'),
			join(root, 'node_modules/prettier'),
			{ recursive: true }
		);
		const files: Record<string, string> = {
			'tsconfig.json': '{}',
			'.prettierrc': '{"singleQuote":true}',
			'.prettierignore': 'gen.ts\n',
			'a.ts': 'const  a = "x";\n',
			'gen.ts': 'const  g = "x";\n',
		};
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), text);
		}
		let settings: AppSettings = defaultAppSettings;
		let project: Project = { id: 'p', name: 'demo', path: root };
		const stub = {
			codeTarget: async (_key: unknown, id: string) => ({
				absolute: join(root, id),
				projectRoot: root,
				readOnly: false,
				locked: false,
			}),
			onClosed: null,
		} as unknown as Files;
		const bridge = new CodeIntelBridge(
			stub,
			resolve('apps/desktop/out/services'),
			new Syntax(resolve('apps/desktop/out/services/syntax.cjs')),
			() => {},
			{ settings: async () => settings, project: async () => project }
		);
		const key = { projectId: 'p', id: 't' };
		try {
			await bridge.openCode(key, 'a.ts', files['a.ts']!);
			expect(await bridge.formatInfo(key, 'a.ts')).toEqual({ source: 'prettier', onSave: true });
			expect(await bridge.format(key, 'a.ts', 0, 'save')).toEqual({
				status: 'formatted',
				source: 'prettier',
				version: 0,
				edits: [{ from: 6, to: 14, insert: "a = 'x'" }],
			});
			expect(await bridge.format(key, 'a.ts', 4, 'save')).toEqual({
				status: 'skipped',
				reason: 'stale',
			});
			settings = { ...defaultAppSettings, editor: { ...defaultAppSettings.editor, format: 'off' } };
			expect(await bridge.format(key, 'a.ts', 0, 'save')).toEqual({
				status: 'skipped',
				reason: 'off',
			});
			expect((await bridge.format(key, 'a.ts', 0, 'command')).status).toBe('formatted');
			expect(await bridge.formatInfo(key, 'a.ts')).toEqual({ source: 'prettier', onSave: false });
			project = { ...project, formatter: 'language-server' };
			expect(await bridge.format(key, 'a.ts', 0, 'save')).toMatchObject({
				status: 'formatted',
				source: 'language-server',
			});
			expect(await bridge.formatInfo(key, 'a.ts')).toEqual({
				source: 'language-server',
				onSave: true,
			});
			project = { ...project, formatter: 'auto' };
			await bridge.openCode(key, 'gen.ts', files['gen.ts']!);
			expect(await bridge.format(key, 'gen.ts', 0, 'save')).toEqual({
				status: 'skipped',
				reason: 'ignored',
			});
			expect(await bridge.formatInfo(key, 'gen.ts')).toEqual({ source: null, onSave: true });
			await rm(join(root, 'node_modules'), { recursive: true });
			project = { ...project, formatter: 'prettier' };
			expect(await bridge.format(key, 'a.ts', 0, 'save')).toEqual({
				status: 'skipped',
				reason: 'not-found',
			});
		} finally {
			await bridge.dispose();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
