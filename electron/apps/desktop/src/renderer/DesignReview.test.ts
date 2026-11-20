import { expect, it } from 'vitest';
import { pairAspect } from './DesignReview';

it('a Figma | Device pair stands at one scale: one width bounded by the narrower ratio (spec/design-review#card)', () => {
	// The live case: a 383×104 Figma header beside the same node cropped from a 463×1000 screenshot (area 0.92×0.095).
	const figma = { width: 383, height: 104 },
		shot = { width: 463, height: 1000 },
		area = { x: 0.04, y: 0.226, width: 0.92, height: 0.095 };
	const aspect = pairAspect(figma, shot, area)!;
	expect(aspect).toBeCloseTo(383 / 104, 5);
	// Both images take the width `aspect × 86` (or the tile's), so neither is drawn smaller than the other.
	const width = aspect * 86;
	expect(width / (383 / 104)).toBeLessThanOrEqual(86);
	expect(width / ((0.92 * 463) / (0.095 * 1000))).toBeLessThanOrEqual(86);
	// A tall crop bounds the width instead.
	expect(pairAspect(figma, shot, { x: 0, y: 0, width: 0.5, height: 0.5 })).toBeCloseTo(
		463 / 1000,
		5
	);
	// The whole screenshot without an area.
	expect(pairAspect({ width: 390, height: 844 }, shot)).toBeCloseTo(390 / 844, 5);
	// A missing image: each tile fits on its own.
	expect(pairAspect(null, shot, area)).toBeNull();
	expect(pairAspect(figma, null, area)).toBeNull();
});
