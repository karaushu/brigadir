import { create } from 'zustand';
import {
	t,
	type BrowserAgentState,
	type BrowserAgentStep,
	type BrowserTabInfo,
	type Locale,
	type TaskKey,
} from '@brigadir/core';
import { useSecondTick } from './ui/second-tick';
/**
 * spec/task-window-workspace#work-area: what main says about each browser tab of each task, on screen or not — its name for the strip and the
 * Tools list, and the agent's state there. One subscription for the window.
 */
export const useBrowserTabs = create<{ tabs: Record<string, Record<string, BrowserTabInfo>> }>(
	() => ({ tabs: {} })
);
const taskKey = (key: TaskKey) => `${key.projectId}/${key.id}`;
/** spec/task-window-workspace#work-area: tabs the person just opened from Tools — their address takes the focus once (an agent's tab never does). */
export const freshBrowserTabs = new Set<string>();
let subscribed = false;
export function watchBrowserTabs() {
	if (subscribed || typeof window === 'undefined' || !window.brigadir?.onBrowserTab) return;
	subscribed = true;
	window.brigadir.onBrowserTab(({ key, info }) =>
		useBrowserTabs.setState((state) => ({
			tabs: {
				...state.tabs,
				[taskKey(key)]: { ...state.tabs[taskKey(key)], [info.tab]: info },
			},
		}))
	);
}
export function browserTabInfo(key: TaskKey, tab: string): BrowserTabInfo | undefined {
	return useBrowserTabs.getState().tabs[taskKey(key)]?.[tab];
}
export function useBrowserTab(key: TaskKey, tab: string) {
	return useBrowserTabs((state) => state.tabs[taskKey(key)]?.[tab]);
}
export function useTaskBrowserTabs(key: TaskKey) {
	return useBrowserTabs((state) => state.tabs[taskKey(key)]);
}
/** spec/task-window-workspace#work-area: the agent stays with a tab for 60 s after its last step (the page lives that long, spec/browser-and-simulator#background). */
export const agentLinger = 60_000;
export type AgentMark = 'acting' | 'waiting' | 'recent' | null;
export function agentMark(agent: BrowserAgentState | null | undefined, now: number): AgentMark {
	if (!agent) return null;
	if (agent.waiting) return 'waiting';
	if (agent.acting) return 'acting';
	return agent.last && now - agent.last < agentLinger ? 'recent' : null;
}
/** The mark of a tab, re-read every second while the agent's minute runs out. */
export function useAgentMark(agent: BrowserAgentState | null | undefined): AgentMark {
	const lingering = !!agent && !agent.acting && !agent.waiting && agent.last > 0;
	const now = useSecondTick(lingering);
	return agentMark(agent, lingering ? now : Date.now());
}
/** A host for a tab name: `localhost:5173`, `staging.example.com`; the title when the page has no address yet. */
export function browserTabName(info: BrowserTabInfo | undefined, fallback: string) {
	// A tab without a page is «New page», not `about:blank` (the title of a blank page is its address).
	if (!info || info.url === 'about:blank') return fallback;
	try {
		const url = new URL(info.url);
		if (url.protocol === 'http:' || url.protocol === 'https:') return url.host;
	} catch {
		/* about:blank and the like */
	}
	return info.title && info.title !== info.url ? info.title : fallback;
}
/** spec/task-window-workspace#tool-tab-look.1: the address field at rest shows a web address without its
 * scheme — `localhost:5173/loyalty`, and a bare host without the root `/`; the field being edited shows it whole. */
export function displayAddress(address: string): string {
	const match = /^https?:\/\/([^/?#]*)(.*)$/i.exec(address);
	if (!match) return address;
	const host = match[1] ?? '',
		rest = match[2] ?? '';
	return rest === '/' ? host : host + rest;
}
const quoted = (target: string | null) =>
	target ? `«${target.length > 40 ? `${target.slice(0, 39)}…` : target}»` : null;
/** spec/task-window-workspace#work-area: the agent's step in words — «clicks «Save»»; `next` — the step it waits to take. */
export function agentStepText(locale: Locale, step: BrowserAgentStep, next = false): string {
	const target = quoted(step.target) ?? t(locale, 'the page');
	const say = (key: Parameters<typeof t>[1], value: string, slot = '{target}') =>
		t(locale, key).replace(slot, value);
	switch (step.kind) {
		case 'click':
			return say(next ? 'will click {target}' : 'clicks {target}', target);
		case 'hover':
			return say(next ? 'will hover {target}' : 'hovers {target}', target);
		case 'type':
			return say(next ? 'will type into {target}' : 'types into {target}', target);
		case 'key':
			return say(next ? 'will press {key}' : 'presses {key}', step.target ?? '', '{key}');
		case 'scroll':
			return t(locale, next ? 'will scroll the page' : 'scrolls the page');
		case 'select':
			return say(next ? 'will select in {target}' : 'selects in {target}', target);
		case 'back':
			return t(locale, next ? 'will go back' : 'goes back');
		case 'forward':
			return t(locale, next ? 'will go forward' : 'goes forward');
		case 'reload':
			return t(locale, next ? 'will reload the page' : 'reloads the page');
		case 'open':
			return say('opens {url}', step.target ?? '', '{url}');
		case 'screenshot':
			return t(locale, 'takes a screenshot');
		case 'notifications':
			return t(
				locale,
				step.target === 'granted'
					? next
						? 'will allow notifications'
						: 'allows notifications'
					: step.target === 'denied'
						? next
							? 'will block notifications'
							: 'blocks notifications'
						: next
							? 'will reset notifications'
							: 'resets notifications'
			);
		default:
			return t(locale, 'reads the page');
	}
}
