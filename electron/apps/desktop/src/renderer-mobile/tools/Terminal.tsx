/**
 * spec/remote-access-and-mobile#phone-task-tools: the task's command tabs for reading — `readCommandRuns` (only a host that already runs;
 * nothing starts), the chosen tab's output from `terminalCommand read` and `terminal:event`, xterm.js without input as the
 * computer's `ToolTerminal`. There is no field: a command is typed at the machine or asked of the agent in the chat.
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
	runState,
	t,
	type AgentTask,
	type Locale,
	type TerminalInfo,
	type TerminalSnapshot,
} from '@brigadir/core';
import { terminalColor } from '../../renderer/terminal-color';
import { Button } from '../../renderer/ui/Controls';
import { Chip, ChipRow } from '../ui/Chip';
import { BackButton, NavBar } from '../ui/Nav';
import { Caption } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { back } from '../router';
import { useMobile } from '../store';
import { useConnection } from '../context';
import { keyOf } from './data';
import screen from '../screens/Screen.module.css';
import { Loading } from '../ui/Loading';
import s from './Terminal.module.css';

function theme() {
	const css = getComputedStyle(document.documentElement),
		color = (name: string) => css.getPropertyValue(name).trim();
	return {
		background: color('--term'),
		foreground: color('--fg'),
		cursor: color('--term'),
		selectionBackground: terminalColor(color('--accent-soft')),
		red: color('--red'),
		brightRed: color('--red'),
		green: color('--green'),
		brightGreen: color('--green'),
		yellow: color('--amber'),
		brightYellow: color('--amber'),
		blue: color('--accent'),
		brightBlue: color('--accent'),
		brightBlack: color('--fg2'),
	};
}
function Output({ task, id }: { task: AgentTask; id: string }) {
	const mount = useRef<HTMLDivElement>(null),
		[atEnd, setAtEnd] = useState(true),
		terminal = useRef<XTerm | null>(null);
	const locale = useMobile((state) => state.locale);
	const connection = useConnection();
	useEffect(() => {
		const node = mount.current!;
		let disposed = false,
			seq = -1,
			// A `read` on its way: events wait for its snapshot, which may already hold them.
			reading = false;
		const queued: { seq: number; data: string }[] = [];
		const xterm = new XTerm({
				cols: 40,
				rows: 20,
				scrollback: 10000,
				fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
				fontSize: 12,
				// 12 / 18 in the design: the cell of a 12 px mono is about 14.4 px high.
				lineHeight: 1.25,
				disableStdin: true,
				cursorBlink: false,
				cursorInactiveStyle: 'none',
				convertEol: true,
				screenReaderMode: true,
				theme: theme(),
			}),
			fit = new FitAddon();
		terminal.current = xterm;
		xterm.loadAddon(fit);
		xterm.open(node);
		// WebGL draws the cells on a canvas; without it the DOM renderer colours them through `<style>` and `style=`, which
		// `adoptScriptStyles` turns into adopted style sheets under the phone's CSP (spec/remote-access-and-mobile#outbox).
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			xterm.loadAddon(webgl);
		} catch {
			// No WebGL on this phone: the DOM renderer.
		}
		// xterm keeps a helper field for typing; on a phone a tap on it would raise the keyboard. Nothing is typed here.
		const helper = node.querySelector('textarea');
		if (helper) {
			helper.readOnly = true;
			helper.tabIndex = -1;
			helper.setAttribute('inputmode', 'none');
		}
		const resize = () => {
			if (!disposed && node.clientWidth) fit.fit();
		};
		resize();
		const scrolled = () => {
			const buffer = xterm.buffer.active;
			setAtEnd(buffer.viewportY >= buffer.baseY);
		};
		const onScroll = xterm.onScroll(scrolled);
		const onWrite = xterm.onWriteParsed(scrolled);
		const stop = window.brigadir.onTerminalEvent(({ key, event }) => {
			if (key.projectId !== task.projectId || key.id !== task.id || event.id !== id || !event.data)
				return;
			if (reading || seq < 0) queued.push({ seq: event.seq, data: event.data });
			else if (event.seq > seq) {
				seq = event.seq;
				xterm.write(event.data);
			}
		});
		/**
		 * The snapshot and the watch (`read`). Asked again when the link comes back and when the phone wakes (spec/remote-access-and-mobile#outbox):
		 * a new connection is a new client on the machine, and a host that lost its watch sends nothing until read again.
		 * Output missed meanwhile — a newer snapshot — replaces the screen; the same one changes nothing.
		 */
		const load = () => {
			if (reading) return;
			reading = true;
			void window.brigadir
				.terminalCommand(keyOf(task), { kind: 'read', id })
				.then((value) => {
					if (disposed || !value || Array.isArray(value) || typeof value !== 'object') return;
					const snapshot = value as TerminalSnapshot;
					if (snapshot.seq > seq) {
						const first = seq < 0,
							end = first || xterm.buffer.active.viewportY >= xterm.buffer.active.baseY;
						if (!first) xterm.reset();
						xterm.write(snapshot.data, () => !disposed && end && xterm.scrollToBottom());
						seq = snapshot.seq;
					}
				})
				.catch(() => {})
				.finally(() => {
					reading = false;
					if (disposed || seq < 0) return;
					for (const item of queued.splice(0))
						if (item.seq > seq) {
							seq = item.seq;
							xterm.write(item.data);
						}
				});
		};
		load();
		const stopLink = connection.watchLink((state) => {
			if (state === 'up') load();
		});
		const wake = () => {
			if (document.visibilityState === 'visible') load();
		};
		document.addEventListener('visibilitychange', wake);
		const observer = new ResizeObserver(resize);
		observer.observe(node);
		const appearance = new MutationObserver(() => {
			xterm.options.theme = theme();
		});
		appearance.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		});
		return () => {
			disposed = true;
			stop();
			stopLink();
			document.removeEventListener('visibilitychange', wake);
			onScroll.dispose();
			onWrite.dispose();
			observer.disconnect();
			appearance.disconnect();
			xterm.dispose();
			terminal.current = null;
			// Main lets the host stop only when no other client still watches this output (spec/remote-access-and-mobile#phone-task-tools).
			void window.brigadir.terminalCommand(keyOf(task), { kind: 'unwatch', id }).catch(() => {});
		};
	}, [task.projectId, task.id, id, connection]);
	return (
		<div className={s.body}>
			<div ref={mount} className={s.output} data-terminal-output />
			{!atEnd && (
				<Button
					className={s.end}
					size="l"
					data-terminal-end
					onClick={() => terminal.current?.scrollToBottom()}>
					<Icon name="down" />
					{t(locale, 'To the end')}
				</Button>
			)}
		</div>
	);
}
export function Terminal({ task, locale }: { task: AgentTask; locale: Locale }) {
	const [runs, setRuns] = useState<TerminalInfo[] | null>(null),
		[chosen, setChosen] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		const read = () =>
			void window.brigadir.readCommandRuns(keyOf(task)).then(
				(list) => live && setRuns(list),
				() => live && setRuns((current) => current ?? [])
			);
		read();
		// A run that starts or ends at the machine shows up here: its exit comes as an event, a new tab by reading again.
		const stop = window.brigadir.onTerminalEvent(({ key, event }) => {
			if (key.projectId === task.projectId && key.id === task.id && (event.exited || event.run))
				read();
		});
		const timer = setInterval(read, 5000);
		return () => {
			live = false;
			stop();
			clearInterval(timer);
		};
	}, [task.projectId, task.id]);
	const shown = runs?.find((run) => run.id === chosen) ?? runs?.[0] ?? null;
	return (
		<div className={screen.screen} data-screen="tool" data-tool="terminal">
			<NavBar
				left={<BackButton label={t(locale, 'Chat')} locale={locale} onClick={back} />}
				title={t(locale, 'Terminal')}
				sub={t(locale, 'output only')}
			/>
			{runs && runs.length > 0 && (
				<ChipRow role="tablist" label={t(locale, 'Terminal')} line>
					{runs.map((run) => {
						const state = runState(run);
						return (
							<Chip
								key={run.id}
								role="tab"
								selected={run.id === shown?.id}
								data={{ 'terminal-tab': run.run?.name ?? run.title }}
								onClick={() => setChosen(run.id)}>
								{(state === 'running' || state === 'starting') && <i className={s.dot} />}
								{run.run?.name ?? run.title}
								{run.exited && run.exitCode !== 0 && run.exitCode !== null && (
									<small>exit {run.exitCode}</small>
								)}
							</Chip>
						);
					})}
				</ChipRow>
			)}
			{shown ? (
				<Output key={shown.id} task={task} id={shown.id} />
			) : runs ? (
				<p className={`${screen.empty} ${s.none}`}>{t(locale, 'No commands run in this task')}</p>
			) : (
				<Loading locale={locale} />
			)}
			<div className={screen.bottom}>
				<Caption className={s.caption}>{t(locale, 'View only')}</Caption>
			</div>
		</div>
	);
}
