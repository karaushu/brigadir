import { describe, expect, it } from 'vitest';
import {
	RAIL,
	markWidth,
	railBand,
	railHit,
	railLayout,
	railOffset,
	railTime,
	railY,
	turnStep,
	visibleTurns,
} from './turn-rail';

describe('railLayout', () => {
	it('keeps the 7 px step while the rail fits and centres nothing itself', () => {
		const layout = railLayout(10, 520, null);
		expect(layout.sizes.every((size) => size === RAIL.pitch)).toBe(true);
		expect(layout.total).toBe(70);
		expect(layout.tops[3]).toBe(21);
	});
	it('shrinks the step evenly when the marks do not fit, with no lower bound', () => {
		expect(railLayout(160, 520, null).total).toBeCloseTo(520);
		expect(railLayout(1000, 520, null).sizes[0]).toBeCloseTo(0.52);
	});
	it('magnifies around the focus to about 10 px and never grows past the height', () => {
		const dense = railLayout(160, 520, 60);
		expect(dense.total).toBeLessThanOrEqual(520.0001);
		expect(dense.sizes[60]).toBeGreaterThan(8.5);
		expect(dense.sizes[60]).toBeLessThan(11);
		expect(dense.sizes[0]).toBeLessThan(railLayout(160, 520, null).sizes[0]!);
		const sparse = railLayout(40, 520, 4);
		expect(sparse.sizes[4]).toBeGreaterThan(RAIL.pitch);
		expect(sparse.sizes[30]).toBeCloseTo(RAIL.pitch, 3);
	});
	it('maps a pointer position back to the mark drawn there', () => {
		const layout = railLayout(20, 520, 5);
		expect(railHit(layout, layout.tops[5]! + 0.5)).toBe(5);
		expect(railHit(layout, -3)).toBe(0);
		expect(railHit(layout, 9999)).toBe(19);
		expect(railHit(railLayout(0, 520, null), 10)).toBeNull();
	});
});

describe('visibleTurns', () => {
	it('counts a turn from its prompt to the next prompt', () => {
		// prompts at 0, 500, 1200; content ends at 2000; viewport 600..1000 shows only the second turn
		expect([...visibleTurns([0, 500, 1200], 600, 400, 2000)]).toEqual([1]);
		expect([...visibleTurns([0, 500, 1200], 1100, 400, 2000)].sort()).toEqual([1, 2]);
		expect([...visibleTurns([0, undefined, 1200], 100, 100, 2000)]).toEqual([0]);
	});
});

describe('turnStep', () => {
	const starts = [0, 500, 1200, 1900];
	it('goes to the nearest prompt above the top and the first below it', () => {
		expect(turnStep(starts, 500, 3000, -1)).toBe(0);
		expect(turnStep(starts, 700, 3000, -1)).toBe(1);
		expect(turnStep(starts, 0, 3000, -1)).toBeNull();
		expect(turnStep(starts, 500, 3000, 1)).toBe(2);
		expect(turnStep(starts, 0, 3000, 1)).toBe(1);
	});
	it('treats a prompt the view cannot scroll to as the end', () => {
		expect(turnStep(starts, 1200, 1600, 1)).toBe('end');
		expect(turnStep(starts, 1900, 3000, 1)).toBe('end');
	});
});

describe('railTime', () => {
	it('shows only the time today and date · time on another day', () => {
		const now = new Date(2026, 8, 25, 15, 0);
		expect(railTime(new Date(2026, 8, 25, 14, 32).toISOString(), now)).toBe('14:32');
		expect(railTime(new Date(2026, 8, 24, 18, 33).toISOString(), now)).toBe('24.09.2026 · 18:33');
	});
});

describe('markWidth', () => {
	it('is 8 px at rest, 12 on screen, 18 in focus, and the lens lengthens neighbours by up to 8', () => {
		expect(markWidth('rest', false, 0)).toBe(8);
		expect(markWidth('shown', true, 0)).toBe(12);
		expect(markWidth('active', true, 1)).toBe(18);
		expect(markWidth('rest', false, 0.5)).toBe(12);
		expect(markWidth('running', true, 0)).toBe(12);
	});
});

describe('spec/chat-turns-plans-and-questions#rail-scrollbar: the rail is the scrollbar', () => {
	// Four turns: 0–100, 100–400, 400–500, 500–1000; cells of 7 px each.
	const starts = [0, 100, 400, 500],
		end = 1000,
		layout = railLayout(4, 400, null);
	it('maps a scroll offset into its turn cell and back', () => {
		expect(railY(starts, end, layout, 0)).toBe(0);
		expect(railY(starts, end, layout, 250)).toBeCloseTo(7 + 3.5);
		expect(railY(starts, end, layout, 1000)).toBe(28);
		for (const y of [0, 50, 250, 420, 750, 1000])
			expect(railOffset(starts, end, layout, railY(starts, end, layout, y))).toBeCloseTo(y);
	});
	it('a band spans the viewport, never thinner than 6 px', () => {
		expect(railBand(starts, end, layout, 100, 400)).toEqual({ top: 7, height: 14 });
		const thin = railBand(starts, end, layout, 600, 50);
		expect(thin.height).toBe(6);
		expect(thin.top).toBeGreaterThanOrEqual(0);
		expect(thin.top + thin.height).toBeLessThanOrEqual(28);
	});
	it('content above the first prompt is the rail top; an unmeasured start takes the one before it', () => {
		expect(railY([200, 300], 400, railLayout(2, 400, null), 100)).toBe(0);
		expect(railY([0, undefined, 300], 400, railLayout(3, 400, null), 150)).toBeCloseTo(7 + 3.5);
	});
});

describe('pointer on a dense rail (from the turn-rail e2e)', () => {
	const rest = railLayout(160, 520, null);
	it('hit-tests against the rest layout: the lens under a still pointer, or a 1 px move, keeps the same mark', () => {
		const y = rest.tops[80]! + rest.sizes[80]! / 2;
		expect(railHit(rest, y)).toBe(80);
		expect(railHit(rest, y + 0.5)).toBe(80);
		expect(railHit(rest, y - 0.5)).toBe(80);
		// The lens grows the mark in focus, but the rail stays inside its room.
		const lens = railLayout(160, 520, 80);
		expect(lens.sizes[80]!).toBeGreaterThan(rest.sizes[80]!);
		expect(lens.total).toBeLessThanOrEqual(520.0001);
	});
	it('spec/chat-turns-plans-and-questions#rail-scrollbar: the band on the rail is at least 20 px tall and stays on the rail', () => {
		const starts = Array.from({ length: 160 }, (_, i) => i * 300),
			end = 160 * 300;
		for (const top of [0, 12_000, end - 600]) {
			const band = railBand(starts, end, rest, top, 600, 20);
			expect(band.height).toBeGreaterThanOrEqual(20);
			expect(band.top).toBeGreaterThanOrEqual(0);
			expect(band.top + band.height).toBeLessThanOrEqual(rest.total + 0.0001);
		}
	});
	it('the view at the end shows the last turn and not the first', () => {
		const starts = Array.from({ length: 24 }, (_, i) => i * 300),
			shown = visibleTurns(starts, 24 * 300 - 600, 600, 24 * 300);
		expect(shown.has(23)).toBe(true);
		expect(shown.has(0)).toBe(false);
	});
});
