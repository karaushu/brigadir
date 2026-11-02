import { isRateReset } from './rate-limit';
import { isTaskArchive, type TaskArchive } from './archive';
import { isPRRef, type PRRef } from './forge';
import { isTaskKey, type TaskKey } from './session';
import { isAgentOption, type AgentOption } from './agent';
import { isTaskLaunch, isTaskPreparation, type TaskLaunch, type TaskPreparation } from './launch';
import { isCrewSpec, type CrewSpec } from './crew';
import { isProjectCommands, type ProjectCommand } from './project-commands';
import { isProjectSimulator, type ProjectSimulator } from './simulator';
import {
	isProjectIcon,
	isProjectIconPick,
	type ProjectIcon,
	type ProjectIconPick,
} from './project-icon';
/** `backlog` and `completed` are set only by the person (spec/projects-and-board#project-screen, spec/projects-and-board#board); agents never write them. */
export const taskStatuses = [
	'backlog',
	'queued',
	'preparing',
	'working',
	'needs-you',
	'done',
	'interrupted',
	'failed',
	'rate-limited',
	'completed',
] as const;
export type TaskStatus = (typeof taskStatuses)[number];
/** spec/editor-code-intelligence#format-on-save: `formatter` absent means `default`, the global Settings ▸ Editor choice. */
export type ProjectFormatter = 'default' | 'auto' | 'prettier' | 'language-server' | 'off';
export const projectFormatters: readonly ProjectFormatter[] = [
	'default',
	'auto',
	'prettier',
	'language-server',
	'off',
];
/** spec/search-menus-and-commands#project-commands: `commands` absent means none; an empty list is never written. */
/** spec/browser-and-simulator#simulator: `simulator` — the device the project chose last. */
export type Project = {
	commands?: ProjectCommand[];
	simulator?: ProjectSimulator;
	pullRequestBases?: Record<string, string>;
	formatter?: ProjectFormatter;
	/** spec/appearance#evolution-redesign: the icon the sidebar, the boards and the archive show; absent until the agent picked once. */
	icon?: ProjectIcon;
	/** The agent's last pick with its reason and suggestions (the picker's «Picked by the agent»). */
	iconPick?: ProjectIconPick;
	/** Not stored: main sets it while the agent picks the icon (spec/appearance#evolution-redesign, «Picking an icon…»). */
	iconPicking?: boolean;
	/** Not stored: main sets it while Codex draws the icon (spec/projects-and-board#project-icon, «Generating…»). */
	iconGenerating?: boolean;
	id: string;
	name: string;
	path: string;
};
/** `modelName`/`effortName` are the provider's names at launch (spec/projects-and-board#board rule 6); `updatedAt` is derived from task.json mtime when read. */
/** `plan` is a permission that is a plan for approval (spec/chat-turns-plans-and-questions#plan-approval). */
export type TaskActivity = {
	kind: 'tool' | 'permission' | 'question' | 'plan' | 'proposal';
	title: string;
	path: string | null;
};
/** spec/crew-templates-and-editor#snapshot: `crew` marks a foreman task and is its immutable snapshot; workers carry `crewTaskId`, `crewNodeId` and `parentTaskId`. */
/** spec/pull-requests-and-ci#review-modal, spec/pull-requests-and-ci#review-with-agent: a task that reviews or fixes a PR: repo, number, mode and the PR base for Create PR (`<head>-fixes → <head>`). */
/** spec/pull-requests-and-ci#resolve-conflicts: `conflicts` — the task that merges the base into the PR branch to resolve its conflicts. */
export type TaskPRReview = {
	scopeId: string;
	number: number;
	mode: 'review' | 'fix' | 'conflicts';
	base: string;
};
export type SlackThreadRef = { channel: string; ts: string; permalink: string | null };
export function isSlackThreadRef(value: unknown): value is SlackThreadRef {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		typeof value.channel === 'string' &&
		/^[A-Z0-9]{2,40}$/.test(value.channel) &&
		typeof value.ts === 'string' &&
		/^\d{1,12}\.\d{1,8}$/.test(value.ts) &&
		(value.permalink === null ||
			(typeof value.permalink === 'string' &&
				value.permalink.length <= 2048 &&
				/^https:\/\/[^\s/]+\.slack\.com\/\S*$/.test(value.permalink)))
	);
}
export type AgentTask = {
	/** spec/tasks#archive: in the archive; absent — a live task. */ archived?: TaskArchive;
	/** spec/tasks#archive: when the person marked it completed. */ completedAt?: string;
	prReview?: TaskPRReview;
	crew?: CrewSpec;
	crewTaskId?: string;
	crewNodeId?: string;
	parentTaskId?: string;
	/** spec/projects-and-board#repo-selection: the «writes no code» right lives on the agent, not on the repo set. */ readOnlyAgent?: boolean;
	/** spec/crew#parts: the checkpoint every change surface counts from (a crew part's start); none — the first one. */ changeBase?: number;
	activity?: TaskActivity | null;
	/** spec/chat-turns-plans-and-questions#background-commands: background commands still running after the turn (the host keeps it from the journal). */ background?:
		import('./background').BackgroundSummary | null;
	changeSummary?: { additions: number; deletions: number };
	/** `scopeId` (spec/tasks#agent-worktrees): a checkout of the root's repo from outside the project stands for the root. */
	taskTree?: { branch: string | null; worktree: boolean; scopeId?: string };
	pinned?: boolean;
	rateLimit?: { resetsAt: number | null } | null;
	/** spec/agents-and-providers#sign-in-recovery: the last failure was the agent's sign-in; a new turn or session clears it. */ failure?:
		'auth' | null;
	pullRequests?: Record<string, PRRef>;
	relayIssue?: 'summary-failed' | 'source-unavailable' | null;
	continuesTaskId?: string;
	/** spec/tasks#agent-created-tasks: the task whose agent proposed this one with `create_task` (same project). */ originTaskId?: string;
	/** spec/notifications-slack-notes-and-schedules#schedules: a run of a schedule; `quiet` — kept out of Tasks until it waits for the person, fails or leaves changes. */ scheduleRun?: {
		scheduleId: string;
		due: string;
		quiet: boolean;
	};
	relaySelection?: RelaySelection;
	/** spec/notifications-slack-notes-and-schedules#slack: the Slack thread whose `@bot` mention made this task; `permalink` opens it (`From Slack`). */ slackThread?: SlackThreadRef;
	id: string;
	projectId: string;
	title: string;
	status: TaskStatus;
	provider?: 'claude' | 'codex';
	transport?: 'gui' | 'terminal';
	prompt?: string;
	modelName?: string;
	effortName?: string;
	updatedAt?: string;
	agentOptions?: AgentOption[];
	launchOptions?: { id: string; value: string | boolean }[];
	hasStarted?: boolean;
	/** spec/tasks#backlog-edit: a backlog task's attachments, sent with its first prompt. */ attachments?: PromptAttachment[];
	activitySeq?: number;
	hasUnread?: boolean;
	hasUnreviewedChanges?: boolean;
	scopeNames?: string[];
	worktreeBranch?: string;
	launch?: TaskLaunch;
	preparation?: TaskPreparation;
	blockedBy?: TaskKey[];
};
export type ReadIssueCode =
	'invalid_document' | 'unsupported_schema' | 'unreadable' | 'unsafe_path';
export type ReadIssue = { path: string; code: ReadIssueCode };
/** Desktop may include its home directory for display-only path abbreviation. */
export type WorkspaceSnapshot = {
	homeDirectory?: string;
	projects: Project[];
	tasks: AgentTask[];
	issues: ReadIssue[];
};
export type ProjectDocument = { schemaVersion: 1; project: Project };
export type TaskDocument = { schemaVersion: 1; task: AgentTask };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}
function isText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}
export function isProject(value: unknown): value is Project {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isText(value.name) &&
		isText(value.path) &&
		value.path.startsWith('/') &&
		(value.formatter === undefined ||
			projectFormatters.includes(value.formatter as ProjectFormatter)) &&
		(value.commands === undefined || isProjectCommands(value.commands)) &&
		(value.simulator === undefined || isProjectSimulator(value.simulator)) &&
		(value.icon === undefined || isProjectIcon(value.icon)) &&
		(value.iconPick === undefined || isProjectIconPick(value.iconPick)) &&
		(value.iconPicking === undefined || typeof value.iconPicking === 'boolean') &&
		(value.iconGenerating === undefined || typeof value.iconGenerating === 'boolean') &&
		(value.pullRequestBases === undefined ||
			(isRecord(value.pullRequestBases) &&
				Object.entries(value.pullRequestBases).every(
					([key, base]) =>
						key.length <= 4096 &&
						typeof base === 'string' &&
						base.length <= 512 &&
						!/[\x00-\x20]/.test(base)
				)))
	);
}
export function isAgentTask(value: unknown): value is AgentTask {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isId(value.projectId) &&
		isText(value.title) &&
		(value.rateLimit === undefined ||
			value.rateLimit === null ||
			(isRecord(value.rateLimit) && isRateReset(value.rateLimit.resetsAt))) &&
		(value.pullRequests === undefined ||
			(isRecord(value.pullRequests) &&
				Object.keys(value.pullRequests).length <= 512 &&
				Object.entries(value.pullRequests).every(
					([id, ref]) => /^[a-f0-9]{16}$/.test(id) && isPRRef(ref)
				))) &&
		(value.failure === undefined || value.failure === null || value.failure === 'auth') &&
		(value.relayIssue === undefined ||
			value.relayIssue === null ||
			value.relayIssue === 'summary-failed' ||
			value.relayIssue === 'source-unavailable') &&
		(value.continuesTaskId === undefined ||
			(isId(value.continuesTaskId) && value.continuesTaskId !== value.id)) &&
		(value.originTaskId === undefined ||
			(isId(value.originTaskId) && value.originTaskId !== value.id)) &&
		(value.relaySelection === undefined || isRelaySelection(value.relaySelection)) &&
		(value.slackThread === undefined || isSlackThreadRef(value.slackThread)) &&
		(value.scheduleRun === undefined ||
			(isRecord(value.scheduleRun) &&
				typeof value.scheduleRun.scheduleId === 'string' &&
				/^s_[a-z0-9]{6,24}$/.test(value.scheduleRun.scheduleId) &&
				typeof value.scheduleRun.due === 'string' &&
				value.scheduleRun.due.length <= 40 &&
				typeof value.scheduleRun.quiet === 'boolean')) &&
		(value.transport === undefined ||
			value.transport === 'gui' ||
			value.transport === 'terminal') &&
		taskStatuses.some((status) => status === value.status) &&
		(value.prompt === undefined || typeof value.prompt === 'string') &&
		(value.provider === undefined || value.provider === 'claude' || value.provider === 'codex') &&
		(value.blockedBy === undefined ||
			(Array.isArray(value.blockedBy) &&
				value.blockedBy.length <= 512 &&
				value.blockedBy.every(isTaskKey))) &&
		(value.scopeNames === undefined ||
			(Array.isArray(value.scopeNames) &&
				value.scopeNames.length <= 512 &&
				value.scopeNames.every((name) => typeof name === 'string' && name.length <= 4096))) &&
		(value.launch === undefined || isTaskLaunch(value.launch)) &&
		(value.preparation === undefined || isTaskPreparation(value.preparation)) &&
		(value.worktreeBranch === undefined ||
			(typeof value.worktreeBranch === 'string' && value.worktreeBranch.length <= 4096)) &&
		(value.activitySeq === undefined ||
			(Number.isSafeInteger(value.activitySeq) && (value.activitySeq as number) >= 0)) &&
		(value.changeBase === undefined ||
			(Number.isSafeInteger(value.changeBase) && (value.changeBase as number) >= 0)) &&
		(value.hasUnreviewedChanges === undefined || typeof value.hasUnreviewedChanges === 'boolean') &&
		(value.background === undefined ||
			value.background === null ||
			isBackgroundSummary(value.background)) &&
		(value.activity === undefined ||
			value.activity === null ||
			(isRecord(value.activity) &&
				['tool', 'permission', 'question', 'plan', 'proposal'].includes(
					value.activity.kind as string
				) &&
				typeof value.activity.title === 'string' &&
				(value.activity.path === null || typeof value.activity.path === 'string'))) &&
		(value.changeSummary === undefined ||
			(isRecord(value.changeSummary) &&
				[value.changeSummary.additions, value.changeSummary.deletions].every(
					(count) => Number.isSafeInteger(count) && (count as number) >= 0
				))) &&
		(value.taskTree === undefined ||
			(isRecord(value.taskTree) &&
				typeof value.taskTree.worktree === 'boolean' &&
				(value.taskTree.branch === null || typeof value.taskTree.branch === 'string') &&
				(value.taskTree.scopeId === undefined || typeof value.taskTree.scopeId === 'string'))) &&
		(value.crew === undefined || isCrewSpec(value.crew)) &&
		(value.crewTaskId === undefined || isId(value.crewTaskId)) &&
		(value.crewNodeId === undefined || isId(value.crewNodeId)) &&
		(value.parentTaskId === undefined ||
			(isId(value.parentTaskId) && value.parentTaskId !== value.id)) &&
		(value.crewTaskId === undefined) === (value.crewNodeId === undefined) &&
		(value.parentTaskId === undefined || value.crewTaskId !== undefined) &&
		(value.archived === undefined || isTaskArchive(value.archived)) &&
		(value.completedAt === undefined ||
			(typeof value.completedAt === 'string' &&
				value.completedAt.length <= 40 &&
				Number.isFinite(Date.parse(value.completedAt)))) &&
		(value.pinned === undefined || typeof value.pinned === 'boolean') &&
		(value.hasUnread === undefined || typeof value.hasUnread === 'boolean') &&
		(value.hasStarted === undefined || typeof value.hasStarted === 'boolean') &&
		(value.attachments === undefined || isAttachmentList(value.attachments)) &&
		(value.agentOptions === undefined ||
			(Array.isArray(value.agentOptions) &&
				value.agentOptions.length <= 128 &&
				value.agentOptions.every(isAgentOption))) &&
		(value.launchOptions === undefined ||
			(Array.isArray(value.launchOptions) &&
				value.launchOptions.length <= 128 &&
				value.launchOptions.every(
					(option) =>
						isRecord(option) &&
						typeof option.id === 'string' &&
						(typeof option.value === 'string' || typeof option.value === 'boolean')
				))) &&
		['modelName', 'effortName', 'updatedAt'].every(
			(field) =>
				value[field] === undefined ||
				(typeof value[field] === 'string' && (value[field] as string).length <= 200)
		)
	);
}
import { isRelaySelection, type RelaySelection } from './relay';
import { isAttachmentList, type PromptAttachment } from './attachments';

export function isTaskTitle(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		value.length <= 160 &&
		!/[\r\n\0]/.test(value)
	);
}

/**
 * spec/tasks#quick-tasks: the project's main tree — a hidden task record with this id (not a UUID, so it never collides).
 * Not shown in the sidebar, on the board or in search; no agent starts in it — handing it to an agent creates a quick task.
 */
export const MAIN_TREE_ID = 'main-tree';
export function isMainTree(key: { id: string } | null | undefined): boolean {
	return key?.id === MAIN_TREE_ID;
}
/** Branch state of a main-tree repo for a quick task on a PR branch (spec/tasks#quick-tasks). */
export type MainTreeBranch = {
	scopeId: string;
	current: string | null;
	branch: string;
	dirty: boolean;
	exists: boolean;
};

import { isBackgroundSummary } from './background';
