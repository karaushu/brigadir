import { isId, isRecord } from './workspace';
/**
 * spec/notifications-slack-notes-and-schedules#notes: a note is a plain Markdown file in `~/.brigadir/notes/<id>.md`; beside it `<id>.json` keeps what the file does
 * not — its project (or none), the tasks made from it and the agent session of its chat. The id never changes: the title
 * is the note's first heading and may change with every edit.
 */
export type NoteTaskLink = { taskId: string; projectId: string };
export type NoteMeta = {
	schemaVersion: 1;
	project: string | null;
	createdAt: string;
	tasks: NoteTaskLink[];
};
/** One row of the notes list. `title` is empty when the note has no text yet — the UI shows `Untitled note`. */
export type NoteSummary = {
	id: string;
	title: string;
	project: string | null;
	updatedAt: string;
	tasks: number;
	/** The tasks made from the note, `<projectId>/<taskId>`: a task shows «From the note» by them (spec/notifications-slack-notes-and-schedules#notes). */
	taskKeys: string[];
};
export type NoteDocument = NoteSummary & { text: string };
/** What changed, so a window re-reads the list or the one note it shows. `id` null — the list as a whole. */
export type NotesChange = { id: string | null; kind: 'created' | 'written' | 'deleted' | 'meta' };
/** Notes stay small: the agent gets the whole text with each message (spec/notifications-slack-notes-and-schedules#notes). */
export const noteMaxBytes = 512 * 1024;
export const isNoteId = (value: unknown): value is string =>
	isId(value) && String(value).startsWith('note-');
export function newNoteId(now = Date.now(), random = Math.random) {
	return `note-${now.toString(36)}${Math.floor(random() * 36 ** 4)
		.toString(36)
		.padStart(4, '0')}`;
}
/** The first Markdown heading, else the first line with text; without Markdown marks, at most 120 characters. */
export function noteTitle(text: string): string {
	const lines = text.split('\n').map((line) => line.trim());
	const line = lines.find((l) => /^#{1,6}\s+\S/.test(l)) ?? lines.find((l) => l.length > 0) ?? '';
	const plain = line
		.replace(/^#{1,6}\s+/, '')
		.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
		.replace(/[*_`]/g, '')
		.trim();
	return plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
}
export function isNoteTaskLink(value: unknown): value is NoteTaskLink {
	return isRecord(value) && isId(value.taskId) && isId(value.projectId);
}
export function isNoteMeta(value: unknown): value is NoteMeta {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		(value.project === null || isId(value.project)) &&
		typeof value.createdAt === 'string' &&
		Array.isArray(value.tasks) &&
		value.tasks.every(isNoteTaskLink)
	);
}
/** Characters, not bytes: core has no encoder, and the store checks bytes on write. */
export const isNoteText = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= noteMaxBytes;
/**
 * spec/notifications-slack-notes-and-schedules#notes: the link back is plain Markdown in the note — `→ [<task title>](brigadir://task/<project>/<task>)` on its
 * own line; the editor and the preview draw it as a chip with the task's live state.
 */
export function noteTaskLine(title: string, projectId: string, taskId: string) {
	const text = title.replace(/[[\]\n\r]/g, ' ').trim() || taskId;
	return `→ [${text}](brigadir://task/${projectId}/${taskId})`;
}
export const noteTaskLinkPattern =
	/→ \[([^\]\n]*)\]\(brigadir:\/\/task\/([a-zA-Z0-9][\w-]{0,127})\/([a-zA-Z0-9][\w-]{0,127})\)/g;
/** The text with the link put under line `after` (1-based; past the end or null — at the end). */
export function withNoteTaskLine(text: string, line: string, after: number | null) {
	const lines = text.split('\n');
	const at = after === null ? lines.length : Math.min(Math.max(after, 0), lines.length);
	if (after === null && lines.at(-1) === '') lines.splice(lines.length - 1, 0, line);
	else lines.splice(at, 0, line);
	return lines.join('\n');
}
