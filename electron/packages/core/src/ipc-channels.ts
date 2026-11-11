/**
 * spec/architecture-and-platform#ipc-boundary, spec/remote-access-and-mobile#architecture: the one table of the bridge between the renderer and main. Each `DesktopBridge` member has
 * exactly one row: its IPC channel, kind (invoke or subscribe; `local` members never cross IPC), class and, for an
 * invoke, the argument validator main runs before the handler. The preload builds the named methods from it
 * (`createDesktopBridge`), main registers every handler with the row's validator, and the remote gateway (R1) will
 * route by class and reuse the same validators.
 *
 * Class: `remote` runs in the main of the working machine (almost everything); `client` runs in the main of the
 * machine whose window shows the renderer — clipboard, `openExternal`, notifications and sounds, native menus and the
 * app menu, theme and window chrome, picking or dropping local files. Some client rows still read data that lives on
 * the working machine (a PR page address, an attachment's image, the appearance's fonts); R2 splits them (spec/remote-access-and-mobile#architecture).
 * `remote: 'forbidden'` — never accepted from a remote client (spec/remote-access-and-mobile#architecture); `'guarded'` — accepted, but main refuses
 * the part a remote client may not change.
 */
import type { DesktopBridge } from './bridge';
import { isAppSettings, isHelperAgent, isHelperRun } from './settings';
import { isAgentAction, isCrewAction, isActionCrew } from './action-agents';
/** spec/appearance#evolution-redesign: an optional last argument — the capsule's one-time Helper agent. */
const helperTail = (a: readonly unknown[], n: number) =>
	a.length === n || (a.length === n + 1 && (a[n] == null || isHelperRun(a[n])));
import { isSoundName } from './notifications';
import { isNoticeCenterAction, isToastNotice } from './notice-center';
import { isContextReport } from './context-state';
import { isTaskKey, isSessionCommand } from './session';
import {
	isTaskTitle,
	isId,
	isRecord,
	projectFormatters,
	isProjectReviewNotes,
	reviewNotesLimit,
	isMainTree,
	type ProjectFormatter,
} from './workspace';
import { isProjectView, isBoardColumn } from './board';
import { isProjectMode } from './pr-board';
import { isNoteId, isNoteText } from './notes';
import { isScheduleDraft, isScheduleId } from './schedules';
import { noteChatLimits } from './note-chat';
import type { TaskSheet } from './bridge';
import { isLaunchInput } from './launch';
import { isTaskSurface, isSurfaceDraft } from './surface';
import { isSurfaceLayout } from './layout';
import {
	isAttachmentOwner,
	isAttachmentInput,
	isAttachmentId,
	isAttachmentIds,
} from './attachments';
import { isQuotaWatch } from './quota';
import { isLiveAgentRef } from './live-agents';
import { isLaunchConflictChoice } from './scope-locks';
import { isQuickAskRequest, isQuickAskId } from './quick-ask';
import { isFileId, isRepoFolderId, editorByteLimit } from './files';
import {
	isPRDraftInput,
	isPRReviewEvent,
	isPRAgentQuestion,
	isPRRefKey,
	isPRMenuRow,
	isCIRunsQuery,
	isCIWatch,
} from './pull-requests';
import { pullRequestLink, externalLink } from './external-links';
import { isWebURL } from './forge';
import {
	isGitScopeId,
	isBranchName,
	isHistoryPath,
	isHistoryQuery,
	isCommitSha,
	historyLimitMax,
} from './git-history';
/** A conflicted file of a repo: the same relative path, without `..`, as History takes. */
const isConflictPath = isHistoryPath;
import { isRelayCreate } from './relay';
import { isScopeUpdate } from './scope-controls';
import { isCrewLaunch, isAgentTemplate, isCrewTemplate } from './crew';
import { isEditorCommentInput, isCommentText, isCommentInput, isReviewSelection } from './review';
import { isRendererErrorReport } from './renderer-error';
import { isBrowserCommand } from './browser';
import { isBrowserScreenArgs } from './browser-screen';
import { isSimulatorCommand } from './simulator';
import { isTerminalCommand } from './terminal';
import { isProjectCommands, isCommandRunRef } from './project-commands';
import { isTextSearchRequest } from './search';
import { menuCommands, isMenuContext } from './menu';
import { isCodeOffset, isCodeChanges, isCodeTrigger, isCodeFormatReason } from './code-intel';
import { isBackgroundId } from './background';
import { isAttributionRange } from './attribution';
import { isChatMenuState } from './chat-menu';
import { isTerminalMenuState } from './terminal-menu';
import { isDocumentTabMenuState } from './document-tabs';
import { isMenuIconImages } from './menu-icons';
import {
	isProjectIcon,
	isProjectIconColor,
	isProjectIconHint,
	isProjectImageBytes,
	isRepoIconPath,
} from './project-icon';
import { isEditorMenuState } from './editor-menu';
import { validBranch } from './branch-name';
import { isSwitchRequest, isCreateBranchRequest, isStashSha, isRepoPath } from './branch-switch';
import { isSidebarSelection } from './sidebar';
import { isSlashCatalogRequest } from './slash-menu';
import { isChromeColors } from './chrome-colors';
import { fitsUtf8 } from './utf8';
import { isCommitBasketPlans, isCommitPaths, isCommitScopeId } from './commits';
import {
	isAgentLoginRelayRequest,
	isMachineName,
	isRemoteHost,
	isRemoteId,
	isRemotePassword,
	isRemotePort,
	remoteAuditLimit,
	remotePasswordMax,
} from './remote-access';
import {
	isRemoteFolderName,
	isRemoteFsPath,
	isRemoteUiAnswer,
	remoteUploadLimit,
} from './remote-ui';

export type IpcClass = 'remote' | 'client';
export type IpcRemote = 'forbidden' | 'guarded';
export type IpcValidator = (args: unknown[]) => boolean;
/** What the preload gives the table: the platform's own pieces, never a channel. */
export interface BridgeEnvironment {
	/** `webUtils.getPathForFile` in Electron; throws for a file that is not on disk. */
	pathForFile(file: object): string;
	readonly testCrash: string | null;
	readonly testAttentionMs: number | null;
	readonly chromePlatform: 'darwin' | 'win32' | 'linux';
	/** spec/remote-access-and-mobile#module-and-settings: the machine a window of the device shows; null for the machine's own window. */
	readonly remoteMachine: { id: string; name: string; device: string } | null;
}
/** How the bridge reaches main. The generic `invoke` stays inside the preload; the renderer sees named methods only. */
export interface BridgeTransport {
	invoke(channel: string, args: readonly unknown[]): Promise<unknown>;
	subscribe(channel: string, listener: (value: unknown) => void): () => void;
	/** Delivers to this renderer's own subscribers without a round trip (spec/composer#slash-menu). */
	emit(channel: string, value: unknown): void;
}
export interface IpcInvokeRow {
	readonly kind: 'invoke';
	readonly channel: string;
	readonly class: IpcClass;
	readonly remote?: IpcRemote;
	/** Arguments sent as the method got them, padded or cut to this many — what a plain `(a, b) => invoke(ch, a, b)` did. */
	readonly arity?: number;
	/** Arguments rebuilt from the method's (defaults, optional tails); `{ resolve }` answers without asking main. */
	readonly encode?: (
		args: any[],
		env: BridgeEnvironment
	) => readonly unknown[] | { readonly resolve: unknown };
	readonly validate: IpcValidator;
	/**
	 * spec/remote-access-and-mobile#outbox: the reply can run to megabytes — a file, its highlighting, a diff, an attachment. A remote connection
	 * runs such calls one at a time, each after its socket drained, so a client that does not read holds one in main.
	 */
	readonly bulk?: true;
}
export interface IpcSubscribeRow {
	readonly kind: 'subscribe';
	readonly channel: string;
	readonly class: IpcClass;
	readonly remote?: IpcRemote;
}
export interface IpcLocalRow {
	readonly kind: 'local';
	readonly class: IpcClass;
	readonly remote?: IpcRemote;
	readonly local: (env: BridgeEnvironment, transport: BridgeTransport) => unknown;
}
export type IpcRow = IpcInvokeRow | IpcSubscribeRow | IpcLocalRow;

const noArgs: IpcValidator = (a) => a.length === 0;
/** Node's `path.isAbsolute` on POSIX: the working machine is a Mac today (spec/remote-access-and-mobile#architecture, terms). */
const isAbsolutePath = (value: string) => value.startsWith('/');
const signature = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 8000;
const knowledgeTarget = (v: unknown) =>
	isRecord(v) &&
	Object.keys(v).length === 2 &&
	isId(v.scopeId) &&
	typeof v.path === 'string' &&
	v.path.length > 0 &&
	v.path.length <= 1024;
const prKey = (a: unknown[]) => isTaskKey(a[0]) && isPRRefKey(a[1]);
const isAgentChoices = (value: unknown) =>
	Array.isArray(value) &&
	value.length <= 16 &&
	value.every(
		(item) =>
			isRecord(item) &&
			Object.keys(item).length === 2 &&
			typeof item.id === 'string' &&
			item.id.length > 0 &&
			item.id.length <= 200 &&
			typeof item.value === 'string' &&
			item.value.length <= 200
	);
const isSheet = (value: unknown) =>
	value === undefined ||
	(isRecord(value) &&
		Object.keys(value).every(
			(key) =>
				key === 'name' ||
				key === 'options' ||
				key === 'attachments' ||
				key === 'draftId' ||
				key === 'role'
		) &&
		(value.role === undefined || value.role === null || isId(value.role)) &&
		(value.name === undefined || isTaskTitle(value.name)) &&
		(value.options === undefined || isAgentChoices(value.options)) &&
		(value.attachments === undefined || isAttachmentIds(value.attachments)) &&
		(value.draftId === undefined || isId(value.draftId)));
// spec/chat-turns-plans-and-questions#plan-approval: the plan copy is keyed by the permission request; its text comes from the transcript the renderer shows.
const isPlanArgs = (a: unknown[]) =>
	a.length === 3 &&
	isTaskKey(a[0]) &&
	typeof a[1] === 'string' &&
	a[1].length > 0 &&
	a[1].length <= 256 &&
	typeof a[2] === 'string' &&
	a[2].trim().length > 0 &&
	fitsUtf8(a[2], 1_000_000);
// spec/editor-code-intelligence#architecture: named code-intelligence methods; offsets are UTF-16 in the renderer's own document version.
const codeRequest = (a: unknown[], extra: number) =>
	a.length === 4 + extra &&
	isTaskKey(a[0]) &&
	isFileId(a[1]) &&
	isCodeOffset(a[2]) &&
	isCodeOffset(a[3]);
const commentId = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const isTree = (a: unknown[], n: number) => a.length === n && isId(a[0]) && isGitScopeId(a[1]);
const agentArg = (a: unknown[]) => a.length === 1 && (a[0] === 'claude' || a[0] === 'codex');

export const ipcTable = {
	readLiveAgents: {
		kind: 'invoke',
		channel: 'agents:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	readQuota: {
		kind: 'invoke',
		channel: 'quota:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	refreshQuota: {
		kind: 'invoke',
		channel: 'quota:refresh',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	watchQuota: {
		kind: 'invoke',
		channel: 'quota:watch',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && (a[0] === 'claude' || a[0] === 'codex') && isQuotaWatch(a[1]),
	},
	onQuotaChanged: { kind: 'subscribe', channel: 'quota:changed', class: 'remote' },
	controlLiveAgent: {
		kind: 'invoke',
		channel: 'agents:control',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isLiveAgentRef(a[0]) && (a[1] === 'stop' || a[1] === 'terminate'),
	},
	readSidebarState: {
		kind: 'invoke',
		channel: 'sidebar:read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	collapseProject: {
		kind: 'invoke',
		channel: 'sidebar:collapse',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === 'boolean',
	},
	readCollapsedCrews: {
		kind: 'invoke',
		channel: 'sidebar:crew-read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	collapseCrew: {
		kind: 'invoke',
		channel: 'sidebar:crew-collapse',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === 'boolean',
	},
	readCollapsedCompleted: {
		kind: 'invoke',
		channel: 'sidebar:completed-read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	collapseCompleted: {
		kind: 'invoke',
		channel: 'sidebar:completed-collapse',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === 'boolean',
	},
	readSelection: {
		kind: 'invoke',
		channel: 'sidebar:selection-read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	saveSelection: {
		kind: 'invoke',
		channel: 'sidebar:select',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isSidebarSelection(a[0]),
	},
	// spec/notifications-slack-notes-and-schedules#schedules: scheduled tasks.
	listSchedules: {
		kind: 'invoke',
		channel: 'schedules:list',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	readScheduleRuns: {
		kind: 'invoke',
		channel: 'schedules:runs',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isScheduleId(a[1]),
	},
	createSchedule: {
		kind: 'invoke',
		channel: 'schedules:create',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isScheduleDraft(a[1]),
	},
	editSchedule: {
		kind: 'invoke',
		channel: 'schedules:edit',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isId(a[0]) && isScheduleId(a[1]) && isScheduleDraft(a[2]),
	},
	deleteSchedule: {
		kind: 'invoke',
		channel: 'schedules:delete',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isScheduleId(a[1]),
	},
	setSchedulePaused: {
		kind: 'invoke',
		channel: 'schedules:pause',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isId(a[0]) && isScheduleId(a[1]) && typeof a[2] === 'boolean',
	},
	runScheduleNow: {
		kind: 'invoke',
		channel: 'schedules:run-now',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isScheduleId(a[1]),
	},
	resolveScheduleMissed: {
		kind: 'invoke',
		channel: 'schedules:resolve-missed',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isId(a[0]) && isScheduleId(a[1]) && (a[2] === 'run' || a[2] === 'skip'),
	},
	onSchedulesChanged: { kind: 'subscribe', channel: 'schedules:changed', class: 'remote' },
	listNotes: { kind: 'invoke', channel: 'notes:list', class: 'remote', arity: 0, validate: noArgs },
	readNote: {
		kind: 'invoke',
		channel: 'notes:read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isNoteId(a[0]),
	},
	createNote: {
		kind: 'invoke',
		channel: 'notes:create',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && (a[0] === null || isId(a[0])) && isNoteText(a[1]),
	},
	writeNote: {
		kind: 'invoke',
		channel: 'notes:write',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isNoteId(a[0]) && isNoteText(a[1]),
	},
	setNoteProject: {
		kind: 'invoke',
		channel: 'notes:set-project',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isNoteId(a[0]) && (a[1] === null || isId(a[1])),
	},
	deleteNote: {
		kind: 'invoke',
		channel: 'notes:delete',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isNoteId(a[0]),
	},
	onNotesChanged: { kind: 'subscribe', channel: 'notes:changed', class: 'remote' },
	readNoteChat: {
		kind: 'invoke',
		channel: 'notes:chat-read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isNoteId(a[0]),
	},
	sendNoteChat: {
		kind: 'invoke',
		channel: 'notes:chat-send',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isNoteId(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].trim().length > 0 &&
			a[1].length <= noteChatLimits.message &&
			isRecord(a[2]) &&
			(a[2].provider === 'claude' || a[2].provider === 'codex') &&
			(a[2].model === null || (typeof a[2].model === 'string' && a[2].model.length <= 200)),
	},
	stopNoteChat: {
		kind: 'invoke',
		channel: 'notes:chat-stop',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isNoteId(a[0]),
	},
	undoNoteEdit: {
		kind: 'invoke',
		channel: 'notes:chat-undo',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isNoteId(a[0]) && Number.isSafeInteger(a[1]),
	},
	onNoteChatEvent: { kind: 'subscribe', channel: 'notes:chat-event', class: 'remote' },
	noteMenu: {
		kind: 'invoke',
		channel: 'notes:menu',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isNoteId(a[0]),
	},
	noteTaskProjectMenu: {
		kind: 'invoke',
		channel: 'notes:task-project-menu',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	attachNote: {
		kind: 'invoke',
		channel: 'notes:attach',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isAttachmentOwner(a[0]) && isNoteId(a[1]),
	},
	linkNoteTask: {
		kind: 'invoke',
		channel: 'notes:link-task',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isNoteId(a[0]) &&
			isRecord(a[1]) &&
			isId(a[1].projectId) &&
			isId(a[1].id) &&
			typeof a[1].title === 'string' &&
			a[1].title.length <= 400 &&
			(a[2] === null || (Number.isSafeInteger(a[2]) && Number(a[2]) >= 1)),
	},
	noteProjectMenu: {
		kind: 'invoke',
		channel: 'notes:project-menu',
		class: 'client',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isNoteId(a[0]) &&
			[a[1], a[2]].every((value) => typeof value === 'number' && Number.isFinite(value)),
	},
	readKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	prepareKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:prepare',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isId(a[0]) && signature(a[1]) && knowledgeTarget(a[2]),
	},
	generateKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:generate',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isId(a[0]) && signature(a[1]) && isId(a[2]),
	},
	cancelKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:cancel',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	rejectKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:reject',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && signature(a[1]),
	},
	restoreKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:restore',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && signature(a[1]),
	},
	addKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:add',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isId(a[0]) &&
			signature(a[1]) &&
			isId(a[2]) &&
			typeof a[3] === 'string' &&
			a[3].length <= 16000,
	},
	dismissKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:dismiss',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isId(a[1]),
	},
	undoKnowledge: {
		kind: 'invoke',
		channel: 'knowledge:undo',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isId(a[1]),
	},
	readKnowledgeFile: {
		kind: 'invoke',
		channel: 'knowledge:file',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && knowledgeTarget(a[1]),
	},
	requestGhost: {
		kind: 'invoke',
		channel: 'ghost:request',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			Number.isSafeInteger(a[1]) &&
			Number(a[1]) > 0 &&
			isId(a[2]),
	},
	cancelGhost: {
		kind: 'invoke',
		channel: 'ghost:cancel',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	askQuickQuestion: {
		kind: 'invoke',
		channel: 'quick:ask',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isQuickAskRequest(a[1]),
	},
	askQuickFollowUp: {
		kind: 'invoke',
		channel: 'quick:follow-up',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isQuickAskId(a[1]) &&
			typeof a[2] === 'string' &&
			a[2].trim().length > 0 &&
			a[2].length <= 4000,
	},
	stopQuickQuestion: {
		kind: 'invoke',
		channel: 'quick:stop',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isQuickAskId(a[0]),
	},
	closeQuickQuestion: {
		kind: 'invoke',
		channel: 'quick:close',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isQuickAskId(a[0]),
	},
	answerQuickPermission: {
		kind: 'invoke',
		channel: 'quick:permission',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isQuickAskId(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 200 &&
			(a[2] === null || (typeof a[2] === 'string' && a[2].length <= 200)),
	},
	revertQuickChange: {
		kind: 'invoke',
		channel: 'quick:revert',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			isRecord(a[2]) &&
			Number.isSafeInteger(a[2].base) &&
			Number.isSafeInteger(a[2].current) &&
			Number(a[2].base) >= 0 &&
			Number(a[2].current) > Number(a[2].base),
	},
	onQuickAskEvent: { kind: 'subscribe', channel: 'quick:event', class: 'remote' },
	readForge: {
		kind: 'invoke',
		channel: 'forge:read',
		class: 'remote',
		encode: ([key, remote, fresh]) => [key, remote, fresh === true],
		validate: (a) =>
			a.length === 3 && isTaskKey(a[0]) && typeof a[1] === 'boolean' && typeof a[2] === 'boolean',
	},
	preparePush: {
		kind: 'invoke',
		channel: 'forge:prepare-push',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	pushChanges: {
		kind: 'invoke',
		channel: 'forge:push',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	preparePullRequest: {
		kind: 'invoke',
		channel: 'forge:prepare-pr',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	checkPullRequest: {
		kind: 'invoke',
		channel: 'forge:check-pr',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isId(a[1]) &&
			isRecord(a[2]) &&
			typeof a[2].head === 'string' &&
			a[2].head.length > 0 &&
			a[2].head.length <= 512 &&
			typeof a[2].base === 'string' &&
			a[2].base.length > 0 &&
			a[2].base.length <= 512,
	},
	createPullRequest: {
		kind: 'invoke',
		channel: 'forge:create-pr',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isId(a[1]) &&
			isRecord(a[2]) &&
			typeof a[2].title === 'string' &&
			a[2].title.trim().length > 0 &&
			a[2].title.length <= 1000 &&
			typeof a[2].body === 'string' &&
			a[2].body.length <= 100000 &&
			typeof a[2].branch === 'string' &&
			a[2].branch.length <= 512 &&
			typeof a[2].head === 'string' &&
			a[2].head.length <= 512 &&
			typeof a[2].base === 'string' &&
			a[2].base.length <= 512 &&
			typeof a[2].web === 'boolean',
	},
	generatePullRequest: {
		kind: 'invoke',
		channel: 'forge:generate',
		class: 'remote',
		arity: 3,
		validate: (a) => helperTail(a, 2) && isTaskKey(a[0]) && isId(a[1]),
	},
	discardForgeDraft: {
		kind: 'invoke',
		channel: 'forge:discard',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	hidePullRequestSuggestion: {
		kind: 'invoke',
		channel: 'forge:hide-suggestion',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	readPullRequest: {
		kind: 'invoke',
		channel: 'forge:details',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	openPullRequest: {
		kind: 'invoke',
		channel: 'forge:open',
		class: 'client',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	createScopeBranch: {
		kind: 'invoke',
		channel: 'forge:branch',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isId(a[1]) &&
			typeof a[2] === 'string' &&
			a[2].length <= 240,
	},
	openMainTree: {
		kind: 'invoke',
		channel: 'main-tree:open',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	readMainTreeBranch: {
		kind: 'invoke',
		channel: 'main-tree:branch',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isId(a[0]) && isId(a[1]) && typeof a[2] === 'string' && validBranch(a[2]),
	},
	switchMainTreeBranch: {
		kind: 'invoke',
		channel: 'main-tree:switch',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isId(a[0]) && isId(a[1]) && typeof a[2] === 'string' && validBranch(a[2]),
	},
	readBranchSwitch: {
		kind: 'invoke',
		channel: 'main-tree:switch-state',
		class: 'remote',
		encode: ([projectId, scopeId, fetch]) => [projectId, scopeId, fetch === true],
		validate: (a) =>
			(a.length === 2 || (a.length === 3 && typeof a[2] === 'boolean')) &&
			isId(a[0]) &&
			isGitScopeId(a[1]),
	},
	switchBranchTo: {
		kind: 'invoke',
		channel: 'main-tree:switch-to',
		class: 'remote',
		arity: 3,
		validate: (a) => isTree(a, 3) && isSwitchRequest(a[2]),
	},
	createMainTreeBranch: {
		kind: 'invoke',
		channel: 'main-tree:create-branch',
		class: 'remote',
		arity: 3,
		validate: (a) => isTree(a, 3) && isCreateBranchRequest(a[2]),
	},
	readStashes: {
		kind: 'invoke',
		channel: 'main-tree:stashes',
		class: 'remote',
		arity: 2,
		validate: (a) => isTree(a, 2),
	},
	stashChanges: {
		kind: 'invoke',
		channel: 'main-tree:stash',
		class: 'remote',
		arity: 2,
		validate: (a) => isTree(a, 2),
	},
	restoreStash: {
		kind: 'invoke',
		channel: 'main-tree:stash-restore',
		class: 'remote',
		arity: 3,
		validate: (a) => isTree(a, 3) && isStashSha(a[2]),
	},
	dropStash: {
		kind: 'invoke',
		channel: 'main-tree:stash-drop',
		class: 'remote',
		arity: 3,
		validate: (a) => isTree(a, 3) && isStashSha(a[2]),
	},
	pullBranch: {
		kind: 'invoke',
		channel: 'main-tree:pull',
		class: 'remote',
		encode: ([projectId, scopeId, taskId]) => [projectId, scopeId, taskId ?? null],
		validate: (a) =>
			isTree(a, 2) ||
			(a.length === 3 && isId(a[0]) && isGitScopeId(a[1]) && (a[2] === null || isId(a[2]))),
	},
	undoLastCommit: {
		kind: 'invoke',
		channel: 'main-tree:undo-commit',
		class: 'remote',
		arity: 2,
		validate: (a) => isTree(a, 2),
	},
	discardChanges: {
		kind: 'invoke',
		channel: 'main-tree:discard',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			isTree(a, 3) && Array.isArray(a[2]) && a[2].length <= 5000 && a[2].every(isRepoPath),
	},
	preparePullRequestTrees: {
		kind: 'invoke',
		channel: 'prs:prepare',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	readPullRequestFiles: {
		kind: 'invoke',
		channel: 'prs:files',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	readPullRequestFileDiff: {
		kind: 'invoke',
		bulk: true,
		channel: 'prs:file-diff',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			prKey(a) &&
			typeof a[2] === 'string' &&
			a[2].length > 0 &&
			a[2].length <= 4096,
	},
	findPullRequestDefinition: {
		kind: 'invoke',
		channel: 'prs:definition',
		class: 'remote',
		arity: 6,
		validate: (a) =>
			a.length === 6 &&
			prKey(a) &&
			typeof a[2] === 'string' &&
			a[2].length > 0 &&
			a[2].length <= 4096 &&
			Number.isSafeInteger(a[3]) &&
			(a[3] as number) > 0 &&
			Number.isSafeInteger(a[4]) &&
			(a[4] as number) > 0 &&
			typeof a[5] === 'string' &&
			a[5].length <= 65536,
	},
	readPullRequestReview: {
		kind: 'invoke',
		channel: 'prs:draft-read',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	readPullRequestReviewStates: {
		kind: 'invoke',
		channel: 'prs:review-states',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isId(a[0]) &&
			Array.isArray(a[1]) &&
			a[1].length <= 1000 &&
			a[1].every(isPRRefKey),
	},
	notePullRequestViewed: {
		kind: 'invoke',
		channel: 'prs:draft-viewed',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			prKey(a) &&
			Number.isSafeInteger(a[2]) &&
			Number.isSafeInteger(a[3]) &&
			(a[2] as number) >= 0 &&
			(a[2] as number) <= (a[3] as number),
	},
	pullRequestMenu: {
		kind: 'invoke',
		channel: 'prs:menu',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && isPRMenuRow(a[2]),
	},
	addPullRequestDraft: {
		kind: 'invoke',
		channel: 'prs:draft-add',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && isPRDraftInput(a[2]),
	},
	editPullRequestDraft: {
		kind: 'invoke',
		channel: 'prs:draft-edit',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			prKey(a) &&
			isId(a[2]) &&
			typeof a[3] === 'string' &&
			a[3].trim().length > 0 &&
			a[3].length <= 65536,
	},
	removePullRequestDraft: {
		kind: 'invoke',
		channel: 'prs:draft-remove',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && isId(a[2]),
	},
	discussPullRequestDraft: {
		kind: 'invoke',
		channel: 'prs:draft-discuss',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			prKey(a) &&
			isId(a[2]) &&
			typeof a[3] === 'string' &&
			a[3].trim().length > 0 &&
			a[3].length <= 65536,
	},
	setPullRequestReview: {
		kind: 'invoke',
		channel: 'prs:review-set',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			prKey(a) &&
			isRecord(a[2]) &&
			// Security review W2: only the form's fields; the handler spreads the patch over the draft file.
			Object.keys(a[2]).every((name) => ['body', 'event', 'sendComments'].includes(name)) &&
			(a[2].body === undefined || (typeof a[2].body === 'string' && a[2].body.length <= 65536)) &&
			(a[2].event === undefined || isPRReviewEvent(a[2].event)) &&
			(a[2].sendComments === undefined || typeof a[2].sendComments === 'boolean'),
	},
	submitPullRequestReview: {
		kind: 'invoke',
		channel: 'prs:submit',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	commentPullRequestNow: {
		kind: 'invoke',
		channel: 'prs:comment-now',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && isPRDraftInput(a[2]),
	},
	commentPullRequest: {
		kind: 'invoke',
		channel: 'prs:comment',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			prKey(a) &&
			typeof a[2] === 'string' &&
			a[2].trim().length > 0 &&
			a[2].length <= 65536,
	},
	resolvePullRequestThread: {
		kind: 'invoke',
		channel: 'prs:resolve',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			prKey(a) &&
			typeof a[2] === 'string' &&
			/^[\w=-]{1,200}$/.test(a[2]) &&
			typeof a[3] === 'boolean',
	},
	markPullRequestFileViewed: {
		kind: 'invoke',
		channel: 'prs:viewed',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			prKey(a) &&
			typeof a[2] === 'string' &&
			a[2].length > 0 &&
			a[2].length <= 4096 &&
			typeof a[3] === 'boolean',
	},
	readPullRequestSummary: {
		kind: 'invoke',
		channel: 'prs:summary-read',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	generatePullRequestSummary: {
		kind: 'invoke',
		channel: 'prs:summary',
		class: 'remote',
		arity: 3,
		validate: (a) => helperTail(a, 2) && prKey(a),
	},
	stopPullRequestSummary: {
		kind: 'invoke',
		channel: 'prs:summary-stop',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	acceptPullRequestDraft: {
		kind: 'invoke',
		channel: 'prs:draft-accept',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && isId(a[2]),
	},
	writePullRequestReviewBody: {
		kind: 'invoke',
		channel: 'prs:review-body',
		class: 'remote',
		arity: 3,
		validate: (a) => helperTail(a, 2) && prKey(a),
	},
	suggestPullRequestVerdict: {
		kind: 'invoke',
		channel: 'prs:verdict',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	askPullRequestAgent: {
		kind: 'invoke',
		channel: 'prs:ask',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && isPRAgentQuestion(a[2]),
	},
	resolvePullRequestConflicts: {
		kind: 'invoke',
		channel: 'prs:resolve-conflicts',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && prKey(a) && (a[2] === 'agent' || a[2] === 'manual'),
	},
	startPullRequestAgent: {
		kind: 'invoke',
		channel: 'prs:agent-task',
		class: 'remote',
		// spec/appearance#evolution-redesign: a 7th `true` — the review was asked from step 2 of the review modal (agent suggestions in review).
		// spec/pull-requests-and-ci#review-crew: an 8th — the library crew of this review (the Crew segment); the 7th is then `false` when it is no suggestion.
		// spec/pull-requests-and-ci#review-launch: a 9th — the person's instructions for this review, sent only when there are some.
		encode: ([key, ref, mode, sendComments, where, agent, suggestions, crew, notes]) =>
			typeof notes === 'string' && notes.trim()
				? [
						key,
						ref,
						mode,
						sendComments,
						where ?? null,
						agent ?? null,
						suggestions === true,
						crew ?? null,
						notes,
					]
				: typeof crew === 'string'
					? [key, ref, mode, sendComments, where ?? null, agent ?? null, suggestions === true, crew]
					: suggestions === true
						? [key, ref, mode, sendComments, where ?? null, agent ?? null, true]
						: agent
							? [key, ref, mode, sendComments, where ?? null, agent]
							: where
								? [key, ref, mode, sendComments, where]
								: [key, ref, mode, sendComments],
		validate: (a) =>
			(a.length === 4 ||
				(a.length === 5 && (a[4] === 'quick' || a[4] === 'worktree')) ||
				(a.length === 6 &&
					(a[4] === null || a[4] === 'quick' || a[4] === 'worktree') &&
					isHelperRun(a[5])) ||
				(a.length === 7 &&
					(a[4] === null || a[4] === 'quick' || a[4] === 'worktree') &&
					(a[5] === null || isHelperRun(a[5])) &&
					a[6] === true &&
					a[2] === 'review') ||
				(a.length === 8 &&
					(a[4] === null || a[4] === 'quick' || a[4] === 'worktree') &&
					a[5] === null &&
					typeof a[6] === 'boolean' &&
					isId(a[7]) &&
					a[2] === 'review') ||
				(a.length === 9 &&
					(a[4] === null || a[4] === 'quick' || a[4] === 'worktree') &&
					(a[5] === null || isHelperRun(a[5])) &&
					typeof a[6] === 'boolean' &&
					(a[7] === null || (isId(a[7]) && a[5] === null)) &&
					typeof a[8] === 'string' &&
					a[8].trim().length > 0 &&
					a[8].length <= reviewNotesLimit &&
					a[2] === 'review')) &&
			prKey(a) &&
			(a[2] === 'review' || a[2] === 'fix') &&
			typeof a[3] === 'boolean',
	},
	readyPullRequest: {
		kind: 'invoke',
		channel: 'prs:ready',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && prKey(a),
	},
	mergePullRequest: {
		kind: 'invoke',
		channel: 'prs:merge',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			prKey(a) &&
			(a[2] === 'squash' || a[2] === 'merge' || a[2] === 'rebase') &&
			typeof a[3] === 'boolean',
	},
	readPullRequests: {
		kind: 'invoke',
		channel: 'prs:list',
		class: 'remote',
		encode: ([projectId, taskId, fresh]) => [projectId, taskId, fresh === true],
		validate: (a) =>
			a.length === 3 && isId(a[0]) && (a[1] === null || isId(a[1])) && typeof a[2] === 'boolean',
	},
	readPullRequestDetail: {
		kind: 'invoke',
		channel: 'prs:detail',
		class: 'remote',
		encode: ([projectId, taskId, ref, fresh]) => [projectId, taskId, ref, fresh === true],
		validate: (a) =>
			a.length === 4 &&
			isId(a[0]) &&
			(a[1] === null || isId(a[1])) &&
			isPRRefKey(a[2]) &&
			typeof a[3] === 'boolean',
	},
	readCIRuns: {
		kind: 'invoke',
		channel: 'prs:ci-runs',
		class: 'remote',
		encode: ([projectId, taskId, scopeId, query, fresh]) => [
			projectId,
			taskId,
			scopeId,
			query,
			fresh === true,
		],
		validate: (a) =>
			a.length === 5 &&
			isId(a[0]) &&
			(a[1] === null || isId(a[1])) &&
			isId(a[2]) &&
			isCIRunsQuery(a[3]) &&
			typeof a[4] === 'boolean',
	},
	readCIRun: {
		kind: 'invoke',
		channel: 'prs:ci-run',
		class: 'remote',
		encode: ([projectId, taskId, scopeId, runId, fresh]) => [
			projectId,
			taskId,
			scopeId,
			runId,
			fresh === true,
		],
		validate: (a) =>
			a.length === 5 &&
			isId(a[0]) &&
			(a[1] === null || isId(a[1])) &&
			isId(a[2]) &&
			Number.isSafeInteger(a[3]) &&
			Number(a[3]) > 0 &&
			typeof a[4] === 'boolean',
	},
	watchCIRun: {
		kind: 'invoke',
		channel: 'prs:ci-watch',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isCIWatch(a[0]) && typeof a[1] === 'boolean',
	},
	readCIWatches: {
		kind: 'invoke',
		channel: 'prs:ci-watches',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	onCIWatches: { kind: 'subscribe', channel: 'ci:watches', class: 'remote' },
	onCIFinished: { kind: 'subscribe', channel: 'ci:finished', class: 'remote' },
	onCIOpen: { kind: 'subscribe', channel: 'ci:open', class: 'client' },
	openPullRequestPage: {
		kind: 'invoke',
		channel: 'prs:open',
		class: 'client',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isId(a[0]) &&
			(a[1] === null || isId(a[1])) &&
			isId(a[2]) &&
			(a[3] === null || (Number.isSafeInteger(a[3]) && Number(a[3]) > 0)),
	},
	openPullRequestLink: {
		kind: 'invoke',
		channel: 'prs:link',
		class: 'client',
		arity: 4,
		validate: (a) =>
			a.length === 4 && isId(a[0]) && (a[1] === null || isId(a[1])) && isId(a[2]) && isWebURL(a[3]),
	},
	openWebLink: {
		kind: 'invoke',
		channel: 'links:open',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && externalLink(a[0]) !== null,
	},
	resolvePullRequestLink: {
		kind: 'invoke',
		channel: 'prs:resolve-link',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isId(a[0]) &&
			(a[1] === null || isId(a[1])) &&
			pullRequestLink(a[2]) !== null,
	},
	readCommits: {
		kind: 'invoke',
		channel: 'commits:read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	commitChanges: {
		kind: 'invoke',
		channel: 'commits:run',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			a[2].trim().length > 0 &&
			fitsUtf8(a[2], 16000),
	},
	generateCommitMessage: {
		kind: 'invoke',
		channel: 'commits:generate',
		class: 'remote',
		arity: 3,
		validate: (a) => helperTail(a, 2) && isTaskKey(a[0]) && isFileId(a[1]),
	},
	commitBaskets: {
		kind: 'invoke',
		channel: 'commits:baskets',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && isCommitBasketPlans(a[2]),
	},
	onCommitProgress: { kind: 'subscribe', channel: 'commits:progress', class: 'remote' },
	generateBasketMessage: {
		kind: 'invoke',
		channel: 'commits:generate-basket',
		class: 'remote',
		arity: 5,
		validate: (a) =>
			helperTail(a, 4) &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			isCommitScopeId(a[2]) &&
			isCommitPaths(a[3]),
	},
	splitCommits: {
		kind: 'invoke',
		channel: 'commits:split',
		class: 'remote',
		arity: 3,
		validate: (a) => helperTail(a, 2) && isTaskKey(a[0]) && isFileId(a[1]),
	},
	stopCommitSplit: {
		kind: 'invoke',
		channel: 'commits:split-stop',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readCommitFile: {
		kind: 'invoke',
		bulk: true,
		channel: 'commits:file',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && isFileId(a[2]),
	},
	openCommitFile: {
		kind: 'invoke',
		channel: 'commits:editor',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && isFileId(a[2]),
	},
	readHistoryScopes: {
		kind: 'invoke',
		channel: 'git:scopes',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readBranches: {
		kind: 'invoke',
		channel: 'git:branches',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isGitScopeId(a[1]),
	},
	readHistory: {
		kind: 'invoke',
		channel: 'git:history',
		class: 'remote',
		encode: ([key, scopeId, branch, path, limit, query]) => [
			key,
			scopeId,
			branch,
			path ?? null,
			limit ?? 100,
			query ?? null,
		],
		validate: (a) =>
			a.length >= 3 &&
			a.length <= 6 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			isBranchName(a[2]) &&
			(a[3] === undefined || a[3] === null || isHistoryPath(a[3])) &&
			(a[4] === undefined ||
				(Number.isSafeInteger(a[4]) && Number(a[4]) >= 1 && Number(a[4]) <= historyLimitMax)) &&
			(a[5] === undefined || a[5] === null || isHistoryQuery(a[5])),
	},
	readEditorBlame: {
		kind: 'invoke',
		channel: 'files:blame',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			fitsUtf8(a[2], editorByteLimit),
	},
	readBlameMessage: {
		kind: 'invoke',
		channel: 'files:blame-message',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && isCommitSha(a[2]),
	},
	readHistoryCommit: {
		kind: 'invoke',
		channel: 'git:commit',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && isGitScopeId(a[1]) && isCommitSha(a[2]),
	},
	readHistoryFile: {
		kind: 'invoke',
		bulk: true,
		channel: 'git:commit-file',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			isCommitSha(a[2]) &&
			isFileId(a[3]),
	},
	previewMerge: {
		kind: 'invoke',
		channel: 'git:merge-preview',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			isBranchName(a[2]) &&
			isBranchName(a[3]),
	},
	startMerge: {
		kind: 'invoke',
		channel: 'git:merge',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			isBranchName(a[2]) &&
			isBranchName(a[3]),
	},
	readMergeState: {
		kind: 'invoke',
		channel: 'git:merge-state',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isGitScopeId(a[1]),
	},
	resolveConflict: {
		kind: 'invoke',
		channel: 'git:conflict-take',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			typeof a[2] === 'string' &&
			a[2].length > 0 &&
			a[2].length <= 4096 &&
			!a[2].includes('\0') &&
			(a[3] === 'ours' || a[3] === 'theirs' || a[3] === 'both'),
	},
	markConflictResolved: {
		kind: 'invoke',
		channel: 'git:conflict-resolved',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			typeof a[2] === 'string' &&
			a[2].length > 0 &&
			a[2].length <= 4096 &&
			!a[2].includes('\0'),
	},
	finishMerge: {
		kind: 'invoke',
		channel: 'git:merge-finish',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isGitScopeId(a[1]),
	},
	abortMerge: {
		kind: 'invoke',
		channel: 'git:merge-abort',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isGitScopeId(a[1]),
	},
	// spec/appearance#evolution-redesign: the files the person gives the agent (a row, the selected ones, the merge view); none — all of them.
	askAgentToResolve: {
		kind: 'invoke',
		channel: 'git:merge-agent',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			(a[2] === undefined ||
				a[2] === null ||
				(Array.isArray(a[2]) &&
					a[2].length > 0 &&
					a[2].length <= 1000 &&
					a[2].every(isConflictPath))),
	},
	stopConflictAgent: {
		kind: 'invoke',
		channel: 'git:merge-agent-stop',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isGitScopeId(a[1]),
	},
	readMergeStates: {
		kind: 'invoke',
		channel: 'git:merge-states',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readConflictTexts: {
		kind: 'invoke',
		bulk: true,
		channel: 'git:conflict-texts',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isTaskKey(a[0]) && isGitScopeId(a[1]) && isConflictPath(a[2]),
	},
	applyConflict: {
		kind: 'invoke',
		bulk: true,
		channel: 'git:conflict-apply',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isGitScopeId(a[1]) &&
			isConflictPath(a[2]) &&
			typeof a[3] === 'string' &&
			a[3].length <= 2 * 1024 * 1024 &&
			fitsUtf8(a[3], 4 * 1024 * 1024),
	},
	reopenConflict: {
		kind: 'invoke',
		channel: 'git:conflict-reopen',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isTaskKey(a[0]) && isGitScopeId(a[1]) && isConflictPath(a[2]),
	},
	prepareRelay: {
		kind: 'invoke',
		channel: 'relay:prepare',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	summarizeRelay: {
		kind: 'invoke',
		channel: 'relay:summary',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	stopRelaySummary: {
		kind: 'invoke',
		channel: 'relay:summary-stop',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	discardRelay: {
		kind: 'invoke',
		channel: 'relay:discard',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	createRelayTask: {
		kind: 'invoke',
		channel: 'relay:create',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isRelayCreate(a[0]),
	},
	createProposedTask: {
		kind: 'invoke',
		channel: 'proposal:create',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isTaskKey(a[0]) && typeof a[1] === 'string' && a[1].length <= 64,
	},
	draftProposedTask: {
		kind: 'invoke',
		channel: 'proposal:draft',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 64 &&
			isAttachmentOwner(a[2]),
	},
	adoptProposedTask: {
		kind: 'invoke',
		channel: 'proposal:adopt',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 64 &&
			isTaskKey(a[2]),
	},
	declineProposedTask: {
		kind: 'invoke',
		channel: 'proposal:decline',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isTaskKey(a[0]) && typeof a[1] === 'string' && a[1].length <= 64,
	},
	readScopePanel: {
		kind: 'invoke',
		channel: 'scopes:read',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && (a[1] === null || isId(a[1])),
	},
	updateScope: {
		kind: 'invoke',
		channel: 'scopes:update',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isId(a[0]) && (a[1] === null || isId(a[1])) && isScopeUpdate(a[2]),
	},
	collapseScopes: {
		kind: 'invoke',
		channel: 'scopes:collapse',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === 'boolean',
	},
	readLaunchConflict: {
		kind: 'invoke',
		channel: 'launch:conflict',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	resolveLaunchConflict: {
		kind: 'invoke',
		channel: 'launch:resolve',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && typeof a[0] === 'string' && isLaunchConflictChoice(a[1]),
	},
	onLaunchConflict: { kind: 'subscribe', channel: 'launch:conflict', class: 'remote' },
	readScopeLocks: {
		kind: 'invoke',
		channel: 'launch:locks',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readPreparationLog: {
		kind: 'invoke',
		channel: 'launch:log',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	removeWorktree: {
		kind: 'invoke',
		channel: 'launch:remove-worktree',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readBaseRefs: {
		kind: 'invoke',
		channel: 'launch:refs',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	addProjectFolder: {
		kind: 'invoke',
		channel: 'launch:add-folder',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isId(a[0]) &&
			Array.isArray(a[1]) &&
			a[1].length <= 200 &&
			a[1].every((name) => typeof name === 'string' && name.length <= 500),
	},
	addScopeFolder: {
		kind: 'invoke',
		channel: 'scopes:add-folder',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isId(a[1]),
	},
	searchProjectFiles: {
		kind: 'invoke',
		channel: 'launch:search-files',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === 'string' && a[1].length <= 200,
	},
	readLaunchSettings: {
		kind: 'invoke',
		channel: 'launch:settings',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	updateMenuContext: {
		kind: 'invoke',
		channel: 'menu:context',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isMenuContext(a[0]),
	},
	readProjectViews: {
		kind: 'invoke',
		channel: 'project-views:read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	saveProjectView: {
		kind: 'invoke',
		channel: 'project-views:save',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && (a[0] === '*' || isId(a[0])) && isProjectView(a[1]),
	},
	readProjectModes: {
		kind: 'invoke',
		channel: 'project-modes:read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	saveProjectMode: {
		kind: 'invoke',
		channel: 'project-modes:save',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && (a[0] === '*' || isId(a[0])) && isProjectMode(a[1]),
	},
	setShortcutRecording: {
		kind: 'invoke',
		channel: 'keymap:recording',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && typeof a[0] === 'boolean',
	},
	checkEnvironment: {
		kind: 'invoke',
		channel: 'environment:check',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	readCliUpdates: {
		kind: 'invoke',
		channel: 'cli-updates:read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	checkCliUpdates: {
		kind: 'invoke',
		channel: 'cli-updates:check',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	onCliUpdates: { kind: 'subscribe', channel: 'cli-updates:changed', class: 'remote' },
	// spec/architecture-and-platform#auto-update: the app on the computer that shows the window updates itself.
	readAppUpdate: {
		kind: 'invoke',
		channel: 'app-update:read',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	checkAppUpdate: {
		kind: 'invoke',
		channel: 'app-update:check',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	downloadAppUpdate: {
		kind: 'invoke',
		channel: 'app-update:download',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	installAppUpdate: {
		kind: 'invoke',
		channel: 'app-update:install',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	cancelAppUpdateRestart: {
		kind: 'invoke',
		channel: 'app-update:cancel-restart',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	onAppUpdate: { kind: 'subscribe', channel: 'app-update:changed', class: 'client' },
	readKeepAwake: {
		kind: 'invoke',
		channel: 'keep-awake:read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	onKeepAwake: { kind: 'subscribe', channel: 'keep-awake:changed', class: 'remote' },
	signInAgent: {
		kind: 'invoke',
		channel: 'environment:sign-in',
		class: 'remote',
		arity: 1,
		validate: agentArg,
	},
	readAgentLogin: {
		kind: 'invoke',
		channel: 'agent-login:read',
		class: 'remote',
		arity: 1,
		validate: agentArg,
	},
	submitAgentLoginCode: {
		kind: 'invoke',
		channel: 'agent-login:code',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && (a[0] === 'claude' || a[0] === 'codex') && typeof a[1] === 'string',
	},
	cancelAgentLogin: {
		kind: 'invoke',
		channel: 'agent-login:cancel',
		class: 'remote',
		arity: 1,
		validate: agentArg,
	},
	reopenAgentLogin: {
		kind: 'invoke',
		channel: 'agent-login:reopen',
		class: 'remote',
		arity: 1,
		validate: agentArg,
	},
	onAgentLogin: { kind: 'subscribe', channel: 'agent-login:changed', class: 'remote' },
	// spec/remote-access-and-mobile#networking: a sign-in page opened from a window of another machine — on this device, with its way back.
	openAgentSignIn: {
		kind: 'invoke',
		channel: 'agent-login:open',
		class: 'client',
		arity: 2,
		validate: (a) => a.length === 2 && (a[0] === 'claude' || a[0] === 'codex') && isWebURL(a[1]),
	},
	relayAgentLogin: {
		kind: 'invoke',
		channel: 'agent-login:relay',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && (a[0] === 'claude' || a[0] === 'codex') && isAgentLoginRelayRequest(a[1]),
	},
	moveTask: {
		kind: 'invoke',
		channel: 'board:move',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isBoardColumn(a[1]),
	},
	taskOptionMenu: {
		kind: 'invoke',
		channel: 'board:option',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && (a[1] === 'model' || a[1] === 'effort'),
	},
	deleteCompletedTask: {
		kind: 'invoke',
		channel: 'board:delete',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	clearCompletedTasks: {
		kind: 'invoke',
		channel: 'board:clear',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && (a[0] === null || isId(a[0])),
	},
	editBacklogTask: {
		kind: 'invoke',
		channel: 'board:edit',
		class: 'remote',
		arity: 6,
		validate: (a) =>
			(a.length === 5 ||
				(a.length === 6 && isSheet(a[5]) && !(a[5] as TaskSheet | undefined)?.draftId)) &&
			(a[4] === undefined || isLaunchInput(a[4])) &&
			isTaskKey(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 1_000_000 &&
			(a[2] === 'claude' || a[2] === 'codex') &&
			(a[3] === 'gui' || a[3] === 'terminal'),
	},
	readMarkdownDescription: {
		kind: 'invoke',
		channel: 'sheet:markdown',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	sheetAttachMenu: {
		kind: 'invoke',
		channel: 'sheet:attach-menu',
		class: 'client',
		arity: 2,
		validate: (a) =>
			a.length === 2 && a.every((value) => typeof value === 'number' && Number.isFinite(value)),
	},
	discardAttachmentDraft: {
		kind: 'invoke',
		channel: 'attachment:discard-draft',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isAttachmentOwner(a[0]) && a[0].draft === true,
	},
	renameTask: {
		kind: 'invoke',
		channel: 'task:rename',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isTaskTitle(a[1]),
	},
	taskMenu: {
		kind: 'invoke',
		channel: 'task:menu',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	archiveTask: {
		kind: 'invoke',
		channel: 'archive:task',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	archiveCompletedTasks: {
		kind: 'invoke',
		channel: 'archive:completed',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && (a[0] === null || isId(a[0])),
	},
	restoreTasks: {
		kind: 'invoke',
		channel: 'archive:restore',
		class: 'remote',
		arity: 1,
		validate: (a) =>
			a.length === 1 &&
			Array.isArray(a[0]) &&
			a[0].length > 0 &&
			a[0].length <= 1000 &&
			a[0].every(isTaskKey),
	},
	deleteArchivedTasks: {
		kind: 'invoke',
		channel: 'archive:delete',
		class: 'remote',
		arity: 1,
		validate: (a) =>
			a.length === 1 &&
			Array.isArray(a[0]) &&
			a[0].length > 0 &&
			a[0].length <= 1000 &&
			a[0].every(isTaskKey),
	},
	readArchiveSections: {
		kind: 'invoke',
		channel: 'sidebar:archive-read',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	openArchiveSection: {
		kind: 'invoke',
		channel: 'sidebar:archive-open',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === 'boolean',
	},
	projectMenu: {
		kind: 'invoke',
		channel: 'project:menu',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	copyText: {
		kind: 'invoke',
		channel: 'clipboard:write-text',
		class: 'client',
		arity: 1,
		validate: (a) =>
			a.length === 1 &&
			typeof a[0] === 'string' &&
			a[0].length <= 1_000_000 &&
			fitsUtf8(a[0], 4 * 1024 * 1024),
	},
	readClipboardText: {
		kind: 'invoke',
		channel: 'clipboard:read-text',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	reportRendererError: {
		kind: 'invoke',
		channel: 'renderer:error',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isRendererErrorReport(a[0]),
	},
	reloadWindow: {
		kind: 'invoke',
		channel: 'window:reload',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	testCrash: { kind: 'local', class: 'client', remote: 'forbidden', local: (env) => env.testCrash },
	testAttentionMs: { kind: 'local', class: 'client', local: (env) => env.testAttentionMs },
	chromePlatform: { kind: 'local', class: 'client', local: (env) => env.chromePlatform },
	remoteMachine: { kind: 'local', class: 'client', local: (env) => env.remoteMachine },
	openAppMenu: {
		kind: 'invoke',
		channel: 'window:app-menu',
		class: 'client',
		encode: ([x, y]) => (x === undefined || y === undefined ? [] : [x, y]),
		validate: (a) =>
			a.length === 0 ||
			(a.length === 2 &&
				a.every(
					(value) =>
						typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 100_000
				)),
	},
	onAppMenu: { kind: 'subscribe', channel: 'window:app-menu', class: 'client' },
	setChromeColors: {
		kind: 'invoke',
		channel: 'window:chrome-colors',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isChromeColors(a[0]),
	},
	readAttribution: {
		kind: 'invoke',
		channel: 'changes:attribution',
		class: 'remote',
		encode: ([key, id, range]) => [key, id, range ?? null],
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			(a[2] === null || isAttributionRange(a[2])),
	},
	attachFile: {
		kind: 'invoke',
		channel: 'files:attach',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	openFileTerminal: {
		kind: 'invoke',
		channel: 'files:terminal',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	removeReviewSelection: {
		kind: 'invoke',
		channel: 'review:remove-selection',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isReviewSelection(a[1]),
	},
	readComposer: {
		kind: 'invoke',
		channel: 'composer:read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	saveComposer: {
		kind: 'invoke',
		channel: 'composer:save',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 1_000_000 &&
			fitsUtf8(JSON.stringify(a[1]), 4 * 1024 * 1024),
	},
	deleteTreeFile: {
		kind: 'invoke',
		channel: 'files:delete',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	fileMenu: {
		kind: 'invoke',
		channel: 'files:menu',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			(a[2] === 'tree' || a[2] === 'changes'),
	},
	editorMenu: {
		kind: 'invoke',
		channel: 'editor:menu',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && isEditorMenuState(a[2]),
	},
	documentTabMenu: {
		kind: 'invoke',
		channel: 'documents:tab-menu',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isDocumentTabMenuState(a[1]),
	},
	setMenuIcons: {
		kind: 'invoke',
		channel: 'menu:icons',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isMenuIconImages(a[0]),
	},
	chatMenu: {
		kind: 'invoke',
		channel: 'chat:menu',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isChatMenuState(a[0]),
	},
	terminalMenu: {
		kind: 'invoke',
		channel: 'terminal:menu',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isTerminalMenuState(a[0]),
	},
	readTimeline: {
		kind: 'invoke',
		channel: 'changes:timeline',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	selectChangeRange: {
		kind: 'invoke',
		channel: 'changes:range',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			(a[1] === null ||
				(isRecord(a[1]) &&
					Number.isSafeInteger(a[1].base) &&
					Number(a[1].base) >= 0 &&
					Number.isSafeInteger(a[1].current) &&
					Number(a[1].current) >= Number(a[1].base))),
	},
	revertFile: {
		kind: 'invoke',
		channel: 'changes:revert',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	backgroundOutput: {
		kind: 'invoke',
		channel: 'session:background-output',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isBackgroundId(a[1]),
	},
	readToolChange: {
		kind: 'invoke',
		channel: 'activity:tool-change',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			Number.isSafeInteger(a[1]) &&
			Number(a[1]) > 0 &&
			Number.isSafeInteger(a[2]) &&
			Number(a[2]) >= 0 &&
			Number(a[2]) < 1000,
	},
	turnMenu: {
		kind: 'invoke',
		channel: 'activity:turn-menu',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isTaskKey(a[0]) && Number.isSafeInteger(a[1]) && Number(a[1]) > 0,
	},
	readToolDiff: {
		kind: 'invoke',
		bulk: true,
		channel: 'activity:tool-diff',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			Number.isSafeInteger(a[1]) &&
			Number(a[1]) > 0 &&
			Number.isSafeInteger(a[2]) &&
			Number(a[2]) >= 0 &&
			Number(a[2]) < 1000,
	},
	readTurnChanges: {
		kind: 'invoke',
		channel: 'activity:turn-changes',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isTaskKey(a[0]) && Number.isSafeInteger(a[1]) && Number(a[1]) > 0,
	},
	readSurfaceLayout: {
		kind: 'invoke',
		channel: 'layout:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	readSurface: {
		kind: 'invoke',
		channel: 'surface:read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	writeSurface: {
		kind: 'invoke',
		channel: 'surface:write',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isTaskSurface(a[1]),
	},
	writeSurfaceDrafts: {
		kind: 'invoke',
		channel: 'surface:drafts',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			Array.isArray(a[1]) &&
			a[1].length <= 200 &&
			a[1].every(isSurfaceDraft),
	},
	onSurfaceFlush: { kind: 'subscribe', channel: 'surface:flush', class: 'remote' },
	surfaceFlushed: {
		kind: 'invoke',
		channel: 'surface:flushed',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && Number.isInteger(a[0]),
	},
	saveSurfaceLayout: {
		kind: 'invoke',
		channel: 'layout:save',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isSurfaceLayout(a[0]),
	},
	pickAttachments: {
		kind: 'invoke',
		channel: 'attachment:pick',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isAttachmentOwner(a[0]),
	},
	createAttachment: {
		kind: 'invoke',
		channel: 'attachment:create',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isAttachmentInput(a[1]),
	},
	pasteAttachment: {
		kind: 'invoke',
		channel: 'attachment:paste',
		class: 'client',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isAttachmentOwner(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].trim().length > 0 &&
			a[1].length <= 200,
	},
	attachDroppedFiles: {
		kind: 'invoke',
		channel: 'attachment:paths',
		class: 'client',
		// spec/composer#paste: only real dropped or pasted files have a path; anything else (a clipboard picture, a page's image) has none.
		encode: ([key, files], env) => {
			const paths = (files as object[])
				.map((file) => {
					try {
						return env.pathForFile(file);
					} catch {
						return '';
					}
				})
				.filter(Boolean);
			return paths.length ? [key, paths] : { resolve: [] };
		},
		validate: (a) =>
			a.length === 2 &&
			isAttachmentOwner(a[0]) &&
			Array.isArray(a[1]) &&
			a[1].length > 0 &&
			a[1].length <= 10 &&
			a[1].every(
				(path) =>
					typeof path === 'string' &&
					isAbsolutePath(path) &&
					path.length <= 4096 &&
					!path.includes('\0')
			),
	},
	readAttachment: {
		kind: 'invoke',
		bulk: true,
		channel: 'attachment:read',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isAttachmentOwner(a[0]) && isAttachmentId(a[1]),
	},
	readAttachmentInfo: {
		kind: 'invoke',
		channel: 'attachment:info',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isAttachmentOwner(a[0]) && isAttachmentId(a[1]),
	},
	attachTaskSummary: {
		kind: 'invoke',
		channel: 'attachment:task-summary',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			isTaskKey(a[1]) &&
			a[0].projectId === a[1].projectId &&
			a[0].id !== a[1].id,
	},
	readAttachmentThumbnail: {
		kind: 'invoke',
		channel: 'attachment:thumbnail',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isAttachmentOwner(a[0]) && isAttachmentId(a[1]),
	},
	copyAttachmentImage: {
		kind: 'invoke',
		channel: 'attachment:copy-image',
		class: 'client',
		arity: 2,
		validate: (a) => a.length === 2 && isAttachmentOwner(a[0]) && isAttachmentId(a[1]),
	},
	browserCommand: {
		kind: 'invoke',
		channel: 'browser:command',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isBrowserCommand(a[1]),
	},
	onBrowserEvent: { kind: 'subscribe', channel: 'browser:event', class: 'remote' },
	// spec/remote-access-and-mobile#browser-from-device: a window of another machine streams the page instead of mounting it; frames come back to it alone.
	browserScreen: {
		kind: 'invoke',
		channel: 'browser:screen',
		class: 'remote',
		arity: 2,
		validate: isBrowserScreenArgs,
	},
	onBrowserScreen: { kind: 'subscribe', channel: 'browser:screen', class: 'remote' },
	// spec/remote-access-and-mobile#browser-from-device: a file the device chose for a page's file input, before its answer to `remote:files`.
	uploadPageFile: {
		kind: 'invoke',
		channel: 'browser:file',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			Number.isSafeInteger(a[0]) &&
			Number(a[0]) > 0 &&
			typeof a[1] === 'string' &&
			a[1].trim().length > 0 &&
			a[1].length <= 200 &&
			!/[/\\\0]/.test(a[1]) &&
			a[1] !== '.' &&
			a[1] !== '..' &&
			a[2] instanceof Uint8Array &&
			a[2].length <= remoteUploadLimit,
	},
	onBrowserShow: { kind: 'subscribe', channel: 'browser:show', class: 'remote' },
	onBrowserTab: { kind: 'subscribe', channel: 'browser:tab', class: 'remote' },
	readBrowserLive: {
		kind: 'invoke',
		channel: 'browser:live',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	onBrowserLive: { kind: 'subscribe', channel: 'browser:live', class: 'remote' },
	onContextRequest: { kind: 'subscribe', channel: 'context:request', class: 'remote' },
	answerContextRequest: {
		kind: 'invoke',
		channel: 'context:answer',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			typeof a[0] === 'string' &&
			a[0].length <= 64 &&
			(a[1] === null || isContextReport(a[1])),
	},
	simulatorCommand: {
		kind: 'invoke',
		channel: 'simulator:command',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isSimulatorCommand(a[1]),
	},
	readSimulatorToolchain: {
		kind: 'invoke',
		channel: 'simulator:toolchain',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	onSimulatorEvent: { kind: 'subscribe', channel: 'simulator:event', class: 'remote' },
	onSimulatorFrame: { kind: 'subscribe', channel: 'simulator:frame', class: 'remote' },
	terminalCommand: {
		kind: 'invoke',
		channel: 'terminal:command',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			isTerminalCommand(a[1]) &&
			(!isRecord(a[1]) || (!('directory' in a[1]) && a[1].kind !== 'run')),
	},
	readCommandRuns: {
		kind: 'invoke',
		channel: 'commands:runs',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	runProjectCommand: {
		kind: 'invoke',
		channel: 'commands:run',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isCommandRunRef(a[1]),
	},
	readProjectScripts: {
		kind: 'invoke',
		channel: 'commands:scripts',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	saveProjectCommands: {
		kind: 'invoke',
		channel: 'commands:save',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isProjectCommands(a[1]),
	},
	projectCommandMenu: {
		kind: 'invoke',
		channel: 'commands:menu',
		class: 'remote',
		arity: 1,
		validate: (a) =>
			a.length === 1 &&
			isRecord(a[0]) &&
			Object.keys(a[0]).length === 3 &&
			['running', 'shown', 'port'].every(
				(field) => typeof (a[0] as Record<string, unknown>)[field] === 'boolean'
			),
	},
	onTerminalEvent: { kind: 'subscribe', channel: 'terminal:event', class: 'remote' },
	compareEditorFile: {
		kind: 'invoke',
		channel: 'files:compare',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			fitsUtf8(a[2], editorByteLimit),
	},
	readEditorSyntax: {
		kind: 'invoke',
		bulk: true,
		channel: 'files:syntax',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			fitsUtf8(a[2], editorByteLimit),
	},
	readEditorGutter: {
		kind: 'invoke',
		channel: 'files:gutter',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			fitsUtf8(a[2], editorByteLimit),
	},
	readEditorReview: {
		kind: 'invoke',
		channel: 'review:editor-read',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && isFileId(a[2]),
	},
	addEditorComment: {
		kind: 'invoke',
		channel: 'review:editor-add',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isEditorCommentInput(a[1]),
	},
	listFiles: {
		kind: 'invoke',
		channel: 'files:list',
		class: 'remote',
		encode: ([key, id, showIgnored = false]) => [key, id, showIgnored],
		validate: (a) =>
			a.length === 3 &&
			typeof a[2] === 'boolean' &&
			isTaskKey(a[0]) &&
			(a[1] === null || isFileId(a[1]) || isRepoFolderId(a[1])),
	},
	readEditorFile: {
		kind: 'invoke',
		bulk: true,
		channel: 'files:read',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	createEditorFile: {
		kind: 'invoke',
		channel: 'files:create',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length > 0 &&
			a[1].length <= 4096,
	},
	openPlanFile: {
		kind: 'invoke',
		channel: 'plans:open',
		class: 'remote',
		arity: 3,
		validate: isPlanArgs,
	},
	readPlanFile: {
		kind: 'invoke',
		channel: 'plans:text',
		class: 'remote',
		arity: 3,
		validate: isPlanArgs,
	},
	checkEditorFile: {
		kind: 'invoke',
		channel: 'files:check',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			a[2].length <= 64,
	},
	openDiffFile: {
		kind: 'invoke',
		channel: 'files:diff',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	saveEditorFile: {
		kind: 'invoke',
		channel: 'files:save',
		class: 'remote',
		encode: ([key, id, version, text, afterTurn = false]) => [key, id, version, text, afterTurn],
		validate: (a) =>
			a.length === 5 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			isFileId(a[2]) &&
			typeof a[3] === 'string' &&
			fitsUtf8(a[3], editorByteLimit) &&
			typeof a[4] === 'boolean',
	},
	setEditorDirty: {
		kind: 'invoke',
		channel: 'files:dirty',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isTaskKey(a[0]) && isFileId(a[1]) && typeof a[2] === 'boolean',
	},
	releaseEditorFile: {
		kind: 'invoke',
		channel: 'files:release',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	openCode: {
		kind: 'invoke',
		channel: 'code:open',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			typeof a[2] === 'string' &&
			fitsUtf8(a[2], editorByteLimit),
	},
	changeCode: {
		kind: 'invoke',
		channel: 'code:change',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			isCodeOffset(a[2]) &&
			isCodeChanges(a[3]),
	},
	closeCode: {
		kind: 'invoke',
		channel: 'code:close',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	completeCode: {
		kind: 'invoke',
		channel: 'code:complete',
		class: 'remote',
		arity: 5,
		validate: (a) => codeRequest(a, 1) && isCodeTrigger(a[4]),
	},
	resolveCompletion: {
		kind: 'invoke',
		channel: 'code:resolve',
		class: 'remote',
		arity: 5,
		validate: (a) =>
			a.length === 5 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			isCodeOffset(a[2]) &&
			isCodeOffset(a[3]) &&
			isCodeOffset(a[4]),
	},
	hoverCode: {
		kind: 'invoke',
		channel: 'code:hover',
		class: 'remote',
		arity: 4,
		validate: (a) => codeRequest(a, 0),
	},
	signatureCode: {
		kind: 'invoke',
		channel: 'code:signature',
		class: 'remote',
		arity: 5,
		validate: (a) => codeRequest(a, 1) && isCodeTrigger(a[4]),
	},
	definitionCode: {
		kind: 'invoke',
		channel: 'code:definition',
		class: 'remote',
		arity: 4,
		validate: (a) => codeRequest(a, 0),
	},
	referencesCode: {
		kind: 'invoke',
		channel: 'code:references',
		class: 'remote',
		arity: 4,
		validate: (a) => codeRequest(a, 0),
	},
	onCodeProblems: { kind: 'subscribe', channel: 'code:problems', class: 'remote' },
	formatCode: {
		kind: 'invoke',
		channel: 'code:format',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isTaskKey(a[0]) &&
			isFileId(a[1]) &&
			isCodeOffset(a[2]) &&
			isCodeFormatReason(a[3]),
	},
	formatInfoCode: {
		kind: 'invoke',
		channel: 'code:format-info',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	indentInfoCode: {
		kind: 'invoke',
		channel: 'code:indent-info',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	restartCode: {
		kind: 'invoke',
		channel: 'code:restart',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	onCodeRestarted: { kind: 'subscribe', channel: 'code:restarted', class: 'remote' },
	readFormatters: {
		kind: 'invoke',
		channel: 'formatters:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	/** spec/pull-requests-and-ci#review-notes: the project's review notes; null removes them. */
	setProjectReviewNotes: {
		kind: 'invoke',
		channel: 'projects:review-notes',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && (a[1] === null || isProjectReviewNotes(a[1])),
	},
	setProjectFormatter: {
		kind: 'invoke',
		channel: 'formatters:set',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isId(a[0]) && projectFormatters.includes(a[1] as ProjectFormatter),
	},
	onNavigate: { kind: 'subscribe', channel: 'navigation:route', class: 'client' },
	searchFiles: {
		kind: 'invoke',
		channel: 'files:search',
		class: 'remote',
		encode: ([key, query, showIgnored = false, folders = false]) => [
			key,
			query,
			showIgnored,
			folders,
		],
		validate: (a) =>
			(a.length === 3 || (a.length === 4 && typeof a[3] === 'boolean')) &&
			typeof a[2] === 'boolean' &&
			isTaskKey(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 200,
	},
	searchText: {
		kind: 'invoke',
		channel: 'search:text',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isTaskKey(a[0]) &&
			isTextSearchRequest(a[1]) &&
			typeof a[2] === 'string' &&
			/^[\w-]{1,64}$/.test(a[2]),
	},
	cancelTextSearch: {
		kind: 'invoke',
		channel: 'search:text-cancel',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && typeof a[0] === 'string' && a[0].length <= 64,
	},
	peekFile: {
		kind: 'invoke',
		bulk: true,
		channel: 'search:peek',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isFileId(a[1]),
	},
	readTextSearchRepos: {
		kind: 'invoke',
		channel: 'search:text-repos',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	onTextSearch: { kind: 'subscribe', channel: 'search:text-event', class: 'remote' },
	runMenuCommand: {
		kind: 'invoke',
		channel: 'menu:run',
		class: 'client',
		arity: 1,
		validate: (a) =>
			a.length === 1 &&
			typeof a[0] === 'string' &&
			menuCommands.some((command) => command.id === a[0]),
	},
	onReviewChanged: { kind: 'subscribe', channel: 'review:changed', class: 'remote' },
	onWorkspaceAction: { kind: 'subscribe', channel: 'workspace:action', class: 'client' },
	dispatchWorkspaceAction: {
		kind: 'local',
		class: 'client',
		local: (_env, transport) => (action: unknown) => transport.emit('workspace:action', action),
	},
	readSlashCatalog: {
		kind: 'invoke',
		channel: 'slash:catalog',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isSlashCatalogRequest(a[0]),
	},
	onEditorAction: { kind: 'subscribe', channel: 'editor:action', class: 'client' },
	addProject: {
		kind: 'invoke',
		channel: 'project:add',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	setProjectIcon: {
		kind: 'invoke',
		channel: 'project:icon-set',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && (a[1] === null || isProjectIcon(a[1])),
	},
	pickProjectIcon: {
		kind: 'invoke',
		channel: 'project:icon-pick',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	readProjectRepoIcons: {
		kind: 'invoke',
		channel: 'project:icon-repo',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	setProjectRepoIcon: {
		kind: 'invoke',
		channel: 'project:icon-repo-set',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isId(a[0]) && isRepoIconPath(a[1]) && isProjectIconColor(a[2]),
	},
	setProjectImageIcon: {
		kind: 'invoke',
		channel: 'project:icon-image-set',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isProjectImageBytes(a[1]),
	},
	readProjectImageIcon: {
		kind: 'invoke',
		channel: 'project:icon-image',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isId(a[0]),
	},
	generateProjectIcon: {
		kind: 'invoke',
		channel: 'project:icon-generate',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isId(a[0]) && isProjectIconHint(a[1]),
	},
	addDroppedProject: {
		kind: 'invoke',
		channel: 'project:add-path',
		class: 'client',
		encode: ([file], env) => [env.pathForFile(file as object)],
		validate: (a) => a.length === 1 && typeof a[0] === 'string' && isAbsolutePath(a[0]),
	},
	createTask: {
		kind: 'invoke',
		channel: 'task:create',
		class: 'remote',
		encode: ([
			projectId,
			prompt,
			provider,
			transport = 'gui',
			backlog = false,
			launch,
			crew,
			sheet,
		]) => [projectId, prompt, provider, transport, backlog, launch, crew, sheet],
		validate: (a) =>
			(a.length === 6 ||
				((a.length === 7 || a.length === 8) &&
					(a[6] === undefined || isCrewLaunch(a[6])) &&
					isSheet(a[7]))) &&
			(a[5] === undefined || isLaunchInput(a[5])) &&
			typeof a[4] === 'boolean' &&
			(a[3] === 'gui' || a[3] === 'terminal') &&
			isId(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length <= 1_000_000 &&
			(a[2] === 'claude' || a[2] === 'codex'),
	},
	readTemplates: {
		kind: 'invoke',
		channel: 'templates:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	saveAgentTemplate: {
		kind: 'invoke',
		channel: 'templates:save-agent',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isAgentTemplate(a[0]),
	},
	saveCrewTemplate: {
		kind: 'invoke',
		channel: 'templates:save-crew',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isCrewTemplate(a[0]),
	},
	deleteTemplate: {
		kind: 'invoke',
		channel: 'templates:delete',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && (a[0] === 'agent' || a[0] === 'crew') && isId(a[1]),
	},
	restoreCrewTemplates: {
		kind: 'invoke',
		channel: 'templates:restore-crews',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	exportTemplate: {
		kind: 'invoke',
		channel: 'templates:export',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && (a[0] === 'agent' || a[0] === 'crew') && isId(a[1]),
	},
	importTemplate: {
		kind: 'invoke',
		channel: 'templates:import',
		class: 'remote',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	readProviderCatalog: {
		kind: 'invoke',
		channel: 'templates:catalog',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && (a[0] === 'claude' || a[0] === 'codex'),
	},
	readFileLinks: {
		kind: 'invoke',
		channel: 'files:links',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			Array.isArray(a[1]) &&
			a[1].length <= 32 &&
			a[1].every(
				(item) =>
					isRecord(item) && typeof item.text === 'string' && typeof item.literal === 'boolean'
			) &&
			a[1].reduce((size, item) => size + item.text.length, 0) <= 32768,
	},
	readCodeSyntax: {
		kind: 'invoke',
		bulk: true,
		channel: 'syntax:code',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			typeof a[0] === 'string' &&
			a[0].length <= 64 &&
			typeof a[1] === 'string' &&
			a[1].length <= 1_000_000 &&
			fitsUtf8(a[1], 4 * 1024 * 1024),
	},
	readReviewPositions: {
		kind: 'invoke',
		channel: 'review:positions',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isAttachmentId(a[1]),
	},
	readReview: {
		kind: 'invoke',
		channel: 'review:read',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			(a[1] === null || (typeof a[1] === 'string' && /^[a-f0-9]{64}$/.test(a[1]))),
	},
	addReviewNote: {
		kind: 'invoke',
		channel: 'review:note',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isCommentText(a[1]),
	},
	addComment: {
		kind: 'invoke',
		channel: 'review:add',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isCommentInput(a[1]),
	},
	editComment: {
		kind: 'invoke',
		channel: 'review:edit',
		class: 'remote',
		arity: 3,
		validate: (a) => a.length === 3 && isTaskKey(a[0]) && commentId(a[1]) && isCommentText(a[2]),
	},
	readCommentFile: {
		kind: 'invoke',
		bulk: true,
		channel: 'review:file',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && commentId(a[1]),
	},
	resolveComment: {
		kind: 'invoke',
		channel: 'review:resolve',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 && isTaskKey(a[0]) && commentId(a[1]) && typeof a[2] === 'boolean',
	},
	removeComment: {
		kind: 'invoke',
		channel: 'review:remove',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && commentId(a[1]),
	},
	prepareReview: {
		kind: 'invoke',
		channel: 'review:prepare',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readChanges: {
		kind: 'invoke',
		channel: 'changes:read',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	readFileDiff: {
		kind: 'invoke',
		bulk: true,
		channel: 'changes:file',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isTaskKey(a[0]) && typeof a[1] === 'string' && /^[a-f0-9]{64}$/.test(a[1]),
	},
	readFileSyntax: {
		kind: 'invoke',
		bulk: true,
		channel: 'changes:syntax',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isTaskKey(a[0]) && typeof a[1] === 'string' && /^[a-f0-9]{64}$/.test(a[1]),
	},
	readSettings: {
		kind: 'invoke',
		channel: 'settings:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	readSounds: {
		kind: 'invoke',
		channel: 'sounds:read',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	previewSound: {
		kind: 'invoke',
		channel: 'sounds:preview',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isSoundName(a[0]),
	},
	openNotificationSettings: {
		kind: 'invoke',
		channel: 'notifications:system-settings',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	readNotificationPermission: {
		kind: 'invoke',
		channel: 'notifications:permission',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	requestNotificationPermission: {
		kind: 'invoke',
		channel: 'notifications:request',
		class: 'client',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	onNotificationPermission: {
		kind: 'subscribe',
		channel: 'notifications:permission',
		class: 'client',
	},
	setVisibleTask: {
		kind: 'invoke',
		channel: 'notifications:visible',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && (a[0] === null || isTaskKey(a[0])),
	},
	onProjectOpen: { kind: 'subscribe', channel: 'project:open', class: 'client' },
	onNotificationOpen: { kind: 'subscribe', channel: 'notification:open', class: 'client' },
	// spec/notifications-slack-notes-and-schedules#notification-center: the center's journal lives with the tasks (remote); opening a row brings this window to it.
	readNoticeCenter: {
		kind: 'invoke',
		channel: 'notices:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	noticeCenterAction: {
		kind: 'invoke',
		channel: 'notices:action',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isNoticeCenterAction(a[0]),
	},
	addToastNotice: {
		kind: 'invoke',
		channel: 'notices:toast',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isToastNotice(a[0]),
	},
	onNoticeCenter: { kind: 'subscribe', channel: 'notices:changed', class: 'remote' },
	// spec/notifications-slack-notes-and-schedules#slack: Slack lives with the tasks; the token goes one way, into main, and never from a remote client.
	readSlack: { kind: 'invoke', channel: 'slack:read', class: 'remote', arity: 0, validate: noArgs },
	retrySlack: {
		kind: 'invoke',
		channel: 'slack:retry',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	connectSlack: {
		kind: 'invoke',
		channel: 'slack:connect',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && typeof a[0] === 'string' && a[0].length <= 256,
	},
	moveSlackToKeychain: {
		kind: 'invoke',
		channel: 'slack:keychain',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	disconnectSlack: {
		kind: 'invoke',
		channel: 'slack:disconnect',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	connectSlackApp: {
		kind: 'invoke',
		channel: 'slack:app-connect',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && typeof a[0] === 'string' && a[0].length <= 256,
	},
	disconnectSlackApp: {
		kind: 'invoke',
		channel: 'slack:app-disconnect',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	onSlack: { kind: 'subscribe', channel: 'slack:changed', class: 'remote' },
	// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: a remote client saves settings but never switches the `remoteAccess` module.
	saveSettings: {
		kind: 'invoke',
		channel: 'settings:save',
		class: 'remote',
		remote: 'guarded',
		arity: 1,
		validate: (a) => a.length === 1 && isAppSettings(a[0]),
	},
	saveActionAgent: {
		kind: 'invoke',
		channel: 'settings:action-agent',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && isAgentAction(a[0]) && (a[1] === null || isHelperAgent(a[1])),
	},
	// spec/pull-requests-and-ci#review-crew: `Remember for …` on the Crew segment and its `Reset` in Customize per action.
	saveActionCrew: {
		kind: 'invoke',
		channel: 'settings:action-crew',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isCrewAction(a[0]) && (a[1] === null || isActionCrew(a[1])),
	},
	// spec/remote-access-and-mobile#browser-from-device: never from a device — the connection and its resume token would not survive it.
	restartApp: {
		kind: 'invoke',
		channel: 'settings:restart',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: (a) => a.length === 0,
	},
	readSession: {
		kind: 'invoke',
		channel: 'session:read',
		class: 'remote',
		encode: ([key, afterSeq]) => (afterSeq === undefined ? [key] : [key, afterSeq]),
		validate: (a) =>
			(a.length === 1 || (a.length === 2 && Number.isSafeInteger(a[1]) && Number(a[1]) >= 0)) &&
			isTaskKey(a[0]),
	},
	readSessionActivity: {
		kind: 'invoke',
		channel: 'session:activity',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]),
	},
	startSession: {
		kind: 'invoke',
		channel: 'session:start',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && isTaskKey(a[0]) && !isMainTree(a[0]),
	},
	sendCommand: {
		kind: 'invoke',
		channel: 'session:command',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 &&
			isTaskKey(a[0]) &&
			isSessionCommand(a[1]) &&
			a[1].kind !== 'quickAsk' &&
			(!isMainTree(a[0]) || ['checkpoint', 'setScope', 'recordPullRequest'].includes(a[1].kind)),
	},
	onSessionEvent: { kind: 'subscribe', channel: 'session:event', class: 'remote' },
	readWorkspace: {
		kind: 'invoke',
		channel: 'workspace:read',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	readAppearance: {
		kind: 'invoke',
		channel: 'appearance:read',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	onAppearanceChanged: { kind: 'subscribe', channel: 'appearance:changed', class: 'client' },
	// spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: remote access. The working machine's rows: reading is allowed from a device (the tab is read-only
	// there), managing access itself is not (spec/remote-access-and-mobile#architecture).
	readRemoteAccess: {
		kind: 'invoke',
		channel: 'remote:status',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	setRemoteAccess: {
		kind: 'invoke',
		channel: 'remote:enable',
		class: 'remote',
		remote: 'forbidden',
		encode: ([enabled, password]) => (password === undefined ? [enabled] : [enabled, password]),
		validate: (a) =>
			(a.length === 1 || (a.length === 2 && isRemotePassword(a[1]))) && typeof a[0] === 'boolean',
	},
	setRemotePassword: {
		kind: 'invoke',
		channel: 'remote:password',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && isRemotePassword(a[0]),
	},
	renameRemoteMachine: {
		kind: 'invoke',
		channel: 'remote:rename',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && (a[0] === null || isMachineName(a[0])),
	},
	revokeRemoteDevice: {
		kind: 'invoke',
		channel: 'remote:revoke',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && isRemoteId(a[0]),
	},
	revokeAllRemoteDevices: {
		kind: 'invoke',
		channel: 'remote:revoke-all',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	disconnectRemoteDevice: {
		kind: 'invoke',
		channel: 'remote:drop',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && isRemoteId(a[0]),
	},
	unblockRemoteDevice: {
		kind: 'invoke',
		channel: 'remote:unblock',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && isRemoteId(a[0]),
	},
	startRemotePairing: {
		kind: 'invoke',
		channel: 'remote:pairing-start',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	stopRemotePairing: {
		kind: 'invoke',
		channel: 'remote:pairing-stop',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	confirmRemotePairing: {
		kind: 'invoke',
		channel: 'remote:pairing-confirm',
		class: 'remote',
		remote: 'forbidden',
		arity: 2,
		validate: (a) =>
			a.length === 2 && typeof a[0] === 'boolean' && (a[1] === null || isMachineName(a[1])),
	},
	readRemoteAudit: {
		kind: 'invoke',
		channel: 'remote:audit',
		class: 'remote',
		arity: 1,
		validate: (a) =>
			a.length === 1 &&
			Number.isSafeInteger(a[0]) &&
			Number(a[0]) >= 1 &&
			Number(a[0]) <= remoteAuditLimit,
	},
	revealRemoteAudit: {
		kind: 'invoke',
		channel: 'remote:audit-reveal',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	// spec/remote-access-and-mobile#phone-network: the phone's web listener — its switch, and Tailscale asked again.
	setRemotePhone: {
		kind: 'invoke',
		channel: 'remote:phone',
		class: 'remote',
		remote: 'forbidden',
		arity: 1,
		validate: (a) => a.length === 1 && typeof a[0] === 'boolean',
	},
	checkRemotePhone: {
		kind: 'invoke',
		channel: 'remote:phone-check',
		class: 'remote',
		remote: 'forbidden',
		arity: 0,
		validate: noArgs,
	},
	takeRemoteControl: {
		kind: 'invoke',
		channel: 'remote:take-control',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	onRemoteStatus: { kind: 'subscribe', channel: 'remote:status', class: 'remote' },
	onRemoteControl: { kind: 'subscribe', channel: 'remote:control', class: 'remote' },
	onRemoteNotice: { kind: 'subscribe', channel: 'remote:notice', class: 'remote' },
	// The device's rows: the main of the machine whose window calls runs them, its paired machines and connections.
	readRemoteMachines: {
		kind: 'invoke',
		channel: 'remote:machines',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	browseRemoteMachines: {
		kind: 'invoke',
		channel: 'remote:browse',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && typeof a[0] === 'boolean',
	},
	pairRemoteMachine: {
		kind: 'invoke',
		channel: 'remote:pair',
		class: 'client',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isRemoteHost(a[0]) &&
			(a[1] === null || isRemotePort(a[1])) &&
			typeof a[2] === 'string' &&
			a[2].length <= 32 &&
			(a[3] === null || isMachineName(a[3])),
	},
	cancelPairRemoteMachine: {
		kind: 'invoke',
		channel: 'remote:pair-cancel',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	onRemotePairProgress: { kind: 'subscribe', channel: 'remote:pair-progress', class: 'client' },
	// spec/remote-access-and-mobile#identity-and-keys: a Linux key store that is a plain file is refused before anyone pairs.
	readRemoteKeyStore: {
		kind: 'invoke',
		channel: 'remote:key-store',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	forgetRemoteMachine: {
		kind: 'invoke',
		channel: 'remote:forget',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isRemoteId(a[0]),
	},
	connectRemoteMachine: {
		kind: 'invoke',
		channel: 'remote:connect',
		class: 'client',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			isRemoteId(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].length > 0 &&
			a[1].length <= remotePasswordMax &&
			typeof a[2] === 'boolean',
	},
	disconnectRemoteMachine: {
		kind: 'invoke',
		channel: 'remote:disconnect',
		class: 'client',
		arity: 1,
		validate: (a) => a.length === 1 && isRemoteId(a[0]),
	},
	readRemoteSessions: {
		kind: 'invoke',
		channel: 'remote:sessions',
		class: 'client',
		arity: 0,
		validate: noArgs,
	},
	onRemoteSessions: { kind: 'subscribe', channel: 'remote:sessions', class: 'client' },
	onRemoteFound: { kind: 'subscribe', channel: 'remote:found', class: 'client' },
	// spec/remote-access-and-mobile#remote-button: «Go to» in the chip's menu of another machine's window — that window, or this machine's task window
	// (`connect`: with the list «Connect» open on the machine).
	showRemoteWindow: {
		kind: 'invoke',
		channel: 'remote:show',
		class: 'client',
		arity: 2,
		validate: (a) =>
			a.length === 2 && (a[0] === null || isRemoteId(a[0])) && typeof a[1] === 'boolean',
	},
	onRemoteOpen: { kind: 'subscribe', channel: 'remote:open', class: 'client' },
	// spec/remote-access-and-mobile#networking: whether each paired machine answers, while the Connect list is open.
	onRemoteReach: { kind: 'subscribe', channel: 'remote:reach', class: 'client' },
	// spec/remote-access-and-mobile#client-ui-seam: what a device shows on its own screen and answers; what it reads of the working machine to show it.
	answerRemoteUi: {
		kind: 'invoke',
		channel: 'remote:ui-answer',
		class: 'remote',
		arity: 2,
		validate: isRemoteUiAnswer,
	},
	listRemoteFolder: {
		kind: 'invoke',
		channel: 'remote:fs-list',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			Number.isSafeInteger(a[0]) &&
			(a[1] === null || isRemoteFsPath(a[1])) &&
			typeof a[2] === 'boolean',
	},
	createRemoteFolder: {
		kind: 'invoke',
		channel: 'remote:fs-mkdir',
		class: 'remote',
		arity: 3,
		validate: (a) =>
			a.length === 3 &&
			Number.isSafeInteger(a[0]) &&
			isRemoteFsPath(a[1]) &&
			isRemoteFolderName(a[2]),
	},
	actOnRemoteNotice: {
		kind: 'invoke',
		channel: 'remote:notice-act',
		class: 'remote',
		arity: 2,
		validate: (a) =>
			a.length === 2 && Number.isSafeInteger(a[0]) && (a[1] === 'allow' || a[1] === 'deny'),
	},
	onRemoteMenu: { kind: 'subscribe', channel: 'remote:menu', class: 'remote' },
	onRemoteDialog: { kind: 'subscribe', channel: 'remote:dialog', class: 'remote' },
	onRemoteFiles: { kind: 'subscribe', channel: 'remote:files', class: 'remote' },
	// spec/remote-access-and-mobile#browser-from-device: a device closes its window of this machine — the window writes its buffers first (hot exit).
	closingRemoteWindow: {
		kind: 'invoke',
		channel: 'remote:closing',
		class: 'remote',
		arity: 1,
		validate: (a) => a.length === 1 && (a[0] === 'flush' || a[0] === 'keep'),
	},
	onRemoteSave: { kind: 'subscribe', channel: 'remote:save', class: 'remote' },
	onRemoteNotify: { kind: 'subscribe', channel: 'remote:notify', class: 'remote' },
	onRemoteAppearance: { kind: 'subscribe', channel: 'remote:appearance', class: 'remote' },
	readMachineAppearance: {
		kind: 'invoke',
		channel: 'appearance:machine',
		class: 'remote',
		arity: 0,
		validate: noArgs,
	},
	readPullRequestPageUrl: {
		kind: 'invoke',
		channel: 'prs:url',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isId(a[0]) &&
			(a[1] === null || isId(a[1])) &&
			isId(a[2]) &&
			(a[3] === null || (Number.isSafeInteger(a[3]) && Number(a[3]) > 0)),
	},
	readPullRequestLinkUrl: {
		kind: 'invoke',
		channel: 'prs:link-url',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 && isId(a[0]) && (a[1] === null || isId(a[1])) && isId(a[2]) && isWebURL(a[3]),
	},
	readPullRequestUrl: {
		kind: 'invoke',
		channel: 'forge:url',
		class: 'remote',
		arity: 2,
		validate: (a) => a.length === 2 && isTaskKey(a[0]) && isId(a[1]),
	},
	uploadAttachment: {
		kind: 'invoke',
		channel: 'attachment:upload',
		class: 'remote',
		arity: 4,
		validate: (a) =>
			a.length === 4 &&
			isAttachmentOwner(a[0]) &&
			typeof a[1] === 'string' &&
			a[1].trim().length > 0 &&
			a[1].length <= 200 &&
			!/[/\\\0]/.test(a[1]) &&
			a[1] !== '.' &&
			a[1] !== '..' &&
			a[2] instanceof Uint8Array &&
			a[2].length > 0 &&
			a[2].length <= remoteUploadLimit &&
			typeof a[3] === 'boolean',
	},
} as const satisfies Record<keyof DesktopBridge, IpcRow>;

type Table = typeof ipcTable;
export type IpcMethod = keyof Table;
export type IpcInvokeChannel = {
	[K in IpcMethod]: Table[K] extends { kind: 'invoke'; channel: infer C } ? C : never;
}[IpcMethod];
export type IpcSubscribeChannel = {
	[K in IpcMethod]: Table[K] extends { kind: 'subscribe'; channel: infer C } ? C : never;
}[IpcMethod];
type Located<R> = R & { readonly method: IpcMethod };
const rows = Object.entries(ipcTable) as [IpcMethod, IpcRow][];
const byChannel = <R extends IpcInvokeRow | IpcSubscribeRow>(kind: R['kind']) => {
	const map = new Map<string, Located<R>>();
	for (const [method, row] of rows)
		if (row.kind === kind) {
			if (map.has(row.channel)) throw new Error(`Two ${kind} rows for ${row.channel}`);
			map.set(row.channel, { ...(row as R), method });
		}
	return map as ReadonlyMap<string, Located<R>>;
};
/** Main's lookup: the row an incoming invoke must satisfy. */
export const ipcInvokeRows = byChannel<IpcInvokeRow>('invoke');
export const ipcSubscribeRows = byChannel<IpcSubscribeRow>('subscribe');
export function ipcInvokeRow(channel: IpcInvokeChannel): Located<IpcInvokeRow> {
	return ipcInvokeRows.get(channel)!;
}
/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: why a call that came over the gateway is refused before any handler, or null. A
 * client-class row runs on the device's own machine and never crosses the gateway; a forbidden row never runs remotely.
 */
export function remoteCallRefusal(channel: string): string | null {
	const row = ipcInvokeRows.get(channel);
	if (!row) return 'Invalid IPC request';
	if (row.class === 'client') return 'This call runs on the device, not on the working machine.';
	if (row.remote === 'forbidden') return 'Not available from a remote device.';
	return null;
}
/** spec/remote-access-and-mobile#outbox: a call whose reply can run to megabytes (the row's `bulk`); the gateways serialize them per connection. */
export function isBulkCall(channel: string): boolean {
	return ipcInvokeRows.get(channel)?.bulk === true;
}
/** The class of an event channel: a client event (theme, app menu) never leaves its own machine. */
export function ipcEventClass(channel: IpcSubscribeChannel): IpcClass {
	return ipcSubscribeRows.get(channel)!.class;
}
/** Builds the renderer's `DesktopBridge` over a transport: only the table's named methods, nothing generic. */
export function createDesktopBridge(
	transport: BridgeTransport,
	env: BridgeEnvironment
): DesktopBridge {
	const bridge: Record<string, unknown> = {};
	for (const [method, row] of rows) {
		if (row.kind === 'local') bridge[method] = row.local(env, transport);
		else if (row.kind === 'subscribe')
			bridge[method] = (listener: (value: unknown) => void) =>
				transport.subscribe(row.channel, listener);
		else if (row.encode) {
			const encode = row.encode;
			bridge[method] = (...args: unknown[]) => {
				const sent = encode(args, env);
				return 'resolve' in sent
					? Promise.resolve(sent.resolve)
					: transport.invoke(row.channel, sent as readonly unknown[]);
			};
		} else {
			const arity = row.arity ?? 0;
			bridge[method] = (...args: unknown[]) =>
				transport.invoke(
					row.channel,
					Array.from({ length: arity }, (_, index) => args[index])
				);
		}
	}
	return bridge as unknown as DesktopBridge;
}
/** FNV-1a, 64 bit: a fingerprint, not a secret — the handshake runs inside mutual TLS. */
function fnv1a64(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < text.length; index++) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, '0');
}
const source = (fn: unknown) => (typeof fn === 'function' ? String(fn).replace(/\s+/g, '') : '');
/** spec/remote-access-and-mobile#architecture: what both sides compare before any call — methods, channels, kinds, classes and validators. Whitespace
 *  is ignored; both sides are the same build of the same commit, so the validator text matches when the code does. */
export function hashIpcTable(table: Readonly<Record<string, IpcRow>>): string {
	const lines = Object.keys(table)
		.sort()
		.map((method) => {
			const row = table[method]!;
			return [
				method,
				row.kind,
				'channel' in row ? row.channel : '',
				row.class,
				row.remote ?? '',
				'arity' in row ? String(row.arity ?? '') : '',
				'encode' in row ? source(row.encode) : '',
				'validate' in row ? source(row.validate) : '',
			].join('\u0001');
		});
	return fnv1a64(lines.join('\u0002'));
}
let tableHash: string | null = null;
export function ipcTableHash(): string {
	return (tableHash ??= hashIpcTable(ipcTable));
}
