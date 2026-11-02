import type { Scope } from './changes';
import type { ScopeChoice, ScopeKind } from './launch';

/** spec/projects-and-board#external-folders: a folder without git has no tree, so no diff, snapshot or lock. */
export function isGitScope(scope: { kind?: ScopeKind }): boolean {
	return scope.kind !== 'folder';
}

/**
 * spec/projects-and-board#repo-selection: three functions over one `selected`; their result is stored nowhere.
 * `inTask` — diff, lock, write access, manifest.
 */
export function inTask(scope: { kind?: ScopeKind; selected: boolean }): boolean {
	return scope.selected && isGitScope(scope);
}

/** spec/projects-and-board#external-folders: an outside folder is part of the task's choice; unselecting it removes it from the task instead of leaving it unselected. */
export function outsideProject(scope: { kind?: ScopeKind }): boolean {
	return scope.kind === 'external' || scope.kind === 'folder';
}
export function listedInTask(scope: { kind?: ScopeKind; selected: boolean }): boolean {
	return scope.selected || !outsideProject(scope);
}

/** spec/projects-and-board#repo-selection: a snapshot for `scope.violation` (spec/projects-and-board#write-policy) — a project repo outside the task. */
export function watched(scope: { kind?: ScopeKind; selected: boolean }): boolean {
	return !scope.selected && isGitScope(scope) && listedInTask(scope);
}

/** spec/projects-and-board#external-folders: a folder the agent only reads. No diff, no lock, no writes. */
export function contextOnly(scope: { kind?: ScopeKind; selected: boolean }): boolean {
	return scope.selected && !isGitScope(scope);
}

/** The agent sees the folder: a selected git repo or a selected reference folder. The manifest follows this. */
export function visibleToAgent(scope: { kind?: ScopeKind; selected: boolean }): boolean {
	return scope.selected;
}

/** spec/projects-and-board#repo-selection and spec/projects-and-board#external-folders: writes go only to a selected git repo. */
export function writableByAgent(scope: {
	kind?: ScopeKind;
	selected: boolean;
	available?: boolean;
}): boolean {
	return inTask(scope) && scope.available !== false;
}

/** A snapshot is taken of every git repo of the project, selected or not (spec/projects-and-board#repo-selection); a removed outside folder is not (spec/projects-and-board#external-folders). */
export function snapshotted(scope: {
	kind?: ScopeKind;
	selected: boolean;
	available?: boolean;
}): boolean {
	return isGitScope(scope) && scope.available !== false && listedInTask(scope);
}

export function selectedScopes<T extends { kind?: ScopeKind; selected: boolean }>(
	scopes: T[]
): T[] {
	return scopes.filter(inTask);
}

/** The diff list: selected, available git repos. */
export function diffScopes(scopes: Scope[]): Scope[] {
	return scopes.filter((scope) => inTask(scope) && scope.available !== false);
}

/** The task's choice laid over the project's discovered repos. A newly found repo arrives unselected (spec/projects-and-board#repo-selection). */
export function applyChoices(scopes: Scope[], choices: ScopeChoice[] | undefined): Scope[] {
	if (!choices) return scopes;
	const byId = new Map(choices.map((choice) => [choice.id, choice]));
	return scopes.map((scope) => {
		const choice = byId.get(scope.id);
		return choice ? { ...scope, selected: choice.selected } : { ...scope, selected: false };
	});
}
