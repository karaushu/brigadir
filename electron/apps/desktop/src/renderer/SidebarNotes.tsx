import { useMemo, useState } from 'react';
import {
	relativeAge,
	t,
	type Locale,
	type NoteDocument,
	type NoteSummary,
	type Project,
} from '@brigadir/core';
import { useNotes } from './NotesScreen';
import { SearchField } from './ui/PanelSearch';
import { IconButton } from './ui/Controls';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Glyph } from './ui/Glyph';
import { ProjectIcon, projectToneStyle } from './ui/ProjectIcon';
import { toastError } from './ui/Toast';
import { SkeletonRows } from './ui/Loading';
import styles from './App.module.css';

/**
 * spec/sidebar#section-rail: the sidebar of the Notes section — the filter field and New note,
 * then the notes in groups as the tasks are drawn (rule 17): `No project` first, then each project with notes. A row is the
 * task row: the note glyph, the title, «edited … · N tasks». A row opens the note on the Notes screen; its menu and the
 * delete confirmation are the screen's (spec/notifications-slack-notes-and-schedules#notes).
 */
export function SidebarNotes({
	locale,
	projects,
	colors,
	selected,
	onOpen,
	onCreateTask,
}: {
	locale: Locale;
	projects: Project[];
	colors: Map<string, number>;
	selected: string | null;
	onOpen(id: string): void;
	onCreateTask(note: NoteDocument): void;
}) {
	const notes = useNotes(),
		[query, setQuery] = useState(''),
		[collapsed, setCollapsed] = useState<string[]>([]),
		[deleting, setDeleting] = useState<NoteSummary | null>(null);
	const needle = query.trim().toLowerCase();
	const shown = (notes ?? []).filter(
		(note) => !needle || note.title.toLowerCase().includes(needle)
	);
	const groups = useMemo(
		() =>
			[
				{ id: '', project: undefined as Project | undefined },
				...projects.map((project) => ({ id: project.id, project })),
			]
				.map((group) => ({
					...group,
					rows: shown.filter((note) => (note.project ?? '') === group.id),
				}))
				.filter((group) => group.rows.length),
		[projects, shown]
	);
	const create = () =>
		void window.brigadir
			.createNote(null, '')
			.then(onOpen)
			.catch(() => toastError(t(locale, 'Could not create the note.')));
	const menu = async (note: NoteSummary) => {
		const action = await window.brigadir.noteMenu(note.id);
		if (action === 'delete') setDeleting(note);
		else if (action === 'task') onCreateTask(await window.brigadir.readNote(note.id));
		else if (action) onOpen(note.id);
	};
	return (
		<>
			<div className={styles.taskFilter} data-size="l">
				<SearchField
					className={styles.taskFilterField}
					locale={locale}
					label={t(locale, 'Filter notes')}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && query) {
							event.preventDefault();
							setQuery('');
						}
					}}
				/>
				<IconButton label={t(locale, 'New note')} onClick={create}>
					<Glyph name="plus" size={14} />
				</IconButton>
			</div>
			<div data-sidebar-list data-sidebar-notes className={styles.projectList}>
				{!notes ? (
					<SkeletonRows count={4} height={46} />
				) : !groups.length ? (
					<p className={styles.muted}>{t(locale, needle ? 'No matches' : 'No notes yet')}</p>
				) : (
					groups.map(({ id, project, rows }) => {
						const shut = collapsed.includes(id),
							name = project?.name ?? t(locale, 'No project');
						return (
							<section key={id || '-'} className={styles.project} data-open={!shut}>
								<div
									className={styles.projectHeader}
									style={
										project ? projectToneStyle(project, colors.get(project.id) ?? 0) : undefined
									}>
									<button
										className={styles.projectCollapse}
										aria-label={`${t(locale, shut ? 'Expand project' : 'Collapse project')} · ${name}`}
										title={t(locale, shut ? 'Expand project' : 'Collapse project')}
										aria-expanded={!shut}
										onClick={() =>
											setCollapsed((list) =>
												shut ? list.filter((item) => item !== id) : [...list, id]
											)
										}>
										<Glyph name="sidebar-chevron" size={10} />
									</button>
									<span className={styles.projectIconButton} aria-hidden="true">
										{project ? (
											<ProjectIcon project={project} slot={colors.get(project.id) ?? 0} size={22} />
										) : (
											<Glyph name="note" size={14} />
										)}
									</span>
									{/* The name stretches over the header and folds the group (rule 15: the whole row). */}
									<h3 title={project?.path}>
										<button
											className={styles.projectSelect}
											aria-expanded={!shut}
											onClick={() =>
												setCollapsed((list) =>
													shut ? list.filter((item) => item !== id) : [...list, id]
												)
											}>
											{name}
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
										{rows.map((note) => (
											<button
												key={note.id}
												className={styles.task}
												data-sidebar-note={note.id}
												aria-pressed={note.id === selected}
												title={note.title || t(locale, 'Untitled note')}
												onClick={() => onOpen(note.id)}
												onContextMenu={(event) => {
													event.preventDefault();
													void menu(note);
												}}>
												<span className={styles.noteGlyph}>
													<Glyph name="note" size={14} />
												</span>
												<span className={styles.taskCopy}>
													<span className={styles.taskHead}>
														<span className={styles.taskTitle}>
															{note.title || t(locale, 'Untitled note')}
														</span>
													</span>
													<small className={styles.prLine}>
														<time dateTime={note.updatedAt}>
															{relativeAge(locale, note.updatedAt)}
														</time>
														{note.tasks > 0 && (
															<span title={t(locale, 'Tasks from this note')}>
																{' · '}
																<Glyph name="task-new" size={11} />
																{note.tasks}
															</span>
														)}
													</small>
												</span>
											</button>
										))}
									</div>
								</div>
							</section>
						);
					})
				)}
			</div>
			{deleting && (
				<ConfirmDialog
					title={t(locale, 'Delete the note?')}
					locale={locale}
					action={t(locale, 'Delete')}
					danger
					error={t(locale, 'Could not delete the note.')}
					cancel={() => setDeleting(null)}
					confirm={async () => {
						await window.brigadir.deleteNote(deleting.id);
						setDeleting(null);
					}}>
					<p>
						<b>{deleting.title || t(locale, 'Untitled note')}</b>
					</p>
					<p>{t(locale, 'The note and its chat will be deleted. Tasks from it stay.')}</p>
				</ConfirmDialog>
			)}
		</>
	);
}
