/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#client-ui-seam: the one seam through which main shows anything — a native menu, a message box, a folder or
 * file choice, a save. The local window and a window of another machine on this device get the native thing over their
 * own window; a paired device gets it as an event on its connection and answers with `remote:ui-answer`, so a handler
 * awaits the same promise either way and nothing a device asks for opens on this machine's screen.
 */
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import {
	Menu,
	clipboard,
	dialog,
	shell,
	type BrowserWindow,
	type MenuItemConstructorOptions,
} from 'electron';
import {
	deviceMenuItems,
	menuItemsDeep,
	isRemoteFsPath,
	remoteFsListLimit,
	type NativeMenuItem,
	type RemoteBox,
	type RemoteFsEntry,
	type RemoteFsListing,
	type RemotePage,
	type RemotePick,
	type RemoteUiAnswer,
} from '@brigadir/core';
import { menuIcon } from './menu-icons';
import type { Client } from './clients';

export type MenuAt = { x: number; y: number } | null;
export type BoxRequest = Omit<RemoteBox, 'kind' | 'id'>;
export type PickRequest = Omit<RemotePick, 'kind' | 'id'> & {
	/** The native dialog's filter name (`JSON`, `Markdown`); a device's browser lists the extensions only. */
	filterName?: string;
};
export type SaveRequest = { name: string; extensions: string[]; filterName: string; text: string };
/** spec/remote-access-and-mobile#browser-from-device: a page's dialog for the device that streams it; the answer — true, a prompt's text, or null. */
export type PageRequest = Omit<RemotePage, 'kind' | 'id'>;
export type PageAnswer = boolean | string | null;
/** The answer and whether the person ticked «Don't show more dialogs from this page» (only when it was offered, P1). */
export type PageReply = { answer: PageAnswer; mute: boolean };
const cancelledPage: PageReply = { answer: null, mute: false };
/** spec/remote-access-and-mobile#browser-from-device: a page's file input for the device that streams it; its files land in `dir` on this machine. */
export type FilesRequest = { multiple: boolean; extensions: string[] | null; dir: string };
/** At most this many files for one input, each within the upload limit (spec/remote-access-and-mobile#client-ui-seam). */
export const pageFilesLimit = 10;

/** What shows the native thing over a window of this machine. Electron's by default; tests give their own. */
export interface NativeUi {
	menu(
		window: BrowserWindow | null,
		items: readonly NativeMenuItem[],
		at: MenuAt
	): Promise<string | null>;
	box(window: BrowserWindow | null, box: BoxRequest): Promise<number>;
	pick(window: BrowserWindow | null, pick: PickRequest): Promise<string | null>;
	save(window: BrowserWindow | null, save: SaveRequest): Promise<boolean>;
}

/** The native menu of a template: `copy` and `reveal` items finish here and answer null, like the handlers did before. */
export function nativeMenu(
	window: BrowserWindow | null,
	items: readonly NativeMenuItem[],
	at: MenuAt
): Promise<string | null> {
	return new Promise((resolve) => {
		const build = (item: NativeMenuItem): MenuItemConstructorOptions => {
			if (!item) return { type: 'separator' };
			const base: MenuItemConstructorOptions = {
				label: item.label,
				...menuIcon(item.icon),
				enabled: item.enabled ?? true,
				...(item.checked === undefined ? {} : { type: 'checkbox' as const, checked: item.checked }),
				...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
			};
			// spec/appearance#evolution-redesign: a submenu's title chooses nothing; its items answer as the top level's do.
			if (item.submenu) return { ...base, submenu: item.submenu.map(build) };
			if (item.role) return { ...base, role: item.role };
			if (item.copy !== undefined) {
				const text = item.copy;
				return {
					...base,
					click: () => {
						clipboard.writeText(text);
						resolve(null);
					},
				};
			}
			if (item.reveal !== undefined) {
				const path = item.reveal;
				return {
					...base,
					click: () => {
						shell.showItemInFolder(path);
						resolve(null);
					},
				};
			}
			const id = item.id;
			return { ...base, click: () => resolve(id) };
		};
		Menu.buildFromTemplate(items.map(build)).popup({
			...(window ? { window } : {}),
			...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}),
			// A click lands after the close callback on some platforms: let it win.
			callback: () => setTimeout(() => resolve(null), 0),
		});
	});
}
/**
 * A machine's menu as a device shows it (spec/remote-access-and-mobile#client-ui-seam): an item with a role is the device's own Cut, Copy, Paste or
 * Select all, so it carries the device's word for it — a machine must not label «Paste» as «Open» and have the device's
 * clipboard pasted into a field of the machine's window (security review R2–R4, V7).
 */
export function deviceRoleLabels(
	items: readonly NativeMenuItem[],
	label: (role: NonNullable<Exclude<NativeMenuItem, null>['role']>) => string
): NativeMenuItem[] {
	return items.map((item) => (item?.role ? { ...item, label: label(item.role) } : item));
}
/**
 * spec/appearance#dialogs: every message box of main goes here. Windows shows custom buttons («Delete task», «Discard changes»)
 * as command links unless `noLink` is set; macOS and Linux ignore it, so it is set everywhere.
 */
export function messageBox(
	window: BrowserWindow | null | undefined,
	options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
	const plain = { ...options, noLink: true };
	return window ? dialog.showMessageBox(window, plain) : dialog.showMessageBox(plain);
}
export const electronUi: NativeUi = {
	menu: nativeMenu,
	async box(window, box) {
		return (
			await messageBox(window, {
				type: box.type,
				message: box.message,
				detail: box.detail,
				buttons: box.buttons,
				defaultId: box.defaultId,
				cancelId: box.cancelId,
			})
		).response;
	},
	async pick(window, pick) {
		const options: Electron.OpenDialogOptions = {
			properties: [pick.target === 'folder' ? 'openDirectory' : 'openFile'],
			...(pick.extensions
				? {
						filters: [
							{ name: pick.filterName ?? pick.extensions.join(', '), extensions: pick.extensions },
						],
					}
				: {}),
		};
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	},
	async save(window, save) {
		const options: Electron.SaveDialogOptions = {
			defaultPath: save.name,
			filters: [{ name: save.filterName, extensions: save.extensions }],
		};
		const result = window
			? await dialog.showSaveDialog(window, options)
			: await dialog.showSaveDialog(options);
		if (result.canceled || !result.filePath) return false;
		await writeFile(result.filePath, save.text, { mode: 0o600 });
		return true;
	},
};

type Pending =
	| { kind: 'menu'; client: string; ids: ReadonlySet<string>; resolve(value: string | null): void }
	| { kind: 'box'; client: string; box: BoxRequest; resolve(value: number): void }
	| { kind: 'pick'; client: string; pick: RemotePick; resolve(value: string | null): void }
	| { kind: 'save'; client: string; resolve(value: boolean): void }
	| {
			kind: 'page';
			client: string;
			type: RemotePage['type'];
			mute: boolean;
			resolve(value: PageReply): void;
	  }
	| {
			kind: 'files';
			client: string;
			request: FilesRequest;
			paths: string[];
			writing: Promise<unknown>;
			resolve(value: string[] | null): void;
	  };

/** Whether a path a device chose is what the choice asked for: a folder, or a file with one of its extensions. */
export async function pickFits(pick: Pick<RemotePick, 'target' | 'extensions'>, path: string) {
	if (!isRemoteFsPath(path)) return false;
	const info = await stat(path).catch(() => null);
	if (!info) return false;
	if (pick.target === 'folder') return info.isDirectory();
	return (
		info.isFile() &&
		(!pick.extensions || pick.extensions.includes(extname(path).slice(1).toLowerCase()))
	);
}

export class ClientUi {
	private next = 1;
	private readonly pending = new Map<number, Pending>();
	constructor(
		private readonly native: NativeUi = electronUi,
		/** The window a client without its own (a test, an early call) falls back to. */
		private readonly fallback: () => BrowserWindow | null = () => null
	) {}
	private window(client: Client): BrowserWindow | null {
		return client.window?.() ?? this.fallback();
	}
	/** A device's request of one kind replaces the one before it: a person sees one menu or dialog at a time. */
	private open<T>(client: Client, entry: Pending, cancel: T): number {
		for (const [id, item] of this.pending)
			if (item.client === client.id && item.kind === entry.kind) this.settle(id, cancel);
		const id = this.next++;
		this.pending.set(id, entry);
		return id;
	}
	private settle(id: number, value: unknown) {
		const item = this.pending.get(id);
		if (!item) return;
		this.pending.delete(id);
		(item.resolve as (value: unknown) => void)(value);
	}
	/** A native menu; the id of the chosen item, or null (closed, or a `copy`/`reveal` item that finished by itself). */
	menu(
		client: Client,
		items: readonly NativeMenuItem[],
		at: MenuAt = null
	): Promise<string | null> {
		if (!client.device) return this.native.menu(this.window(client), items, at);
		const shown = deviceMenuItems(items);
		if (!shown.some(Boolean)) return Promise.resolve(null);
		return new Promise((resolve) => {
			const ids = new Set(
				menuItemsDeep(shown).flatMap((item) =>
					item && item.enabled !== false && !item.submenu && !item.role && item.copy === undefined
						? [item.id]
						: []
				)
			);
			const id = this.open(client, { kind: 'menu', client: client.id, ids, resolve }, null);
			if (!client.send('remote:menu', { id, items: shown, at })) this.settle(id, null);
		});
	}
	/** A message box; the index of the button pressed (`cancelId` when the device went away). */
	ask(client: Client, box: BoxRequest): Promise<number> {
		if (!client.device) return this.native.box(this.window(client), box);
		return new Promise((resolve) => {
			const id = this.open(client, { kind: 'box', client: client.id, box, resolve }, box.cancelId);
			if (!client.send('remote:dialog', { kind: 'box', id, ...box })) this.settle(id, box.cancelId);
		});
	}
	/** A folder or file of this machine; a device chooses it in the folder browser (canvas `Folder`). */
	pick(client: Client, request: PickRequest): Promise<string | null> {
		if (!client.device) return this.native.pick(this.window(client), request);
		return new Promise((resolve) => {
			const pick: RemotePick = {
				kind: 'pick',
				id: 0,
				target: request.target,
				title: request.title,
				extensions: request.extensions,
			};
			const id = this.open(client, { kind: 'pick', client: client.id, pick, resolve }, null);
			pick.id = id;
			if (!client.send('remote:dialog', pick)) this.settle(id, null);
		});
	}
	/** A file this machine made, saved where the person says — on the device that asked, when one did. */
	save(client: Client, request: SaveRequest): Promise<boolean> {
		if (!client.device) return this.native.save(this.window(client), request);
		return new Promise((resolve) => {
			const id = this.open(client, { kind: 'save', client: client.id, resolve }, false);
			const { filterName: _filter, ...save } = request;
			if (!client.send('remote:save', { id, ...save })) this.settle(id, false);
		});
	}
	/** A page of this machine's browser asks the device that streams it (spec/remote-access-and-mobile#browser-from-device); null — cancelled or gone. */
	page(client: Client, request: PageRequest): Promise<PageReply> {
		if (!client.device) return Promise.resolve(cancelledPage);
		return new Promise((resolve) => {
			const id = this.open(
				client,
				{ kind: 'page', client: client.id, type: request.type, mute: request.mute, resolve },
				cancelledPage
			);
			if (!client.send('remote:dialog', { kind: 'page', id, ...request }))
				this.settle(id, cancelledPage);
		});
	}
	/** Files of the device for a page's file input: their paths in `request.dir` on this machine, or null. */
	files(client: Client, request: FilesRequest): Promise<string[] | null> {
		if (!client.device) return Promise.resolve(null);
		return new Promise((resolve) => {
			const id = this.open(
				client,
				{
					kind: 'files',
					client: client.id,
					request,
					paths: [],
					writing: Promise.resolve(),
					resolve,
				},
				null
			);
			if (
				!client.send('remote:files', {
					id,
					multiple: request.multiple,
					extensions: request.extensions,
				})
			)
				this.settle(id, null);
		});
	}
	/** `browser:file`: one file of an open file request, written 0600 into its folder under a name of its own. */
	async pageFile(client: Client, id: number, name: string, bytes: Uint8Array) {
		const item = this.pending.get(id);
		if (!item || item.client !== client.id || item.kind !== 'files')
			throw new Error('The file choice is closed.');
		const limit = item.request.multiple ? pageFilesLimit : 1;
		if (item.paths.length >= limit) throw new Error('Too many files for this field.');
		const folder = join(item.request.dir, String(item.paths.length));
		const path = join(folder, name);
		if (dirname(path) !== folder) throw new Error('Invalid file name');
		item.paths.push(path);
		const write = item.writing.then(async () => {
			await mkdir(folder, { recursive: true, mode: 0o700 });
			await writeFile(path, bytes, { mode: 0o600 });
		});
		item.writing = write.catch(() => {});
		await write;
	}
	/** `remote:ui-answer`: only the device that was asked, only a value its request allows; anything else cancels. */
	async answer(client: Client, id: number, value: RemoteUiAnswer) {
		const item = this.pending.get(id);
		if (!item || item.client !== client.id) return;
		switch (item.kind) {
			case 'page': {
				const muted = value !== null && typeof value === 'object',
					inner = muted ? value.value : value;
				this.settle(id, {
					answer:
						item.type === 'prompt'
							? typeof inner === 'string'
								? inner
								: null
							: item.type === 'alert'
								? true
								: inner === true,
					mute: muted && item.mute,
				} satisfies PageReply);
				return;
			}
			case 'files': {
				await item.writing;
				this.settle(id, value === true && item.paths.length ? [...item.paths] : null);
				return;
			}
			case 'menu':
				this.settle(id, typeof value === 'string' && item.ids.has(value) ? value : null);
				return;
			case 'box':
				this.settle(
					id,
					typeof value === 'number' && value < item.box.buttons.length ? value : item.box.cancelId
				);
				return;
			case 'save':
				this.settle(id, value === true);
				return;
			case 'pick': {
				const path = typeof value === 'string' && (await pickFits(item.pick, value)) ? value : null;
				this.settle(id, path);
			}
		}
	}
	/** The choice a device has open now under this id, for its folder browser's reads; null — none. */
	openPick(client: Client, id: number): RemotePick | null {
		const item = this.pending.get(id);
		return item?.kind === 'pick' && item.client === client.id ? item.pick : null;
	}
	/** The device went away: whatever it was asked closes as cancelled. */
	forget(client: Client) {
		for (const [id, item] of [...this.pending])
			if (item.client === client.id)
				this.settle(
					id,
					item.kind === 'box'
						? item.box.cancelId
						: item.kind === 'save'
							? false
							: item.kind === 'page'
								? cancelledPage
								: null
				);
	}
	/** A stream ended (spec/remote-access-and-mobile#browser-from-device): its page questions and file choices of this client close as cancelled. */
	cancelPages(client: Client) {
		for (const [id, item] of [...this.pending])
			if (item.client === client.id && (item.kind === 'page' || item.kind === 'files'))
				this.settle(id, item.kind === 'page' ? cancelledPage : null);
	}
}

/**
 * `remote:fs-list`: one folder of this machine for the folder browser of an open choice — names, folder or file, `.git`,
 * when it changed; files only with the choice's extensions; hidden names only when asked. Never the contents.
 */
export async function listFolder(
	pick: Pick<RemotePick, 'target' | 'extensions'>,
	path: string | null,
	hidden: boolean
): Promise<RemoteFsListing> {
	const home = homedir(),
		folder = path ?? home;
	const items = await readdir(folder, { withFileTypes: true });
	const entries: RemoteFsEntry[] = [];
	let truncated = false;
	const candidates = items
		.filter((item) => hidden || !item.name.startsWith('.'))
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
		);
	for (let index = 0; index < candidates.length; index += 64) {
		const chunk = await Promise.all(
			candidates.slice(index, index + 64).map(async (item): Promise<RemoteFsEntry | null> => {
				const full = join(folder, item.name);
				// A link counts as what it points at, like the system dialog shows it.
				const info = await stat(full).catch(() => null);
				if (!info) return null;
				const directory = info.isDirectory();
				if (!directory) {
					if (pick.target !== 'file' || !info.isFile()) return null;
					if (
						pick.extensions &&
						!pick.extensions.includes(extname(item.name).slice(1).toLowerCase())
					)
						return null;
				}
				return {
					name: item.name,
					kind: directory ? 'directory' : 'file',
					git: directory && !!(await stat(join(full, '.git')).catch(() => null)),
					modifiedAt: Number.isFinite(info.mtimeMs) ? Math.round(info.mtimeMs) : null,
					hidden: item.name.startsWith('.'),
				};
			})
		);
		for (const entry of chunk) if (entry) entries.push(entry);
		if (entries.length >= remoteFsListLimit) {
			truncated = true;
			break;
		}
	}
	entries.sort((a, b) =>
		a.kind === b.kind
			? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
			: a.kind === 'directory'
				? -1
				: 1
	);
	return {
		path: folder,
		parent: folder === '/' ? null : dirname(folder),
		home,
		entries: entries.slice(0, remoteFsListLimit),
		truncated,
	};
}
/** `remote:fs-mkdir`: `New folder…` in the folder the browser shows; the new folder's path. */
export async function createFolder(parent: string, name: string): Promise<string> {
	const path = join(parent, name.trim());
	if (dirname(path) !== parent) throw new Error('Invalid folder name');
	await mkdir(path);
	return path;
}
