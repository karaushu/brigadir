/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#pairing: remote access in main — Electron's part around `@brigadir/remote`.
 *
 * Working machine: the gateway follows Settings ▸ Remote and the `remoteAccess` module; each logged-in device becomes a
 * `Client` whose calls go through main's one `dispatch` (the same validators and handlers as the local window); the
 * key lives in `safeStorage`; mDNS says the machine; keep-awake holds while access is on.
 *
 * Device: paired machines, pairing, connections with reconnect; a connected machine gets a window of the same renderer
 * (`openWindow`) whose remote-class calls main forwards over the connection and whose client-class calls main runs here.
 */
import { hostname, networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { powerMonitor, safeStorage, shell } from 'electron';
import {
	bidiControls,
	changedSettingKeys,
	guardRemoteSettings,
	guardPhoneSettings,
	ipcSubscribeRows,
	ipcTableHash,
	isMachineName,
	isRemotePort,
	moduleOffMessages,
	type AppSettings,
	isRemoteMenu,
	isRemoteNotify,
	isRemoteSave,
	type FoundMachine,
	type Appearance,
	type MachineAppearance,
	type NativeMenuItem,
	type PairedMachine,
	type RemoteNotify,
	type RemoteSave,
	type RemoteFileChoice,
	isRemoteFileChoice,
	isRemoteDialog,
	isMachineAppearance,
	type TaskKey,
	type RemoteAccessSettings,
	type RemoteConnectResult,
	type RemoteControl,
	type RemoteNotice,
	type RemotePairResult,
	type RemoteReach,
	type RemoteSession,
	type AgentLoginRelayResponse,
	type AgentLoginState,
	loopbackRedirect,
} from '@brigadir/core';
import {
	CallbackListener,
	MachineList,
	Mdns,
	classifyAddress,
	mdnsId,
	mergeFoundAddresses,
	raceAddresses,
	rankAddresses,
	touchMachine,
	type HeardMachine,
	RemoteFiles,
	RemoteGateway,
	RemoteLink,
	loadIdentity,
	pairWithMachine,
	type Identity,
	type KeyVault,
	type MachineRecord,
	type PushKind,
	type RemotePeer,
	type WebDeps,
} from '@brigadir/remote';
import type { BrowserWindow } from 'electron';
import type { Client, Clients } from './clients';
import { isTrustedSender, type Sender } from './trusted-sender';

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#transport-and-protocol: the private key is sealed by the OS key store. On Linux a `basic_text` backend is a
 * plain-text file, so remote access refuses it; on macOS `getSelectedStorageBackend` does not exist and is not called.
 */
export function electronVault(): KeyVault {
	if (process.platform === 'linux') {
		const backend = safeStorage.getSelectedStorageBackend();
		if (backend === 'basic_text' || backend === 'unknown')
			// spec/architecture-and-platform#linux-package: catalog keys, so Settings ▸ Remote shows them in the window's language (`Not listening: {error}`).
			throw new Error(
				'No secret service (GNOME Keyring or KWallet): Brigadir cannot keep the key of this computer. Install one and start Brigadir again.'
			);
	}
	if (!safeStorage.isEncryptionAvailable())
		throw new Error(
			'The system key store is not available: Brigadir cannot keep the key of this computer.'
		);
	return {
		seal: (text) => safeStorage.encryptString(text),
		open: (sealed) => safeStorage.decryptString(sealed),
	};
}
/**
 * spec/remote-access-and-mobile#pairing: the e2e hooks — a key store that never asks the OS keychain (with `BRIGADIR_DATA_DIR` and
 * `BRIGADIR_TEST_REMOTE_VAULT=1`) and loopback listeners with their own ports (`BRIGADIR_REMOTE_LISTEN`, `…_PORT`,
 * `…_PAIRING_PORT`). A packaged build has none of them, and the listen override takes loopback addresses only: an
 * environment variable must not unseal the key or put the gateway on 0.0.0.0 (security review R1, S4).
 */
export function remoteTestHooks(
	env: Record<string, string | undefined>,
	packaged: boolean
): Pick<RemoteAccessDeps, 'vault' | 'listenOverride' | 'callbackPortOffset' | 'webTest'> {
	if (packaged) return { listenOverride: null };
	const offset = Number(env.BRIGADIR_TEST_CALLBACK_PORT_OFFSET);
	const addresses = (env.BRIGADIR_REMOTE_LISTEN ?? '')
		.split(',')
		.map((address) => address.trim())
		.filter((address) => classifyAddress(address) === 'loopback');
	const port = (value: string | undefined, fallback: number) =>
		isRemotePort(Number(value)) ? Number(value) : fallback;
	return {
		...(env.BRIGADIR_DATA_DIR && env.BRIGADIR_TEST_REMOTE_VAULT === '1'
			? {
					vault: () => ({
						seal: (text: string) => Buffer.from(`test:${text}`),
						open: (sealed: Buffer) => sealed.toString().replace(/^test:/, ''),
					}),
				}
			: {}),
		listenOverride: addresses.length
			? {
					addresses,
					port: port(env.BRIGADIR_REMOTE_PORT, 7420),
					pairingPort: port(env.BRIGADIR_REMOTE_PAIRING_PORT, 7421),
				}
			: null,
		// spec/remote-access-and-mobile#networking: two instances on one computer cannot both listen on a sign-in's port.
		...(env.BRIGADIR_DATA_DIR && Number.isSafeInteger(offset) && offset > 0 && offset < 1000
			? { callbackPortOffset: offset }
			: {}),
		// spec/remote-access-and-mobile#phone-network: the phone's listener on its own port, under `localhost` instead of the tailnet name.
		...(env.BRIGADIR_DATA_DIR && env.BRIGADIR_REMOTE_WEB_HOST === 'localhost'
			? { webTest: { port: port(env.BRIGADIR_REMOTE_WEB_PORT, 7422) } }
			: {}),
	};
}
/** The system's name for the machine (spec/remote-access-and-mobile#module-and-settings): the host name without `.local`. */
export function systemMachineName(): string {
	const name = hostname()
		.replace(/\.local\.?$/i, '')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(new RegExp(bidiControls.source, 'g'), '')
		.trim()
		.slice(0, 64)
		.trim();
	return isMachineName(name) ? name : 'Brigadir';
}
/** A window of this machine that shows a connected machine. */
export type ClientWindow = {
	isDestroyed(): boolean;
	isFocused(): boolean;
	webContents: Sender & { send(channel: string, value: unknown): void };
	on(event: 'closed', listener: () => void): unknown;
	close(): void;
	show?(): void;
	focus?(): void;
	isMinimized?(): boolean;
	restore?(): void;
};
/** A window of another machine as the device's native side sees it (spec/remote-access-and-mobile#client-ui-seam). */
export type MachineWindowRef = {
	machineId: string;
	window: ClientWindow;
	/** The task the window shows now (its last `notifications:visible`), for a notice of that very task. */
	visible(): TaskKey | null;
	/** `Allow` / `Deny` of a notice, back to the machine. */
	act(id: number, action: 'allow' | 'deny'): void;
	/** A click on a notice: the window in front with that task. */
	open(key: TaskKey): void;
};
/**
 * spec/remote-access-and-mobile#client-ui-seam: what a connected machine asks this device to show on its own screen. The device's main shows a menu and a
 * save natively over the machine's window, notices with its own OS, and keeps the machine's appearance for that window.
 */
export type DeviceUi = {
	menu(
		window: ClientWindow,
		items: NativeMenuItem[],
		at: { x: number; y: number } | null
	): Promise<string | null>;
	save(window: ClientWindow, save: RemoteSave): Promise<boolean>;
	/** spec/remote-access-and-mobile#browser-from-device: files of this device for a page's file input of the machine; null — the person cancelled. */
	files(
		window: ClientWindow,
		request: RemoteFileChoice
	): Promise<{ name: string; data: Uint8Array }[] | null>;
	notify(ref: MachineWindowRef, value: RemoteNotify): void;
	/** The machine's settings with this device's theme, accent and fonts. */
	appearance(machine: MachineAppearance): Appearance;
	/** The connection went: its notices and badge go too. */
	closed(machineId: string): void;
};
export type RemoteAccessDeps = {
	dataDir: string | undefined;
	clients: Clients;
	/** main's one entry for every call (spec/architecture-and-platform#ipc-boundary): validators, module checks, handlers. */
	dispatch(client: Client, channel: string, args: unknown[]): Promise<unknown>;
	settings(): AppSettings;
	/** Saves a change of the `remoteAccess` block and applies it like Settings do. */
	saveRemoteSettings(next: RemoteAccessSettings): Promise<AppSettings>;
	/** The key store; a fake in tests. */
	vault?: () => KeyVault;
	/** Remote access turned on or off: keep-awake counts again (spec/remote-access-and-mobile#architecture). */
	holdChanged(): void;
	/** Opens the window for a connected machine (the same renderer and preload as the local window). */
	openWindow(machine: PairedMachine): ClientWindow;
	entry: string;
	development: boolean;
	log(line: string): void;
	/** e2e: listen on these addresses (loopback) and ports instead of the interfaces and 7420/7421. */
	listenOverride?: { addresses: string[]; port: number; pairingPort: number } | null;
	/** spec/remote-access-and-mobile#architecture: someone works at this machine now (its window in front and in use). */
	localPresent?(): boolean;
	/** spec/remote-access-and-mobile#client-ui-seam: the device's native side for a connected machine's menus, saves, notices and appearance. */
	device?: DeviceUi;
	/** A device's connection went: what it was asked to show closes as cancelled. */
	detached?(client: Client): void;
	/** Who controls this machine changed (spec/remote-access-and-mobile#architecture): the browser lets go of what the old controller saw. */
	controlChanged?(): void;
	/** e2e: the device's sign-in listener takes the sign-in's port plus this (spec/remote-access-and-mobile#networking). */
	callbackPortOffset?: number;
	/** This computer's interfaces; tests pass their own. */
	interfaces?: () => ReturnType<typeof networkInterfaces>;
	/** spec/remote-access-and-mobile#phone-network: the phone's bundle (`out/renderer-mobile`), null when it is not there. */
	webBundle?: string | null;
	/** spec/remote-access-and-mobile#phone-task-tools: the app's version the phone's machine sheet names. */
	webVersion?: string;
	/** e2e only: the phone's listener on this port under `localhost` (spec/remote-access-and-mobile#phone-network). */
	webTest?: { port: number };
	/** Tests: what the web listener uses for Tailscale and Web Push. */
	web?: Partial<WebDeps>;
};
/** spec/remote-access-and-mobile#networking: how often the Connect list touches the paired machines, and the network is looked at. */
const reachMs = 10_000;
const networkMs = 2_000;
type Connection = {
	link: RemoteLink;
	window: ClientWindow | null;
	client: Client | null;
	detach: () => void;
	visible: TaskKey | null;
	/** The machine's part of the appearance, for this window's `appearance:changed`. */
	appearance: MachineAppearance | null;
	/** spec/remote-access-and-mobile#networking: the loopback listener of a sign-in started from this window. */
	signIn: { provider: string; listener: CallbackListener } | null;
};
export class RemoteAccess {
	readonly gateway: RemoteGateway;
	private readonly mdns: Mdns;
	private readonly peers = new Map<string, Client>();
	private readonly connections = new Map<string, Connection>();
	private readonly files: RemoteFiles;
	private machines: Promise<MachineList> | null = null;
	private identity: Promise<Identity> | null = null;
	private found: FoundMachine[] = [];
	private browsing = false;
	private pairing: AbortController | null = null;
	/** spec/remote-access-and-mobile#networking: each paired machine's last touch while the list is open. */
	private reach = new Map<string, RemoteReach>();
	/** Machines that turned this device's certificate down: not touched again while the list is open. */
	private refusedReach = new Set<string>();
	private reaching: Promise<void> | null = null;
	private reachTimer: ReturnType<typeof setInterval> | null = null;
	private networkTimer: ReturnType<typeof setInterval> | null = null;
	private networkShape = '';
	private readonly wake = () => this.networkChanged();
	constructor(private readonly deps: RemoteAccessDeps) {
		this.files = new RemoteFiles(deps.dataDir);
		const vault = () => (deps.vault ?? electronVault)();
		this.mdns = new Mdns(deps.log);
		const override = deps.listenOverride ?? null;
		this.gateway = new RemoteGateway({
			files: this.files,
			vault,
			tableHash: ipcTableHash(),
			defaultName: systemMachineName(),
			dispatch: (peer, channel, args) => {
				const client = this.peers.get(peer.id);
				if (!client) return Promise.reject(new Error('Not connected.'));
				return deps.dispatch(client, channel, args);
			},
			attach: (peer) => this.attach(peer),
			changed: () => this.changed(),
			controlChanged: () => this.publishControl(),
			notice: (notice) => this.notice(notice),
			log: deps.log,
			localPresent: () => deps.localPresent?.() ?? false,
			web: {
				bundle: deps.webBundle ?? null,
				...(deps.webVersion ? { version: deps.webVersion } : {}),
				...(deps.webTest ? { port: deps.webTest.port, testHost: true } : {}),
				...deps.web,
			},
			...(override
				? {
						port: override.port,
						pairingPort: override.pairingPort,
						addresses: () =>
							override.addresses.map((address) => ({
								network: 'loopback',
								address,
							})),
						rescanMs: 0,
					}
				: {}),
		});
	}

	// —— the working machine ——

	/** Settings changed (or the app started): the gateway follows the module and the block. */
	async configure(settings: AppSettings = this.deps.settings()) {
		const module = settings.modules.remoteAccess;
		await this.gateway.configure({ module, ...settings.remoteAccess });
		if (!module) {
			for (const id of [...this.connections.keys()]) this.disconnect(id);
			this.browse(false);
		}
		this.deps.holdChanged();
	}
	/** Keep-awake's hold (spec/remote-access-and-mobile#architecture). */
	holding(): boolean {
		const settings = this.deps.settings();
		return settings.modules.remoteAccess && settings.remoteAccess.enabled;
	}
	private requireModule() {
		if (!this.deps.settings().modules.remoteAccess) throw new Error(moduleOffMessages.remoteAccess);
	}
	status(client: Client) {
		return this.gateway.status(Boolean(client.device));
	}
	/** Whether a client may set main's per-client state (spec/remote-access-and-mobile#architecture): the local window or a device in control. */
	isActive(client: Client): boolean {
		if (client.local) return this.gateway.isActive(null);
		if (client.device) return this.gateway.isActive(client.id);
		return true;
	}
	async setEnabled(enabled: boolean, password: string | undefined) {
		this.requireModule();
		if (password !== undefined) await this.gateway.setPassword(password);
		if (enabled && !(await this.gateway.hasPassword()))
			throw new Error('Set a password for remote access first.');
		const current = this.deps.settings().remoteAccess;
		const saved = await this.deps.saveRemoteSettings({ ...current, enabled });
		await this.configure(saved);
		return this.gateway.status(false);
	}
	/** spec/remote-access-and-mobile#phone-network: the phone's web listener on or off; it listens only with access on. */
	async setPhone(enabled: boolean) {
		this.requireModule();
		const current = this.deps.settings().remoteAccess;
		const saved = await this.deps.saveRemoteSettings({ ...current, phone: enabled });
		await this.configure(saved);
		return this.gateway.status(false);
	}
	/** Tailscale asked again: the machine's name in the tailnet and `tailscale serve`. */
	async checkPhone() {
		this.requireModule();
		await this.gateway.web.check();
		return this.gateway.status(false);
	}
	/**
	 * spec/remote-access-and-mobile#phone: a notice main shows would also reach the subscribed phones — the task's name and the kind only. The web
	 * listener sends nothing while the module, access or the phone's switch is off.
	 */
	pushPhones(type: PushKind, task: string, key: string) {
		void this.gateway
			.pushPhones(type, task, key)
			.catch((error: unknown) =>
				this.deps.log(`remote: Web Push: ${error instanceof Error ? error.message : String(error)}`)
			);
	}
	async setPassword(password: string) {
		this.requireModule();
		await this.gateway.setPassword(password);
		await this.configure();
		return this.gateway.status(false);
	}
	async rename(name: string | null) {
		this.requireModule();
		const current = this.deps.settings().remoteAccess;
		const saved = await this.deps.saveRemoteSettings({ ...current, machineName: name });
		await this.configure(saved);
		return this.gateway.status(false);
	}
	async revoke(id: string) {
		this.requireModule();
		await this.gateway.revoke(id);
		return this.gateway.status(false);
	}
	async revokeAll() {
		this.requireModule();
		await this.gateway.revokeAll();
		return this.gateway.status(false);
	}
	async unblock(id: string) {
		this.requireModule();
		await this.gateway.unblock(id);
		return this.gateway.status(false);
	}
	/** The cover's «Disconnect <device>»: the connection goes, the device stays paired. */
	async drop(id: string) {
		this.requireModule();
		await this.gateway.drop(id);
		return this.gateway.status(false);
	}
	/** «Show in file manager» under the log. */
	async revealAudit() {
		this.requireModule();
		const file = await this.files.path('audit.jsonl');
		if (existsSync(file)) shell.showItemInFolder(file);
		else await shell.openPath(await this.files.path('.'));
	}
	async startPairing() {
		this.requireModule();
		return this.gateway.startPairing();
	}
	async stopPairing() {
		this.requireModule();
		return this.gateway.stopPairing();
	}
	async confirmPairing(accept: boolean, name: string | null) {
		this.requireModule();
		return this.gateway.confirmPairing(accept, name);
	}
	async readAudit(limit: number) {
		this.requireModule();
		return this.gateway.readAudit(limit);
	}
	/** Whether the client with this id controls the machine (a device's peer id; `local` — the window). */
	isActiveId(id: string): boolean {
		return this.gateway.isActive(id === 'local' ? null : id);
	}
	/** «Take back» from the local window, «Take control again» from a device. */
	async takeControl(client: Client): Promise<RemoteControl> {
		this.requireModule();
		if (client.local) return this.gateway.takeControl(null);
		if (client.device) return this.gateway.takeControl(client.id);
		throw new Error('Take control from the machine’s window.');
	}
	/**
	 * spec/remote-access-and-mobile#architecture: a remote `settings:save` keeps the module switch and the remote block as they are here; the audit
	 * notes which keys it changes, never their values (spec/remote-access-and-mobile#pairing).
	 */
	guardSettings(client: Client, value: AppSettings): AppSettings {
		if (!client.device) return value;
		const current = this.deps.settings();
		// spec/remote-access-and-mobile#phone-network: a phone changes the notifications only.
		const guarded =
			client.device.kind === 'phone'
				? guardPhoneSettings(value, current)
				: guardRemoteSettings(value, current);
		const changed = changedSettingKeys(current, guarded);
		if (changed.length) this.gateway.auditPeer(client.id, 'settings-changed', changed.join(', '));
		return guarded;
	}
	/** spec/remote-access-and-mobile#pairing: a device asked for a forbidden or client-class row. */
	callRefused(client: Client, channel: string) {
		if (client.device) this.gateway.auditPeer(client.id, 'call-refused', channel);
	}
	private attach(peer: RemotePeer): () => void {
		const client: Client = {
			id: peer.id,
			local: false,
			device: { id: peer.deviceId, name: peer.deviceName, kind: peer.kind ?? 'computer' },
			events: 'remote',
			send: (channel, value, droppable) => peer.send(channel, value, droppable),
			// A device never speaks Electron IPC.
			owns: () => false,
		};
		this.peers.set(peer.id, client);
		const remove = this.deps.clients.add(client);
		return () => {
			remove();
			this.peers.delete(peer.id);
			this.deps.detached?.(client);
		};
	}
	private changed() {
		this.deps.clients.personal('remote:status', (client) =>
			this.gateway.status(Boolean(client.device))
		);
		const status = this.gateway.status(false),
			fingerprint = this.gateway.fingerprint;
		// spec/remote-access-and-mobile#networking: said again when the name or the listened addresses change; a goodbye when access goes off.
		void this.mdns.advertise(
			status.module &&
				status.enabled &&
				fingerprint &&
				status.listening.some((item) => item.network === 'lan')
				? {
						name: status.machineName,
						port: status.port,
						pairingPort: status.pairingPort,
						fingerprint,
						addresses: status.listening.map((item) => item.address),
					}
				: null
		);
	}
	/** spec/remote-access-and-mobile#client-ui-seam: the device in control now — its notices, sounds and badge go there; null — the local window. */
	activeDevice(): Client | null {
		for (const client of this.peers.values()) if (this.gateway.isActive(client.id)) return client;
		return null;
	}
	private publishControl() {
		this.deps.controlChanged?.();
		this.deps.clients.personal('remote:control', (client) =>
			this.gateway.control(client.device ? client.id : null)
		);
	}
	private notice(notice: RemoteNotice) {
		this.deps.clients.broadcast('remote:notice', notice);
	}

	// —— the device ——

	private machineList() {
		return (this.machines ??= MachineList.open(this.files));
	}
	private ownIdentity() {
		const vault = this.deps.vault ?? electronVault;
		this.identity ??= Promise.resolve()
			.then(() => loadIdentity(this.files, vault()))
			.catch((error: unknown) => {
				this.identity = null;
				throw error;
			});
		return this.identity;
	}
	async readMachines(): Promise<PairedMachine[]> {
		this.requireModule();
		return (await this.machineList()).list().map(publicMachine);
	}
	browse(on: boolean) {
		if (on) this.requireModule();
		if (on === this.browsing) return;
		this.browsing = on;
		this.found = [];
		this.mdns.browse(on ? (machines) => void this.heard(machines) : null);
		if (this.reachTimer) clearInterval(this.reachTimer);
		this.reachTimer = null;
		this.reach.clear();
		this.refusedReach.clear();
		if (on) {
			void this.touchMachines(true);
			this.reachTimer = setInterval(() => void this.touchMachines(), reachMs);
			this.reachTimer.unref?.();
		}
		this.watchNetwork();
	}
	/**
	 * spec/remote-access-and-mobile#networking: machines heard over mDNS — this computer's own record left out, a paired one under its id (its new
	 * LAN addresses join `machines.json` and a live link), an unpaired one without an id.
	 */
	private async heard(machines: HeardMachine[]) {
		const list = await this.machineList(),
			paired = new Map(list.list().map((machine) => [mdnsId(machine.id), machine])),
			own = this.gateway.fingerprint ? mdnsId(this.gateway.fingerprint) : null;
		const found: FoundMachine[] = [];
		for (const item of machines) {
			if (item.id && item.id === own) continue;
			const machine = item.id ? paired.get(item.id) : undefined;
			if (machine) {
				const addresses = mergeFoundAddresses(machine.addresses, item.addresses);
				if (addresses.length !== machine.addresses.length) {
					await list.put({ ...machine, addresses });
					this.connections.get(machine.id)?.link.learn(addresses);
				}
			}
			found.push({ ...item, id: machine?.id ?? null });
		}
		if (!this.browsing) return;
		this.found = found;
		this.deps.clients.broadcast('remote:found', found);
	}
	/**
	 * spec/remote-access-and-mobile#networking: whether each paired machine answers now — a TLS touch with its pinned certificate on every address,
	 * the first to answer wins; a connected machine answers through its link. One run at a time.
	 */
	private touchMachines(first = false): Promise<void> {
		if (this.reaching) return this.reaching;
		const run = async () => {
			const machines = (await this.machineList()).list();
			if (!this.browsing || !machines.length) return;
			if (first)
				for (const machine of machines)
					this.reach.set(machine.id, {
						machineId: machine.id,
						state: 'checking',
						network: null,
						address: null,
						tailscale: machine.addresses.some((item) => item.network === 'tailscale'),
					});
			this.publishReach();
			let identity: Identity;
			try {
				identity = await this.ownIdentity();
			} catch {
				return;
			}
			const local = (this.deps.interfaces ?? networkInterfaces)();
			await Promise.all(
				machines.map(async (machine) => {
					const tailscale = machine.addresses.some((item) => item.network === 'tailscale'),
						session = this.connections.get(machine.id)?.link.session();
					let reach: RemoteReach;
					if (session?.state === 'connected' && session.address)
						reach = {
							machineId: machine.id,
							state: 'answered',
							network: session.address.network,
							address: session.address.address,
							tailscale,
						};
					else if (this.refusedReach.has(machine.id)) return;
					else {
						const won = await raceAddresses(
							rankAddresses(machine.addresses, local, null),
							(address, signal) =>
								touchMachine({
									identity,
									cert: machine.cert,
									id: machine.id,
									address: address.address,
									port: machine.port,
									signal,
								}),
							() => {},
							0
						);
						if (won?.value === 'refused') this.refusedReach.add(machine.id);
						reach = {
							machineId: machine.id,
							state: won ? 'answered' : 'silent',
							network: won?.address.network ?? null,
							address: won?.address.address ?? null,
							tailscale,
						};
					}
					if (this.browsing) this.reach.set(machine.id, reach);
				})
			);
			this.publishReach();
		};
		this.reaching = run()
			.catch((error: unknown) =>
				this.deps.log(`remote: reach: ${error instanceof Error ? error.message : String(error)}`)
			)
			.finally(() => {
				this.reaching = null;
			});
		return this.reaching;
	}
	private publishReach() {
		if (this.browsing) this.deps.clients.broadcast('remote:reach', [...this.reach.values()]);
	}
	/**
	 * spec/remote-access-and-mobile#networking: this computer's network changed or it woke — links check themselves, the list asks the LAN and
	 * touches the machines again.
	 */
	networkChanged() {
		this.networkShape = networkSignature((this.deps.interfaces ?? networkInterfaces)());
		for (const connection of this.connections.values()) connection.link.networkChanged();
		if (this.browsing) {
			this.mdns.refresh();
			void this.touchMachines();
		}
	}
	/** The interfaces are looked at only while a link is open or the list shows; `powerMonitor` says sleep and wake. */
	private watchNetwork() {
		const want = this.browsing || this.connections.size > 0;
		if (want && !this.networkTimer) {
			this.networkShape = networkSignature((this.deps.interfaces ?? networkInterfaces)());
			this.networkTimer = setInterval(() => {
				const shape = networkSignature((this.deps.interfaces ?? networkInterfaces)());
				if (shape !== this.networkShape) this.networkChanged();
			}, networkMs);
			this.networkTimer.unref?.();
			try {
				powerMonitor.on('resume', this.wake);
				powerMonitor.on('unlock-screen', this.wake);
			} catch {
				// Not in Electron (unit tests).
			}
		} else if (!want && this.networkTimer) {
			clearInterval(this.networkTimer);
			this.networkTimer = null;
			try {
				powerMonitor.off('resume', this.wake);
				powerMonitor.off('unlock-screen', this.wake);
			} catch {
				// Not in Electron.
			}
		}
	}
	async pair(
		host: string,
		port: number | null,
		code: string,
		deviceName: string | null
	): Promise<RemotePairResult> {
		this.requireModule();
		let identity: Identity;
		try {
			identity = await this.ownIdentity();
		} catch (error) {
			return {
				ok: false,
				reason: 'identity',
				attemptsLeft: null,
				message: error instanceof Error ? error.message : String(error),
			};
		}
		const settings = this.deps.settings();
		this.pairing?.abort();
		const pairing = new AbortController();
		this.pairing = pairing;
		try {
			const { result, record } = await pairWithMachine({
				identity,
				host,
				port,
				code,
				deviceName: deviceName ?? settings.remoteAccess.machineName ?? systemMachineName(),
				tableHash: ipcTableHash(),
				signal: pairing.signal,
				onWait: (machine) =>
					this.deps.clients.broadcast('remote:pair-progress', { state: 'waiting', machine }),
			});
			if (record && !pairing.signal.aborted) await (await this.machineList()).put(record);
			return result;
		} finally {
			if (this.pairing === pairing) this.pairing = null;
		}
	}
	/** The device's «Cancel» while the machine asks its person. */
	cancelPair() {
		this.pairing?.abort();
		this.pairing = null;
	}
	/** The name this computer offers when it pairs (spec/remote-access-and-mobile#module-and-settings): its own machine name. */
	deviceName(): string {
		return this.deps.settings().remoteAccess.machineName ?? systemMachineName();
	}
	async forget(id: string) {
		this.requireModule();
		this.disconnect(id);
		await (await this.machineList()).remove(id);
	}
	sessions(): RemoteSession[] {
		return [...this.connections.values()].map((connection) => connection.link.session());
	}
	private publishSessions() {
		this.deps.clients.broadcast('remote:sessions', this.sessions());
	}
	/**
	 * Connects to a paired machine and opens its window (spec/remote-access-and-mobile#architecture). R1b calls this from `File ▸ Connect…`; the
	 * password stays in this call, the reconnects use the machine's resume token.
	 */
	async connect(id: string, password: string, takeOver: boolean): Promise<RemoteConnectResult> {
		this.requireModule();
		const machines = await this.machineList();
		const machine = machines.get(id);
		const refused = (reason: 'unknown' | 'identity', message: string): RemoteConnectResult => ({
			ok: false,
			reason,
			message,
			retryAfterMs: null,
			attemptsLeft: null,
			machine: null,
		});
		if (!machine) return refused('unknown', 'This machine is not paired.');
		const existing = this.connections.get(id);
		if (existing && existing.link.session().state !== 'closed') return { ok: true };
		// A closed connection keeps its window until the person connects again or closes it (R1b draws its state).
		if (existing) this.disconnect(id);
		let identity: Identity;
		try {
			identity = await this.ownIdentity();
		} catch (error) {
			return refused('identity', error instanceof Error ? error.message : String(error));
		}
		const connection: Connection = {
			link: null!,
			window: null,
			client: null,
			detach: () => {},
			visible: null,
			appearance: null,
			signIn: null,
		};
		connection.link = new RemoteLink(
			machine,
			identity,
			ipcTableHash(),
			{
				event: (channel, value) => {
					// The machine's own events only: a client-class channel belongs to this machine (security review R1, S2).
					if (ipcSubscribeRows.get(channel)?.class !== 'remote') return;
					// spec/remote-access-and-mobile#networking: the sign-in stopped waiting — its loopback listener here closes; the window still hears it.
					if (channel === 'agent-login:changed') this.signInChanged(connection, value);
					if (this.intercept(connection, id, channel, value)) return;
					const window = connection.window;
					if (window && !window.isDestroyed()) window.webContents.send(channel, value);
				},
				session: () => this.publishSessions(),
				control: () => this.publishSessions(),
				machine: (record: MachineRecord) => void machines.put(record),
			},
			this.deps.log
		);
		connection.link.subscribe(
			[...ipcSubscribeRows.values()]
				.filter((row) => row.class === 'remote')
				.map((row) => row.channel)
		);
		this.connections.set(id, connection);
		this.watchNetwork();
		const result = await connection.link.connect(password, takeOver);
		if (!result.ok) {
			this.connections.delete(id);
			this.watchNetwork();
			this.publishSessions();
			return result;
		}
		this.openWindow(connection, publicMachine(machine));
		return result;
	}
	/**
	 * spec/remote-access-and-mobile#client-ui-seam: what the machine asks this device to show is shown here, never handed to its window as is — a menu and a
	 * save natively, a notice with this OS, the machine's appearance merged with this device's theme and fonts. Each is
	 * checked by its validator first: the machine is trusted with its own data, not with this device's screen.
	 */
	private intercept(connection: Connection, machineId: string, channel: string, value: unknown) {
		const ui = this.deps.device,
			window = connection.window,
			answer = (id: number, value: unknown) =>
				void connection.link.invoke('remote:ui-answer', [id, value]).catch(() => {});
		switch (channel) {
			case 'remote:menu':
				if (!isRemoteMenu(value)) return true;
				if (!ui || !window || window.isDestroyed()) answer(value.id, null);
				else
					void ui.menu(window, value.items, value.at).then(
						(choice) => answer(value.id, choice),
						() => answer(value.id, null)
					);
				return true;
			case 'remote:save':
				if (!isRemoteSave(value)) return true;
				if (!ui || !window || window.isDestroyed()) answer(value.id, false);
				else
					void ui.save(window, value).then(
						(saved) => answer(value.id, saved),
						() => answer(value.id, false)
					);
				return true;
			case 'remote:files':
				// spec/remote-access-and-mobile#browser-from-device: a page's file input — the native dialog of this device, the files uploaded, then the answer.
				if (!isRemoteFileChoice(value)) return true;
				if (!ui || !window || window.isDestroyed()) answer(value.id, false);
				else
					void ui.files(window, value).then(
						async (files) => {
							if (!files?.length) return answer(value.id, false);
							try {
								for (const file of files)
									await connection.link.invoke('browser:file', [value.id, file.name, file.data]);
								answer(value.id, true);
							} catch {
								answer(value.id, false);
							}
						},
						() => answer(value.id, false)
					);
				return true;
			case 'remote:notify':
				if (isRemoteNotify(value) && ui && window && !window.isDestroyed())
					ui.notify(
						{
							machineId,
							window,
							visible: () => connection.visible,
							act: (id, action) =>
								void connection.link.invoke('remote:notice-act', [id, action]).catch(() => {}),
							open: (key) => {
								if (window.isDestroyed()) return;
								window.show?.();
								window.focus?.();
								window.webContents.send('notification:open', key);
							},
						},
						value
					);
				return true;
			case 'remote:appearance':
				if (isMachineAppearance(value)) {
					connection.appearance = value;
					if (ui && window && !window.isDestroyed())
						window.webContents.send('appearance:changed', ui.appearance(connection.appearance));
				}
				return true;
			// The window shows it as is: a shape it cannot draw is dropped here (security review R2–R4, V4).
			case 'remote:dialog':
				return !isRemoteDialog(value);
		}
		return false;
	}
	/** The machine's appearance this device keeps for a window, or null before the machine sent it. */
	machineAppearance(client: Client): MachineAppearance | null {
		for (const connection of this.connections.values())
			if (connection.client === client) return connection.appearance;
		return null;
	}
	private openWindow(connection: Connection, machine: PairedMachine) {
		const window = this.deps.openWindow(machine);
		connection.window = window;
		const client: Client = {
			id: `window:${machine.id}`,
			local: false,
			// This machine's theme, menu and notifications reach it; the machine's own events come over the connection.
			events: 'client',
			send: (channel, value) => {
				if (window.isDestroyed()) return false;
				// This device's theme changed: the window takes it with the machine's settings (spec/remote-access-and-mobile#client-ui-seam).
				if (channel === 'appearance:changed') {
					if (connection.appearance && this.deps.device)
						window.webContents.send(
							'appearance:changed',
							this.deps.device.appearance(connection.appearance)
						);
					return true;
				}
				window.webContents.send(channel, value);
				return true;
			},
			owns: (event) =>
				!window.isDestroyed() &&
				isTrustedSender(event, window.webContents, this.deps.entry, this.deps.development),
			forward: async (channel, args) => {
				if (channel === 'notifications:visible')
					connection.visible = (args[0] as TaskKey | null) ?? null;
				const value = await connection.link.invoke(channel, args);
				// The window's first read: this device's theme changes compose with it from now on.
				if (channel === 'appearance:machine') {
					// A shape the device's main cannot compose is the machine's error, not a throw here later (V4).
					if (!isMachineAppearance(value)) throw new Error('The machine sent no appearance.');
					connection.appearance = value;
				}
				return value;
			},
			window: () => (window.isDestroyed() ? null : (window as unknown as BrowserWindow)),
		};
		connection.client = client;
		connection.detach = this.deps.clients.add(client);
		window.on('closed', () => this.disconnect(machine.id));
	}
	/**
	 * spec/remote-access-and-mobile#browser-from-device: this device closes its window of `machineId` — the machine has the window write its buffers
	 * (`flush`, the unsaved paths it could not keep come back) or takes back the drafts of a close the person cancelled.
	 */
	async closingWindow(machineId: string, phase: 'flush' | 'keep'): Promise<string[] | null> {
		const connection = this.connections.get(machineId);
		if (!connection || connection.link.session().state !== 'connected') return null;
		const answer = await Promise.race([
			connection.link.invoke('remote:closing', [phase]),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref?.()),
		]);
		return Array.isArray(answer)
			? answer.filter((item): item is string => typeof item === 'string')
			: null;
	}
	/** spec/remote-access-and-mobile#remote-button: brings the window of `machineId` to the front; false when it has none open. */
	showWindow(machineId: string): boolean {
		const window = this.connections.get(machineId)?.window;
		if (!window || window.isDestroyed()) return false;
		if (window.isMinimized?.()) window.restore?.();
		window.show?.();
		window.focus?.();
		return true;
	}
	/** The window of another machine that is in front now, if any: the menu bar's actions go to it (spec/remote-access-and-mobile#architecture). */
	focusedClient(): Client | null {
		for (const connection of this.connections.values())
			if (connection.window && !connection.window.isDestroyed() && connection.window.isFocused())
				return connection.client;
		return null;
	}
	disconnect(id: string) {
		const connection = this.connections.get(id);
		if (!connection) return;
		this.connections.delete(id);
		this.watchNetwork();
		connection.signIn?.listener.close();
		connection.detach();
		connection.link.close();
		this.deps.device?.closed(id);
		const window = connection.window;
		connection.window = null;
		if (window && !window.isDestroyed()) window.close();
		this.publishSessions();
	}
	/**
	 * spec/remote-access-and-mobile#networking: a window of another machine opens its agent's sign-in page here. When the page comes back to
	 * `localhost:<port>`, this device listens there for this sign-in only and passes each request to the machine.
	 */
	async openSignIn(client: Client, provider: 'claude' | 'codex', url: string): Promise<void> {
		const connection = [...this.connections.values()].find((item) => item.client === client),
			redirect = loopbackRedirect(url);
		if (connection && redirect) {
			connection.signIn?.listener.close();
			connection.signIn = null;
			const listener: CallbackListener = new CallbackListener(
				(request) =>
					connection.link.invoke('agent-login:relay', [
						provider,
						request,
					]) as Promise<AgentLoginRelayResponse>,
				() => {
					if (connection.signIn?.listener === listener) connection.signIn = null;
				},
				this.deps.log
			);
			const port = redirect.port + (this.deps.callbackPortOffset ?? 0);
			if (await listener.listen(port)) connection.signIn = { provider, listener };
			else this.deps.log(`remote: sign-in: port ${port} is taken on this computer`);
		}
		await shell.openExternal(url);
	}
	private signInChanged(connection: Connection, value: unknown) {
		const state = value as Partial<AgentLoginState> | null;
		if (
			connection.signIn &&
			state?.provider === connection.signIn.provider &&
			state.phase !== 'waiting'
		)
			connection.signIn.listener.close();
	}
	/**
	 * spec/remote-access-and-mobile#networking, e2e only: the machine sleeps (`freeze`), its network path breaks (`cut`), this device's network
	 * changes (`networkChanged`). main exposes these in an unpackaged test run and never otherwise.
	 */
	testHooks() {
		return {
			freeze: (on: boolean) => this.gateway.freeze(on),
			cut: (ms: number) => this.gateway.cut(ms),
			networkChanged: () => this.networkChanged(),
			signInPort: (machineId: string) =>
				this.connections.get(machineId)?.signIn?.listener.port ?? null,
		};
	}
	/** Quit: connections close, the gateway stops, mDNS says goodbye. */
	async close() {
		for (const id of [...this.connections.keys()]) this.disconnect(id);
		this.browse(false);
		await this.mdns.close();
		await this.gateway.close();
	}
}
/** What of the interfaces matters for reaching a machine: the external addresses, in order. */
export function networkSignature(interfaces: ReturnType<typeof networkInterfaces>): string {
	return Object.entries(interfaces)
		.flatMap(([name, list]) =>
			(list ?? []).filter((item) => !item.internal).map((item) => `${name}=${item.address}`)
		)
		.sort()
		.join(',');
}
const publicMachine = ({ cert: _cert, ...machine }: MachineRecord): PairedMachine => machine;
