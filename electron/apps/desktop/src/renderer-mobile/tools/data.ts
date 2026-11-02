/**
 * spec/remote-access-and-mobile#phone-task-tools: what the task's tools read from the machine, kept per task so the menu, the list and the diff share one read —
 * the change set (`readChanges`) and the forge state that links the task's PR (`readForge`).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ChangesSnapshot, ForgeSnapshot, TaskKey } from '@brigadir/core';
import { onSessionEvent } from '../../renderer/session-events';

type Entry<T> = { value: T | null; error: string | null; at: number };
type State = {
	changes: Record<string, Entry<ChangesSnapshot>>;
	forge: Record<string, Entry<ForgeSnapshot>>;
};
export const useTools = create<State>(() => ({ changes: {}, forge: {} }));
export const taskName = (key: TaskKey) => `${key.projectId}/${key.id}`;
/** A task as the machine's rows take it: its key alone, not the whole task over the wire. */
export const keyOf = (task: TaskKey): TaskKey => ({ projectId: task.projectId, id: task.id });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const flights = new Map<string, Promise<void>>();
function once(name: string, run: () => Promise<void>) {
	const running = flights.get(name);
	if (running) return running;
	const flight = run().finally(() => flights.delete(name));
	flights.set(name, flight);
	return flight;
}
export function loadChanges(key: TaskKey) {
	const name = taskName(key);
	return once(`changes:${name}`, async () => {
		try {
			const value = await window.brigadir.readChanges(keyOf(key));
			useTools.setState((state) => ({
				changes: { ...state.changes, [name]: { value, error: null, at: Date.now() } },
			}));
		} catch (error) {
			useTools.setState((state) => ({
				changes: {
					...state.changes,
					[name]: {
						value: state.changes[name]?.value ?? null,
						error: message(error),
						at: Date.now(),
					},
				},
			}));
		}
	});
}
/** `remote`: ask GitHub (the PR screen, as the computer's PR button); without it the machine's cached state (the menu). */
export function loadForge(key: TaskKey, remote: boolean) {
	const name = taskName(key);
	return once(`forge:${name}:${remote}`, async () => {
		try {
			const value = await window.brigadir.readForge(keyOf(key), remote, false);
			useTools.setState((state) => ({
				forge: { ...state.forge, [name]: { value, error: null, at: Date.now() } },
			}));
		} catch (error) {
			useTools.setState((state) => ({
				forge: {
					...state.forge,
					[name]: {
						value: state.forge[name]?.value ?? null,
						error: message(error),
						at: Date.now(),
					},
				},
			}));
		}
	});
}
/** The change set of a task, read on mount and again after the agent's edits (the same events the sidebar follows). */
export function useChanges(key: TaskKey): Entry<ChangesSnapshot> | undefined {
	const name = taskName(key);
	const entry = useTools((state) => state.changes[name]);
	useEffect(() => {
		void loadChanges(key);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ key: event, record }) => {
			if (event.projectId !== key.projectId || event.id !== key.id) return;
			if (record && record.event.kind !== 'tool.changed' && record.event.kind !== 'turn.completed')
				return;
			clearTimeout(timer);
			timer = setTimeout(() => void loadChanges(key), 1000);
		});
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [name]);
	return entry;
}
