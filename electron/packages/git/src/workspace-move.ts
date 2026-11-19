import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readlink,
	rename,
	rm,
	rmdir,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	isRecord,
	moveFate,
	type MoveEntry,
	type WorkspaceStayReason,
	type WorkspaceStayed,
} from '@brigadir/core';
import { safePath } from '@brigadir/persistence';
import { git, gitText, GitError, isSha } from './command';

/**
 * spec/crew#auto-move: the move of a running task from the project folder into its new worktree, per repo. What moves comes from snapshot
 * trees (rule 3): `base` at the task's start, `current` the last checkpoint, and the repo's `HEAD`. Nothing here touches the project
 * folder until `restoreProjectRepo`, which the host calls only after the worktree holds every moved path and the task has switched.
 */
export type MoveWrite = { path: string; mode: string; oid: string };
export type RepoMovePlan = {
	/** The repo's commit the worktree copy starts from. */
	head: string;
	/** Paths the worktree gets, with their final blobs (a merged path has a new blob). */
	writes: MoveWrite[];
	/** Paths the worktree loses. */
	deletes: string[];
	/** Every moved path with its entries at the task's start, at the last checkpoint and in `HEAD`: what the project folder goes back to. */
	moved: { path: string; base: MoveEntry; current: MoveEntry; head: MoveEntry }[];
	/** Repo-relative paths that stay in the project folder. */
	stayed: { path: string; reason: WorkspaceStayReason }[];
};
const zero = /^0+$/;
/** `git diff-tree -r -z --raw` → path → {before, after}; gitlinks included. */
async function rawDiff(cwd: string, from: string, to: string) {
	const out = (
		await git(cwd, ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to], {
			maxBytes: 256 * 1024 * 1024,
		})
	).toString('utf8');
	const parts = out.split('\0'),
		changes = new Map<string, { before: MoveEntry; after: MoveEntry }>();
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const header = parts[i]!,
			path = parts[i + 1]!;
		const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(header);
		if (!match || !path) continue;
		const [, srcMode, dstMode, srcOid, dstOid] = match;
		changes.set(path, {
			before: zero.test(srcMode!) ? null : { mode: srcMode!, oid: srcOid! },
			after: zero.test(dstMode!) ? null : { mode: dstMode!, oid: dstOid! },
		});
	}
	return changes;
}
async function blob(cwd: string, oid: string) {
	return git(cwd, ['cat-file', 'blob', oid], { maxBytes: 512 * 1024 * 1024 });
}
/** `git merge-file` of the task's change (base → current) onto `HEAD`; null when it conflicts. */
async function mergeOnto(cwd: string, base: string, head: string, current: string) {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-move-merge-'));
	try {
		const [b, h, c] = [join(dir, 'base'), join(dir, 'head'), join(dir, 'current')];
		await writeFile(b, await blob(cwd, base));
		await writeFile(h, await blob(cwd, head));
		await writeFile(c, await blob(cwd, current));
		let merged: Buffer;
		try {
			merged = await git(cwd, ['merge-file', '-p', '--quiet', h, b, c], {
				maxBytes: 512 * 1024 * 1024,
			});
		} catch (error) {
			// Conflicts, and files git does not merge (binary), stay where they are.
			if (error instanceof GitError && error.code !== null) return null;
			throw error;
		}
		const oid = await gitText(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], {
			input: merged,
		});
		if (!isSha(oid)) throw new Error('Invalid merged blob');
		return oid;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
/**
 * The plan of one repo. `personPaths`: repo-relative paths a checkpoint outside the agent's turns (or the person's Save) changed.
 */
export async function planRepoMove(input: {
	repo: string;
	baseTree: string;
	currentTree: string;
	personPaths: ReadonlySet<string>;
}): Promise<RepoMovePlan> {
	const { repo, baseTree, currentTree, personPaths } = input;
	const head = await gitText(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(
		() => ''
	);
	if (!isSha(head)) throw new Error('The repo has no commit to start a worktree from');
	const task = await rawDiff(repo, baseTree, currentTree),
		before = await rawDiff(repo, baseTree, head);
	const plan: RepoMovePlan = { head, writes: [], deletes: [], moved: [], stayed: [] };
	for (const [path, change] of task) {
		const base = change.before,
			current = change.after,
			headEntry = before.has(path) ? before.get(path)!.after : base;
		const fate = moveFate(base, headEntry, current, personPaths.has(path));
		if (fate.kind === 'skip') continue;
		if (fate.kind === 'stay') {
			plan.stayed.push({ path, reason: fate.reason });
			continue;
		}
		let target = current;
		if (fate.kind === 'merge') {
			const oid = await mergeOnto(repo, base!.oid, headEntry!.oid, current!.oid);
			if (!oid) {
				plan.stayed.push({ path, reason: 'conflict' });
				continue;
			}
			target = { mode: current!.mode, oid };
		}
		if (target) plan.writes.push({ path, mode: target.mode, oid: target.oid });
		else plan.deletes.push(path);
		plan.moved.push({ path, base, current, head: headEntry });
	}
	return plan;
}
/** An index of our own beside the repo's, so the person's (or the worktree's) index is never staged. */
async function scratchIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-move-index-'));
	try {
		return await run({ GIT_INDEX_FILE: join(dir, 'index') });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
/** Writes entries into a working tree through a scratch index, so git applies the repo's filters, modes and symlinks. */
async function checkout(repo: string, tree: string, writes: readonly MoveWrite[]) {
	if (!writes.length) return;
	await scratchIndex(async (env) => {
		await gitText(repo, ['read-tree', tree], { env });
		await gitText(repo, ['update-index', '-z', '--index-info'], {
			env,
			input: writes.map((item) => `${item.mode} ${item.oid}\t${item.path}\0`).join(''),
		});
		for (const item of writes) await rm(await leaf(repo, item.path), { force: true });
		await gitText(repo, ['checkout-index', '-f', '-z', '--stdin'], {
			env,
			input: writes.map((item) => `${item.path}\0`).join(''),
		});
	});
}
/** The file's own path with every folder above it checked (no symlinks on the way); the file itself may be a symlink. */
async function leaf(repo: string, path: string) {
	const parent = dirname(path);
	return join(parent === '.' ? repo : await safePath(repo, parent), path.split('/').at(-1)!);
}
/** What the file at `path` is now as a tree entry; null when it is missing. */
async function entryOf(repo: string, paths: readonly string[]): Promise<Map<string, MoveEntry>> {
	const result = new Map<string, MoveEntry>(),
		files: string[] = [];
	for (const path of paths) {
		const full = await leaf(repo, path);
		try {
			const target = await readlink(full);
			const oid = await gitText(repo, ['hash-object', '--no-filters', '--stdin'], {
				input: target,
			});
			result.set(path, { mode: '120000', oid });
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') result.set(path, null);
			else if (isRecord(error) && error.code === 'EINVAL') files.push(path);
			else if (isRecord(error) && error.code === 'EISDIR') result.set(path, null);
			else throw error;
		}
	}
	if (files.length) {
		const oids = (
			await gitText(repo, ['hash-object', '--stdin-paths'], { input: files.join('\n') + '\n' })
		).split('\n');
		for (const [i, path] of files.entries()) {
			const info = await stat(await leaf(repo, path));
			result.set(
				path,
				info.isFile() ? { mode: info.mode & 0o111 ? '100755' : '100644', oid: oids[i] ?? '' } : null
			);
		}
	}
	return result;
}
/** The same content: a symlink is a symlink, and a file's executable bit is left to the repo's `core.fileMode`. */
const same = (a: MoveEntry | undefined, b: MoveEntry) =>
	(a ?? null) === b ||
	(!!a && !!b && a.oid === b.oid && (a.mode === '120000') === (b.mode === '120000'));
/**
 * spec/crew#auto-move: the worktree copy (fresh at `plan.head`) gets the moved paths, then every one is checked against the blob it should
 * hold. Returns the paths that do not match; the caller fails the move on any.
 */
export async function writeRepoMove(worktree: string, plan: RepoMovePlan): Promise<string[]> {
	const names = plan.writes.filter((item) => item.path.includes('\n')).map((item) => item.path);
	if (names.length) return names;
	await checkout(worktree, plan.head, plan.writes);
	for (const path of plan.deletes) await rm(await leaf(worktree, path), { force: true });
	const actual = await entryOf(worktree, [
		...plan.writes.map((item) => item.path),
		...plan.deletes,
	]);
	return [
		...plan.writes.filter((item) => !same(actual.get(item.path), item)),
		...plan.deletes.filter((path) => actual.get(path) !== null).map((path) => ({ path })),
	].map((item) => item.path);
}
/**
 * spec/crew#auto-move: after the switch, each moved path of the project folder goes back to its version at the task's start. Git writes
 * the start versions into a folder of its own first; then each path is checked right before it is replaced in one rename, so a version
 * the person saved meanwhile stays (it is returned) and no path is ever missing half-way. An index entry the agent staged for a moved path
 * (its `git add` or `git rm`) returns to `HEAD`; folders left empty by removed files go too.
 */
export async function restoreProjectRepo(
	repo: string,
	baseTree: string,
	moved: RepoMovePlan['moved']
): Promise<string[]> {
	if (!moved.length) return [];
	const stage = await mkdtemp(
		join(await gitText(repo, ['rev-parse', '--absolute-git-dir']), 'brigadir-restore-')
	);
	const changed: string[] = [],
		back: typeof moved = [],
		removed: string[] = [];
	try {
		const writes = moved.flatMap((item) =>
			item.base ? [{ path: item.path, mode: item.base.mode, oid: item.base.oid }] : []
		);
		if (writes.length)
			await scratchIndex(async (env) => {
				await gitText(repo, ['read-tree', baseTree], { env });
				await gitText(repo, ['update-index', '-z', '--index-info'], {
					env,
					input: writes.map((item) => `${item.mode} ${item.oid}\t${item.path}\0`).join(''),
				});
				await gitText(repo, ['checkout-index', '-f', '-z', '--stdin', `--prefix=${stage}/`], {
					env,
					input: writes.map((item) => `${item.path}\0`).join(''),
				});
			});
		for (const item of moved) {
			const now = (await entryOf(repo, [item.path])).get(item.path);
			// Restored already, by a run that stopped half-way: only its index entry may be left.
			if (same(now, item.base)) {
				back.push(item);
				continue;
			}
			if (!same(now, item.current)) {
				changed.push(item.path);
				continue;
			}
			const target = await leaf(repo, item.path);
			if (item.base) {
				const from = join(stage, item.path),
					next = `${target}.brigadir-restore`;
				await mkdir(dirname(target), { recursive: true });
				await rm(next, { force: true });
				const info = await lstat(from);
				if (info.isSymbolicLink()) await symlink(await readlink(from), next);
				else {
					await copyFile(from, next);
					await chmod(next, info.mode & 0o777);
				}
				await rename(next, target);
			} else {
				await rm(target, { force: true });
				removed.push(item.path);
			}
			back.push(item);
		}
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
	// The agent's own `git add` or `git rm` of a moved path: the person's index returns to HEAD for it.
	const staged = new Map<string, MoveEntry>();
	for (let i = 0; i < back.length; i += 200)
		for (const line of (
			await git(repo, [
				'ls-files',
				'-s',
				'-z',
				'--',
				...back.slice(i, i + 200).map((item) => `:(literal)${item.path}`),
			])
		)
			.toString('utf8')
			.split('\0')
			.filter(Boolean)) {
			const tab = line.indexOf('\t');
			const [mode, oid] = line.slice(0, tab).split(' ');
			staged.set(line.slice(tab + 1), { mode: mode!, oid: oid! });
		}
	const resets = back.filter((item) => {
		const entry = staged.get(item.path) ?? null;
		return (entry?.oid ?? null) === (item.current?.oid ?? null) && !same(entry, item.head);
	});
	if (resets.length)
		await gitText(repo, ['update-index', '-z', '--index-info'], {
			input: resets
				.map((item) =>
					item.head
						? `${item.head.mode} ${item.head.oid}\t${item.path}\0`
						: `0 ${'0'.repeat(40)}\t${item.path}\0`
				)
				.join(''),
		});
	await pruneEmpty(repo, removed);
	return changed;
}
/** Folders under the repo root that only removed files filled. */
async function pruneEmpty(repo: string, removed: readonly string[]) {
	const folders = new Set<string>();
	for (const path of removed)
		for (let dir = dirname(path); dir !== '.' && dir !== '/'; dir = dirname(dir)) folders.add(dir);
	for (const dir of [...folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
		try {
			const full = await safePath(repo, dir);
			if ((await readdir(full)).length === 0) await rmdir(full);
		} catch {
			/* A folder that is gone, holds something or is a link stays as it is. */
		}
	}
}
/** Stayed paths of a repo as project-relative paths. */
export function projectStayed(
	relativePath: string,
	stayed: readonly { path: string; reason: WorkspaceStayReason }[]
): WorkspaceStayed[] {
	return stayed.map((item) => ({
		path: relativePath ? `${relativePath}/${item.path}` : item.path,
		reason: item.reason,
	}));
}
