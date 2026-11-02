import type { FilePathLink, FilePathText, TaskKey } from '@brigadir/core';
/** spec/diff-and-review#scope-kinds: link requests go one at a time. A long transcript mounts dozens of blocks at once, and main's bounded queue
 *  (12) rejected the rest, leaving their paths unlinked; a block that unmounts before its turn sends nothing. */
let tail: Promise<unknown> = Promise.resolve();
export function readFileLinksQueued(
	task: TaskKey,
	texts: FilePathText[],
	active: () => boolean
): Promise<FilePathLink[][] | null> {
	const next = tail
		.catch(() => {})
		.then(() => (active() ? window.brigadir.readFileLinks(task, texts) : null));
	tail = next;
	return next;
}
