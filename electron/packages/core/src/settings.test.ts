import { describe, expect, it } from 'vitest';
import {
	accentColors,
	accentFillNeedsDarkText,
	defaultAppSettings,
	editorTypingKeys,
	isAppSettings,
} from './settings';
import { isProject } from './workspace';
import { isKeepAwakeStatus, keepAwakeLabel } from './keep-awake';
describe('accent setting (spec/appearance#accent)', () => {
	it('offers eight colours in swatch order, following the system by default', () => {
		expect(accentColors).toEqual([
			'system',
			'blue',
			'indigo',
			'purple',
			'pink',
			'teal',
			'yellow',
			'graphite',
		]);
		expect(defaultAppSettings.accent).toBe('system');
		for (const accent of accentColors)
			expect(isAppSettings({ ...defaultAppSettings, accent })).toBe(true);
		for (const accent of ['red', 'orange', 'green', '', null, undefined, '#f8c500'])
			expect(isAppSettings({ ...defaultAppSettings, accent })).toBe(false);
	});
	it('puts dark text on a system accent fill only when white loses 3:1', () => {
		expect(accentFillNeedsDarkText('007affff')).toBe(false);
		expect(accentFillNeedsDarkText('0a84ff')).toBe(false);
		expect(accentFillNeedsDarkText('8c8c8cff')).toBe(false);
		expect(accentFillNeedsDarkText('ffc600ff')).toBe(true);
		expect(accentFillNeedsDarkText('f8c500')).toBe(true);
		expect(accentFillNeedsDarkText('not-a-colour')).toBe(false);
	});
});
describe('diff base (spec/diff-and-review#diff-base)', () => {
	it('is the task start by default, task or head only', () => {
		expect(defaultAppSettings.editor.diffBase).toBe('task');
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, diffBase: 'head' },
			})
		).toBe(true);
		for (const diffBase of ['HEAD', 'index', null, 1])
			expect(
				isAppSettings({ ...defaultAppSettings, editor: { ...defaultAppSettings.editor, diffBase } })
			).toBe(false);
	});
});
describe('indentation (spec/editor#indentation)', () => {
	it('is automatic, 2 spaces a level and 4 columns a tab by default; styles and widths are validated', () => {
		expect(defaultAppSettings.editor).toMatchObject({
			indentStyle: 'auto',
			indentSize: 2,
			tabWidth: 'auto',
		});
		for (const patch of [
			{ indentStyle: 'tabs' },
			{ indentStyle: 'spaces', indentSize: 8 },
			{ tabWidth: 2 },
			{ tabWidth: 16 },
			{ tabWidth: 'auto' },
		])
			expect(
				isAppSettings({ ...defaultAppSettings, editor: { ...defaultAppSettings.editor, ...patch } })
			).toBe(true);
		for (const patch of [
			{ indentStyle: 'mixed' },
			{ indentSize: 0 },
			{ indentSize: 17 },
			{ tabWidth: 2.5 },
			{ tabWidth: '4' },
			{ tabWidth: 'wide' },
			{ indentSize: null },
		])
			expect(
				isAppSettings({ ...defaultAppSettings, editor: { ...defaultAppSettings.editor, ...patch } })
			).toBe(false);
		for (const key of ['indentStyle', 'indentSize', 'tabWidth'] as const) {
			const { [key]: _, ...missing } = defaultAppSettings.editor;
			expect(isAppSettings({ ...defaultAppSettings, editor: missing })).toBe(false);
		}
	});
});
describe('typing aids and language servers (spec/editor-code-intelligence#typing-help)', () => {
	it('are all on by default and booleans only', () => {
		expect(defaultAppSettings.editor).toEqual({
			format: 'auto',
			diffBase: 'task',
			codeTheme: 'brigadir',
			lineAuthor: true,
			syntaxStyles: true,
			indentStyle: 'auto',
			indentSize: 2,
			tabWidth: 'auto',
			languageServers: true,
			closeBrackets: true,
			closeTags: true,
			callParens: true,
		});
		// spec/editor#line-author: the line author is on by default and a boolean only.
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, lineAuthor: false },
			})
		).toBe(true);
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, lineAuthor: 'on' },
			})
		).toBe(false);
		// spec/editor-code-intelligence#font-styles: font styles in the highlighting are a boolean apart from the code theme.
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, syntaxStyles: false },
			})
		).toBe(true);
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, syntaxStyles: 'bold' },
			})
		).toBe(false);
		for (const key of editorTypingKeys) {
			expect(
				isAppSettings({
					...defaultAppSettings,
					editor: { ...defaultAppSettings.editor, [key]: false },
				})
			).toBe(true);
			expect(
				isAppSettings({
					...defaultAppSettings,
					editor: { ...defaultAppSettings.editor, [key]: 'off' },
				})
			).toBe(false);
			const { [key]: _, ...missing } = defaultAppSettings.editor;
			expect(isAppSettings({ ...defaultAppSettings, editor: missing })).toBe(false);
		}
	});
});
describe('format on save (spec/editor-code-intelligence#format-on-save)', () => {
	it('is on by default, auto or off only, and a project may override it', () => {
		expect(defaultAppSettings.editor).toMatchObject({ format: 'auto', diffBase: 'task' });
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, format: 'off' },
			})
		).toBe(true);
		for (const editor of [
			{ ...defaultAppSettings.editor, format: 'prettier' },
			{},
			{ format: 'auto' },
			{ ...defaultAppSettings.editor, extra: 1 },
			null,
		])
			expect(isAppSettings({ ...defaultAppSettings, editor })).toBe(false);
		const project = { id: 'p', name: 'choice', path: '/Users/a/choice' };
		for (const formatter of [undefined, 'default', 'auto', 'prettier', 'language-server', 'off'])
			expect(isProject({ ...project, ...(formatter ? { formatter } : {}) })).toBe(true);
		expect(isProject({ ...project, formatter: 'biome' })).toBe(false);
	});
});
describe('intro settings (spec/settings-modules-and-onboarding#settings-keys)', () => {
	it('defaults to both agents on, no isolation, the board, the Brigadir keymap and an unseen intro', () => {
		expect(defaultAppSettings.agents).toMatchObject({
			enabled: { claude: true, codex: true },
			isolation: 'in-place',
		});
		expect(defaultAppSettings.projects).toEqual({ defaultView: 'board' });
		expect(defaultAppSettings.keymap).toEqual({ preset: 'brigadir', overrides: {} });
		expect(defaultAppSettings.onboarding).toEqual({ completedVersion: null });
		expect(defaultAppSettings.editor.codeTheme).toBe('brigadir');
	});
	it('keeps at least one agent on, and the default agent among them', () => {
		const agents = defaultAppSettings.agents;
		expect(
			isAppSettings({
				...defaultAppSettings,
				agents: { ...agents, provider: 'codex', enabled: { claude: false, codex: true } },
			})
		).toBe(true);
		expect(
			isAppSettings({
				...defaultAppSettings,
				agents: { ...agents, enabled: { claude: false, codex: false } },
			})
		).toBe(false);
		expect(
			isAppSettings({
				...defaultAppSettings,
				agents: { ...agents, provider: 'claude', enabled: { claude: false, codex: true } },
			})
		).toBe(false);
		expect(isAppSettings({ ...defaultAppSettings, agents: { ...agents, isolation: 'copy' } })).toBe(
			false
		);
	});
	it('accepts only known code themes, project views and intro versions', () => {
		for (const codeTheme of ['brigadir', 'vscode', 'intellij'])
			expect(
				isAppSettings({
					...defaultAppSettings,
					editor: { ...defaultAppSettings.editor, codeTheme },
				})
			).toBe(true);
		expect(
			isAppSettings({
				...defaultAppSettings,
				editor: { ...defaultAppSettings.editor, codeTheme: 'dracula' },
			})
		).toBe(false);
		expect(isAppSettings({ ...defaultAppSettings, projects: { defaultView: 'list' } })).toBe(true);
		expect(isAppSettings({ ...defaultAppSettings, projects: { defaultView: 'grid' } })).toBe(false);
		expect(isAppSettings({ ...defaultAppSettings, onboarding: { completedVersion: 1 } })).toBe(
			true
		);
		for (const completedVersion of [0, 1.5, '1'])
			expect(isAppSettings({ ...defaultAppSettings, onboarding: { completedVersion } })).toBe(
				false
			);
	});
});
describe('keep awake (spec/architecture-and-platform#keep-awake)', () => {
	it('the «Mac sleep» line names the working agents in four Ukrainian forms and stays away while nobody works or the switch is off', () => {
		const line = (working: number, locale: 'uk' | 'en' = 'uk', enabled = true) =>
			keepAwakeLabel(locale, { working, holding: working > 0 }, enabled);
		expect(line(1)).toBe('У роботі: 1 агент');
		expect(line(3)).toBe('У роботі: 3 агенти');
		expect(line(5)).toBe('У роботі: 5 агентів');
		expect(line(21)).toBe('У роботі: 21 агент');
		expect(line(2, 'en')).toBe('Working: 2 agents');
		expect(line(0)).toBeNull();
		expect(line(2, 'uk', false)).toBeNull();
		expect(keepAwakeLabel('uk', null, true)).toBeNull();
		expect(isKeepAwakeStatus({ working: 2, holding: true })).toBe(true);
		for (const value of [
			null,
			{},
			{ working: -1, holding: true },
			{ working: 1.5, holding: false },
			{ working: 1, holding: 'yes' },
			{ working: 1, holding: true, extra: 1 },
		])
			expect(isKeepAwakeStatus(value)).toBe(false);
	});
});
