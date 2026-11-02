import { nativeImage, type NativeImage } from 'electron';
import type { MenuIcon, MenuIconImages } from '@brigadir/core';

/**
 * spec/search-menus-and-commands#menu-glyphs: the one set of menu glyphs every native menu takes its icons from. The renderer's PNGs become template images,
 * so macOS tints them for the theme and the highlighted row. Template images are a macOS idea: elsewhere a black glyph
 * would vanish in a dark menu, so the menus there stay text.
 */
let icons: ReadonlyMap<MenuIcon, NativeImage> = new Map();
export function templateIcons(
	images: MenuIconImages,
	platform: NodeJS.Platform = process.platform
): ReadonlyMap<MenuIcon, NativeImage> {
	const result = new Map<MenuIcon, NativeImage>();
	if (platform !== 'darwin') return result;
	for (const [name, image] of Object.entries(images) as [MenuIcon, { x1: string; x2: string }][]) {
		const icon = nativeImage.createEmpty();
		icon.addRepresentation({ scaleFactor: 1, dataURL: image.x1 });
		icon.addRepresentation({ scaleFactor: 2, dataURL: image.x2 });
		if (icon.isEmpty()) continue;
		icon.setTemplateImage(true);
		result.set(name, icon);
	}
	return result;
}
export function setMenuIcons(images: MenuIconImages) {
	icons = templateIcons(images);
}
/** Spread into a menu item: `{icon}` once the glyphs arrived, nothing before (a menu opened that early shows text only). */
export function menuIcon(name: MenuIcon | undefined): { icon?: NativeImage } {
	const icon = name ? icons.get(name) : undefined;
	return icon ? { icon } : {};
}
