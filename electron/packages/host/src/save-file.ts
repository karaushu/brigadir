import type { SaveFileRequest, SaveFileResult, SessionEvent, TaskKey } from '@brigadir/core';
import { readProjectFile, writeProjectFile, type SessionStore } from '@brigadir/persistence';
import { Snapshots } from '@brigadir/git';
import { join } from 'node:path';
export async function saveTaskFile(
	store: SessionStore,
	key: TaskKey,
	snapshots: Snapshots,
	request: SaveFileRequest,
	emit: (event: SessionEvent) => Promise<void>
): Promise<SaveFileResult> {
	const project = await store.projectForTask(key);
	const current = await readProjectFile(project.path, request.path);
	if (current.version !== request.expectedVersion) return { status: 'conflict', content: current };
	// spec/diff-and-review#snapshots: the save delta covers only the repo with this file; other repos are captured by the agent's turn.
	const scopeIds = await snapshots.scopesFor(join(project.path, request.path)),
		before = await snapshots.capture('user-before', { scopeIds });
	const result = await writeProjectFile(project.path, request);
	if (result.status === 'conflict') return result;
	const after = await snapshots.capture('user-after', { scopeIds });
	if (after && after.id !== before?.id)
		await emit({ kind: 'checkpoint.created', checkpoint: after.id });
	await emit({
		kind: 'file.saved',
		path: request.path,
		before: before?.id ?? null,
		after: after?.id ?? null,
		version: result.content.version,
	});
	return result;
}
