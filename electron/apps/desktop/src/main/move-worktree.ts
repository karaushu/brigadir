import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { moveRefusal, type AgentTask, type MoveRefusal, type TaskKey } from '@brigadir/core';
import { readDocument, safePath, type SessionStore } from '@brigadir/persistence';

/**
 * spec/tasks#move-to-worktree: whether the person's move applies to a task, read from its files without its host: a move already under way
 * (`workspace-move.json`), the launch queue and the project's Git repository. The host repeats the rule with what only it knows.
 */
export async function personMoveRefusal(
	store: SessionStore,
	key: TaskKey,
	task: AgentTask,
	queued: boolean
): Promise<MoveRefusal | 'worktree' | null> {
	const moving = await readDocument(await safePath(await store.taskDir(key), 'workspace-move.json'))
		.then((doc) => ['pending', 'moving', 'switching', 'switched'].includes(String(doc.state)))
		.catch(() => false);
	const project = await store.project(key.projectId).catch(() => null);
	const git = project
		? await stat(join(project.path, '.git')).then(
				() => true,
				() => false
			)
		: false;
	return moveRefusal(queued ? { ...task, status: 'queued' } : task, { moving, git });
}
