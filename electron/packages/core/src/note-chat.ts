import type { AgentEvent, AgentProvider, ToolPatch } from './agent';
/**
 * spec/notifications-slack-notes-and-schedules#notes: the chat of a note — one per note, kept in `notes/<id>.chat.jsonl`. Rows are the person's messages,
 * the agent's normalized events of each answer (rule 2), the agent's edits of the note with their text before and after
 * (for Undo), the person's edits between messages, and the end of each answer.
 */
export type NoteChatEntry =
	| { kind: 'prompt'; text: string; note: string; choice?: NoteChatChoice }
	| { kind: 'event'; event: AgentEvent }
	| { kind: 'edit'; before: string; after: string; added: number; removed: number }
	| { kind: 'undo'; of: number }
	| { kind: 'person-edit'; added: number; removed: number }
	| { kind: 'done'; milliseconds: number; stopped: boolean }
	| { kind: 'failed'; message: string };
export type NoteChatRow = { seq: number; at: string } & NoteChatEntry;
export type NoteChatChoice = { provider: AgentProvider; model: string | null };
export type NoteChatState = { rows: NoteChatRow[]; busy: boolean; choice: NoteChatChoice | null };
export type NoteChatEvent = { id: string } & ({ row: NoteChatRow } | { busy: boolean });
export const noteChatLimits = { message: 20_000 } as const;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
export function isNoteChatRow(value: unknown): value is NoteChatRow {
	if (!record(value) || !Number.isSafeInteger(value.seq) || typeof value.at !== 'string')
		return false;
	switch (value.kind) {
		case 'prompt':
			return typeof value.text === 'string' && typeof value.note === 'string';
		case 'event':
			return record(value.event) && typeof value.event.kind === 'string';
		case 'edit':
			return typeof value.before === 'string' && typeof value.after === 'string';
		case 'undo':
			return Number.isSafeInteger(value.of);
		case 'person-edit':
			return Number.isSafeInteger(value.added) && Number.isSafeInteger(value.removed);
		case 'done':
			return typeof value.milliseconds === 'number' && typeof value.stopped === 'boolean';
		case 'failed':
			return typeof value.message === 'string';
		default:
			return false;
	}
}
/** Lines added and removed between two texts: the lines of each that the other lacks, counted as a multiset. */
export function noteLineDelta(before: string, after: string) {
	const count = (text: string) => {
		const map = new Map<string, number>();
		for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
		return map;
	};
	const a = count(before),
		b = count(after);
	let added = 0,
		removed = 0;
	for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
	for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
	return { added, removed };
}
/** The text the note last had in this chat — at the last message or after the agent's last edit; undefined — none yet. */
export function lastSeenNote(rows: readonly NoteChatRow[]): string | undefined {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i]!;
		if (row.kind === 'prompt') return row.note;
		if (row.kind === 'edit') return row.after;
		if (row.kind === 'undo') {
			const edit = rows.find((item) => item.seq === row.of);
			if (edit?.kind === 'edit') return edit.before;
		}
	}
	return undefined;
}
/** The newest Undo that may still run: the agent's last edit not undone yet, when the note still holds its text. */
export function undoableEdit(rows: readonly NoteChatRow[], current: string) {
	const undone = new Set(rows.flatMap((row) => (row.kind === 'undo' ? [row.of] : [])));
	const edit = rows.findLast((row) => row.kind === 'edit' && !undone.has(row.seq));
	return edit?.kind === 'edit' && edit.after === current ? edit.seq : null;
}
/** Rule 12: the agent reads English. The note's text comes with every message — it may change between them. */
export function noteChatPrompt(input: {
	text: string;
	note: string;
	file: string;
	project: string | null;
	first: boolean;
}) {
	return [
		input.first
			? `You are chatting with the person about one Markdown note, the file ${input.file}. ` +
				(input.project
					? `The note belongs to the project in your working directory: read its files when that helps, but do not change them. `
					: `The note has no project: work only with this note. `) +
				`When the person asks you to change the note, edit that file with your edit tool; change no other file. ` +
				`Keep the note's language and Markdown. Answer in the language the person writes in. ` +
				`When you name lines of the note, write them as L5 or L5-7 (1-based, as in the note above).`
			: `The same note, ${input.file}.`,
		'',
		'The note as it is now:',
		'<note>',
		input.note,
		'</note>',
		'',
		'The person writes:',
		input.text,
	].join('\n');
}
/** The paths an edit tool names, absolute. */
export function toolPaths(tool: Pick<ToolPatch, 'locations' | 'content'>): string[] {
	return [
		...(tool.locations ?? []).map((location) => location.path),
		...(tool.content ?? []).flatMap((content) => (content.kind === 'diff' ? [content.path] : [])),
	].filter((path): path is string => typeof path === 'string' && path.length > 0);
}
