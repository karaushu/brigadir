import { describe, expect, it } from 'vitest';
import {
	clipLine,
	defaultAppSettings,
	defaultKeymap,
	defaultModules,
	emptyMenuContext,
	isTextSearchRequest,
	keymapConflicts,
	keymapPresets,
	maskMatcher,
	matchRanges,
	matchScore,
	menuCommands,
	parseGrepLine,
	searchActions,
	searchCount,
	searchPullRequests,
	searchSettings,
	settingLocation,
	textPattern,
	textSearchReady,
	toggleSetting,
	visibleSearchTabs,
	type PullRequestSummary,
} from './index';

const pr = (number: number, patch: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/o/r/pull/${number}`,
	state: 'OPEN',
	author: 'olena',
	mine: false,
	waiting: false,
	head: `feat/${number}`,
	base: 'main',
	updatedAt: '2026-10-06T10:00:00Z',
	closedAt: null,
	reviewDecision: null,
	reviewers: [],
	comments: 0,
	checks: 'none',
	...patch,
});

describe('spec/search-menus-and-commands#search-tabs Search Everywhere', () => {
	it('shows every tab in order and drops PR and Commands with their modules', () => {
		expect(visibleSearchTabs(defaultModules)).toEqual([
			'all',
			'agents',
			'files',
			'text',
			'prs',
			'commands',
			'actions',
		]);
		expect(visibleSearchTabs({ ...defaultModules, pullRequests: false, commands: false })).toEqual([
			'all',
			'agents',
			'files',
			'text',
			'actions',
		]);
	});
	it('waits for three characters of text in All and one on Text', () => {
		expect(textSearchReady('fo', 'all')).toBe(false);
		expect(textSearchReady('foc', 'all')).toBe(true);
		expect(textSearchReady('f', 'text')).toBe(true);
		expect(textSearchReady('  ', 'text')).toBe(false);
		expect(textSearchReady('focus', 'files')).toBe(false);
	});
	it('ranks a prefix before a word start before anywhere', () => {
		expect(matchScore('Focus composer', 'focus')).toBe(0);
		expect(matchScore('Show focus', 'focus')).toBe(1);
		expect(matchScore('unfocused', 'focus')).toBe(2);
		expect(matchScore('Diff', 'focus')).toBeNull();
	});
	it('finds menu actions in both languages, leaves out its own items and the disabled ones', () => {
		const context = { ...emptyMenuContext, task: true, project: true, font: true };
		const uk = searchActions('шрифт', {
			context,
			modules: defaultModules,
			keymap: defaultKeymap,
			locale: 'uk',
		});
		expect(uk.map((item) => item.id)).toEqual(
			expect.arrayContaining(['font-increase', 'font-decrease', 'font-reset'])
		);
		expect(uk.find((item) => item.id === 'font-increase')).toMatchObject({
			group: 'Вигляд',
			shortcut: '⌘+',
			matchedEnglish: false,
		});
		const english = searchActions('composer', {
			context,
			modules: defaultModules,
			keymap: defaultKeymap,
			locale: 'uk',
		}).find((item) => item.id === 'composer');
		expect(english).toMatchObject({
			matchedEnglish: true,
			english: 'Focus composer',
			shortcut: '⌘L',
		});
		const all = searchActions('', {
			context,
			modules: defaultModules,
			keymap: defaultKeymap,
			locale: 'en',
		}).map((item) => item.id);
		for (const own of ['search', 'find-in-files', 'find-action', 'quick-open', 'commands'])
			expect(all).not.toContain(own);
		expect(all).not.toContain('diff-toggle');
		expect(
			searchActions('', {
				context: { ...context, modal: true },
				modules: { ...defaultModules, pullRequests: false },
				keymap: defaultKeymap,
				locale: 'en',
			}).map((item) => item.id)
		).not.toContain('pull-requests');
	});
	it('gives the new File items their shortcuts and moves the task filter, with no preset conflicts', () => {
		const key = (id: string) => menuCommands.find((item) => item.id === id)?.accelerator;
		expect([key('find-in-files'), key('find-action'), key('sidebar-filter')]).toEqual([
			'CmdOrCtrl+Shift+F',
			'CmdOrCtrl+Shift+A',
			'CmdOrCtrl+Alt+Shift+F',
		]);
		for (const preset of keymapPresets)
			expect(keymapConflicts({ preset, overrides: {} })).toEqual([]);
	});
	it('finds settings with their path, value and switch, and toggles a switch', () => {
		const settings = defaultAppSettings;
		const font = searchSettings('шрифт', settings, 'uk');
		expect(font.find((item) => item.id === 'interface-font')).toMatchObject({
			label: 'Шрифт',
			path: 'Налаштування ▸ Вигляд ▸ Інтерфейс',
			value: 'Geist',
			toggle: null,
		});
		// spec/appearance#evolution-redesign: the OS font is a choice of its own, under its own name.
		expect(
			searchSettings(
				'шрифт',
				{ ...settings, interfaceFont: { ...settings.interfaceFont, family: 'system-ui' } },
				'uk'
			).find((item) => item.id === 'interface-font')?.value
		).toBe('Системний шрифт');
		expect(font.find((item) => item.id === 'editor-font')?.value).toBe('Geist Mono');
		expect(
			searchSettings('ligatures', settings, 'uk').find((item) => item.id === 'editor-ligatures')
		).toMatchObject({ toggle: true, path: 'Налаштування ▸ Вигляд ▸ Редактор' });
		expect(toggleSetting('editor-ligatures', settings)?.typography.editor.ligatures).toBe(false);
		expect(toggleSetting('module-browser', settings)?.modules.browser).toBe(false);
		expect(
			toggleSetting('agent-claude', {
				...settings,
				agents: { ...settings.agents, enabled: { claude: true, codex: false } },
			})
		).toBeNull();
		expect(toggleSetting('theme', settings)).toBeNull();
		expect(settingLocation('keep-awake', 'uk')).toMatchObject({ tab: 'agents', section: 'Агенти' });
	});
	it('finds PR by number, title, author and branch, in the panel groups', () => {
		const now = Date.parse('2026-10-06T12:00:00Z');
		const repos = [
			{
				scopeId: 'root',
				name: 'choice',
				prs: [
					pr(421, { waiting: true, title: 'Loyalty in admin' }),
					pr(417, { mine: true, state: 'DRAFT', title: 'Admin flag' }),
					pr(342, {
						state: 'MERGED',
						closedAt: '2026-10-05T10:00:00Z',
						title: 'Old importer',
						author: 'ihor',
					}),
				],
			},
		];
		expect(searchPullRequests('#421', repos, now).map((hit) => hit.pr.number)).toEqual([421]);
		expect(searchPullRequests('42', repos, now).map((hit) => hit.pr.number)).toEqual([421, 342]);
		expect(
			searchPullRequests('admin', repos, now).map((hit) => [hit.pr.number, hit.group])
		).toEqual([
			[421, 'waiting'],
			[417, 'mine'],
		]);
		expect(searchPullRequests('ihor', repos, now).map((hit) => hit.group)).toEqual(['closed']);
		expect(searchPullRequests('feat/417', repos, now).map((hit) => hit.pr.number)).toEqual([417]);
	});
	it('builds the text pattern from the options and rejects a broken expression', () => {
		const ranges = (query: string, line: string, options = {}) => {
			const pattern = textPattern({
				query,
				caseSensitive: false,
				wholeWord: false,
				regex: false,
				...options,
			});
			return pattern && matchRanges(line, pattern);
		};
		expect(ranges('focus', 'focusRing and Focus')).toEqual([
			[0, 5],
			[14, 19],
		]);
		expect(ranges('focus', 'focusRing and Focus', { caseSensitive: true })).toEqual([[0, 5]]);
		expect(ranges('focus', 'focusRing and focus', { wholeWord: true })).toEqual([[14, 19]]);
		expect(ranges('a.c', 'abc a.c')).toEqual([[4, 7]]);
		expect(ranges('a.c', 'abc a.c', { regex: true })).toEqual([
			[0, 3],
			[4, 7],
		]);
		expect(
			textPattern({ query: '(', caseSensitive: false, wholeWord: false, regex: true })
		).toBeNull();
		expect(
			isTextSearchRequest({
				query: 'x',
				caseSensitive: false,
				wholeWord: false,
				regex: false,
				mask: '',
				repo: null,
			})
		).toBe(true);
		expect(
			isTextSearchRequest({
				query: '',
				caseSensitive: false,
				wholeWord: false,
				regex: false,
				mask: '',
				repo: null,
			})
		).toBe(false);
		expect(
			isTextSearchRequest({
				query: 'a\nb',
				caseSensitive: false,
				wholeWord: false,
				regex: false,
				mask: '',
				repo: null,
			})
		).toBe(false);
	});
	it('reads masks: globs by name or path, «!» excludes', () => {
		const css = maskMatcher('*.css');
		expect(css('kit/src/Button.module.css')).toBe(true);
		expect(css('kit/src/Button.tsx')).toBe(false);
		const ts = maskMatcher('*.ts, !*.test.ts');
		expect(ts('a/b.ts')).toBe(true);
		expect(ts('a/b.test.ts')).toBe(false);
		expect(maskMatcher('apps/**/hooks/*.ts')('apps/admin/src/hooks/useX.ts')).toBe(true);
		expect(maskMatcher('')('anything')).toBe(true);
	});
	it('parses rg and git grep output with NUL after the path', () => {
		expect(parseGrepLine('kit/a:b.css\u000041:  &:focus-visible {')).toEqual({
			path: 'kit/a:b.css',
			line: 41,
			text: '  &:focus-visible {',
		});
		expect(parseGrepLine('kit/a.css\u000041\u0000x:y')).toEqual({
			path: 'kit/a.css',
			line: 41,
			text: 'x:y',
		});
		expect(parseGrepLine('Binary file matches')).toBeNull();
	});
	it('clips a long line around its first match', () => {
		const line = `${'x'.repeat(500)}focus${'y'.repeat(500)}`;
		const clipped = clipLine(line, [[500, 505]], 100);
		expect(clipped.text).toHaveLength(100);
		expect(clipped.text.slice(clipped.ranges[0]![0], clipped.ranges[0]![1])).toBe('focus');
	});
	it('counts in four Ukrainian forms', () => {
		expect([1, 3, 5, 21].map((n) => searchCount('uk', 'match', n))).toEqual([
			'1 збіг',
			'3 збіги',
			'5 збігів',
			'21 збіг',
		]);
		expect([1, 3, 5].map((n) => searchCount('uk', 'file-in', n))).toEqual([
			'1 файлі',
			'3 файлах',
			'5 файлах',
		]);
		expect(searchCount('uk', 'match', 1.5)).toBe('1,5 збігу');
		expect(searchCount('en', 'file', 2)).toBe('2 files');
	});
});
