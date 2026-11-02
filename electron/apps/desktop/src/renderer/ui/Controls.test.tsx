import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	Button,
	Choice,
	Chip,
	Field,
	IconButton,
	Popup,
	Segments,
	Stepper,
	Switch,
} from './Controls';
import { TextArea, TextInput } from './Input';
import notice from './NoticeChip.module.css';
import controls from './Controls.module.css';

/** spec/appearance#control-scale: one size scale, appearance and variant on every control. */
const attrs = (html: string) =>
	Object.fromEntries(
		[...html.matchAll(/data-([\w-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!])
	);

it('Button takes size, appearance and variant; the default is a neutral soft button and a primary solid one', () => {
	expect(attrs(renderToStaticMarkup(<Button>Go</Button>))).toMatchObject({
		appearance: 'neutral',
		variant: 'soft',
	});
	expect(attrs(renderToStaticMarkup(<Button appearance="primary">Go</Button>))).toMatchObject({
		appearance: 'primary',
		variant: 'solid',
	});
	expect(
		attrs(
			renderToStaticMarkup(
				<Button appearance="danger" variant="ghost" size="xl">
					Go
				</Button>
			)
		)
	).toMatchObject({ appearance: 'danger', variant: 'ghost', size: 'xl' });
	expect(attrs(renderToStaticMarkup(<Button appearance="warning">Go</Button>))).toMatchObject({
		appearance: 'warning',
		variant: 'soft',
	});
});

it('a control with no size inherits its group, and `small` is gone', () => {
	expect(renderToStaticMarkup(<Button>Go</Button>)).not.toContain('data-size');
	expect(renderToStaticMarkup(<Button size="s">Go</Button>)).toContain('data-size="s"');
	// @ts-expect-error `small` is not on the size scale
	expect(renderToStaticMarkup(<Button small>Go</Button>)).not.toContain('data-small');
});

it('IconButton is a ghost square unless a shape is asked for, and keeps its accessible name', () => {
	const square = renderToStaticMarkup(
		<IconButton label="Search" size="m">
			x
		</IconButton>
	);
	expect(attrs(square)).toMatchObject({ variant: 'ghost', shape: 'square', size: 'm' });
	expect(square).toContain('aria-label="Search"');
	expect(
		attrs(
			renderToStaticMarkup(
				<IconButton label="Open" shape="auto">
					x
				</IconButton>
			)
		)
	).toMatchObject({ shape: 'auto' });
});

it('IconButton «lost» turns its glyph into a spinner, hides the dot and keeps the hint (spec/remote-access-and-mobile#remote-button)', () => {
	const lost = renderToStaticMarkup(
		<IconButton label="Remote machine studio" hint="Reconnecting…" dot="var(--green)" lost>
			<b>glyph</b>
		</IconButton>
	);
	expect(lost).toContain('data-glyph="agent-spinner"');
	expect(lost).not.toContain('<b>glyph</b>');
	expect(attrs(lost)).toMatchObject({ lost: 'true', dot: 'false' });
	expect(lost).toContain('aria-disabled="true"');
	expect(lost).not.toContain('disabled=""');
	expect(lost).toContain('title="Reconnecting…"');
	const live = renderToStaticMarkup(
		<IconButton label="Remote" dot="var(--green)">
			<b>glyph</b>
		</IconButton>
	);
	expect(live).toContain('<b>glyph</b>');
	expect(live).not.toContain('data-lost');
	expect(live).not.toContain('aria-disabled');
});

it('every control kind carries the size of its row', () => {
	const options = [
		{ value: 'a', label: 'A' },
		{ value: 'b', label: 'B' },
	];
	for (const size of ['s', 'm', 'l', 'xl'] as const) {
		const html = [
			renderToStaticMarkup(
				<Popup size={size} label="P" options={options} value="a" onChange={() => {}} />
			),
			renderToStaticMarkup(
				<Segments size={size} label="S" options={options} value="a" onChange={() => {}} />
			),
			renderToStaticMarkup(<Switch size={size} label="W" checked onChange={() => {}} />),
			renderToStaticMarkup(
				<Stepper
					size={size}
					label="N"
					value={1}
					onChange={() => {}}
					increaseLabel="+"
					decreaseLabel="-"
				/>
			),
			renderToStaticMarkup(<Choice size={size} type="checkbox" label="C" />),
			renderToStaticMarkup(<Field size={size} label="F" />),
			renderToStaticMarkup(<TextInput size={size} />),
			renderToStaticMarkup(<TextArea size={size} />),
		];
		for (const markup of html) expect(attrs(markup).size).toBe(size);
	}
});

it('a fractional Stepper is a text field with the interface’s separator, not the OS region’s (spec/settings-modules-and-onboarding#settings-window)', () => {
	const html = renderToStaticMarkup(
		<Stepper
			label="N"
			value={1}
			step={0.1}
			onChange={() => {}}
			increaseLabel="+"
			decreaseLabel="-"
		/>
	);
	expect(html).toMatch(/type="text"/);
	expect(html).toMatch(/value="1\.0"/);
	expect(html).toMatch(/inputMode="decimal"/);
	expect(attrs(html).automatic).toBeUndefined();
	const whole = renderToStaticMarkup(
		<Stepper label="N" value={13} onChange={() => {}} increaseLabel="+" decreaseLabel="-" />
	);
	expect(whole).toMatch(/type="number"/);
});

it('TextInput `size` is the control size, not the HTML character count', () => {
	expect(renderToStaticMarkup(<TextInput size="l" />)).not.toMatch(/ size="/);
});

it('a clickable Chip is an S control (24 px target)', () => {
	expect(attrs(renderToStaticMarkup(<Chip>x</Chip>)).size).toBe('s');
});

it('a chip just added carries `fresh` only while asked (spec/tasks#worktree-preparation, canvas 8.5 `.k8-ch.new`)', () => {
	expect(attrs(renderToStaticMarkup(<Chip fresh>design-notes</Chip>)).fresh).toBe('true');
	expect(attrs(renderToStaticMarkup(<Chip>design-notes</Chip>)).fresh).toBeUndefined();
});

it('a selected chip keeps the shared hover layer (rule 15, spec/tasks#worktree-preparation): its fill is `background-color`, not the shorthand', () => {
	const rule = readFileSync(new URL('./Controls.module.css', import.meta.url), 'utf8').match(
		/\.chip\[data-tone='selected'\]\s*\{([^}]*)\}/
	)?.[1];
	expect(rule).toMatch(/background-color: var\(--accent-soft\)/);
	expect(rule).not.toMatch(/(^|[\s;])background:/);
});

it('a warning chip is the one amber pill: NoticeChip’s class, not a copy (spec/appearance#component-details)', () => {
	const html = renderToStaticMarkup(<Chip tone="warning">Reviewer</Chip>);
	expect(notice.chip).toBeTruthy();
	expect(html).toContain(`class="${notice.chip} "`);
	expect(renderToStaticMarkup(<Chip>kit</Chip>)).toContain(`class="${controls.chip} "`);
	expect(readFileSync(new URL('./Controls.module.css', import.meta.url), 'utf8')).not.toMatch(
		/\.chip\[data-tone='warning'\]/
	);
});

it('only a glyph chip asks to be square (spec/crew-templates-and-editor#editor-inspector); a chip with text and a glyph keeps its padding', () => {
	expect(attrs(renderToStaticMarkup(<Chip square>+</Chip>)).square).toBe('true');
	expect(
		attrs(renderToStaticMarkup(<Chip tone="warning">Reviewer ×</Chip>)).square
	).toBeUndefined();
});

it('a disclosure Button marks itself, so an open «Setup log» keeps its rest look (spec/tasks#worktree-preparation)', () => {
	const open = attrs(
		renderToStaticMarkup(
			<Button disclosure aria-expanded>
				Setup log
			</Button>
		)
	);
	expect(open).toMatchObject({ disclosure: 'true', variant: 'soft' });
	expect(
		attrs(renderToStaticMarkup(<Button aria-expanded>Menu</Button>)).disclosure
	).toBeUndefined();
	expect(readFileSync(new URL('./Controls.module.css', import.meta.url), 'utf8')).toMatch(
		/\.button\.button\[data-disclosure\]\[data-variant='soft'\]\[aria-expanded='true'\]\s*\{[^}]*background-color: var\(--ap-soft, var\(--tint\)\)/
	);
});

it('an open ghost disclosure and a ghost that opens a popover are out of the selected look (spec/appearance#component-details)', () => {
	expect(
		attrs(
			renderToStaticMarkup(
				<Button variant="ghost" disclosure aria-expanded>
					Details
				</Button>
			)
		)
	).toMatchObject({ disclosure: 'true', variant: 'ghost' });
	expect(
		attrs(
			renderToStaticMarkup(
				<Button variant="ghost" opensPopover aria-expanded>
					Limits
				</Button>
			)
		)
	).toMatchObject({ 'opens-popover': 'true', variant: 'ghost' });
	expect(
		attrs(renderToStaticMarkup(<Button aria-expanded>Menu</Button>))['opens-popover']
	).toBeUndefined();
	// Comments out and whitespace squashed, so the checks survive formatting.
	const css = readFileSync(new URL('./Controls.module.css', import.meta.url), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\s+/g, ' ')
		.replace(/\( /g, '(')
		.replace(/ \)/g, ')');
	// The selected rules skip both; the popover's ghost holds the hover fill.
	expect(css).toContain(
		".button[aria-expanded='true']:where(:not([data-disclosure], [data-opens-popover])),"
	);
	expect(css).toContain(
		".button.button[data-variant='ghost'][aria-expanded='true']:not(:disabled, [data-disclosure], [data-opens-popover]),"
	);
	expect(css).not.toMatch(
		/\.button(\.button\[data-variant='ghost'\])?\[aria-expanded='true'\](:not\(:disabled\))?,/
	);
	expect(css).toMatch(
		/\.button\.button\[data-opens-popover\]\[data-variant='ghost'\]\[aria-expanded='true'\]:not\(:disabled\)\s*\{[^}]*background-color: var\(--ap-soft, var\(--tint\)\)/
	);
});

/**
 * tokens.css as rules, so the checks survive formatting: comments dropped, quotes and spaces
 * normalised in selectors and values; `media` is the enclosing at-rule prelude, if any.
 */
type CssRule = { media: string | null; selectors: string[]; decls: Map<string, string> };
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const parseCss = (css: string) => {
	const rules: CssRule[] = [];
	const walk = (source: string, media: string | null) => {
		let index = 0;
		while (index < source.length) {
			const open = source.indexOf('{', index);
			if (open < 0) return;
			const prelude = squash(source.slice(index, open));
			let depth = 1,
				close = open + 1;
			for (; close < source.length && depth; close++)
				depth += source[close] === '{' ? 1 : source[close] === '}' ? -1 : 0;
			const body = source.slice(open + 1, close - 1);
			if (prelude.startsWith('@')) walk(body, prelude);
			else
				rules.push({
					media,
					selectors: prelude.split(',').map((selector) => squash(selector.replace(/['"]/g, ''))),
					decls: new Map(
						body
							.split(';')
							.map((decl) => decl.split(/:(.*)/s))
							.filter((pair) => pair.length > 1)
							.map(([name, value]) => [squash(name!), squash(value!).toLowerCase()])
					),
				});
			index = close;
		}
	};
	walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), null);
	return rules;
};
const tokenRules = () => parseCss(readFileSync(new URL('../tokens.css', import.meta.url), 'utf8'));
/** The value `name` gets in the rule whose selector list is exactly `selectors`. */
const declared = (
	rules: CssRule[],
	selectors: string[],
	name: string,
	media: (prelude: string | null) => boolean = (prelude) => prelude === null
) =>
	rules
		.find(
			(rule) =>
				media(rule.media) &&
				rule.selectors.length === selectors.length &&
				selectors.every((selector) => rule.selectors.includes(selector)) &&
				rule.decls.has(name)
		)
		?.decls.get(name);

it('tokens.css publishes one rising height per size, none under the 24 px target (spec/appearance#control-scale, rule 16)', () => {
	const rules = tokenRules();
	const heights = (['s', 'm', 'l', 'xl'] as const).map((size) => {
		expect(declared(rules, [`[data-size=${size}]`], '--c-h'), size).toBe(
			`var(--control-h-${size})`
		);
		const value = declared(rules, [':root'], `--control-h-${size}`);
		expect(value, size).toMatch(/^\d+px$/);
		return parseInt(value!, 10);
	});
	expect(heights[0]).toBeGreaterThanOrEqual(24);
	expect(heights).toEqual([...heights].sort((a, b) => a - b));
	expect(new Set(heights).size).toBe(heights.length);
	expect(rules.some((rule) => [...rule.decls.keys()].includes('--input-height'))).toBe(false);
	expect(
		rules.some(
			(rule) =>
				rule.selectors.some((selector) => /(^| )button$/.test(selector)) &&
				rule.decls.get('min-height') === '24px'
		)
	).toBe(false);
});

it('filled warning and danger keep 4.5:1 in both themes (spec/appearance#control-scale)', () => {
	const rules = tokenRules();
	const luminance = (hex: string, alpha = 1, under = [255, 255, 255]) => {
		const [r, g, b] = [1, 3, 5].map((i, k) => {
			const channel = parseInt(hex.slice(i, i + 2), 16) * alpha + under[k]! * (1 - alpha);
			const value = channel / 255;
			return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	};
	const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	const token = (name: string, theme: 'light' | 'dark' | 'hc-light' | 'hc-dark') => {
		const selectors = theme.endsWith('light')
			? [':root', '[data-palette=light]']
			: [':root[data-theme=dark]', '[data-palette=dark]'];
		const value = declared(rules, selectors, `--${name}`, (media) =>
			theme.startsWith('hc-')
				? squash(media ?? '').replace(/\s/g, '') === '@media(prefers-contrast:more)'
				: media === null
		);
		return value && /^#[0-9a-f]{6}$/.test(value) ? value : undefined;
	};
	for (const [theme, amberText, redText] of [
		['light', '#ffffff', '#ffffff'],
		['dark', null, '#ffffff'],
		['hc-light', '#ffffff', '#ffffff'],
		['hc-dark', null, '#ffffff'],
	] as const) {
		const amber = token('amber-fill', theme),
			red = token('red-fill', theme);
		expect(amber, `amber-fill ${theme}`).toBeTruthy();
		expect(red, `red-fill ${theme}`).toBeTruthy();
		const amberOn = amberText
			? luminance(amberText)
			: luminance('#000000', 0.85, [...[1, 3, 5].map((i) => parseInt(amber!.slice(i, i + 2), 16))]);
		expect(ratio(luminance(amber!), amberOn), `warning ${theme}`).toBeGreaterThanOrEqual(4.5);
		expect(ratio(luminance(red!), luminance(redText)), `danger ${theme}`).toBeGreaterThanOrEqual(
			4.5
		);
	}
});

it('tokens.css defines the theme tokens in light and dark, one soft --sel and self-contained font stacks (spec/appearance#evolution-redesign)', () => {
	// The invariant only: the exact theme values are a design choice and may change.
	const rules = tokenRules(),
		light = [':root', '[data-palette=light]'],
		dark = [':root[data-theme=dark]', '[data-palette=dark]'],
		value = (selectors: string[], name: string) =>
			declared(rules, selectors, name)
				?.replace(/\s/g, '')
				.replace(/([(,])0\./g, '$1.');
	for (const name of [
		'--fg2',
		'--fg3',
		'--amber',
		'--amber-soft',
		'--hover',
		'--tint2',
		'--sel-opacity',
	])
		expect(value(light, name), `light ${name}`).toBeTruthy();
	for (const name of ['--fg2', '--fg3', '--tint2', '--sel-opacity'])
		expect(value(dark, name), `dark ${name}`).toBeTruthy();
	// --sel is the soft accent; a named accent does not pin it to a solid fill.
	expect(value([':root', '[data-palette]'], '--sel')).toBe(
		'color-mix(insrgb,var(--accent)var(--sel-opacity),transparent)'
	);
	expect(rules.filter((rule) => rule.decls.has('--sel')).length).toBe(1);
	// A family token never refers to itself and falls back to the OS stacks.
	for (const name of ['--ui-family', '--mono-family']) {
		const stack = value([':root'], name)!.replace(/['"]/g, '').toLowerCase();
		expect(stack, name).not.toContain('var(');
		expect(stack.split(',').length, name).toBeGreaterThan(1);
	}
});
