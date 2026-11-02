import { useState } from 'react';
import {
	fileCount,
	findSpecAgent,
	mcpRow,
	t,
	type AgentTask,
	type Locale,
	type McpModule,
	type McpState,
	type McpWorker,
	type ToolPatch,
} from '@brigadir/core';
import { Button, Chevron, StatusIcon } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ToolElapsed } from './ActivityDetails';
import s from './McpToolRow.module.css';

const glyphs: Record<McpModule, Parameters<typeof Glyph>[0]['name']> = {
	crew: 'helmet',
	human: 'person',
	browser: 'browser',
	simulator: 'simulator',
	pr: 'pr-branch',
	editor: 'editor',
	commands: 'command-idle',
	console: 'console',
};
/** The agent and part of a crew task id, from the tasks the window already knows (spec/crew-templates-and-editor#after-launch). */
export function crewWorkers(
	tasks: readonly AgentTask[],
	current: AgentTask,
	fromLog: ReadonlyMap<string, McpWorker> = new Map()
): (taskId: string) => McpWorker | null {
	return (taskId) => {
		const logged = fromLog.get(taskId);
		if (logged) return logged;
		const worker = tasks.find((item) => item.id === taskId);
		if (!worker?.crewNodeId || !worker.crewTaskId) return null;
		const foreman =
			current.id === worker.crewTaskId
				? current
				: tasks.find((item) => item.id === worker.crewTaskId);
		const name = foreman?.crew
			? findSpecAgent(foreman.crew.root, worker.crewNodeId)?.name
			: undefined;
		return name ? { name, title: worker.title } : null;
	};
}
function pretty(text: string | undefined): string {
	if (!text) return '';
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}
/**
 * spec/chat#mcp-calls: an MCP call in the log. The first line is the action by its state (`Приймає частину` →
 * `Прийняв частину`, `Частину не прийнято`) with the module's sign and the crew agent; the second line is the target or
 * the outcome, red when the call failed. Expanded: fields and texts instead of JSON; `Показати JSON` keeps the raw call.
 */
export function McpToolRow({
	tool,
	state,
	startedAt,
	finishedAt,
	locale,
	open,
	onToggle,
	className,
	summaryRef,
	worker,
	target,
}: {
	tool: ToolPatch;
	state: McpState;
	startedAt: number;
	finishedAt: number | null;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
	className: string | undefined;
	summaryRef(node: HTMLElement | null): void;
	worker: (taskId: string) => McpWorker | null;
	/** spec/chat#tool-groups: a copy pinned under a collapsed tool group marks itself `pin/<id>`: the navigation target is the call inside the group. */
	target?: string;
}) {
	const [raw, setRaw] = useState(false);
	const row = mcpRow(locale, tool, state, worker);
	if (!row) return null;
	const failed = state === 'failed',
		output =
			tool.output ?? tool.content?.flatMap((c) => (c.kind === 'text' ? [c.text] : [])).join('\n');
	const label = t(
		locale,
		state === 'done'
			? 'Done'
			: failed
				? 'Error'
				: state === 'interrupted'
					? 'Interrupted'
					: 'Working'
	);
	return (
		<details
			className={className}
			open={open}
			onToggle={onToggle}
			data-mcp-row={row.module ?? 'foreign'}>
			<summary
				ref={summaryRef}
				data-tool-target={target ?? tool.id}
				className={s.summary}
				title={row.module ? undefined : (tool.name ?? tool.title)}>
				<Chevron />
				<StatusIcon
					status={
						state === 'done'
							? 'done'
							: failed
								? 'failed'
								: state === 'interrupted'
									? 'interrupted'
									: 'working'
					}
					label={label}
				/>
				<span className={s.body}>
					<span className={s.line}>
						<span
							className={s.sign}
							role="img"
							aria-label={t(locale, row.module ? 'Brigadir tool' : 'Tool of another server')}>
							<Glyph name={row.module ? glyphs[row.module] : 'plug'} size={12} />
						</span>
						<strong className={s.title}>{row.title}</strong>
						{row.who && <span className={s.who}>{row.who}</span>}
						<span className={s.spacer} />
						<ToolElapsed startedAt={startedAt} finishedAt={finishedAt} locale={locale} />
					</span>
					{row.detail.length > 0 && (
						<span className={s.detail} data-failed={failed || undefined}>
							{row.detail.map((part, index) => (
								<span key={index} data-kind={part.kind}>
									{part.text}
								</span>
							))}
						</span>
					)}
				</span>
			</summary>
			<div className={s.result}>
				{row.fields.length > 0 && (
					<dl className={s.fields}>
						{row.fields.map((field, index) => (
							<div key={index}>
								<dt>{field.label}</dt>
								<dd>{field.value}</dd>
							</div>
						))}
					</dl>
				)}
				{row.files.length > 0 && (
					<ul className={s.files} aria-label={t(locale, 'Files')}>
						{row.files.slice(0, 8).map((file) => (
							<li key={file.path}>
								<span className={s.path}>{file.path}</span>
								<span className={s.state}>{file.status}</span>
								<span className={s.added}>+{file.added}</span>
								<span className={s.removed}>−{file.removed}</span>
							</li>
						))}
					</ul>
				)}
				{row.files.length > 8 && (
					<small className={s.more}>
						{t(locale, 'and {files} more').replace(
							'{files}',
							fileCount(locale, row.files.length - 8)
						)}
					</small>
				)}
				{row.message && (
					<div className={s.message}>
						<small>{t(locale, 'last message')}</small>
						<p>{row.message}</p>
					</div>
				)}
				{row.text && (
					<pre className={s.text} data-failed={(failed && !row.module) || undefined}>
						{row.diff
							? row.text.split('\n').map((line, index) => (
									<span
										key={index}
										data-line={
											line.startsWith('@@')
												? 'hunk'
												: line.startsWith('+')
													? 'added'
													: line.startsWith('-')
														? 'removed'
														: undefined
										}>
										{line}
										{'\n'}
									</span>
								))
							: row.text}
					</pre>
				)}
				<Button
					size="s"
					variant="ghost"
					className={s.json}
					aria-expanded={raw}
					onClick={() => setRaw((value) => !value)}>
					<Glyph name="code" size={14} />
					{t(locale, raw ? 'Hide JSON' : 'Show JSON')}
				</Button>
				{raw && (
					<div className={s.raw}>
						{tool.input && (
							<>
								<small>{t(locale, 'Input')}</small>
								<pre>{pretty(tool.input)}</pre>
							</>
						)}
						{output && (
							<>
								<small>{t(locale, 'Result')}</small>
								<pre>{pretty(output)}</pre>
							</>
						)}
					</div>
				)}
			</div>
		</details>
	);
}
