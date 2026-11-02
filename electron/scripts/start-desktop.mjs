import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { desktop, desktopRuntime } from './desktop-runtime.mjs';
import { launchSnapshot } from './launch-snapshot.mjs';
const args = process.argv.slice(2),
	dev = args.includes('--dev'),
	secondary = args.includes('--secondary');
const executable = await desktopRuntime();
const env = { ...process.env, ELECTRON_EXEC_PATH: executable };
delete env.ELECTRON_RUN_AS_NODE;
if (secondary) {
	env.BRIGADIR_BACKGROUND = '1';
	env.BRIGADIR_DISPLAY = 'secondary';
	env.BRIGADIR_INTERACTIVE = '1';
}
const forwarded = args.filter((arg) => arg !== '--dev' && arg !== '--secondary');
const vite = join(
	dirname(createRequire(join(desktop, 'package.json')).resolve('electron-vite/package.json')),
	'bin/electron-vite.js'
);
// spec/architecture-and-platform#crash-recovery: a rebuild of out/ in another session never reaches the running app. The copy lives inside apps/desktop,
// so main still resolves its externalized dependencies from apps/desktop/node_modules.
const snapshot = dev ? null : await launchSnapshot(join(desktop, 'out'), join(desktop, '.launch'));
if (snapshot) env.BRIGADIR_BUILD = snapshot.id;
// spec/remote-access-and-mobile#phone-network: the phone's bundle (`out/renderer-mobile`) is not part of electron-vite; without it the web listener
// stays off and `tailscale serve` answers the phone with 502 (a white page). Dev builds it once before starting.
if (dev) {
	const built = await new Promise((resolve) => {
		const mobile = spawn(
			process.execPath,
			[
				join(
					dirname(createRequire(join(desktop, 'package.json')).resolve('vite/package.json')),
					'bin/vite.js'
				),
				'build',
				'-c',
				'vite.mobile.config.ts',
				'--logLevel',
				'warn',
			],
			{ cwd: desktop, env, stdio: 'inherit' }
		);
		mobile.on('exit', (code) => resolve(code === 0));
		mobile.on('error', () => resolve(false));
	});
	if (!built)
		console.warn('The phone bundle did not build; the phone sign-in stays off in this run.');
}
const child = spawn(
	dev ? process.execPath : executable,
	dev ? [vite, 'dev', ...forwarded] : [...forwarded, join(snapshot.path, 'main/index.js')],
	{ cwd: desktop, env, stdio: 'inherit' }
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.on('exit', (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});
