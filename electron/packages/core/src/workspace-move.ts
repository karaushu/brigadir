import { isId, isMainTree, isRecord, type AgentTask } from './workspace';
/**
 * spec/crew#auto-move: why a path of the task stayed in the project folder when the task moved into a worktree.
 * `person` — changed outside the agent's turns or by the person's Save; `moving` — the person changed it while the move ran;
 * `conflict` — also changed before the task and the task's change does not merge onto `HEAD`; `ignored` — git ignores it;
 * `outside` — it lies in no repo of the worktree.
 */
export type WorkspaceStayReason = 'person' | 'moving' | 'conflict' | 'ignored' | 'outside';
export const workspaceStayReasons: readonly WorkspaceStayReason[] = [
	'person',
	'moving',
	'conflict',
	'ignored',
	'outside',
];
/** A path that stayed, relative to the project folder. */
export type WorkspaceStayed = { path: string; reason: WorkspaceStayReason };
/** spec/crew#auto-move: how many stayed paths an event carries; the chat row shows 20 of them. */
export const workspaceStayedLimit = 200;
/**
 * spec/tasks#worktree-move: `waiting` — the person's move waits for the agent's turn to end; `cancelled` — the person cancelled it while it
 * waited. A hire's move starts at `moving`.
 */
export type WorkspaceMoveState = 'waiting' | 'moving' | 'moved' | 'failed' | 'cancelled';
export const workspaceMoveStates: readonly WorkspaceMoveState[] = [
	'waiting',
	'moving',
	'moved',
	'failed',
	'cancelled',
];
/** spec/crew#auto-move, spec/tasks#worktree-move: the move of a task into a worktree; the newest event of an `id` is its chat row (rule 2: a normalized event). */
export type WorkspaceMoveEvent = {
	kind: 'workspace.move';
	id: string;
	/** The hire that asked for the move; absent when the person started it (`by: 'person'`). */
	hireId?: string;
	by?: 'person';
	state: WorkspaceMoveState;
	/** The repos that move, by name: the project's name for the root, the relative path for the others. */
	repos: string[];
	branch?: string;
	/** The root repo's branch (or short commit) the worktree started from. */
	base?: string;
	stayed?: WorkspaceStayed[];
	/** Why the move failed, as git or the step gave it. */
	message?: string;
};
const text = (value: unknown): value is string => typeof value === 'string';
export function isWorkspaceStayed(value: unknown): value is WorkspaceStayed {
	return (
		isRecord(value) &&
		text(value.path) &&
		value.path.length <= 4096 &&
		workspaceStayReasons.includes(value.reason as WorkspaceStayReason)
	);
}
/** The event's fields (the validator checks `kind` itself). */
export function isWorkspaceMoveFields(value: unknown): boolean {
	return (
		isRecord(value) &&
		isId(value.id) &&
		(isId(value.hireId)
			? value.by === undefined
			: value.hireId === undefined && value.by === 'person') &&
		workspaceMoveStates.includes(value.state as WorkspaceMoveState) &&
		Array.isArray(value.repos) &&
		value.repos.length <= 512 &&
		value.repos.every(text) &&
		(value.branch === undefined || text(value.branch)) &&
		(value.base === undefined || text(value.base)) &&
		(value.message === undefined || text(value.message)) &&
		(value.stayed === undefined ||
			(Array.isArray(value.stayed) &&
				value.stayed.length <= workspaceStayedLimit &&
				value.stayed.every(isWorkspaceStayed)))
	);
}
/** A tree entry of one path: git mode and object id; null — the path is absent. */
export type MoveEntry = { mode: string; oid: string } | null;
export type MoveFate =
	| { kind: 'skip' }
	| { kind: 'take' }
	| { kind: 'merge' }
	| { kind: 'stay'; reason: WorkspaceStayReason };
const same = (a: MoveEntry, b: MoveEntry) =>
	a === b || (!!a && !!b && a.mode === b.mode && a.oid === b.oid);
const gitlink = (entry: MoveEntry) => entry?.mode === '160000';
const regular = (entry: MoveEntry) => entry?.mode === '100644' || entry?.mode === '100755';
/**
 * spec/crew#auto-move: what happens to one path the task changed (`base` at the task's start, `current` the last checkpoint, `head` the
 * repo's `HEAD`). Pure, so the rules are tested without git.
 */
export function moveFate(
	base: MoveEntry,
	head: MoveEntry,
	current: MoveEntry,
	changedByPerson: boolean
): MoveFate {
	// A submodule's commit moves with the submodule's own repo.
	if (gitlink(base) || gitlink(head) || gitlink(current)) return { kind: 'skip' };
	if (same(current, head)) return { kind: 'skip' };
	if (changedByPerson) return { kind: 'stay', reason: 'person' };
	if (same(base, head)) return { kind: 'take' };
	// Changed before the task too: only a text file on all three sides merges.
	if (regular(base) && regular(head) && regular(current)) return { kind: 'merge' };
	return { kind: 'stay', reason: 'conflict' };
}

/**
 * spec/tasks#agent-worktrees: a git worktree made in the task's turns joined the task as a folder. `by: 'agent'` — the host saw the agent make
 * it; `by: 'person'` — the host could not tell and the person allowed it on a card. The chat row says which branch now holds the work.
 */
export type WorktreeJoinedEvent = {
	kind: 'worktree.joined';
	scopeId: string;
	name: string;
	path: string;
	/** The task's repo it is a checkout of, by name (the project's name for the root). */
	repo: string;
	/** Its branch; absent on a detached `HEAD`. */
	branch?: string;
	/** True when it is a checkout of the task root's repo: its branch is the task's branch from now on. */
	standsForRoot: boolean;
	by: 'agent' | 'person';
};
/** spec/tasks#agent-worktrees: a joined worktree's folder is gone (removed by the agent, or missing after a restart). */
export type WorktreeRemovedEvent = {
	kind: 'worktree.removed';
	scopeId: string;
	name: string;
	path: string;
	branch?: string;
	/** The branch still exists in the repo, with its commits. */
	branchKept: boolean;
};
export function isWorktreeJoinedFields(value: unknown): boolean {
	return (
		isRecord(value) &&
		isId(value.scopeId) &&
		text(value.name) &&
		text(value.path) &&
		text(value.repo) &&
		(value.branch === undefined || text(value.branch)) &&
		typeof value.standsForRoot === 'boolean' &&
		(value.by === 'agent' || value.by === 'person')
	);
}
export function isWorktreeRemovedFields(value: unknown): boolean {
	return (
		isRecord(value) &&
		isId(value.scopeId) &&
		text(value.name) &&
		text(value.path) &&
		(value.branch === undefined || text(value.branch)) &&
		typeof value.branchKept === 'boolean'
	);
}
/** spec/tasks#move-to-worktree: why the person's `Move to a worktree` cannot run (message keys, English is the key). */
export const moveRefusals = {
	role: 'Only a solo or Auto task moves into a worktree.',
	terminal: 'A task in the terminal cannot move: its agent would stop.',
	busy: 'The task cannot restart now.',
	git: 'The project has no Git repository.',
} as const;
export type MoveRefusal = (typeof moveRefusals)[keyof typeof moveRefusals];
/**
 * spec/tasks#move-to-worktree: whether the person's move applies. `worktree` — the task already has one (the item is not shown); a refusal —
 * shown disabled with that reason; null — it can move. One rule for the menus and the host.
 */
export function moveRefusal(
	task: Pick<
		AgentTask,
		| 'id'
		| 'launch'
		| 'transport'
		| 'crew'
		| 'auto'
		| 'crewTaskId'
		| 'readOnlyAgent'
		| 'provider'
		| 'status'
		| 'preparation'
	>,
	state: { moving: boolean; git: boolean }
): MoveRefusal | 'worktree' | null {
	if (task.launch?.isolation === 'worktree') return 'worktree';
	if (
		isMainTree(task) ||
		!task.provider ||
		task.crewTaskId !== undefined ||
		task.readOnlyAgent === true ||
		(task.crew !== undefined && task.auto === undefined)
	)
		return moveRefusals.role;
	if (task.transport === 'terminal') return moveRefusals.terminal;
	if (
		state.moving ||
		task.status === 'backlog' ||
		task.status === 'queued' ||
		task.preparation?.state === 'preparing'
	)
		return moveRefusals.busy;
	if (!state.git) return moveRefusals.git;
	return null;
}
