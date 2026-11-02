/**
 * spec/remote-access-and-mobile#phone-app: the chat's rows on the phone — the person's message, the agent's answer, a thought, a tool call,
 * a group of calls (spec/chat#tool-groups), a subagent (spec/chat#subagents), the agent's plan (spec/chat-turns-plans-and-questions#plan-row), the turn's state line (spec/chat-turns-plans-and-questions#turn-status-row). The rows come
 * from `conversation-rows` (the computer's model); each row taps open its details.
 */
import { useState, type ReactNode } from 'react';
import {
	formatDuration,
	lineChangeCount,
	planSummary,
	promptDisplayText,
	t,
	toolCallCount,
	toolErrorCount,
	toolGroupDuration,
	toolGroupName,
	toolGroupSummary,
	toolHeadline,
	toolMixText,
	type EventRecord,
	type Locale,
	type TurnStatus,
} from '@brigadir/core';
import type { DisplayRow, ToolRow, ThoughtRow } from '../../renderer/conversation-rows';
import { StatusIcon } from '../../renderer/ui/Controls';
import { useSecondTick } from '../../renderer/ui/second-tick';
import { Button } from '../../renderer/ui/Controls';
import { markdown } from '../../renderer/markdown';
import { Icon } from '../ui/Icon';
import { Counts } from '../ui/Cards';
import s from './Chat.module.css';

export type ChatRow = DisplayRow | { id: string; kind: 'card'; card: ReactNode };
/** What a row can do on the phone: the failed turn's «Повторити» (only on the last failure, while nothing came after it). */
export type ChatActions = { retrySeq?: number | null; retry?(): void; retrying?: boolean };
const toolState = (tool: ToolRow) =>
	tool.tool.status === 'failed'
		? 'failed'
		: tool.finishedAt !== null || tool.tool.status === 'completed'
			? 'done'
			: 'working';
function Disclosure({
	open,
	children,
	onClick,
	sub = false,
	data,
}: {
	open: boolean;
	children: ReactNode;
	onClick(): void;
	sub?: boolean;
	data?: string;
}) {
	return (
		<button
			type="button"
			className={s.tool}
			data-sub={sub || undefined}
			aria-expanded={open}
			onClick={onClick}
			{...(data ? { [`data-${data}`]: '' } : {})}>
			<Icon name={open ? 'chev' : 'chevr'} size={14} className={s.chevron} />
			{children}
		</button>
	);
}
function Duration({ from, to, locale }: { from: number; to: number | null; locale: Locale }) {
	const now = useSecondTick(to === null);
	return <span className={s.time}>{formatDuration(locale, (to ?? now) - from)}</span>;
}
function ToolLine({ row, locale, sub = false }: { row: ToolRow; locale: Locale; sub?: boolean }) {
	const [open, setOpen] = useState(false),
		head = toolHeadline(row.tool),
		state = toolState(row);
	// An edit shows what it changed (+N −M), as the desktop's Edit row; a command shows how long it ran.
	const diffs = (row.tool.content ?? []).filter((content) => content.kind === 'diff'),
		edits = diffs.length
			? diffs.reduce(
					(sum, content) => {
						const count = lineChangeCount(content.before, content.after);
						return {
							additions: sum.additions + count.additions,
							deletions: sum.deletions + count.deletions,
						};
					},
					{ additions: 0, deletions: 0 }
				)
			: null;
	return (
		<>
			<Disclosure open={open} sub={sub} onClick={() => setOpen(!open)} data="tool-row">
				{state === 'failed' ? (
					<Icon name="x2" size={15} className={s.failed} />
				) : (
					<StatusIcon
						status={state === 'working' ? 'working' : 'done'}
						label={t(locale, state === 'working' ? 'Working' : 'Done')}
						size={16}
					/>
				)}
				<span className={s.two}>
					<span className="ell">
						<b>{head.name ?? t(locale, 'Tool')}</b>{' '}
						{head.target && <span className={`mono ${s.target}`}>{head.target}</span>}
					</span>
					{state === 'failed' && (
						<span className={s.note}>
							<span className={s.error}>
								{row.tool.exitCode !== undefined ? `exit ${row.tool.exitCode}` : t(locale, 'Error')}
							</span>
							{sub &&
								row.finishedAt !== null &&
								` · ${formatDuration(locale, row.finishedAt - row.startedAt)}`}
						</span>
					)}
				</span>
				{!sub &&
					(edits && state === 'done' ? (
						<Counts additions={edits.additions} deletions={edits.deletions} />
					) : (
						<Duration from={row.startedAt} to={row.finishedAt} locale={locale} />
					))}
			</Disclosure>
			{open && row.tool.output && <pre className={s.output}>{row.tool.output.slice(-4000)}</pre>}
		</>
	);
}
function ThoughtLine({ row, locale }: { row: ThoughtRow; locale: Locale }) {
	const [open, setOpen] = useState(false);
	const word =
		row.endedAt !== undefined && row.startedAt !== undefined && row.endedAt > row.startedAt
			? `${t(locale, 'thought')} · ${formatDuration(locale, row.endedAt - row.startedAt)}`
			: t(locale, 'thinking');
	return (
		<>
			<button type="button" className={s.think} aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name={open ? 'chev' : 'chevr'} size={14} className={s.chevron} />
				{word}
			</button>
			{open && <p className={s.thought}>{row.text}</p>}
		</>
	);
}
function ToolGroup({
	row,
	locale,
}: {
	row: Extract<DisplayRow, { kind: 'toolGroup' }>;
	locale: Locale;
}) {
	const [open, setOpen] = useState(false);
	const calls = row.tools.map((tool) => ({
		id: tool.id,
		tool: tool.tool,
		startedAt: tool.startedAt,
		finishedAt: tool.finishedAt,
	}));
	const summary = toolGroupSummary(calls, (tool) => toolGroupName(locale, tool)),
		now = useSecondTick(summary.running);
	const shown = open ? row.tools : row.tools.filter((tool) => summary.pinned.includes(tool.id));
	return (
		<div className={s.group} data-tool-group>
			<Disclosure open={open} onClick={() => setOpen(!open)}>
				<Icon name="tools" size={16} className={s.toolsIcon} />
				<span className={s.two}>
					<span>
						<b>{toolCallCount(locale, summary.calls)}</b>
						{summary.errors > 0 && (
							<span className={s.errors}> · {toolErrorCount(locale, summary.errors)}</span>
						)}
					</span>
					<span className={`ell ${s.note}`}>{toolMixText(summary.mix)}</span>
				</span>
				<span className={s.time}>{formatDuration(locale, toolGroupDuration(calls, now))}</span>
			</Disclosure>
			{shown.map((tool) => (
				<ToolLine key={tool.id} row={tool} locale={locale} sub />
			))}
		</div>
	);
}
function Subagent({
	row,
	locale,
}: {
	row: Extract<DisplayRow, { kind: 'subagentBlock' }>;
	locale: Locale;
}) {
	const [open, setOpen] = useState(false);
	const view = row.view,
		state = view.state;
	return (
		<>
			<Disclosure open={open} onClick={() => setOpen(!open)} data="subagent">
				<StatusIcon
					status={
						state === 'running'
							? 'working'
							: state === 'completed'
								? 'done'
								: state === 'failed'
									? 'failed'
									: 'interrupted'
					}
					label={t(locale, state === 'running' ? 'Working' : 'Done')}
					size={16}
				/>
				<span className={s.two}>
					<span className="ell">
						<b>{t(locale, 'Subagent')}</b>{' '}
						<span className={`mono ${s.target}`}>{row.row.name}</span>
					</span>
					<span className={`ell ${s.note}`}>
						{[row.row.prompt?.split('\n')[0], toolCallCount(locale, view.calls)]
							.filter(Boolean)
							.join(' · ')}
					</span>
				</span>
				<Duration from={row.row.startedAt} to={row.row.finishedAt} locale={locale} />
			</Disclosure>
			{open && view.answer && <p className={s.thought}>{view.answer}</p>}
		</>
	);
}
function PlanLine({ record, locale }: { record: EventRecord; locale: Locale }) {
	const [open, setOpen] = useState(true);
	if (record.event.kind !== 'plan.changed') return null;
	const entries = record.event.entries,
		summary = planSummary(entries);
	return (
		<>
			<Disclosure open={open} onClick={() => setOpen(!open)} data="plan-row">
				<Icon name="plan" size={16} className={s.toolsIcon} />
				<b>{t(locale, 'Plan')}</b>
				<span className={s.note}>
					{summary.done}/{summary.total}
				</span>
				{summary.segments && (
					<span className={s.progress} aria-hidden="true">
						{entries.map((entry, index) => (
							<i key={index} data-on={entry.status === 'completed' || undefined} />
						))}
					</span>
				)}
				<span className={`ell ${s.note} ${s.grow}`}>{summary.current ?? summary.next ?? ''}</span>
			</Disclosure>
			{open && (
				<ul className={s.planItems}>
					{entries.map((entry, index) => (
						<li key={index} data-status={entry.status}>
							<StatusIcon
								status={
									entry.status === 'completed'
										? 'done'
										: entry.status === 'in_progress'
											? 'working'
											: 'queued'
								}
								label={entry.status}
								size={16}
							/>
							{entry.status === 'completed' ? <s>{entry.text}</s> : entry.text}
						</li>
					))}
				</ul>
			)}
		</>
	);
}
export function TurnStatusLine({ status, locale }: { status: TurnStatus; locale: Locale }) {
	const now = useSecondTick(true);
	const word =
		status.state === 'thinking' ? 'Thinking' : status.state === 'writing' ? 'Writing' : 'Working';
	const target =
		status.subagent ??
		(status.tool ? toolHeadline(status.tool).target || status.tool.name : status.target);
	return (
		<div className={s.status} data-turn-status={status.state}>
			<StatusIcon status="working" label={t(locale, word)} size={16} />
			<b>{t(locale, word)}</b>
			<span>· {formatDuration(locale, Math.max(0, now - status.startedAt))}</span>
			{target && <span className={`ell mono ${s.statusTarget}`}>· {target}</span>}
		</div>
	);
}
function EventLine({
	record,
	locale,
	actions,
}: {
	record: EventRecord;
	locale: Locale;
	actions: ChatActions;
}) {
	const e = record.event;
	if (e.kind === 'plan.changed') return <PlanLine record={record} locale={locale} />;
	if (e.kind === 'session.failed')
		return (
			<div className={s.turnFailed} data-turn-failed>
				<p className={s.failure} role="alert">
					{e.message || t(locale, 'The agent stopped with an error.')}
				</p>
				{actions.retry && actions.retrySeq === record.seq && (
					<div data-size="l">
						<Button disabled={actions.retrying} data-retry-turn onClick={actions.retry}>
							{t(locale, 'Retry (turn)')}
						</Button>
					</div>
				)}
			</div>
		);
	if (e.kind === 'turn.started' && e.crew) return <div className={s.user}>{e.text}</div>;
	// spec/chat-turns-plans-and-questions#plan-approval: the plan the agent writes, read on the phone as on the computer (the request that follows shows it itself).
	if (e.kind === 'plan.document')
		return (
			<div
				className={`${s.answer} ${s.planDocument}`}
				data-plan-document={e.planId}
				dangerouslySetInnerHTML={{ __html: markdown.render(e.text) }}
			/>
		);
	return null;
}
export function renderChatRow(row: ChatRow, locale: Locale, actions: ChatActions = {}): ReactNode {
	switch (row.kind) {
		case 'card':
			return row.card;
		case 'message':
			if (row.role === 'thought') return <ThoughtLine row={row} locale={locale} />;
			return (
				<div className={s.user} data-user-message data-held={row.waiting || undefined}>
					{promptDisplayText(row.text, row.attachments ?? [])}
					{row.waiting && (
						<small className={s.held}>{t(locale, 'Sending at the next step…')}</small>
					)}
				</div>
			);
		case 'markdown':
			return <div className={s.answer} dangerouslySetInnerHTML={{ __html: row.html }} />;
		case 'tool':
			return <ToolLine row={row} locale={locale} />;
		case 'toolGroup':
			return <ToolGroup row={row} locale={locale} />;
		case 'subagentBlock':
			return <Subagent row={row} locale={locale} />;
		case 'turnStatus':
			return <TurnStatusLine status={row.status} locale={locale} />;
		case 'event':
			return <EventLine record={row.record} locale={locale} actions={actions} />;
	}
}
