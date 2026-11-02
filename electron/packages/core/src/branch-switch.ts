import { isRecord } from './workspace';
import { validBranch } from './branch-name';
import { isBranchName, isGitScopeId, isCommitSha } from './git-history';

/** spec/git#main-tree-branches: a branch as the picker shows it. `ahead`/`behind` count against the upstream as of the last fetch;
 *  `gone` — the upstream was deleted (a merged PR); `worktree` — the branch is checked out in another worktree. */
export type SwitchBranch = {
	name: string;
	remote: boolean;
	current: boolean;
	ahead: number;
	behind: number;
	upstream: string | null;
	gone: boolean;
	worktree: string | null;
	/** The task whose worktree holds the branch, when it is one of ours. */ worktreeTask:
		string | null;
};
/** A change in the tree, as the dirty step lists it (`?` — a new file). */
export type DirtyFile = {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	untracked: boolean;
};
export type StashEntry = {
	sha: string;
	branch: string | null;
	message: string;
	files: number;
	time: number;
	/** Made by the branch switch (spec/git#main-tree-branches). */ ours: boolean;
};
export type LastCommit = { sha: string; subject: string; pushed: boolean; root: boolean };
/** Who holds the repo: a task without isolation with a live host (spec/tasks#launch-sheet); the picker is read-only then (spec/git#main-tree-branches). */
export type RepoHolder = { projectId: string; id: string; title: string };
export type BranchSwitchState = {
	scopeId: string;
	current: string | null;
	dirty: DirtyFile[];
	branches: SwitchBranch[];
	stashes: number;
	heldBy: RepoHolder | null;
	last: LastCommit | null;
};
/** `clean` — the tree has no changes; the other three are the dirty step's choices. */
export type SwitchMode = 'clean' | 'stash' | 'carry' | 'discard';
export type SwitchRequest = {
	branch: string;
	mode: SwitchMode;
	/** Discard removes only these new files; anything else new since the step stays. */ discardPaths?: string[];
	/** Fetch failed and the person chose «Switch without pull». */ offline?: boolean;
};
export type SwitchResult = { current: string; pulled: number; stash: string | null };
export type CreateBranchRequest = { name: string; base: string };
/** The branch a task without isolation needs before its agent starts (spec/git#main-tree-branches). `create` — a new branch from `base`. */
export type LaunchSwitch = {
	scopeId: string;
	branch: string;
	dirty?: 'stash' | 'carry';
	create?: { base: string };
};

/** A fetch that failed tells the renderer it can switch without it (spec/git#main-tree-branches). */
export const FETCH_FAILED = 'Could not fetch the branch from origin.';
/** «Bring the changes» refused by git: the target touches the same files (spec/git#main-tree-branches). */
export const CARRY_CONFLICT_MESSAGE = 'Your changes conflict with the branch. Nothing was changed.';
/** A stash message that marks our own entry; the arrow keeps it readable in `git stash list`. */
export const stashMessage = (from: string | null, to: string) =>
	`brigadir: ${from ?? 'HEAD'} → ${to}`;
export const isOurStash = (message: string) => /(?:^|: )brigadir: /.test(message);

export function isSwitchRequest(value: unknown): value is SwitchRequest {
	return (
		isRecord(value) &&
		isBranchName(value.branch) &&
		['clean', 'stash', 'carry', 'discard'].includes(value.mode as string) &&
		(value.discardPaths === undefined ||
			(Array.isArray(value.discardPaths) &&
				value.discardPaths.length <= 5000 &&
				value.discardPaths.every(isRepoPath))) &&
		(value.offline === undefined || typeof value.offline === 'boolean')
	);
}
export function isCreateBranchRequest(value: unknown): value is CreateBranchRequest {
	return (
		isRecord(value) &&
		typeof value.name === 'string' &&
		validBranch(value.name) &&
		isBranchName(value.base)
	);
}
export function isLaunchSwitch(value: unknown): value is LaunchSwitch {
	return (
		isRecord(value) &&
		isGitScopeId(value.scopeId) &&
		typeof value.branch === 'string' &&
		isBranchName(value.branch) &&
		(value.dirty === undefined || value.dirty === 'stash' || value.dirty === 'carry') &&
		(value.create === undefined ||
			(isRecord(value.create) && validBranch(value.branch) && isBranchName(value.create.base)))
	);
}
export function isLaunchSwitches(value: unknown): value is LaunchSwitch[] {
	return (
		Array.isArray(value) &&
		value.length <= 64 &&
		value.every(isLaunchSwitch) &&
		new Set(value.map((item) => (item as LaunchSwitch).scopeId)).size === value.length
	);
}
export function isStashSha(value: unknown): value is string {
	return isCommitSha(value);
}
/** A path inside the repo as git prints it: relative, no `..` part, no NUL. */
export function isRepoPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.includes('\0') &&
		!value.startsWith('/') &&
		!value.split('/').includes('..')
	);
}
/** `origin/feat/x` → `feat/x`: a remote branch is switched to as its local twin. */
export function localName(branch: Pick<SwitchBranch, 'name' | 'remote'>): string {
	return branch.remote ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name;
}
