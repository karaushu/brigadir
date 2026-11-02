import { execFileSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** spec/architecture-and-platform#data-root: the data folder is `~/.brigadir`; `~/.brigadir-v2` is where it lived before 1.0.0. */
export const DATA_DIR_NAME = '.brigadir';
export const PREVIOUS_DATA_DIR_NAME = '.brigadir-v2';

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}
/** The default data folder. While a move is postponed (live hosts), the old folder stays in use. */
export function defaultDataDir(home = homedir()): string {
	const current = join(home, DATA_DIR_NAME),
		previous = join(home, PREVIOUS_DATA_DIR_NAME);
	return !existsSync(current) && isDirectory(previous) ? previous : current;
}

function entries(path: string) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
}
function alive(file: string): boolean {
	let pid: unknown;
	try {
		pid = JSON.parse(readFileSync(file, 'utf8')).pid;
	} catch {
		return false;
	}
	if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || pid === process.pid) return false;
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
/** A task host outlives the app (spec/task-window-workspace#restore-window hot exit) and another copy of the app may be open; both write by the old
 *  paths, so the folder waits for the next start. */
function inUse(root: string): boolean {
	for (const entry of entries(join(root, 'run')))
		if (/^app-\d+\.lock$/.test(entry.name) && alive(join(root, 'run', entry.name))) return true;
	for (const project of entries(join(root, 'projects'))) {
		if (!project.isDirectory()) continue;
		for (const task of entries(join(root, 'projects', project.name, 'tasks')))
			if (
				task.isDirectory() &&
				alive(join(root, 'projects', project.name, 'tasks', task.name, 'host.lock'))
			)
				return true;
	}
	return false;
}
/** spec/architecture-and-platform#data-root: marks this app instance as using the data folder until it exits, so another copy does not move it. */
export function markAppRunning(root: string) {
	const dir = join(root, 'run'),
		file = join(dir, `app-${process.pid}.lock`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
	process.once('exit', () => rmSync(file, { force: true }));
}
/** JSON documents keep absolute paths (worktree roots, `dataDir` of host configs); journals stay as history.
 *  `worktrees/` holds the user's checkouts and is never rewritten. */
function rewriteDocuments(dir: string, from: string, to: string, top = true) {
	const quoted = JSON.stringify(from).slice(0, -1),
		replacement = JSON.stringify(to).slice(0, -1);
	for (const entry of entries(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!(top && entry.name === 'worktrees')) rewriteDocuments(path, from, to, false);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const text = readFileSync(path, 'utf8');
		const next = text
			.split(`${quoted}"`)
			.join(`${replacement}"`)
			.split(`${quoted}/`)
			.join(`${replacement}/`);
		if (next === text) continue;
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, next, { mode: 0o600 });
		renameSync(temporary, path);
	}
}
/** Each moved worktree points its source repository back at the new place. */
function repairWorktrees(root: string, log: (message: string) => void) {
	for (const project of entries(join(root, 'projects'))) {
		if (!project.isDirectory()) continue;
		for (const task of entries(join(root, 'projects', project.name, 'tasks'))) {
			let state: { root?: unknown; repositories?: unknown };
			try {
				state = JSON.parse(
					readFileSync(
						join(root, 'projects', project.name, 'tasks', task.name, 'worktree.json'),
						'utf8'
					)
				);
			} catch {
				continue;
			}
			if (typeof state.root !== 'string' || !Array.isArray(state.repositories)) continue;
			for (const repository of state.repositories) {
				const relativePath =
					repository && typeof repository.relativePath === 'string'
						? repository.relativePath
						: null;
				const path = relativePath === null ? null : join(state.root, relativePath);
				if (!path || !existsSync(join(path, '.git'))) continue;
				try {
					execFileSync('git', ['-C', path, 'worktree', 'repair'], {
						stdio: 'ignore',
						timeout: 10_000,
					});
				} catch {
					log(`git worktree repair failed: ${path}`);
				}
			}
		}
	}
}
/** Claude Code keys its transcripts by the session folder; moved worktrees keep their conversations. */
function moveClaudeTranscripts(
	home: string,
	from: string,
	to: string,
	log: (message: string) => void
) {
	const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
	const projects = join(home, '.claude', 'projects'),
		prefix = encode(from),
		next = encode(to);
	for (const entry of entries(projects)) {
		if (!entry.isDirectory() || (entry.name !== prefix && !entry.name.startsWith(`${prefix}-`)))
			continue;
		const target = join(projects, next + entry.name.slice(prefix.length));
		if (existsSync(target)) continue;
		try {
			renameSync(join(projects, entry.name), target);
		} catch {
			log(`could not move Claude transcripts: ${entry.name}`);
		}
	}
}

export type DataDirMove = 'moved' | 'none' | 'postponed';
/**
 * spec/architecture-and-platform#data-root: one-time move `~/.brigadir-v2` → `~/.brigadir` before anything opens the store. Synchronous on
 * purpose — main calls it first thing. A folder already at `~/.brigadir` wins; the old one is then left as is.
 */
export function moveDataDir(
	home = homedir(),
	log: (message: string) => void = () => {}
): DataDirMove {
	const current = join(home, DATA_DIR_NAME),
		previous = join(home, PREVIOUS_DATA_DIR_NAME);
	if (existsSync(current) || !isDirectory(previous)) return 'none';
	if (inUse(previous)) {
		log('data folder move postponed: a task host or another copy of the app is still running');
		return 'postponed';
	}
	renameSync(previous, current);
	rewriteDocuments(current, previous, current);
	repairWorktrees(current, log);
	moveClaudeTranscripts(home, previous, current, log);
	log(`data folder moved: ${previous} → ${current}`);
	return 'moved';
}
