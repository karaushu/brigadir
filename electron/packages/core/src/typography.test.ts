import { it, expect } from 'vitest';
import {
	chatFontStep,
	chatScale,
	chatTextSize,
	defaultChatFont,
	isChatFont,
	shownChatSize,
	defaultInterfaceFont,
	defaultTypography,
	fontFamilyChoice,
	isInterfaceFont,
	isTypography,
	resizedTypography,
} from './typography';
it('validates independent surface fonts and the fixed terminal grid', () => {
	expect(isTypography(defaultTypography)).toBe(true);
	expect(
		isTypography({ ...defaultTypography, editor: { ...defaultTypography.editor, size: 8 } })
	).toBe(true);
	for (const patch of [
		{ size: 0 },
		{ size: 7 },
		{ size: 25 },
		{ size: NaN },
		{ lineHeight: Infinity },
		{ family: 'bad\nfont' },
		{ ligatures: 1 },
	])
		expect(
			isTypography({ ...defaultTypography, editor: { ...defaultTypography.editor, ...patch } })
		).toBe(false);
	for (const patch of [{ lineHeight: 1.6 }, { ligatures: true }])
		expect(
			isTypography({ ...defaultTypography, terminal: { ...defaultTypography.terminal, ...patch } })
		).toBe(false);
	expect(
		isTypography({
			...defaultTypography,
			editor: { ...defaultTypography.editor, family: 'Font removed on another machine' },
		})
	).toBe(true);
});
it('resizes only the chosen surface and resets size without dropping font preferences', () => {
	const initial = {
		...defaultTypography,
		editor: { family: 'Menlo', size: 24, lineHeight: 1.8, ligatures: true },
	};
	expect(resizedTypography(initial, 'editor', 'increase')).toEqual(initial);
	const next = resizedTypography(initial, 'editor', 'reset');
	expect(next.editor).toEqual({ ...initial.editor, size: 12 });
	expect(next.diff).toEqual(initial.diff);
	expect(next.terminal).toEqual(initial.terminal);
	expect(initial.editor.size).toBe(24);
});
it('accepts interface sizes from 8 to 24 px', () => {
	for (const size of [8, 13, 24])
		expect(isInterfaceFont({ ...defaultInterfaceFont, size })).toBe(true);
	for (const size of [7, 25, 12.5])
		expect(isInterfaceFont({ ...defaultInterfaceFont, size })).toBe(false);
});
it('reads null as the bundled Geist, the CSS generic name as the OS font, anything else as installed (spec/appearance#evolution-redesign)', () => {
	expect(defaultInterfaceFont.family).toBeNull();
	expect(fontFamilyChoice(null, 'sans')).toEqual({ kind: 'bundled', name: 'Geist' });
	expect(fontFamilyChoice(null, 'mono')).toEqual({ kind: 'bundled', name: 'Geist Mono' });
	expect(fontFamilyChoice('system-ui', 'sans').kind).toBe('system');
	expect(fontFamilyChoice('ui-monospace', 'mono').kind).toBe('system');
	expect(fontFamilyChoice('ui-monospace', 'sans').kind).toBe('installed');
	expect(fontFamilyChoice('JetBrains Mono', 'mono')).toEqual({
		kind: 'installed',
		name: 'JetBrains Mono',
	});
	// Geist Mono's ligatures are on in the code surfaces; the terminal keeps its grid.
	expect([defaultTypography.editor.ligatures, defaultTypography.diff.ligatures]).toEqual([
		true,
		true,
	]);
	expect(defaultTypography.terminal.ligatures).toBe(false);
});

it('spec/appearance#chat-text-size: the chat follows the interface until it has its own size; the stepper shows the 0.5 grid', () => {
	expect(isChatFont(defaultChatFont)).toBe(true);
	expect(isChatFont({ size: 13.5 })).toBe(true);
	for (const value of [{ size: 13.25 }, { size: 7.5 }, { size: 24.5 }, { size: NaN }, {}, null])
		expect(isChatFont(value)).toBe(false);
	const ui = defaultInterfaceFont;
	expect(chatTextSize(null, ui)).toBe(13.5);
	expect(chatScale(defaultChatFont, ui)).toBe(1);
	expect(chatScale(undefined, ui)).toBe(1);
	// A follower moves with the interface exactly: 16 / 13 of the design.
	expect(chatScale(null, { ...ui, size: 16 })).toBeCloseTo(16 / 13);
	expect(shownChatSize(null, { ...ui, size: 16 })).toBe(16.5);
	expect(shownChatSize(null, { ...ui, size: 14 })).toBe(14.5);
	// An own size ignores the interface.
	expect(chatScale({ size: 18 }, { ...ui, size: 10 })).toBeCloseTo(18 / 13.5);
	expect(shownChatSize({ size: 18 }, { ...ui, size: 10 })).toBe(18);
	expect(shownChatSize(null, { ...ui, size: 24 })).toBe(24);
	expect([chatFontStep(13.3), chatFontStep(13.2), chatFontStep(30), chatFontStep(2)]).toEqual([
		13.5, 13, 24, 8,
	]);
});
