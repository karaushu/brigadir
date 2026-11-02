import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindPanel, findCountText, type FindCount } from './FindPanel';

const query = {
	search: 'alert',
	caseSensitive: true,
	wholeWord: false,
	regexp: false,
	replace: '',
};
const noop = () => {};
const panel = (count: FindCount, replace: { open: boolean; toggle(): void } | null) =>
	renderToStaticMarkup(
		<FindPanel
			locale="en"
			query={query}
			count={count}
			replace={replace}
			showReplaceKey="⌥⌘F"
			onQuery={noop}
			onNext={noop}
			onPrevious={noop}
			onSelectAll={noop}
			onReplace={noop}
			onReplaceAll={noop}
			onClose={noop}
		/>
	);

it('writes the counter as the canvas does: 3 of 12, narrow 3/12, ? off a match (spec/appearance#evolution-redesign)', () => {
	const found: FindCount = { kind: 'found', current: 3, total: 12, capped: false };
	expect(findCountText('en', found, false)).toBe('3 of 12');
	expect(findCountText('en', found, true)).toBe('3/12');
	expect(findCountText('uk', found, false)).toBe('3 з 12');
	expect(findCountText('en', { ...found, current: null, total: 10000, capped: true }, false)).toBe(
		'? of 10000+'
	);
	expect(findCountText('en', { kind: 'none' }, false)).toBe('No results');
	expect(findCountText('en', { kind: 'invalid' }, false)).toBe('Invalid regex');
	expect(findCountText('en', { kind: 'empty' }, false)).toBe('');
});

it('draws one M row with the toggles in the field, arrows, select all and Esc; replace only where allowed', () => {
	const html = panel(
		{ kind: 'found', current: 3, total: 12, capped: false },
		{ open: false, toggle: noop }
	);
	expect(html).toContain('aria-label="Find in file"');
	expect(html).toContain('data-size="m"');
	expect(html).toContain('aria-pressed="true"');
	expect(html).toContain('title="Next match · ⌘G"');
	expect(html).toContain('title="Previous match · ⇧⌘G"');
	expect(html).toContain('title="Select all matches · ⌥↩"');
	expect(html).toContain('title="Show replace · ⌥⌘F"');
	expect(html).toContain('>Esc<');
	expect(html).not.toContain('aria-label="Replace"');
	const open = panel(
		{ kind: 'found', current: 3, total: 12, capped: false },
		{ open: true, toggle: noop }
	);
	expect(open).toContain('title="Hide replace"');
	expect(open).toContain('aria-label="Replace"');
	expect(open).toContain('title="Replace all · ⌥⌘↩"');
	const readOnly = panel({ kind: 'none' }, null);
	expect(readOnly).not.toContain('Show replace');
	expect(readOnly).toContain('data-bad="true"');
	expect(readOnly).toMatch(
		/aria-label="Next match"[^>]*disabled=""|disabled=""[^>]*aria-label="Next match"/
	);
});
