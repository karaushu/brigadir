import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangeSign } from './ChangeSign';
it('draws + and − on one height and keeps the text sign (spec/diff-and-review#change-counters)', () => {
	const plus = renderToStaticMarkup(
			<span>
				<ChangeSign sign="+" />2
			</span>
		),
		minus = renderToStaticMarkup(
			<span>
				<ChangeSign sign="−" />1
			</span>
		);
	const bar = (html: string) => /d="M\.6 ([\d.]+)h5\.4/.exec(html)?.[1];
	expect(bar(plus)).toBe(bar(minus));
	expect(minus.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '')).toBe('−1');
	expect(minus).toContain('aria-hidden="true"');
});
