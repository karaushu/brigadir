import { execFile } from 'node:child_process';
import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * spec/chat-turns-plans-and-questions#background-commands: Claude's own stop of a background command (`_session/async_task/stop`) answers `{stopped: false}` unless the
 * client is an AIR client, and the AIR capability changes the adapter's other updates (ADR, Rejected). So the
 * transport stops the command itself: the processes that hold the command's output file open (the shell Claude Code
 * started and what runs in it), and only those descended from this adapter — never anything else of the person's.
 */
export type ProcessRunner = (command: string, args: string[]) => Promise<string>;
const run: ProcessRunner = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, { timeout: 5000, encoding: 'utf8' }, (_error, stdout) =>
			resolve(typeof stdout === 'string' ? stdout : '')
		);
	});
const pids = (text: string) =>
	text
		.split(/\s+/)
		.map(Number)
		.filter((pid) => Number.isSafeInteger(pid) && pid > 1);
/** The processes to signal: writers of `path` under `ancestor`, as `{pid, group}`; a shell that leads its own group is
 *  signalled as the group, so the command it runs stops with it. */
/** What the search needs of the OS: who holds the file, and each process's parent and group. */
type ProcessTable = {
	writers(path: string): Promise<number[]>;
	parent(pid: number): Promise<number>;
	group(pid: number): Promise<number | undefined>;
};
/** macOS: `lsof` and `ps`. */
export const psTable = (exec: ProcessRunner): ProcessTable => ({
	writers: async (path) => pids(await exec('lsof', ['-t', '--', path])),
	parent: async (pid) => pids(await exec('ps', ['-o', 'ppid=', '-p', String(pid)]))[0] ?? 0,
	group: async (pid) => pids(await exec('ps', ['-o', 'pgid=', '-p', String(pid)]))[0],
});
/** `/proc/<pid>/stat` after the command name, which may hold spaces and parentheses: state, ppid, pgrp, … */
async function statFields(proc: string, pid: number) {
	try {
		const stat = await readFile(join(proc, String(pid), 'stat'), 'utf8');
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
	} catch {
		return [];
	}
}
/** spec/architecture-and-platform#linux-package: Linux reads `/proc` — a minimal Fedora or Debian has no `lsof`. */
export const procTable = (proc = '/proc'): ProcessTable => ({
	writers: async (path) => {
		const target = await realpath(path).catch(() => path);
		const found: number[] = [];
		for (const entry of await readdir(proc).catch(() => [] as string[])) {
			if (!/^\d+$/.test(entry)) continue;
			const fds = join(proc, entry, 'fd');
			for (const fd of await readdir(fds).catch(() => [] as string[]))
				if ((await readlink(join(fds, fd)).catch(() => null)) === target) {
					found.push(Number(entry));
					break;
				}
		}
		return found.filter((pid) => pid > 1);
	},
	parent: async (pid) => Number((await statFields(proc, pid))[1]) || 0,
	group: async (pid) => Number((await statFields(proc, pid))[2]) || undefined,
});
export async function backgroundProcesses(
	path: string,
	ancestor: number,
	exec: ProcessRunner = run,
	table: ProcessTable = process.platform === 'linux' ? procTable() : psTable(exec)
): Promise<{ pid: number; group: boolean }[]> {
	const writers = await table.writers(path);
	const found: { pid: number; group: boolean }[] = [];
	for (const pid of writers) {
		let parent = pid,
			owned = false;
		for (let depth = 0; depth < 16 && parent > 1; depth++) {
			parent = await table.parent(parent);
			if (parent === ancestor) {
				owned = true;
				break;
			}
		}
		if (!owned) continue;
		const group = await table.group(pid);
		found.push({ pid, group: group === pid });
	}
	return found;
}
export async function stopBackgroundProcesses(
	path: string,
	ancestor: number,
	exec: ProcessRunner = run,
	kill: (pid: number, signal: NodeJS.Signals) => void = process.kill
): Promise<number> {
	const targets = await backgroundProcesses(path, ancestor, exec);
	let stopped = 0;
	for (const target of targets) {
		try {
			kill(target.group ? -target.pid : target.pid, 'SIGTERM');
			stopped++;
		} catch {
			/* already gone */
		}
	}
	return stopped;
}
