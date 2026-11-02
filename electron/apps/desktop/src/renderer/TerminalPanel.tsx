import { terminalTypography } from './typography';
import { terminalColor } from './terminal-color';
import { onSessionEvent } from './session-events';
import { AgentLaunchState } from './ui/AgentLaunchState';
import { fileDropHandlers } from './ui/file-drop';
import { Glyph } from './ui/Glyph';
import { openCommandPort, RunGlyph, runCommand, stopCommand } from './ProjectCommands';
import { useWorkspace } from './store';
import { useCommandShortcut } from './ui/use-command-shortcut';
import { nativeWheel } from './terminal-wheel';
import { installTerminalInteractions } from './terminal-interactions';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import {
	closeAsks,
	runState,
	t,
	withShortcut,
	type MessageKey,
	type AgentTask,
	type Locale,
	type TerminalInfo,
	type TerminalSnapshot,
	type TerminalEvent,
	type TerminalAnchor,
} from '@brigadir/core';
import { useTaskState, attachTaskContext } from './task-state';
import { Button, IconButton } from './ui/Controls';
import { notify } from './ui/Toast';
import '@xterm/xterm/css/xterm.css';
import styles from './TerminalPanel.module.css';
/** The terminal list changes with the host lifecycle and turns; streamed deltas never change it. */
const terminalListEvents = new Set([
	'session.started',
	'session.failed',
	'host.stopped',
	'turn.started',
	'turn.completed',
]);
/**
 * spec/task-window-workspace#work-area: a console session is a tab of the work area — `session` names it; the CLI agent's terminal (`agent`) stays the
 * chat column of a terminal task (spec/terminal-and-cli-agents#cli-transport). `onClosed` — the session went (closed here or on the host); `onStep` — ⌃⇥ / ⌃⇧⇥.
 */
export default function TerminalPanel({
	task,
	locale,
	role = 'console',
	session,
	onRelay,
	onClosed,
	onStep,
	restored,
	onReopen,
}: {
	task: AgentTask;
	locale: Locale;
	role?: 'console' | 'agent';
	session?: string;
	onRelay?: () => void;
	onClosed?: () => void;
	onStep?: (step: 1 | -1) => void;
	/** spec/task-window-workspace#restore-window: a tab a restart brought back, with its session's folder; a session the host no longer has stays as
	 *  «Session ended · Open again» instead of closing its tab. `onReopen` — the new shell in that folder. */
	restored?: { directory: string | null };
	onReopen?: (item: TerminalInfo) => void;
}) {
	// spec/settings-modules-and-onboarding#module-off: with the commands module off a command tab keeps its output and Stop, but cannot run again.
	const commandsOn = useWorkspace((state) => state.appearance.modules.commands);
	const shortcut = useCommandShortcut();
	const [
		{ returnToDiff, terminalScroll, terminalActive, terminalClosing, focusTurn, focusTurnNumber },
		setTask,
	] = useTaskState(task);
	const [items, setItems] = useState<TerminalInfo[]>([]);
	const [launchError, setLaunchError] = useState('');
	const [closing, setClosing] = useState<TerminalInfo | null>(null);
	const [dismissed, setDismissed] = useState('');
	const [loaded, setLoaded] = useState(false),
		[starting, setStarting] = useState(false),
		[resumable, setResumable] = useState(false);
	const startPending = useRef(false),
		loadVersion = useRef(0),
		sessionKnown = useRef(false);
	const mount = useRef<HTMLDivElement>(null),
		linkTip = useRef<HTMLDivElement>(null);
	const terminal = useRef<Terminal | null>(null);
	const turnRef = useRef(focusTurn);
	turnRef.current = focusTurn;
	const jumpRef = useRef<() => void>(() => {});
	const [anchorMissing, setAnchorMissing] = useState(false);
	useEffect(() => {
		jumpRef.current();
	}, [focusTurn]);
	const closedRef = useRef(onClosed);
	closedRef.current = onClosed;
	const restoredRef = useRef(restored);
	restoredRef.current = restored;
	const [ended, setEnded] = useState(false),
		[reopening, setReopening] = useState(false);
	const selected =
		role === 'console'
			? items.find((item) => item.id === session)
			: (items.find((item) => item.id === terminalActive[role]) ?? items[0]);
	// spec/task-window-workspace#terminal-close: the tab's × asks here only while a command runs (TaskView sets `terminalClosing`); a shell at its prompt closes.
	useEffect(() => {
		if (role !== 'console' || !terminalClosing || terminalClosing !== session || !loaded) return;
		setTask({ terminalClosing: null });
		if (!selected) onClosed?.();
		else if (selected.exited) void close(selected);
		else
			void load().then(
				(all) => {
					const fresh = all.find((item) => item.id === selected.id);
					if (!fresh) onClosed?.();
					else if (fresh.exited || !closeAsks(fresh)) void close(fresh);
					else setClosing(fresh);
				},
				() => setClosing(selected)
			);
	}, [terminalClosing, session, loaded, selected?.id]);
	// spec/terminal-and-cli-agents#cli-start: a new CLI task is `queued` until its first turn; main is already starting its agent, so no Start button meanwhile.
	const launching =
		role === 'agent' && loaded && !selected && !resumable && task.status === 'queued';
	/** spec/notifications-slack-notes-and-schedules#message-classes: each failure is its own toast that names the action; the start of a CLI agent stays on its launch stage (class B). */
	const fail = (key: MessageKey, options: { retry?: () => void; warning?: boolean } = {}) =>
		notify(options.warning ? 'warning' : 'error', t(locale, key), {
			action: options.retry ? { label: t(locale, 'Retry'), run: options.retry } : undefined,
		});
	/** The first read of the agent's terminal list feeds its launch stage, which shows the failure with Retry; any other read is a toast. */
	const listFailed = (stage = false) => {
		if (stage && role === 'agent') setLaunchError(t(locale, 'Could not read the terminal list.'));
		else
			fail('Could not read the terminal list.', {
				warning: true,
				retry: () => {
					void load().catch(() => listFailed());
				},
			});
	};
	async function load() {
		const version = ++loadVersion.current;
		const [value, activity] = await Promise.all([
			window.brigadir.terminalCommand(task, { kind: 'list' }),
			role === 'agent' && !sessionKnown.current
				? window.brigadir.readSessionActivity(task)
				: Promise.resolve(null),
		]);
		const all = value as TerminalInfo[];
		// spec/task-window-workspace#work-area: a session the host no longer has takes its tab with it.
		if (
			version === loadVersion.current &&
			role === 'console' &&
			!all.some((item) => item.id === session)
		) {
			if (restoredRef.current) setEnded(true);
			else closedRef.current?.();
		}
		if (version === loadVersion.current) {
			setItems(all.filter((item) => item.role === role));
			if (activity) {
				sessionKnown.current = activity.started;
				setResumable(sessionKnown.current);
			}
			setLoaded(true);
		}
		return all;
	}
	async function start() {
		if (startPending.current) return;
		startPending.current = true;
		setStarting(true);
		setLaunchError('');
		try {
			await window.brigadir.startSession(task);
			await load();
		} catch {
			setLaunchError(t(locale, 'Could not start the agent.'));
		} finally {
			startPending.current = false;
			setStarting(false);
		}
	}
	function retryLoad() {
		setLaunchError('');
		void load().catch(() => listFailed(true));
	}
	useEffect(() => {
		let active = true;
		void load().catch(() => {
			if (active) listFailed(true);
		});
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id === task.id && key.projectId === task.projectId) {
				if (record?.event.kind === 'session.started') {
					sessionKnown.current = true;
					setResumable(true);
				}
				if (!record || terminalListEvents.has(record.event.kind)) void load().catch(() => {});
			}
		});
		return () => {
			active = false;
			loadVersion.current++;
			stop();
		};
	}, [task.id, task.projectId, role]);
	useEffect(() => {
		const id = role === 'console' ? session : terminalActive[role];
		if (id && !items.some((item) => item.id === id)) void load().catch(() => listFailed());
	}, [terminalActive[role], session]);
	// spec/search-menus-and-commands#project-commands: a command tab started from the toolbar or search, its port and its exit reach every tab, not only the shown one.
	useEffect(() => {
		if (role !== 'console') return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = window.brigadir.onTerminalEvent(({ key, event }) => {
			if (key.id !== task.id || key.projectId !== task.projectId || (!event.run && !event.exited))
				return;
			clearTimeout(timer);
			timer = setTimeout(() => void load().catch(() => {}), 60);
		});
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [task.id, task.projectId, role, selected?.id]);
	useEffect(() => {
		if (!selected || !mount.current) return;
		let disposed = false;
		let ready = false;
		let exited = selected.exited;
		let seq = 0;
		const queued: TerminalEvent[] = [];
		const readTheme = () => {
			const css = getComputedStyle(document.documentElement);
			return {
				// spec/task-window-workspace#tool-tab-look: a CLI task has the console's `--term`, as the host tells the CLI in OSC 11.
				background: css.getPropertyValue('--term').trim(),
				foreground: css.getPropertyValue('--fg').trim(),
				cursor: css.getPropertyValue('--fg').trim(),
				selectionBackground: terminalColor(css.getPropertyValue('--accent-soft')),
			};
		};
		const instance = new Terminal({
			cols: selected.cols,
			rows: selected.rows,
			scrollback: 5000,
			allowProposedApi: true,
			rightClickSelectsWord: false,
			macOptionClickForcesSelection: true,
			...terminalTypography(),
			theme: readTheme(),
			cursorBlink: true,
			disableStdin: exited,
		});
		terminal.current = instance;
		const fit = new FitAddon();
		instance.loadAddon(fit);
		instance.open(mount.current);
		// spec/terminal-and-cli-agents#wheel: one line per line-height of travel, as a native terminal; Settings ▸ Appearance ▸ Terminal scales it.
		const scrollSpeed = () => useWorkspace.getState().appearance.terminalScrollSpeed ?? 1;
		instance.options.scrollSensitivity = scrollSpeed();
		const wheel = nativeWheel(
			instance,
			() => mount.current?.querySelector<HTMLElement>('.xterm-screen') ?? null,
			scrollSpeed,
			(data) => {
				if (ready && !exited)
					void window.brigadir
						.terminalCommand(task, { kind: 'input', id: selected.id, data })
						.catch(() => failed('Could not send the input to the terminal.'));
			},
			() => role === 'agent' && task.provider === 'codex'
		);
		// spec/terminal-and-cli-agents#console-links: ⌘-click links, the right-click menu, ⌘C / ⌘A; xterm keeps its selection out of the page's reach.
		const interactions = installTerminalInteractions(instance, mount.current, {
			task,
			locale,
			writable: () => ready && !exited,
			showAgent: () => {
				void compose();
			},
			clear: () => {
				void window.brigadir
					.terminalCommand(task, { kind: 'clear', id: selected.id })
					.catch(() => fail('Could not clear the terminal.'));
			},
			tip: (text, x = 0, y = 0) => {
				const node = linkTip.current;
				if (!node) return;
				node.hidden = !text;
				if (text) {
					node.textContent = text;
					node.style.left = `${x + 14}px`;
					node.style.top = `${y + 18}px`;
				}
			},
		});
		const speedWatch = useWorkspace.subscribe((state) => {
			const speed = state.appearance.terminalScrollSpeed ?? 1;
			if (instance.options.scrollSensitivity !== speed) instance.options.scrollSensitivity = speed;
		});
		let shownTheme = JSON.stringify(readTheme()),
			shownType = JSON.stringify(terminalTypography());
		// Focus republishes the same appearance: repaint only on a real theme or font change.
		const themeObserver = new MutationObserver(() => {
			const theme = readTheme(),
				type = terminalTypography();
			if (JSON.stringify(theme) !== shownTheme) {
				shownTheme = JSON.stringify(theme);
				instance.options.theme = theme;
			}
			if (JSON.stringify(type) !== shownType) {
				shownType = JSON.stringify(type);
				Object.assign(instance.options, type);
				resize();
			}
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'data-accent', 'data-accent-text', 'style'],
		});
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			instance.loadAddon(webgl);
		} catch {
			/* Native canvas/DOM renderer remains functional without WebGL. */
		}
		const parkedScroll = terminalScroll.get(selected.id);
		const rememberScroll = () => {
			if (ready && instance.buffer.active.type === 'normal') {
				const buffer = instance.buffer.active;
				const distance = Math.max(0, buffer.baseY - buffer.viewportY);
				terminalScroll.set(selected.id, { distance, follow: distance === 0 });
			}
		};
		const scroll = instance.onScroll(rememberScroll);
		let anchors: TerminalAnchor[] = [];
		let normal = true;
		let decoration: ReturnType<Terminal['registerDecoration']>;
		let marker: ReturnType<Terminal['registerMarker']>;
		const jump = () => {
			if (role !== 'agent' || !ready) return;
			decoration?.dispose();
			marker?.dispose();
			const target = anchors.find((anchor) => anchor.turn === turnRef.current);
			setAnchorMissing(Boolean(turnRef.current && (!normal || !target)));
			if (!turnRef.current || !normal || !target) return;
			instance.scrollToLine(target.line);
			const buffer = instance.buffer.active;
			marker = instance.registerMarker(target.line - buffer.baseY - buffer.cursorY);
			if (marker) {
				const end =
					anchors.find((anchor) => anchor.line > target.line)?.line ??
					buffer.baseY + buffer.cursorY + 1;
				decoration = instance.registerDecoration({
					marker,
					width: instance.cols,
					height: Math.max(1, end - target.line),
					layer: 'bottom',
				});
				decoration?.onRender((element) => {
					element.style.background = 'var(--accent-soft)';
					element.style.borderLeft = '2px solid var(--accent)';
				});
			}
		};
		jumpRef.current = jump;
		const failed = (key: MessageKey, warning = false) => {
			if (!disposed) fail(key, { warning });
		};
		const apply = (event: TerminalEvent) => {
			if (event.seq <= seq) return;
			seq = event.seq;
			if (event.anchors) {
				anchors = event.anchors;
				normal = event.normal !== false;
			}
			if (event.data) instance.write(event.data);
			if (event.block)
				setItems((items) =>
					items.map((item) =>
						item.id === event.id && event.block ? { ...item, block: event.block } : item
					)
				);
			if (event.exited) {
				exited = true;
				instance.options.disableStdin = true;
				void load().catch(() => failed('Could not read the terminal list.', true));
			}
		};
		const stop = window.brigadir.onTerminalEvent(({ key, event }) => {
			if (key.id !== task.id || key.projectId !== task.projectId || event.id !== selected.id)
				return;
			if (ready) apply(event);
			else queued.push(event);
		});
		// The local grid follows every frame; the PTY hears a size once it settles and only if it differs:
		// every SIGWINCH makes the agent's TUI redraw.
		let sent = '',
			resizeTimer: ReturnType<typeof setTimeout> | undefined;
		const sendSize = () => {
			resizeTimer = undefined;
			if (exited || disposed) return;
			const cols = Math.max(2, Math.min(500, instance.cols)),
				rows = Math.max(1, Math.min(200, instance.rows)),
				size = `${cols}x${rows}`;
			if (size === sent) return;
			sent = size;
			void window.brigadir
				.terminalCommand(task, { kind: 'resize', id: selected.id, cols, rows })
				.catch(() => {
					sent = '';
					failed('Could not resize the terminal.', true);
				});
		};
		const resize = () => {
			if (
				exited ||
				!ready ||
				disposed ||
				!mount.current?.clientWidth ||
				!mount.current.clientHeight
			)
				return;
			fit.fit();
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(sendSize, 120);
		};
		const input = instance.onData((data) => {
			if (ready && !exited) instance.scrollToBottom();
			if (ready && !exited)
				void window.brigadir
					.terminalCommand(task, { kind: 'input', id: selected.id, data })
					.catch(() => failed('Could not send the input to the terminal.'));
		});
		void window.brigadir.terminalCommand(task, { kind: 'read', id: selected.id }).then(
			(value) => {
				if (disposed) return;
				const state = value as TerminalSnapshot;
				exited = state.exited;
				instance.options.disableStdin = exited;
				setItems((items) =>
					items.map((item) =>
						item.id === state.id
							? {
									...item,
									exited: state.exited,
									exitCode: state.exitCode,
									...(state.block ? { block: state.block } : {}),
									...(state.run ? { run: state.run } : {}),
								}
							: item
					)
				);
				seq = state.seq;
				anchors = state.anchors ?? [];
				normal = state.normal !== false;
				instance.resize(state.cols, state.rows);
				sent = `${state.cols}x${state.rows}`;
				instance.write(state.data, () => {
					if (disposed) return;
					ready = true;
					queued.forEach(apply);
					queued.length = 0;
					resize();
					instance.write('', () => {
						if (disposed) return;
						if (parkedScroll && !parkedScroll.follow && instance.buffer.active.type === 'normal')
							instance.scrollToLine(
								Math.max(0, instance.buffer.active.baseY - parkedScroll.distance)
							);
						jump();
						instance.focus();
					});
				});
			},
			() => failed('Could not read the terminal output.', true)
		);
		const observer = new ResizeObserver(resize);
		observer.observe(mount.current);
		// `read` above started the host sending this terminal's output; the unmounted panel stops it. A host started before this ignores it.
		return () => {
			interactions.dispose();
			wheel.dispose();
			speedWatch();
			void window.brigadir
				.terminalCommand(task, { kind: 'unwatch', id: selected.id })
				.catch(() => {});
			rememberScroll();
			disposed = true;
			clearTimeout(resizeTimer);
			scroll.dispose();
			jumpRef.current = () => {};
			decoration?.dispose();
			marker?.dispose();
			stop();
			observer.disconnect();
			themeObserver.disconnect();
			input.dispose();
			instance.dispose();
			terminal.current = null;
		};
	}, [selected?.id, task.id, task.projectId, locale]);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (
					role !== 'console' ||
					document.querySelector('dialog[open]') ||
					!mount.current?.parentElement?.contains(document.activeElement)
				)
					return;
				if (action === 'terminal-compose') {
					void compose();
					return;
				}
				if (selected && action === 'terminal-clear')
					void window.brigadir
						.terminalCommand(task, { kind: 'clear', id: selected.id })
						.catch(() => fail('Could not clear the terminal.'));
				if (selected && !selected.exited && action === 'cancel')
					void window.brigadir
						.terminalCommand(task, { kind: 'input', id: selected.id, data: '\x03' })
						.catch(() => fail('Could not interrupt the terminal process.'));
				if (selected && ['terminal-next', 'terminal-previous'].includes(action))
					onStep?.(action === 'terminal-next' ? 1 : -1);
			}),
		[role, selected, items]
	);
	/** A saved command restarts in its own tab; a «Run once» line runs again in a new tab that replaces the finished one. */
	async function rerun(item: TerminalInfo) {
		try {
			if (item.run?.commandId) await runCommand(task, { commandId: item.run.commandId });
			else if (item.run) {
				const line = item.run.line;
				await runCommand(task, { line });
				if (item.exited)
					await window.brigadir.terminalCommand(task, { kind: 'close', id: item.id });
				await load();
			}
		} catch {
			fail('Could not run the command.', {
				retry: () => {
					void rerun(item);
				},
			});
		}
	}
	/** spec/task-window-workspace#restore-window: a new shell in the ended session's folder, in the same tab place. */
	async function reopen() {
		if (reopening) return;
		setReopening(true);
		try {
			const directory = restoredRef.current?.directory;
			const item = (await window.brigadir.terminalCommand(task, {
				kind: 'create',
				role: 'console',
				...(directory ? { directory } : {}),
			})) as TerminalInfo;
			onReopen?.(item);
		} catch {
			fail('Could not open a new terminal.', {
				retry: () => {
					void reopen();
				},
			});
		} finally {
			setReopening(false);
		}
	}
	async function close(item: TerminalInfo) {
		try {
			await window.brigadir.terminalCommand(task, { kind: 'close', id: item.id });
			setClosing(null);
			await load();
			if (role === 'console') onClosed?.();
		} catch {
			fail('Could not close the terminal.', {
				retry: () => {
					void close(item);
				},
			});
		}
	}
	async function compose() {
		if (!selected) return;
		try {
			let text = terminal.current?.getSelection();
			if (!text && selected.block?.exitCode !== null && selected.block)
				text = (await window.brigadir.terminalCommand(task, {
					kind: 'text',
					id: selected.id,
				})) as string;
			if (!text && terminal.current) {
				const view = terminal.current;
				const buffer = view.buffer.active;
				const lines = [];
				for (
					let i = buffer.viewportY;
					i < Math.min(buffer.length, buffer.viewportY + view.rows);
					i++
				)
					lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
				text = lines.join('\n').slice(0, 16384);
			}
			if (text?.trim())
				await attachTaskContext(task, {
					kind: 'text',
					name: t(locale, 'Terminal output'),
					text: `Terminal output (${selected.title}):\n${text}`,
				});
		} catch {
			fail('Could not show the terminal output to the agent.');
		}
	}
	return (
		<section
			{...(role === 'agent'
				? fileDropHandlers(task, () => fail('Could not attach the file.'))
				: {})}
			className={styles.panel}
			data-role={role}
			data-menu-terminal-count={items.filter((item) => item.role === 'console').length}
			data-menu-terminal-alive={!!selected && !selected.exited}
			data-menu-terminal-output={!!selected?.block}
			data-font-surface="terminal"
			aria-label={t(locale, role === 'console' ? 'Console' : 'Agent')}>
			{role === 'console' && selected?.run && (
				<header data-size="s">
					{selected?.run && (
						<div className={styles.runActions}>
							<code title={selected.run.line}>{selected.run.line}</code>
							{runState(selected) === 'running' && selected.run.port && (
								<Button
									appearance="primary"
									variant="soft"
									className={styles.port}
									title={t(locale, 'Open in browser')}
									onClick={() => {
										void openCommandPort(task, selected).catch(() =>
											fail('Could not open the port in the browser.')
										);
									}}>
									:{selected.run.port}
								</Button>
							)}
							{!selected.exited ? (
								<>
									{selected.run.commandId && commandsOn && (
										<IconButton
											label={t(locale, 'Restart')}
											title={withShortcut(t(locale, 'Restart'), shortcut('command-run'))}
											onClick={() => {
												void rerun(selected);
											}}>
											<Glyph name="refresh" size={13} />
										</IconButton>
									)}
									<IconButton
										label={t(locale, 'Stop')}
										title={withShortcut(t(locale, 'Stop'), shortcut('command-stop'))}
										onClick={() => {
											void stopCommand(task, selected).catch(() =>
												fail('Could not stop the command.')
											);
										}}>
										<Glyph name="command-stop" size={11} />
									</IconButton>
								</>
							) : (
								commandsOn && (
									<IconButton
										className={styles.run}
										label={t(locale, 'Run again')}
										title={t(locale, 'Run again')}
										onClick={() => {
											void rerun(selected);
										}}>
										<Glyph name="command-play" size={11} />
									</IconButton>
								)
							)}
						</div>
					)}
				</header>
			)}
			{closing && (
				<div className={styles.confirmClose} data-size="s" role="alert">
					<span>
						{t(locale, 'Stop this terminal process?')} {closing.title}
					</span>
					<Button onClick={() => setClosing(null)}>{t(locale, 'Cancel')}</Button>
					{/* Closing a live tab: Stop is the solid red action. */}
					<Button
						appearance="danger"
						variant="solid"
						onClick={() => {
							void close(closing);
						}}>
						{t(locale, 'Stop')}
					</Button>
				</div>
			)}
			{role === 'agent' && (!selected || selected.exited || starting) && (
				<AgentLaunchState
					{...(onRelay ? { onRelay } : {})}
					task={task}
					locale={locale}
					loading={!loaded}
					starting={starting || launching}
					resumable={resumable}
					error={
						launchError ||
						(!starting && selected?.exited && selected.exitCode !== 0
							? t(locale, 'The agent exited with code {code}.').replace(
									'{code}',
									String(selected.exitCode)
								)
							: '')
					}
					onStart={() => {
						void start();
					}}
					onRetry={retryLoad}
				/>
			)}
			{role === 'agent' && returnToDiff && (
				<Button onClick={() => setTask({ surface: 'diff', focusTurn: null, returnToDiff: false })}>
					{t(locale, 'Back to diff')}
				</Button>
			)}
			{role === 'agent' && focusTurn && (
				<div className={styles.failure} data-size="s">
					<span>
						{t(locale, 'Turn')} {focusTurnNumber ?? ''}
						{anchorMissing
							? ` · ${t(locale, 'This turn is no longer in the terminal buffer.')}`
							: ''}
					</span>
					<Button onClick={() => setTask({ focusTurn: null })}>{t(locale, 'Dismiss')}</Button>
				</div>
			)}
			<div ref={linkTip} className={styles.linkTip} role="tooltip" hidden />
			<div
				className={styles.mount}
				data-launch-hidden={role === 'agent' && (!selected || selected.exited || starting)}
				aria-label={t(locale, 'Terminal output')}>
				{/* spec/terminal-and-cli-agents#render-and-theme: FitAddon measures the terminal's parent and takes off only the terminal's own padding; under
				    border-box the padded mount counted 12 px too many and the last row went under the edge. */}
				<div ref={mount} className={styles.grid} />
				{/* spec/notifications-slack-notes-and-schedules#notice-chips: a CLI's input box is in the bottom rows of its TUI; toasts stand over them, not on them. */}
				{role === 'agent' && <div className={styles.inputRows} data-toast-avoid aria-hidden />}
			</div>
			{role === 'console' &&
				selected?.block &&
				selected.block.exitCode !== null &&
				![0, 130].includes(selected.block.exitCode) &&
				dismissed !== `${selected.id}/${selected.block.id}` && (
					<div className={styles.failure} data-size="s" data-failed="true" role="status">
						<span>
							{t(locale, 'Exit')} {selected.block.exitCode} · {selected.block.command}
						</span>
						<Button
							onClick={() => {
								void compose();
							}}>
							{t(locale, 'Show the agent')}
						</Button>
						<IconButton
							variant="soft"
							label={t(locale, 'Dismiss')}
							onClick={() => setDismissed(`${selected.id}/${selected.block!.id}`)}>
							×
						</IconButton>
					</div>
				)}
			{role === 'console' &&
				selected?.run &&
				runState(selected) === 'failed' &&
				dismissed !== selected.id && (
					<div className={styles.failure} data-size="s" data-failed="true" role="status">
						<span>
							{t(locale, 'Exit')} {selected.exitCode} · {selected.title}
						</span>
						<Button
							onClick={() => {
								void rerun(selected);
							}}>
							{t(locale, selected.run.commandId ? 'Restart' : 'Run again')}
						</Button>
						<Button
							onClick={() => {
								void compose();
							}}>
							{t(locale, 'Show the agent')}
						</Button>
						<IconButton
							variant="soft"
							label={t(locale, 'Dismiss')}
							onClick={() => setDismissed(selected.id)}>
							×
						</IconButton>
					</div>
				)}
			{role === 'console' && selected?.run && runState(selected) === 'stopped' && (
				<div className={styles.failure} data-size="s" data-stopped="true" role="status">
					<span>{t(locale, 'Stopped by you · the output stays until the tab is closed')}</span>
					<Button
						onClick={() => {
							void rerun(selected);
						}}>
						{t(locale, 'Run again')}
					</Button>
				</div>
			)}
			{role === 'console' && ended && !selected && (
				<div
					className={styles.failure}
					data-size="s"
					data-stopped="true"
					data-session-ended
					role="status">
					<span>{t(locale, 'Session ended')}</span>
					<Button
						disabled={reopening}
						onClick={() => {
							void reopen();
						}}>
						{t(locale, 'Open again')}
					</Button>
				</div>
			)}
			{role === 'console' && selected?.exited && !selected.run && (
				<p>
					{t(locale, 'Exit')} {selected.exitCode}
				</p>
			)}
		</section>
	);
}
