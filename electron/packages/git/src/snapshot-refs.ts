import type { TaskKey } from '@brigadir/core';
import { gitText, GitError } from './command';
/** spec/architecture-and-platform#snapshot-refs: one tip ref per task and repo instead of a ref per checkpoint. Snapshot
 *  commits form a parent chain, so the tip keeps all earlier ones from gc. `refs/brigadir-v2/snap/…/<scope>/<n>` remain only
 *  where a commit would otherwise become unreachable: legacy refs before consolidation and keepers of a broken chain. The
 *  tip lives outside `snap/`, because a ref cannot be both a file and a directory of the same per-checkpoint refs. */
export const tipRef = (key: TaskKey, scopeId: string) =>
	`refs/brigadir-v2/tip/${key.projectId}/${key.id}/${scopeId}`;
export const checkpointRefPrefix = (key: TaskKey, scopeId: string) =>
	`refs/brigadir-v2/snap/${key.projectId}/${key.id}/${scopeId}/`;
/** How many per-checkpoint refs one pass checks with one `merge-base --independent`; the rest go to the next pass. */
export const refBatch = 1024;
const order = (name: string) => {
	const n = Number(name.slice(name.lastIndexOf('/') + 1));
	return Number.isInteger(n) ? n : -1;
};
/**
 * Moves the tip to the new snapshot commit and removes per-checkpoint refs reachable from what remains.
 * `expected` — the tip value this process itself wrote last: then one `update-ref tip new old` is enough.
 * Otherwise (a new instance, an old task, a foreign tip change) — the slow path: `for-each-ref` of this repo and task,
 * `merge-base --independent` of the new commit, the old tip and per-checkpoint refs, one transaction for the tip and
 * keeper, a second for deletion. Only a ref whose commit git called an ancestor of (or equal to) a remaining commit goes.
 * Returns true when this repo's refs are fully consolidated.
 */
export async function advanceTip(
	cwd: string,
	key: TaskKey,
	scopeId: string,
	commit: string,
	parent: string | undefined,
	expected: string | null | undefined,
	keeperId: (oid: string) => number
): Promise<boolean> {
	const ref = tipRef(key, scopeId),
		zero = '0'.repeat(commit.length);
	if (expected !== undefined && (expected ?? undefined) === parent)
		try {
			await gitText(cwd, ['update-ref', ref, commit, parent ?? zero]);
			return true;
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
		}
	const prefix = checkpointRefPrefix(key, scopeId);
	const listed = (
		await gitText(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', ref, prefix])
	)
		.split('\n')
		.filter(Boolean)
		.map((line) => ({
			oid: line.slice(0, line.indexOf(' ')),
			name: line.slice(line.indexOf(' ') + 1),
		}));
	const current = listed.find((entry) => entry.name === ref)?.oid,
		all = listed
			.filter((entry) => entry.name.startsWith(prefix))
			.sort((a, b) => order(b.name) - order(a.name)),
		candidates = all.slice(0, refBatch);
	// The old tip, which without git is not known to be an ancestor of the new commit (the parent is known: commit-tree -p).
	const loose = current && current !== commit && current !== parent ? current : undefined;
	let independent: Set<string> | null = new Set([commit]);
	if (loose || candidates.length)
		try {
			independent = new Set(
				(
					await gitText(cwd, [
						'merge-base',
						'--independent',
						...new Set([
							commit,
							...(loose ? [loose] : []),
							...candidates.map((entry) => entry.oid),
						]),
					])
				)
					.split('\n')
					.filter(Boolean)
			);
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			independent = null;
		}
	// A broken chain: the old tip is reachable neither from the new commit nor from another ref, so it gets its own per-checkpoint ref.
	const keep =
		loose && !all.some((entry) => entry.oid === loose) && (!independent || independent.has(loose));
	const lines = [`update ${ref} ${commit} ${current ?? zero}`];
	if (keep) {
		let name = `${prefix}${keeperId(loose)}`;
		if (all.some((entry) => entry.name === name)) name = `${name}-${loose.slice(0, 12)}`;
		lines.push(`create ${name} ${loose}`);
	}
	await gitText(cwd, ['update-ref', '--stdin'], { input: lines.join('\n') + '\n' });
	if (!independent) return false;
	const doomed = candidates.filter((entry) => entry.oid === commit || !independent.has(entry.oid));
	if (doomed.length)
		try {
			await gitText(cwd, ['update-ref', '--stdin'], {
				input: doomed.map((entry) => `delete ${entry.name} ${entry.oid}`).join('\n') + '\n',
			});
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			return false;
		}
	return all.length <= refBatch;
}
