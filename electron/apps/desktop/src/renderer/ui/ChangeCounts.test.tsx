import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangeCounts } from './ChangeCounts';

const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

it('draws the pair with the halves marked; a shortened count gives the whole one tooltip (spec/appearance#component-details)', () => {
	const html = renderToStaticMarkup(<ChangeCounts additions={2} deletions={1} locale="en" />);
	expect(text(html)).toBe('+2 −1');
	expect(html).not.toContain('title="');
	expect(html).toContain('data-change="add"');
	expect(html).toContain('data-change="remove"');
	const long = renderToStaticMarkup(<ChangeCounts additions={5036} deletions={1} locale="en" />);
	expect(long.match(/title="/g)).toHaveLength(1);
});

it('`nonzero` drops a zero half and its space; `split` and `tone` are the wrapper’s', () => {
	const html = renderToStaticMarkup(
		<ChangeCounts additions={0} deletions={3} locale="en" nonzero split tone="diff" />
	);
	expect(text(html)).toBe('−3');
	expect(html).not.toContain('data-change="add"');
	expect(html).toMatch(/data-split="true"/);
	expect(html).toMatch(/data-tone="diff"/);
	// A split pair takes the row's gap: no space of its own, as the two siblings it replaced.
	expect(
		text(renderToStaticMarkup(<ChangeCounts additions={2} deletions={1} locale="en" split />))
	).toBe('+2−1');
});
