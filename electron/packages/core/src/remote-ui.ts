/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#client-ui-seam: what would otherwise open on the working machine's screen, as data. A native menu, a message box, a
 * folder or file choice and a save travel to the device that asked; it shows them on its own screen and answers with
 * `remote:ui-answer`. Every value here crosses the gateway, so each has a validator the receiving side runs.
 */
import { menuIconNames, type MenuIcon } from './menu-icons';
import { isRecord } from './workspace';
import { fitsUtf8 } from './utf8';
import { isTaskKey, type TaskKey } from './session';
import { externalLink } from './external-links';
import { isSoundName } from './notifications';
import { isChatFont, isInterfaceFont, isTypography } from './typography';
import type { MachineAppearance } from './bridge';

const iconNames: ReadonlySet<string> = new Set(menuIconNames);
const text = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.length <= max && !value.includes('\0');
const uiId = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 2 ** 52;

/** One item of a native menu; `null` is a separator. `copy` puts its text on the clipboard of the machine that shows the
 *  menu; `reveal` shows a path in the file manager and never reaches a device (spec/remote-access-and-mobile#architecture). */
export type NativeMenuItem = {
	id: string;
	label: string;
	icon?: MenuIcon;
	enabled?: boolean;
	checked?: boolean;
	/** Shown beside the item only: the menu bar owns the key. */
	accelerator?: string;
	role?: 'cut' | 'copy' | 'paste' | 'selectAll';
	copy?: string;
	reveal?: string;
	/** spec/appearance#evolution-redesign: one level of submenu; the item is then only its title, and the answer is a child's id. */
	submenu?: NativeMenuItem[];
} | null;
export const nativeMenuRoles = ['cut', 'copy', 'paste', 'selectAll'] as const;
export type RemoteMenu = {
	id: number;
	items: NativeMenuItem[];
	/** Where in the window, in its CSS pixels; null — at the pointer. */
	at: { x: number; y: number } | null;
};
const coordinate = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
/** `nested`: an item of a submenu, which has no submenu of its own (one level, spec/appearance#evolution-redesign). */
export function isNativeMenuItem(value: unknown, nested = false): value is NativeMenuItem {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	return (
		keys.every((key) =>
			[
				'id',
				'label',
				'icon',
				'enabled',
				'checked',
				'accelerator',
				'role',
				'copy',
				'reveal',
				'submenu',
			].includes(key)
		) &&
		(value.submenu === undefined ||
			(!nested &&
				Array.isArray(value.submenu) &&
				value.submenu.length > 0 &&
				value.submenu.length <= 32 &&
				value.role === undefined &&
				value.copy === undefined &&
				value.reveal === undefined &&
				value.submenu.every((child) => isNativeMenuItem(child, true)))) &&
		text(value.id, 100) &&
		value.id.length > 0 &&
		text(value.label, 300) &&
		(value.icon === undefined || (typeof value.icon === 'string' && iconNames.has(value.icon))) &&
		(value.enabled === undefined || typeof value.enabled === 'boolean') &&
		(value.checked === undefined || typeof value.checked === 'boolean') &&
		(value.accelerator === undefined ||
			(typeof value.accelerator === 'string' && /^[\x21-\x7e]{1,40}$/.test(value.accelerator))) &&
		(value.role === undefined || (nativeMenuRoles as readonly unknown[]).includes(value.role)) &&
		(value.copy === undefined ||
			(typeof value.copy === 'string' && fitsUtf8(value.copy, 1_000_000))) &&
		(value.reveal === undefined || text(value.reveal, 4096))
	);
}
/** Every item of a menu, each submenu's items after its title. */
export const menuItemsDeep = (items: readonly NativeMenuItem[]): NativeMenuItem[] =>
	items.flatMap((item) => (item?.submenu ? [item, ...item.submenu] : [item]));
/** A menu a device may show: at most 64 items with the submenus' ones and never a `reveal` item. */
export function isRemoteMenu(value: unknown): value is RemoteMenu {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		uiId(value.id) &&
		Array.isArray(value.items) &&
		value.items.length > 0 &&
		value.items.every((item) => isNativeMenuItem(item)) &&
		menuItemsDeep(value.items as NativeMenuItem[]).length <= 64 &&
		menuItemsDeep(value.items as NativeMenuItem[]).every(
			(item) => item === null || item.reveal === undefined
		) &&
		(value.at === null ||
			(isRecord(value.at) &&
				Object.keys(value.at).length === 2 &&
				coordinate(value.at.x) &&
				coordinate(value.at.y)))
	);
}
/** The items a device shows: no `reveal` item, and no separator left at an edge or doubled by the ones taken out. */
export function deviceMenuItems(items: readonly NativeMenuItem[]): NativeMenuItem[] {
	const kept = items
		.filter((item) => item === null || item.reveal === undefined)
		.map((item) => (item?.submenu ? { ...item, submenu: deviceMenuItems(item.submenu) } : item))
		.filter((item) => !item?.submenu || item.submenu.length > 0);
	return kept.filter(
		(item, index) =>
			item !== null || (index > 0 && index < kept.length - 1 && kept[index - 1] !== null)
	);
}

/** A message box (`dialog.showMessageBox`) for the device's own modal dialog (rule 14). */
export type RemoteBox = {
	kind: 'box';
	id: number;
	type: 'info' | 'warning' | 'error' | 'question';
	message: string;
	detail: string;
	buttons: string[];
	defaultId: number;
	cancelId: number;
	/** The destructive button, drawn red; null when none is. */
	danger: number | null;
};
/** A folder or file choice on the working machine (`dialog.showOpenDialog`), for the folder browser. */
export type RemotePick = {
	kind: 'pick';
	id: number;
	target: 'folder' | 'file';
	/** The browser's name: `Add a project from studio`. */
	title: string;
	/** A file choice lists only these extensions (lower case, no dot). */
	extensions: string[] | null;
};
/**
 * spec/remote-access-and-mobile#browser-from-device: a page of the working machine's browser asks — `alert`, `confirm`, `prompt` or before leaving — while a
 * device streams it. `site` is the page's host, `value` the prompt's default text. The answer: `true` (OK, Leave), a
 * string (the prompt's text), `null` or `false` (Cancel, Stay).
 */
export type RemotePage = {
	kind: 'page';
	id: number;
	type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
	site: string;
	message: string;
	value: string;
	/** A dialog soon after the tab's last one: it offers «Don't show more dialogs from this page» (P1). */
	mute: boolean;
};
export type RemoteDialog = RemoteBox | RemotePick | RemotePage;
export function isRemoteDialog(value: unknown): value is RemoteDialog {
	if (!isRecord(value) || !uiId(value.id)) return false;
	if (value.kind === 'page')
		return (
			Object.keys(value).length === 7 &&
			['alert', 'confirm', 'prompt', 'beforeunload'].includes(value.type as string) &&
			typeof value.mute === 'boolean' &&
			text(value.site, 300) &&
			text(value.message, 4000) &&
			text(value.value, 4000)
		);
	if (value.kind === 'box') {
		const buttons = value.buttons;
		const index = (item: unknown) =>
			Number.isSafeInteger(item) &&
			Number(item) >= 0 &&
			Array.isArray(buttons) &&
			Number(item) < buttons.length;
		return (
			Object.keys(value).length === 9 &&
			['info', 'warning', 'error', 'question'].includes(value.type as string) &&
			text(value.message, 1000) &&
			text(value.detail, 20_000) &&
			Array.isArray(buttons) &&
			buttons.length > 0 &&
			buttons.length <= 4 &&
			buttons.every((item) => text(item, 100) && item.length > 0) &&
			index(value.defaultId) &&
			index(value.cancelId) &&
			(value.danger === null || index(value.danger))
		);
	}
	return (
		value.kind === 'pick' &&
		Object.keys(value).length === 5 &&
		(value.target === 'folder' || value.target === 'file') &&
		text(value.title, 300) &&
		(value.extensions === null ||
			(Array.isArray(value.extensions) &&
				value.extensions.length <= 8 &&
				value.extensions.every(
					(item) => typeof item === 'string' && /^[a-z0-9]{1,10}$/.test(item)
				)))
	);
}
/**
 * spec/remote-access-and-mobile#browser-from-device: a page's file input on a streamed tab — the device chooses files on its own disk (its native dialog over
 * the machine's window) and uploads them with `browser:file` before it answers `true`.
 */
export type RemoteFileChoice = { id: number; multiple: boolean; extensions: string[] | null };
export function isRemoteFileChoice(value: unknown): value is RemoteFileChoice {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		uiId(value.id) &&
		typeof value.multiple === 'boolean' &&
		(value.extensions === null ||
			(Array.isArray(value.extensions) &&
				value.extensions.length > 0 &&
				value.extensions.length <= 32 &&
				value.extensions.every(
					(item) => typeof item === 'string' && /^[a-z0-9]{1,10}$/.test(item)
				)))
	);
}
/** A page's `accept` as the extensions a native dialog filters by; null — any file (a MIME type it cannot name, or none). */
export function acceptExtensions(accept: string): string[] | null {
	const known: Record<string, string[]> = {
		'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp'],
		'image/png': ['png'],
		'image/jpeg': ['jpg', 'jpeg'],
		'image/gif': ['gif'],
		'image/webp': ['webp'],
		'image/svg+xml': ['svg'],
		'application/pdf': ['pdf'],
		'application/json': ['json'],
		'text/plain': ['txt'],
		'text/csv': ['csv'],
		'video/*': ['mp4', 'mov', 'webm', 'm4v'],
		'audio/*': ['mp3', 'm4a', 'wav', 'ogg', 'aac'],
	};
	const out = new Set<string>();
	for (const raw of accept.split(',')) {
		const item = raw.trim().toLowerCase();
		if (!item) continue;
		if (/^\.[a-z0-9]{1,10}$/.test(item)) out.add(item.slice(1));
		else if (known[item]) for (const extension of known[item]!) out.add(extension);
		else return null;
	}
	return out.size ? [...out].slice(0, 32) : null;
}
/** A file the working machine hands to the device to save there (`dialog.showSaveDialog`, the template export). */
export type RemoteSave = { id: number; name: string; extensions: string[]; text: string };
export function isRemoteSave(value: unknown): value is RemoteSave {
	return (
		isRecord(value) &&
		Object.keys(value).length === 4 &&
		uiId(value.id) &&
		text(value.name, 255) &&
		value.name.length > 0 &&
		!/[/\\]/.test(value.name) &&
		Array.isArray(value.extensions) &&
		value.extensions.length <= 4 &&
		value.extensions.every((item) => typeof item === 'string' && /^[a-z0-9]{1,10}$/.test(item)) &&
		typeof value.text === 'string' &&
		fitsUtf8(value.text, 4_000_000)
	);
}
/**
 * The device's answer: a menu item id or null, a button index, a chosen path or null, whether the file was saved; a page
 * dialog's answer with «Don't show more dialogs from this page» ticked is `{value, mute: true}` (P1).
 */
export type RemoteUiAnswer =
	string | number | boolean | null | { value: string | boolean | null; mute: true };
export function isRemoteUiAnswer(args: readonly unknown[]): boolean {
	const answer = args[1];
	const plain = (value: unknown) =>
		value === null || typeof value === 'boolean' || text(value, 4096);
	return (
		args.length === 2 &&
		uiId(args[0]) &&
		(plain(answer) ||
			(Number.isSafeInteger(answer) && Number(answer) >= 0 && Number(answer) < 16) ||
			(isRecord(answer) &&
				Object.keys(answer).length === 2 &&
				answer.mute === true &&
				plain(answer.value)))
	);
}

/** One row of the folder browser: what the native dialog shows too — never the file's contents. */
export type RemoteFsEntry = {
	name: string;
	kind: 'directory' | 'file';
	/** A folder with `.git` in it: the browser marks it (`git · today`). */
	git: boolean;
	/** Milliseconds since the epoch; null when the system did not say. */
	modifiedAt: number | null;
	hidden: boolean;
};
export type RemoteFsListing = {
	path: string;
	parent: string | null;
	/** The machine's home folder, where a browser starts. */
	home: string;
	entries: RemoteFsEntry[];
	/** More than the listing limit: the rest is not shown. */
	truncated: boolean;
};
export const remoteFsListLimit = 2000;
/** spec/remote-access-and-mobile#client-ui-seam: one file a device uploads into a task's attachments — under the gateway's 16 MB frame after base64. */
export const remoteUploadLimit = 10 * 1024 * 1024;
/** An absolute POSIX path (the working machine is a Mac today, spec/remote-access-and-mobile#architecture): no NUL, no `..` segments. */
export function isRemoteFsPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith('/') &&
		value.length <= 4096 &&
		!value.includes('\0') &&
		!value.split('/').some((part) => part === '..' || part === '.')
	);
}
/** `New folder…`: one name, not a path. */
export function isRemoteFolderName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		value.length <= 255 &&
		value !== '.' &&
		value !== '..' &&
		!/[/\0]/.test(value)
	);
}

/** A notice the working machine hands to the device in control (spec/remote-access-and-mobile#architecture): shown, closed, a group removed, a sound, the badge. */
export type RemoteNotify =
	| {
			kind: 'show';
			id: number;
			notice: {
				id: string;
				groupId: string;
				key: TaskKey;
				title: string;
				body: string;
				actions: { allow: string | null; deny: string | null };
			};
	  }
	| { kind: 'close'; id: number }
	| { kind: 'remove'; groupId: string }
	| { kind: 'sound'; name: string }
	| { kind: 'badge'; count: number };
export function isRemoteNotify(value: unknown): value is RemoteNotify {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'show': {
			const notice = value.notice;
			return (
				uiId(value.id) &&
				isRecord(notice) &&
				text(notice.id, 400) &&
				text(notice.groupId, 400) &&
				isTaskKey(notice.key) &&
				text(notice.title, 400) &&
				text(notice.body, 4000) &&
				isRecord(notice.actions) &&
				(notice.actions.allow === null || text(notice.actions.allow, 100)) &&
				(notice.actions.deny === null || text(notice.actions.deny, 100))
			);
		}
		case 'close':
			return uiId(value.id);
		case 'remove':
			return text(value.groupId, 400);
		case 'sound':
			return isSoundName(value.name);
		case 'badge':
			return (
				Number.isSafeInteger(value.count) &&
				Number(value.count) >= 0 &&
				Number(value.count) < 10_000
			);
		default:
			return false;
	}
}

/** WHATWG URL of the runtime (Node, Electron, a browser): core's lib has no DOM and no Node types. */
const WebUrl = (globalThis as unknown as { URL: new (input: string) => { hostname: string } }).URL;
/**
 * spec/remote-access-and-mobile#client-ui-seam: an address that names the working machine itself or its local network (`localhost`, `127.0.0.0/8`,
 * `::1`, `*.localhost`, `.local`, RFC 1918, `fc00::/7`, link-local). On a device it would mean another computer, so the
 * window of the machine hides «Open in default browser» for it.
 */
export function isMachineLocalUrl(value: string): boolean {
	// The host as a browser reads it: `127.1`, `0x7f.1`, `0177.0.0.1`, `[0:0:0:0:0:0:0:1]` all name loopback, and a regex
	// over the text saw none of them (security review R2–R4, V5).
	let parsed: { hostname: string };
	try {
		parsed = new WebUrl(value);
	} catch {
		return true;
	}
	const host = parsed.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (!host) return true;
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	if (!host.includes('.') && !host.includes(':')) return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 127 ||
			a === 10 ||
			a === 0 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (host.includes(':'))
		return (
			host === '::1' ||
			host === '::' ||
			/^f[cd][0-9a-f]{2}:/.test(host) ||
			/^fe[89ab][0-9a-f]:/.test(host) ||
			/^::ffff:/.test(host) ||
			// IPv4-compatible (`::127.0.0.1` → `::7f00:1`): an IPv4 address of the machine's own networks.
			/^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(host)
		);
	return false;
}
/**
 * spec/remote-access-and-mobile#client-ui-seam: the machine's part of a window's appearance as a device takes it (`remote:appearance`,
 * `appearance:machine`) — what the device's main composes with its own theme and fonts must have that shape, or a
 * machine's broken value would throw in the device's main (security review R2–R4, V4).
 */
export function isMachineAppearance(value: unknown): value is MachineAppearance {
	return (
		isRecord(value) &&
		isTypography(value.typography) &&
		isInterfaceFont(value.interfaceFont) &&
		(value.chatFont === undefined || isChatFont(value.chatFont)) &&
		isRecord(value.modules) &&
		typeof value.locale === 'string'
	);
}
/** The address a device opens for «Open in default browser» of the machine's page; null — the item is hidden. */
export function deviceExternalUrl(value: unknown): string | null {
	const link = externalLink(value);
	return link && /^https?:/i.test(link) && !isMachineLocalUrl(link) ? link : null;
}
