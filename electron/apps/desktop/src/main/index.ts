import './data-dir-move';
import { homedir, tmpdir } from 'node:os';
import { TaskActivities } from './task-activity';
import { TaskLabels } from './task-labels';
import { NoteChats } from './note-chats';
import {
	type AgentTask,
	type NotesChange,
	type NoteChatChoice,
	agentRelayLimits,
	loopbackRedirect,
	remoteUploadLimit,
} from '@brigadir/core';
import { relayToLoopback } from '@brigadir/remote';
import {
	agentOptionKind,
	catalogOptions,
	ghostModelPlan,
	helperCatalogProvider,
	helperPlan,
	actionChoice,
	taskLaunchOptions,
	withActionAgent,
	withActionCrew,
	actionCrewId,
	type AgentAction,
	type ActionCrew,
	type CrewAction,
	type CrewSpec,
	type HelperAgent,
	type HelperAction,
	type SlackAgentAction,
	type TaskAction,
	type HelperRun,
	quotaExhausted,
	taskSummaryPrefix,
	taskSummaryText,
} from '@brigadir/core';
import { LiveAgents } from './live-agents';
import { Quota, providerReaders, testQuota } from './quota';
import { Projects } from './projects';
import { TaskDiffs } from './task-diffs';
import { SidebarState } from './sidebar-state';
import { Knowledge } from './knowledge';
import { ghostDirectory, Ghosts, writeBranchWords, writeHintOneShot } from './ghosts';
import { generateCodexImage } from './codex-image';
import { ProjectIcons } from './project-icons';
import { QuickAsks } from './quick-ask';
import { ForgeActions } from './forge';
import { PullRequests } from './pull-requests';
import { ContextState } from './context-state';
import { isContextTool } from '@brigadir/core';
import { MainTrees } from './main-tree';
import { RemoteWatch } from './remote-watch';
import { externalLink } from '@brigadir/core';
import { Commits } from './commits';
import { Relays } from './relays';
import { TaskProposals } from './task-proposals';
import { defaultDataDir, readRelayHandoff } from '@brigadir/persistence';
import { ScopeControls } from './scope-controls';
import { LaunchLocks } from './launch-locks';
import { searchProjectFiles } from './project-files';
import { readSlashCatalog } from './slash-catalog';
import { LaunchSettingsStore } from './launch-settings';
import { Preparations } from './preparations';
import { withAutoBranch, branchNamePrompt } from '@brigadir/core';
import { TaskReads } from './task-reads';
import { NoticeLog } from './notice-log';
import { QuitGuard, type PendingWrite } from './quit-guard';
import { Boards } from './boards';
import { resolveReviewCrew, reviewCrewPrompt } from './review-crew';
import { ProjectViews } from './views';
import { personTasks } from '@brigadir/core';
import {
	isSimulatorAgentCommand,
	commandModule,
	moduleOffMessages,
	sameModules,
	type AppModule,
	commandAccelerator,
	normalizeAccelerator,
	menuCommands,
	menuCommandEnabled,
	emptyMenuContext,
	type DocumentTabMenuState,
	type MenuIconImages,
	menuCommandIcons,
	withGroupSeparators,
	appMenuIcons,
	roleMenuIcons,
	fileMenuIcons,
	turnMenuIcons,
	attachMenuIcons,
	noteMenuIcons,
	type EditorMenuState,
	type MenuContext,
	type TaskKey,
	type NoticeEntryKind,
	type QuickAskEvent,
	type CIFinished,
	type CIRunDetail,
	type TerminalCommand,
} from '@brigadir/core';
import { editorMenuTemplate } from './editor-menu';
import { documentTabMenuTemplate } from './document-tab-menu';
import { menuIcon, setMenuIcons } from './menu-icons';
import { chatMenuTemplate, terminalMenuTemplate, showEditMenu, copyImage } from './chat-menu';
import {
	ClientUi,
	electronUi,
	listFolder,
	createFolder,
	deviceRoleLabels,
	messageBox,
	nativeMenu,
	pageFilesLimit,
} from './client-ui';
import { RoutedNotices } from './remote-notices';
import { composeAppearance } from './appearance';
import { Fonts } from './fonts';
import { Settings } from './settings';
import {
	textSurfaces,
	defaultAppSettings,
	settingsLocale,
	type AppSettings,
	type CodeRestartResult,
	type Locale,
} from '@brigadir/core';
import { SidebarMenus } from './sidebar-menu';
import { PRMenus } from './pr-menu';
import { syntaxFencePath } from '@brigadir/core';
import {
	attachPaths,
	thumbnailPng,
	readMarkdown,
	pickFiles,
	uploadPaths,
	uploadAttachment,
} from './pick-attachments';
import { pasteAttachment, clipboardPng } from './paste-attachment';
import { ComposerDrafts } from './composer';
import { ActivityDetails } from './activity-details';
import { Layout } from './layout';
import { TaskSurfaces } from './surface';
import { GitHistory } from './git-history';
import {
	MAIN_TREE_ID,
	projectColors,
	projectIconColorAt,
	projectImageSide,
	type Project,
} from '@brigadir/core';
import { EditorBlames } from './editor-blame';
import {
	app,
	BrowserWindow,
	clipboard,
	shell,
	dialog,
	ipcMain,
	Menu,
	webContents,
	nativeTheme,
	screen,
	systemPreferences,
	powerSaveBlocker,
	powerMonitor,
	safeStorage,
	nativeImage,
} from 'electron';
import { RendererLog, RendererRestarts } from './renderer-recovery';
import { chromePlatform, windowFrame } from './window-chrome';
import { setShortcutPlatform } from '@brigadir/core';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	SessionStore,
	Attachments,
	TemplateStore,
	NotesStore,
	SchedulesStore,
	lastSessionStart,
} from '@brigadir/persistence';
import { Scheduler } from './schedules';
import {
	resolveCrew,
	templateLookup,
	crewIssues,
	crewPalette,
	composeCrewId,
	foremanTemplateId,
	isAgentTemplateDocument,
	isCrewTemplateDocument,
	type CrewLaunch,
	type ProviderCatalog,
	editedSchedule,
	missedRunsText,
	newSchedule,
	newScheduleId,
	type Schedule,
	type ScheduleDraft,
	type TaskLaunch,
	type PendingNotice,
} from '@brigadir/core';
import { readFile as readFileNode, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { EnvironmentCheckService, loginShellPath } from './environment';
import { CliUpdates } from './cli-updates';
import { AppUpdates, updateSupport, type UpdateDriver } from './app-updates';
import { appBundle, createUpdateDriver, macDeveloperId } from './app-updater';
import { releasePage, releasesRepo, type AppUpdateSupport } from '@brigadir/core';
import desktopManifest from '../../package.json';
import { KeepAwake, keepAwakeKinds, keepAwakeTimes, workingAgents } from './keep-awake';
import { TaskArchives } from './task-archive';
import { AgentLogin } from './agent-login';
import { probeAgentCatalog, adapterRefreshCommand } from '@brigadir/transport';
import { execFile, spawn } from 'node:child_process';
import { listRefs, discoverScopes, readRelayDiff } from '@brigadir/git';
import {
	fitWindowBounds,
	type WindowBounds,
	type AttachmentOwner,
	type TaskSheet,
	isBrowserCommand,
	isRecord,
	isTaskAgentRequest,
	resolveTaskAgent,
	providerName,
	t,
	type MessageKey,
	type Appearance,
} from '@brigadir/core';
import { Browsers, type ScreenOwner } from './browser';
import { Simulators } from './simulator';
import { SimulatorFrames } from './simulator-frames';
import { SimulatorQueue } from './simulator-queue';
import { Files, outsideTaskRepos } from './files';
import { TextSearches } from './text-search';
import { CodeIntelBridge } from './code-intel';
import { readFormatters, setProjectFormatter } from './format';
import { runProjectCommand, saveProjectCommands } from './project-commands';
import { readProjectScripts } from './package-scripts';
import { Reviews } from './review';
import { Changes } from './changes';
import { Sessions } from './sessions';
import { replacesDocument, TerminalWatchers } from './terminal-watchers';
import { Notifications, type NoticeGateway, type SoundPlayer } from './notifications';
import { NativeNotices } from './notifications-native';
import { CIWatches } from './ci-watch';
import {
	NotificationPermissionState,
	nativeAuthorization,
	type AuthorizationSource,
} from './notification-permission';
import { Sounds } from './sounds';
import { LaunchQueue } from './launch-queue';
import { readWorkspace, resolveDataRoot } from '@brigadir/persistence';
import { Clients, windowClient, type Client } from './clients';
import {
	isWebURL,
	type IpcInvokeChannel,
	type MachineAppearance,
	type PairedMachine,
	type AttachmentInput,
	type PromptAttachment,
	type RemoteNotify,
} from '@brigadir/core';
import {
	RemoteAccess,
	electronVault,
	remoteTestHooks,
	systemMachineName,
	type DeviceUi,
} from './remote-access';
import { Slack } from './slack';
import type { SlackSideThread, SlackTaskInput } from './slack-mentions';
import { SlackSessions } from './slack-sessions';
import type { SlackAnswerResult, SlackSendResult } from './slack-answers';
import { randomUUID } from 'node:crypto';
import {
	idleStopped,
	noteTitle,
	notificationPermissionChoices,
	pendingInputs,
	planSummary,
	slackQuestionChoices,
	slackTaskAgent,
	selectOption,
	type SlackAnswer,
	type SlackAsk,
	type SlackTaskInfo,
} from '@brigadir/core';
import { dispatchCall, type Handler } from './dispatch';
import { servicesDir } from './services-dir';
import { keyStoreState } from './key-store';

app.setName('Brigadir');
// spec/architecture-and-platform#data-root: the dev copy is Electron's bundle, whose Info.plist names Electron's version; the panel shows ours.
app.setAboutPanelOptions({
	applicationVersion: app.getVersion(),
	...(app.isPackaged ? {} : { version: 'dev' }),
});
/** spec/remote-access-and-mobile#architecture: every event main sends goes to this set; today it holds the local window only. */
const clients = new Clients();
// Agent launches must not activate macOS or interrupt the user's other work.
const background = process.env.BRIGADIR_BACKGROUND === '1';
/** A background launch stays inactive until the person focuses its window once (spec/search-menus-and-commands#menu-after-background-launch). */
let focusedOnce = false;
const secondaryDisplay = process.env.BRIGADIR_DISPLAY === 'secondary';
if (background && process.platform === 'darwin') app.setActivationPolicy('accessory');
const environment = new EnvironmentCheckService();
/** Installs the latest GUI adapters into the npx cache without running them; at start and on «Check now» (spec/agents-and-providers#cli-updates). */
const refreshAdapters = () =>
	Promise.all(
		(['claude', 'codex'] as const).map(
			(provider) =>
				new Promise<void>((resolve) => {
					const launch = adapterRefreshCommand(provider);
					const child = spawn(launch.command, launch.args, {
						stdio: 'ignore',
						env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
					});
					const timer = setTimeout(() => child.kill(), 180_000);
					timer.unref();
					const done = () => {
						clearTimeout(timer);
						resolve();
					};
					child.once('exit', done);
					child.once('error', done);
				})
		)
	).then(() => {});
/** spec/composer-steering-queue-and-ghost#ghost-headless: forgets the probed model catalogs, so the next sheet asks a freshly updated CLI; set with the handlers. */
let forgetCatalogs = () => {};
const cliUpdates = new CliUpdates(process.env.BRIGADIR_DATA_DIR, {
	run: async (provider, args, timeout) => {
		const cli = await environment.cliCommand(provider);
		if (!cli) return null;
		// Nobody answers a prompt in the background: stdin closes at once, and Codex's installer runs non-interactively.
		return new Promise((done) => {
			const child = execFile(
				cli.command,
				[...cli.args, ...args],
				{
					env: { ...cli.env, ...(provider === 'codex' ? { CODEX_NON_INTERACTIVE: '1' } : {}) },
					timeout,
					maxBuffer: 1 << 20,
				},
				(error, stdout, stderr) => {
					const code = error
						? typeof (error as { code?: unknown }).code === 'number'
							? Number((error as { code: number }).code)
							: 1
						: 0;
					done({ code, stdout: String(stdout), stderr: String(stderr) });
				}
			);
			child.stdin?.end();
		});
	},
	settings: () => ({
		providers: (['claude', 'codex'] as const).filter(
			(provider) => appliedSettings.agents.enabled[provider]
		),
		background: appliedSettings.agents.updateClis,
	}),
	refreshAdapters: () => (process.env.BRIGADIR_DATA_DIR ? Promise.resolve() : refreshAdapters()),
	changed: (status) => {
		if (!status.running) forgetCatalogs();
		clients.broadcast('cli-updates:changed', status);
	},
	log: (line) => console.error(line),
});
// spec/architecture-and-platform#auto-update: Brigadir's own updates. Until `setUpAppUpdates` knows how this build updates, nothing is checked.
const appUpdateDeps = (support: AppUpdateSupport, driver: UpdateDriver | null) => {
	const repo = releasesRepo(desktopManifest.releases);
	return {
		support,
		current: app.getVersion(),
		driver,
		releaseUrl: (version: string) => (repo ? releasePage(repo, version) : null),
		autoDownload: () => appliedSettings.updates.autoDownload,
		// A turn that has not ended: the agent works or waits for the person mid-turn.
		runningTurns: async () =>
			(await sessions.workspace()).tasks.filter(
				(task) => task.status === 'working' || task.status === 'needs-you'
			).length,
		relaunching: () => restartRequested,
		changed: (state: ReturnType<AppUpdates['status']>) => {
			clients.broadcast('app-update:changed', state);
		},
		log: (line: string) => console.error(line),
	};
};
let appUpdates = new AppUpdates(appUpdateDeps('off', null));
async function setUpAppUpdates() {
	const repo = releasesRepo(desktopManifest.releases),
		feedUrl = (app.isPackaged && process.env.BRIGADIR_UPDATE_URL) || undefined;
	const developerId =
		app.isPackaged && process.platform === 'darwin'
			? await macDeveloperId(appBundle(process.execPath))
			: false;
	const support = updateSupport({
		packaged: app.isPackaged,
		platform: process.platform,
		configured: Boolean(repo || feedUrl),
		developerId,
		appImage: Boolean(process.env.APPIMAGE),
	});
	if (support === 'off') return;
	let driver: UpdateDriver;
	try {
		driver = createUpdateDriver({
			platform: process.platform,
			appImage: process.env.APPIMAGE,
			feedUrl,
			log: (line) => console.error(line),
			relaunchAfterQuit: (path) => {
				updateRelaunchPath = path;
				restartRequested = true;
			},
			failed: (error) => updates.failed(error),
		});
	} catch (error) {
		console.error(
			`app-update: the updater could not start: ${error instanceof Error ? error.message : String(error)}`
		);
		return;
	}
	const updates = new AppUpdates(appUpdateDeps(support, driver));
	appUpdates = updates;
	clients.broadcast('app-update:changed', updates.status());
	rebuildMenu?.();
	// Test builds use their own data dir and never reach the network on their own.
	if (!process.env.BRIGADIR_DATA_DIR) updates.start();
}
// spec/agents-and-providers#sign-in-recovery: one in-app sign-in per agent; after it every live host of that agent retries its failed turn.
/** spec/remote-access-and-mobile#networking: the device that started each agent's sign-in, and the requests it relayed. */
const signInRelays = new Map<'claude' | 'codex', { deviceId: string; count: number }>();
const agentLogin = new AgentLogin({
	command: (provider, quiet) => environment.loginCommand(provider, quiet),
	signedIn: (provider) => environment.signedIn(provider),
	openUrl: (url) => shell.openExternal(url),
	publish: (state) => {
		clients.broadcast('agent-login:changed', state);
	},
	retry: (provider) => sessions.retryAfterSignIn(provider),
});
const launchSettings = new LaunchSettingsStore(
	process.env.BRIGADIR_DATA_DIR,
	() => appliedSettings.agents.isolation,
	() => appliedSettings.agents.copyEnvFiles
);
const launchLocks = new LaunchLocks(
	process.env.BRIGADIR_DATA_DIR,
	servicesDir,
	(key) => {
		clients.broadcast('session:event', { key, record: null });
	},
	(conflict) => {
		clients.broadcast('launch:conflict', conflict);
	}
);
const preparations = new Preparations(
	process.env.BRIGADIR_DATA_DIR,
	servicesDir,
	(key) => {
		clients.broadcast('session:event', { key, record: null });
	},
	(title, prompt, signal) => nameBranch(title, prompt, signal)
);
// spec/agents-and-providers#provider-terms: knowledge additions are written by the Helper agent (spec/composer-steering-queue-and-ghost#ghost-headless), like every other one-off text.
const knowledge = new Knowledge(process.env.BRIGADIR_DATA_DIR, async (prompt, signal) => {
	const target = await ghostTarget(signal);
	if (!target) throw new Error('The helper agent is off.');
	return writeHintOneShot(prompt, signal, target, 16000, 90000, false, {
		fixture: process.env.BRIGADIR_TEST_KNOWLEDGE,
	});
});
const projects = new Projects(process.env.BRIGADIR_DATA_DIR);
const taskActivities = new TaskActivities(process.env.BRIGADIR_DATA_DIR);
const taskLabels = new TaskLabels(process.env.BRIGADIR_DATA_DIR);
const taskDiffs = new TaskDiffs(process.env.BRIGADIR_DATA_DIR);
const sidebarState = new SidebarState(process.env.BRIGADIR_DATA_DIR);
const taskReads = new TaskReads(process.env.BRIGADIR_DATA_DIR);
const projectViews = new ProjectViews(process.env.BRIGADIR_DATA_DIR);
const layout = new Layout(process.env.BRIGADIR_DATA_DIR);
const settings = new Settings(process.env.BRIGADIR_DATA_DIR);
let appliedSettings = structuredClone(defaultAppSettings);
let shortcutRecording = false;
// spec/architecture-and-platform#window-frame: Windows and Linux wear the OS buttons in our strip and open the app menu from ☰; BRIGADIR_CHROME_PLATFORM previews that on a Mac.
const chrome = chromePlatform(
	process.platform,
	process.env.BRIGADIR_CHROME_PLATFORM,
	app.isPackaged
);
setShortcutPlatform(chrome);
let appMenuOpen = false;
const fonts = new Fonts(join(servicesDir, 'fonts'), publishAppearance);
// spec/architecture-and-platform#crash-recovery: the log outlives a restart; a lost renderer comes back on its own once a minute.
const rendererLog = new RendererLog(async () =>
		join((await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).root, 'logs/renderer.jsonl')
	),
	rendererRestarts = new RendererRestarts();
let appliedLanguage: AppSettings['language'] = 'system',
	restartRequested = false;
/** spec/architecture-and-platform#auto-update: an AppImage that installed an update relaunches from the file it was installed to. */
let updateRelaunchPath: (() => string | undefined) | null = null;
function currentLocale(): Locale {
	return settingsLocale({ ...defaultAppSettings, language: appliedLanguage }, app.getLocale());
}
let window: BrowserWindow | null = null;
let consolesClosed = false;
let discarding = false;
let quitRequested = false;
let closePrompt = false;
/** spec/task-window-workspace#restore-window: the window's tasks wrote their surfaces and their unsaved buffers for this close. */
let surfaceFlushed = false;
/**
 * spec/task-window-workspace#restore-window: which unsaved buffers this close kept in `drafts/` — the file ids the window wrote;
 * `'all'` — a quit whose window did not answer (as before, it asks nothing); `'none'` — a window close it did not answer.
 */
let hotExitKept: Set<string> | 'all' | 'none' = 'none';
/** The drafts the window writes during the flush now, and the tasks they belong to (a «Keep editing» takes them back). */
const flushKept = new Set<string>(),
	flushDraftTasks = new Map<string, TaskKey>();
/** The unsaved buffers this close would lose: those hot exit could not keep (the main tree, a buffer past the limit). */
function unkeptPaths() {
	if (hotExitKept === 'all') return [];
	return files.unsavedExcept(hotExitKept === 'none' ? new Set() : hotExitKept);
}
/** spec/task-window-workspace#restore-window: the window's last size and place; read once at start, kept current as the window moves. */
let savedWindow: WindowBounds | null = null;
let flushSeq = 0;
const flushWaiters = new Map<number, () => void>();
/** spec/remote-access-and-mobile#browser-from-device: a device's window that closes — the drafts it keeps, apart from this machine's own close. */
const deviceFlushes = new Map<string, { kept: Set<string>; tasks: Map<string, TaskKey> }>();
/** Which client marked a buffer unsaved. */
const dirtyOwners = new Map<string, string>();
/** One device's window writes its surfaces and its unsaved buffers (hot exit), as this machine's own does on close. */
function flushClientSurfaces(client: Client): Promise<boolean> {
	const id = ++flushSeq;
	return new Promise<boolean>((resolve) => {
		const done = (answered: boolean) => {
			clearTimeout(timer);
			flushWaiters.delete(id);
			resolve(answered);
		};
		const timer = setTimeout(() => done(false), 2000);
		flushWaiters.set(id, () => done(true));
		if (!client.send('surface:flush', { id, drafts: true })) done(false);
	});
}
/** Asks the window to write every task's surface now (the 500 ms wait skipped) and, on a hot exit, its unsaved buffers. */
function flushSurfaces(drafts: boolean): Promise<boolean> {
	const target = window;
	if (!target || target.isDestroyed() || target.webContents.isCrashed())
		return Promise.resolve(false);
	const id = ++flushSeq;
	return new Promise<boolean>((resolve) => {
		const done = (answered: boolean) => {
			clearTimeout(timer);
			flushWaiters.delete(id);
			resolve(answered);
		};
		// A window that does not answer (still loading, hung) does not hold the close.
		const timer = setTimeout(() => done(false), 2000);
		flushWaiters.set(id, () => done(true));
		clients.broadcast('surface:flush', { id, drafts });
	});
}
let windowTimer: ReturnType<typeof setTimeout> | undefined;
function rememberWindow(now = false) {
	clearTimeout(windowTimer);
	const save = () => {
		const target = window;
		if (!target || target.isDestroyed() || target.isFullScreen() || target.isMinimized()) return;
		const bounds = { ...target.getNormalBounds(), maximized: target.isMaximized() };
		if (JSON.stringify(bounds) === JSON.stringify(savedWindow)) return;
		savedWindow = bounds;
		void layout.saveWindow(bounds).catch(() => {});
	};
	if (now) save();
	else windowTimer = setTimeout(save, 500);
}
const rendererFile = join(__dirname, '../renderer/index.html');
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const entry = developmentUrl ?? pathToFileURL(rendererFile).href;
const localClient = windowClient(() => window, entry, Boolean(developmentUrl));
clients.add(localClient);
/** spec/remote-access-and-mobile#client-ui-seam: menus and dialogs open over the window of the client that asked; a device gets them as data. */
const ui = new ClientUi(electronUi, () => (window && !window.isDestroyed() ? window : null));
/** The name a device sees in «Add a project from studio» (spec/remote-access-and-mobile#module-and-settings). */
const machineName = () => appliedSettings.remoteAccess.machineName ?? systemMachineName();
const fromMachine = (key: MessageKey) =>
	t(currentLocale(), key).replace('{machine}', machineName());
/** spec/architecture-and-platform#ipc-boundary: every invoke channel's handler, run only through `dispatch`. */
const handlers = new Map<string, Handler>();
function register(channel: IpcInvokeChannel, run: Handler) {
	handlers.set(channel, run);
	ipcMain.handle(channel, (event, ...args: unknown[]) =>
		dispatch(clients.from(event), channel, args)
	);
}
const dispatch = (client: Client | null, channel: string, args: unknown[]): Promise<unknown> => {
	return dispatchCall(
		{
			handlers,
			guardSettings: (from, value) => remoteAccess.guardSettings(from, value),
			isActive: (from) => remoteAccess.isActive(from),
			refused: (from, refusedChannel) => remoteAccess.callRefused(from, refusedChannel),
		},
		client,
		channel,
		args
	);
};
/** spec/remote-access-and-mobile#architecture: the gateway and the device's connections; Settings ▸ Remote and `File ▸ Connect…` drive it. */
const remoteAccess: RemoteAccess = new RemoteAccess({
	dataDir: process.env.BRIGADIR_DATA_DIR,
	clients,
	dispatch: (client, channel, args) => dispatch(client, channel, args),
	settings: () => appliedSettings,
	saveRemoteSettings: async (next) => {
		appliedSettings = await settings.save({ ...appliedSettings, remoteAccess: next });
		return appliedSettings;
	},
	holdChanged: () => keepAwake.settingChanged(),
	openWindow: (machine) => openRemoteWindow(machine),
	entry,
	development: Boolean(developmentUrl),
	log: (line) => console.error(line),
	// spec/remote-access-and-mobile#architecture: someone works here — this window in front and the keyboard or mouse used in the last two minutes.
	localPresent: () =>
		!!window &&
		!window.isDestroyed() &&
		window.isFocused() &&
		powerMonitor.getSystemIdleTime() < 120,
	// spec/remote-access-and-mobile#client-ui-seam: what a connected machine asks this device to show, shown here.
	device: deviceUi(),
	// A device went away: its open menus and dialogs close as cancelled, its browser streams and simulator columns end.
	detached: (client) => {
		ui.forget(client);
		browsers.forgetOwner(client.id);
		forgetSimulatorWatches(client);
		for (const { task, id } of terminalWatchers.forget(client.id)) {
			const [projectId, taskId] = task.split('/') as [string, string];
			void sessions.terminal({ projectId, id: taskId }, { kind: 'unwatch', id }).catch(() => {});
		}
	},
	// spec/remote-access-and-mobile#browser-from-device: a device in control gets the pages; this machine's window (under the cover) lets its views go.
	controlChanged: () =>
		browsers.controlChanged(
			(id) => remoteAccess.isActiveId(id),
			remoteAccess.activeDevice() !== null
		),
	// spec/remote-access-and-mobile#phone-network: the phone's bundle, built next to the renderer.
	webVersion: app.getVersion(),
	webBundle: existsSync(join(__dirname, '../renderer-mobile/bundle-manifest.json'))
		? join(__dirname, '../renderer-mobile')
		: null,
	// e2e only, never in a packaged build: no OS keychain prompt, two instances on loopback (spec/remote-access-and-mobile#pairing).
	...remoteTestHooks(process.env, app.isPackaged),
});
// spec/remote-access-and-mobile#networking: an unpackaged e2e run may make the machine sleep, break its network path or change this device's.
if (
	!app.isPackaged &&
	process.env.BRIGADIR_DATA_DIR &&
	process.env.BRIGADIR_TEST_REMOTE_VAULT === '1'
)
	(globalThis as any).brigadirRemoteTest = remoteAccess.testHooks();
const changes = new Changes(process.env.BRIGADIR_DATA_DIR, join(servicesDir, 'diff.cjs'));
const activityDetails = new ActivityDetails(changes);
const reviews = new Reviews(changes, (key) => {
	clients.broadcast('review:changed', key);
});
const composer = new ComposerDrafts(process.env.BRIGADIR_DATA_DIR);
// spec/browser-and-simulator#simulator: devices and frames of the simulator column; frames go to the window as they come, the renderer decodes them.
// Test builds replace xcrun and the helper with a fixture: {xcodebuild, simctl, helper}.
const simulatorFixture = process.env.BRIGADIR_TEST_SIMULATOR
	? (JSON.parse(readFileSync(process.env.BRIGADIR_TEST_SIMULATOR, 'utf8')) as {
			xcodebuild: string;
			simctl: unknown;
			helper: string;
		})
	: null;
let fixtureOrientation = 'portrait';
const simulators = new Simulators(
	process.env.BRIGADIR_DATA_DIR,
	simulatorFixture?.helper ?? join(servicesDir, 'sim-helper'),
	(event) => {
		clients.broadcast('simulator:event', event);
	},
	(projectId, frame) => {
		simulatorFrames.frame(projectId, frame);
	},
	simulatorFixture
		? {
				run: async (_file, args) => {
					if (args[0] === 'devicectl') {
						if (args[3] === 'rotate') fixtureOrientation = 'landscapeLeft';
						return `Current Device Orientation: ${fixtureOrientation}`;
					}
					return args[0] === 'xcodebuild'
						? simulatorFixture.xcodebuild
						: args[1] === 'list'
							? JSON.stringify(simulatorFixture.simctl)
							: '';
				},
				android: async () => null,
				detach: () => {},
			}
		: undefined
);
// spec/remote-access-and-mobile#browser-from-device: frames each window may miss on its own; a device that missed one waits for a key frame.
const simulatorFrames = new SimulatorFrames(clients, (projectId) => {
	void simulators.keyframe(projectId).catch(() => {});
});
/** spec/remote-access-and-mobile#phone-task-tools: terminal outputs each client watches; a device's go when its connection goes. */
const terminalWatchers = new TerminalWatchers();
/**
 * spec/remote-access-and-mobile#outbox (security review W2, J3): the window's renderer went away (reload, crash, close) — its terminal watches go,
 * but an output a phone or another device still shows keeps coming to them.
 */
function releaseWindowWatches() {
	terminalWatchers.forget(localClient.id);
	sessions.unwatchAll((task, id) => terminalWatchers.watched(task, id));
}
/** spec/remote-access-and-mobile#browser-from-device: the simulator columns each device watches, released when its connection goes. */
const simulatorWatches = new Map<string, Map<string, number>>();
function forgetSimulatorWatches(client: Client) {
	simulatorFrames.forget(client);
	const watches = simulatorWatches.get(client.id);
	simulatorWatches.delete(client.id);
	for (const [projectId, count] of watches ?? [])
		for (let index = 0; index < count; index++)
			void simulators.command(projectId, { kind: 'watch', on: false }).catch(() => {});
}
// spec/agents-and-providers#tools-awareness: crew workers take the project's one device in turns; their sidebar line shows who waits.
const simulatorQueue = new SimulatorQueue({
	onWaiting: (projectId, waiting) => {
		clients.broadcast('simulator:event', { projectId, waiting });
	},
});
/** spec/browser-and-simulator#notifications: the pages' notices of the OS, so a page's `close()` removes its own. */
const pageNotices = new Map<string, { close(): void }>();
const browsers = new Browsers(
	process.env.BRIGADIR_DATA_DIR,
	() => window,
	(key, event) => {
		clients.broadcast('browser:event', { key, event });
	},
	syncMenuFocus,
	(key, tab, front) => {
		clients.broadcast('browser:show', { key, tab, front });
	},
	(key, info) => {
		clients.broadcast('browser:tab', { key, info });
	},
	{
		// spec/browser-and-simulator#background: the sidebar marks a task whose page lives off screen.
		live: (keys) => {
			clients.broadcast('browser:live', keys);
		},
		onScreen: (key) => visibleTask?.id === key.id && visibleTask.projectId === key.projectId,
		// spec/browser-and-simulator#notifications: a page's notification out of sight is a silent notice of the OS; a click opens the tab.
		pageNotification: (key, tab, notice) => {
			const id = `page:${tab}:${notice.tag || notice.id}`;
			void notifications
				.page(
					key,
					{
						id,
						title: notice.title || notice.host,
						body: notice.body ? `${notice.host} · ${notice.body}` : notice.host,
					},
					() => browsers.notificationClicked(key, tab, notice.id)
				)
				.then((handle) => {
					if (handle) pageNotices.set(`${key.projectId}/${key.id}#${tab}#${notice.id}`, handle);
					for (const old of pageNotices.keys()) {
						if (pageNotices.size <= 200) break;
						pageNotices.delete(old);
					}
				});
		},
		pageNotificationClose: (key, tab, id) => {
			const name = `${key.projectId}/${key.id}#${tab}#${id}`;
			pageNotices.get(name)?.close();
			pageNotices.delete(name);
		},
		// spec/task-window-workspace#restore-window: a tab's new mode is in surface.json at once, not at the next layout change.
		modeChanged: (key) => {
			void surfaces.refresh(key).catch(() => {});
		},
		freezeMs:
			process.env.BRIGADIR_DATA_DIR && process.env.BRIGADIR_TEST_BROWSER_FREEZE_MS
				? Number(process.env.BRIGADIR_TEST_BROWSER_FREEZE_MS)
				: undefined,
	}
);
/** spec/notifications-slack-notes-and-schedules#schedules: the «Needs you» rows of schedules whose missed slots wait for the person, and the answer to one. */
let schedulePending: PendingNotice[] = [];
let scheduleAnswer: ((id: string, option: 'allow' | 'deny') => void) | undefined;
/** spec/notifications-slack-notes-and-schedules#schedules: set once the scheduler exists; a journal record of a quiet run is looked at again, a module change re-arms it. */
let scheduleEvents: ((key: TaskKey) => void) | undefined;
let scheduleSettings: (() => void) | undefined;
const sessions = new Sessions(
	process.env.BRIGADIR_DATA_DIR,
	servicesDir,
	(key, record) => {
		if (record && visibleTask?.id === key.id && visibleTask.projectId === key.projectId)
			void taskReads.mark(key, record.seq).catch(() => {});
		if (record?.event.kind === 'checkpoint.created') void codeIntel.checkpoint(key);
		if (record) scheduleEvents?.(key);
		if (!record || keepAwakeKinds.has(record.event.kind)) {
			keepAwake.refresh();
			appUpdates.turnsChanged();
		}
		if (record) {
			if (['turn.completed', 'session.failed', 'host.stopped'].includes(record.event.kind))
				simulatorQueue.release(key);
			quota.observe(key, record);
			ghosts.observe(key, record);
			if (record.event.kind === 'turn.completed')
				void knowledge.observe(key.projectId).catch(() => {});
			// spec/browser-and-simulator#background: the task clipboard lives as long as the task's host.
			if (record.event.kind === 'host.stopped') browsers.forgetClipboard(key);
			notifications.observe(key, record);
			if (
				[
					'turn.completed',
					'session.failed',
					'host.stopped',
					'rate-limit.changed',
					'rate-limit.expired',
				].includes(record.event.kind)
			)
				void launches.kick();
		}
		clients.broadcast('session:event', { key, record });
	},
	(key, event) => {
		clients.broadcast('terminal:event', { key, event });
	},
	async (key, method, params) => {
		/* spec/projects-and-board#folders-mid-task, spec/projects-and-board#external-folders: `add_folder` describes the folder for this task only; the project does not change. */ if (
			method === 'folder' &&
			isRecord(params) &&
			typeof params.path === 'string'
		) {
			const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
			return launchSettings.describeFolder(
				key.projectId,
				params.path,
				(await store.task(key)).launch?.scopes
			);
		}
		// spec/tasks#agent-created-tasks: the agent `create_task` names, checked against the catalog the sheet and the crew use.
		if (method === 'task_agent' && isTaskAgentRequest(params)) {
			if (!appliedSettings.agents.enabled[params.provider])
				throw new Error(`${providerName(params.provider)} is turned off in the Brigadir settings.`);
			return resolveTaskAgent(
				params,
				params.model || params.effort
					? await providerCatalogs(params.provider).catch(() => null)
					: null
			);
		}
		// spec/editor-code-intelligence#language-server-restart: the agent's `editor_restart_language_servers`.
		if (method === 'code_restart') return restartCode(key);
		// spec/notifications-slack-notes-and-schedules#slack-agent-post: the agent's `slack_post` — where and as whom, then the post itself.
		if ((method === 'slack_target' || method === 'slack_post') && isRecord(params)) {
			if (!appliedSettings.modules.slack) throw new Error(moduleOffMessages.slack);
			const input = {
				channel: typeof params.channel === 'string' ? params.channel : undefined,
				thread: typeof params.thread === 'string' ? params.thread : undefined,
			};
			if (method === 'slack_target') {
				const { bot, label } = await slack.agentTarget(key, input);
				return { bot, label };
			}
			if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('text is empty');
			return slack.agentPost(key, { ...input, text: params.text });
		}
		if (method === 'context' && isRecord(params) && isContextTool(params.tool)) {
			if (params.tool === 'pr' && !appliedSettings.modules.pullRequests)
				throw new Error(moduleOffMessages.pullRequests);
			return contextState.answer(key, params.tool);
		}
		if (method.startsWith('browser') && !appliedSettings.modules.browser)
			throw new Error(moduleOffMessages.browser);
		if (method === 'simulator') {
			if (!appliedSettings.modules.simulator) throw new Error(moduleOffMessages.simulator);
			if (!isSimulatorAgentCommand(params)) throw new Error('Invalid simulator operation');
			const { queued, ...command } = params as typeof params & { queued?: unknown };
			return simulatorQueue.run(key, queued === true, () => simulators.agent(key, command));
		}
		if (method === 'browser' && isBrowserCommand(params)) return browsers.agent(key, params);
		// spec/browser-and-simulator#background: «Show» on the agent's request opens its task with the browser column.
		if (method === 'browser_show') {
			openTask(key);
			return browsers.reveal(key);
		}
		if (isRecord(params) && typeof params.url === 'string') {
			if (method === 'browser_allowed') return browsers.allowed(key, params.url);
			if (method === 'browser_remember') return browsers.remember(key, params.url);
			// spec/browser-and-simulator#background: Settings ▸ Modules ▸ Browser lets agents act on any site without the card.
			if (method === 'browser_act_allowed')
				return (
					appliedSettings.agents.browserActAnywhere || browsers.allowed(key, params.url, 'act')
				);
			if (method === 'browser_act_remember') return browsers.remember(key, params.url, 'act');
		}
		throw new Error('Invalid browser request');
	}
);
// spec/architecture-and-platform#auto-update: a packaged app replaces hosts started from another version's bundle at their next turn boundary.
sessions.appVersion = app.isPackaged ? app.getVersion() : null;
// spec/architecture-and-platform#keep-awake: the Mac does not idle-sleep while an agent works (`workingAgents`); events in `keepAwakeKinds` recount.
// Test builds shorten the release delay.
const keepAwakeRelease =
	process.env.BRIGADIR_DATA_DIR && process.env.BRIGADIR_TEST_KEEP_AWAKE_RELEASE_MS
		? Number(process.env.BRIGADIR_TEST_KEEP_AWAKE_RELEASE_MS)
		: keepAwakeTimes.releaseMs;
const keepAwake = new KeepAwake(
	{
		count: async () => workingAgents((await sessions.workspace()).tasks),
		enabled: () => appliedSettings.agents.keepAwake,
		held: () => remoteAccess.holding(),
		blocker: {
			start: () => powerSaveBlocker.start('prevent-app-suspension'),
			stop: (id) => {
				powerSaveBlocker.stop(id);
			},
		},
		changed: (status) => {
			clients.broadcast('keep-awake:changed', status);
		},
		log: (line) => console.error(line),
	},
	{
		...keepAwakeTimes,
		releaseMs:
			Number.isFinite(keepAwakeRelease) && keepAwakeRelease >= 0
				? keepAwakeRelease
				: keepAwakeTimes.releaseMs,
	}
);
// Test builds record deliveries instead of reaching Notification Center or the speakers.
const notificationsTest =
	process.env.BRIGADIR_TEST_NOTIFICATIONS === '1'
		? ((): {
				gateway: NoticeGateway;
				sounds: SoundPlayer;
				active: () => boolean | null;
				authorization: AuthorizationSource;
			} => {
				const log: {
					shown: { notice: unknown; handlers: unknown; closed: boolean }[];
					sounds: string[];
					removedGroups: string[];
					badges: number[];
					active: boolean | null;
					permission: string;
					answer: string;
					requests: number;
				} = {
					shown: [],
					sounds: [],
					removedGroups: [],
					badges: [],
					active: null,
					permission: process.env.BRIGADIR_TEST_NOTIFICATION_PERMISSION ?? 'granted',
					answer: 'granted',
					requests: 0,
				};
				(globalThis as any).brigadirNotifications = log;
				return {
					authorization: {
						status: async () => log.permission,
						request: async () => {
							log.requests++;
							log.permission = log.answer;
							return log.permission;
						},
					},
					gateway: {
						supported: () => true,
						show(notice, handlers) {
							const entry = { notice, handlers, closed: false };
							log.shown.push(entry);
							return {
								close: () => {
									entry.closed = true;
								},
							};
						},
						removeGroup(groupId) {
							log.removedGroups.push(groupId);
						},
					},
					sounds: {
						play(name) {
							log.sounds.push(name);
						},
					},
					active: () => log.active,
				};
			})()
		: null;
let visibleTask: { projectId: string; id: string } | null = null;
/** spec/composer-steering-queue-and-ghost#ghost-headless: the provider catalogs the launch sheet uses; set once the handlers are registered. */
let providerCatalogs: (
	provider: 'claude' | 'codex'
) => Promise<ProviderCatalog | null> = async () => null;
/** spec/composer-steering-queue-and-ghost#ghost-headless: a catalog the probe has already returned; the default never waits for a probe. */
let knownCatalog: (provider: 'claude' | 'codex') => ProviderCatalog | undefined = () => undefined;
/** The chosen provider's catalog decides whether the chosen model is still offered. The default uses a catalog only once
 *  it is known (a Codex catalog without Luna goes to Haiku); before that it is matched by name during the call.
 *  spec/appearance#evolution-redesign: `run` — the capsule's one-time choice — wins while its provider is on. */
const ghostTarget = async (
	signal: AbortSignal,
	run?: HelperRun | null,
	/** spec/appearance#evolution-redesign: the action's own agent of Customize per action comes after the one-time choice. */
	action?: HelperAction | SlackAgentAction
) => {
	const choice = appliedSettings.helperAgent,
		enabled = appliedSettings.agents.enabled,
		catalogs: Partial<Record<'claude' | 'codex', ProviderCatalog | null>> = {};
	const pick = action
		? actionChoice(action, run, appliedSettings.actionAgents, enabled, knownCatalogs()).run
		: run && enabled[run.provider]
			? run
			: null;
	if (pick) return helperPlan(pick, choice, enabled, catalogs).target;
	const probe = helperCatalogProvider(choice, enabled),
		known = probe ? knownCatalog(probe) : undefined;
	if (probe && probe === choice?.provider)
		catalogs[probe] = await Promise.race([
			providerCatalogs(probe).catch(() => null),
			new Promise<null>((resolve) =>
				signal.addEventListener('abort', () => resolve(null), { once: true })
			),
		]);
	else if (probe && known) catalogs[probe] = known;
	return ghostModelPlan(choice, enabled, catalogs).target;
};
/** The catalogs the probes have already returned: a setting whose model a known catalog no longer lists is skipped. */
const knownCatalogs = () =>
	Object.fromEntries(
		(['claude', 'codex'] as const).flatMap((provider) => {
			const catalog = knownCatalog(provider);
			return catalog ? [[provider, catalog]] : [];
		})
	) as Partial<Record<'claude' | 'codex', ProviderCatalog>>;
/** spec/appearance#evolution-redesign: a one-off text of the Helper agent (commit message, PR text, PR summary, review word, verdict).
 *  spec/appearance#evolution-redesign: the capsule's one-time choice → the action's own agent → the Helper agent. */
async function helperText(
	prompt: string,
	signal: AbortSignal,
	run: HelperRun | null | undefined,
	action: HelperAction,
	characterLimit = 12000,
	timeoutMs = 90000
) {
	const target = await ghostTarget(signal, run, action);
	if (!target) throw new Error('The helper agent is off.');
	return {
		text: await writeHintOneShot(prompt, signal, target, characterLimit, timeoutMs, false),
		provider: target.provider,
	};
}
/** spec/git#agent-branch-names: the hint model names an auto branch; a disabled provider or an exhausted window keeps the derived name. */
async function nameBranch(title: string, prompt: string, signal: AbortSignal) {
	const target = await ghostTarget(signal, null, 'branchName');
	if (!target || quotaExhausted(quota.read(), target.provider)) return '';
	return writeBranchWords(branchNamePrompt(title, prompt), signal, target);
}
/** spec/appearance#evolution-redesign: the hint model picks the project icon; a disabled provider or an exhausted window — no pick. */
const projectIcons = new ProjectIcons({
	...(process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}),
	write: async (prompt, signal) => {
		const target = await ghostTarget(signal, null, 'projectIcon');
		if (!target || quotaExhausted(quota.read(), target.provider)) return null;
		return writeHintOneShot(prompt, signal, target, 600);
	},
	changed: (projectId) =>
		clients.broadcast('session:event', { key: { projectId, id: MAIN_TREE_ID }, record: null }),
	thumbnail: (path, size) => {
		const image = nativeImage.createFromPath(path);
		if (image.isEmpty()) return null;
		const url = image.resize({ width: size, height: size, quality: 'best' }).toDataURL();
		return url.startsWith('data:image/png;base64,') && url.length <= 96_000 ? url : null;
	},
	// spec/projects-and-board#project-icon: the bytes are decoded again here, so only a real image reaches `icon.png`; a non-square one is cut to
	// its centre (the renderer already sends a square).
	normalize: (bytes) => {
		const image = nativeImage.createFromBuffer(Buffer.from(bytes));
		if (image.isEmpty()) return null;
		const { width, height } = image.getSize(),
			side = Math.min(width, height);
		const square = image.crop({
				x: Math.floor((width - side) / 2),
				y: Math.floor((height - side) / 2),
				width: side,
				height: side,
			}),
			full =
				side > projectImageSide
					? square.resize({ width: projectImageSide, height: projectImageSide, quality: 'best' })
					: square;
		const url = square.resize({ width: 72, height: 72, quality: 'best' }).toDataURL();
		if (!url.startsWith('data:image/png;base64,') || url.length > 96_000) return null;
		return { png: full.toPNG(), image: url };
	},
	// spec/projects-and-board#project-icon: Codex draws the icon with its own image tool; off in Settings, missing or out of quota — none.
	draw: async (prompt, signal) => {
		if (!appliedSettings.agents.enabled.codex || quotaExhausted(quota.read(), 'codex')) return null;
		const fake = process.env.BRIGADIR_TEST_CODEX_IMAGE,
			cli = fake
				? {
						command: process.execPath,
						args: [fake],
						env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
					}
				: await environment.cliCommand('codex');
		if (!cli) return null;
		const cwd = ghostDirectory();
		await mkdir(cwd, { recursive: true, mode: 0o700 });
		return generateCodexImage({
			cli,
			cwd,
			prompt,
			signal,
			codexHome: cli.env.CODEX_HOME || join(homedir(), '.codex'),
		});
	},
});
const ghosts = new Ghosts({
	target: (signal) => ghostTarget(signal, null, 'promptHint'),
	exhausted: (provider) => quotaExhausted(quota.read(), provider),
	read: (key) => sessions.read(key),
	context: async (key) => {
		const review = await reviews.read(key, null);
		return {
			enabled: appliedSettings.suggestNextPrompt,
			visible:
				visibleTask?.id === key.id &&
				visibleTask.projectId === key.projectId &&
				Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()),
			composerEmpty: !(await composer.read(key)),
			reviewPending: [...review.comments, ...(review.notes ?? [])].filter(
				(item) => !item.sent && !item.resolved
			).length,
		};
	},
});
const sounds = new Sounds();
type WindowAction = {
	channel:
		'workspace:action' | 'navigation:route' | 'project:open' | 'notification:open' | 'ci:open';
	value: unknown;
};
let pendingWindowAction: WindowAction | null = null;
function dispatchWindowAction(channel: WindowAction['channel'], value: unknown) {
	if (quitRequested) return;
	// spec/remote-access-and-mobile#architecture: a window of another machine in front takes the menu's actions; `Connect…` stays in this machine's window.
	const remoteWindow = remoteAccess.focusedClient();
	if (
		remoteWindow &&
		(channel === 'workspace:action' || channel === 'navigation:route') &&
		value !== 'connect'
	) {
		remoteWindow.send(channel, value);
		return;
	}
	// spec/search-menus-and-commands#menu-after-background-launch: a background launch nobody has focused yet takes no focus from a menu action either; it only shows the window inactive.
	if (window && !window.isDestroyed() && menuReady) {
		if (background && !focusedOnce) {
			if (!window.isVisible()) window.showInactive();
		} else {
			window.show();
			window.focus();
		}
		localClient.send(channel, value);
		return;
	}
	pendingWindowAction = { channel, value };
	if (!window || window.isDestroyed()) createWindow();
}
function flushWindowAction() {
	if (!pendingWindowAction || !window || window.isDestroyed() || !menuReady) return;
	const action = pendingWindowAction;
	pendingWindowAction = null;
	dispatchWindowAction(action.channel, action.value);
}
function openTask(key: { projectId: string; id: string }) {
	dispatchWindowAction('notification:open', key);
}
// spec/notifications-slack-notes-and-schedules#macos-permission: macOS authorization; the renderer hears every change for Settings and the sidebar banner.
const notificationPermission = new NotificationPermissionState(
	notificationsTest?.authorization ??
		nativeAuthorization(join(servicesDir, 'notification-auth.node')),
	(value) => {
		clients.broadcast('notifications:permission', value);
	}
);
/** spec/remote-access-and-mobile#client-ui-seam: this machine's notices go to the device in control, if one is. */
const deviceNotices = new NativeNotices();
const routedNotices = new RoutedNotices(notificationsTest?.gateway ?? deviceNotices, () =>
	remoteAccess.activeDevice()
);
const notifications = new Notifications({
	gateway: routedNotices,
	sounds: routedNotices.sounds(notificationsTest?.sounds ?? sounds),
	preferences: () => appliedSettings.notifications,
	locale: currentLocale,
	allowed: () => notificationPermission.ensure(),
	visibility: () => ({
		// Under a device's control the person is at the device: it decides there whether the task is in front.
		active: remoteAccess.activeDevice()
			? false
			: (notificationsTest?.active() ??
				(window !== null && !window.isDestroyed() && window.isFocused())),
		task: visibleTask,
	}),
	taskTitle: async (key) => {
		try {
			return await taskLabels.title(
				key,
				(await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).task(key)).title
			);
		} catch {
			return null;
		}
	},
	answerPermission: (key, id, optionId) =>
		sessions.command(key, { kind: 'answerPermission', id, optionId }),
	openTask,
	// spec/remote-access-and-mobile#phone: the same notice reaches the paired phones as a Web Push.
	push: (type, task, key) => remoteAccess.pushPhones(type, task, key),
	badge: (count) => {
		routedNotices.badge(count);
		localBadge = count;
		showBadge();
	},
	// spec/notifications-slack-notes-and-schedules#notification-center: the notification center keeps what the notice says and hears when the requests change.
	log: ({ request, ...input }) => {
		void noticeLog.addTask(input).catch(() => {});
		void slackTaskNotice(input.kind, input.task, request ?? null, input.read);
	},
	pendingChanged: () => noticeLog.pendingChanged(),
});
/** spec/notifications-slack-notes-and-schedules#notification-center: the notification center's history and its «Needs you» rows. */
const noticeLog = new NoticeLog({
	dataDir: process.env.BRIGADIR_DATA_DIR,
	pending: () => [...notifications.pendingNotices(), ...schedulePending],
	// spec/notifications-slack-notes-and-schedules#schedules: a schedule's «Ask» answers Run once (allow) or Skip (deny).
	answer: (id, option) => {
		if (id.startsWith('schedule:')) scheduleAnswer?.(id, option);
		else notifications.answer(id, option);
	},
	openTask,
	openSchedule: () => dispatchWindowAction('workspace:action', 'schedules'),
	openRun: (watch) => dispatchWindowAction('ci:open', { watch }),
	changed: (center) => clients.broadcast('notices:changed', center),
});
/** spec/notifications-slack-notes-and-schedules#slack: the person's CI bot in Slack; the token is read and kept here, in main. */
const slack: Slack = new Slack({
	dataRoot: () => resolveDataRoot(process.env.BRIGADIR_DATA_DIR),
	vault: () => (remoteTestHooks(process.env, app.isPackaged).vault ?? electronVault)(),
	env: process.env,
	projects: async () =>
		(
			await readWorkspace(
				process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
			)
		).projects,
	settings: () => appliedSettings.slack,
	enabled: () => appliedSettings.modules.slack,
	changed: (state) => clients.broadcast('slack:changed', state),
	refused: (error) =>
		void noticeLog
			.addPlain({
				kind: 'warning',
				title: 'Slack',
				body: `${t(currentLocale(), 'Slack did not take a message:')} ${error}`,
			})
			.catch(() => {}),
	// spec/notifications-slack-notes-and-schedules#slack: what an `@bot` mention may do here — the helper model, tasks, their state, notes.
	brigadir: {
		notesOn: () => appliedSettings.modules.notes,
		helper: async (prompt, characterLimit) => {
			// spec/notifications-slack-notes-and-schedules#slack: the action «Slack: answers» of Customize per action, else the Helper agent.
			const signal = AbortSignal.timeout(60_000),
				target = await ghostTarget(signal, null, 'slackAnswers');
			if (!target || quotaExhausted(quota.read(), target.provider)) return null;
			return writeHintOneShot(prompt, signal, target, characterLimit, 45_000);
		},
		askAgent: (task, question, language, thread) => slackAskAgent(task, question, language, thread),
		askCode: (projectId, question, language, thread) =>
			slackSessions.askCode(projectId, {
				thread,
				question,
				language,
				// spec/notifications-slack-notes-and-schedules#slack: «Slack: code questions» of Customize per action, else the Default agent.
				choice: slackCodeChoice() ?? { provider: appliedSettings.agents.provider },
				context: thread.context,
			}),
		sideSession: (channel, ts) => slackSessions.session(channel, ts),
		createTask: (input) => createSlackTask(input),
		// spec/notifications-slack-notes-and-schedules#slack: a reply in the task's thread, and the buttons of Needs you and of a schedule's «Ask».
		sendToTask: (key, text) => slackSendToTask(key, text),
		answer: (answer) => slackAnswer(answer),
		tasks: (projectId) => slackTaskInfos(projectId),
		status: (task) => slackTaskStatus(task),
		createNote: async (project, text) => {
			const id = await (await NotesStore.at(process.env.BRIGADIR_DATA_DIR)).create(project, text);
			clients.broadcast('notes:changed', { id, kind: 'created' });
			void noticeLog
				.addPlain({
					kind: 'info',
					title: t(currentLocale(), 'Note from Slack'),
					body: noteTitle(text),
				})
				.catch(() => {});
		},
	},
	// spec/notifications-slack-notes-and-schedules#slack «watch and tell me here»: a PR read fresh, its runs and bells (spec/pull-requests-and-ci#ci-bell), a task's state.
	watching: {
		pr: async (pr) => {
			const detail = await pullRequests.detail(
				pr.projectId,
				pr.taskId,
				pr.scopeId,
				pr.number,
				true
			);
			return {
				state: detail.summary.state,
				repo: runRepo(detail.summary.url),
				head: detail.summary.head,
				base: detail.summary.base,
				url: detail.summary.url,
				headSha: detail.headSha,
				mergeSha: detail.mergeSha ?? null,
			};
		},
		runs: (pr, sha) => pullRequests.ciRuns(pr.projectId, pr.taskId, pr.scopeId, { sha }, true),
		run: (pr, runId) => pullRequests.ciRun(pr.projectId, pr.taskId, pr.scopeId, runId, true),
		bells: () => ciWatches.list(),
		bell: (watch, on) => ciWatches.toggle(watch, on),
		task: async (key) => {
			try {
				const { task, repo, branch } = await slackTask(key);
				return { status: task.status, repo, branch };
			} catch {
				return null;
			}
		},
	},
});
/**
 * spec/notifications-slack-notes-and-schedules#slack: a task from an `@bot` mention — the path of `create_task` (spec/tasks#agent-created-tasks): made in the backlog with its own
 * worktree, the thread attached as text, then started (`Start`) or left for the person with a notice (`Ask in Brigadir`).
 */
async function createSlackTask(input: SlackTaskInput) {
	const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
		defaults = await launchSettings.read(input.projectId);
	// spec/notifications-slack-notes-and-schedules#slack-dispatch: the other projects the work is in join as folders from outside.
	const scopes = [...defaults.scopes];
	if (input.alsoProjects.length) {
		for (const id of input.alsoProjects) {
			const path = await store
				.project(id)
				.then((project) => project.path)
				.catch(() => null);
			const folder =
				path &&
				(await launchSettings.describeFolder(input.projectId, path, scopes).catch(() => null));
			if (folder && !scopes.some((scope) => scope.id === folder.id)) scopes.push(folder);
		}
	}
	const launch = withAutoBranch(
		await launchSettings.resolve(input.projectId, {
			...defaults,
			isolation: 'worktree',
			branch: '',
			scopes,
		}),
		input.title,
		input.prompt,
		randomUUID()
	);
	// spec/notifications-slack-notes-and-schedules#slack: «Agent for tasks» of the Slack settings, else the Default agent.
	const agent = slackTaskAgent(
			appliedSettings.slack.mentions,
			appliedSettings.agents.enabled,
			appliedSettings.agents.provider,
			knownModels()
		),
		launchOptions = agent.run
			? taskLaunchOptions(agent.run, await providerCatalogs(agent.run.provider).catch(() => null))
			: [];
	let task = await store.createTask(
		input.projectId,
		input.prompt,
		agent.provider,
		'gui',
		t(currentLocale(), 'New task'),
		'backlog',
		launch
	);
	const attachments = input.context
		? [
				await new Attachments(store).create(task, {
					kind: 'text',
					name: 'Slack thread',
					text: input.context,
				}),
			]
		: [];
	task = await store.updateTask(task, {
		...(launchOptions.length ? { launchOptions } : {}),
		title: input.title,
		slackThread: input.thread,
		...(attachments.length ? { attachments } : {}),
	});
	clients.broadcast('session:event', { key: task, record: null });
	if (input.start) await launches.request(task);
	else
		void noticeLog
			.addTask({
				kind: 'proposal',
				task,
				title: t(currentLocale(), 'New task from Slack'),
				body: task.title,
				read: false,
			})
			.catch(() => {});
	return { projectId: task.projectId, id: task.id, title: task.title };
}
/**
 * spec/notifications-slack-notes-and-schedules#slack: a reply in a task's Slack thread goes to its agent the way the composer's Enter does (spec/composer-steering-queue-and-ghost#steering) — into the
 * running turn, else as a new one; a stopped agent starts first through the launch queue, as «resume» in the composer.
 */
async function slackSendToTask(key: TaskKey, text: string): Promise<SlackSendResult> {
	const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
	let task;
	try {
		task = await store.task(key);
	} catch {
		return 'gone';
	}
	if (task.archived) return 'archived';
	if (task.transport === 'terminal') return 'terminal';
	if (task.status === 'backlog') return 'waiting';
	let snapshot = await sessions.read(key);
	if (!snapshot.connected || idleStopped(snapshot.records)) {
		snapshot = await launches.request(key);
		if (!snapshot.connected || snapshot.queued || idleStopped(snapshot.records)) return 'busy';
	}
	await sessions.command(key, { kind: 'prompt', text, steer: true });
	return 'sent';
}
/** Set once the scheduler exists: a schedule's «Ask» answered from Slack. */
let slackScheduleAnswer:
	| ((projectId: string, id: string, option: 'run' | 'skip') => Promise<SlackAnswerResult>)
	| undefined;
/**
 * spec/notifications-slack-notes-and-schedules#slack: a button in Slack answers as the OS notification and the notice center do — the request is checked in the
 * task's live journal, a permission takes the same one-time option, and an answer that came first wins.
 */
async function slackAnswer(answer: SlackAnswer): Promise<SlackAnswerResult> {
	if (answer.kind === 'schedule')
		return appliedSettings.modules.schedules && slackScheduleAnswer
			? slackScheduleAnswer(answer.projectId, answer.schedule, answer.option)
			: 'gone';
	const key = answer.task;
	try {
		await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).task(key);
	} catch {
		return 'gone';
	}
	const snapshot = await sessions.read(key);
	if (!snapshot.connected) return 'already';
	const pending = pendingInputs(snapshot.records);
	if (answer.kind === 'permission') {
		const request = pending.permissions.find((item) => item.id === answer.request),
			optionId = request ? notificationPermissionChoices(request)[answer.option] : null;
		if (!request || !optionId) return 'already';
		await sessions.command(key, { kind: 'answerPermission', id: request.id, optionId });
		return 'answered';
	}
	const question = pending.questions.find((item) => item.id === answer.request);
	if (!question || !slackQuestionChoices(question)?.includes(answer.option)) return 'already';
	await sessions.command(key, {
		kind: 'answerQuestion',
		id: question.id,
		answer: { labels: [answer.option], text: '' },
	});
	return 'answered';
}
/** The buttons a Needs you gets in Slack: a permission's Allow · Deny, a question's few choices; else none. */
async function slackAsk(kind: NoticeEntryKind, key: TaskKey, request: string | null) {
	if (!request || (kind !== 'permission' && kind !== 'question')) return undefined;
	const pending = pendingInputs((await sessions.read(key)).records);
	if (kind === 'permission') {
		const found = pending.permissions.find((item) => item.id === request);
		if (!found) return undefined;
		const choices = notificationPermissionChoices(found),
			options = (['allow', 'deny'] as const).filter((option) => choices[option]);
		return options.length
			? ({ kind, request, tool: found.tool.title ?? null, options } satisfies SlackAsk)
			: undefined;
	}
	const found = pending.questions.find((item) => item.id === request),
		options = found && slackQuestionChoices(found);
	return found && options
		? ({ kind, request, question: found.question, options } satisfies SlackAsk)
		: undefined;
}
/** The project's tasks as the status answer may name them — titles, states, branches and PRs, nothing else. */
async function slackTaskInfos(projectId: string): Promise<SlackTaskInfo[]> {
	const workspace = await sessions.workspace();
	return Promise.all(
		workspace.tasks
			.filter((task) => task.projectId === projectId && task.id !== MAIN_TREE_ID)
			.map(async (task) => ({
				projectId,
				id: task.id,
				title: await taskLabels.title(task, task.title),
				status: task.status,
				branch: task.taskTree?.branch ?? task.worktreeBranch ?? null,
				prs: Object.entries(task.pullRequests ?? {}).map(([scopeId, { number, url, state }]) => ({
					number,
					url,
					state,
					scopeId,
				})),
				updatedAt: task.updatedAt ?? null,
				archived: !!task.archived,
			}))
	);
}
/** spec/notifications-slack-notes-and-schedules#slack: the last end of a watched run per task — the status answer's CI line. */
const slackRuns = new Map<string, 'pass' | 'fail' | 'cancelled'>();
/** The plan N of M and its step from the task's journal; CI — a watched run still going, else the last one's end. */
async function slackTaskStatus(task: SlackTaskInfo) {
	const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
		records = (await store.journal(task).catch(() => ({ records: [] }))).records;
	let plan = null;
	for (let index = records.length - 1; index >= 0; index--) {
		const event = records[index]!.event;
		if (event.kind === 'plan.changed') {
			plan = planSummary(event.entries);
			break;
		}
	}
	const watched = (await ciWatches.list().catch(() => [])).some(
		(watch) => watch.projectId === task.projectId && watch.taskId === task.id
	);
	return {
		plan,
		ci: watched ? ('running' as const) : (slackRuns.get(`${task.projectId}/${task.id}`) ?? null),
	};
}
/** The task a Slack message is about: its title as the sidebar shows it, the project as the repo, the task's branch. */
async function slackTask(key: TaskKey) {
	const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
		[task, project] = await Promise.all([store.task(key), store.project(key.projectId)]);
	return {
		task,
		ref: { projectId: key.projectId, id: key.id, title: await taskLabels.title(key, task.title) },
		repo: project.name,
		branch: task.taskTree?.branch || task.worktreeBranch || '',
	};
}
const slackReasons: Partial<Record<NoticeEntryKind, string>> = {
	permission: 'A permission to answer',
	question: 'A question to answer',
	plan: 'A plan to approve',
	proposal: 'A task to approve',
	worker: 'A worker waits for you',
};
/** spec/notifications-slack-notes-and-schedules#slack: Needs you, Task done, and a schedule's run that failed — from the same notices the center keeps. */
/** When Slack last heard «Task done» of a task: one turn's end, not every one in a row (a crew, a restart, quick turns). */
const slackDoneAt = new Map<string, number>();
async function slackTaskNotice(
	kind: NoticeEntryKind,
	key: TaskKey,
	request: string | null,
	read = false
) {
	// «Tell me when the task is done» (spec/notifications-slack-notes-and-schedules#slack): a turn's end may be it; Completed is seen by the minute pass.
	if (kind === 'turn-ended') void slack.taskEnded(key).catch(() => {});
	if (!appliedSettings.modules.slack || slack.state().state === 'off') return;
	try {
		const { task, ref, repo, branch } = await slackTask(key),
			reason = slackReasons[kind];
		if (reason) {
			const ask = appliedSettings.slack.events.needsYou
				? await slackAsk(kind, key, request).catch(() => undefined)
				: undefined;
			slack.post(
				{ kind: 'needsYou', repo, branch, task: ref, reason, ...(ask ? { ask } : {}) },
				key.projectId
			);
		} else if (kind === 'turn-ended') {
			// The person has the task in front of them — Slack stays quiet; at most one «Task done» per task in ten minutes.
			const id = `${key.projectId}/${key.id}`,
				last = slackDoneAt.get(id) ?? 0;
			if (read || Date.now() - last < 10 * 60_000) return;
			slackDoneAt.set(id, Date.now());
			slack.post({ kind: 'taskDone', repo, branch, task: ref, summary: null }, key.projectId);
		} else if (kind === 'failed' && task.scheduleRun)
			slack.post(
				{ kind: 'scheduleFailed', schedule: ref.title, project: repo, reason: 'The run failed.' },
				key.projectId
			);
	} catch {
		// The task is gone or unreadable — nothing to say.
	}
}
/** `owner/repo` of a run's GitHub link — the repo watch-ci names. */
const runRepo = (link: string) => /github\.com\/[^/]+\/([^/]+)/.exec(link)?.[1] ?? '';
async function slackRun(event: CIFinished, detail: CIRunDetail) {
	if (event.watch.taskId)
		slackRuns.set(`${event.watch.projectId}/${event.watch.taskId}`, event.state);
	// A bell a Slack watch put answers in the watch's thread only.
	if (await slack.ciFinished(event, detail).catch(() => false)) return;
	if (!appliedSettings.modules.slack || slack.state().state === 'off') return;
	const { watch, run } = event,
		task = watch.taskId
			? await slackTask({ projectId: watch.projectId, id: watch.taskId }).catch(() => null)
			: null;
	slack.post(
		{
			kind: 'ci',
			state: event.state,
			repo: runRepo(run.link) || task?.repo || watch.label,
			branch: run.branch,
			environment: detail.deploy?.environment ?? null,
			task: task?.ref ?? null,
			seconds: run.seconds,
			link: run.link,
			error: detail.annotation?.message ?? null,
		},
		watch.projectId
	);
}
/** The Dock badge: this machine's own count plus what connected machines ask this device to show (spec/remote-access-and-mobile#client-ui-seam). */
let localBadge = 0;
const machineBadges = new Map<string, number>();
function showBadge() {
	const count = localBadge + [...machineBadges.values()].reduce((sum, value) => sum + value, 0);
	if (notificationsTest) (globalThis as any).brigadirNotifications.badges.push(count);
	if (process.platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
	else app.setBadgeCount(count);
}
// spec/pull-requests-and-ci#ci-bell: the bell on a run — main watches on its own and on disk; a run's end is an OS notification and a toast.
const ciWatches = new CIWatches({
	dataDir: process.env.BRIGADIR_DATA_DIR,
	read: (watch) =>
		pullRequests.ciRun(watch.projectId, watch.taskId, watch.scopeId, watch.runId, true),
	gateway: routedNotices,
	allowed: () => notificationPermission.ensure(),
	locale: currentLocale,
	pollMs: Number(process.env.BRIGADIR_TEST_CI_WATCH_MS) || undefined,
	changed: (watches) => {
		clients.broadcast('ci:watches', watches);
	},
	finished: (event, detail) => {
		clients.broadcast('ci:finished', event);
		void noticeLog.addRun(event).catch(() => {});
		void slackRun(event, detail);
	},
	open: (event) => dispatchWindowAction('ci:open', event),
});
sessions.onAttached = (key, snapshot) => notifications.seed(key, snapshot);
sessions.onDetached = (key) => {
	notifications.detached(key);
	void launches.kick();
};
// spec/tasks#launch-sheet: starts beyond the concurrency limit wait as queued; promotion sends the stored first prompt itself.
const relays = new Relays(process.env.BRIGADIR_DATA_DIR, launchSettings, changes);
const launches = new LaunchQueue(process.env.BRIGADIR_DATA_DIR, {
	dequeued: async (key) => {
		launchLocks.forget(key);
		await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).updateTask(key, { blockedBy: [] });
	},
	eligible: (key, interactive, pass) => launchLocks.check(key, interactive, pass),
	limit: () => appliedSettings.agents.maxConcurrent,
	active: async () =>
		(
			await readWorkspace(
				process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
			)
		).tasks
			.filter(
				(task) =>
					task.status === 'working' || task.status === 'needs-you' || task.status === 'preparing'
			)
			.map((task) => ({ projectId: task.projectId, id: task.id })),
	// spec/agents-and-providers#catalog: model first; an option the provider refuses after it (effort of another model) is skipped, not fatal.
	configure: async (key, options) => {
		for (const option of options)
			await sessions.command(key, { kind: 'setOption', ...option }).catch(() => {});
		await (
			await SessionStore.at(process.env.BRIGADIR_DATA_DIR)
		).updateTask(key, { launchOptions: [] });
	},
	start: async (key) => {
		const override = launchLocks.takeOverride(key);
		await preparations.prepare(key);
		await relays.prepareBacklog(key);
		return sessions.start(key, override);
	},
	sendPrompt: async (key, text) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			handoff = await readRelayHandoff(store, key);
		// spec/tasks#backlog-edit: the host adds the task's own attachments to its first turn; a task with attachments and no text still sends one.
		if (text.trim() || handoff?.attachmentIds.length || (await store.task(key)).attachments?.length)
			await sessions.command(key, {
				kind: 'prompt',
				text,
				...(handoff ? { attachmentIds: handoff.attachmentIds } : {}),
			});
	},
	task: async (key) => (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).task(key),
	hasTurns: async (key) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
		return (await store.journal(key)).records.some(
			(record) => record.event.kind === 'turn.started'
		);
	},
	setStatus: async (key, status) =>
		(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).setStatus(key, status),
	snapshot: (key) => sessions.read(key),
	changed: (key) => {
		clients.broadcast('session:event', { key, record: null });
	},
});
// spec/tasks#agent-created-tasks: the task an agent proposed with `create_task`; main creates it and answers the waiting host.
const taskProposals = new TaskProposals({
	...(process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}),
	settings: launchSettings,
	changes,
	command: (key, command) => sessions.command(key, command),
	start: async (key) => {
		await launches.request(key);
	},
	emptyTitle: () => t(currentLocale(), 'New task'),
});
const liveAgents = new LiveAgents(process.env.BRIGADIR_DATA_DIR, servicesDir, sessions);
// spec/agents-and-providers#quota-sources: account-level limits. `/usage` runs in its own folder under the data dir; tests pin a snapshot or read nothing.
const quotaRoot = process.env.BRIGADIR_DATA_DIR ?? defaultDataDir();
const quota = new Quota(
	providerReaders(join(quotaRoot, 'usage')),
	async (key) =>
		(await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).task(key)).provider ?? null,
	(snapshot) => {
		clients.broadcast('quota:changed', snapshot);
	},
	{ viewFile: join(quotaRoot, 'quota-view.json') }
);
const files = new Files(changes, sessions);
// spec/task-window-workspace#restore-window: each task's surface.json and the unsaved buffers of a hot exit.
const surfaces = new TaskSurfaces(
	{
		filePath: (key, id) => files.surfacePath(key, id),
		fileId: (key, path) => files.surfaceId(key, path),
		terminals: (key) => sessions.liveTerminals(key),
		browser: (key, tab) => browsers.describe(key, tab),
		restoreBrowsers: (key, tabs) => browsers.restore(key, tabs),
		device: async (projectId) =>
			(await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).project(projectId)).simulator
				?.device ?? null,
	},
	process.env.BRIGADIR_DATA_DIR
);
// spec/search-menus-and-commands#search-tabs: Text of Search Everywhere over the Files index; events go to the window like terminal output.
const textSearches = new TextSearches(
	(key) => files.textFiles(key),
	(event) => {
		clients.broadcast('search:text-event', event);
	}
);
const quickListeners = new Map<string, (event: QuickAskEvent) => void>();
/**
 * spec/notifications-slack-notes-and-schedules#slack: the facts do not answer a Slack question about a task — its agent does, in a
 * read-only side session (spec/composer-steering-queue-and-ghost#quick-question) of «Slack: code questions» when that is set, else of the task's own provider. The answer's
 * text when it ends; `null` when it fails or takes over five minutes. A follow-up in the same thread within ten minutes goes to
 * the same session.
 */
function slackAskAgent(
	key: TaskKey,
	question: string,
	language: 'en' | 'uk',
	thread: SlackSideThread | undefined
): Promise<string | null> {
	return slackSessions.askTask(key, {
		// Without a thread the question gets a session of its own.
		thread: thread ?? { channel: '', ts: randomUUID() },
		question,
		language,
		choice: slackCodeChoice() ?? {},
		context: thread?.context ?? null,
	});
}
/** spec/appearance#evolution-redesign: the agent of «Slack: code questions» while it is set and its provider on; `null` — the default. */
function slackCodeChoice() {
	const run = actionChoice(
		'slackCode',
		null,
		appliedSettings.actionAgents,
		appliedSettings.agents.enabled,
		knownCatalogs()
	).run;
	return run
		? { provider: run.provider, model: run.model, ...(run.effort ? { effort: run.effort } : {}) }
		: null;
}
/** The models the known catalogs list: a Slack agent whose model its known catalog does not list falls back to the default. */
function knownModels() {
	return Object.fromEntries(
		Object.entries(knownCatalogs()).map(([provider, catalog]) => [
			provider,
			catalog
				? (selectOption(catalog.options, 'model')?.choices.map((item) => item.value) ?? null)
				: null,
		])
	) as Partial<Record<'claude' | 'codex', string[] | null>>;
}
const slackSessions = new SlackSessions({
	ask: (key, request, mode, thread) => quickAsks.ask(key, request, mode, thread),
	followUp: (key, id, question, language) => quickAsks.followUp(key, id, question, language),
	stop: (id) => quickAsks.stop(id),
	close: (id) => quickAsks.close(id),
	listen: (id, listener) => {
		if (listener) quickListeners.set(id, listener);
		else quickListeners.delete(id);
	},
	ensureMainTree: async (projectId) => {
		await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).ensureMainTree(projectId);
	},
	newId: () => randomUUID(),
});
// spec/composer-steering-queue-and-ghost#quick-question: a quick question from a selection — a separate session of the task's provider, streamed to the window.
const quickAsks = new QuickAsks({
	dataDir: process.env.BRIGADIR_DATA_DIR,
	read: (key) => sessions.read(key),
	command: (key, command) => sessions.command(key, command),
	revertFile: (key, fileId, range) => sessions.revertFile(key, fileId, range),
	fileDiff: (key, fileId) => changes.file(key, fileId),
	scopes: (key) => launchLocks.scopes(key),
	provider: () => appliedSettings.agents.provider,
	send: (event) => {
		// spec/notifications-slack-notes-and-schedules#slack: a question from Slack is answered to Slack, not to the window's popover.
		const listener = quickListeners.get(event.id);
		if (listener) listener(event);
		else clients.broadcast('quick:event', event);
	},
	adapter: process.env.BRIGADIR_TEST_AGENT
		? {
				command: '/usr/bin/env',
				args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, process.env.BRIGADIR_TEST_AGENT],
			}
		: undefined,
});
const codeIntel = new CodeIntelBridge(
	files,
	servicesDir,
	changes.syntax,
	(event) => {
		clients.broadcast('code:problems', event);
	},
	{
		settings: () => settings.read(),
		project: async (id) => (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).project(id),
	},
	(keys) => {
		clients.broadcast('code:restarted', keys);
	}
);
/** spec/editor-code-intelligence#language-server-restart: the agent's restart; a declared type, as the sessions that call it are built before codeIntel. */
function restartCode(key: TaskKey): Promise<CodeRestartResult> {
	return codeIntel.restart(key);
}
const forge = new ForgeActions(process.env.BRIGADIR_DATA_DIR, sessions);
const pullRequests = new PullRequests(process.env.BRIGADIR_DATA_DIR, forge.forge, changes, () => ({
	provider: appliedSettings.agents.provider,
	locale: currentLocale(),
}));
pullRequests.helper = (prompt, signal, run, action) => helperText(prompt, signal, run, action);
forge.textWriter = async (prompt, signal, run) =>
	(await helperText(prompt, signal, run, 'prText')).text;
// spec/agents-and-providers#context-tools: what the person is looking at, for `editor_state` and `pr_state` of the task's agent.
const contextState: ContextState = new ContextState({
	dataDir: process.env.BRIGADIR_DATA_DIR,
	send: (request) => {
		return clients.broadcast('context:request', request);
	},
	visible: (key) =>
		visibleTask?.id === key.id &&
		visibleTask.projectId === key.projectId &&
		Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()),
	diffBase: () => appliedSettings.editor.diffBase,
	pullRequest: async (key, scopeId, number) => {
		const [detail, review, viewer] = await Promise.all([
			pullRequests.detail(key.projectId, key.id, scopeId, number),
			pullRequests.readDraft(key, scopeId, number),
			pullRequests.viewerLogin(key.projectId, key.id, scopeId),
		]);
		return { detail, review, viewer };
	},
});
const mainTreeChanged = (projectId: string) => {
	clients.broadcast('session:event', {
		key: { projectId, id: MAIN_TREE_ID },
		record: null,
	});
};
// spec/git#pull: a quiet fetch of every project's repos at start, on focus and every 5 minutes; e2e opts out unless a spec asks.
const remoteWatch = new RemoteWatch(process.env.BRIGADIR_DATA_DIR, mainTreeChanged);
const mainTrees = new MainTrees(
	process.env.BRIGADIR_DATA_DIR,
	servicesDir,
	(key) => files.refresh(key),
	() => forge.isSaving || commits.isSaving || files.isSaving,
	mainTreeChanged,
	async (key) => (await sessions.activity(key)).busy,
	(path) => remoteWatch.fetched(path)
);
const commits = new Commits(process.env.BRIGADIR_DATA_DIR, changes, sessions, files);
/** spec/git#commit-dialog: «Split with the agent» is a one-shot of the hint model, like the branch name (spec/git#agent-branch-names). */
commits.splitWriter = async (prompt, signal, run) => {
	const target = await ghostTarget(signal, run, 'split');
	if (!target || quotaExhausted(quota.read(), target.provider))
		throw new Error('The helper agent is off.');
	return writeHintOneShot(prompt, signal, target, 12000, 90000);
};
/** spec/appearance#evolution-redesign: commit messages follow the Helper agent, no longer pinned to Claude. */
commits.messageWriter = async (prompt, signal, run) =>
	(await helperText(prompt, signal, run, 'commitMessage')).text;
const gitHistory = new GitHistory(process.env.BRIGADIR_DATA_DIR, changes, sessions);
const editorBlames = new EditorBlames(changes, gitHistory, (key, id) => files.codeTarget(key, id));
const scopeControls = new ScopeControls(
	process.env.BRIGADIR_DATA_DIR,
	servicesDir,
	sessions,
	changes,
	launchSettings
);
const sidebarMenus = new SidebarMenus(
	process.env.BRIGADIR_DATA_DIR,
	ui,
	sessions,
	files,
	browsers,
	launches,
	() =>
		Promise.all([
			files.waitForSaves(),
			reviews.waitForWrites(),
			composer.waitForWrites(),
			browsers.waitForWrites(),
			scopeControls.waitForWrites(),
			launchSettings.waitForWrites(),
			relays.waitForWrites(),
			commits.waitForWrites(),
			forge.waitForWrites(),
			knowledge.waitForWrites(),
			sidebarState.waitForWrites(),
			projects.waitForWrites(),
			liveAgents.waitForWrites(),
			taskLabels.waitForWrites(),
		]),
	currentLocale
);
const prMenus = new PRMenus(process.env.BRIGADIR_DATA_DIR, ui, pullRequests, currentLocale);
projects.isRemoving = (id) => sidebarMenus.busy(id);
relays.isRemoving = (id) => sidebarMenus.busy(id);
commits.isRemoving = (id) => sidebarMenus.busy(id);
forge.isRemoving = (id) => sidebarMenus.busy(id);
knowledge.isRemoving = (id) => sidebarMenus.busy(id);
forge.isGitBusy = () => commits.isSaving || files.isSaving;
commits.isGitBusy = () => forge.isSaving;
// spec/architecture-and-platform#exit: writes that close and quit wait for, by name; quit also waits for consoles a closing window is still stopping.
const saves: PendingWrite[] = [
	{ name: 'files', busy: () => files.isSaving, wait: () => files.waitForSaves() },
	{ name: 'layout', busy: () => layout.isSaving, wait: () => layout.waitForWrites() },
	{ name: 'surfaces', busy: () => surfaces.isSaving, wait: () => surfaces.waitForWrites() },
	{ name: 'browsers', busy: () => browsers.isSaving, wait: () => browsers.waitForWrites() },
	{ name: 'reviews', busy: () => reviews.isSaving, wait: () => reviews.waitForWrites() },
	{ name: 'composer', busy: () => composer.isSaving, wait: () => composer.waitForWrites() },
	{ name: 'settings', busy: () => settings.isSaving, wait: () => settings.waitForWrites() },
	{
		name: 'projectViews',
		busy: () => projectViews.isSaving,
		wait: () => projectViews.waitForWrites(),
	},
	{ name: 'taskReads', busy: () => taskReads.isSaving, wait: () => taskReads.waitForWrites() },
	{ name: 'noticeLog', busy: () => noticeLog.isSaving, wait: () => noticeLog.waitForWrites() },
	{ name: 'launches', busy: () => launches.isSaving, wait: () => launches.waitForWrites() },
	{
		name: 'preparations',
		busy: () => preparations.isSaving,
		wait: () => preparations.waitForWrites(),
	},
	{
		name: 'scopeControls',
		busy: () => scopeControls.isSaving,
		wait: () => scopeControls.waitForWrites(),
	},
	{
		name: 'launchSettings',
		busy: () => launchSettings.isSaving,
		wait: () => launchSettings.waitForWrites(),
	},
	{ name: 'relays', busy: () => relays.isSaving, wait: () => relays.waitForWrites() },
	{ name: 'commits', busy: () => commits.isSaving, wait: () => commits.waitForWrites() },
	{ name: 'forge', busy: () => forge.isSaving, wait: () => forge.waitForWrites() },
	{ name: 'knowledge', busy: () => knowledge.isSaving, wait: () => knowledge.waitForWrites() },
	{
		name: 'sidebarState',
		busy: () => sidebarState.isSaving,
		wait: () => sidebarState.waitForWrites(),
	},
	{ name: 'projects', busy: () => projects.isSaving, wait: () => projects.waitForWrites() },
	{ name: 'liveAgents', busy: () => liveAgents.isSaving, wait: () => liveAgents.waitForWrites() },
	{ name: 'quotaView', busy: () => quota.isSaving, wait: () => quota.waitForWrites() },
	{ name: 'taskLabels', busy: () => taskLabels.isSaving, wait: () => taskLabels.waitForWrites() },
];
const quitWaits: PendingWrite[] = [
	{
		name: 'consoles',
		busy: () => sessions.isClosingConsoles,
		wait: () => sessions.closeConsoles(),
	},
	...saves,
	// spec/architecture-and-platform#auto-update: a downloaded update installs on quit when no agent turn runs.
	{
		name: 'appUpdate',
		busy: () => appUpdates.quitPending(),
		wait: () => appUpdates.prepareQuit(),
	},
];
const quitGuard = new QuitGuard();
let quitSettling = false;
const boards = new Boards(
	process.env.BRIGADIR_DATA_DIR,
	sessions,
	launches,
	ui,
	currentLocale,
	(key) => {
		clients.broadcast('session:event', { key, record: null });
	}
);
boards.preparations = preparations;
// spec/notifications-slack-notes-and-schedules#slack: «Task completed» in Slack; a quiet scheduled run that closed itself is not news.
boards.onCompleted = (key) => {
	if (!appliedSettings.modules.slack || slack.state().state === 'off') return;
	void slackTask(key)
		.then(({ task, ref, repo, branch }) => {
			if (task.scheduleRun?.quiet) return;
			slack.post({ kind: 'taskCompleted', repo, branch, task: ref }, key.projectId);
		})
		.catch(() => {});
};
sidebarMenus.labels = taskLabels;
sidebarMenus.boards = boards;
sidebarMenus.preparations = preparations;
// spec/tasks#archive: archive stops the task like a removal does, but keeps its data; a clean worktree goes the «Remove worktree…» way.
const taskArchives = new TaskArchives({
	dataDir: process.env.BRIGADIR_DATA_DIR,
	tasks: async () => (await sessions.workspace()).tasks,
	isQueued: (key) => launches.isQueued(key),
	uncommitted: (key) => preparations.uncommitted(key),
	removeWorktree: (key) => preparations.discard(key),
	days: () => appliedSettings.agents.archiveAfterDays,
	stop: async (key) => {
		await preparations.cancel(key);
		await launches.dequeue(key);
		await sessions.stopForRemoval(key);
		await browsers.command(key, { kind: 'discard' });
	},
	changed: (key) => {
		clients.broadcast('session:event', { key, record: null });
	},
});
sidebarMenus.archives = taskArchives;
sidebarMenus.schedules = () => appliedSettings.modules.schedules;
sidebarMenus.keymap = () => appliedSettings.keymap;
let menuContext: MenuContext = { ...emptyMenuContext },
	menuReady = false;
/** spec/remote-access-and-mobile#client-ui-seam: the menu context of each window of another machine on this device, by its client id. */
const machineMenuContexts = new Map<string, MenuContext>();
/** What opens on the screen of the machine a window shows; a window of another machine has none of it (spec/remote-access-and-mobile#client-ui-seam). */
const machineScreenCommands = new Set(['browser-inspect', 'simulator-devtools']);
/** The menu bar follows the window in front: this machine's own, or a window of another machine (spec/remote-access-and-mobile#client-ui-seam). */
function menuFocus(): { context: MenuContext; ready: boolean; machine: boolean } {
	const remoteWindow = remoteAccess.focusedClient();
	if (remoteWindow) {
		const context = machineMenuContexts.get(remoteWindow.id);
		return { context: context ?? emptyMenuContext, ready: !!context, machine: true };
	}
	return { context: menuContext, ready: menuReady, machine: false };
}
function syncMenuFocus() {
	const menu = Menu.getApplicationMenu();
	if (!menu) return;
	const focus = menuFocus(),
		// The page's focus is this machine's browser; a window of another machine has its browser there.
		pageFocused = !focus.machine && browsers.isFocused();
	for (const command of menuCommands) {
		const item = menu.getMenuItemById(command.id);
		if (item)
			item.enabled =
				(focus.ready || (!window && !focus.machine && command.when === 'always')) &&
				!(focus.machine && machineScreenCommands.has(command.id)) &&
				menuCommandEnabled(command, focus.context, pageFocused);
	}
	for (const id of [
		'settings',
		'settings-templates',
		'workspace-route',
		'kit-route',
		'open-recent',
	]) {
		const item = menu.getMenuItemById(id);
		// Recent projects are this machine's: a window of another machine opens its folders from its browser.
		if (item)
			item.enabled =
				(focus.ready || (!window && !focus.machine)) &&
				!focus.context.modal &&
				!(focus.machine && id === 'open-recent');
	}
	const preview = menu.getMenuItemById('markdown-preview');
	if (preview) preview.checked = focus.context.markdownPreview;
	for (const [id, key] of Object.entries(layoutChecks)) {
		const item = menu.getMenuItemById(id);
		if (item && key) item.checked = focus.context[key];
	}
	// spec/search-menus-and-commands#menu-structure: in two columns Panel's glyph is the panel's state; a native item takes a new icon only when rebuilt.
	if (menuPanelGlyph !== null && menuPanelGlyph !== focus.context.layoutPanel) rebuildMenu?.();
}
/** Whether View ▸ Layout ▸ Panel was built with the open panel's glyph (two columns); null in three columns. */
let menuPanelGlyph: boolean | null = null;
/** spec/task-window-workspace#layout-switch: View ▸ Layout's three items tick with the task's switches. */
const layoutChecks: Partial<Record<string, 'layoutChat' | 'layoutWork' | 'layoutPanel'>> = {
	'layout-chat': 'layoutChat',
	'layout-work': 'layoutWork',
	'layout-panel': 'layoutPanel',
};

/** spec/editor#line-author: Editor ▸ Show line author is the Settings switch itself, so both stay one setting. */
function lineAuthorItem(
	locale: ReturnType<typeof currentLocale>
): Electron.MenuItemConstructorOptions {
	return {
		id: 'editor-line-author',
		type: 'checkbox',
		label: t(locale, 'Show line author'),
		...menuIcon(appMenuIcons['line-author']),
		checked: appliedSettings.editor.lineAuthor,
		click: () => {
			const next = {
				...appliedSettings,
				editor: { ...appliedSettings.editor, lineAuthor: !appliedSettings.editor.lineAuthor },
			};
			void settings.save(next).then(
				(saved) => {
					appliedSettings = saved;
					publishAppearance();
					rebuildMenu?.();
				},
				() => rebuildMenu?.()
			);
		},
	};
}

/** spec/task-window-workspace#two-columns: View ▸ Layout ▸ Two columns / Three columns — the Settings choice itself, as radios with their glyphs. */
function taskColumnsItems(
	locale: ReturnType<typeof currentLocale>
): Electron.MenuItemConstructorOptions[] {
	return (['two', 'three'] as const).map((value) => ({
		id: `layout-columns-${value}`,
		type: 'radio' as const,
		label: t(locale, value === 'two' ? 'Two columns' : 'Three columns'),
		...menuIcon(appMenuIcons[value === 'two' ? 'layout-two' : 'layout-three']),
		checked: appliedSettings.taskColumns === value,
		click: () => {
			if (appliedSettings.taskColumns === value) return;
			void settings.save({ ...appliedSettings, taskColumns: value }).then(
				(saved) => {
					appliedSettings = saved;
					publishAppearance();
					rebuildMenu?.();
				},
				() => rebuildMenu?.()
			);
		},
	}));
}

async function recentFailure(path?: string) {
	if (quitRequested) return;
	const options: Electron.MessageBoxOptions = {
		type: 'error',
		message: t(currentLocale(), 'The project could not be opened.'),
		detail: path ?? t(currentLocale(), 'Recent projects could not be read.'),
		buttons: path
			? [t(currentLocale(), 'Cancel'), t(currentLocale(), 'Open a project…')]
			: [t(currentLocale(), 'Close')],
		defaultId: 0,
		cancelId: 0,
	};
	const result = await messageBox(window && !window.isDestroyed() ? window : null, options);
	if (path && result.response === 1) dispatchWindowAction('workspace:action', 'open-project');
}
/** spec/appearance#evolution-redesign: e2e opts out of the icon picks (a hint model call per project) unless a spec asks. */
const iconPicks = process.env.BRIGADIR_ICON_PICK !== '0';
/** The agent picks the icon of a project just added; until it answers, the sidebar says «Picking an icon…». */
function pickNewProjectIcon(project: Project) {
	if (!iconPicks || project.icon) return;
	void sessions
		.workspace()
		.then(({ projects }) => {
			const colors = projectColors(projects.map((item) => item.id));
			return projectIcons.pick(project.id, projectIconColorAt(colors.get(project.id) ?? 0), true);
		})
		.catch(() => {});
}
let recentRevision = 0;
let recentTemplate: Electron.MenuItemConstructorOptions[] = [];
let rebuildMenu: (() => void) | undefined;
async function refreshRecent() {
	const revision = ++recentRevision;
	const locale = currentLocale();
	const replace = (template: Electron.MenuItemConstructorOptions[]) => {
		recentTemplate = template;
		rebuildMenu?.();
	};
	try {
		const paths = await projects.recent();
		if (revision !== recentRevision) return;
		replace(
			paths.length
				? [
						...paths.map((path, index) => ({
							id: `recent-project-${index}`,
							label: path,
							...menuIcon(appMenuIcons['recent-project']),
							click: () => {
								if (menuContext.modal) return;
								void projects
									.open(path)
									.then(async (project) => {
										await refreshRecent();
										dispatchWindowAction('project:open', project.id);
									})
									.catch(() => recentFailure(path));
							},
						})),
						{ type: 'separator' },
						{
							id: 'recent-clear',
							label: t(locale, 'Clear Recent'),
							...menuIcon(appMenuIcons['recent-clear']),
							click: () => {
								if (!menuContext.modal)
									void projects
										.clear()
										.then(refreshRecent)
										.catch(() => recentFailure());
							},
						},
					]
				: [
						{
							label: t(locale, 'No recent projects'),
							...menuIcon(appMenuIcons['recent-project']),
							enabled: false,
						},
					]
		);
	} catch {
		if (revision !== recentRevision) return;
		replace([
			{
				label: t(locale, 'Recent projects could not be read.'),
				...menuIcon(appMenuIcons['recent-error']),
				enabled: false,
			},
			{
				id: 'recent-retry',
				label: t(locale, 'Retry'),
				...menuIcon(appMenuIcons['recent-retry']),
				click: () => {
					void refreshRecent();
				},
			},
		]);
	}
	syncMenuFocus();
}

/** spec/remote-access-and-mobile#client-ui-seam: this machine's settings as a window shows them — a device adds its own theme, accent and fonts. */
function machineAppearance(): MachineAppearance {
	return {
		suggestNextPrompt: appliedSettings.suggestNextPrompt,
		terminalScrollSpeed: appliedSettings.terminal.scrollSpeed,
		terminalFontWeight: appliedSettings.terminal.fontWeight,
		modules: appliedSettings.modules,
		reviewWhere: appliedSettings.agents.reviewWhere,
		prSummary: appliedSettings.agents.prSummary,
		agentsEnabled: { ...appliedSettings.agents.enabled },
		agentProvider: appliedSettings.agents.provider,
		codeTheme: appliedSettings.editor.codeTheme,
		keymap: appliedSettings.keymap,
		accentColor: appliedSettings.accent,
		locale: currentLocale(),
		toolbarLabels: appliedSettings.toolbarLabels,
		taskColumns: appliedSettings.taskColumns,
		interfaceFont: structuredClone(appliedSettings.interfaceFont),
		chatFont: structuredClone(appliedSettings.chatFont),
		typography: structuredClone(appliedSettings.typography),
		diffBase: appliedSettings.editor.diffBase,
		notificationMode: appliedSettings.notifications.mode,
		indent: {
			indentStyle: appliedSettings.editor.indentStyle,
			indentSize: appliedSettings.editor.indentSize,
			tabWidth: appliedSettings.editor.tabWidth,
		},
		editing: {
			languageServers: appliedSettings.editor.languageServers,
			closeBrackets: appliedSettings.editor.closeBrackets,
			closeTags: appliedSettings.editor.closeTags,
			callParens: appliedSettings.editor.callParens,
		},
		lineAuthor: appliedSettings.editor.lineAuthor,
		syntaxStyles: appliedSettings.editor.syntaxStyles,
		archiveAfterDays: appliedSettings.agents.archiveAfterDays,
	};
}
/** The system accent as RGBA hex; empty where the desktop gives none (a Linux without the portal's accent, spec/architecture-and-platform#linux-package). */
function systemAccent() {
	try {
		return systemPreferences.getAccentColor() ?? '';
	} catch {
		return '';
	}
}
/** A window's appearance from a machine's settings and this machine's theme, accent and fonts. */
function localAppearance(machine: MachineAppearance): Appearance {
	return composeAppearance(machine, fonts.read(), nativeTheme.shouldUseDarkColors, systemAccent());
}
function appearance(): Appearance {
	return localAppearance(machineAppearance());
}
function publishAppearance() {
	clients.broadcast('appearance:changed', appearance());
	// A device that shows this machine takes its settings with its own theme and fonts (spec/remote-access-and-mobile#client-ui-seam).
	clients.broadcast('remote:appearance', machineAppearance());
}
/** Validate before touching storage: a known client and the table's arguments (none, for a read). */
function registerRead(channel: IpcInvokeChannel, read: () => unknown) {
	register(channel, () => read());
}
function showRoute(route: 'workspace' | 'kit') {
	if (!window) return;
	if (window.webContents.getURL()) {
		clients.broadcast('navigation:route', route);
		return;
	}
	if (developmentUrl) void window.loadURL(`${developmentUrl}#${route}`);
	else void window.loadFile(rendererFile, { hash: route });
}
/** spec/architecture-and-platform#window-frame: the same app menu the macOS menu bar shows, under ☰ (x 10, y 42 unless the button says otherwise). */
function popupAppMenu(x = 10, y = 42, client: Client = localClient) {
	const menu = Menu.getApplicationMenu(),
		target = client.window?.() ?? null;
	if (!menu || !target || target.isDestroyed() || appMenuOpen || chrome === 'darwin')
		return Promise.resolve(false);
	appMenuOpen = true;
	client.send('window:app-menu', true);
	return new Promise<boolean>((resolve) =>
		menu.popup({
			window: target,
			x: Math.round(x),
			y: Math.round(y),
			callback: () => {
				appMenuOpen = false;
				if (!target.isDestroyed()) client.send('window:app-menu', false);
				resolve(true);
			},
		})
	);
}
/**
 * spec/remote-access-and-mobile#client-ui-seam: this device's native side for a connected machine — its menus and saves over the machine's window, its
 * notices with this OS (a click opens the task in that window), its badge added to this machine's, its settings with
 * this device's theme and fonts.
 */
const roleWords = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all' } as const;
function deviceUi(): DeviceUi {
	const shown = new Map<string, Map<number, { close(): void }>>();
	const asWindow = (target: unknown) => target as BrowserWindow;
	return {
		// A role is this device's own Cut, Copy, Paste or Select all, in its own words.
		menu: (target, items, at) =>
			nativeMenu(
				asWindow(target),
				deviceRoleLabels(items, (role) => t(currentLocale(), roleWords[role])),
				at
			),
		save: (target, save) =>
			electronUi.save(asWindow(target), {
				...save,
				filterName: save.extensions.map((item) => item.toUpperCase()).join(', '),
			}),
		// spec/remote-access-and-mobile#browser-from-device: a page's file input of the machine — this device's own dialog over that window, files read here.
		files: async (target, request) => {
			const options: Electron.OpenDialogOptions = {
				properties: request.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
				...(request.extensions
					? {
							filters: [
								{
									name: request.extensions.map((item) => item.toUpperCase()).join(', '),
									extensions: request.extensions,
								},
							],
						}
					: {}),
			};
			const result = await dialog.showOpenDialog(asWindow(target), options);
			if (result.canceled || !result.filePaths.length) return null;
			const files: { name: string; data: Uint8Array }[] = [];
			for (const path of result.filePaths.slice(0, request.multiple ? pageFilesLimit : 1)) {
				const info = await stat(path).catch(() => null);
				if (!info?.isFile() || info.size > remoteUploadLimit) continue;
				files.push({ name: basename(path), data: new Uint8Array(await readFileNode(path)) });
			}
			return files.length ? files : null;
		},
		notify: (ref, value: RemoteNotify) => {
			const gateway = notificationsTest?.gateway ?? deviceNotices;
			const handles = shown.get(ref.machineId) ?? new Map<number, { close(): void }>();
			shown.set(ref.machineId, handles);
			if (value.kind === 'show') {
				const visible = ref.visible();
				// The person looks at this very task in that window: like this machine's own notices, nothing to show.
				if (
					ref.window.isFocused() &&
					visible?.projectId === value.notice.key.projectId &&
					visible.id === value.notice.key.id
				)
					return;
				const handle = gateway.show(
					{ ...value.notice, kind: 'needs-you' },
					{
						open: () => ref.open(value.notice.key),
						allow: () => ref.act(value.id, 'allow'),
						deny: () => ref.act(value.id, 'deny'),
					}
				);
				if (handle) handles.set(value.id, handle);
				for (const id of handles.keys()) {
					if (handles.size <= 200) break;
					handles.delete(id);
				}
			} else if (value.kind === 'close') {
				handles.get(value.id)?.close();
				handles.delete(value.id);
			} else if (value.kind === 'remove') gateway.removeGroup(value.groupId);
			else if (value.kind === 'sound') (notificationsTest?.sounds ?? sounds).play(value.name);
			else {
				machineBadges.set(ref.machineId, value.count);
				showBadge();
			}
		},
		appearance: (machine) => localAppearance(machine),
		closed: (machineId) => {
			for (const handle of shown.get(machineId)?.values() ?? []) handle.close();
			shown.delete(machineId);
			if (machineBadges.delete(machineId)) showBadge();
		},
	};
}
/** The open windows of other machines on this device. */
const machineWindows = new Set<BrowserWindow>();
/**
 * spec/architecture-and-platform#window-frame: F10 and a lone Alt open ☰ on Windows and Linux, from any focus in the window, but not while a shortcut is
 * recorded — in this machine's window and in a window of another machine alike (spec/remote-access-and-mobile#identity-and-keys).
 */
function appMenuKeys(target: BrowserWindow, client: () => Client | undefined) {
	if (chrome === 'darwin') return;
	let altAlone = false;
	const open = (event: Electron.Event) => {
		const owner = client();
		if (!owner || shortcutRecording) return;
		event.preventDefault();
		void popupAppMenu(undefined, undefined, owner);
	};
	target.webContents.on('before-input-event', (event, input) => {
		if (input.type === 'keyDown') {
			// Alt counts only pressed and released on its own: Alt+↓, Ctrl+Alt or a held Alt with any other key is a shortcut.
			if (input.key === 'Alt') {
				if (!input.isAutoRepeat) altAlone = !input.control && !input.shift && !input.meta;
			} else altAlone = false;
			if (input.key === 'F10' && !input.alt && !input.control && !input.shift && !input.meta)
				open(event);
			return;
		}
		if (input.type === 'keyUp' && input.key === 'Alt' && altAlone) {
			altAlone = false;
			open(event);
		}
	});
}
/**
 * spec/remote-access-and-mobile#architecture: a window of this machine that shows a connected machine — the same renderer, preload and protections as
 * the local window (spec/architecture-and-platform#ipc-boundary). Its calls reach `dispatch`, which forwards the remote-class ones over the connection.
 * R1b gives it the chip and the reconnect cover; this is the minimum that runs.
 */
function openRemoteWindow(machine: PairedMachine) {
	const title = t(currentLocale(), '{machine} — Brigadir').replace('{machine}', machine.name);
	const remote = new BrowserWindow({
		width: 1180,
		height: 780,
		minWidth: 820,
		minHeight: 560,
		title,
		...windowFrame(chrome, process.platform, nativeTheme.shouldUseDarkColors),
		show: false,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// spec/remote-access-and-mobile#module-and-settings: the renderer knows it shows another machine — the chip, the reconnect and «taken» states.
			additionalArguments: [
				`--brigadir-chrome=${chrome}`,
				`--brigadir-remote-machine=${machine.id}`,
				`--brigadir-remote-name=${encodeURIComponent(machine.name)}`,
				// spec/remote-access-and-mobile#remote-button: «Go to» names this computer's own window.
				`--brigadir-remote-device=${encodeURIComponent(machineName())}`,
			],
		},
	});
	// The OS title names the machine, not the page (spec/remote-access-and-mobile#module-and-settings: «studio — Brigadir»).
	remote.on('page-title-updated', (event) => {
		event.preventDefault();
		remote.setTitle(title);
	});
	remote.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	remote.webContents.on('will-navigate', (event) => event.preventDefault());
	remote.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
		callback(false)
	);
	// spec/remote-access-and-mobile#client-ui-seam: the menu bar follows this window while it is in front; a field without its own menu gets the edit menu.
	remote.on('focus', syncMenuFocus);
	remote.on('blur', syncMenuFocus);
	remote.webContents.on('focus', syncMenuFocus);
	remote.webContents.on('context-menu', (_event, params) => {
		showEditMenu(remote, currentLocale(), params);
	});
	appMenuKeys(remote, () => clients.list().find((item) => item.window?.() === remote));
	machineWindows.add(remote);
	remote.on('closed', () => {
		machineWindows.delete(remote);
		machineMenuContexts.delete(`window:${machine.id}`);
		syncMenuFocus();
	});
	// spec/remote-access-and-mobile#browser-from-device: closing writes the window's buffers on the machine first (hot exit); the ones it could not keep ask
	// here, over this window, as this machine's own close does.
	let closeAllowed = false,
		closing = false;
	const closeNow = () => {
		closeAllowed = true;
		closing = false;
		if (!remote.isDestroyed()) remote.close();
		// A close held during a quit stopped the quit: it goes on now.
		if (quitRequested) app.quit();
	};
	remote.on('close', (event) => {
		if (closeAllowed) return;
		event.preventDefault();
		if (closing) return;
		closing = true;
		void remoteAccess.closingWindow(machine.id, 'flush').then(
			async (paths) => {
				if (!paths?.length || remote.isDestroyed()) return closeNow();
				const locale = currentLocale();
				const { response } = await messageBox(remote, {
					type: 'warning',
					message: t(locale, 'There are unsaved changes.'),
					detail: paths.join('\n'),
					buttons: [t(locale, 'Keep editing'), t(locale, 'Discard changes')],
					defaultId: 0,
					cancelId: 0,
				});
				if (response === 1) return closeNow();
				closing = false;
				// «Keep editing» during a quit keeps the app too, as this machine's own window does.
				quitRequested = false;
				restartRequested = false;
				quitGuard.cancel();
				void remoteAccess.closingWindow(machine.id, 'keep').catch(() => {});
			},
			// A lost connection does not hold the window.
			closeNow
		);
	});
	// spec/remote-access-and-mobile#browser-from-device: its renderer comes back on its own once a minute; the second crash asks here, over this window.
	const restarts = new RendererRestarts();
	remote.webContents.on('render-process-gone', (_event, details) => {
		if (details.reason === 'clean-exit' || remote.isDestroyed()) return;
		rendererLog.processGone(details.reason, details.exitCode);
		if (restarts.next() === 'reload') {
			remote.webContents.reload();
			return;
		}
		const locale = currentLocale();
		void messageBox(remote, {
			type: 'error',
			message: t(locale, 'The Brigadir window crashes again'),
			detail: `${t(locale, 'The window process stopped two times in one minute.')} (${details.reason})`,
			buttons: [t(locale, 'Reload the window'), t(locale, 'Close window')],
			defaultId: 0,
			cancelId: 0,
		}).then(({ response }) => {
			if (remote.isDestroyed()) return;
			if (response === 1) closeNow();
			else remote.webContents.reload();
		});
	});
	remote.once('ready-to-show', () => {
		if (background) remote.showInactive();
		else remote.show();
	});
	if (developmentUrl) void remote.loadURL(`${developmentUrl}#workspace`);
	else void remote.loadFile(rendererFile, { hash: 'workspace' });
	return remote;
}
function createWindow() {
	menuReady = false;
	menuContext = { ...emptyMenuContext };
	syncMenuFocus();
	if (sessions.isClosingConsoles) {
		void sessions.closeConsoles().then(() => {
			if (!window && !quitRequested) createWindow();
		});
		return;
	}
	consolesClosed = false;
	sessions.openWindow();
	const display = secondaryDisplay
		? screen.getAllDisplays().find((item) => item.id !== screen.getPrimaryDisplay().id)
		: undefined;
	// spec/task-window-workspace#restore-window: the last size and place; a window off every connected display goes to the primary one.
	const restored = savedWindow
		? fitWindowBounds(
				savedWindow,
				screen.getAllDisplays().map((item) => item.workArea),
				screen.getPrimaryDisplay().workArea
			)
		: null;
	// Window buttons sit centred in the 48 px title strip, level with the sidebar toggle and the title (spec/sidebar#layout).
	window = new BrowserWindow({
		width: restored?.width ?? 1180,
		height: restored?.height ?? 780,
		...(restored && !display ? { x: restored.x, y: restored.y } : {}),
		minWidth: 820,
		minHeight: 560,
		title: 'Brigadir',
		...windowFrame(chrome, process.platform, nativeTheme.shouldUseDarkColors),
		show: false,
		focusable:
			!background ||
			process.env.BRIGADIR_INTERACTIVE === '1' ||
			process.argv.includes('--brigadir-interactive'),
		...(display ? { x: display.workArea.x + 16, y: display.workArea.y + 16 } : {}),
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			additionalArguments: [
				`--brigadir-chrome=${chrome}`,
				...(process.env.BRIGADIR_TEST_CRASH
					? [`--brigadir-test-crash=${process.env.BRIGADIR_TEST_CRASH}`]
					: []),
				...(process.env.BRIGADIR_DATA_DIR && process.env.BRIGADIR_TEST_ATTENTION_MS
					? [`--brigadir-test-attention-ms=${process.env.BRIGADIR_TEST_ATTENTION_MS}`]
					: []),
			],
		},
	});
	// spec/architecture-and-platform#window-frame: no menu bar under the overlay; a Mac previewing the PC layout hides its traffic lights instead.
	if (chrome !== 'darwin') {
		if (process.platform === 'darwin') window.setWindowButtonVisibility(false);
		else window.setMenuBarVisibility(false);
	}
	syncMenuFocus();
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
		callback(false)
	);
	const created = window;
	const placeOnSecondary = () => {
		const target = screen
			.getAllDisplays()
			.find((item) => item.id !== screen.getPrimaryDisplay().id);
		if (!target) {
			created.hide();
			return false;
		}
		const bounds = created.getBounds(),
			area = target.workArea;
		created.setBounds({
			x: area.x + 16,
			y: area.y + 16,
			width: Math.min(bounds.width, area.width - 32),
			height: Math.min(bounds.height, area.height - 32),
		});
		return true;
	};
	const displayChanged = () => {
		if (placeOnSecondary()) created.showInactive();
	};
	if (secondaryDisplay) {
		screen.on('display-added', displayChanged);
		screen.on('display-removed', displayChanged);
		screen.on('display-metrics-changed', displayChanged);
		// spec/agents-and-providers#quota-sources: a silent limits refresh that fell on a hidden window runs as soon as it is visible again.
		for (const event of ['show', 'restore', 'focus'] as const)
			created.on(event as 'show', () => quota.shown());
		created.once('closed', () => {
			screen.removeListener('display-added', displayChanged);
			screen.removeListener('display-removed', displayChanged);
			screen.removeListener('display-metrics-changed', displayChanged);
		});
	}
	created.once('ready-to-show', () => {
		if (secondaryDisplay && !placeOnSecondary()) return;
		if (restored?.maximized && !background && !secondaryDisplay) created.maximize();
		if (background) created.showInactive();
		else created.show();
	});
	// Accessory prevents activation during background launch, but also hides the
	// macOS menu bar. The user's first focus makes this a normal interactive app.
	created.once('focus', () => {
		focusedOnce = true;
		if (background && process.platform === 'darwin') app.setActivationPolicy('regular');
	});
	window.on('focus', publishAppearance);
	if (process.env.BRIGADIR_REMOTE_WATCH !== '0') {
		window.on('focus', () => {
			void remoteWatch.check();
		});
		remoteWatch.start();
	}
	window.on('focus', () => {
		void notificationPermission.refresh();
	});
	for (const event of ['resize', 'move'] as const)
		created.on(event as 'resize', () => rememberWindow());
	window.on('close', (event) => {
		launchLocks.cancel();
		// spec/task-window-workspace#restore-window: every task writes its surface and its unsaved buffers before the window goes, so neither a quit nor a
		// window close asks (hot exit, spec/task-window-workspace#restore-window); only a buffer hot exit could not keep does.
		if (!surfaceFlushed) {
			event.preventDefault();
			if (!closePrompt) {
				closePrompt = true;
				rememberWindow(true);
				flushKept.clear();
				flushDraftTasks.clear();
				void flushSurfaces(true).then((answered) => {
					hotExitKept = answered
						? new Set(flushKept)
						: quitRequested || process.platform !== 'darwin'
							? 'all'
							: 'none';
					surfaceFlushed = true;
					closePrompt = false;
					if (quitRequested) app.quit();
					else window?.close();
				});
			}
			return;
		}
		if (quitGuard.busy(saves).length) {
			event.preventDefault();
			if (!closePrompt) {
				closePrompt = true;
				void quitGuard.settle(quitRequested ? 'quit' : 'close', saves).then(() => {
					closePrompt = false;
					if (quitRequested) app.quit();
					else window?.close();
				});
			}
			return;
		}
		const unkept = unkeptPaths();
		if (discarding || !unkept.length) {
			if (!consolesClosed) {
				event.preventDefault();
				if (!closePrompt) {
					closePrompt = true;
					void quitGuard
						.run(quitRequested ? 'quit' : 'close', 'consoles', () => sessions.closeConsoles())
						.then(() => {
							consolesClosed = true;
							closePrompt = false;
							if (quitRequested) app.quit();
							else window?.close();
						});
				}
			}
			return;
		}
		event.preventDefault();
		if (closePrompt) return;
		closePrompt = true;
		const locale = currentLocale();
		void messageBox(window!, {
			type: 'warning',
			message: t(locale, 'There are unsaved changes.'),
			detail: unkept.join('\n'),
			buttons: [t(locale, 'Keep editing'), t(locale, 'Discard changes')],
			defaultId: 0,
			cancelId: 0,
		}).then(({ response }) => {
			closePrompt = false;
			if (response === 1) {
				discarding = true;
				if (quitRequested) app.quit();
				else window?.close();
			} else {
				quitRequested = false;
				restartRequested = false;
				surfaceFlushed = false;
				hotExitKept = 'none';
				// The window stays with its buffers: the drafts of this close would come back over a later save.
				for (const key of flushDraftTasks.values())
					void surfaces.writeDrafts(key, []).catch(() => {});
				flushDraftTasks.clear();
				quitGuard.cancel();
			}
		});
	});
	window.webContents.on('focus', syncMenuFocus);
	appMenuKeys(window, () => localClient);
	// spec/chat#context-menu: a page that handled its own right click prevented it, so this sees only fields without a menu.
	window.webContents.on('context-menu', (_event, params) => {
		showEditMenu(created, currentLocale(), params);
	});
	window.webContents.on('did-start-navigation', (details) => {
		// spec/terminal-and-cli-agents#pty-host: a refused navigation keeps the page and its terminals; only a reload replaces them.
		if (
			details.isMainFrame &&
			!details.isSameDocument &&
			replacesDocument(created.webContents.getURL(), details.url)
		)
			releaseWindowWatches();
	});
	window.webContents.on('render-process-gone', (_event, details) => {
		releaseWindowWatches();
		if (details.reason === 'clean-exit' || created.isDestroyed()) return;
		rendererLog.processGone(details.reason, details.exitCode);
		if (rendererRestarts.next() === 'reload') {
			created.webContents.reload();
			return;
		}
		const locale = currentLocale();
		void messageBox(created, {
			type: 'error',
			message: t(locale, 'The Brigadir window crashes again'),
			detail: `${t(locale, 'The window process stopped two times in one minute.')} (${details.reason})`,
			buttons: [t(locale, 'Reload the window'), t(locale, 'Quit Brigadir')],
			defaultId: 0,
			cancelId: 0,
		}).then(({ response }) => {
			if (response === 1) app.quit();
			else if (!created.isDestroyed()) created.webContents.reload();
		});
	});
	window.on('hide', () => ghosts.cancelAll());
	window.on('minimize', () => ghosts.cancelAll());
	window.on('closed', () => {
		contextState.closeAll();
		releaseWindowWatches();
		ghosts.cancelAll();
		quickAsks.closeAll();
		knowledge.cancelAll();
		window = null;
		visibleTask = null;
		sessions.setVisible(null);
		browsers.close();
		if (!consolesClosed) void sessions.closeConsoles();
		files.resetEditors();
		discarding = false;
		surfaceFlushed = false;
		hotExitKept = 'none';
		flushDraftTasks.clear();
		menuReady = false;
		menuContext = { ...emptyMenuContext };
		syncMenuFocus();
	});
	showRoute('workspace');
}
void app.whenReady().then(async () => {
	// spec/architecture-and-platform#packaging: opened from Finder, a packaged app has /usr/bin:/bin only; the agents' CLIs live on the login shell's PATH.
	const [initialSettings] = await Promise.all([
		settings.read().catch(() => ({ ...defaultAppSettings })),
		app.isPackaged
			? loginShellPath().then((path) => {
					process.env.PATH = path;
				})
			: null,
	]);
	appliedSettings = initialSettings;
	void slack.refresh();
	changes.diffBase = taskDiffs.diffBase = initialSettings.editor.diffBase;
	void codeIntel.setLanguageServers(initialSettings.editor.languageServers);
	// The font catalog helper and worktree recovery are independent: start them together.
	// spec/tasks#backlog-edit: a sheet's draft attachments outlive it only after a crash.
	await Promise.all([
		fonts.start(),
		preparations.recover(),
		SessionStore.at(process.env.BRIGADIR_DATA_DIR)
			.then((store) => store.clearDrafts())
			.catch(() => {}),
	]);
	await launches.restore();
	// spec/appearance#evolution-redesign: a project that never had an icon gets the agent's pick once, in the background.
	if (iconPicks)
		void sessions
			.workspace()
			.then((workspace) => projectIcons.pickMissing(workspace.projects))
			.catch(() => {});
	appliedLanguage = initialSettings.language;
	nativeTheme.themeSource = initialSettings.appearance;
	const settingsSnapshot = (value: AppSettings) => ({
		settings: value,
		restartRequired: value.language !== appliedLanguage,
	});
	registerRead('settings:read', async () => {
		if (!fonts.read()) await fonts.start();
		return settingsSnapshot(await settings.read());
	});
	registerRead('layout:read', () => layout.read());
	registerRead('browser:live', () => browsers.liveTasks());
	registerRead('simulator:toolchain', () => simulators.found());
	registerRead('workspace:read', async () => {
		const workspace = projectIcons.decorate(
			await taskLabels.decorate(
				await taskActivities.decorate(await taskDiffs.decorate(await sessions.workspace()))
			)
		);
		try {
			const seen = await taskReads.read();
			for (const task of workspace.tasks)
				task.hasUnread = (task.activitySeq ?? 0) > (seen[`${task.projectId}/${task.id}`] ?? 0);
		} catch {
			workspace.issues.push({ path: 'task-reads.json', code: 'unreadable' });
		}
		return { ...workspace, homeDirectory: homedir() };
	});
	// spec/remote-access-and-mobile#client-ui-seam: a window of another machine takes that machine's settings with this device's theme and fonts.
	handleClient('appearance:read', async (client) =>
		client.forward
			? localAppearance((await client.forward('appearance:machine', [])) as MachineAppearance)
			: appearance()
	);
	registerRead('appearance:machine', machineAppearance);
	// spec/settings-modules-and-onboarding#module-off: the IPC of a module switched off answers with its sentence; reading its saved commands or drafts is not asked for.
	const channelModule = (channel: string): AppModule | null =>
		channel.startsWith('prs:')
			? 'pullRequests'
			: channel === 'commands:run' || channel === 'commands:menu'
				? 'commands'
				: channel.startsWith('remote:')
					? 'remoteAccess'
					: channel.startsWith('notes:')
						? 'notes'
						: channel.startsWith('schedules:')
							? 'schedules'
							: null;
	// spec/architecture-and-platform#ipc-boundary: the arguments are checked by the channel table's validator (core/ipc-channels) in `dispatch`, the same
	// for a remote call (spec/remote-access-and-mobile#architecture).
	function handle(channel: IpcInvokeChannel, action: (...args: any[]) => unknown) {
		handleClient(channel, (_client, ...args) => action(...args));
	}
	/** A handler that needs to know who calls: the remote status a device reads, who takes control. */
	function handleClient(
		channel: IpcInvokeChannel,
		action: (client: Client, ...args: any[]) => unknown
	) {
		register(channel, (client, args) => {
			const off = channelModule(channel);
			if (off && !appliedSettings.modules[off]) throw new Error(moduleOffMessages[off]);
			if (sidebarMenus.busy(args[0])) {
				if (channel === 'terminal:command' && isRecord(args[1]) && args[1].kind === 'list')
					return [];
				throw new Error('Removal is in progress');
			}
			return action(client, ...args);
		});
	}
	// spec/notifications-slack-notes-and-schedules#slack: Settings ▸ Modules ▸ Slack; the token goes in and never comes back out.
	handle('slack:read', () => slack.state());
	handle('slack:retry', () => slack.refresh());
	handle('slack:connect', (token: string) => slack.setToken(token));
	handle('slack:keychain', () => slack.moveToKeychain());
	handle('slack:disconnect', () => slack.disconnect());
	handle('slack:app-connect', (token: string) => slack.setAppToken(token));
	handle('slack:app-disconnect', () => slack.disconnectApp());
	handle('settings:save', async (value) => {
		const keepAwakeChanged = value.agents.keepAwake !== appliedSettings.agents.keepAwake,
			updatesChanged = value.updates.autoDownload !== appliedSettings.updates.autoDownload,
			archiveChanged = value.agents.archiveAfterDays !== appliedSettings.agents.archiveAfterDays,
			keymapChanged = JSON.stringify(value.keymap) !== JSON.stringify(appliedSettings.keymap),
			modulesChanged = !sameModules(value.modules, appliedSettings.modules),
			authorChanged = value.editor.lineAuthor !== appliedSettings.editor.lineAuthor,
			columnsChanged = value.taskColumns !== appliedSettings.taskColumns,
			slackChanged = value.modules.slack !== appliedSettings.modules.slack,
			remoteChanged =
				value.modules.remoteAccess !== appliedSettings.modules.remoteAccess ||
				JSON.stringify(value.remoteAccess) !== JSON.stringify(appliedSettings.remoteAccess);
		const saved = await settings.save(value);
		appliedSettings = saved;
		if (remoteChanged) await remoteAccess.configure(saved);
		if (slackChanged) void slack.refresh();
		// spec/notifications-slack-notes-and-schedules#slack: the `Create tasks from Slack` switch starts and stops Socket Mode.
		else void slack.listen();
		if (keepAwakeChanged) keepAwake.settingChanged();
		if (updatesChanged) appUpdates.settingsChanged();
		if (archiveChanged) void taskArchives.autoArchive().catch(() => {});
		if (modulesChanged) scheduleSettings?.();
		if (keymapChanged || modulesChanged || authorChanged || columnsChanged) rebuildMenu?.();
		if (!saved.modules.browser) browsers.close();
		if (saved.modules.simulator) simulators.reopen();
		else simulators.close();
		changes.diffBase = taskDiffs.diffBase = saved.editor.diffBase;
		await codeIntel.setLanguageServers(saved.editor.languageServers);
		if (!saved.suggestNextPrompt) ghosts.cancelAll();
		nativeTheme.themeSource = saved.appearance;
		publishAppearance();
		void launches.kick();
		return settingsSnapshot(saved);
	});
	// spec/appearance#evolution-redesign: one action's agent — `Remember for …` of a capsule, `Reset` in Settings; the rest of the settings stays.
	// spec/pull-requests-and-ci#review-crew: an agent and a crew of one action exclude each other — remembering one forgets the other.
	handle('settings:action-agent', async (action: AgentAction, agent: HelperAgent | null) => {
		appliedSettings = await settings.save({
			...appliedSettings,
			actionAgents: withActionAgent(appliedSettings.actionAgents, action, agent),
			...(agent && (action === 'review' || action === 'reviewSuggestions')
				? { actionCrews: withActionCrew(appliedSettings.actionCrews, action, null) }
				: {}),
		});
		return settingsSnapshot(appliedSettings);
	});
	handle('settings:action-crew', async (action: CrewAction, crew: ActionCrew | null) => {
		appliedSettings = await settings.save({
			...appliedSettings,
			actionCrews: withActionCrew(appliedSettings.actionCrews, action, crew),
			...(crew
				? { actionAgents: withActionAgent(appliedSettings.actionAgents, action, null) }
				: {}),
		});
		return settingsSnapshot(appliedSettings);
	});
	// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: remote access. The working machine's rows; managing access is refused to a device in `dispatch`.
	handleClient('remote:status', (client) => remoteAccess.status(client));
	handle('remote:enable', (enabled, password) => remoteAccess.setEnabled(enabled, password));
	handle('remote:password', (password) => remoteAccess.setPassword(password));
	handle('remote:rename', (name) => remoteAccess.rename(name));
	handle('remote:revoke', (id) => remoteAccess.revoke(id));
	handle('remote:revoke-all', () => remoteAccess.revokeAll());
	handle('remote:unblock', (id) => remoteAccess.unblock(id));
	handle('remote:drop', (id) => remoteAccess.drop(id));
	handle('remote:audit-reveal', () => remoteAccess.revealAudit());
	handle('remote:pairing-start', () => remoteAccess.startPairing());
	handle('remote:pairing-stop', () => remoteAccess.stopPairing());
	handle('remote:pairing-confirm', (accept, name) => remoteAccess.confirmPairing(accept, name));
	handle('remote:audit', (limit) => remoteAccess.readAudit(limit));
	handle('remote:phone', (enabled) => remoteAccess.setPhone(enabled));
	handle('remote:phone-check', () => remoteAccess.checkPhone());
	handleClient('remote:take-control', (client) => remoteAccess.takeControl(client));
	// The device's rows: this machine's own list of machines and its connections.
	handle('remote:machines', () => remoteAccess.readMachines());
	handle('remote:browse', (on) => remoteAccess.browse(on));
	handle('remote:pair', (host, port, code, name) => remoteAccess.pair(host, port, code, name));
	handle('remote:pair-cancel', () => remoteAccess.cancelPair());
	handle('remote:forget', (id) => remoteAccess.forget(id));
	handle('remote:connect', (id, password, takeOver) =>
		remoteAccess.connect(id, password, takeOver)
	);
	handle('remote:disconnect', (id) => remoteAccess.disconnect(id));
	handle('remote:sessions', () => remoteAccess.sessions());
	// spec/remote-access-and-mobile#remote-button: «Go to» from the chip's menu in another machine's window.
	handle('remote:show', (id, connect) => {
		if (id && remoteAccess.showWindow(id)) return;
		if (!window || window.isDestroyed()) {
			createWindow();
			return;
		}
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
		if (connect) localClient.send('remote:open', id);
	});
	// spec/remote-access-and-mobile#identity-and-keys: the list of machines says up front that a Linux without a secret service cannot keep the key.
	handle('remote:key-store', () =>
		keyStoreState(
			process.platform,
			safeStorage,
			!app.isPackaged && process.env.BRIGADIR_DATA_DIR
				? (process.env.BRIGADIR_TEST_KEY_STORE ??
						(process.env.BRIGADIR_TEST_REMOTE_VAULT === '1' ? 'ok' : undefined))
				: undefined
		)
	);
	void remoteAccess.configure(initialSettings).catch((error: unknown) => {
		console.error(`remote: ${error instanceof Error ? error.message : String(error)}`);
	});
	registerRead('sounds:read', () => sounds.names());
	handle('sounds:preview', (name) => {
		if (notificationsTest) {
			notificationsTest.sounds.play(name);
			return true;
		}
		return sounds.playNamed(name);
	});
	registerRead('notifications:permission', () => notificationPermission.refresh());
	handle('notifications:request', () => notificationPermission.request());
	handle('notices:read', () => noticeLog.center());
	handle('notices:action', (action) => noticeLog.act(action));
	handle('notices:toast', (toast) => noticeLog.addToast(toast));
	handle('context:answer', (id, report) => {
		contextState.settle(id, report);
	});
	handle('notifications:system-settings', () => {
		if (process.platform === 'darwin')
			return shell.openExternal(
				'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
			);
	});
	handle('notifications:visible', async (key) => {
		ghosts.cancelAll();
		visibleTask = key;
		sessions.setVisible(key);
		if (key) {
			void noticeLog.readTask(key).catch(() => {});
			const task = await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).task(key);
			await taskReads.mark(key, task.activitySeq ?? 0);
			clients.broadcast('session:event', { key, record: null });
		}
	});
	handle('settings:restart', () => {
		if (restartRequested) return;
		restartRequested = true;
		setTimeout(() => app.quit(), 0);
	});
	handle('task:rename', async (key, title) => {
		await taskLabels.rename(key, title);
		clients.broadcast('session:event', { key, record: null });
	});
	handleClient('task:menu', (client, key) => sidebarMenus.task(key, client));
	// spec/tasks#archive: archive by hand (⌃⌘A, swipe, the Archive window), restore, delete from the Archive window, the sidebar sections.
	handle('archive:task', (key) => taskArchives.archive(key));
	handleClient('archive:completed', async (client, id) =>
		sidebarMenus.archiveCompleted(
			personTasks(
				(
					await readWorkspace(
						process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
					)
				).tasks
			).filter(
				(task) =>
					task.status === 'completed' && !task.archived && (id === null || task.projectId === id)
			),
			client
		)
	);
	handle('archive:restore', async (keys: TaskKey[]) => {
		for (const key of keys) await taskArchives.restore(key);
	});
	handleClient('archive:delete', (client, keys: TaskKey[]) =>
		sidebarMenus.deleteArchived(keys, client)
	);
	handle('sidebar:archive-read', () => sidebarState.readArchive());
	handle('sidebar:archive-open', (id, open) => sidebarState.setArchive(id, open));
	handle('project-views:read', () => projectViews.read());
	handle('project-views:save', (id, view) => projectViews.save(id, view));
	handle('project-modes:read', () => projectViews.readModes());
	handle('project-modes:save', (id, mode) => projectViews.saveMode(id, mode));
	handle('board:move', (key, column) => boards.move(key, column));
	handleClient('board:option', (client, key, kind) => boards.optionMenu(key, kind, client));
	handle('board:edit', async (key, text, provider, transport, input, sheet?: TaskSheet) => {
		const launch = withAutoBranch(
			await launchSettings.resolve(key.projectId, input),
			sheet?.name ?? '',
			text,
			key.id
		);
		// spec/tasks#backlog-edit: the sheet's name, model options and attachment list; the attachments are the task's own, checked on disk.
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			options = sheet?.options?.length ? await sheetOptions(provider, sheet.options) : null;
		const attachments = sheet?.attachments
			? await new Attachments(store).list(
					{ projectId: key.projectId, id: key.id },
					sheet.attachments
				)
			: undefined;
		const task = await boards.edit(key, text, provider, transport, launch, {
			...(sheet ? { name: sheet.name ?? null } : {}),
			...(options ? { options } : {}),
			...(attachments ? { attachments } : {}),
		});
		await launchSettings.save(key.projectId, launch);
		return task;
	});
	handleClient('board:delete', async (client, key) => {
		if (
			(await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).task(key)).status !==
			'completed'
		)
			throw new Error('Task is no longer completed');
		return sidebarMenus.removeTask(key, client);
	});
	// spec/projects-and-board#person-tasks: the column clears what it shows, the person's tasks; workers go only with their foreman (spec/tasks#delete-task).
	handleClient('board:clear', async (client, id) =>
		sidebarMenus.clearCompleted(
			personTasks(
				(
					await readWorkspace(
						process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
					)
				).tasks
			).filter((task) => task.status === 'completed' && (id === null || task.projectId === id)),
			client
		)
	);
	handleClient('project:menu', (client, id) => sidebarMenus.project(id, client));
	// spec/task-window-workspace#restore-window: the task's surface.json and its hot-exit drafts.
	handle('surface:read', (key) => surfaces.read(key));
	handle('surface:write', (key, surface) => surfaces.write(key, surface));
	handleClient('surface:drafts', async (client, key, drafts) => {
		await surfaces.writeDrafts(key, drafts);
		// spec/task-window-workspace#restore-window: these buffers are kept; the close asks only about the others. A device's
		// window that closes keeps its own list (spec/remote-access-and-mobile#browser-from-device).
		const flush = deviceFlushes.get(client.id);
		for (const draft of drafts) if (draft.id) (flush?.kept ?? flushKept).add(draft.id);
		if (drafts.length) (flush?.tasks ?? flushDraftTasks).set(`${key.projectId}/${key.id}`, key);
	});
	/**
	 * spec/remote-access-and-mobile#browser-from-device: a device closes its window of this machine. `flush` — only that window writes its surfaces and the
	 * buffers hot exit keeps; the answer is the unsaved buffers of that window it could not keep. `keep` — the person went
	 * on editing: the drafts of that flush go, as a «Keep editing» of this machine's own close does.
	 */
	handleClient('remote:closing', async (client, phase) => {
		if (!client.device) throw new Error('Only a device closes its window of this machine.');
		if (phase === 'keep') {
			const flush = deviceFlushes.get(client.id);
			deviceFlushes.delete(client.id);
			for (const key of flush?.tasks.values() ?? [])
				await surfaces.writeDrafts(key, []).catch(() => {});
			return null;
		}
		const flush = { kept: new Set<string>(), tasks: new Map<string, TaskKey>() };
		deviceFlushes.set(client.id, flush);
		await flushClientSurfaces(client);
		return files.unsaved((id) => dirtyOwners.get(id) === client.id && !flush.kept.has(id));
	});
	handle('surface:flushed', (id) => {
		flushWaiters.get(id)?.();
	});
	handle('layout:save', (value) => layout.save(value));
	// spec/tasks#backlog-edit: an owner is a task or a launch sheet's draft; only the fields that name it go on.
	const owner = (value: AttachmentOwner): AttachmentOwner => ({
		projectId: value.projectId,
		id: value.id,
		...(value.draft ? { draft: true as const } : {}),
	});
	/**
	 * spec/remote-access-and-mobile#client-ui-seam: files of this machine for a window of another machine go there as bytes: the picker opens over that
	 * window, dropped and pasted files are read here, and the machine makes the attachments.
	 */
	const upload =
		(client: Client, key: AttachmentOwner) => (name: string, bytes: Uint8Array, image: boolean) =>
			client.forward!('attachment:upload', [
				owner(key),
				name,
				bytes,
				image,
			]) as Promise<PromptAttachment>;
	handleClient('attachment:pick', async (client, key) => {
		if (!client.forward)
			await new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).ownerDir(
				owner(key)
			);
		const paths = await pickFiles(client.window?.() ?? null);
		if (!paths.length) return [];
		return client.forward
			? uploadPaths(upload(client, key), paths)
			: attachPaths(owner(key), paths, process.env.BRIGADIR_DATA_DIR);
	});
	handleClient('attachment:paths', (client, key, paths) =>
		client.forward
			? uploadPaths(upload(client, key), paths)
			: attachPaths(owner(key), paths, process.env.BRIGADIR_DATA_DIR)
	);
	handleClient('attachment:paste', async (client, key, name) => {
		if (!client.forward) return pasteAttachment(owner(key), name, process.env.BRIGADIR_DATA_DIR);
		const png = await clipboardPng();
		return png ? upload(client, key)(name, new Uint8Array(png), true) : null;
	});
	handle('attachment:upload', (key, name, bytes, image) =>
		uploadAttachment(owner(key), name, bytes, image, process.env.BRIGADIR_DATA_DIR)
	);
	handle('attachment:create', async (key, input) =>
		new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).create(key, input)
	);
	// spec/remote-access-and-mobile#client-ui-seam: the image is the machine's, the clipboard is the one the person sits at.
	handleClient('attachment:copy-image', async (client, key, id) => {
		const input = client.forward
			? ((await client.forward('attachment:read', [owner(key), id])) as AttachmentInput)
			: (
					await new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).read(
						owner(key),
						id
					)
				).input;
		if (input?.kind !== 'image' || typeof input.data !== 'string')
			throw new Error('The attachment is not an image');
		await copyImage(Buffer.from(input.data, 'base64'));
	});
	handle(
		'attachment:read',
		async (key, id) =>
			(
				await new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).read(
					owner(key),
					id
				)
			).input
	);
	handle(
		'attachment:thumbnail',
		async (key, id) =>
			`data:image/png;base64,${(await new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).thumbnail(owner(key), id, thumbnailPng)).toString('base64')}`
	);
	handle('attachment:discard-draft', async (key) => {
		await new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).discard({
			projectId: key.projectId,
			id: key.id,
		});
	});
	handleClient('sheet:markdown', async (client) => {
		const path = await ui.pick(client, {
			target: 'file',
			title: fromMachine('Description from a .md file on {machine}'),
			extensions: ['md', 'markdown'],
			filterName: 'Markdown',
		});
		return path ? readMarkdown(path) : null;
	});
	handleClient('sheet:attach-menu', async (client, x: number, y: number) => {
		const locale = currentLocale();
		return (await ui.menu(
			client,
			[
				{ id: 'files', label: t(locale, 'Attach files…'), icon: attachMenuIcons.files },
				{
					id: 'markdown',
					label: t(locale, 'Description from a .md file…'),
					icon: attachMenuIcons.markdown,
				},
			],
			{ x, y }
		)) as 'files' | 'markdown' | null;
	});
	handle(
		'attachment:info',
		async (key, id) =>
			(
				await new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).read(
					owner(key),
					id
				)
			).attachment
	);
	handle('attachment:task-summary', async (key, source) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			task = await store.task(source),
			journal = await store.journal(source),
			diff = await readRelayDiff(store, source, changes.range(source));
		return new Attachments(store).create(key, {
			kind: 'text',
			name: `${taskSummaryPrefix}${task.title}`.slice(0, 200),
			text: taskSummaryText(task, journal.records, diff.stat).slice(0, 256 * 1024),
		});
	});
	registerRead('quota:read', () => quota.read());
	handle('quota:refresh', () => quota.refreshAll());
	handle('quota:watch', (provider, window) => quota.watch(provider, window));
	registerRead('agents:read', async () => {
		const value = await liveAgents.read();
		return {
			...value,
			agents: await Promise.all(
				value.agents.map(async (agent) => ({
					...agent,
					title: await taskLabels.title(agent.key, agent.title),
				}))
			),
		};
	});
	handle('agents:control', (ref, action) => {
		if (sidebarMenus.busy(ref.key)) throw new Error('Removal is in progress');
		return liveAgents.control(ref, action);
	});
	// spec/remote-access-and-mobile#client-ui-seam: a device chooses the folder in the browser of this machine.
	handleClient('project:add', async (client) => {
		const path = await ui.pick(client, {
			target: 'folder',
			title: fromMachine('Add a project from {machine}'),
			extensions: null,
		});
		if (!path) return null;
		const project = await projects.open(path);
		await refreshRecent();
		pickNewProjectIcon(project);
		return project;
	});
	// spec/settings-modules-and-onboarding#intro: the intro's drop zone; only an absolute path to a folder opens a project. A folder dropped into a window of
	// another machine is this device's: a project of that machine comes from its browser (spec/remote-access-and-mobile#client-ui-seam).
	handleClient('project:add-path', async (client, path: string) => {
		if (client.forward)
			throw new Error('A project of another machine is added from its folder browser.');
		if (!(await stat(path).catch(() => null))?.isDirectory()) return null;
		const project = await projects.open(path);
		await refreshRecent();
		pickNewProjectIcon(project);
		return project;
	});
	// spec/appearance#evolution-redesign: the project icon — the person's choice, «Pick again», «From repo».
	handle('project:icon-set', (projectId, icon) => projectIcons.set(projectId, icon));
	handle('project:icon-pick', (projectId) => projectIcons.pick(projectId));
	handle('project:icon-repo', (projectId) => projectIcons.candidates(projectId));
	handle('project:icon-repo-set', (projectId, path, color) =>
		projectIcons.setRepo(projectId, path, color)
	);
	// spec/projects-and-board#project-icon: the person's image, «Your image», «Generate with Codex».
	handle('project:icon-image-set', (projectId, png) => projectIcons.setImage(projectId, png));
	handle('project:icon-image', (projectId) => projectIcons.readImage(projectId));
	handle('project:icon-generate', (projectId, hint) => projectIcons.generate(projectId, hint));
	handle('launch:conflict', () => launchLocks.conflict);
	handle('launch:resolve', (id, choice) => launchLocks.resolve(id, choice));
	handle('launch:locks', (key) => launchLocks.scopes(key));
	handle('launch:log', (key) => preparations.log(key));
	// spec/tasks#sheet-base-ref: the sheet picks a base ref from the project's own refs instead of typing one.
	handle('launch:refs', async (projectId) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
		return listRefs((await store.project(projectId)).path);
	});
	// spec/projects-and-board#external-folders: an outside folder is one task's choice; neither the sheet nor the panel writes it to the project.
	// spec/projects-and-board#folders-mid-task: «Add folder…» in the Repos panel joins the task, also while it runs.
	handleClient('scopes:add-folder', async (client, projectId, taskId) => {
		const path = await ui.pick(client, {
			target: 'folder',
			title: fromMachine('Add a folder from {machine}'),
			extensions: null,
		});
		if (!path) return null;
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			key = { projectId, id: taskId },
			taken = (await store.task(key)).launch?.scopes;
		const choice = await launchSettings.describeFolder(projectId, path, taken);
		await sessions.command(key, { kind: 'addScope', choice });
		return choice;
	});
	handleClient('launch:add-folder', async (client, projectId, names: string[]) => {
		const path = await ui.pick(client, {
			target: 'folder',
			title: fromMachine('Add a folder from {machine}'),
			extensions: null,
		});
		if (!path) return null;
		return launchSettings.describeFolder(
			projectId,
			path,
			names.map((name) => ({ name }))
		);
	});
	// spec/composer#slash-menu: the `/` menu's list before the agent starts; only reads the agent's and the project's files.
	handle('slash:catalog', async (request) =>
		readSlashCatalog(
			await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			request,
			appliedSettings.modules
		)
	);
	handle('launch:search-files', async (projectId, query) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
		const settings = await launchSettings.read(projectId);
		return searchProjectFiles((await store.project(projectId)).path, settings.scopes, query);
	});
	handle('launch:remove-worktree', async (key) => {
		if (await sessions.connected(key))
			throw new Error('Stop the task before removing its worktree');
		await preparations.discard(key);
	});
	handle('ghost:request', (key, turn, id) => ghosts.request(key, turn, id));
	handle('ghost:cancel', (key, id) => ghosts.cancel(key, id));
	handle('quick:ask', (key, request) => {
		void quickAsks.ask(key, request);
	});
	handle('quick:follow-up', (key, id, question) => {
		void quickAsks.followUp(key, id, question);
	});
	handle('quick:stop', (id) => quickAsks.stop(id));
	handle('quick:close', (id) => {
		quickAsks.close(id);
	});
	handle('quick:permission', (id, requestId, optionId) => {
		quickAsks.answer(id, requestId, optionId);
	});
	handle('quick:revert', (key, fileId, range) => quickAsks.revert(key, fileId, range));
	handle('sidebar:read', () => sidebarState.read());
	handle('sidebar:collapse', (id, collapsed) => sidebarState.set(id, collapsed));
	handle('sidebar:crew-read', () => sidebarState.readCrews());
	handle('sidebar:selection-read', () => sidebarState.readSelection());
	handle('sidebar:select', (value) => sidebarState.select(value));
	handle('sidebar:crew-collapse', (id, collapsed) => sidebarState.setCrew(id, collapsed));
	// spec/notifications-slack-notes-and-schedules#notes: notes are plain files in `~/.brigadir/notes/`; every change goes to all windows so a list and an open note
	// follow the agent's edits and the other window's.
	const notesStore = NotesStore.at(process.env.BRIGADIR_DATA_DIR);
	const notesChanged = (change: NotesChange) => clients.broadcast('notes:changed', change);
	// spec/notifications-slack-notes-and-schedules#notes: the note's chat — its agent session, journal and Undo.
	const noteChats = new NoteChats({
		store: notesStore,
		projectPath: async (project) =>
			project
				? ((
						await readWorkspace(
							process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
						)
					).projects.find((item) => item.id === project)?.path ?? null)
				: null,
		send: (event) => clients.broadcast('notes:chat-event', event),
		changed: (id) => notesChanged({ id, kind: 'written' }),
		adapter: process.env.BRIGADIR_TEST_AGENT
			? {
					command: '/usr/bin/env',
					args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, process.env.BRIGADIR_TEST_AGENT],
				}
			: undefined,
	});
	app.on('will-quit', () => noteChats.closeAll());
	handle('notes:chat-read', (id: string) => noteChats.read(id));
	handle('notes:chat-send', (id: string, text: string, choice: NoteChatChoice) => {
		// The answer streams by `notes:chat-event`; the call returns once the message is on its way.
		void noteChats.send(id, text, choice);
	});
	handle('notes:chat-stop', (id: string) => noteChats.stop(id));
	handle('notes:chat-undo', (id: string, seq: number) => noteChats.undo(id, seq));
	handle('notes:list', async () => (await notesStore).list());
	handle('notes:read', async (id: string) => (await notesStore).read(id));
	handle('notes:create', async (project: string | null, text: string) => {
		const id = await (await notesStore).create(project, text);
		notesChanged({ id, kind: 'created' });
		return id;
	});
	handle('notes:write', async (id: string, text: string) => {
		const updatedAt = await (await notesStore).write(id, text);
		notesChanged({ id, kind: 'written' });
		return updatedAt;
	});
	handle('notes:set-project', async (id: string, project: string | null) => {
		await (await notesStore).setProject(id, project);
		notesChanged({ id, kind: 'meta' });
	});
	handle('notes:delete', async (id: string) => {
		noteChats.close(id);
		await (await notesStore).delete(id);
		notesChanged({ id, kind: 'deleted' });
	});
	handleClient('notes:menu', async (client, id: string) => {
		const locale = currentLocale(),
			path = join(await (await notesStore).dir(), `${id}.md`);
		return (await ui.menu(client, [
			{ id: 'task', label: t(locale, 'Create task from note'), icon: noteMenuIcons.task },
			{ id: 'chat', label: t(locale, 'Chat about the note'), icon: noteMenuIcons.chat },
			null,
			{
				id: 'reveal',
				label: t(locale, 'Reveal in Finder'),
				icon: noteMenuIcons.reveal,
				reveal: path,
			},
			{ id: 'copy', label: t(locale, 'Copy path'), icon: noteMenuIcons.copy, copy: path },
			null,
			{ id: 'delete', label: t(locale, 'Delete note…'), icon: noteMenuIcons.delete },
		])) as 'task' | 'chat' | 'delete' | null;
	});
	handleClient('notes:task-project-menu', async (client) => {
		const { projects: list } = await readWorkspace(
			process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
		);
		return (await ui.menu(
			client,
			list.map((project) => ({ id: project.id, label: project.name }))
		)) as string | null;
	});
	handle('notes:attach', async (owner: AttachmentOwner, id: string) => {
		const note = await (await notesStore).read(id);
		return new Attachments(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).create(owner, {
			kind: 'text',
			name: `${note.title || id}.md`,
			text: note.text,
		});
	});
	handle(
		'notes:link-task',
		async (
			id: string,
			task: { projectId: string; id: string; title: string },
			after: number | null
		) => {
			await (
				await notesStore
			).linkTask(id, { projectId: task.projectId, taskId: task.id }, task.title, after);
			notesChanged({ id, kind: 'written' });
		}
	);
	handleClient('notes:project-menu', async (client, id: string, x: number, y: number) => {
		const locale = currentLocale(),
			note = await (await notesStore).read(id),
			{ projects: list } = await readWorkspace(
				process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
			);
		return (await ui.menu(
			client,
			[
				{ id: 'none', label: t(locale, 'No project'), checked: note.project === null },
				null,
				...list.map((project) => ({
					id: project.id,
					label: project.name,
					checked: project.id === note.project,
				})),
			],
			{ x, y }
		)) as string | null;
	});
	handle('knowledge:read', (id) => knowledge.read(id));
	handle('knowledge:prepare', (id, sig, target) => knowledge.prepare(id, sig, target));
	handle('knowledge:generate', (id, sig, preview) => knowledge.generate(id, sig, preview));
	handle('knowledge:cancel', (id) => knowledge.cancel(id));
	handle('knowledge:reject', (id, sig) => knowledge.reject(id, sig));
	handle('knowledge:restore', (id, sig) => knowledge.restore(id, sig));
	handle('knowledge:add', (id, sig, preview, text) => knowledge.add(id, sig, preview, text));
	handle('knowledge:dismiss', (id, receipt) => knowledge.dismiss(id, receipt));
	handle('knowledge:undo', (id, receipt) => knowledge.undo(id, receipt));
	handle('knowledge:file', (id, target) => knowledge.file(id, target));
	handle('forge:read', (key, remote, fresh) => forge.read(key, remote, fresh));
	handle('forge:prepare-push', (key, id) => forge.preparePush(key, id));
	handle('forge:push', (key, id) => forge.push(key, id));
	handle('forge:prepare-pr', (key, id) => forge.preparePR(key, id));
	handle('forge:check-pr', (key, id, pair) => forge.checkPR(key, id, pair));
	handle('forge:create-pr', (key, id, input) => forge.createPR(key, id, input));
	handle('forge:generate', (key, id, run?: HelperRun | null) => forge.generate(key, id, run));
	handle('forge:discard', (key, id) => forge.discard(key, id));
	handle('forge:hide-suggestion', (key, id) => forge.hideSuggestion(key, id));
	handle('forge:details', (key, id) => forge.details(key, id));
	// spec/pull-requests-and-ci#pr-threads, spec/diff-and-review#review-comments, spec/pull-requests-and-ci#merge: a PR in the panel — diff from tree snapshots, drafts on the task's disk, GitHub writes only on the person's action.
	handle('prs:prepare', (key, ref) =>
		pullRequests.prepare(key.projectId, key.id, ref.scopeId, ref.number)
	);
	handle('prs:files', (key, ref) =>
		pullRequests.files(key.projectId, key.id, ref.scopeId, ref.number)
	);
	handle('prs:file-diff', (key, ref, path) =>
		pullRequests.fileDiff(key.projectId, key.id, ref.scopeId, ref.number, path)
	);
	// spec/pull-requests-and-ci#pr-definition: the clicked line (≤ 64 KiB) and its 1-based place; the search reads only the PR head tree.
	handle('prs:definition', (key, ref, path, line, column, text) =>
		pullRequests.definition(
			key.projectId,
			key.id,
			ref.scopeId,
			ref.number,
			path,
			line,
			column,
			text
		)
	);
	handle('prs:draft-read', (key, ref) => pullRequests.readDraft(key, ref.scopeId, ref.number));
	handle('prs:review-states', (projectId, refs) => pullRequests.reviewStates(projectId, refs));
	handle('prs:draft-viewed', (key, ref, n, of) =>
		pullRequests.noteViewed(key, ref.scopeId, ref.number, n, of)
	);
	// spec/appearance#evolution-redesign: a PR list row's menu; the renderer acts on the answer, the copies finish here.
	handleClient('prs:menu', (client, key, ref, pr) => prMenus.show(client, key, ref, pr));
	handle('prs:draft-add', (key, ref, input) =>
		pullRequests.addDraft(key, ref.scopeId, ref.number, input)
	);
	handle('prs:draft-edit', (key, ref, id, body) =>
		pullRequests.editDraft(key, ref.scopeId, ref.number, id, body)
	);
	handle('prs:draft-remove', (key, ref, id) =>
		pullRequests.removeDraft(key, ref.scopeId, ref.number, id)
	);
	handle('prs:draft-discuss', (key, ref, id, body) =>
		pullRequests.discuss(key, ref.scopeId, ref.number, id, body)
	);
	handle('prs:review-set', (key, ref, patch) =>
		pullRequests.setReview(key, ref.scopeId, ref.number, patch)
	);
	handle('prs:submit', (key, ref) => pullRequests.submit(key, ref.scopeId, ref.number));
	handle('prs:comment-now', (key, ref, input) =>
		pullRequests.commentNow(key, ref.scopeId, ref.number, input)
	);
	handle('prs:comment', (key, ref, body) =>
		pullRequests.comment(key, ref.scopeId, ref.number, body)
	);
	handle('prs:resolve', (key, ref, thread, resolved) =>
		pullRequests.resolve(key, ref.scopeId, ref.number, thread, resolved)
	);
	handle('prs:viewed', (key, ref, path, viewed) =>
		pullRequests.viewed(key, ref.scopeId, ref.number, path, viewed)
	);
	handle('prs:ready', (key, ref) => pullRequests.ready(key, ref.scopeId, ref.number));
	handle('prs:merge', async (key, ref, method, deleteBranch) => {
		const merged = await pullRequests.merge(key, ref.scopeId, ref.number, method, deleteBranch);
		// spec/notifications-slack-notes-and-schedules#slack: PR merged — a reply in the task's thread, broadcast to the project's channel.
		if (appliedSettings.modules.slack && slack.state().state !== 'off') {
			const task = await slackTask(key).catch(() => null);
			slack.post(
				{
					kind: 'prMerged',
					repo: merged.repository,
					head: merged.summary.head,
					base: merged.summary.base,
					task: task?.ref ?? null,
					number: merged.summary.number,
					url: merged.summary.url,
				},
				key.projectId
			);
		}
	});
	handle('prs:summary-read', (key, ref) => pullRequests.readSummary(key, ref.scopeId, ref.number));
	handle('prs:summary', (key, ref, run?: HelperRun | null) =>
		pullRequests.summary(key, ref.scopeId, ref.number, run)
	);
	handle('prs:summary-stop', (key, ref) => {
		pullRequests.stopSummary(key, ref.scopeId, ref.number);
	});
	handle('prs:draft-accept', (key, ref, id) =>
		pullRequests.acceptDraft(key, ref.scopeId, ref.number, id)
	);
	handle('prs:review-body', (key, ref, run?: HelperRun | null) =>
		pullRequests.reviewBody(key, ref.scopeId, ref.number, run)
	);
	handle('prs:verdict', (key, ref) => pullRequests.verdict(key, ref.scopeId, ref.number));
	handle('prs:ask', (key, ref, question) =>
		pullRequests.ask(key, ref.scopeId, ref.number, question)
	);
	/**
	 * spec/pull-requests-and-ci#review-modal, spec/pull-requests-and-ci#review-with-agent, spec/tasks#task-states: agent work on a PR. `review` — a «Review #N» task in a worktree on the PR branch; the agent writes no
	 * code and leaves comments as drafts via pr_comment. `fix` — review drafts go as a prompt: an own PR to the task it came
	 * from; someone else's to a fix task in a worktree on the PR branch, or without push rights on `<head>-fixes`, with a separate
	 * PR into `<head>`. Push only through the usual confirmation (spec/pull-requests-and-ci#gh-integration).
	 */
	// spec/remote-access-and-mobile#phone-pr-list: a phone's place is for this review only — a phone changes no settings of the machine (spec/remote-access-and-mobile#phone).
	handleClient(
		'prs:agent-task',
		(
			client,
			key,
			ref,
			mode,
			sendComments,
			where?: 'quick' | 'worktree' | null,
			agent?: HelperRun | null,
			suggestions?: boolean,
			crew?: string
		) =>
			agentTask(
				key,
				ref,
				mode,
				sendComments,
				where ?? undefined,
				client.device?.kind === 'phone',
				agent,
				suggestions === true,
				crew ?? null
			)
	);
	/**
	 * spec/appearance#evolution-redesign: the agent of a task an action starts — the one-time choice, else the action's own agent of Customize per
	 * action, else the Default agent (its provider, the catalog's own model and effort: no launch options).
	 */
	async function taskAgent(action: TaskAction, run?: HelperRun | null) {
		const enabled = appliedSettings.agents.enabled,
			chosen = actionChoice(
				action,
				run,
				appliedSettings.actionAgents,
				enabled,
				knownCatalogs()
			).run;
		if (!chosen) return { provider: appliedSettings.agents.provider, launchOptions: [] };
		const catalog = await providerCatalogs(chosen.provider).catch(() => null);
		return { provider: chosen.provider, launchOptions: taskLaunchOptions(chosen, catalog) };
	}
	async function agentTask(
		key: TaskKey,
		ref: { scopeId: string; number: number },
		mode: 'review' | 'fix',
		sendComments: boolean,
		where: 'quick' | 'worktree' | undefined,
		phone: boolean,
		/** spec/appearance#evolution-redesign: the «Agent» section of «Review with an agent ▾» — this review only; none is the Default agent. */
		agent?: HelperRun | null,
		/** spec/appearance#evolution-redesign: asked from step 2 of the review modal — the action «agent suggestions in review». */
		suggestions = false,
		/** spec/pull-requests-and-ci#review-crew: the Crew segment — a library crew for this review; none takes the crew the action remembers, if any. */
		crewChoice: string | null = null
	) {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			detail = await pullRequests.detail(key.projectId, key.id, ref.scopeId, ref.number, true),
			pr = detail.summary,
			locale = currentLocale();
		const drafts =
			mode === 'fix' ? await pullRequests.handOff(key, ref.scopeId, ref.number, sendComments) : [];
		const lines = drafts
			.map(
				(draft) =>
					`- ${draft.path}:${draft.startLine && draft.startLine < draft.line ? `${draft.startLine}-` : ''}${draft.line} (${draft.side === 'LEFT' ? 'old' : 'new'} side)${draft.replyTo ? ' — a reply in a review thread' : ''}: ${draft.body}`
			)
			.join('\n');
		// spec/appearance#evolution-redesign: on your own PR the agent also gets the open threads of the reviewers, not only your drafts.
		const threads =
			mode === 'fix' && pr.mine
				? detail.threads.filter(
						(thread) => !thread.resolved && thread.comments[0]?.author !== pr.author
					)
				: [];
		const threadLines = threads
			.map(
				(thread) =>
					`- ${thread.path}:${thread.line ?? 1} — a review thread:\n${thread.comments.map((comment) => `  ${comment.author}: ${comment.body.replace(/\n/g, '\n  ')}`).join('\n')}`
			)
			.join('\n');
		const fixPrompt = `Address the review of pull request #${pr.number} "${pr.title}" (${pr.head} → ${pr.base}).${lines ? `\nReview comments:\n${lines}` : ''}${threadLines ? `\nOpen review threads:\n${threadLines}` : ''}\nMake the changes, run the relevant checks and commit. Do not push: the person confirms the push.`;
		if (mode === 'fix' && pr.mine) {
			const owner = (
				await readWorkspace(
					process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
				)
			).tasks.find(
				(task) =>
					task.projectId === key.projectId && task.pullRequests?.[ref.scopeId]?.number === pr.number
			);
			if (owner)
				return {
					task: owner,
					created: false,
					prompt: fixPrompt,
					count: drafts.length,
					threads: threads.length,
				};
		}
		const trees = await pullRequests.prepare(key.projectId, key.id, ref.scopeId, ref.number);
		const defaults = await launchSettings.resolve(key.projectId, undefined),
			own = pr.mine || detail.canPush;
		// spec/pull-requests-and-ci#review-with-agent: a quick review runs in the main tree on the person's branch and reads the PR from git; no worktree.
		const quick = mode === 'review' && (where ?? appliedSettings.agents.reviewWhere) === 'quick';
		if (mode === 'review' && where && where !== appliedSettings.agents.reviewWhere && !phone) {
			appliedSettings = await settings.save({
				...appliedSettings,
				agents: { ...appliedSettings.agents, reviewWhere: where },
			});
			publishAppearance();
		}
		const branch = quick
			? ''
			: mode === 'review'
				? await pullRequests.freeBranch(
						key.projectId,
						key.id,
						ref.scopeId,
						`pr-${pr.number}-review`
					)
				: own
					? await pullRequests.freeBranch(key.projectId, key.id, ref.scopeId, pr.head)
					: await pullRequests.freeBranch(key.projectId, key.id, ref.scopeId, `${pr.head}-fixes`);
		// Only this PR's repo: the PR ref exists only there; the other repos are not needed in the task's worktree.
		const discovered = await discoverScopes((await store.project(key.projectId)).path),
			canonical = await pullRequests.canonicalId(key.projectId, key.id, ref.scopeId),
			repoScope = discovered.find((scope) => scope.id === canonical),
			launch = quick
				? { ...defaults, isolation: 'in-place' as const }
				: {
						...defaults,
						isolation: 'worktree' as const,
						baseRef: `refs/brigadir-v2/pr/${pr.number}`,
						branch,
						scopes: discovered
							.filter((scope) => scope.id === canonical)
							.map((scope) => ({
								id: scope.id,
								name: scope.name,
								kind: scope.kind,
								selected: true,
							})),
					};
		const repo = !repoScope || repoScope.name === '.' ? '.' : repoScope.name,
			prRef = `refs/brigadir-v2/pr/${pr.number}`;
		const prompt = quick
			? `Review pull request #${pr.number} "${pr.title}" (${pr.head} → ${pr.base}) without checking it out: the working tree stays on the person's branch, so its files are not the PR. The PR head is fetched as ${prRef} in the repo ${repo}; its merge base with ${pr.base} is ${trees.base}. Read the change with \`git -C ${repo} diff ${trees.base} ${prRef}\`, a file with \`git -C ${repo} show ${prRef}:<path>\`, search with \`git -C ${repo} grep <pattern> ${prRef}\`. Read the existing review threads. Leave each finding as a draft comment on its lines with the pr_comment tool; the person sends the review. Do not change code or switch branches.`
			: mode === 'review'
				? `Review pull request #${pr.number} "${pr.title}" (${pr.head} → ${pr.base}). Read the changed files and the existing review threads. Leave each finding as a draft comment on its lines with the pr_comment tool; the person sends the review. Do not change code.`
				: own
					? fixPrompt
					: `${fixPrompt}\nYou cannot push to ${pr.head}: the work goes to the branch ${branch}, and its pull request targets ${pr.head}.`;
		const title =
			`${t(locale, mode === 'review' ? 'Review' : 'Fixes')} #${pr.number} · ${pr.title}`.slice(
				0,
				80
			);
		const action: TaskAction =
			mode === 'fix' ? 'agentFix' : suggestions ? 'reviewSuggestions' : 'review';
		// spec/pull-requests-and-ci#review-crew: a crew reviews instead of one agent — the one-time crew, else the action's remembered one. Its foreman is the
		// task's agent; the task keeps the crew as a snapshot (spec/crew-templates-and-editor#snapshot). A remembered crew that is gone from the library runs one agent.
		const crewId =
			mode === 'review'
				? actionCrewId(action, agent, crewChoice, appliedSettings.actionCrews)
				: null;
		let crew: CrewSpec | null = null;
		if (crewId) {
			const library = await (await TemplateStore.at(process.env.BRIGADIR_DATA_DIR)).read();
			try {
				crew = resolveReviewCrew(library, crewId, appliedSettings.agents.provider);
			} catch (error) {
				if (crewChoice) throw error;
			}
		}
		const { provider, launchOptions } = crew
			? { provider: crew.root.provider, launchOptions: [] }
			: await taskAgent(action, mode === 'review' ? agent : null);
		const taskPrompt = crew
			? reviewCrewPrompt({ pr, quick, repo, mergeBase: trees.base, crew })
			: prompt;
		const task = await store.createTask(
			key.projectId,
			taskPrompt,
			provider,
			'gui',
			t(locale, 'New task'),
			'queued',
			launch
		);
		const named = await store.updateTask(task, {
			...(launchOptions.length ? { launchOptions } : {}),
			title,
			prReview: {
				scopeId: await pullRequests.canonicalId(key.projectId, key.id, ref.scopeId),
				number: pr.number,
				mode,
				base: mode === 'fix' && !own ? pr.head : pr.base,
			},
			...(mode === 'review' ? { readOnlyAgent: true } : {}),
			...(crew ? { crew } : {}),
		});
		void launches.request(named).catch(() => {});
		return {
			task: named,
			created: true,
			prompt: taskPrompt,
			count: drafts.length,
			threads: threads.length,
		};
	}
	/**
	 * spec/pull-requests-and-ci#resolve-conflicts: «Resolve conflict» from the «Merge» card. Fresh base and head from GitHub; a task already on the
	 * PR branch in a worktree merges base into itself, otherwise a new «Conflict #N» task in a worktree on the PR branch under the same name
	 * (push updates the PR). The merge is the same spec/git#merge: the conflict stays in the tree, the person or the agent resolves it,
	 * commit and push stay with the person.
	 */
	handle('prs:resolve-conflicts', async (key, ref, how) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			detail = await pullRequests.detail(key.projectId, key.id, ref.scopeId, ref.number, true),
			pr = detail.summary,
			locale = currentLocale();
		if (!detail.canPush) throw new Error('You cannot push to the PR branch.');
		if (detail.crossRepository)
			throw new Error('The PR branch is in a fork: resolve the conflict on GitHub.');
		const branches = await pullRequests.fetchBranches(
				key.projectId,
				key.id,
				ref.scopeId,
				pr.number
			),
			canonical = await pullRequests.canonicalId(key.projectId, key.id, ref.scopeId);
		const tasks = (
			await readWorkspace(
				process.env.BRIGADIR_DATA_DIR ? { dataDir: process.env.BRIGADIR_DATA_DIR } : {}
			)
		).tasks.filter(
			(task) =>
				task.projectId === key.projectId &&
				!task.archived &&
				task.launch?.isolation === 'worktree' &&
				task.worktreeBranch === pr.head
		);
		let owner: AgentTask | null = null,
			scopeId = '';
		for (const task of tasks) {
			const scope = await pullRequests.taskScope(key.projectId, task.id, canonical);
			if (scope) {
				owner = task;
				scopeId = scope.id;
				break;
			}
		}
		let task = owner,
			created = false;
		if (!task) {
			await pullRequests.claimBranch(key.projectId, key.id, ref.scopeId, pr.head);
			const defaults = await launchSettings.resolve(key.projectId, undefined),
				discovered = await discoverScopes((await store.project(key.projectId)).path);
			const launch = {
				...defaults,
				isolation: 'worktree' as const,
				baseRef: branches.head,
				branch: pr.head,
				scopes: discovered
					.filter((scope) => scope.id === canonical)
					.map((scope) => ({ id: scope.id, name: scope.name, kind: scope.kind, selected: true })),
			};
			// spec/appearance#evolution-redesign: the conflict task takes the agent of «Resolve conflicts» in Customize per action.
			const agent = await taskAgent('conflicts');
			const fresh = await store.createTask(
				key.projectId,
				'',
				agent.provider,
				'gui',
				t(locale, 'New task'),
				'queued',
				launch
			);
			task = await store.updateTask(fresh, {
				...(agent.launchOptions.length ? { launchOptions: agent.launchOptions } : {}),
				title: `${t(locale, 'Conflict')} #${pr.number} · ${pr.title}`.slice(0, 80),
				prReview: { scopeId: canonical, number: pr.number, mode: 'conflicts', base: pr.base },
			});
			created = true;
			await preparations.prepare(task);
			const scope = await pullRequests.taskScope(key.projectId, task.id, canonical);
			if (!scope) throw new Error('Repo is unavailable');
			scopeId = scope.id;
		}
		// A merge already in progress in that task is the same work: its strip opens again, nothing merges twice.
		const outcome = (await gitHistory.state(task, scopeId))
			? { status: 'conflicts' as const }
			: await gitHistory.merge(task, scopeId, pr.head, branches.base);
		let prompt: string | null = null;
		if (outcome.status === 'conflicts' && how === 'agent')
			prompt = `${await gitHistory.agentPrompt(task, scopeId)}\nThis resolves the conflicts of pull request #${pr.number} "${pr.title}" with ${pr.base}; the person finishes the merge and pushes.`;
		if (created) {
			if (prompt) task = await store.updateTask(task, { prompt });
			prompt = null;
			void launches.request(task).catch(() => {});
		}
		return { task: await store.task(task), created, scopeId, status: outcome.status, prompt };
	});
	handle('prs:list', (projectId, taskId, fresh) => pullRequests.list(projectId, taskId, fresh));
	handle('prs:detail', (projectId, taskId, ref, fresh) =>
		pullRequests.detail(projectId, taskId, ref.scopeId, ref.number, fresh)
	);
	handle('prs:ci-runs', (projectId, taskId, scopeId, query, fresh) =>
		pullRequests.ciRuns(projectId, taskId, scopeId, query, fresh)
	);
	handle('prs:ci-run', (projectId, taskId, scopeId, runId, fresh) =>
		pullRequests.ciRun(projectId, taskId, scopeId, runId, fresh)
	);
	handle('prs:ci-watch', (watch, on) => ciWatches.toggle(watch, on));
	handle('prs:ci-watches', () => ciWatches.list());
	// spec/remote-access-and-mobile#client-ui-seam: the address is the machine's (its tasks and repos), the browser is the one the person sits at.
	handleClient('prs:open', async (client, projectId, taskId, scopeId, number) => {
		const url = client.forward
			? await client.forward('prs:url', [projectId, taskId, scopeId, number])
			: await pullRequests.url(projectId, taskId, scopeId, number);
		if (!isWebURL(url)) throw new Error('Invalid pull request address');
		await shell.openExternal(url);
	});
	handle('prs:url', (projectId, taskId, scopeId, number) =>
		pullRequests.url(projectId, taskId, scopeId, number)
	);
	// spec/chat#web-links: http(s) and mailto from Markdown (chat, plan, preview); the address is normalized again here.
	// spec/pull-requests-and-ci#pr-links: the address is a GitHub PR page; main finds the repo among the task's own and reads the PR.
	handle('prs:resolve-link', (projectId, taskId, url) =>
		pullRequests.resolveLink(projectId, taskId, url)
	);
	handle('links:open', async (url) => {
		await shell.openExternal(externalLink(url)!);
	});
	handleClient('prs:link', async (client, projectId, taskId, scopeId, url) => {
		const link = client.forward
			? await client.forward('prs:link-url', [projectId, taskId, scopeId, url])
			: await pullRequests.link(projectId, taskId, scopeId, url);
		if (!isWebURL(link)) throw new Error('Invalid link');
		await shell.openExternal(link);
	});
	handle('prs:link-url', (projectId, taskId, scopeId, url) =>
		pullRequests.link(projectId, taskId, scopeId, url)
	);
	handleClient('forge:open', async (client, key, id) => {
		const url = client.forward
			? await client.forward('forge:url', [key, id])
			: await forge.url(key, id);
		if (!isWebURL(url)) throw new Error('Invalid pull request address');
		await shell.openExternal(url);
	});
	handle('forge:url', (key, id) => forge.url(key, id));
	handle('forge:branch', (key, id, branch) => forge.branch(key, id, branch));
	handle('commits:read', (key) => commits.read(key));
	handle('commits:run', (key, revision, message) => commits.run(key, revision, message));
	handle('commits:generate', (key, revision, run?: HelperRun | null) =>
		commits.generate(key, revision, run)
	);
	// spec/git#commit-dialog: the commit dialog — baskets in order (progress to every window), a basket's message, the agent's split.
	handle('commits:baskets', (key, revision, plan) =>
		commits.baskets(key, revision, plan, (progress) =>
			clients.broadcast('commits:progress', progress)
		)
	);
	handle('commits:generate-basket', (key, revision, scopeId, paths, run?: HelperRun | null) =>
		commits.generateBasket(key, revision, scopeId, paths, run)
	);
	handle('commits:split', (key, revision, run?: HelperRun | null) =>
		commits.split(key, revision, run)
	);
	handle('commits:split-stop', (key) => commits.stopSplit(key));
	handle('commits:file', (key, revision, id) => commits.file(key, revision, id));
	handle('commits:editor', (key, revision, id) => commits.editor(key, revision, id));
	// spec/git#merge: the History mode of the changes panel — read only.
	handle('git:scopes', (key) => gitHistory.scopes(key));
	handle('git:branches', (key, scopeId) => gitHistory.branches(key, scopeId));
	// spec/editor#line-author: an optional file path narrows the page; the limit grows by pages of 100. spec/git#history-search: a query searches the whole history.
	handle(
		'git:history',
		(key, scopeId, branch, path?: string | null, limit?: number, query?: string | null) =>
			gitHistory.history(key, scopeId, branch, path ?? undefined, limit, query ?? undefined)
	);
	handle('files:blame', (key, id, text) => editorBlames.read(key, id, text));
	handle('files:blame-message', (key, id, sha) => editorBlames.message(key, id, sha));
	handle('git:commit', (key, scopeId, sha) => gitHistory.commit(key, scopeId, sha));
	handle('git:commit-file', (key, scopeId, sha, id) => gitHistory.file(key, scopeId, sha, id));
	// spec/git#merge: merge and conflicts; only a repo of the task is written to.
	handle('git:merge-preview', (key, scopeId, into, from) =>
		gitHistory.preview(key, scopeId, into, from)
	);
	handle('git:merge', (key, scopeId, into, from) => gitHistory.merge(key, scopeId, into, from));
	handle('git:merge-state', (key, scopeId) => gitHistory.state(key, scopeId));
	handle('git:conflict-take', (key, scopeId, path, take) =>
		gitHistory.take(key, scopeId, path, take)
	);
	handle('git:conflict-resolved', (key, scopeId, path) => gitHistory.resolved(key, scopeId, path));
	handle('git:merge-finish', (key, scopeId) => gitHistory.finish(key, scopeId));
	handle('git:merge-abort', (key, scopeId) => gitHistory.abort(key, scopeId));
	handle('git:merge-agent', (key, scopeId, paths) => gitHistory.askAgent(key, scopeId, paths));
	// spec/appearance#evolution-redesign: the Conflicts dialog and the merge in three columns.
	handle('git:merge-agent-stop', (key, scopeId) => gitHistory.stopAgent(key, scopeId));
	handle('git:merge-states', (key) => gitHistory.states(key));
	handle('git:conflict-texts', (key, scopeId, path) => gitHistory.texts(key, scopeId, path));
	handle('git:conflict-apply', (key, scopeId, path, text) =>
		gitHistory.apply(key, scopeId, path, text)
	);
	handle('git:conflict-reopen', (key, scopeId, path) => gitHistory.reopen(key, scopeId, path));
	handle('relay:prepare', (key) => relays.prepare(key));
	handle('relay:summary', (id) => relays.summarize(id));
	handle('relay:summary-stop', (id) => relays.stopSummary(id));
	handle('relay:discard', (id) => relays.discard(id));
	handle('relay:create', (input) => relays.create(input, t(currentLocale(), 'New task')));
	handle('proposal:create', (key, id) => taskProposals.create(key, id));
	handle('proposal:draft', (key, id, owner) => taskProposals.draft(key, id, owner));
	handle('proposal:adopt', (key, id, created) => taskProposals.adopt(key, id, created));
	handle('proposal:decline', (key, id) => taskProposals.decline(key, id));
	handle('scopes:read', (projectId, taskId) => scopeControls.read(projectId, taskId));
	handle('scopes:update', (projectId, taskId, update) =>
		scopeControls.update(projectId, taskId, update)
	);
	handle('scopes:collapse', (projectId, collapsed) =>
		launchSettings.collapse(projectId, collapsed)
	);
	handle('launch:settings', (projectId) => launchSettings.read(projectId));
	// spec/tasks#sheet-model, spec/tasks#backlog-edit: the sheet's model choice takes the backlog card's path — launchOptions applied by setOption at start.
	// spec/agents-and-providers#catalog: effort is checked against the options of the chosen model, not of the probe's default one.
	async function sheetOptions(
		provider: 'claude' | 'codex',
		choices: { id: string; value: string }[]
	) {
		const catalog = await providerCatalog(provider),
			modelId = catalog?.options.find((item) => agentOptionKind(item) === 'model')?.id,
			available = catalogOptions(catalog, choices.find((choice) => choice.id === modelId)?.value);
		const known = choices.filter((choice) => {
			const option = available.find((item) => item.id === choice.id);
			return (
				option?.kind === 'select' && option.choices.some((item) => item.value === choice.value)
			);
		});
		if (!known.length) return null;
		const options = available.map((option) => {
			const choice = known.find((item) => item.id === option.id);
			return choice && option.kind === 'select' ? { ...option, value: choice.value } : option;
		});
		const named = (kind: 'model' | 'effort') => {
			const option = options.find(
				(item) => agentOptionKind(item) === kind && known.some((choice) => choice.id === item.id)
			);
			return option?.kind === 'select'
				? option.choices.find((item) => item.value === option.value)?.name
				: undefined;
		};
		const model = named('model'),
			effort = named('effort');
		return {
			agentOptions: options,
			launchOptions: known,
			...(model ? { modelName: model } : {}),
			...(effort ? { effortName: effort } : {}),
		};
	}
	/** `task:create`, and a schedule's run (spec/notifications-slack-notes-and-schedules#schedules): the sheet's arguments make the same task either way. */
	async function createSheetTask(
		projectId: string,
		title: string,
		provider: 'claude' | 'codex',
		transport: 'gui' | 'terminal',
		backlog: boolean,
		input: TaskLaunch | undefined,
		crewInput?: CrewLaunch,
		sheet?: TaskSheet,
		/** A schedule's run does not become the project's last sheet choice. */ remember = true
	) {
		const launch = await launchSettings.resolve(projectId, input),
			store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
		// spec/crew-templates-and-editor#snapshot: the crew resolves into an immutable snapshot at creation; the task never reads the library again.
		let crew;
		if (crewInput) {
			const library = await (await TemplateStore.at(process.env.BRIGADIR_DATA_DIR)).read(),
				lookup = templateLookup(library.agents);
			const template =
				'compose' in crewInput
					? (crewInput.template ?? {
							schemaVersion: 1 as const,
							id: composeCrewId,
							name: 'Crew',
							builtin: true,
							root: { id: 'root', name: 'Foreman', template: foremanTemplateId },
						})
					: 'templateId' in crewInput
						? library.crews.find((item) => item.id === crewInput.templateId)
						: crewInput.template;
			if (!template) throw new Error('The crew template is unavailable');
			const issues = crewIssues(template, lookup);
			if (issues.length) throw new Error(issues[0]!.message);
			const context = { lookup, defaultProvider: appliedSettings.agents.provider };
			crew = resolveCrew(template, context);
			// spec/crew#compose: the foreman composes from a snapshot of the library and of the enabled providers' models; the task never reads the library again.
			if ('compose' in crewInput) {
				const enabled = (['claude', 'codex'] as const).filter(
						(item) => appliedSettings.agents.enabled[item]
					),
					catalogs = (
						await Promise.all(
							enabled.map((item) =>
								Promise.race([
									providerCatalog(item).catch(() => null),
									new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000).unref()),
								])
							)
						)
					).flatMap((catalog, index) =>
						catalog ? [catalog] : [{ provider: enabled[index]!, options: [], modes: [] }]
					);
				const palette = crewPalette(library.agents, context, catalogs);
				crew = {
					...crew,
					templateId: composeCrewId,
					compose: {
						...palette,
						templates: palette.templates.filter((item) => enabled.includes(item.provider)),
					},
				};
			}
		}
		if (remember) await launchSettings.save(projectId, launch, crew?.templateId ?? undefined);
		const task = await store.createTask(
			projectId,
			title,
			crew ? crew.root.provider : provider,
			transport,
			t(currentLocale(), 'New task'),
			backlog ? 'backlog' : 'queued',
			launch
		);
		let chosen = sheet?.name
			? await store.updateTask(task, { title: sheet.name.trim().slice(0, 80) })
			: task;
		const choices = sheet?.options;
		if (choices?.length && !crew) {
			const patch = await sheetOptions(provider, choices);
			if (patch) chosen = await store.updateTask(chosen, patch);
		}
		// spec/tasks#backlog-edit: the sheet's draft attachments move into the task before it can start.
		if (sheet?.draftId && sheet.attachments?.length)
			chosen = await store.updateTask(chosen, {
				attachments: await new Attachments(store).adopt(
					{ projectId, id: sheet.draftId },
					task,
					sheet.attachments
				),
			});
		else if (sheet?.draftId) await new Attachments(store).discard({ projectId, id: sheet.draftId });
		return crew ? store.updateTask(chosen, { crew }) : chosen;
	}
	handle('task:create', (projectId, title, provider, transport, backlog, input, crew, sheet) =>
		createSheetTask(projectId, title, provider, transport, backlog, input, crew, sheet)
	);
	// spec/notifications-slack-notes-and-schedules#schedules: scheduled tasks — one timer in main; every run is a task from the schedule's blank.
	const schedulesStore = await SchedulesStore.at(process.env.BRIGADIR_DATA_DIR);
	const runWhen = (schedule: Schedule, due: number) =>
		new Intl.DateTimeFormat(currentLocale() === 'uk' ? 'uk' : 'en-GB', {
			timeZone: schedule.timeZone,
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).format(due);
	const scheduler = new Scheduler({
		store: schedulesStore,
		tasks: async () => (await taskDiffs.decorate(await sessions.workspace())).tasks,
		createRun: async (schedule, due, quiet) => {
			const { prompt, provider, transport, launch, crew, options } = schedule.task,
				title = `${schedule.name} · ${runWhen(schedule, due)}`.slice(0, 80);
			const task = await createSheetTask(
				schedule.projectId,
				prompt,
				provider,
				transport,
				false,
				launch,
				crew,
				{ name: title, ...(options?.length ? { options } : {}) },
				false
			);
			const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR);
			return store.updateTask(task, {
				scheduleRun: { scheduleId: schedule.id, due: new Date(due).toISOString(), quiet },
			});
		},
		start: (key) => launches.request(key),
		markLoud: async (task) =>
			task.scheduleRun &&
			(await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).updateTask(task, {
				scheduleRun: { ...task.scheduleRun, quiet: false },
			}),
		complete: (task) => boards.move(task, 'completed'),
		notify: (notice) => {
			const locale = currentLocale();
			switch (notice.kind) {
				case 'started':
					void noticeLog
						.addTask({
							kind: 'info',
							task: notice.task,
							title: notice.task.title,
							body: t(locale, 'Started a run'),
							read: notice.schedule.inTasks === 'needs-you',
						})
						.catch(() => {});
					break;
				case 'finished':
					void noticeLog
						.addTask({
							kind: 'success',
							task: notice.task,
							title: notice.task.title,
							body: t(locale, 'Run finished without changes'),
							read: false,
						})
						.catch(() => {});
					break;
				case 'start-failed':
					if (appliedSettings.modules.slack)
						void SessionStore.at(process.env.BRIGADIR_DATA_DIR)
							.then((store) => store.project(notice.schedule.projectId))
							.then((project) =>
								slack.post(
									{
										kind: 'scheduleFailed',
										schedule: notice.schedule.name,
										project: project.name,
										reason: notice.error || 'The run could not start.',
									},
									project.id
								)
							)
							.catch(() => {});
					void noticeLog
						.addPlain({
							kind: 'error',
							title: notice.schedule.name,
							body: `${t(locale, 'The scheduled run could not start.')} ${notice.error}`.trim(),
						})
						.catch(() => {});
					break;
				case 'missed':
					// spec/notifications-slack-notes-and-schedules#slack: the «Ask» waits for Run now · Skip in Slack too, under the Needs you event.
					if (notice.asked && appliedSettings.modules.slack)
						void SessionStore.at(process.env.BRIGADIR_DATA_DIR)
							.then((store) => store.project(notice.schedule.projectId))
							.then((project) =>
								slack.post(
									{
										kind: 'scheduleAsk',
										projectId: project.id,
										scheduleId: notice.schedule.id,
										schedule: notice.schedule.name,
										project: project.name,
										count: notice.count,
									},
									project.id
								)
							)
							.catch(() => {});
					void noticeLog
						.addPlain({
							kind: 'warning',
							title: notice.schedule.name,
							body: notice.asked
								? `${missedRunsText(locale, notice.count)} · ${t(locale, 'Waiting for your answer: run once or skip.')}`
								: missedRunsText(locale, notice.count),
						})
						.catch(() => {});
					break;
			}
		},
		changed: () => {
			clients.broadcast('schedules:changed', null);
			void refreshSchedulePending();
		},
		enabled: () => appliedSettings.modules.schedules,
	});
	async function refreshSchedulePending() {
		const list = appliedSettings.modules.schedules ? await scheduler.list().catch(() => []) : [];
		const locale = currentLocale();
		schedulePending = list.flatMap((item) =>
			item.pendingMissed
				? [
						{
							id: `schedule:${item.projectId}/${item.id}`,
							at: Date.parse(item.pendingMissed.latest),
							kind: 'schedule' as const,
							task: { projectId: item.projectId, id: item.id },
							title: item.name,
							body: missedRunsText(locale, item.pendingMissed.count),
							allow: 'run',
							deny: 'skip',
							schedule: true as const,
						},
					]
				: []
		);
		noticeLog.pendingChanged();
	}
	scheduleAnswer = (id, option) => {
		const [projectId, scheduleId] = id.slice('schedule:'.length).split('/');
		if (projectId && scheduleId)
			void scheduler
				.resolveMissed(projectId, scheduleId, option === 'allow' ? 'run' : 'skip')
				.catch(() => {});
	};
	slackScheduleAnswer = async (projectId, id, option) => {
		let schedule;
		try {
			schedule = await schedulesStore.read(projectId, id);
		} catch {
			return 'gone';
		}
		if (!schedule.pendingMissed) return 'already';
		await scheduler.resolveMissed(projectId, id, option);
		return 'answered';
	};
	void refreshSchedulePending();
	handle('schedules:list', () => scheduler.list());
	handle('schedules:runs', (projectId: string, id: string) => scheduler.runs(projectId, id));
	handle('schedules:create', (projectId: string, draft: ScheduleDraft) =>
		scheduler.save(newSchedule(draft, projectId, newScheduleId(), Date.now()))
	);
	handle('schedules:edit', async (projectId: string, id: string, draft: ScheduleDraft) =>
		scheduler.save(editedSchedule(await schedulesStore.read(projectId, id), draft, Date.now()))
	);
	handle('schedules:delete', (projectId: string, id: string) => scheduler.remove(projectId, id));
	handle('schedules:pause', async (projectId: string, id: string, paused: boolean) => {
		await scheduler.setPaused(projectId, id, paused);
	});
	handle('schedules:run-now', (projectId: string, id: string) => scheduler.runNow(projectId, id));
	handle(
		'schedules:resolve-missed',
		async (projectId: string, id: string, answer: 'run' | 'skip') => {
			await scheduler.resolveMissed(projectId, id, answer);
		}
	);
	scheduler.start();
	taskProposals.scheduleWith((projectId, draft) =>
		scheduler.save(newSchedule(draft, projectId, newScheduleId(), Date.now()))
	);
	app.on('will-quit', () => scheduler.stop());
	// spec/notifications-slack-notes-and-schedules#schedules: a wake or an unlock is the moment missed slots are noticed.
	powerMonitor.on('resume', () => void scheduler.kick());
	powerMonitor.on('unlock-screen', () => void scheduler.kick());
	scheduleEvents = (key) => scheduler.taskEvent(key);
	scheduleSettings = () => {
		if (appliedSettings.modules.schedules) void scheduler.kick();
	};
	registerRead('templates:read', async () =>
		(await TemplateStore.at(process.env.BRIGADIR_DATA_DIR)).read()
	);
	// spec/crew-templates-and-editor#template-library library actions. Built-ins are never written; import validates the document before it touches the library.
	handle('templates:save-agent', async (template) => {
		const store = await TemplateStore.at(process.env.BRIGADIR_DATA_DIR);
		await store.saveAgent(template);
		return store.read();
	});
	handle('templates:save-crew', async (template) => {
		const store = await TemplateStore.at(process.env.BRIGADIR_DATA_DIR);
		await store.saveCrew(template);
		return store.read();
	});
	handle('templates:delete', async (kind, id) => {
		const store = await TemplateStore.at(process.env.BRIGADIR_DATA_DIR);
		if (kind === 'agent') await store.deleteAgent(id);
		else await store.deleteCrew(id);
		return store.read();
	});
	handle('templates:restore-crews', async () => {
		const store = await TemplateStore.at(process.env.BRIGADIR_DATA_DIR);
		await store.restoreCrews();
		return store.read();
	});
	handleClient('templates:export', async (client, kind, id) => {
		const library = await (await TemplateStore.at(process.env.BRIGADIR_DATA_DIR)).read();
		const template =
			kind === 'agent'
				? library.agents.find((item) => item.id === id)
				: library.crews.find((item) => item.id === id);
		if (!template) throw new Error('The template is unavailable');
		// spec/remote-access-and-mobile#client-ui-seam: a device saves the file on its own disk.
		return ui.save(client, {
			name: `${template.name.replace(/[\/:\\]/g, '-').slice(0, 200)}.json`,
			extensions: ['json'],
			filterName: 'JSON',
			text: `${JSON.stringify({ schemaVersion: 1, template }, null, 2)}\n`,
		});
	});
	handleClient('templates:import', async (client) => {
		const path = await ui.pick(client, {
			target: 'file',
			title: fromMachine('Import a template from {machine}'),
			extensions: ['json'],
			filterName: 'JSON',
		});
		if (!path) return null;
		const text = await readFileNode(path, 'utf8');
		if (text.length > 2_000_000) throw new Error('The file is too large');
		const doc: unknown = JSON.parse(text);
		const store = await TemplateStore.at(process.env.BRIGADIR_DATA_DIR);
		if (isAgentTemplateDocument(doc)) await store.saveAgent({ ...doc.template, builtin: false });
		else if (isCrewTemplateDocument(doc)) await store.saveCrew({ ...doc.template, builtin: false });
		else throw new Error('The file is not a Brigadir template');
		return store.read();
	});
	/** One source for the model lists on the sheet, the crew and the backlog card (spec/tasks#sheet-model). */
	const probed = new Map<'claude' | 'codex', Promise<ProviderCatalog | null>>(),
		settled = new Map<'claude' | 'codex', ProviderCatalog>();
	const askProvider = (provider: 'claude' | 'codex') =>
		probed.get(provider) ??
		(() => {
			const promise = (async (): Promise<ProviderCatalog | null> => {
				const cwd = await mkdtemp(join(tmpdir(), 'brigadir-catalog-'));
				try {
					const probe = await probeAgentCatalog({
						provider,
						cwd,
						...(process.env.BRIGADIR_TEST_AGENT
							? { adapter: { command: process.execPath, args: [process.env.BRIGADIR_TEST_AGENT] } }
							: {}),
					});
					return probe
						? { provider, options: probe.options, modes: probe.modes, byModel: probe.byModel }
						: null;
				} finally {
					await rm(cwd, { recursive: true, force: true }).catch(() => {});
				}
			})();
			// A failed probe is remembered for five minutes: signing in or installing the CLI must not
			// need a restart, and a missing CLI must not spawn a process on every sheet.
			const forget = () => setTimeout(() => probed.delete(provider), 5 * 60_000).unref();
			promise.then((value) => {
				if (value) settled.set(provider, value);
				else forget();
			}, forget);
			probed.set(provider, promise);
			return promise;
		})();
	const catalogFromTasks = async (
		provider: 'claude' | 'codex'
	): Promise<ProviderCatalog | null> => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			tasks = (await readWorkspace({ dataDir: store.root })).tasks
				.filter(
					(task) =>
						task.provider === provider && task.transport !== 'terminal' && task.agentOptions?.length
				)
				.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
		for (const task of tasks) {
			const session = await lastSessionStart(store, task).catch(() => null);
			return { provider, options: task.agentOptions ?? [], modes: session?.modes ?? [] };
		}
		return null;
	};
	// spec/agents-and-providers#catalog: the probe knows every model's options; a task's catalog knows only its own model, so it is the fallback.
	const providerCatalog = async (provider: 'claude' | 'codex'): Promise<ProviderCatalog | null> =>
		(await askProvider(provider)) ?? (await catalogFromTasks(provider));
	handle('templates:catalog', (provider) => providerCatalog(provider));
	providerCatalogs = providerCatalog;
	knownCatalog = (provider) => settled.get(provider);
	forgetCatalogs = () => {
		probed.clear();
		settled.clear();
	};
	// spec/composer-steering-queue-and-ghost#ghost-headless: the hint model's provider (chosen or default) warms its catalog once, so the first hint does not wait for the probe.
	const helperProbe = helperCatalogProvider(
		appliedSettings.helperAgent,
		appliedSettings.agents.enabled
	);
	if (appliedSettings.suggestNextPrompt && helperProbe)
		void providerCatalog(helperProbe).catch(() => {});
	handle('files:syntax', (key, id, text) => files.syntax(key, id, text));
	handle('review:editor-read', async (key, id, version) => {
		const context = await files
			.commentContext(key, id, version)
			.catch((error: unknown) =>
				error instanceof Error && error.message === outsideTaskRepos ? ('outside' as const) : null
			);
		return context === 'outside' ? context : context ? reviews.readEditor(key, context) : null;
	});
	handle('review:editor-add', async (key, input) =>
		reviews.addEditor(key, input, await files.commentContext(key, input.fileId, input.version))
	);
	handle('files:list', (key, id, showIgnored) => files.list(key, id, showIgnored));
	handle('files:links', (key, texts) => files.links(key, texts));
	// The window that asked: this machine's own or a window of another machine (spec/remote-access-and-mobile#client-ui-seam).
	handleClient('window:reload', (client) => {
		const target = client.window?.();
		if (target && !target.isDestroyed()) target.webContents.reload();
	});
	// spec/architecture-and-platform#window-frame: ☰ opens the app menu under itself; the strip's colours follow the theme and the accent.
	handleClient('window:app-menu', (client, x?: number, y?: number) => popupAppMenu(x, y, client));
	handleClient('window:chrome-colors', (client, colors) => {
		const target = client.window?.();
		if (chrome === 'darwin' || !target || target.isDestroyed()) return;
		target.setBackgroundColor(colors.color);
		if (process.platform !== 'darwin') target.setTitleBarOverlay(colors);
	});
	handle('renderer:error', (report) => {
		rendererLog.report(report);
	});
	handle('clipboard:write-text', (text) => clipboard.writeText(text));
	handle('syntax:code', (language, text) =>
		changes.syntax.read(syntaxFencePath(language), text, 'code')
	);
	handle('composer:read', (key) => composer.read(key));
	handle('composer:save', (key, text) => composer.save(key, text));
	handle('files:read', (key, id) => files.read(key, id));
	handle('files:create', (key, path) => files.create(key, path));
	handle('plans:open', (key, requestId, text) => files.plan(key, requestId, text));
	handle('plans:text', (key, requestId, text) => files.planText(key, requestId, text));
	handle('files:check', (key, id, version) => files.check(key, id, version));
	handle('files:diff', (key, id) => files.fromDiff(key, id));
	// spec/remote-access-and-mobile#client-ui-seam: the system browser and DevTools of this machine never open for a device.
	handleClient('browser:command', (client, key, command) => {
		if (client.device && (command.kind === 'external' || command.kind === 'inspect'))
			throw new Error('Not available from a remote device.');
		return browsers.command(key, command);
	});
	// spec/remote-access-and-mobile#browser-from-device: a device's window streams the page; its dialogs and file choices ask that device.
	const screenOwner = (client: Client): ScreenOwner => ({
		id: client.id,
		send: (event, droppable) => client.send('browser:screen', event, droppable),
		ask: (request) => ui.page(client, request),
		files: (request) => ui.files(client, request),
		cancel: () => ui.cancelPages(client),
	});
	handleClient('browser:screen', (client, key, command) => {
		if (!client.device) throw new Error('This window shows the page itself.');
		return browsers.screen(screenOwner(client), key, command);
	});
	handleClient('browser:file', (client, id, name, bytes) => ui.pageFile(client, id, name, bytes));
	handleClient('simulator:command', (client, projectId, command) => {
		if (!appliedSettings.modules.simulator) throw new Error(moduleOffMessages.simulator);
		if (client.device && command.kind === 'devtools')
			throw new Error('Not available from a remote device.');
		// spec/remote-access-and-mobile#browser-from-device: a device pastes its own clipboard; this Mac's is never read for it.
		if (client.device && command.kind === 'paste' && command.text === undefined)
			throw new Error('Not available from a remote device.');
		if (client.device && command.kind === 'watch') {
			const watches = simulatorWatches.get(client.id) ?? new Map<string, number>();
			simulatorWatches.set(client.id, watches);
			watches.set(projectId, Math.max(0, (watches.get(projectId) ?? 0) + (command.on ? 1 : -1)));
		}
		return simulators.command(projectId, command);
	});
	// A command run names its line and folder only through `commands:run`, which reads them from project.json (spec/search-menus-and-commands#project-commands).
	// spec/remote-access-and-mobile#phone-task-tools: watchers count by client — one client's `unwatch` does not stop the output another still shows.
	handleClient('terminal:command', (client, key: TaskKey, command: TerminalCommand) =>
		terminalWatchers.command(`${key.projectId}/${key.id}`, command, client.id, () =>
			sessions.terminal(key, command)
		)
	);
	handle('commands:runs', (key) => sessions.commandRuns(key));
	handle('commands:run', (key, ref) =>
		runProjectCommand(
			process.env.BRIGADIR_DATA_DIR,
			(task, command) => sessions.terminal(task, command),
			key,
			ref
		)
	);
	handle('commands:scripts', async (projectId) =>
		readProjectScripts(
			(await (await SessionStore.at(process.env.BRIGADIR_DATA_DIR)).project(projectId)).path
		)
	);
	handle('commands:save', (projectId, commands) =>
		saveProjectCommands(process.env.BRIGADIR_DATA_DIR, projectId, commands)
	);
	handleClient('commands:menu', (client, state) => sidebarMenus.command(state, client));
	handle('files:gutter', (key, id, text) => files.gutter(key, id, text));
	handle('files:compare', (key, id, text) => files.compare(key, id, text));
	handle('search:text', (key, request, id) => {
		void textSearches.start(key, request, id);
	});
	handle('search:peek', (key, id) => files.peek(key, id));
	handle('search:text-cancel', (id) => {
		textSearches.cancel(id);
	});
	handle('search:text-repos', (key) => textSearches.repos(key));
	// spec/search-menus-and-commands#search-tabs: Actions of Search Everywhere run a menu item as its click would, without bringing the window forward.
	// The window whose Search Everywhere ran it, not every window of this device (spec/remote-access-and-mobile#client-ui-seam).
	handleClient('menu:run', (client, id) => {
		const command = menuCommands.find((item) => item.id === id)!,
			module = commandModule(id);
		if (module && !appliedSettings.modules[module] && !client.forward)
			throw new Error(moduleOffMessages[module]);
		const action = command.action === 'quick-open-alias' ? 'quick-open' : command.action;
		client.send(command.channel === 'editor' ? 'editor:action' : 'workspace:action', action);
	});
	handle('files:search', (key, query, showIgnored, folders = false) =>
		files.search(key, query, showIgnored, folders)
	);
	handle('files:save', (key, id, version, text, afterTurn) =>
		files.save(key, id, version, text, afterTurn)
	);
	handleClient('files:dirty', async (client, key, id, dirty) => {
		await files.markDirty(key, id, dirty);
		// spec/remote-access-and-mobile#browser-from-device: whose buffer it is — a device's window closing asks only about its own.
		if (dirty) dirtyOwners.set(id, client.id);
		else dirtyOwners.delete(id);
	});
	handle('files:release', (key, id) => files.release(key, id));
	handle('code:open', (key, id, text) => codeIntel.openCode(key, id, text));
	handle('code:change', (key, id, version, changes) =>
		codeIntel.changeCode(key, id, version, changes)
	);
	handle('code:close', (key, id) => codeIntel.closeCode(key, id));
	handle('code:complete', (key, id, version, offset, trigger) =>
		codeIntel.complete(key, id, version, offset, trigger)
	);
	handle('code:resolve', (key, id, version, list, item) =>
		codeIntel.resolve(key, id, version, list, item)
	);
	handle('code:hover', (key, id, version, offset) => codeIntel.hover(key, id, version, offset));
	handle('code:signature', (key, id, version, offset, trigger) =>
		codeIntel.signature(key, id, version, offset, trigger)
	);
	handle('code:definition', (key, id, version, offset) =>
		codeIntel.definition(key, id, version, offset)
	);
	handle('code:references', (key, id, version, offset) =>
		codeIntel.references(key, id, version, offset)
	);
	// spec/editor-code-intelligence#format-on-save: formatting reads the synced mirror; the renderer sends a version, never text or paths.
	handle('code:format', (key, id, version, reason) => codeIntel.format(key, id, version, reason));
	handle('code:format-info', (key, id) => codeIntel.formatInfo(key, id));
	handle('code:indent-info', (key, id) => codeIntel.indentInfo(key, id));
	handle('code:restart', (key) => codeIntel.restart(key));
	registerRead('formatters:read', () =>
		readFormatters(process.env.BRIGADIR_DATA_DIR, (root) => codeIntel.projectIndentAt(root))
	);
	handle('formatters:set', (projectId, formatter) =>
		setProjectFormatter(process.env.BRIGADIR_DATA_DIR, projectId, formatter, (root) =>
			codeIntel.projectIndentAt(root)
		)
	);
	handle('review:positions', (key, id) => reviews.positions(key, id));
	handle('review:read', (key, fileId) => reviews.read(key, fileId));
	handle('review:note', (key, text) => reviews.addNote(key, text));
	handle('review:add', (key, input) => reviews.add(key, input));
	handle('review:edit', (key, id, text) => reviews.edit(key, id, text));
	handle('review:file', async (key, id) => files.fromAnchor(key, await reviews.anchor(key, id)));
	handle('review:resolve', (key, id, resolved) => reviews.resolve(key, id, resolved));
	handle('review:remove-selection', async (key, selection) => {
		await reviews.removeSelection(key, selection);
		return true;
	});
	handle('review:remove', (key, id) => reviews.remove(key, id));
	handle('review:prepare', (key) => reviews.prepare(key));
	handle('session:background-output', (key, id) => sessions.backgroundOutput(key, id));
	handleClient('changes:revert', async (client, key, fileId) => {
		const file = await files.canRevert(key, fileId);
		const locale = currentLocale();
		const result = await ui.ask(client, {
			type: 'warning',
			message: `${t(locale, 'Revert file changes…')} ${file.path}`,
			detail: t(
				locale,
				changes.view(key) === 'head'
					? 'Restore the file to the last commit. Changes made before the task are lost too.'
					: 'Restore the file to the base of the displayed diff.'
			),
			buttons: [t(locale, 'Cancel'), t(locale, 'Revert')],
			defaultId: 0,
			cancelId: 0,
			danger: 1,
		});
		if (result !== 1) return false;
		await files.canRevert(key, fileId);
		await files.revert(key, fileId);
		return true;
	});
	handle('activity:tool-diff', (key, seq, index) => activityDetails.tool(key, seq, index));
	handle('activity:tool-change', (key, seq, index) =>
		activityDetails.currentToolChange(key, seq, index)
	);
	handleClient('activity:turn-menu', async (client, key, seq) => {
		const turn = await activityDetails.turn(key, seq),
			canCopy = await activityDetails.canCopyTurn(key, seq),
			locale = currentLocale();
		return ui.menu(client, [
			{
				id: 'copy',
				label: t(locale, 'Copy response'),
				icon: turnMenuIcons.copy,
				enabled: canCopy,
			},
			{
				id: 'changes',
				label: t(locale, 'Show changes'),
				icon: turnMenuIcons.changes,
				enabled: turn.range !== null,
			},
		]);
	});
	handle('activity:turn-changes', (key, seq) => activityDetails.turn(key, seq));
	handle('changes:attribution', (key, id, range) =>
		changes.attribution(key, id, range ?? undefined)
	);
	handle('files:attach', (key, id) => files.attach(key, id));
	handle('files:terminal', (key, id) => files.terminalHere(key, id));
	handleClient('files:menu', async (client, key, id, source) => {
		const entry = source === 'tree' ? await files.treeLocation(key, id) : null;
		const path = entry?.absolute ?? (await files.location(key, id, source));
		const locale = currentLocale();
		return ui.menu(client, [
			...(entry?.kind === 'directory'
				? []
				: [{ id: 'open', label: t(locale, 'Open in editor'), icon: fileMenuIcons['open'] }]),
			...(entry
				? [
						// spec/editor#new-file: a new file in this folder, or in the folder of this file.
						{ id: 'new-file', label: t(locale, 'New file…'), icon: fileMenuIcons['new-file'] },
						null,
						{ id: 'attach', label: t(locale, 'To composer'), icon: fileMenuIcons['attach'] },
						{
							id: 'terminal',
							label: t(locale, 'Open terminal here'),
							icon: fileMenuIcons['terminal'],
						},
						{
							id: 'copy',
							label: t(locale, 'Copy relative path'),
							icon: fileMenuIcons['copy'],
							copy: entry.path,
						},
					]
				: []),
			...(source === 'changes'
				? [
						{ id: 'why', label: t(locale, 'Why did this change?'), icon: fileMenuIcons['why'] },
						{
							id: 'revert',
							label: t(locale, 'Revert file changes…'),
							icon: fileMenuIcons['revert'],
						},
					]
				: []),
			null,
			{
				id: 'copy-absolute',
				label: t(locale, 'Copy absolute path'),
				icon: fileMenuIcons['copy-absolute'],
				copy: path,
			},
			{
				id: 'finder',
				label: t(locale, 'Reveal in Finder'),
				icon: fileMenuIcons['finder'],
				reveal: path,
			},
		]);
	});
	handleClient('chat:menu', (client, state) =>
		ui.menu(client, chatMenuTemplate(currentLocale(), state))
	);
	handleClient('terminal:menu', (client, state) =>
		ui.menu(client, terminalMenuTemplate(currentLocale(), state, appliedSettings.keymap))
	);
	handle('clipboard:read-text', async () => (await clipboard.readText()).slice(0, 1_000_000));
	// spec/editor#tab-menu: a file tab finds its file like the editor menu, a local diff tab like the Changes menu; a missing file only disables the path items.
	handleClient('documents:tab-menu', async (client, key: TaskKey, state: DocumentTabMenuState) => {
		const file = state.file
			? await (
					state.file.source === 'editor'
						? files.editorLocation(key, state.file.id)
						: files.changesLocation(key, state.file.id)
				).catch(() => null)
			: null;
		return ui.menu(
			client,
			documentTabMenuTemplate(currentLocale(), file, state, appliedSettings.keymap),
			state.at ?? null
		);
	});
	handle('menu:icons', (icons: MenuIconImages) => {
		setMenuIcons(icons);
		rebuildMenu?.();
		void refreshRecent();
	});
	handleClient('editor:menu', async (client, key: TaskKey, id: string, state: EditorMenuState) =>
		ui.menu(
			client,
			editorMenuTemplate(
				currentLocale(),
				await files.editorLocation(key, id),
				state,
				appliedSettings.keymap
			),
			state.at ?? null
		)
	);
	handle('changes:timeline', (key) => changes.timeline(key));
	handle('changes:range', (key, range) => changes.selectRange(key, range));
	handle('changes:read', (key) => changes.read(key));
	handle('changes:file', (key, fileId) => changes.file(key, fileId));
	handle('changes:syntax', (key, fileId) => changes.fileSyntax(key, fileId));
	handle('session:read', async (key, afterSeq?: number) => ({
		...(await sessions.read(key, afterSeq)),
		...(launches.isQueued(key) ? { queued: true } : {}),
	}));
	handle('session:activity', (key) => sessions.activity(key));
	// spec/tasks#quick-tasks: no agent starts in the main tree — «To agent» there creates a quick task.
	handle('session:start', (key) => launches.request(key));
	handle('main-tree:branch', (projectId, scopeId, branch) =>
		mainTrees.branch(projectId, scopeId, branch)
	);
	handle('main-tree:switch', (projectId, scopeId, branch) =>
		mainTrees.switch(projectId, scopeId, branch)
	);
	// spec/git#main-tree-branches: the main tree's branch and git tools; every writing action checks the lock of a task without isolation in main.
	handle('main-tree:switch-state', (projectId, scopeId, fetch?: boolean) =>
		mainTrees.read(projectId, scopeId, fetch === true)
	);
	handle('main-tree:switch-to', (projectId, scopeId, request) =>
		mainTrees.switchTo(projectId, scopeId, request)
	);
	handle('main-tree:create-branch', (projectId, scopeId, request) =>
		mainTrees.create(projectId, scopeId, request)
	);
	handle('main-tree:stashes', (projectId, scopeId) => mainTrees.stashes(projectId, scopeId));
	handle('main-tree:stash', (projectId, scopeId) => mainTrees.stash(projectId, scopeId));
	handle('main-tree:stash-restore', (projectId, scopeId, sha) =>
		mainTrees.restore(projectId, scopeId, sha)
	);
	handle('main-tree:stash-drop', (projectId, scopeId, sha) =>
		mainTrees.drop(projectId, scopeId, sha)
	);
	handle('main-tree:pull', (projectId, scopeId, taskId?: string | null) =>
		mainTrees.pull(projectId, scopeId, taskId ?? null)
	);
	handle('main-tree:undo-commit', (projectId, scopeId) => mainTrees.undoCommit(projectId, scopeId));
	handle('main-tree:discard', (projectId, scopeId, paths) =>
		mainTrees.discard(projectId, scopeId, paths)
	);
	handle('main-tree:open', async (projectId) => {
		const store = await SessionStore.at(process.env.BRIGADIR_DATA_DIR),
			task = await store.ensureMainTree(projectId);
		await files.refresh(task);
		return task;
	});
	handle('session:command', async (key, command) => {
		if (command.kind === 'cancel' && (await preparations.cancel(key))) return;
		if (command.kind === 'checkpoint') return files.refresh(key);
		return sessions.command(key, command);
	});
	handle('environment:check', () => environment.check());
	handle('cli-updates:read', () => cliUpdates.status());
	handle('cli-updates:check', () => cliUpdates.checkNow());
	// spec/architecture-and-platform#auto-update: Settings ▸ Language ▸ Updates and the update toasts.
	handle('app-update:read', () => appUpdates.status());
	handle('app-update:check', () => appUpdates.check(true));
	handle('app-update:download', async () => {
		const state = appUpdates.status();
		// A build that cannot install opens the release page; the person installs the package.
		if (state.support === 'notify' && state.releaseUrl) {
			await shell.openExternal(state.releaseUrl);
			return state;
		}
		return appUpdates.download();
	});
	handle('app-update:install', () => appUpdates.install());
	handle('app-update:cancel-restart', () => appUpdates.cancelRestart());
	handle('keep-awake:read', () => keepAwake.status());
	// spec/remote-access-and-mobile#browser-from-device: a sign-in started from a device opens its page there; the CLI opens no browser here.
	handleClient('environment:sign-in', (client, provider) => {
		if (client.device) signInRelays.set(provider, { deviceId: client.device.id, count: 0 });
		else signInRelays.delete(provider);
		return agentLogin.start(provider, { quiet: !!client.device });
	});
	// spec/remote-access-and-mobile#networking: the device's browser comes back to its loopback; this machine passes it to its own — only to the
	// port of the waiting sign-in's `redirect_uri`, only for the device that started it, a few requests at most.
	handleClient('agent-login:relay', async (client, provider, request) => {
		const relay = signInRelays.get(provider),
			state = agentLogin.state(provider),
			redirect = state.phase === 'waiting' && state.url ? loopbackRedirect(state.url) : null;
		if (!client.device || !relay || relay.deviceId !== client.device.id || !redirect)
			throw new Error('No sign-in of this device is waiting.');
		if (++relay.count > agentRelayLimits.requests)
			throw new Error('Too many requests for this sign-in.');
		return relayToLoopback(redirect, request);
	});
	// The device's side: a window of another machine opens the page here, with a listener for its way back.
	handleClient('agent-login:open', (client, provider, url) =>
		remoteAccess.openSignIn(client, provider, url)
	);
	handle('agent-login:read', (provider) => agentLogin.state(provider));
	handle('agent-login:code', (provider, code) => agentLogin.submitCode(provider, code));
	handle('agent-login:cancel', (provider) => agentLogin.cancel(provider));
	handleClient('agent-login:reopen', (client, provider) => {
		if (client.device) throw new Error('Not available from a remote device.');
		return agentLogin.reopen(provider);
	});
	handle('keymap:recording', async (recording) => {
		if (shortcutRecording === recording) return;
		shortcutRecording = recording;
		rebuildMenu?.();
	});
	// spec/remote-access-and-mobile#client-ui-seam: each window says its own context; the menu bar reads the one in front.
	handleClient('menu:context', (client, context) => {
		if (!client.local) {
			machineMenuContexts.set(client.id, context);
			syncMenuFocus();
			return;
		}
		menuReady = true;
		menuContext = context;
		syncMenuFocus();
		flushWindowAction();
	});
	// spec/remote-access-and-mobile#client-ui-seam: a device's answers and the folder browser of its open choice.
	handleClient('remote:ui-answer', (client, id, answer) => ui.answer(client, id, answer));
	handleClient('remote:fs-list', async (client, id, path, hidden) => {
		const pick = ui.openPick(client, id);
		if (!pick) throw new Error('The folder choice is closed.');
		return listFolder(pick, path, hidden);
	});
	handleClient('remote:fs-mkdir', async (client, id, parent, name) => {
		const pick = ui.openPick(client, id);
		if (!pick || pick.target !== 'folder') throw new Error('The folder choice is closed.');
		return createFolder(parent, name);
	});
	handleClient('remote:notice-act', (client, id, action) => {
		routedNotices.act(client, id, action);
	});
	function buildMenu() {
		const locale = currentLocale();
		// A shortcut the keymap leaves as it was keeps the menu's own spelling; only a changed one is shown normalized.
		const menuAccelerator = (command: (typeof menuCommands)[number]) => {
			const key = commandAccelerator(command, appliedSettings.keymap);
			return key && command.accelerator && normalizeAccelerator(command.accelerator) === key
				? command.accelerator
				: key;
		};
		// spec/settings-modules-and-onboarding#modules: a module switched off has no menu items, so its shortcuts are free.
		const moduleOn = (id: string) => {
			const module = commandModule(id);
			return !module || appliedSettings.modules[module];
		};
		const commands = (group: MessageKey) =>
			menuCommands
				.filter((command) => command.group === group && moduleOn(command.id))
				.map((command) => ({
					id: command.id,
					label: command.label === 'Search Everywhere…' ? command.label : t(locale, command.label),
					...menuIcon(menuCommandIcons[command.id]),
					...(command.id === 'markdown-preview'
						? { type: 'checkbox' as const, checked: menuContext.markdownPreview }
						: layoutChecks[command.id]
							? { type: 'checkbox' as const, checked: menuContext[layoutChecks[command.id]!] }
							: {}),
					...((key) => (key && !shortcutRecording ? { accelerator: key } : {}))(
						menuAccelerator(command)
					),
					enabled: false,
					click: () => {
						const focus = menuFocus();
						if (
							!(focus.ready || (!window && !focus.machine && command.when === 'always')) ||
							(focus.machine && machineScreenCommands.has(command.id)) ||
							!menuCommandEnabled(command, focus.context, !focus.machine && browsers.isFocused())
						)
							return;
						const action = command.action === 'quick-open-alias' ? 'quick-open' : command.action;
						if (command.channel === 'editor')
							(remoteAccess.focusedClient() ?? localClient).send('editor:action', action);
						else dispatchWindowAction('workspace:action', action);
					},
				}));
		/**
		 * spec/search-menus-and-commands#menu-structure (spec/task-window-workspace#two-columns): two columns show Panel ⌘3 with the panel's state as its glyph, then Reset column
		 * widths — as the toolbar's `Layout ▾`. Chat, Work area and Show all stay hidden there: ⌘1 / ⌘2 still act (spec/task-window-workspace#two-columns),
		 * and Electron keeps a hidden item's key on macOS (`acceleratorWorksWhenHidden`) and on Windows and Linux.
		 */
		const layoutItems = (
			items: ReturnType<typeof commands>
		): Electron.MenuItemConstructorOptions[] => {
			const two = appliedSettings.taskColumns === 'two';
			menuPanelGlyph = two ? menuFocus().context.layoutPanel : null;
			if (!two) return [...items.slice(0, 3), { type: 'separator' as const }, ...items.slice(3)];
			const panel = items.find((item) => item.id === 'layout-panel'),
				rest = items.filter((item) => item.id !== 'layout-panel' && item.id !== 'layout-reset');
			return [
				...(panel
					? [
							{
								...panel,
								...menuIcon(appMenuIcons[menuPanelGlyph ? 'layout-two-panel' : 'layout-two']),
							},
						]
					: []),
				{ type: 'separator' as const },
				...items.filter((item) => item.id === 'layout-reset'),
				...rest.map((item) => ({ ...item, visible: false, acceleratorWorksWhenHidden: true })),
			];
		};
		const nativeEdit = Menu.buildFromTemplate([{ role: 'editMenu' }]).items[0]!.submenu!;
		const editItems = (menu: Menu): Electron.MenuItemConstructorOptions[] =>
			menu.items.map((item) => {
				const role = item.role?.toLowerCase();
				if (role === 'undo' || role === 'redo')
					return {
						id: `history-${role}`,
						label: t(locale, role === 'undo' ? 'Undo' : 'Redo'),
						...menuIcon(roleMenuIcons[role]),
						accelerator: role === 'undo' ? 'CmdOrCtrl+Z' : 'CmdOrCtrl+Shift+Z',
						click: () => {
							const focus = menuFocus();
							if (
								focus.context.editor &&
								!focus.context.modal &&
								!(!focus.machine && browsers.isFocused())
							)
								(remoteAccess.focusedClient() ?? localClient).send('editor:action', role);
							else {
								const target = webContents.getFocusedWebContents();
								if (role === 'undo') target?.undo();
								else target?.redo();
							}
						},
					};
				// spec/search-menus-and-commands#menu-glyphs: the role's glyph; Substitutions and Speech are titles without a role, named by their first item.
				const icon = role
					? roleMenuIcons[role as keyof typeof roleMenuIcons]
					: item.submenu?.items.some((child) => child.role?.toLowerCase() === 'showsubstitutions')
						? appMenuIcons.substitutions
						: item.submenu?.items.some((child) => child.role?.toLowerCase() === 'startspeaking')
							? appMenuIcons.speech
							: undefined;
				return {
					label: item.label,
					type: item.type,
					...(item.type === 'separator' ? {} : menuIcon(icon)),
					...(item.role ? { role: item.role } : {}),
					...(item.accelerator ? { accelerator: item.accelerator } : {}),
					...(item.submenu ? { submenu: editItems(item.submenu) } : {}),
				};
			});
		const about: Electron.MenuItemConstructorOptions = {
			role: 'about',
			label: t(locale, 'About Brigadir'),
			...menuIcon(appMenuIcons.about),
		};
		const settingsItems: Electron.MenuItemConstructorOptions[] = [
			{
				id: 'settings',
				label: t(locale, 'Settings…'),
				...menuIcon(appMenuIcons.settings),
				accelerator: 'CmdOrCtrl+,',
				click: () => {
					if (!menuFocus().context.modal) dispatchWindowAction('workspace:action', 'settings');
				},
			},
			{
				id: 'settings-templates',
				label: t(locale, 'Templates…'),
				...menuIcon(appMenuIcons['settings-templates']),
				click: () => {
					if (!menuFocus().context.modal)
						dispatchWindowAction('workspace:action', 'settings-templates');
				},
			},
		];
		// spec/architecture-and-platform#auto-update: the app menu on macOS, Help on Windows and Linux; a build that never checks shows it disabled.
		const updatesItem: Electron.MenuItemConstructorOptions = {
			id: 'check-updates',
			label: t(locale, 'Check for Updates…'),
			...menuIcon(appMenuIcons['check-updates']),
			enabled: appUpdates.status().support !== 'off',
			click: () => {
				void appUpdates.check(true);
			},
		};
		const introItem: Electron.MenuItemConstructorOptions = {
			id: 'intro',
			label: t(locale, 'Show the intro again…'),
			...menuIcon(appMenuIcons.intro),
			click: () => {
				if (!menuFocus().context.modal) dispatchWindowAction('workspace:action', 'intro');
			},
		};
		const fileItems: Electron.MenuItemConstructorOptions[] = [
			commands('File')[0]!,
			{
				id: 'open-recent',
				label: t(locale, 'Open Recent'),
				...menuIcon(appMenuIcons['open-recent']),
				submenu: recentTemplate,
			},
			...commands('File').slice(1),
		];
		// spec/architecture-and-platform#window-frame: Windows and Linux have no app-named menu: Settings and Exit end File, the intro and About go to Help.
		const pc = chrome !== 'darwin';
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				...(pc
					? []
					: [
							{
								label: t(locale, 'Brigadir'),
								submenu: [
									about,
									updatesItem,
									{ type: 'separator' },
									...settingsItems,
									introItem,
									{ type: 'separator' },
									{
										role: 'services',
										label: t(locale, 'Services'),
										...menuIcon(appMenuIcons.services),
									},
									{ type: 'separator' },
									{
										role: 'hide',
										label: t(locale, 'Hide Brigadir'),
										...menuIcon(appMenuIcons.hide),
									},
									{
										role: 'hideOthers',
										label: t(locale, 'Hide Others'),
										...menuIcon(appMenuIcons['hide-others']),
									},
									{
										role: 'unhide',
										label: t(locale, 'Show All'),
										...menuIcon(appMenuIcons['show-all']),
									},
									{ type: 'separator' },
									{
										role: 'quit',
										label: t(locale, 'Quit Brigadir'),
										...menuIcon(appMenuIcons.quit),
									},
								],
							} as Electron.MenuItemConstructorOptions,
						]),
				{
					label: t(locale, 'File'),
					submenu: pc
						? [
								...fileItems,
								{ type: 'separator' },
								...settingsItems,
								{ type: 'separator' },
								{
									id: 'quit',
									role: 'quit',
									label: t(locale, 'Exit Brigadir'),
									...menuIcon(appMenuIcons.quit),
									accelerator: 'Ctrl+Q',
								},
							]
						: fileItems,
				},
				{
					label: t(locale, 'Edit'),
					submenu: [
						...editItems(nativeEdit),
						{ type: 'separator' },
						{
							label: t(locale, 'Formatting'),
							...menuIcon(appMenuIcons.formatting),
							submenu: commands('Formatting'),
						},
					],
				},
				...(['Editor', 'Navigate', 'Diff', 'Browser', 'Simulator', 'Console'] as const)
					.filter(
						(group) =>
							(group !== 'Browser' && group !== 'Simulator') ||
							appliedSettings.modules[group === 'Browser' ? 'browser' : 'simulator']
					)
					.map((group) => ({
						label: t(locale, group),
						submenu:
							group === 'Editor'
								? [
										...withGroupSeparators<Electron.MenuItemConstructorOptions>(commands(group)),
										{ type: 'separator' as const },
										lineAuthorItem(locale),
									]
								: commands(group),
					})),
				// spec/editor#editor-groups: the editor groups' items are a submenu right under Toggle the editor, as Formatting is in Edit.
				{
					label: t(locale, 'View'),
					submenu: [
						// spec/task-window-workspace#layout-switch: Layout and the editor groups are submenus right under Toggle sidebar.
						...withGroupSeparators(commands('View')).flatMap((item) =>
							!('id' in item)
								? [item]
								: item.id === 'sidebar-toggle'
									? [
											item,
											{
												label: t(locale, 'Layout'),
												...menuIcon(appMenuIcons.layout),
												submenu: [
													// spec/task-window-workspace#two-columns: the way the window is laid out first, then the switches of that layout.
													...taskColumnsItems(locale),
													{ type: 'separator' as const },
													...layoutItems(commands('Layout')),
												],
											},
											{
												label: t(locale, 'Editor groups'),
												...menuIcon(appMenuIcons['editor-groups']),
												submenu: commands('Editor groups'),
											},
										]
									: [item]
						),
						// spec/search-menus-and-commands#menu-structure: the windows (Workspace, Kit) are a group of their own.
						{ type: 'separator' as const },
						{
							id: 'workspace-route',
							label: t(locale, 'Workspace'),
							...menuIcon(appMenuIcons['workspace-route']),
							accelerator: 'CmdOrCtrl+Shift+1',
							click: () => {
								if (!menuFocus().context.modal)
									dispatchWindowAction('navigation:route', 'workspace');
							},
						},
						{
							id: 'kit-route',
							label: t(locale, 'Kit'),
							...menuIcon(appMenuIcons['kit-route']),
							accelerator: 'CmdOrCtrl+Shift+2',
							click: () => {
								if (!menuFocus().context.modal) dispatchWindowAction('navigation:route', 'kit');
							},
						},
						{ type: 'separator' },
						{
							role: 'toggleDevTools',
							accelerator: 'CmdOrCtrl+Alt+Shift+I',
							...menuIcon(roleMenuIcons.toggledevtools),
						},
						{ role: 'togglefullscreen', ...menuIcon(roleMenuIcons.togglefullscreen) },
					],
				},
				// spec/search-menus-and-commands#menu-glyphs: Electron's own Window items, spelled out so each carries its glyph; macOS still adds its window list and tiling.
				{
					role: 'windowMenu',
					submenu: pc
						? [
								{ role: 'minimize', ...menuIcon(roleMenuIcons.minimize) },
								// spec/search-menus-and-commands#menu-structure: Ctrl+W is File ▸ Close tab. The `close` role would bring its default Ctrl+W back, so
								// Close is an item of its own with no key; the window closes the system's way (Alt+F4).
								{
									id: 'window-close',
									label: t(locale, 'Close'),
									...menuIcon(roleMenuIcons.close),
									click: () => BrowserWindow.getFocusedWindow()?.close(),
								},
							]
						: [
								{ role: 'minimize', ...menuIcon(roleMenuIcons.minimize) },
								{ role: 'zoom', ...menuIcon(roleMenuIcons.zoom) },
								{ type: 'separator' },
								{ role: 'front', ...menuIcon(roleMenuIcons.front) },
							],
				},
				...(pc
					? [
							{
								id: 'help',
								label: t(locale, 'Help'),
								submenu: [introItem, { type: 'separator' }, updatesItem, about],
							} as Electron.MenuItemConstructorOptions,
						]
					: []),
			])
		);
		const roleLabels: Record<string, MessageKey> = {
			editmenu: 'Edit',
			undo: 'Undo',
			redo: 'Redo',
			cut: 'Cut',
			copy: 'Copy',
			paste: 'Paste',
			pasteandmatchstyle: 'Paste and match style',
			delete: 'Delete',
			selectall: 'Select all',
			windowmenu: 'Window',
			minimize: 'Minimize',
			zoom: 'Zoom',
			close: 'Close',
			front: 'Bring all to front',
			togglefullscreen: 'Toggle full screen',
			toggledevtools: 'Developer tools',
			showsubstitutions: 'Show Substitutions',
			togglesmartquotes: 'Smart Quotes',
			togglesmartdashes: 'Smart Dashes',
			toggletextreplacement: 'Text Replacement',
			startspeaking: 'Start Speaking',
			stopspeaking: 'Stop Speaking',
		};
		function translateRoles(menu: Menu) {
			for (const item of menu.items) {
				const label = roleLabels[item.role?.toLowerCase() ?? ''];
				if (label) item.label = t(locale, label);
				if (item.submenu) {
					if (item.submenu.items.some((child) => child.role?.toLowerCase() === 'showsubstitutions'))
						item.label = t(locale, 'Substitutions');
					if (item.submenu.items.some((child) => child.role?.toLowerCase() === 'startspeaking'))
						item.label = t(locale, 'Speech');
					translateRoles(item.submenu);
				}
			}
		}
		translateRoles(Menu.getApplicationMenu()!);
		syncMenuFocus();
	}
	rebuildMenu = buildMenu;
	buildMenu();
	await refreshRecent();
	// Sessions run the adapter npx installed; once per start, well after the window, fetch its latest version so
	// updates land with the next start. Tests use their own data dir and adapters and skip this network step.
	// spec/agents-and-providers#quota-sources: one complete read per provider soon after start; later reads follow turns and the popover.
	void quota.loadView();
	if (process.env.BRIGADIR_TEST_QUOTA) quota.pin(testQuota(process.env.BRIGADIR_TEST_QUOTA));
	else if (!process.env.BRIGADIR_DATA_DIR) {
		setTimeout(() => {
			void quota.refreshAll();
		}, 5_000).unref();
		quota.background(() =>
			Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())
		);
	}
	if (!process.env.BRIGADIR_DATA_DIR) {
		setTimeout(() => {
			void refreshAdapters();
		}, 60_000).unref();
		cliUpdates.start();
	}
	void setUpAppUpdates();
	keepAwake.start();
	taskArchives.start();
	nativeTheme.on('updated', publishAppearance);
	systemPreferences.on('accent-color-changed', publishAppearance);
	const accentSubscription =
		process.platform === 'darwin'
			? systemPreferences.subscribeNotification(
					'AppleColorPreferencesChangedNotification',
					publishAppearance
				)
			: undefined;
	app.once('will-quit', () => {
		if (restartRequested)
			app.relaunch({
				// spec/architecture-and-platform#linux-package: an AppImage's own path, not the mount it unmounts on quit.
				...(process.platform === 'linux' && (updateRelaunchPath?.() ?? process.env.APPIMAGE)
					? { execPath: (updateRelaunchPath?.() ?? process.env.APPIMAGE)! }
					: {}),
				args: [
					...process.argv.slice(1).filter((arg) => arg !== '--brigadir-interactive'),
					'--brigadir-interactive',
				],
			});
		sessions.disconnect();
		nativeTheme.removeListener('updated', publishAppearance);
		systemPreferences.removeListener('accent-color-changed', publishAppearance);
		if (accentSubscription !== undefined)
			systemPreferences.unsubscribeNotification(accentSubscription);
	});
	savedWindow = await layout.readWindow();
	createWindow();
	app.on('activate', () => {
		if (!window) createWindow();
	});
	if (process.platform === 'darwin')
		app.on('did-become-active', () => {
			void notificationPermission.refresh();
		});
});
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
	quitRequested = true;
	quitGuard.begin();
	ghosts.cancelAll();
	slackSessions.closeAll();
	quickAsks.closeAll();
	launchLocks.cancel();
	relays.cancelAll();
	commits.cancelAll();
	forge.cancelAll();
	knowledge.cancelAll();
	if (quitGuard.busy(quitWaits).length) {
		event.preventDefault();
		if (!quitSettling) {
			quitSettling = true;
			void quitGuard.settle('quit', quitWaits).then(() => {
				quitSettling = false;
				app.quit();
			});
		}
	}
});

app.on('will-quit', () => {
	void remoteAccess.close();
	taskArchives.stop();
	agentLogin.stopAll();
	cliUpdates.stop();
	appUpdates.stop();
	keepAwake.stop();
	simulators.close();
	fonts.stop();
	launches.stop();
	quota.close();
	void codeIntel.dispose();
});
