/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings, spec/diff-and-review#snapshots: remote access — the shapes main, the gateway and the renderer share. Pure data and validators:
 * the crypto, the listeners and the files live in `@brigadir/remote` and `desktop/main/remote-access`.
 *
 * Terms (spec/remote-access-and-mobile#architecture): the *working machine* runs Brigadir with the agents; a *device* (`Device · Пристрій`) is a paired
 * computer that controls it; on the device side the working machine is a *machine*.
 */
import { isRecord } from './workspace';
import type { AppSettings } from './settings';

/** spec/remote-access-and-mobile#module-and-settings: Settings ▸ Remote. Access itself is off by default even with the module on (spec/remote-access-and-mobile#architecture). */
export type RemoteAccessSettings = {
	enabled: boolean;
	/** null — the system's name (spec/remote-access-and-mobile#module-and-settings). */
	machineName: string | null;
	/** Which interfaces the gateway listens on; never 0.0.0.0, never a public address (spec/remote-access-and-mobile#architecture). */
	listen: { lan: boolean; tailscale: boolean };
	/** spec/remote-access-and-mobile#phone-network: the web listener for a phone behind `tailscale serve`; off by default. */
	phone: boolean;
};
export const defaultRemoteAccess: RemoteAccessSettings = {
	enabled: false,
	machineName: null,
	listen: { lan: true, tailscale: true },
	phone: false,
};
export const remoteMachineNameMax = 64;
/** Unicode direction marks, embeddings, overrides and isolates: they reorder what a name shows (security review R2–R4, V8). */
export const bidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
export function isMachineName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		value.length <= remoteMachineNameMax &&
		value === value.trim() &&
		// No control characters: the name goes into mDNS, the audit and other people's menus.
		!/[\u0000-\u001f\u007f]/.test(value) &&
		// Nor a direction override or isolate: «studio» must read as what it is in a list and a confirmation (V8).
		!bidiControls.test(value) &&
		// Nor a lone surrogate: it cannot be URI-encoded for the machine window's arguments (security review R1, S2).
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
	);
}
export function isRemoteAccessSettings(value: unknown): value is RemoteAccessSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 4 &&
		typeof value.enabled === 'boolean' &&
		typeof value.phone === 'boolean' &&
		(value.machineName === null || isMachineName(value.machineName)) &&
		isRecord(value.listen) &&
		Object.keys(value.listen).length === 2 &&
		typeof value.listen.lan === 'boolean' &&
		typeof value.listen.tailscale === 'boolean'
	);
}
/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: what a remote `settings:save` may not change — the module switch and the whole
 * `remoteAccess` block keep the working machine's current values; everything else is saved as sent.
 */
export function guardRemoteSettings(incoming: AppSettings, current: AppSettings): AppSettings {
	return {
		...incoming,
		modules: { ...incoming.modules, remoteAccess: current.modules.remoteAccess },
		remoteAccess: { ...current.remoteAccess, listen: { ...current.remoteAccess.listen } },
	};
}
/**
 * spec/remote-access-and-mobile#pairing: the names of the settings a save changes — to the second level (`editor.fontSize`), never the values
 * (paths and tokens live there). Sorted; an object's key order does not count as a change.
 */
export function changedSettingKeys(before: AppSettings, after: AppSettings): string[] {
	const stable = (value: unknown): string =>
		JSON.stringify(value, (_key, item: unknown) =>
			isRecord(item)
				? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
				: item
		) ?? 'undefined';
	const changed: string[] = [];
	const walk = (a: unknown, b: unknown, path: string, depth: number) => {
		if (stable(a) === stable(b)) return;
		if (depth < 2 && isRecord(a) && isRecord(b)) {
			for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
				walk(a[key], b[key], path ? `${path}.${key}` : key, depth + 1);
			return;
		}
		changed.push(path);
	};
	walk(before, after, '', 0);
	return changed;
}

/** spec/remote-access-and-mobile#architecture: at least ten characters; the upper bound only keeps scrypt's input sane. */
export const remotePasswordMin = 10;
export const remotePasswordMax = 256;
export function isRemotePassword(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		[...value].length >= remotePasswordMin &&
		value.length <= remotePasswordMax
	);
}

/** spec/remote-access-and-mobile#architecture: 8 characters of Crockford base32 (40 bits), shown as 4 + 4. */
export const pairingAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const pairingCodeLength = 8;
/** What a person types or pastes: case, spaces, dashes and Crockford's look-alikes (O → 0, I/L → 1) don't matter. */
export function normalizePairingCode(text: string): string {
	return text
		.toUpperCase()
		.replace(/[\s\-·.]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
}
export function isPairingCode(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length === pairingCodeLength &&
		[...value].every((char) => pairingAlphabet.includes(char))
	);
}
/** `ABCD EFGH`, the way the working machine shows it (spec/remote-access-and-mobile#module-and-settings). */
export function formatPairingCode(code: string): string {
	return `${code.slice(0, 4)} ${code.slice(4)}`;
}

export type RemoteNetwork = 'lan' | 'tailscale' | 'loopback';
export type RemoteAddress = { network: RemoteNetwork; address: string };
const isNetwork = (value: unknown): value is RemoteNetwork =>
	value === 'lan' || value === 'tailscale' || value === 'loopback';
export function isRemoteAddress(value: unknown): value is RemoteAddress {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		isNetwork(value.network) &&
		typeof value.address === 'string' &&
		value.address.length > 0 &&
		value.address.length <= 64
	);
}

/** A paired device as the working machine lists it (spec/remote-access-and-mobile#architecture). The certificate itself never leaves main. */
export type RemoteDevice = {
	/** The SHA-256 fingerprint of its certificate (a phone: of its passkey's id), lowercase hex. */
	id: string;
	/** spec/remote-access-and-mobile#phone-network: a computer with the app, or a phone in the browser with a passkey. */
	kind: RemoteDeviceKind;
	name: string;
	pairedAt: string;
	lastLoginAt: string | null;
	lastAddress: RemoteAddress | null;
	/** Wrong passwords in a row (spec/remote-access-and-mobile#architecture). */
	failures: number;
	/** Ten wrong passwords in a row: refused until `Unblock` (spec/remote-access-and-mobile#module-and-settings). */
	blocked: boolean;
	/** The last wrong password: «Blocked … · 10 min ago». */
	lastFailureAt: string | null;
	/** 30 days after the last login (or pairing) the device is forgotten (spec/remote-access-and-mobile#architecture). */
	expiresAt: string;
	/** Connected now. */
	connected: boolean;
};
export type RemoteDeviceKind = 'computer' | 'phone';
/** spec/remote-access-and-mobile#phone-network: the web listener for a phone and what Tailscale says about it. */
export type RemotePhoneStatus = {
	/** The `remoteAccess.phone` switch. */
	enabled: boolean;
	/** The web listener is up on loopback now. */
	listening: boolean;
	port: number;
	/** The machine's name in the tailnet (`studio.tail1234.ts.net`): the address, the passkeys' RP ID; null — unknown. */
	host: string | null;
	tailscale: {
		/** The `tailscale` command was found. */
		cli: boolean;
		/** spec/remote-access-and-mobile#tailscale-guidance: HTTPS is on in the tailnet (its certificates), or serve already works. */
		https: boolean;
		/** `tailscale serve` sends `https://<host>/` to this listener. */
		serving: boolean;
		/** What to run once so that it does. */
		command: string;
	};
	/** Why it does not listen although on, English. */
	error: string | null;
};
/** The pairing window of the working machine (spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings). */
export type RemotePairing =
	| { state: 'idle' }
	/** `code` is blank for a remote reader (spec/remote-access-and-mobile#pairing). */
	| { state: 'open'; code: string; expiresAt: string; attemptsLeft: number }
	/** The code matched; the person confirms the device's name on the working machine. */
	| {
			state: 'confirm';
			device: string;
			fingerprint: string;
			expiresAt: string;
			/** Where the pairing device came from (the dialog's «Address»). */
			address: string | null;
			/** The network of the listener it reached, as the gateway decided it; absent — guessed from the address. */
			network?: RemoteNetwork | null;
	  }
	| { state: 'paired'; device: string }
	| { state: 'expired' }
	| { state: 'exhausted' }
	| { state: 'declined' };
/** spec/remote-access-and-mobile#architecture: who controls the working machine now; `self` is the receiving client. */
export type RemoteControl = {
	active: 'local' | 'remote';
	/** The controlling device's name, null for the local window. */
	device: string | null;
	deviceId: string | null;
	self: boolean;
};
/** Settings ▸ Remote on the working machine (`remote:status`). */
export type RemoteAccessStatus = {
	/** The `remoteAccess` module (spec/remote-access-and-mobile#module-and-settings). */
	module: boolean;
	enabled: boolean;
	passwordSet: boolean;
	machineName: string;
	/** The system's name, for the field's placeholder. */
	defaultName: string;
	port: number;
	pairingPort: number;
	/** Where the gateway listens now; empty while off or with no LAN/Tailscale interface. */
	listening: RemoteAddress[];
	/** Why it does not listen although enabled (a port taken, the key store refused), English. */
	error: string | null;
	devices: RemoteDevice[];
	pairing: RemotePairing;
	control: RemoteControl;
	/** spec/remote-access-and-mobile#phone-network: the phone's web listener. */
	phone: RemotePhoneStatus;
	/** False when opened from a remote client: the tab is read-only there (spec/remote-access-and-mobile#module-and-settings). */
	editable: boolean;
};
export type RemoteNotice = {
	kind:
		| 'connected'
		| 'disconnected'
		| 'failed'
		| 'blocked'
		| 'tls-rejected'
		| 'paired'
		| 'pairing-failed';
	device: string | null;
	address: string | null;
	/** The network of the listener the connection reached (S7); absent — guessed from the address. */
	network?: RemoteNetwork | null;
	at: string;
};
export const remoteAuditKinds = [
	'access-enabled',
	'access-disabled',
	'password-set',
	'password-changed',
	'renamed',
	'pairing-opened',
	'pairing-closed',
	'pairing-failed',
	'pairing-exhausted',
	'pairing-expired',
	'pairing-declined',
	'paired',
	'login',
	'login-failed',
	'login-refused',
	'tls-rejected',
	'blocked',
	'unblocked',
	'revoked',
	'revoked-all',
	'expired',
	'disconnected',
	'took-back',
	'took-over',
	'version-mismatch',
	// spec/remote-access-and-mobile#pairing (security review R1, S9).
	'call-refused',
	'settings-changed',
	'dropped',
	'module-enabled',
	'module-disabled',
	// spec/remote-access-and-mobile#phone-network.
	'phone-enabled',
	'phone-disabled',
	'push-subscribed',
	'push-removed',
] as const;
export type RemoteAuditKind = (typeof remoteAuditKinds)[number];
/** One line of `remote/audit.jsonl` (spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings). */
export type RemoteAuditEntry = {
	at: string;
	kind: RemoteAuditKind;
	device: string | null;
	deviceId: string | null;
	address: string | null;
	/**
	 * The network of the listener the connection reached, as the gateway decided it (spec/remote-access-and-mobile#pairing). Lines written before
	 * it have none: the log reads them as before, by the address.
	 */
	network?: RemoteNetwork | null;
	detail: string | null;
};
export function isRemoteAuditEntry(value: unknown): value is RemoteAuditEntry {
	const text = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 512);
	return (
		isRecord(value) &&
		typeof value.at === 'string' &&
		remoteAuditKinds.includes(value.kind as RemoteAuditKind) &&
		text(value.device) &&
		text(value.deviceId) &&
		text(value.address) &&
		(value.network === undefined || value.network === null || isNetwork(value.network)) &&
		text(value.detail)
	);
}
export const remoteAuditLimit = 500;

/** A working machine as a device remembers it (`remote/machines.json` on the device). */
export type PairedMachine = {
	/** The fingerprint of the machine's certificate. */
	id: string;
	name: string;
	addresses: RemoteAddress[];
	port: number;
	pairingPort: number;
	pairedAt: string;
	lastConnectedAt: string | null;
};
/** A machine heard over mDNS (spec/remote-access-and-mobile#module-and-settings): `id` matches a paired machine when it is one. */
export type FoundMachine = {
	name: string;
	id: string | null;
	addresses: string[];
	port: number;
	pairingPort: number;
};
export type RemotePairResult =
	| { ok: true; machine: PairedMachine }
	| {
			ok: false;
			reason:
				| 'code'
				| 'closed'
				| 'exhausted'
				| 'declined'
				| 'busy'
				| 'unreachable'
				| 'version'
				| 'identity'
				| 'off';
			attemptsLeft: number | null;
			message: string;
	  };
/** `local`: someone works at the machine now (its window is in front and in use); connect again with `takeOver` (spec/remote-access-and-mobile#architecture). */
export type RemoteConnectFailure =
	| 'password'
	| 'wait'
	| 'blocked'
	| 'version'
	| 'unreachable'
	| 'unknown'
	| 'off'
	| 'identity'
	| 'local';
export type RemoteConnectResult =
	| { ok: true }
	| {
			ok: false;
			reason: RemoteConnectFailure;
			/** For `wait` and `password`: when the next try is accepted. */
			retryAfterMs: number | null;
			/** For `password`: tries before the device is blocked. */
			attemptsLeft: number | null;
			/** For `version`: the machine's name for «Оновіть Бригадир на <машина>». */
			machine: string | null;
			message: string;
	  };
/** The device side of one connection (`remote:session`), what the chip and the Connect list draw (spec/remote-access-and-mobile#module-and-settings). */
export type RemoteSession = {
	machineId: string;
	machineName: string;
	state: 'connecting' | 'connected' | 'reconnecting' | 'closed';
	address: RemoteAddress | null;
	latencyMs: number | null;
	/** This device controls the machine; false after «Take back» there (spec/remote-access-and-mobile#module-and-settings). */
	active: boolean;
	/** Why it closed: `revoked`, `off`, `password-changed`, `expired` (resume ran out), `replaced`, `dropped`, `user`. */
	closedReason: string | null;
	nextAttemptMs: number | null;
	/** When this connection logged in (the chip's menu: «since 19:20»). */
	since: string | null;
	/**
	 * Logins of this link so far (spec/remote-access-and-mobile#networking): it grows after a reconnect or a move to another address — for the
	 * machine that is a new client, so the window says its visible task, menu, browser stream and simulator again.
	 */
	generation: number;
};
/**
 * spec/remote-access-and-mobile#networking: whether a paired machine answers now, before any password — `network` and `address` of the address
 * that answered, null when none did; `checking` before the first answer of this showing of the list.
 */
export type RemoteReach = {
	machineId: string;
	state: 'checking' | 'answered' | 'silent';
	network: RemoteNetwork | null;
	address: string | null;
	/** The machine knows a Tailscale address: «does not answer» rather than «unavailable outside the LAN». */
	tailscale: boolean;
};
/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#identity-and-keys: where this computer keeps its remote access key. `plain` — Linux without a secret service
 * (Chromium's `basic_text`): remote access refuses it; `missing` — no OS key store at all.
 */
export type RemoteKeyStore = 'ok' | 'plain' | 'missing';
/** spec/remote-access-and-mobile#module-and-settings: the device's pairing in progress — the code went through and the machine asks its person. */
export type RemotePairProgress = { state: 'waiting'; machine: string };
export function isRemotePairProgress(value: unknown): value is RemotePairProgress {
	return isRecord(value) && value.state === 'waiting' && typeof value.machine === 'string';
}

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: calls that set state main keeps for one client — the visible task, the menu context,
 * a PTY's size, the browser view's place. From a client that does not control the machine they are answered without
 * effect, so the covered window keeps working behind its cover.
 */
export function remoteActiveOnly(channel: string, args: readonly unknown[]): boolean {
	if (channel === 'notifications:visible' || channel === 'menu:context') return true;
	const command = args[1];
	if (channel === 'terminal:command') return isRecord(command) && command.kind === 'resize';
	if (channel === 'browser:command') return isRecord(command) && command.kind === 'mount';
	// spec/remote-access-and-mobile#browser-from-device: the stream and its input belong to the client in control; a stop and an ack are always fine.
	if (channel === 'browser:screen')
		return isRecord(command) && command.kind !== 'stop' && command.kind !== 'ack';
	return false;
}
/** spec/remote-access-and-mobile#module-and-settings: the channels of remote access itself answer with the module's sentence while it is off. */
export function isRemoteAccessChannel(channel: string): boolean {
	return channel.startsWith('remote:');
}

const fingerprint = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const isRemoteId = fingerprint;
/** `remote:pair` — an address the person typed or mDNS gave: a host name or an IP literal, optional port. */
export function isRemoteHost(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 253 &&
		/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?|[0-9.]+|\[?[0-9A-Fa-f:.]+\]?)$/.test(
			value
		)
	);
}
export const isRemotePort = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65535;

/** spec/remote-access-and-mobile#module-and-settings: a moment in the device list, the journal and the cover — «сьогодні о 19:20», «3 жовтня о 09:12». */
export function remoteMoment(locale: 'en' | 'uk', iso: string | null, now = Date.now()): string {
	if (!iso) return '';
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return '';
	const time = new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'en-GB', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(at);
	const day = (value: Date) =>
		new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
	const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
	if (days === 0) return locale === 'uk' ? `сьогодні о ${time}` : `today at ${time}`;
	if (days === 1) return locale === 'uk' ? `вчора о ${time}` : `yesterday at ${time}`;
	const date = new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'en-GB', {
		day: 'numeric',
		month: 'long',
		...(at.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
	}).format(at);
	return locale === 'uk' ? `${date} о ${time}` : `${date} at ${time}`;
}
/** The time of day alone, «19:20» (the cover's «since», the journal's column for today). */
export function remoteClock(locale: 'en' | 'uk', iso: string | null): string {
	if (!iso) return '';
	const at = new Date(iso);
	if (!Number.isFinite(at.getTime())) return '';
	return new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'en-GB', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(at);
}
/** A network's name as the interface shows it; LAN and Tailscale are not translated (spec/remote-access-and-mobile#module-and-settings). */
export function remoteNetworkName(network: RemoteNetwork): string {
	return network === 'tailscale' ? 'Tailscale' : network === 'lan' ? 'LAN' : 'loopback';
}

/**
 * spec/remote-access-and-mobile#networking: where a sign-in page sends the browser back — `redirect_uri` on this computer's loopback (Codex:
 * `http://localhost:1455/auth/callback`). Null for anything else: another host, https, a port below 1024.
 */
export type LoopbackRedirect = { host: string; port: number; path: string };
export function loopbackRedirect(signInUrl: string): LoopbackRedirect | null {
	if (!/^https:\/\//i.test(signInUrl) || signInUrl.length > 8192) return null;
	const query = signInUrl.split('#')[0]!.split('?')[1] ?? '';
	const raw = query
		.split('&')
		.find((part) => part.startsWith('redirect_uri='))
		?.slice('redirect_uri='.length);
	if (!raw) return null;
	let redirect: string;
	try {
		redirect = decodeURIComponent(raw.replace(/\+/g, ' '));
	} catch {
		return null;
	}
	const match =
		/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(\/[^?#\s]*)?(?:[?#].*)?$/i.exec(redirect);
	if (!match) return null;
	const port = Number(match[2]);
	if (port < 1024 || port > 65535) return null;
	return {
		host: match[1]!.toLowerCase().replace(/^\[|\]$/g, ''),
		port,
		path: match[3] ?? '/',
	};
}
/** The headers of the device's browser that reach the sign-in's own server on the machine. */
export const agentRelayHeaders = ['accept', 'accept-language', 'user-agent'] as const;
export type AgentLoginRelayRequest = {
	method: 'GET' | 'HEAD';
	/** Path and query, as the browser asked the device's loopback. */
	path: string;
	headers: Partial<Record<(typeof agentRelayHeaders)[number], string>>;
};
export type AgentLoginRelayResponse = {
	status: number;
	/** `content-type`, `cache-control`, and `location` as a path on the same server. */
	headers: Record<string, string>;
	body: Uint8Array;
};
export const agentRelayLimits = {
	pathBytes: 2048,
	headerValue: 512,
	bodyBytes: 1024 * 1024,
	requests: 16,
	timeoutMs: 10_000,
	/** The device's listener lives at most this long. */
	listenMs: 10 * 60_000,
} as const;
const headerValue = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length <= agentRelayLimits.headerValue &&
	!/[\r\n\0]/.test(value);
export function isAgentLoginRelayRequest(value: unknown): value is AgentLoginRelayRequest {
	if (!isRecord(value) || Object.keys(value).length !== 3) return false;
	if (value.method !== 'GET' && value.method !== 'HEAD') return false;
	const path = value.path;
	if (
		typeof path !== 'string' ||
		path.length > agentRelayLimits.pathBytes ||
		!path.startsWith('/') ||
		path.startsWith('//') ||
		/[\s\0\\]/.test(path)
	)
		return false;
	const headers = value.headers;
	return (
		isRecord(headers) &&
		Object.entries(headers).every(
			([name, item]) => (agentRelayHeaders as readonly string[]).includes(name) && headerValue(item)
		)
	);
}
