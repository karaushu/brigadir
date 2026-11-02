// spec/architecture-and-platform#linux-package: the native files of a Linux services folder, built from this computer (a Mac or a Linux CI runner) with
// `zig cc` / `zig c++` for glibc 2.28: the C helpers (process-owner, mcp-relay, cli-relay) and node-pty's pty.node from the
// node-pty sources in node_modules (N-API, so one build serves every Electron). macOS-only files leave the folder.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** zig's targets: the glibc floor of RHEL 8, Debian 10 and Ubuntu 18.10. */
export const linuxTargets = { x64: 'x86_64-linux-gnu.2.28', arm64: 'aarch64-linux-gnu.2.28' };
/** What only macOS uses (CoreText, UserNotifications, CoreSimulator, the zsh relays, node-pty's spawn-helper prebuilds). */
export const macOnlyServices = [
	'fonts',
	'sim-helper',
	'notification-auth.node',
	'hook.zsh',
	'statusline.zsh',
];
/** The ELF files a Linux services folder carries; check-linux.mjs checks each one's architecture. */
export const linuxNativeFiles = (arch) => [
	'process-owner',
	'mcp-relay',
	'cli-relay',
	`node_modules/node-pty/prebuilds/linux-${arch}/pty.node`,
];

async function zig(args) {
	try {
		await run('zig', ['version']);
	} catch {
		throw new Error(
			'Linux native modules are cross-compiled with zig: brew install zig (macOS) or ziglang.org/download (Linux).'
		);
	}
	await run('zig', args, { maxBuffer: 16 << 20 });
}

/**
 * Replaces the native files of `services` (a copy of out/services) with Linux ones for `arch`.
 * @param {{workspace: string, services: string, arch: 'x64' | 'arm64'}} options
 */
export async function buildLinuxNatives({ workspace, services, arch }) {
	const target = linuxTargets[arch];
	if (!target) throw new Error(`No Linux target for ${arch}`);
	for (const name of macOnlyServices) await rm(join(services, name), { force: true });
	// -s strips: no debug info in the package; -Werror keeps the helpers as clean as the macOS build.
	for (const [source, output] of [
		['packages/persistence/native/process-owner.c', 'process-owner'],
		['packages/host/native/mcp-relay.c', 'mcp-relay'],
		['packages/host/native/cli-relay.c', 'cli-relay'],
	])
		await zig([
			'cc',
			'-target',
			target,
			'-O2',
			'-s',
			'-Wall',
			'-Wextra',
			'-Werror',
			join(workspace, source),
			'-o',
			join(services, output),
		]);
	// node-pty 1.1.0: src/unix/pty.cc against node-addon-api (with C++ exceptions, as its binding.gyp) and the Node-API
	// headers of the Node running this script. libc++ is linked statically, so the module needs only glibc.
	const require = createRequire(join(workspace, 'packages/host/package.json'));
	const ptyRoot = dirname(require.resolve('node-pty/package.json'));
	const addonApi = dirname(
		createRequire(join(ptyRoot, 'package.json')).resolve('node-addon-api/package.json')
	);
	const nodeHeaders = join(dirname(process.execPath), '..', 'include', 'node');
	if (!existsSync(join(nodeHeaders, 'node_api.h')))
		throw new Error(
			`Node-API headers not found in ${nodeHeaders}: use a Node install that has include/node.`
		);
	// Only the two Node-API entry points leave the module: the static libc++ inside never meets Electron's own.
	const work = await mkdtemp(join(tmpdir(), 'brigadir-pty-'));
	const exports = join(work, 'exports.map');
	await writeFile(
		exports,
		'{ global: napi_register_module_v1; node_api_module_get_api_version_v1; local: *; };\n'
	);
	const prebuilds = join(services, 'node_modules/node-pty/prebuilds');
	await rm(prebuilds, { recursive: true, force: true });
	await mkdir(join(prebuilds, `linux-${arch}`), { recursive: true });
	await zig([
		'c++',
		'-target',
		target,
		'-shared',
		'-fPIC',
		'-O2',
		'-s',
		'-fvisibility=hidden',
		`-Wl,--version-script=${exports}`,
		'-D_FORTIFY_SOURCE=2',
		'-DNAPI_CPP_EXCEPTIONS',
		'-DBUILDING_NODE_EXTENSION',
		'-I',
		nodeHeaders,
		'-I',
		addonApi,
		join(ptyRoot, 'src/unix/pty.cc'),
		'-lutil',
		'-o',
		join(prebuilds, `linux-${arch}`, 'pty.node'),
	]).finally(() => rm(work, { recursive: true, force: true }));
	// A Linux computer's own `pnpm install` may have built node-pty from source; the package carries the cross build only.
	await rm(join(services, 'node_modules/node-pty/build'), { recursive: true, force: true });
}
