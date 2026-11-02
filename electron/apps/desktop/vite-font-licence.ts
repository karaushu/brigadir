import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
/**
 * spec/appearance#evolution-redesign: Geist ships under the SIL OFL 1.1 and Lucide under ISC (with Feather's MIT); their texts travel with
 * the assets. Vite hashes the fonts and the icon data into `assets/`; this puts the licences beside them in every
 * renderer build that carries them: the desktop has both, the phone only the fonts.
 */
const licences = {
	geist: 'src/renderer/fonts/LICENSE-geist.txt',
	lucide: 'src/renderer/lucide/LICENSE-lucide.txt',
};
export const fontLicence = (...names: (keyof typeof licences)[]): Plugin => ({
	name: 'brigadir-asset-licences',
	apply: 'build',
	generateBundle() {
		for (const name of names.length ? names : (['geist'] as const))
			this.emitFile({
				type: 'asset',
				fileName: `assets/LICENSE-${name}.txt`,
				source: readFileSync(resolve(__dirname, licences[name])),
			});
	},
});
