import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readRelayHandoff, safePath, type SessionStore } from '@brigadir/persistence';
import type { TaskKey, PromptResource } from '@brigadir/core';
/** Rebase file references into this task's prepared tree; never link the source worktree. */
/** The first turn's own context: a relay's handoff (spec/tasks#relay) and the attachments the task was saved with (spec/tasks#backlog-edit). */
export async function relayContext(
	store: SessionStore,
	key: TaskKey
): Promise<{ attachmentIds: string[]; resources: PromptResource[] }> {
	const own = (await store.task(key)).attachments?.map((item) => item.id) ?? [];
	const handoff = await readRelayHandoff(store, key);
	if (!handoff) return { attachmentIds: own, resources: [] };
	const project = await store.projectForTask(key),
		resources: PromptResource[] = [];
	for (const name of handoff.files) {
		try {
			const path = await safePath(project.path, name);
			if ((await lstat(path)).isFile()) resources.push({ name, uri: pathToFileURL(path).href });
		} catch {
			/* Missing or unsafe references are described by the stat, never exposed as links. */
		}
	}
	return { attachmentIds: [...handoff.attachmentIds, ...own], resources };
}
