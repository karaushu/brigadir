import { expect, it } from 'vitest';
import { fitRetry, fitStart, fitStep } from './fit-row';

it('takes the narrow look exactly when the wide header overflows and comes back at the width it needs (spec/appearance#evolution-redesign)', () => {
	// 700 px: the wide header fits.
	let state = fitStep(fitStart, 700, 0);
	expect(state).toBe(fitStart);
	// 650 px: «Merge PR…» runs 21 px into the padding — narrow, and the header needs 671.
	state = fitStep(state, 650, 21);
	expect(state).toEqual({ narrow: true, need: 671, below: false });
	// Narrow, the wide row cannot be measured: it stays narrow until the box reaches the need.
	expect(fitStep(state, 670, null)).toBe(state);
	state = fitStep(state, 671, null);
	expect(state.narrow).toBe(false);
	// Wide again and fitting: nothing changes.
	expect(fitStep(state, 671, 0)).toBe(state);
});

it('measures the need again when the content changes while narrow', () => {
	const narrow = fitStep(fitStart, 650, 21);
	const retried = fitRetry(narrow);
	expect(retried.narrow).toBe(false);
	// A merged PR without «Start review»: the shorter header fits at 650.
	expect(fitStep(retried, 650, 0)).toBe(retried);
	expect(fitRetry(fitStart)).toBe(fitStart);
});

it('reports a box under the caller width apart from the row (the cards in a column)', () => {
	const state = fitStep(fitStart, 600, 0, 640);
	expect(state).toEqual({ narrow: false, need: 0, below: true });
	expect(fitStep(state, 640, 0, 640).below).toBe(false);
});
