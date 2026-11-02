import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Glyph } from './Glyph';
import { glyphMarkup } from './glyph-markup';
it('matches the server renderer for the glyphs the prompt editor embeds', () => {
	for (const name of [
		'file',
		'claude',
		'openai',
		'helmet',
		'person',
		'search',
		'folder-plus',
		'sidebar-branch',
	] as const) {
		const parse = (html: string) => html.replace(/<(\w+)([^>]*)\/>/g, '<$1$2></$1>');
		expect(parse(glyphMarkup(<Glyph name={name} size={10} />))).toBe(
			parse(renderToStaticMarkup(<Glyph name={name} size={10} />))
		);
	}
});
