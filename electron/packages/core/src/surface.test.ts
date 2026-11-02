import { describe, expect, it } from 'vitest';
import {
	documentForBrowser,
	documentForDiff,
	documentForFile,
	documentForTerminal,
	type DocumentTab,
} from './document-tabs';
import { replaceTab, type EditorGroups } from './editor-groups';
import {
	fitWindowBounds,
	isTaskSurface,
	mapSurfaceTabs,
	readSurfaceDocument,
	restoreSurfaceGroups,
	surfaceGroups,
	surfaceSchemaVersion,
	surfaceTabs,
	surfaceVersionOf,
	type SurfaceTab,
	type TaskSurface,
} from './surface';

const fileId = 'a'.repeat(64);
const file = documentForFile(fileId, 'src/a.ts'),
	diff = documentForDiff('root/src/b.ts'),
	terminal = documentForTerminal('6f1c2d4e-1111-2222-3333-444455556666', 'zsh'),
	browser = documentForBrowser('bpage1', 'Person page'),
	other = documentForBrowser('bpage2', 'Agent page');
/** Two groups: a file and a diff on top, a terminal and two browsers in the bottom group (the second page active). */
function twoGroups(): EditorGroups {
	return {
		root: {
			kind: 'split',
			id: 's3',
			direction: 'down',
			ratio: 0.6,
			first: { kind: 'group', id: 'g1', documents: [file, diff], activeDocument: diff.id },
			second: {
				kind: 'group',
				id: 'g2',
				documents: [terminal, browser, other],
				activeDocument: other.id,
			},
		},
		focused: 'g1',
		next: 4,
	};
}
const tabOf = (tab: DocumentTab): SurfaceTab | null => {
	switch (tab.kind) {
		case 'file':
			return { kind: 'file', id: tab.target, path: tab.path };
		case 'diff':
			return {
				kind: 'diff',
				scope: tab.target.slice(0, tab.target.indexOf('/')),
				path: tab.path,
				range: { base: 0, current: 2 },
			};
		case 'terminal':
			return { kind: 'terminal', session: tab.target, title: tab.path, directory: 'src' };
		case 'browser':
			return {
				kind: 'browser',
				tab: tab.target,
				title: tab.path,
				url: 'http://127.0.0.1:5173/',
				mobile: false,
			};
		default:
			return null;
	}
};
const surfaceOf = (groups: EditorGroups): TaskSurface => ({
	groups: surfaceGroups(groups, tabOf),
	columns: { chat: true, work: true, panel: false },
	widths: { chat: 460, panel: 320, bottom: 260 },
	panel: { tab: 'files', mode: 'history' },
	toolPlace: 'bottom',
	bottomUnderChat: true,
});

describe('surface.json (spec/task-window-workspace#restore-window)', () => {
	it('keeps the group tree, the order of tabs, the active tab of each group and the focus', () => {
		const groups = twoGroups(),
			surface = surfaceOf(groups);
		expect(isTaskSurface(surface)).toBe(true);
		expect(isTaskSurface(JSON.parse(JSON.stringify(surface)))).toBe(true);
		const back = restoreSurfaceGroups(surface.groups);
		expect(back).toEqual(groups);
		expect(surfaceTabs(surface).map((tab) => tab.kind)).toEqual([
			'file',
			'diff',
			'terminal',
			'browser',
			'browser',
		]);
	});
	it('drops what cannot come back: a file without an id, a group whose tabs all went', () => {
		const groups = twoGroups(),
			surface = mapSurfaceTabs(surfaceOf(groups), (tab) =>
				tab.kind === 'file'
					? { kind: 'file', path: tab.path }
					: tab.kind === 'terminal'
						? null
						: tab
			);
		const back = restoreSurfaceGroups(surface.groups);
		// The terminal's group is gone; its split collapsed, the browsers' group took its place.
		expect(back.root.kind).toBe('split');
		const leaves = JSON.stringify(back);
		expect(leaves).not.toContain(terminal.id);
		expect(leaves).not.toContain(file.id);
		expect(leaves).toContain(diff.id);
		expect(back.next).toBe(4);
	});
	it('an empty tree becomes one empty group; a stale focus goes to the first group', () => {
		const back = restoreSurfaceGroups({
			root: { kind: 'group', id: 'g7', tabs: [{ kind: 'file', path: 'gone.ts' }], active: 0 },
			focused: 'g9',
			next: 2,
		});
		expect(back).toEqual({
			root: { kind: 'group', id: 'g1', documents: [], activeDocument: null },
			focused: 'g1',
			next: 2,
		});
	});
	it('validates what it reads: paths inside the task, bounded widths, known modes', () => {
		const good = surfaceOf(twoGroups());
		const bad = (change: (value: any) => void) => {
			const value = JSON.parse(JSON.stringify(good));
			change(value);
			return isTaskSurface(value);
		};
		expect(bad(() => {})).toBe(true);
		expect(bad((value) => (value.groups.root.first.tabs[0].path = '../etc/passwd'))).toBe(false);
		expect(bad((value) => (value.groups.root.first.tabs[0].path = '/etc/passwd'))).toBe(false);
		expect(bad((value) => (value.widths.chat = -1))).toBe(false);
		expect(bad((value) => (value.panel.mode = 'blame'))).toBe(false);
		expect(bad((value) => (value.groups.root.second.tabs[1].url = 'file:///etc/passwd'))).toBe(
			false
		);
		expect(bad((value) => (value.toolPlace = 'side'))).toBe(false);
	});
	it('reads only its own schema version; an unknown one is reported, not taken for empty', () => {
		const surface = surfaceOf(twoGroups());
		expect(readSurfaceDocument({ schemaVersion: surfaceSchemaVersion, surface })).toEqual(surface);
		expect(readSurfaceDocument({ schemaVersion: 2, surface })).toBeNull();
		expect(surfaceVersionOf({ schemaVersion: 2, surface })).toBe(2);
		expect(surfaceVersionOf('nonsense')).toBeNull();
		expect(readSurfaceDocument({ schemaVersion: 1, surface: { groups: {} } })).toBeNull();
	});
	it('a reopened terminal takes the ended session’s place', () => {
		const groups = twoGroups(),
			fresh = documentForTerminal('77777777-1111-2222-3333-444455556666', 'zsh'),
			next = replaceTab(groups, terminal.id, fresh);
		expect(JSON.stringify(next)).toContain(fresh.id);
		expect(JSON.stringify(next)).not.toContain(terminal.id);
		const bottom = next.root.kind === 'split' && next.root.second;
		expect(bottom && bottom.kind === 'group' && bottom.documents.map((tab) => tab.id)).toEqual([
			fresh.id,
			browser.id,
			other.id,
		]);
	});
});

describe('window bounds (spec/task-window-workspace#restore-window)', () => {
	const primary = { x: 0, y: 25, width: 1512, height: 920 },
		side = { x: 1512, y: 0, width: 1920, height: 1080 };
	it('stays on a connected display', () => {
		const saved = { x: 1600, y: 100, width: 1200, height: 800, maximized: false };
		expect(fitWindowBounds(saved, [primary, side], primary)).toEqual(saved);
	});
	it('a window off every display goes to the primary one, centred and no larger than it', () => {
		const saved = { x: 4000, y: 100, width: 1800, height: 1000, maximized: true };
		expect(fitWindowBounds(saved, [primary], primary)).toEqual({
			x: 0,
			y: 25,
			width: 1512,
			height: 920,
			maximized: true,
		});
		expect(fitWindowBounds({ ...saved, width: 1000, height: 700 }, [primary], primary)).toEqual({
			x: 256,
			y: 135,
			width: 1000,
			height: 700,
			maximized: true,
		});
	});
	it('a title bar only partly on screen comes back inside the display', () => {
		const saved = { x: -300, y: 40, width: 1000, height: 700, maximized: false };
		expect(fitWindowBounds(saved, [primary], primary)).toMatchObject({ x: 0, y: 40, width: 1000 });
	});
});
