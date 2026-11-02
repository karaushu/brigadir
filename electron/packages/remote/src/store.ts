/**
 * spec/remote-access-and-mobile#architecture, rule 10: the files of remote access under `<data>/remote/` — pretty JSON with sorted keys, the audit as
 * JSONL. Nothing here holds a secret in clear: the private key is sealed by the OS key store (`KeyVault`) and the
 * password is a scrypt hash.
 */
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isRecord,
	isRemoteAddress,
	isRemoteAuditEntry,
	isMachineName,
	isRemotePort,
	remoteAuditLimit,
	type PairedMachine,
	type RemoteAddress,
	type RemoteAuditEntry,
	type RemoteAuditKind,
} from '@brigadir/core';
import { atomicJson, readDocument, resolveDataRoot, safePath } from '@brigadir/persistence';
import {
	createIdentity,
	fingerprintOf,
	isIdentity,
	isPeerCertificate,
	type Identity,
} from './cert';
import { isPasswordHash, type PasswordHash } from './password';
import { isPasskeyRecord, passkeyDeviceId, type PasskeyRecord } from './webauthn';
import {
	createVapidKeys,
	isVapidKeys,
	type PushSubscriptionRecord,
	type VapidKeys,
} from './web-push';

/** The OS key store: Keychain, libsecret or DPAPI through Electron's `safeStorage`; a fake in tests. */
export interface KeyVault {
	seal(text: string): Buffer;
	open(sealed: Buffer): string;
}
const isMissing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
const isId = (value: unknown): value is string =>
	typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isIso = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));

export class RemoteFiles {
	private readonly dir: Promise<string>;
	private made = false;
	/** The folder is resolved (and the legacy store refused) on first use, not here. */
	constructor(dataDir?: string) {
		this.dir = resolveDataRoot(dataDir).then((root) => join(root, 'remote'));
		this.dir.catch(() => {});
	}
	async path(name: string): Promise<string> {
		const dir = await this.dir;
		if (!this.made) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			this.made = true;
		}
		return safePath(dir, name);
	}
	async read(name: string): Promise<Record<string, unknown> | null> {
		try {
			return await readDocument(await this.path(name));
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}
	async write(name: string, value: Record<string, unknown>): Promise<void> {
		await atomicJson(await this.path(name), { schemaVersion: 1, ...value });
	}
}

/**
 * This installation's identity, one for both roles: the working machine's server certificate and the device's client
 * certificate. Made on first use, so a person who never turns remote access on never touches the key store.
 */
export async function loadIdentity(files: RemoteFiles, vault: KeyVault): Promise<Identity> {
	const doc = await files.read('identity.json');
	if (doc && isRecord(doc.identity)) {
		const { cert, fingerprint, sealedKey } = doc.identity;
		if (
			typeof cert === 'string' &&
			typeof fingerprint === 'string' &&
			typeof sealedKey === 'string'
		) {
			const identity = { cert, fingerprint, key: vault.open(Buffer.from(sealedKey, 'base64')) };
			if (isIdentity(identity)) return identity;
		}
		throw new Error('The remote access identity is damaged.');
	}
	const identity = createIdentity();
	await files.write('identity.json', {
		identity: {
			cert: identity.cert,
			fingerprint: identity.fingerprint,
			sealedKey: vault.seal(identity.key).toString('base64'),
		},
	});
	return identity;
}

/**
 * spec/remote-access-and-mobile#phone-network: the machine's VAPID key for Web Push, sealed like the identity's key (`remote/vapid.json`). Made when a
 * phone first signs in, so the key store is not touched before.
 */
export async function loadVapidKeys(files: RemoteFiles, vault: KeyVault): Promise<VapidKeys> {
	const doc = await files.read('vapid.json');
	if (doc && isRecord(doc.vapid)) {
		const { publicKey, sealedKey } = doc.vapid;
		if (typeof publicKey === 'string' && typeof sealedKey === 'string') {
			const keys = { publicKey, privateKey: vault.open(Buffer.from(sealedKey, 'base64')) };
			if (isVapidKeys(keys)) return keys;
		}
		throw new Error('The Web Push key is damaged.');
	}
	const keys = createVapidKeys();
	await files.write('vapid.json', {
		vapid: {
			publicKey: keys.publicKey,
			sealedKey: vault.seal(keys.privateKey).toString('base64'),
		},
	});
	return keys;
}

export async function readPassword(files: RemoteFiles): Promise<PasswordHash | null> {
	const doc = await files.read('password.json');
	if (!doc) return null;
	if (!isPasswordHash(doc.password)) throw new Error('The remote access password file is damaged.');
	return doc.password;
}
export async function writePassword(files: RemoteFiles, password: PasswordHash): Promise<void> {
	await files.write('password.json', { password });
}

/** One paired device in `remote/devices.json`. */
export type DeviceRecord = {
	id: string;
	name: string;
	/** spec/remote-access-and-mobile#phone-network: a computer (its certificate) or a phone (its passkey); a record written before phones is a computer. */
	kind: 'computer' | 'phone';
	/** A computer's certificate; null for a phone. */
	cert: string | null;
	/** A phone's passkey. */
	passkey?: PasskeyRecord;
	/** A phone's Web Push subscription, once its page gave one. */
	push?: PushSubscriptionRecord | null;
	pairedAt: string;
	lastLoginAt: string | null;
	lastAddress: RemoteAddress | null;
	failures: number;
	lastFailureAt: string | null;
	blocked: boolean;
};
const isPushRecord = (value: unknown): value is PushSubscriptionRecord =>
	isRecord(value) &&
	Object.keys(value).length === 3 &&
	typeof value.endpoint === 'string' &&
	value.endpoint.length <= 2048 &&
	typeof value.p256dh === 'string' &&
	value.p256dh.length <= 100 &&
	typeof value.auth === 'string' &&
	value.auth.length <= 40;
/** A computer is its certificate; a phone is its passkey, under the id of the key — never both. */
function isDeviceIdentity(value: Record<string, unknown>): boolean {
	if (value.kind === 'phone')
		return (
			value.cert === null &&
			isPasskeyRecord(value.passkey) &&
			passkeyDeviceId(value.passkey.credentialId) === value.id &&
			(value.push === undefined || value.push === null || isPushRecord(value.push))
		);
	return (
		(value.kind === undefined || value.kind === 'computer') &&
		value.passkey === undefined &&
		value.push === undefined &&
		isPeerCertificate(value.cert) &&
		fingerprintOf(value.cert) === value.id
	);
}
function isDeviceRecord(value: unknown): value is DeviceRecord {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isMachineName(value.name) &&
		isDeviceIdentity(value) &&
		isIso(value.pairedAt) &&
		(value.lastLoginAt === null || isIso(value.lastLoginAt)) &&
		(value.lastAddress === null || isRemoteAddress(value.lastAddress)) &&
		Number.isSafeInteger(value.failures) &&
		Number(value.failures) >= 0 &&
		(value.lastFailureAt === null || isIso(value.lastFailureAt)) &&
		typeof value.blocked === 'boolean'
	);
}
/** spec/remote-access-and-mobile#architecture: a device not seen for 30 days is forgotten. */
export const deviceIdleDays = 30;
export const deviceExpiresAt = (device: DeviceRecord) =>
	new Date(Date.parse(device.lastLoginAt ?? device.pairedAt) + deviceIdleDays * 86_400_000);

/** The working machine's registry of paired devices. Writes run one at a time; readers get copies. */
export class DeviceRegistry {
	private devices: DeviceRecord[] = [];
	private writes: Promise<unknown> = Promise.resolve();
	private constructor(
		private readonly files: RemoteFiles,
		private readonly now: () => number
	) {}
	static async open(files: RemoteFiles, now: () => number = Date.now): Promise<DeviceRegistry> {
		const registry = new DeviceRegistry(files, now);
		const doc = await files.read('devices.json');
		if (doc) {
			if (!Array.isArray(doc.devices)) throw new Error('The device registry is damaged.');
			// A damaged entry is dropped, not trusted: it can only cost a device its pairing.
			registry.devices = doc.devices
				.filter(isDeviceRecord)
				.map((device) => ({ ...device, kind: device.kind ?? 'computer' }));
		}
		return registry;
	}
	/** Forgets devices idle for 30 days; returns them so the caller can write the audit. */
	async expire(): Promise<DeviceRecord[]> {
		const now = this.now();
		const gone = this.devices.filter((device) => deviceExpiresAt(device).getTime() <= now);
		if (gone.length) {
			this.devices = this.devices.filter((device) => !gone.includes(device));
			await this.save();
		}
		return gone;
	}
	list(): DeviceRecord[] {
		const now = this.now();
		return this.devices
			.filter((device) => deviceExpiresAt(device).getTime() > now)
			.map((device) => structuredClone(device));
	}
	get(id: string): DeviceRecord | null {
		const device = this.devices.find((item) => item.id === id);
		return device && deviceExpiresAt(device).getTime() > this.now()
			? structuredClone(device)
			: null;
	}
	/** Pairing again with the same certificate keeps one entry under the new name. */
	async add(name: string, cert: string): Promise<DeviceRecord> {
		const id = fingerprintOf(cert);
		const device: DeviceRecord = {
			id,
			name,
			kind: 'computer',
			cert,
			pairedAt: new Date(this.now()).toISOString(),
			lastLoginAt: null,
			lastAddress: null,
			failures: 0,
			lastFailureAt: null,
			blocked: false,
		};
		this.devices = [...this.devices.filter((item) => item.id !== id), device];
		await this.save();
		return structuredClone(device);
	}
	/** spec/remote-access-and-mobile#phone-network: a phone and its passkey; pairing again with the same key keeps one entry. */
	async addPhone(name: string, passkey: PasskeyRecord): Promise<DeviceRecord> {
		const id = passkeyDeviceId(passkey.credentialId);
		const device: DeviceRecord = {
			id,
			name,
			kind: 'phone',
			cert: null,
			passkey: structuredClone(passkey),
			push: null,
			pairedAt: new Date(this.now()).toISOString(),
			lastLoginAt: null,
			lastAddress: null,
			failures: 0,
			lastFailureAt: null,
			blocked: false,
		};
		this.devices = [...this.devices.filter((item) => item.id !== id), device];
		await this.save();
		return structuredClone(device);
	}
	async remove(id: string): Promise<DeviceRecord | null> {
		const device = this.devices.find((item) => item.id === id) ?? null;
		if (!device) return null;
		this.devices = this.devices.filter((item) => item !== device);
		await this.save();
		return device;
	}
	async clear(): Promise<DeviceRecord[]> {
		const gone = this.devices;
		this.devices = [];
		await this.save();
		return gone;
	}
	async update(id: string, change: (device: DeviceRecord) => void): Promise<DeviceRecord | null> {
		const device = this.devices.find((item) => item.id === id);
		if (!device) return null;
		change(device);
		await this.save();
		return structuredClone(device);
	}
	private save() {
		const write = this.writes.then(() =>
			this.files.write('devices.json', { devices: this.devices })
		);
		this.writes = write.catch(() => {});
		return write;
	}
}

/** The device side: the machines this installation paired with (`remote/machines.json`). */
export type MachineRecord = PairedMachine & { cert: string };
function isMachineRecord(value: unknown): value is MachineRecord {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isMachineName(value.name) &&
		isPeerCertificate(value.cert) &&
		fingerprintOf(value.cert) === value.id &&
		Array.isArray(value.addresses) &&
		value.addresses.length <= 32 &&
		value.addresses.every(isRemoteAddress) &&
		isRemotePort(value.port) &&
		isRemotePort(value.pairingPort) &&
		isIso(value.pairedAt) &&
		(value.lastConnectedAt === null || isIso(value.lastConnectedAt))
	);
}
export class MachineList {
	private machines: MachineRecord[] = [];
	private writes: Promise<unknown> = Promise.resolve();
	private constructor(private readonly files: RemoteFiles) {}
	static async open(files: RemoteFiles): Promise<MachineList> {
		const list = new MachineList(files);
		const doc = await files.read('machines.json');
		if (doc && Array.isArray(doc.machines)) list.machines = doc.machines.filter(isMachineRecord);
		return list;
	}
	list(): MachineRecord[] {
		return this.machines.map((machine) => structuredClone(machine));
	}
	get(id: string): MachineRecord | null {
		const machine = this.machines.find((item) => item.id === id);
		return machine ? structuredClone(machine) : null;
	}
	async put(machine: MachineRecord): Promise<void> {
		this.machines = [
			...this.machines.filter((item) => item.id !== machine.id),
			structuredClone(machine),
		];
		await this.save();
	}
	async remove(id: string): Promise<void> {
		this.machines = this.machines.filter((item) => item.id !== id);
		await this.save();
	}
	private save() {
		const write = this.writes.then(() =>
			this.files.write('machines.json', { machines: this.machines })
		);
		this.writes = write.catch(() => {});
		return write;
	}
}

/** `remote/audit.jsonl`: one line per event, appended one at a time; over 2 MiB the file moves to `audit.1.jsonl`. */
export class AuditLog {
	private writes: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly files: RemoteFiles,
		private readonly now: () => number = Date.now
	) {}
	append(
		kind: RemoteAuditKind,
		fields: Partial<Omit<RemoteAuditEntry, 'at' | 'kind'>> = {}
	): Promise<RemoteAuditEntry> {
		const clip = (value: string | null | undefined) => (value == null ? null : value.slice(0, 512));
		const entry: RemoteAuditEntry = {
			at: new Date(this.now()).toISOString(),
			kind,
			device: clip(fields.device),
			deviceId: clip(fields.deviceId),
			address: clip(fields.address),
			network: fields.network ?? null,
			detail: clip(fields.detail),
		};
		const write = this.writes.then(async () => {
			const path = await this.files.path('audit.jsonl');
			try {
				if ((await stat(path)).size > 2 * 1024 * 1024)
					await rename(path, await this.files.path('audit.1.jsonl'));
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			const file = await open(path, 'a', 0o600);
			try {
				await file.appendFile(`${JSON.stringify(entry)}\n`);
				await file.sync();
			} finally {
				await file.close();
			}
		});
		this.writes = write.catch((error: unknown) => {
			// A lost audit line must not stop a login or a pairing; it is reported where main logs.
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
		return this.writes.then(() => entry);
	}
	/** Waits for the lines already appended (quit, tests). */
	flush(): Promise<void> {
		return this.writes.then(() => {});
	}
	onError: ((error: Error) => void) | null = null;
	/** The newest `limit` entries, newest first. */
	async read(limit = remoteAuditLimit): Promise<RemoteAuditEntry[]> {
		await this.writes;
		const lines: RemoteAuditEntry[] = [];
		for (const name of ['audit.jsonl', 'audit.1.jsonl']) {
			if (lines.length >= limit) break;
			let text: string;
			try {
				const file = await open(await this.files.path(name), 'r');
				try {
					text = await file.readFile('utf8');
				} finally {
					await file.close();
				}
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			const entries = text
				.split('\n')
				.filter(Boolean)
				.flatMap((line) => {
					try {
						const value: unknown = JSON.parse(line);
						return isRemoteAuditEntry(value) ? [value] : [];
					} catch {
						return [];
					}
				})
				.reverse();
			lines.push(...entries.slice(0, limit - lines.length));
		}
		return lines;
	}
}
