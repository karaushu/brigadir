import { notificationModes } from './notifications';
import { searchSettings, settingLocation } from './search';
import {
	accentColors,
	codeThemes,
	isAppSettings,
	terminalFontWeights,
	type AppSettings,
} from './settings';
import { taskColumnChoices } from './task-layout';
import { chatFontSize, codeFontSize, interfaceFontSize } from './typography';
import type { Locale } from './messages';

/**
 * spec/settings-modules-and-onboarding#settings-registry: the settings the Brigadir chat may change, each tied to its row in Settings (`id` of
 * `settingDefinitions`, which gives the label and the place). The Settings window and the chat validate through `isAppSettings`, so the chat
 * never writes a value the window would refuse. Secrets are not here; remote access is a setup (it needs a password), so it is not either.
 */
export type SettingKind =
	| { type: 'enum'; values: readonly (string | number | null)[] }
	| { type: 'number'; min: number; max: number; step: number }
	| { type: 'boolean' };
export type SettingEdit = {
	/** The key the agent names, a path into `settings.json`. */
	key: string;
	/** The row in Settings (`settingDefinitions`). */
	id: string;
	kind: SettingKind;
	get(settings: AppSettings): string | number | boolean | null;
	set(settings: AppSettings, value: string | number | boolean | null): AppSettings;
	/** A change that removes a part of the app or lets agents act without asking: a card with `Apply` first. */
	confirm?(before: unknown, after: unknown): boolean;
};
const size = (min: number, max: number, step = 1): SettingKind => ({
	type: 'number',
	min,
	max,
	step,
});
const bool: SettingKind = { type: 'boolean' };
const oneOf = (values: readonly (string | number | null)[]): SettingKind => ({
	type: 'enum',
	values,
});
const surfaces = ['editor', 'diff', 'terminal'] as const;
const modules = [
	'browser',
	'simulator',
	'pullRequests',
	'commands',
	'notes',
	'schedules',
	'slack',
] as const;

export const settingEdits: readonly SettingEdit[] = [
	{
		key: 'appearance',
		id: 'theme',
		kind: oneOf(['system', 'light', 'dark']),
		get: (s) => s.appearance,
		set: (s, v) => ({ ...s, appearance: v as AppSettings['appearance'] }),
	},
	{
		key: 'accent',
		id: 'accent',
		kind: oneOf(accentColors),
		get: (s) => s.accent,
		set: (s, v) => ({ ...s, accent: v as AppSettings['accent'] }),
	},
	{
		key: 'toolbarLabels',
		id: 'toolbar-labels',
		kind: oneOf(['icons', 'labels']),
		get: (s) => s.toolbarLabels,
		set: (s, v) => ({ ...s, toolbarLabels: v as AppSettings['toolbarLabels'] }),
	},
	{
		key: 'taskColumns',
		id: 'task-columns',
		kind: oneOf(taskColumnChoices),
		get: (s) => s.taskColumns,
		set: (s, v) => ({ ...s, taskColumns: v as AppSettings['taskColumns'] }),
	},
	{
		key: 'projects.defaultView',
		id: 'tasks-view',
		kind: oneOf(['board', 'list']),
		get: (s) => s.projects.defaultView,
		set: (s, v) => ({ ...s, projects: { ...s.projects, defaultView: v as 'board' | 'list' } }),
	},
	{
		key: 'interfaceFont.size',
		id: 'interface-size',
		kind: size(interfaceFontSize.min, interfaceFontSize.max),
		get: (s) => s.interfaceFont.size,
		set: (s, v) => ({ ...s, interfaceFont: { ...s.interfaceFont, size: v as number } }),
	},
	{
		key: 'chatFont.size',
		id: 'chat-size',
		kind: { type: 'number', min: chatFontSize.min, max: chatFontSize.max, step: chatFontSize.step },
		get: (s) => s.chatFont.size,
		set: (s, v) => ({ ...s, chatFont: { size: v as number | null } }),
	},
	...surfaces.map((surface): SettingEdit => ({
		key: `typography.${surface}.size`,
		id: `${surface}-size`,
		kind: size(codeFontSize.min, codeFontSize.max),
		get: (s) => s.typography[surface].size,
		set: (s, v) => ({
			...s,
			typography: { ...s.typography, [surface]: { ...s.typography[surface], size: v as number } },
		}),
	})),
	...surfaces.map((surface): SettingEdit => ({
		key: `typography.${surface}.ligatures`,
		id: `${surface}-ligatures`,
		kind: bool,
		get: (s) => s.typography[surface].ligatures,
		set: (s, v) => ({
			...s,
			typography: {
				...s.typography,
				[surface]: { ...s.typography[surface], ligatures: v as boolean },
			},
		}),
	})),
	{
		key: 'terminal.fontWeight',
		id: 'terminal-font-weight',
		kind: oneOf(terminalFontWeights),
		get: (s) => s.terminal.fontWeight,
		set: (s, v) => ({
			...s,
			terminal: { ...s.terminal, fontWeight: v as AppSettings['terminal']['fontWeight'] },
		}),
	},
	{
		key: 'editor.codeTheme',
		id: 'code-theme',
		kind: oneOf(codeThemes),
		get: (s) => s.editor.codeTheme,
		set: (s, v) => ({
			...s,
			editor: { ...s.editor, codeTheme: v as AppSettings['editor']['codeTheme'] },
		}),
	},
	{
		key: 'editor.lineAuthor',
		id: 'line-author',
		kind: bool,
		get: (s) => s.editor.lineAuthor,
		set: (s, v) => ({ ...s, editor: { ...s.editor, lineAuthor: v as boolean } }),
	},
	{
		key: 'editor.format',
		id: 'format-on-save',
		kind: oneOf(['auto', 'off']),
		get: (s) => s.editor.format,
		set: (s, v) => ({ ...s, editor: { ...s.editor, format: v as 'auto' | 'off' } }),
	},
	{
		key: 'language',
		id: 'language',
		kind: oneOf(['system', 'en', 'uk']),
		get: (s) => s.language,
		set: (s, v) => ({ ...s, language: v as AppSettings['language'] }),
	},
	{
		key: 'updates.autoDownload',
		id: 'app-updates',
		kind: bool,
		get: (s) => s.updates.autoDownload,
		set: (s, v) => ({ ...s, updates: { autoDownload: v as boolean } }),
	},
	{
		key: 'notifications.mode',
		id: 'notifications-when',
		kind: oneOf(notificationModes),
		get: (s) => s.notifications.mode,
		set: (s, v) => ({
			...s,
			notifications: { ...s.notifications, mode: v as AppSettings['notifications']['mode'] },
		}),
	},
	{
		key: 'notifications.soundMode',
		id: 'sound-when',
		kind: oneOf(notificationModes),
		get: (s) => s.notifications.soundMode,
		set: (s, v) => ({
			...s,
			notifications: {
				...s.notifications,
				soundMode: v as AppSettings['notifications']['soundMode'],
			},
		}),
	},
	{
		key: 'agents.provider',
		id: 'default-agent',
		kind: oneOf(['claude', 'codex']),
		get: (s) => s.agents.provider,
		set: (s, v) => ({
			...s,
			agents: { ...s.agents, provider: v as AppSettings['agents']['provider'] },
		}),
	},
	{
		key: 'agents.transport',
		id: 'launch-in',
		kind: oneOf(['gui', 'terminal']),
		get: (s) => s.agents.transport,
		set: (s, v) => ({ ...s, agents: { ...s.agents, transport: v as 'gui' | 'terminal' } }),
	},
	{
		key: 'agents.isolation',
		id: 'isolation',
		kind: oneOf(['in-place', 'worktree']),
		get: (s) => s.agents.isolation,
		set: (s, v) => ({ ...s, agents: { ...s.agents, isolation: v as 'in-place' | 'worktree' } }),
	},
	{
		key: 'agents.keepAwake',
		id: 'keep-awake',
		kind: bool,
		get: (s) => s.agents.keepAwake,
		set: (s, v) => ({ ...s, agents: { ...s.agents, keepAwake: v as boolean } }),
	},
	{
		key: 'agents.slackPostWithoutAsking',
		id: 'module-slack',
		kind: bool,
		get: (s) => s.agents.slackPostWithoutAsking,
		set: (s, v) => ({ ...s, agents: { ...s.agents, slackPostWithoutAsking: v as boolean } }),
		confirm: (_before, after) => after === true,
	},
	{
		key: 'suggestNextPrompt',
		id: 'prompt-suggestion',
		kind: bool,
		get: (s) => s.suggestNextPrompt,
		set: (s, v) => ({ ...s, suggestNextPrompt: v as boolean }),
	},
	...modules.map((module): SettingEdit => ({
		key: `modules.${module}`,
		id: `module-${module}`,
		kind: bool,
		get: (s) => s.modules[module],
		set: (s, v) => ({ ...s, modules: { ...s.modules, [module]: v as boolean } }),
		confirm: (before, after) => before === true && after === false,
	})),
];

const byKey = new Map(settingEdits.map((edit) => [edit.key, edit]));
export function settingEdit(key: string): SettingEdit | null {
	return byKey.get(key) ?? null;
}
const kindText = (kind: SettingKind) =>
	kind.type === 'boolean'
		? 'true | false'
		: kind.type === 'enum'
			? kind.values.map((value) => JSON.stringify(value)).join(' | ')
			: `${kind.min}–${kind.max}${kind.step !== 1 ? ` by ${kind.step}` : ''}`;
/** The place of a setting as Settings shows it in English: `Settings ▸ Appearance ▸ Editor ▸ Size`. */
function place(edit: SettingEdit): string {
	const where = settingLocation(edit.id, 'en');
	if (!where) return edit.key;
	const tab = where.tab === 'remote' ? 'Modules' : where.tab[0]!.toUpperCase() + where.tab.slice(1);
	return [
		'Settings',
		tab,
		...(where.section && where.section !== tab ? [where.section] : []),
		where.label,
	].join(' ▸ ');
}
export type SettingInfo = {
	key: string;
	place: string;
	values: string;
	current: string | number | boolean | null;
	confirm: boolean;
};
function info(edit: SettingEdit, settings: AppSettings): SettingInfo {
	return {
		key: edit.key,
		place: edit.key.startsWith('modules.')
			? `Settings ▸ Modules ▸ ${edit.key.slice(8)}`
			: edit.key === 'agents.slackPostWithoutAsking'
				? 'Settings ▸ Modules ▸ Slack ▸ Agents can post without confirmation'
				: place(edit),
		values: kindText(edit.kind),
		current: edit.get(settings),
		confirm: Boolean(edit.confirm),
	};
}
/** spec/settings-modules-and-onboarding#brigadir-chat-tools: `settings_find` — by key, by the label in either language, by the place. */
export function findSettings(query: string, settings: AppSettings, locale: Locale): SettingInfo[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return settingEdits.map((edit) => info(edit, settings));
	const ids = new Set(searchSettings(query, settings, locale).map((row) => row.id));
	for (const other of locale === 'en' ? [] : (['en'] as const))
		for (const row of searchSettings(query, settings, other)) ids.add(row.id);
	return settingEdits
		.filter((edit) => ids.has(edit.id) || edit.key.toLowerCase().includes(needle))
		.map((edit) => info(edit, settings));
}
/** Every setting the chat may change, one line each, for the agent's prompt. */
export function settingsRegistryText(settings: AppSettings): string {
	return settingEdits
		.map((edit) => {
			const item = info(edit, settings);
			return `- ${item.key} (${item.place}): ${item.values}; now ${JSON.stringify(item.current)}${item.confirm ? '; asks the person first' : ''}`;
		})
		.join('\n');
}
export type SettingChange = {
	key: string;
	place: string;
	before: string | number | boolean | null;
	after: string | number | boolean | null;
	settings: AppSettings;
	/** The person must press `Apply` first. */
	confirm: boolean;
};
/** spec/settings-modules-and-onboarding#brigadir-chat-tools: `settings_set` — the new settings, or an error the agent can act on. */
export function changeSetting(settings: AppSettings, key: string, value: unknown): SettingChange {
	const edit = settingEdit(key);
	if (!edit) throw new Error(`No setting ${key}. Call settings_find to see the keys.`);
	const kind = edit.kind;
	let next: string | number | boolean | null;
	if (kind.type === 'boolean') {
		if (typeof value !== 'boolean') throw new Error(`${key} takes true or false.`);
		next = value;
	} else if (kind.type === 'number') {
		const number = typeof value === 'string' ? Number(value) : value;
		if (number === null && edit.key === 'chatFont.size') next = null;
		else if (
			typeof number !== 'number' ||
			!Number.isFinite(number) ||
			number < kind.min ||
			number > kind.max ||
			!Number.isInteger(Math.round((number / kind.step) * 1e6) / 1e6)
		)
			throw new Error(`${key} takes ${kindText(kind)}.`);
		else next = number;
	} else {
		const match = kind.values.find((item) => item === value || String(item) === String(value));
		if (match === undefined) throw new Error(`${key} takes ${kindText(kind)}.`);
		next = match;
	}
	const before = edit.get(settings);
	const updated = edit.set(settings, next);
	if (!isAppSettings(updated))
		throw new Error(
			`${key} cannot be ${JSON.stringify(next)} with the other settings as they are.`
		);
	return {
		key,
		place: info(edit, settings).place,
		before,
		after: next,
		settings: updated,
		confirm: Boolean(edit.confirm?.(before, next)) && before !== next,
	};
}
