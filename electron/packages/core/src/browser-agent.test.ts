import { describe, expect, it } from 'vitest';
import {
	browserActLabel,
	browserElements,
	browserKey,
	findBrowserElement,
	formatBrowserUi,
	isBrowserActRequest,
	sensitiveField,
	type AxNode,
} from './browser-agent';
import { isBrowserCommand } from './browser';
import { mcpRow } from './mcp-tools';
import type { ToolPatch } from './agent';
const claude = (tool: string, input: unknown, output: string): ToolPatch => ({
	id: 'c',
	name: `mcp__brigadir__${tool}`,
	title: `mcp__brigadir__${tool}`,
	category: 'other',
	status: 'completed',
	input: JSON.stringify(input),
	content: [{ kind: 'text', text: output }],
});

describe('spec/browser-and-simulator#browser-ui-act browser_act', () => {
	it('accepts one action with its target and refuses the rest', () => {
		expect(isBrowserActRequest({ action: 'click', ref: '@e12' })).toBe(true);
		expect(
			isBrowserActRequest({ action: 'type', selector: '#q', text: 'pizza', submit: true })
		).toBe(true);
		expect(isBrowserActRequest({ action: 'scroll', dy: -400 })).toBe(true);
		expect(isBrowserActRequest({ action: 'click', count: 3 })).toBe(false);
		expect(isBrowserActRequest({ action: 'drag' })).toBe(false);
		expect(isBrowserActRequest({ action: 'click', ref: '12' })).toBe(false);
		expect(isBrowserCommand({ kind: 'act', action: 'back' })).toBe(true);
		expect(isBrowserCommand({ kind: 'ui', offset: 150 })).toBe(true);
		expect(isBrowserCommand({ kind: 'ui', selector: 'x' })).toBe(false);
	});
	it('turns key names and combinations into CDP key events', () => {
		expect(browserKey('Enter')).toEqual({
			key: 'Enter',
			code: 'Enter',
			keyCode: 13,
			modifiers: 0,
			text: '\r',
		});
		expect(browserKey('esc')).toMatchObject({ key: 'Escape', keyCode: 27 });
		expect(browserKey('Shift+Tab')).toEqual({ key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 8 });
		expect(browserKey('Meta+A')).toEqual({
			key: 'a',
			code: 'KeyA',
			keyCode: 65,
			modifiers: 4,
			commands: ['selectAll'],
		});
		expect(browserKey('a')).toEqual({
			key: 'a',
			code: 'KeyA',
			keyCode: 65,
			modifiers: 0,
			text: 'a',
		});
		expect(browserKey('F5')).toMatchObject({ key: 'F5', keyCode: 116 });
		expect(browserKey('Hyper+A')).toBeNull();
		expect(browserKey('Enterprise')).toBeNull();
	});
	it('keeps the controls and names of the tree and formats them a line each', () => {
		const nodes: AxNode[] = [
			{ role: { value: 'RootWebArea' }, name: { value: 'Shop' }, backendDOMNodeId: 1 },
			{ role: { value: 'heading' }, name: { value: 'Cart' }, backendDOMNodeId: 2 },
			{ role: { value: 'StaticText' }, name: { value: 'Total' }, backendDOMNodeId: 3 },
			{
				role: { value: 'button' },
				name: { value: '  Pay   now ' },
				backendDOMNodeId: 4,
				properties: [
					{ name: 'focused', value: { value: true } },
					{ name: 'disabled', value: { value: false } },
				],
			},
			{
				role: { value: 'checkbox' },
				name: { value: 'Gift' },
				backendDOMNodeId: 5,
				properties: [{ name: 'checked', value: { value: 'true' } }],
			},
			{
				role: { value: 'textbox' },
				name: { value: 'Coupon' },
				value: { value: 'SPRING' },
				backendDOMNodeId: 6,
			},
			{
				role: { value: 'generic' },
				name: { value: 'Open menu' },
				backendDOMNodeId: 7,
				properties: [{ name: 'focusable', value: { value: true } }],
			},
			{ role: { value: 'img' }, name: { value: '' }, backendDOMNodeId: 8 },
			{ role: { value: 'button' }, name: { value: 'Hidden' }, backendDOMNodeId: 9, ignored: true },
		];
		const elements = browserElements(nodes);
		expect(elements.map((element) => element.ref)).toEqual([2, 4, 5, 6, 7]);
		const boxes: Record<number, [number, number, number, number]> = {
			2: [10, 10, 200, 30],
			4: [10, 900, 80, 32],
			5: [10, 50, 20, 20],
			6: [40, 50, 100, 24],
			7: [0, 0, 0, 0],
		};
		expect(
			formatBrowserUi(
				{ width: 800, height: 600, scrollX: 0, scrollY: 0, pageWidth: 800, pageHeight: 1600 },
				elements.map((element) => ({ ...element, box: boxes[element.ref]! })),
				elements.length
			)
		).toBe(
			[
				'Viewport 800×600 px, scrolled 0,0 of 800×1600 · 5 elements',
				'heading "Cart" @e2 10,10 200×30',
				'button "Pay now" @e4 10,900 80×32 focused offscreen',
				'checkbox "Gift" @e5 10,50 20×20 checked',
				'textbox "Coupon" = "SPRING" @e6 40,50 100×24',
				'clickable "Open menu" @e7 hidden',
			].join('\n')
		);
		expect(findBrowserElement(elements, 'pay')?.ref).toBe(4);
		expect(findBrowserElement(elements, 'cart')?.ref).toBe(2);
	});
	it('pages a long tree', () => {
		const elements = Array.from({ length: 200 }, (_, index) => ({
			ref: index + 1,
			role: 'link',
			name: `Item ${index}`,
			states: [],
			box: [0, index * 20, 100, 20] as [number, number, number, number],
		}));
		const text = formatBrowserUi(
			{ width: 800, height: 600, scrollX: 0, scrollY: 0, pageWidth: 800, pageHeight: 4000 },
			elements.slice(0, 150),
			200
		);
		expect(text.split('\n').at(-1)).toBe('… 50 more: call again with offset 150');
	});
	it('never fills passwords, one-time codes or payment cards', () => {
		expect(sensitiveField({ tag: 'INPUT', type: 'password' })).toBe(true);
		expect(sensitiveField({ tag: 'input', type: 'text', autocomplete: 'one-time-code' })).toBe(
			true
		);
		expect(sensitiveField({ tag: 'input', autocomplete: 'billing cc-number' })).toBe(true);
		expect(sensitiveField({ tag: 'input', type: 'email', autocomplete: 'username' })).toBe(false);
		expect(sensitiveField({ tag: 'textarea', type: 'password' })).toBe(false);
	});
	it('labels the ring with the action and its target', () => {
		expect(browserActLabel({ action: 'click' }, 'button "Save"')).toBe('click · button "Save"');
		expect(browserActLabel({ action: 'click', count: 2, ref: 'e4' }, null)).toBe(
			'double-click · @e4'
		);
		expect(browserActLabel({ action: 'scroll' }, null)).toBe('scroll');
	});
	it('shows the action and its target in the chat log', () => {
		const row = mcpRow(
			'uk',
			claude('browser_act', { action: 'click', label: 'Зберегти' }, 'Clicked button "Зберегти".'),
			'done'
		)!;
		expect(row.title).toBe('Клікнув');
		expect(row.detail).toEqual([{ kind: 'code', text: 'Зберегти' }]);
		expect(
			mcpRow(
				'en',
				claude(
					'browser_ui',
					{},
					'Viewport 800×600 px, scrolled 0,0 of 800×600 · 12 elements\nbutton "A" @e1'
				),
				'done'
			)!.detail
		).toEqual([{ kind: 'text', text: '12 elements' }]);
	});
});
