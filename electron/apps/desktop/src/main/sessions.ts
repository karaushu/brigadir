import { Snapshots } from '@brigadir/git';
import { spawn } from 'node:child_process';
import { open, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isBusy,
	isRecord,
	samePullRequest,
	type ChangeView,
	type TerminalCommand,
	type TerminalEvent,
	type TerminalInfo,
	type SaveFileRequest,
	type SaveFileResult,
	type EventRecord,
	type SessionCommand,
	type SessionSnapshot,
	type TaskKey,
} from '@brigadir/core';
import {
	atomicJson,
	safePath,
	readWorkspace,
	JournalCache,
	SessionStore,
} from '@brigadir/persistence';
import {
	connectHost,
	readIdentity,
	reclaimAbsentOwner,
	acquireOwner,
	revertTaskFile,
	saveTaskFile,
	type HostClient,
} from '@brigadir/host/client';
import { hostNeedsReplacing } from './app-updates';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class Sessions {
	private clients = new Map<string, HostClient>();
	private attachments = new Map<string, Promise<HostClient | null>>();
	private starts = new Map<string, Promise<SessionSnapshot>>();
	private consoleStarts = new Set<Promise<SessionSnapshot>>();
	private consoleEpoch = 0;
	/** Journals of tasks without a live host, parsed once and then read from the appended tail. */
	private journals = new JournalCache(2);
	private consolesClosing = false;
	private consoleClose: Promise<void> | null = null;
	/** Terminals the renderer has read and not unwatched, per task: a reconnected host hears them again (TUI-02). */
	private watching = new Map<string, Set<string>>();
	/**
	 * spec/architecture-and-platform#auto-update: the running app version when hosts of another version are replaced (packaged builds); null in
	 * development. A host started from an older bundle hears `retire` on attach and stops at its next turn boundary; the next
	 * message starts a host of this app and resumes the session.
	 */
	appVersion: string | null = null;
	/** Live-delivery hooks: the first snapshot after attach seeds notifications; detach clears them. */
	onAttached: (key: TaskKey, snapshot: SessionSnapshot | null) => void = () => {};
	onDetached: (key: TaskKey) => void = () => {};
	openWindow() {
		this.consolesClosing = false;
	}
	/** BG-09 (spec/architecture-and-platform#host-lifecycle): the selected task's host never stops for idleness. A host hears it on every change and on attach; an older host ignores it. */
	private visible: TaskKey | null = null;
	setVisible(key: TaskKey | null) {
		const previous = this.visible;
		this.visible = key;
		if (previous && (!key || name(previous) !== name(key)))
			void this.clients
				.get(name(previous))
				?.visible(false)
				.catch(() => {});
		if (key) {
			const client = this.clients.get(name(key));
			if (client) void client.visible(true).catch(() => {});
			else void this.attach(key).catch(() => {});
		}
	}
	get isClosingConsoles() {
		return this.consoleClose !== null;
	}
	constructor(
		readonly dataDir: string | undefined,
		readonly services: string,
		readonly publish: (key: TaskKey, record: EventRecord | null) => void,
		readonly terminalEvent: (key: TaskKey, event: TerminalEvent) => void = () => {},
		readonly browserCall: (
			key: TaskKey,
			method: string,
			params: unknown
		) => Promise<unknown> = async () => {
			throw new Error('Browser is unavailable');
		}
	) {}
	private async attach(key: TaskKey): Promise<HostClient | null> {
		const current = this.clients.get(name(key));
		if (current) return current;
		const pending = this.attachments.get(name(key));
		if (pending) return pending;
		const promise = this.connect(key).finally(() => this.attachments.delete(name(key)));
		this.attachments.set(name(key), promise);
		return promise;
	}
	private async connect(key: TaskKey): Promise<HostClient | null> {
		const store = await SessionStore.at(this.dataDir);
		const identity = await readIdentity(store, key);
		if (!identity) return null;
		let client: HostClient | undefined;
		try {
			client = await connectHost(
				identity,
				(record) => this.publish(key, record),
				() => {
					if (client && this.clients.get(name(key)) === client) {
						this.clients.delete(name(key));
						this.onDetached(key);
						this.publish(key, null);
					}
				},
				(event) => this.terminalEvent(key, event),
				(method, params) => this.browserCall(key, method, params)
			);
			this.clients.set(name(key), client);
			const attached = client;
			if (hostNeedsReplacing(identity.appVersion, this.appVersion))
				void attached.command({ kind: 'retire' }).catch((error: unknown) => {
					// A host older than `retire` keeps running until it stops by itself.
					console.error(
						`[update] host of ${name(key)} (${identity.appVersion ?? 'unknown version'}) was not retired: ${error instanceof Error ? error.message : String(error)}`
					);
				});
			if (this.visible && name(this.visible) === name(key))
				void attached.visible(true).catch(() => {});
			for (const id of this.watching.get(name(key)) ?? [])
				void attached.terminal({ kind: 'read', id }).catch(() => {
					this.watching.get(name(key))?.delete(id);
				});
			void attached.snapshot().then(
				(snapshot) => {
					if (this.clients.get(name(key)) === attached) this.onAttached(key, snapshot);
				},
				() => {
					if (this.clients.get(name(key)) === attached) this.onAttached(key, null);
				}
			);
			return client;
		} catch {
			return null;
		}
	}
	async workspace() {
		const workspace = await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {});
		await Promise.all(
			workspace.tasks.map(async (task) => {
				if (!task.provider || !['working', 'needs-you', 'rate-limited'].includes(task.status))
					return;
				try {
					if (!(await this.attach(task)) && task.status !== 'rate-limited')
						task.status = 'interrupted';
					if (
						task.status === 'rate-limited' &&
						task.rateLimit?.resetsAt !== null &&
						task.rateLimit?.resetsAt !== undefined &&
						task.rateLimit.resetsAt * 1000 <= Date.now()
					) {
						task.status = 'interrupted';
						task.rateLimit = null;
					}
				} catch {
					workspace.issues.push({
						path: `projects/${task.projectId}/tasks/${task.id}/host.json`,
						code: 'unsupported_schema',
					});
				}
			})
		);
		return workspace;
	}
	/** `afterSeq` returns only newer records: readers that already hold the history ask for the tail (CHAT-07). */
	async read(key: TaskKey, afterSeq = 0): Promise<SessionSnapshot> {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		const client = await this.attach(key);
		if (client) {
			try {
				return await client.snapshot(afterSeq);
			} catch {
				this.clients.delete(name(key));
			}
		}
		const journal = await this.journals.read(store, key);
		return {
			key,
			records: journal.records.slice(Math.min(afterSeq, journal.records.length)),
			issue: journal.issue,
			connected: false,
		};
	}
	/** Readiness, a running turn and whether an agent ever started, without sending the journal (BG-04, IPC-02). */
	async activity(key: TaskKey): Promise<{ connected: boolean; busy: boolean; started: boolean }> {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		const client = await this.attach(key);
		if (client) {
			try {
				const status = await client.status();
				if (status.busy !== undefined)
					return {
						connected: status.connected,
						busy: status.busy,
						started: status.started !== null,
					};
				// A host started before `busy` existed: its snapshot answers once.
				const snapshot = await client.snapshot();
				return {
					connected: snapshot.connected,
					busy: isBusy(snapshot.records),
					started: snapshot.records.some((record) => record.event.kind === 'session.started'),
				};
			} catch {
				this.clients.delete(name(key));
			}
		}
		const { records } = await this.journals.read(store, key);
		return {
			connected: false,
			busy: isBusy(records),
			started: records.some((record) => record.event.kind === 'session.started'),
		};
	}
	/** Readiness without the journal: ScopePanel and pollers ask this on events, not for the records. */
	async connected(key: TaskKey): Promise<boolean> {
		const client = await this.attach(key);
		if (!client) return false;
		try {
			return (await client.status()).connected;
		} catch {
			return false;
		}
	}
	async start(key: TaskKey, allowScopeConflict = false): Promise<SessionSnapshot> {
		await this.ensure(key, false, allowScopeConflict);
		const client = await this.attach(key);
		if (!client) throw new Error('Host is not connected');
		await client.startAgent(allowScopeConflict);
		return client.snapshot();
	}
	private ensure(key: TaskKey, consoleOnly: boolean, allowScopeConflict = false) {
		const current = this.starts.get(name(key));
		if (current) return current;
		const promise = this.launch(key, consoleOnly, allowScopeConflict).finally(() => {
			this.starts.delete(name(key));
			this.consoleStarts.delete(promise);
		});
		this.starts.set(name(key), promise);
		if (consoleOnly) this.consoleStarts.add(promise);
		return promise;
	}
	async terminal(key: TaskKey, command: TerminalCommand) {
		const epoch = this.consoleEpoch;
		const check = () => {
			if (this.consolesClosing || epoch !== this.consoleEpoch) throw new Error('Window is closing');
		};
		check();
		let client = await this.attach(key);
		check();
		if (!client) {
			if (command.kind !== 'create' && command.kind !== 'list' && command.kind !== 'run')
				throw new Error('Host is not connected');
			await this.ensure(key, true);
			client = await this.attach(key);
		}
		check();
		if (!client) throw new Error('Host is not connected');
		if (command.kind === 'read') {
			const ids = this.watching.get(name(key)) ?? new Set<string>();
			ids.add(command.id);
			this.watching.set(name(key), ids);
		}
		if (command.kind === 'unwatch' || command.kind === 'close')
			this.watching.get(name(key))?.delete(command.id);
		return client.terminal(command);
	}
	/** spec/search-menus-and-commands#project-commands: the command tabs of a task whose host already runs; unlike `list`, never starts one. */
	async commandRuns(key: TaskKey): Promise<TerminalInfo[]> {
		const client = await this.attach(key);
		if (!client) return [];
		const all = await client.terminal({ kind: 'list' });
		return Array.isArray(all) ? (all as TerminalInfo[]).filter((item) => item.run) : [];
	}
	/** spec/task-window-workspace#restore-window: every terminal of a task whose host already runs; `null` without a host — nothing is started for it. */
	async liveTerminals(key: TaskKey, waitMs = 1000): Promise<TerminalInfo[] | null> {
		// A busy host does not hold the surface write: without an answer in time the folders stay as last written.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), waitMs);
		});
		const list = (async () => {
			const client = await this.attach(key).catch(() => null);
			if (!client) return null;
			const all = await client.terminal({ kind: 'list' }).catch(() => null);
			return Array.isArray(all) ? (all as TerminalInfo[]) : null;
		})();
		try {
			return await Promise.race([list, late]);
		} finally {
			clearTimeout(timer);
		}
	}
	/**
	 * The renderer went away (reload, closed window): nothing of it is mounted, so no host keeps sending that output — except
	 * what `keep` says another client (a phone, a device) still shows (spec/remote-access-and-mobile#outbox).
	 */
	unwatchAll(keep: (task: string, id: string) => boolean = () => false) {
		for (const [task, ids] of this.watching) {
			const client = this.clients.get(task);
			for (const id of [...ids]) {
				if (keep(task, id)) continue;
				ids.delete(id);
				void client?.terminal({ kind: 'unwatch', id }).catch(() => {});
			}
			if (!ids.size) this.watching.delete(task);
		}
	}
	private async launch(
		key: TaskKey,
		consoleOnly = false,
		allowScopeConflict = false
	): Promise<SessionSnapshot> {
		const connected = await this.attach(key);
		if (connected) return connected.snapshot();
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		const journal = await store.journal(key);
		if (journal.issue) throw new Error(journal.issue);
		const dir = await store.taskDir(key);
		await reclaimAbsentOwner(store, key, join(this.services, 'process-owner'));
		const configPath = await safePath(dir, 'host-config.json');
		await atomicJson(configPath, {
			schemaVersion: 1,
			consoleOnly,
			allowScopeConflict,
			dataDir: store.root,
			key,
			mcpEntry: join(this.services, 'mcp-relay'),
			runtime: process.execPath,
			...(process.env.BRIGADIR_TEST_AGENT
				? { adapter: { command: process.execPath, args: [process.env.BRIGADIR_TEST_AGENT] } }
				: {}),
		});
		const log = await open(await safePath(dir, 'host.log'), 'a', 0o600);
		const child = spawn(process.execPath, [join(this.services, 'host.cjs'), configPath], {
			detached: true,
			stdio: ['ignore', log.fd, log.fd],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});
		await log.close();
		child.unref();
		let failure: Error | null = null;
		child.once('error', (e) => {
			failure = e;
		});
		const end = Date.now() + 90_000;
		while (Date.now() < end) {
			if (failure) throw failure;
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error('Host stopped during startup. See host.log.');
			const client = await this.attach(key);
			if (client) {
				if (consoleOnly) return client.snapshot();
				// Poll the small status; the full snapshot crosses the socket once, when the agent has started.
				const status = await client.status();
				// The start is journaled while the transport is still coming up; commands are accepted once the host says connected.
				if (status.connected && (status.started ?? 0) > journal.records.length)
					return client.snapshot();
				if ((status.failed ?? 0) > journal.records.length)
					throw new Error('Agent startup failed. See the conversation.');
			}
			await delay(100);
		}
		throw new Error('Host startup timed out');
	}
	async command(key: TaskKey, command: SessionCommand) {
		const client = await this.attach(key);
		if (client) return client.command(command);
		if (
			command.kind !== 'checkpoint' &&
			command.kind !== 'setScope' &&
			command.kind !== 'addScope' &&
			command.kind !== 'recordPullRequest' &&
			command.kind !== 'quickAsk'
		)
			throw new Error('Host is not connected');
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		await reclaimAbsentOwner(store, key, join(this.services, 'process-owner'));
		const release = await acquireOwner(store, key, join(this.services, 'process-owner'));
		try {
			const writer = await store.writer(key);
			try {
				const snapshots = await Snapshots.open(store, key),
					journal = await store.journal(key);
				if (journal.issue) throw new Error(journal.issue);
				if (
					journal.records.findLast((record) =>
						['turn.started', 'turn.completed', 'host.stopped', 'session.failed'].includes(
							record.event.kind
						)
					)?.event.kind === 'turn.started'
				)
					await writer.append({ kind: 'host.stopped', reason: 'recovered_before_refresh' });
				if (command.kind === 'recordPullRequest') {
					if (!snapshots.current.scopes.some((scope) => scope.id === command.scopeId))
						throw new Error('Repo is unavailable');
					const current = await store.task(key);
					if (samePullRequest(current.pullRequests?.[command.scopeId], command.pr)) return;
					await writer.append({
						kind: 'pull-request.changed',
						scopeId: command.scopeId,
						pr: command.pr,
					});
					await store.updateTask(key, {
						pullRequests: { ...current.pullRequests, [command.scopeId]: command.pr },
					});
					this.publish(key, null);
					return;
				}
				const revision = snapshots.scopeRevision,
					point =
						command.kind === 'setScope'
							? await snapshots.setScope(command.update)
							: command.kind === 'addScope'
								? await snapshots.addScope(command.choice)
								: await snapshots.capture(
										command.kind === 'quickAsk' ? `quick-${command.phase}` : 'refresh'
									);
				if (revision !== snapshots.scopeRevision) await writer.append({ kind: 'scopes.changed' });
				if (
					point &&
					!journal.records.some(
						(record) =>
							record.event.kind === 'checkpoint.created' && record.event.checkpoint === point.id
					)
				)
					await writer.append({ kind: 'checkpoint.created', checkpoint: point.id });
				if (
					command.kind === 'quickAsk' &&
					command.phase === 'after' &&
					point &&
					point.id > command.before
				)
					await writer.append({
						kind: 'quick-ask.changed',
						question: command.question,
						files: command.files,
						before: command.before,
						after: point.id,
					});
				this.publish(key, null);
			} finally {
				await writer.close();
			}
		} finally {
			await release();
		}
	}
	/** spec/agents-and-providers#sign-in-recovery: after a sign-in every live host of this agent starts its failed turn again; a host whose last failure was not the sign-in ignores it. */
	async retryAfterSignIn(provider: 'claude' | 'codex') {
		const store = await SessionStore.at(this.dataDir);
		await Promise.all(
			[...this.clients.entries()].map(async ([id, client]) => {
				const [projectId, taskId] = id.split('/') as [string, string];
				try {
					const task = await store.task({ projectId, id: taskId });
					if (task.provider === provider && task.failure === 'auth')
						await client.command({ kind: 'retryTurn', reason: 'auth' });
				} catch {
					/* the task may be gone or busy */
				}
			})
		);
	}
	/** spec/chat-turns-plans-and-questions#background-commands: the tail of a background command's output, read by its host; no host — nothing runs, nothing to read. */
	async backgroundOutput(key: TaskKey, id: string): Promise<{ text: string; missing: boolean }> {
		const client = await this.attach(key);
		if (!client) return { text: '', missing: true };
		return client.backgroundOutput(id);
	}
	async revertFile(key: TaskKey, fileId: string, range?: ChangeView) {
		const client = await this.attach(key);
		if (client) return client.revertFile(fileId, range);
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		await reclaimAbsentOwner(store, key, join(this.services, 'process-owner'));
		const release = await acquireOwner(store, key, join(this.services, 'process-owner'));
		try {
			const writer = await store.writer(key);
			try {
				const snapshots = await Snapshots.open(store, key);
				await revertTaskFile(store, key, snapshots, fileId, range, async (event) => {
					await writer.append(event);
				});
				this.publish(key, null);
			} finally {
				await writer.close();
			}
		} finally {
			await release();
		}
	}
	async saveFile(key: TaskKey, request: SaveFileRequest): Promise<SaveFileResult> {
		const client = await this.attach(key);
		if (client) return client.saveFile(request);
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		await reclaimAbsentOwner(store, key, join(this.services, 'process-owner'));
		const release = await acquireOwner(store, key, join(this.services, 'process-owner'));
		try {
			const writer = await store.writer(key);
			try {
				const snapshots = await Snapshots.open(store, key);
				const result = await saveTaskFile(store, key, snapshots, request, async (event) => {
					await writer.append(event);
				});
				this.publish(key, null);
				return result;
			} finally {
				await writer.close();
			}
		} finally {
			await release();
		}
	}
	async controlHost(key: TaskKey, instance: string, action: 'stop' | 'terminate') {
		const client = await this.attach(key);
		if (!client || client.instance !== instance) throw new Error('The agent process changed');
		if (action === 'stop') {
			const task = await (await SessionStore.at(this.dataDir)).task(key);
			if (task.transport !== 'terminal') await client.command({ kind: 'pausePromptQueue' });
			await client.command({ kind: 'cancel' });
			return;
		}
		await client.command({ kind: 'shutdown' });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.closed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('The agent did not stop')), 15000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	async stopForRemoval(key: TaskKey) {
		await this.starts.get(name(key));
		const client = await this.attach(key);
		if (client) {
			await client.command({ kind: 'shutdown' });
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					client.closed,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('Host did not stop; task was not removed')),
							15000
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
			this.clients.delete(name(key));
		}
		const store = await SessionStore.at(this.dataDir),
			lock = await safePath(await store.taskDir(key), 'host.lock');
		// Peers close before the journal and owner lock; wait for full host teardown.
		const until = Date.now() + 10000;
		while (true) {
			try {
				await access(lock);
			} catch (error) {
				if (isRecord(error) && error.code === 'ENOENT') break;
				throw error;
			}
			try {
				await reclaimAbsentOwner(store, key, join(this.services, 'process-owner'));
				break;
			} catch (error) {
				if (Date.now() >= until) throw error;
			}
			await delay(50);
		}
	}
	closeConsoles() {
		if (this.consoleClose) return this.consoleClose;
		this.consolesClosing = true;
		this.consoleEpoch++;
		const pending = (async () => {
			await Promise.allSettled([...this.consoleStarts]);
			await Promise.allSettled(
				[...this.clients.values()].map(async (client) => {
					const result = await client.terminal({ kind: 'close-consoles' });
					if (isRecord(result) && result.stopping === true) await client.closed;
				})
			);
		})();
		this.consoleClose = pending.finally(() => {
			this.consoleClose = null;
		});
		return this.consoleClose;
	}
	disconnect() {
		for (const client of this.clients.values()) client.close();
		this.clients.clear();
	}
}
