import { realpathSync, watch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { discoveryDepth, discoverySkipped, gitDir } from './scopes';
const skipped = new Set([
	'node_modules',
	'.pnpm-store',
	'dist',
	'.next',
	'.build',
	'build',
	'vendor',
]);
/** `discover` — a repo may have appeared or vanished; `heads` — roots of repos whose HEAD moved (branch, commit, reset). */
export type ScopeChange = { discover: boolean; heads: string[] };
/**
 * spec/architecture-and-platform#perf-git: a path inside a git dir, relative to it, that moves HEAD. A commit on a branch writes
 * `logs/HEAD` and `refs/heads/<branch>`, never `HEAD` itself; a checkout or a detached commit writes `HEAD`.
 */
export function movesHead(rest: readonly string[]): boolean {
	const last = rest.at(-1) ?? '';
	if (last.endsWith('.lock')) return false;
	return (
		(rest.length === 1 && (last === 'HEAD' || last === 'packed-refs')) ||
		(rest.length === 2 && rest[0] === 'logs' && last === 'HEAD') ||
		(rest.length > 2 && rest[0] === 'refs' && rest[1] === 'heads')
	);
}
/** Where HEAD moved for a path under the watched root: `.git/…` of a repo, `.git/modules/<name>/…` of a submodule or
 *  `.git/worktrees/<id>/…` of a linked worktree. */
function movedGitDir(parts: readonly string[], git: number): string | null {
	const rest = parts.slice(git + 1);
	if (movesHead(rest)) return parts.slice(0, git + 1).join(sep);
	if (rest[0] !== 'modules' && rest[0] !== 'worktrees') return null;
	for (let i = 2; i < rest.length; i++)
		if (movesHead(rest.slice(i))) return parts.slice(0, git + 1 + i).join(sep);
	return null;
}
/**
 * A full refresh (discovery and a snapshot of every repo) in each of a project's hosts on any event would cost 270 git
 * processes per `mkdir` with 5 hosts. Discovery runs only when `.git` or `.gitmodules` appears or vanishes, or for a
 * dotless folder that is a repo from the document, its ancestor, or contains `.git` within discovery depth (checked by
 * `readdir`, not git). A HEAD move gives `heads`: the host updates the branch and captures only that repo. A submodule's
 * git dir (`.git/modules/…`) maps to the submodule; a known repo whose git dir lies outside the root (a linked worktree,
 * an external folder) gets a watcher of its own git dir.
 */
export function watchScopes(
	project: string,
	refresh: (change: ScopeChange) => Promise<void>,
	known: () => readonly string[] = () => []
): () => void {
	// Repo paths in the document are after realpath; an event gives a path relative to what we watch.
	let root = project;
	try {
		root = realpathSync(project);
	} catch {
		/* The watcher below reports a missing root. */
	}
	let timer: ReturnType<typeof setTimeout> | undefined,
		closed = false,
		running = false,
		again = false,
		discover = false;
	const heads = new Set<string>(),
		dirs = new Set<string>(),
		/** Git dirs (relative to the root, or absolute for outside ones) where HEAD moved. */
		moved = new Set<string>(),
		/** Git dir → repo path for known repos; outside git dirs → their watchers. */
		repos = new Map<string, string>(),
		outside = new Map<string, ReturnType<typeof watch>>();
	const reconcile = async () => {
		const paths = known(),
			dirsNow = await Promise.all(paths.map((path) => gitDir(path)));
		if (closed) return;
		repos.clear();
		const wanted = new Set<string>();
		for (const [i, dir] of dirsNow.entries()) {
			if (!dir) continue;
			repos.set(dir, paths[i]!);
			if (dir !== root && !dir.startsWith(`${root}${sep}`)) wanted.add(dir);
		}
		for (const [dir, w] of outside)
			if (!wanted.has(dir)) {
				w.close();
				outside.delete(dir);
			}
		for (const dir of wanted) {
			if (outside.has(dir)) continue;
			try {
				const w = watch(dir, { recursive: true }, (_event, file) => {
					if (movesHead((file?.toString() ?? '').split(sep))) {
						moved.add(dir);
						schedule();
					}
				});
				w.on('error', () => {
					w.close();
					outside.delete(dir);
				});
				outside.set(dir, w);
			} catch {
				/* A missing git dir: the repo is unavailable, discovery reports it. */
			}
		}
	};
	const run = async () => {
		if (closed) return;
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			// A git dir no known repo owns yet (the map is rebuilt after discovery) — discovery finds its repo.
			for (const dir of moved) {
				const path = repos.get(dir.startsWith(sep) ? dir : join(root, dir));
				if (path) heads.add(path);
				else discover = true;
			}
			moved.clear();
			const change = { discover, heads: [...heads] },
				candidates = [...dirs];
			discover = false;
			heads.clear();
			dirs.clear();
			if (!change.discover && candidates.length)
				change.discover = await touchesRepo(root, candidates, known());
			if (!closed && (change.discover || change.heads.length)) await refresh(change);
			if (change.discover) await reconcile();
		} catch {
			/* The host publishes the refresh error. */
		} finally {
			running = false;
			if (again) {
				again = false;
				schedule();
			}
		}
	};
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void run();
		}, 750);
		timer.unref();
	};
	let watcher: ReturnType<typeof watch> | undefined;
	try {
		watcher = watch(root, { recursive: true }, (event, file) => {
			const path = file?.toString() ?? '',
				parts = path.split('/'),
				git = parts.indexOf('.git');
			if (
				parts.some((part) => skipped.has(part) || part.startsWith('.brigadir')) ||
				parts.length > (git >= 0 ? 12 : 6)
			)
				return;
			if (git >= 0) {
				if (git === parts.length - 1) {
					discover = true;
					schedule();
				} else {
					const dir = movedGitDir(parts, git);
					if (dir) {
						moved.add(dir);
						schedule();
					}
				}
				return;
			}
			if (!path || path.endsWith('.gitmodules')) {
				discover = true;
				schedule();
			} else if (event === 'rename' && !parts.at(-1)?.includes('.')) {
				dirs.add(path);
				schedule();
			}
		});
		watcher.on('error', () => {
			watcher?.close();
			watcher = undefined;
		});
	} catch {
		/* Periodic fallback below also covers filesystems without recursive watch. */
	}
	void reconcile().catch(() => {});
	const fallback = setInterval(() => {
		if (!watcher) {
			discover = true;
			schedule();
		}
	}, 15000);
	fallback.unref();
	return () => {
		closed = true;
		clearTimeout(timer);
		clearInterval(fallback);
		watcher?.close();
		for (const w of outside.values()) w.close();
		outside.clear();
	};
}
/** A dotless folder brings or takes a repo only if it is a repo from the document or its ancestor, or holds a `.git`
 *  discovery would see. The walk is bounded; an exhausted limit falls back to discovery. */
async function touchesRepo(
	root: string,
	candidates: string[],
	known: readonly string[]
): Promise<boolean> {
	let budget = 2000;
	const scan = async (dir: string, depth: number): Promise<boolean> => {
		if (--budget < 0) return true;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		if (entries.some((entry) => entry.name === '.git' && !entry.isSymbolicLink())) return true;
		if (depth >= discoveryDepth) return false;
		for (const entry of entries)
			if (
				entry.isDirectory() &&
				!discoverySkipped.has(entry.name) &&
				!entry.name.startsWith('.brigadir') &&
				(await scan(join(dir, entry.name), depth + 1))
			)
				return true;
		return false;
	};
	for (const path of candidates) {
		const absolute = join(root, path),
			depth = path.split('/').length;
		if (known.some((scope) => scope === absolute || scope.startsWith(`${absolute}/`))) return true;
		if (
			depth > discoveryDepth ||
			!(await lstat(absolute).then(
				(stat) => stat.isDirectory(),
				() => false
			))
		)
			continue;
		if (await scan(absolute, depth)) return true;
	}
	return false;
}
