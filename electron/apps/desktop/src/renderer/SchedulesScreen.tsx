import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
	describeRule,
	formatSlot,
	scheduleState,
	t,
	type AgentTask,
	type Locale,
	type MessageKey,
	type Project,
	type ScheduleRun,
	type ScheduleState,
	type ScheduleSummary,
} from '@brigadir/core';
import { Button, IconButton, Segments, Switch } from './ui/Controls';
import { TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { ProjectIcon } from './ui/ProjectIcon';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { MenuItem, MenuPopover } from './ui/Popover';
import { ScheduleEditor, type ScheduleTiming } from './ui/ScheduleEditor';
import { showToast, toastError } from './ui/Toast';
import s from './SchedulesScreen.module.css';
import { SkeletonText } from './ui/Loading';

/** spec/notifications-slack-notes-and-schedules#schedules: every schedule, one shared read kept fresh by `schedules:changed` and a minute's tick; null until the first read. */
const useScheduleList = create<{ list: ScheduleSummary[] | null }>(() => ({ list: null }));
let watchers = 0,
	unwatch: (() => void) | null = null;
function watchSchedules() {
	if (watchers++ > 0) return;
	const read = () =>
		void window.brigadir
			.listSchedules()
			.then((list) => useScheduleList.setState({ list }))
			.catch(() => useScheduleList.setState((state) => ({ list: state.list ?? [] })));
	read();
	const stop = window.brigadir.onSchedulesChanged(read),
		timer = setInterval(read, 60_000);
	unwatch = () => {
		stop();
		clearInterval(timer);
	};
}
export function useSchedules() {
	useEffect(() => {
		watchSchedules();
		return () => {
			if (--watchers === 0) {
				unwatch?.();
				unwatch = null;
			}
		};
	}, []);
	return useScheduleList((state) => state.list);
}
export const stateGlyph: Record<
	ScheduleState,
	{
		glyph:
			'schedule' | 'agent-run' | 'check-skipped' | 'agent-failed' | 'pause' | 'agent-completed';
		tone: string;
	}
> = {
	scheduled: { glyph: 'schedule', tone: 'var(--fg2)' },
	running: { glyph: 'agent-run', tone: 'var(--accent)' },
	ask: { glyph: 'check-skipped', tone: 'var(--amber)' },
	failed: { glyph: 'agent-failed', tone: 'var(--red)' },
	paused: { glyph: 'pause', tone: 'var(--fg3)' },
	done: { glyph: 'agent-completed', tone: 'var(--fg3)' },
};
/** «in 25 min» within the hour, else the slot — the list's and the table's «Next run». */
export function nextText(locale: Locale, schedule: ScheduleSummary, now = Date.now()) {
	if (!schedule.nextRun) return '';
	const ms = Date.parse(schedule.nextRun) - now;
	if (ms < 3_600_000) {
		const minutes = Math.max(1, Math.round(ms / 60_000));
		return locale === 'uk' ? `за ${minutes} хв` : `in ${minutes} min`;
	}
	return formatSlot(locale, schedule.nextRun, schedule.timeZone);
}
export function stateText(
	locale: Locale,
	state: ScheduleState,
	schedule: ScheduleSummary,
	now = Date.now()
): string {
	switch (state) {
		case 'running':
			return t(locale, 'Running');
		case 'ask':
			return t(locale, 'Missed · needs your answer');
		case 'failed':
			return t(locale, 'Last run failed');
		case 'paused':
			return t(locale, 'Paused');
		case 'done':
			return t(locale, 'Completed');
		case 'scheduled':
			return nextText(locale, schedule, now);
	}
}
const runLabel: Record<ScheduleRun['status'], MessageKey> = {
	started: 'Working',
	skipped: 'Skipped',
	missed: 'Missed',
	'failed-to-start': 'Could not start',
};

/**
 * spec/notifications-slack-notes-and-schedules#schedules: the main area of the Schedules section. A schedule — its header with Run
 * now · Pause · Edit, the facts, the prompt and the runs by day; Edit opens the editor as a column on the right, every
 * change saved at once. `All schedules` — the table of every schedule with its switch.
 */
export function SchedulesScreen({
	locale,
	projects,
	tasks,
	selected,
	onSelect,
	onOpenTask,
	onNew,
}: {
	locale: Locale;
	projects: Project[];
	tasks: AgentTask[];
	selected: { projectId: string; id: string } | 'all';
	onSelect(schedule: { projectId: string; id: string } | 'all'): void;
	onOpenTask(projectId: string, id: string): void;
	onNew(): void;
}) {
	const schedules = useSchedules();
	const schedule =
		selected === 'all'
			? null
			: (schedules?.find(
					(item) => item.projectId === selected.projectId && item.id === selected.id
				) ?? null);
	if (!schedules) return <SkeletonText lines={8} />;
	if (!schedules.length || (selected !== 'all' && !schedule))
		return (
			<div className={s.empty}>
				<Glyph name="schedule" size={40} />
				<h1>{t(locale, 'No schedules')}</h1>
				<Button appearance="primary" onClick={onNew}>
					<Glyph name="plus" size={13} />
					{t(locale, 'New schedule')}
				</Button>
			</div>
		);
	return schedule ? (
		<ScheduleView
			key={`${schedule.projectId}/${schedule.id}`}
			locale={locale}
			schedule={schedule}
			projects={projects}
			tasks={tasks}
			onOpenTask={onOpenTask}
			onGone={() => onSelect('all')}
		/>
	) : (
		<ScheduleTable
			locale={locale}
			schedules={schedules}
			projects={projects}
			tasks={tasks}
			onSelect={onSelect}
		/>
	);
}

function ScheduleTable({
	locale,
	schedules,
	projects,
	tasks,
	onSelect,
}: {
	locale: Locale;
	schedules: ScheduleSummary[];
	projects: Project[];
	tasks: AgentTask[];
	onSelect(schedule: { projectId: string; id: string }): void;
}) {
	const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
	const shown = schedules.filter(
		(item) => filter === 'all' || (filter === 'paused') === item.paused
	);
	const active = schedules.filter((item) => !item.paused).length;
	return (
		<section className={s.screen} aria-label={t(locale, 'All schedules')}>
			<header className={s.header} data-size="s">
				<h1>{t(locale, 'All schedules')}</h1>
				<span className={s.spacer} />
				<Segments
					label={t(locale, 'Filter schedules')}
					options={[
						{ value: 'all', label: `${t(locale, 'All')} · ${schedules.length}` },
						{ value: 'active', label: `${t(locale, 'Active')} · ${active}` },
						{ value: 'paused', label: `${t(locale, 'Paused')} · ${schedules.length - active}` },
					]}
					value={filter}
					onChange={(value) => setFilter(value as typeof filter)}
				/>
			</header>
			<div className={s.table} role="table" aria-label={t(locale, 'All schedules')}>
				<div className={s.th} role="row">
					<span role="columnheader">{t(locale, 'Name')}</span>
					<span role="columnheader">{t(locale, 'Repeat (field)')}</span>
					<span role="columnheader">{t(locale, 'Next run')}</span>
					<span role="columnheader">{t(locale, 'Last run')}</span>
					<span role="columnheader">{t(locale, 'On')}</span>
				</div>
				{projects
					.map((project) => ({
						project,
						rows: shown.filter((item) => item.projectId === project.id),
					}))
					.filter((group) => group.rows.length)
					.map(({ project, rows }) => (
						<div key={project.id} role="rowgroup">
							<div className={s.group}>
								<ProjectIcon project={project} slot={0} />
								{project.name}
							</div>
							{rows.map((item) => {
								const state = scheduleState(item, tasks),
									last = item.lastRun;
								return (
									<div
										key={item.id}
										className={s.tr}
										role="row"
										data-paused={item.paused || undefined}>
										<button
											className={s.rowButton}
											onClick={() => onSelect({ projectId: item.projectId, id: item.id })}>
											<Glyph name={item.rule.kind === 'once' ? 'clock' : 'schedule'} size={13} />
											<span>{item.name}</span>
										</button>
										<span role="cell">{describeRule(locale, item.rule, item.timeZone)}</span>
										<small role="cell">
											{item.paused ? t(locale, 'Paused') : nextText(locale, item)}
										</small>
										<span role="cell" className={s.last} style={{ color: stateGlyph[state].tone }}>
											{last && (
												<>
													<Glyph
														name={
															stateGlyph[
																state === 'scheduled' || state === 'paused' ? 'done' : state
															].glyph
														}
														size={13}
													/>
													{formatSlot(locale, last.due, item.timeZone)}
												</>
											)}
										</span>
										<span role="cell" className={s.raised}>
											<Switch
												size="s"
												label={t(locale, item.paused ? 'Resume (schedule)' : 'Pause')}
												checked={!item.paused}
												onChange={(on) =>
													void window.brigadir
														.setSchedulePaused(item.projectId, item.id, !on)
														.catch(() => toastError(t(locale, 'Could not save the schedule.')))
												}
											/>
										</span>
									</div>
								);
							})}
						</div>
					))}
			</div>
		</section>
	);
}

function ScheduleView({
	locale,
	schedule,
	projects,
	tasks,
	onOpenTask,
	onGone,
}: {
	locale: Locale;
	schedule: ScheduleSummary;
	projects: Project[];
	tasks: AgentTask[];
	onOpenTask(projectId: string, id: string): void;
	onGone(): void;
}) {
	const [editing, setEditing] = useState(false),
		[runs, setRuns] = useState<ScheduleRun[] | null>(null),
		[menu, setMenu] = useState(false),
		[deleting, setDeleting] = useState(false),
		[name, setName] = useState(schedule.name);
	const more = useRef<HTMLButtonElement>(null),
		save = useRef<ReturnType<typeof setTimeout> | null>(null),
		// spec/notifications-slack-notes-and-schedules#schedules: Undo in the toast puts back the schedule as it was before this round of edits.
		before = useRef(schedule);
	const { projectId, id } = schedule;
	useEffect(() => {
		let active = true;
		void window.brigadir
			.readScheduleRuns(projectId, id)
			.then((items) => active && setRuns(items))
			.catch(() => active && setRuns([]));
		return () => {
			active = false;
		};
	}, [projectId, id, schedule.lastRun?.at, schedule.checkedUntil]);
	const state = scheduleState(schedule, tasks),
		project = projects.find((item) => item.id === projectId);
	const write = (timing: ScheduleTiming, nextName = name) => {
		if (save.current) clearTimeout(save.current);
		save.current = setTimeout(() => {
			const old = before.current;
			void window.brigadir
				.editSchedule(projectId, id, {
					name: nextName.trim() || schedule.name,
					timeZone: timing.timeZone,
					rule: timing.rule,
					missed: timing.missed,
					inTasks: timing.inTasks,
					task: schedule.task,
				})
				.then(() =>
					showToast(t(locale, 'Schedule saved'), {
						label: t(locale, 'Undo'),
						run: () => {
							setName(old.name);
							setTiming({
								rule: old.rule,
								timeZone: old.timeZone,
								missed: old.missed,
								inTasks: old.inTasks,
							});
							void window.brigadir
								.editSchedule(projectId, id, {
									name: old.name,
									timeZone: old.timeZone,
									rule: old.rule,
									missed: old.missed,
									inTasks: old.inTasks,
									task: old.task,
								})
								.catch(() => toastError(t(locale, 'Could not save the schedule.')));
						},
					})
				)
				.catch(() => toastError(t(locale, 'Could not save the schedule.')));
		}, 600);
	};
	const [timing, setTiming] = useState<ScheduleTiming>({
		rule: schedule.rule,
		timeZone: schedule.timeZone,
		missed: schedule.missed,
		inTasks: schedule.inTasks,
	});
	const byDay = useMemo(() => {
		const out: { day: string; rows: ScheduleRun[] }[] = [];
		for (const run of runs ?? []) {
			const day = new Intl.DateTimeFormat(locale === 'uk' ? 'uk' : 'en-GB', {
				timeZone: schedule.timeZone,
				weekday: 'short',
				day: 'numeric',
				month: 'short',
			}).format(Date.parse(run.due));
			const last = out[out.length - 1];
			if (last?.day === day) last.rows.push(run);
			else out.push({ day, rows: [run] });
		}
		return out;
	}, [runs, locale, schedule.timeZone]);
	const act = (work: Promise<unknown>) =>
		void work.catch(() => toastError(t(locale, 'Could not start the run.')));
	const agent = schedule.task.provider === 'codex' ? 'Codex' : 'Claude';
	return (
		<section className={s.screen} aria-label={schedule.name}>
			<header className={s.header} data-size="s">
				<Glyph name={schedule.rule.kind === 'once' ? 'clock' : 'schedule'} size={14} />
				<h1>
					{schedule.name}
					<small>{describeRule(locale, schedule.rule, schedule.timeZone)}</small>
				</h1>
				<span className={s.spacer} />
				<Button onClick={() => act(window.brigadir.runScheduleNow(projectId, id))}>
					<Glyph name="resume" size={13} />
					{t(locale, 'Run now')}
				</Button>
				<Button
					onClick={() => act(window.brigadir.setSchedulePaused(projectId, id, !schedule.paused))}>
					<Glyph name={schedule.paused ? 'schedule' : 'pause'} size={13} />
					{t(locale, schedule.paused ? 'Resume (schedule)' : 'Pause')}
				</Button>
				<Button aria-pressed={editing} onClick={() => setEditing((value) => !value)}>
					<Glyph name="edit" size={13} />
					{t(locale, 'Edit')}
				</Button>
				<IconButton
					ref={more}
					label={t(locale, 'More')}
					aria-expanded={menu}
					onClick={() => setMenu(true)}>
					<Glyph name="more" size={14} />
				</IconButton>
				<MenuPopover
					open={menu}
					onClose={() => setMenu(false)}
					anchor={more}
					label={schedule.name}
					locale={locale}
					align="end">
					{schedule.lastRun?.taskId && (
						<MenuItem
							icon={<Glyph name="chat" size={14} />}
							onSelect={() => onOpenTask(projectId, schedule.lastRun!.taskId!)}>
							{t(locale, 'Open last run')}
						</MenuItem>
					)}
					<MenuItem
						icon={<Glyph name="trash" size={14} />}
						danger
						onSelect={() => setDeleting(true)}>
						{t(locale, 'Delete schedule…')}
					</MenuItem>
				</MenuPopover>
			</header>
			{schedule.pendingMissed && (
				<div className={s.ask} role="alert" data-size="s">
					<Glyph name="check-skipped" size={14} />
					<span>{t(locale, 'Missed · needs your answer')}</span>
					<span className={s.spacer} />
					<Button onClick={() => act(window.brigadir.resolveScheduleMissed(projectId, id, 'skip'))}>
						{t(locale, 'Skip')}
					</Button>
					<Button
						appearance="primary"
						onClick={() => act(window.brigadir.resolveScheduleMissed(projectId, id, 'run'))}>
						{t(locale, 'Run now')}
					</Button>
				</div>
			)}
			<div className={s.body}>
				<div className={s.main}>
					<div className={s.facts}>
						<span style={{ color: stateGlyph[state].tone }}>
							<Glyph name={stateGlyph[state].glyph} size={12} />
							{stateText(locale, state, schedule)}
						</span>
						{project && (
							<span>
								<ProjectIcon project={project} slot={0} />
								<b>{project.name}</b>
							</span>
						)}
						<span>
							{t(locale, 'Agent')} <b>{agent}</b>
						</span>
						<span>
							{t(locale, 'Isolation')}{' '}
							<b>
								{schedule.task.launch?.isolation === 'worktree'
									? 'Worktree'
									: t(locale, 'No isolation')}
							</b>
						</span>
					</div>
					<div className={s.prompt}>{schedule.task.prompt}</div>
					{runs && !runs.length ? (
						<div className={s.empty} data-small>
							<Glyph name="schedule" size={28} />
							<h2>{t(locale, 'No runs yet')}</h2>
							{schedule.nextRun && (
								<p>
									{t(locale, 'First run: {when}').replace(
										'{when}',
										formatSlot(locale, schedule.nextRun, schedule.timeZone)
									)}
								</p>
							)}
						</div>
					) : (
						<>
							<h2 className={s.section}>
								{t(locale, 'Runs · {n}').replace('{n}', String(runs?.length ?? 0))}
							</h2>
							<div className={s.runs}>
								{byDay.map(({ day, rows }) => (
									<div key={day}>
										<div className={s.day}>{day}</div>
										{rows.map((run, index) => (
											<RunRow
												key={`${run.due}-${index}`}
												locale={locale}
												run={run}
												schedule={schedule}
												tasks={tasks}
												onOpenTask={onOpenTask}
											/>
										))}
									</div>
								))}
							</div>
						</>
					)}
				</div>
				{editing && (
					<aside className={s.edit} aria-label={t(locale, 'Edit')} data-size="m">
						<TextInput
							aria-label={t(locale, 'Name')}
							value={name}
							maxLength={120}
							onChange={(event) => {
								setName(event.currentTarget.value);
								write(timing, event.currentTarget.value);
							}}
						/>
						<ScheduleEditor
							locale={locale}
							value={timing}
							allowOnce={schedule.rule.kind === 'once'}
							onChange={(next, valid) => {
								setTiming(next);
								if (valid) write(next);
							}}
						/>
					</aside>
				)}
			</div>
			{deleting && (
				<ConfirmDialog
					title={t(locale, 'Delete the schedule?')}
					locale={locale}
					action={t(locale, 'Delete')}
					danger
					error={t(locale, 'Could not save the schedule.')}
					cancel={() => setDeleting(false)}
					confirm={async () => {
						await window.brigadir.deleteSchedule(projectId, id);
						setDeleting(false);
						onGone();
					}}>
					<p>
						<b>{schedule.name}</b>
					</p>
					<p>{t(locale, 'Its tasks stay; the run history is deleted.')}</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

function RunRow({
	locale,
	run,
	schedule,
	tasks,
	onOpenTask,
}: {
	locale: Locale;
	run: ScheduleRun;
	schedule: ScheduleSummary;
	tasks: AgentTask[];
	onOpenTask(projectId: string, id: string): void;
}) {
	const task = run.taskId
		? tasks.find((item) => item.projectId === schedule.projectId && item.id === run.taskId)
		: undefined;
	const time = new Intl.DateTimeFormat(locale === 'uk' ? 'uk' : 'en-GB', {
		timeZone: schedule.timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(Date.parse(run.due));
	const status = task?.status;
	const glyph =
		run.status === 'missed' || run.status === 'skipped'
			? { name: 'check-skipped' as const, tone: 'var(--amber)' }
			: run.status === 'failed-to-start' || status === 'failed'
				? { name: 'agent-failed' as const, tone: 'var(--red)' }
				: status === 'working' || status === 'preparing' || status === 'queued'
					? { name: 'agent-run' as const, tone: 'var(--accent)' }
					: status === 'needs-you'
						? { name: 'agent-permission' as const, tone: 'var(--amber)' }
						: {
								name: 'agent-completed' as const,
								tone: status === 'completed' ? 'var(--fg3)' : 'var(--green)',
							};
	const reason =
		run.reason === 'previous-run-active'
			? t(locale, 'Previous run still active')
			: run.reason === 'missed'
				? t(locale, 'The computer slept or the app was closed')
				: run.reason === 'asked-skip'
					? t(locale, 'You skipped it')
					: (task?.title ?? '');
	const label = task
		? t(
				locale,
				(
					{
						'needs-you': 'Needs you',
						failed: 'Error',
						completed: 'Completed',
						done: 'Turn completed',
						working: 'Working',
					} as Record<string, MessageKey>
				)[task.status] ?? 'Working'
			)
		: t(locale, runLabel[run.status]);
	const quiet = task?.scheduleRun?.quiet;
	const tag = task?.scheduleRun ? (
		<span
			className={quiet ? s.quiet : s.tag}
			title={t(locale, quiet ? 'Not shown in Tasks: finished without changes' : 'Shown in Tasks')}>
			{quiet ? (
				t(locale, 'Only here')
			) : (
				<>
					<Glyph name="board" size={11} />
					{t(locale, 'In Tasks')}
				</>
			)}
		</span>
	) : null;
	// spec/notifications-slack-notes-and-schedules#schedules: a failed run offers Retry on hover — a new run now, raised over the row's open button.
	const failed = run.status === 'failed-to-start' || status === 'failed';
	const retry = failed ? (
		<Button
			size="s"
			className={s.retry}
			onClick={(event) => {
				event.stopPropagation();
				void window.brigadir
					.runScheduleNow(schedule.projectId, schedule.id)
					.catch(() => toastError(t(locale, 'Could not start the run.')));
			}}>
			{t(locale, 'Retry')}
		</Button>
	) : null;
	const content = (
		<>
			<span className={s.glyph} style={{ color: glyph.tone }}>
				<Glyph name={glyph.name} size={14} />
			</span>
			<time>{time}</time>
			<span className={s.runText}>
				{label}
				{reason && <small>{reason}</small>}
			</span>
			<em>
				{tag}
				{retry}
			</em>
		</>
	);
	return (
		<div className={s.run} data-missed={(run.status !== 'started' && !failed) || undefined}>
			{task && (
				<button
					className={s.runOpen}
					aria-label={`${t(locale, 'Open task')} · ${task.title}`}
					onClick={() => onOpenTask(schedule.projectId, task.id)}
					data-run-task={task.id}
				/>
			)}
			{content}
		</div>
	);
}
