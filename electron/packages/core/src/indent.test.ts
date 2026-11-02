import { expect, it } from 'vitest';
import { detectIndent, indentUnitString, resolveIndent, type IndentSettings } from './indent';
import { editorConfigGlob, editorConfigIndent, parseEditorConfig } from './editorconfig';
const settings: IndentSettings = { indentStyle: 'auto', indentSize: 2, tabWidth: 'auto' };
it('detects tabs, the common space rise and ignores block comment stars', () => {
	expect(detectIndent('a\n\tb\n\t\tc\n')).toEqual({ style: 'tabs', size: null });
	expect(detectIndent('a\n    b\n        c\n    d\n')).toEqual({ style: 'spaces', size: 4 });
	expect(detectIndent('/**\n * doc\n */\na\n  b\n')).toEqual({ style: 'spaces', size: 2 });
	expect(detectIndent('a\n      b\n')).toEqual({ style: 'spaces', size: 6 });
	expect(detectIndent('a\n  b\n    c\n  d\n    e\n')?.size).toBe(2);
	expect(detectIndent('flat\nlines\n')).toBeNull();
	expect(detectIndent('\n\n  \n')).toBeNull();
});
it('resolves the style: project config, then an explicit choice, then the content, then spaces', () => {
	const tabs = { source: 'prettier', useTabs: true, tabWidth: 8 } as const;
	expect(
		resolveIndent({
			settings: { ...settings, indentStyle: 'spaces' },
			project: tabs,
			detected: { style: 'spaces', size: 2 },
		})
	).toMatchObject({
		insertSpaces: false,
		tabWidth: 8,
		indentSize: 8,
		styleSource: 'prettier',
		widthSource: 'prettier',
	});
	expect(
		resolveIndent({
			settings: { ...settings, indentStyle: 'tabs' },
			detected: { style: 'spaces', size: 2 },
		})
	).toMatchObject({ insertSpaces: false, tabWidth: 4, configTabWidth: 4, styleSource: 'setting' });
	expect(resolveIndent({ settings, detected: { style: 'tabs', size: null } })).toMatchObject({
		insertSpaces: false,
		styleSource: 'detected',
	});
	expect(resolveIndent({ settings, detected: null })).toMatchObject({
		insertSpaces: true,
		indentSize: 2,
		styleSource: 'default',
	});
});
it('resolves the size: project config, explicit spaces, the content, the language, the setting', () => {
	const detected = { style: 'spaces', size: 4 } as const;
	expect(
		resolveIndent({ settings, project: { source: 'editorconfig', indentSize: 3 }, detected })
	).toMatchObject({ indentSize: 3, sizeSource: 'editorconfig', styleSource: 'detected' });
	expect(
		resolveIndent({ settings, project: { source: 'prettier', tabWidth: 8 }, detected })
	).toMatchObject({ indentSize: 8, tabWidth: 8, insertSpaces: true });
	expect(
		resolveIndent({ settings: { ...settings, indentStyle: 'spaces', indentSize: 6 }, detected })
	).toMatchObject({ indentSize: 6, sizeSource: 'setting' });
	expect(resolveIndent({ settings, detected })).toMatchObject({
		indentSize: 4,
		sizeSource: 'detected',
	});
	expect(resolveIndent({ settings, detected: null, languageSize: 4 })).toMatchObject({
		indentSize: 4,
		sizeSource: 'default',
	});
	expect(resolveIndent({ settings: { ...settings, indentSize: 8 }, detected: null })).toMatchObject(
		{ indentSize: 8 }
	);
	expect(indentUnitString(resolveIndent({ settings, detected }))).toBe('    ');
	expect(
		indentUnitString(resolveIndent({ settings, detected: { style: 'tabs', size: null } }))
	).toBe('\t');
});
it('keeps the tab width of a project that gives only a width while the content decides tabs', () => {
	expect(
		resolveIndent({
			settings,
			project: { source: 'prettier', tabWidth: 2 },
			detected: { style: 'tabs', size: null },
		})
	).toMatchObject({
		insertSpaces: false,
		tabWidth: 2,
		indentSize: 2,
		styleSource: 'detected',
		widthSource: 'prettier',
	});
});
it('shows a tab at the width the author picked, whatever the project says, while formatting keeps the project width (spec/editor#indentation)', () => {
	const project = { source: 'prettier', useTabs: true, tabWidth: 4 } as const;
	expect(resolveIndent({ settings: { ...settings, tabWidth: 2 }, project })).toMatchObject({
		insertSpaces: false,
		tabWidth: 2,
		configTabWidth: 4,
		widthSource: 'setting',
		styleSource: 'prettier',
	});
	expect(resolveIndent({ settings, project })).toMatchObject({
		tabWidth: 4,
		configTabWidth: 4,
		widthSource: 'prettier',
	});
	expect(resolveIndent({ settings, detected: { style: 'tabs', size: null } })).toMatchObject({
		tabWidth: 4,
		widthSource: 'default',
	});
	expect(
		resolveIndent({
			settings: { ...settings, tabWidth: 8 },
			project: { source: 'prettier', useTabs: false, tabWidth: 2 },
		})
	).toMatchObject({ insertSpaces: true, indentSize: 2, tabWidth: 8, configTabWidth: 2 });
});
it('parses .editorconfig and matches its globs', () => {
	const config = parseEditorConfig(
		'# c\nroot = true\n\n[*]\nindent_style = tab ; inline\n[*.{ts,tsx}]\nindent_size = 2\n'
	);
	expect(config.root).toBe(true);
	expect(config.sections).toEqual([
		{ glob: '*', props: { indent_style: 'tab' } },
		{ glob: '*.{ts,tsx}', props: { indent_size: '2' } },
	]);
	for (const [glob, path, expected] of [
		['*.py', 'a/b/c.py', true],
		['*.py', 'c.pyc', false],
		['*.{ts,tsx}', 'src/x.tsx', true],
		['src/**.js', 'src/a/b.js', true],
		['/lib/*.js', 'lib/a.js', true],
		['/lib/*.js', 'x/lib/a.js', false],
		['lib/*.js', 'lib/a/b.js', false],
		['{package.json,.travis.yml}', 'package.json', true],
		['[ab].txt', 'a.txt', true],
		['[!ab].txt', 'a.txt', false],
		['file{1..3}.md', 'file2.md', true],
		['file{1..3}.md', 'file4.md', false],
		['*', '.hidden', true],
	] as const)
		expect([glob, path, editorConfigGlob(glob).test(path)]).toEqual([glob, path, expected]);
});
it('reads indentation from .editorconfig, nearest file last, root stops the climb, tab sizes', () => {
	const inner = '[*.py]\nindent_size = 4\n';
	const outer = 'root = true\n[*]\nindent_style = space\nindent_size = 2\n';
	expect(
		editorConfigIndent([
			{ text: inner, relative: 'a.py' },
			{ text: outer, relative: 'pkg/a.py' },
		])
	).toEqual({ source: 'editorconfig', useTabs: false, tabWidth: 4, indentSize: 4 });
	expect(
		editorConfigIndent([
			{ text: inner, relative: 'a.ts' },
			{ text: outer, relative: 'pkg/a.ts' },
		])
	).toEqual({ source: 'editorconfig', useTabs: false, tabWidth: 2, indentSize: 2 });
	expect(
		editorConfigIndent([
			{ text: '[*]\nindent_style = space\n', relative: 'a.ts' },
			{ text: '[*]\nindent_style = tab\n', relative: 'x/a.ts' },
			{ text: 'root = true\n[*]\nindent_size = 8\n', relative: 'y/x/a.ts' },
		])
	).toEqual({ source: 'editorconfig', useTabs: false, tabWidth: 8, indentSize: 8 });
	expect(
		editorConfigIndent([
			{ text: '[*]\nindent_style = tab\nindent_size = tab\ntab_width = 3\n', relative: 'a.go' },
		])
	).toEqual({ source: 'editorconfig', useTabs: true, tabWidth: 3, indentSize: 3 });
	expect(editorConfigIndent([{ text: '[*]\nindent_style = tab\n', relative: 'a.go' }])).toEqual({
		source: 'editorconfig',
		useTabs: true,
	});
	expect(editorConfigIndent([{ text: '[*.md]\nindent_size = 2\n', relative: 'a.ts' }])).toBeNull();
	expect(
		editorConfigIndent([
			{ text: '[*]\nindent_size = 99\nindent_style = unset\n', relative: 'a.ts' },
		])
	).toBeNull();
});
