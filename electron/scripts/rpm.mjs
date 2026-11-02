// spec/architecture-and-platform#linux-package (first spec/remote-access-and-mobile#identity-and-keys): Brigadir as an .rpm for Fedora and other rpm systems. electron-builder's rpm target needs a
// working rpmbuild, which does not build for x86_64 on an arm64 Mac; nfpm writes the rpm itself on any OS. The payload is
// the same unpacked app the .deb carries, installed into /opt/Brigadir with the same desktop file and icon.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** nfpm's own names for the architectures electron-builder builds. */
const nfpmArch = { x64: 'amd64', arm64: 'arm64' };
/** The rpm file name keeps the deb's pattern with the rpm's own architecture names. */
export const rpmArch = { x64: 'x86_64', arm64: 'aarch64' };

const desktopFile = (description) => `[Desktop Entry]
Name=Brigadir
Exec=/opt/Brigadir/brigadir %U
Terminal=false
Type=Application
Icon=brigadir
StartupWMClass=brigadir
Comment=${description}
Categories=Development;
`;

// The same steps as the .deb's scripts that matter on Fedora: the command on PATH, the Chromium sandbox helper only where
// user namespaces are off, the menu entry. AppArmor is Ubuntu's; Fedora uses SELinux and needs nothing here.
const postInstall = `#!/bin/sh
ln -sf /opt/Brigadir/brigadir /usr/bin/brigadir
if [ -L /proc/self/ns/user ] && unshare --user true 2>/dev/null; then
  chmod 0755 /opt/Brigadir/chrome-sandbox || true
else
  chmod 4755 /opt/Brigadir/chrome-sandbox || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
`;
// $1 is 0 on erase and 1 on upgrade: keep the command while a new version replaces the old one.
const postRemove = `#!/bin/sh
if [ "$1" = "0" ]; then rm -f /usr/bin/brigadir; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
`;

/**
 * @param {{output:string, archs:string[], version:string, release:string, icon:string, description:string,
 *   homepage:string, depends:string[], recommends:string[], file:(arch:string)=>string}} options
 * @returns {Promise<string[]>} the rpm paths
 */
export async function buildRpms({
	output,
	archs,
	version,
	release,
	icon,
	description,
	homepage,
	depends,
	recommends,
	file,
}) {
	try {
		execFileSync('nfpm', ['--version'], { stdio: 'ignore' });
	} catch {
		throw new Error(
			'An .rpm needs nfpm on PATH: brew install nfpm (macOS) or a release from github.com/goreleaser/nfpm.'
		);
	}
	const work = join(output, 'rpm-work');
	await rm(work, { recursive: true, force: true });
	await mkdir(work, { recursive: true });
	await writeFile(join(work, 'brigadir.desktop'), desktopFile(description));
	await writeFile(join(work, 'postinstall.sh'), postInstall);
	await writeFile(join(work, 'postremove.sh'), postRemove);
	const rpms = [];
	for (const arch of archs) {
		const unpacked = join(output, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`);
		const target = join(output, file(arch));
		// nfpm reads YAML; JSON is valid YAML, so the config is written as JSON.
		const config = {
			name: 'brigadir',
			arch: nfpmArch[arch],
			platform: 'linux',
			version,
			release,
			maintainer: 'Brigadir',
			vendor: 'Brigadir',
			homepage,
			license: 'Apache-2.0',
			description,
			depends,
			recommends,
			contents: [
				{ src: unpacked, dst: '/opt/Brigadir', type: 'tree' },
				{ src: join(work, 'brigadir.desktop'), dst: '/usr/share/applications/brigadir.desktop' },
				{ src: icon, dst: '/usr/share/icons/hicolor/512x512/apps/brigadir.png' },
			],
			scripts: {
				postinstall: join(work, 'postinstall.sh'),
				postremove: join(work, 'postremove.sh'),
			},
			rpm: { compression: 'xz' },
		};
		const configFile = join(work, `nfpm-${arch}.yaml`);
		await writeFile(configFile, JSON.stringify(config, null, 2));
		execFileSync(
			'nfpm',
			['package', '--config', configFile, '--packager', 'rpm', '--target', target],
			{ stdio: 'inherit' }
		);
		rpms.push(target);
	}
	await rm(work, { recursive: true, force: true });
	return rpms;
}
