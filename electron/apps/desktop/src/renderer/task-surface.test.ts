import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import {
	defaultSurfaceLayout,
	documentForBrowser,
	documentForDiff,
	documentForFile,
	documentForTerminal,
	focusedTabs,
	isSurfaceDraft,
	isTaskSurface,
	type EditorDocument,
	type EditorGroups,
} from '@brigadir/core';
import { EditorModel } from './editor-model';
import {
	draftsOf,
	flushSurfaces,
	preloadSurface,
	restoredState,
	surfaceOf,
	trackSurface,
} from './task-surface';
import type { TaskState } from './task-state';

const id = 'a'.repeat(64),
	version = 'b'.repeat(64);
const document = (text: string, at = version): EditorDocument => ({
	id,
	path: 'src/a.ts',
	text,
	version: at,
	lineEnding: '\n',
	mode: 0o644,
	locked: false,
	state: 'text',
	large: false,
});
const file = documentForFile(id, 'src/a.ts'),
	diff = documentForDiff('root/src/b.ts'),
	commit = documentForDiff('history:abc1234:root/src/c.ts'),
	terminal = documentForTerminal('6f1c2d4e-1111-2222-3333-444455556666', 'zsh'),
	page = documentForBrowser('bpage1', 'Person page');
const groups: EditorGroups = {
	root: {
		kind: 'split',
		id: 's3',
		direction: 'down',
		ratio: 0.55,
		first: { kind: 'group', id: 'g1', documents: [file, diff, commit], activeDocument: file.id },
		second: { kind: 'group', id: 'g2', documents: [terminal, page], activeDocument: page.id },
	},
	focused: 'g2',
	next: 4,
};
const apply = (next: EditorGroups): Partial<TaskState> => ({
	editorGroups: next,
	...focusedTabs(next),
});
/** The fields the window keeps per task in memory (task-state.ts) that the surface is made of. */
function state(overrides: Partial<TaskState> = {}): TaskState {
	return {
		editorGroups: groups,
		...focusedTabs(groups),
		editorTabs: [],
		evictedEditors: new Map(),
		commitDiffs: { [commit.target]: {} },
		changeRange: { base: 1, current: 3 },
		terminalRestored: {},
		chatShown: false,
		workShown: true,
		panelShown: true,
		widths: { chatWidth: 500 },
		panel: 'files',
		changesView: 'turns',
		toolPlace: 'bottom',
		bottomUnderChat: true,
		...overrides,
	} as unknown as TaskState;
}

describe('the task window in memory and in surface.json (spec/task-window-workspace#restore-window)', () => {
	it('moves from memory to the file and back: groups, tabs, columns, widths, the panel and Tools', () => {
		const model = new EditorModel(document('one\ntwo\nthree\n'));
		model.state = model.state.update({ selection: EditorSelection.cursor(6) }).state;
		model.scrollTop = 80;
		const before = state({ editorTabs: [model] }),
			surface = surfaceOf(before, true);
		expect(isTaskSurface(JSON.parse(JSON.stringify(surface)))).toBe(true);
		expect(surface.columns).toEqual({ chat: false, work: true, panel: true });
		// A width the task never set is the default of surface-layout.json.
		expect(surface.widths).toEqual({
			chat: 500,
			panel: defaultSurfaceLayout.changesWidth,
			bottom: defaultSurfaceLayout.consoleHeight,
		});
		expect(surface.panel).toEqual({ tab: 'files', mode: 'turns' });
		expect(surface.toolPlace).toBe('bottom');
		expect(surface.bottomUnderChat).toBe(true);
		const top = surface.groups.root.kind === 'split' ? surface.groups.root.first : null;
		// A commit's diff has no place in the file; the file tab keeps its caret and scroll.
		expect(top?.kind === 'group' && top.tabs).toEqual([
			{
				kind: 'file',
				id,
				path: 'src/a.ts',
				place: {
					anchor: { line: 2, column: 2 },
					head: { line: 2, column: 2 },
					scrollTop: 80,
					scrollLeft: 0,
				},
			},
			{ kind: 'diff', scope: 'root', path: 'src/b.ts', range: { base: 1, current: 3 } },
		]);
		// Back in a fresh window: the same tree, the file waiting as an evicted buffer at its place.
		const fresh = state({
			editorGroups: {
				root: { kind: 'group', id: 'g1', documents: [], activeDocument: null },
				focused: 'g1',
				next: 2,
			},
			documents: [],
			activeDocument: null,
			chatShown: true,
			widths: {},
			panel: 'changes',
			changesView: 'diff',
			toolPlace: 'focused',
			bottomUnderChat: false,
			changeRange: null,
			commitDiffs: {},
		});
		const after = restoredState(fresh, JSON.parse(JSON.stringify(surface)), apply);
		expect(after.editorGroups).toEqual({
			...groups,
			root: {
				...groups.root,
				first: { kind: 'group', id: 'g1', documents: [file, diff], activeDocument: file.id },
			},
		});
		expect(after).toMatchObject({
			chatShown: false,
			workShown: true,
			panelShown: true,
			widths: { chatWidth: 500, changesWidth: defaultSurfaceLayout.changesWidth },
			panel: 'files',
			changesView: 'turns',
			toolPlace: 'bottom',
			bottomUnderChat: true,
			changeRange: { base: 1, current: 3 },
			terminalRestored: { [terminal.target]: null },
		});
		expect(after.evictedEditors?.get(id)).toEqual({
			path: 'src/a.ts',
			anchor: { line: 2, column: 2 },
			head: { line: 2, column: 2 },
			scrollTop: 80,
			scrollLeft: 0,
			conflict: false,
		});
	});
	it('spec/task-window-workspace#two-columns: the pinned Chat tab of two columns survives a restart; an older file opens on the chat', () => {
		const surface = JSON.parse(JSON.stringify(surfaceOf(state({ chatTab: false }))));
		expect(surface.chatTab).toBe(false);
		expect(isTaskSurface(surface)).toBe(true);
		expect(restoredState(state(), surface, apply).chatTab).toBe(false);
		const { chatTab: _, ...older } = surface;
		expect(isTaskSurface(older)).toBe(true);
		expect(restoredState(state(), older, apply).chatTab).toBe(true);
		expect(isTaskSurface({ ...surface, chatTab: 'yes' })).toBe(false);
	});
	it('spec/task-window-workspace#empty-work-area: the group under the chat keeps the work area’s empty place across a restart', () => {
		const held: EditorGroups = {
			root: {
				kind: 'split',
				id: 's5',
				direction: 'down',
				ratio: 0.6,
				first: { kind: 'group', id: 'g4', documents: [], activeDocument: null },
				second: { kind: 'group', id: 'g2', documents: [terminal], activeDocument: terminal.id },
			},
			focused: 'g4',
			next: 6,
		};
		const surface = surfaceOf(
			state({
				editorGroups: held,
				...focusedTabs(held),
				chatShown: true,
				workShown: false,
				bottomUnderChat: true,
			})
		);
		const fresh = state({
			editorGroups: {
				root: { kind: 'group', id: 'g1', documents: [], activeDocument: null },
				focused: 'g1',
				next: 2,
			},
			documents: [],
			activeDocument: null,
		});
		const after = restoredState(fresh, JSON.parse(JSON.stringify(surface)), apply);
		const root = after.editorGroups!.root;
		expect(root.kind).toBe('split');
		if (root.kind !== 'split') return;
		expect(root).toMatchObject({ direction: 'down', ratio: 0.6 });
		expect(root.first).toMatchObject({ kind: 'group', documents: [] });
		expect(root.second).toMatchObject({ id: 'g2', documents: [terminal] });
		expect(after.editorGroups!.focused).toBe(root.first.id);
		// Not under the chat: the group comes back as the work area itself.
		const plain = restoredState(
			fresh,
			JSON.parse(JSON.stringify({ ...surface, bottomUnderChat: false })),
			apply
		);
		expect(plain.editorGroups!.root).toMatchObject({ kind: 'group', id: 'g2' });
	});
	it('a tab opened while the file was read stays, in the focused group', () => {
		const surface = surfaceOf(state());
		const agent = documentForBrowser('bagent', 'Agent page');
		const after = restoredState(
			state({
				editorGroups: {
					root: { kind: 'group', id: 'g1', documents: [agent], activeDocument: agent.id },
					focused: 'g1',
					next: 2,
				},
				documents: [agent],
				activeDocument: agent.id,
			}),
			surface,
			apply
		);
		expect(JSON.stringify(after.editorGroups)).toContain(agent.id);
		expect(after.activeDocument).toBe(page.id);
	});
	it('a hot exit keeps the unsaved text, the caret and the undo history of a buffer', () => {
		const model = new EditorModel(document('saved\n'));
		model.state = model.state.update({ changes: { from: 5, insert: ' and unsaved' } }).state;
		model.state = model.state.update({ selection: EditorSelection.cursor(3) }).state;
		model.scrollTop = 24;
		const clean = new EditorModel({ ...document('clean\n'), id: 'c'.repeat(64), path: 'src/c.ts' });
		const drafts = draftsOf(state({ editorTabs: [model, clean] }));
		expect(drafts).toHaveLength(1);
		const draft = JSON.parse(JSON.stringify(drafts[0]));
		expect(isSurfaceDraft(draft)).toBe(true);
		expect(draft).toMatchObject({ id, path: 'src/a.ts', version, scrollTop: 24 });
		// After the restart: the same text over the disk version, dirty, caret and undo back.
		const back = new EditorModel(document('saved\n'), draft);
		expect(back.text()).toBe('saved and unsaved\n');
		expect(back.dirty).toBe(true);
		expect(back.state.selection.main.head).toBe(3);
		expect(back.scrollTop).toBe(24);
		let undone = back.state;
		undo({ state: undone, dispatch: (tr) => (undone = tr.state) });
		expect(undone.sliceDoc()).toBe('saved\n');
		// The disk moved on meanwhile: the buffer is still dirty and keeps its old base version.
		const moved = new EditorModel(
			{ ...document('changed on disk\n', 'd'.repeat(64)), version },
			draft
		);
		expect(moved.text()).toBe('saved and unsaved\n');
		expect(moved.dirty).toBe(true);
		expect(moved.document.version).toBe(version);
	});
});
describe('a surface read ahead (spec/task-window-workspace#restore-window)', () => {
	afterEach(() => {
		delete (globalThis as { window?: unknown }).window;
	});
	function bridge(reads: Record<string, unknown>) {
		const drafts: [string, unknown[]][] = [];
		(globalThis as { window?: unknown }).window = {
			brigadir: {
				readSurface: async (key: { id: string }) => reads[key.id] ?? { surface: null, drafts: [] },
				writeSurface: async () => {},
				writeSurfaceDrafts: async (key: { id: string }, list: unknown[]) => {
					drafts.push([key.id, list]);
				},
				onSurfaceFlush: () => () => {},
				surfaceFlushed: async () => {},
				readEditorFile: async () => null,
				setEditorDirty: async () => {},
			},
		};
		return drafts;
	}
	it('the store made after the read has the restored layout before its first render', async () => {
		const surface = surfaceOf(state({ chatShown: true, panelShown: true, panel: 'files' }));
		bridge({ shown: { surface, drafts: [] } });
		await preloadSurface({ projectId: 'project', id: 'shown' });
		const store = createStore<TaskState>(() =>
			state({ chatShown: false, panelShown: false, panel: 'changes', widths: {} })
		);
		trackSurface({ projectId: 'project', id: 'shown' }, store, apply);
		// Synchronously: no frame of the default layout.
		expect(store.getState()).toMatchObject({
			chatShown: true,
			panelShown: true,
			panel: 'files',
			widths: { chatWidth: 500 },
		});
	});
	it('a read nobody took gives the unsaved buffers back to the disk when the window closes', async () => {
		const draft = {
			path: 'src/a.ts',
			id,
			version,
			state: { doc: 'x' },
			scrollTop: 0,
			scrollLeft: 0,
		};
		const written = bridge({ unseen: { surface: null, drafts: [draft] } });
		await preloadSurface({ projectId: 'project', id: 'unseen' });
		await flushSurfaces(false);
		expect(written.filter(([task]) => task === 'unseen')).toEqual([]);
		await flushSurfaces(true);
		expect(written.filter(([task]) => task === 'unseen')).toEqual([['unseen', [draft]]]);
	});
});
