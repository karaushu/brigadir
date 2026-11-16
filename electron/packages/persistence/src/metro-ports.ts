import { open, readFile, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';

import { isRecord, type TaskKey } from '@brigadir/core';
import { atomicJson, safePath, type SessionStore } from './session';
/**
 * spec/browser-and-simulator#metro-port: the Metro port of each task with its own worktree, in `metro-ports.json` of the data root. Every
 * host takes its own port when it starts — also a crew worker's host, which its foreman's host starts — so the allocation is shared by
 * main and the hosts: one at a time under a lock file, the free port chosen and written before the lock is let go.
 */
export const metroPortRange = { first: 8082, last: 8999 } as const;
const portsFile = 'metro-ports.json',
	lockFile = 'metro-ports.lock',
	staleLockMs = 15_000;
const portOk = (value: unknown) =>
	Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) <= 65_535;
const taskName = (key: TaskKey) => `${key.projectId}/${key.id}`;
/** Whether nothing listens on `port` now: it could be listened on at both `127.0.0.1` and `::`. */
export async function portFree(port: number): Promise<boolean> {
	const listen = (host: string) =>
		new Promise<boolean>((resolve) => {
			const server = createServer();
			server.once('error', (error: NodeJS.ErrnoException) =>
				// A machine without IPv6 has no `::` to be busy on.
				resolve(host === '::' && error.code === 'EAFNOSUPPORT')
			);
			server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
		});
	return (await listen('127.0.0.1')) && (await listen('::'));
}
/**
 * The task keeps its saved port while it is free or its own Metro holds it; otherwise the lowest free port not given to another task.
 * A busy port is never handed out: Expo without a terminal aborts on it.
 */
export async function assignMetroPort(options: {
	saved: number | undefined;
	taken: ReadonlySet<number>;
	free?: (port: number) => Promise<boolean>;
	ownMetro?: (port: number) => Promise<boolean>;
}): Promise<number> {
	const free = options.free ?? portFree;
	const { saved, taken } = options;
	if (
		saved !== undefined &&
		!taken.has(saved) &&
		((await free(saved)) || (await (options.ownMetro?.(saved) ?? false)))
	)
		return saved;
	for (let port = metroPortRange.first; port <= metroPortRange.last; port++)
		if (!taken.has(port) && port !== saved && (await free(port))) return port;
	throw new Error('No free port for Metro.');
}
/** Every task's port, by `projectId/taskId`; an entry that does not validate is left out. */
export async function readMetroPorts(root: string): Promise<Record<string, number>> {
	const ports: Record<string, number> = {};
	try {
		const doc = JSON.parse(await readFile(await safePath(root, portsFile), 'utf8')) as unknown;
		if (isRecord(doc) && doc.schemaVersion === 1 && isRecord(doc.ports))
			for (const [name, port] of Object.entries(doc.ports))
				if (/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/.test(name) && portOk(port))
					ports[name] = Number(port);
	} catch {
		/* no ports yet */
	}
	return ports;
}
/** Runs `work` while this process holds the lock file; a lock left by a process that died goes after 15 s. */
async function locked<T>(root: string, work: () => Promise<T>, waitMs = 20_000): Promise<T> {
	const path = await safePath(root, lockFile),
		until = Date.now() + waitMs;
	for (;;) {
		try {
			const handle = await open(path, 'wx', 0o600);
			await handle.close();
			break;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'EEXIST') throw error;
			const age = await stat(path).then(
				(info) => Date.now() - info.mtimeMs,
				() => 0
			);
			if (age > staleLockMs) await unlink(path).catch(() => {});
			else if (Date.now() > until) throw new Error('The Metro ports are locked.');
			else await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await work();
	} finally {
		await unlink(path).catch(() => {});
	}
}
async function writePorts(root: string, ports: Record<string, number>) {
	await atomicJson(await safePath(root, portsFile), { schemaVersion: 1, ports });
}
/** The port of a task whose worktree is `own`: kept, or the lowest free one, written before another allocator may look. */
export async function metroPortFor(
	root: string,
	key: TaskKey,
	own: string,
	options: {
		free?: (port: number) => Promise<boolean>;
		ownMetro?: (port: number) => Promise<boolean>;
	} = {}
): Promise<number> {
	return locked(root, async () => {
		const ports = await readMetroPorts(root),
			name = taskName(key),
			taken = new Set(
				Object.entries(ports)
					.filter(([other]) => other !== name)
					.map(([, port]) => port)
			);
		const port = await assignMetroPort({
			saved: ports[name],
			taken,
			...(options.free ? { free: options.free } : {}),
			ownMetro:
				options.ownMetro ??
				(async (port) => {
					const response = await fetch(`http://127.0.0.1:${port}/status`, {
						signal: AbortSignal.timeout(500),
					}).catch(() => null);
					const root = response?.headers.get('x-react-native-project-root');
					return !!root && (root === own || root.startsWith(`${own}/`));
				}),
		});
		if (ports[name] !== port) await writePorts(root, { ...ports, [name]: port });
		return port;
	});
}
/** A task that ended gives its port back. */
export async function forgetMetroPort(root: string, key: TaskKey) {
	await locked(root, async () => {
		const ports = await readMetroPorts(root);
		if (!(taskName(key) in ports)) return;
		delete ports[taskName(key)];
		await writePorts(root, ports);
	});
}
/** The task's own worktree, or null for a task in the project folder: only a worktree gets a port of its own. */
export async function taskWorktree(store: SessionStore, key: TaskKey): Promise<string | null> {
	const [tree, project] = await Promise.all([
		store.projectForTask(key),
		store.project(key.projectId),
	]);
	return tree.path !== project.path ? tree.path : null;
}
/**
 * spec/browser-and-simulator#metro-port: the environment a task's host gives its agent and terminals. A task with a worktree gets its own
 * port; one in the project folder drops a port it inherited from another task's host (a foreman's), and keeps the person's own.
 */
export async function applyMetroPort(
	store: SessionStore,
	key: TaskKey,
	env: NodeJS.ProcessEnv,
	options: {
		free?: (port: number) => Promise<boolean>;
		ownMetro?: (port: number) => Promise<boolean>;
		worktree?: (key: TaskKey) => Promise<string | null>;
	} = {}
): Promise<number | null> {
	const own = await (options.worktree ?? ((key: TaskKey) => taskWorktree(store, key)))(key).catch(
		() => null
	);
	if (own) {
		const port = await metroPortFor(store.root, key, own, {
			...(options.free ? { free: options.free } : {}),
			...(options.ownMetro ? { ownMetro: options.ownMetro } : {}),
		});
		env.RCT_METRO_PORT = String(port);
		env.BRIGADIR_METRO_TASK = taskName(key);
		return port;
	}
	if (env.BRIGADIR_METRO_TASK && env.BRIGADIR_METRO_TASK !== taskName(key)) {
		delete env.RCT_METRO_PORT;
		delete env.BRIGADIR_METRO_TASK;
	}
	return null;
}
export const metroPortsLockFile = lockFile;
