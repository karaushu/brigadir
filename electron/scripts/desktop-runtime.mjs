import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const desktop = join(workspace, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
/** The text macOS shows when Brigadir first looks for or connects to computers on the local network (spec/remote-access-and-mobile#networking). */
export const localNetworkUsage =
	'Brigadir finds your paired computers on the local network and connects to them for remote access.';
async function iconDigest(directory) {
	const hash = createHash('sha256');
	async function visit(relative = '') {
		for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort(
			(a, b) => a.name.localeCompare(b.name)
		)) {
			const path = join(relative, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) {
				hash.update(path);
				hash.update('\0');
				hash.update(await readFile(join(directory, path)));
			} else throw new Error(`Unsupported icon asset: ${path}`);
		}
	}
	await visit();
	return hash.digest('hex');
}
export async function desktopRuntime() {
	const executable = require('electron');
	if (process.platform !== 'darwin') return executable;
	const version = require('electron/package.json').version;
	const icon = join(desktop, 'resources/brigadir.icon'),
		iconHash = await iconDigest(icon);
	const root = join(
		workspace,
		'.runtime',
		`electron-${version}-${process.arch}-branding-3-${iconHash.slice(0, 12)}`
	);
	const bundle = join(root, 'Brigadir.app'),
		marker = join(root, 'ready.json');
	const expected = { version, name: 'Brigadir', id: 'com.karaushu.brigadir.dev', iconHash };
	try {
		if (JSON.stringify(JSON.parse(await readFile(marker, 'utf8'))) === JSON.stringify(expected))
			return join(bundle, 'Contents/MacOS/Electron');
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	await mkdir(dirname(root), { recursive: true });
	const staging = await mkdtemp(join(dirname(root), '.brigadir-'));
	try {
		const copy = join(staging, 'Brigadir.app');
		await cp(dirname(dirname(dirname(executable))), copy, {
			recursive: true,
			verbatimSymlinks: true,
		});
		const plist = join(copy, 'Contents/Info.plist');
		for (const [key, value] of Object.entries({
			CFBundleName: expected.name,
			CFBundleDisplayName: expected.name,
			CFBundleIdentifier: expected.id,
		}))
			await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
		await run('/usr/bin/xcrun', [
			'actool',
			'--compile',
			join(copy, 'Contents/Resources'),
			'--platform',
			'macosx',
			'--minimum-deployment-target',
			'13.0',
			'--app-icon',
			'brigadir',
			'--output-partial-info-plist',
			join(staging, 'icon-info.plist'),
			'--output-format',
			'human-readable-text',
			icon,
		]);
		await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile brigadir', plist]);
		await run('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleIconName string brigadir', plist]);
		// spec/remote-access-and-mobile#networking: the same local network keys as the release build, so the dev app asks macOS the same way.
		for (const command of [
			`Add :NSLocalNetworkUsageDescription string ${localNetworkUsage}`,
			'Add :NSBonjourServices array',
			'Add :NSBonjourServices:0 string _brigadir._tcp',
		])
			await run('/usr/libexec/PlistBuddy', ['-c', command, plist]);
		await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', copy]);
		await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', copy]);
		await writeFile(join(staging, 'ready.json'), JSON.stringify(expected));
		try {
			await rename(staging, root);
		} catch (error) {
			if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
			if ((await readFile(marker, 'utf8')) !== JSON.stringify(expected)) throw error;
		}
		return join(bundle, 'Contents/MacOS/Electron');
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
