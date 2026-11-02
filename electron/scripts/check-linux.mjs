// spec/architecture-and-platform#linux-package: checks the full Linux packages without running them. The unpacked app of each architecture: app.asar with
// main, preload, the renderers and no node_modules; resources/services with every service the
// app starts, each native file an ELF of that architecture with its exec bit, no Mach-O and no macOS-only helper. A .deb
// is read with `ar` and `tar` (and its Depends), an .rpm with `rpm` (Requires, the services and their modes), an AppImage
// with 7-Zip when there is one.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { asarModule, files, head, sevenZip, unpacked } from './package-files.mjs';
import { linuxNativeFiles, macOnlyServices } from './linux-natives.mjs';
import { updateFeedProblems } from './check-dist.mjs';
const exec = promisify(execFile);

/** ELF e_machine of each architecture. */
const machines = { x64: 62, arm64: 183 };
/** What main and the host start from resources/services (spec/architecture-and-platform#packaging). */
const required = [
	'host.cjs',
	'hook.cjs',
	'syntax.cjs',
	'diff.cjs',
	'prettier.cjs',
	'android.cjs',
	'scrcpy-server',
	'shell/.zshrc',
	'shell/bashrc',
	'shell/fish.fish',
	'syntax-assets/tree-sitter.wasm',
	'lsp/node_modules/typescript-language-server/lib/cli.mjs',
	'lsp/node_modules/typescript/lib/tsserver.js',
	'node_modules/node-pty/lib/index.js',
	'node_modules/node-pty/package.json',
];
const machOMagic = new Set([
	'feedface',
	'feedfacf',
	'cefaedfe',
	'cffaedfe',
	'cafebabe',
	'bebafeca',
]);
/** `{machine}` of an ELF file, `{macho:true}` of a Mach-O, null otherwise. */
async function binaryKind(path) {
	const bytes = await head(path, 20);
	if (bytes.subarray(0, 4).toString('latin1') === '\x7fELF')
		return { machine: bytes.readUInt16LE(18) };
	return machOMagic.has(bytes.subarray(0, 4).toString('hex')) ? { macho: true } : null;
}
/** What a native file may link: glibc and its split-off parts, nothing else (no libstdc++, no libnode). */
const allowedLibraries =
	/^(libc\.so\.6|libpthread\.so\.0|libdl\.so\.2|libutil\.so\.1|ld-linux[\w.-]*\.so\.\d)$/;
const glibcFloor = [2, 28];
/** NEEDED libraries and the newest GLIBC version a file asks for, from `objdump -p`; null without objdump. */
async function linkage(path) {
	const text = await exec('objdump', ['-p', path]).then(
		(result) => result.stdout,
		() => null
	);
	if (text === null) return null;
	const needed = [...text.matchAll(/^\s*NEEDED\s+(\S+)/gm)].map((match) => match[1]);
	const versions = [...text.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((match) => [
		Number(match[1]),
		Number(match[2]),
	]);
	const newest = versions.reduce(
		(top, version) =>
			version[0] > top[0] || (version[0] === top[0] && version[1] > top[1]) ? version : top,
		[0, 0]
	);
	return { needed, newest };
}
/** `file`'s description, for the log: the same line a person checks by hand. */
async function describe(path) {
	return (await exec('file', ['-b', path]).catch(() => ({ stdout: '?' }))).stdout.trim();
}

/** @param {{output:string,packages:string[],archs:string[]}} options */
export async function checkLinux({ output, packages, archs, version }) {
	const problems = [],
		notes = [];
	const asar = asarModule();
	for (const arch of archs) {
		const root = join(output, unpacked('linux', arch)),
			resources = join(root, 'resources'),
			services = join(resources, 'services');
		const all = await files(root).catch(() => null);
		if (!all) {
			problems.push(`${relative(output, root)} is missing`);
			continue;
		}
		const where = relative(output, root);
		const executable = await binaryKind(join(root, 'brigadir')).catch(() => null);
		if (executable?.machine !== machines[arch])
			problems.push(`${where}/brigadir is not an ELF for ${arch}`);
		for (const name of required)
			await stat(join(services, name)).catch(() =>
				problems.push(`${where} lacks services/${name}`)
			);
		for (const name of macOnlyServices)
			if (all.includes(join(services, name)))
				problems.push(`${where} carries the macOS-only services/${name}`);
		const natives = linuxNativeFiles(arch);
		for (const name of natives) {
			const path = join(services, name);
			const info = await stat(path).catch(() => null);
			if (!info) {
				problems.push(`${where} lacks services/${name}`);
				continue;
			}
			if (!(info.mode & 0o111)) problems.push(`services/${name} is not executable`);
			const linked = await linkage(path);
			if (linked) {
				const extra = linked.needed.filter((library) => !allowedLibraries.test(library));
				if (extra.length) problems.push(`services/${name} links ${extra.join(', ')}`);
				if (
					linked.newest[0] > glibcFloor[0] ||
					(linked.newest[0] === glibcFloor[0] && linked.newest[1] > glibcFloor[1])
				)
					problems.push(`services/${name} needs GLIBC_${linked.newest.join('.')}, above 2.28`);
			}
			if (name.endsWith('.node')) {
				const exported = await exec('nm', ['-D', '--defined-only', path]).then(
					(result) =>
						result.stdout
							.split('\n')
							.map((line) => line.trim().split(/\s+/).pop())
							.filter(Boolean),
					() => null
				);
				if (
					exported &&
					exported.some(
						(symbol) =>
							symbol !== 'napi_register_module_v1' &&
							symbol !== 'node_api_module_get_api_version_v1'
					)
				)
					problems.push(`services/${name} exports more than its Node-API entry points`);
			}
			notes.push(
				`${arch} services/${name}: ${await describe(path)}${linked ? `; links ${linked.needed.join(' ')}, GLIBC ≤ ${linked.newest.join('.')}` : ''}`
			);
		}
		// Every binary under services: an ELF of this architecture, and one of the natives above.
		for (const path of all.filter((path) => path.startsWith(services + '/'))) {
			const kind = await binaryKind(path).catch(() => null);
			if (!kind) continue;
			const name = relative(services, path);
			if (kind.macho) problems.push(`services/${name} is a Mach-O file`);
			else if (kind.machine !== machines[arch])
				problems.push(`services/${name} is an ELF for machine ${kind.machine}, not ${arch}`);
			else if (!natives.includes(name)) problems.push(`services/${name} is an unexpected ELF`);
		}
		const archive = join(resources, 'app.asar'),
			entries = asar.listPackage(archive, {}).map((name) => name.replace(/^[\\/]/, ''));
		for (const need of [
			'package.json',
			'out/main/index.js',
			'out/preload/index.cjs',
			'out/renderer/index.html',
			'out/renderer-mobile/index.html',
		])
			if (!entries.includes(need)) problems.push(`app.asar lacks ${need}`);
		if (entries.some((name) => name.startsWith('node_modules')))
			problems.push('app.asar carries node_modules');
		// spec/architecture-and-platform#auto-update: the feed of the app's update check (AppImage installs, .deb and .rpm only check).
		problems.push(
			...(await updateFeedProblems(join(resources, 'app-update.yml'))).map(
				(problem) => `${where}: ${problem}`
			)
		);
		if (version) {
			const file = arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
			const info = await readFile(join(output, file), 'utf8').catch(() => null);
			if (info === null) problems.push(`no ${file}`);
			else {
				if (!info.split('\n').includes(`version: ${version}`))
					problems.push(`${file} is not of version ${version}`);
				if (!/url: \S+\.AppImage$/m.test(info)) problems.push(`${file} lists no AppImage`);
			}
		}
		notes.push(
			`${where}: ${all.length} files, app.asar ${((await stat(archive)).size / 1024 / 1024).toFixed(1)} MB`
		);
	}
	for (const path of packages) {
		const name = relative(output, path);
		const arch = /(?:x86_64|amd64|x64)\./.test(path) ? 'x64' : 'arm64';
		if (path.endsWith('.deb')) {
			// A .deb is an `ar` archive: control.tar.* and data.tar.*; `ar` and `tar` read it on a Mac too.
			const members = (await exec('ar', ['t', path])).stdout.split('\n').filter(Boolean);
			const data = members.find((member) => member.startsWith('data.tar')),
				control = members.find((member) => member.startsWith('control.tar'));
			if (!data || !control) {
				problems.push(`${name}: not a deb (${members.join(', ')})`);
				continue;
			}
			const list = (
				await exec('/bin/sh', ['-c', `ar p "$0" ${data} | tar -tvf -`, path], {
					maxBuffer: 64 << 20,
				})
			).stdout
				.split('\n')
				.filter(Boolean);
			const missing = [...required, ...linuxNativeFiles(arch)].filter(
				(service) => !list.some((line) => line.endsWith(`/resources/services/${service}`))
			);
			if (missing.length) problems.push(`${name}: lacks services ${missing.join(', ')}`);
			for (const native of linuxNativeFiles(arch)) {
				const line = list.find((item) => item.endsWith(`/resources/services/${native}`));
				if (line && !/^-rwx/.test(line)) problems.push(`${name}: ${native} is not executable`);
			}
			const fields = (
				await exec('/bin/sh', ['-c', `ar p "$0" ${control} | tar -xOf - ./control`, path])
			).stdout;
			if (!/^Depends:.*libsecret-1-0/m.test(fields))
				problems.push(`${name}: Depends lacks libsecret-1-0`);
			notes.push(
				`${name}: ${list.length} entries; ${['Package', 'Version', 'Architecture', 'Recommends']
					.map((field) => fields.match(new RegExp(`^${field}:.*$`, 'm'))?.[0])
					.filter(Boolean)
					.join(', ')}`
			);
		} else if (path.endsWith('.rpm')) {
			// An rpm: `rpm -qp` reads it on a Mac too when rpm is installed (brew install rpm); otherwise the lead magic only.
			if ((await head(path, 4)).toString('latin1') !== '\xed\xab\xee\xdb')
				problems.push(`${name}: not an rpm`);
			const rpm = await exec('rpm', ['-qp', '--requires', path]).catch(() => null);
			if (rpm) {
				if (!/^libsecret\b/m.test(rpm.stdout)) problems.push(`${name}: Requires lacks libsecret`);
				const list = (await exec('rpm', ['-qplv', path], { maxBuffer: 64 << 20 })).stdout
					.split('\n')
					.filter(Boolean);
				const missing = [...required, ...linuxNativeFiles(arch)].filter(
					(service) =>
						!list.some((line) => line.endsWith(`/opt/Brigadir/resources/services/${service}`))
				);
				if (missing.length) problems.push(`${name}: lacks services ${missing.join(', ')}`);
				for (const native of linuxNativeFiles(arch)) {
					const line = list.find((item) => item.endsWith(`/resources/services/${native}`));
					if (line && !/^-rwx/.test(line)) problems.push(`${name}: ${native} is not executable`);
				}
				const info = (await exec('rpm', ['-qpi', path])).stdout;
				notes.push(
					`${name}: ${list.length} files; ${['Version', 'Release', 'Architecture']
						.map((field) => info.match(new RegExp(`^${field}\\s*:\\s*(.*)$`, 'm'))?.[0])
						.filter(Boolean)
						.join(', ')}`
				);
			} else notes.push(`${name}: header only (no rpm to read it)`);
		} else if (path.endsWith('.AppImage')) {
			// An AppImage of type 2: an ELF runtime with «AI\x02» at byte 8, the squashfs of the unpacked app after it.
			const bytes = await head(path, 20);
			if (
				bytes.subarray(0, 4).toString('latin1') !== '\x7fELF' ||
				bytes.subarray(8, 11).toString('latin1') !== 'AI\x02'
			)
				problems.push(`${name}: not an AppImage of type 2`);
			else if (bytes.readUInt16LE(18) !== machines[arch])
				problems.push(`${name}: the runtime is not for ${arch}`);
			const zip = await sevenZip();
			if (zip) {
				const list = (await exec(zip, ['l', '-ba', path], { maxBuffer: 64 << 20 })).stdout
					.split('\n')
					.map((line) => line.trim().split(/\s+/).pop() ?? '')
					.filter(Boolean);
				for (const need of [
					'AppRun',
					'brigadir.desktop',
					'resources/app.asar',
					'resources/app-update.yml',
					...linuxNativeFiles(arch).map((native) => `resources/services/${native}`),
				])
					if (!list.includes(need)) problems.push(`${name}: no ${need}`);
				notes.push(`${name}: ${list.length} entries (read with 7-Zip)`);
			} else notes.push(`${name}: header only (no 7-Zip to read the squashfs)`);
		}
	}
	console.log(`\nLinux check:\n  ${notes.join('\n  ')}`);
	if (problems.length)
		throw new Error(`The Linux build failed its check:\n  - ${problems.join('\n  - ')}`);
	console.log('  Linux check: OK');
}
