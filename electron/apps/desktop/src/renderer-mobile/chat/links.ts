/**
 * A link in the agent's answer on the phone (spec/remote-access-and-mobile#phone-chat). The page is the signed-in app: following a link in it would
 * replace it and ask for the passkey again. An address with a scheme (`https:`, `mailto:`) opens in a new tab or the system
 * browser; a file of the task (`src/app.ts`, `./src/app.ts:12`, the absolute path the agent knows) opens in Files
 * (spec/remote-access-and-mobile#phone-task-tools), found by `searchFiles` among the task's files, so the phone still names a file only by main's id; anything else
 * stays where it is.
 */
import type { TaskKey } from '@brigadir/core';
import { navigate } from '../router';
import { seenFiles } from '../tools/Files';
import { keyOf } from '../tools/data';
import { linkPath, matchFile } from './link-path';

export function openChatLink(href: string, task: TaskKey) {
	if (/^(https?:|mailto:)/i.test(href.trim())) {
		window.open(href.trim(), '_blank', 'noopener,noreferrer');
		return;
	}
	const path = linkPath(href);
	if (!path) return;
	const name = path.split('/').at(-1) ?? path;
	void window.brigadir.searchFiles(keyOf(task), name).then(
		(result) => {
			const entry = matchFile(path, result.entries);
			if (!entry) return;
			if (!seenFiles.has(entry.id)) seenFiles.set(entry.id, { ...entry, parent: null });
			navigate({
				screen: 'tool',
				projectId: task.projectId,
				taskId: task.id,
				tool: 'file',
				item: entry.id,
			});
		},
		() => {}
	);
}
