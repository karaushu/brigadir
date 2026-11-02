import { useState, type ReactNode, type SyntheticEvent } from 'react';
import {
	answerLine,
	formatDuration,
	subagentElapsed,
	t,
	tokenCount,
	toolCallCount,
	toolErrorCount,
	type Locale,
	type SubagentRow,
	type SubagentView,
} from '@brigadir/core';
import { Button, Chevron, StatusIcon } from './ui/Controls';
import { useSecondTick } from './ui/second-tick';
import styles from './SubagentBlock.module.css';

/**
 * spec/chat#subagents: a subagent is its own block on the place where it started. The header — status · «Subagent»
 * · type · name … calls · errors · time; under the collapsed header one line: the running call, the answer's first line, or the
 * state. Open: the prompt, the subagent's own rows (its calls fold into spec/chat#tool-groups groups) and the answer.
 */
export function SubagentBlock({
	row,
	view,
	locale,
	open,
	onToggle,
	onOpen,
	items,
	answer,
	live,
	summaryRef,
}: {
	row: SubagentRow;
	view: SubagentView;
	locale: Locale;
	open: boolean;
	onToggle(event: SyntheticEvent<HTMLDetailsElement>): void;
	onOpen(): void;
	/** The subagent's own rows, rendered by the conversation's one row engine (rule 6). */
	items: ReactNode;
	/** The answer as markdown blocks of the same engine; null while there is none. */
	answer: ReactNode;
	/** The running call as a pinned row under the collapsed header. */
	live: ReactNode;
	summaryRef?(node: HTMLElement | null): void;
}) {
	const now = useSecondTick(view.state === 'running'),
		[promptFull, setPromptFull] = useState(false),
		[answerFull, setAnswerFull] = useState(false);
	const status =
		view.state === 'running'
			? 'working'
			: view.state === 'completed'
				? 'done'
				: view.state === 'failed'
					? 'failed'
					: 'interrupted';
	const label = t(
		locale,
		view.state === 'running'
			? 'Working'
			: view.state === 'completed'
				? 'Done'
				: view.state === 'failed'
					? 'Error'
					: 'Interrupted'
	);
	const elapsed = subagentElapsed(row, now),
		time = formatDuration(locale, elapsed >= 1000 ? Math.floor(elapsed / 1000) * 1000 : elapsed);
	const calls = toolCallCount(locale, view.calls);
	const meta = [row.model, row.tokens !== undefined ? tokenCount(locale, row.tokens) : null]
		.filter(Boolean)
		.join(' · ');
	const line = view.answer ? answerLine(view.answer) : null;
	return (
		<div className={styles.block} data-subagent={view.state}>
			<details open={open} onToggle={onToggle}>
				<summary
					ref={summaryRef}
					data-subagent-head
					title={[t(locale, 'Subagent'), row.type, row.name, calls].filter(Boolean).join(' · ')}>
					<Chevron />
					<StatusIcon status={status} label={label} />
					<strong>{t(locale, 'Subagent')}</strong>
					{row.type && <span className={styles.type}>{row.type}</span>}
					<span className={styles.dot} aria-hidden="true">
						·
					</span>
					<span className={styles.name}>{row.name}</span>
					<span className={styles.spacer} />
					<small className={styles.count}>{calls}</small>
					{view.errors > 0 && view.state !== 'failed' && (
						<span className={styles.errors}>{toolErrorCount(locale, view.errors)}</span>
					)}
					{view.state === 'failed' && <span className={styles.errors}>{t(locale, 'error')}</span>}
					{view.state === 'cancelled' || view.state === 'interrupted' ? (
						<>
							<span className={styles.dot} aria-hidden="true">
								·
							</span>
							<small className={styles.count}>{t(locale, 'interrupted')}</small>
						</>
					) : null}
					<span className={styles.dot} aria-hidden="true">
						·
					</span>
					<small className={styles.time}>{time}</small>
				</summary>
				<div className={styles.body}>
					{row.prompt && (
						<section className={styles.section}>
							<h4>{t(locale, 'Prompt')}</h4>
							<p className={styles.prompt} data-full={promptFull || undefined}>
								{row.prompt}
							</p>
							<Button
								size="s"
								appearance="primary"
								variant="ghost"
								className={styles.more}
								onClick={() => setPromptFull((value) => !value)}>
								{t(locale, promptFull ? 'Show less' : 'Show in full')}
							</Button>
						</section>
					)}
					{items}
					{answer ? (
						<section className={styles.section}>
							<h4>{t(locale, 'Answer')}</h4>
							<div className={styles.answer} data-full={answerFull || undefined}>
								{answer}
							</div>
							<Button
								size="s"
								appearance="primary"
								variant="ghost"
								className={styles.more}
								onClick={() => setAnswerFull((value) => !value)}>
								{t(locale, answerFull ? 'Show less' : 'Show in full')}
							</Button>
						</section>
					) : view.state === 'running' ||
					  view.state === 'cancelled' ||
					  view.state === 'interrupted' ? (
						<p className={styles.wait}>
							{t(
								locale,
								view.state === 'running'
									? 'The answer comes when the subagent finishes'
									: 'Stopped before the answer'
							)}
						</p>
					) : null}
					{meta && <p className={styles.meta}>{meta}</p>}
				</div>
			</details>
			{!open &&
				(view.live ? (
					<div className={styles.pin}>{live}</div>
				) : line ? (
					<div className={styles.pin}>
						<button type="button" className={styles.line} title={line} onClick={onOpen}>
							{line}
						</button>
					</div>
				) : null)}
		</div>
	);
}
