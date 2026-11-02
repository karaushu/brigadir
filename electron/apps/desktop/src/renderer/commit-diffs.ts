import type { AgentTask, FileDiff } from '@brigadir/core';
/**
 * Diffs of commit-preview and History tabs. The task store keeps only the file, revision and
 * source of each tab; full FileDiffs (both texts, lines, pairs, syntax) live in this LRU of `commitDiffLimit` entries across
 * tasks, and a tab whose diff left it reads it again from main. A History sha is immutable; a commit preview revision
 * that main no longer holds answers «Files changed», which the tab shows as an unreadable file.
 */
export type CommitDiffSource =
	| { kind: 'history'; scopeId: string; sha: string; id: string }
	| { kind: 'commit'; revision: string; id: string }
	| {
			kind: 'pr';
			ref: { scopeId: string; number: number };
			path: string;
			revision: string;
			id: string;
	  };
export type CommitDiffEntry = {
	file: FileDiff['file'];
	revision: string;
	source: CommitDiffSource;
};
const cache = new Map<string, FileDiff>();
export const commitDiffLimit = 4;
const cacheKey = (task: AgentTask, key: string, revision: string) =>
	`${task.projectId}/${task.id}\0${key}\0${revision}`;
const revisionOf = (source: CommitDiffSource) =>
	source.kind === 'history' ? source.sha : source.revision;
/** spec/pull-requests-and-ci#pr-threads: a PR file is the merge-base diff against head; the revision is the head SHA, so a new push reads again. */
const readSource = (task: AgentTask, source: CommitDiffSource) =>
	source.kind === 'history'
		? window.brigadir.readHistoryFile(task, source.scopeId, source.sha, source.id)
		: source.kind === 'pr'
			? window.brigadir.readPullRequestFileDiff(task, source.ref, source.path)
			: window.brigadir.readCommitFile(task, source.revision, source.id);
/** Remembers a freshly read diff and returns the store entry for its tab. */
export function keepCommitDiff(
	task: AgentTask,
	key: string,
	diff: FileDiff,
	source: CommitDiffSource
): CommitDiffEntry {
	const revision = revisionOf(source),
		id = cacheKey(task, key, revision);
	cache.delete(id);
	cache.set(id, diff);
	while (cache.size > commitDiffLimit) cache.delete(cache.keys().next().value!);
	return { file: diff.file, revision, source };
}
export function readCommitDiff(
	task: AgentTask,
	key: string,
	entry: CommitDiffEntry,
	read = readSource
): Promise<FileDiff> {
	const id = cacheKey(task, key, entry.revision),
		cached = cache.get(id);
	if (cached) {
		cache.delete(id);
		cache.set(id, cached);
		return Promise.resolve(cached);
	}
	return read(task, entry.source).then((diff) => {
		keepCommitDiff(task, key, diff, entry.source);
		return diff;
	});
}
export function forgetCommitDiff(task: AgentTask, key: string, entry: CommitDiffEntry) {
	cache.delete(cacheKey(task, key, entry.revision));
}
export const cachedCommitDiffs = () => cache.size;
