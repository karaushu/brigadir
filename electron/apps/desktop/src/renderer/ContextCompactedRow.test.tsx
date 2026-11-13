import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextCompactedRow } from './ContextCompactedRow';
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');
// spec/chat#context-compacted
it('says the context was compacted, with both sizes in the token format', () => {
	const html = renderToStaticMarkup(
		<ContextCompactedRow
			event={{ kind: 'context.compacted', before: 940_000, after: 62_000 }}
			locale="en"
		/>
	);
	expect(text(html)).toBe('Context compacted · 940k → 62k');
	expect(html).toContain('data-context-compacted');
	expect(html).not.toContain('<button');
});
it('keeps only the label when a size is missing, and speaks Ukrainian', () => {
	for (const event of [
		{ kind: 'context.compacted' as const, before: 300_000, after: null },
		{ kind: 'context.compacted' as const, before: null, after: null },
	])
		expect(text(renderToStaticMarkup(<ContextCompactedRow event={event} locale="uk" />))).toBe(
			'Контекст стиснуто'
		);
});
