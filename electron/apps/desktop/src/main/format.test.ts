import { describe, expect, it } from 'vitest';
import { defaultAppSettings, type CodeChange } from '@brigadir/core';
import { formatEdits, formatMode } from './format';
const apply = (text: string, edits: CodeChange[]) =>
	[...edits]
		.reverse()
		.reduce((value, edit) => value.slice(0, edit.from) + edit.insert + value.slice(edit.to), text);
describe('format edits (spec/editor-code-intelligence#format-on-save)', () => {
	it.each([
		['one line', 'const  a = "x"\nconst b = 1;\n', "const a = 'x';\nconst b = 1;\n"],
		['lines added and removed', 'a\nb\nc\nd\n', 'a\nb2\nb3\nd\n'],
		['no final newline', 'x', 'x\n'],
		['everything', 'function f(){return 1}', 'function f() {\n\treturn 1;\n}\n'],
		['empty', '', ''],
	])('rebuild the formatted text: %s', (_name, before, after) => {
		const edits = formatEdits(before, after);
		expect(apply(before, edits)).toBe(after);
		for (let i = 1; i < edits.length; i++)
			expect(edits[i]!.from).toBeGreaterThanOrEqual(edits[i - 1]!.to);
	});
	it('touches only the changed characters, so the cursor and review marks elsewhere stay', () => {
		const before = 'import a from "a";\n\nexport const x = 1;\nexport const y = "y";\n';
		const edits = formatEdits(before, before.replace(/"/g, "'"));
		expect(edits).toEqual([
			{ from: 14, to: 17, insert: "'a'" },
			{ from: 57, to: 60, insert: "'y'" },
		]);
		expect(formatEdits(before, before)).toEqual([]);
	});
});
describe('format mode', () => {
	const off = {
		...defaultAppSettings,
		editor: { ...defaultAppSettings.editor, format: 'off' as const },
	};
	it('follows the global switch unless the project overrides it; the command tries even when saving is off', () => {
		expect(formatMode(defaultAppSettings, undefined, 'save')).toBe('auto');
		expect(formatMode(off, 'default', 'save')).toBe('off');
		expect(formatMode(off, 'default', 'command')).toBe('auto');
		expect(formatMode(off, 'prettier', 'save')).toBe('prettier');
		expect(formatMode(defaultAppSettings, 'off', 'save')).toBe('off');
		expect(formatMode(defaultAppSettings, 'language-server', 'command')).toBe('language-server');
	});
});
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { readFormatters, setProjectFormatter } from './format';
describe('project formatter choice (spec/editor-code-intelligence#editor-settings)', () => {
	it('stores the override in project.json, drops it for «As default» and reports the root Prettier', async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-formatters-')));
		try {
			const repo = join(dir, 'repo');
			await mkdir(join(repo, 'node_modules/prettier'), { recursive: true });
			await writeFile(join(repo, 'node_modules/prettier/package.json'), '{"version":"3.9.5"}');
			const data = join(dir, 'data');
			const project = await (await SessionStore.at(data)).addProject(repo);
			expect(await readFormatters(data)).toEqual([
				{
					projectId: project.id,
					name: 'repo',
					formatter: 'default',
					prettier: '3.9.5',
					indent: null,
				},
			]);
			// spec/editor#indentation: the indentation of the project's config comes with the row; a slow answer is left out, not waited for.
			const answer = { source: 'editorconfig', useTabs: true } as const;
			expect((await readFormatters(data, async () => answer))[0]?.indent).toEqual(answer);
			expect(
				(
					await readFormatters(data, async () => {
						throw new Error('x');
					})
				)[0]?.indent
			).toBeNull();
			expect((await setProjectFormatter(data, project.id, 'language-server'))[0]?.formatter).toBe(
				'language-server'
			);
			expect((await (await SessionStore.at(data)).project(project.id)).formatter).toBe(
				'language-server'
			);
			await setProjectFormatter(data, project.id, 'default');
			expect('formatter' in (await (await SessionStore.at(data)).project(project.id))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
