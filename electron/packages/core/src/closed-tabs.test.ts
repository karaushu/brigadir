import { describe, expect, it } from 'vitest';
import {
	closedTabLimit,
	nextClosedTab,
	pushClosedTab,
	takeClosedTab,
	type ClosedTab,
} from './closed-tabs';
import { documentForDiff, documentForFile, documentForTerminal } from './document-tabs';
import { findGroup, reopenTab, singleGroup, splitGroup, type EditorGroups } from './editor-groups';

const a = documentForFile('a', 'src/a.ts'),
	b = documentForFile('b', 'src/b.ts'),
	c = documentForDiff('s1/src/c.ts');
const closed = (tab: ClosedTab['tab'], group = 'g1', index = 0): ClosedTab<string> => ({
	tab,
	group,
	index,
	extra: tab.id,
});
/** g1 holds `b`; g2 (split right of g1) holds `a`, focused. */
const split = (): EditorGroups =>
	splitGroup(singleGroup({ documents: [a, b], activeDocument: a.id }), 'g1', a.id, 'right', true);

describe('closed tab stack (spec/editor#reopen-closed-tab)', () => {
	it('reopens the newest closed tab first and keeps one entry per tab and group', () => {
		const groups = singleGroup();
		let stack = pushClosedTab([], closed(a));
		stack = pushClosedTab(stack, closed(b, 'g1', 1));
		stack = pushClosedTab(stack, closed(a, 'g1', 2));
		expect(stack.map((item) => [item.tab.id, item.index])).toEqual([
			[b.id, 1],
			[a.id, 2],
		]);
		const first = takeClosedTab(stack, groups, 'g1')!;
		expect(first.entry.tab).toEqual(a);
		const second = takeClosedTab(first.stack, groups, 'g1')!;
		expect(second.entry.tab).toEqual(b);
		expect(second.stack).toEqual([]);
		expect(takeClosedTab(second.stack, groups, 'g1')).toBeNull();
	});
	it('keeps a stack per editor group', () => {
		const groups = split();
		expect(findGroup(groups, 'g2')?.documents).toEqual([a]);
		const stack = [closed(c, 'g1'), closed(b, 'g2')];
		expect(nextClosedTab(stack, groups, 'g1')?.tab).toEqual(c);
		expect(nextClosedTab(stack, groups, 'g2')?.tab).toEqual(b);
	});
	it('gives the tabs of a group that is gone to the focused group', () => {
		const groups = singleGroup({ documents: [a], activeDocument: a.id });
		expect(nextClosedTab([closed(c, 'g7')], groups, 'g1')?.tab).toEqual(c);
	});
	it('skips a tab the group shows again and drops it with the one it takes', () => {
		const groups = singleGroup({ documents: [a], activeDocument: a.id });
		const stack = [closed(b), closed(a)];
		expect(nextClosedTab(stack, groups, 'g1')?.tab).toEqual(b);
		expect(takeClosedTab(stack, groups, 'g1')!.stack).toEqual([]);
		expect(nextClosedTab([closed(a)], groups, 'g1')).toBeNull();
	});
	it('never keeps a tool tab and holds at most the limit', () => {
		expect(pushClosedTab([], closed(documentForTerminal('t1', 'zsh')))).toEqual([]);
		let stack: ClosedTab<string>[] = [];
		for (let index = 0; index < closedTabLimit + 5; index++)
			stack = pushClosedTab(stack, closed(documentForFile(`f${index}`, `f${index}`)));
		expect(stack).toHaveLength(closedTabLimit);
		expect(stack[0]!.tab.target).toBe('f5');
	});
	it('puts the reopened tab back at its place and focuses its group', () => {
		const groups = split();
		const back = reopenTab({ ...groups, focused: 'g2' }, 'g1', c, 0);
		expect(back.focused).toBe('g1');
		expect(findGroup(back, 'g1')).toMatchObject({ documents: [c, b], activeDocument: c.id });
		// A gone group: the focused one takes it.
		const lone = reopenTab(singleGroup({ documents: [a], activeDocument: a.id }), 'g9', b, 5);
		expect(findGroup(lone, 'g1')).toMatchObject({ documents: [a, b], activeDocument: b.id });
	});
});
