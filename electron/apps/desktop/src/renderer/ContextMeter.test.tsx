import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextMeter } from './ContextMeter';
// The share, its tone and when the meter is not shown at all.
const meter = (used: number, capacity: number) => {
	const html = renderToStaticMarkup(<ContextMeter used={used} capacity={capacity} locale="en" />);
	return {
		html,
		label: /aria-label="(Context: [^"]*)"/.exec(html)?.[1] ?? null,
		tone: /data-tone="([^"]*)"/.exec(html)?.[1] ?? null,
	};
};
it('shows the share of the context with a tone: normal to 70%, warning to 90%, danger above and past 100%', () => {
	expect(
		[
			meter(0, 200000),
			meter(82400, 200000),
			meter(140000, 200000),
			meter(142000, 200000),
			meter(180000, 200000),
			meter(182000, 200000),
			meter(210000, 200000),
		].map(({ label, tone }) => [label, tone])
	).toEqual([
		['Context: 0%', 'normal'],
		['Context: 41%', 'normal'],
		['Context: 70%', 'normal'],
		['Context: 71%', 'warning'],
		['Context: 90%', 'warning'],
		['Context: 91%', 'danger'],
		['Context: 105%', 'danger'],
	]);
	expect(meter(82400, 200000).html).toContain('aria-haspopup="dialog"');
});
it('shows nothing without a usable capacity or count', () => {
	for (const [used, capacity] of [
		[42, 0],
		[42, -1],
		[-1, 100],
		[Number.NaN, 100],
		[42, Number.POSITIVE_INFINITY],
	] as const)
		expect(meter(used, capacity).html, `${used}/${capacity}`).toBe('');
});
