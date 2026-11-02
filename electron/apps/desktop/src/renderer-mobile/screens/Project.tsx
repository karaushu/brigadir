/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-app, spec/remote-access-and-mobile#phone-pr-list: a project — the segments «Задачі N |
 * PR N ●»; the tasks as a list (search, groups by state, completed tasks as quiet rows) or as the board, by this phone's
 * choice for the project; the project's PRs; «Нова задача» under the tasks.
 */
import { useMemo, useState } from 'react';
import {
	crewNeedsYou,
	t,
	taskCount,
	type AgentTask,
	type Locale,
	type MessageKey,
	type ProjectView,
} from '@brigadir/core';
import { Button, Segments } from '../../renderer/ui/Controls';
import { BackButton, NavBar, NavIcon } from '../ui/Nav';
import { QuietRow } from '../ui/Cards';
import { Icon } from '../ui/Icon';
import { SwipeRow } from '../ui/Swipe';
import { back, openSheet, replaceRoute, useRouter } from '../router';
import { useMobile, useOffline } from '../store';
import { CrewCard, matchesWithCrew, openTask, projectTasks, waitingTasks } from './Home';
import { Board, MoveSheet } from './Board';
import { readProjectView, saveProjectView } from './board-moves';
import { PRList, RepoSheet, linkRepo, openPulls, usePRView } from '../tools/PullRequests';
import { usePRList } from '../tools/prs';
import { prBadge } from '../tools/pr-list';
import s from './Screen.module.css';
import p from './Project.module.css';

const groups: { key: MessageKey; test(task: AgentTask, tasks: readonly AgentTask[]): boolean }[] = [
	// spec/crew#attention: a foreman whose worker waits for the person sorts with «Потрібен ти», as on the computer's board.
	{
		key: 'Needs you',
		test: (task, tasks) => task.status === 'needs-you' || crewNeedsYou(task, tasks),
	},
	{ key: 'Running', test: (task) => ['working', 'preparing', 'queued'].includes(task.status) },
	{
		key: 'Unreviewed',
		test: (task) => task.status === 'done' && task.hasUnreviewedChanges === true,
	},
	{ key: 'Backlog', test: (task) => task.status === 'backlog' },
	{ key: 'Other tasks', test: () => true },
];
export function Project({
	projectId,
	tab,
	locale,
}: {
	projectId: string;
	tab: 'pr' | undefined;
	locale: Locale;
}) {
	const workspace = useMobile((state) => state.workspace),
		filter = useMobile((state) => state.filter),
		offline = useOffline(),
		{ sheet } = useRouter();
	const [query, setQuery] = useState(''),
		[view, setView] = useState<ProjectView>(() => readProjectView(projectId));
	const project = workspace?.projects.find((item) => item.id === projectId);
	const name = project?.name ?? '';
	const all = useMemo(() => projectTasks(workspace)(projectId), [workspace, projectId]);
	const prs = usePRList(projectId),
		prRepo = usePRView((state) => state.views[projectId]?.repo ?? null);
	const badge = prBadge(prs?.value ?? null);
	const tasks = workspace?.tasks ?? [];
	const filtered = all.filter((task) => matchesWithCrew(task, tasks, filter));
	const found = filtered.filter(
		(task) =>
			!query.trim() ||
			task.title.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))
	);
	const live = found.filter((task) => task.status !== 'completed'),
		done = filter ? [] : found.filter((task) => task.status === 'completed');
	const placed = new Set<string>();
	const sections = groups.flatMap((group) => {
		const items = live.filter((task) => !placed.has(task.id) && group.test(task, tasks));
		for (const task of items) placed.add(task.id);
		return items.length ? [{ ...group, items }] : [];
	});
	const open = all.filter((task) => task.status !== 'completed').length,
		waiting = waitingTasks(tasks).filter((task) => task.projectId === projectId).length;
	const pr = tab === 'pr';
	const toggle = () => {
		const next = view === 'board' ? 'list' : 'board';
		saveProjectView(projectId, next);
		setView(next);
	};
	const moving =
		sheet?.kind === 'move' ? workspace?.tasks.find((task) => task.id === sheet.taskId) : undefined;
	return (
		<div
			className={s.screen}
			data-screen="project"
			data-project-tab={pr ? 'pr' : 'tasks'}
			data-view={view}>
			<NavBar
				left={<BackButton label={t(locale, 'Projects')} locale={locale} onClick={back} />}
				title={name}
				sub={[
					taskCount(locale, open),
					...(waiting ? [t(locale, '{count} waiting').replace('{count}', String(waiting))] : []),
				].join(' · ')}
				line={false}
				right={
					pr ? (
						<NavIcon
							icon="link"
							quiet
							label={t(locale, 'Open on GitHub')}
							disabled={!linkRepo(prs?.value ?? null, prRepo)}
							onClick={() => openPulls(projectId, linkRepo(prs?.value ?? null, prRepo))}
						/>
					) : (
						<>
							<NavIcon
								icon={view === 'board' ? 'list' : 'board'}
								quiet
								label={`${t(locale, 'Project view')}: ${t(locale, view === 'board' ? 'List' : 'Board').toLocaleLowerCase(locale)}`}
								onClick={toggle}
							/>
							<NavIcon
								icon="filter"
								quiet
								label={t(locale, 'Filter by status')}
								dot={filter ? 'var(--accent)' : null}
								onClick={() => openSheet({ kind: 'filter' })}
							/>
						</>
					)
				}
			/>
			<div className={p.segments} data-size="l">
				<Segments
					size="l"
					className={p.wide}
					label={name}
					value={pr ? 'pr' : 'tasks'}
					options={[
						{
							value: 'tasks',
							label: t(locale, 'Tasks'),
							tail: String(open),
						},
						{
							value: 'pr',
							label: 'PR',
							...(prs?.value ? { tail: String(badge.open) } : {}),
							badge: badge.waiting && (
								<i
									className={p.waiting}
									role="img"
									aria-label={t(locale, 'Waiting for your review')}
								/>
							),
						},
					]}
					onChange={(value) =>
						replaceRoute(
							value === 'pr'
								? { screen: 'project', projectId, tab: 'pr' }
								: { screen: 'project', projectId }
						)
					}
				/>
			</div>
			{pr ? (
				<>
					<div className={p.line} />
					<PRList projectId={projectId} projectName={name} entry={prs} locale={locale} />
				</>
			) : view === 'board' ? (
				<Board
					projectId={projectId}
					tasks={filtered}
					all={workspace?.tasks ?? []}
					locale={locale}
				/>
			) : (
				<div className={s.scroll}>
					<label className={`${s.search} ${p.search}`}>
						<Icon name="search" size={18} />
						<input
							type="search"
							value={query}
							aria-label={t(locale, 'Search tasks')}
							placeholder={t(locale, 'Search tasks')}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className={s.groups} data-project-groups>
						{sections.map((section) => (
							<div
								key={section.key}
								role="group"
								aria-label={t(locale, section.key)}
								className={s.frames6}>
								<div className={s.groupHead}>
									{t(locale, section.key)} <span>{section.items.length}</span>
								</div>
								{section.items.map((task) => (
									<CrewCard key={task.id} task={task} tasks={tasks} locale={locale} />
								))}
							</div>
						))}
						{done.length > 0 && (
							<div role="group" aria-label={t(locale, 'Completed')} className={s.frames6}>
								<div className={s.groupHead}>
									{t(locale, 'Completed')} <span>{done.length}</span>
								</div>
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
							</div>
						)}
						{!sections.length && !done.length && (
							<p className={s.empty}>{t(locale, query.trim() ? 'Nothing found' : 'No tasks')}</p>
						)}
					</div>
				</div>
			)}
			{!pr && (
				<div className={s.bottom}>
					<div className={s.bottomAction} data-size="xl">
						<Button
							appearance="primary"
							disabled={offline}
							onClick={() => openSheet({ kind: 'new', projectId })}>
							<Icon name="plus" size={20} />
							{t(locale, 'New task')}
						</Button>
					</div>
				</div>
			)}
			{sheet?.kind === 'repo' && (
				<RepoSheet
					projectId={projectId}
					projectName={name}
					snapshot={prs?.value ?? null}
					locale={locale}
				/>
			)}
			{sheet?.kind === 'move' && <MoveSheet task={moving} column={sheet.column} locale={locale} />}
		</div>
	);
}
