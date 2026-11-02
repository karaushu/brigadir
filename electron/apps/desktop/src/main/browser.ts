import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserNetwork } from './browser-network';
import {
	BaseWindow,
	BrowserWindow,
	WebContentsView,
	screen,
	session,
	shell,
	type Rectangle,
	type WebContents,
} from 'electron';
import { SessionStore, readDocument, atomicJson, safePath } from '@brigadir/persistence';
import { BrowserModes } from './browser-modes';
import {
	isRecord,
	browserClipboardMax,
	browserClipboardReply,
	browserDialogReply,
	browserNotificationsReply,
	browserEvictions,
	browserNoteText,
	browserQuietMaxMs,
	browserQuietMs,
	defaultSurfaceLayout,
	type BrowserPageNote,
	type TaskKey,
	type BrowserAgentState,
	type BrowserAgentStep,
	type BrowserCommand,
	type BrowserEvent,
	type BrowserLog,
	type BrowserState,
	type BrowserNotificationPermission,
	type BrowserTabInfo,
	acceptExtensions,
	browserCursor,
	browserScreenMetrics,
	isBrowserPicker,
	isPersonGesture,
	macEditCommands,
	macKey,
	macMouseModifiers,
	type BrowserScreenCommand,
	type BrowserScreenEvent,
	type BrowserScreenFormat,
} from '@brigadir/core';
import { browserUrl, localBrowserUrl } from '@brigadir/host/client';
import { readPage, describeNode } from './browser-scripts';
import { browserAct, browserUi, type RingColors } from './browser-agent';
import { cdpColor, type CdpColor } from './cdp-color';
import {
	pageAgentScript,
	pageApi,
	pageBinding,
	pageDialogPath,
	type PageAgentState,
} from './browser-page';
import { ScreenPacer } from './browser-stream';
import type { FilesRequest, PageAnswer, PageReply, PageRequest } from './client-ui';
import { BrowserAgentClock } from './browser-clock';
import {
	BrowserNotificationSites,
	pageNotice,
	pageNoticeGapMs,
	type PageNotice,
} from './browser-notifications';
import { PersonInput } from './browser-yield';
/** spec/task-window-workspace#work-area: a task has as many browser tabs as it needs; each is its own view, named by the task and the tab. */
const taskName = (key: TaskKey) => `${key.projectId}/${key.id}`;
const name = (key: TaskKey, tab: string) => `${taskName(key)}#${tab}`;
const freshTab = () => `b${randomUUID().replace(/-/g, '').slice(0, 8)}`;
/** What the bar over the agent's page names (spec/task-window-workspace#work-area); quick reads (state, console, network) are not steps. */
function agentStep(command: BrowserCommand): BrowserAgentStep | null {
	if (command.kind === 'act')
		return {
			kind: command.action,
			target:
				command.action === 'key'
					? (command.key ?? null)
					: command.action === 'notifications'
						? (command.permission ?? null)
						: (command.label ??
							command.selector ??
							command.ref ??
							(command.x !== undefined && command.y !== undefined
								? `${Math.round(command.x)},${Math.round(command.y)}`
								: null)),
		};
	if (command.kind === 'open') return { kind: 'open', target: command.url };
	if (command.kind === 'ui' || command.kind === 'read' || command.kind === 'screenshot')
		return { kind: command.kind, target: null };
	return null;
}
const domainFiles = { open: 'browser-domains.json', act: 'browser-act-domains.json' } as const;
/** What an agent reads from the page console: the newest 100 entries within 32 KiB of text, oldest first. */
function recentLogs(logs: BrowserLog[]) {
	const kept: BrowserLog[] = [];
	let bytes = 0;
	for (let index = logs.length - 1; index >= 0 && kept.length < 100; index--) {
		bytes += logs[index]!.text.length;
		if (bytes > 32 * 1024 && kept.length) break;
		kept.push(logs[index]!);
	}
	return kept.reverse();
}
type Entry = {
	nodes: Map<string, number>;
	highlights: Map<string, number>;
	network: BrowserNetwork;
	key: TaskKey;
	tab: string;
	/** spec/task-window-workspace#work-area: the agent on this page; `null` until it acts here. */ agent: BrowserAgentState | null;
	/** The tab's last published info, so the strip hears only changes. */ info: string;
	view: WebContentsView;
	web: WebContents;
	mobile: boolean;
	picking: boolean;
	logs: BrowserLog[];
	error: string | null;
	counter: number;
	timer: ReturnType<typeof setTimeout> | null;
	agentDomains: Set<string> | null;
	/** spec/browser-and-simulator#background: the invisible window that holds the view while the agent uses it off screen. */
	park: BaseWindow | null;
	/** Frozen and off every window; the next agent call thaws it. */
	frozen: boolean;
	/** An agent call runs on the page now: the page uses the task clipboard, input is not the person's. */
	acting: boolean;
	/** The agent has used this page: from now on the person's own input is worth a sentence. */
	agentSeen: boolean;
	/** What the page did since the agent's last reply (spec/browser-and-simulator#background). */
	notes: BrowserPageNote[];
	touched: boolean;
	nextDialog: { accept: boolean; text?: string } | null;
	pageSignature: string;
	pageScript: string | null;
	pageSync: Promise<void>;
	intercepting: boolean;
	/** The last network event: after a thaw the action waits for 500 ms of quiet. */
	netAt: number;
	/** A view the cache closed reopens its address (spec/browser-and-simulator#background). */
	reopening: Promise<unknown> | null;
	/** spec/remote-access-and-mobile#browser-from-device: the person's last navigation from the strip, for «Leave» after `beforeunload`. */
	lastNav: { command: BrowserCommand; at: number } | null;
	/** The dialog requests of the page script: not the page's own network. */
	hiddenRequests: Set<string>;
	/** Folders of files a device gave the page's file inputs; removed with the tab. */
	fileDirs: string[];
	/** CDP `Fetch` intercepts the page dialogs' requests now. */
	fetching: boolean;
	/**
	 * The tab's secret for the page script's state: only main can switch the dialogs, the
	 * clipboard and the pickers; the page cannot hand its native ones back.
	 */
	pageToken: string;
	/** The page script's state now, for frames that attach later; null before the first sync. */
	pageState: PageAgentState | null;
	/**
	 * Cross-site frames (out-of-process iframes) by their CDP session: the page script, the file chooser and the dialog
	 * requests go to each of them as to the page, or a frame's `alert` would open Electron's own window (`runModal` for a
	 * view without a visible window) on this machine. `script` — its registered script; `applied` — what it has.
	 */
	frames: Map<string, { script: string | null; applied: FrameState | null }>;
	/** The person ticked «Don't show more dialogs from this page»; until the next navigation they answer themselves. */
	dialogsMuted: boolean;
	/** When the tab's last page dialog closed: one soon after it offers the tick. */
	dialogClosedAt: number;
	/** spec/browser-and-simulator#notifications: the page waits for the person's answer on notifications; `×` mutes its asks until navigation. */
	notificationAsk: boolean;
	notificationsMuted: boolean;
	/** spec/browser-and-simulator#notifications: when the tab last showed a notification. */
	noticeAt: number;
};
/** As in Chrome: a page dialog this soon after the tab's previous one offers «Don't show more dialogs…». */
const pageDialogRepeatMs = 10_000;
/** What a cross-site frame has of the page's state: its script's state, the file chooser, the dialog path. */
type FrameState = { script: string; intercept: boolean; fetching: string | null };
/** spec/remote-access-and-mobile#browser-from-device: every cross-site frame of a tab is held at its start until the page script is in it. */
const frameAutoAttach = {
	autoAttach: true,
	waitForDebuggerOnStart: true,
	flatten: true,
	filter: [{ type: 'iframe', exclude: false }],
};
/**
 * spec/remote-access-and-mobile#browser-from-device: who streams a tab — a device's connection. Frames and the cursor go to it alone; a page's dialogs and
 * file choices ask it.
 */
export type ScreenOwner = {
	readonly id: string;
	send(event: BrowserScreenEvent, droppable?: boolean): boolean;
	ask(request: PageRequest): Promise<PageReply>;
	files(request: FilesRequest): Promise<string[] | null>;
	/** The stream ended: the questions it still had open close as cancelled. */
	cancel(): void;
};
type Stream = {
	owner: ScreenOwner;
	key: TaskKey;
	tab: string;
	format: BrowserScreenFormat;
	metrics: ReturnType<typeof browserScreenMetrics>;
	request: Extract<BrowserScreenCommand, { kind: 'start' }>;
	pacer: ScreenPacer;
	/** The device's last input on the page: what the page copies within a second of it goes to the device. */
	input: number;
	/** Our own copy for the device is answered by value, not by the page's report. */
	copying: boolean;
	/** The page's dialogs ask through this path (spec/remote-access-and-mobile#browser-from-device). */
	ask: string;
	/** «Leave» after `beforeunload`: until then the page's unload does not hold a navigation. */
	leaveUntil: number;
	/** The device is being asked «Leave this page?» now. */
	leaving: boolean;
	/** The screencast runs with these metrics. */
	started: string;
};
/** Where a device's files for page file inputs land on this machine (0700 folders, 0600 files). */
export const pageFilesRoot = join(tmpdir(), 'brigadir-page-files');
const debugStreams = process.env.BRIGADIR_REMOTE_DEBUG === '1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(promise: Promise<T>, ms: number) =>
	Promise.race([
		promise,
		sleep(ms).then(() => {
			throw new Error('Timed out');
		}),
	]);
/** Network events that say the page is still loading something; frames of an open stream do not. */
const networkActivity = new Set([
	'Network.requestWillBeSent',
	'Network.responseReceived',
	'Network.loadingFinished',
	'Network.loadingFailed',
]);
/** The person's own input on a page the agent works with (spec/browser-and-simulator#background). */
const personInput = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'char', 'mouseWheel']);
export type BrowsersOptions = {
	/** spec/browser-and-simulator#background: tasks whose page lives off screen, for the sidebar marker. */
	live?: (keys: TaskKey[]) => void;
	/** The task the window shows: an agent call there waits for its column instead of parking the view. */
	onScreen?: (key: TaskKey) => boolean;
	/** spec/browser-and-simulator#background: 60 s; tests shorten it. */
	freezeMs?: number | undefined;
	/** spec/task-window-workspace#restore-window: the person changed a tab's Desktop / Mobile. */
	modeChanged?: (key: TaskKey, tab: string) => void;
	/**
	 * spec/browser-and-simulator#notifications: a page showed a notification out of sight (its tab is off screen or the window is not focused) — a
	 * notice of the OS; `close` — the page closed it.
	 */
	pageNotification?: (key: TaskKey, tab: string, notice: PageNotice & { host: string }) => void;
	pageNotificationClose?: (key: TaskKey, tab: string, id: number) => void;
};
/** Only when the window is gone and its tokens cannot be read (rule 4: the window is the source of colours). */
const ringFallback: RingColors = {
	accent: '#2f7cf6',
	soft: 'rgba(47,124,246,.18)',
	fill: '#2f7cf6',
	fg: '#fff',
};

export class Browsers {
	private entries = new Map<string, Entry>();
	/** spec/task-window-workspace#work-area: the views attached to the window now — every tab on screen in any group, not one per window. */
	private shown = new Set<string>();
	/** spec/task-window-workspace#work-area: the tab each task's agent opened; its calls without `tab` go there. */
	private agentTabs = new Map<string, string>();
	/** spec/task-window-workspace#work-area.1: the person's input on each page, so the agent yields for a moment. */
	readonly input = new PersonInput();
	private mountRevisions = new Map<string, number>();
	private lifecycle = 0;
	private pending = new Map<string, Promise<Entry>>();
	/** spec/task-window-workspace#restore-window: Desktop / Mobile of each tab; the old app-wide setting is read once. */
	private modes: BrowserModes;
	get isSaving() {
		return false;
	}
	waitForWrites() {
		return this.modes.settled();
	}
	private domainWrites: Promise<unknown> = Promise.resolve();
	/** spec/browser-and-simulator#opening-tabs: agent calls waiting for their task's view to be mounted by the renderer. */
	private mountWaiters = new Map<string, Set<() => void>>();
	/** spec/browser-and-simulator#background: the agent's interval per view; its end freezes a hidden view. */
	private clock: BrowserAgentClock;
	/** spec/browser-and-simulator#background: the task clipboard, in memory only; it lives while the task's host does. */
	private clipboards = new Map<string, string>();
	/** spec/browser-and-simulator#background: addresses of views the cache closed, reopened by the next call. */
	private reopen = new Map<string, string>();
	/** The browser column width the task had on screen; the invisible window takes it. */
	private widths = new Map<string, number>();
	private liveSignature = '';
	/** spec/remote-access-and-mobile#browser-from-device: tabs a device streams now; a streamed tab counts as one the person sees. */
	private streams = new Map<string, Stream>();
	private streamLog: ReturnType<typeof setInterval> | null = null;
	/** spec/browser-and-simulator#notifications: the person's decisions on the pages' notifications, by project. */
	private notificationSites: BrowserNotificationSites;
	/** The person sees the tab: on this machine's window, or streamed to the device in control. */
	private seen(id: string) {
		return this.shown.has(id) || this.streams.has(id);
	}
	private seenIds() {
		return [...this.shown, ...this.streams.keys()];
	}
	constructor(
		readonly dataDir: string | undefined,
		readonly window: () => BrowserWindow | null,
		readonly publish: (key: TaskKey, event: BrowserEvent) => void,
		readonly focusChanged: () => void = () => {},
		readonly show: (key: TaskKey, tab: string, front?: boolean) => void = () => {},
		readonly tabChanged: (key: TaskKey, info: BrowserTabInfo) => void = () => {},
		readonly options: BrowsersOptions = {}
	) {
		this.clock = new BrowserAgentClock((id) => this.expire(id), options.freezeMs);
		this.modes = new BrowserModes(dataDir);
		this.notificationSites = new BrowserNotificationSites(dataDir);
	}
	/** The tab's name, address and agent state for the strip and the Tools list, sent when it changes (on screen or not). */
	private info(entry: Entry) {
		if (entry.web.isDestroyed()) return;
		const info: BrowserTabInfo = {
				tab: entry.tab,
				url: entry.web.getURL(),
				title: entry.web.getTitle(),
				loading: entry.web.isLoading(),
				agent: entry.agent,
				audible: entry.web.isCurrentlyAudible(),
				muted: entry.web.isAudioMuted(),
			},
			signature = JSON.stringify(info);
		if (signature === entry.info) return;
		entry.info = signature;
		this.tabChanged(entry.key, info);
	}
	private state(entry: Entry): BrowserState {
		const web = entry.web;
		return {
			url: web.getURL(),
			title: web.getTitle(),
			loading: web.isLoading(),
			mobile: entry.mobile,
			picking: entry.picking,
			back: web.navigationHistory.canGoBack(),
			forward: web.navigationHistory.canGoForward(),
			error: entry.error,
			agent: this.clock.active(name(entry.key, entry.tab)),
			notifications: this.notifications(entry),
		};
	}
	/** spec/browser-and-simulator#notifications: the page's domain, its decision and whether the strip asks now; none for a page that is not HTTP(S). */
	private notifications(entry: Entry): BrowserState['notifications'] {
		const host = browserUrl(entry.web.getURL())?.hostname;
		if (!host) return null;
		return {
			host,
			permission: this.notificationSites.loaded.get(entry.key.projectId)?.[host] ?? 'default',
			asking: entry.notificationAsk,
		};
	}
	// A cached view that is not attached publishes nothing: the renderer drops it, and mount sends the full state.
	private update(entry: Entry, node?: string, nodeToken?: string) {
		if (entry.web.isDestroyed()) return;
		this.info(entry);
		if (!this.seen(name(entry.key, entry.tab))) return;
		this.focusChanged();
		this.publish(entry.key, {
			tab: entry.tab,
			state: this.state(entry),
			logs: entry.logs,
			...(node ? { node } : {}),
			...(nodeToken ? { nodeToken } : {}),
		});
	}
	/** A cached view nobody sees is frozen like a background tab: no timers, network or console work until mount. Agents only drive the attached view. */
	private lifecycle_(entry: Entry, state: 'frozen' | 'active') {
		if (!entry.web.isDestroyed() && entry.web.debugger.isAttached())
			void entry.web.debugger.sendCommand('Page.setWebLifecycleState', { state }).catch(() => {});
	}
	private schedule(entry: Entry) {
		if (!entry.timer)
			entry.timer = setTimeout(() => {
				entry.timer = null;
				this.update(entry);
			}, 100);
	}
	private log(entry: Entry, kind: BrowserLog['kind'], text: string, error = false) {
		entry.logs.push({
			id: String(++entry.counter),
			kind,
			text: text.slice(0, 8000),
			error,
			at: Date.now(),
		});
		if (entry.logs.length > 500) entry.logs.shift();
		this.schedule(entry);
	}
	private async get(key: TaskKey, tab: string) {
		const id = name(key, tab);
		const existing = this.pending.get(id);
		if (existing) return existing;
		const current = this.entries.get(id);
		if (current) {
			// The cache closes the view used longest ago (spec/browser-and-simulator#background).
			this.entries.delete(id);
			this.entries.set(id, current);
			return current;
		}
		const operation = this.create(key, tab, this.lifecycle)
			.catch((error) => {
				this.discard(id);
				throw error;
			})
			.finally(() => this.pending.delete(id));
		this.pending.set(id, operation);
		return operation;
	}
	private async create(key: TaskKey, tab: string, lifecycle: number) {
		const id = name(key, tab);
		let entry = this.entries.get(id);
		if (entry) {
			this.entries.delete(id);
			this.entries.set(id, entry);
			return entry;
		}
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		if (lifecycle !== this.lifecycle || !this.window() || this.window()!.isDestroyed())
			throw new Error('Window is closed');
		const partition = session.fromPartition(`persist:brigadir-browser-${key.projectId}`);
		partition.setPermissionRequestHandler((_w, _p, reply) => reply(false));
		partition.setPermissionCheckHandler(() => false);
		if (!partition.listenerCount('will-download'))
			partition.on('will-download', (event) => event.preventDefault());
		const view = new WebContentsView({
			webPreferences: {
				session: partition,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				backgroundThrottling: true,
			},
		});
		entry = {
			nodes: new Map(),
			highlights: new Map(),
			network: new BrowserNetwork(
				(log) => {
					current.logs.push(log);
					if (current.logs.length > 500) current.logs.shift();
					this.schedule(current);
				},
				() => this.schedule(current),
				(requestId) =>
					view.webContents.debugger.sendCommand('Network.streamResourceContent', { requestId })
			),
			key,
			tab,
			agent: null,
			info: '',
			view,
			web: view.webContents,
			mobile: false,
			picking: false,
			logs: [],
			error: null,
			counter: 0,
			timer: null,
			agentDomains: null,
			park: null,
			frozen: false,
			acting: false,
			agentSeen: false,
			notes: [],
			touched: false,
			nextDialog: null,
			pageSignature: '',
			pageScript: null,
			pageSync: Promise.resolve(),
			intercepting: false,
			netAt: 0,
			reopening: null,
			lastNav: null,
			hiddenRequests: new Set(),
			fileDirs: [],
			fetching: false,
			pageToken: randomUUID(),
			pageState: null,
			frames: new Map(),
			dialogsMuted: false,
			dialogClosedAt: 0,
			notificationAsk: false,
			notificationsMuted: false,
			noticeAt: 0,
		};
		const current = entry;
		this.entries.set(id, entry);
		const web = view.webContents;
		this.input.watch(web);
		web.on('focus', () => this.focusChanged());
		web.on('blur', () => queueMicrotask(() => this.focusChanged()));
		const navigate = (event: Electron.Event, url: string, main: boolean) => {
			const parsed = browserUrl(url);
			if (!parsed && !(url === 'about:blank' && !main)) {
				event.preventDefault();
				return;
			}
			if (
				main &&
				current.agentDomains &&
				!localBrowserUrl(url) &&
				!current.agentDomains.has(parsed!.hostname)
			) {
				event.preventDefault();
				current.error = `Browser navigation needs permission: ${url}`;
				this.log(current, 'console', current.error, true);
				this.update(current);
			}
		};
		// spec/remote-access-and-mobile#browser-from-device: a page a device streams opens its new windows as tabs of our browser; locally they stay denied.
		web.setWindowOpenHandler((details) => {
			this.openedWindow(current, details.url);
			return { action: 'deny' };
		});
		web.on('cursor-changed', (_event, type) => {
			const stream = this.streams.get(id);
			if (stream) stream.owner.send({ key, tab, kind: 'cursor', cursor: browserCursor(type) });
		});
		web.on('will-frame-navigate', (event) => navigate(event, event.url, event.isMainFrame));
		web.on('will-redirect', (event, url, _inPlace, main) => navigate(event, url, main));
		web.on('did-start-navigation', (_event, _url, _inPlace, main) => {
			if (main) {
				current.nodes.clear();
				current.highlights.clear();
				if (web.debugger.isAttached())
					void web.debugger.sendCommand('Overlay.hideHighlight').catch(() => {});
				current.network.clear();
				current.logs = [];
				current.error = null;
				this.update(current);
			}
		});
		web.on('did-fail-load', (_event, code, description, _url, main) => {
			if (main && code !== -3) {
				current.error = description;
				this.update(current);
			}
		});
		web.on('did-navigate', () => {
			// A new document of the tab: its dialogs ask again; so does it for notifications (spec/browser-and-simulator#notifications).
			current.dialogsMuted = false;
			current.dialogClosedAt = 0;
			current.notificationAsk = false;
			current.notificationsMuted = false;
			this.update(current);
		});
		web.on('did-navigate-in-page', () => this.update(current));
		web.on('did-stop-loading', () => this.update(current));
		web.on('page-title-updated', () => this.update(current));
		// spec/browser-and-simulator#tab-sound: the tab's sound icon follows the page.
		web.on('audio-state-changed', () => this.update(current));
		web.on('render-process-gone', () => {
			current.error = 'Browser renderer stopped';
			this.update(current);
		});
		// spec/browser-and-simulator#background: while the agent works with the page, beforeunload does not hold its navigation.
		web.on('will-prevent-unload', (event) => {
			const stream = this.streams.get(id);
			if (stream && !current.park && !this.clock.active(id)) {
				// spec/remote-access-and-mobile#browser-from-device: «Leave» on the device lets the next navigation go; otherwise it stays and the device is asked.
				if (Date.now() < stream.leaveUntil) event.preventDefault();
				else void this.askLeave(current, stream);
				return;
			}
			if (!current.park && !this.clock.active(id)) return;
			event.preventDefault();
			this.note(current, { kind: 'beforeunload' });
		});
		// HTTP authentication is never answered from here; the agent learns that the page wants a sign-in.
		web.on('login', (event, details, _auth, callback) => {
			event.preventDefault();
			callback();
			if (current.park || this.clock.active(id))
				this.note(current, {
					kind: 'login',
					host: browserUrl(details.url)?.host ?? details.url.slice(0, 200),
				});
		});
		// spec/browser-and-simulator#background: the person's own input between the agent's calls.
		web.on('input-event', (_event, input) => {
			if (current.agentSeen && !current.acting && this.seen(id) && personInput.has(input.type))
				current.touched = true;
		});
		// A detached, never-navigated view has no renderer for Runtime.enable yet.
		// Initialize it before allowing callers to navigate or mount concurrently.
		await web.loadURL('about:blank');
		web.debugger.attach('1.3');
		await Promise.all([
			web.debugger.sendCommand('Runtime.enable'),
			web.debugger.sendCommand('Network.enable', {
				maxTotalBufferSize: 1048576,
				maxResourceBufferSize: 65536,
				maxPostDataSize: 0,
			}),
			web.debugger.sendCommand('DOM.enable'),
			web.debugger.sendCommand('Page.enable'),
			web.debugger.sendCommand('Runtime.addBinding', { name: pageBinding }),
		]);
		if (this.modes.of(id)) await this.applyMode(current, true, false);
		web.debugger.on('message', (_event, method, params, sessionId) => {
			// A cross-site frame came or went; what one of them says is about its page script only.
			if (method === 'Target.attachedToTarget') return this.frameAttached(current, params);
			if (method === 'Target.detachedFromTarget')
				return void current.frames.delete(params?.sessionId);
			if (sessionId) return this.frameMessage(current, method, params, sessionId);
			// spec/remote-access-and-mobile#browser-from-device: the screencast, the page dialogs' requests and the device's file choice.
			if (method === 'Page.screencastFrame') return this.screenFrame(current, params);
			if (method === 'Fetch.requestPaused') return void this.pageQuestion(current, params);
			if (method.startsWith('Network.')) {
				const request = params?.requestId;
				if (
					method === 'Network.requestWillBeSent' &&
					typeof params?.request?.url === 'string' &&
					params.request.url.includes(pageDialogPath)
				)
					current.hiddenRequests.add(request);
				if (current.hiddenRequests.has(request)) {
					if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed')
						current.hiddenRequests.delete(request);
					return;
				}
			}
			if (networkActivity.has(method)) current.netAt = Date.now();
			if (method === 'Runtime.bindingCalled' && params.name === pageBinding)
				this.pageReport(current, params.payload);
			if (method === 'Page.fileChooserOpened') {
				if (this.streams.has(id) && !current.acting && !current.park)
					void this.chooseFiles(current, params);
				else this.note(current, { kind: 'file-chooser' });
			}
			if (method === 'Runtime.consoleAPICalled')
				this.log(
					current,
					'console',
					(params.args ?? [])
						.map((arg: any) => String(arg.value ?? arg.description ?? arg.type))
						.join(' '),
					params.type === 'error'
				);
			if (method === 'Runtime.exceptionThrown')
				this.log(
					current,
					'console',
					String(
						params.exceptionDetails?.exception?.description ??
							params.exceptionDetails?.text ??
							'Exception'
					),
					true
				);
			current.network.event(method, params);
			if (method === 'Overlay.inspectModeCanceled') {
				current.picking = false;
				this.update(current);
			}
			if (method === 'Overlay.inspectNodeRequested')
				void (async () => {
					current.picking = false;
					await web.debugger.sendCommand('Overlay.setInspectMode', {
						mode: 'none',
						highlightConfig: {},
					});
					const resolved = await web.debugger.sendCommand('DOM.resolveNode', {
						backendNodeId: params.backendNodeId,
					});
					const result = await web.debugger.sendCommand('Runtime.callFunctionOn', {
						objectId: resolved.object.objectId,
						functionDeclaration: describeNode,
						returnByValue: true,
					});
					await web.debugger.sendCommand('Runtime.releaseObject', {
						objectId: resolved.object.objectId,
					});
					const token = randomUUID();
					current.nodes.set(token, params.backendNodeId);
					while (current.nodes.size > 10) current.nodes.delete(current.nodes.keys().next().value!);
					this.update(
						current,
						JSON.stringify({ ...result.result.value, mode: current.mobile ? 'Mobile' : 'Desktop' }),
						token
					);
				})().catch((error) => {
					current.error = `Node selection failed: ${String(error)}`;
					this.update(current);
				});
		});
		// Cross-site frames get the page script too, and every document gets it before the page's own scripts.
		void web.debugger.sendCommand('Target.setAutoAttach', frameAutoAttach).catch(() => {});
		void this.syncPage(current);
		// spec/browser-and-simulator#background: no limit on live pages; the cache of 10 closes the oldest frozen ones (every tab is a view).
		for (const victim of browserEvictions(
			[...this.entries.entries()].map(([item, value]) => ({
				id: item,
				live: this.seen(item) || !!value.park,
			})),
			id
		))
			this.discard(victim, true);
		const address = this.reopen.get(id);
		if (address) {
			this.reopen.delete(id);
			current.reopening = web.loadURL(address).catch(() => {});
		}
		return entry;
	}
	private discard(id: string, remember = false) {
		const entry = this.entries.get(id);
		if (!entry) return;
		// BrowserWindow's closed event runs after its native contentView is gone.
		// Drop ownership first so repeated cleanup and late CDP events are harmless.
		this.entries.delete(id);
		this.shown.delete(id);
		this.mountRevisions.delete(id);
		// A tab the cache closed stays the agent's: its next call reopens the address there (spec/browser-and-simulator#background).
		if (!remember && this.agentTabs.get(taskName(entry.key)) === entry.tab)
			this.agentTabs.delete(taskName(entry.key));
		if (entry.timer) clearTimeout(entry.timer);
		this.clock.clear(id);
		this.endStream(id, false);
		for (const dir of entry.fileDirs.splice(0)) void rm(dir, { recursive: true, force: true });
		if (remember && !entry.web.isDestroyed() && browserUrl(entry.web.getURL())) {
			this.reopen.delete(id);
			this.reopen.set(id, entry.web.getURL());
			while (this.reopen.size > 100) this.reopen.delete(this.reopen.keys().next().value!);
		}
		const window = this.window();
		if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
		this.unpark(entry);
		if (!entry.web.isDestroyed()) entry.web.close();
		this.focusChanged();
	}
	/** spec/browser-and-simulator#background: one invisible window per live hidden view, on the main window's display, as wide as the task's browser column. */
	private async park(entry: Entry) {
		const id = name(entry.key, entry.tab),
			main = this.window();
		if (this.seen(id)) return;
		if (!main || main.isDestroyed())
			throw new Error('The Brigadir window is closed, so the browser is not available.');
		if (!entry.park || entry.park.isDestroyed()) {
			const area = screen.getDisplayMatching(main.getBounds()).workArea,
				width = Math.max(
					320,
					Math.min(area.width, this.widths.get(id) ?? defaultSurfaceLayout.browserWidth)
				),
				height = Math.max(320, Math.min(area.height, main.getContentBounds().height));
			const park = new BaseWindow({
				x: area.x,
				y: area.y,
				width,
				height,
				show: false,
				frame: false,
				focusable: false,
				skipTaskbar: true,
				hasShadow: false,
				resizable: false,
				movable: false,
				minimizable: false,
				maximizable: false,
				fullscreenable: false,
				title: '',
			});
			// spec/architecture-and-platform#linux-package: Linux cannot make a window invisible (`setOpacity` does nothing there), so its parking window is never
			// shown: the focus emulation below keeps the page drawing and taking CDP input in a hidden window (probe
			// hidden-browser-unshown.js on macOS: clicks in 2–7 ms and a screenshot, without it 5 s and no surface).
			const shown = process.platform !== 'linux';
			// Always on top: a window covered by any other one is hidden for macOS, and the page's mouse waits 5 s again.
			if (shown) {
				park.setOpacity(0);
				park.setIgnoreMouseEvents(true);
				park.setAlwaysOnTop(true, 'screen-saver');
			}
			park.excludedFromShownWindowsMenu = true;
			if (process.platform === 'darwin') park.setHiddenInMissionControl(true);
			park.contentView.addChildView(entry.view);
			entry.view.setBounds({ x: 0, y: 0, width, height });
			if (shown) park.showInactive();
			entry.park = park;
			this.publishLive();
		}
		if (entry.frozen) {
			entry.frozen = false;
			this.lifecycle_(entry, 'active');
			entry.netAt = Date.now();
			// The page catches up with what came while it was frozen: 500 ms without requests, 3 s at most.
			const started = Date.now();
			while (
				Date.now() - started < browserQuietMaxMs &&
				Date.now() - entry.netAt < browserQuietMs &&
				!entry.web.isDestroyed()
			)
				await sleep(50);
		}
		// spec/browser-and-simulator#background: the page is focused for itself all the time it is parked; the window never takes the OS focus.
		if (!entry.web.isDestroyed())
			await entry.web.debugger
				.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
				.catch(() => {});
	}
	private unpark(entry: Entry) {
		const park = entry.park;
		if (!park) return;
		entry.park = null;
		if (!park.isDestroyed()) {
			park.contentView.removeChildView(entry.view);
			park.destroy();
		}
		this.publishLive();
	}
	/** The person stopped seeing the view: it stays live in the invisible window while the agent works with it, otherwise it freezes. */
	private hide(entry: Entry) {
		const id = name(entry.key, entry.tab),
			window = this.window();
		if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
		this.shown.delete(id);
		if (this.clock.active(id))
			void this.park(entry)
				.then(() => this.syncPage(entry))
				.catch(() => this.freeze(entry));
		else this.freeze(entry);
		this.focusChanged();
	}
	private freeze(entry: Entry) {
		if (this.seen(name(entry.key, entry.tab)) || entry.web.isDestroyed()) return;
		this.unpark(entry);
		if (!entry.frozen) {
			entry.frozen = true;
			this.lifecycle_(entry, 'frozen');
		}
	}
	/** spec/browser-and-simulator#background: 60 s after the agent's last call a hidden view freezes; a visible one stops answering its dialogs. */
	private expire(id: string) {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.nextDialog = null;
		void this.syncPage(entry).then(() => {
			if (this.entries.get(id) === entry && !this.clock.active(id) && entry.park)
				this.freeze(entry);
		});
		this.update(entry);
	}
	private publishLive() {
		const keys = this.liveTasks(),
			signature = keys.map(taskName).sort().join('\n');
		if (signature === this.liveSignature) return;
		this.liveSignature = signature;
		this.options.live?.(keys);
	}
	/** Tasks whose page is live off screen (spec/browser-and-simulator#background). */
	liveTasks(): TaskKey[] {
		const keys = new Map<string, TaskKey>();
		for (const entry of this.entries.values())
			if (entry.park) keys.set(taskName(entry.key), entry.key);
		return [...keys.values()];
	}
	/** spec/browser-and-simulator#background: the task clipboard goes with the task's host. */
	forgetClipboard(key: TaskKey) {
		this.clipboards.delete(taskName(key));
	}
	private note(entry: Entry, note: BrowserPageNote) {
		// One copy note is enough: the last one says what the clipboard holds.
		if (note.kind === 'copy') entry.notes = entry.notes.filter((item) => item.kind !== 'copy');
		if (entry.notes.length < 20) entry.notes.push(note);
	}
	/** What the page script reports through the binding: one JSON object, checked like any page input. */
	private pageReport(entry: Entry, payload: unknown) {
		let value: unknown;
		try {
			value = typeof payload === 'string' && payload.length < 300_000 ? JSON.parse(payload) : null;
		} catch {
			return;
		}
		if (!isRecord(value)) return;
		if (value.kind === 'next-used') entry.nextDialog = null;
		if (
			value.kind === 'dialog' &&
			(value.type === 'alert' || value.type === 'confirm' || value.type === 'prompt') &&
			typeof value.message === 'string'
		)
			this.note(entry, {
				kind: 'dialog',
				type: value.type,
				message: value.message.slice(0, 2000),
				answer:
					typeof value.answer === 'string'
						? value.answer.slice(0, 2000)
						: value.answer === true
							? true
							: null,
			});
		const stream = this.streams.get(name(entry.key, entry.tab));
		if (value.kind === 'copy' && typeof value.text === 'string' && stream && !entry.acting) {
			// spec/remote-access-and-mobile#browser-from-device: what the page copies right after the person's input on the device goes to its clipboard.
			if (!stream.copying && Date.now() - stream.input < 1000)
				stream.owner.send({
					key: entry.key,
					tab: entry.tab,
					kind: 'copy',
					text: value.text.slice(0, 1_000_000),
				});
			return;
		}
		if (value.kind === 'copy' && typeof value.text === 'string') {
			const text = value.text.slice(0, browserClipboardMax);
			this.clipboards.set(taskName(entry.key), text);
			this.note(entry, { kind: 'copy', text, cut: value.cut === true });
		}
		if (value.kind === 'picker') this.note(entry, { kind: 'picker' });
		if (typeof value.kind === 'string' && value.kind.startsWith('notification'))
			this.pageNotification(entry, value);
		// spec/remote-access-and-mobile#networking: the page asked for a picker while a device streams it — the device shows its own.
		if (value.kind === 'open-picker' && stream && !entry.acting && isBrowserPicker(value.picker))
			stream.owner.send({ key: entry.key, tab: entry.tab, kind: 'picker', picker: value.picker });
	}
	/** spec/browser-and-simulator#notifications: the page asks to show notifications, shows one or closes one. */
	private pageNotification(entry: Entry, value: Record<string, unknown>) {
		const id = name(entry.key, entry.tab),
			notifications = this.notifications(entry);
		if (!notifications) return;
		if (value.kind === 'notification-ask') {
			if (entry.notificationsMuted || notifications.permission !== 'default')
				return void this.pageCall(entry, 'asked()');
			if (entry.notificationAsk) return;
			entry.notificationAsk = true;
			if (this.clock.active(id))
				this.note(entry, { kind: 'notification-ask', host: notifications.host });
			return this.update(entry);
		}
		if (value.kind === 'notification-close' && Number.isSafeInteger(value.id))
			return this.options.pageNotificationClose?.(entry.key, entry.tab, Number(value.id));
		if (value.kind !== 'notification' || notifications.permission !== 'granted') return;
		const notice = pageNotice(value),
			now = Date.now();
		if (!notice || now - entry.noticeAt < pageNoticeGapMs) return;
		entry.noticeAt = now;
		if (entry.agentSeen)
			this.note(entry, { kind: 'notification', title: notice.title, body: notice.body });
		const window = this.window();
		if (this.shown.has(id) && window && !window.isDestroyed() && window.isFocused())
			return this.publish(entry.key, {
				tab: entry.tab,
				state: this.state(entry),
				logs: entry.logs,
				notice: { id: notice.id, title: notice.title, body: notice.body, host: notifications.host },
			});
		this.options.pageNotification?.(entry.key, entry.tab, { ...notice, host: notifications.host });
	}
	/** A call into the page script's own API; a page that went or never ran it is no error. */
	private pageCall(entry: Entry, call: string) {
		if (entry.web.isDestroyed() || !entry.web.debugger.isAttached()) return;
		void within(
			entry.web.debugger.sendCommand('Runtime.evaluate', { expression: `${pageApi}?.${call}` }),
			2000
		).catch(() => {});
	}
	/** spec/browser-and-simulator#notifications: the person's answer for the page's domain — from the strip or the «…» menu. */
	private async decideNotifications(
		entry: Entry,
		decision: BrowserNotificationPermission | 'dismiss'
	) {
		const host = browserUrl(entry.web.getURL())?.hostname;
		if (!host) throw new Error('Only HTTP and HTTPS pages have notifications');
		entry.notificationAsk = false;
		if (decision === 'dismiss') {
			entry.notificationsMuted = true;
			this.pageCall(entry, 'asked()');
			this.update(entry);
			return host;
		}
		await this.notificationSites.set(entry.key.projectId, host, decision);
		// Every tab of the project hears it: the page script's state changes and the waiting request settles.
		for (const other of this.entries.values())
			if (other.key.projectId === entry.key.projectId) {
				void this.syncPage(other);
				this.update(other);
			}
		return host;
	}
	/** spec/browser-and-simulator#notifications: the person clicked the page's notice of the OS — its tab comes to the front, the page gets `click`. */
	notificationClicked(key: TaskKey, tab: string, id: number) {
		const entry = this.entries.get(name(key, tab));
		if (!entry) return;
		this.show(key, tab, true);
		this.pageCall(entry, `click(${Math.trunc(id)})`);
	}
	/** spec/browser-and-simulator#background: the page's dialogs, clipboard and pickers while the agent works with it; the file chooser is intercepted. */
	private syncPage(entry: Entry) {
		const run = async () => {
			if (entry.web.isDestroyed() || entry.frozen || !entry.web.debugger.isAttached()) return;
			const id = name(entry.key, entry.tab),
				hidden = !!entry.park,
				agent = hidden || this.clock.active(id),
				stream = this.streams.get(id);
			const state: PageAgentState = {
				dialogs: agent,
				// spec/remote-access-and-mobile#browser-from-device: a streamed page copies and pastes with the device, asks it its dialogs, has no pickers.
				clipboard: hidden || entry.acting || !!stream,
				pickers: hidden || !!stream,
				next: entry.nextDialog,
				buffer: this.clipboards.get(taskName(entry.key)) ?? '',
				ask: stream && !agent ? stream.ask : null,
				// spec/remote-access-and-mobile#networking: the person on the device opens the page's pickers there; the agent's are refused as before.
				remotePickers: !!stream && !agent && !entry.acting,
				notifications: await this.notificationSites.of(entry.key.projectId),
			};
			const signature = JSON.stringify(state),
				cdp = (method: string, params?: Record<string, unknown>) =>
					entry.web.debugger.sendCommand(method, params);
			entry.pageState = state;
			if (signature !== entry.pageSignature) {
				entry.pageSignature = signature;
				if (entry.pageScript) {
					const identifier = entry.pageScript;
					entry.pageScript = null;
					await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
				}
				// Every document, even with everything off: the page never gets to the key before the script.
				const source = pageAgentScript(state, entry.pageToken);
				entry.pageScript = (
					await cdp('Page.addScriptToEvaluateOnNewDocument', { source })
				).identifier;
				await within(cdp('Runtime.evaluate', { expression: source }), 2000).catch(() => {});
			}
			// The file chooser is the agent's only while it acts or the page is hidden; the person's own click opens it —
			// on this machine, or on the device that streams the page (spec/remote-access-and-mobile#browser-from-device).
			const intercept = hidden || entry.acting || !!stream;
			if (intercept !== entry.intercepting) {
				entry.intercepting = intercept;
				await cdp('Page.setInterceptFileChooserDialog', { enabled: intercept }).catch(() => {});
			}
			const fetching = !!stream && !agent;
			if (fetching !== entry.fetching) {
				entry.fetching = fetching;
				await (
					fetching
						? cdp('Fetch.enable', {
								patterns: [{ urlPattern: `*${stream!.ask}*`, requestStage: 'Request' }],
							})
						: cdp('Fetch.disable')
				).catch(() => {});
			}
			// A frame that went without its detach event is forgotten, not a stop for the others.
			for (const session of [...entry.frames.keys()])
				await this.syncFrame(entry, session).catch(() => entry.frames.delete(session));
		};
		return (entry.pageSync = entry.pageSync.then(run).catch(() => {}));
	}
	/**
	 * A cross-site frame of the tab attached, held at its start: it gets what the page has — the page script, the file
	 * chooser interception and the dialog requests — and only then runs. Its own cross-site frames attach the same way.
	 */
	private frameAttached(entry: Entry, params: any) {
		const session = params?.sessionId;
		if (typeof session !== 'string' || entry.web.isDestroyed()) return;
		const cdp = (method: string, value?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, value, session);
		const run = () => cdp('Runtime.runIfWaitingForDebugger').catch(() => {});
		if (params?.targetInfo?.type !== 'iframe') return void run();
		entry.frames.set(session, { script: null, applied: null });
		entry.pageSync = entry.pageSync
			.then(async () => {
				await cdp('Page.enable');
				await cdp('Target.setAutoAttach', frameAutoAttach);
				await this.syncFrame(entry, session);
			})
			.catch(() => {})
			.then(run);
	}
	/** One frame catches up with the page's state (inside `syncPage`'s queue). */
	private async syncFrame(entry: Entry, session: string) {
		const frame = entry.frames.get(session),
			page = entry.pageState;
		if (!frame || !page || entry.web.isDestroyed()) return;
		const cdp = (method: string, value?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, value, session);
		// A frame of another site: no task clipboard for it, and the agent's next answer is the page's.
		const next: FrameState = {
				script: JSON.stringify({ ...page, buffer: '', next: null }),
				intercept: entry.intercepting,
				fetching: entry.fetching ? (page.ask ?? null) : null,
			},
			before = frame.applied;
		frame.applied = next;
		if (before?.script !== next.script) {
			if (frame.script)
				await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: frame.script }).catch(
					() => {}
				);
			const source = pageAgentScript(JSON.parse(next.script) as PageAgentState, entry.pageToken);
			frame.script = (await cdp('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
			await within(cdp('Runtime.evaluate', { expression: source }), 2000).catch(() => {});
		}
		if (before?.intercept !== next.intercept)
			await cdp('Page.setInterceptFileChooserDialog', { enabled: next.intercept }).catch(() => {});
		if (before?.fetching !== next.fetching)
			await (
				next.fetching
					? cdp('Fetch.enable', {
							patterns: [{ urlPattern: `*${next.fetching}*`, requestStage: 'Request' }],
						})
					: cdp('Fetch.disable')
			).catch(() => {});
	}
	/** What a cross-site frame says — a dialog's request, a file chooser; the rest is the page's business. */
	private frameMessage(entry: Entry, method: string, params: any, session: string) {
		if (method === 'Fetch.requestPaused') return void this.pageQuestion(entry, params, session);
		if (method === 'Page.fileChooserOpened') {
			if (this.streams.has(name(entry.key, entry.tab)) && !entry.acting && !entry.park)
				void this.chooseFiles(entry, params, session);
			else this.note(entry, { kind: 'file-chooser' });
		}
	}
	/** The page's news since the last reply, added to this one; a reply that cannot carry text keeps them for the next. */
	private withNotes(entry: Entry, result: unknown) {
		if (entry.touched) {
			entry.touched = false;
			this.note(entry, { kind: 'person' });
		}
		if (!entry.notes.length) return result;
		const lines = entry.notes.map(browserNoteText);
		if (typeof result === 'string') {
			entry.notes = [];
			return `${result} ${lines.join(' ')}`;
		}
		if (isRecord(result) && !('image' in result)) {
			entry.notes = [];
			return { ...result, notes: lines };
		}
		return result;
	}
	/** spec/browser-and-simulator#browser: domains the agent may open; spec/browser-and-simulator#browser-ui-act: domains it may act on, a list of its own. */
	private async domains(key: TaskKey, list: 'open' | 'act' = 'open'): Promise<string[]> {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		const path = await safePath(store.root, `projects/${key.projectId}/${domainFiles[list]}`);
		try {
			const doc = await readDocument(path);
			if (
				!Array.isArray(doc.domains) ||
				doc.domains.length > 1000 ||
				!doc.domains.every((d) => typeof d === 'string')
			)
				throw new Error('Invalid browser domains');
			return doc.domains;
		} catch (e) {
			if (isRecord(e) && e.code === 'ENOENT') return [];
			throw e;
		}
	}
	async allowed(key: TaskKey, url: string, list: 'open' | 'act' = 'open') {
		return (
			localBrowserUrl(url) ||
			(await this.domains(key, list)).includes(browserUrl(url)?.hostname ?? '')
		);
	}
	remember(key: TaskKey, url: string, list: 'open' | 'act' = 'open') {
		const result = this.domainWrites.then(async () => {
			const domain = browserUrl(url)?.hostname;
			if (!domain) throw new Error('Invalid URL');
			const domains = await this.domains(key, list);
			if (domains.includes(domain)) return;
			if (domains.length >= 1000) throw new Error('Browser domain limit reached');
			const store = await SessionStore.at(this.dataDir);
			await atomicJson(
				await safePath(store.root, `projects/${key.projectId}/${domainFiles[list]}`),
				{ schemaVersion: 1, domains: [...domains, domain] }
			);
		});
		this.domainWrites = result.catch(() => {});
		return result;
	}
	/** A call without a tab (an older caller): the task's tab on screen, else the agent's, else its newest, else a first one. */
	private someTab(key: TaskKey) {
		const prefix = `${taskName(key)}#`,
			shown = this.seenIds().find((id) => id.startsWith(prefix));
		if (shown) return shown.slice(prefix.length);
		const own = this.agentTabs.get(taskName(key));
		if (own) return own;
		const last = [...this.entries.keys()].filter((id) => id.startsWith(prefix)).at(-1);
		return last ? last.slice(prefix.length) : 'b0';
	}
	/** spec/task-window-workspace#work-area: the task's browser tabs, the agent's own first marked. */
	/**
	 * spec/task-window-workspace#restore-window: the browser tabs a restart brought back. No page loads now: each address waits, like a tab the cache
	 * closed (spec/browser-and-simulator#background), until the tab is shown or the agent calls it.
	 */
	async restore(
		key: TaskKey,
		tabs: { tab: string; url: string; title: string; mobile: boolean }[]
	) {
		// Each tab comes back in its own mode, before the renderer mounts it (spec/task-window-workspace#restore-window).
		await this.modes.restore(tabs.map(({ tab, mobile }) => ({ id: name(key, tab), mobile })));
		for (const { tab, url, title } of tabs) {
			const id = name(key, tab);
			if (this.entries.has(id) || this.pending.has(id) || !browserUrl(url)) continue;
			this.reopen.delete(id);
			this.reopen.set(id, url);
			// The strip and the Tools list name the waiting tab by its address, as before the restart.
			this.tabChanged(key, {
				tab,
				url,
				title,
				loading: false,
				agent: null,
				audible: false,
				muted: false,
			});
		}
		while (this.reopen.size > 100) this.reopen.delete(this.reopen.keys().next().value!);
	}
	/** spec/task-window-workspace#restore-window: what `surface.json` keeps of a browser tab — its address, title and mode; `null` when main has none. */
	describe(key: TaskKey, tab: string): { url: string; title: string; mobile: boolean } | null {
		const id = name(key, tab),
			entry = this.entries.get(id);
		if (entry && !entry.web.isDestroyed()) {
			const url = entry.web.getURL();
			return browserUrl(url)
				? { url, title: entry.web.getTitle(), mobile: this.modes.of(id) }
				: {
						url: this.reopen.get(id) ?? '',
						title: entry.web.getTitle(),
						mobile: this.modes.of(id),
					};
		}
		const waiting = this.reopen.get(id);
		return waiting ? { url: waiting, title: '', mobile: this.modes.of(id) } : null;
	}
	private tabs(key: TaskKey) {
		const prefix = `${taskName(key)}#`,
			own = this.agentTabs.get(taskName(key));
		return [...this.entries.entries()]
			.filter(([id, entry]) => id.startsWith(prefix) && !entry.web.isDestroyed())
			.map(([id, entry]) => ({
				tab: entry.tab,
				url: entry.web.getURL(),
				title: entry.web.getTitle(),
				yours: entry.tab === own,
				onScreen: this.seen(id),
			}));
	}
	/**
	 * spec/task-window-workspace#work-area: the agent works in the tab it opened. `browser_open` without a tab makes one the first time and goes
	 * there later; `tab: "new"` makes another; other calls go to its tab, or to the tab the person has on screen.
	 */
	private agentTab(key: TaskKey, command: BrowserCommand): string | null {
		const task = taskName(key),
			own = this.agentTabs.get(task);
		if (command.tab === 'new' || (command.kind === 'open' && !command.tab && !own)) {
			const tab = freshTab();
			this.agentTabs.set(task, tab);
			return tab;
		}
		if (command.tab) {
			const id = name(key, command.tab);
			// A tab the cache closed (spec/browser-and-simulator#background) is still the task's: the call reopens its address.
			if (!this.entries.has(id) && !this.reopen.has(id))
				throw new Error(
					`There is no browser tab ${command.tab} in this task: browser_state lists them.`
				);
			return command.tab;
		}
		if (own) return own;
		const prefix = `${task}#`;
		return (
			this.seenIds()
				.find((id) => id.startsWith(prefix))
				?.slice(prefix.length) ?? null
		);
	}
	/**
	 * spec/browser-and-simulator#opening-tabs, spec/browser-and-simulator#background, spec/task-window-workspace#work-area: an agent call opens its browser tab in its task (the person sees the page when
	 * they open the task) and runs whether the tab is on screen or not: a task on screen waits for its tab, any other
	 * tab parks its view in an invisible window. The selected task, the window and the OS focus do not change.
	 */
	async agent(key: TaskKey, command: BrowserCommand) {
		if (!this.window() || this.window()!.isDestroyed())
			throw new Error('The Brigadir window is closed, so the browser is not available.');
		if (command.kind === 'tabs') return this.tabs(key);
		const tab = this.agentTab(key, command);
		if (!tab) {
			if (command.kind === 'state') return { url: '', title: '', tabs: this.tabs(key) };
			throw new Error('No page is open: call browser_open first.');
		}
		const id = name(key, tab);
		if (!this.seen(id)) {
			// A new tab of a task on screen opens in front of the person and the call waits for it; any other runs parked.
			const fresh = !this.entries.has(id) && !this.pending.has(id) && !this.reopen.has(id),
				mounted = fresh && this.options.onScreen?.(key) ? this.mounted(id, 3000) : null;
			this.show(key, tab);
			if (!(mounted && (await mounted))) {
				const entry = await this.get(key, tab);
				if (!this.seen(id)) await this.park(entry);
			}
		}
		const entry = await this.get(key, tab);
		if (command.kind !== 'open') await entry.reopening;
		this.clock.touch(id);
		entry.agentSeen = true;
		entry.acting = true;
		const step = agentStep(command);
		if (step) {
			entry.agent = {
				acting: step,
				waiting: null,
				step: entry.agent?.step ?? null,
				last: entry.agent?.last ?? 0,
				count: entry.agent?.count ?? 0,
			};
			this.info(entry);
		}
		const clipboard = taskName(key);
		let result: unknown;
		try {
			await this.syncPage(entry);
			if (command.kind === 'act' && command.action === 'dialog') {
				entry.nextDialog = {
					accept: command.accept === true,
					...(command.text !== undefined ? { text: command.text } : {}),
				};
				result = browserDialogReply(entry.nextDialog.accept, entry.nextDialog.text);
			} else if (command.kind === 'act' && command.action === 'notifications') {
				// spec/browser-and-simulator#notifications: the same decision as the person's strip and menu, kept for the domain.
				const host = await this.decideNotifications(entry, command.permission ?? 'default');
				result = browserNotificationsReply(host, command.permission ?? 'default');
			} else if (command.kind === 'act' && command.action === 'clipboard')
				result = browserClipboardReply(this.clipboards.get(clipboard) ?? '');
			else {
				if (command.kind === 'act' && command.action === 'paste') {
					this.clipboards.set(clipboard, (command.text ?? '').slice(0, browserClipboardMax));
					await this.syncPage(entry);
				}
				result = await this.command(key, { ...command, tab }, true);
				if (command.kind === 'state' && isRecord(result))
					result = { ...result, tab, tabs: this.tabs(key) };
			}
		} finally {
			entry.acting = false;
			if (step)
				entry.agent = {
					acting: null,
					waiting: null,
					step,
					last: Date.now(),
					count: (entry.agent?.count ?? 0) + 1,
				};
			await this.syncPage(entry);
			this.update(entry);
		}
		// The host asks `state` before every browser call (the permission is about that page): the page's news wait for the
		// call itself, or that look would take them and the agent would never read them (spec/browser-and-simulator#notifications).
		return command.kind === 'state' ? result : this.withNotes(entry, result);
	}
	/** spec/browser-and-simulator#background: `browser_show` — the person chose «Show»: the task opens with the agent's browser tab. */
	async reveal(key: TaskKey) {
		const tab = this.agentTabs.get(taskName(key)) ?? this.someTab(key),
			id = name(key, tab),
			mounted = this.mounted(id, 5000);
		this.show(key, tab, true);
		return this.seen(id) || (await mounted)
			? 'The page is on screen: the human opened the task and its browser. Keep working with it.'
			: 'The human allowed it, but the page is not on screen yet; it shows when the human opens the task. Keep working with it.';
	}
	private mounted(id: string, timeout: number) {
		return new Promise<boolean>((resolve) => {
			const waiters = this.mountWaiters.get(id) ?? new Set<() => void>();
			this.mountWaiters.set(id, waiters);
			const done = (value: boolean) => {
				clearTimeout(timer);
				waiters.delete(finish);
				if (!waiters.size && this.mountWaiters.get(id) === waiters) this.mountWaiters.delete(id);
				resolve(value);
			};
			const finish = () => done(true),
				timer = setTimeout(() => done(this.seen(id)), timeout);
			waiters.add(finish);
		});
	}
	async command(key: TaskKey, command: BrowserCommand, agent = false): Promise<unknown> {
		if (command.kind === 'tabs') return this.tabs(key);
		if (command.kind === 'discard' && !command.tab) {
			// The task itself went (archived, removed): every tab of it.
			const prefix = `${taskName(key)}#`;
			for (const id of [...this.entries.keys()]) if (id.startsWith(prefix)) this.discard(id);
			return null;
		}
		const tab = command.tab ?? this.someTab(key),
			id = name(key, tab);
		// Each tab has its own mount order: a later mount of one tab must not cancel another tab's.
		const mountRevision =
			command.kind === 'mount'
				? (this.mountRevisions.get(id) ?? 0) + 1
				: (this.mountRevisions.get(id) ?? 0);
		if (command.kind === 'mount') {
			this.mountRevisions.set(id, mountRevision);
		}
		if (command.kind === 'discard') {
			// The person closed the tab: a later tab of the same name starts Desktop.
			this.modes.forget(id);
			this.discard(id);
			return null;
		}
		if (command.kind === 'mount' && !command.visible) {
			const entry = this.entries.get(id);
			if (entry && this.shown.has(id)) {
				// spec/task-window-workspace#work-area: under an overlay the page leaves its picture behind (capturePage, ≈15 ms), not a hole.
				let image: string | null = null;
				if (command.snapshot && !entry.web.isDestroyed())
					image = await entry.web.capturePage().then(
						(picture) => (picture.isEmpty() ? null : picture.toDataURL()),
						() => null
					);
				if (this.mountRevisions.get(id) !== mountRevision) return image ? { image } : null;
				// Off screen it lives on in the invisible window while the agent works with it, else it freezes (spec/browser-and-simulator#background).
				this.hide(entry);
				return image ? { image } : null;
			}
			// spec/task-window-workspace#work-area: a tab laid out under an overlay from its first measure: its page exists, and an agent call waiting
			// for it goes on, parked.
			if (command.snapshot && this.mountWaiters.has(id)) {
				await this.get(key, tab);
				for (const finish of [...(this.mountWaiters.get(id) ?? [])]) finish();
			}
			return null;
		}
		if (command.kind === 'retain-nodes' && !this.entries.has(id)) return null;
		const entry = await this.get(key, tab);
		const web = entry.web;
		// spec/remote-access-and-mobile#browser-from-device: «Leave» after a page's `beforeunload` repeats this navigation of the person.
		if (!agent && ['open', 'back', 'forward', 'reload'].includes(command.kind))
			entry.lastNav = { command, at: Date.now() };
		if (command.kind === 'mount') {
			if (mountRevision !== this.mountRevisions.get(id)) return null;
			const window = this.window();
			if (!window || window.isDestroyed()) throw new Error('Window is closed');
			if (!this.shown.has(id)) {
				// spec/browser-and-simulator#background: a parked view comes back to its tab as it is, without a reload.
				this.unpark(entry);
				window.contentView.addChildView(entry.view);
				this.shown.add(id);
				entry.frozen = false;
				this.lifecycle_(entry, 'active');
				void this.syncPage(entry);
			}
			if (command.width > 0) this.widths.set(id, Math.round(command.width));
			const mobile = this.modes.of(id);
			if (entry.mobile !== mobile) await this.applyMode(entry, mobile);
			if (
				mountRevision !== this.mountRevisions.get(id) ||
				window.isDestroyed() ||
				web.isDestroyed()
			)
				return null;
			const bounds = window.getContentBounds();
			const x = Math.max(0, Math.min(bounds.width, Math.round(command.x))),
				y = Math.max(0, Math.min(bounds.height, Math.round(command.y)));
			entry.view.setBounds({
				x,
				y,
				width: Math.max(0, Math.min(bounds.width - x, Math.round(command.width))),
				height: Math.max(0, Math.min(bounds.height - y, Math.round(command.height))),
			});
			this.update(entry);
			for (const finish of [...(this.mountWaiters.get(id) ?? [])]) finish();
			return this.state(entry);
		}
		if (command.kind === 'open') {
			const url = browserUrl(command.url);
			if (!url) throw new Error('Only HTTP and HTTPS pages are supported');
			entry.agentDomains = agent ? new Set([url.hostname, ...(await this.domains(key))]) : null;
			// spec/browser-and-simulator#network-streams: a page that is itself an event stream never finishes loading while it is open; answer once its headers arrive.
			const stream = entry.network.documentStream(url.href);
			const load = web.loadURL(command.url);
			load.catch(() => {});
			try {
				if (await Promise.race([load.then(() => false), stream.promise.then(() => true)])) {
					this.update(entry);
					return {
						...this.state(entry),
						note: 'This page is an event stream and stays open while it streams. browser_network lists it; its requestId gives the events received so far.',
					};
				}
			} catch (e) {
				if (entry.error?.startsWith('Browser navigation needs permission:'))
					throw new Error(entry.error);
				throw e;
			} finally {
				stream.cancel();
			}
		}
		// spec/browser-and-simulator#browser-ui-act: the agent's tree and its actions; the host has checked the permission for this domain.
		if (command.kind === 'ui') {
			if (!agent) throw new Error('Only an agent reads the tree');
			return browserUi(web, command.offset);
		}
		if (command.kind === 'act') {
			if (!agent) throw new Error('Only an agent acts through browser_act');
			const { kind: _kind, tab: _tab, ...request } = command;
			// spec/task-window-workspace#work-area.1: while the person types or holds the mouse on this page, the action waits for them.
			const before = { url: web.getURL(), title: web.getTitle() };
			const settled = await this.input.settle(web, (waiting) => {
				if (entry.agent)
					entry.agent = { ...entry.agent, waiting: waiting ? entry.agent.acting : null };
				this.info(entry);
			});
			if (settled === 'busy')
				throw new Error(
					'The person is working on this page: they kept typing or holding the mouse for over 10 seconds, so this action was not done. Try it again later, or do something else first.'
				);
			const result = await this.input.agent(web, () =>
				browserAct(web, request, {
					// A streamed page's pickers would open on this machine's screen too (spec/remote-access-and-mobile#browser-from-device).
					hidden: () => !!entry.park || this.streams.has(id),
					colors: () => this.ringColors(),
					counter: () => entry.counter,
					errors: (since) =>
						entry.logs
							.filter((log) => log.kind === 'console' && log.error && Number(log.id) > since)
							.map((log) => log.text),
					navigate: (kind) => {
						const history = web.navigationHistory;
						if (kind === 'back') {
							if (!history.canGoBack()) return false;
							history.goBack();
						} else if (kind === 'forward') {
							if (!history.canGoForward()) return false;
							history.goForward();
						} else web.reload();
						return true;
					},
				})
			);
			this.update(entry);
			if (entry.error?.startsWith('Browser navigation needs permission:'))
				throw new Error(entry.error);
			if (settled !== 'waited') return result;
			// The reply says it below; the note of spec/browser-and-simulator#background would say it twice.
			entry.touched = false;
			const moved =
				before.url !== web.getURL() || before.title !== web.getTitle()
					? ` While you waited the page became ${web.getURL()}${web.getTitle() ? ` — "${web.getTitle()}"` : ''}.`
					: '';
			return `The person was working on this page, so this action waited until they stopped.${moved} ${result}`;
		}
		if (!agent && ['back', 'forward', 'reload'].includes(command.kind)) entry.agentDomains = null;
		if (command.kind === 'back' && web.navigationHistory.canGoBack())
			web.navigationHistory.goBack();
		if (command.kind === 'forward' && web.navigationHistory.canGoForward())
			web.navigationHistory.goForward();
		if (command.kind === 'reload') web.reload();
		// Focusing a WebContents activates the app on macOS: only move focus inside a window the person is already in.
		if (command.kind === 'focus') {
			const window = this.window();
			if (window && !window.isDestroyed() && window.isFocused()) web.focus();
		}
		if (command.kind === 'external') {
			if (agent) throw new Error('External navigation requires a user action');
			const url = browserUrl(web.getURL());
			if (!url) throw new Error('Only HTTP and HTTPS pages are supported');
			await shell.openExternal(url.href);
		}
		if (command.kind === 'inspect') web.openDevTools({ mode: 'detach' });
		if (command.kind === 'mute') {
			if (agent) throw new Error('Only the person mutes a tab');
			web.setAudioMuted(command.muted);
			this.update(entry);
		}
		if (command.kind === 'notification-click') {
			if (agent) throw new Error('Only the person clicks the notifications of a page');
			this.pageCall(entry, `click(${command.id})`);
		}
		if (command.kind === 'notifications') {
			if (agent) throw new Error('Only the person answers for the notifications of a page');
			await this.decideNotifications(entry, command.decision);
		}
		// spec/task-window-workspace#restore-window: the segment changes this tab only; `surface.json` keeps it.
		if (command.kind === 'mode') {
			this.modes.set(id, command.mobile);
			this.options.modeChanged?.(key, tab);
			await this.applyMode(entry, command.mobile);
		}
		if (command.kind === 'read') {
			const result = await web.debugger.sendCommand('Runtime.evaluate', {
				expression: `(${readPage})(${JSON.stringify(command.selector ?? '')})`,
				returnByValue: true,
				timeout: 3000,
			});
			return result.result.value;
		}
		if (command.kind === 'network' && command.requestId)
			return entry.network.details(command.requestId, (id) =>
				web.debugger.sendCommand('Network.getResponseBody', { requestId: id })
			);
		if (command.kind === 'network') return entry.network.list();
		if (command.kind === 'console')
			return recentLogs(entry.logs.filter((log) => log.kind === 'console'));
		if (command.kind === 'screenshot') {
			let bounds: Rectangle | undefined;
			if (command.selector) {
				const result = await web.debugger.sendCommand('Runtime.evaluate', {
					expression: `(()=>{const n=document.querySelector(${JSON.stringify(command.selector)});if(!n)return null;const r=n.getBoundingClientRect(),x=Math.max(0,Math.ceil(r.x)),y=Math.max(0,Math.ceil(r.y)),right=Math.min(innerWidth,Math.floor(r.right)),bottom=Math.min(innerHeight,Math.floor(r.bottom));return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;})()`,
					returnByValue: true,
					timeout: 3000,
				});
				bounds = result.result.value ?? undefined;
				if (!bounds) throw new Error('Element is not visible');
			}
			const capture = await web.capturePage(bounds);
			return {
				image: capture
					.resize({ width: Math.min(900, capture.getSize().width) })
					.toPNG()
					.toString('base64'),
				mimeType: 'image/png',
			};
		}
		if (command.kind === 'bind-node') {
			const node = entry.nodes.get(command.token);
			if (node !== undefined) {
				entry.nodes.delete(command.token);
				entry.highlights.set(command.attachmentId, node);
				while (entry.highlights.size > 10)
					entry.highlights.delete(entry.highlights.keys().next().value!);
				await this.highlight(entry);
			}
		}
		if (command.kind === 'retain-nodes') {
			for (const id of entry.highlights.keys())
				if (!command.attachmentIds.includes(id)) entry.highlights.delete(id);
			await this.highlight(entry);
		}
		if (command.kind === 'pick') {
			await web.debugger.sendCommand('Overlay.enable');
			await web.debugger.sendCommand('Overlay.setInspectMode', {
				mode: entry.picking ? 'none' : 'searchForNode',
				highlightConfig: await this.inspectHighlight(),
			});
			entry.picking = !entry.picking;
		}
		this.update(entry);
		return this.state(entry);
	}
	/** The Chromium inspector outline of «Select element» and of a node in the composer's context: 1 px of the app's
	 *  `--accent` (rule 4), resolved by the window so a chosen accent (spec/appearance#accent) and the theme apply. */
	private async inspectHighlight(): Promise<{ showInfo: boolean; borderColor: CdpColor }> {
		const window = this.window();
		let value: unknown = null;
		if (window && !window.isDestroyed())
			value = await window.webContents
				.executeJavaScript(
					`(()=>{const p=document.createElement('i');p.style.color='var(--accent)';document.documentElement.append(p);const c=getComputedStyle(p).color;p.remove();return c;})()`
				)
				.catch(() => null);
		const borderColor =
			(typeof value === 'string' ? cdpColor(value) : null) ??
			cdpColor((await this.ringColors()).accent) ??
			cdpColor(ringFallback.accent)!;
		return { showInfo: true, borderColor };
	}
	/** The accent of the app (spec/appearance#accent) for the ring the agent leaves on the page; read from the window, the source of the theme. */
	private async ringColors(): Promise<RingColors> {
		const fallback = ringFallback,
			window = this.window();
		if (!window || window.isDestroyed()) return fallback;
		try {
			const value = await window.webContents.executeJavaScript(
				`(()=>{const s=getComputedStyle(document.documentElement),v=n=>s.getPropertyValue(n).trim();return {accent:v('--accent'),soft:v('--accent-soft'),fill:v('--accent-fill')||v('--accent'),fg:v('--selfg')||'#fff'};})()`
			);
			return isRecord(value) &&
				Object.values(value).every(
					(item) => typeof item === 'string' && item && item.length < 200 && !/[;{}<>]/.test(item)
				)
				? (value as RingColors)
				: fallback;
		} catch {
			return fallback;
		}
	}
	private async highlight(entry: Entry) {
		const node = [...entry.highlights.values()].at(-1);
		try {
			await entry.web.debugger.sendCommand('Overlay.enable');
			await entry.web.debugger.sendCommand(
				node === undefined ? 'Overlay.hideHighlight' : 'Overlay.highlightNode',
				node === undefined
					? {}
					: {
							backendNodeId: node,
							highlightConfig: await this.inspectHighlight(),
						}
			);
		} catch {
			entry.highlights.clear();
			if (!entry.web.isDestroyed())
				await entry.web.debugger.sendCommand('Overlay.hideHighlight').catch(() => {});
		}
	}
	private async applyMode(entry: Entry, mobile: boolean, reload = true) {
		const web = entry.web;
		entry.mobile = mobile;
		if (mobile) {
			web.setUserAgent(
				web
					.getUserAgent()
					.replace(/\([^)]*\)/, '(Linux; Android 13; Mobile)')
					.replace(/ Electron\/[^ ]+/g, '') + ' Mobile'
			);
			await web.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 844,
				deviceScaleFactor: 1,
				mobile: true,
			});
			await web.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
			await web.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
				enabled: true,
				configuration: 'mobile',
			});
		} else {
			web.setUserAgent(web.session.getUserAgent());
			await web.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
			await web.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
			await web.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: false });
		}
		// spec/remote-access-and-mobile#browser-from-device: a streamed tab keeps the device's size, in the new mode's viewport.
		const stream = this.streams.get(name(entry.key, entry.tab));
		if (stream) await this.screencast(entry, stream);
		if (reload) web.reload();
	}
	// —— spec/remote-access-and-mobile#browser-from-device: the page on a device ——

	/** `browser:screen` from the device in control (dispatch checks that): the stream, its acks and the person's input. */
	async screen(owner: ScreenOwner, key: TaskKey, command: BrowserScreenCommand): Promise<unknown> {
		const id = name(key, command.tab),
			stream = this.streams.get(id);
		if (command.kind === 'start') return this.startStream(owner, key, command);
		if (command.kind === 'stop') {
			if (stream?.owner.id === owner.id) this.endStream(id, true);
			return null;
		}
		if (command.kind === 'ack') {
			if (stream?.owner.id === owner.id) stream.pacer.ack(command.frame);
			return null;
		}
		const entry = this.entries.get(id);
		if (!stream || stream.owner.id !== owner.id || !entry || entry.web.isDestroyed())
			throw new Error('The page is not on this device.');
		// A pointer passing over the page is not the person acting: no copy to the device for it.
		if (isPersonGesture(command)) stream.input = Date.now();
		const cdp = (method: string, params?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, params);
		switch (command.kind) {
			case 'mouse': {
				const type = {
					move: 'mouseMoved',
					down: 'mousePressed',
					up: 'mouseReleased',
					wheel: 'mouseWheel',
				}[command.type];
				await cdp('Input.dispatchMouseEvent', {
					type,
					x: command.x,
					y: command.y,
					button: command.button,
					buttons: command.buttons,
					clickCount: command.clickCount,
					// spec/remote-access-and-mobile#networking: Ctrl+click of a Windows or Linux device is ⌘+click on this Mac.
					modifiers:
						process.platform === 'darwin'
							? macMouseModifiers(command.modifiers, command.ctrlPrimary)
							: command.modifiers,
					...(command.type === 'wheel' ? { deltaX: command.deltaX, deltaY: command.deltaY } : {}),
				});
				return null;
			}
			case 'key': {
				// The working machine is a Mac (spec/remote-access-and-mobile#architecture): its shortcuts and editing commands.
				const mac = process.platform === 'darwin',
					key = mac
						? macKey(command)
						: {
								modifiers: command.modifiers,
								key: command.key,
								code: command.code,
								keyCode: command.keyCode,
							},
					commands =
						mac && command.type === 'down' ? macEditCommands(key.key, key.code, key.modifiers) : [];
				await cdp('Input.dispatchKeyEvent', {
					type: command.type === 'up' ? 'keyUp' : command.text ? 'keyDown' : 'rawKeyDown',
					key: key.key,
					code: key.code,
					windowsVirtualKeyCode: key.keyCode,
					modifiers: key.modifiers,
					autoRepeat: command.repeat,
					location: command.location,
					isKeypad: command.location === 3,
					...(command.text && command.type === 'down'
						? { text: command.text, unmodifiedText: command.text }
						: {}),
					...(commands.length ? { commands } : {}),
				});
				return null;
			}
			case 'text':
				await cdp('Input.insertText', { text: command.text });
				return null;
			case 'ime':
				// spec/remote-access-and-mobile#networking: the composition shows underlined in the page while the person composes.
				await cdp('Input.imeSetComposition', {
					text: command.text,
					selectionStart: command.start,
					selectionEnd: command.end,
				});
				return null;
			case 'pick':
				await cdp('Runtime.evaluate', {
					expression: `(()=>{const api=${pageApi};return api&&api.pick?api.pick(${JSON.stringify(command.id)},${JSON.stringify(command.value)}):false;})()`,
					returnByValue: true,
					userGesture: true,
					timeout: 3000,
				});
				return null;
			case 'copy': {
				await this.syncPage(entry);
				stream.copying = true;
				try {
					const result = await cdp('Runtime.evaluate', {
						expression: `(()=>{const api=${pageApi};if(!api)return null;api.clip(${JSON.stringify(command.cut ? 'cut' : 'copy')});return api.buffer();})()`,
						returnByValue: true,
						userGesture: true,
						timeout: 3000,
					});
					const text = result?.result?.value;
					return typeof text === 'string' ? text : null;
				} finally {
					stream.copying = false;
				}
			}
			case 'paste':
				await this.syncPage(entry);
				await cdp('Runtime.evaluate', {
					expression: `(()=>{const api=${pageApi};if(!api)return;api.put(${JSON.stringify(command.text)});api.paste();})()`,
					userGesture: true,
					timeout: 3000,
				});
				return null;
		}
	}
	private async startStream(
		owner: ScreenOwner,
		key: TaskKey,
		command: Extract<BrowserScreenCommand, { kind: 'start' }>
	) {
		const id = name(key, command.tab),
			existing = this.streams.get(id);
		// One device at a time (spec/remote-access-and-mobile#architecture): another owner's stream of this tab ends.
		if (existing && existing.owner.id !== owner.id) this.endStream(id, false, true);
		const entry = await this.get(key, command.tab);
		await entry.reopening;
		if (entry.web.isDestroyed()) throw new Error('The page closed.');
		// The page leaves this machine's window (the cover is over it) and the invisible one: it is drawn for the device.
		if (this.shown.has(id)) {
			const window = this.window();
			if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
			this.shown.delete(id);
		}
		this.unpark(entry);
		if (entry.frozen) {
			entry.frozen = false;
			this.lifecycle_(entry, 'active');
		}
		const format: BrowserScreenFormat = command.formats.includes('webp') ? 'webp' : 'jpeg';
		let stream = this.streams.get(id);
		if (!stream) {
			const web = entry.web;
			stream = {
				owner,
				key,
				tab: command.tab,
				format,
				metrics: browserScreenMetrics(command, entry.mobile),
				request: command,
				pacer: new ScreenPacer((session) => {
					if (!web.isDestroyed())
						void web.debugger
							.sendCommand('Page.screencastFrameAck', { sessionId: session })
							.catch(() => {});
				}),
				input: 0,
				copying: false,
				ask: `${pageDialogPath}${randomUUID()}`,
				leaveUntil: 0,
				leaving: false,
				started: '',
			};
			this.streams.set(id, stream);
			this.watchStreams();
		} else {
			stream.request = command;
			if (stream.format !== format) stream.started = '';
			stream.format = format;
		}
		await this.screencast(entry, stream);
		void this.syncPage(entry);
		this.update(entry);
		this.focusChanged();
		return this.state(entry);
	}
	/** The page drawn at the panel's size and the device's ratio, focused for itself, frames on. */
	private async screencast(entry: Entry, stream: Stream) {
		const cdp = (method: string, params?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, params);
		const metrics = browserScreenMetrics(stream.request, entry.mobile),
			signature = JSON.stringify({ ...metrics, format: stream.format });
		stream.metrics = metrics;
		await cdp('Emulation.setDeviceMetricsOverride', {
			width: metrics.width,
			height: metrics.height,
			deviceScaleFactor: metrics.scale,
			mobile: metrics.mobile,
		});
		await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
		if (signature === stream.started) return;
		stream.started = signature;
		await cdp('Page.stopScreencast').catch(() => {});
		await cdp('Page.startScreencast', {
			format: stream.format,
			quality: 50,
			maxWidth: metrics.maxWidth,
			maxHeight: metrics.maxHeight,
			everyNthFrame: 1,
		});
	}
	private screenFrame(entry: Entry, params: any) {
		const stream = this.streams.get(name(entry.key, entry.tab)),
			session = params?.sessionId;
		if (!stream) {
			if (!entry.web.isDestroyed())
				void entry.web.debugger
					.sendCommand('Page.screencastFrameAck', { sessionId: session })
					.catch(() => {});
			return;
		}
		const data = Buffer.from(String(params?.data ?? ''), 'base64'),
			metadata = params?.metadata ?? {};
		stream.pacer.frameIn(session, data.length, (frame) =>
			stream.owner.send(
				{
					key: entry.key,
					tab: entry.tab,
					kind: 'frame',
					frame,
					format: stream.format,
					data,
					width: Number(metadata.deviceWidth) || stream.metrics.width,
					height: Number(metadata.deviceHeight) || stream.metrics.height,
				},
				true
			)
		);
	}
	/**
	 * spec/remote-access-and-mobile#browser-from-device: the page script's synchronous request for a dialog; it never reaches the network. The device in
	 * control answers it in its own modal dialog; anything else is a cancel.
	 */
	private async pageQuestion(entry: Entry, params: any, session?: string) {
		const requestId = params?.requestId,
			request = params?.request ?? {},
			stream = this.streams.get(name(entry.key, entry.tab));
		if (entry.web.isDestroyed()) return;
		const cdp = (method: string, value?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, value, session);
		const fulfill = (answer: PageAnswer) =>
			cdp('Fetch.fulfillRequest', {
				requestId,
				responseCode: 200,
				responseHeaders: [
					{ name: 'Content-Type', value: 'application/json' },
					{ name: 'Cache-Control', value: 'no-store' },
				],
				body: Buffer.from(JSON.stringify({ answer })).toString('base64'),
			}).catch(() => {});
		if (typeof request.url !== 'string' || !request.url.includes(pageDialogPath))
			return void cdp('Fetch.continueRequest', { requestId }).catch(() => {});
		if (!stream || !request.url.includes(stream.ask)) return void fulfill(null);
		let question: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(String(request.postData ?? '{}'));
			if (isRecord(parsed)) question = parsed;
		} catch {
			// A question without its text is still asked.
		}
		const clean = (value: unknown) =>
			String(value ?? '')
				.replace(/\0/g, '')
				.slice(0, 4000);
		const type =
			question.type === 'confirm' || question.type === 'prompt' ? question.type : 'alert';
		// The site that asks: the page's, or a cross-site frame's own — never the request's, which the page names.
		const url = session
			? String((await cdp('Target.getTargetInfo').catch(() => null))?.targetInfo?.url ?? '')
			: entry.web.getURL();
		// The person turned this page's dialogs off — alert closes, confirm and prompt cancel, the device sees nothing.
		if (entry.dialogsMuted)
			return void fulfill(type === 'alert' ? true : type === 'confirm' ? false : null);
		const reply = await stream.owner.ask({
			type,
			site: (browserUrl(url)?.host ?? '').slice(0, 300),
			message: clean(question.message),
			value: clean(question.value),
			mute: Date.now() - entry.dialogClosedAt < pageDialogRepeatMs,
		});
		entry.dialogClosedAt = Date.now();
		if (reply.mute) entry.dialogsMuted = true;
		await fulfill(reply.answer);
	}
	/** `beforeunload` held a navigation of a streamed page: the device asks; «Leave» repeats the person's step. */
	private async askLeave(entry: Entry, stream: Stream) {
		if (stream.leaving) return;
		stream.leaving = true;
		const asked = Date.now(),
			nav = entry.lastNav;
		try {
			const { answer } = await stream.owner.ask({
				type: 'beforeunload',
				site: (browserUrl(entry.web.getURL())?.host ?? '').slice(0, 300),
				message: '',
				value: '',
				mute: false,
			});
			if (answer !== true || this.streams.get(name(entry.key, entry.tab)) !== stream) return;
			stream.leaveUntil = Date.now() + 30_000;
			if (nav && asked - nav.at < 3000 && entry.lastNav === nav) {
				entry.lastNav = null;
				void this.command(entry.key, { ...nav.command, tab: entry.tab }).catch(() => {});
			}
		} finally {
			stream.leaving = false;
		}
	}
	/** A file input of a streamed page: the device chooses, this machine gets the files (spec/remote-access-and-mobile#browser-from-device). */
	private async chooseFiles(entry: Entry, params: any, session?: string) {
		const stream = this.streams.get(name(entry.key, entry.tab)),
			node = params?.backendNodeId;
		if (!stream || typeof node !== 'number') return;
		const cdp = (method: string, value?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, value, session);
		let accept = '';
		try {
			const resolved = await cdp('DOM.resolveNode', { backendNodeId: node });
			const result = await cdp('Runtime.callFunctionOn', {
				objectId: resolved.object.objectId,
				functionDeclaration: 'function(){return String(this.accept||"")}',
				returnByValue: true,
			});
			accept = typeof result?.result?.value === 'string' ? result.result.value : '';
			await cdp('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {});
		} catch {
			// Any file, then.
		}
		const dir = join(pageFilesRoot, randomUUID());
		entry.fileDirs.push(dir);
		const paths = await stream.owner.files({
			multiple: params?.mode === 'selectMultiple',
			extensions: acceptExtensions(accept),
			dir,
		});
		if (!paths?.length || entry.web.isDestroyed()) return;
		await cdp('DOM.setFileInputFiles', { files: paths, backendNodeId: node }).catch(() => {});
	}
	/** `window.open` and `target=_blank` of a streamed page: a new tab of the task in front, with that address. */
	private openedWindow(entry: Entry, url: string) {
		if (!this.streams.has(name(entry.key, entry.tab)) || !browserUrl(url)) return;
		const tab = freshTab();
		this.reopen.set(name(entry.key, tab), url);
		this.tabChanged(entry.key, {
			tab,
			url,
			title: '',
			loading: false,
			agent: null,
			audible: false,
			muted: false,
		});
		this.show(entry.key, tab, true);
	}
	/**
	 * A stream ends: the screencast stops; with `restore` the tab gets its own look back and the rules of spec/browser-and-simulator#background (live
	 * for the agent, else frozen); `tell` lets the device know it was the machine that ended it.
	 */
	private endStream(id: string, restore: boolean, tell = false) {
		const stream = this.streams.get(id);
		if (!stream) return;
		this.streams.delete(id);
		stream.pacer.stop();
		if (![...this.streams.values()].some((item) => item.owner.id === stream.owner.id))
			stream.owner.cancel();
		if (tell) stream.owner.send({ key: stream.key, tab: stream.tab, kind: 'end' });
		const entry = this.entries.get(id);
		if (!entry || entry.web.isDestroyed()) return;
		const cdp = (method: string, value?: Record<string, unknown>) =>
			entry.web.debugger.sendCommand(method, value).catch(() => {});
		void cdp('Page.stopScreencast');
		if (!restore) return;
		void (async () => {
			if (entry.mobile)
				await cdp('Emulation.setDeviceMetricsOverride', {
					width: 390,
					height: 844,
					deviceScaleFactor: 1,
					mobile: true,
				});
			else await cdp('Emulation.clearDeviceMetricsOverride');
			if (!entry.park) await cdp('Emulation.setFocusEmulationEnabled', { enabled: false });
			await this.syncPage(entry);
			if (this.seen(id) || this.entries.get(id) !== entry) return;
			if (this.clock.active(id))
				void this.park(entry)
					.then(() => this.syncPage(entry))
					.catch(() => this.freeze(entry));
			else this.freeze(entry);
		})();
		this.focusChanged();
	}
	/**
	 * spec/remote-access-and-mobile#browser-from-device: who controls the machine changed. A stream of a client not in control ends; while a device controls,
	 * this machine's window shows the cover, and its views leave it.
	 */
	controlChanged(active: (ownerId: string) => boolean, deviceInControl: boolean) {
		for (const [id, stream] of [...this.streams])
			if (!active(stream.owner.id)) this.endStream(id, true, true);
		if (!deviceInControl) return;
		for (const id of [...this.shown]) {
			const entry = this.entries.get(id);
			if (entry) this.hide(entry);
		}
	}
	/** A device's connection went: its streams end. */
	forgetOwner(ownerId: string) {
		for (const [id, stream] of [...this.streams])
			if (stream.owner.id === ownerId) this.endStream(id, true);
	}
	/** spec/remote-access-and-mobile#browser-from-device: frames a second and kilobytes a second of each stream, in main's log, with BRIGADIR_REMOTE_DEBUG=1. */
	private watchStreams() {
		if (!debugStreams || this.streamLog) return;
		this.streamLog = setInterval(() => {
			if (!this.streams.size) {
				clearInterval(this.streamLog!);
				this.streamLog = null;
				return;
			}
			for (const [id, stream] of this.streams) {
				const rates = stream.pacer.rates();
				console.error(
					`remote: stream ${id} ${stream.format} ${stream.metrics.maxWidth}x${stream.metrics.maxHeight} ${rates.fps} fps ${rates.kbps} KB/s, ${rates.skipped} replaced, ${rates.dropped} dropped`
				);
			}
		}, 5000);
		this.streamLog.unref?.();
	}
	isFocused() {
		return [...this.shown].some((id) => {
			const entry = this.entries.get(id);
			return Boolean(entry && !entry.web.isDestroyed() && entry.web.isFocused());
		});
	}
	/** spec/task-window-workspace#work-area.1, e2e only: input of the person on a tab (Playwright cannot type into a WebContentsView). */
	personInput(key: TaskKey, tab: string, kind: 'key' | 'down' | 'up') {
		const entry = this.entries.get(name(key, tab));
		if (entry) this.input.person(entry.web, kind);
	}
	close() {
		this.lifecycle++;
		this.clock.dispose();
		for (const key of [...this.entries.keys()]) this.discard(key);
		if (this.streamLog) clearInterval(this.streamLog);
		void rm(pageFilesRoot, { recursive: true, force: true });
	}
}
