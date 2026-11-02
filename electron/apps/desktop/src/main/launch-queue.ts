import { mkdir } from 'node:fs/promises';
import {
	isRecord,
	isTaskKey,
	type AgentTask,
	type SessionSnapshot,
	type TaskKey,
} from '@brigadir/core';
import { SessionStore, atomicJson, readDocument, safePath } from '@brigadir/persistence';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
type Deps = {
	/** `pass` is the same object for every candidate of one queue pass, so shared reads happen once per pass. */
	eligible?(
		key: TaskKey,
		interactive: boolean,
		pass?: object
	): Promise<'ready' | 'queue' | 'cancel'>;
	limit(): number | null;
	/** Tasks that currently burn an agent: `working` or `needs-you`, plus starts not yet visible in status. */
	active(): Promise<TaskKey[]>;
	configure?(key: TaskKey, options: NonNullable<AgentTask['launchOptions']>): Promise<void>;
	start(key: TaskKey): Promise<SessionSnapshot>;
	sendPrompt(key: TaskKey, text: string): Promise<unknown>;
	task(key: TaskKey): Promise<AgentTask>;
	hasTurns(key: TaskKey): Promise<boolean>;
	setStatus(key: TaskKey, status: AgentTask['status']): Promise<void>;
	snapshot(key: TaskKey): Promise<SessionSnapshot>;
	changed(key: TaskKey): void;
	dequeued?(key: TaskKey): Promise<void>;
};
/**
 * spec/tasks#launch-sheet task queue: starts beyond the concurrency limit wait here as `queued`. The
 * queue is durable (launch-queue.json) so a restart resumes it, and a 3 s observer
 * runs only while someone waits, because slots free up without any action of ours.
 */
export class LaunchQueue {
	private pending = 0;
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.operations;
	}
	private operations: Promise<unknown> = Promise.resolve();
	private inFlight = new Map<string, Promise<SessionSnapshot>>();
	private serial<T>(action: () => Promise<T>): Promise<T> {
		this.pending++;
		const next = this.operations.then(action).finally(() => {
			this.pending--;
		});
		this.operations = next.catch(() => {});
		return next;
	}
	private waiting: TaskKey[] = [];
	private starting = new Map<string, { key: TaskKey; until: number }>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private writes = Promise.resolve();
	constructor(
		private dataDir: string | undefined,
		private deps: Deps,
		private observeEvery = 3000
	) {}
	get keys() {
		return [...this.waiting];
	}
	isQueued(key: TaskKey) {
		return this.waiting.some((item) => name(item) === name(key));
	}
	async restore() {
		try {
			const store = await SessionStore.at(this.dataDir);
			const doc = await readDocument(await safePath(store.root, 'launch-queue.json'));
			if (!Array.isArray(doc.queue)) return;
			for (const key of doc.queue) {
				if (!isTaskKey(key) || this.isQueued(key)) continue;
				try {
					if ((await this.deps.task(key)).status === 'queued') this.waiting.push(key);
				} catch {}
			}
		} catch (error) {
			if (!(isRecord(error) && error.code === 'ENOENT')) return;
		} finally {
			if (this.waiting.length) {
				this.watch();
				void this.kick();
			}
		}
	}
	/** Start now when a slot is free; otherwise persist the task as queued and return its journal. */
	request(input: TaskKey): Promise<SessionSnapshot> {
		const id = name(input),
			pending = this.inFlight.get(id);
		if (pending) return pending;
		const result = this.serial(() => this.requestNow(input)).finally(() =>
			this.inFlight.delete(id)
		);
		this.inFlight.set(id, result);
		return result;
	}
	private async requestNow(input: TaskKey): Promise<SessionSnapshot> {
		const key: TaskKey = { projectId: input.projectId, id: input.id }; // callers may pass a whole task; persist only its identity
		// spec/tasks#archive: an archived task is read-only until Restore.
		if ((await this.deps.task(key)).archived) throw new Error('The task is in the archive');
		if (this.isQueued(key)) return { ...(await this.deps.snapshot(key)), queued: true };
		const eligibility = (await this.deps.eligible?.(key, true)) ?? 'ready';
		if (eligibility === 'cancel') {
			const task = await this.deps.task(key);
			if (task.status === 'queued') await this.deps.setStatus(key, 'interrupted');
			this.deps.changed(key);
			return this.deps.snapshot(key);
		}
		// spec/terminal-and-cli-agents#cli-start: an immediate start tells the window too. A CLI panel listed its terminals before the agent's PTY existed.
		if (eligibility === 'ready' && (await this.hasSlot())) {
			try {
				return await this.launch(key);
			} finally {
				this.deps.changed(key);
			}
		}
		await this.deps.setStatus(key, 'queued');
		this.waiting.push(key);
		await this.persist();
		this.watch();
		this.deps.changed(key);
		return { ...(await this.deps.snapshot(key)), queued: true };
	}
	/** Stop on a queued task leaves the queue without starting anything. */
	dequeue(key: TaskKey) {
		return this.serial(() => this.dequeueNow(key));
	}
	private async dequeueNow(key: TaskKey) {
		if (!this.isQueued(key)) return false;
		this.waiting = this.waiting.filter((item) => name(item) !== name(key));
		await this.persist();
		await this.deps.setStatus(key, 'interrupted');
		await this.deps.dequeued?.(key);
		this.deps.changed(key);
		this.watch();
		return true;
	}
	/** Re-evaluate after any event that may free a slot. */
	kick() {
		return this.serial(() => this.promote()).catch(() => {});
	}
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
	private watch() {
		if (this.waiting.length) {
			if (!this.timer) {
				this.timer = setInterval(() => {
					void this.kick();
				}, this.observeEvery);
				this.timer.unref?.();
			}
		} else this.stop();
	}
	private async hasSlot() {
		const limit = this.deps.limit();
		if (limit === null) return true;
		const now = Date.now(),
			active = new Set((await this.deps.active()).map(name));
		// A start counts until its status is visible: still `queued` means the first turn has not landed yet.
		for (const [id, entry] of this.starting) {
			if (entry.until < now || active.has(id)) {
				this.starting.delete(id);
				continue;
			}
			let status: AgentTask['status'] | null = null;
			try {
				status = (await this.deps.task(entry.key)).status;
			} catch {}
			if (status === 'queued') active.add(id);
			else this.starting.delete(id);
		}
		return active.size < limit;
	}
	private async promote() {
		while (this.waiting.length && (await this.hasSlot())) {
			let key: TaskKey | undefined;
			const pass = {};
			for (const candidate of this.waiting) {
				try {
					if (((await this.deps.eligible?.(candidate, false, pass)) ?? 'ready') === 'ready') {
						key = candidate;
						break;
					}
				} catch {
					/* A failed lock read must not start an agent. */
				}
			}
			if (!key) break;
			this.waiting = this.waiting.filter((item) => name(item) !== name(key!));
			await this.persist();
			try {
				await this.launch(key);
			} catch {
				/* launch preserves the precise preparation/agent failure status. */
			}
			this.deps.changed(key);
		}
		this.watch();
	}
	private async launch(key: TaskKey) {
		this.starting.set(name(key), { key, until: Date.now() + 15000 });
		try {
			const before = await this.deps.task(key);
			if (before.status === 'backlog') await this.deps.setStatus(key, 'queued');
			const snapshot = await this.deps.start(key);
			// One launch path (spec/projects-and-board#project-screen rule 6): the stored prompt is the first turn of a GUI task that has none yet.
			const task = await this.deps.task(key);
			if (task.launchOptions?.length) await this.deps.configure?.(key, task.launchOptions);
			const send =
				task.transport !== 'terminal' &&
				(task.prompt?.trim() || task.continuesTaskId || task.attachments?.length) &&
				!(await this.hasTurnsIn(snapshot, key));
			if (send) await this.deps.sendPrompt(key, task.prompt ?? '');
			// spec/tasks#lock-registry: `queued` means waiting for a slot or a lock. A GUI start that sent no first prompt waits for nothing; the host is up and the person writes next.
			if (
				(before.status === 'backlog' || (!send && task.transport !== 'terminal')) &&
				(await this.deps.task(key)).status === 'queued'
			)
				await this.deps.setStatus(key, 'done');
			return snapshot;
		} catch (error) {
			this.starting.delete(name(key));
			const status = await this.deps.task(key).then(
				(task) => task.status,
				() => null
			);
			if (status === 'queued' || status === 'backlog')
				await this.deps.setStatus(key, 'interrupted').catch(() => {});
			throw error;
		} finally {
			setTimeout(() => {
				this.starting.delete(name(key));
			}, 15000).unref?.();
		}
	}
	private async hasTurnsIn(snapshot: SessionSnapshot, key: TaskKey) {
		return (
			snapshot.records.some((record) => record.event.kind === 'turn.started') ||
			(await this.deps.hasTurns(key))
		);
	}
	private persist() {
		const queue = [...this.waiting];
		const write = this.writes.then(async () => {
			const store = await SessionStore.at(this.dataDir);
			await mkdir(store.root, { recursive: true, mode: 0o700 });
			await atomicJson(await safePath(store.root, 'launch-queue.json'), {
				schemaVersion: 1,
				queue,
			});
		});
		this.writes = write.catch(() => {});
		return write;
	}
}
