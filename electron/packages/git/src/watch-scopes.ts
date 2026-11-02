import { realpathSync, watch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoveryDepth, discoverySkipped } from './scopes';
const skipped = new Set([
	'node_modules',
	'.pnpm-store',
	'dist',
	'.next',
	'.build',
	'build',
	'vendor',
]);
/** `discover` — a repo may have appeared or vanished; `heads` — roots of repos whose `.git/HEAD` changed (branch and tree). */
export type ScopeChange = { discover: boolean; heads: string[] };
/**
 * A full refresh (discovery and a snapshot of every repo) in each of a project's hosts on any event would cost 270 git
 * processes per `mkdir` with 5 hosts. Discovery runs only when `.git` or `.gitmodules` appears or vanishes, or for a
 * dotless folder that is a repo from the document, its ancestor, or contains `.git` within discovery depth (checked by
 * `readdir`, not git). A HEAD change gives `heads`: the host updates the branch and captures only that repo.
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
		dirs = new Set<string>();
	const run = async () => {
		if (closed) return;
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			const change = { discover, heads: [...heads] },
				candidates = [...dirs];
			discover = false;
			heads.clear();
			dirs.clear();
			if (!change.discover && candidates.length)
				change.discover = await touchesRepo(root, candidates, known());
			if (!closed && (change.discover || change.heads.length)) await refresh(change);
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
				parts = path.split('/');
			if (
				parts.some((part) => skipped.has(part) || part.startsWith('.brigadir')) ||
				parts.length > 6
			)
				return;
			const git = parts.indexOf('.git');
			if (git >= 0) {
				if (git === parts.length - 1) {
					discover = true;
					schedule();
				} else if (parts[git + 1] === 'HEAD') {
					heads.add(join(root, ...parts.slice(0, git)));
					schedule();
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
