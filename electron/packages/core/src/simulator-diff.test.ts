import { expect, it } from 'vitest';
import type { SimulatorElement, SimulatorUi } from './simulator-agent';
import { describeWaitTarget, diffUi, findWaitTarget, formatUiDiff } from './simulator-diff';
const el = (
	role: string,
	label: string,
	id: string,
	frame: [number, number, number, number],
	value?: string
): SimulatorElement => ({ role, label, id, frame, ...(value ? { value } : {}) });
const screen = (...elements: SimulatorElement[]): SimulatorUi => ({
	width: 402,
	height: 874,
	elements,
});
const before = screen(
	el('Application', 'Couriers', '', [0, 0, 402, 874]),
	el('Other', '', '', [0, 0, 402, 874]),
	el('Text', 'Order #4821', 'order', [12, 126, 200, 20]),
	el('Button', 'Take order', 'take-order', [12, 622, 378, 48]),
	el('TextField', 'Comment', 'comment', [12, 760, 378, 40]),
	el('Text', 'Count: 1', '', [12, 300, 100, 20]),
	el('Cell', 'Row', '', [0, 400, 402, 44]),
	el('Cell', 'Row', '', [0, 444, 402, 44])
);
it('lists what appeared, disappeared and changed, counts what moved and leaves anonymous elements out (spec/browser-and-simulator#sim-act-settle)', () => {
	const after = screen(
		el('Application', 'Couriers', '', [0, 0, 402, 874]),
		el('Other', '', '', [0, 100, 402, 774]),
		el('Text', 'Order #4821', 'order', [12, 126, 200, 20]),
		el('Text', 'Order taken', 'status', [12, 622, 378, 48]),
		el('TextField', 'Comment', 'comment', [12, 760, 378, 40], 'ring twice'),
		el('Text', 'Count: 2', '', [12, 300, 100, 20]),
		el('Cell', 'Row', '', [0, 300, 402, 44]),
		el('Cell', 'Row', '', [0, 344, 402, 44])
	);
	const diff = diffUi(before, after);
	expect(diff.added.map((e) => e.id)).toEqual(['status']);
	expect(diff.removed.map((e) => e.id)).toEqual(['take-order']);
	expect(diff.changed.map((c) => c.after.label)).toEqual(['Comment', 'Count: 2']);
	expect(diff.moved).toBe(2);
	expect(formatUiDiff(diff)).toBe(
		[
			'Changes: 1 appeared, 1 disappeared, 2 changed.',
			'~ TextField "Comment" = "ring twice" #comment 12,760 378×40 (was no value)',
			'~ Text "Count: 2" 12,300 100×20 (was "Count: 1")',
			'+ Text "Order taken" #status 12,622 378×48',
			'- Button "Take order" #take-order 12,622 378×48',
			'2 elements moved',
		].join('\n')
	);
});
it('says when nothing changed, and an element found by testID keeps its identity across a new label (spec/browser-and-simulator#sim-act-settle)', () => {
	expect(formatUiDiff(diffUi(before, before))).toBe('No changes in the accessibility tree.');
	const renamed = screen(el('Button', 'Taking…', 'take-order', [12, 622, 378, 48], 'busy'));
	const diff = diffUi(screen(before.elements[3]!), renamed);
	expect(diff).toMatchObject({ added: [], removed: [], moved: 0 });
	expect(formatUiDiff(diff)).toBe(
		'Changes: 0 appeared, 0 disappeared, 1 changed.\n~ Button "Taking…" = "busy" #take-order 12,622 378×48 (was "Take order" no value)'
	);
});
it('stops at 32 KiB with a truncated marker that says how many changes are left (spec/architecture-and-platform#perf-agent-responses)', () => {
	const many = screen(
		...Array.from({ length: 2000 }, (_, index) =>
			el('Cell', `A long row label number ${index} with some more words`, `row-${index}`, [
				0,
				index * 44,
				402,
				44,
			])
		)
	);
	const text = formatUiDiff(diffUi(screen(), many));
	expect(text.length).toBeLessThanOrEqual(32 * 1024);
	const lines = text.split('\n');
	const shown = lines.filter((line) => line.startsWith('+ ')).length;
	expect(shown).toBeGreaterThan(100);
	expect(lines.at(-1)).toBe(
		`… truncated: ${2000 - shown} more changes. Call simulator_ui for the whole screen.`
	);
	expect(lines[0]).toBe('Changes: 2000 appeared, 0 disappeared, 0 changed.');
});
it('a new testID in the same place is a removal and an addition; only elements without one merge by role and frame', () => {
	const diff = diffUi(
		screen(
			el('Button', 'Log in', 'login', [12, 622, 378, 48]),
			el('Text', 'Guest', '', [12, 100, 200, 20])
		),
		screen(
			el('Button', 'Log out', 'logout', [12, 622, 378, 48]),
			el('Text', 'Andy', '', [12, 100, 200, 20])
		)
	);
	expect(diff.added.map((e) => e.id)).toEqual(['logout']);
	expect(diff.removed.map((e) => e.id)).toEqual(['login']);
	expect(diff.changed.map((c) => `${c.before.label} → ${c.after.label}`)).toEqual(['Guest → Andy']);
});
it('counts the 32 KiB in UTF-8 bytes, the truncated marker included (spec/architecture-and-platform#perf-agent-responses)', () => {
	const many = screen(
		...Array.from({ length: 2000 }, (_, index) =>
			el('Text', `Замовлення номер ${index}: доставка кур'єром до дверей`, `row-${index}`, [
				0,
				index * 44,
				402,
				44,
			])
		)
	);
	const text = formatUiDiff(diffUi(screen(), many));
	expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(32 * 1024);
	// Cyrillic is two bytes a letter: counted in UTF-16 units, the same lines would pass 32 KiB.
	expect(text.length).toBeLessThan(28 * 1024);
	expect(text.split('\n').at(-1)).toMatch(/^… truncated: \d+ more changes\./);
	for (const max of [300, 301, 302, 400, 1000]) {
		const small = formatUiDiff(diffUi(screen(), many), max);
		expect(new TextEncoder().encode(small).length, String(max)).toBeLessThanOrEqual(max);
	}
});
it('finds what simulator_wait waits for: text in a label or value, a testID, a label (spec/browser-and-simulator#sim-wait)', () => {
	const ui = screen(
		el('Button', 'Take order', 'take-order', [12, 622, 378, 48]),
		el('TextField', 'Comment', 'comment', [12, 760, 378, 40], 'Ring Twice')
	);
	expect(findWaitTarget(ui, { text: 'ring twice' })?.id).toBe('comment');
	expect(findWaitTarget(ui, { text: 'ORDER' })?.id).toBe('take-order');
	expect(findWaitTarget(ui, { id: 'comment' })?.label).toBe('Comment');
	expect(findWaitTarget(ui, { label: 'take' })?.id).toBe('take-order');
	expect(findWaitTarget(ui, { text: 'saved' })).toBeNull();
	expect(describeWaitTarget({ id: 'spinner' })).toBe('#spinner');
	expect(describeWaitTarget({ label: 'Save' })).toBe('label "Save"');
	expect(describeWaitTarget({ text: 'Saved' })).toBe('text "Saved"');
});
