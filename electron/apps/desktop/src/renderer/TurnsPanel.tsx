import { formatTime } from '@brigadir/core';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
	t,
	turnSummarizer,
	type AgentTask,
	type ChangesSnapshot,
	type EventRecord,
	type Locale,
	type TurnChanges,
	type TurnSummary,
} from '@brigadir/core';
import { useTaskState, rowPosition } from './task-state';
import { Button } from './ui/Controls';
import { Rows } from './ui/Rows';
import { Glyph } from './ui/Glyph';
import { ChangeCounts } from './ui/ChangeCounts';
import { Highlight } from './ui/PanelSearch';
import styles from './TurnsPanel.module.css';
type Totals = { additions: number; deletions: number };
/** A finished turn's totals never change: cached per task and seq. */
const totals = new Map<string, Totals>();
const sum = (changes: TurnChanges): Totals =>
	changes.files.reduce(
		(value, file) => ({
			additions: value.additions + file.additions,
			deletions: value.deletions + file.deletions,
		}),
		{ additions: 0, deletions: 0 }
	);
/**
 * spec/pull-requests-and-ci#pr-panel: Turns is the third mode of the changes panel. A row is the state sign, «Turn N», +N −M and the time;
 * a click selects the turn and shows its changes below and in the chat. The header search filters turns by text.
 */
export function TurnsPanel({
	task,
	locale,
	records,
	query = '',
	changes,
}: {
	task: AgentTask;
	locale: Locale;
	records: EventRecord[];
	query?: string;
	changes: ChangesSnapshot | null;
}) {
	const [{ positions, focusTurn, changeRange }, setTask] = useTaskState(task);
	const summarize = useRef(turnSummarizer()).current;
	const turns = useMemo(() => summarize(records), [records]);
	const [counts, setCounts] = useState<Record<number, Totals>>({});
	useEffect(() => {
		let active = true;
		for (const turn of turns) {
			const key = `${task.projectId}/${task.id}/${turn.seq}`,
				cached = totals.get(key);
			if (!turn.range || turn.status === 'running') continue;
			if (cached) {
				setCounts((value) => (value[turn.seq] ? value : { ...value, [turn.seq]: cached }));
				continue;
			}
			void window.brigadir.readTurnChanges(task, turn.seq).then(
				(changes) => {
					const value = sum(changes);
					totals.set(key, value);
					if (active) setCounts((current) => ({ ...current, [turn.seq]: value }));
				},
				() => {}
			);
		}
		return () => {
			active = false;
		};
	}, [turns, task.projectId, task.id]);
	const shown = [...turns]
		.reverse()
		.filter(
			(turn) =>
				!query.trim() ||
				`${turn.title} ${t(locale, 'Turn')} ${turn.number}`
					.toLocaleLowerCase()
					.includes(query.trim().toLocaleLowerCase())
		);
	const selected = turns.find(
		(turn) =>
			turn.seq === focusTurn &&
			changeRange &&
			turn.range &&
			turn.range.base === changeRange.base &&
			turn.range.current === changeRange.current
	);
	const files = selected && changes ? changes.files : [];
	return (
		<div className={styles.panel}>
			<div
				className={styles.turns}
				style={{ '--turn-rows': Math.max(shown.length, 1) } as CSSProperties}>
				{shown.length ? (
					<Rows
						position={rowPosition(positions, 'turns')}
						rows={shown}
						role="list"
						label={t(locale, 'Turns')}
						// spec/task-window#panel: the newest turn is on top — the list does not follow its end, no «To latest».
						followOutput={false}
						estimatedHeight={46}
						render={(turn) => (
							<TurnRow
								turn={turn}
								locale={locale}
								query={query}
								counts={counts[turn.seq]}
								selected={focusTurn === turn.seq}
								open={() =>
									setTask({
										focusTurn: turn.seq,
										focusTurnNumber: turn.number,
										changeRange: turn.range,
										surface: 'chat',
										returnToDiff: false,
									})
								}
							/>
						)}
					/>
				) : (
					<p className={styles.hint}>{t(locale, query.trim() ? 'No matches' : 'No turns')}</p>
				)}
			</div>
			{selected && (
				<section
					className={styles.changes}
					aria-label={t(locale, 'Changes of turn {n}').replace('{n}', String(selected.number))}>
					<div className={styles.changesHead}>
						<span className={styles.tag}>
							{t(locale, 'Changes of turn {n}').replace('{n}', String(selected.number))}
						</span>
						<span className={styles.space} />
						{files.length > 0 && (
							<Button
								size="s"
								onClick={() => {
									const file = files[0]!;
									setTask({
										selected: `${file.scopeId}/${file.path}`,
										surface: 'diff',
										whyFile: file.id,
									});
								}}>
								{t(locale, 'Why did this change?')}
							</Button>
						)}
					</div>
					{files.map((file) => (
						<button
							type="button"
							key={file.id}
							className={styles.file}
							title={file.path}
							onClick={() =>
								setTask({ selected: `${file.scopeId}/${file.path}`, surface: 'diff' })
							}>
							<Glyph name="file" size={12} />
							<span className={styles.name}>{file.path.split('/').at(-1)}</span>
							<ChangeCounts
								additions={file.additions}
								deletions={file.deletions}
								locale={locale}
								className={styles.counts}
								split
							/>
						</button>
					))}
					{!files.length && <p className={styles.hint}>{t(locale, 'No changes')}</p>}
				</section>
			)}
		</div>
	);
}
function TurnRow({
	turn,
	locale,
	query,
	counts,
	selected,
	open,
}: {
	turn: TurnSummary;
	locale: Locale;
	query: string;
	counts: Totals | undefined;
	selected: boolean;
	open(): void;
}) {
	const status =
		turn.status === 'running'
			? t(locale, 'Running')
			: turn.status === 'done'
				? t(locale, 'Done')
				: turn.status === 'failed'
					? t(locale, 'Failed')
					: t(locale, 'Interrupted');
	return (
		<button
			type="button"
			className={styles.turn}
			data-status={turn.status}
			aria-pressed={selected}
			onClick={open}
			title={`${t(locale, 'Turn')} ${turn.number} · ${status}`}>
			<span className={styles.line}>
				<span className={styles.icon} role="img" aria-label={status}>
					{turn.status === 'running' ? (
						<Glyph name="check-run" size={13} />
					) : turn.status === 'done' ? (
						<Glyph name="turn-done" size={13} />
					) : turn.status === 'failed' ? (
						<Glyph name="check-fail" size={13} />
					) : (
						<Glyph name="agent-stopped" size={13} />
					)}
				</span>
				<strong>
					{t(locale, 'Turn')} {turn.number}
				</strong>
				<span className={styles.space} />
				{counts && (counts.additions > 0 || counts.deletions > 0) && (
					<>
						<ChangeCounts
							additions={counts.additions}
							deletions={counts.deletions}
							locale={locale}
							className={styles.counts}
							split
						/>
					</>
				)}
				<small>{turn.status === 'running' ? t(locale, 'now') : formatTime(turn.at)}</small>
			</span>
			{turn.title && (
				<span className={styles.summary}>
					<Highlight text={turn.title} query={query} />
				</span>
			)}
		</button>
	);
}
