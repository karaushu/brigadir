import { useSyncExternalStore } from 'react';
import type { NoteSummary } from '@brigadir/core';
/**
 * spec/notifications-slack-notes-and-schedules#notes: one shared list of notes for the places that only look a task up (its «From the note» link): read once,
 * kept fresh by `notes:changed`, dropped when nobody looks.
 */
let notes: readonly NoteSummary[] = [];
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
const read = () =>
	window.brigadir.listNotes().then(
		(list) => {
			notes = list;
			for (const listener of listeners) listener();
		},
		() => {}
	);
function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!off) {
		off = window.brigadir.onNotesChanged(() => void read());
		void read();
	}
	return () => {
		listeners.delete(listener);
		if (!listeners.size) {
			off?.();
			off = null;
		}
	};
}
const empty: readonly NoteSummary[] = [];
const noop = () => () => {};
/** The note a task was made from, or null. */
export function useNoteOfTask(projectId: string, taskId: string, enabled: boolean) {
	const list = useSyncExternalStore(enabled ? subscribe : noop, () => (enabled ? notes : empty));
	const key = `${projectId}/${taskId}`;
	return list.find((note) => note.taskKeys.includes(key)) ?? null;
}
