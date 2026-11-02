import { describe, expect, it, vi } from 'vitest';
import {
	defaultAppSettings,
	guardRemoteSettings,
	ipcInvokeRows,
	type AppSettings,
} from '@brigadir/core';
import { dispatchCall, type Handler } from './dispatch';
import type { Client } from './clients';

const local: Client = { id: 'local', local: true, send: () => true, owns: () => true };
const device: Client = {
	id: 'remote:1',
	local: false,
	device: { id: 'a'.repeat(64), name: 'laptop' },
	events: 'remote',
	send: () => true,
	owns: () => false,
};
function setup(active: Client = local) {
	const calls: { channel: string; args: unknown[]; from: string }[] = [];
	const handlers = new Map<string, Handler>();
	for (const channel of ipcInvokeRows.keys())
		handlers.set(channel, (client, args) => {
			calls.push({ channel, args, from: client.id });
			return 'done';
		});
	const applied: AppSettings = {
		...defaultAppSettings,
		remoteAccess: {
			enabled: true,
			machineName: 'studio',
			listen: { lan: true, tailscale: false },
			phone: false,
		},
	};
	const refused: { client: string; channel: string }[] = [];
	const rules = {
		handlers,
		refused: (client: Client, channel: string) => refused.push({ client: client.id, channel }),
		guardSettings: (client: Client, value: AppSettings) =>
			client.device ? guardRemoteSettings(value, applied) : value,
		isActive: (client: Client) => client === active,
	};
	return {
		calls,
		refused,
		run: (client: Client | null, channel: string, args: unknown[]) =>
			dispatchCall(rules, client, channel, args),
	};
}
describe('one dispatch for every client (spec/architecture-and-platform#ipc-boundary, spec/remote-access-and-mobile#architecture)', () => {
	it('validates first, for the window and for a device alike', async () => {
		const { run, calls } = setup();
		await expect(run(null, 'workspace:read', [])).rejects.toThrow('Invalid IPC request');
		await expect(run(local, 'workspace:read', [1])).rejects.toThrow('Invalid IPC arguments');
		await expect(run(device, 'workspace:read', [1])).rejects.toThrow('Invalid IPC arguments');
		await expect(run(device, 'no:such', [])).rejects.toThrow('Invalid IPC request');
		expect(await run(device, 'workspace:read', [])).toBe('done');
		expect(calls).toEqual([{ channel: 'workspace:read', args: [], from: 'remote:1' }]);
	});
	it('refuses a device the forbidden and client-class rows', async () => {
		const { run, calls, refused } = setup();
		for (const [channel, args] of [
			['remote:enable', [true]],
			['remote:password', ['0123456789']],
			['remote:revoke-all', []],
			['remote:pairing-start', []],
		] as const)
			await expect(run(device, channel, [...args])).rejects.toThrow(
				'Not available from a remote device.'
			);
		await expect(run(device, 'appearance:read', [])).rejects.toThrow(/runs on the device/);
		expect(calls).toEqual([]);
		// Reading the status and taking control are allowed from a device.
		expect(await run(device, 'remote:status', [])).toBe('done');
		expect(await run(device, 'remote:take-control', [])).toBe('done');
		// The local window may do all of it.
		expect(await run(local, 'remote:enable', [true])).toBe('done');
		// Each refusal reaches the audit, the allowed calls and the local window's do not (spec/remote-access-and-mobile#pairing, S9).
		expect(refused.map((item) => item.channel)).toEqual([
			'remote:enable',
			'remote:password',
			'remote:revoke-all',
			'remote:pairing-start',
			'appearance:read',
		]);
		expect(new Set(refused.map((item) => item.client))).toEqual(new Set(['remote:1']));
	});
	it("keeps the remote access settings of a device's settings:save as they are", async () => {
		const { run, calls } = setup();
		const sent: AppSettings = {
			...defaultAppSettings,
			accent: 'pink',
			modules: { ...defaultAppSettings.modules, remoteAccess: false },
			remoteAccess: {
				enabled: false,
				machineName: 'hacked',
				listen: { lan: true, tailscale: true },
				phone: true,
			},
		};
		await run(device, 'settings:save', [sent]);
		const saved = calls[0]!.args[0] as AppSettings;
		expect(saved.accent).toBe('pink');
		expect(saved.modules.remoteAccess).toBe(true);
		expect(saved.remoteAccess).toEqual({
			enabled: true,
			machineName: 'studio',
			listen: { lan: true, tailscale: false },
			phone: false,
		});
		await run(local, 'settings:save', [sent]);
		expect((calls[1]!.args[0] as AppSettings).remoteAccess.machineName).toBe('hacked');
	});
	it('answers per-client state without effect from a client not in control (spec/remote-access-and-mobile#architecture)', async () => {
		const { run, calls } = setup(device);
		const key = { projectId: 'p', id: 't' };
		expect(await run(local, 'notifications:visible', [key])).toBeUndefined();
		expect(calls).toEqual([]);
		expect(await run(device, 'notifications:visible', [key])).toBe('done');
		expect(await run(local, 'workspace:read', [])).toBe('done');
	});
	it("sends a window's remote-class calls to its machine and runs its client-class ones here", async () => {
		const { run, calls } = setup();
		const forward = vi.fn(async () => 'from studio');
		const window: Client = {
			id: 'window:x',
			local: false,
			events: 'client',
			send: () => true,
			owns: () => true,
			forward,
		};
		expect(await run(window, 'workspace:read', [])).toBe('from studio');
		expect(forward).toHaveBeenCalledWith('workspace:read', []);
		expect(await run(window, 'appearance:read', [])).toBe('done');
		await expect(run(window, 'workspace:read', ['x'])).rejects.toThrow('Invalid IPC arguments');
		expect(calls.map((call) => call.channel)).toEqual(['appearance:read']);
	});
});
describe('a phone meets the web class (spec/remote-access-and-mobile#phone-network)', () => {
	const phone: Client = {
		id: 'web:1',
		local: false,
		device: { id: 'b'.repeat(64), name: 'iPhone', kind: 'phone' },
		events: 'remote',
		send: () => true,
		owns: () => false,
	};
	const key = { projectId: 'p', id: 't' };
	it('reaches web rows, and of the chat and the terminal only what the phone may do', async () => {
		const { run, calls, refused } = setup();
		expect(await run(phone, 'workspace:read', [])).toBe('done');
		expect(await run(phone, 'session:command', [key, { kind: 'cancel' }])).toBe('done');
		expect(await run(phone, 'terminal:command', [key, { kind: 'text', id: 'x' }])).toBe('done');
		await expect(
			run(phone, 'terminal:command', [key, { kind: 'input', id: 'x', data: 'rm -rf ~\r' }])
		).rejects.toThrow('Not available from a phone.');
		await expect(run(phone, 'session:command', [key, { kind: 'shutdown' }])).rejects.toThrow(
			'Not available from a phone.'
		);
		await expect(run(phone, 'keep-awake:read', [])).rejects.toThrow('Not available from a phone.');
		// What a computer may not do, a phone may not either — and says it the computer's way.
		await expect(run(phone, 'remote:enable', [true])).rejects.toThrow(
			'Not available from a remote device.'
		);
		// The table's validator still runs first.
		await expect(run(phone, 'workspace:read', [1])).rejects.toThrow('Invalid IPC arguments');
		expect(calls.map((call) => call.channel)).toEqual([
			'workspace:read',
			'session:command',
			'terminal:command',
		]);
		expect(refused.map((item) => item.channel)).toEqual([
			'terminal:command',
			'session:command',
			'keep-awake:read',
			'remote:enable',
		]);
		// A computer is not held to the web class.
		expect(await run(device, 'keep-awake:read', [])).toBe('done');
	});
});
