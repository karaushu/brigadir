import type { BlameCommit, Scope } from '@brigadir/core';
import { GitError, git, gitText } from './command';

/** One file's `git blame` on disk: per disk line an index into `commits` or -1 (not committed), and its line in that commit. */
export type DiskBlame = { commits: BlameCommit[]; lines: number[]; origins: number[] };
const header = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: \d+)?$/;
const uncommitted = (sha: string) => /^0+$/.test(sha);

/** spec/editor#line-author: `git blame --porcelain` — a header per line, commit fields once per commit, then the tab-prefixed text. */
export function parsePorcelain(text: string): DiskBlame {
	const commits: BlameCommit[] = [],
		index = new Map<string, number>(),
		info = new Map<string, { author: string; time: number; summary: string }>();
	const lines: number[] = [],
		origins: number[] = [];
	let current: string | null = null;
	const rows = text.split('\n');
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (row.startsWith('\t')) {
			current = null;
			continue;
		}
		const match: RegExpExecArray | null = current === null ? header.exec(row) : null;
		if (match) {
			const sha: string = match[1]!,
				origin = Number(match[2]),
				final = Number(match[3]);
			current = sha;
			if (!info.has(sha)) info.set(sha, { author: '', time: 0, summary: '' });
			lines[final - 1] = uncommitted(sha)
				? -1
				: (() => {
						let at = index.get(sha);
						if (at === undefined) {
							at = commits.length;
							index.set(sha, at);
							commits.push({ sha, author: '', time: 0, summary: '' });
						}
						return at;
					})();
			origins[final - 1] = uncommitted(sha) ? 0 : origin;
			continue;
		}
		if (current === null) continue;
		const space = row.indexOf(' '),
			field = space < 0 ? row : row.slice(0, space),
			value = space < 0 ? '' : row.slice(space + 1),
			entry = info.get(current)!;
		if (field === 'author') entry.author = value;
		else if (field === 'author-time') entry.time = (Number(value) || 0) * 1000;
		else if (field === 'summary') entry.summary = value;
	}
	for (const commit of commits) {
		const entry = info.get(commit.sha)!;
		commit.author = entry.author;
		commit.time = entry.time;
		commit.summary = entry.summary;
	}
	for (let i = 0; i < lines.length; i++)
		if (lines[i] === undefined) {
			lines[i] = -1;
			origins[i] = 0;
		}
	return { commits, lines, origins };
}

/** Git answers these when the file has no commit yet: never added, only staged, or the repo has no HEAD. */
const untrackedError =
	/no such path|no such ref|bad revision|does not have any commits|not a valid object name|ambiguous argument 'HEAD'/i;

/** Blame of the file as it is on disk, in the Git root that owns it. `untracked`: no commit holds the file yet. */
export async function blameFile(scope: Scope, path: string): Promise<DiskBlame | 'untracked'> {
	try {
		return parsePorcelain(
			(await git(scope.path, ['blame', '--porcelain', '--', path], { timeoutMs: 30_000 })).toString(
				'utf8'
			)
		);
	} catch (error) {
		if (error instanceof GitError && untrackedError.test(error.message)) return 'untracked';
		throw error;
	}
}

/** The full message of one commit, for the line author card; bounded, a card shows a few lines. */
export async function commitMessage(scope: Scope, sha: string): Promise<string> {
	return (
		await gitText(scope.path, ['show', '-s', '--format=%B', sha, '--'], { maxBytes: 64 * 1024 })
	).slice(0, 2000);
}
