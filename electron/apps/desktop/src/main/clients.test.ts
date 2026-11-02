import { expect, it, vi } from 'vitest';
import { Clients, windowClient, type Client } from './clients';
const entry = 'file:///app/out/index.html';
function fakeWindow() {
	const webContents = { mainFrame: { url: entry }, send: vi.fn() };
	return {
		destroyed: false,
		isDestroyed() {
			return this.destroyed;
		},
		webContents,
	};
}
it('sends to the local window while it lives and owns only its main frame', () => {
	let window: ReturnType<typeof fakeWindow> | null = fakeWindow();
	const clients = new Clients();
	clients.add(windowClient(() => window, entry, false));
	expect(clients.broadcast('session:event', { key: 1 })).toBe(true);
	expect(window.webContents.send).toHaveBeenCalledWith('session:event', { key: 1 });
	const sender = window.webContents;
	expect(clients.from({ sender, senderFrame: sender.mainFrame })?.id).toBe('local');
	expect(clients.from({ sender, senderFrame: { url: entry } })).toBeNull();
	const foreign = { mainFrame: { url: entry } };
	expect(clients.from({ sender: foreign, senderFrame: foreign.mainFrame })).toBeNull();
	window.destroyed = true;
	expect(clients.broadcast('session:event', null)).toBe(false);
	window = null;
	expect(clients.broadcast('session:event', null)).toBe(false);
	expect(clients.from({ sender, senderFrame: sender.mainFrame })).toBeNull();
});
it('keeps client-class events on their own machine (spec/remote-access-and-mobile#architecture)', () => {
	const clients = new Clients();
	const remote: Client & { send: ReturnType<typeof vi.fn> } = {
		id: 'laptop',
		local: false,
		send: vi.fn(() => true),
		owns: () => false,
	};
	const drop = clients.add(remote);
	expect(clients.broadcast('appearance:changed', {})).toBe(false);
	expect(clients.broadcast('window:app-menu', true)).toBe(false);
	expect(remote.send).not.toHaveBeenCalled();
	expect(clients.broadcast('terminal:event', {})).toBe(true);
	expect(remote.send).toHaveBeenCalledWith('terminal:event', {});
	drop();
	expect(clients.broadcast('terminal:event', {})).toBe(false);
});
it("gives a window of another machine only this machine's client-class events, and personal values (spec/remote-access-and-mobile#pairing)", () => {
	const clients = new Clients();
	const window: Client & { send: ReturnType<typeof vi.fn> } = {
		id: 'window:studio',
		local: false,
		events: 'client',
		send: vi.fn(() => true),
		owns: () => false,
	};
	const device: Client & { send: ReturnType<typeof vi.fn> } = {
		id: 'remote:1',
		local: false,
		device: { id: 'a', name: 'laptop' },
		send: vi.fn(() => true),
		owns: () => false,
	};
	clients.add(window);
	clients.add(device);
	clients.broadcast('terminal:event', {});
	clients.broadcast('appearance:changed', {});
	expect(window.send.mock.calls.map((call) => call[0])).toEqual(['appearance:changed']);
	expect(device.send.mock.calls.map((call) => call[0])).toEqual(['terminal:event']);
	clients.personal('remote:control', (client) => ({ self: client.id === 'remote:1' }));
	expect(device.send).toHaveBeenLastCalledWith('remote:control', { self: true });
	expect(clients.list()).toHaveLength(2);
});
