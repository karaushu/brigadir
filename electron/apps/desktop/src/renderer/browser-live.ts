import { useSyncExternalStore } from 'react';
import type { TaskKey } from '@brigadir/core';
/** spec/browser-and-simulator#background: tasks whose browser page lives off screen while their agent works with it; main tells every change. */
let live = new Set<string>();
const listeners = new Set<() => void>();
const id = (key: TaskKey) => `${key.projectId}/${key.id}`;
function set(keys: TaskKey[]) {
	live = new Set(keys.map(id));
	for (const listener of listeners) listener();
}
let started = false;
function subscribe(listener: () => void) {
	if (!started) {
		started = true;
		window.brigadir.onBrowserLive(set);
		void window.brigadir.readBrowserLive().then(set, () => {});
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}
const still = () => () => {};
/** `listen` false (the intro's sample, spec/settings-modules-and-onboarding#intro-steps): no subscription to main, never live. */
export function useBrowserLive(key: TaskKey, listen = true) {
	const wanted = id(key);
	return useSyncExternalStore(listen ? subscribe : still, () => listen && live.has(wanted));
}
