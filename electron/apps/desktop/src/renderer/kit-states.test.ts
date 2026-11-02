import { expect, it } from 'vitest';
import { forcedSelector } from './kit-states';

it('lets a marked element or its subtree hold hover, press and focus (spec/appearance#bundled-fonts)', () => {
	expect(forcedSelector('button:hover')).toBe(
		"button:is(:hover, [data-kit-state~='hover'], [data-kit-state~='hover'] *)"
	);
	expect(forcedSelector('.split:has(> button:active:not(:disabled)) > button')).toBe(
		".split:has(> button:is(:active, [data-kit-state~='press'], [data-kit-state~='press'] *):not(:disabled)) > button"
	);
	expect(forcedSelector('.field:focus-within, .x:focus-visible::after')).toBe(
		".field:is(:focus-within, [data-kit-state~='focus'], [data-kit-state~='focus'] *), " +
			".x:is(:focus-visible, [data-kit-state~='focus'], [data-kit-state~='focus'] *)::after"
	);
	// `:focus` alone and look-alike names stay as they are.
	expect(forcedSelector('.items[data-keyboard] .item:focus')).toBe(
		'.items[data-keyboard] .item:focus'
	);
	expect(forcedSelector('.a:hovered')).toBe('.a:hovered');
});
