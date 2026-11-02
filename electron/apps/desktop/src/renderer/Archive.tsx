import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { ProjectIcon } from './ui/ProjectIcon';
import {
	archiveAge,
	archiveDays,
	archiveDeleteTitle,
	archiveGroups,
	archiveMonthLabel,
	archiveSearch,
	archiveWhen,
	defaultArchiveAfterDays,
	keptWorktreeLabel,
	fileCount,
	projectColors,
	swipeAction,
	formatAccelerator,
	t,
	withShortcut,
	taskBranch,
	type AgentTask,
	type Locale,
	type MessageKey,
	type Project,
	type TaskKey,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { useCommandShortcut } from './ui/use-command-shortcut';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import { Button, IconButton, Popup, PopupMarks, Segments, StatusGlyph } from './ui/Controls';
import { PopupClose } from './ui/PopupClose';
import { StateStrip } from './ui/StateStrip';
import { ChangeCounts } from './ui/ChangeCounts';
import { toastError } from './ui/Toast';
import s from './Archive.module.css';
import { primaryKey } from './ui/primary-key';
const key = (task: TaskKey) => ({ projectId: task.projectId, id: task.id });
const same = (a: TaskKey, b: TaskKey) => a.projectId === b.projectId && a.id === b.id;

/* ── Toast (spec/tasks#archive, spec/tasks#archive-actions): «X» is in the archive / «X» is done · Restore, 6 s at the bottom of the sidebar ── */
type ArchiveToastKind = 'archive' | 'complete';
type ArchiveToastState = {
	toast: { id: number; title: string; task: TaskKey; kind: ArchiveToastKind } | null;
};
const useArchiveToast = create<ArchiveToastState>(() => ({ toast: null }));
let toastId = 0;
export function showArchiveToast(task: AgentTask, kind: ArchiveToastKind = 'archive') {
	useArchiveToast.setState({ toast: { id: ++toastId, title: task.title, task: key(task), kind } });
}
export function ArchiveToast({ locale }: { locale: Locale }) {
	const toast = useArchiveToast((state) => state.toast);
	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(
			() =>
				useArchiveToast.setState((state) =>
					state.toast?.id === toast.id ? { toast: null } : state
				),
			6000
		);
		return () => clearTimeout(timer);
	}, [toast?.id]);
	if (!toast) return null;
	return (
		<div key={toast.id} className={s.toast} role="status" data-archive-toast={toast.kind}>
			<Glyph name={toast.kind === 'complete' ? 'agent-idle' : 'archive-box'} size={14} />
			<span>
				{t(
					locale,
					toast.kind === 'complete' ? '«{title}» is completed' : '«{title}» is in the archive'
				).replace('{title}', toast.title)}
			</span>
			<Button
				size="s"
				appearance="primary"
				variant="ghost"
				onClick={() => {
					useArchiveToast.setState({ toast: null });
					if (toast.kind === 'complete') reopenTask(toast.task, locale);
					else restoreTask(toast.task, toast.title, locale);
				}}>
				{t(locale, 'Restore')}
			</Button>
		</div>
	);
}
/** spec/notifications-slack-notes-and-schedules#message-classes: Restore from the toast or the strip; a failure is an error toast with Retry. */
function restoreTask(task: TaskKey, title: string, locale: Locale) {
	void restoreTasks([task]).catch(() =>
		toastError(t(locale, 'Could not restore «{title}».').replace('{title}', title), {
			action: { label: t(locale, 'Retry'), run: () => restoreTask(task, title, locale) },
		})
	);
}
/** Archive by hand: the same path for the menu, ⌃⌘A and the swipe; the toast offers Restore. */
export async function archiveTask(task: AgentTask) {
	await window.brigadir.archiveTask(key(task));
	showArchiveToast(task);
	await useWorkspace.getState().load();
}
/** spec/tasks#archive-actions: the swipe completes a task in progress — the board's path; the toast's Restore moves it back into progress (Done). */
export async function completeTask(task: AgentTask) {
	await window.brigadir.moveTask(key(task), 'completed');
	showArchiveToast(task, 'complete');
	await useWorkspace.getState().load();
}
function reopenTask(task: TaskKey, locale: Locale) {
	void window.brigadir
		.moveTask(task, 'progress')
		.then(() => useWorkspace.getState().load())
		.catch(() => toastError(t(locale, 'Could not move the task.')));
}
export async function restoreTasks(tasks: readonly TaskKey[]) {
	await window.brigadir.restoreTasks(tasks.map(key));
	await useWorkspace.getState().load();
}

/* ── Swipe two fingers left over a card (spec/tasks#archive): partial shows the action, full archives ── */
const swipeWidth = 92,
	swipeMax = 140,
	swipeEndMs = 160;
/** `row`: the child is a completed task's quiet row (spec/sidebar#done-rows), the action takes its radius. */
export function SwipeToArchive({
	task,
	tasks,
	locale,
	children,
	row = false,
}: {
	task: AgentTask;
	tasks: readonly AgentTask[];
	locale: Locale;
	children: ReactNode;
	row?: boolean;
}) {
	const [offset, setOffset] = useState(0),
		[settling, setSettling] = useState(false),
		current = useRef(0),
		timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const action = swipeAction(task, tasks);
	useEffect(() => () => clearTimeout(timer.current), []);
	const end = () => {
		const reached = current.current >= swipeWidth;
		setSettling(true);
		current.current = 0;
		setOffset(reached ? swipeMax : 0);
		if (reached && action)
			void (action === 'complete' ? completeTask : archiveTask)(task)
				.then(() => {
					if (action === 'complete') {
						setSettling(true);
						setOffset(0);
					}
				})
				.catch(() => {
					setOffset(0);
					toastError(
						t(
							locale,
							action === 'complete' ? 'Could not complete the task.' : 'Could not archive the task.'
						)
					);
				});
	};
	return (
		<div
			className={s.swipe}
			data-swipe={task.id}
			data-row={row || undefined}
			data-swiping={offset > 0 || undefined}
			data-settling={settling || undefined}
			onWheel={(event) => {
				if (!action || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
				const next = Math.max(0, Math.min(swipeMax, current.current + event.deltaX));
				current.current = next;
				setSettling(false);
				setOffset(next);
				clearTimeout(timer.current);
				timer.current = setTimeout(end, swipeEndMs);
			}}
			onTransitionEnd={() => setSettling(false)}>
			<div className={s.swipeAction} aria-hidden="true" data-swipe-action={action ?? undefined}>
				<span>
					<Glyph name={action === 'complete' ? 'agent-idle' : 'archive-box'} size={16} />
					{t(locale, action === 'complete' ? 'Complete' : 'Archive')}
				</span>
			</div>
			{offset > 0 ? <div style={{ translate: `${-offset}px 0` }}>{children}</div> : children}
		</div>
	);
}

/** The mini button (spec/tasks#archive): the archive's count, in the sidebar header and on a project's row; there is none while the archive is empty. */
export function ArchiveHeaderButton({
	count,
	locale,
	onClick,
	project = false,
}: {
	count: number;
	locale: Locale;
	onClick(): void;
	project?: boolean;
}) {
	const shortcut = useCommandShortcut()('archive');
	if (!count) return null;
	const label = t(locale, 'Archive (noun)');
	return (
		<IconButton
			size="s"
			shape="auto"
			className={s.headerButton}
			hint={withShortcut(label, shortcut)}
			label={`${label} · ${count}`}
			data-archive-button
			data-archive-scope={project ? 'project' : 'all'}
			onClick={onClick}>
			<Glyph name="archive-box" size={15} />
			<span>{count}</span>
		</IconButton>
	);
}
/** The labelled button on the project screen, left of Board / List (spec/tasks#archive). */
export function ArchiveScreenButton({
	count,
	locale,
	onClick,
}: {
	count: number;
	locale: Locale;
	onClick(): void;
}) {
	const shortcut = useCommandShortcut()('archive');
	if (!count) return null;
	const label = t(locale, 'Archive (noun)');
	return (
		<Button
			title={withShortcut(label, shortcut)}
			aria-label={`${label} · ${count}`}
			data-archive-button
			data-archive-scope="screen"
			onClick={onClick}>
			<Glyph name="archive-box" size={13} />
			{label}
			<span className={s.screenCount}>{count}</span>
		</Button>
	);
}
/** Over the composer of an archived task (spec/tasks#archive). */
export function ArchivedStrip({
	task,
	locale,
	onRelay,
}: {
	task: AgentTask;
	locale: Locale;
	onRelay?: (() => void) | undefined;
}) {
	return (
		<StateStrip
			data-archived-strip
			icon={<Glyph name="archive-box" size={14} />}
			text={t(locale, 'The task is in the archive. The transcript is read-only.')}>
			<Button appearance="primary" onClick={() => restoreTask(task, task.title, locale)}>
				<Glyph name="archive-restore" size={12} />
				{t(locale, 'Restore from archive')}
			</Button>
			{onRelay && (
				<Button variant="ghost" onClick={onRelay}>
					<Glyph name="relay" size={12} />
					{t(locale, 'Continue in a new task')}
				</Button>
			)}
		</StateStrip>
	);
}

/* ── The Archive window (spec/tasks#archive) ── */
type Way = 'all' | 'manual' | 'auto';
export function ArchiveWindow({
	workspace,
	locale,
	projectId,
	close,
	openTask,
	openSettings,
	searchAll,
	taskMenu,
}: {
	workspace: WorkspaceSnapshot;
	locale: Locale;
	projectId: string | null;
	close(): void;
	openTask(task: AgentTask): void;
	openSettings(): void;
	searchAll(query: string): void;
	taskMenu(task: AgentTask): Promise<string | null>;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		input = useRef<HTMLInputElement>(null),
		list = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState(''),
		[project, setProject] = useState<string | null>(projectId),
		[way, setWay] = useState<Way>('all');
	const [selected, setSelected] = useState<TaskKey[]>([]),
		[anchor, setAnchor] = useState<TaskKey | null>(null),
		[deleting, setDeleting] = useState<AgentTask[] | null>(null),
		[error, setError] = useState('');
	const days =
		useWorkspace((state) => state.appearance.archiveAfterDays) ?? defaultArchiveAfterDays;
	useLayoutEffect(() => {
		const previous = document.activeElement,
			node = dialog.current;
		node?.showModal();
		input.current?.focus();
		return () => {
			node?.close();
			if (previous instanceof HTMLElement && previous.isConnected)
				previous.focus({ preventScroll: true });
		};
	}, []);
	const now = Date.now(),
		colors = projectColors(workspace.projects.map((item) => item.id));
	const rows = useMemo(
		() =>
			archiveSearch(
				workspace.tasks,
				workspace.projects,
				{ query, projectId: project, by: way === 'all' ? null : way },
				locale
			),
		[workspace, query, project, way, locale]
	);
	const total = useMemo(
		() =>
			archiveSearch(workspace.tasks, workspace.projects, { query: '', projectId: null, by: null })
				.length,
		[workspace]
	);
	// The selection follows the rows: a restored or deleted task leaves it, the first row is chosen when nothing is.
	const chosen = rows.filter((task) => selected.some((item) => same(item, task)));
	useEffect(() => {
		if (!chosen.length && rows.length) setSelected([key(rows[0]!)]);
	}, [rows.map((task) => task.id).join('|')]);
	const current = chosen.length === 1 ? chosen[0]! : null,
		index = current ? rows.findIndex((task) => same(task, current)) : -1;
	const select = (
		task: AgentTask,
		event?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }
	) => {
		if (event?.shiftKey && anchor) {
			const from = rows.findIndex((item) => same(item, anchor)),
				to = rows.findIndex((item) => same(item, task));
			if (from >= 0 && to >= 0) {
				setSelected(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map(key));
				return;
			}
		}
		if (event && primaryKey(event)) {
			setAnchor(key(task));
			setSelected((values) =>
				values.some((item) => same(item, task))
					? values.filter((item) => !same(item, task))
					: [...values, key(task)]
			);
			return;
		}
		setAnchor(key(task));
		setSelected([key(task)]);
	};
	// spec/notifications-slack-notes-and-schedules#message-classes: the window is modal, a toast would sit under it — a failure is a line in the window that names the action.
	const fail = (key: MessageKey) => () => setError(t(locale, key));
	const restore = (tasks: readonly AgentTask[]) => {
		if (!tasks.length) return;
		setError('');
		void restoreTasks(tasks).catch(fail('Could not restore from the archive.'));
	};
	const open = (task: AgentTask | null) => {
		if (!task) return;
		close();
		openTask(task);
	};
	const groups = archiveGroups(rows, now),
		projectName = (id: string) => workspace.projects.find((item) => item.id === id)?.name ?? '';
	const groupLabel = (groupKey: ReturnType<typeof archiveGroups>[number]['key']) =>
		groupKey === 'today'
			? t(locale, 'Today')
			: groupKey === 'week'
				? t(locale, 'This week')
				: archiveMonthLabel(groupKey, locale, now);
	return (
		<dialog
			ref={dialog}
			className={s.window}
			aria-label={t(locale, 'Archive (noun)')}
			data-archive-window
			onCancel={(event) => {
				event.preventDefault();
				if (!deleting) close();
			}}
			onKeyDown={(event) => {
				if (deleting || event.defaultPrevented || event.nativeEvent.isComposing) return;
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					if (!rows.length) return;
					const next =
						rows[
							Math.max(
								0,
								Math.min(
									rows.length - 1,
									index < 0 ? 0 : index + (event.key === 'ArrowDown' ? 1 : -1)
								)
							)
						]!;
					select(next);
					requestAnimationFrame(() =>
						list.current
							?.querySelector(`[data-archive-item="${next.id}"]`)
							?.scrollIntoView({ block: 'nearest' })
					);
				} else if (
					event.key === 'Enter' &&
					!primaryKey(event) &&
					// spec/tasks#archive-window: a focused control (Open, Delete, Settings, a row's Restore reached by Tab) keeps its Enter.
					!(
						event.target instanceof Element &&
						event.target.closest('button, a, [role=radio]')?.classList.contains(s.itemMain!) ===
							false
					)
				) {
					event.preventDefault();
					restore(chosen);
				} else if (primaryKey(event) && event.key.toLowerCase() === 'o') {
					event.preventDefault();
					open(current);
				} else if (
					primaryKey(event) &&
					event.key === 'Backspace' &&
					!(event.target instanceof HTMLInputElement && event.target.value)
				) {
					event.preventDefault();
					if (chosen.length) setDeleting(chosen);
				}
			}}>
			<header className={s.windowHead} data-size="m">
				<Glyph name="archive-box" size={16} />
				<h2>{t(locale, 'Archive (noun)')}</h2>
				<label className={s.field}>
					<Glyph name="search" size={13} />
					<input
						ref={input}
						aria-label={t(locale, 'Search the archive: title, prompt, branch')}
						placeholder={t(locale, 'Search the archive: title, prompt, branch')}
						value={query}
						maxLength={200}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<ClearField locale={locale} value={query} onClear={() => setQuery('')} />
					<small>{rows.length}</small>
				</label>
				<div className={s.projectPick}>
					{/* spec/tasks#archive-window: the chosen project carries ✓. */}
					<PopupMarks.Provider value>
						<Popup
							chevron
							label={t(locale, 'All projects')}
							value={project ?? '*'}
							options={[
								{ value: '*', label: t(locale, 'All projects') },
								...workspace.projects.map((item) => ({ value: item.id, label: item.name })),
							]}
							onChange={(value) => setProject(value === '*' ? null : value)}
						/>
					</PopupMarks.Provider>
				</div>
				<Segments
					label={t(locale, 'Archive (noun)')}
					value={way}
					options={[
						{ value: 'all', label: t(locale, 'All (archive)') },
						{ value: 'manual', label: t(locale, 'Manually') },
						{ value: 'auto', label: t(locale, 'Auto (archive)') },
					]}
					onChange={(value) => setWay(value as Way)}
				/>
				<PopupClose locale={locale} close={close} />
			</header>
			{error && (
				<p role="alert" className={s.group}>
					{error}
				</p>
			)}
			<div className={s.windowBody}>
				<div
					ref={list}
					className={s.list}
					role="listbox"
					aria-multiselectable="true"
					aria-label={t(locale, 'Tasks in the archive')}>
					{!rows.length ? (
						<div className={s.empty}>
							{query.trim() ? (
								<div>
									{t(locale, 'The archive has no «{query}».').replace('{query}', query.trim())}
									<br />
									<Button
										size="s"
										appearance="primary"
										variant="ghost"
										onClick={() => {
											close();
											searchAll(query.trim());
										}}>
										{t(locale, 'Search all tasks')}
									</Button>
								</div>
							) : (
								<div>{t(locale, total ? 'No results' : 'The archive is empty.')}</div>
							)}
						</div>
					) : (
						groups.map((group) => (
							<div key={group.key} role="group" aria-label={groupLabel(group.key)}>
								<div className={s.group} aria-hidden="true">
									{groupLabel(group.key)}
								</div>
								{group.tasks.map((task) => {
									const archived = task.archived!,
										branch = taskBranch(task),
										isSelected = chosen.some((item) => same(item, task)),
										restoreLabel = t(locale, 'Restore from archive');
									return (
										<div
											key={`${task.projectId}/${task.id}`}
											className={s.item}
											role="option"
											aria-selected={isSelected}
											data-archive-item={task.id}
											onContextMenu={(event) => {
												event.preventDefault();
												setAnchor(key(task));
												setSelected([key(task)]);
												void taskMenu(task)
													.then((action) => {
														if (action === 'open' || action === 'diff') close();
													})
													.catch(fail('The task menu action failed.'));
											}}>
											<button
												type="button"
												className={s.itemMain}
												tabIndex={-1}
												title={task.title}
												onClick={(event) => select(task, event)}
												onDoubleClick={() => open(task)}>
												<StatusGlyph status={archived.status} size={14} />
												<span className={s.itemCopy}>
													<b>{task.title}</b>
													<small>
														<span>
															{/* spec/appearance#evolution-redesign: the project's icon in place of its dot. */}
															<ProjectIcon
																className={s.dot}
																project={
																	workspace.projects.find((item) => item.id === task.projectId) ?? {
																		name: projectName(task.projectId),
																	}
																}
																slot={colors.get(task.projectId) ?? 0}
																size={14}
															/>
															{projectName(task.projectId)}
														</span>
														{branch && (
															<>
																<span>·</span>
																<code>{branch}</code>
															</>
														)}
													</small>
												</span>
												<span
													className={s.itemWhen}
													title={t(
														locale,
														archived.by === 'auto' ? 'Archived automatically' : 'Archived manually'
													)}>
													<Glyph
														name={archived.by === 'auto' ? 'clock' : 'archive-box'}
														size={11}
													/>
													{`${t(locale, archived.by === 'auto' ? 'auto (archive)' : 'manually')} · ${archiveWhen(locale, archived.at, now)}`}
												</span>
												{task.provider && (
													<span
														className={s.itemProvider}
														title={task.provider === 'claude' ? 'Claude' : 'Codex'}>
														<Glyph
															name={task.provider === 'claude' ? 'claude' : 'openai'}
															size={11}
														/>
													</span>
												)}
											</button>
											<IconButton
												size="s"
												className={s.itemRestore}
												label={restoreLabel}
												onClick={() => restore([task])}>
												<Glyph name="archive-restore" size={13} />
											</IconButton>
										</div>
									);
								})}
							</div>
						))
					)}
				</div>
				<aside className={s.preview} aria-label={t(locale, 'Preview')} data-archive-preview>
					{chosen.length > 1 ? (
						<div className={s.selection}>
							<h3>{t(locale, 'Selected {n}').replace('{n}', String(chosen.length))}</h3>
							<ul>
								{chosen.slice(0, 8).map((task) => (
									<li key={task.id}>{task.title}</li>
								))}
							</ul>
							<div className={s.previewActions}>
								<Button appearance="primary" onClick={() => restore(chosen)}>
									<Glyph name="archive-restore" size={12} />
									{t(locale, 'Restore {n}').replace('{n}', String(chosen.length))}
								</Button>
								<Button appearance="danger" variant="outline" onClick={() => setDeleting(chosen)}>
									{t(locale, 'Delete…')}
								</Button>
							</div>
						</div>
					) : current ? (
						<Preview
							task={current}
							locale={locale}
							project={workspace.projects.find((item) => item.id === current.projectId)}
							now={now}
							restore={() => restore([current])}
							open={() => open(current)}
							remove={() => setDeleting([current])}
						/>
					) : null}
				</aside>
			</div>
			<footer className={s.windowFoot}>
				<Button
					size="s"
					appearance="danger"
					variant="ghost"
					data-archive-delete-all
					disabled={!rows.length}
					title={t(locale, 'Delete all from the archive')}
					onClick={() => setDeleting(rows)}>
					<Glyph name="trash" size={12} />
					{t(locale, 'Delete all…')}
				</Button>
				<span>↑↓ {t(locale, 'Select (archive)')}</span>
				<span>
					{formatAccelerator('Enter')} {t(locale, 'restore')}
				</span>
				<span>
					{formatAccelerator('CmdOrCtrl+O')} {t(locale, 'open (archive)')}
				</span>
				<span>
					{formatAccelerator('CmdOrCtrl+Backspace')} {t(locale, 'delete…')}
				</span>
				<span>
					{days === null
						? t(locale, 'Auto-archive is off')
						: t(locale, 'Completed tasks go to the archive after {days}').replace(
								'{days}',
								archiveDays(locale, days)
							)}{' '}
					·{' '}
					<Button
						size="s"
						appearance="primary"
						variant="ghost"
						data-archive-settings
						onClick={() => {
							close();
							openSettings();
						}}>
						{t(locale, 'Settings')}
					</Button>
				</span>
			</footer>
			{deleting && (
				<DeleteArchived
					tasks={deleting}
					locale={locale}
					cancel={() => {
						setDeleting(null);
						input.current?.focus();
					}}
					confirm={async () => {
						try {
							await window.brigadir.deleteArchivedTasks(deleting.map(key));
							await useWorkspace.getState().load();
						} catch {
							fail('Could not delete from the archive.')();
						}
						setDeleting(null);
						input.current?.focus();
					}}
				/>
			)}
		</dialog>
	);
}
function Preview({
	task,
	locale,
	project,
	now,
	restore,
	open,
	remove,
}: {
	task: AgentTask;
	locale: Locale;
	project: Project | undefined;
	now: number;
	restore(): void;
	open(): void;
	remove(): void;
}) {
	const archived = task.archived!,
		branch = taskBranch(task),
		counts = task.changeSummary;
	const meta = [
		project?.name,
		task.provider === 'claude' ? 'Claude' : task.provider === 'codex' ? 'Codex' : null,
		task.completedAt
			? t(locale, 'completed {when}').replace('{when}', archiveWhen(locale, task.completedAt, now))
			: null,
		t(locale, 'in the archive {when}').replace('{when}', archiveWhen(locale, archived.at, now)),
	]
		.filter(Boolean)
		.join(' · ');
	const prompt = (task.prompt ?? '').trim();
	return (
		<>
			<header>
				<h3>{task.title}</h3>
				<small>{meta}</small>
			</header>
			{prompt && prompt !== task.title && <p className={s.prompt}>{prompt}</p>}
			<div className={s.facts}>
				{branch && (
					<div className={s.fact}>
						<Glyph name="sidebar-branch" size={12} />
						<span>
							{t(locale, 'Branch {branch} stays')
								.split('{branch}')
								.flatMap((part, index) =>
									index ? [<code key={index}>{branch}</code>, part] : [part]
								)}
						</span>
					</div>
				)}
				<div
					className={s.fact}
					data-kept={archived.worktree === 'kept' || undefined}
					data-archive-worktree={archived.worktree}>
					<Glyph
						name={
							archived.worktree === 'kept'
								? 'archive-warn'
								: archived.worktree === 'removed'
									? 'sidebar-worktree'
									: 'archive-box'
						}
						size={12}
					/>
					<span>
						{archived.worktree === 'kept'
							? keptWorktreeLabel(locale, archived.uncommitted ?? 0)
							: archived.worktree === 'removed'
								? t(
										locale,
										'The worktree is removed. Continuing the task creates it again from this branch.'
									)
								: t(locale, 'No worktree: the task worked in the main tree.')}
					</span>
				</div>
				{counts && (counts.additions > 0 || counts.deletions > 0) && (
					<div className={s.fact}>
						<Glyph name="diff" size={12} />
						<span>
							<ChangeCounts
								additions={counts.additions}
								deletions={counts.deletions}
								locale={locale}
								data-archive-counts
							/>{' '}
							· {t(locale, 'change snapshots are in place')}
						</span>
					</div>
				)}
			</div>
			<div className={s.previewActions}>
				<Button appearance="primary" onClick={restore} data-archive-restore>
					<Glyph name="archive-restore" size={12} />
					{t(locale, 'Restore')}
				</Button>
				<Button onClick={open}>{t(locale, 'Open')}</Button>
				<Button
					appearance="danger"
					variant="outline"
					data-archive-preview-delete
					title={t(locale, 'Delete task…')}
					onClick={remove}>
					<Glyph name="trash" size={13} />
					{t(locale, 'Delete')}
				</Button>
			</div>
		</>
	);
}
function DeleteArchived({
	tasks,
	locale,
	cancel,
	confirm,
}: {
	tasks: readonly AgentTask[];
	locale: Locale;
	cancel(): void;
	confirm(): Promise<void>;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		action = useRef<HTMLButtonElement>(null),
		[busy, setBusy] = useState(false);
	useLayoutEffect(() => {
		const node = dialog.current;
		node?.showModal();
		// spec/tasks#archive-window: showModal() focuses the first control (Esc); Delete is the one in focus.
		action.current?.focus({ preventScroll: true });
		return () => node?.close();
	}, []);
	const branches = [
			...new Set(tasks.map(taskBranch).filter((branch): branch is string => !!branch)),
		],
		kept = tasks.reduce(
			(sum, task) =>
				sum + (task.archived?.worktree === 'kept' ? (task.archived.uncommitted ?? 0) : 0),
			0
		);
	return (
		<dialog
			ref={dialog}
			className={s.confirm}
			aria-label={archiveDeleteTitle(locale, tasks.length)}
			data-archive-delete
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) cancel();
			}}>
			<header>
				<h2>{archiveDeleteTitle(locale, tasks.length)}</h2>
				<PopupClose locale={locale} close={cancel} />
			</header>
			<div>
				<div className={s.fact} data-loss="true">
					<Glyph name="trash" size={12} />
					<span>{t(locale, 'Chat logs and change snapshots go to the Trash')}</span>
				</div>
				{branches.length > 0 && (
					<div className={s.fact}>
						<Glyph name="sidebar-branch" size={12} />
						<span>
							{t(locale, 'Branches stay: {branches}').replace('{branches}', branches.join(', '))}
						</span>
					</div>
				)}
				{kept ? (
					<div className={s.fact} data-loss="true">
						<Glyph name="archive-warn" size={12} />
						<span>
							{t(locale, 'Worktrees with uncommitted changes are removed: {files}').replace(
								'{files}',
								fileCount(locale, kept)
							)}
						</span>
					</div>
				) : (
					<div className={s.fact}>
						<Glyph name="archive-box" size={12} />
						<span>
							{t(
								locale,
								tasks.some((task) => task.archived?.worktree === 'removed')
									? 'Worktrees were already removed by the archive; nothing is lost'
									: 'No worktrees to remove'
							)}
						</span>
					</div>
				)}
			</div>
			<footer>
				<Button onClick={cancel} disabled={busy}>
					{t(locale, 'Cancel')}
				</Button>
				<Button
					ref={action}
					appearance="danger"
					variant="outline"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void confirm().finally(() => setBusy(false));
					}}>
					{t(locale, 'Delete')}
				</Button>
			</footer>
		</dialog>
	);
}
