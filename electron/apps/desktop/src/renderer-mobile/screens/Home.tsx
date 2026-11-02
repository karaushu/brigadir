/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-app: the home is the sidebar — the machine chip and the quota in the
 * header with the filter and «+», «Усі проєкти», «Чекають тебе · N», the projects in frames with their cards and the quiet
 * rows of completed tasks.
 */
import { useMemo, useState } from 'react';
import {
	crewNeedsYou,
	crewWorkerRows,
	crewWorkers,
	formatTime,
	projectColors,
	sidebarMatches,
	sidebarTasks,
	t,
	type AgentTask,
	type Locale,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { NavBar, NavIcon, LargeTitle } from '../ui/Nav';
import { MachineChip, QuotaPill } from '../ui/Header';
import {
	AttentionBanner,
	Banner,
	ProjectFrame,
	QuietRow,
	QuietSeparator,
	TaskCard,
	WorkerRow,
} from '../ui/Cards';
import { Icon } from '../ui/Icon';
import { SwipeRow } from '../ui/Swipe';
import { navigate, openSheet } from '../router';
import { useMobile } from '../store';
import { PushCard } from './Push';
import { retryLink } from '../data';
import { useConnection } from '../context';
import { Loading } from '../ui/Loading';
import s from './Screen.module.css';

const collapsedKey = 'brigadir.collapsed';
function readCollapsed(): string[] {
	try {
		return JSON.parse(localStorage.getItem(collapsedKey) ?? '[]') as string[];
	} catch {
		return [];
	}
}
export const openTask = (task: AgentTask) =>
	navigate({ screen: 'task', projectId: task.projectId, taskId: task.id });
/** «Питання · дозвіл · план»: what the waiting tasks ask for, in that order, the first word capitalised. */
export function waitingKinds(locale: Locale, tasks: readonly AgentTask[]): string {
	const kinds = (['question', 'permission', 'plan'] as const).filter((kind) =>
		tasks.some(
			(task) =>
				(task.activity?.kind ?? 'permission') === kind ||
				(kind === 'plan' && task.activity?.kind === 'proposal')
		)
	);
	return kinds
		.map((kind, index) => {
			const word = t(
				locale,
				kind === 'question' ? 'Question' : kind === 'plan' ? 'Plan' : 'Permission'
			);
			return index ? word.toLocaleLowerCase(locale) : word;
		})
		.join(' · ');
}
export function projectTasks(workspace: WorkspaceSnapshot | null) {
	const ordered = sidebarTasks(workspace?.tasks ?? []);
	return (projectId: string) => ordered.filter((task) => task.projectId === projectId);
}
/**
 * What waits for the person (spec/crew#attention): a task in «Потрібен ти», and for a foreman the workers that wait — the
 * card to answer is in the worker's chat, so «Чекають тебе» counts and opens the worker, not its foreman.
 */
export function waitingTasks(tasks: readonly AgentTask[]): AgentTask[] {
	return sidebarTasks(tasks).flatMap((task) =>
		task.status === 'needs-you'
			? [task]
			: task.crew
				? crewWorkers(task, tasks).filter((worker) => worker.status === 'needs-you')
				: []
	);
}
/** A foreman stands for its crew under a filter too (spec/projects-and-board#person-tasks): it shows when it or one of its workers matches. */
export function matchesWithCrew(
	task: AgentTask,
	tasks: readonly AgentTask[],
	filter: Parameters<typeof sidebarMatches>[1]
) {
	return (
		sidebarMatches(task, filter) ||
		(task.crew !== undefined &&
			task.crew !== null &&
			crewWorkers(task, tasks).some((worker) => sidebarMatches(worker, filter)))
	);
}
/** The foreman's card and its workers under it, the way the computer's sidebar shows a crew (spec/crew#task-type). */
export function CrewCard({
	task,
	tasks,
	locale,
}: {
	task: AgentTask;
	tasks: readonly AgentTask[];
	locale: Locale;
}) {
	const rows = task.crew ? crewWorkerRows(task, tasks) : [];
	return (
		<>
			<SwipeRow task={task} tasks={tasks} locale={locale}>
				<TaskCard
					task={task}
					locale={locale}
					{...(task.crew
						? { workers: crewWorkers(task, tasks).length, attention: crewNeedsYou(task, tasks) }
						: {})}
					onOpen={openTask}
				/>
			</SwipeRow>
			{rows.length > 0 && (
				<div className={s.workers} data-crew-workers={task.id}>
					{rows.map((row) => (
						<WorkerRow key={row.task.id} row={row} locale={locale} onOpen={openTask} />
					))}
				</div>
			)}
		</>
	);
}
export function Home({ locale }: { locale: Locale }) {
	const workspace = useMobile((state) => state.workspace),
		machine = useMobile((state) => state.machine),
		link = useMobile((state) => state.link),
		quota = useMobile((state) => state.quota),
		shown = useMobile((state) => state.quotaShown),
		filter = useMobile((state) => state.filter),
		syncedAt = useMobile((state) => state.syncedAt),
		lastProject = useMobile((state) => state.lastProject);
	const connection = useConnection();
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const offline = link === 'off';
	const tasksOf = useMemo(() => projectTasks(workspace), [workspace]);
	const colors = useMemo(
		() => projectColors(workspace?.projects.map((project) => project.id) ?? []),
		[workspace]
	);
	const waiting = useMemo(() => waitingTasks(workspace?.tasks ?? []), [workspace]);
	const toggle = (id: string) => {
		const next = collapsed.includes(id)
			? collapsed.filter((item) => item !== id)
			: [...collapsed, id];
		setCollapsed(next);
		try {
			localStorage.setItem(collapsedKey, JSON.stringify(next));
		} catch {
			// Storage blocked: the frame stays as it is until the page closes.
		}
	};
	const newTask = (projectId: string | null) => openSheet({ kind: 'new', projectId });
	return (
		<div className={s.screen} data-screen="home">
			<NavBar
				line={false}
				left={
					<>
						<MachineChip
							machine={machine}
							link={link}
							locale={locale}
							onClick={() => openSheet({ kind: 'machine' })}
						/>
						{!offline && (
							<QuotaPill
								quota={quota}
								shown={shown}
								locale={locale}
								onClick={() => openSheet({ kind: 'quota' })}
							/>
						)}
					</>
				}
				right={
					<>
						<NavIcon
							icon="filter"
							quiet
							label={t(locale, 'Filter by status')}
							dot={filter ? 'var(--accent)' : null}
							onClick={() => openSheet({ kind: 'filter' })}
						/>
						<NavIcon
							icon="plus"
							label={t(locale, 'New task')}
							disabled={offline}
							onClick={() => newTask(lastProject)}
						/>
					</>
				}
			/>
			<LargeTitle>{t(locale, 'All projects')}</LargeTitle>
			<div className={s.scroll}>
				<div className={s.stack} data-home>
					{offline ? (
						<Banner
							data="offline"
							icon={<Icon name="moon" size={20} className={s.bannerIcon} />}
							title={t(locale, '{machine} is asleep or unreachable').replace('{machine}', machine)}
							sub={`${
								syncedAt
									? t(locale, 'Data as of {time}.').replace('{time}', formatTime(syncedAt))
									: ''
							} ${t(locale, 'Actions are unavailable.')}`.trim()}
							action={
								<Button
									size="l"
									className={s.bannerAction}
									data-retry
									onClick={() => void retryLink(connection)}>
									{t(locale, 'Retry (link)')}
								</Button>
							}
						/>
					) : (
						<>
							<PushCard locale={locale} />
							{waiting.length > 0 && (
								<AttentionBanner
									count={waiting.length}
									kinds={waitingKinds(locale, waiting)}
									locale={locale}
									onClick={() =>
										waiting.length === 1
											? openTask(waiting[0]!)
											: useMobile.getState().setFilter('needs-you')
									}
								/>
							)}
						</>
					)}
					<div className={offline ? s.dim : s.frames}>
						{(workspace?.projects ?? []).map((project) => {
							const all = tasksOf(project.id),
								live = all.filter((task) => task.status !== 'completed'),
								shownTasks = live.filter((task) =>
									matchesWithCrew(task, workspace?.tasks ?? [], filter)
								),
								done = filter ? [] : all.filter((task) => task.status === 'completed');
							if (filter && !shownTasks.length) return null;
							return (
								<ProjectFrame
									key={project.id}
									name={project.name}
									color={`var(--project-${colors.get(project.id) ?? 0})`}
									count={live.length}
									waiting={waiting.filter((task) => task.projectId === project.id).length}
									collapsed={collapsed.includes(project.id)}
									locale={locale}
									onToggle={() => toggle(project.id)}
									onOpen={() => navigate({ screen: 'project', projectId: project.id })}
									newDisabled={offline}
									onNew={() => newTask(project.id)}>
									{shownTasks.map((task) => (
										<CrewCard
											key={task.id}
											task={task}
											tasks={workspace?.tasks ?? []}
											locale={locale}
										/>
									))}
									{done.length > 0 && (
										<>
											{shownTasks.length > 0 && <QuietSeparator />}
											{done.map((task) => (
												<SwipeRow
													key={task.id}
													task={task}
													tasks={workspace?.tasks ?? []}
													locale={locale}
													row>
													<QuietRow task={task} locale={locale} onOpen={openTask} />
												</SwipeRow>
											))}
										</>
									)}
								</ProjectFrame>
							);
						})}
						{workspace && !workspace.projects.length && (
							<p className={s.empty}>{t(locale, 'No projects')}</p>
						)}
						{!workspace && !offline && <Loading locale={locale} />}
					</div>
				</div>
			</div>
		</div>
	);
}
