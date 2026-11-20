import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
	isRecord,
	turnWindows,
	worktreeVerdict,
	type EventRecord,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath, type SessionStore } from '@brigadir/persistence';
import { branchExists, worktreeEntries, type WorktreeEntry } from '@brigadir/git';

/** spec/tasks#agent-worktrees: what the host judged, so a restart judges nothing twice and knows what joined. */
export type AgentWorktreeDocument = {
	schemaVersion: 1;
	/** Worktrees judged for good: joined, left alone or denied on the card. */
	judged: string[];
	joined: { scopeId: string; path: string; repo: string; branch?: string; gone?: true }[];
};
export const agentWorktreeFile = 'agent-worktrees.json';
export type FoundWorktree = WorktreeEntry & {
	/** The repo of the task whose `git worktree list` showed it. */
	repo: string;
};
export type AgentWorktreeDeps = {
	store: SessionStore;
	key: TaskKey;
	/** Canonical paths. */
	projectPath: string;
	dataRoot: string;
	records(): readonly EventRecord[];
	/** The writable git repos of the task. */
	repos(): readonly string[];
	/** True when the path is one of the task's repos now (selected and available). */
	inTask(path: string): boolean;
	/** The folder joins the task as `add_folder` does; the scope id, or null when it could not join now (no window, a lock). */
	join(found: FoundWorktree, by: 'agent' | 'person'): Promise<string | null>;
	/** A joined worktree whose folder is gone leaves the task. */
	leave(scopeId: string): Promise<void>;
	/** The card; true — allowed, false — denied, null — not answered (the host stopped). */
	ask(found: FoundWorktree): Promise<boolean | null>;
	emit(event: SessionEvent): Promise<void>;
	now?(): number;
};
async function readState(store: SessionStore, key: TaskKey): Promise<AgentWorktreeDocument> {
	try {
		const doc = await readDocument(await safePath(await store.taskDir(key), agentWorktreeFile));
		if (Array.isArray(doc.judged) && Array.isArray(doc.joined))
			return {
				schemaVersion: 1,
				judged: doc.judged.filter((item): item is string => typeof item === 'string'),
				joined: doc.joined.filter(
					(item): item is AgentWorktreeDocument['joined'][number] =>
						isRecord(item) &&
						typeof item.scopeId === 'string' &&
						typeof item.path === 'string' &&
						typeof item.repo === 'string'
				),
			};
	} catch {
		/* none yet */
	}
	return { schemaVersion: 1, judged: [], joined: [] };
}
/** spec/tasks#agent-worktrees: whether another task of the data folder holds `path` as a folder of its own. */
export async function heldByOtherTask(store: SessionStore, key: TaskKey, path: string) {
	const projects = join(store.root, 'projects');
	for (const projectId of await readdir(projects).catch(() => [] as string[]))
		for (const id of await readdir(join(projects, projectId, 'tasks')).catch(
			() => [] as string[]
		)) {
			if (projectId === key.projectId && id === key.id) continue;
			try {
				const task = await readDocument(join(projects, projectId, 'tasks', id, 'task.json'));
				const launch = isRecord(task.launch) ? task.launch : null;
				if (
					Array.isArray(launch?.scopes) &&
					launch.scopes.some((scope) => isRecord(scope) && scope.path === path)
				)
					return true;
			} catch {
				/* not a task */
			}
		}
	return false;
}
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
/**
 * spec/tasks#agent-worktrees: the host's look at the worktrees of the task's repos — after a tool that names `worktree`, at every turn's end and
 * at the host's start. Looks run one after another; a card does not hold the next look.
 */
export class AgentWorktrees {
	private tail: Promise<void> = Promise.resolve();
	private asking = new Set<string>();
	constructor(private deps: AgentWorktreeDeps) {}
	look(): Promise<void> {
		this.tail = this.tail.then(
			() => this.lookNow(),
			() => this.lookNow()
		);
		return this.tail;
	}
	private async save(doc: AgentWorktreeDocument) {
		await atomicJson(
			await safePath(await this.deps.store.taskDir(this.deps.key), agentWorktreeFile),
			doc
		);
	}
	private async lookNow() {
		const deps = this.deps;
		const doc = await readState(deps.store, deps.key);
		const found = new Map<string, FoundWorktree>();
		for (const repo of new Set(deps.repos()))
			for (const entry of await worktreeEntries(repo))
				if (!found.has(entry.path)) found.set(entry.path, { ...entry, repo });
		let changed = false;
		// A joined worktree whose folder went away: removed by the agent, or gone while the host was down.
		for (const item of doc.joined) {
			if (item.gone) continue;
			const entry = found.get(item.path);
			const there = await stat(item.path).then(
				(info) => info.isDirectory(),
				() => false
			);
			if (there && !entry?.missing) continue;
			item.gone = true;
			changed = true;
			await deps.emit({
				kind: 'worktree.removed',
				scopeId: item.scopeId,
				name: basename(item.path),
				path: item.path,
				...(item.branch ? { branch: item.branch } : {}),
				branchKept: item.branch ? await branchExists(item.repo, item.branch) : false,
			});
			await deps.leave(item.scopeId).catch(() => {});
		}
		const judged = new Set(doc.judged);
		for (const entry of found.values()) {
			if (entry.missing || judged.has(entry.path) || this.asking.has(entry.path)) continue;
			if (deps.inTask(entry.path)) {
				judged.add(entry.path);
				changed = true;
				continue;
			}
			const verdict = worktreeVerdict({
				path: entry.path,
				branch: entry.branch,
				createdAt: entry.createdAt,
				precision: entry.precision,
				turns: turnWindows(deps.records()),
				brigadir: under(entry.path, join(deps.dataRoot, 'worktrees')),
				insideProject: under(entry.path, deps.projectPath),
				otherTask: await heldByOtherTask(deps.store, deps.key, entry.path),
				now: deps.now?.() ?? Date.now(),
			});
			if (verdict === 'ignore') {
				judged.add(entry.path);
				changed = true;
			} else if (verdict === 'join') {
				const scopeId = await deps.join(entry, 'agent');
				if (!scopeId) continue;
				judged.add(entry.path);
				doc.joined.push(this.joinedItem(scopeId, entry));
				changed = true;
			} else this.ask(entry);
		}
		if (changed) await this.save({ ...doc, judged: [...judged] });
	}
	private joinedItem(scopeId: string, entry: FoundWorktree) {
		return {
			scopeId,
			path: entry.path,
			repo: entry.repo,
			...(entry.branch ? { branch: entry.branch } : {}),
		};
	}
	/** The card waits beside the looks; its answer is written in the order of the looks. */
	private ask(entry: FoundWorktree) {
		this.asking.add(entry.path);
		void this.deps
			.ask(entry)
			.then((answer) => {
				if (answer === null) return;
				this.tail = this.tail
					.catch(() => {})
					.then(async () => {
						const doc = await readState(this.deps.store, this.deps.key);
						const scopeId =
							answer && !this.deps.inTask(entry.path)
								? await this.deps.join(entry, 'person')
								: null;
						if (answer && !scopeId && !this.deps.inTask(entry.path)) return;
						await this.save({
							...doc,
							judged: [...new Set([...doc.judged, entry.path])],
							joined: scopeId ? [...doc.joined, this.joinedItem(scopeId, entry)] : doc.joined,
						});
					});
				return this.tail;
			})
			.catch((error: unknown) => {
				process.stderr.write(
					`[host] worktree card failed: ${error instanceof Error ? error.message : String(error)}\n`
				);
			})
			.finally(() => this.asking.delete(entry.path));
	}
}
