import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
	isAgentTask,
	isId,
	isProject,
	isRecord,
	MAIN_TREE_ID,
	type WorkspaceSnapshot,
	type ReadIssueCode,
} from '@brigadir/core';
import { defaultDataDir } from './data-dir';

export class ReadFailure extends Error {
	constructor(public readonly code: ReadIssueCode) {
		super(code);
	}
}
function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === 'ENOENT';
}
function contains(parent: string, child: string): boolean {
	const part = relative(parent, child);
	return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await canonical(parent), relative(parent, path));
	}
}
export async function resolveDataRoot(dataDir?: string, home = homedir()): Promise<string> {
	if (dataDir !== undefined && (!isAbsolute(dataDir) || !dataDir.trim()))
		throw new ReadFailure('unsafe_path');
	const candidate = await canonical(resolve(dataDir ?? defaultDataDir(home)));
	// The root is a folder of its own, never the home folder or above it.
	if (contains(candidate, await canonical(home))) throw new ReadFailure('unsafe_path');
	return candidate;
}

export async function readWorkspace(
	options: {
		dataDir?: string;
		home?: string;
		/** spec/tasks#quick-tasks: project cleanup also sees the main tree. */ includeMainTrees?: boolean;
	} = {}
): Promise<WorkspaceSnapshot> {
	const snapshot: WorkspaceSnapshot = { projects: [], tasks: [], issues: [] };
	const home = options.home ?? homedir();
	const root = await resolveDataRoot(options.dataDir, home);
	function issue(path: string, error: unknown) {
		snapshot.issues.push({
			path: relative(root, path) || '.',
			code: error instanceof ReadFailure ? error.code : 'unreadable',
		});
	}
	async function checked(path: string): Promise<string> {
		const actual = await realpath(path);
		if (!contains(root, actual)) throw new ReadFailure('unsafe_path');
		return actual;
	}
	async function directories(path: string, optional = false): Promise<string[]> {
		try {
			const entries = await readdir(await checked(path), { withFileTypes: true });
			const names: string[] = [];
			for (const entry of entries) {
				if (entry.isSymbolicLink()) {
					issue(join(path, entry.name), new ReadFailure('unsafe_path'));
					continue;
				}
				if (entry.isDirectory() && isId(entry.name)) names.push(entry.name);
			}
			return names.sort();
		} catch (error) {
			if (!(optional && isMissing(error))) issue(path, error);
			return [];
		}
	}
	async function document(path: string): Promise<Record<string, unknown>> {
		const safe = await checked(path);
		if ((await stat(safe)).size > 1024 * 1024) throw new ReadFailure('invalid_document');
		let value: unknown;
		try {
			value = JSON.parse(await readFile(safe, 'utf8'));
		} catch (error) {
			if (error instanceof SyntaxError) throw new ReadFailure('invalid_document');
			throw error;
		}
		if (!isRecord(value) || !Number.isInteger(value.schemaVersion))
			throw new ReadFailure('invalid_document');
		if (value.schemaVersion !== 1) throw new ReadFailure('unsupported_schema');
		return value;
	}
	const projectsRoot = join(root, 'projects');
	for (const projectId of await directories(projectsRoot, true)) {
		const projectFile = join(projectsRoot, projectId, 'project.json');
		try {
			const value = await document(projectFile);
			if (!isProject(value.project) || value.project.id !== projectId)
				throw new ReadFailure('invalid_document');
			snapshot.projects.push(value.project);
		} catch (error) {
			issue(projectFile, error);
			continue;
		}
		const tasksRoot = join(projectsRoot, projectId, 'tasks');
		for (const taskId of await directories(tasksRoot, true)) {
			if (taskId === MAIN_TREE_ID && !options.includeMainTrees) continue;
			const taskFile = join(tasksRoot, taskId, 'task.json');
			try {
				const value = await document(taskFile);
				if (
					!isAgentTask(value.task) ||
					value.task.id !== taskId ||
					value.task.projectId !== projectId
				)
					throw new ReadFailure('invalid_document');
				// task.json is rewritten on every status change, so its mtime is the last activity (spec/projects-and-board#project-screen RelativeAge).
				snapshot.tasks.push({
					...value.task,
					updatedAt: (await stat(await checked(taskFile))).mtime.toISOString(),
				});
			} catch (error) {
				issue(taskFile, error);
			}
		}
	}
	return snapshot;
}
/**
 * Working, needs-you and preparing tasks of every project: the spec/tasks#launch-sheet agent limit is global. The walk and the
 * validation are readWorkspace's, but a project.json or task.json is parsed again only when its lstat changes, so a
 * crew waiting for a slot polls with stats, not reads. Symlinks and oversized files do not count, as there.
 */
export class ActiveTasks {
	private seen = new Map<string, { stamp: string; value: unknown }>();
	/** `except`: task ids the caller counts itself (a crew's launching workers). */
	async count(dataDir: string, except: ReadonlySet<string> = new Set()): Promise<number> {
		const root = await resolveDataRoot(dataDir),
			next = new Map<string, { stamp: string; value: unknown }>();
		const ids = async (path: string) => {
			try {
				return (await readdir(path, { withFileTypes: true }))
					.filter((entry) => entry.isDirectory() && isId(entry.name))
					.map((entry) => entry.name);
			} catch {
				return [];
			}
		};
		const read = async (path: string): Promise<unknown> => {
			let info;
			try {
				info = await lstat(path);
			} catch {
				return null;
			}
			if (!info.isFile() || info.size > 1024 * 1024) return null;
			const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
			let entry = this.seen.get(path);
			if (entry?.stamp !== stamp) {
				let value: unknown = null;
				try {
					value = JSON.parse(await readFile(path, 'utf8'));
				} catch {
					/* unreadable: not counted */
				}
				entry = { stamp, value };
			}
			next.set(path, entry);
			return entry.value;
		};
		let count = 0;
		for (const projectId of await ids(join(root, 'projects'))) {
			const project = await read(join(root, 'projects', projectId, 'project.json'));
			if (
				!isRecord(project) ||
				project.schemaVersion !== 1 ||
				!isProject(project.project) ||
				project.project.id !== projectId
			)
				continue;
			for (const taskId of await ids(join(root, 'projects', projectId, 'tasks'))) {
				if (except.has(taskId)) continue;
				const value = await read(join(root, 'projects', projectId, 'tasks', taskId, 'task.json'));
				if (
					isRecord(value) &&
					value.schemaVersion === 1 &&
					isAgentTask(value.task) &&
					value.task.id === taskId &&
					value.task.projectId === projectId &&
					['working', 'needs-you', 'preparing'].includes(value.task.status)
				)
					count++;
			}
		}
		this.seen = next;
		return count;
	}
}
export * from './data-dir';
export * from './session';
export * from './journal-cache';
export * from './files';

export * from './attachments';
export * from './process-owner';
export * from './relay';

export * from './knowledge';
export * from './knowledge-file';
export * from './templates';
export * from './notes';
export * from './schedules';
