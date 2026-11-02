import { journalTail } from './journal-tail';
import { taskActivity } from '@brigadir/core';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isRecord,
	type AgentTask,
	type LiveAgent,
	type LiveAgentRef,
	type LiveAgentsSnapshot,
} from '@brigadir/core';
import {
	SessionStore,
	readWorkspace,
	readDocument,
	safePath,
	ProcessCoordinator,
} from '@brigadir/persistence';
import type { Sessions } from './sessions';
/** Observe owners without attaching to their sockets or reading complete journals. */
export class LiveAgents {
	private pending: Promise<LiveAgentsSnapshot> | null = null;
	private actions = new Map<string, Promise<void>>();
	private processes: ProcessCoordinator;
	private identities = new Map<number, { start: string | null; at: number }>();
	/** Scans reuse a host's kernel start identity for a minute while its pid exists (BG-12): the helper runs once per host, not once
	 *  per scan and host. A vanished pid answers at once without the helper. Process controls always ask the kernel. */
	private async identity(pid: number, fresh: boolean) {
		if (!fresh) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (isRecord(error) && error.code === 'ESRCH') {
					this.identities.delete(pid);
					return null;
				}
			}
			const cached = this.identities.get(pid);
			if (cached && Date.now() - cached.at < 60_000) return cached.start;
		}
		const start = await this.processes.identity(pid);
		if (this.identities.size >= 256) this.identities.clear();
		this.identities.set(pid, { start, at: Date.now() });
		return start;
	}
	constructor(
		private dataDir: string | undefined,
		services: string,
		private sessions: Pick<Sessions, 'controlHost'>
	) {
		this.processes = new ProcessCoordinator(join(services, 'process-owner'));
	}
	get isSaving() {
		return this.actions.size > 0;
	}
	async waitForWrites() {
		await Promise.allSettled([...this.actions.values()]);
	}
	private async owner(store: SessionStore, task: AgentTask, fresh = false) {
		const dir = await store.taskDir(task);
		let host, owner;
		try {
			const hostPath = await safePath(dir, 'host.json'),
				ownerPath = await safePath(dir, 'host.lock');
			const stats = await Promise.all([lstat(hostPath), lstat(ownerPath)]);
			if (stats.some((stat) => !stat.isFile())) throw new Error('Invalid host metadata');
			[host, owner] = await Promise.all([
				readDocument(hostPath, 65536),
				readDocument(ownerPath, 4096),
			]);
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
		if (
			host.protocolVersion !== 1 ||
			!isRecord(host.key) ||
			host.key.projectId !== task.projectId ||
			host.key.id !== task.id ||
			typeof host.instance !== 'string' ||
			!/^[a-f0-9-]{36}$/.test(host.instance) ||
			!Number.isSafeInteger(host.pid) ||
			Number(host.pid) <= 0 ||
			typeof host.startedAt !== 'string' ||
			!Number.isFinite(Date.parse(host.startedAt)) ||
			owner.pid !== host.pid ||
			typeof owner.processStart !== 'string' ||
			!/^[-a-f0-9:]{3,100}$/.test(owner.processStart)
		)
			throw new Error('Invalid host owner');
		if ((await this.identity(Number(host.pid), fresh)) !== owner.processStart) return null;
		return { instance: host.instance, startedAt: host.startedAt };
	}
	private async activity(
		store: SessionStore,
		task: AgentTask
	): Promise<Pick<LiveAgent, 'activity' | 'attention'>> {
		const activity = taskActivity(await journalTail(store, task));
		return {
			activity: activity
				? [activity.title, activity.path].filter(Boolean).join(' · ').slice(0, 240)
				: null,
			attention:
				task.status === 'needs-you' && activity?.kind !== 'tool'
					? activity?.kind === 'plan'
						? 'permission'
						: activity?.kind === 'proposal'
							? 'question'
							: (activity?.kind ?? null)
					: null,
		};
	}

	read() {
		if (this.pending) return this.pending;
		const work = this.scan().finally(() => {
			if (this.pending === work) this.pending = null;
		});
		this.pending = work;
		return work;
	}
	private async scan(): Promise<LiveAgentsSnapshot> {
		const store = await SessionStore.at(this.dataDir),
			workspace = await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {}),
			result: LiveAgentsSnapshot = { agents: [], issues: workspace.issues.length };
		let index = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, workspace.tasks.length) }, async () => {
				while (index < workspace.tasks.length) {
					const task = workspace.tasks[index++]!;
					try {
						const owner = await this.owner(store, task);
						if (!owner) continue;
						const project = workspace.projects.find((item) => item.id === task.projectId)!;
						result.agents.push({
							key: { projectId: task.projectId, id: task.id },
							...owner,
							projectName: project.name,
							title: task.title,
							provider: task.provider,
							status: task.status,
							...(await this.activity(store, task)),
						});
					} catch {
						result.issues++;
					}
				}
			})
		);
		result.agents.sort(
			(a, b) =>
				a.projectName.localeCompare(b.projectName) ||
				a.startedAt.localeCompare(b.startedAt) ||
				a.key.id.localeCompare(b.key.id)
		);
		return result;
	}
	control(ref: LiveAgentRef, action: 'stop' | 'terminate') {
		const id = `${ref.key.projectId}/${ref.key.id}/${ref.instance}`;
		if (this.actions.has(id)) throw new Error('Agent action is in progress');
		const work = (async () => {
			const store = await SessionStore.at(this.dataDir),
				task = await store.task(ref.key),
				owner = await this.owner(store, task, true);
			if (!owner || owner.instance !== ref.instance) throw new Error('The agent process changed');
			await this.sessions.controlHost(ref.key, ref.instance, action);
		})().finally(() => this.actions.delete(id));
		this.actions.set(id, work);
		return work;
	}
}
