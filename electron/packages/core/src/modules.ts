import { isRecord } from './workspace';
/**
 * spec/settings-modules-and-onboarding#modules: a module is a part of the app that switches off whole — its column, toolbar button, menu items with their
 * shortcuts, its processes and its MCP tools. The browser is on by default; the simulator is off, because only projects
 * with a mobile app need it and its tools cost context in every session. spec/settings-modules-and-onboarding#module-off: pull requests and project commands are
 * modules too, on by default — they shipped on before they could be switched off. spec/remote-access-and-mobile#module-and-settings: remote access is a
 * module on by default; access itself stays off until Settings ▸ Remote turns it on. spec/notifications-slack-notes-and-schedules#notes: notes are a module on by
 * default; switched off, their files stay in `~/.brigadir/notes/`. spec/notifications-slack-notes-and-schedules#schedules: scheduled tasks are a module on by default;
 * switched off, the timer stops and the schedules stay on disk. spec/notifications-slack-notes-and-schedules#slack: Slack is a module off by default — it needs a bot token;
 * switched off, nothing reaches Slack and the token stays in the Keychain.
 */
export const appModules = [
	'browser',
	'simulator',
	'pullRequests',
	'commands',
	'remoteAccess',
	'notes',
	'schedules',
	'slack',
] as const;
export type AppModule = (typeof appModules)[number];
export type AppModules = Record<AppModule, boolean>;
export const defaultModules: AppModules = {
	browser: true,
	simulator: false,
	pullRequests: true,
	commands: true,
	remoteAccess: true,
	notes: true,
	schedules: true,
	slack: false,
};
export function isAppModules(value: unknown): value is AppModules {
	return (
		isRecord(value) &&
		Object.keys(value).length === appModules.length &&
		appModules.every((key) => typeof value[key] === 'boolean')
	);
}
/** spec/settings-modules-and-onboarding#module-off: `settings.json` written before a module existed lacks its key — that module takes its default; anything else is kept as read. */
export function withModuleDefaults(value: unknown): unknown {
	return isRecord(value) ? { ...defaultModules, ...value } : value;
}
/** MCP tools of a module that are not named by its prefix. */
const moduleTools: Record<string, AppModule> = {
	pr_comment: 'pullRequests',
	pr_comment_reply: 'pullRequests',
	pr_state: 'pullRequests',
	note_read: 'notes',
	note_edit: 'notes',
};
/** The module an MCP tool belongs to, by its name prefix; `null` for the tools every module keeps (`ask_user`, crew tools). */
export function toolModule(name: string): AppModule | null {
	return moduleTools[name] ?? appModules.find((module) => name.startsWith(`${module}_`)) ?? null;
}
/** What the agent reads when it calls a tool of a module switched off before its tool list caught up (Codex keeps its list, spec/settings-modules-and-onboarding#modules). */
export const moduleOffMessages: Record<AppModule, string> = {
	browser: 'The browser is off in Settings.',
	simulator: 'The simulator is off in Settings.',
	pullRequests: 'Pull requests are off in Settings.',
	commands: 'Project commands are off in Settings.',
	remoteAccess: 'Remote access is off in Settings.',
	notes: 'Notes are off in Settings.',
	schedules: 'Scheduled tasks are off in Settings.',
	slack: 'Slack is off in Settings.',
};
/** Menu commands of a module that are not named by it (spec/settings-modules-and-onboarding#module-off): the PR toggle in View and the project command block of File. */
const moduleCommands: Record<string, AppModule> = {
	'pull-requests': 'pullRequests',
	'pull-requests-refresh': 'pullRequests',
	commands: 'commands',
	'command-run': 'commands',
	'command-stop': 'commands',
	'command-new': 'commands',
	connect: 'remoteAccess',
	'note-new': 'notes',
	'schedule-new': 'schedules',
};
/** The module a menu command belongs to: its toggle in View and every item of its own menu. */
export function commandModule(id: string): AppModule | null {
	return (
		moduleCommands[id] ??
		appModules.find((module) => id === module || id.startsWith(`${module}-`)) ??
		null
	);
}
export function sameModules(a: AppModules, b: AppModules) {
	return appModules.every((key) => a[key] === b[key]);
}
