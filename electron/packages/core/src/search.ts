import { isRecord } from './workspace';
import { t, type Locale, type MessageKey } from './messages';
import { menuCommands, menuCommandEnabled, type MenuContext } from './menu';
import { commandAccelerator, formatAccelerator, type KeymapSettings } from './keymap';
import { commandModule, type AppModules } from './modules';
import { agentProviders, maxConcurrentLimit, type AppSettings } from './settings';
import { fontFamilyChoice, shownChatSize } from './typography';
import { prGroups, type PRGroup, type PullRequestSummary } from './pull-requests';

/** spec/search-menus-and-commands#search-tabs: the tabs of Search Everywhere, in strip order; PR and Commands follow their modules (spec/settings-modules-and-onboarding#module-off). */
export const searchTabs = ['all', 'agents', 'files', 'text', 'prs', 'commands', 'actions'] as const;
export type SearchTab = (typeof searchTabs)[number];
export const searchTabLabels: Record<SearchTab, MessageKey> = {
	all: 'All',
	agents: 'Agents',
	files: 'Files',
	text: 'Text',
	prs: 'PR',
	commands: 'Commands',
	actions: 'Actions',
};
export function visibleSearchTabs(
	modules: Pick<AppModules, 'pullRequests' | 'commands'>
): SearchTab[] {
	return searchTabs.filter((tab) =>
		tab === 'prs' ? modules.pullRequests : tab === 'commands' ? modules.commands : true
	);
}
/** spec/search-menus-and-commands#search-tabs: groups of «All» in a fixed order, the slow text last; at most three rows in each. */
export const allGroups = ['agents', 'files', 'actions', 'prs', 'commands', 'text'] as const;
export type AllGroup = (typeof allGroups)[number];
export const allGroupLimit = 3;
/** spec/search-menus-and-commands#search-tabs: text in «All» waits for three characters, on its own tab for one. */
export function textSearchReady(query: string, tab: SearchTab): boolean {
	const length = query.trim().length;
	return tab === 'all' ? length >= 3 : tab === 'text' ? length >= 1 : false;
}
export const textSearchDelay = 250;

/** A substring match, case-insensitive: where it starts, or -1. */
export function matchAt(text: string, query: string): number {
	const needle = query.trim().toLocaleLowerCase();
	return needle ? text.toLocaleLowerCase().indexOf(needle) : 0;
}
/** Lower is better: a prefix, then a word start, then anywhere; null when there is no match. */
export function matchScore(text: string, query: string): number | null {
	const at = matchAt(text, query);
	if (at < 0) return null;
	if (at === 0) return 0;
	return /[\s\-_./:(«]/.test(text[at - 1] ?? '') ? 1 : 2;
}

/** spec/search-menus-and-commands#search-tabs: a menu item as a row of «Actions». */
export type ActionEntry = {
	id: string;
	label: string;
	english: string;
	group: string;
	shortcut: string | null;
	score: number;
	matchedEnglish: boolean;
};
/** Items that open this very modal stay out of its list. */
const selfActions = new Set([
	'search',
	'find-in-files',
	'find-action',
	'quick-open',
	'quick-open-alias',
	'commands',
]);
export function searchActions(
	query: string,
	{
		context,
		modules,
		keymap,
		locale,
	}: { context: MenuContext; modules: AppModules; keymap: KeymapSettings; locale: Locale }
): ActionEntry[] {
	const free = { ...context, modal: false };
	const out: ActionEntry[] = [];
	for (const command of menuCommands) {
		if (selfActions.has(command.id)) continue;
		const module = commandModule(command.id);
		if (module && !modules[module]) continue;
		if (!menuCommandEnabled(command, free)) continue;
		// spec/search-menus-and-commands#project-commands keeps «Search Everywhere…» English in the menu; every other item reads in the interface language.
		const label = command.label === 'Search Everywhere…' ? command.label : t(locale, command.label),
			english = command.label;
		const own = matchScore(label, query),
			eng = locale === 'en' ? null : matchScore(english, query);
		const score = own ?? (eng === null ? null : eng + 0.5);
		if (score === null) continue;
		const key = commandAccelerator(command, keymap);
		out.push({
			id: command.id,
			label,
			english,
			group: t(locale, command.group),
			shortcut: key ? formatAccelerator(key) : null,
			score,
			matchedEnglish: own === null,
		});
	}
	return out.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label, locale));
}

/** spec/search-menus-and-commands#search-tabs: a row of the Settings form, by tab and section, with its value and, for a switch, the toggle. */
export const settingsTabs = [
	'appearance',
	'editor',
	'language',
	'notifications',
	'agents',
	'templates',
	'modules',
	'remote',
] as const;
export type SettingsTab = (typeof settingsTabs)[number];
const settingsTabLabels: Record<SettingsTab, MessageKey> = {
	appearance: 'Appearance',
	editor: 'Editor',
	language: 'Language',
	notifications: 'Notifications',
	agents: 'Agents',
	templates: 'Templates',
	modules: 'Modules',
	remote: 'Remote',
};
type Label = { key: MessageKey } | { raw: string };
type Toggle = {
	get(settings: AppSettings): boolean;
	set(settings: AppSettings, value: boolean): Partial<AppSettings> | null;
};
export type SettingDefinition = {
	id: string;
	tab: SettingsTab;
	section: MessageKey | null;
	label: Label;
	value?(settings: AppSettings): Label | null;
	toggle?: Toggle;
};
const key = (value: MessageKey): Label => ({ key: value }),
	raw = (value: string): Label => ({ raw: value });
/** spec/appearance#evolution-redesign: Geist for the default, «System font» / «System mono» for the OS font, else the family's own name. */
const fontLabel = (family: string | null, kind: 'sans' | 'mono'): Label => {
	const choice = fontFamilyChoice(family, kind);
	return choice.kind === 'system'
		? key(kind === 'sans' ? 'System font' : 'System mono')
		: raw(choice.name);
};
const typing = [
	['languageServers', 'Language servers'],
	['closeBrackets', 'Bracket pairs'],
	['closeTags', 'Closing tags'],
	['callParens', 'Call parentheses'],
] as const;
const surfaces = [
	['editor', 'Editor'],
	['diff', 'Diff'],
	['terminal', 'Terminal'],
] as const;
const moduleNames = [
	['browser', 'Browser'],
	['simulator', 'Simulator'],
	['pullRequests', 'Pull requests'],
	['commands', 'Commands'],
	['remoteAccess', 'Remote access'],
] as const;
export const settingDefinitions: readonly SettingDefinition[] = [
	{
		id: 'theme',
		tab: 'appearance',
		section: 'Appearance',
		label: key('Theme'),
		value: (s) =>
			key(s.appearance === 'system' ? 'System' : s.appearance === 'light' ? 'Light' : 'Dark'),
	},
	{ id: 'accent', tab: 'appearance', section: 'Appearance', label: key('Accent') },
	{
		id: 'toolbar-labels',
		tab: 'appearance',
		section: null,
		label: key('Toolbar labels'),
		value: (s) => key(s.toolbarLabels === 'icons' ? 'Icons only' : 'Icons and names'),
	},
	{
		id: 'task-columns',
		tab: 'appearance',
		section: null,
		label: key('Task layout'),
		value: (s) => key(s.taskColumns === 'two' ? 'Two columns' : 'Three columns'),
	},
	{
		id: 'tasks-view',
		tab: 'appearance',
		section: 'Tasks',
		label: key('View'),
		value: (s) => key(s.projects.defaultView === 'board' ? 'Board' : 'List'),
	},
	{
		id: 'interface-font',
		tab: 'appearance',
		section: 'Interface',
		label: key('Font'),
		value: (s) => fontLabel(s.interfaceFont.family, 'sans'),
	},
	{
		id: 'interface-size',
		tab: 'appearance',
		section: 'Interface',
		label: key('Size'),
		value: (s) => raw(String(s.interfaceFont.size)),
	},
	// spec/appearance#chat-text-size: the chat's own text size; a follower shows the interface's.
	{
		id: 'chat-size',
		tab: 'appearance',
		section: 'Chat',
		label: key('Size'),
		value: (s) => raw(String(shownChatSize(s.chatFont, s.interfaceFont))),
	},
	...surfaces.flatMap(([surface, title]): SettingDefinition[] => [
		{
			id: `${surface}-font`,
			tab: 'appearance',
			section: title,
			label: key('Font'),
			value: (s) => fontLabel(s.typography[surface].family, 'mono'),
		},
		{
			id: `${surface}-size`,
			tab: 'appearance',
			section: title,
			label: key('Size'),
			value: (s) => raw(String(s.typography[surface].size)),
		},
		...(surface === 'terminal'
			? [
					{
						id: 'terminal-scroll-speed',
						tab: 'appearance' as const,
						section: title,
						label: key('Scroll speed'),
						value: (s: AppSettings) => raw(String(s.terminal.scrollSpeed)),
					},
					{
						id: 'terminal-font-weight',
						tab: 'appearance' as const,
						section: title,
						label: key('Font weight'),
						value: (s: AppSettings) =>
							key(
								s.terminal.fontWeight === 300
									? 'Light weight'
									: s.terminal.fontWeight === 400
										? 'Regular'
										: s.terminal.fontWeight === 500
											? 'Medium'
											: 'Semibold'
							),
					},
				]
			: [
					{
						id: `${surface}-line-height`,
						tab: 'appearance' as const,
						section: title,
						label: key('Line height'),
						value: (s: AppSettings) => raw(String(s.typography[surface].lineHeight)),
					},
					{
						id: `${surface}-ligatures`,
						tab: 'appearance' as const,
						section: title,
						label: key('Ligatures'),
						toggle: {
							get: (s: AppSettings) => s.typography[surface].ligatures,
							set: (s: AppSettings, ligatures: boolean) => ({
								typography: { ...s.typography, [surface]: { ...s.typography[surface], ligatures } },
							}),
						},
					},
				]),
	]),
	{
		id: 'code-theme',
		tab: 'appearance',
		section: 'Editor',
		label: key('Code theme'),
		value: (s) =>
			s.editor.codeTheme === 'brigadir'
				? key('Brigadir')
				: raw(s.editor.codeTheme === 'vscode' ? 'VS Code' : 'IntelliJ'),
	},
	{
		id: 'keymap',
		tab: 'appearance',
		section: 'Keyboard',
		label: key('Keymap'),
		value: (s) =>
			s.keymap.preset === 'brigadir'
				? key('Brigadir')
				: raw(s.keymap.preset === 'vscode' ? 'VS Code' : 'IntelliJ'),
	},
	{
		id: 'diff-base',
		tab: 'editor',
		section: null,
		label: key('Diff base'),
		value: (s) => key(s.editor.diffBase === 'task' ? 'Task start' : 'Last commit'),
	},
	...typing.map(([name, label]): SettingDefinition => ({
		id: `editor-${name}`,
		tab: 'editor',
		section: 'Code',
		label: key(label),
		toggle: {
			get: (s) => s.editor[name],
			set: (s, value) => ({ editor: { ...s.editor, [name]: value } }),
		},
	})),
	{
		id: 'indent-style',
		tab: 'editor',
		section: 'Indentation',
		label: key('Indent style'),
		value: (s) =>
			key(
				s.editor.indentStyle === 'auto'
					? 'Automatic'
					: s.editor.indentStyle === 'tabs'
						? 'Tabs'
						: 'Spaces'
			),
	},
	{
		id: 'indent-size',
		tab: 'editor',
		section: 'Indentation',
		label: key('Indent size'),
		value: (s) => raw(String(s.editor.indentSize)),
	},
	{
		id: 'tab-width',
		tab: 'editor',
		section: 'Indentation',
		label: key('Tab width'),
		value: (s) => (s.editor.tabWidth === 'auto' ? key('Auto') : raw(String(s.editor.tabWidth))),
	},
	{
		id: 'line-author',
		tab: 'editor',
		section: 'Git',
		label: key('Line author'),
		toggle: {
			get: (s) => s.editor.lineAuthor,
			set: (s, lineAuthor) => ({ editor: { ...s.editor, lineAuthor } }),
		},
	},
	{
		id: 'copy-env',
		tab: 'editor',
		section: 'Git',
		label: key('Copy .env'),
		toggle: {
			get: (s) => s.agents.copyEnvFiles,
			set: (s, copyEnvFiles) => ({ agents: { ...s.agents, copyEnvFiles } }),
		},
	},
	{
		id: 'format-on-save',
		tab: 'editor',
		section: 'Formatting',
		label: key('On save'),
		toggle: {
			get: (s) => s.editor.format === 'auto',
			set: (s, on) => ({ editor: { ...s.editor, format: on ? 'auto' : 'off' } }),
		},
	},
	{
		id: 'language',
		tab: 'language',
		section: 'Language',
		label: key('Interface language'),
		value: (s) =>
			s.language === 'system'
				? key('Follow system')
				: raw(s.language === 'uk' ? 'Українська' : 'English'),
	},
	// spec/architecture-and-platform#auto-update: Brigadir's own updates under the language card.
	{
		id: 'app-updates',
		tab: 'language',
		section: 'Updates',
		label: key('Download in the background'),
		toggle: {
			get: (s) => s.updates.autoDownload,
			set: (s, autoDownload) => ({ updates: { ...s.updates, autoDownload } }),
		},
	},
	{ id: 'notifications-when', tab: 'notifications', section: 'Notifications', label: key('When') },
	{ id: 'sound-when', tab: 'notifications', section: 'Sound', label: key('When') },
	{
		id: 'quiet-visible',
		tab: 'notifications',
		section: null,
		label: key('Quiet while I am viewing the task'),
		toggle: {
			get: (s) => s.notifications.muteVisibleTask,
			set: (s, muteVisibleTask) => ({ notifications: { ...s.notifications, muteVisibleTask } }),
		},
	},
	...agentProviders.map((provider): SettingDefinition => ({
		id: `agent-${provider}`,
		tab: 'agents',
		section: 'Providers',
		label: raw(provider === 'claude' ? 'Claude Code' : 'Codex'),
		toggle: {
			get: (s) => s.agents.enabled[provider],
			// spec/settings-modules-and-onboarding#settings-keys: the last provider on stays on, the default moves to one that is on — that switch opens Settings.
			set: (s, value) => {
				const enabled = { ...s.agents.enabled, [provider]: value };
				const fallback = agentProviders.find((item) => enabled[item]);
				if (!fallback) return null;
				return {
					agents: {
						...s.agents,
						enabled,
						provider: enabled[s.agents.provider] ? s.agents.provider : fallback,
					},
				};
			},
		},
	})),
	{
		id: 'cli-updates',
		tab: 'agents',
		section: 'Providers',
		label: key('CLI updates'),
		toggle: {
			get: (s) => s.agents.updateClis,
			set: (s, updateClis) => ({ agents: { ...s.agents, updateClis } }),
		},
	},
	{
		id: 'default-agent',
		tab: 'agents',
		section: 'Agents',
		label: key('Default agent'),
		value: (s) => raw(s.agents.provider === 'claude' ? 'Claude' : 'Codex'),
	},
	{
		id: 'launch-in',
		tab: 'agents',
		section: 'Agents',
		label: key('Launch in'),
		value: (s) => (s.agents.transport === 'gui' ? raw('GUI') : key('Terminal')),
	},
	{
		id: 'isolation',
		tab: 'agents',
		section: 'Agents',
		label: key('Isolation for new tasks'),
		value: (s) => (s.agents.isolation === 'in-place' ? key('No isolation') : raw('Worktree')),
	},
	{
		id: 'max-concurrent',
		tab: 'agents',
		section: 'Agents',
		label: key('Max concurrent'),
		value: (s) =>
			s.agents.maxConcurrent === null
				? key('Unlimited')
				: raw(String(Math.min(s.agents.maxConcurrent, maxConcurrentLimit))),
	},
	{
		id: 'keep-awake',
		tab: 'agents',
		section: 'Agents',
		label: key('Mac sleep'),
		toggle: {
			get: (s) => s.agents.keepAwake,
			set: (s, keepAwake) => ({ agents: { ...s.agents, keepAwake } }),
		},
	},
	{
		id: 'prompt-suggestion',
		tab: 'agents',
		section: 'Agents',
		label: key('Prompt suggestion'),
		toggle: {
			get: (s) => s.suggestNextPrompt,
			set: (_, suggestNextPrompt) => ({ suggestNextPrompt }),
		},
	},
	{
		id: 'helper-agent',
		tab: 'agents',
		section: 'Agents',
		label: key('Helper agent'),
		value: (s) => (s.helperAgent?.name ? raw(s.helperAgent.name) : null),
	},
	// spec/appearance#evolution-redesign: an agent per action; the value is how many actions have their own.
	{
		id: 'action-agents',
		tab: 'agents',
		section: 'Agents',
		label: key('Customize per action'),
		value: (s) => {
			// spec/pull-requests-and-ci#review-crew: an action that runs by a crew counts once, as in the Agents card.
			const count = new Set([...Object.keys(s.actionAgents), ...Object.keys(s.actionCrews)]).size;
			return count ? raw(String(count)) : null;
		},
	},
	{ id: 'templates', tab: 'templates', section: null, label: key('Templates') },
	...moduleNames.map(([module, label]): SettingDefinition => ({
		id: `module-${module}`,
		tab: 'modules',
		section: 'Modules',
		label: key(label),
		toggle: {
			get: (s) => s.modules[module],
			set: (s, value) => ({ modules: { ...s.modules, [module]: value } }),
		},
	})),
	// spec/remote-access-and-mobile#module-and-settings: remote access settings are the Remote access module's popup in Settings ▸ Modules (spec/settings-modules-and-onboarding#module-settings-popup);
	// access is turned on there with a password, so search only opens it.
	{ id: 'remote-access', tab: 'remote', section: 'Remote access', label: key('Remote access') },
	{
		id: 'remote-name',
		tab: 'remote',
		section: 'Remote access',
		label: key('Name'),
		value: (s) => (s.remoteAccess.machineName ? raw(s.remoteAccess.machineName) : null),
	},
	{ id: 'remote-devices', tab: 'remote', section: 'Devices', label: key('Devices') },
];
export type SettingEntry = {
	id: string;
	tab: SettingsTab;
	label: string;
	english: string;
	path: string;
	value: string | null;
	toggle: boolean | null;
	score: number;
};
const text = (locale: Locale, label: Label) => ('key' in label ? t(locale, label.key) : label.raw);
const englishText = (label: Label) => ('key' in label ? label.key : label.raw);
/** The rows matching `query`: by label, section, tab and value, in the interface language or English. */
export function searchSettings(
	query: string,
	settings: AppSettings | null,
	locale: Locale
): SettingEntry[] {
	const out: SettingEntry[] = [];
	for (const item of settingDefinitions) {
		// spec/remote-access-and-mobile#module-and-settings: with the module off its tab is gone.
		if (item.tab === 'remote' && settings && !settings.modules.remoteAccess) continue;
		const label = text(locale, item.label),
			english = englishText(item.label),
			value = settings && item.value ? item.value(settings) : null;
		// spec/settings-modules-and-onboarding#module-settings-popup: remote access settings live under Modules ▸ Remote access; a section of the same name is not repeated.
		const tabKeys: MessageKey[] =
				item.tab === 'remote' ? ['Modules', 'Remote access'] : [settingsTabLabels[item.tab]],
			sectionKeys = item.section && !tabKeys.includes(item.section) ? [item.section] : [];
		const path = [
			t(locale, 'Settings'),
			...[...tabKeys, ...sectionKeys].map((part) => t(locale, part)),
		].join(' ▸ ');
		const englishPath = ['Settings', ...tabKeys, ...sectionKeys].join(' ');
		const valueText = value ? text(locale, value) : null;
		const scores = [
			matchScore(label, query),
			matchScore(english, query),
			...[path, englishPath, valueText ?? ''].map((part) => {
				const s = matchScore(part, query);
				return s === null ? null : s + 3;
			}),
		].filter((s): s is number => s !== null);
		if (!scores.length) continue;
		out.push({
			id: item.id,
			tab: item.tab,
			label,
			english,
			path,
			value: valueText,
			toggle: item.toggle && settings ? item.toggle.get(settings) : null,
			score: Math.min(...scores),
		});
	}
	return out.sort((a, b) => a.score - b.score);
}
/** What a switch row saves; null when it cannot change here (the last agent provider). */
export function toggleSetting(id: string, settings: AppSettings): AppSettings | null {
	const item = settingDefinitions.find((entry) => entry.id === id);
	if (!item?.toggle) return null;
	const patch = item.toggle.set(settings, !item.toggle.get(settings));
	return patch ? { ...settings, ...patch } : null;
}
/** The label of a row as Settings shows it, to find it there (spec/search-menus-and-commands#search-tabs). */
export function settingLocation(
	id: string,
	locale: Locale
): { tab: SettingsTab; section: string | null; label: string } | null {
	const item = settingDefinitions.find((entry) => entry.id === id);
	if (!item) return null;
	return {
		tab: item.tab,
		section: item.section ? t(locale, item.section) : null,
		label: text(locale, item.label),
	};
}

/** spec/search-menus-and-commands#search-tabs: PR by number (`#42`, `42`), title, author or branch in the list already read. */
export type PRHit = {
	scopeId: string;
	repo: string;
	pr: PullRequestSummary;
	group: PRGroup;
	score: number;
};
export function searchPullRequests(
	query: string,
	repos: readonly { scopeId: string; name: string; prs: readonly PullRequestSummary[] }[],
	now = Date.now()
): PRHit[] {
	const needle = query.trim(),
		number = /^#?\d+$/.test(needle) ? needle.replace('#', '') : null;
	const out: PRHit[] = [];
	for (const repo of repos)
		for (const { group, prs } of prGroups(repo.prs, now))
			for (const pr of prs) {
				let score: number | null;
				if (!needle) score = 0;
				else if (number !== null)
					score = String(pr.number) === number ? 0 : String(pr.number).includes(number) ? 1 : null;
				else {
					const own = [pr.title, pr.author, pr.head]
						.map((part) => matchScore(part, needle))
						.filter((s): s is number => s !== null);
					score = own.length ? Math.min(...own) : null;
				}
				if (score !== null) out.push({ scopeId: repo.scopeId, repo: repo.name, pr, group, score });
			}
	const order: PRGroup[] = ['waiting', 'mine', 'others', 'closed'];
	return out.sort(
		(a, b) =>
			order.indexOf(a.group) - order.indexOf(b.group) ||
			a.score - b.score ||
			Date.parse(b.pr.updatedAt) - Date.parse(a.pr.updatedAt)
	);
}
/** The state chip of a PR row; «Open» as a key is the verb «Відкрити», so the state has keys of its own. */
export function prStateText(locale: Locale, pr: Pick<PullRequestSummary, 'state'>): string {
	const key: MessageKey =
		pr.state === 'OPEN'
			? 'PR open'
			: pr.state === 'DRAFT'
				? 'PR draft'
				: pr.state === 'MERGED'
					? 'PR merged'
					: 'PR closed';
	return locale === 'en' ? key.slice(3).replace(/^./, (c) => c.toUpperCase()) : t(locale, key);
}

/** spec/search-menus-and-commands#search-tabs: text search options and the request main runs. */
export type TextSearchOptions = {
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
	mask: string;
	repo: string | null;
};
export type TextSearchRequest = { query: string } & TextSearchOptions;
export const defaultTextSearchOptions: TextSearchOptions = {
	caseSensitive: false,
	wholeWord: false,
	regex: false,
	mask: '',
	repo: null,
};
export function isTextSearchRequest(value: unknown): value is TextSearchRequest {
	return (
		isRecord(value) &&
		Object.keys(value).length === 6 &&
		typeof value.query === 'string' &&
		value.query.trim().length > 0 &&
		value.query.length <= 200 &&
		!value.query.includes('\n') &&
		typeof value.caseSensitive === 'boolean' &&
		typeof value.wholeWord === 'boolean' &&
		typeof value.regex === 'boolean' &&
		typeof value.mask === 'string' &&
		value.mask.length <= 500 &&
		(value.repo === null || (typeof value.repo === 'string' && value.repo.length <= 200))
	);
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The same match in JS, for highlights and to reject an invalid expression before main runs anything. */
export function textPattern(
	request: Pick<TextSearchRequest, 'query' | 'caseSensitive' | 'wholeWord' | 'regex'>
): RegExp | null {
	const body = request.regex ? request.query : escape(request.query);
	try {
		return new RegExp(
			request.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body,
			`gu${request.caseSensitive ? '' : 'i'}`
		);
	} catch {
		return null;
	}
}
/** Match ranges on one line, as [start, end) in UTF-16 units; empty matches are skipped. */
export function matchRanges(line: string, pattern: RegExp): [number, number][] {
	const out: [number, number][] = [];
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(line)) && out.length < 50) {
		if (!match[0].length) {
			pattern.lastIndex++;
			continue;
		}
		out.push([match.index, match.index + match[0].length]);
	}
	return out;
}
/** Globs separated by commas; `!` excludes; a glob without `/` looks at the file name only. Empty keeps everything. */
export function maskMatcher(mask: string): (path: string) => boolean {
	const parts = mask
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	const compile = (glob: string) => {
		const source = glob
			.split('**')
			.map((piece) =>
				piece
					.split('*')
					.map((text) => text.split('?').map(escape).join('[^/]'))
					.join('[^/]*')
			)
			.join('.*');
		return { re: new RegExp(`^${source}$`, 'i'), path: glob.includes('/') };
	};
	const include = parts.filter((part) => !part.startsWith('!')).map(compile),
		exclude = parts.filter((part) => part.startsWith('!')).map((part) => compile(part.slice(1)));
	return (path) => {
		const name = path.slice(path.lastIndexOf('/') + 1),
			test = (rule: { re: RegExp; path: boolean }) => rule.re.test(rule.path ? path : name);
		return (!include.length || include.some(test)) && !exclude.some(test);
	};
}
export type TextMatch = {
	fileId: string;
	path: string;
	scope: string;
	line: number;
	column: number;
	text: string;
	ranges: [number, number][];
};
export type TextSearchEvent = {
	id: string;
	matches: TextMatch[];
	scanned: number;
	total: number;
	done: boolean;
	truncated: boolean;
	error: string | null;
};
export const textSearchLimits = { matches: 2000, perFile: 100, lineLength: 400, batch: 200 };
/** One line of `rg --null` (`path\0line:text`) or `git grep -z` (`path\0line\0text`) output. */
export function parseGrepLine(line: string): { path: string; line: number; text: string } | null {
	const nul = line.indexOf('\0');
	if (nul <= 0) return null;
	const rest = line.slice(nul + 1),
		match = /^(\d+)[\0:]/.exec(rest);
	if (!match) return null;
	return { path: line.slice(0, nul), line: Number(match[1]), text: rest.slice(match[0].length) };
}
/** Trims a long line around its first match, keeping ranges aligned. */
export function clipLine(
	text: string,
	ranges: [number, number][],
	limit = textSearchLimits.lineLength
): { text: string; ranges: [number, number][] } {
	if (text.length <= limit) return { text, ranges };
	const first = ranges[0]?.[0] ?? 0,
		start = Math.max(0, Math.min(first - 40, text.length - limit));
	return {
		text: text.slice(start, start + limit),
		ranges: ranges
			.map(([a, b]): [number, number] => [a - start, b - start])
			.filter(([a, b]) => a >= 0 && b <= limit),
	};
}
export function isTextSearchEvent(value: unknown): value is TextSearchEvent {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		Array.isArray(value.matches) &&
		typeof value.done === 'boolean'
	);
}
