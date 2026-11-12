import { mkdir } from 'node:fs/promises';
import {
	defaultAppSettings,
	defaultModules,
	defaultRemoteAccess,
	defaultSlackSettings,
	withSlackDefaults,
	withModuleDefaults,
	isRecord,
	migrateHelperAgent,
	migrateActionAgents,
	migrateActionCrews,
	isAppSettings,
	migrateNotificationPreferences,
	onboardingVersion,
	type AppSettings,
} from '@brigadir/core';
import { SessionStore, readDocument, safePath, atomicJson } from '@brigadir/persistence';
export class Settings {
	private writes: Promise<unknown> = Promise.resolve();
	private pending = 0;
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.writes;
	}
	constructor(private dataDir?: string) {}
	async read(): Promise<AppSettings> {
		const store = await SessionStore.at(this.dataDir);
		// Editor fields added later (spec/diff-and-review#diff-base diffBase, spec/editor-code-intelligence#typing-help typing, spec/settings-modules-and-onboarding#intro codeTheme) read as their defaults; so do spec/agents-and-providers#cli-updates `agents.updateClis`, spec/architecture-and-platform#keep-awake `agents.keepAwake`, spec/tasks#archive `agents.archiveAfterDays` and spec/git#worktree-env `agents.copyEnvFiles` spec/browser-and-simulator#background `agents.browserActAnywhere` and spec/notifications-slack-notes-and-schedules#slack-agent-post `agents.slackPostWithoutAsking`.
		// spec/settings-modules-and-onboarding#settings-keys: a settings file written before the intro existed means the app was used already, so the intro counts as seen.
		try {
			const doc = await readDocument(await safePath(store.root, 'settings.json'));
			const value = doc.settings;
			const agents =
				isRecord(value) && isRecord(value.agents)
					? {
							agents: {
								...value.agents,
								...(!('maxConcurrent' in value.agents) ? { maxConcurrent: null } : {}),
								...(!('enabled' in value.agents)
									? { enabled: { ...defaultAppSettings.agents.enabled } }
									: {}),
								...(!('isolation' in value.agents)
									? { isolation: defaultAppSettings.agents.isolation }
									: {}),
								...(!('copyEnvFiles' in value.agents)
									? { copyEnvFiles: defaultAppSettings.agents.copyEnvFiles }
									: {}),
								...(!('reviewWhere' in value.agents)
									? { reviewWhere: defaultAppSettings.agents.reviewWhere }
									: {}),
								...(!('updateClis' in value.agents)
									? { updateClis: defaultAppSettings.agents.updateClis }
									: {}),
								...(!('keepAwake' in value.agents)
									? { keepAwake: defaultAppSettings.agents.keepAwake }
									: {}),
								...(!('archiveAfterDays' in value.agents)
									? { archiveAfterDays: defaultAppSettings.agents.archiveAfterDays }
									: {}),
								...(!('browserActAnywhere' in value.agents)
									? { browserActAnywhere: defaultAppSettings.agents.browserActAnywhere }
									: {}),
								...(!('slackPostWithoutAsking' in value.agents)
									? { slackPostWithoutAsking: defaultAppSettings.agents.slackPostWithoutAsking }
									: {}),
								// spec/appearance#evolution-redesign: the PR summary switch reads as on in a file written before it.
								...(!('prSummary' in value.agents)
									? { prSummary: defaultAppSettings.agents.prSummary }
									: {}),
								// spec/agents-and-providers#subagent-model: a file written before the setting keeps the session's model for subagents.
								...(!('claudeSubagentModel' in value.agents) ? { claudeSubagentModel: null } : {}),
							},
						}
					: {};
			const modules =
				isRecord(value) && isRecord(value.modules)
					? { modules: withModuleDefaults(value.modules) }
					: {};
			const editor =
				isRecord(value) && isRecord(value.editor)
					? { editor: { ...defaultAppSettings.editor, ...value.editor } }
					: {};
			const terminal =
				isRecord(value) && isRecord(value.terminal)
					? { terminal: { ...defaultAppSettings.terminal, ...value.terminal } }
					: {};
			// spec/remote-access-and-mobile#module-and-settings: a file from before remote access reads its defaults; a partial block fills its missing keys.
			const remoteAccess =
				isRecord(value) && isRecord(value.remoteAccess)
					? {
							remoteAccess: {
								...defaultRemoteAccess,
								...value.remoteAccess,
								listen: {
									...defaultRemoteAccess.listen,
									...(isRecord(value.remoteAccess.listen) ? value.remoteAccess.listen : {}),
								},
							},
						}
					: {};
			const notifications =
				isRecord(value) && isRecord(value.notifications) && !('mode' in value.notifications)
					? { notifications: migrateNotificationPreferences(value.notifications) }
					: {};
			const normalized = isRecord(value)
				? {
						...(!('suggestNextPrompt' in value) ? { suggestNextPrompt: false } : {}),
						...(!('modules' in value) ? { modules: { ...defaultModules } } : {}),
						...(!('agents' in value) ? { agents: structuredClone(defaultAppSettings.agents) } : {}),
						...(!('notifications' in value)
							? { notifications: structuredClone(defaultAppSettings.notifications) }
							: {}),
						...(!('toolbarLabels' in value) ? { toolbarLabels: 'icons' } : {}),
						// spec/task-window-workspace#two-columns: a file from before the choice keeps three columns.
						...(!('taskColumns' in value) ? { taskColumns: 'three' } : {}),
						...(!('accent' in value) ? { accent: 'system' } : {}),
						...(!('interfaceFont' in value)
							? { interfaceFont: structuredClone(defaultAppSettings.interfaceFont) }
							: {}),
						// spec/appearance#chat-text-size: a file from before the chat's own size follows the interface.
						...(!('chatFont' in value)
							? { chatFont: structuredClone(defaultAppSettings.chatFont) }
							: {}),
						...(!('typography' in value)
							? { typography: structuredClone(defaultAppSettings.typography) }
							: {}),
						...(!('terminal' in value)
							? { terminal: structuredClone(defaultAppSettings.terminal) }
							: {}),
						...(!('editor' in value) ? { editor: structuredClone(defaultAppSettings.editor) } : {}),
						...(!('projects' in value)
							? { projects: structuredClone(defaultAppSettings.projects) }
							: {}),
						...(!('keymap' in value) ? { keymap: structuredClone(defaultAppSettings.keymap) } : {}),
						...(!('remoteAccess' in value)
							? { remoteAccess: structuredClone(defaultRemoteAccess) }
							: {}),
						...(!('slack' in value) ? { slack: structuredClone(defaultSlackSettings) } : {}),
						// spec/architecture-and-platform#auto-update: a file from before app updates downloads them in the background.
						...(!('updates' in value)
							? { updates: structuredClone(defaultAppSettings.updates) }
							: {}),
						...(!('onboarding' in value)
							? { onboarding: { completedVersion: onboardingVersion } }
							: {}),
						...value,
						...modules,
						...agents,
						...editor,
						...terminal,
						...notifications,
						...remoteAccess,
						...('slack' in value ? { slack: withSlackDefaults(value.slack) } : {}),
					}
				: value;
			// spec/appearance#evolution-redesign: `suggestModel` became `helperAgent`; the choice carries over with the lowest effort.
			// spec/appearance#evolution-redesign: no `actionAgents` (or an entry that is not one) — that action inherits.
			// spec/pull-requests-and-ci#review-crew: no `actionCrews` — every review action runs one agent.
			const migrated = isRecord(normalized)
				? migrateActionCrews(migrateActionAgents(migrateHelperAgent(normalized)))
				: normalized;
			if (!isAppSettings(migrated)) throw new Error('Invalid settings');
			return migrated;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT')
				return {
					...structuredClone(defaultAppSettings),
					...(process.env.BRIGADIR_SKIP_INTRO === '1'
						? { onboarding: { completedVersion: onboardingVersion } }
						: {}),
				};
			throw error;
		}
	}
	save(value: AppSettings) {
		if (!isAppSettings(value)) throw new Error('Invalid settings');
		const settings = structuredClone(value);
		this.pending++;
		const write = this.writes
			.then(async () => {
				await this.read();
				const store = await SessionStore.at(this.dataDir);
				await mkdir(store.root, { recursive: true, mode: 0o700 });
				await atomicJson(await safePath(store.root, 'settings.json'), {
					schemaVersion: 1,
					settings,
				});
				return settings;
			})
			.finally(() => {
				this.pending--;
			});
		this.writes = write.catch(() => {});
		return write;
	}
}
