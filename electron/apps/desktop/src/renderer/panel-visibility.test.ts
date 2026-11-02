import { describe, expect, it } from 'vitest';
import { opensEditor, panelShortcut } from './panel-visibility';
describe('the panel and the work area (spec/task-window-workspace#layout-switch)', () => {
	it('⇧⌘E / ⇧⌘D / ⇧⌘P open the panel on their tab; the same key again hides it', () => {
		expect(panelShortcut({ panel: 'files', shown: false }, 'changes')).toEqual({
			panel: 'changes',
			panelShown: true,
		});
		expect(panelShortcut({ panel: 'files', shown: true }, 'changes')).toEqual({
			panel: 'changes',
			panelShown: true,
		});
		expect(panelShortcut({ panel: 'changes', shown: true }, 'changes')).toEqual({
			panel: 'changes',
			panelShown: false,
		});
	});
	it('a document put on screen shows the work area; the switch itself decides its own patch', () => {
		expect(opensEditor({ surface: 'diff' }, 0)).toBe(true);
		expect(opensEditor({ activeDocument: 'file:a' }, 1)).toBe(true);
		expect(opensEditor({ documents: [1, 2] }, 1)).toBe(true);
		expect(opensEditor({ documents: [1] }, 1)).toBe(false);
		expect(opensEditor({ surface: 'chat' }, 1)).toBe(false);
		expect(opensEditor({ surface: 'diff', workShown: false }, 0)).toBe(false);
	});
});
