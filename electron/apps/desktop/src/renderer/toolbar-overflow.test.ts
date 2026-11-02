import { expect, it } from 'vitest';
import {
	defaultToolbarWidths,
	fitToolbar,
	narrower,
	toolbarSteps,
	toolbarWidth,
	type OverflowKey,
} from './toolbar-overflow';
const all: OverflowKey[] = ['commands', 'agents'];
const widths = { ...defaultToolbarWidths, fixed: 200 };
it('folds Commands, then Agents leave, then Commands keep their glyph and leave (spec/task-window-workspace#work-area)', () => {
	expect(toolbarSteps(all)).toEqual([
		{ commands: 'full', out: [] },
		{ commands: 'compact', out: [] },
		{ commands: 'compact', out: ['agents'] },
		{ commands: 'minimal', out: ['agents'] },
		{ commands: 'minimal', out: ['agents', 'commands'] },
	]);
	// No agents at work: only Commands fold and leave; the commands module off: only Agents.
	expect(toolbarSteps(['commands']).map((step) => step.out.join(','))).toEqual([
		'',
		'',
		'',
		'commands',
	]);
	expect(toolbarSteps(['agents']).map((step) => step.out.join(','))).toEqual(['', '', 'agents']);
});
it('counts the fixed group and «…» only when a button is out', () => {
	const [full, , agentsOut] = toolbarSteps(all);
	// padding 28 + title 70 + commands 141 + agents 55 + fixed 200 + 3 gaps.
	expect(toolbarWidth(full!, all, widths)).toBe(28 + 70 + 141 + 55 + 200 + 8 * 3);
	expect(toolbarWidth(agentsOut!, all, widths)).toBe(28 + 70 + 65 + 28 + 200 + 8 * 3);
	const last = toolbarSteps(all).at(-1)!;
	expect(toolbarWidth(last, all, widths)).toBe(28 + 70 + 28 + 200 + 8 * 2);
});
it('picks the first step that fits; the floor is the last step, whatever the width', () => {
	expect(fitToolbar(2000, all, widths).step).toEqual({ commands: 'full', out: [] });
	expect(fitToolbar(460, all, widths).step).toEqual({ commands: 'compact', out: [] });
	expect(fitToolbar(440, all, widths).step.out).toEqual(['agents']);
	expect(fitToolbar(300, all, widths).step.out).toEqual(['agents', 'commands']);
	expect(fitToolbar(2000, all, widths).floor).toBe(28 + 70 + 28 + 200 + 8 * 2);
	expect(narrower('full', 'compact')).toBe('compact');
});
