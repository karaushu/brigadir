import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { versionServiceWorker } from './src/renderer-mobile/sw-version';
import { fontLicence } from './vite-font-licence';
/**
 * spec/remote-access-and-mobile#phone-network: the phone's bundle, separate from the desktop renderer — the sign-in page (`index.html`, served without a
 * sign-in with what it imports statically) and the app (`app.tsx`, served only with the cookie of a signed-in socket). The
 * manifest tells the web listener which file is which.
 */
const root = resolve(__dirname, 'src/renderer-mobile');
/** spec/remote-access-and-mobile#outbox: `sw.js` names its cache after this build, so `activate` can drop the older builds' caches. */
const serviceWorkerVersion = (): Plugin => ({
	name: 'brigadir-sw-version',
	apply: 'build',
	async writeBundle(options, bundle) {
		const file = resolve(options.dir!, 'sw.js');
		await writeFile(file, versionServiceWorker(await readFile(file, 'utf8'), Object.keys(bundle)));
	},
});
export default defineConfig({
	root,
	plugins: [serviceWorkerVersion(), fontLicence()],
	base: '/',
	publicDir: resolve(root, 'public'),
	esbuild: { jsx: 'automatic' },
	build: {
		outDir: resolve(__dirname, 'out/renderer-mobile'),
		emptyOutDir: true,
		// Not under `.vite/`: a dot folder may not survive packaging into app.asar.
		manifest: 'bundle-manifest.json',
		minify: 'esbuild',
		// The page loads the app by the address the listener gives it; no preload helper that reaches for it earlier.
		modulePreload: false,
		rollupOptions: {
			input: { index: resolve(root, 'index.html'), app: resolve(root, 'app.tsx') },
			preserveEntrySignatures: 'exports-only',
			// The shared packages are pure modules: without this, everything `core` exports would land in the chunk both
			// entries share and so be served before a sign-in.
			treeshake: {
				moduleSideEffects: (id) => !/[\\/]packages[\\/](?:core|remote)[\\/]/.test(id),
			},
		},
	},
});
