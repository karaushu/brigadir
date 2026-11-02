// spec/architecture-and-platform#packaging: electron-builder configuration for the release build. `scripts/dist.mjs` stages the app and calls
// `builderConfig()`; nothing here reads the dev runtime of `scripts/desktop-runtime.mjs` (spec/architecture-and-platform#macos-package).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const packaging = dirname(fileURLToPath(import.meta.url));
export const workspace = dirname(packaging);
export const appId = 'com.karaushu.brigadir';
export const productName = 'Brigadir';
/** spec/remote-access-and-mobile#identity-and-keys, spec/architecture-and-platform#linux-package: the Linux icon (and Windows one day), drawn from apps/desktop/resources/brigadir.icon by scripts/render-icon.mjs. */
export const pngIcon = join(packaging, 'icons/icon.png');

/** The value of `releases` until the public releases repository is set up (docs/guides/releasing.md). */
export const releasesPlaceholder = 'OWNER/brigadir-releases';
/**
 * spec/architecture-and-platform#auto-update: the public GitHub repository whose releases carry the packages and `latest*.yml`. It is set in
 * one place, the `releases` field of apps/desktop/package.json; the app reads the same field. `publishing` refuses the
 * placeholder, so a release is never published to it.
 * @param {{publishing?: boolean}} [options]
 */
export function releasesRepo({ publishing = false } = {}) {
	const manifest = JSON.parse(readFileSync(join(workspace, 'apps/desktop/package.json'), 'utf8'));
	const value = manifest.releases;
	const match =
		typeof value === 'string'
			? /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(value)
			: null;
	if (!match)
		throw new Error(
			`apps/desktop/package.json: "releases" must be "owner/repo", not ${JSON.stringify(value)}.`
		);
	if (publishing && value === releasesPlaceholder)
		throw new Error(
			`apps/desktop/package.json: "releases" is still the placeholder ${releasesPlaceholder}. Set it to the public releases repository before publishing (docs/guides/releasing.md).`
		);
	return { owner: match[1], repo: match[2], placeholder: value === releasesPlaceholder };
}
/**
 * spec/architecture-and-platform#auto-update: GitHub Releases of the public releases repository. electron-builder writes `app-update.yml` into the
 * package and `latest-mac.yml` / `latest-linux*.yml` next to it; uploads go into the draft release CI prepared, and CI makes
 * it public once every package is there.
 * @returns {import('electron-builder').PublishConfiguration}
 */
export function publishConfig() {
	const { owner, repo } = releasesRepo();
	return { provider: 'github', owner, repo, releaseType: 'draft', vPrefixedTagName: true };
}

/** Developer ID signing is on when electron-builder can find a certificate; otherwise the build is ad-hoc. */
export function signingFromEnv(env = process.env) {
	const developerId = Boolean(env.CSC_LINK || env.CSC_NAME);
	const notarize = Boolean(
		(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
		(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
		env.APPLE_KEYCHAIN_PROFILE
	);
	if (notarize && !developerId)
		throw new Error(
			'Notarization needs a Developer ID Application certificate: set CSC_LINK (+ CSC_KEY_PASSWORD) or CSC_NAME.'
		);
	return { developerId, notarize };
}

/** spec/architecture-and-platform#linux-package: what the full app needs of a Debian or Ubuntu system — Electron's libraries and libsecret for the key. */
export const debDepends = [
	'libgtk-3-0',
	'libnotify4',
	'libnss3',
	'libxss1',
	'libxtst6',
	'xdg-utils',
	'libatspi2.0-0',
	'libuuid1',
	'libsecret-1-0',
];
/** The same for Fedora, RHEL and openSUSE (scripts/rpm.mjs). */
export const rpmDepends = [
	'gtk3',
	'libnotify',
	'nss',
	'libXScrnSaver',
	'libXtst',
	'xdg-utils',
	'at-spi2-core',
	'libuuid',
	'libsecret',
];
export const linuxDescription =
	'Brigadir — an orchestrator for coding agents: projects, tasks, agents in terminals, the editor, diffs, pull requests, the browser and remote access.';

/**
 * spec/architecture-and-platform#linux-package: the full app for Linux, one architecture per call — its services folder (`stage/services`) carries that
 * architecture's natives (scripts/linux-natives.mjs). AppImage and deb here; rpm via nfpm (scripts/rpm.mjs).
 * @param {{stage:string,output:string,electronVersion:string,buildVersion:string}} options
 * @returns {import('electron-builder').Configuration}
 */
export function linuxBuilderConfig({ stage, output, electronVersion, buildVersion }) {
	const services = join(stage, 'services');
	return {
		appId,
		productName,
		executableName: 'brigadir',
		buildVersion,
		electronVersion,
		copyright: '© 2026 Andrew Karaushu',
		directories: { app: join(stage, 'app'), output, buildResources: packaging },
		files: ['package.json', 'out/**/*'],
		asar: true,
		npmRebuild: false,
		nodeGypRebuild: false,
		buildDependenciesFromSource: false,
		includePdb: false,
		publish: publishConfig(),
		// spec/architecture-and-platform#packaging: shells, the agent's CLI and node-pty run these by path, so they stay outside app.asar.
		extraResources: [
			{ from: services, to: 'services', filter: ['**/*', '!**/*.map', '!node_modules/**'] },
			// A top-level node_modules is skipped by electron-builder's file sets, so node-pty is named on its own.
			{
				from: join(services, 'node_modules/node-pty'),
				to: 'services/node_modules/node-pty',
				filter: ['**/*', '!**/*.map'],
			},
		],
		linux: {
			icon: pngIcon,
			category: 'Development',
			synopsis: 'An orchestrator for coding agents',
			description: linuxDescription,
			maintainer: 'Brigadir',
			artifactName: '${productName}-${version}-${arch}.${ext}',
			syncDesktopName: true,
		},
		// The release after the version is the build number, so this package replaces the old client-only one (0.1.0-1, spec/remote-access-and-mobile#identity-and-keys).
		deb: {
			depends: debDepends,
			recommends: ['git', 'gnome-keyring | kwalletmanager'],
			fpm: ['--iteration', buildVersion],
		},
	};
}

/**
 * @param {{stage:string,output:string,electronVersion:string,buildVersion:string,signing:{developerId:boolean,notarize:boolean}}} options
 * @returns {import('electron-builder').Configuration}
 */
export function builderConfig({ stage, output, electronVersion, buildVersion, signing }) {
	const services = join(stage, 'services');
	return {
		appId,
		productName,
		buildVersion,
		electronVersion,
		copyright: '© 2026 Andrew Karaushu',
		directories: { app: join(stage, 'app'), output, buildResources: packaging },
		// out/main bundles every dependency but `electron`: the archive holds only the UI, main and a package.json.
		files: ['package.json', 'out/**/*'],
		asar: true,
		npmRebuild: false,
		nodeGypRebuild: false,
		buildDependenciesFromSource: false,
		includePdb: false,
		// spec/architecture-and-platform#packaging: zsh, the agent's CLI and node-pty run these by path, so they stay outside app.asar.
		extraResources: [
			{ from: services, to: 'services', filter: ['**/*', '!**/*.map', '!node_modules/**'] },
			// A top-level node_modules is skipped by electron-builder's file sets, so node-pty is named on its own.
			{
				from: join(services, 'node_modules/node-pty'),
				to: 'services/node_modules/node-pty',
				filter: ['**/*', '!**/*.map', '!prebuilds/**'],
			},
			{
				from: join(services, 'node_modules/node-pty/prebuilds/${platform}-${arch}'),
				to: 'services/node_modules/node-pty/prebuilds/${platform}-${arch}',
			},
		],
		publish: publishConfig(),
		mac: {
			category: 'public.app-category.developer-tools',
			icon: join(workspace, 'apps/desktop/resources/brigadir.icon'),
			minimumSystemVersion: '13.0',
			darkModeSupport: true,
			hardenedRuntime: true,
			gatekeeperAssess: false,
			entitlements: join(packaging, 'entitlements.mac.plist'),
			entitlementsInherit: join(packaging, 'entitlements.mac.plist'),
			// spec/architecture-and-platform#packaging: without a certificate the build is ad-hoc; the same entitlements keep both builds alike.
			identity: signing.developerId ? undefined : '-',
			notarize: signing.notarize,
			artifactName: '${productName}-${version}-${arch}.${ext}',
			// spec/remote-access-and-mobile#transport-and-protocol: remote access looks for machines over Bonjour and connects to LAN addresses; macOS asks once.
			extendInfo: {
				NSLocalNetworkUsageDescription:
					'Brigadir finds your paired computers on the local network and connects to them for remote access.',
				NSBonjourServices: ['_brigadir._tcp'],
			},
		},
		dmg: { title: '${productName} ${version}', writeUpdateInfo: false, sign: false },
		// spec/architecture-and-platform#packaging [LATER]: the targets of a full Windows build; scripts/dist.mjs refuses it until the port lands (spec/architecture-and-platform#packaging:
		// no client-only build). The full Linux build is linuxBuilderConfig (spec/architecture-and-platform#linux-package).
		win: {
			target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
			artifactName: '${productName}-${version}-${arch}-setup.${ext}',
		},
		nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
	};
}
