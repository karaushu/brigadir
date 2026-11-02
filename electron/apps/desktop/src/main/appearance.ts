import {
	fontFamilyChoice,
	systemFontFamily,
	systemMonoFamily,
	textSurfaces,
	type Appearance,
	type FontCatalog,
	type MachineAppearance,
} from '@brigadir/core';

/**
 * spec/remote-access-and-mobile#client-ui-seam: the appearance a window takes — the settings of the machine it shows (`machine`) with the theme, the
 * system accent and the font catalog of the machine it runs on. A family missing from that catalog falls back to the
 * system font and is named in `missingFonts` (spec/appearance#interface-font); the window of the machine itself passes its own of each.
 * spec/appearance#evolution-redesign: the bundled Geist (null) and the OS font (its CSS generic name) are never missing.
 */
export function composeAppearance(
	machine: MachineAppearance,
	catalog: FontCatalog | null,
	dark: boolean,
	accent: string
): Appearance {
	const typography = structuredClone(machine.typography),
		interfaceFont = structuredClone(machine.interfaceFont),
		missingFonts: string[] = [];
	for (const surface of textSurfaces) {
		const family = typography[surface].family;
		if (
			family &&
			fontFamilyChoice(family, 'mono').kind === 'installed' &&
			!catalog?.fonts.some((font) => font.mono && font.family === family)
		) {
			if (catalog && !missingFonts.includes(family)) missingFonts.push(family);
			typography[surface].family = systemMonoFamily;
		}
	}
	if (
		interfaceFont.family &&
		fontFamilyChoice(interfaceFont.family, 'sans').kind === 'installed' &&
		!catalog?.fonts.some((font) => font.family === interfaceFont.family)
	) {
		if (catalog && !missingFonts.includes(interfaceFont.family))
			missingFonts.push(interfaceFont.family);
		interfaceFont.family = systemFontFamily;
	}
	return { ...machine, typography, interfaceFont, dark, accent, fonts: catalog, missingFonts };
}
