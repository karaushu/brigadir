import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAppSettings, type AppSettings, type PairedMachine } from '@brigadir/core';
import type { KeyVault } from '@brigadir/remote';
import { Clients, type Client } from './clients';
import { dispatchCall, type Handler } from './dispatch';
import { RemoteAccess, remoteTestHooks, type ClientWindow, type DeviceUi } from './remote-access';
import { composeAppearance } from './appearance';

const vault: KeyVault = {
	seal: (text) => Buffer.from(text).reverse(),
	open: (sealed) => Buffer.from(sealed).reverse().toString(),
};
const waitFor = async (check: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};
const waitForAsync = async (check: () => Promise<boolean>, ms = 5000) => {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Side = {
	access: RemoteAccess;
	clients: Clients;
	settings: AppSettings;
	calls: { channel: string; from: string }[];
	windows: {
		machine: PairedMachine;
		sent: { channel: string; value: unknown }[];
		window: ClientWindow;
	}[];
	dispatch(client: Client, channel: string, args: unknown[]): Promise<unknown>;
};
/** One Brigadir: its client set, main's dispatch over a few handlers, and its RemoteAccess on loopback. */
async function side(name: string, module = true, device?: DeviceUi): Promise<Side> {
	const dir = await mkdtemp(join(tmpdir(), `brigadir-remote-${name}-`));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const clients = new Clients();
	const self: Side = {
		access: null!,
		clients,
		settings: {
			...defaultAppSettings,
			modules: { ...defaultAppSettings.modules, remoteAccess: module },
			remoteAccess: { ...defaultAppSettings.remoteAccess, machineName: name },
		},
		calls: [],
		windows: [],
		dispatch: null!,
	};
	const handlers = new Map<string, Handler>();
	const record = (channel: string, value: unknown) =>
		handlers.set(channel, (client) => {
			self.calls.push({ channel, from: client.id });
			return value;
		});
	record('workspace:read', { machine: name });
	record('appearance:read', { theme: name });
	record('notifications:visible', null);
	record('settings:save', null);
	handlers.set('remote:enable', () => {
		throw new Error('the handler ran');
	});
	self.dispatch = (client, channel, args) =>
		dispatchCall(
			{
				handlers,
				guardSettings: (from, value) => self.access.guardSettings(from, value),
				isActive: (from) => self.access.isActive(from),
				refused: (from, channel) => self.access.callRefused(from, channel),
			},
			client,
			channel,
			args
		);
	self.access = new RemoteAccess({
		dataDir: dir,
		clients,
		dispatch: (client, channel, args) => self.dispatch(client, channel, args),
		settings: () => self.settings,
		saveRemoteSettings: async (next) => {
			self.settings = { ...self.settings, remoteAccess: next };
			return self.settings;
		},
		vault: () => vault,
		holdChanged: () => {},
		openWindow: (machine) => {
			const sent: { channel: string; value: unknown }[] = [];
			let destroyed = false;
			const listeners: (() => void)[] = [];
			const window: ClientWindow = {
				isDestroyed: () => destroyed,
				isFocused: () => false,
				webContents: {
					mainFrame: { url: 'file:///app/index.html' },
					send: (channel, value) => sent.push({ channel, value }),
				},
				on: (_event, listener) => listeners.push(listener),
				close: () => {
					destroyed = true;
					for (const listener of listeners) listener();
				},
			};
			self.windows.push({ machine, sent, window });
			return window;
		},
		entry: 'file:///app/index.html',
		development: false,
		log: () => {},
		listenOverride: { addresses: ['127.0.0.1'], port: 0, pairingPort: 0 },
		...(device ? { device } : {}),
	});
	cleanups.push(() => self.access.close());
	return self;
}
const local = (side: Side): Client => ({
	id: 'local',
	local: true,
	send: () => true,
	owns: () => false,
});

describe('remote access through main (spec/remote-access-and-mobile#architecture)', () => {
	it('pairs, connects a window of the device to the machine and routes its calls and events by class', async () => {
		const studio = await side('studio');
		const laptop = await side('laptop');
		await studio.access.setEnabled(true, 'a long password');
		expect(studio.access.status(local(studio)).listening).toEqual([
			{ network: 'loopback', address: '127.0.0.1' },
		]);
		expect(studio.access.holding()).toBe(true);
		const pairing = await studio.access.startPairing();
		if (pairing.state !== 'open') throw new Error('closed');
		const paired = laptop.access.pair(
			'127.0.0.1',
			studio.access.gateway.pairingPort,
			pairing.code,
			null
		);
		await waitFor(() => studio.access.gateway.pairing.current.state === 'confirm');
		expect(studio.access.gateway.pairing.current).toMatchObject({ device: 'laptop' });
		studio.access.confirmPairing(true, 'ThinkPad');
		const result = await paired;
		if (!result.ok) throw new Error(result.message);
		expect(result.machine.name).toBe('studio');
		expect((await laptop.access.readMachines()).map((machine) => machine.name)).toEqual(['studio']);

		expect(await laptop.access.connect(result.machine.id, 'a long password', true)).toEqual({
			ok: true,
		});
		expect(laptop.windows).toHaveLength(1);
		const window = laptop.clients.list().find((client) => client.id.startsWith('window:'))!;
		// A remote-class call goes to studio and runs there for the device; a client-class one runs on the laptop.
		expect(await laptop.dispatch(window, 'workspace:read', [])).toEqual({ machine: 'studio' });
		expect(await laptop.dispatch(window, 'appearance:read', [])).toEqual({ theme: 'laptop' });
		expect(studio.calls.map((call) => call.channel)).toEqual(['workspace:read']);
		expect(studio.calls[0]!.from).toMatch(/^remote:/);
		// Managing access from the device is refused on studio before its handler.
		await expect(laptop.dispatch(window, 'remote:enable', [false])).rejects.toThrow(
			'Not available from a remote device.'
		);
		// The audit on studio notes the refusal and which settings the device changed, not their values (S9).
		await laptop.dispatch(window, 'settings:save', [
			{
				...studio.settings,
				accent: 'pink',
				remoteAccess: { ...studio.settings.remoteAccess, machineName: 'hacked' },
			},
		]);
		const audit = async () => {
			const entries = await studio.access.readAudit(50);
			return {
				refused: entries.find((entry) => entry.kind === 'call-refused'),
				settings: entries.find((entry) => entry.kind === 'settings-changed'),
			};
		};
		await waitForAsync(async () => Boolean((await audit()).settings));
		expect((await audit()).refused).toMatchObject({ device: 'ThinkPad', detail: 'remote:enable' });
		expect((await audit()).settings).toMatchObject({ device: 'ThinkPad', detail: 'accent' });
		expect(studio.calls.filter((call) => call.channel === 'settings:save')).toHaveLength(1);
		// The device controls studio: its per-client calls count there, the covered local window's do not.
		expect(studio.access.gateway.status(false).control).toMatchObject({
			active: 'remote',
			device: 'ThinkPad',
		});
		expect(await studio.dispatch(local(studio), 'notifications:visible', [null])).toBeUndefined();
		expect(studio.calls.some((call) => call.channel === 'notifications:visible')).toBe(false);

		// studio's event reaches the device's window; its client-class event does not leave studio.
		studio.clients.broadcast('session:event', { key: 'k', record: null });
		studio.clients.broadcast('appearance:changed', { theme: 'studio' });
		await waitFor(() => laptop.windows[0]!.sent.some((item) => item.channel === 'session:event'));
		expect(laptop.windows[0]!.sent.some((item) => item.channel === 'appearance:changed')).toBe(
			false
		);

		// «Take back» on studio: the device's session shows it no longer controls.
		await studio.access.takeControl(local(studio));
		await waitFor(() => laptop.access.sessions()[0]?.active === false);

		// Switching the module off on studio drops the device; the laptop's window closes.
		studio.settings = {
			...studio.settings,
			modules: { ...studio.settings.modules, remoteAccess: false },
		};
		await studio.access.configure();
		await waitFor(() => laptop.access.sessions()[0]?.state === 'closed');
		expect(laptop.access.sessions()[0]?.closedReason).toBe('off');
		await expect(studio.access.readAudit(10)).rejects.toThrow('Remote access is off in Settings.');
	});
	it('answers with the module sentence while the module is off and never listens', async () => {
		const off = await side('off', false);
		await off.access.configure();
		await expect(off.access.readMachines()).rejects.toThrow('Remote access is off in Settings.');
		await expect(off.access.setEnabled(true, 'a long password')).rejects.toThrow(
			'Remote access is off in Settings.'
		);
		expect(off.access.status(local(off))).toMatchObject({ module: false, listening: [] });
		expect(off.access.holding()).toBe(false);
	});
	it('needs a password before access turns on', async () => {
		const studio = await side('studio');
		await expect(studio.access.setEnabled(true, undefined)).rejects.toThrow('Set a password');
		expect(studio.settings.remoteAccess.enabled).toBe(false);
	});
});

describe('the e2e hooks (security review R1, S4)', () => {
	const env = {
		BRIGADIR_DATA_DIR: '/tmp/brigadir-e2e',
		BRIGADIR_TEST_REMOTE_VAULT: '1',
		BRIGADIR_REMOTE_LISTEN: '127.0.0.1',
		BRIGADIR_REMOTE_PORT: '47420',
		BRIGADIR_REMOTE_PAIRING_PORT: '47421',
	};
	it('give a dev build its loopback listeners and the test key store', () => {
		const hooks = remoteTestHooks(env, false);
		expect(hooks.listenOverride).toEqual({
			addresses: ['127.0.0.1'],
			port: 47420,
			pairingPort: 47421,
		});
		expect(hooks.vault?.().open(hooks.vault().seal('key'))).toBe('key');
	});
	it('do nothing in a packaged build', () => {
		expect(remoteTestHooks(env, true)).toEqual({ listenOverride: null });
	});
	it('never listen beyond loopback', () => {
		const hooks = remoteTestHooks(
			{ BRIGADIR_REMOTE_LISTEN: '0.0.0.0,192.168.1.10,::,::1', BRIGADIR_REMOTE_PORT: '99999' },
			false
		);
		expect(hooks.listenOverride).toEqual({ addresses: ['::1'], port: 7420, pairingPort: 7421 });
		expect(hooks.vault).toBeUndefined();
		expect(remoteTestHooks({ BRIGADIR_REMOTE_LISTEN: '0.0.0.0' }, false).listenOverride).toBeNull();
	});
});

/** studio and a laptop paired and connected; the laptop's window of studio is open. */
async function connected(device?: DeviceUi) {
	const studio = await side('studio');
	const laptop = await side('laptop', true, device);
	await studio.access.setEnabled(true, 'a long password');
	const pairing = await studio.access.startPairing();
	if (pairing.state !== 'open') throw new Error('closed');
	const paired = laptop.access.pair(
		'127.0.0.1',
		studio.access.gateway.pairingPort,
		pairing.code,
		null
	);
	await waitFor(() => studio.access.gateway.pairing.current.state === 'confirm');
	studio.access.confirmPairing(true, 'ThinkPad');
	const result = await paired;
	if (!result.ok) throw new Error(result.message);
	await laptop.access.connect(result.machine.id, 'a long password', true);
	return { studio, laptop };
}
describe('what a machine sends a device (security review R2–R4)', () => {
	it(
		'V4: a broken appearance or dialog from the machine is dropped on the device, not thrown in its main',
		{ timeout: 20_000 },
		async () => {
			const device: DeviceUi = {
				menu: async () => null,
				save: async () => false,
				files: async () => null,
				notify: () => {},
				appearance: (machine) => composeAppearance(machine, null, false, '#3366ff'),
				closed: () => {},
			};
			const { studio, laptop } = await connected(device);
			const got = (record: string) =>
				laptop.windows[0]!.sent.some(
					(item) =>
						item.channel === 'session:event' && (item.value as { record: string }).record === record
				);
			// The device's subscriptions reach studio right after the welcome.
			await waitFor(() => {
				studio.clients.broadcast('session:event', { key: 'k', record: 'ready' });
				return got('ready');
			});
			studio.clients.broadcast('remote:appearance', { typography: null });
			studio.clients.broadcast('remote:dialog', { kind: 'box', id: 1, buttons: 'OK' });
			studio.clients.broadcast('session:event', { key: 'k', record: 'after' });
			await waitFor(() => got('after'));
			const channels = laptop.windows[0]!.sent.map((item) => item.channel);
			expect(channels).not.toContain('appearance:changed');
			expect(channels).not.toContain('remote:dialog');
			expect(laptop.access.sessions()[0]?.state).toBe('connected');
		}
	);
});
