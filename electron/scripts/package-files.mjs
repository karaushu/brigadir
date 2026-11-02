// File helpers of the package checks (check-linux.mjs): every file under a folder, a file's first bytes, @electron/asar
// of electron-builder, 7-Zip for an AppImage, the unpacked folder's name. They never run what they read.
import { access, constants, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export async function files(root) {
	const found = [];
	for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
		if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
	return found;
}
export async function head(path, length) {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, 0);
		return buffer;
	} finally {
		await handle.close();
	}
}
export function asarModule() {
	const builder = createRequire(import.meta.url).resolve('electron-builder');
	const lib = createRequire(builder).resolve('app-builder-lib');
	return createRequire(lib)('@electron/asar');
}
/** 7-Zip reads the squashfs of an AppImage: on PATH, or the copy electron-builder downloads into its cache. */
export async function sevenZip() {
	const runs = async (path) =>
		access(path, constants.X_OK).then(
			() => path,
			() => null
		);
	for (const name of ['7zz', '7z'])
		for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':'))
			if (dir && (await runs(join(dir, name)))) return join(dir, name);
	const caches = [
		join(homedir(), 'Library/Caches/electron-builder'),
		join(homedir(), '.cache/electron-builder'),
	];
	for (const cache of caches) {
		const found = await readdir(cache, { recursive: true }).catch(() => []);
		for (const path of found)
			if (/(^|[\\/])bin[\\/]7zz?$/.test(path) && (await runs(join(cache, path))))
				return join(cache, path);
	}
	return null;
}
/** The unpacked folder electron-builder leaves next to the packages. */
export const unpacked = (platform, arch) =>
	`${platform}${arch === 'x64' ? '' : `-${arch}`}-unpacked`;
