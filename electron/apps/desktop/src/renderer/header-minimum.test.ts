import { describe, expect, it } from 'vitest';
import { headerNeed } from './header-minimum';

describe('headerNeed (spec/diff-and-review#changes-header)', () => {
	it('adds paddings, gaps and controls; a flexible slot counts what stands in it', () => {
		// History: the view switch, Merge… in its slot, the search toggle.
		expect(
			headerNeed({
				padding: 16,
				gap: 6,
				items: [{ width: 163 }, { inner: [73], gap: 6 }, { width: 28 }],
			})
		).toBe(16 + 163 + 73 + 28 + 12);
	});
	it('an empty spacer still takes its gap, and fractions round up', () => {
		expect(
			headerNeed({
				padding: 12,
				gap: 4,
				items: [
					{ width: 162.4 },
					{ inner: [], gap: 0 },
					{ width: 28 },
					{ inner: [28, 28], gap: 6 },
				],
			})
		).toBe(Math.ceil(12 + 162.4 + 0 + 28 + 62 + 12));
	});
});
