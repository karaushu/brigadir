import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangeCount } from './ChangeCount';
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');
it('keeps a count below 1000 as is (spec/diff-and-review#change-counters)', () => {
	const html = renderToStaticMarkup(
		<span>
			<ChangeCount sign="+" value={999} locale="uk" />
		</span>
	);
	expect(text(html)).toBe('+999');
	expect(html).not.toContain('data-compact');
});
it('draws a long count short and keeps the exact one as text (spec/diff-and-review#change-counters)', () => {
	const plus = renderToStaticMarkup(
			<span>
				<ChangeCount sign="+" value={3150} locale="uk" />
			</span>
		),
		minus = renderToStaticMarkup(
			<span>
				<ChangeCount sign="−" value={1_250_000} locale="en" />
			</span>
		);
	expect(plus).toContain('data-compact="3.1k"');
	expect(text(plus)).toBe('+3 150');
	expect(minus).toContain('data-compact="1.2M"');
	expect(text(minus)).toBe('−1,250,000');
	expect(plus).toContain('aria-hidden="true"');
});
