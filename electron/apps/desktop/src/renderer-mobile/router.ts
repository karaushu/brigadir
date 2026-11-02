/**
 * spec/remote-access-and-mobile#phone-app: the stack in the browser's history — the only way the system «back» (the iOS edge swipe, Android's back)
 * reaches a web app. A screen is `#/`, `#/p/<project>`, `#/t/<project>/<task>` and the task's tools under it (spec/remote-access-and-mobile#phone-task-tools):
 * `/changes[/<file>]`, `/pr`, `/files[/<folder>]`, `/file/<file>`, `/terminal` — a file or a folder only by the opaque id main
 * gave it, never a path. A project's PR segment is `#/p/<project>/pr`, a PR from its list `#/p/<project>/pr/<repo>/<number>`
 * (spec/remote-access-and-mobile#phone-pr-list). An open sheet is one more entry with the same address, so «back» closes it first.
 */
import { useSyncExternalStore } from 'react';

export type Tool = 'changes' | 'pr' | 'files' | 'file' | 'terminal';
export type Route =
	| { screen: 'home' }
	/** spec/remote-access-and-mobile#phone-pr-list: `pr` — the project's PR segment; the tasks' segment has no part of its own. */
	| { screen: 'project'; projectId: string; tab?: 'pr' }
	/** spec/remote-access-and-mobile#phone-pr-list: a PR from the project's list, in the main tree's context — the repo's opaque id and the number. */
	| { screen: 'pr'; projectId: string; scopeId: string; number: number }
	| { screen: 'task'; projectId: string; taskId: string }
	| { screen: 'tool'; projectId: string; taskId: string; tool: Tool; item?: string };
export type Sheet =
	| { kind: 'filter' }
	| { kind: 'machine' }
	| { kind: 'theme' }
	| { kind: 'quota' }
	| { kind: 'menu' }
	| { kind: 'limit' }
	| { kind: 'model' }
	| { kind: 'new'; projectId: string | null }
	| { kind: 'agent'; planId: string; partId: string }
	| { kind: 'dialog'; id: number }
	| { kind: 'menu-remote'; id: number }
	| { kind: 'review' }
	| { kind: 'merge' }
	| { kind: 'file-actions' }
	/** spec/remote-access-and-mobile#phone-pr-list: the PR list's repo picker, a PR's «Ревʼю з агентом» and «Розвести конфлікт», a board move to confirm. */
	| { kind: 'repo' }
	| { kind: 'pr-agent'; mode: 'review' | 'conflict' }
	| { kind: 'move'; taskId: string; column: 'backlog' | 'progress' | 'completed' };
/** `under`: the screen «back» returns to, so the back button names where it goes (a task opened from the home says «Проєкти»). */
type Entry = { route: Route; sheet: Sheet | null; under?: Route };

const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const tools: readonly Tool[] = ['changes', 'pr', 'files', 'file', 'terminal'];
/** Main's file and folder ids: a sha256 in hex (core `isFileId`). */
const item = /^[a-f0-9]{64}$/;
/** A broken escape (`%E0`, from any link) is no id: the address opens the home instead of throwing (security review W2). */
const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return '';
	}
};
/** A PR's number as GitHub gives it: a positive integer, no leading zero. */
const prNumber = /^[1-9][0-9]{0,9}$/;
export function parseRoute(hash: string): Route {
	const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decode);
	if (parts[0] === 'p' && id.test(parts[1] ?? '')) {
		if (parts[2] === 'pr' && id.test(parts[3] ?? '') && prNumber.test(parts[4] ?? ''))
			return {
				screen: 'pr',
				projectId: parts[1]!,
				scopeId: parts[3]!,
				number: Number(parts[4]),
			};
		return parts[2] === 'pr'
			? { screen: 'project', projectId: parts[1]!, tab: 'pr' }
			: { screen: 'project', projectId: parts[1]! };
	}
	if (parts[0] === 't' && id.test(parts[1] ?? '') && id.test(parts[2] ?? '')) {
		const tool = parts[3] as Tool | undefined,
			id = parts[4];
		if (!tool || !tools.includes(tool) || (tool === 'file' && !item.test(id ?? '')))
			return { screen: 'task', projectId: parts[1]!, taskId: parts[2]! };
		return {
			screen: 'tool',
			projectId: parts[1]!,
			taskId: parts[2]!,
			tool,
			...(id && item.test(id) && tool !== 'pr' && tool !== 'terminal' ? { item: id } : {}),
		};
	}
	return { screen: 'home' };
}
export function routeHash(route: Route): string {
	switch (route.screen) {
		case 'home':
			return '#/';
		case 'project':
			return `#/p/${route.projectId}${route.tab ? `/${route.tab}` : ''}`;
		case 'pr':
			return `#/p/${route.projectId}/pr/${route.scopeId}/${route.number}`;
		case 'task':
			return `#/t/${route.projectId}/${route.taskId}`;
		case 'tool':
			return `#/t/${route.projectId}/${route.taskId}/${route.tool}${route.item ? `/${route.item}` : ''}`;
	}
}
const listeners = new Set<() => void>();
let current: Entry = { route: parseRoute(location.hash), sheet: null };
const isEntry = (value: unknown): value is Entry =>
	typeof value === 'object' && value !== null && 'route' in value && 'sheet' in value;
function publish(entry: Entry) {
	current = entry;
	for (const listener of [...listeners]) listener();
}
let started = false;
/** The first entry: the address the page was opened at (a deep link stays), with a home under it for «back». */
export function startRouter() {
	if (started) return;
	started = true;
	const route = parseRoute(location.hash);
	const home: Route = { screen: 'home' };
	if (route.screen !== 'home') {
		history.replaceState({ route: home, sheet: null } satisfies Entry, '', '#/');
		history.pushState({ route, sheet: null, under: home } satisfies Entry, '', routeHash(route));
	} else history.replaceState({ route, sheet: null } satisfies Entry, '', '#/');
	publish(route.screen === 'home' ? { route, sheet: null } : { route, sheet: null, under: home });
	addEventListener('popstate', (event) => {
		publish(isEntry(event.state) ? event.state : { route: parseRoute(location.hash), sheet: null });
	});
}
export function navigate(route: Route) {
	// Over a sheet or not, the entry under the new screen is the current one.
	const entry: Entry = { route, sheet: null, under: current.route };
	// A sheet that leads to another screen (the task menu → Changes) leaves its own entry behind: replace it.
	if (current.sheet) history.replaceState(entry, '', routeHash(route));
	else history.pushState(entry, '', routeHash(route));
	publish(entry);
}
export function openSheet(sheet: Sheet) {
	const entry: Entry = {
		route: current.route,
		sheet,
		...(current.under ? { under: current.under } : {}),
	};
	if (current.sheet) history.replaceState(entry, '', routeHash(current.route));
	else history.pushState(entry, '', routeHash(current.route));
	publish(entry);
}
/** The same screen with another item (the next file of the diff): the entry is replaced, «back» still goes to the list. */
export function replaceRoute(route: Route) {
	const entry: Entry = { route, sheet: null, ...(current.under ? { under: current.under } : {}) };
	history.replaceState(entry, '', routeHash(route));
	publish(entry);
}
/** ×, a swipe down, Esc and the system «back» all close a sheet the same way. */
export function back() {
	history.back();
}
export function closeSheet() {
	if (current.sheet) history.back();
}
export function useRouter(): Entry {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current
	);
}
