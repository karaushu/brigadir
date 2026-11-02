import { patchHunks, type ChangedFile, type Scope, type DeltaHunk } from '@brigadir/core';
import { gitText, GitError } from './command';
/** Git parses the blobs out of process; response size never follows a huge source line. */
export async function attributionHunks(
	scope: Scope,
	file: ChangedFile
): Promise<DeltaHunk[] | null> {
	if (file.binary || file.gitlink) return null;
	if (!file.before) return [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: file.additions }];
	if (!file.after) return [{ oldStart: 1, oldCount: file.deletions, newStart: 0, newCount: 0 }];
	// Blobs are immutable, and so is their diff: a cache without invalidation.
	const key = `${scope.path}\0${file.before}\0${file.after}`;
	let pending = hunks.get(key);
	if (pending) {
		hunks.delete(key);
		hunks.set(key, pending);
	} else {
		const created = blobHunks(scope, file.before, file.after);
		pending = created;
		hunks.set(key, created);
		created.catch(() => {
			if (hunks.get(key) === created) hunks.delete(key);
		});
		while (hunks.size > 2048) hunks.delete(hunks.keys().next().value!);
	}
	return (await pending)?.map((hunk) => ({ ...hunk })) ?? null;
}
const hunks = new Map<string, Promise<DeltaHunk[] | null>>();
async function blobHunks(scope: Scope, before: string, after: string): Promise<DeltaHunk[] | null> {
	try {
		return patchHunks(
			await gitText(
				scope.path,
				['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', before, after],
				{ maxBytes: 512 * 1024 }
			)
		);
	} catch (error) {
		if (error instanceof GitError && error.message === 'Git operation exceeded its resource limit')
			return null;
		throw error;
	}
}
