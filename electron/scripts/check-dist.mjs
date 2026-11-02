// spec/architecture-and-platform#macos-package: mounts a release DMG read-only and checks the bundle inside it. `node scripts/check-dist.mjs <dmg> [--x64]`.
// Never launches the app.
import { execFile } from 'node:child_process';
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appId, productName, releasesRepo } from '../packaging/electron-builder.config.mjs';
const exec = promisify(execFile);
const output = async (command, args) => {
	const { stdout, stderr } = await exec(command, args, { maxBuffer: 16 << 20 });
	return stdout + stderr;
};
const status = async (command, args) => {
	try {
		return { ok: true, text: await output(command, args) };
	} catch (error) {
		return { ok: false, text: String(error.stdout ?? '') + String(error.stderr ?? error.message) };
	}
};

const services = [
	'host.cjs',
	'hook.cjs',
	'syntax.cjs',
	'diff.cjs',
	'prettier.cjs',
	'android.cjs',
	'fonts',
	'sim-helper',
	'notification-auth.node',
	'process-owner',
	'mcp-relay',
	// spec/architecture-and-platform#linux-package: the relay Linux runs for CLI hooks; built on macOS too, where the relay tests run it.
	'cli-relay',
	'scrcpy-server',
	'scrcpy-LICENSE',
	'hook.zsh',
	'statusline.zsh',
	'shell/.zshenv',
	'shell/.zprofile',
	'shell/.zshrc',
	'shell/bashrc',
	'shell/fish.fish',
	'syntax-assets/tree-sitter.wasm',
	'syntax-assets/tree-sitter-scss.wasm',
	'syntax-assets/tree-sitter-json.wasm',
	'lsp/node_modules/typescript/lib/tsserver.js',
	'lsp/node_modules/typescript-language-server/lib/cli.mjs',
	'node_modules/node-pty/package.json',
];
const fat = [
	'fonts',
	'sim-helper',
	'notification-auth.node',
	'process-owner',
	'mcp-relay',
	'cli-relay',
];

async function machO(path) {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(4);
		await handle.read(buffer, 0, 4, 0);
		const magic = buffer.readUInt32BE(0);
		return [0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xcafebabe].includes(magic);
	} finally {
		await handle.close();
	}
}
async function files(root) {
	const found = [];
	for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
		if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
	return found;
}
/** The asar header is a JSON tree after a 16-byte pickle prefix. */
async function asarEntries(path) {
	const buffer = await readFile(path);
	const size = buffer.readUInt32LE(12);
	const header = JSON.parse(buffer.subarray(16, 16 + size).toString('utf8'));
	const names = [];
	const walk = (node, prefix) => {
		for (const [name, child] of Object.entries(node.files ?? {})) {
			const full = prefix ? `${prefix}/${name}` : name;
			names.push(full);
			if (child.files) walk(child, full);
		}
	};
	walk(header, '');
	return names;
}

/** @param {string} dmg @param {{arch:'arm64'|'x64',developerId:boolean}} options */
export async function checkDmg(dmg, { arch, developerId }) {
	const machArch = arch === 'x64' ? 'x86_64' : 'arm64',
		problems = [],
		notes = [];
	const mount = await mkdtemp(join(tmpdir(), 'brigadir-dmg-'));
	await exec('/usr/bin/hdiutil', [
		'attach',
		'-nobrowse',
		'-readonly',
		'-noautoopen',
		'-mountpoint',
		mount,
		dmg,
	]);
	try {
		const app = join(mount, `${productName}.app`),
			contents = join(app, 'Contents'),
			resources = join(contents, 'Resources');
		const plist = async (key) =>
			(
				await output('/usr/bin/plutil', [
					'-extract',
					key,
					'raw',
					'-o',
					'-',
					join(contents, 'Info.plist'),
				])
			).trim();
		if ((await plist('CFBundleIdentifier')) !== appId)
			problems.push(`CFBundleIdentifier is ${await plist('CFBundleIdentifier')}`);
		if ((await plist('CFBundleName')) !== productName)
			problems.push('CFBundleName is not Brigadir');
		// spec/remote-access-and-mobile#networking: remote access asks macOS for the local network once; without these keys it is denied silently.
		if (!(await plist('NSLocalNetworkUsageDescription').catch(() => '')))
			problems.push('no NSLocalNetworkUsageDescription');
		if (!(await plist('NSBonjourServices.0').catch(() => '')).includes('_brigadir._tcp'))
			problems.push('NSBonjourServices does not list _brigadir._tcp');
		notes.push(
			`version ${await plist('CFBundleShortVersionString')} (${await plist('CFBundleVersion')}), LSMinimumSystemVersion ${await plist('LSMinimumSystemVersion')}`
		);
		const icon = await status('/usr/bin/plutil', [
			'-extract',
			'CFBundleIconName',
			'raw',
			'-o',
			'-',
			join(contents, 'Info.plist'),
		]);
		if (!icon.ok && !(await readdir(resources)).some((name) => name.endsWith('.icns')))
			problems.push('no app icon');
		if (!(await readdir(resources)).includes('Assets.car')) notes.push('no Assets.car (icns only)');
		if ((await readdir(resources)).includes('default_app.asar'))
			problems.push('Electron default_app.asar is still in the bundle');
		// spec/architecture-and-platform#auto-update: the app finds its updates through this file.
		problems.push(...(await updateFeedProblems(join(resources, 'app-update.yml'))));
		const entries = await asarEntries(join(resources, 'app.asar'));
		for (const need of [
			'package.json',
			'out/main/index.js',
			'out/preload/index.cjs',
			'out/renderer/index.html',
			'out/renderer-mobile/index.html',
			'out/renderer-mobile/bundle-manifest.json',
		])
			if (!entries.includes(need)) problems.push(`app.asar lacks ${need}`);
		if (entries.some((name) => name === 'node_modules' || name.startsWith('node_modules/')))
			problems.push('app.asar carries node_modules');
		if (entries.some((name) => name.startsWith('out/services')))
			problems.push('app.asar carries out/services');
		const serviceRoot = join(resources, 'services');
		for (const need of services)
			await stat(join(serviceRoot, need)).catch(() => problems.push(`services lack ${need}`));
		const prebuilds = await readdir(join(serviceRoot, 'node_modules/node-pty/prebuilds'));
		if (prebuilds.join() !== `darwin-${arch}`)
			problems.push(`node-pty prebuilds are ${prebuilds.join(', ')}, not darwin-${arch}`);
		if (
			!(
				await stat(join(serviceRoot, `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`))
			).mode & 0o111
		)
			problems.push('spawn-helper is not executable');
		if ((await files(serviceRoot)).some((path) => path.endsWith('.map')))
			problems.push('services carry source maps');
		// Every Mach-O in the bundle: right architecture, valid signature.
		const binaries = [];
		for (const path of await files(contents)) if (await machO(path)) binaries.push(path);
		for (const path of binaries) {
			const name = relative(contents, path),
				archs = (await output('/usr/bin/lipo', ['-archs', path])).trim().split(/\s+/);
			if (!archs.includes(machArch))
				problems.push(`${name} lacks ${machArch} (${archs.join(' ')})`);
			if (fat.some((helper) => name === `Resources/services/${helper}`) && archs.length < 2)
				problems.push(`${name} is not fat (${archs.join(' ')})`);
			const verify = await status('/usr/bin/codesign', ['--verify', '--strict', path]);
			if (!verify.ok) problems.push(`${name}: ${verify.text.trim()}`);
		}
		const deep = await status('/usr/bin/codesign', [
			'--verify',
			'--deep',
			'--strict',
			'--verbose=2',
			app,
		]);
		if (!deep.ok) problems.push(`codesign --deep: ${deep.text.trim()}`);
		const details = await output('/usr/bin/codesign', ['-dv', '--verbose=2', app]);
		if (!/flags=.*runtime/.test(details)) problems.push('hardened runtime is off');
		const signature = /Signature=adhoc/.test(details)
			? 'ad-hoc'
			: (/Authority=(Developer ID Application[^\n]*)/.exec(details)?.[1] ?? 'unknown');
		if (developerId && signature === 'ad-hoc')
			problems.push('expected a Developer ID signature, found ad-hoc');
		const entitlements = await output('/usr/bin/codesign', ['-d', '--entitlements', ':-', app]);
		if (entitlements.includes('com.apple.security.app-sandbox'))
			problems.push('App Sandbox is on (rule 13)');
		for (const key of [
			'com.apple.security.cs.allow-jit',
			'com.apple.security.cs.allow-unsigned-executable-memory',
			'com.apple.security.cs.disable-library-validation',
		])
			if (!entitlements.includes(key)) problems.push(`entitlement ${key} missing`);
		const helperSignatures = [];
		for (const helper of [
			...fat,
			`node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`,
			`node_modules/node-pty/prebuilds/darwin-${arch}/pty.node`,
		]) {
			const text = await output('/usr/bin/codesign', ['-dv', join(serviceRoot, helper)]);
			helperSignatures.push(
				`${helper}: ${/Signature=adhoc/.test(text) ? 'ad-hoc' : (/Authority=([^\n]*)/.exec(text)?.[1] ?? 'signed')}${/flags=.*runtime/.test(text) ? ', runtime' : ''}`
			);
		}
		const gatekeeper = await status('/usr/sbin/spctl', ['-a', '-vv', '-t', 'exec', app]);
		console.log(
			`\n${relative(process.cwd(), dmg)} [${arch}]\n  signature: ${signature}; ${notes.join('; ')}\n  Mach-O files: ${binaries.length}; helpers:\n    ${helperSignatures.join('\n    ')}\n  Gatekeeper: ${gatekeeper.text.trim().replaceAll('\n', '; ')}`
		);
		if (problems.length)
			throw new Error(`${dmg} failed the bundle check:\n  - ${problems.join('\n  - ')}`);
		console.log('  bundle check: OK');
	} finally {
		await exec('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() =>
			exec('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet'])
		);
		await rm(mount, { recursive: true, force: true });
	}
}

/** spec/architecture-and-platform#auto-update: `app-update.yml` in the package names the releases repository of apps/desktop/package.json. */
export async function updateFeedProblems(path) {
	const text = await readFile(path, 'utf8').catch(() => null);
	if (text === null) return ['no app-update.yml: the app cannot find its updates'];
	const { owner, repo } = releasesRepo();
	const problems = [];
	for (const line of ['provider: github', `owner: ${owner}`, `repo: ${repo}`])
		if (!text.split('\n').includes(line)) problems.push(`app-update.yml lacks "${line}"`);
	if (!/^updaterCacheDirName: \S+/m.test(text))
		problems.push('app-update.yml lacks updaterCacheDirName');
	return problems;
}
/** spec/architecture-and-platform#auto-update: `latest-mac.yml` is of this version and lists the zip of every architecture built, and the zips exist. */
export async function checkMacUpdateInfo(output, { version, archs }) {
	const problems = [];
	const text = await readFile(join(output, 'latest-mac.yml'), 'utf8').catch(() => null);
	if (text === null) problems.push('no latest-mac.yml');
	else if (!text.split('\n').includes(`version: ${version}`))
		problems.push(`latest-mac.yml is not of version ${version}`);
	for (const arch of archs) {
		const zip = `${productName}-${version}-${arch}.zip`;
		if (text !== null && !text.includes(`url: ${zip}`))
			problems.push(`latest-mac.yml does not list ${zip}`);
		await stat(join(output, zip)).catch(() => problems.push(`no ${zip}`));
	}
	if (problems.length)
		throw new Error(`The update files failed the check:\n  - ${problems.join('\n  - ')}`);
	console.log(`latest-mac.yml: ${version}, ${archs.map((arch) => `${arch} zip`).join(', ')}: OK`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dmg = process.argv[2];
	if (!dmg) {
		console.error('usage: node scripts/check-dist.mjs <dmg> [--x64]');
		process.exit(2);
	}
	await checkDmg(dmg, {
		arch: process.argv.includes('--x64') ? 'x64' : 'arm64',
		developerId: false,
	});
}
