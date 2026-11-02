import { isId, isRecord } from './workspace';
import { isCommandRunSpec, type CommandRunSpec } from './project-commands';
export type TerminalBlock = {
	id: number;
	command: string;
	cwd: string;
	startedAt: number;
	duration: number | null;
	exitCode: number | null;
	output: string;
};
/** spec/search-menus-and-commands#project-commands: a console tab that runs a project command (or a «Run once» line) instead of an interactive shell. */
export type TerminalRun = {
	commandId: string | null;
	name: string;
	line: string;
	port: number | null;
	stopped: boolean;
};
export type RunState = 'starting' | 'running' | 'failed' | 'done' | 'stopped';
export type TerminalInfo = {
	id: string;
	role: 'console' | 'agent';
	title: string;
	cols: number;
	rows: number;
	exited: boolean;
	exitCode: number | null;
	block?: TerminalBlock;
	run?: TerminalRun;
	/** spec/task-window-workspace#restore-window: the session's folder inside the task; absent for the task's root (and from an older host). */
	directory?: string;
	/** spec/task-window-workspace#terminal-close: a console's shell runs a command in the foreground, so closing it asks first; absent from an older host. */
	busy?: boolean;
};
export type TerminalAnchor = { turn: number; line: number };
export type TerminalSnapshot = TerminalInfo & {
	data: string;
	seq: number;
	anchors?: TerminalAnchor[];
	normal?: boolean;
};
export type TerminalEvent = {
	id: string;
	seq: number;
	data: string;
	anchors?: TerminalAnchor[];
	normal?: boolean;
	exited?: boolean;
	exitCode?: number;
	block?: TerminalBlock;
	run?: TerminalRun;
};
/**
 * spec/task-window-workspace#terminal-close: closing a live terminal asks only when something would stop — a command tab's process, or a command a console's
 * shell runs. A host that does not say (`busy` absent) still asks.
 */
export function closeAsks(info: Pick<TerminalInfo, 'exited' | 'run' | 'busy'>): boolean {
	if (info.exited) return false;
	return info.run ? true : info.busy !== false;
}
/** spec/search-menus-and-commands#project-commands: `running` once the output named a local address, `stopped` when the person stopped it or pressed Ctrl-C (130). */
export function runState(info: Pick<TerminalInfo, 'exited' | 'exitCode' | 'run'>): RunState | null {
	if (!info.run) return null;
	if (!info.exited) return info.run.port === null ? 'starting' : 'running';
	return info.run.stopped || info.exitCode === 130
		? 'stopped'
		: info.exitCode === 0
			? 'done'
			: 'failed';
}
/** `read` also starts delivery of that terminal's output to the UI; `unwatch` ends it (perf review TUI-02). */
export type TerminalCommand =
	| { kind: 'list' }
	| { kind: 'run'; run: CommandRunSpec }
	| { kind: 'stop'; id: string }
	| { kind: 'create'; role: 'console' | 'agent'; directory?: string }
	| { kind: 'read' | 'close' | 'clear' | 'text' | 'unwatch'; id: string }
	| { kind: 'close-consoles' }
	| { kind: 'input'; id: string; data: string }
	| { kind: 'resize'; id: string; cols: number; rows: number };
export function isTerminalCommand(v: unknown): v is TerminalCommand {
	if (!isRecord(v)) return false;
	if (v.kind === 'list' || v.kind === 'close-consoles') return true;
	if (v.kind === 'run') return isCommandRunSpec(v.run);
	if (v.kind === 'create')
		return (
			(v.role === 'console' || v.role === 'agent') &&
			(v.directory === undefined ||
				(v.role === 'console' &&
					typeof v.directory === 'string' &&
					v.directory.length <= 4096 &&
					!v.directory.startsWith('/') &&
					!v.directory.includes('\0') &&
					v.directory
						.split('/')
						.every((part) => part !== '..' && part !== '.git' && part !== '.brigadir')))
		);
	if (!isId(v.id)) return false;
	if (['read', 'close', 'clear', 'text', 'unwatch', 'stop'].includes(String(v.kind))) return true;
	if (v.kind === 'input') return typeof v.data === 'string' && v.data.length <= 65536;
	return (
		v.kind === 'resize' &&
		Number.isSafeInteger(v.cols) &&
		Number(v.cols) >= 2 &&
		Number(v.cols) <= 500 &&
		Number.isSafeInteger(v.rows) &&
		Number(v.rows) >= 1 &&
		Number(v.rows) <= 200
	);
}
