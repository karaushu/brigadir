import { ipcEventClass, type IpcClass, type IpcSubscribeChannel } from '@brigadir/core';
import type { BrowserWindow } from 'electron';
import { isTrustedSender, type ReadEvent, type Sender } from './trusted-sender';

/**
 * spec/remote-access-and-mobile#architecture: whom main's events reach and whose calls it takes. The local window takes every event; a connection from
 * a paired device (spec/remote-access-and-mobile#pairing) takes remote-class events only — theme and app menu belong to the machine that shows
 * them; a window of this machine that shows another machine takes this machine's client-class events only and sends its
 * remote-class calls over its connection (`forward`).
 */
export interface Client {
	readonly id: string;
	/** The working machine's own window. */
	readonly local: boolean;
	/**
	 * A connection from a paired device: its calls meet the remote rules of the table (spec/remote-access-and-mobile#architecture). A phone (spec/remote-access-and-mobile#phone-network)
	 * meets the `web` class besides.
	 */
	readonly device?: {
		readonly id: string;
		readonly name: string;
		readonly kind?: 'computer' | 'phone';
	};
	/** Which of this main's events it takes; absent means `all` for the local window, `remote` otherwise. */
	readonly events?: 'all' | IpcClass;
	/**
	 * False when nothing took it (no window, a destroyed one, a closed connection). `droppable` (spec/remote-access-and-mobile#browser-from-device): a video or
	 * screencast frame a slow connection may leave out — false then too.
	 */
	send(channel: IpcSubscribeChannel, value: unknown, droppable?: boolean): boolean;
	/** Whether an Electron IPC call came from this client. Only windows speak Electron IPC. */
	owns(event: ReadEvent): boolean;
	/** A window showing another machine: its remote-class calls go there instead of this main's handlers. */
	forward?(channel: string, args: readonly unknown[]): Promise<unknown>;
	/** The window of this machine the client is (spec/remote-access-and-mobile#client-ui-seam): native menus and dialogs open over it, not elsewhere. */
	window?(): BrowserWindow | null;
}
const takes = (client: Client, kind: IpcClass) => {
	const events = client.events ?? (client.local ? 'all' : 'remote');
	return events === 'all' || events === kind;
};
export class Clients {
	private readonly all = new Set<Client>();
	add(client: Client): () => void {
		this.all.add(client);
		return () => {
			this.all.delete(client);
		};
	}
	/** True when at least one client took it. */
	broadcast(channel: IpcSubscribeChannel, value: unknown): boolean {
		return this.personal(channel, () => value);
	}
	/** The same event with a value made for each client (`remote:control` knows whose it is, a device sees no pairing code). */
	personal(channel: IpcSubscribeChannel, value: (client: Client) => unknown): boolean {
		const kind = ipcEventClass(channel);
		let delivered = false;
		for (const client of [...this.all])
			if (takes(client, kind) && client.send(channel, value(client))) delivered = true;
		return delivered;
	}
	/** Each client that takes this channel's class: frames each client may miss on its own (spec/remote-access-and-mobile#browser-from-device). */
	each(channel: IpcSubscribeChannel, run: (client: Client) => void) {
		const kind = ipcEventClass(channel);
		for (const client of [...this.all]) if (takes(client, kind)) run(client);
	}
	/** The known client an IPC call came from, or null. */
	from(event: ReadEvent): Client | null {
		for (const client of this.all) if (client.owns(event)) return client;
		return null;
	}
	list(): Client[] {
		return [...this.all];
	}
}
type WindowLike = {
	isDestroyed(): boolean;
	webContents: Sender & { send(channel: string, value: unknown): void };
};
/** The local window, checked exactly as spec/architecture-and-platform#ipc-boundary asks: the same webContents, its main frame, the entry URL. */
export function windowClient(
	current: () => WindowLike | null,
	entry: string,
	development: boolean
): Client {
	return {
		id: 'local',
		local: true,
		window: () => {
			const window = current();
			return window && !window.isDestroyed() ? (window as unknown as BrowserWindow) : null;
		},
		send(channel, value) {
			const window = current();
			if (!window || window.isDestroyed()) return false;
			window.webContents.send(channel, value);
			return true;
		},
		owns(event) {
			const window = current();
			return isTrustedSender(event, window?.webContents, entry, development);
		},
	};
}
