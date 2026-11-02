import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createDesktopBridge } from '@brigadir/core';
// One ipcRenderer listener per channel fans out to every renderer subscriber. Many surfaces legitimately
// listen to one channel (workspace:action has about twenty), and a listener each trips Node's
// MaxListenersExceededWarning past ten. A throwing subscriber does not stop the rest; its error stays uncaught.
const fanouts = new Map<string, Set<(value: unknown) => void>>();
function deliver(subscribers: Iterable<(value: unknown) => void>, value: unknown) {
	for (const call of [...subscribers])
		try {
			call(value);
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
}
function fanout(channel: string) {
	const subscribers = new Set<(value: unknown) => void>();
	fanouts.set(channel, subscribers);
	ipcRenderer.on(channel, (_event, value: unknown) => deliver(subscribers, value));
	return subscribers;
}
const argument = (name: string) =>
	process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
// spec/architecture-and-platform#ipc-boundary: the renderer gets the table's named methods only; the generic invoke below never leaves the preload.
const bridge = createDesktopBridge(
	{
		invoke: (channel, args) => ipcRenderer.invoke(channel, ...args),
		subscribe: (channel, listener) => {
			const subscribers = fanouts.get(channel) ?? fanout(channel),
				call = (value: unknown) => listener(value);
			subscribers.add(call);
			return () => {
				subscribers.delete(call);
			};
		},
		// spec/composer#slash-menu: the same fan-out a menu-bar click reaches through main, without the round trip.
		emit: (channel, value) => deliver(fanouts.get(channel) ?? [], value),
	},
	{
		pathForFile: (file) => webUtils.getPathForFile(file as File),
		testCrash: argument('brigadir-test-crash') ?? null,
		testAttentionMs: Number(argument('brigadir-test-attention-ms')) || null,
		chromePlatform: ((value) => (value === 'win32' || value === 'linux' ? value : 'darwin'))(
			argument('brigadir-chrome')
		),
		// spec/remote-access-and-mobile#module-and-settings: main opens a window of another machine with its id and name.
		remoteMachine: ((id, name, device) =>
			id && /^[0-9a-f]{64}$/.test(id) && name !== undefined
				? {
						id,
						name: decodeURIComponent(name).slice(0, 64),
						device: decodeURIComponent(device ?? '').slice(0, 64),
					}
				: null)(
			argument('brigadir-remote-machine'),
			argument('brigadir-remote-name'),
			argument('brigadir-remote-device')
		),
	}
);
contextBridge.exposeInMainWorld('brigadir', bridge);
