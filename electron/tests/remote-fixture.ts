import {
	_electron as electron,
	expect,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
/** spec/remote-access-and-mobile#architecture: two instances of Brigadir on one machine — the working machine and a paired device (spec/remote-access-and-mobile#pairing). */
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

/** Two free loopback ports one after the other: the gateway and its pairing listener (spec/remote-access-and-mobile#pairing). */
export async function freePorts(): Promise<number> {
	const free = (port: number) =>
		new Promise<boolean>((done) => {
			const server = createServer();
			server.once('error', () => done(false));
			server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
		});
	for (;;) {
		const port = 41000 + Math.floor(Math.random() * 9000) * 2;
		if ((await free(port)) && (await free(port + 1))) return port;
	}
}
export type Machine = { root: string; data: string };
export async function machine(
	name: string,
	remoteAccess: boolean,
	task: string | null,
	/** spec/remote-access-and-mobile#browser-from-device: the simulator module for a machine that shows one (off by default). */
	options: { simulator?: boolean } = {}
): Promise<Machine> {
	const root = await mkdtemp(join(tmpdir(), `brigadir-remote-${name}-`)),
		data = join(root, 'data');
	await mkdir(data, { recursive: true });
	if (task) {
		const repo = join(root, 'repo'),
			taskDir = join(data, 'projects/project/tasks/task');
		await mkdir(repo);
		await mkdir(taskDir, { recursive: true });
		await writeFile(
			join(taskDir, '../../project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
		);
		await writeFile(
			join(taskDir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id: 'task',
					projectId: 'project',
					title: task,
					status: 'done',
					provider: 'claude',
					transport: 'gui',
				},
			})
		);
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'dark',
				language: 'en',
				modules: {
					browser: true,
					simulator: options.simulator ?? false,
					pullRequests: true,
					commands: true,
					remoteAccess,
				},
				remoteAccess: {
					enabled: false,
					machineName: name,
					listen: { lan: true, tailscale: true },
				},
			},
		})
	);
	return { root, data };
}
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
export function launch(
	at: Machine,
	port: number,
	extra: Record<string, string> = {},
	/** Chromium switches before the app (spec/remote-access-and-mobile#networking: `--force-device-scale-factor=2` for a Retina-like display). */
	switches: string[] = []
) {
	return electron.launch({
		executablePath,
		args: [...switches, desktop, `--user-data-dir=${join(at.root, 'profile')}`],
		env: {
			...env,
			...extra,
			BRIGADIR_DATA_DIR: at.data,
			// spec/remote-access-and-mobile#pairing: both instances on loopback, each with its own ports.
			BRIGADIR_REMOTE_LISTEN: '127.0.0.1',
			BRIGADIR_REMOTE_PORT: String(port),
			BRIGADIR_REMOTE_PAIRING_PORT: String(port + 1),
			// No OS keychain prompt in a background test.
			BRIGADIR_TEST_REMOTE_VAULT: '1',
		},
	});
}
export async function menuAction(app: ElectronApplication, id: string) {
	await expect
		.poll(() =>
			app.evaluate(
				({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.enabled ?? false,
				id
			)
		)
		.toBe(true);
	await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
}
/** spec/settings-modules-and-onboarding#module-settings-popup: remote access settings — the popup of Settings ▸ Modules ▸ Remote access ⚙ (Settings must be open). */
export async function openRemoteSettings(page: Page) {
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	await settings.getByRole('tab', { name: 'Modules', exact: true }).click();
	await settings.locator('[data-module-settings-button="remoteAccess"]').click();
	const popup = page.locator('dialog[data-module-settings="remoteAccess"]');
	await expect(popup).toBeVisible();
	return popup;
}

/**
 * The working machine turns access on, the device pairs by the code and connects: the device's window of the machine.
 * The same steps the first remote access test checks one by one; here they are the way in.
 */
export async function connectDevice(
	work: ElectronApplication,
	device: ElectronApplication,
	port: number
) {
	const page = await work.firstWindow(),
		client = await device.firstWindow();
	await menuAction(work, 'settings');
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	const remoteSettings = await openRemoteSettings(page);
	await remoteSettings.getByRole('switch', { name: 'Allow control from other devices' }).click();
	const password = 'correct horse battery';
	await remoteSettings.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
	await remoteSettings.getByRole('textbox', { name: 'Repeat the password' }).fill(password);
	await remoteSettings.locator('[data-remote-enable]').click();
	await expect(remoteSettings.locator('[data-remote-status]')).toContainText('127.0.0.1');
	await remoteSettings.locator('[data-remote-add]').click();
	const pairDialog = page.locator('[data-remote-pair]');
	const code = (await pairDialog.locator('[data-remote-code]').getAttribute('data-remote-code'))!;
	// spec/appearance#evolution-redesign: the device's access is off, so it has no Remote button; File ▸ Connect… opens the list «Connect».
	await menuAction(device, 'connect');
	const connect = client.locator('dialog[data-remote-connect]');
	await connect.locator('[data-remote-new]').click();
	await expect(connect).toHaveAttribute('data-remote-connect', 'new');
	await connect.locator('[data-remote-address]').click();
	await connect.getByRole('textbox', { name: 'Address', exact: true }).fill('127.0.0.1');
	await connect.getByRole('textbox', { name: 'Port', exact: true }).fill(String(port));
	await connect.getByRole('button', { name: 'Next', exact: true }).click();
	await connect.getByRole('textbox', { name: 'Code character 1' }).focus();
	await client.keyboard.type(code);
	await pairDialog.locator('[data-remote-pair-accept]').click();
	await expect(pairDialog).toHaveCount(0);
	// Esc closes the popup, back to Settings ▸ Modules; the second closes Settings.
	await page.keyboard.press('Escape');
	await expect(remoteSettings).toBeHidden();
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();
	await expect(connect).toHaveAttribute('data-remote-connect', 'paired');
	const opened = device.waitForEvent('window');
	await connect.locator('[data-remote-password]').fill(password);
	await connect.locator('[data-remote-password]').press('Enter');
	const remote = await opened;
	await expect(connect).toHaveCount(0);
	return { page, client, remote };
}

/** spec/remote-access-and-mobile#phone-network, spec/remote-access-and-mobile#phone-app: a phone in its own hidden Electron window at the machine's web listener, with a virtual
 *  authenticator over CDP (WebAuthn.addVirtualAuthenticator), touch, and the phone's size, user agent and colour scheme. */
export type PhoneLook = { size?: string; agent?: string; dark?: boolean };
export async function phoneAt(url: string, profile: string, look: PhoneLook = {}) {
	const app = await electron.launch({
		executablePath,
		args: [resolve('tests/fixtures/web-phone/main.cjs'), `--user-data-dir=${profile}`],
		env: {
			...env,
			BRIGADIR_PHONE_URL: url,
			...(look.size ? { BRIGADIR_PHONE_SIZE: look.size } : {}),
			...(look.agent ? { BRIGADIR_PHONE_UA: look.agent } : {}),
		},
	});
	const page = await app.firstWindow();
	const cdp = await app.context().newCDPSession(page);
	// A hidden window has no focus, and WebAuthn wants a focused document.
	await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	if (look.dark !== undefined)
		await cdp.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'prefers-color-scheme', value: look.dark ? 'dark' : 'light' }],
		});
	await cdp.send('WebAuthn.enable', { enableUI: false });
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	return { app, page };
}
/** Pairs the phone at its sign-in page by the machine's code and passkey; the person at the machine confirms the name. */
export async function pairPhone(
	machineWindow: import('@playwright/test').Page,
	page: import('@playwright/test').Page,
	name: string,
	shot: (name: string) => Promise<unknown> = async () => {}
) {
	const pairing = await machineWindow.evaluate(() => window.brigadir.startRemotePairing());
	const code = (pairing as { code: string }).code;
	await page.locator('[data-pair-open]').click();
	await page.locator('[data-pair-code]').fill(code);
	await page.locator('[data-pair-submit]').click();
	await expect(page.locator('#root')).toHaveAttribute('data-state', 'pair-register');
	await page.locator('[data-pair-name]').fill(name);
	await shot('pair-name');
	await page.locator('[data-pair-create]').click();
	await expect(page.locator('#root')).toHaveAttribute('data-state', 'pair-wait');
	await expect
		.poll(() =>
			machineWindow.evaluate(async () => (await window.brigadir.readRemoteAccess()).pairing.state)
		)
		.toBe('confirm');
	await machineWindow.evaluate(() => window.brigadir.confirmRemotePairing(true, null));
	// An iPhone in Safari: the Home Screen step first, then the sign-in.
	await expect(page.locator('#root')).toHaveAttribute('data-state', /^(signin|install)$/);
	if ((await page.locator('#root').getAttribute('data-state')) === 'install') {
		await expect(page.locator('#root')).toContainText('Home Screen');
		await shot('install');
		await page.locator('[data-continue]').click();
	}
	await expect(page.locator('#root')).toHaveAttribute('data-state', 'signin');
}
