import { useMemo, useState } from 'react';
import {
	formatDuration,
	providerName,
	smokeCounts,
	smokeLeftMs,
	smokeLimits,
	smokeOpen,
	smokeRunOf,
	t,
	type AgentTask,
	type EventRecord,
	type Locale,
	type SessionCommand,
	type SessionEvent,
	type SmokeStep,
} from '@brigadir/core';
import { Button, IconButton } from './ui/Controls';
import { DeckFill, DeckList, DeckRow, DeckRowButton, DeckRowGlyph, DeckRowText } from './ui/Deck';
import { Glyph, type GlyphName } from './ui/Glyph';
import { useSecondTick } from './ui/second-tick';
import { TextLink } from './ui/TextLink';
import { setTaskBrowser, setTaskSimulator } from './task-state';
import service from './Crew.module.css';
import styles from './SmokeRun.module.css';

const minute = 60_000;
/** spec/smoke-run#deck: `6:12`, the time left of the run's limit. */
const clock = (ms: number) => {
	const seconds = Math.ceil(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const agentName = (task: AgentTask) => (task.provider ? providerName(task.provider) : 'Agent');
/** spec/smoke-run#deck: the deck row is shown while a run is open. */
export function useSmokeRun(records: readonly EventRecord[]) {
	const run = useMemo(() => smokeRunOf(records), [records]);
	return smokeOpen(run) ? run : null;
}
/**
 * spec/smoke-run#deck: the smoke run's own row in the composer deck — the time left of its limit, `+5 min` and `Stop` while it runs, the agent
 * writing its report once it stopped; the chevron (or the row) opens its steps.
 */
export function SmokeStrip({
	task,
	records,
	locale,
	disabled,
	send,
	open: initial = false,
}: {
	task: AgentTask;
	records: readonly EventRecord[];
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
	/** Starts expanded (the tests: a server render cannot click the chevron). */
	open?: boolean;
}) {
	const run = useSmokeRun(records),
		[shown, setShown] = useState(initial),
		running = run?.state === 'running',
		now = useSecondTick(running);
	if (!run) return null;
	const left = smokeLeftMs(run, now),
		limit = Math.round(run.limitMs / minute),
		last = running && left <= minute,
		agent = agentName(task);
	const line = running
		? t(locale, '{time} left of {n} min')
				.replace('{time}', clock(left))
				.replace('{n}', String(limit))
		: `${
				run.cause === 'person'
					? t(locale, 'stopped by you')
					: t(locale, 'stopped at {n} min').replace('{n}', String(limit))
			} · ${t(locale, '{agent} writes the report').replace('{agent}', agent)}`;
	const extendable =
		run.limitMs + smokeLimits.extendMinutes * minute <= smokeLimits.maxMinutes * minute;
	return (
		<>
			<DeckList label={t(locale, 'Smoke run')} data-smoke-strip={run.state}>
				<DeckRow
					hover
					tone={last ? 'amber' : undefined}
					data-smoke-last={last || undefined}
					label={
						<DeckRowGlyph>
							<Glyph name={running ? 'agent-spinner' : 'stop'} size={12} />
						</DeckRowGlyph>
					}
					actions={
						<>
							{running && (
								<>
									<Button
										size="s"
										variant="ghost"
										disabled={disabled || !extendable}
										title={t(locale, 'Give 5 more minutes')}
										onClick={() => send({ kind: 'extendSmoke', id: run.id })}>
										{t(locale, '+5 min')}
									</Button>
									<Button
										size="s"
										variant="ghost"
										disabled={disabled}
										title={t(locale, 'Stop the smoke run')}
										onClick={() => send({ kind: 'stopSmoke', id: run.id })}>
										{t(locale, 'Stop')}
									</Button>
								</>
							)}
							<IconButton
								size="s"
								label={t(locale, shown ? 'Collapse' : 'Expand')}
								aria-expanded={shown}
								onClick={() => setShown(!shown)}>
								<Glyph name="chevron-down" size={12} />
							</IconButton>
						</>
					}>
					<DeckRowButton expanded={shown} onClick={() => setShown(!shown)}>
						<DeckRowText title={t(locale, 'Smoke run')} line={line} />
					</DeckRowButton>
				</DeckRow>
			</DeckList>
			{shown && (
				<DeckFill>
					<ol className={styles.steps} aria-label={t(locale, 'Smoke run steps')}>
						{run.steps.map((step, index) => (
							<li key={index}>
								<span className={styles.number}>{index + 1}</span>
								<span>{step}</span>
							</li>
						))}
					</ol>
				</DeckFill>
			)}
		</>
	);
}
const resultGlyph: Record<SmokeStep['result'], GlyphName> = {
	passed: 'check-pass',
	failed: 'agent-failed',
	unchecked: 'stop',
};
const resultLabel = {
	passed: 'passed',
	failed: 'failed (step)',
	unchecked: 'unchecked (step)',
} as const;
/** spec/smoke-run#chat: the report's service row with its summary, the run's steps behind `N of M steps`; a run dropped without a report. */
export function SmokeEventRow({
	event,
	locale,
}: {
	event: Extract<SessionEvent, { kind: 'smoke.reported' } | { kind: 'smoke.dropped' }>;
	locale: Locale;
}) {
	const [open, setOpen] = useState(false);
	if (event.kind === 'smoke.dropped')
		return (
			<div className={service.service} data-smoke-row="dropped">
				<Glyph name="stop" size={12} />
				<small>{t(locale, 'smoke')}</small>
				<span className={service.label}>{formatDuration(locale, event.elapsedMs)}</span>
				<small className={service.warn}>{t(locale, 'no report')}</small>
				<small>
					{t(
						locale,
						event.reason === 'cancelled' ? 'stopped with the turn' : 'the agent did not report'
					)}
				</small>
			</div>
		);
	const counts = smokeCounts(event.steps),
		glyph: GlyphName = event.stopped ? 'stop' : counts.failed ? 'agent-failed' : 'check-pass',
		tone = event.stopped ? undefined : counts.failed ? 'red' : 'green';
	return (
		<div className={styles.report} data-smoke-row="reported">
			<div className={service.service}>
				<span className={styles.glyph} data-tone={tone}>
					<Glyph name={glyph} size={12} />
				</span>
				<small>{t(locale, 'smoke')}</small>
				<span className={service.label}>
					{event.stopped === 'limit'
						? t(locale, '{n} min').replace('{n}', String(Math.round(event.elapsedMs / minute)))
						: formatDuration(locale, event.elapsedMs)}
				</span>
				{event.stopped && (
					<small className={event.stopped === 'limit' ? service.warn : undefined}>
						{t(locale, event.stopped === 'limit' ? 'stopped at the limit' : 'stopped by you')}
					</small>
				)}
				<small>
					<TextLink aria-expanded={open} onClick={() => setOpen(!open)}>
						{t(locale, '{checked} of {all} steps')
							.replace('{checked}', String(counts.checked))
							.replace('{all}', String(counts.all))}
					</TextLink>
				</small>
				{counts.failed ? (
					<small className={service.warn}>
						{t(locale, '{n} failed').replace('{n}', String(counts.failed))}
					</small>
				) : (
					!event.stopped && <small className={service.ok}>{t(locale, 'done')}</small>
				)}
			</div>
			<p className={styles.summary}>{event.summary}</p>
			{open && (
				<ul className={styles.results}>
					{event.steps.map((step, index) => (
						<li key={index} data-result={step.result}>
							<span
								className={styles.glyph}
								data-tone={
									step.result === 'passed' ? 'green' : step.result === 'failed' ? 'red' : undefined
								}>
								<Glyph name={resultGlyph[step.result]} size={12} />
							</span>
							<span className={styles.step}>{step.step}</span>
							<small>
								{t(locale, resultLabel[step.result])}
								{step.missing
									? ` · ${t(locale, 'not in the report')}`
									: step.note
										? ` · ${step.note}`
										: ''}
							</small>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
/** spec/smoke-run#ready-surfaces: the agent's `Ready to look` — the screen, where it is, and `Show`, which opens it in the work area. */
export function ReadyRow({
	task,
	event,
	locale,
}: {
	task: AgentTask;
	event: Extract<SessionEvent, { kind: 'task.ready' }>;
	locale: Locale;
}) {
	const place =
		event.where === 'simulator'
			? (event.device ?? '')
			: (() => {
					try {
						const url = new URL(event.url ?? '');
						return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
					} catch {
						return event.url ?? '';
					}
				})();
	return (
		<div className={service.service} data-ready-row={event.where}>
			<Glyph name={event.where === 'simulator' ? 'simulator' : 'browser'} size={12} />
			<small>{t(locale, 'ready')}</small>
			<span className={service.label}>{event.screen}</span>
			{place && <small>{place}</small>}
			<small>
				<TextLink
					onClick={() =>
						event.where === 'simulator'
							? setTaskSimulator(task)
							: event.tab && setTaskBrowser(task, event.tab)
					}>
					{t(locale, 'Show')}
				</TextLink>
			</small>
		</div>
	);
}
