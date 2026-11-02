/**
 * spec/remote-access-and-mobile#phone-network: the phone's bundle (`out/renderer-mobile`) as the web listener serves it. Vite's manifest says which
 * files the sign-in page needs — its entry and everything it imports statically — and which belong to the app; only the
 * first, the service worker, the PWA manifest and the icons go out without a sign-in. A request names a file exactly as
 * it is in this table: nothing outside the bundle's folder can be asked for.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type BundleFile = { file: string; type: string; public: boolean };
export type WebBundle = {
	files: ReadonlyMap<string, BundleFile>;
	/** The app's entry and its styles, for the page to load once signed in. */
	app: { script: string; styles: string[] };
};
type ManifestChunk = {
	file: string;
	isEntry?: boolean;
	imports?: string[];
	css?: string[];
	assets?: string[];
	dynamicImports?: string[];
};
const types: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	webmanifest: 'application/manifest+json',
	svg: 'image/svg+xml',
	png: 'image/png',
	woff2: 'font/woff2',
	wasm: 'application/wasm',
};
/** The files at the bundle's root that need no sign-in: the page itself, the service worker, the PWA's manifest, icons. */
const publicRoot =
	/^\/(?:index\.html|sw\.js|manifest\.webmanifest|icon[A-Za-z0-9-]*\.(?:png|svg))$/;

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		// Dotfiles stay on disk; `bundle-manifest.json` is not served either (no type below).
		if (entry.name.startsWith('.')) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(path)));
		else if (entry.isFile()) out.push(path);
	}
	return out;
}
export async function loadWebBundle(dir: string): Promise<WebBundle> {
	const manifest = JSON.parse(await readFile(join(dir, 'bundle-manifest.json'), 'utf8')) as Record<
		string,
		ManifestChunk
	>;
	const entries = Object.entries(manifest);
	const signIn = entries.find(([key, chunk]) => chunk.isEntry && key.endsWith('index.html'));
	const app = entries.find(([key, chunk]) => chunk.isEntry && /(?:^|\/)app\.tsx?$/.test(key));
	if (!signIn || !app) throw new Error('The phone bundle has no sign-in page or app entry.');
	// The sign-in page's closure: its chunk, what it imports statically, their styles and assets (not dynamic imports).
	const open = new Set<string>();
	const visit = (key: string) => {
		const chunk = manifest[key];
		if (!chunk || open.has(`/${chunk.file}`)) return;
		open.add(`/${chunk.file}`);
		for (const css of chunk.css ?? []) open.add(`/${css}`);
		for (const asset of chunk.assets ?? []) open.add(`/${asset}`);
		for (const item of chunk.imports ?? []) visit(item);
	};
	visit(signIn[0]);
	const files = new Map<string, BundleFile>();
	for (const file of await walk(dir)) {
		const path = `/${relative(dir, file).split(sep).join('/')}`;
		const type = types[path.slice(path.lastIndexOf('.') + 1)];
		if (!type || !/^\/[A-Za-z0-9._/-]+$/.test(path)) continue;
		files.set(path, { file, type, public: publicRoot.test(path) || open.has(path) });
	}
	return {
		files,
		app: { script: `/${app[1].file}`, styles: (app[1].css ?? []).map((css) => `/${css}`) },
	};
}
