import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRecord, type TaskKey } from '@brigadir/core';
import {
	atomicJson,
	readDocument,
	safePath,
	ProcessCoordinator,
	type SessionStore,
} from '@brigadir/persistence';
import { hostAppVersion } from './version';
export type HostIdentity = {
	schemaVersion: 1;
	protocolVersion: 1;
	key: TaskKey;
	pid: number;
	startedAt: string;
	instance: string;
	socket: string;
	uiToken: string;
	mcpToken: string;
	hookToken?: string;
	/** spec/crew#communication: the parent crew host connects with this token; it never displaces the UI peer. */ crewToken?: string;
	/** spec/architecture-and-platform#auto-update: the app version of this host's code; absent in hosts of older builds and unbundled tests. */ appVersion?: string;
};
export async function runtimeFile(store: SessionStore, key: TaskKey) {
	return safePath(await store.taskDir(key), 'host.json');
}
export async function readIdentity(
	store: SessionStore,
	key: TaskKey
): Promise<HostIdentity | null> {
	try {
		const v: unknown = JSON.parse(await readFile(await runtimeFile(store, key), 'utf8'));
		if (
			!isRecord(v) ||
			v.schemaVersion !== 1 ||
			v.protocolVersion !== 1 ||
			!isRecord(v.key) ||
			v.key.projectId !== key.projectId ||
			v.key.id !== key.id ||
			!Number.isSafeInteger(v.pid) ||
			typeof v.startedAt !== 'string' ||
			typeof v.instance !== 'string' ||
			typeof v.socket !== 'string' ||
			typeof v.uiToken !== 'string' ||
			typeof v.mcpToken !== 'string' ||
			(v.appVersion !== undefined &&
				(typeof v.appVersion !== 'string' || v.appVersion.length > 100))
		)
			throw new Error('Unsupported host identity');
		return v as HostIdentity;
	} catch (e) {
		if (isRecord(e) && e.code === 'ENOENT') return null;
		throw e;
	}
}
async function reclaimOwner(store: SessionStore, key: TaskKey, processes: ProcessCoordinator) {
	const lock = await safePath(await store.taskDir(key), 'host.lock');
	try {
		const owner: unknown = await readDocument(lock);
		if (
			!isRecord(owner) ||
			owner.schemaVersion !== 1 ||
			!Number.isSafeInteger(owner.pid) ||
			Number(owner.pid) <= 0
		)
			throw new Error('Invalid host owner');
		if (
			owner.processStart !== undefined &&
			(typeof owner.processStart !== 'string' || !/^[-a-f0-9:]{3,100}$/.test(owner.processStart))
		)
			throw new Error('Invalid host owner');
		const current = await processes.identity(Number(owner.pid));
		// Older owners have only a wall-clock date. Reclaim those only when the PID is absent.
		const absent =
			current === null || (owner.processStart !== undefined && current !== owner.processStart);
		if (!absent) throw new Error('A host already owns this task');
		await unlink(lock);
	} catch (e) {
		if (!(isRecord(e) && e.code === 'ENOENT')) throw e;
	}
}
export async function reclaimAbsentOwner(store: SessionStore, key: TaskKey, helper: string) {
	const processes = new ProcessCoordinator(helper);
	return processes.transaction(await safePath(await store.taskDir(key), 'host-owner.guard'), () =>
		reclaimOwner(store, key, processes)
	);
}
export async function acquireOwner(store: SessionStore, key: TaskKey, helper: string) {
	const path = await safePath(await store.taskDir(key), 'host.lock');
	const processes = new ProcessCoordinator(helper),
		guard = await safePath(await store.taskDir(key), 'host-owner.guard'),
		instance = randomUUID();
	await processes.transaction(guard, async () => {
		await reclaimOwner(store, key, processes);
		const processStart = await processes.identity(process.pid);
		if (!processStart) throw new Error('Host process is not running');
		await atomicJson(path, {
			schemaVersion: 1,
			pid: process.pid,
			processStart,
			instance,
			startedAt: new Date().toISOString(),
		});
	});
	return async () =>
		processes.transaction(guard, async () => {
			const owner = await readDocument(path);
			if (owner.instance !== instance || owner.pid !== process.pid)
				throw new Error('Host owner changed');
			await unlink(path);
		});
}
export async function newIdentity(store: SessionStore, key: TaskKey): Promise<HostIdentity> {
	const instance = randomUUID();
	const name = createHash('sha256')
		.update(`${store.root}/${key.projectId}/${key.id}/${instance}`)
		.digest('hex')
		.slice(0, 24);
	let dir = await safePath(store.root, 'run');
	if (Buffer.byteLength(join(dir, `${name}.sock`)) >= 104)
		dir = join('/tmp', `brigadir.${process.getuid?.() ?? 'user'}`);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (
		info.isSymbolicLink() ||
		!info.isDirectory() ||
		(process.getuid && info.uid !== process.getuid())
	)
		throw new Error('Unsafe socket directory');
	await chmod(dir, 0o700);
	return {
		schemaVersion: 1,
		protocolVersion: 1,
		key,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		instance,
		socket: join(dir, `${name}.sock`),
		uiToken: randomBytes(32).toString('hex'),
		mcpToken: randomBytes(32).toString('hex'),
		hookToken: randomBytes(32).toString('hex'),
		crewToken: randomBytes(32).toString('hex'),
		...(hostAppVersion ? { appVersion: hostAppVersion } : {}),
	};
}
export async function saveIdentity(store: SessionStore, identity: HostIdentity) {
	await atomicJson(await runtimeFile(store, identity.key), identity);
}
/** spec/architecture-and-platform#host-lifecycle: how often a host checks that its task dir and socket still exist. */
export const orphanCheckMs = 5000;
export type DirMark = { dev: number; ino: number };
export async function dirMark(dir: string): Promise<DirMark> {
	const info = await stat(dir);
	return { dev: info.dev, ino: info.ino };
}
/** spec/architecture-and-platform#host-lifecycle: nobody can reach the host or read what it writes — its task dir is gone or replaced, or its socket is gone. */
export async function orphaned(dir: string, mark: DirMark, socket: string) {
	const missing = (e: unknown) => isRecord(e) && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
	try {
		const info = await stat(dir);
		if (info.dev !== mark.dev || info.ino !== mark.ino) return true;
	} catch (e) {
		if (missing(e)) return true;
		throw e;
	}
	try {
		await lstat(socket);
	} catch (e) {
		if (missing(e)) return true;
		throw e;
	}
	return false;
}
