import { describe, expect, it } from 'vitest';
import { documentForFile, documentForTerminal } from './document-tabs';
import {
	bottomGroup,
	closeInGroup,
	holdWorkArea,
	holdsWorkArea,
	openToolTab,
	singleGroup,
	splitGroup,
	workAreaTabs,
} from './editor-groups';
import {
	chatGroup,
	chatTabAfter,
	chatTabState,
	chatUnreadAfter,
	defaultTaskColumns,
	fitWorkArea,
	isTaskColumns,
	opensToolsInstead,
	twoColumnsLayout,
	twoColumnsShortcut,
} from './task-layout';

describe('spec/task-window-workspace#two-columns two columns: the chat is the pinned tab of the work area', () => {
	const a = documentForFile('a', 'src/a.ts'),
		b = documentForFile('b', 'src/b.ts');
	const one = singleGroup({ documents: [a, b], activeDocument: a.id });
	it('is a choice of two values, three by default', () => {
		expect(defaultTaskColumns).toBe('three');
		expect(isTaskColumns('two')).toBe(true);
		expect(isTaskColumns('three')).toBe(true);
		expect(isTaskColumns('auto')).toBe(false);
	});
	it('shows no chat column and always the work area; the panel stays the task’s', () => {
		expect(twoColumnsLayout({ chat: true, work: false, panel: true })).toEqual({
			chat: false,
			work: true,
			panel: true,
		});
		expect(twoColumnsLayout({ chat: false, work: true, panel: false }).panel).toBe(false);
	});
	it('the tab says what the agent does: waiting over working over unread', () => {
		expect(chatTabState({ waiting: true, running: true, unread: true })).toBe('waiting');
		expect(chatTabState({ waiting: false, running: true, unread: true })).toBe('running');
		expect(chatTabState({ waiting: false, running: false, unread: true })).toBe('unread');
		expect(chatTabState({ waiting: false, running: false, unread: false })).toBe('idle');
	});
	it('a turn that ends off screen leaves the tab unread until the chat is on screen', () => {
		expect(chatUnreadAfter(false, true, false, false)).toBe(true);
		expect(chatUnreadAfter(false, true, false, true)).toBe(false);
		expect(chatUnreadAfter(true, false, false, false)).toBe(true);
		expect(chatUnreadAfter(true, false, true, true)).toBe(false);
		expect(chatUnreadAfter(false, false, true, false)).toBe(false);
	});
	it('⌘1 always shows the chat, ⌘2 the group’s file or Tools without tabs, ⌘3 the panel', () => {
		expect(twoColumnsShortcut('chat', { groupFile: true, workTabs: 3 })).toBe('chat');
		expect(twoColumnsShortcut('work', { groupFile: true, workTabs: 3 })).toBe('file');
		expect(twoColumnsShortcut('work', { groupFile: false, workTabs: 0 })).toBe('tools');
		expect(twoColumnsShortcut('work', { groupFile: false, workTabs: 2 })).toBe('none');
		expect(twoColumnsShortcut('panel', { groupFile: false, workTabs: 0 })).toBe('panel');
	});
	it('the chat lives in the first group, a split keeps it there', () => {
		const split = splitGroup(one, one.focused, b.id, 'right', true);
		expect(chatGroup(split).id).toBe(one.root.id);
	});
	it('another tab of the chat’s group hides the chat; a closed tab or the chat’s own surface do not', () => {
		const switched = singleGroup({ documents: [a, b], activeDocument: b.id });
		expect(chatTabAfter(true, one, switched, {})).toBe(false);
		const closed = closeInGroup(one, one.focused, a.id);
		expect(chatTabAfter(true, one, closed, {})).toBe(true);
		expect(chatTabAfter(false, one, switched, { chat: true })).toBe(true);
		expect(chatTabAfter(true, one, one, {})).toBe(true);
	});
	it('a document the person picks for the focused first group hides the chat, even the one already active', () => {
		expect(chatTabAfter(true, one, one, { explicit: true })).toBe(false);
		const split = splitGroup(one, one.focused, b.id, 'right', true);
		expect(split.focused).not.toBe(chatGroup(split).id);
		expect(chatTabAfter(true, split, split, { explicit: true })).toBe(true);
	});
	it('a group without a tab shows the chat whatever was chosen', () => {
		const empty = singleGroup();
		expect(chatTabAfter(false, empty, empty, { explicit: true })).toBe(false);
		expect(chatTabAfter(true, empty, empty, {})).toBe(true);
	});
});

describe('spec/task-window-workspace#empty-work-area an empty work area is never shown', () => {
	it('hides a work area without tabs; the chat takes the width', () => {
		expect(fitWorkArea({ chat: true, work: true, panel: false }, 0)).toEqual({
			chat: true,
			work: false,
			panel: false,
		});
	});
	it('keeps a work area with tabs as the switches say', () => {
		const layout = { chat: true, work: true, panel: true };
		expect(fitWorkArea(layout, 2)).toBe(layout);
		const hidden = { chat: true, work: false, panel: false };
		expect(fitWorkArea(hidden, 2)).toBe(hidden);
	});
	it('brings nothing back when the last tab closes with the chat hidden (14.10.2026)', () => {
		expect(fitWorkArea({ chat: false, work: true, panel: true }, 0)).toEqual({
			chat: false,
			work: false,
			panel: true,
		});
		const bare = { chat: false, work: false, panel: false };
		expect(fitWorkArea(bare, 0)).toBe(bare);
	});
	it('the main tree keeps its work area without a tab; its switches decide (14.10.2026)', () => {
		const empty = { chat: true, work: true, panel: true };
		expect(fitWorkArea(empty, 0, true)).toBe(empty);
		const noPanel = { chat: true, work: true, panel: false };
		expect(fitWorkArea(noPanel, 0, true)).toBe(noPanel);
		const off = { chat: true, work: false, panel: false };
		expect(fitWorkArea(off, 2, true)).toBe(off);
	});
	it('turning an empty work area on opens Tools instead', () => {
		const hidden = { chat: true, work: false, panel: false };
		expect(opensToolsInstead(hidden, 'work', 0)).toBe(true);
		expect(opensToolsInstead(hidden, 'work', 1)).toBe(false);
		expect(opensToolsInstead(hidden, 'panel', 0)).toBe(false);
		expect(opensToolsInstead({ ...hidden, work: true }, 'work', 0)).toBe(false);
	});
	it('the bottom group under the chat does not count for the work area', () => {
		const file = documentForFile('f1', 'src/a.ts'),
			terminal = documentForTerminal('t1', 'zsh');
		const groups = openToolTab(
			singleGroup({ documents: [file], activeDocument: file.id }),
			terminal,
			'bottom'
		);
		expect(workAreaTabs(groups, false).map((tab) => tab.id)).toEqual([file.id, terminal.id]);
		expect(workAreaTabs(groups, true).map((tab) => tab.id)).toEqual([file.id]);
		// The last file closes: the tree collapses to the bottom group; it goes back under an empty group that holds the place.
		const collapsed = closeInGroup(groups, 'g1', file.id);
		expect(collapsed.root.kind).toBe('group');
		const held = holdWorkArea(collapsed);
		expect(holdsWorkArea(held)).toBe(true);
		expect(bottomGroup(held)?.documents.map((tab) => tab.id)).toEqual([terminal.id]);
		expect(held.focused).not.toBe(bottomGroup(held)?.id);
		expect(workAreaTabs(held, true)).toEqual([]);
		expect(workAreaTabs(held, false).map((tab) => tab.id)).toEqual([terminal.id]);
		expect(holdsWorkArea(groups)).toBe(false);
	});
});
