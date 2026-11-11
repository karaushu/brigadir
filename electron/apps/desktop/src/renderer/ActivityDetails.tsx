import { FileLinkText } from './FileLinks';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	backgroundWorkCount,
	formatDuration,
	t,
	type BackgroundCommand,
	type AgentTask,
	type Locale,
	type ToolDiffPreview,
	type TurnChanges,
	type TurnSummary,
} from '@brigadir/core';
import { useTaskState, rowPosition } from './task-state';
import { lineTokens } from './syntax';
import { DiffCode } from './ui/DiffCode';
import { Rows } from './ui/Rows';
import { Glyph } from './ui/Glyph';
import { FilePath } from './ui/FilePath';
import { Button, IconButton, StatusIcon } from './ui/Controls';
import styles from './ActivityDetails.module.css';
import { ChangeCounts } from './ui/ChangeCounts';
import { useSecondTick } from './ui/second-tick';
import { toastError, toastWarning } from './ui/Toast';
import { SkeletonText } from './ui/Loading';
export function ToolDiff({
	task,
	seq,
	index,
	locale,
	revision = 0,
}: {
	task: AgentTask;
	seq: number;
	index: number;
	locale: Locale;
	revision?: number;
}) {
	const [preview, setPreview] = useState<ToolDiffPreview | null>(null),
		[error, setError] = useState(false);
	const [{ positions }, setTask] = useTaskState(task);
	const [opening, setOpening] = useState(false),
		[unchanged, setUnchanged] = useState(false);
	async function openCurrent() {
		if (opening) return;
		setOpening(true);
		setUnchanged(false);
		try {
			const file = await window.brigadir.readToolChange(task, seq, index);
			setTask({
				changeRange: null,
				panel: 'changes',
				panelShown: true,
				filter: '',
				...(file
					? { selected: `${file.scopeId}/${file.path}`, surface: 'diff' }
					: { selected: null }),
			});
			setUnchanged(!file);
		} catch {
			const name = preview?.path.split('/').at(-1) || preview?.path || '';
			toastError(t(locale, 'Could not read the changes in {file}.').replace('{file}', name), {
				bold: name,
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void openCurrent();
					},
				},
			});
		} finally {
			setOpening(false);
		}
	}
	useEffect(() => {
		let active = true;
		setPreview(null);
		setError(false);
		void window.brigadir.readToolDiff(task, seq, index).then(
			(value) => {
				if (active) setPreview(value);
			},
			() => {
				if (active) setError(true);
			}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, seq, index]);
	const syntax = useMemo(
		() => ({
			old: lineTokens(preview?.beforeText ?? '', preview?.beforeSyntax?.tokens ?? []),
			new: lineTokens(preview?.afterText ?? '', preview?.afterSyntax?.tokens ?? []),
		}),
		[preview]
	);
	const rows = useMemo(
		() =>
			preview?.lines
				.map((line, index) => ({ ...line, id: String(index) }))
				.filter(
					(line, index, all) =>
						line.kind !== 'context' ||
						all.slice(Math.max(0, index - 3), index + 4).some((item) => item.kind !== 'context')
				) ?? [],
		[preview]
	);
	if (error) return <p role="status">{t(locale, 'The tool diff could not be read.')}</p>;
	if (!preview) return <SkeletonText lines={5} />;
	return (
		<div className={styles.toolDiff}>
			<header title={preview.path}>
				<FileLinkText text={preview.path} literal task={task} locale={locale} revision={revision} />
			</header>
			{preview.tooLarge ? (
				<p>{t(locale, 'This file is too large to display.')}</p>
			) : (
				<div
					role="button"
					tabIndex={0}
					aria-label={`${t(locale, 'Open current diff')} · ${preview.path}`}
					aria-disabled={opening}
					onClick={() => {
						if (!window.getSelection()?.toString()) void openCurrent();
					}}
					onKeyDown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							void openCurrent();
						}
					}}
					className={styles.code}
					style={{
						height: `min(240px, calc(var(--diff-line, 18px) * ${Math.max(1, rows.length)}))`,
					}}>
					<Rows
						rows={rows}
						position={rowPosition(positions, `tool/${seq}/${index}`)}
						label={`${t(locale, 'Tool diff')} · ${preview.path}`}
						estimatedHeight={18}
						followOutput={false}
						render={(line) => {
							const side = line.kind === 'removed' ? 'old' : 'new',
								number = side === 'old' ? line.oldLine : line.newLine;
							return (
								<DiffCode
									compact
									line={line}
									side={side}
									locale={locale}
									tokens={syntax[side].get(number ?? 0) ?? []}
								/>
							);
						}}
					/>
				</div>
			)}
			{unchanged && (
				<p role="status">{t(locale, 'This file has no changes in the current snapshot.')}</p>
			)}
		</div>
	);
}
export function TurnFooter({
	task,
	turn,
	locale,
	response,
	background = [],
}: {
	response: string;
	task: AgentTask;
	turn: TurnSummary;
	locale: Locale;
	/** spec/chat-turns-plans-and-questions#background-commands: the background commands this turn started — a chip «in background N» while they run, their summary after. */ background?: readonly BackgroundCommand[];
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	// spec/notifications-slack-notes-and-schedules#message-classes: failures are toasts that name the action; the footer keeps only `Copied`.
	function copy() {
		void window.brigadir.copyText(response).then(
			() => setCopied(true),
			() =>
				toastError(t(locale, 'Could not copy the response.'), {
					action: { label: t(locale, 'Retry'), run: copy },
				})
		);
	}
	async function menu() {
		try {
			const action = await window.brigadir.turnMenu(task, turn.seq);
			if (action === 'copy') copy();
			if (action === 'changes')
				setTask({ changeRange: turn.range, panel: 'changes', panelShown: true, filter: '' });
		} catch {
			toastError(t(locale, 'Could not open the menu.'));
		}
	}
	const [changes, setChanges] = useState<TurnChanges | null>(null);
	const [, setTask] = useTaskState(task);
	useEffect(() => {
		if (!turn.range) return;
		let active = true;
		void window.brigadir.readTurnChanges(task, turn.seq).then(
			(value) => {
				if (active) setChanges(value);
			},
			() => {
				if (active) toastWarning(t(locale, 'Could not read the turn changes.'));
			}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, turn.seq, turn.range?.current]);
	// spec/chat-turns-plans-and-questions#turn-footer: the file chips take at most two lines of the footer; the rest hide behind `Show all · N` at the end of the second line.
	const footer = useRef<HTMLElement>(null),
		[width, setWidth] = useState(0),
		[expanded, setExpanded] = useState(false),
		[fit, setFit] = useState<{ key: string; limit: number | null }>({ key: '', limit: null });
	const fitKey = `${turn.seq}:${changes?.files.length ?? 0}:${width}`,
		limit = expanded || fit.key !== fitKey ? null : fit.limit;
	useEffect(() => {
		const node = footer.current;
		if (!node) return;
		const observer = new ResizeObserver(([entry]) =>
			setWidth(Math.round(entry?.contentRect.width ?? 0))
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	useLayoutEffect(() => {
		const node = footer.current;
		if (
			!node ||
			expanded ||
			!changes?.files.length ||
			!width ||
			(fit.key === fitKey && fit.limit === null)
		)
			return;
		const first = node.querySelector<HTMLElement>('button');
		if (!first) return;
		const gap = parseFloat(getComputedStyle(node).rowGap) || 0,
			bottom = first.offsetTop + first.offsetHeight * 2 + gap + 1,
			overflows = (item: HTMLElement) => item.offsetTop + item.offsetHeight > bottom;
		const chips = [...node.querySelectorAll<HTMLElement>('[data-file-chip]')],
			more = node.querySelector<HTMLElement>('[data-show-all]');
		if (fit.key !== fitKey) {
			const fitting = chips.findIndex(overflows);
			setFit({ key: fitKey, limit: fitting < 0 ? null : fitting });
			return;
		}
		if (limit !== null && more && overflows(more) && limit > 0)
			setFit({ key: fitKey, limit: limit - 1 });
	});
	// On one line the chips stand on the right; once they wrap they follow the buttons.
	const [wrapped, setWrapped] = useState(false);
	useLayoutEffect(() => {
		const node = footer.current,
			first = node?.firstElementChild as HTMLElement | null,
			last = node?.lastElementChild as HTMLElement | null;
		if (!first || !last) return;
		const next = last.offsetTop > first.offsetTop + first.offsetHeight;
		if (next !== wrapped) setWrapped(next);
	});
	const files = changes ? (limit === null ? changes.files : changes.files.slice(0, limit)) : [];
	return (
		<footer
			ref={footer}
			className={styles.turnFooter}
			aria-label={`${t(locale, 'Turn')} ${turn.number}`}>
			<span>
				{t(
					locale,
					turn.status === 'interrupted'
						? 'Interrupted'
						: turn.status === 'failed'
							? 'Error'
							: 'Done'
				)}
				{turn.duration !== null ? ` · ${formatDuration(locale, turn.duration)}` : ''}
			</span>
			<IconButton size="s" label={t(locale, 'Copy response')} disabled={!response} onClick={copy}>
				<Glyph name="copy" size={14} />
			</IconButton>
			<IconButton
				size="s"
				label={t(locale, 'Turn actions')}
				onClick={() => {
					void menu();
				}}>
				<Glyph name="more" size={14} />
			</IconButton>
			{copied && <span role="status">{t(locale, 'Copied')}</span>}
			{background.length > 0 && <BackgroundChip commands={background} locale={locale} />}
			{!wrapped && <span className={styles.footSpacer} aria-hidden="true" />}
			{changes &&
				files.map((file) => (
					<button
						className={styles.fileChip}
						data-file-chip
						data-size="s"
						data-appearance="neutral"
						data-variant="soft"
						key={file.id}
						title={file.path}
						onClick={() =>
							setTask({
								changeRange: changes.range,
								selected: `${file.scopeId}/${file.path}`,
								surface: 'diff',
								panel: 'changes',
								panelShown: true,
							})
						}>
						<FilePath path={file.path} />
						{!file.binary && (
							<ChangeCounts
								additions={file.additions}
								deletions={file.deletions}
								locale={locale}
								tone="diff"
								split
							/>
						)}
					</button>
				))}
			{changes && limit !== null ? (
				<Button
					size="s"
					className={styles.chip}
					data-show-all
					aria-expanded={false}
					onClick={() => setExpanded(true)}>
					{t(locale, 'Show all')} · {changes.total}
				</Button>
			) : (
				<>
					{changes && changes.total > changes.files.length && (
						<Button
							size="s"
							className={styles.chip}
							onClick={() =>
								setTask({ changeRange: changes.range, panel: 'changes', panelShown: true })
							}>
							<Glyph name="diff" size={12} />
							{t(locale, 'Show changes')} · {changes.total}
						</Button>
					)}
					{expanded && (
						<Button
							size="s"
							className={styles.chip}
							aria-expanded
							onClick={() => setExpanded(false)}>
							{t(locale, 'Show less')}
						</Button>
					)}
				</>
			)}
		</footer>
	);
}

/** spec/chat-turns-plans-and-questions#background-commands: the turn left work in the background. A click brings the deck over the island into view and lights it up. */
function BackgroundChip({
	commands,
	locale,
}: {
	commands: readonly BackgroundCommand[];
	locale: Locale;
}) {
	const running = commands.filter((command) => command.state === 'running'),
		number = new Intl.NumberFormat(locale);
	const last = commands.reduce(
		(worst, command) =>
			command.state === 'failed'
				? command
				: worst.state === 'failed'
					? worst
					: command.state === 'stopped'
						? command
						: worst,
		commands[0]!
	);
	const status = running.length
		? 'working'
		: last.state === 'failed'
			? 'failed'
			: last.state === 'stopped'
				? 'interrupted'
				: 'done';
	const one = commands.length === 1 ? commands[0]! : null,
		elapsed = one?.finishedAt ? formatDuration(locale, one.finishedAt - one.startedAt) : null;
	const show = () => {
		const deck = document.querySelector<HTMLElement>('[data-background-deck]');
		if (!deck) return;
		deck.scrollIntoView({ block: 'nearest' });
		deck.animate(
			[
				{ boxShadow: 'inset 0 0 0 1.5px var(--accent)' },
				{ boxShadow: 'inset 0 0 0 1.5px transparent' },
			],
			{ duration: 900, easing: 'ease-out' }
		);
		deck.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
	};
	return (
		<Button
			size="s"
			className={styles.backgroundChip}
			data-background-chip={status}
			title={
				running.length
					? t(locale, 'Show background work')
					: commands.map((command) => command.name).join('\n')
			}
			onClick={show}
			disabled={!running.length && !commands.some((command) => command.state === 'failed')}>
			<StatusIcon
				status={status}
				label={t(
					locale,
					status === 'working'
						? 'Working'
						: status === 'failed'
							? 'Error'
							: status === 'interrupted'
								? 'stopped'
								: 'Done'
				)}
				size={12}
			/>
			{running.length ? (
				<>
					{t(locale, 'in background')}
					<small>{number.format(running.length)}</small>
				</>
			) : one ? (
				<>
					{t(locale, one.kind === 'subagent' ? 'subagent' : 'background command')}
					{elapsed && <small>{elapsed}</small>}
				</>
			) : (
				// spec/chat-turns-plans-and-questions#background-subagents: subagents and commands as two counts.
				backgroundWorkCount(
					locale,
					commands.length,
					commands.filter((command) => command.kind === 'subagent').length
				)
			)}
		</Button>
	);
}
export function ToolElapsed({
	startedAt,
	finishedAt,
	locale,
}: {
	startedAt: number;
	finishedAt: number | null;
	locale: Locale;
}) {
	const now = useSecondTick(finishedAt === null);
	return (
		<small className={styles.elapsed}>
			{formatDuration(locale, (finishedAt ?? now) - startedAt)}
		</small>
	);
}
