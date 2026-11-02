import {
	defaultChatFont,
	defaultInterfaceFont,
	defaultTypography,
	isChatFont,
	isInterfaceFont,
	isTypography,
	type ChatFont,
	type InterfaceFont,
	type Typography,
} from './typography';
import { isRecord } from './workspace';
import { defaultIndentSize, indentStyles, isIndentWidth, type IndentStyle } from './indent';
import { selectLocale, type Locale } from './messages';
import {
	defaultNotificationPreferences,
	isNotificationPreferences,
	type NotificationPreferences,
} from './notifications';
import { defaultKeymap, isKeymapSettings, type KeymapSettings } from './keymap';
import { isProjectView, type ProjectView } from './board';
import { defaultTaskColumns, isTaskColumns, type TaskColumns } from './task-layout';
import { defaultModules, isAppModules, type AppModules } from './modules';
import { defaultSlackSettings, isSlackSettings, type SlackSettings } from './slack';
import { defaultArchiveAfterDays, isArchiveAfterDays, type ArchiveAfterDays } from './archive';
import {
	defaultRemoteAccess,
	isRemoteAccessSettings,
	type RemoteAccessSettings,
} from './remote-access';
import {
	isActionAgents,
	isActionCrews,
	type ActionAgents,
	type ActionCrews,
} from './action-agents';
/** spec/tasks#launch-sheet: `maxConcurrent` null means no limit; tasks beyond the limit wait as `queued`. */
/** spec/settings-modules-and-onboarding#settings-keys: `enabled` — which providers are offered (at least one); `isolation` — where every new task starts. */
export const agentProviders = ['claude', 'codex'] as const;
export type AgentProviderId = (typeof agentProviders)[number];
export type AgentDefaults = {
	provider: AgentProviderId;
	transport: 'gui' | 'terminal';
	maxConcurrent: number | null;
	enabled: Record<AgentProviderId, boolean>;
	isolation: 'in-place' | 'worktree';
	/** spec/git#worktree-env: a new worktree gets the project's ignored `.env*` files; the New task sheet starts from this. */ copyEnvFiles: boolean;
	/** spec/pull-requests-and-ci#review-with-agent: where «Review with an agent» runs — the main tree read from git, or a worktree of the PR. */ reviewWhere:
		'quick' | 'worktree';
	/** spec/agents-and-providers#cli-updates: `claude update` and `codex update` once a day in the background. */ updateClis: boolean;
	/** spec/architecture-and-platform#keep-awake: the Mac does not idle-sleep while an agent works. */ keepAwake: boolean;
	/** spec/tasks#archive: completed tasks go to the archive after this many days; null never. */ archiveAfterDays: ArchiveAfterDays;
	/** spec/browser-and-simulator#background: agents act on any site in the browser without the `Act on <domain>` card; off by default. */ browserActAnywhere: boolean;
	/** spec/appearance#evolution-redesign: the review of a PR writes the agent summary by itself on its first open; on by default. */ prSummary: boolean;
};
export const maxConcurrentLimit = 99;
/** spec/appearance#accent: palette order is the swatch order in Settings ▸ Appearance; `system` follows macOS. */
export const accentColors = [
	'system',
	'blue',
	'indigo',
	'purple',
	'pink',
	'teal',
	'yellow',
	'graphite',
] as const;
export type AccentColor = (typeof accentColors)[number];
export function isAccentColor(value: unknown): value is AccentColor {
	return accentColors.includes(value as AccentColor);
}
/** spec/editor-code-intelligence#format-on-save: `auto` formats on save with the project's Prettier or the language server; a project may override it.
 *  spec/diff-and-review#diff-base: `diffBase` — what every change surface counts from: the task's first snapshot or each repo's HEAD.
 *  spec/editor-code-intelligence#typing-help: language servers and the typing aids of the editor, each on by default. */
export type EditorSettings = {
	format: 'auto' | 'off';
	diffBase: DiffBase;
	codeTheme: CodeTheme;
	/** spec/editor#line-author: the line author after the caret line, on by default. */
	lineAuthor: boolean;
	/** spec/editor-code-intelligence#font-styles: font styles in syntax highlighting — bold keywords, italic comments; on by default, apart from the code theme. */
	syntaxStyles: boolean;
	/** spec/editor#indentation: how the editor indents. A project's Prettier or .editorconfig overrules these for its files. */
	indentStyle: IndentStyle;
	indentSize: number;
	tabWidth: number | 'auto';
} & EditorTyping;
/** spec/settings-modules-and-onboarding#settings-keys: a code theme recolours only syntax tokens of the editor and the diff. */
export const codeThemes = ['brigadir', 'vscode', 'intellij'] as const;
export type CodeTheme = (typeof codeThemes)[number];
export const editorTypingKeys = [
	'languageServers',
	'closeBrackets',
	'closeTags',
	'callParens',
] as const;
export type EditorTyping = Record<(typeof editorTypingKeys)[number], boolean>;
export const diffBases = ['task', 'head'] as const;
export type DiffBase = (typeof diffBases)[number];
export function isEditorSettings(value: unknown): value is EditorSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 8 + editorTypingKeys.length &&
		indentStyles.includes(value.indentStyle as IndentStyle) &&
		isIndentWidth(value.indentSize) &&
		(value.tabWidth === 'auto' || isIndentWidth(value.tabWidth)) &&
		typeof value.lineAuthor === 'boolean' &&
		typeof value.syntaxStyles === 'boolean' &&
		(value.format === 'auto' || value.format === 'off') &&
		diffBases.includes(value.diffBase as DiffBase) &&
		codeThemes.includes(value.codeTheme as CodeTheme) &&
		editorTypingKeys.every((key) => typeof value[key] === 'boolean')
	);
}
/** spec/settings-modules-and-onboarding#settings-keys: `projects.defaultView` for projects without a saved view; `onboarding.completedVersion` null shows the intro. */
export type ProjectDefaults = { defaultView: ProjectView };
export type OnboardingState = { completedVersion: number | null };
export const onboardingVersion = 1;
/** spec/composer-steering-queue-and-ghost#ghost-headless, spec/appearance#evolution-redesign: the Helper agent — who writes every short one-off text (summaries, commit and PR texts, branch
 *  names, prompt hints). `model` is a value of the provider's own catalog; `name` is the catalog name at the time of choosing,
 *  so Settings can still say what was chosen while the provider is off or the model has left; `effort` null is the lowest
 *  level the model advertises. Older settings store `suggestModel` (model only); `migrateHelperAgent` converts it. */
export type HelperAgent = {
	provider: AgentProviderId;
	model: string;
	name: string | null;
	effort: string | null;
};
const shortText = (value: unknown) =>
	typeof value === 'string' && value.length > 0 && value.length <= 200;
export function isHelperAgent(value: unknown): value is HelperAgent {
	return (
		isRecord(value) &&
		Object.keys(value).length === 4 &&
		agentProviders.includes(value.provider as AgentProviderId) &&
		shortText(value.model) &&
		(value.name === null || (typeof value.name === 'string' && value.name.length <= 200)) &&
		(value.effort === null || shortText(value.effort))
	);
}
/** spec/appearance#evolution-redesign: a one-time choice of the in-place capsule — it serves one run and never changes Settings. */
export type HelperRun = { provider: AgentProviderId; model: string; effort: string | null };
export function isHelperRun(value: unknown): value is HelperRun {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		agentProviders.includes(value.provider as AgentProviderId) &&
		shortText(value.model) &&
		(value.effort === null || shortText(value.effort))
	);
}
/** spec/appearance#evolution-redesign: the stored `suggestModel` becomes `helperAgent` with the lowest effort; the person's choice carries over. */
export function migrateHelperAgent(value: Record<string, unknown>): Record<string, unknown> {
	if ('helperAgent' in value) return value;
	const { suggestModel, ...rest } = value;
	const old = isRecord(suggestModel) ? suggestModel : null;
	return {
		...rest,
		helperAgent:
			old &&
			agentProviders.includes(old.provider as AgentProviderId) &&
			shortText(old.model) &&
			(old.name === null || typeof old.name === 'string')
				? {
						provider: old.provider,
						model: old.model,
						name: typeof old.name === 'string' ? old.name.slice(0, 200) : null,
						effort: null,
					}
				: null,
	};
}
/** spec/terminal-and-cli-agents#wheel: wheel and trackpad in the terminal. `scrollSpeed` 1 is a native terminal: one line per line-height of travel. */
/** spec/terminal-and-cli-agents#render-and-theme: `fontWeight` of the terminal text, as a native terminal profile picks Regular or Medium; bold stays 700. */
export const terminalFontWeights = [300, 400, 500, 600] as const;
export type TerminalFontWeight = (typeof terminalFontWeights)[number];
export type TerminalSettings = { scrollSpeed: number; fontWeight: TerminalFontWeight };
export const terminalScrollSpeed = { min: 0.2, max: 4, default: 1 } as const;
export function isTerminalSettings(value: unknown): value is TerminalSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		terminalFontWeights.includes(value.fontWeight as TerminalFontWeight) &&
		typeof value.scrollSpeed === 'number' &&
		Number.isFinite(value.scrollSpeed) &&
		value.scrollSpeed >= terminalScrollSpeed.min &&
		value.scrollSpeed <= terminalScrollSpeed.max
	);
}
/** spec/settings-modules-and-onboarding#modules: `modules` — the browser and the simulator switch off whole, with their MCP tools.
 *  spec/appearance#evolution-redesign: `helperAgent` null is the default Helper agent (Claude Haiku, the lowest effort). */
export type AppSettings = {
	suggestNextPrompt: boolean;
	helperAgent: HelperAgent | null;
	/** spec/appearance#evolution-redesign: Customize per action — only the changed actions; an absent one inherits. */
	actionAgents: ActionAgents;
	/** spec/pull-requests-and-ci#review-crew: `Remember for …` on the Crew segment — a review action runs by a library crew; excludes its `actionAgents` entry. */
	actionCrews: ActionCrews;
	modules: AppModules;
	projects: ProjectDefaults;
	keymap: KeymapSettings;
	onboarding: OnboardingState;
	appearance: 'system' | 'light' | 'dark';
	accent: AccentColor;
	language: 'system' | Locale;
	toolbarLabels: 'icons' | 'labels';
	/** spec/task-window-workspace#two-columns: two columns (the chat a pinned tab of the work area) or three (the chat a column); three by default. */
	taskColumns: TaskColumns;
	interfaceFont: InterfaceFont;
	/** spec/appearance#chat-text-size: the chat's text size; null follows the interface. */
	chatFont: ChatFont;
	typography: Typography;
	terminal: TerminalSettings;
	agents: AgentDefaults;
	notifications: NotificationPreferences;
	editor: EditorSettings;
	/** spec/remote-access-and-mobile#module-and-settings: Settings ▸ Remote; a remote client never changes it (spec/remote-access-and-mobile#architecture). */
	remoteAccess: RemoteAccessSettings;
	/** spec/notifications-slack-notes-and-schedules#slack: Settings ▸ Modules ▸ Slack; the token is not here. */
	slack: SlackSettings;
	/** spec/architecture-and-platform#auto-update: `autoDownload` — a new version downloads by itself; checking runs either way. */
	updates: UpdateSettings;
};
export type UpdateSettings = { autoDownload: boolean };
export function isUpdateSettings(value: unknown): value is UpdateSettings {
	return (
		isRecord(value) && Object.keys(value).length === 1 && typeof value.autoDownload === 'boolean'
	);
}
export const defaultAppSettings: AppSettings = {
	suggestNextPrompt: false,
	helperAgent: null,
	actionAgents: {},
	actionCrews: {},
	modules: { ...defaultModules },
	projects: { defaultView: 'board' },
	keymap: defaultKeymap,
	onboarding: { completedVersion: null },
	appearance: 'system',
	accent: 'system',
	language: 'system',
	toolbarLabels: 'icons',
	taskColumns: defaultTaskColumns,
	interfaceFont: defaultInterfaceFont,
	chatFont: defaultChatFont,
	typography: defaultTypography,
	terminal: { scrollSpeed: terminalScrollSpeed.default, fontWeight: 400 },
	agents: {
		provider: 'claude',
		transport: 'gui',
		maxConcurrent: null,
		enabled: { claude: true, codex: true },
		isolation: 'in-place',
		copyEnvFiles: true,
		reviewWhere: 'quick',
		updateClis: true,
		keepAwake: true,
		archiveAfterDays: defaultArchiveAfterDays,
		browserActAnywhere: false,
		prSummary: true,
	},
	notifications: defaultNotificationPreferences,
	editor: {
		format: 'auto',
		diffBase: 'task',
		codeTheme: 'brigadir',
		lineAuthor: true,
		syntaxStyles: true,
		indentStyle: 'auto',
		indentSize: defaultIndentSize,
		tabWidth: 'auto',
		languageServers: true,
		closeBrackets: true,
		closeTags: true,
		callParens: true,
	},
	remoteAccess: { ...defaultRemoteAccess, listen: { ...defaultRemoteAccess.listen } },
	slack: {
		...defaultSlackSettings,
		events: { ...defaultSlackSettings.events },
		projects: {},
		mentions: { ...defaultSlackSettings.mentions, people: [] },
	},
	updates: { autoDownload: true },
};
export function isAgentDefaults(value: unknown): value is AgentDefaults {
	return (
		isRecord(value) &&
		Object.keys(value).length === 12 &&
		typeof value.prSummary === 'boolean' &&
		typeof value.copyEnvFiles === 'boolean' &&
		typeof value.browserActAnywhere === 'boolean' &&
		isArchiveAfterDays(value.archiveAfterDays) &&
		(value.reviewWhere === 'quick' || value.reviewWhere === 'worktree') &&
		typeof value.updateClis === 'boolean' &&
		typeof value.keepAwake === 'boolean' &&
		isRecord(value.enabled) &&
		Object.keys(value.enabled).length === agentProviders.length &&
		agentProviders.every(
			(provider) => typeof (value.enabled as Record<string, unknown>)[provider] === 'boolean'
		) &&
		agentProviders.some(
			(provider) => (value.enabled as Record<string, unknown>)[provider] === true
		) &&
		(value.enabled as Record<string, unknown>)[value.provider as string] === true &&
		['in-place', 'worktree'].includes(value.isolation as string) &&
		['claude', 'codex'].includes(value.provider as string) &&
		['gui', 'terminal'].includes(value.transport as string) &&
		(value.maxConcurrent === null ||
			(Number.isSafeInteger(value.maxConcurrent) &&
				Number(value.maxConcurrent) >= 1 &&
				Number(value.maxConcurrent) <= maxConcurrentLimit))
	);
}
export function isAppSettings(value: unknown): value is AppSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 23 &&
		isSlackSettings(value.slack) &&
		isUpdateSettings(value.updates) &&
		isTaskColumns(value.taskColumns) &&
		isRemoteAccessSettings(value.remoteAccess) &&
		(value.helperAgent === null || isHelperAgent(value.helperAgent)) &&
		isActionAgents(value.actionAgents) &&
		isActionCrews(value.actionCrews) &&
		isAppModules(value.modules) &&
		isRecord(value.projects) &&
		Object.keys(value.projects).length === 1 &&
		isProjectView(value.projects.defaultView) &&
		isKeymapSettings(value.keymap) &&
		isRecord(value.onboarding) &&
		Object.keys(value.onboarding).length === 1 &&
		(value.onboarding.completedVersion === null ||
			(Number.isSafeInteger(value.onboarding.completedVersion) &&
				Number(value.onboarding.completedVersion) >= 1)) &&
		typeof value.suggestNextPrompt === 'boolean' &&
		['system', 'light', 'dark'].includes(value.appearance as string) &&
		isAccentColor(value.accent) &&
		['system', 'en', 'uk'].includes(value.language as string) &&
		['icons', 'labels'].includes(value.toolbarLabels as string) &&
		isInterfaceFont(value.interfaceFont) &&
		isChatFont(value.chatFont) &&
		isTypography(value.typography) &&
		isTerminalSettings(value.terminal) &&
		isAgentDefaults(value.agents) &&
		isNotificationPreferences(value.notifications) &&
		isEditorSettings(value.editor)
	);
}
/** spec/appearance#accent: text on a system accent fill stays white while white keeps 3:1 against it; below that it turns dark. */
export function accentFillNeedsDarkText(hex: string): boolean {
	const match = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(hex);
	if (!match) return false;
	const channel = (value: string) => {
		const c = parseInt(value, 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const luminance =
		0.2126 * channel(match[1]!) + 0.7152 * channel(match[2]!) + 0.0722 * channel(match[3]!);
	return 1.05 / (luminance + 0.05) < 3;
}
export function settingsLocale(settings: AppSettings, systemLocale: string): Locale {
	return settings.language === 'system' ? selectLocale(systemLocale) : settings.language;
}
export type SettingsSnapshot = { settings: AppSettings; restartRequired: boolean };

/** Width of the task strip, excluding the project sidebar (spec/sidebar#layout). */
export const headerLabelsMinimumWidth = 860;
/** The title's readable minimum while the strip carries labels (spec/sidebar#layout, spec/search-menus-and-commands#project-commands); the toolbar fit keeps it (spec/task-window#narrow-toolbar). */
export const headerLabelsTitleMinimum = 180;
