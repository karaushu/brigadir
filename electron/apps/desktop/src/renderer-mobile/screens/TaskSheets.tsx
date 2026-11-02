/**
 * spec/remote-access-and-mobile#phone-app: the task's sheets — the menu (Changes, Pull request, Files, Terminal; Stop turn,
 * Complete task), the model and effort, the subscription limit, the worker of a plan's part.
 */
import { useEffect } from 'react';
import {
	crewLabel,
	fileCount,
	t,
	type AgentOption,
	type AgentTask,
	type CrewPlan,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { Glyph } from '../../renderer/ui/Glyph';
import { Button } from '../../renderer/ui/Controls';
import { Caption, Group, RowIcon, SectionHead, Sheet, SheetRow } from '../ui/Sheet';
import { Counts } from '../ui/Cards';
import { loadForge, taskName, useChanges, useTools } from '../tools/data';
import { completeInMenu } from '../tools/logic';
import { useMobile } from '../store';
import { Icon } from '../ui/Icon';
import { back, navigate, type Sheet as SheetRoute, type Tool } from '../router';
import { limitTime } from '../chat/Composer';
import { planAgents, usePlanEdits } from '../chat/CrewPlanCard';
import { QuotaRows } from './HomeSheets';
import s from './Sheets.module.css';

export function TaskSheets({
	sheet,
	task,
	locale,
	busy,
	options,
	plan,
	limitMinutes,
	send,
	headSub,
}: {
	headSub: string;
	sheet: SheetRoute | null;
	task: AgentTask;
	locale: Locale;
	busy: boolean;
	options: readonly AgentOption[];
	plan: CrewPlan | null;
	limitMinutes: number | null;
	send(command: SessionCommand): Promise<boolean>;
}) {
	if (!sheet) return null;
	const open = (tool: Tool) =>
		navigate({ screen: 'tool', projectId: task.projectId, taskId: task.id, tool });
	if (sheet.kind === 'menu')
		return (
			<TaskMenu task={task} locale={locale} busy={busy} send={send} headSub={headSub} open={open} />
		);
	if (sheet.kind === 'model') {
		const selects = options.filter(
			(option): option is Extract<AgentOption, { kind: 'select' }> =>
				option.kind === 'select' && /model|effort|reasoning/i.test(option.id)
		);
		return (
			<Sheet label={t(locale, 'Model')} title={t(locale, 'Model')} locale={locale} close={back}>
				{selects.map((option) => (
					<div key={option.id}>
						<SectionHead>{option.name}</SectionHead>
						<Group>
							{option.choices.map((choice) => (
								<SheetRow
									key={choice.value}
									role="menuitemradio"
									checked={choice.value === option.value}
									icon={
										<span
											className={s.radio}
											data-on={choice.value === option.value || undefined}
										/>
									}
									title={choice.name}
									{...(choice.description ? { sub: choice.description } : {})}
									onClick={() => {
										void send({ kind: 'setOption', id: option.id, value: choice.value });
										back();
									}}
								/>
							))}
						</Group>
					</div>
				))}
				<Caption className={s.captionTop}>
					{t(locale, 'The change applies from the next turn.')}
				</Caption>
			</Sheet>
		);
	}
	if (sheet.kind === 'limit')
		return (
			<Sheet
				label={t(locale, 'Subscription limit')}
				title={t(locale, 'Subscription limit')}
				locale={locale}
				close={back}>
				<div className={s.limitText}>
					<b>
						{t(locale, 'The {agent} subscription limit is reached.').replace(
							'{agent}',
							task.provider === 'codex' ? 'Codex' : 'Claude'
						)}
					</b>
					<span>
						{t(locale, 'Resets in {time}. Queued messages go after the reset.').replace(
							'{time}',
							limitTime(locale, limitMinutes)
						)}
					</span>
				</div>
				<QuotaRows locale={locale} only={task.provider ?? 'claude'} />
				<div className={s.footer} data-size="xl">
					<Button appearance="neutral" className={s.wide} onClick={back}>
						{t(locale, 'Got it')}
					</Button>
				</div>
			</Sheet>
		);
	if (sheet.kind === 'agent' && plan && plan.id === sheet.planId) {
		const edits = usePlanEdits.getState(),
			parts = edits.parts[plan.id] ?? plan.parts,
			part = parts.find((item) => item.id === sheet.partId);
		return (
			<Sheet
				label={t(locale, 'Agent')}
				title={part?.title ?? t(locale, 'Agent')}
				locale={locale}
				close={back}>
				<Group>
					{planAgents(plan, task).map((agent) => (
						<SheetRow
							key={agent.id}
							role="menuitemradio"
							checked={agent.name === part?.agent}
							icon={<span className={s.radio} data-on={agent.name === part?.agent || undefined} />}
							title={
								<span className={s.agent}>
									<Glyph name={agent.provider === 'claude' ? 'claude' : 'openai'} size={14} />
									{crewLabel(locale, agent.name)}
								</span>
							}
							onClick={() => {
								edits.set(
									plan.id,
									parts.map((item) =>
										item.id === sheet.partId ? { ...item, agent: agent.name } : item
									)
								);
								back();
							}}
						/>
					))}
				</Group>
			</Sheet>
		);
	}
	return null;
}
/** The task's menu — the tools with what each holds now (the change set, the PR and its checks), then the turn's stop
 * and «Завершити задачу». */
function TaskMenu({
	task,
	locale,
	busy,
	send,
	headSub,
	open,
}: {
	task: AgentTask;
	locale: Locale;
	busy: boolean;
	send(command: SessionCommand): Promise<boolean>;
	headSub: string;
	open(tool: Tool): void;
}) {
	const changes = useChanges(task)?.value,
		files = changes?.files ?? [],
		counts = files.length
			? files.reduce(
					(sum, file) => ({
						additions: sum.additions + file.additions,
						deletions: sum.deletions + file.deletions,
					}),
					{ additions: 0, deletions: 0 }
				)
			: task.changeSummary,
		pr = Object.entries(task.pullRequests ?? {})[0],
		forge = useTools((state) => state.forge[taskName(task)]?.value),
		details = pr ? forge?.scopes.find((scope) => scope.scope.id === pr[0])?.details : null,
		passed = details?.checks.filter(
			(check) => check.bucket === 'pass' || check.bucket === 'skipping'
		).length,
		repos = new Set(files.map((file) => file.scopeId)),
		repo = repos.size === 1 ? changes?.scopes.find((scope) => repos.has(scope.id))?.name : null;
	const tasks = useMobile((state) => state.workspace?.tasks) ?? [];
	useEffect(() => {
		if (pr) void loadForge(task, false);
	}, [pr?.[0]]);
	return (
		<Sheet
			label={t(locale, 'Task menu')}
			title={task.title}
			sub={headSub}
			locale={locale}
			close={back}>
			<Group>
				<SheetRow
					icon={
						<RowIcon>
							<Icon name="diff" size={18} />
						</RowIcon>
					}
					title={t(locale, 'Changes')}
					sub={
						counts && (counts.additions || counts.deletions) ? (
							<>
								{files.length ? `${fileCount(locale, files.length)} · ` : ''}
								<Counts additions={counts.additions} deletions={counts.deletions} />
							</>
						) : (
							t(locale, 'No changes')
						)
					}
					chevron
					data={{ menu: 'changes' }}
					onClick={() => open('changes')}
				/>
				<SheetRow
					icon={
						<RowIcon>
							<Icon name="pr" size={18} />
						</RowIcon>
					}
					title={t(locale, 'Pull request')}
					sub={
						pr
							? `#${pr[1].number}${details?.checks.length ? ` · ${t(locale, 'Checks')} ${passed}/${details.checks.length}` : ''}`
							: t(locale, 'No pull request')
					}
					chevron
					data={{ menu: 'pr' }}
					onClick={() => open('pr')}
				/>
				<SheetRow
					icon={
						<RowIcon>
							<Icon name="folder" size={18} />
						</RowIcon>
					}
					title={t(locale, 'Files')}
					sub={
						repo && files.length
							? `${repo} · ${t(locale, '{count} changed').replace('{count}', String(files.length))}`
							: t(locale, 'View only')
					}
					chevron
					data={{ menu: 'files' }}
					onClick={() => open('files')}
				/>
				<SheetRow
					icon={
						<RowIcon>
							<Icon name="term" size={18} />
						</RowIcon>
					}
					title={t(locale, 'Terminal')}
					sub={t(locale, 'Output only')}
					chevron
					data={{ menu: 'terminal' }}
					onClick={() => open('terminal')}
				/>
			</Group>
			<Group className={s.gap12}>
				{busy && (
					<SheetRow
						danger
						icon={
							<RowIcon danger>
								<Icon name="stop" size={16} />
							</RowIcon>
						}
						title={t(locale, 'Stop turn')}
						data={{ menu: 'stop' }}
						onClick={() => {
							void send({ kind: 'cancel' });
							back();
						}}
					/>
				)}
				{completeInMenu(task, tasks, busy) && (
					<SheetRow
						icon={
							<RowIcon>
								<Icon name="tick" size={18} />
							</RowIcon>
						}
						title={t(locale, 'Complete task')}
						data={{ menu: 'complete' }}
						onClick={() => {
							void window.brigadir
								.moveTask({ projectId: task.projectId, id: task.id }, 'completed')
								.catch(() => {});
							back();
						}}
					/>
				)}
			</Group>
		</Sheet>
	);
}
