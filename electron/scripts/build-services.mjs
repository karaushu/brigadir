import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { mkdir, copyFile, cp, chmod, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { existsSync } from 'node:fs';
// spec/architecture-and-platform#packaging: `pnpm dist:mac` asks for fat helpers (BRIGADIR_MAC_ARCHS=arm64,x86_64), so one services folder serves both DMGs.
const macArchs =
	process.platform === 'darwin'
		? (process.env.BRIGADIR_MAC_ARCHS ?? '')
				.split(',')
				.filter(Boolean)
				.flatMap((arch) => ['-arch', arch])
		: [];
import { join } from 'node:path';
// Resolve this pnpm workspace through Node, independent of an unrelated ancestor Yarn PnP file.
const nodeResolution = {
	name: 'workspace-node-resolution',
	setup(api) {
		api.onResolve({ filter: /^[^./]/ }, (args) =>
			isBuiltin(args.path) || args.path === 'node-pty'
				? { path: args.path, external: true }
				: { path: createRequire(join(args.resolveDir, 'package.json')).resolve(args.path) }
		);
	},
};
// spec/architecture-and-platform#auto-update: the host records the app version its code comes from, so a newer app replaces it.
const appVersion = JSON.parse(await readFile('apps/desktop/package.json', 'utf8')).version;
await build({
	entryPoints: {
		hook: 'packages/host/src/hook-entry.ts',
		syntax: 'packages/syntax/src/worker.ts',
		diff: 'packages/diff/src/worker.ts',
		host: 'packages/host/src/entry.ts',
		prettier: 'packages/lsp/src/prettier-worker.ts',
		android: 'apps/desktop/src/services/android-helper.ts',
	},
	outdir: 'apps/desktop/out/services',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	outExtension: { '.js': '.cjs' },
	sourcemap: true,
	logLevel: 'info',
	plugins: [nodeResolution],
	define: { 'process.env.BRIGADIR_APP_VERSION': JSON.stringify(appVersion) },
});

const assets = 'apps/desktop/out/services/syntax-assets';
await mkdir(assets, { recursive: true });
const runtime = dirname(
	createRequire(join(process.cwd(), 'packages/syntax/package.json')).resolve(
		'@vscode/tree-sitter-wasm'
	)
);
for (const name of [
	'tree-sitter.wasm',
	...[
		'javascript',
		'typescript',
		'tsx',
		'css',
		'python',
		'bash',
		'rust',
		'go',
		'ruby',
		'java',
		'cpp',
		'c-sharp',
		'php',
		'ini',
		'powershell',
	].map((name) => `tree-sitter-${name}.wasm`),
])
	await copyFile(join(runtime, name), join(assets, name));
// spec/editor-code-intelligence#css-scss: grammars @vscode/tree-sitter-wasm does not ship, built for its runtime (packages/syntax/grammars/README.md).
for (const name of [
	'tree-sitter-scss.wasm',
	'LICENSE-tree-sitter-scss',
	'tree-sitter-json.wasm',
	'LICENSE-tree-sitter-json',
])
	await copyFile(join('packages/syntax/grammars', name), join(assets, name));

for (const name of ['LICENSE', 'cgmanifest.json'])
	await copyFile(join(runtime, '..', name), join(assets, name));

// spec/editor-code-intelligence#server-processes: the bundled TypeScript language server runs from here with Electron's Node; no network.
const lspRequire = createRequire(join(process.cwd(), 'packages/lsp/package.json'));
const lspTarget = 'apps/desktop/out/services/lsp/node_modules';
await rm('apps/desktop/out/services/lsp', { recursive: true, force: true });
for (const [pkg, files] of [
	['typescript-language-server', ['package.json', 'LICENSE', 'lib']],
	['typescript', ['package.json', 'LICENSE.txt', 'ThirdPartyNoticeText.txt', 'lib']],
]) {
	const root = dirname(lspRequire.resolve(`${pkg}/package.json`));
	for (const name of files)
		await cp(join(root, name), join(lspTarget, pkg, name), { recursive: true });
}

const ptyRoot = dirname(
	createRequire(join(process.cwd(), 'packages/host/package.json')).resolve('node-pty/package.json')
);
const ptyTarget = 'apps/desktop/out/services/node_modules/node-pty';
await mkdir(ptyTarget, { recursive: true });
for (const name of ['package.json', 'LICENSE', 'lib', 'prebuilds'])
	await cp(join(ptyRoot, name), join(ptyTarget, name), { recursive: true });
// spec/architecture-and-platform#linux-package: node-pty has no Linux prebuild; on a Linux computer `pnpm install` built it from source (node-gyp).
if (existsSync(join(ptyRoot, 'build/Release/pty.node')))
	await cp(join(ptyRoot, 'build/Release/pty.node'), join(ptyTarget, 'build/Release/pty.node'));
// spec/architecture-and-platform#packaging: a packaged x64 build ships the x64 prebuild, so every spawn-helper of this platform stays executable.
if (process.platform !== 'win32')
	for (const arch of ['arm64', 'x64']) {
		const helper = join(ptyTarget, 'prebuilds', `${process.platform}-${arch}`, 'spawn-helper');
		if (existsSync(helper)) await chmod(helper, 0o755);
	}
const shellTarget = 'apps/desktop/out/services/shell';
await rm(shellTarget, { recursive: true, force: true });
await mkdir(shellTarget, { recursive: true });
for (const name of ['.zshenv', '.zprofile', '.zshrc', 'bashrc', 'fish.fish'])
	await copyFile(join('packages/host/resources/shell', name), join(shellTarget, name));
// TUI-06: the CLI hook relay; hook.cjs stays for CLIs launched with an earlier build's settings.
await copyFile('packages/host/resources/hook.zsh', 'apps/desktop/out/services/hook.zsh');
await copyFile(
	'packages/host/resources/statusline.zsh',
	'apps/desktop/out/services/statusline.zsh'
);

if (process.platform === 'darwin')
	await promisify(execFile)('/usr/bin/xcrun', [
		'clang',
		...macArchs,
		'-fobjc-arc',
		'-O2',
		'-framework',
		'AppKit',
		'-framework',
		'CoreText',
		'apps/desktop/native/fonts.m',
		'-o',
		'apps/desktop/out/services/fonts',
	]);
// spec/browser-and-simulator#simulator: one sim-helper per booted iOS device; CoreSimulator and SimulatorKit are dlopen'ed from the active Xcode at run time.
if (process.platform === 'darwin')
	await promisify(execFile)('/usr/bin/xcrun', [
		'clang',
		...macArchs,
		'-fobjc-arc',
		'-O2',
		'-Wall',
		'-Wextra',
		'-Werror',
		...[
			'Foundation',
			'AppKit',
			'CoreImage',
			'CoreMedia',
			'CoreVideo',
			'IOSurface',
			'VideoToolbox',
		].flatMap((name) => ['-framework', name]),
		'apps/desktop/native/sim-helper.m',
		'-o',
		'apps/desktop/out/services/sim-helper',
	]);
// spec/browser-and-simulator#simulator: android.cjs mirrors and drives an Android device through scrcpy-server v4.1 (Apache-2.0), pushed to the device at run time.
const scrcpyServer = await readFile('apps/desktop/native/scrcpy-server-v4.1');
const scrcpyHash = createHash('sha256').update(scrcpyServer).digest('hex');
if (scrcpyHash !== 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae')
	throw new Error(
		`apps/desktop/native/scrcpy-server-v4.1 has sha256 ${scrcpyHash}, not the vendored v4.1 release`
	);
await copyFile('apps/desktop/native/scrcpy-server-v4.1', 'apps/desktop/out/services/scrcpy-server');
await copyFile('apps/desktop/native/scrcpy-LICENSE', 'apps/desktop/out/services/scrcpy-LICENSE');
// spec/notifications-slack-notes-and-schedules#macos-permission: notification authorization is an N-API addon loaded by main, so macOS answers for the app's own bundle.
// N-API is ABI-stable: the headers of the Node running this build serve Electron's embedded Node as well.
if (process.platform === 'darwin')
	await promisify(execFile)('/usr/bin/xcrun', [
		'clang',
		...macArchs,
		'-fobjc-arc',
		'-O2',
		'-Wall',
		'-Wextra',
		'-Werror',
		'-bundle',
		'-undefined',
		'dynamic_lookup',
		'-framework',
		'Foundation',
		'-framework',
		'UserNotifications',
		'-I',
		join(dirname(process.execPath), '..', 'include', 'node'),
		'apps/desktop/native/notification-auth.m',
		'-o',
		'apps/desktop/out/services/notification-auth.node',
	]);
// MCP-04: the agent's MCP server is a byte relay into the host (`mcp-relay` = HostConfig.mcpEntry), not a Node bundle.
if (process.platform !== 'win32')
	for (const [source, output] of [
		['packages/persistence/native/process-owner.c', 'process-owner'],
		['packages/host/native/mcp-relay.c', 'mcp-relay'],
		// spec/architecture-and-platform#linux-package: CLI hooks and the statusline where zsh is not a given; built on macOS too so the relay tests run both.
		['packages/host/native/cli-relay.c', 'cli-relay'],
	])
		await promisify(execFile)(process.platform === 'darwin' ? '/usr/bin/xcrun' : 'cc', [
			...(process.platform === 'darwin' ? ['clang', ...macArchs] : []),
			'-O2',
			'-Wall',
			'-Wextra',
			'-Werror',
			source,
			'-o',
			`apps/desktop/out/services/${output}`,
		]);
await rm('apps/desktop/out/services/mcp.cjs', { force: true });
await rm('apps/desktop/out/services/mcp.cjs.map', { force: true });
