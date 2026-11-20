import { merge3, mergeLines, mergeText, myersWork, sequenceDiff } from '@brigadir/diff';

/**
 * spec/notifications-slack-notes-and-schedules#note-concurrent: the editor's text (`ours`, edited from `base`) over the file as it is now
 * (`disk`, changed since by a Slack append, the note chat's agent or another window). Each side's change applies; where both
 * touch the same lines the person's lines stay and the other side's new lines follow them, so nothing either side wrote is
 * lost.
 */
export function mergeNoteText(base: string, ours: string, disk: string): string {
	if (disk === base || disk === ours) return ours;
	if (ours === base) return disk;
	const merge = merge3(mergeLines(base), mergeLines(ours), mergeLines(disk)),
		lines: string[] = [];
	let at = 0;
	for (const chunk of merge.chunks) {
		lines.push(...merge.base.slice(at, chunk.base.start));
		const own = merge.ours.slice(chunk.ours.start, chunk.ours.end),
			theirs = merge.theirs.slice(chunk.theirs.start, chunk.theirs.end);
		if (chunk.kind === 'theirs') lines.push(...theirs);
		else if (chunk.kind !== 'conflict') lines.push(...own);
		else {
			// The other side's own additions within the chunk (against the base, not the person's text: a line both sides
			// added stays twice, each in its own place).
			const added = sequenceDiff(
				merge.base.slice(chunk.base.start, chunk.base.end),
				theirs,
				250000,
				myersWork
			).flatMap((edit) => (edit.kind === 'added' ? [edit.value] : []));
			lines.push(...own, ...added);
		}
		at = chunk.base.end;
	}
	lines.push(...merge.base.slice(at));
	return mergeText(lines, ours.endsWith('\n') || (ours === '' && disk.endsWith('\n')));
}
