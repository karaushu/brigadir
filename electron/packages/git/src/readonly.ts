import { inTask, watched } from '@brigadir/core';
import { join } from 'node:path';
import type { Checkpoint, Scope } from '@brigadir/core';
import { changedFiles } from './changes';
/** Evidence of changed trees, not a claim about which external process wrote them. */
export async function readOnlyChanges(
	scopes: readonly Scope[],
	before: Checkpoint | undefined,
	after: Checkpoint | null
) {
	const violations: { scopeId: string; name: string; paths: string[]; checkpoint: number }[] = [];
	if (!before || !after || before.id === after.id) return violations;
	for (const scope of scopes.filter((scope) => watched(scope) && scope.available !== false)) {
		const old = before.trees.find((tree) => tree.scopeId === scope.id),
			next = after.trees.find((tree) => tree.scopeId === scope.id);
		if (!old || !next || old.tree === next.tree) continue;
		const files = (await changedFiles(scope, old.tree, next.tree)).filter(
			(file) =>
				!file.gitlink ||
				!scopes.some(
					(child) =>
						child.path === join(scope.path, file.path) && inTask(child) && child.available !== false
				)
		);
		if (files.length)
			violations.push({
				scopeId: scope.id,
				name: scope.name,
				paths: files.slice(0, 128).map((file) => file.path),
				checkpoint: after.id,
			});
	}
	return violations;
}
