import { describe, expect, it } from 'vitest';
import {
	changedSettingKeys,
	defaultRemoteAccess,
	formatPairingCode,
	guardRemoteSettings,
	isMachineName,
	isRemoteAccessSettings,
	isRemoteAuditEntry,
	isRemoteHost,
	isRemotePassword,
	remoteActiveOnly,
	remoteClock,
	remoteMoment,
	remoteNetworkName,
	isAgentLoginRelayRequest,
	loopbackRedirect,
} from './remote-access';
import { defaultAppSettings, isAppSettings } from './settings';
import { commandModule, defaultModules, moduleOffMessages } from './modules';
import { characterCount, pairingAttemptsLeft, revokeAllText } from './messages';
import { menuCommands } from './menu';
import { searchSettings } from './search';
import { ipcInvokeRows, remoteCallRefusal } from './ipc-channels';

describe('remote access settings (spec/remote-access-and-mobile#module-and-settings)', () => {
	it('is a module on by default with access itself off', () => {
		expect(defaultModules.remoteAccess).toBe(true);
		expect(defaultAppSettings.remoteAccess).toEqual(defaultRemoteAccess);
		expect(defaultRemoteAccess.enabled).toBe(false);
		expect(moduleOffMessages.remoteAccess).toBe('Remote access is off in Settings.');
		expect(isAppSettings(defaultAppSettings)).toBe(true);
		const { remoteAccess: _, ...without } = defaultAppSettings;
		expect(isAppSettings(without)).toBe(false);
	});
	it('checks the block and the machine name', () => {
		expect(isRemoteAccessSettings({ ...defaultRemoteAccess, machineName: 'studio' })).toBe(true);
		expect(isRemoteAccessSettings({ ...defaultRemoteAccess, extra: 1 })).toBe(false);
		expect(isRemoteAccessSettings({ ...defaultRemoteAccess, listen: { lan: true } })).toBe(false);
		expect(isMachineName(' studio')).toBe(false);
		expect(isMachineName('a\u0007b')).toBe(false);
		expect(isMachineName('x'.repeat(65))).toBe(false);
	});
	it('wants ten characters of password and a sane host', () => {
		expect(isRemotePassword('123456789')).toBe(false);
		expect(isRemotePassword('1234567890')).toBe(true);
		expect(isRemoteHost('studio.local')).toBe(true);
		expect(isRemoteHost('192.168.1.2')).toBe(true);
		expect(isRemoteHost('[fd7a:115c:a1e0::1]')).toBe(true);
		expect(isRemoteHost('http://x')).toBe(false);
		expect(formatPairingCode('ABCD1234')).toBe('ABCD 1234');
	});
	it("keeps the working machine's remote block in a remote save", () => {
		const current = {
			...defaultAppSettings,
			remoteAccess: {
				enabled: true,
				machineName: 'studio',
				listen: { lan: true, tailscale: true },
				phone: false,
			},
		};
		const incoming = {
			...defaultAppSettings,
			accent: 'pink' as const,
			modules: { ...defaultAppSettings.modules, remoteAccess: false },
		};
		const guarded = guardRemoteSettings(incoming, current);
		expect(guarded.accent).toBe('pink');
		expect(guarded.modules.remoteAccess).toBe(true);
		expect(guarded.remoteAccess).toEqual(current.remoteAccess);
		expect(isAppSettings(guarded)).toBe(true);
	});
});
describe('what a device changed in settings (spec/remote-access-and-mobile#pairing, security review R1, S9)', () => {
	it('names the changed keys to the second level, never the values', () => {
		const after = {
			...defaultAppSettings,
			accent: 'pink' as const,
			editor: { ...defaultAppSettings.editor, format: 'off' as const },
			agents: { ...defaultAppSettings.agents, enabled: { claude: false, codex: true } },
		};
		expect(changedSettingKeys(defaultAppSettings, after)).toEqual([
			'accent',
			'agents.enabled',
			'editor.format',
		]);
		// The same values in another key order are no change.
		const reordered = JSON.parse(JSON.stringify(defaultAppSettings)) as typeof defaultAppSettings;
		reordered.agents = Object.fromEntries(
			Object.entries(reordered.agents).reverse()
		) as typeof reordered.agents;
		expect(changedSettingKeys(defaultAppSettings, reordered)).toEqual([]);
		expect(changedSettingKeys(defaultAppSettings, after).join()).not.toContain('pink');
	});
});
describe('a line of the remote access log (spec/remote-access-and-mobile#pairing, security review R1, S7)', () => {
	it('carries the network the gateway decided and still reads the lines written before it', () => {
		const line = {
			at: '2026-10-15T10:00:00.000Z',
			kind: 'login',
			device: 'laptop',
			deviceId: null,
			address: '100.64.0.7',
			detail: null,
		};
		expect(isRemoteAuditEntry(line)).toBe(true);
		expect(isRemoteAuditEntry({ ...line, network: 'lan' })).toBe(true);
		expect(isRemoteAuditEntry({ ...line, network: null })).toBe(true);
		expect(isRemoteAuditEntry({ ...line, network: 'wifi' })).toBe(false);
	});
});
describe('remote rules of the channel table (spec/remote-access-and-mobile#architecture)', () => {
	it('forbids managing remote access from a device but lets it read the status', () => {
		for (const channel of [
			'remote:enable',
			'remote:password',
			'remote:rename',
			'remote:revoke',
			'remote:revoke-all',
			'remote:unblock',
			'remote:pairing-start',
			'remote:pairing-stop',
			'remote:pairing-confirm',
		])
			expect(remoteCallRefusal(channel), channel).toBe('Not available from a remote device.');
		expect(remoteCallRefusal('remote:status')).toBeNull();
		expect(remoteCallRefusal('remote:take-control')).toBeNull();
		expect(remoteCallRefusal('remote:audit')).toBeNull();
		// The device's own rows run on the device.
		for (const channel of ['remote:connect', 'remote:pair', 'remote:machines'])
			expect(ipcInvokeRows.get(channel)!.class).toBe('client');
		expect(remoteCallRefusal('nope')).toBe('Invalid IPC request');
	});
	it('names the per-client calls', () => {
		expect(remoteActiveOnly('notifications:visible', [null])).toBe(true);
		expect(remoteActiveOnly('menu:context', [{}])).toBe(true);
		expect(remoteActiveOnly('terminal:command', [{}, { kind: 'resize' }])).toBe(true);
		expect(remoteActiveOnly('terminal:command', [{}, { kind: 'input' }])).toBe(false);
		expect(remoteActiveOnly('browser:command', [{}, { kind: 'mount' }])).toBe(true);
		expect(remoteActiveOnly('workspace:read', [])).toBe(false);
		expect(remoteActiveOnly('browser:screen', [{}, { kind: 'start' }])).toBe(true);
		expect(remoteActiveOnly('browser:screen', [{}, { kind: 'mouse' }])).toBe(true);
		expect(remoteActiveOnly('browser:screen', [{}, { kind: 'stop' }])).toBe(false);
		expect(remoteActiveOnly('browser:screen', [{}, { kind: 'ack' }])).toBe(false);
	});
	it('validates the remote rows', () => {
		const ok = (channel: string, args: unknown[]) => ipcInvokeRows.get(channel)!.validate(args);
		expect(ok('remote:enable', [true])).toBe(true);
		expect(ok('remote:enable', [true, 'short'])).toBe(false);
		expect(ok('remote:enable', [true, 'long enough!'])).toBe(true);
		expect(ok('remote:pair', ['192.168.1.2', null, 'ABCD-1234', null])).toBe(true);
		expect(ok('remote:pair', ['192.168.1.2', 70000, 'ABCD-1234', null])).toBe(false);
		expect(ok('remote:connect', ['a'.repeat(64), 'pw', true])).toBe(true);
		expect(ok('remote:connect', ['A'.repeat(64), 'pw', true])).toBe(false);
		expect(ok('remote:audit', [501])).toBe(false);
		expect(ok('remote:pairing-confirm', [true, null])).toBe(true);
	});
});

describe('R1b texts (spec/remote-access-and-mobile#module-and-settings)', () => {
	it('says when: today, yesterday, a date, at the interface locale', () => {
		const now = new Date(2026, 9, 15, 21, 0).getTime();
		expect(remoteMoment('uk', new Date(2026, 9, 15, 19, 20).toISOString(), now)).toBe(
			'сьогодні о 19:20'
		);
		expect(remoteMoment('en', new Date(2026, 9, 14, 9, 5).toISOString(), now)).toBe(
			'yesterday at 09:05'
		);
		expect(remoteMoment('uk', new Date(2026, 9, 3, 9, 12).toISOString(), now)).toBe(
			'3 жовтня о 09:12'
		);
		expect(remoteMoment('uk', null, now)).toBe('');
		expect(remoteClock('uk', new Date(2026, 9, 15, 7, 4).toISOString())).toBe('07:04');
	});
	it('counts in four Ukrainian forms', () => {
		expect([1, 2, 5, 11, 21, 22, 25].map((n) => characterCount('uk', n))).toEqual([
			'1 символ',
			'2 символи',
			'5 символів',
			'11 символів',
			'21 символ',
			'22 символи',
			'25 символів',
		]);
		expect(characterCount('en', 1)).toBe('1 character');
		expect(pairingAttemptsLeft('uk', 1)).toBe('Код не підійшов. Лишилась 1 спроба.');
		expect(pairingAttemptsLeft('uk', 3)).toBe('Код не підійшов. Лишилось 3 спроби.');
		expect(pairingAttemptsLeft('uk', 0)).toBe('Код не підійшов. Лишилось 0 спроб.');
		expect(pairingAttemptsLeft('en', 1)).toBe('The code is not correct. 1 attempt is left.');
		expect(revokeAllText('uk', 3)).toMatch(/^3 пристрої більше не підключаться/);
		expect(revokeAllText('uk', 1)).toMatch(/^1 пристрій більше не підключиться/);
		expect(revokeAllText('uk', 5)).toMatch(/^5 пристроїв/);
	});
	it('names the networks without translating them', () => {
		expect(remoteNetworkName('lan')).toBe('LAN');
		expect(remoteNetworkName('tailscale')).toBe('Tailscale');
	});
	it('puts Connect… in File and hides the Remote tab with its module off', () => {
		expect(menuCommands.find((command) => command.id === 'connect')).toMatchObject({
			group: 'File',
			label: 'Connect…',
			// spec/remote-access-and-mobile#remote-button: ⌥⌘O on macOS, Ctrl+Alt+O on Linux and Windows.
			accelerator: 'CmdOrCtrl+Alt+O',
		});
		expect(commandModule('connect')).toBe('remoteAccess');
		const on = searchSettings('Пристрої', defaultAppSettings, 'uk').map((item) => item.id);
		expect(on).toContain('remote-devices');
		const off = searchSettings(
			'Пристрої',
			{ ...defaultAppSettings, modules: { ...defaultAppSettings.modules, remoteAccess: false } },
			'uk'
		).map((item) => item.id);
		expect(off).not.toContain('remote-devices');
	});
});

describe('an agent sign-in from a device (spec/remote-access-and-mobile#networking)', () => {
	it('finds a way back to this computer’s loopback in the sign-in page, and nothing else', () => {
		const page = (redirect: string) =>
			`https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(redirect)}&state=s`;
		expect(loopbackRedirect(page('http://localhost:1455/auth/callback'))).toEqual({
			host: 'localhost',
			port: 1455,
			path: '/auth/callback',
		});
		expect(loopbackRedirect(page('http://127.0.0.1:8085/cb?x=1'))).toMatchObject({
			host: '127.0.0.1',
			port: 8085,
			path: '/cb',
		});
		expect(loopbackRedirect(page('http://[::1]:9000/'))).toMatchObject({ host: '::1', port: 9000 });
		expect(loopbackRedirect(page('https://localhost:1455/cb'))).toBeNull();
		expect(loopbackRedirect(page('http://example.com:1455/cb'))).toBeNull();
		expect(loopbackRedirect(page('http://localhost:80/cb'))).toBeNull();
		expect(loopbackRedirect(page('http://localhost/cb'))).toBeNull();
		expect(loopbackRedirect(page('http://localhost.evil.com:1455/cb'))).toBeNull();
		expect(
			loopbackRedirect('http://auth.example.com/?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2F')
		).toBeNull();
		expect(loopbackRedirect('https://auth.example.com/sign-in')).toBeNull();
	});
	it('passes only plain GET and HEAD requests with a few headers', () => {
		const request = {
			method: 'GET',
			path: '/auth/callback?code=1',
			headers: { accept: 'text/html' },
		};
		expect(isAgentLoginRelayRequest(request)).toBe(true);
		expect(isAgentLoginRelayRequest({ ...request, method: 'HEAD' })).toBe(true);
		expect(isAgentLoginRelayRequest({ ...request, method: 'POST' })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, path: 'auth' })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, path: '//evil.com/x' })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, path: `/${'a'.repeat(2048)}` })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, path: '/a b' })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, headers: { cookie: 'x' } })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, headers: { accept: 'a\r\nb: c' } })).toBe(false);
		expect(isAgentLoginRelayRequest({ ...request, body: 'x' })).toBe(false);
	});
});

describe('security review R2–R4, V8: names that read as what they are', () => {
	it('refuses direction overrides, embeddings and isolates in a machine or device name', () => {
		expect(isMachineName('studio')).toBe(true);
		expect(isMachineName('Dev’s ThinkPad')).toBe(true);
		for (const mark of ['\u202E', '\u202D', '\u2066', '\u2069', '\u200F', '\u061C'])
			expect(isMachineName(`studio${mark}x`)).toBe(false);
	});
});
