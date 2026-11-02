// spec/architecture-and-platform#linux-package: `pnpm dist:linux [--x64] [--arm64] [--skip-build] [--publish]` — the full Brigadir for Linux into electron/dist:
// AppImage and .deb (electron-builder), .rpm (nfpm), x64 by default. `--publish` uploads what electron-builder made; the .rpm
// goes up separately (CI uploads it to the same release, docs/guides/releasing.md). Builds from a Mac or Linux alike: the services get
// their Linux natives from zig (scripts/linux-natives.mjs), one staged services folder per architecture.
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import {
	linuxBuilderConfig,
	linuxDescription,
	pngIcon,
	rpmDepends,
	workspace,
} from '../packaging/electron-builder.config.mjs';
import { checkLinux } from './check-linux.mjs';
import { buildLinuxNatives } from './linux-natives.mjs';
import { buildRpms, rpmArch } from './rpm.mjs';

/** A .deb names a homepage: the project's repository (docs/guides/releasing.md). */
const homepage = 'https://github.com/karaushu/brigadir';

export async function distLinux(args) {
	const archs = [
		...new Set(
			args.filter((arg) => arg === '--x64' || arg === '--arm64').map((arg) => arg.slice(2))
		),
	];
	if (!archs.length) archs.push('x64');
	const started = Date.now();
	const desktop = join(workspace, 'apps/desktop'),
		output = join(workspace, 'dist');
	const run = (command, commandArgs) =>
		new Promise((resolve, reject) => {
			const child = spawn(command, commandArgs, { cwd: workspace, stdio: 'inherit' });
			child.on('error', reject);
			child.on('exit', (code) =>
				code === 0
					? resolve()
					: reject(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`))
			);
		});

	// 1. The app and its services, as for the DMG; the natives of this computer are replaced per architecture below.
	if (!args.includes('--skip-build')) await run('pnpm', ['build']);

	const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
	const electronVersion = createRequire(join(desktop, 'package.json'))(
		'electron/package.json'
	).version;
	const buildVersion = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
		cwd: workspace,
		encoding: 'utf8',
	}).trim();
	const { build, Platform, Arch } = await import('electron-builder');
	const artifacts = [];
	for (const arch of archs) {
		// 2. Stage: the app (main, preload, both renderers, a package.json without dependencies) and this architecture's services.
		const stage = join(output, `stage-linux-${arch}`);
		await rm(stage, { recursive: true, force: true });
		await mkdir(join(stage, 'app/out'), { recursive: true });
		await writeFile(
			join(stage, 'app/package.json'),
			JSON.stringify(
				{
					name: 'brigadir',
					productName: 'Brigadir',
					version: manifest.version,
					description: 'Brigadir — an orchestrator for coding agents',
					author: 'Brigadir',
					homepage,
					// The window's app_id / WM_CLASS names the installed .desktop file (linux.syncDesktopName).
					desktopName: 'brigadir.desktop',
					main: 'out/main/index.js',
				},
				null,
				2
			)
		);
		// spec/remote-access-and-mobile#phone-network: `renderer-mobile` is what the web listener serves to a phone.
		for (const part of ['main', 'preload', 'renderer', 'renderer-mobile'])
			await cp(join(desktop, 'out', part), join(stage, 'app/out', part), {
				recursive: true,
				verbatimSymlinks: true,
			});
		await cp(join(desktop, 'out/services'), join(stage, 'services'), {
			recursive: true,
			verbatimSymlinks: true,
		});
		await buildLinuxNatives({ workspace, services: join(stage, 'services'), arch });

		// 3. AppImage and deb. The unpacked folder of an earlier build (the client's too) goes first.
		await rm(join(output, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`), {
			recursive: true,
			force: true,
		});
		// spec/architecture-and-platform#auto-update: with --publish the AppImage, the .deb and latest-linux*.yml go to the releases repository.
		artifacts.push(
			...(await build({
				targets: Platform.LINUX.createTarget(['AppImage', 'deb'], Arch[arch]),
				config: linuxBuilderConfig({ stage, output, electronVersion, buildVersion }),
				projectDir: workspace,
				publish: args.includes('--publish') ? 'always' : 'never',
			}))
		);
	}

	// 3b. Fedora: an .rpm of the same unpacked app, written by nfpm (rpmbuild cannot build x86_64 on an arm64 Mac).
	artifacts.push(
		...(await buildRpms({
			output,
			archs,
			version: manifest.version,
			// The build number: higher than the release 1 of the old client-only package (spec/remote-access-and-mobile#identity-and-keys), so dnf upgrades it.
			release: buildVersion,
			icon: pngIcon,
			description: linuxDescription,
			homepage,
			depends: rpmDepends,
			recommends: ['git', 'gnome-keyring'],
			file: (arch) => `Brigadir-${manifest.version}-${rpmArch[arch]}.rpm`,
		}))
	);

	// 4. What went in: every service, Linux natives of the right architecture, nothing of macOS.
	const packages = artifacts.filter((path) => /\.(AppImage|deb|rpm)$/.test(path));
	await checkLinux({ output, packages, archs, version: manifest.version });
	const seconds = Math.round((Date.now() - started) / 1000);
	for (const path of packages)
		console.log(
			`${relative(workspace, path)}: ${((await stat(path)).size / 1024 / 1024).toFixed(1)} MB`
		);
	console.log(`Packaged the Linux build in ${seconds} s.`);
}
