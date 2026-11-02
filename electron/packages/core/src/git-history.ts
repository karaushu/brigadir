import type { ChangedFile, Scope } from './changes';
import { inTask, isGitScope } from './scope-select';

/** spec/git#merge: a branch as git sees it. There is no branch registry of our own. */
export type GitBranch = { name: string; remote: boolean; updatedAt: number };
export type BranchList = { scopeId: string; current: string | null; branches: GitBranch[] };
/** spec/editor#line-author: in a file's history, `file` is that file in this commit: its path then, its lines, the path it was renamed from. */
export type HistoryFileStat = {
	path: string;
	additions: number;
	deletions: number;
	renamedFrom?: string;
};
export type HistoryCommit = {
	sha: string;
	subject: string;
	author: string;
	time: number;
	parents: string[];
	files: number;
	file?: HistoryFileStat;
};
export type HistoryPage = {
	scopeId: string;
	branch: string;
	commits: HistoryCommit[];
	truncated: boolean;
	path?: string;
	/** spec/git#history-search: the search this page answers, over the whole history of the branch. */
	query?: string;
};
/** spec/editor#line-author: pages of 100, up to 1000 commits. */
export const historyPageSize = 100,
	historyLimitMax = 1000;
/** spec/git#history-search: the History search text as main takes it: trimmed, one line, at most 200 characters. */
export function isHistoryQuery(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 200 &&
		value === value.trim() &&
		!/\p{Cc}/u.test(value)
	);
}
/** spec/git#history-search: the text of the search field as History sends it: control characters become spaces, then trim and cut. */
export function historyQuery(text: string): string {
	return text
		.replace(/\p{Cc}/gu, ' ')
		.trim()
		.slice(0, 200)
		.trimEnd();
}
/** spec/git#history-search: while git searches, the rows already on screen narrow by the same text: subject, author or SHA prefix. */
export function historyCommitMatches(
	commit: Pick<HistoryCommit, 'sha' | 'subject' | 'author'>,
	query: string
): boolean {
	const text = query.toLocaleLowerCase();
	return (
		!text ||
		commit.sha.startsWith(text) ||
		[commit.subject, commit.author].some((value) => value.toLocaleLowerCase().includes(text))
	);
}
export type CommitFiles = { scopeId: string; sha: string; files: ChangedFile[] };
/** A scope the History selector can pick; `available: false` shows disabled. */
export type HistoryScope = Pick<Scope, 'id' | 'name' | 'kind' | 'selected' | 'branch'> & {
	available: boolean;
	canMerge: boolean;
};

/** spec/git#merge: the selector lists git scopes only — a folder without git has no branches or commits. */
export function historyScopes(scopes: Scope[]): HistoryScope[] {
	return scopes.filter(isGitScope).map((scope) => ({
		id: scope.id,
		name: scope.name,
		kind: scope.kind,
		selected: scope.selected,
		branch: scope.branch,
		available: scope.available !== false,
		canMerge: canMergeInto(scope),
	}));
}
/** A merge writes to the working tree, so only a repo of the task that exists on disk. */
export function canMergeInto(scope: Pick<Scope, 'kind' | 'selected' | 'available'>): boolean {
	return inTask(scope) && scope.available !== false;
}

export type MergeFile = { path: string; additions: number; deletions: number };
/** What arrives if `from` is merged into `into`; `merge-tree` predicts the conflicts, the tree is not touched. */
export type MergePreview = {
	scopeId: string;
	into: string;
	from: string;
	commits: number;
	files: MergeFile[];
	conflicts: string[];
	upToDate: boolean;
};
/** `places` — markers left in the file; `resolved` — the person accepted the resolution (the file is in the index);
 *  `deleted` — which side deleted the file (a modified / deleted conflict: one place, the choice is keep or delete).
 *  spec/appearance#evolution-redesign: sides are from the person's view (`ours` is their branch, in a rebase too). */
export type ConflictFile = {
	path: string;
	places: number;
	resolved: boolean;
	byAgent: boolean;
	deleted?: 'ours' | 'theirs' | 'both';
	/** How the person resolved it: ✓ `Yours` / `Theirs` / `Merged` / `Kept` / `Deleted`. */ resolution?: ConflictResolution;
	/** The agent's part (spec/appearance#evolution-redesign): working on it, a result waiting for `Accept`, or it left the markers. */ agent?:
		'running' | 'review' | 'failed';
	/** Not text, or too large: no three columns, only a whole side. */ binary?: boolean;
};
export type ConflictResolution = 'yours' | 'theirs' | 'merged' | 'kept' | 'deleted';
/** A tree in the merging state (or a stopped rebase): conflicted files and those that came in without a conflict. */
export type MergeState = {
	scopeId: string;
	/** spec/appearance#evolution-redesign: the branch that comes in; for a rebase, the base the branch goes onto. */ from: string;
	/** The person's branch. */ into: string;
	conflicts: ConflictFile[];
	clean: MergeFile[];
	external: boolean;
	/** `rebase` — `Rebasing <into> onto <from> · commit N of M`; `Continue` is `git rebase --continue`. */ kind:
		'merge' | 'rebase';
	step?: { current: number; total: number };
	/** Short SHA the tree goes back to on `Abort merge…`. */ head: string;
	/** The agent's resolving turn is running. */ agentRunning: boolean;
};
/** spec/appearance#evolution-redesign: the texts of a conflicted file for the merge in three columns, sides from the person's view. */
export type ConflictTexts = {
	path: string;
	base: string;
	ours: string;
	theirs: string;
	/** The file in the tree now: markers, or the agent's text. */ current: string;
	byAgent: boolean;
};
/** One row of the Conflicts dialog, from the file's state (spec/appearance#evolution-redesign). */
export type ConflictRowState = 'open' | 'deleted' | 'running' | 'review' | 'failed' | 'resolved';
export function conflictRowState(file: ConflictFile): ConflictRowState {
	if (file.resolved) return 'resolved';
	if (file.agent === 'running') return 'running';
	if (file.deleted) return 'deleted';
	if (file.agent === 'failed') return 'failed';
	if (file.agent === 'review' || (file.byAgent && file.places === 0)) return 'review';
	return 'open';
}
/** `N of M resolved · K to review`; `Continue` waits for every file, the agent's ones accepted by the person. */
export function conflictProgress(state: Pick<MergeState, 'conflicts' | 'agentRunning'>) {
	const rows = state.conflicts.map(conflictRowState);
	const resolved = rows.filter((row) => row === 'resolved').length,
		review = rows.filter((row) => row === 'review').length;
	return {
		total: rows.length,
		resolved,
		review,
		running: rows.filter((row) => row === 'running').length,
		canContinue: !state.agentRunning && rows.length > 0 && resolved === rows.length,
	};
}
export type MergeOutcome = { status: 'merged' | 'conflicts' | 'up-to-date'; sha: string | null };

/** A branch name from the UI comes back to main, so its shape is checked here and its existence there, through git. */
export function isBranchName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 240 &&
		!value.startsWith('-') &&
		!/[\s\0~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.lock$|^\/|\.$/.test(value)
	);
}
/** A scope id — the first 16 hex of the path's sha256 (discoverScopes). */
export function isGitScopeId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
}
export function isCommitSha(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}
/** spec/editor#line-author: a file path inside a repo, as History filters by it: relative, no `..`, no NUL. */
export function isHistoryPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.includes('\0') &&
		!value.startsWith('/') &&
		value.split('/').every((part) => part !== '' && part !== '..' && part !== '.')
	);
}

/** The agent's prompt, in English (rule 12): resolve the markers, commit nothing. */
export function mergeResolvePrompt(input: {
	repo: string;
	from: string;
	into: string;
	paths: string[];
}): string {
	return [
		`Resolve the merge conflicts in the repo "${input.repo}". A merge of \`${input.from}\` into \`${input.into}\` is in progress, and these files still contain conflict markers:`,
		...input.paths.map((path) => `- ${path}`),
		'',
		'For every conflict place keep the intent of both sides. When the two sides truly exclude each other, keep the current branch and say why.',
		'Remove every conflict marker. Run the project checks that cover these files if they exist.',
		'Do not commit and do not run any git command that changes the index or the history (no `git add`, `git commit`, `git merge --continue`, `git merge --abort`). The person reviews your resolution and finishes the merge.',
		'When you are done, list each file and what you kept from each side.',
	].join('\n');
}
