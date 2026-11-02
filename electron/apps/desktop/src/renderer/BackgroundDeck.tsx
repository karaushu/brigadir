import { useEffect, useRef, useState } from 'react';
import {
	backgroundDeck,
	backgroundSettleMs,
	formatDuration,
	t,
	type AgentTask,
	type BackgroundCommand,
	type EventRecord,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { Deck, DeckList, DeckRow } from './ui/Deck';
import { Button, IconButton, StatusIcon } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { Popover } from './ui/Popover';
import { useSecondTick } from './ui/second-tick';
import { notify } from './ui/Toast';
import styles from './BackgroundDeck.module.css';

const status = (command: BackgroundCommand): AgentTask['status'] =>
	command.state === 'running'
		? 'working'
		: command.state === 'completed'
			? 'done'
			: command.state === 'failed'
				? 'failed'
				: 'interrupted';
/**
 * spec/chat-turns-plans-and-questions#background-commands: what the agent left running after its turn, on the deck over the island. A row opens Output
 * (the tail of the command's output, read by the host), Stop stops it. A finished row stays 4 s; a failed one until
 * the agent's next turn or Remove; a stopped one leaves at once.
 */
export function BackgroundDeck({
	task,
	records,
	locale,
	send,
	queue,
}: {
	task: AgentTask;
	records: readonly EventRecord[];
	locale: Locale;
	send(command: SessionCommand): Promise<boolean>;
	/** The queue's own list, under the background one in the same deck. */ queue: React.ReactNode;
}) {
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	const [open, setOpen] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const rows = backgroundDeck(records, now, dismissed);
	// A finished row leaves after its settle time: one timer for the earliest of them.
	const leaving = rows
		.filter((command) => command.state === 'completed')
		.map((command) => command.finishedAt! + backgroundSettleMs - now);
	useEffect(() => {
		if (!leaving.length) return;
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...leaving)) + 20);
		return () => clearTimeout(timer);
	}, [leaving.join(',')]);
	useEffect(() => {
		setNow(Date.now());
	}, [records.length]);
	if (!rows.length && !queue) return null;
	const live = rows.filter((command) => command.state === 'running').length;
	return (
		<Deck data-background-deck={rows.length ? true : undefined}>
			{rows.length > 0 && (
				<DeckList label={t(locale, 'Background commands')} data-background-list>
					{rows.map((command, index) => (
						<BackgroundRow
							key={command.id}
							task={task}
							command={command}
							locale={locale}
							send={send}
							label={
								index === 0
									? t(locale, 'In the background · {count}').replace(
											'{count}',
											new Intl.NumberFormat(locale).format(live || rows.length)
										)
									: ''
							}
							open={open === command.id}
							onOpen={(value) => setOpen(value ? command.id : null)}
							onDismiss={() => setDismissed((current) => new Set([...current, command.id]))}
						/>
					))}
				</DeckList>
			)}
			{queue}
		</Deck>
	);
}

function BackgroundRow({
	task,
	command,
	locale,
	label,
	send,
	open,
	onOpen,
	onDismiss,
}: {
	task: AgentTask;
	command: BackgroundCommand;
	locale: Locale;
	label: string;
	send(command: SessionCommand): Promise<boolean>;
	open: boolean;
	onOpen(open: boolean): void;
	onDismiss(): void;
}) {
	const running = command.state === 'running',
		now = useSecondTick(running),
		anchor = useRef<HTMLButtonElement>(null);
	// spec/chat-turns-plans-and-questions#turn-status-row: whole seconds, the first one not shown.
	const ms = Math.max(0, (command.finishedAt ?? now) - command.startedAt),
		elapsed = formatDuration(locale, Math.floor(ms / 1000) * 1000);
	const time =
		command.state === 'completed'
			? `${t(locale, 'background finished')} · ${elapsed}`
			: command.state === 'failed'
				? `${t(locale, 'error')} · ${elapsed}`
				: ms >= 1000
					? elapsed
					: '';
	const word = t(
		locale,
		running
			? 'Working'
			: command.state === 'completed'
				? 'Done'
				: command.state === 'failed'
					? 'Error'
					: 'stopped'
	);
	const stop = () => {
		onOpen(false);
		void send({ kind: 'stopBackground', id: command.id }).then((done) => {
			if (done) notify('info', t(locale, 'The background command is stopped'));
		});
	};
	return (
		<DeckRow
			hover
			label={label}
			data-background-row={command.state}
			actions={
				<>
					{command.state !== 'completed' && (
						<Button
							size="s"
							variant="ghost"
							title={t(locale, 'Show the output')}
							onClick={() => onOpen(!open)}>
							<Glyph name="console" size={14} />
							{t(locale, 'Output')}
						</Button>
					)}
					{running && (
						<Button
							size="s"
							variant="ghost"
							title={t(locale, 'Stop the background command')}
							onClick={stop}>
							<Glyph name="command-stop" size={12} />
							{t(locale, 'Stop')}
						</Button>
					)}
					{command.state === 'failed' && (
						<IconButton size="s" label={t(locale, 'Remove')} onClick={onDismiss}>
							<Glyph name="close" size={14} />
						</IconButton>
					)}
				</>
			}>
			<button
				ref={anchor}
				type="button"
				className={styles.row}
				title={command.name}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => onOpen(!open)}>
				<StatusIcon status={status(command)} label={word} size={13} />
				<span className={styles.name}>{command.name}</span>
				<span className={styles.time} aria-hidden={running || undefined}>
					{time}
				</span>
			</button>
			<Popover
				open={open}
				onClose={() => onOpen(false)}
				anchor={anchor}
				label={t(locale, 'Output of the background command')}
				title={t(locale, 'Output')}
				note={command.name}
				locale={locale}
				side="top"
				width={560}
				size="l"
				headerExtra={
					running ? (
						<Button
							size="s"
							variant="ghost"
							title={t(locale, 'Stop the background command')}
							onClick={stop}>
							<Glyph name="command-stop" size={12} />
							{t(locale, 'Stop')}
						</Button>
					) : undefined
				}
				data-background-output>
				<Output task={task} command={command} locale={locale} />
			</Popover>
		</DeckRow>
	);
}

/** spec/chat-turns-plans-and-questions#background-commands: the last lines, read again every second while the command runs. */
function Output({
	task,
	command,
	locale,
}: {
	task: AgentTask;
	command: BackgroundCommand;
	locale: Locale;
}) {
	const [output, setOutput] = useState<{ text: string; missing: boolean } | null>(null),
		[failed, setFailed] = useState(false),
		box = useRef<HTMLPreElement>(null);
	const tick = useSecondTick(command.state === 'running');
	useEffect(() => {
		let active = true;
		void window.brigadir.backgroundOutput(task, command.id).then(
			(value) => {
				if (active) {
					setOutput(value);
					setFailed(false);
				}
			},
			() => {
				if (active) setFailed(true);
			}
		);
		return () => {
			active = false;
		};
	}, [
		task.id,
		task.projectId,
		command.id,
		command.outputPath,
		command.state === 'running' ? tick : command.state,
	]);
	useEffect(() => {
		const node = box.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [output?.text]);
	const empty = failed
		? t(locale, 'Could not read the output.')
		: output?.missing
			? t(locale, 'The output file is gone.')
			: t(locale, 'No output yet');
	return (
		<div className={styles.output}>
			<pre ref={box} data-empty={!output?.text || undefined}>
				{output?.text || empty}
			</pre>
			{command.state === 'running' && <p>{t(locale, 'Last lines · updates every second')}</p>}
		</div>
	);
}
