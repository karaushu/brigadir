import { promptDisplayText } from '@brigadir/core';
import { constants } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	realpath,
	rm,
	stat,
	unlink,
} from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	MAIN_TREE_ID,
	withAutoBranch,
	isSessionEvent,
	isRecord,
	isTaskKey,
	isProject,
	isProjectCommands,
	isProjectSimulator,
	isProjectIcon,
	isProjectIconPick,
	type ProjectIcon,
	type ProjectIconPick,
	isAgentTask,
	type ProjectCommand,
	type ProjectSimulator,
	type TaskLaunch,
	type AgentTask,
	type EventRecord,
	type Project,
	type ProjectFormatter,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import { ReadFailure, resolveDataRoot } from './index';
export async function safePath(root: string, ...parts: string[]): Promise<string> {
	const path = join(root, ...parts);
	const rel = relative(root, path);
	if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
		throw new ReadFailure('unsafe_path');
	let current = root;
	for (const part of rel.split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new ReadFailure('unsafe_path');
		} catch (e) {
			if (!(isRecord(e) && e.code === 'ENOENT')) throw e;
		}
	}
	return path;
}
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (isRecord(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, sorted(value[k])])
		);
	return value;
}
/** The text atomicJson writes: sorted keys, 2-space indent, trailing newline. Serialize once and check the size. */
export function jsonText(value: unknown): string {
	return `${JSON.stringify(sorted(value), null, 2)}\n`;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
	await atomicText(path, jsonText(value));
}
export async function atomicText(path: string, text: string | Uint8Array): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	const file = await open(temp, 'wx', 0o600);
	try {
		await file.writeFile(text);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temp, path);
		const dir = await open(dirname(path), 'r');
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
	} finally {
		await unlink(temp).catch(() => {});
	}
}
export async function readDocument(
	path: string,
	maxBytes = 1024 * 1024
): Promise<Record<string, unknown>> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if ((await file.stat()).size > maxBytes) throw new ReadFailure('invalid_document');
		const value: unknown = JSON.parse(await file.readFile('utf8'));
		if (!isRecord(value) || !Number.isInteger(value.schemaVersion))
			throw new ReadFailure('invalid_document');
		if (value.schemaVersion !== 1) throw new ReadFailure('unsupported_schema');
		return value;
	} finally {
		await file.close();
	}
}
/** One read-modify-write of a task.json at a time in this process: a status write that read the file before a launch
 *  write must not put the old launch back (spec/tasks#agent-worktrees: the host adopts a folder while the turn ends). */
const taskWrites = new Map<string, Promise<unknown>>();
function serialTask<T>(path: string, work: () => Promise<T>): Promise<T> {
	const result = (taskWrites.get(path) ?? Promise.resolve()).then(work, work),
		tail = result.catch(() => {});
	taskWrites.set(path, tail);
	void tail.then(() => {
		if (taskWrites.get(path) === tail) taskWrites.delete(path);
	});
	return result;
}
/** Records a crash may lose for up to `groupSyncMs`: streamed text, tool progress and usage (spec/architecture-and-platform#journal). */
const streamedKinds: ReadonlySet<string> = new Set([
	'message.delta',
	'tool.changed',
	'usage.changed',
]);
const groupSyncMs = 50;
export class SessionStore {
	private constructor(readonly root: string) {}
	static async at(dataDir?: string) {
		return new SessionStore(await resolveDataRoot(dataDir));
	}
	async taskDir(key: TaskKey) {
		if (!isTaskKey(key)) throw new ReadFailure('unsafe_path');
		return safePath(this.root, 'projects', key.projectId, 'tasks', key.id);
	}
	/** spec/tasks#backlog-edit: the attachments of a launch sheet whose task does not exist yet. */
	async draftDir(key: TaskKey) {
		if (!isTaskKey(key)) throw new ReadFailure('unsafe_path');
		return safePath(this.root, 'drafts', key.projectId, key.id);
	}
	/** spec/tasks#backlog-edit: drafts are left only by a sheet that never closed (a crash); the next start drops them. */
	async clearDrafts() {
		await rm(await safePath(this.root, 'drafts'), { recursive: true, force: true });
	}
	/** spec/pull-requests-and-ci#review-drafts: a PR's review drafts and summary belong to the project, one file per PR; every task and the main tree share it. */
	async pullRequestFile(
		projectId: string,
		kind: 'review' | 'summary',
		scopeId: string,
		number: number
	) {
		if (!isTaskKey({ projectId, id: 'check' }) || !Number.isSafeInteger(number) || number <= 0)
			throw new ReadFailure('unsafe_path');
		const dir = await safePath(this.root, 'projects', projectId, 'pull-requests');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return safePath(dir, `${kind}-${scopeId.replace(/[^\w.-]/g, '_')}-${number}.json`);
	}
	/**
	 * spec/pull-requests-and-ci#review-drafts: the PR's document. Until the project file exists, the per-task files it had before are read instead:
	 * review drafts are joined without duplicates, the rest comes from the newest file. Reading never writes.
	 */
	async readPullRequestDocument(
		projectId: string,
		kind: 'review' | 'summary',
		scopeId: string,
		number: number
	): Promise<Record<string, unknown> | null> {
		const path = await this.pullRequestFile(projectId, kind, scopeId, number);
		try {
			const doc = await readDocument(path);
			return isRecord(doc[kind]) ? doc[kind] : null;
		} catch (e) {
			if (!(isRecord(e) && e.code === 'ENOENT')) return null;
		}
		const tasks = await safePath(this.root, 'projects', projectId, 'tasks'),
			name = `pr-${kind}-${scopeId.replace(/[^\w.-]/g, '_')}-${number}.json`;
		const found: { at: number; value: Record<string, unknown> }[] = [];
		for (const id of await readdir(tasks).catch(() => [] as string[])) {
			if (!isTaskKey({ projectId, id })) continue;
			try {
				const file = await safePath(tasks, id, name),
					doc = await readDocument(file),
					value = doc[kind];
				if (isRecord(value)) found.push({ at: (await stat(file)).mtimeMs, value });
			} catch {
				/* none in this task */
			}
		}
		if (!found.length) return null;
		found.sort((a, b) => a.at - b.at);
		const newest = found.at(-1)!.value;
		if (kind === 'summary') return newest;
		const drafts = new Map<string, Record<string, unknown>>();
		for (const { value } of found)
			for (const draft of Array.isArray(value.drafts) ? value.drafts : [])
				if (isRecord(draft) && typeof draft.id === 'string' && !drafts.has(draft.id))
					drafts.set(draft.id, draft);
		return {
			...newest,
			drafts: [...drafts.values()].sort((a, b) =>
				String(a.createdAt).localeCompare(String(b.createdAt))
			),
		};
	}
	async project(id: string): Promise<Project> {
		if (!isTaskKey({ projectId: id, id: 'check' })) throw new ReadFailure('unsafe_path');
		const doc = await readDocument(await safePath(this.root, 'projects', id, 'project.json'));
		if (!isProject(doc.project) || doc.project.id !== id) throw new ReadFailure('invalid_document');
		return doc.project;
	}
	/** spec/tasks#released-worktree: the path a worktree had once «Remove worktree…» (or the archive) took it away: `worktree-released.json` is
	 *  there and `worktree.json` is not. Null for every other task, including one whose worktree is still being prepared. */
	async releasedWorktree(key: TaskKey): Promise<string | null> {
		const task = await this.task(key);
		if (task.launch?.isolation !== 'worktree') return null;
		const dir = await this.taskDir(key),
			has = async (name: string) => {
				try {
					await lstat(await safePath(dir, name));
					return true;
				} catch (e) {
					if (isRecord(e) && e.code === 'ENOENT') return false;
					throw e;
				}
			};
		return (await has('worktree-released.json')) && !(await has('worktree.json'))
			? safePath(this.root, 'worktrees', key.projectId, key.id)
			: null;
	}
	/** spec/tasks#released-worktree: where the task's files live for a reader. Released worktree: its former path (`released`), which is
	 *  gone, so file access has nothing to read; every other task: `projectForTask`'s root. */
	async workspace(key: TaskKey): Promise<{ path: string; released: boolean }> {
		const released = await this.releasedWorktree(key);
		return released
			? { path: released, released: true }
			: { path: (await this.projectForTask(key)).path, released: false };
	}
	/** Task data can name isolation, but never supplies a filesystem root. */
	async projectForTask(key: TaskKey): Promise<Project> {
		const project = await this.project(key.projectId),
			task = await this.task(key);
		if (task.launch?.isolation !== 'worktree') return project;
		const path = await safePath(this.root, 'worktrees', key.projectId, key.id),
			doc = await readDocument(await safePath(await this.taskDir(key), 'worktree.json'));
		if (
			doc.root !== path ||
			doc.state !== 'ready' ||
			doc.branch !== task.launch.branch ||
			(await realpath(path)) !== path
		)
			throw new Error('The isolated workspace is not ready');
		return { ...project, path };
	}
	async task(key: TaskKey): Promise<AgentTask> {
		const doc = await readDocument(await safePath(await this.taskDir(key), 'task.json'));
		if (!isAgentTask(doc.task) || doc.task.id !== key.id || doc.task.projectId !== key.projectId)
			throw new ReadFailure('invalid_document');
		return doc.task;
	}
	async addProject(path: string): Promise<Project> {
		const actual = await realpath(path);
		if (!(await lstat(actual)).isDirectory()) throw new Error('Project must be a directory');
		const project: Project = {
			id: randomUUID(),
			name: actual.split(sep).at(-1) || actual,
			path: actual,
		};
		const dir = await safePath(this.root, 'projects', project.id);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await atomicJson(join(dir, 'project.json'), { schemaVersion: 1, project });
		return project;
	}
	/** spec/editor-code-intelligence#format-on-save: `default` drops the field, so the project follows Settings ▸ Editor again. */
	async setProjectFormatter(id: string, formatter: ProjectFormatter): Promise<Project> {
		const { formatter: _previous, ...rest } = await this.project(id);
		const project: Project = formatter === 'default' ? rest : { ...rest, formatter };
		await atomicJson(await safePath(this.root, 'projects', id, 'project.json'), {
			schemaVersion: 1,
			project,
		});
		return project;
	}
	/** spec/search-menus-and-commands#project-commands: an empty list drops the field, as `default` does for the formatter. */
	async setProjectCommands(id: string, commands: ProjectCommand[]): Promise<Project> {
		if (!isProjectCommands(commands)) throw new Error('Invalid project commands');
		const { commands: _previous, ...rest } = await this.project(id);
		const project: Project = commands.length ? { ...rest, commands } : rest;
		await atomicJson(await safePath(this.root, 'projects', id, 'project.json'), {
			schemaVersion: 1,
			project,
		});
		return project;
	}
	/** spec/search-menus-and-commands#agent-command-tools: `Always allow agents` on a permission card marks one command; the rest of project.json is kept as read. */
	async setProjectCommandAgentRuns(
		id: string,
		commandId: string,
		agentRuns: boolean
	): Promise<Project> {
		const project = await this.project(id),
			commands = project.commands ?? [];
		if (!commands.some((command) => command.id === commandId))
			throw new Error('The command is no longer saved');
		return this.setProjectCommands(
			id,
			commands.map((command) => (command.id === commandId ? { ...command, agentRuns } : command))
		);
	}
	/** spec/appearance#evolution-redesign: the icon and the agent's pick; `null` drops a field (no icon — the monogram of the name). */
	async setProjectIcon(
		id: string,
		change: { icon?: ProjectIcon | null; iconPick?: ProjectIconPick | null }
	): Promise<Project> {
		if (change.icon && !isProjectIcon(change.icon)) throw new Error('Invalid project icon');
		if (change.iconPick && !isProjectIconPick(change.iconPick))
			throw new Error('Invalid project icon pick');
		const {
			icon,
			iconPick,
			iconPicking: _picking,
			iconGenerating: _generating,
			...rest
		} = await this.project(id);
		const next = {
			icon: change.icon === undefined ? icon : change.icon,
			iconPick: change.iconPick === undefined ? iconPick : change.iconPick,
		};
		const project: Project = {
			...rest,
			...(next.icon ? { icon: next.icon } : {}),
			...(next.iconPick ? { iconPick: next.iconPick } : {}),
		};
		await atomicJson(await safePath(this.root, 'projects', id, 'project.json'), {
			schemaVersion: 1,
			project,
		});
		return project;
	}
	/** spec/browser-and-simulator#simulator: the device the project shows in the simulator column. */
	async setProjectSimulator(id: string, simulator: ProjectSimulator): Promise<Project> {
		if (!isProjectSimulator(simulator)) throw new Error('Invalid project simulator');
		const project: Project = { ...(await this.project(id)), simulator };
		await atomicJson(await safePath(this.root, 'projects', id, 'project.json'), {
			schemaVersion: 1,
			project,
		});
		return project;
	}
	async createTask(
		projectId: string,
		title: string,
		provider: 'claude' | 'codex',
		transport: 'gui' | 'terminal' = 'gui',
		emptyTitle = 'New task',
		status: 'queued' | 'backlog' = 'queued',
		launch?: TaskLaunch
	): Promise<AgentTask> {
		await this.project(projectId);
		if (title.length > 1_000_000 || !['claude', 'codex'].includes(provider))
			throw new Error('Invalid task');
		const task: AgentTask = {
			id: randomUUID(),
			projectId,
			title: promptDisplayText(title).trim().slice(0, 80) || emptyTitle,
			prompt: title,
			provider,
			transport,
			status,
		};
		if (launch) task.launch = withAutoBranch(launch, '', title, task.id);
		if (!isAgentTask(task)) throw new Error('Invalid task');
		if (Buffer.byteLength(JSON.stringify(task)) > 1_000_000)
			throw new Error('Task prompt is too large');
		const dir = await this.taskDir(task);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await atomicJson(join(dir, 'task.json'), { schemaVersion: 1, task });
		return task;
	}
	/**
	 * spec/tasks#quick-tasks: the project's main tree — a task.json with no provider or launch, status `done` (not counted as active).
	 * Scopes and snapshots work as in a task without isolation, in place; no agent starts here.
	 */
	async ensureMainTree(projectId: string): Promise<AgentTask> {
		const project = await this.project(projectId),
			key = { projectId, id: MAIN_TREE_ID };
		try {
			return await this.task(key);
		} catch {
			/* the first open writes it */
		}
		const task: AgentTask = {
			id: MAIN_TREE_ID,
			projectId,
			title: project.name,
			status: 'done',
			transport: 'gui',
		};
		if (!isAgentTask(task)) throw new Error('Invalid main tree');
		const dir = await this.taskDir(task);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await atomicJson(join(dir, 'task.json'), { schemaVersion: 1, task });
		return task;
	}
	/** Merges provider names or an edited prompt into task.json; identity and status stay as they are. */
	async updateTask(
		key: TaskKey,
		patch: Partial<
			Pick<
				AgentTask,
				| 'prReview'
				| 'readOnlyAgent'
				| 'agentRole'
				| 'changeBase'
				| 'crew'
				| 'crewTaskId'
				| 'crewNodeId'
				| 'parentTaskId'
				| 'rateLimit'
				| 'failure'
				| 'pullRequests'
				| 'relayIssue'
				| 'continuesTaskId'
				| 'originTaskId'
				| 'relaySelection'
				| 'slackThread'
				| 'title'
				| 'prompt'
				| 'provider'
				| 'transport'
				| 'modelName'
				| 'effortName'
				| 'launchOptions'
				| 'agentOptions'
				| 'hasStarted'
				| 'activitySeq'
				| 'scopeNames'
				| 'worktreeBranch'
				| 'launch'
				| 'preparation'
				| 'blockedBy'
				| 'attachments'
				| 'background'
				| 'scheduleRun'
			>
		>
	): Promise<AgentTask> {
		const path = await safePath(await this.taskDir(key), 'task.json');
		return serialTask(path, async () => {
			const doc = await readDocument(path);
			const current = await this.task(key);
			const next: AgentTask = {
				...current,
				...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
			} as AgentTask;
			if (!isAgentTask(next) || Buffer.byteLength(JSON.stringify(next)) > 1_000_000)
				throw new Error('Invalid task');
			await atomicJson(path, { ...doc, task: next });
			return next;
		});
	}
	/** Standalone worktree removal (spec/sidebar#layout): the task forgets its prepared copy. */
	async clearPreparation(key: TaskKey): Promise<void> {
		const path = await safePath(await this.taskDir(key), 'task.json');
		return serialTask(path, async () => {
			const doc = await readDocument(path);
			const { preparation, worktreeBranch, ...task } = doc.task as AgentTask;
			void preparation;
			void worktreeBranch;
			if (!isAgentTask(task)) throw new Error('Invalid task');
			await atomicJson(path, { ...doc, task });
		});
	}
	/** spec/tasks#archive: `completedAt` marks when the person completed the task; any other status drops it. */
	async setStatus(key: TaskKey, status: AgentTask['status']): Promise<void> {
		const path = await safePath(await this.taskDir(key), 'task.json');
		return serialTask(path, async () => {
			const doc = await readDocument(path);
			const current = await this.task(key);
			const { completedAt, ...rest } = doc.task as AgentTask;
			const stamp =
				status !== 'completed'
					? {}
					: current.status === 'completed' && completedAt
						? { completedAt }
						: { completedAt: new Date().toISOString() };
			await atomicJson(path, { ...doc, task: { ...rest, ...stamp, status } });
		});
	}
	/** spec/tasks#archive migration: a completed task from before `completedAt` gets the time of the first auto-archive pass. */
	async stampCompleted(key: TaskKey, at: string): Promise<void> {
		const path = await safePath(await this.taskDir(key), 'task.json');
		return serialTask(path, async () => {
			const doc = await readDocument(path),
				task = await this.task(key);
			if (task.status !== 'completed' || task.completedAt) return;
			await atomicJson(path, { ...doc, task: { ...(doc.task as AgentTask), completedAt: at } });
		});
	}
	/** spec/tasks#archive: the task goes to the archive with the status it has; the status itself does not change. */
	async archive(key: TaskKey, archived: NonNullable<AgentTask['archived']>): Promise<AgentTask> {
		const path = await safePath(await this.taskDir(key), 'task.json');
		return serialTask(path, async () => {
			const doc = await readDocument(path);
			await this.task(key);
			const next = { ...(doc.task as AgentTask), archived } as AgentTask;
			if (!isAgentTask(next)) throw new Error('Invalid task');
			await atomicJson(path, { ...doc, task: next });
			return next;
		});
	}
	/** spec/tasks#archive: Restore drops the archive mark and puts back the status the task had when archived. */
	async unarchive(key: TaskKey): Promise<AgentTask> {
		const path = await safePath(await this.taskDir(key), 'task.json');
		return serialTask(path, async () => {
			const doc = await readDocument(path);
			const current = await this.task(key);
			const { archived, ...task } = doc.task as AgentTask;
			if (!current.archived) return current;
			const next = { ...task, status: archived!.status } as AgentTask;
			if (!isAgentTask(next)) throw new Error('Invalid task');
			await atomicJson(path, { ...doc, task: next });
			return next;
		});
	}
	async journal(key: TaskKey): Promise<{ records: EventRecord[]; issue: string | null }> {
		const path = await safePath(await this.taskDir(key), 'events.jsonl');
		let contents: string;
		try {
			contents = await readFile(path, 'utf8');
		} catch (e) {
			if (isRecord(e) && e.code === 'ENOENT') return { records: [], issue: null };
			throw e;
		}
		const lines = contents.split('\n');
		const records: EventRecord[] = [];
		for (const line of lines.slice(0, -1)) {
			try {
				const v: unknown = JSON.parse(line);
				if (!isRecord(v) || !Number.isInteger(v.schemaVersion)) throw new Error('invalid_document');
				if (v.schemaVersion !== 1) throw new Error('unsupported_schema');
				if (v.seq !== records.length + 1 || typeof v.at !== 'string' || !isSessionEvent(v.event))
					throw new Error('invalid_document');
				records.push(v as EventRecord);
			} catch (e) {
				return { records, issue: e instanceof Error ? e.message : 'invalid_document' };
			}
		}
		return { records, issue: lines.at(-1) !== '' ? 'incomplete_record' : null };
	}
	async writer(key: TaskKey) {
		const journal = await this.journal(key);
		if (journal.issue) throw new Error(journal.issue);
		const file = await open(
			await safePath(await this.taskDir(key), 'events.jsonl'),
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
			0o600
		);
		let seq = journal.records.length;
		let tail: Promise<unknown> = Promise.resolve();
		// spec/architecture-and-platform#journal: streamed records reach the disk together within `groupSyncMs`; every other record still returns only
		// after an fsync that also covers the streamed ones written before it.
		let dirty = false,
			timer: ReturnType<typeof setTimeout> | undefined;
		const syncLater = () => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				const syncing = tail.then(async () => {
					if (dirty) {
						dirty = false;
						await file.sync();
					}
				});
				tail = syncing;
				syncing.catch(() => {});
			}, groupSyncMs);
			timer.unref?.();
		};
		return {
			records: journal.records,
			append(event: SessionEvent): Promise<EventRecord> {
				const result = tail.then(async () => {
					const record: EventRecord = {
						schemaVersion: 1,
						seq: seq + 1,
						at: new Date().toISOString(),
						event,
					};
					await file.writeFile(`${JSON.stringify(record)}\n`);
					seq++;
					if (streamedKinds.has(event.kind)) {
						dirty = true;
						syncLater();
					} else {
						dirty = false;
						await file.sync();
					}
					return record;
				});
				tail = result;
				return result;
			},
			async close() {
				clearTimeout(timer);
				timer = undefined;
				try {
					await tail;
					if (dirty) {
						dirty = false;
						await file.sync();
					}
				} finally {
					await file.close();
				}
			},
		};
	}
}
