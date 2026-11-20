import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
 * spec/tasks#agent-worktrees: one linked worktree of a repository as the host judges it. `missing` — git still lists it but its folder is gone
 * (prunable); `createdAt` — when it was made (the first entry of its `HEAD` reflog, else its administrative folder's birth time); `start` — the
 * commit it was made at, so a joined worktree's diff counts from there and the commits made in it before it joined are the task's too.
 */
export type WorktreeEntry = {
	path: string;
	missing: boolean;
	branch: string | null;
	head: string | null;
	createdAt: number | null;
	/** How exact `createdAt` is, in ms: the folder's birth time is exact, a reflog counts whole seconds. */
	precision: number;
	start: string | null;
};
const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The first line of a reflog: the commit it moved to and when. */
async function firstReflog(file: string): Promise<{ at: number; to: string } | null> {
	const text = await readFile(file, 'utf8').catch(() => '');
	const line = text.split('\n', 1)[0] ?? '';
	const match = /^\S+ (\S+) .*> (\d+) [+-]\d{4}(?:\t|$)/.exec(line);
	if (!match || !sha.test(match[1]!)) return null;
	return { to: match[1]!, at: Number(match[2]) * 1000 };
}
/** spec/tasks#agent-worktrees: the linked worktrees of `repo` (the main checkout is left out), with what the host needs to judge them. */
export async function worktreeEntries(repo: string): Promise<WorktreeEntry[]> {
	const [text, common] = await Promise.all([
		gitText(repo, ['worktree', 'list', '--porcelain'], { env: { GIT_OPTIONAL_LOCKS: '0' } }).catch(
			() => ''
		),
		gitCommonDir(repo),
	]);
	if (!common) return [];
	// Administrative folders by the checkout they serve: `<common>/worktrees/<name>/gitdir` holds `<path>/.git`.
	const admins = new Map<string, string>();
	for (const name of await readdir(join(common, 'worktrees')).catch(() => [] as string[])) {
		const admin = join(common, 'worktrees', name);
		const gitdir = (await readFile(join(admin, 'gitdir'), 'utf8').catch(() => '')).trim();
		if (gitdir) admins.set(dirname(gitdir), admin);
	}
	const entries: WorktreeEntry[] = [];
	const blocks = text.split('\n\n').filter((block) => block.trim());
	for (const [index, block] of blocks.entries()) {
		const lines = block.split('\n'),
			head = lines.find((line) => line.startsWith('worktree '));
		// The first block is the main checkout; a bare repository has none to join.
		if (index === 0 || !head || lines.includes('bare')) continue;
		const listed = head.slice('worktree '.length);
		const real = await realpath(listed).catch(() => null);
		const admin = admins.get(listed) ?? (real ? admins.get(real) : undefined) ?? null;
		const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? null;
		const oid = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length) ?? null;
		const branchName = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
		// The start: the worktree's first HEAD entry, else its branch's first entry (`branch: Created from …`), else where it forks from
		// the repo's HEAD — never the folder as it is now, so work made before the join stays the task's.
		const headLog = admin ? await firstReflog(join(admin, 'logs', 'HEAD')) : null;
		const first =
			headLog ??
			(branchName ? await firstReflog(join(common, 'logs', 'refs', 'heads', branchName)) : null);
		const fork =
			!first?.to && oid && sha.test(oid)
				? await gitText(repo, ['merge-base', 'HEAD', oid]).catch(() => '')
				: '';
		const born = admin
			? await stat(admin).then(
					(info) => (info.birthtimeMs > 0 ? info.birthtimeMs : null),
					() => null
				)
			: null;
		entries.push({
			path: real ?? listed,
			missing: !real || lines.some((line) => line.startsWith('prunable')),
			branch: branchName,
			head: oid && sha.test(oid) ? oid : null,
			// When it was made: the folder's birth, else its own HEAD's first entry (a branch may be older than the worktree).
			createdAt: born ?? headLog?.at ?? null,
			precision: born !== null ? 1 : 1000,
			start: first?.to ?? (sha.test(fork) ? fork : null),
		});
	}
	return entries;
}
/** spec/tasks#agent-worktrees: whether `branch` still exists in the repository of `repo`. */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
	return gitText(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
		(text) => sha.test(text),
		() => false
	);
}
