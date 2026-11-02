import type {
	BranchList,
	CommitFiles,
	GitBranch,
	HistoryCommit,
	HistoryPage,
	Scope,
} from '@brigadir/core';
import { git, gitText } from './command';
import { changedFiles } from './changes';

/** spec/git#merge: branches and commits come from git; there is no registry of our own (spec/agents-and-providers#transport, rule 7). */
export async function listBranches(scope: Scope, limit = 300): Promise<BranchList> {
	const out = (
		await git(scope.path, [
			'for-each-ref',
			'--sort=-committerdate',
			`--count=${limit}`,
			'--format=%(refname)%00%(refname:short)%00%(committerdate:unix)',
			'refs/heads',
			'refs/remotes',
		])
	).toString('utf8');
	const branches: GitBranch[] = [];
	for (const line of out.split('\n')) {
		const [ref, name, time] = line.split('\0');
		if (!ref || !name || ref.endsWith('/HEAD')) continue;
		branches.push({
			name,
			remote: ref.startsWith('refs/remotes/'),
			updatedAt: (Number(time) || 0) * 1000,
		});
	}
	const current = await gitText(scope.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
		() => ''
	);
	return { scopeId: scope.id, current: current || null, branches };
}

/** A name from the UI is checked through git: only a real local or remote branch. */
export async function resolveBranch(
	scope: Scope,
	name: string
): Promise<{ ref: string; sha: string }> {
	for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`]) {
		const sha = await gitText(scope.path, [
			'rev-parse',
			'--verify',
			'--quiet',
			`${ref}^{commit}`,
		]).catch(() => '');
		if (sha) return { ref, sha };
	}
	throw new Error('The branch is unavailable');
}

const RECORD = '\x1e',
	FIELD = '\x1f';
export function parseLog(text: string): HistoryCommit[] {
	const commits: HistoryCommit[] = [];
	for (const chunk of text.split(RECORD)) {
		if (!chunk.trim()) continue;
		const end = chunk.indexOf('\n'),
			head = end < 0 ? chunk : chunk.slice(0, end),
			stat = end < 0 ? '' : chunk.slice(end + 1);
		const [sha, parents, author, time, ...subject] = head.split(FIELD);
		if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid Git log');
		commits.push({
			sha,
			subject: subject.join(FIELD),
			author: author ?? '',
			time: (Number(time) || 0) * 1000,
			parents: parents ? parents.split(' ').filter(Boolean) : [],
			files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0),
		});
	}
	return commits;
}

// History from a commit is immutable, and so is the page keyed by its SHA: reopening the tab and every checkpoint with no
// new commit on the branch skip `log --shortstat` (a diff of each of 101 commits). The log runs from the SHA, not the name.
// spec/git#history-search: a search is the same page under a key with its query.
const pages = new Map<string, Promise<HistoryCommit[]>>();
export async function branchHistory(
	scope: Scope,
	branch: string,
	limit = 100,
	path?: string,
	query?: string
): Promise<HistoryPage> {
	const { sha } = await resolveBranch(scope, branch),
		key = `${scope.path}\0${sha}\0${limit}\0${path ?? ''}\0${query ?? ''}`;
	let page = pages.get(key);
	if (page) {
		pages.delete(key);
		pages.set(key, page);
	} else {
		const created = query
			? searchLog(scope, sha, limit, query, path)
			: readLog(scope, historyLogArgs(sha, limit, path), path);
		page = created;
		pages.set(key, created);
		created.catch(() => {
			if (pages.get(key) === created) pages.delete(key);
		});
		while (pages.size > 32) pages.delete(pages.keys().next().value!);
	}
	const commits = (await page).map((commit) => ({
		...commit,
		parents: [...commit.parents],
		...(commit.file ? { file: { ...commit.file } } : {}),
	}));
	return {
		scopeId: scope.id,
		branch,
		commits: commits.slice(0, limit),
		truncated: commits.length > limit,
		...(path !== undefined ? { path } : {}),
		...(query ? { query } : {}),
	};
}

const LOG_FORMAT = `--format=${RECORD}%H${FIELD}%P${FIELD}%an${FIELD}%ct${FIELD}%s`;
/** spec/git#history-search: what one History search pass asks git to match: the whole message, or the author's name and email. */
export type HistorySearchField = 'message' | 'author';
/**
 * The `log` argv of a History page from `sha`: `limit + 1` commits, so the caller knows there is more. With `search` git
 * itself keeps the matching commits of the whole history; the text is one argv item, a literal (`--fixed-strings`)
 * compared without case. spec/editor#line-author: one file's history follows its renames; `--numstat` gives that file's lines.
 */
export function historyLogArgs(
	sha: string,
	limit: number,
	path?: string,
	search?: { field: HistorySearchField; query: string }
): string[] {
	const filter = search
		? [
				'--regexp-ignore-case',
				'--fixed-strings',
				search.field === 'message' ? `--grep=${search.query}` : `--author=${search.query}`,
			]
		: [];
	return path === undefined
		? ['log', `--max-count=${limit + 1}`, ...filter, LOG_FORMAT, '--shortstat', sha, '--']
		: [
				'--literal-pathspecs',
				'log',
				'--follow',
				'-M',
				`--max-count=${limit + 1}`,
				...filter,
				LOG_FORMAT,
				'--numstat',
				sha,
				'--',
				path,
			];
}
function readLog(scope: Scope, args: string[], path?: string): Promise<HistoryCommit[]> {
	return git(scope.path, args).then((out) =>
		path === undefined ? parseLog(out.toString('utf8')) : parseFileLog(out.toString('utf8'))
	);
}
/** spec/git#history-search: a query that can be the start of a SHA; a shorter prefix matches too much to name a commit. */
export const historyHashPrefix = /^[0-9a-f]{4,40}$/i;
/**
 * spec/git#history-search: the search over the whole history of the branch. Git matches the message and the author in two passes (given
 * together, `--grep` and `--author` must both match); a SHA prefix is a commit reachable from the branch. The lists merge
 * by commit time, each commit once; each pass reads `limit + 1`, so the merged page knows there is more.
 */
async function searchLog(
	scope: Scope,
	sha: string,
	limit: number,
	query: string,
	path?: string
): Promise<HistoryCommit[]> {
	const lists = await Promise.all([
		readLog(scope, historyLogArgs(sha, limit, path, { field: 'message', query }), path),
		readLog(scope, historyLogArgs(sha, limit, path, { field: 'author', query }), path),
		hashHit(scope, sha, query, path),
	]);
	return mergeHistory(lists);
}
async function hashHit(
	scope: Scope,
	tip: string,
	query: string,
	path?: string
): Promise<HistoryCommit[]> {
	if (!historyHashPrefix.test(query)) return [];
	const hit = await gitText(scope.path, [
		'rev-parse',
		'--verify',
		'--quiet',
		`${query.toLowerCase()}^{commit}`,
	]).catch(() => '');
	if (!hit) return [];
	const reachable = await git(scope.path, ['merge-base', '--is-ancestor', hit, tip]).then(
		() => true,
		() => false
	);
	if (!reachable) return [];
	// With a file filter the commit counts only when it changed that file.
	const [commit] = await readLog(scope, historyLogArgs(hit, 0, path), path);
	return commit?.sha === hit ? [commit] : [];
}
/** Lists in git's order merged by commit time, newer first; a commit found twice stays where it came first. */
export function mergeHistory(lists: HistoryCommit[][]): HistoryCommit[] {
	const at = lists.map(() => 0),
		seen = new Set<string>(),
		merged: HistoryCommit[] = [];
	for (;;) {
		let next = -1;
		for (let i = 0; i < lists.length; i++) {
			const head = lists[i]![at[i]!];
			if (head && (next < 0 || head.time > lists[next]![at[next]!]!.time)) next = i;
		}
		if (next < 0) return merged;
		const commit = lists[next]![at[next]!++]!;
		if (!seen.has(commit.sha)) {
			seen.add(commit.sha);
			merged.push(commit);
		}
	}
}

/** `src/{a.ts => b/a.ts}` or `a.ts => b.ts` from `--numstat` of a rename; a plain path stays as it is. */
export function numstatPath(spec: string): { path: string; renamedFrom?: string } {
	const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(spec),
		tidy = (value: string) => value.replace(/\/{2,}/g, '/').replace(/^\//, '');
	if (brace)
		return {
			path: tidy(brace[1]! + brace[3]! + brace[4]!),
			renamedFrom: tidy(brace[1]! + brace[2]! + brace[4]!),
		};
	const plain = /^(.+) => (.+)$/.exec(spec);
	if (plain) return { path: plain[2]!, renamedFrom: plain[1]! };
	return { path: spec };
}
/** A file's log: the same header as `parseLog`, then that file's `--numstat` row (none for a merge). */
export function parseFileLog(text: string): HistoryCommit[] {
	const commits = parseLog(
		text
			.split(RECORD)
			.map((chunk) => chunk.split('\n')[0]!)
			.join(RECORD)
	);
	const chunks = text.split(RECORD).filter((chunk) => chunk.trim());
	return commits.map((commit, index) => {
		const row = chunks[index]!.split('\n')
			.slice(1)
			.map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line))
			.find(Boolean);
		if (!row) return { ...commit, files: 0 };
		return {
			...commit,
			files: 1,
			file: {
				...numstatPath(row[3]!),
				additions: row[1] === '-' ? 0 : Number(row[1]),
				deletions: row[2] === '-' ? 0 : Number(row[2]),
			},
		};
	});
}

async function emptyTree(scope: Scope) {
	return gitText(scope.path, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
}

/** A commit's files against its first parent; a root commit against the empty tree. */
export async function commitFiles(scope: Scope, sha: string): Promise<CommitFiles> {
	const tree = await gitText(scope.path, ['rev-parse', '--verify', `${sha}^{tree}`]);
	const parent =
		(await gitText(scope.path, ['rev-parse', '--verify', '--quiet', `${sha}^1^{tree}`]).catch(
			() => ''
		)) || (await emptyTree(scope));
	return { scopeId: scope.id, sha, files: await changedFiles(scope, parent, tree) };
}
