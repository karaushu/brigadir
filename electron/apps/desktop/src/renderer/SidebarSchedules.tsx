import { useRef, useState } from 'react';
import {
	describeRule,
	scheduleState,
	t,
	type AgentTask,
	type Locale,
	type Project,
	type ScheduleSummary,
} from '@brigadir/core';
import { useSchedules, stateGlyph, stateText } from './SchedulesScreen';
import { SearchField } from './ui/PanelSearch';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ProjectIcon, projectToneStyle } from './ui/ProjectIcon';
import { MenuItem, MenuPopover } from './ui/Popover';
import { toastError } from './ui/Toast';
import { SkeletonRows } from './ui/Loading';
import styles from './App.module.css';
import s from './SidebarSchedules.module.css';

type Filter = 'all' | 'active' | 'paused';
/**
 * spec/notifications-slack-notes-and-schedules#schedules: the sidebar of the Schedules section — the filter with All · Active ·
 * Paused, `All schedules · N`, then each project's schedules as the task rows are drawn (rule 17): the state's glyph, the
 * name, «rule · state». Hover covers the row (rule 15) and raises Run now · Pause · ⋯ over it.
 */
export function SidebarSchedules({
	locale,
	projects,
	tasks,
	colors,
	selected,
	onSelect,
	onNew,
}: {
	locale: Locale;
	projects: Project[];
	tasks: AgentTask[];
	colors: Map<string, number>;
	selected: { projectId: string; id: string } | 'all' | null;
	onSelect(schedule: { projectId: string; id: string } | 'all'): void;
	onNew(): void;
}) {
	const schedules = useSchedules(),
		[query, setQuery] = useState(''),
		[filter, setFilter] = useState<Filter>('all'),
		[filterOpen, setFilterOpen] = useState(false),
		[collapsed, setCollapsed] = useState<string[]>([]);
	const filterButton = useRef<HTMLButtonElement>(null);
	const needle = query.trim().toLowerCase();
	const shown = (schedules ?? []).filter(
		(item) =>
			(filter === 'all' || (filter === 'paused') === item.paused) &&
			(!needle ||
				item.name.toLowerCase().includes(needle) ||
				item.task.prompt.toLowerCase().includes(needle))
	);
	const groups = projects
		.map((project) => ({ project, rows: shown.filter((item) => item.projectId === project.id) }))
		.filter((group) => group.rows.length);
	return (
		<>
			<div className={styles.taskFilter} data-size="l">
				<SearchField
					className={styles.taskFilterField}
					locale={locale}
					label={t(locale, 'Filter schedules')}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && query) {
							event.preventDefault();
							setQuery('');
						}
					}}
				/>
				<IconButton
					ref={filterButton}
					label={t(locale, 'Filter schedules')}
					aria-expanded={filterOpen}
					dot={filter === 'all' ? null : 'var(--accent)'}
					onClick={() => setFilterOpen(true)}>
					<Glyph name="filter" size={15} />
				</IconButton>
				{/* spec/sidebar#section-rail: the section's one action beside its filter, as Notes has it. */}
				<IconButton label={t(locale, 'New schedule')} onClick={onNew}>
					<Glyph name="plus" size={14} />
				</IconButton>
				<MenuPopover
					open={filterOpen}
					onClose={() => setFilterOpen(false)}
					anchor={filterButton}
					label={t(locale, 'Filter schedules')}
					locale={locale}
					focus="checked">
					{(['all', 'active', 'paused'] as const).map((value) => (
						<MenuItem
							key={value}
							kind="radio"
							checked={filter === value}
							onSelect={() => setFilter(value)}>
							{t(locale, value === 'all' ? 'All' : value === 'active' ? 'Active' : 'Paused')}
						</MenuItem>
					))}
				</MenuPopover>
			</div>
			<div className={styles.allProjectsRow} data-selected={selected === 'all'}>
				<button
					className={styles.allProjects}
					aria-pressed={selected === 'all'}
					onClick={() => onSelect('all')}>
					<Glyph name="schedule" size={14} />
					{t(locale, 'All schedules')}
				</button>
				<span className={styles.sectionGroupCount}>{schedules?.length ?? ''}</span>
			</div>
			<div data-sidebar-list data-sidebar-schedules className={styles.projectList}>
				{!schedules ? (
					<SkeletonRows count={3} height={46} />
				) : !schedules.length ? (
					<div className={s.empty}>
						<Glyph name="schedule" size={28} />
						<span>{t(locale, 'No schedules')}</span>
						<Button size="s" appearance="primary" onClick={onNew}>
							{t(locale, 'New schedule')}
						</Button>
					</div>
				) : !groups.length ? (
					<p className={styles.muted}>{t(locale, 'No matches')}</p>
				) : (
					groups.map(({ project, rows }) => {
						const shut = collapsed.includes(project.id),
							toggle = () =>
								setCollapsed((list) =>
									shut ? list.filter((item) => item !== project.id) : [...list, project.id]
								);
						return (
							<section key={project.id} className={styles.project} data-open={!shut}>
								<div
									className={styles.projectHeader}
									style={projectToneStyle(project, colors.get(project.id) ?? 0)}>
									<button
										className={styles.projectCollapse}
										aria-label={`${t(locale, shut ? 'Expand project' : 'Collapse project')} · ${project.name}`}
										aria-expanded={!shut}
										onClick={toggle}>
										<Glyph name="sidebar-chevron" size={10} />
									</button>
									<span className={styles.projectIconButton} aria-hidden="true">
										<ProjectIcon project={project} slot={colors.get(project.id) ?? 0} size={22} />
									</span>
									<h3 title={project.path}>
										<button className={styles.projectSelect} aria-expanded={!shut} onClick={toggle}>
											{project.name}
										</button>
									</h3>
									<span className={styles.sectionGroupCount}>{rows.length}</span>
								</div>
								<div
									className={styles.projectDisclosure}
									data-open={!shut}
									inert={shut}
									aria-hidden={shut}>
									<div>
										{rows.map((item) => (
											<ScheduleRow
												key={item.id}
												locale={locale}
												schedule={item}
												tasks={tasks}
												selected={
													selected !== 'all' &&
													selected?.projectId === item.projectId &&
													selected.id === item.id
												}
												onOpen={() => onSelect({ projectId: item.projectId, id: item.id })}
											/>
										))}
									</div>
								</div>
							</section>
						);
					})
				)}
			</div>
		</>
	);
}

function ScheduleRow({
	locale,
	schedule,
	tasks,
	selected,
	onOpen,
}: {
	locale: Locale;
	schedule: ScheduleSummary;
	tasks: AgentTask[];
	selected: boolean;
	onOpen(): void;
}) {
	const [menu, setMenu] = useState(false);
	const more = useRef<HTMLButtonElement>(null);
	const state = scheduleState(schedule, tasks),
		{ tone } = stateGlyph[state],
		// spec/notifications-slack-notes-and-schedules#schedules: a once waiting for its time shows the clock.
		glyph =
			state === 'scheduled' && schedule.rule.kind === 'once' ? 'clock' : stateGlyph[state].glyph;
	const fail = () => toastError(t(locale, 'Could not start the run.'));
	const { projectId, id } = schedule;
	return (
		<div className={s.row} data-state={state} data-sidebar-schedule={id}>
			<button
				className={styles.task}
				aria-pressed={selected}
				title={schedule.name}
				onClick={onOpen}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenu(true);
				}}>
				<span className={styles.noteGlyph} style={{ color: tone }}>
					<Glyph name={glyph} size={14} />
				</span>
				<span className={styles.taskCopy}>
					<span className={styles.taskHead}>
						<span className={styles.taskTitle} data-paused={schedule.paused || undefined}>
							{schedule.name}
						</span>
					</span>
					<small className={styles.prLine}>
						{describeRule(locale, schedule.rule, schedule.timeZone)}
						{' · '}
						<span
							style={
								state === 'scheduled' || state === 'done' || state === 'paused'
									? undefined
									: { color: tone }
							}>
							{stateText(locale, state, schedule)}
						</span>
					</small>
				</span>
			</button>
			<span className={s.actions}>
				<IconButton
					size="s"
					label={t(locale, 'Run now')}
					onClick={() => void window.brigadir.runScheduleNow(projectId, id).catch(fail)}>
					<Glyph name="resume" size={12} />
				</IconButton>
				<IconButton
					size="s"
					label={t(locale, schedule.paused ? 'Resume (schedule)' : 'Pause')}
					onClick={() =>
						void window.brigadir.setSchedulePaused(projectId, id, !schedule.paused).catch(fail)
					}>
					<Glyph name={schedule.paused ? 'schedule' : 'pause'} size={12} />
				</IconButton>
				<IconButton
					ref={more}
					size="s"
					label={t(locale, 'More')}
					aria-expanded={menu}
					onClick={() => setMenu(true)}>
					<Glyph name="more" size={12} />
				</IconButton>
			</span>
			<MenuPopover
				open={menu}
				onClose={() => setMenu(false)}
				anchor={more}
				label={schedule.name}
				locale={locale}
				align="end">
				<MenuItem
					icon={<Glyph name="resume" size={14} />}
					onSelect={() => void window.brigadir.runScheduleNow(projectId, id).catch(fail)}>
					{t(locale, 'Run now')}
				</MenuItem>
				<MenuItem
					icon={<Glyph name={schedule.paused ? 'schedule' : 'pause'} size={14} />}
					onSelect={() =>
						void window.brigadir.setSchedulePaused(projectId, id, !schedule.paused).catch(fail)
					}>
					{t(locale, schedule.paused ? 'Resume (schedule)' : 'Pause')}
				</MenuItem>
				<MenuItem icon={<Glyph name="edit" size={14} />} onSelect={onOpen}>
					{t(locale, 'Edit schedule…')}
				</MenuItem>
			</MenuPopover>
		</div>
	);
}
