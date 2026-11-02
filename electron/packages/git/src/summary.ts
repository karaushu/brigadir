import { baseTree, inTask } from '@brigadir/core';
import type { ChangeView, SnapshotDocument } from '@brigadir/core';
import { git, isSha } from './command';
import { nestedPrefixes, repoPath, viewTrees } from './changes';
/** Numstat only: no patch, blob, text conversion, index write or working-tree diff.
 *  The view is the base setting (spec/diff-and-review#diff-base): the task's first snapshot, or HEAD of each repo. */
/** spec/crew#parts: `from` is the task's change base. */
export async function snapshotTotals(doc: SnapshotDocument, view?: ChangeView, from = 0) {
	const current = doc.checkpoints.at(-1);
	let additions = 0,
		deletions = 0,
		files = 0;
	if (!current) return { additions, deletions, files };
	for (const scope of doc.scopes.filter(
		(scope) => inTask(scope) && (scope.available !== false || scope.source)
	)) {
		const trees =
			view === 'head' && scope.available !== false
				? await viewTrees(doc, scope, 'head')
				: (() => {
						const before = baseTree(doc, scope.id, from),
							after = current.trees.find((tree) => tree.scopeId === scope.id);
						return before && after ? { old: before.tree, next: after.tree } : null;
					})();
		if (!trees || trees.old === trees.next) continue;
		if (!isSha(trees.old) || !isSha(trees.next)) throw new Error('Invalid snapshot trees');
		const children = nestedPrefixes(doc, scope, current.id);
		const bytes = await git(
				repoPath(scope),
				[
					'diff-tree',
					'-r',
					'-M',
					'-C',
					'--no-commit-id',
					'--numstat',
					'-z',
					'--no-ext-diff',
					'--no-textconv',
					trees.old,
					trees.next,
				],
				{ maxBytes: 2 * 1024 * 1024, timeoutMs: 8000 }
			),
			entries = bytes.toString('utf8').split('\0');
		for (let index = 0; index < entries.length - 1; index++) {
			const line = entries[index]!,
				first = line.indexOf('\t'),
				second = line.indexOf('\t', first + 1);
			if (first < 0 || second < 0) throw new Error('Invalid numstat');
			const added = line.slice(0, first),
				removed = line.slice(first + 1, second);
			let path = line.slice(second + 1);
			if (!path) {
				index++;
				path = entries[++index] ?? '';
			}
			if (!path || !/^\d+$|^-$/.test(added) || !/^\d+$|^-$/.test(removed))
				throw new Error('Invalid numstat');
			if (children.some((prefix) => path.startsWith(prefix))) continue;
			additions += added === '-' ? 0 : Number(added);
			deletions += removed === '-' ? 0 : Number(removed);
			files++;
			if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions))
				throw new Error('Invalid line totals');
		}
	}
	return { additions, deletions, files };
}
