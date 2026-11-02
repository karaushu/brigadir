import { createHash } from 'node:crypto';
import { readdir, realpath, lstat, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isRecord, type Scope } from '@brigadir/core';
import { gitText, git } from './command';
export const discoverySkipped: ReadonlySet<string> = new Set([
	'.git',
	'node_modules',
	'.pnpm-store',
	'dist',
	'.next',
	'.build',
	'build',
	'vendor',
]);
const skipped = discoverySkipped;
/** Discovery sees `.git` in directories down to this depth from the project root, inclusive. */
export const discoveryDepth = 4;
export async function worktreePaths(path: string): Promise<string[]> {
	const output = await git(path, ['worktree', 'list', '--porcelain', '-z']);
	return output
		.toString('utf8')
		.split('\0')
		.filter((s) => s.startsWith('worktree '))
		.map((s) => s.slice(9));
}
/** Without `worktrees/` and `commondir` in the git dir, `worktree list` gives only the main tree, which never lies
 *  inside the repo, so snapshot exclusions need no process. When in doubt — `true`. */
export async function mayHaveLinkedWorktrees(path: string): Promise<boolean> {
	const dir = await gitDir(path);
	if (!dir) return true;
	for (const name of ['worktrees', 'commondir'])
		try {
			await lstat(join(dir, name));
			return true;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') return true;
		}
	return false;
}
/** A repo's git dir: `.git` itself or `gitdir:` from a `.git` file (submodule, worktree). Anything else — `null`. */
export async function gitDir(path: string): Promise<string | null> {
	try {
		const dotGit = join(path, '.git'),
			stat = await lstat(dotGit);
		if (stat.isDirectory()) return dotGit;
		if (!stat.isFile()) return null;
		const match = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'));
		return match ? resolve(path, match[1]!.trim()) : null;
	} catch {
		return null;
	}
}
export async function discoverScopes(
	projectPath: string,
	managed: ReadonlyMap<string, Scope['kind']> = new Map()
): Promise<Scope[]> {
	const root = await realpath(projectPath);
	const candidates: string[] = [];
	let visited = 0;
	async function visit(path: string, depth: number) {
		if (++visited > 10000) throw new Error('Repo discovery exceeded its directory limit');
		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.name === '.git' && !e.isSymbolicLink())) candidates.push(path);
		if (depth >= discoveryDepth) return;
		for (const entry of entries)
			if (entry.isDirectory() && !skipped.has(entry.name) && !entry.name.startsWith('.brigadir'))
				await visit(join(path, entry.name), depth + 1);
	}
	await visit(root, 0);
	const scopes: Scope[] = [];
	const excluded: string[] = [];
	for (const path of candidates) {
		try {
			const top = await gitText(path, ['rev-parse', '--show-toplevel']);
			if ((await realpath(top)) !== path) continue;
			const submodule = await gitText(path, ['rev-parse', '--show-superproject-working-tree']);
			const dotGit = await lstat(join(path, '.git'));
			const managedKind = managed.get(relative(root, path).split(sep).join('/'));
			if (
				!managedKind &&
				path !== root &&
				!submodule &&
				(await worktreePaths(path)).includes(path) &&
				dotGit.isFile()
			) {
				excluded.push(path);
				continue;
			}
			const branch = await gitText(path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
				() => null
			);
			const remote = manifestRemote(
				await gitText(path, ['config', '--get', 'remote.origin.url']).catch(() => null)
			);
			scopes.push({
				id: createHash('sha256').update(path).digest('hex').slice(0, 16),
				path,
				name: relative(root, path).split(sep).join('/') || '.',
				kind:
					path === root
						? 'root'
						: (managedKind ?? (submodule ? 'submodule' : dotGit.isFile() ? 'worktree' : 'nested')),
				branch,
				remote,
				selected: true,
			});
		} catch {
			/* Uninitialized or invalid .git is not a live scope. */
		}
	}
	return scopes.filter((scope) => !excluded.some((path) => scope.path.startsWith(`${path}/`)));
}

/** Remote metadata must not copy HTTPS credentials or query tokens into journals/context. */
function manifestRemote(value: string | null): string | null {
	if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
	try {
		const url = new URL(value);
		url.password = '';
		if (url.protocol === 'http:' || url.protocol === 'https:') url.username = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}
