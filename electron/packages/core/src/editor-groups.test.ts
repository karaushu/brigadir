import { describe, expect, it } from 'vitest';
import {
	documentForBrowser,
	documentForFile,
	documentForSimulator,
	documentForTerminal,
	type DocumentTab,
} from './document-tabs';
import {
	allGroupTabs,
	closeInGroup,
	dropTab,
	findGroup,
	focusedTabs,
	groupLeaves,
	groupOf,
	moveToNextGroup,
	openElsewhere,
	pruneGroups,
	resizeSplit,
	shownTabs,
	singleGroup,
	splitGroup,
	stepGroup,
	unsplitAll,
	unsplitGroup,
	withFocusedTabs,
	bottomGroup,
	openToolTab,
	renameTab,
	revealTab,
	toolTabs,
	type EditorGroups,
} from './editor-groups';
import {
	toggleColumn,
	defaultTaskLayout,
	firstTaskLayout,
	isTaskLayout,
	showsEmptyPlace,
} from './task-layout';

const a = documentForFile('a', 'a.ts'),
	b = documentForFile('b', 'b.ts'),
	c = documentForFile('c', 'c.ts');
const ids = (tabs: DocumentTab[]) => tabs.map((tab) => tab.id);
const one = (...tabs: DocumentTab[]): EditorGroups =>
	singleGroup({ documents: tabs, activeDocument: tabs[0]?.id ?? null });
const shape = (groups: EditorGroups) =>
	groupLeaves(groups.root).map(
		(group) =>
			`${group.id}:${group.documents.map((tab) => tab.path[0]).join('')}>${group.activeDocument?.slice(5) ?? '-'}`
	);

describe('editor groups (spec/editor#editor-groups)', () => {
	it('Split copies the tab into a new focused group; Split and Move takes it there', () => {
		const copied = splitGroup(one(a, b), 'g1', a.id, 'right', false);
		expect(shape(copied)).toEqual(['g1:ab>a', 'g2:a>a']);
		expect(copied.focused).toBe('g2');
		expect(copied.root.kind === 'split' && copied.root.direction).toBe('right');
		const moved = splitGroup(one(a, b), 'g1', a.id, 'down', true);
		expect(shape(moved)).toEqual(['g1:b>b', 'g2:a>a']);
		expect(moved.root.kind === 'split' && moved.root.direction).toBe('down');
		// Moving the only tab would leave an empty group where the new one stands: nothing happens.
		expect(splitGroup(one(a), 'g1', a.id, 'right', true)).toEqual(one(a));
	});
	it('splits any group again, so the grid nests (arbitrary, as in JetBrains)', () => {
		let groups = splitGroup(one(a, b, c), 'g1', b.id, 'right', true);
		groups = splitGroup(groups, 'g2', b.id, 'down', false);
		expect(shape(groups)).toEqual(['g1:ac>a', 'g2:b>b', 'g4:b>b']);
		expect(
			groups.root.kind === 'split' &&
				groups.root.second.kind === 'split' &&
				groups.root.second.direction
		).toBe('down');
	});
	it('closing the last tab of a group removes it; the side that takes the place gets the focus', () => {
		let groups = splitGroup(one(a, b), 'g1', b.id, 'right', true);
		groups = closeInGroup(groups, 'g2', b.id);
		expect(shape(groups)).toEqual(['g1:a>a']);
		expect(groups.root.kind).toBe('group');
		expect(groups.focused).toBe('g1');
		// The last group stays, empty.
		expect(shape(closeInGroup(groups, 'g1', a.id))).toEqual(['g1:>-']);
	});
	it('a drop beside a group opens a new one there; inside a group or its strip moves the tab; ⌥ copies', () => {
		const split = splitGroup(one(a, b, c), 'g1', c.id, 'right', true);
		expect(shape(dropTab(split, 'g1', b.id, { group: 'g2', at: 'down' }, false))).toEqual([
			'g1:a>a',
			'g2:c>c',
			'g4:b>b',
		]);
		expect(shape(dropTab(split, 'g1', b.id, { group: 'g2', at: 'center' }, false))).toEqual([
			'g1:a>a',
			'g2:cb>b',
		]);
		expect(shape(dropTab(split, 'g1', b.id, { group: 'g2', at: { index: 0 } }, true))).toEqual([
			'g1:ab>a',
			'g2:bc>b',
		]);
		// Reordering inside the same strip.
		expect(
			ids(
				findGroup(
					dropTab(one(a, b, c), 'g1', a.id, { group: 'g1', at: { index: 3 } }, false),
					'g1'
				)!.documents
			)
		).toEqual([b.id, c.id, a.id]);
		// Dropping the group's only tab into another group removes the emptied one.
		expect(shape(dropTab(split, 'g2', c.id, { group: 'g1', at: 'center' }, false))).toEqual([
			'g1:acb>c',
		]);
	});
	it('moves to the other group, walks the groups and unsplits', () => {
		const split = splitGroup(one(a, b), 'g1', b.id, 'right', true);
		expect(shape(moveToNextGroup({ ...split, focused: 'g1' }, 'g1', a.id))).toEqual(['g2:ba>a']);
		expect(stepGroup(split, 1).focused).toBe('g1');
		expect(stepGroup(stepGroup(split, 1), -1).focused).toBe('g2');
		expect(shape(unsplitGroup(split, 'g2'))).toEqual(['g1:ab>b']);
		const three = splitGroup(
			splitGroup(one(a, b, c), 'g1', b.id, 'right', true),
			'g2',
			b.id,
			'down',
			false
		);
		expect(shape(unsplitAll(three))).toEqual(['g1:acb>b']);
	});
	it('mirrors the focused group to the flat tab fields and knows where a tab is open', () => {
		const split = splitGroup(one(a, b), 'g1', a.id, 'right', false);
		expect(focusedTabs(split)).toEqual({ documents: [a], activeDocument: a.id });
		const written = withFocusedTabs(split, { documents: [a, c], activeDocument: c.id });
		expect(shape(written)).toEqual(['g1:ab>a', 'g2:ac>c']);
		expect(openElsewhere(written, a.id, 'g2')).toBe(true);
		expect(openElsewhere(written, c.id, 'g2')).toBe(false);
		expect(ids(allGroupTabs(written))).toEqual([a.id, b.id, c.id]);
		expect(ids(shownTabs(written))).toEqual([a.id, c.id]);
		expect(groupOf(written, a.id)?.id).toBe('g2');
		expect(shape(pruneGroups(written, (tab) => tab.id !== c.id))).toEqual(['g1:ab>a', 'g2:a>a']);
		expect(
			resizeSplit(written, 's3', 2).root.kind === 'split' &&
				(resizeSplit(written, 's3', 2).root as { ratio: number }).ratio
		).toBe(0.9);
	});
	// spec/task-window-workspace#work-area: tools are tabs of the work area; the console is the bottom group.
	it('opens a tool tab in the focused group or the bottom group, made under the whole area', () => {
		const zsh = documentForTerminal('t1', 'zsh'),
			web = documentForBrowser('b1', 'localhost:5173'),
			sim = documentForSimulator('iPhone 17');
		// An empty work area simply takes the tab.
		const alone = openToolTab(one(), zsh, 'bottom');
		expect(alone.root.kind).toBe('group');
		expect(ids(findGroup(alone, 'g1')!.documents)).toEqual([zsh.id]);
		const split = openToolTab(one(a, b), zsh, 'bottom');
		expect(split.root).toMatchObject({ kind: 'split', direction: 'down', ratio: 0.68 });
		expect(bottomGroup(split)?.documents).toEqual([zsh]);
		expect(split.focused).toBe(bottomGroup(split)!.id);
		// The bottom group takes the next tool; the focused group takes one when asked.
		const two = openToolTab(split, web, 'bottom');
		expect(ids(bottomGroup(two)!.documents)).toEqual([zsh.id, web.id]);
		const top = openToolTab({ ...two, focused: 'g1' }, sim, 'focused');
		expect(ids(findGroup(top, 'g1')!.documents)).toEqual([a.id, sim.id, b.id]);
		expect(ids(toolTabs(top))).toEqual([sim.id, zsh.id, web.id]);
		// A tab open anywhere is shown where it is, and its group takes the focus.
		const again = openToolTab({ ...top, focused: 'g1' }, zsh, 'focused');
		expect(again.focused).toBe(bottomGroup(again)!.id);
		expect(bottomGroup(again)!.activeDocument).toBe(zsh.id);
		expect(revealTab(again, 'missing')).toBe(again);
		expect(bottomGroup(renameTab(again, zsh.id, 'pnpm dev'))!.documents[0]!.path).toBe('pnpm dev');
	});
	it('moves a tool tab instead of copying it: one terminal, one page on screen', () => {
		const zsh = documentForTerminal('t1', 'zsh');
		const split = splitGroup(one(a, zsh), 'g1', zsh.id, 'right', false);
		expect(ids(findGroup(split, 'g1')!.documents)).toEqual([a.id]);
		const dropped = dropTab(split, 'g2', zsh.id, { group: 'g1', at: 'center' }, true);
		expect(groupLeaves(dropped.root).map((group) => ids(group.documents))).toEqual([
			[a.id, zsh.id],
		]);
	});
});
describe('task layout (spec/task-window-workspace#layout-switch)', () => {
	it('opens a new task without the panel, the main tree with it', () => {
		expect(defaultTaskLayout).toEqual({ chat: true, work: true, panel: false });
		expect(firstTaskLayout(false)).toEqual(defaultTaskLayout);
		expect(firstTaskLayout(true)).toEqual({ chat: true, work: true, panel: true });
	});
	it('switches each column on and off, all three too (14.10.2026)', () => {
		const all = { chat: true, work: true, panel: true };
		expect(toggleColumn(all, 'panel')).toEqual({ chat: true, work: true, panel: false });
		const chatless = toggleColumn(all, 'chat');
		expect(chatless).toEqual({ chat: false, work: true, panel: true });
		const bare = toggleColumn(toggleColumn(chatless, 'work'), 'panel');
		expect(bare).toEqual({ chat: false, work: false, panel: false });
		expect(showsEmptyPlace(bare)).toBe(true);
		expect(showsEmptyPlace({ chat: false, work: false, panel: true })).toBe(true);
		expect(showsEmptyPlace(chatless)).toBe(false);
		expect(toggleColumn(bare, 'chat').chat).toBe(true);
		expect(isTaskLayout(defaultTaskLayout)).toBe(true);
		expect(isTaskLayout(bare)).toBe(true);
		expect(isTaskLayout({ chat: false, work: false })).toBe(false);
	});
});
