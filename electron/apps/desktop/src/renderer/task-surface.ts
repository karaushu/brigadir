import {
	allGroupTabs,
	documentForFile,
	draftTextLimit,
	groupOf,
	holdWorkArea,
	isSurfacePath,
	MAIN_TREE_ID,
	openToolTab,
	restoreSurfaceGroups,
	surfaceGroups,
	surfaceTabs,
	withFocusedTabs,
	type DocumentTab,
	type EditorGroups,
	type SurfaceDraft,
	type SurfacePlace,
	type SurfaceTab,
	type TaskKey,
	type TaskSurface,
} from '@brigadir/core';
import type { StoreApi } from 'zustand';
import type { Text } from '@codemirror/state';
import { EditorModel } from './editor-model';
import type { EvictedEditor } from './editor-buffers';
import { useSurfaceLayout } from './surface-layout';
import type { TaskState } from './task-state';
/**
 * spec/task-window-workspace#restore-window: the task window on disk. Each task store the window holds writes its `surface.json` 500 ms after a change of what
 * it keeps (groups, tabs, columns, widths, the panel, Tools' place) and at once when main asks before the window closes; a
 * hot exit also writes the unsaved buffers to `drafts/`. A task reads its file when its store is made — the task the app
 * opens on, or one the person or an agent opens later — and writes nothing until that read is done.
 */
type Store = StoreApi<TaskState>;
type Apply = (groups: EditorGroups) => Partial<TaskState>;
/** The fields a surface is made of: only their change schedules a write. */
const persisted = [
	'editorGroups',
	'documents',
	'activeDocument',
	'chatShown',
	'workShown',
	'panelShown',
	'panel',
	'changesView',
	'toolPlace',
	'bottomUnderChat',
	'chatTab',
	'widths',
	'changeRange',
	'terminalRestored',
	'commitDiffs',
] as const satisfies readonly (keyof TaskState)[];
export const surfaceDelay = 500;

const line = (doc: Text, offset: number) => {
	const at = doc.lineAt(Math.min(offset, doc.length));
	return { line: at.number, column: offset - at.from };
};
function placeOf(
	model: EditorModel | undefined,
	evicted: EvictedEditor | undefined
): SurfacePlace | undefined {
	if (model) {
		const { anchor, head } = model.state.selection.main,
			doc = model.state.doc;
		return {
			anchor: line(doc, anchor),
			head: line(doc, head),
			scrollTop: Math.max(0, Math.round(model.scrollTop)),
			scrollLeft: Math.max(0, Math.round(model.scrollLeft)),
		};
	}
	return evicted
		? {
				anchor: evicted.anchor,
				head: evicted.head,
				scrollTop: Math.max(0, Math.round(evicted.scrollTop)),
				scrollLeft: Math.max(0, Math.round(evicted.scrollLeft)),
			}
		: undefined;
}
const sessionId = /^[a-zA-Z0-9-]{1,128}$/;
/** The tab as `surface.json` keeps it; a commit's or a PR's diff, a file outside the task and a plan copy are not kept. */
function tabOf(state: TaskState, tab: DocumentTab, places: boolean): SurfaceTab | null {
	switch (tab.kind) {
		case 'file': {
			const model = state.editorTabs.find((item) => item.document.id === tab.target),
				evicted = state.evictedEditors.get(tab.target),
				path = model?.document.path ?? evicted?.path ?? tab.path;
			if (!/^[a-f0-9]{64}$/.test(tab.target) || !isSurfacePath(path)) return null;
			const place = places ? placeOf(model, evicted) : undefined;
			return { kind: 'file', id: tab.target, path, ...(place ? { place } : {}) };
		}
		case 'diff': {
			if (state.commitDiffs[tab.target]) return null;
			const slash = tab.target.indexOf('/'),
				scope = tab.target.slice(0, slash),
				path = tab.target.slice(slash + 1);
			if (slash < 1 || scope.length > 256 || !isSurfacePath(path)) return null;
			return { kind: 'diff', scope, path, range: state.changeRange };
		}
		case 'terminal': {
			if (!sessionId.test(tab.target)) return null;
			const directory = state.terminalRestored[tab.target] ?? null;
			return {
				kind: 'terminal',
				session: tab.target,
				title: tab.path.slice(0, 512),
				directory: directory && isSurfacePath(directory) ? directory : null,
			};
		}
		case 'browser':
			return {
				kind: 'browser',
				tab: tab.target,
				title: tab.path.slice(0, 1024),
				url: '',
				mobile: false,
			};
		case 'simulator':
			return { kind: 'simulator', title: tab.path.slice(0, 512), device: null };
	}
}
/** The surface of the task's state now; `places` adds each file tab's caret and scroll (written at the close). */
export function surfaceOf(state: TaskState, places = false): TaskSurface {
	const defaults = useSurfaceLayout.getState().layout,
		groups = withFocusedTabs(state.editorGroups, state);
	return {
		groups: surfaceGroups(groups, (tab) => tabOf(state, tab, places)),
		columns: { chat: state.chatShown, work: state.workShown, panel: state.panelShown },
		widths: {
			chat: Math.round(state.widths.chatWidth ?? defaults.chatWidth),
			panel: Math.round(state.widths.changesWidth ?? defaults.changesWidth),
			bottom: Math.round(state.widths.consoleHeight ?? defaults.consoleHeight),
		},
		panel: { tab: state.panel, mode: state.changesView },
		toolPlace: state.toolPlace,
		bottomUnderChat: state.bottomUnderChat,
		chatTab: state.chatTab,
	};
}
/**
 * The task's state with its stored surface. A tab the window already holds and the file does not (an agent opened it while
 * the file was read) joins the focused group; a stored file tab waits as an evicted buffer and reads its file when shown.
 */
export function restoredState(
	state: TaskState,
	surface: TaskSurface,
	apply: Apply
): Partial<TaskState> {
	let groups = restoreSurfaceGroups(surface.groups);
	// spec/task-window-workspace#empty-work-area: the group under the chat kept the work area's place as an empty group; the restore drops empty groups.
	const stored = surface.groups.root;
	if (
		surface.bottomUnderChat &&
		stored.kind === 'split' &&
		stored.direction === 'down' &&
		stored.second.kind === 'group' &&
		groups.root.kind === 'group' &&
		groups.root.id === stored.second.id
	)
		groups = holdWorkArea(groups, stored.ratio);
	for (const tab of allGroupTabs(withFocusedTabs(state.editorGroups, state)))
		if (!groupOf(groups, tab.id)) groups = openToolTab(groups, tab, 'focused', true);
	const evictedEditors = new Map(state.evictedEditors),
		terminalRestored = { ...state.terminalRestored },
		storedTabs = surfaceTabs(surface);
	for (const tab of storedTabs) {
		if (
			tab.kind === 'file' &&
			tab.id &&
			!state.editorTabs.some((model) => model.document.id === tab.id)
		)
			evictedEditors.set(tab.id, {
				path: tab.path,
				anchor: tab.place?.anchor ?? { line: 1, column: 0 },
				head: tab.place?.head ?? { line: 1, column: 0 },
				scrollTop: tab.place?.scrollTop ?? 0,
				scrollLeft: tab.place?.scrollLeft ?? 0,
				conflict: false,
			});
		if (tab.kind === 'terminal') terminalRestored[tab.session] = tab.directory;
	}
	const range = storedTabs.find(
		(tab): tab is Extract<SurfaceTab, { kind: 'diff' }> => tab.kind === 'diff' && tab.range !== null
	)?.range;
	return {
		...apply(groups),
		evictedEditors,
		terminalRestored,
		chatShown: surface.columns.chat,
		workShown: surface.columns.work,
		panelShown: surface.columns.panel,
		widths: {
			chatWidth: surface.widths.chat,
			changesWidth: surface.widths.panel,
			consoleHeight: surface.widths.bottom,
		},
		panel: surface.panel.tab,
		changesView: surface.panel.mode,
		toolPlace: surface.toolPlace,
		bottomUnderChat: surface.bottomUnderChat,
		chatTab: surface.chatTab ?? true,
		...(range ? { changeRange: range } : {}),
	};
}
/** spec/task-window-workspace#restore-window: the unsaved buffers a hot exit keeps — text files of the task, dirty, within the editor's limit. */
export function draftsOf(state: TaskState): SurfaceDraft[] {
	return state.editorTabs.flatMap((model) => {
		const document = model.document;
		if (
			!model.dirty ||
			document.state !== 'text' ||
			document.readOnly ||
			!isSurfacePath(document.path) ||
			!/^[a-f0-9]{64}$/.test(document.version) ||
			model.state.doc.length > draftTextLimit
		)
			return [];
		return [{ path: document.path, id: document.id, version: document.version, ...model.draft() }];
	});
}
type Tracked = {
	task: TaskKey;
	store: Store;
	timer: ReturnType<typeof setTimeout> | undefined;
	ready: boolean;
	written: string | null;
	unsubscribe: () => void;
};
const tracked = new Map<string, Tracked>();
type SurfaceRead = Awaited<ReturnType<typeof window.brigadir.readSurface>>;
/**
 * spec/task-window-workspace#restore-window: a surface read before its task's store exists — the task the app opens on. The store
 * made after it takes the read synchronously, so the task view's first frame is already the restored one. A read nobody
 * took still holds the task's unsaved buffers (main took them off the disk): a close writes them back.
 */
type Preloaded = {
	task: TaskKey;
	read: SurfaceRead | null;
	done: boolean;
	promise: Promise<SurfaceRead | null>;
};
const preloaded = new Map<string, Preloaded>();
const keyOf = (task: TaskKey) => `${task.projectId}/${task.id}`;
async function readWithRetries(task: TaskKey, alive: () => boolean = () => true) {
	let read: SurfaceRead | null = null;
	for (let attempt = 0; attempt < 3 && !read; attempt++) {
		if (attempt) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
		if (!alive()) return null;
		read = await window.brigadir.readSurface(task).catch(() => null);
	}
	return read;
}
/** Reads the task's surface ahead of its store (once); resolves when the read is in, at most after `timeout` ms. */
export function preloadSurface(task: TaskKey, timeout = 1500): Promise<void> {
	if (task.id === MAIN_TREE_ID || typeof window === 'undefined' || !window.brigadir?.readSurface)
		return Promise.resolve();
	const key = keyOf(task);
	if (tracked.has(key)) return Promise.resolve();
	let entry = preloaded.get(key);
	if (!entry) {
		const made: Preloaded = {
			task: { projectId: task.projectId, id: task.id },
			read: null,
			done: false,
			promise: Promise.resolve(null),
		};
		made.promise = readWithRetries(made.task).then((read) => {
			made.read = read;
			made.done = true;
			return read;
		});
		preloaded.set(key, made);
		entry = made;
		listen();
	}
	return Promise.race([
		entry.promise.then(() => {}),
		new Promise<void>((resolve) => setTimeout(resolve, timeout)),
	]);
}
let listening = false;
function listen() {
	if (listening || typeof window === 'undefined' || !window.brigadir?.onSurfaceFlush) return;
	listening = true;
	window.brigadir.onSurfaceFlush(({ id, drafts }) => {
		void flushSurfaces(drafts).finally(() => {
			void window.brigadir.surfaceFlushed(id).catch(() => {});
		});
	});
}
async function write(entry: Tracked, places = false) {
	clearTimeout(entry.timer);
	entry.timer = undefined;
	if (!entry.ready) return;
	const state = entry.store.getState(),
		signature = JSON.stringify(surfaceOf(state));
	if (!places && signature === entry.written) return;
	entry.written = signature;
	await window.brigadir.writeSurface(entry.task, surfaceOf(state, places)).catch(() => {
		entry.written = null;
	});
}
function schedule(entry: Tracked) {
	if (!entry.ready) return;
	clearTimeout(entry.timer);
	entry.timer = setTimeout(() => void write(entry), surfaceDelay);
}
/** A buffer of a hot exit back in its tab: the same text, caret and undo, dirty against the disk it was based on. */
async function restoreDraft(entry: Tracked, draft: SurfaceDraft, apply: Apply) {
	const id = draft.id;
	if (!id) return;
	const document = await window.brigadir.readEditorFile(entry.task, id).catch(() => null);
	if (!document || document.state !== 'text') return;
	// The disk moved on meanwhile: the buffer keeps its old base, so Save meets the write conflict of spec/editor#files-and-save.
	const model = new EditorModel(
		document.version === draft.version ? document : { ...document, version: draft.version },
		draft
	);
	entry.store.setState((state) => {
		const evictedEditors = new Map(state.evictedEditors);
		evictedEditors.delete(id);
		const groups = withFocusedTabs(state.editorGroups, state),
			tab = documentForFile(id, document.path);
		return {
			editorTabs: [...state.editorTabs.filter((item) => item.document.id !== id), model],
			evictedEditors,
			...(groupOf(groups, tab.id) ? {} : apply(openToolTab(groups, tab, 'focused', true))),
		};
	});
	await window.brigadir.setEditorDirty(entry.task, id, true).catch(() => {});
}
/** Reads the task's surface into its new store and keeps writing it; the main tree has no task folder, so it is not kept. */
export function trackSurface(task: TaskKey, store: Store, apply: Apply) {
	if (task.id === MAIN_TREE_ID || typeof window === 'undefined' || !window.brigadir?.readSurface)
		return;
	listen();
	const key = `${task.projectId}/${task.id}`;
	tracked.get(key)?.unsubscribe();
	const entry: Tracked = {
		task: { projectId: task.projectId, id: task.id },
		store,
		timer: undefined,
		ready: false,
		written: null,
		unsubscribe: () => {},
	};
	tracked.set(key, entry);
	entry.unsubscribe = store.subscribe((state, previous) => {
		if (persisted.some((field) => state[field] !== previous[field])) schedule(entry);
	});
	// spec/task-window-workspace#restore-window: a surface read ahead is applied now, before the task view's first render.
	const ahead = preloaded.get(key);
	preloaded.delete(key);
	if (ahead?.done && ahead.read?.surface) {
		const surface = ahead.read.surface;
		store.setState((state) => restoredState(state, surface, apply));
	}
	void (async () => {
		const read = ahead
			? ahead.done
				? ahead.read
				: await ahead.promise
			: await readWithRetries(entry.task, () => tracked.get(key) === entry);
		// Unreadable: the task works from its defaults and never writes over the file it could not read.
		if (!read) return;
		if (tracked.get(key) !== entry) return;
		const surface = read.surface;
		if (surface && !ahead?.done) store.setState((state) => restoredState(state, surface, apply));
		for (const draft of read.drafts) await restoreDraft(entry, draft, apply);
		entry.ready = true;
		entry.written = JSON.stringify(surfaceOf(store.getState()));
	})();
}
/** The store leaves the window (its slot went to a newer task): its surface is written first. */
export async function untrackSurface(key: string) {
	const entry = tracked.get(key);
	if (!entry) return;
	tracked.delete(key);
	entry.unsubscribe();
	await write(entry, true);
}
/** Every task's surface now, with the carets and scrolls; `drafts` — a hot exit, the unsaved buffers too. */
export async function flushSurfaces(drafts: boolean) {
	// A surface read ahead for a task the window never showed: its unsaved buffers go back to the disk as they came.
	const unclaimed = drafts
		? [...preloaded.values()].map(async (entry) => {
				const read = entry.done ? entry.read : await entry.promise;
				if (read?.drafts.length && preloaded.get(keyOf(entry.task)) === entry)
					await window.brigadir.writeSurfaceDrafts(entry.task, read.drafts).catch(() => {});
			})
		: [];
	await Promise.all([
		...unclaimed,
		...[...tracked.values()]
			.filter((entry) => entry.ready)
			.map(async (entry) => {
				await write(entry, true);
				if (drafts)
					await window.brigadir
						.writeSurfaceDrafts(entry.task, draftsOf(entry.store.getState()))
						.catch(() => {});
			}),
	]);
}
