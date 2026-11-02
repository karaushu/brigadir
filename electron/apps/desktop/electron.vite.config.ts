import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
import { fontLicence } from './vite-font-licence';
export default defineConfig({
	main: {
		// Bundled, ws's optional native helpers become empty objects that don't throw, and ws would call their missing
		// functions for any frame of 48 bytes or more (spec/remote-access-and-mobile#pairing): use its JavaScript paths.
		define: {
			'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
			'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1'),
		},
		build: {
			externalizeDeps: {
				exclude: [
					'@brigadir/forge',
					'@brigadir/lsp',
					'@brigadir/core',
					'@brigadir/persistence',
					'@brigadir/git',
					'@brigadir/diff',
					'@brigadir/host',
					'@brigadir/transport',
					'@brigadir/remote',
					'@agentclientprotocol/sdk',
					// spec/architecture-and-platform#auto-update: the package has no node_modules, so the updater is bundled into main.
					'electron-updater',
				],
			},
			rollupOptions: { input: resolve(__dirname, 'src/main/index.ts'), external: ['electron'] },
		},
	},
	preload: {
		build: {
			// A sandboxed preload cannot require packages: the channel table (spec/architecture-and-platform#ipc-boundary) is bundled in.
			externalizeDeps: { exclude: ['@brigadir/core'] },
			rollupOptions: {
				input: resolve(__dirname, 'src/preload/index.ts'),
				external: ['electron'],
				output: { format: 'cjs', entryFileNames: 'index.cjs' },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		plugins: [fontLicence('geist', 'lucide')],
		esbuild: { jsx: 'automatic' },
		build: {
			minify: 'esbuild',
			rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
		},
	},
});
