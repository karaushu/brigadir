import { isId, isRecord } from './workspace';
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
export type WorkspaceMoveState = 'moving' | 'moved' | 'failed';
/** spec/crew#auto-move: the move of a task into a worktree; the newest event of an `id` is its chat row (rule 2: a normalized event). */
export type WorkspaceMoveEvent = {
	kind: 'workspace.move';
	id: string;
	/** The hire that asked for the move. */
	hireId: string;
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
		isId(value.hireId) &&
		['moving', 'moved', 'failed'].includes(String(value.state)) &&
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
