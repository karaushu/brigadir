import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gitText } from './command';

/** spec/tasks#agent-worktrees: the checkouts of a repository (`git worktree list`), canonical; a missing or prunable one is left out. */
export async function listWorktrees(repo: string): Promise<string[]> {
	const text = await gitText(repo, ['worktree', 'list', '--porcelain'], {
		env: { GIT_OPTIONAL_LOCKS: '0' },
	}).catch(() => '');
	const paths: string[] = [];
	for (const block of text.split('\n\n')) {
		const lines = block.split('\n'),
			head = lines.find((line) => line.startsWith('worktree '));
		if (!head || lines.some((line) => line === 'bare' || line.startsWith('prunable'))) continue;
		const path = await realpath(head.slice('worktree '.length)).catch(() => null);
		if (path) paths.push(path);
	}
	return [...new Set(paths)];
}

/** The repository a checkout belongs to: two worktrees of one repo share it. */
export async function gitCommonDir(path: string): Promise<string | null> {
	const text = await gitText(path, ['rev-parse', '--git-common-dir'], {
		env: { GIT_OPTIONAL_LOCKS: '0' },
	}).catch(() => null);
	if (!text?.trim()) return null;
	return realpath(resolve(path, text.trim())).catch(() => null);
}

/** spec/tasks#agent-worktrees: `rootId` when `path` is another checkout of the task root's repository. */
export async function worktreeOfRoot(
	path: string,
	root: { id: string; path: string } | undefined
): Promise<string | undefined> {
	if (!root || root.path === path) return undefined;
	const [own, rootDir] = await Promise.all([gitCommonDir(path), gitCommonDir(root.path)]);
	return own && own === rootDir ? root.id : undefined;
}

/**
 * spec/tasks#agent-worktrees: worktrees that appeared since the last look. The first look at a repo is its baseline, so worktrees that
 * existed before are never reported; `outside` drops paths under the project root and Brigadir's own worktrees.
 */
export class NewWorktrees {
	private known = new Map<string, Set<string>>();
	constructor(private outside: readonly string[]) {}
	async found(repos: readonly string[]): Promise<string[]> {
		const found = new Set<string>();
		for (const repo of new Set(repos)) {
			const paths = await listWorktrees(repo),
				seen = this.known.get(repo);
			this.known.set(repo, new Set([...(seen ?? []), ...paths]));
			if (seen) for (const path of paths) if (!seen.has(path)) found.add(path);
		}
		return [...found].filter(
			(path) =>
				!repos.includes(path) &&
				!this.outside.some((base) => path === base || path.startsWith(`${base}/`))
		);
	}
}
