import { access, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	CARRY_CONFLICT_MESSAGE,
	FETCH_FAILED,
	PULL_DIRTY,
	isOurStash,
	stashMessage,
	type CreateBranchRequest,
	type DirtyFile,
	type LastCommit,
	type PullOutcome,
	type StashEntry,
	type SwitchBranch,
	type SwitchRequest,
	type SwitchResult,
} from '@brigadir/core';
import { git, gitText, GitError } from './command';

/**
 * spec/git#main-tree-branches: the main tree's branch and the git tools around it. Everything here writes the person's own working tree, so
 * every step is one git command that refuses rather than guesses: no `reset` but the ones the person confirmed, a stash
 * addressed by its SHA (the stack is shared by every worktree of the repo), a fast-forward only.
 */
const FIELD = '\x1f';
export const CARRY_CONFLICT = CARRY_CONFLICT_MESSAGE;

/** Local and remote branches; a remote one with a local twin is not listed twice. */
export async function switchBranches(
	path: string
): Promise<{ current: string | null; branches: SwitchBranch[] }> {
	const format = [
		'%(refname)',
		'%(refname:short)',
		'%(upstream:short)',
		'%(upstream:track,nobracket)',
		'%(worktreepath)',
	].join(FIELD);
	const [out, current, here] = await Promise.all([
		gitText(path, [
			'for-each-ref',
			'--sort=-committerdate',
			'--count=400',
			`--format=${format}`,
			'refs/heads',
			'refs/remotes',
		]),
		gitText(path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
		realpath(path).catch(() => path),
	]);
	const local: SwitchBranch[] = [],
		remote: SwitchBranch[] = [];
	for (const line of out.split('\n')) {
		const [ref, name, upstream, track, worktree] = line.split(FIELD);
		if (!ref || !name || ref.endsWith('/HEAD')) continue;
		const isRemote = ref.startsWith('refs/remotes/'),
			ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
			behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
		const elsewhere =
			worktree && name !== current && (await realpath(worktree).catch(() => worktree)) !== here
				? worktree
				: null;
		(isRemote ? remote : local).push({
			name,
			remote: isRemote,
			current: !isRemote && name === current,
			ahead,
			behind,
			upstream: upstream || null,
			gone: track === 'gone',
			worktree: elsewhere,
			worktreeTask: null,
		});
	}
	const names = new Set(local.map((branch) => branch.name));
	return {
		current: current || null,
		branches: [
			...local,
			...remote.filter((branch) => !names.has(branch.name.slice(branch.name.indexOf('/') + 1))),
		],
	};
}

/** `status` with numbers: the dirty step shows what will be stashed, carried or lost. `diff HEAD` counts tracked
 *  files only; an untracked file counts its own lines, as Git counts a new file (a one-line file is `+1`). */
export async function dirtyFiles(path: string): Promise<DirtyFile[]> {
	const [status, numstat] = await Promise.all([
		git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
		gitText(path, ['diff', '--numstat', '-z', 'HEAD']).catch(() => ''),
	]);
	const counts = new Map<string, [number, number]>(),
		records = numstat.split('\0');
	for (let i = 0; i < records.length; i++) {
		const [add, del, file] = records[i]!.split('\t');
		if (add === undefined || del === undefined || file === undefined) continue;
		// A rename is `N\tM\t` followed by the old and the new path; the row is the new one.
		let target: string | undefined = file;
		if (!target) {
			i += 2;
			target = records[i];
		}
		if (target) counts.set(target, [Number(add) || 0, Number(del) || 0]);
	}
	const entries = status.toString('utf8').split('\0'),
		files: DirtyFile[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.length < 4) continue;
		const code = entry.slice(0, 2),
			file = entry.slice(3);
		if (code[0] === 'R' || code[0] === 'C') i++;
		const untracked = code === '??',
			[additions, deletions] =
				counts.get(file) ?? (untracked ? [await textLines(join(path, file)), 0] : [0, 0]);
		files.push({
			path: file,
			status: untracked ? 'A' : (code.trim()[0] ?? 'M'),
			additions,
			deletions,
			untracked,
		});
	}
	return files;
}
/** Lines of a new text file as `git diff --numstat` counts them: a last line without `\n` counts; binary or over 8 MB is 0. */
async function textLines(file: string): Promise<number> {
	const handle = await open(file, 'r').catch(() => null);
	if (!handle) return 0;
	try {
		const { size } = await handle.stat();
		if (!size || size > 8 * 1024 * 1024) return 0;
		const bytes = Buffer.alloc(size);
		await handle.read(bytes, 0, size, 0);
		if (bytes.subarray(0, 8000).includes(0)) return 0;
		let lines = 0;
		for (const byte of bytes) if (byte === 10) lines++;
		return bytes[size - 1] === 10 ? lines : lines + 1;
	} finally {
		await handle.close();
	}
}

export async function lastCommit(path: string): Promise<LastCommit | null> {
	const head = await gitText(path, ['log', '-1', `--format=%H${FIELD}%s${FIELD}%P`]).catch(
		() => ''
	);
	if (!head) return null;
	const [sha, subject, parents] = head.split(FIELD);
	const pushed = await gitText(path, [
		'for-each-ref',
		'--count=1',
		'--format=%(refname)',
		'--contains',
		sha!,
		'refs/remotes',
	]).catch(() => '');
	return { sha: sha!, subject: subject ?? '', pushed: pushed.length > 0, root: !parents };
}

export async function stashes(path: string): Promise<StashEntry[]> {
	const out = await gitText(path, ['stash', 'list', `--format=%H${FIELD}%gs${FIELD}%ct`]).catch(
		() => ''
	);
	const entries: StashEntry[] = [];
	for (const line of out.split('\n').slice(0, 30)) {
		const [sha, subject, time] = line.split(FIELD);
		if (!sha || !subject) continue;
		// `On main: brigadir: main → staging`, `WIP on main: 1a2b3c message`.
		const match = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject),
			branch = match?.[1] ?? null,
			message = match?.[2] ?? subject;
		const files = (
			await gitText(path, ['stash', 'show', '--include-untracked', '--name-only', sha]).catch(
				() => ''
			)
		)
			.split('\n')
			.filter(Boolean).length;
		entries.push({
			sha,
			branch: branch === '(no branch)' ? null : branch,
			message,
			files,
			time: (Number(time) || 0) * 1000,
			ours: isOurStash(message),
		});
	}
	return entries;
}

/** Pushes the tree into the stash and returns the SHA of that entry, read before anyone else can push on top. */
export async function stashPush(path: string, message: string): Promise<string> {
	const before = await gitText(path, ['rev-parse', '-q', '--verify', 'refs/stash']).catch(() => '');
	await gitText(path, ['stash', 'push', '--include-untracked', '-m', message]);
	const sha = await gitText(path, ['rev-parse', '-q', '--verify', 'refs/stash']);
	if (!sha || sha === before) throw new Error('Nothing to stash');
	return sha;
}
/** `stash@{n}` of a SHA now: the stack moves when another worktree pushes or drops. */
async function stashIndex(path: string, sha: string) {
	const out = await gitText(path, ['stash', 'list', '--format=%H']).catch(() => '');
	const index = out.split('\n').indexOf(sha);
	if (index < 0) throw new Error('The stash entry is gone');
	return `stash@{${index}}`;
}
/** Applies the entry and drops it only when it applied cleanly; a conflict keeps it. */
export async function stashRestore(path: string, sha: string) {
	await stashIndex(path, sha);
	await gitText(path, ['stash', 'apply', '-q', sha]);
	await gitText(path, ['stash', 'drop', '-q', await stashIndex(path, sha)]);
}
export async function stashDrop(path: string, sha: string) {
	await gitText(path, ['stash', 'drop', '-q', await stashIndex(path, sha)]);
}

/** Tracked changes back to HEAD; only the listed new files go (anything new since the confirm stays). */
export async function discardChanges(path: string, untracked: readonly string[]) {
	await gitText(path, ['reset', '--hard', '-q', 'HEAD']);
	const now = new Set(
			(await dirtyFiles(path)).filter((file) => file.untracked).map((file) => file.path)
		),
		gone = untracked.filter((file) => now.has(file));
	for (let i = 0; i < gone.length; i += 200)
		await gitText(path, ['clean', '-f', '-q', '--', ...gone.slice(i, i + 200)]);
}

/** `reset --soft HEAD~1` for a commit that is on no remote yet; its changes stay staged. */
export async function undoLastCommit(path: string): Promise<LastCommit> {
	const last = await lastCommit(path);
	if (!last) throw new Error('No commits');
	if (last.root) throw new Error('This is the first commit of the repo.');
	if (last.pushed)
		throw new Error('The commit is already on origin. Only a new commit (revert) can undo it.');
	await gitText(path, ['reset', '--soft', '-q', 'HEAD~1']);
	return last;
}

async function fetchBranch(path: string, remote: string, branch: string) {
	await gitText(
		path,
		['fetch', '--no-tags', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
		{ timeoutMs: 20_000 }
	);
}
async function exists(path: string, ref: string) {
	return gitText(path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).then(
		Boolean,
		() => false
	);
}
/** Commits the local branch is only behind its upstream by; 0 when it is not strictly behind. */
async function behindOnly(path: string): Promise<number> {
	const counts = await gitText(path, [
		'rev-list',
		'--left-right',
		'--count',
		'HEAD...@{upstream}',
	]).catch(() => '');
	const [ahead, behind] = counts.split(/\s+/).map(Number);
	return ahead === 0 && behind ? behind : 0;
}

/**
 * spec/git#main-tree-branches: switch the tree to `branch` (a local one, or `origin/x` as its local twin with tracking), after the dirty
 * step's choice; a local branch strictly behind its upstream is fast-forwarded.
 */
export async function switchBranch(path: string, request: SwitchRequest): Promise<SwitchResult> {
	const current =
		(await gitText(path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')) || null;
	const remotes = (await gitText(path, ['remote']).catch(() => '')).split('\n').filter(Boolean);
	const remote = remotes.find(
		(name) => request.branch.startsWith(`${name}/`) && !remotes.includes(request.branch)
	);
	const local =
		remote && !(await exists(path, `refs/heads/${request.branch}`))
			? request.branch.slice(remote.length + 1)
			: request.branch;
	if (local === current) return { current, pulled: 0, stash: null };
	const hasLocal = await exists(path, `refs/heads/${local}`);
	const upstream = hasLocal
		? await gitText(path, ['rev-parse', '--abbrev-ref', `${local}@{upstream}`]).catch(() => '')
		: '';
	const source =
		remote ??
		(upstream.includes('/')
			? upstream.slice(0, upstream.indexOf('/'))
			: hasLocal
				? null
				: remotes.includes('origin')
					? 'origin'
					: null);
	const remoteBranch = remote
		? local
		: upstream
			? upstream.slice(upstream.indexOf('/') + 1)
			: local;
	if (source && !request.offline)
		await fetchBranch(path, source, remoteBranch).catch((error) => {
			// A branch that exists only on the remote cannot be switched to without it; a local one can, with the person's say.
			throw new GitError(['fetch'], error instanceof GitError ? error.code : null, FETCH_FAILED);
		});
	if (!hasLocal && !(source && (await exists(path, `refs/remotes/${source}/${remoteBranch}`))))
		throw new Error('The branch is unavailable');
	const dirty = (await dirtyFiles(path)).length > 0;
	if (dirty && request.mode === 'clean') throw new Error('The main tree has uncommitted changes');
	let stash: string | null = null;
	if (dirty && request.mode === 'discard') await discardChanges(path, request.discardPaths ?? []);
	if (dirty && request.mode === 'stash')
		stash = await stashPush(path, stashMessage(current, local));
	try {
		await gitText(
			path,
			hasLocal
				? ['switch', '-q', local]
				: ['switch', '-q', '-c', local, '--track', `${source}/${remoteBranch}`]
		);
	} catch (error) {
		if (stash) await stashRestore(path, stash).catch(() => {});
		// «Bring the changes» (spec/git#main-tree-branches): git refuses when the target touches the same files; the tree is as it was.
		if (
			error instanceof GitError &&
			/would be overwritten|overwritten by checkout/.test(error.message)
		)
			throw new Error(CARRY_CONFLICT);
		throw error;
	}
	let pulled = 0;
	if (hasLocal && !request.offline) {
		const behind = await behindOnly(path);
		if (behind)
			pulled = await gitText(path, ['merge', '--ff-only', '-q', '@{upstream}']).then(
				() => behind,
				() => 0
			);
	}
	return { current: local, pulled, stash };
}

/** spec/git#main-tree-branches: a new branch from `base` without tracking it (a push must not land in `base`); changes move along. */
export async function createBranch(
	path: string,
	request: CreateBranchRequest
): Promise<SwitchResult> {
	if (await exists(path, `refs/heads/${request.name}`))
		throw new Error('A branch with this name already exists.');
	const remotes = (await gitText(path, ['remote']).catch(() => '')).split('\n').filter(Boolean),
		remote = remotes.find((name) => request.base.startsWith(`${name}/`));
	if (remote)
		await fetchBranch(path, remote, request.base.slice(remote.length + 1)).catch(() => {});
	const ref = (await exists(path, `refs/heads/${request.base}`))
		? `refs/heads/${request.base}`
		: `refs/remotes/${request.base}`;
	if (!(await exists(path, ref))) throw new Error('The branch is unavailable');
	await gitText(path, ['switch', '-q', '--no-track', '-c', request.name, ref]);
	return { current: request.name, pulled: 0, stash: null };
}

/** spec/git#pull: ahead/behind the upstream as of the last fetch; null without an upstream or when it is gone. */
export async function upstreamCounts(
	path: string
): Promise<{ ahead: number; behind: number } | null> {
	const counts = await gitText(path, [
		'rev-list',
		'--left-right',
		'--count',
		'HEAD...@{upstream}',
	]).catch(() => '');
	if (!counts) return null;
	const [ahead, behind] = counts.split(/\s+/).map(Number);
	return { ahead: ahead || 0, behind: behind || 0 };
}
/** Fetch and fast-forward the current branch; returns the commits it moved by. */
export async function pullFastForward(path: string): Promise<number> {
	const upstream = await gitText(path, ['rev-parse', '--abbrev-ref', '@{upstream}']).catch(
		() => ''
	);
	if (!upstream) throw new Error('The branch has no upstream on origin.');
	const remote = upstream.slice(0, upstream.indexOf('/'));
	await fetchBranch(path, remote, upstream.slice(remote.length + 1)).catch(() => {
		throw new Error(FETCH_FAILED);
	});
	const counts = (
		await gitText(path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
	)
		.split(/\s+/)
		.map(Number);
	if (!counts[1]) return 0;
	if (counts[0]) throw new Error('The branch has diverged from origin. Pull only fast-forwards.');
	await gitText(path, ['merge', '--ff-only', '-q', '@{upstream}']);
	return counts[1];
}

/**
 * spec/git#pull: a click on `↓N`. Only behind → fast-forward; diverged → rebase of the local commits onto the upstream, never a merge commit.
 * A rebase that stops on a conflict is aborted before this returns, so the tree and the branch are as they were.
 */
export async function pullBranch(path: string): Promise<PullOutcome> {
	const upstream = await gitText(path, ['rev-parse', '--abbrev-ref', '@{upstream}']).catch(
		() => ''
	);
	if (!upstream) throw new Error('The branch has no upstream on origin.');
	const remote = upstream.slice(0, upstream.indexOf('/'));
	await fetchBranch(path, remote, upstream.slice(remote.length + 1)).catch(() => {
		throw new Error(FETCH_FAILED);
	});
	const [ahead = 0, behind = 0] = (
		await gitText(path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
	)
		.split(/\s+/)
		.map(Number);
	if (!behind) return { kind: 'pulled', pulled: 0, rebased: 0 };
	if (!ahead) {
		await gitText(path, ['merge', '--ff-only', '-q', '@{upstream}']);
		return { kind: 'pulled', pulled: behind, rebased: 0 };
	}
	try {
		await gitText(path, ['rebase', '-q', '--no-autostash', '@{upstream}']);
		return { kind: 'pulled', pulled: behind, rebased: ahead };
	} catch (error) {
		if (!(await rebasing(path))) {
			const text = error instanceof Error ? error.message : String(error);
			throw /uncommitted|unstaged|overwritten|stash/i.test(text) ? new Error(PULL_DIRTY) : error;
		}
		const files = (await gitText(path, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
			.split('\n')
			.filter(Boolean);
		await gitText(path, ['rebase', '--abort']);
		const branch = await gitText(path, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'HEAD');
		return { kind: 'conflict', branch, upstream, ahead, behind, files };
	}
}
async function rebasing(path: string) {
	for (const name of ['rebase-merge', 'rebase-apply']) {
		const at = await gitText(path, ['rev-parse', '--git-path', name]).catch(() => '');
		if (
			at &&
			(await access(resolve(path, at)).then(
				() => true,
				() => false
			))
		)
			return true;
	}
	return false;
}

/** The background refresh of the list (spec/git#main-tree-branches): one fetch of the remotes, pruned, quietly. */
export async function fetchRemotes(path: string) {
	await gitText(path, ['fetch', '--no-tags', '--prune', '--all', '-q'], { timeoutMs: 20_000 });
}
