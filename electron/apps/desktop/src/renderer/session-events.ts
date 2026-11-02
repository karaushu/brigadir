import type { EventRecord, TaskKey } from '@brigadir/core';
type Listener = (value: { key: TaskKey; record: EventRecord | null }) => void;
const listeners = new Set<Listener>();
let stop: (() => void) | null = null;
/**
 * One bridge subscription for the whole renderer: each record crosses the context bridge once and fans out here,
 * instead of being cloned for every component that listens (perf review IPC-03). A throwing listener does not
 * starve the others; its error still surfaces.
 */
export function onSessionEvent(listener: Listener) {
	listeners.add(listener);
	if (!stop)
		stop = window.brigadir.onSessionEvent((value) => {
			for (const each of [...listeners]) {
				try {
					each(value);
				} catch (error) {
					queueMicrotask(() => {
						throw error;
					});
				}
			}
		});
	return () => {
		listeners.delete(listener);
		if (!listeners.size && stop) {
			stop();
			stop = null;
		}
	};
}
