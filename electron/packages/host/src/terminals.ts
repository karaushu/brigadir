import { safePath } from '@brigadir/persistence';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import headless, { type IMarker } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
	isTerminalCommand,
	outputPort,
	type CommandRunSpec,
	type AgentTask,
	type TerminalCommand,
	type TerminalAnchor,
	type TerminalEvent,
	type TerminalInfo,
	type TerminalSnapshot,
} from '@brigadir/core';
import { consoleShell } from './shell';
import { agentShell, loginShell } from './login-shell';
import { TerminalBlocks, boundedOutput } from './terminal-blocks';
import type { CliLaunch } from './cli-launch';
import { oscColor, type TerminalColors } from './terminal-colors';
const { Terminal } = headless;
type Anchors = { normal: boolean; anchors: TerminalAnchor[] };
type Entry = {
	info: TerminalInfo;
	pty: IPty;
	terminal: InstanceType<typeof Terminal>;
	serialize: SerializeAddon;
	seq: number;
	pending: Promise<void>;
	closed: boolean;
	markers: Map<number, IMarker>;
	queued: string;
	writing: boolean;
	paused: boolean;
	sentAnchors: Anchors | undefined;
	snapshot: { key: string; data: string } | undefined;
	frozen: { data: string; screen: string; anchors: Anchors; tail: string } | undefined;
	freezeTimer: ReturnType<typeof setTimeout> | undefined;
	exits: (() => void)[];
	/** The process the PTY started (`zsh`), to tell its own prompt from a command in the foreground. */
	program: string;
};
/** PTY output waiting for the headless parser beyond this many UTF-16 units pauses the child. */
const outputHighWater = 1024 * 1024;
/** An exited terminal keeps its serialized buffer instead of a live headless one (~20 MB each when full, TUI-10). Tests shorten it. */
/** spec/search-menus-and-commands#agent-command-tools, spec/terminal-and-cli-agents#agent-console-tools: the most output lines an agent reads of a command or a console session at once. */
export const commandTailLimit = 400;
export const terminalTiming = { freezeAfterExit: 60_000, stopTerm: 3000, stopKill: 5000 };
/** SerializeAddon returns a rope of small pieces, ~20× its length on the heap; kept copies are flattened once. */
const flat = (value: string) => Buffer.from(value, 'utf8').toString('utf8');
/** Event-sized pieces of output that never split a surrogate pair. */
function outputSlices(data: string) {
	const slices: string[] = [];
	for (let start = 0; start < data.length;) {
		let end = Math.min(data.length, start + 32768);
		if (end < data.length) {
			const code = data.charCodeAt(end - 1);
			if (code >= 0xd800 && code <= 0xdbff) end--;
		}
		slices.push(data.slice(start, end));
		start = end;
	}
	return slices;
}
/** Buffers never touch disk. Only the mounted UI subscribes to output: `read` starts it, `unwatch` ends it (perf review TUI-02). */
export class Terminals {
	private closed = false;
	private watched = new Set<string>();
	private entries = new Map<string, Entry>();
	private launch: CliLaunch | undefined;
	agentAlive() {
		return [...this.entries.values()].some(
			(entry) => entry.info.role === 'agent' && !entry.info.exited
		);
	}
	/** The user's shells still running: an idle host never stops under them (spec/architecture-and-platform#host-lifecycle). */
	consolesAlive() {
		return [...this.entries.values()].some(
			(entry) => entry.info.role === 'console' && !entry.info.exited
		);
	}
	configureAgent(launch: CliLaunch) {
		this.launch = launch;
	}
	/** spec/settings-modules-and-onboarding#module-off: the commands module switched off — every live command stops as `Stop` does; its tab keeps the output. */
	stopRuns() {
		for (const entry of [...this.entries.values()])
			if (entry.info.run && !entry.info.exited) void this.halt(entry);
	}
	interruptAgent() {
		const entry = [...this.entries.values()].find(
			(entry) => entry.info.role === 'agent' && !entry.info.exited
		);
		if (!entry) throw new Error('Agent is not running');
		entry.pty.write('\x03');
	}
	/** `scopeName` names a console session by the repo it opens in (spec/terminal-and-cli-agents#console: without markers the tab is the scope's name). */
	constructor(
		readonly cwd: string,
		readonly task: AgentTask,
		readonly publish: (event: TerminalEvent) => void,
		readonly agentExit: (code: number) => void = () => {},
		readonly fixture?: { command: string; args: string[] },
		readonly shellAssets?: string,
		readonly scopeName: (cwd: string) => string | undefined = () => undefined,
		readonly colors?: (role: 'console' | 'agent') => Promise<TerminalColors>
	) {}
	/** spec/search-menus-and-commands#project-commands: `run` starts a project command as `$SHELL -l -c`; `replace` is the tab it restarts, kept at its place in the list. */
	private create(role: 'console' | 'agent', cwd = this.cwd, run?: CommandRunSpec, replace?: Entry) {
		if (this.closed) throw new Error('Terminals are closed');
		if (role === 'agent') {
			if (this.task.transport !== 'terminal') throw new Error('This task uses GUI transport');
			const current = [...this.entries.values()].find(
				(entry) => entry.info.role === 'agent' && !entry.info.exited
			);
			if (current) return current.info;
		}
		if (role === 'agent')
			for (const entry of [...this.entries.values()])
				if (entry.info.role === 'agent' && entry.info.exited) this.close(entry);
		if (this.entries.size - (replace ? 1 : 0) >= 8) throw new Error('Terminal limit reached');
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(e): e is [string, string] =>
					typeof e[1] === 'string' &&
					!e[0].startsWith('BRIGADIR_') &&
					e[0] !== 'ELECTRON_RUN_AS_NODE'
			)
		);
		// A new PTY has its own capabilities; launcher/log color flags do not apply.
		delete env.NO_COLOR;
		delete env.FORCE_COLOR;
		Object.assign(env, {
			TERM: 'xterm-256color',
			COLORTERM: 'truecolor',
			TERM_PROGRAM: 'Brigadir',
			TERM_PROGRAM_VERSION: '0.0.0',
		});
		// spec/architecture-and-platform#linux-package: the person's login shell; the agent's own start is agentShell (macOS keeps /bin/zsh).
		const shell = loginShell();
		if (role === 'agent' && !this.launch && !this.fixture)
			throw new Error('Agent launch is not configured');
		if (role === 'agent') Object.assign(env, this.launch?.env);
		const agent =
			role === 'agent'
				? agentShell(this.launch?.command ?? this.task.provider!, this.launch?.args ?? [])
				: null;
		const args = agent
			? agent.args
			: run
				? ['-l', '-c', run.line]
				: consoleShell(shell, env, this.shellAssets);
		const command =
			role === 'agent' && this.fixture ? this.fixture.command : (agent?.file ?? shell);
		const launchArgs =
			role === 'agent' && this.fixture
				? [...this.fixture.args, ...(this.launch?.args ?? [])]
				: args;
		if (role === 'agent' && this.fixture) env.ELECTRON_RUN_AS_NODE = '1';
		const terminal = new Terminal({
			cols: 100,
			rows: 24,
			scrollback: 5000,
			allowProposedApi: true,
		});
		const serialize = new SerializeAddon();
		terminal.loadAddon(serialize as unknown as Parameters<typeof terminal.loadAddon>[0]);
		// The headless parser answers DA but has no colors: a CLI asking OSC 10/11 before DA hears silence and assumes a dark background.
		// An async handler holds the parser (the headless typings omit the Promise the shared parser accepts), so the color reply still comes before the DA one (Claude Code's `auto` theme).
		const colors = this.colors;
		if (colors)
			for (const [ident, key] of [
				[10, 'foreground'],
				[11, 'background'],
			] as const)
				(
					terminal.parser.registerOscHandler as (
						ident: number,
						callback: (data: string) => boolean | Promise<boolean>
					) => void
				)(ident, (data) =>
					data !== '?'
						? false
						: colors(role).then(
								(value) => {
									if (!info.exited) pty.write(`\x1b]${ident};${oscColor(value[key])}\x1b\\`);
									return true;
								},
								() => false
							)
				);
		let pty: IPty;
		try {
			pty = spawn(command, launchArgs, { cwd, cols: 100, rows: 24, name: 'xterm-256color', env });
		} catch (e) {
			terminal.dispose();
			throw e;
		}
		const info: TerminalInfo = {
			id: randomUUID(),
			role,
			title:
				role === 'agent'
					? (this.task.provider ?? 'Agent')
					: run
						? run.name
						: (this.scopeName(cwd) ?? shell.split('/').at(-1)!),
			cols: 100,
			rows: 24,
			exited: false,
			exitCode: null,
			// spec/task-window-workspace#restore-window: a session the restart ended reopens in its folder.
			...(() => {
				const directory = relative(this.cwd, cwd);
				return directory && !directory.startsWith('..') && !isAbsolute(directory)
					? { directory: directory.split('\\').join('/') }
					: {};
			})(),
			...(run
				? {
						run: {
							commandId: run.commandId,
							name: run.name,
							line: run.line,
							port: null,
							stopped: false,
						},
					}
				: {}),
		};
		const entry: Entry = {
			info,
			pty,
			terminal,
			serialize,
			seq: 0,
			pending: Promise.resolve(),
			closed: false,
			markers: new Map(),
			queued: '',
			writing: false,
			paused: false,
			sentAnchors: undefined,
			snapshot: undefined,
			frozen: undefined,
			freezeTimer: undefined,
			exits: [],
			program: basename(command),
		};
		this.entries.set(info.id, entry);
		if (replace) {
			this.entries = new Map(
				[...this.entries]
					.filter(([id]) => id !== info.id)
					.map(([id, value]) => (id === replace.info.id ? [info.id, entry] : [id, value]))
			);
			this.retire(replace);
		}
		if (run) this.send(entry, { data: '', run: { ...info.run! } });
		let portTail = '';
		if (role === 'console' && !run)
			new TerminalBlocks(terminal, this.cwd, (block) => {
				info.block = block;
				this.send(entry, { data: '', block });
			});
		pty.onData((data) => {
			if (entry.closed || entry.frozen) return;
			entry.queued += data;
			// A local address in the output marks the server as running; a tail bridges a split chunk.
			if (info.run && info.run.port === null) {
				portTail = (portTail + data).slice(-512);
				const port = outputPort(portTail);
				if (port !== null) {
					info.run.port = port;
					this.send(entry, { data: '', run: { ...info.run } });
				}
			}
			if (!entry.paused && entry.queued.length > outputHighWater) {
				entry.paused = true;
				pty.pause();
			}
			if (!entry.writing) this.drain(entry);
		});
		pty.onExit(({ exitCode }) => {
			info.exited = true;
			info.exitCode = exitCode;
			for (const done of entry.exits.splice(0)) done();
			void entry.pending.then(() => {
				this.send(entry, { data: '', exited: true, exitCode });
				this.scheduleFreeze(entry);
				if (role === 'agent' && !this.agentAlive()) this.agentExit(exitCode);
			});
		});
		// Reply only to terminal protocol queries, never arbitrary application IPC.
		terminal.onData((data) => {
			if (!info.exited) pty.write(data);
		});
		return info;
	}
	async command(
		command: TerminalCommand
	): Promise<TerminalInfo[] | TerminalInfo | TerminalSnapshot | string | null> {
		if (!isTerminalCommand(command)) throw new Error('Invalid terminal command');
		if (command.kind === 'list')
			return [...this.entries.values()].map((entry) => ({
				...entry.info,
				...(entry.info.role === 'console' && !entry.info.run ? { busy: this.busy(entry) } : {}),
			}));
		if (command.kind === 'run') {
			const cwd = command.run.directory
				? await safePath(this.cwd, command.run.directory)
				: this.cwd;
			if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
			// One tab per command: a second run restarts it in place once the old process has let go of its port.
			const previous =
				command.run.commandId === null
					? undefined
					: [...this.entries.values()].find(
							(entry) => entry.info.run?.commandId === command.run.commandId
						);
			if (previous) await this.halt(previous);
			return this.create(
				'console',
				cwd,
				command.run,
				previous && this.entries.get(previous.info.id) === previous ? previous : undefined
			);
		}
		if (command.kind === 'create') {
			const cwd =
				command.directory === undefined ? this.cwd : await safePath(this.cwd, command.directory);
			if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory');
			return this.create(command.role, cwd);
		}
		if (command.kind === 'close-consoles') {
			for (const entry of [...this.entries.values()])
				if (entry.info.role === 'console') this.close(entry);
			return null;
		}
		if (command.kind === 'unwatch') {
			this.watched.delete(command.id);
			return null;
		}
		const entry = this.entries.get(command.id);
		if (!entry) throw new Error('Terminal is unavailable');
		if (command.kind === 'close') {
			this.close(entry);
			return null;
		}
		if (command.kind === 'stop') {
			if (!entry.info.run) throw new Error('Not a command');
			void this.halt(entry);
			return null;
		}
		// Watching starts before the snapshot: output parsed meanwhile reaches the UI with seq the snapshot already covers.
		if (command.kind === 'read') this.watched.add(entry.info.id);
		await entry.pending;
		if (command.kind === 'read' && entry.frozen)
			return { ...entry.info, seq: entry.seq, data: entry.frozen.data, ...entry.frozen.anchors };
		if (command.kind === 'read') {
			// A reattach without new output or a resize reuses the last serialization (TUI-08).
			const key = `${entry.seq}/${entry.info.cols}x${entry.info.rows}`;
			if (entry.snapshot?.key !== key)
				entry.snapshot = { key, data: flat(entry.serialize.serialize()) };
			const anchors = this.anchors(entry);
			if (entry.info.role === 'agent') entry.sentAnchors = anchors;
			return { ...entry.info, seq: entry.seq, data: entry.snapshot.data, ...anchors };
		}
		if (command.kind === 'text') {
			if (entry.info.block?.exitCode !== null && entry.info.block) {
				const block = entry.info.block;
				return `${block.command}\ncwd: ${block.cwd}\nexit: ${block.exitCode} · ${block.duration} ms\n${block.output}`;
			}
			return entry.frozen?.screen ?? this.screen(entry);
		}
		// The live view drops everything on this sequence; a frozen buffer does the same.
		if (command.kind === 'clear' && entry.frozen) {
			entry.frozen = { ...entry.frozen, data: '', screen: '', tail: '' };
			this.send(entry, { data: '\x1b[3J\x1b[H\x1b[2J' });
			return null;
		}
		if (command.kind === 'clear') {
			entry.terminal.clear();
			this.send(entry, { data: '\x1b[3J\x1b[H\x1b[2J' });
			return null;
		}
		if (entry.info.exited) throw new Error('Terminal has exited');
		if (command.kind === 'input') {
			entry.pty.write(command.data);
			return null;
		}
		if (command.kind !== 'resize') throw new Error('Unknown terminal command');
		entry.terminal.resize(command.cols, command.rows);
		entry.pty.resize(command.cols, command.rows);
		entry.info.cols = command.cols;
		entry.info.rows = command.rows;
		return null;
	}
	/**
	 * spec/task-window-workspace#terminal-close: the tty's foreground process is not the shell itself — a command runs. A PTY that cannot name it falls back to
	 * the shell's own marks (an open command block).
	 */
	private busy(entry: Entry): boolean {
		if (entry.info.exited) return false;
		let foreground = '';
		try {
			foreground = entry.pty.process;
		} catch {
			/* The platform's PTY cannot name its foreground process. */
		}
		if (foreground) return basename(foreground).replace(/^-/, '') !== entry.program;
		return entry.info.block?.exitCode === null;
	}
	/** One parser write in flight; output that arrives meanwhile is published as one event after its own write (perf review TUI-01). */
	private drain(entry: Entry) {
		entry.writing = true;
		entry.pending = entry.pending.then(
			() =>
				new Promise<void>((resolve) => {
					const step = () => {
						if (entry.closed || !entry.queued) {
							entry.writing = false;
							resolve();
							return;
						}
						const data = entry.queued;
						entry.queued = '';
						if (entry.paused && !entry.info.exited) {
							entry.paused = false;
							entry.pty.resume();
						}
						entry.terminal.write(data, () => {
							entry.snapshot = undefined;
							for (const slice of outputSlices(data)) this.send(entry, { data: slice });
							step();
						});
					};
					step();
				})
		);
	}
	/** Output goes only to a watched terminal; exits and command blocks go always, being rare and small. Anchors ride along only when they changed (TUI-09):
	 * a trim, reflow or buffer switch moves them, and the UI keeps the last value. */
	private send(entry: Entry, event: Omit<TerminalEvent, 'id' | 'seq'>) {
		const id = entry.info.id,
			seq = ++entry.seq;
		if (!this.watched.has(id)) {
			if (event.exited || event.block || event.run) this.publish({ id, seq, ...event, data: '' });
			return;
		}
		const anchors = entry.info.role === 'agent' ? this.changedAnchors(entry) : {};
		if (event.data || event.exited || event.block || event.run || 'anchors' in anchors)
			this.publish({ id, seq, ...event, ...anchors });
	}
	private changedAnchors(entry: Entry): Anchors | Record<string, never> {
		const next = this.anchors(entry),
			last = entry.sentAnchors;
		if (
			last &&
			last.normal === next.normal &&
			last.anchors.length === next.anchors.length &&
			last.anchors.every(
				(anchor, i) =>
					anchor.turn === next.anchors[i]!.turn && anchor.line === next.anchors[i]!.line
			)
		)
			return {};
		entry.sentAnchors = next;
		return next;
	}
	/** A new UI peer has mounted nothing yet; the next event after a `read` resends anchors. */
	unwatchAll() {
		this.watched.clear();
		for (const entry of this.entries.values()) entry.sentAnchors = undefined;
	}
	/** spec/search-menus-and-commands#agent-command-tools: the tab of a saved command, for the agent's `commands_*` tools. */
	commandRun(commandId: string): TerminalInfo | null {
		const entry = [...this.entries.values()].find((item) => item.info.run?.commandId === commandId);
		return entry ? { ...entry.info, run: { ...entry.info.run! } } : null;
	}
	/** spec/terminal-and-cli-agents#agent-console-tools: the console sessions of the task (its open tabs, command runs among them), for `console_list`. */
	consoles(): TerminalInfo[] {
		return [...this.entries.values()]
			.filter((entry) => entry.info.role === 'console')
			.map((entry) => ({ ...entry.info }));
	}
	/** spec/search-menus-and-commands#agent-command-tools, spec/terminal-and-cli-agents#agent-console-tools: the last lines of a console tab as plain text, for `commands_*` and `console_read`. */
	async consoleOutput(id: string, count: number): Promise<string> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error('Terminal is unavailable');
		await entry.pending;
		const limit = Math.max(1, Math.min(commandTailLimit, Math.floor(count)));
		return entry.frozen
			? entry.frozen.tail.split('\n').slice(-limit).join('\n')
			: this.plainTail(entry, limit);
	}
	/** Wrapped rows join their line; blank rows under the last output drop. */
	private plainTail(entry: Entry, count: number) {
		const buffer = entry.terminal.buffer.active,
			lines: string[] = [];
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (!line) continue;
			const text = line.translateToString(true);
			if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		while (lines.length && !lines.at(-1)!.trim()) lines.pop();
		return lines.slice(-count).join('\n');
	}
	private screen(entry: Entry) {
		const buffer = entry.terminal.buffer.active;
		const lines: string[] = [];
		for (
			let i = buffer.viewportY;
			i < Math.min(buffer.length, buffer.viewportY + entry.info.rows);
			i++
		)
			lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
		return boundedOutput(lines);
	}
	/** Late output after exit is parsed first; `read`, `text` and `clear` then answer from the kept strings. */
	private scheduleFreeze(entry: Entry) {
		clearTimeout(entry.freezeTimer);
		if (entry.closed || entry.frozen) return;
		entry.freezeTimer = setTimeout(() => {
			void entry.pending.then(() => {
				if (entry.closed || entry.frozen) return;
				if (entry.writing || entry.queued) {
					this.scheduleFreeze(entry);
					return;
				}
				const key = `${entry.seq}/${entry.info.cols}x${entry.info.rows}`;
				entry.frozen = {
					data:
						entry.snapshot?.key === key ? entry.snapshot.data : flat(entry.serialize.serialize()),
					screen: this.screen(entry),
					anchors: this.anchors(entry),
					tail: entry.info.role === 'console' ? this.plainTail(entry, commandTailLimit) : '',
				};
				// The disposed instance stays referenced by the entry: drop its lines first.
				entry.snapshot = undefined;
				entry.markers.clear();
				entry.terminal.reset();
				entry.terminal.resize(2, 1);
				entry.terminal.dispose();
			});
		}, terminalTiming.freezeAfterExit);
		entry.freezeTimer.unref?.();
	}
	private anchors(entry: Entry): Anchors {
		return {
			normal: entry.terminal.buffer.active.type === 'normal',
			anchors: [...entry.markers]
				.filter(([, marker]) => !marker.isDisposed)
				.map(([turn, marker]) => ({ turn, line: marker.line })),
		};
	}
	async markTurn(turn: number) {
		const entry = [...this.entries.values()].find(
			(entry) => entry.info.role === 'agent' && !entry.info.exited
		);
		if (!entry) return;
		await entry.pending;
		if (entry.closed || entry.terminal.buffer.active.type !== 'normal') return;
		const marker = entry.terminal.registerMarker(0);
		if (!marker) return;
		entry.markers.set(turn, marker);
		for (const [id, value] of entry.markers) if (value.isDisposed) entry.markers.delete(id);
		while (entry.markers.size > 1000) {
			const oldest = entry.markers.keys().next().value!;
			entry.markers.get(oldest)!.dispose();
			entry.markers.delete(oldest);
		}
		this.send(entry, { data: '' });
	}
	/** spec/search-menus-and-commands#project-commands: Ctrl-C (tty and SIGINT) to the group, `SIGTERM` to the whole group after 3 s, `SIGKILL` after 5 s. Resolves on exit. */
	private halt(entry: Entry) {
		if (entry.info.exited) return Promise.resolve();
		if (entry.info.run && !entry.info.run.stopped) {
			entry.info.run.stopped = true;
			this.send(entry, { data: '', run: { ...entry.info.run } });
		}
		return new Promise<void>((resolve) => {
			const group = (signal: NodeJS.Signals) => {
				try {
					process.kill(-entry.pty.pid, signal);
				} catch {
					/* The group has already exited. */
				}
			};
			const term = setTimeout(() => group('SIGTERM'), terminalTiming.stopTerm),
				kill = setTimeout(() => group('SIGKILL'), terminalTiming.stopKill);
			entry.exits.push(() => {
				clearTimeout(term);
				clearTimeout(kill);
				resolve();
			});
			// Ctrl-C through the tty, and SIGINT to the group: a ^C written while the shell still starts never reaches the command.
			entry.pty.write('\x03');
			group('SIGINT');
		});
	}
	private close(entry: Entry) {
		this.entries.delete(entry.info.id);
		this.retire(entry);
	}
	private retire(entry: Entry) {
		entry.closed = true;
		clearTimeout(entry.freezeTimer);
		this.watched.delete(entry.info.id);
		if (!entry.info.exited) entry.pty.kill('SIGHUP');
		void entry.pending.finally(() => {
			if (!entry.frozen) entry.terminal.dispose();
		});
	}
	closeAll() {
		this.closed = true;
		for (const entry of [...this.entries.values()]) this.close(entry);
	}
}
