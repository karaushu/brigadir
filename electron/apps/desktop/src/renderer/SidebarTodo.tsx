import { useMemo, useState } from 'react';
import {
	t,
	todoCountsLine,
	todoListMatches,
	todoListName,
	type Locale,
	type Project,
	type TodoList,
} from '@brigadir/core';
import { SearchField } from './ui/PanelSearch';
import { IconButton } from './ui/Controls';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Glyph } from './ui/Glyph';
import { ProjectIcon, projectToneStyle } from './ui/ProjectIcon';
import { SkeletonRows } from './ui/Loading';
import { toastError } from './ui/Toast';
import { RenameDialog } from './RenameTask';
import { addTodoListToCache, markFreshTodoList, useTodoLists } from './todo-data';
import styles from './App.module.css';

/** A new list without a project, opened with its name being typed (the sidebar's «+», the empty screen's `New list`). */
export async function newTodoList(locale: Locale, open: (id: string) => void) {
	try {
		const list = await window.brigadir.createTodoList(null, '');
		addTodoListToCache(list);
		markFreshTodoList(list.id);
		open(list.id);
	} catch {
		toastError(t(locale, 'Could not create the list.'));
	}
}
/** `Move to project…` of a list: the projects as a native menu, from the row or the screen's chip. */
export async function moveTodoList(locale: Locale, id: string, at?: HTMLElement) {
	const box = at?.getBoundingClientRect();
	const choice = await window.brigadir.todoProjectMenu(
		id,
		box ? box.left : null,
		box ? box.bottom + 4 : null
	);
	if (choice)
		await window.brigadir
			.setTodoListProject(id, choice === 'none' ? null : choice)
			.catch(() => toastError(t(locale, 'Could not save the to-do.')));
}
/** spec/todo-and-slack-inbox#todo-entry: `Delete the list?` — from the row's menu or the screen's `…`. */
export function TodoDeleteDialog({
	locale,
	list,
	close,
	deleted,
}: {
	locale: Locale;
	list: TodoList;
	close(): void;
	deleted(): void;
}) {
	return (
		<ConfirmDialog
			title={t(locale, 'Delete the list?')}
			locale={locale}
			action={t(locale, 'Delete')}
			danger
			error={t(locale, 'Could not delete the list.')}
			cancel={close}
			confirm={async () => {
				await window.brigadir.deleteTodoList(list.id);
				deleted();
			}}>
			<p>
				<b>{todoListName(locale, list)}</b>
			</p>
			<p>{t(locale, 'The list and its items are deleted.')}</p>
		</ConfirmDialog>
	);
}
/**
 * spec/todo-and-slack-inbox#todo-entry: the sidebar of the Todo section in the shared list look (rule 17) — `Filter to-dos` (list names and item
 * text) with `New list`, then the lists grouped as notes are: `No project` first, then each project with lists, each group folding by its
 * name. A row: the `todo` glyph, the name, `3 of 8 done`; its menu renames, moves to a project or deletes.
 */
export function SidebarTodo({
	locale,
	projects,
	colors,
	selected,
	onOpen,
}: {
	locale: Locale;
	projects: Project[];
	colors: Map<string, number>;
	selected: string | null;
	onOpen(id: string | null): void;
}) {
	const lists = useTodoLists(),
		[query, setQuery] = useState(''),
		[collapsed, setCollapsed] = useState<string[]>([]),
		[renaming, setRenaming] = useState<TodoList | null>(null),
		[deleting, setDeleting] = useState<TodoList | null>(null);
	const needle = query.trim();
	const groups = useMemo(() => {
		const shown = (lists ?? [])
			.filter((list) => todoListMatches(list, needle))
			// A stable order: a list keeps its place while its items change.
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
		return [
			{ id: '', project: undefined as Project | undefined },
			...projects.map((project) => ({ id: project.id, project })),
		]
			.map((group) => ({
				...group,
				rows: shown.filter(
					(list) =>
						(list.project ?? '') === group.id ||
						// A list of a project that is gone shows under No project.
						(group.id === '' && !!list.project && !projects.some((p) => p.id === list.project))
				),
			}))
			.filter((group) => group.rows.length);
	}, [lists, needle, projects]);
	const menu = async (list: TodoList, target: HTMLElement) => {
		const action = await window.brigadir.todoListMenu(list.id);
		if (action === 'rename') setRenaming(list);
		else if (action === 'delete') setDeleting(list);
		else if (action === 'project') await moveTodoList(locale, list.id, target);
	};
	const fold = (id: string, shut: boolean) =>
		setCollapsed((current) => (shut ? current.filter((item) => item !== id) : [...current, id]));
	return (
		<>
			<div className={styles.taskFilter} data-size="l">
				<SearchField
					className={styles.taskFilterField}
					locale={locale}
					label={t(locale, 'Filter to-dos')}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && query) {
							event.preventDefault();
							setQuery('');
						}
					}}
				/>
				<IconButton label={t(locale, 'New list')} onClick={() => void newTodoList(locale, onOpen)}>
					<Glyph name="plus" size={14} />
				</IconButton>
			</div>
			<div data-sidebar-list data-sidebar-todo className={styles.projectList}>
				{!lists ? (
					<SkeletonRows count={4} height={46} />
				) : !groups.length ? (
					needle && <p className={styles.muted}>{t(locale, 'No matches')}</p>
				) : (
					groups.map(({ id, project, rows }) => {
						// A filter shows every group it finds in, open.
						const shut = !needle && collapsed.includes(id),
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
										onClick={() => fold(id, shut)}>
										<Glyph name="sidebar-chevron" size={10} />
									</button>
									<span className={styles.projectIconButton} aria-hidden="true">
										{project ? (
											<ProjectIcon project={project} slot={colors.get(project.id) ?? 0} size={22} />
										) : (
											<Glyph name="todo" size={14} />
										)}
									</span>
									{/* The name stretches over the header and folds the group (rule 15: the whole row). */}
									<h3 title={project?.path}>
										<button
											className={styles.projectSelect}
											aria-expanded={!shut}
											onClick={() => fold(id, shut)}>
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
										{rows.map((list) => (
											<button
												key={list.id}
												className={styles.task}
												data-sidebar-todo-list={list.id}
												aria-pressed={list.id === selected}
												title={todoListName(locale, list)}
												onClick={() => onOpen(list.id)}
												onContextMenu={(event) => {
													event.preventDefault();
													void menu(list, event.currentTarget);
												}}>
												<span className={styles.noteGlyph}>
													<Glyph name="todo" size={14} />
												</span>
												<span className={styles.taskCopy}>
													<span className={styles.taskHead}>
														<span className={styles.taskTitle}>{todoListName(locale, list)}</span>
													</span>
													<small className={styles.prLine}>{todoCountsLine(locale, list)}</small>
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
			{renaming && (
				<RenameDialog
					locale={locale}
					initial={renaming.name}
					title={t(locale, 'Rename the list')}
					label={t(locale, 'Name')}
					error={t(locale, 'Could not rename the list.')}
					close={() => setRenaming(null)}
					save={(name) => window.brigadir.renameTodoList(renaming.id, name)}
				/>
			)}
			{deleting && (
				<TodoDeleteDialog
					locale={locale}
					list={deleting}
					close={() => setDeleting(null)}
					deleted={() => {
						if (deleting.id === selected) onOpen(null);
						setDeleting(null);
					}}
				/>
			)}
		</>
	);
}
