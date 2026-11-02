// spec/architecture-and-platform#packaging: `pnpm dist:mac [--arm64] [--x64] [--all] [--skip-build] [--publish]` builds the release DMG(s) and the
// update zips into electron/dist. `--linux [--x64] [--arm64]` builds the full app for Linux (spec/architecture-and-platform#linux-package, scripts/dist-linux.mjs).
// Only full builds (spec/architecture-and-platform#packaging). Developer ID signing and notarization turn on from the environment
// (packaging/electron-builder.config.mjs). `--publish` uploads the packages and `latest*.yml` to the releases repository with
// GH_TOKEN (spec/architecture-and-platform#auto-update, docs/guides/releasing.md).
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import {
	builderConfig,
	releasesRepo,
	signingFromEnv,
	workspace,
} from '../packaging/electron-builder.config.mjs';
import { checkDmg, checkMacUpdateInfo } from './check-dist.mjs';

const args = process.argv.slice(2);
// spec/architecture-and-platform#auto-update: publishing needs the real releases repository and a token that may write to it.
const publish = args.includes('--publish');
if (publish) {
	try {
		releasesRepo({ publishing: true });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	if (!process.env.GH_TOKEN) {
		console.error(
			'--publish needs GH_TOKEN: a token that can write releases of the releases repository.'
		);
		process.exit(1);
	}
}
// spec/architecture-and-platform#linux-package: the full Linux build goes from a Mac or Linux alike; zig cross-compiles its natives.
if (args.includes('--linux')) {
	const { distLinux } = await import('./dist-linux.mjs');
	await distLinux(args);
	process.exit(0);
}
const blockers = `A full Windows (NSIS) build is [LATER] (spec/architecture-and-platform#packaging, spec/architecture-and-platform#linux-package «Відкладено»). Before it can work:
  - the host's .sock and process-owner.c, mcp-relay.c, cli-relay.c are POSIX (Windows needs named pipes);
  - the shell integration has no PowerShell version; fonts, sounds and the keep-awake check have no Windows source.
Linux: pnpm dist:linux [--x64] [--arm64].`;
if (args.includes('--win') || process.platform !== 'darwin') {
	console.error(blockers);
	process.exit(1);
}

const archs = args.includes('--all')
	? ['arm64', 'x64']
	: [
			...new Set(
				args.filter((arg) => arg === '--arm64' || arg === '--x64').map((arg) => arg.slice(2))
			),
		];
if (!archs.length) archs.push(process.arch === 'x64' ? 'x64' : 'arm64');
// CI passes a missing secret as an empty variable; electron-builder would read an empty CSC_LINK as a certificate path.
for (const name of [
	'CSC_LINK',
	'CSC_KEY_PASSWORD',
	'CSC_NAME',
	'APPLE_API_KEY',
	'APPLE_API_KEY_ID',
	'APPLE_API_ISSUER',
	'APPLE_ID',
	'APPLE_APP_SPECIFIC_PASSWORD',
	'APPLE_TEAM_ID',
	'APPLE_KEYCHAIN_PROFILE',
])
	if (process.env[name] === '') delete process.env[name];
const started = Date.now(),
	signing = signingFromEnv();
const desktop = join(workspace, 'apps/desktop'),
	output = join(workspace, 'dist'),
	stage = join(output, 'stage');
const run = (command, commandArgs, env = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: workspace,
			stdio: 'inherit',
			env: { ...process.env, ...env },
		});
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0
				? resolve()
				: reject(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`))
		);
	});

// 1. The app and its services; the native helpers fat, so one services folder serves both architectures.
if (!args.includes('--skip-build'))
	await run('pnpm', ['build'], { BRIGADIR_MAC_ARCHS: 'arm64,x86_64' });

// 2. Stage: the archive gets only out/main|preload|renderer and a package.json without dependencies (main bundles them).
const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
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

// 3. Package. Electron comes from the @electron/get cache that `pnpm install` filled for this Mac's architecture;
// another architecture downloads once. (A custom electronDist would keep Electron's default_app.asar in the bundle.)
const { build, Platform, Arch } = await import('electron-builder');
const electronRequire = createRequire(join(desktop, 'package.json'));
const electronVersion = electronRequire('electron/package.json').version;
const buildVersion = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
	cwd: workspace,
	encoding: 'utf8',
}).trim();
// One build for every architecture: electron-builder then writes one latest-mac.yml listing each architecture's zip, which
// Squirrel.Mac installs (spec/architecture-and-platform#auto-update); the DMG is what people download by hand.
const config = builderConfig({ stage, output, electronVersion, buildVersion, signing });
const artifacts = await build({
	targets: Platform.MAC.createTarget(['dmg', 'zip'], ...archs.map((arch) => Arch[arch])),
	config,
	projectDir: workspace,
	publish: publish ? 'always' : 'never',
});
const dmgs = artifacts
	.filter((path) => path.endsWith('.dmg'))
	.map((path) => ({ path, arch: path.endsWith('-x64.dmg') ? 'x64' : 'arm64' }));

// 4. Mount every DMG read-only and check its bundle (structure, architectures, signatures, entitlements, update feed).
for (const dmg of dmgs)
	await checkDmg(dmg.path, { arch: dmg.arch, developerId: signing.developerId });
await checkMacUpdateInfo(output, { version: manifest.version, archs });
const seconds = Math.round((Date.now() - started) / 1000);
for (const dmg of dmgs)
	console.log(
		`DMG ${relative(workspace, dmg.path)}: ${((await stat(dmg.path)).size / 1024 / 1024).toFixed(1)} MB`
	);
console.log(
	`Packaged in ${seconds} s (${signing.developerId ? 'Developer ID' : 'ad-hoc'}${signing.notarize ? ', notarized' : ''}).`
);
if (!signing.developerId)
	console.warn(`\nWarning: this build is signed ad-hoc and not notarized. It runs on this Mac; on another Mac Gatekeeper blocks a downloaded copy
("cannot be opened" / "is damaged"). Open it there via System Settings → Privacy & Security → Open Anyway, or run
  xattr -dr com.apple.quarantine /Applications/Brigadir.app
Set CSC_LINK (+ CSC_KEY_PASSWORD) and APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER for a Developer ID, notarized build.`);
