import { menuIconNames, type MenuIconImages } from '@brigadir/core';
import { Glyph, type GlyphName } from './ui/Glyph';
import { glyphMarkup } from './ui/glyph-markup';

/** Every icon a native menu names is one of our glyphs (spec/search-menus-and-commands#menu-glyphs); this assignment fails to compile otherwise. */
const names: readonly GlyphName[] = menuIconNames;
async function png(svg: string, size: number) {
	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await image.decode();
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	canvas.getContext('2d')!.drawImage(image, 0, 0, size, size);
	return canvas.toDataURL('image/png');
}
/**
 * spec/search-menus-and-commands#menu-glyphs: the native menu takes no SVG, so the glyphs of every native menu go to main once, as black PNGs at 1× and 2×;
 * main makes them template images and macOS tints them for the theme and the highlighted row. Only macOS has template
 * images, so the other platforms draw nothing.
 */
export async function sendMenuIcons() {
	if (window.brigadir.chromePlatform !== 'darwin') return;
	const entries = await Promise.all(
		names.map(async (name) => {
			const svg = glyphMarkup(<Glyph name={name} size={16} />)
				.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
				.replaceAll('currentColor', '#000');
			return [name, { x1: await png(svg, 16), x2: await png(svg, 32) }] as const;
		})
	);
	await window.brigadir.setMenuIcons(Object.fromEntries(entries) as MenuIconImages);
}
