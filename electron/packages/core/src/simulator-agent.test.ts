import { expect, it } from 'vitest';
import {
	findElement,
	formatUi,
	isSimulatorAgentCommand,
	type SimulatorUi,
} from './simulator-agent';
const ui: SimulatorUi = {
	width: 402,
	height: 874,
	elements: [
		{ role: 'Text', label: 'Order #4821', id: 'order-4821', frame: [12, 126, 200, 20] },
		{ role: 'Button', label: 'Take order', id: 'take-order', frame: [12, 622.4, 378, 48] },
		{ role: 'Button', label: 'Take order later', id: '', frame: [12, 700, 378, 48] },
		{
			role: 'TextField',
			label: 'Comment',
			id: 'comment',
			frame: [12, 760, 378, 40],
			value: 'ring twice',
		},
	],
};
it('prints the accessibility tree one element a line, in points, with a page hint (spec/browser-and-simulator#simulator)', () => {
	expect(formatUi(ui)).toBe(
		'Screen 402×874 pt · 4 elements\nText "Order #4821" #order-4821 12,126 200×20\nButton "Take order" #take-order 12,622 378×48\nButton "Take order later" 12,700 378×48\nTextField "Comment" = "ring twice" #comment 12,760 378×40'
	);
	const long: SimulatorUi = {
		...ui,
		elements: Array.from({ length: 160 }, (_, index) => ({
			role: 'Cell',
			label: `Row ${index}`,
			id: '',
			frame: [0, index * 44, 402, 44] as [number, number, number, number],
		})),
	};
	const first = formatUi(long).split('\n');
	expect(first).toHaveLength(152);
	expect(first.at(-1)).toBe('… 10 more: call again with offset 150');
	expect(formatUi(long, 150).split('\n').slice(1)).toHaveLength(10);
});
it('finds a target by testID, then by exact label, then by a label that contains the text', () => {
	expect(findElement(ui, { id: 'take-order' })?.label).toBe('Take order');
	expect(findElement(ui, { id: 'take' })).toBeNull();
	expect(findElement(ui, { label: 'take order' })?.id).toBe('take-order');
	expect(findElement(ui, { label: 'later' })?.label).toBe('Take order later');
});
it('checks the agent commands main accepts', () => {
	for (const command of [
		{ tool: 'state' },
		{
			tool: 'open',
			device: 'iPhone 17 Pro',
			app: 'com.example.couriers',
			url: 'exp+couriers://x',
		},
		{ tool: 'ui', offset: 150 },
		{ tool: 'act', action: 'tap', id: 'take-order' },
		{ tool: 'act', action: 'swipe', x: 10, y: 600, x2: 10, y2: 100 },
		{ tool: 'screenshot' },
	])
		expect(isSimulatorAgentCommand(command), JSON.stringify(command)).toBe(true);
	for (const command of [
		{ tool: 'shell' },
		{ tool: 'open', app: 'a b' },
		{ tool: 'open', url: 'no scheme' },
		{ tool: 'act', action: 'drag' },
		{ tool: 'act', action: 'tap', x: -1, y: 0 },
		{ tool: 'ui', offset: -1 },
	])
		expect(isSimulatorAgentCommand(command), JSON.stringify(command)).toBe(false);
});
