import { access, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { git, gitText, GitError } from './command';
export type MergeResult = { merged: boolean; conflicts: string[]; sha: string | null };
/**
 * spec/crew#task-type (result integration), spec/crew#accept: a deterministic `merge --squash` done by code, then one ordinary commit with `message`
 * (one parent, no merge commit). Conflicts stay in the tree for the human with `message` in `SQUASH_MSG`, so «Finish merge»
 * (`commit --no-edit`) commits it; nothing is resolved automatically. A branch already in the tree commits nothing.
 */
export async function squashBranch(
	repoPath: string,
	branch: string,
	message: string
): Promise<MergeResult> {
	if (!branch || branch.startsWith('-') || /[\s\0]/.test(branch)) throw new Error('Invalid branch');
	if (!message.trim()) throw new Error('Empty commit message');
	const before = await gitText(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
		() => null
	);
	const target = await gitText(repoPath, [
		'rev-parse',
		'--verify',
		'--quiet',
		`refs/heads/${branch}^{commit}`,
	]).catch(() => null);
	if (!target) throw new Error(`Branch ${branch} does not exist`);
	if (
		before &&
		(await gitText(repoPath, ['merge-base', '--is-ancestor', target, before]).then(
			() => true,
			(error) => {
				if (error instanceof GitError && error.code === 1) return false;
				throw error;
			}
		))
	)
		return { merged: false, conflicts: [], sha: before };
	// An earlier conflict is the human's until they finish or abort it; its files must not be taken for this part's conflicts.
	if (
		(await gitText(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')) ||
		(await squashInProgress(repoPath))
	)
		throw new Error('A merge is in progress in this tree; finish or abort it before accepting');
	// A fast-forward squash keeps staged changes, and the commit below takes the whole index: refuse, like `merge --no-ff`.
	if (before && (await indexDiffers(repoPath)))
		throw new Error('The tree has staged changes; commit or unstage them before accepting');
	try {
		await git(repoPath, ['merge', '--squash', '--', branch]);
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		const conflicts = await unmergedNames(repoPath);
		if (!conflicts.length) throw error;
		// git appends `# Conflicts:` to MERGE_MSG, and `commit --no-edit` would carry those lines into the message (spec/crew#accept).
		await writeFile(await gitPath(repoPath, 'SQUASH_MSG'), message.trim() + '\n');
		await rm(await gitPath(repoPath, 'MERGE_MSG'), { force: true });
		return { merged: false, conflicts, sha: before };
	}
	// The changes are already in the tree (a retried acceptance): nothing to commit.
	if (before && !(await indexDiffers(repoPath))) {
		await rm(await gitPath(repoPath, 'SQUASH_MSG'), { force: true });
		return { merged: false, conflicts: [], sha: before };
	}
	await git(repoPath, ['commit', '-q', '--no-verify', '--cleanup=verbatim', '-F', '-'], {
		input: message.trim() + '\n',
	});
	return { merged: true, conflicts: [], sha: await gitText(repoPath, ['rev-parse', 'HEAD']) };
}
/**
 * spec/crew#parts: before a crew member's next part, its branch takes the parent's tree. `bridge` is a commit with that tree and
 * two parents — the worker tip the last acceptance squashed (`acceptedTip`) and the parent's HEAD — and the worker tree merges it.
 * A tip that is still where acceptance left it fast-forwards onto the parent's tree; anything added to the worker branch after
 * acceptance merges with that tip as the base, so the accepted work never conflicts with its own squash. The parent's HEAD
 * becomes an ancestor of the worker branch, so the next squash takes only the new part (spec/crew#parts). A conflict stays in the
 * worker's tree (`MERGE_HEAD`) for the human.
 */
export async function syncFromParent(
	repoPath: string,
	parentHead: string,
	acceptedTip: string | null,
	message: string
): Promise<MergeResult> {
	if (
		!/^[0-9a-f]{40,64}$/.test(parentHead) ||
		(acceptedTip !== null && !/^[0-9a-f]{40,64}$/.test(acceptedTip))
	)
		throw new Error('Invalid commit');
	if (!message.trim()) throw new Error('Empty commit message');
	const head = await gitText(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
		() => null
	);
	if (!head) throw new Error('The worker branch has no commit');
	const ancestor = (commit: string, of: string) =>
		gitText(repoPath, ['merge-base', '--is-ancestor', commit, of]).then(
			() => true,
			(error) => {
				if (error instanceof GitError && error.code === 1) return false;
				throw error;
			}
		);
	if (await ancestor(parentHead, head)) return { merged: false, conflicts: [], sha: head };
	if (
		(await gitText(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')) ||
		(await squashInProgress(repoPath))
	)
		throw new Error('A merge is in progress in the worker tree; finish or abort it first');
	if (await indexDiffers(repoPath))
		throw new Error('The worker tree has staged changes; commit or unstage them first');
	const base =
		acceptedTip && (await ancestor(acceptedTip, head).catch(() => false)) ? acceptedTip : head;
	const tree = await gitText(repoPath, ['rev-parse', `${parentHead}^{tree}`]);
	const bridge = await gitText(
		repoPath,
		['commit-tree', tree, '-p', base, '-p', parentHead, '-F', '-'],
		{ input: message.trim() + '\n' }
	);
	try {
		await git(repoPath, ['merge', '-q', '--no-edit', '--no-verify', '-m', message.trim(), bridge]);
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		const conflicts = await unmergedNames(repoPath);
		if (conflicts.length) return { merged: false, conflicts, sha: head };
		if (await gitText(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => ''))
			await git(repoPath, ['merge', '--abort']).catch(() => {});
		throw error;
	}
	return { merged: true, conflicts: [], sha: await gitText(repoPath, ['rev-parse', 'HEAD']) };
}
/** A file under this worktree's git dir (`.git/worktrees/<name>/…` for a linked worktree). */
export async function gitPath(repoPath: string, name: string): Promise<string> {
	const value = await gitText(repoPath, ['rev-parse', '--git-path', name]);
	return isAbsolute(value) ? value : join(repoPath, value);
}
/** The index has something HEAD has not (staged or unmerged entries); `diff-index --cached` reads no work tree stat. */
async function indexDiffers(repoPath: string): Promise<boolean> {
	return git(repoPath, ['diff-index', '--cached', '--quiet', 'HEAD', '--']).then(
		() => false,
		(error) => {
			if (error instanceof GitError && error.code === 1) return true;
			throw error;
		}
	);
}
/** spec/crew#accept: a squash left by crew acceptance — `SQUASH_MSG` without `MERGE_HEAD`, and the index still differs from HEAD. */
export async function squashInProgress(repoPath: string): Promise<boolean> {
	if (await gitText(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => ''))
		return false;
	const message = await gitPath(repoPath, 'SQUASH_MSG')
		.then((path) => access(path))
		.then(
			() => true,
			() => false
		);
	return message && (await indexDiffers(repoPath).catch(() => false));
}
export async function hasUnmergedPaths(repoPath: string): Promise<boolean> {
	return (await unmergedNames(repoPath)).length > 0;
}
/** The same as `diff --name-only --diff-filter=U`, but without refreshing the user's index under its lock. */
/** Index stages of each unmerged path: 1 base, 2 ours, 3 theirs. A side without its stage deleted the file. */
export async function unmergedStages(repoPath: string): Promise<Map<string, Set<number>>> {
	const stages = new Map<string, Set<number>>();
	for (const entry of (await git(repoPath, ['ls-files', '-u', '-z']))
		.toString('utf8')
		.split('\0')) {
		const tab = entry.indexOf('\t');
		if (tab < 0) continue;
		const name = entry.slice(tab + 1),
			stage = Number(entry.slice(0, tab).split(' ')[2]);
		const set = stages.get(name) ?? new Set<number>();
		set.add(stage);
		stages.set(name, set);
	}
	return stages;
}
export async function unmergedNames(repoPath: string): Promise<string[]> {
	const names: string[] = [];
	for (const entry of (await git(repoPath, ['ls-files', '-u', '-z']))
		.toString('utf8')
		.split('\0')) {
		const tab = entry.indexOf('\t');
		if (tab < 0) continue;
		const name = entry.slice(tab + 1);
		if (names.at(-1) !== name) names.push(name);
	}
	return names;
}
