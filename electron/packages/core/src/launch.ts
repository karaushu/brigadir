import { isId, isRecord } from './workspace';
import { suggestedBranch, validBranch } from './branch-name';
import { isLaunchSwitches, type LaunchSwitch } from './branch-switch';
/** spec/projects-and-board#external-folders: `external` is a git repo outside the project root, `folder` a folder without git. */
export type ScopeKind = 'root' | 'submodule' | 'nested' | 'worktree' | 'external' | 'folder';
export const scopeKinds: ScopeKind[] = [
	'root',
	'submodule',
	'nested',
	'worktree',
	'external',
	'folder',
];
/** spec/projects-and-board#repo-selection: a repo is either in the task or not. */
export type ScopeChoice = {
	kind?: ScopeKind;
	id: string;
	name: string;
	selected: boolean;
	path?: string;
	/** spec/tasks#agent-worktrees: a folder from outside that is another checkout of the task root's repo; it stands for the root in the composer. */
	worktreeOf?: string;
};
/** `copyEnvFiles` (spec/git#worktree-env): the worktree gets the project's ignored `.env*` files; absent means no.
 *  `branchAuto` (spec/git#agent-branch-names): the agent names the branch at preparation; `branch` meanwhile holds the name derived from the text. */
export type TaskLaunch = {
	isolation: 'in-place' | 'worktree';
	branch: string;
	branchAuto?: boolean;
	baseRef: string;
	setupCommand: string;
	copyEnvFiles?: boolean;
	scopes: ScopeChoice[];
	/** spec/git#main-tree-branches: without isolation, the branches to switch to before the agent starts; never remembered for the project. */ switches?: LaunchSwitch[];
	/** spec/git#pull: without isolation, the repos to fetch and fast-forward before the agent starts; never remembered for the project. */ pull?: string[];
};
/** `crewTemplateId` remembers the last crew chosen for a Brigadir task in this project (spec/tasks#sheet-rail). */
export type LaunchSettings = {
	isolation: TaskLaunch['isolation'];
	baseRef: string;
	setupCommand: string;
	copyEnvFiles?: boolean;
	scopes: ScopeChoice[];
	crewTemplateId?: string;
};
export type TaskPreparation = {
	state: 'preparing' | 'failed' | 'ready';
	step: string;
	error?: string;
};
/** Accepts both forms: `selected`, and the legacy pair of flags (spec/projects-and-board#repo-selection, migration).
 *  A record with neither is invalid. */
export function isScopeChoice(value: unknown): value is ScopeChoice {
	return (
		isRecord(value) &&
		(value.kind === undefined || scopeKinds.includes(value.kind as ScopeKind)) &&
		typeof value.id === 'string' &&
		/^[a-f0-9]{16}$/.test(value.id) &&
		typeof value.name === 'string' &&
		value.name.length <= 4096 &&
		(value.path === undefined || (typeof value.path === 'string' && value.path.length <= 4096)) &&
		(value.worktreeOf === undefined ||
			(typeof value.worktreeOf === 'string' && /^[a-f0-9]{16}$/.test(value.worktreeOf))) &&
		(typeof value.selected === 'boolean' ||
			(typeof value.agentWritable === 'boolean' && typeof value.diffEnabled === 'boolean'))
	);
}
/** spec/projects-and-board#repo-selection: `selected = agentWritable`. Write access decides, showing the diff does not.
 *  A pair `diff: true, write: false` becomes unselected: we never grant access the person did not give. */
export function scopeSelected(value: { selected?: boolean; agentWritable?: boolean }): boolean {
	return typeof value.selected === 'boolean' ? value.selected : value.agentWritable === true;
}
/** Normalizes a record of either form into the current one. Legacy fields are not carried into the model. */
export function normalizeScopeChoice(
	value: ScopeChoice & { diffEnabled?: boolean; agentWritable?: boolean }
): ScopeChoice {
	const { diffEnabled: _diff, agentWritable: _write, ...rest } = value;
	return { ...rest, selected: scopeSelected(value) };
}
export function isLaunchSettings(value: unknown): value is LaunchSettings {
	return (
		isRecord(value) &&
		(value.isolation === 'in-place' || value.isolation === 'worktree') &&
		typeof value.baseRef === 'string' &&
		value.baseRef.length > 0 &&
		value.baseRef.length <= 240 &&
		!value.baseRef.startsWith('-') &&
		!/[\s\0]/.test(value.baseRef) &&
		typeof value.setupCommand === 'string' &&
		value.setupCommand.length <= 100000 &&
		!value.setupCommand.includes('\0') &&
		(value.copyEnvFiles === undefined || typeof value.copyEnvFiles === 'boolean') &&
		(value.branchAuto === undefined || typeof value.branchAuto === 'boolean') &&
		Array.isArray(value.scopes) &&
		value.scopes.length <= 512 &&
		value.scopes.every(isScopeChoice) &&
		new Set(value.scopes.map((scope) => scope.id)).size === value.scopes.length &&
		(value.crewTemplateId === undefined || isId(value.crewTemplateId))
	);
}
/** spec/git#agent-branch-names: an empty branch is an auto one — the derived name holds the place until the agent names it at preparation. */
export function withAutoBranch(
	launch: TaskLaunch,
	title: string,
	prompt: string,
	id: string
): TaskLaunch {
	return launch.branch
		? launch
		: { ...launch, branch: suggestedBranch(title, prompt, id), branchAuto: true };
}
export function isLaunchInput(value: unknown): value is TaskLaunch {
	return (
		isRecord(value) &&
		typeof value.branch === 'string' &&
		(value.branch === '' || validBranch(value.branch)) &&
		isLaunchSettings(value) &&
		switchesValid(value)
	);
}
const switchesValid = (value: Record<string, unknown>) =>
	(value.switches === undefined ||
		(value.isolation === 'in-place' && isLaunchSwitches(value.switches))) &&
	(value.pull === undefined ||
		(value.isolation === 'in-place' &&
			Array.isArray(value.pull) &&
			value.pull.length <= 64 &&
			value.pull.every((id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) &&
			new Set(value.pull).size === value.pull.length));
export function isTaskLaunch(value: unknown): value is TaskLaunch {
	return (
		isRecord(value) &&
		typeof value.branch === 'string' &&
		(value.isolation === 'in-place' || validBranch(value.branch)) &&
		isLaunchSettings(value) &&
		switchesValid(value)
	);
}
export function isTaskPreparation(value: unknown): value is TaskPreparation {
	return (
		isRecord(value) &&
		['preparing', 'failed', 'ready'].includes(String(value.state)) &&
		typeof value.step === 'string' &&
		value.step.length <= 4096 &&
		(value.error === undefined || (typeof value.error === 'string' && value.error.length <= 100000))
	);
}
