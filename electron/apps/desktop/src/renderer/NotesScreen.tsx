import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
	noteTitle,
	projectColors,
	relativeAge,
	t,
	withShortcut,
	type AgentProvider,
	type AgentTask,
	type Locale,
	type NoteDocument,
	type NoteSummary,
	type Project,
} from '@brigadir/core';
import { Button, IconButton, Segments } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ProjectIcon } from './ui/ProjectIcon';
import { SearchField } from './ui/PanelSearch';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { showToast, toastError } from './ui/Toast';
import { useCommandShortcut } from './ui/use-command-shortcut';
import { ProjectTitlebar } from './ProjectBoard';
import { NoteChat } from './NoteChat';
import { ResizeHandle } from './ui/ResizeHandle';
import { useSurfaceLayout } from './surface-layout';
import {
	collapseSelection,
	revealLines,
	NoteEditor,
	selectionStartRect,
	type NoteSelection,
	type NoteTaskInfo,
} from './NoteEditor';
import { SelectionActions, SelectionFloat } from './ui/ReviewControls';
import { taskStatusLabel } from './ProjectBoard';
import editorStyles from './CodeEditor.module.css';
import { AgentsButton } from './LiveAgents';
import { renderNote, toggleInText } from './note-markdown';
import { MarkdownStill } from './MarkdownBlock';
import s from './NotesScreen.module.css';
/** All notes, newest edit first, re-read on every change any window or the agent makes (spec/notifications-slack-notes-and-schedules#notes). */
export function useNotes(enabled = true) {
	const [notes, setNotes] = useState<NoteSummary[] | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const read = () =>
			window.brigadir
				.listNotes()
				.then((list) => active && setNotes(list))
				.catch(() => active && setNotes((current) => current ?? []));
		void read();
		const off = window.brigadir.onNotesChanged(() => void read());
		return () => {
			active = false;
			off();
		};
	}, [enabled]);
	return notes;
}
/** Which notes a screen shows: all, the ones without a project, or one project's. */
export type NoteScope = 'all' | 'none' | { project: string };
const inScope = (note: NoteSummary, scope: NoteScope) =>
	scope === 'all'
		? true
		: scope === 'none'
			? note.project === null
			: note.project === scope.project;
const SAVE_DELAY = 500;
type SaveState = 'saved' | 'saving' | 'failed';
/** One note: its text as the editor holds it, saved 500 ms after the last edit (spec/notifications-slack-notes-and-schedules#notes). */
function useNoteText(id: string | null, locale: Locale) {
	const [doc, setDoc] = useState<NoteDocument | null>(null),
		[text, setText] = useState(''),
		[save, setSave] = useState<SaveState>('saved');
	const pending = useRef<{ id: string; text: string } | null>(null),
		timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const flush = useCallback(async () => {
		clearTimeout(timer.current);
		const next = pending.current;
		if (!next) return;
		pending.current = null;
		try {
			await window.brigadir.writeNote(next.id, next.text);
			if (!pending.current) setSave('saved');
		} catch {
			pending.current ??= next;
			setSave('failed');
			toastError(t(locale, 'Could not save the note. Changes are kept.'), {
				key: `note-save-${next.id}`,
				action: { label: t(locale, 'Retry'), run: () => void flush() },
			});
		}
	}, [locale]);
	useEffect(() => {
		setDoc(null);
		if (!id) return;
		let active = true;
		const read = (initial: boolean) =>
			window.brigadir
				.readNote(id)
				.then((note) => {
					if (!active || pending.current?.id === id) return;
					setDoc(note);
					setText(note.text);
					if (initial) setSave('saved');
				})
				.catch(() => {
					if (active && initial) toastError(t(locale, 'Could not open the note.'));
				});
		void read(true);
		const off = window.brigadir.onNotesChanged((change) => {
			if (change.id === id && change.kind !== 'deleted') void read(false);
		});
		return () => {
			active = false;
			off();
			void flush();
		};
	}, [id, locale, flush]);
	const change = useCallback(
		(next: string) => {
			if (!id) return;
			setText(next);
			pending.current = { id, text: next };
			setSave('saving');
			clearTimeout(timer.current);
			timer.current = setTimeout(() => void flush(), SAVE_DELAY);
		},
		[id, flush]
	);
	return { doc, text, save, change, flush };
}
function NoteRow({
	note,
	project,
	slot,
	selected,
	locale,
	onOpen,
	onMenu,
}: {
	note: NoteSummary;
	project: Project | undefined;
	slot: number;
	selected: boolean;
	locale: Locale;
	onOpen(): void;
	onMenu(): void;
}) {
	return (
		<div className={s.row} data-selected={selected} data-note={note.id}>
			<button
				type="button"
				className={s.rowMain}
				aria-current={selected || undefined}
				onClick={onOpen}
				onContextMenu={(event) => {
					event.preventDefault();
					onMenu();
				}}>
				<span className={s.rowGlyph}>
					<Glyph name="note" size={14} />
				</span>
				<span className={s.rowText}>
					<span className={s.rowTitle}>{note.title || t(locale, 'Untitled note')}</span>
					<span className={s.rowMeta}>
						{project ? (
							<>
								<ProjectIcon project={project} slot={slot} size={14} />
								<span>{project.name}</span>
							</>
						) : (
							<span>{t(locale, 'No project')}</span>
						)}
						<span>· {relativeAge(locale, note.updatedAt)}</span>
						{note.tasks > 0 && (
							<span className={s.rowTasks} title={t(locale, 'Tasks from this note')}>
								<Glyph name="task-new" size={11} />
								{note.tasks}
							</span>
						)}
					</span>
				</span>
			</button>
			<IconButton size="s" className={s.rowMore} label={t(locale, 'Note actions')} onClick={onMenu}>
				<Glyph name="more" size={13} />
			</IconButton>
		</div>
	);
}
/**
 * spec/notifications-slack-notes-and-schedules#notes: the list of notes, the open note and its chat — the body of the Notes screen and of a project's
 * Notes tab (rule 17: one screen, two filters).
 */
export function NotesBody({
	locale,
	projects,
	scope,
	selected,
	onSelect,
	tasks,
	onCreateTask,
	onOpenTask,
	list = true,
}: {
	locale: Locale;
	projects: Project[];
	scope: NoteScope;
	/** spec/sidebar#section-rail: false — the rail's Notes section lists the notes in the sidebar; the screen is the note and its chat. */
	list?: boolean;
	selected: string | null;
	onSelect(id: string | null): void;
	/** The workspace's tasks, for the links to them in a note. */ tasks: AgentTask[];
	/** spec/notifications-slack-notes-and-schedules#notes: the sheet for the whole note (`part` null) or its selected lines. */
	onCreateTask(note: NoteDocument, part: NoteSelection | null): void;
	onOpenTask(projectId: string, taskId: string): void;
}) {
	const notes = useNotes(),
		[query, setQuery] = useState(''),
		[view, setView] = useState<'code' | 'side' | 'preview'>('code'),
		[deleting, setDeleting] = useState<string | null>(null),
		[selection, setSelection] = useState<NoteSelection | null>(null),
		[chatOpen, setChatOpen] = useState(true),
		[quote, setQuote] = useState<{ id: number; text: string } | null>(null),
		chatShortcut = useCommandShortcut()('layout-chat'),
		[provider, setProvider] = useState<AgentProvider>('claude'),
		noteRef = useRef<HTMLElement>(null),
		bodyRef = useRef<HTMLDivElement>(null),
		[bodyWidth, setBodyWidth] = useState(0),
		chatWish = useSurfaceLayout((state) => state.layout.noteChatWidth);
	useEffect(() => void useSurfaceLayout.getState().load(), []);
	// spec/notifications-slack-notes-and-schedules#note-chat: the note keeps 400 px, so the window is the chat's ceiling.
	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		const observer = new ResizeObserver(() => setBodyWidth(body.clientWidth));
		observer.observe(body);
		return () => observer.disconnect();
	}, []);
	const chatMax = Math.max(300, bodyWidth - (list ? 249 : 0) - 401),
		chatWidth = bodyWidth ? Math.min(chatWish, chatMax) : chatWish;
	// spec/diff-and-review#selection-panel: the selection's panel lives under its last line in the editor's flow, like the code editor's.
	const selectionHost = useMemo(() => {
		const node = document.createElement('div');
		node.className = editorStyles.selectionWidget!;
		return node;
	}, []);
	const byKey = useMemo(
		() => new Map(tasks.map((task) => [`${task.projectId}/${task.id}`, task])),
		[tasks]
	);
	const taskInfo = useCallback(
		(projectId: string, taskId: string): NoteTaskInfo => {
			const task = byKey.get(`${projectId}/${taskId}`);
			return task
				? { title: task.title, status: task.status, label: taskStatusLabel(task, locale) }
				: null;
		},
		[byKey, locale]
	);
	const tasksKey = useMemo(
		() => tasks.map((task) => `${task.id}:${task.status}:${task.title}`).join('|'),
		[tasks]
	);
	const colors = useMemo(() => projectColors(projects.map((p) => p.id)), [projects]);
	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (notes ?? []).filter(
			(note) => inScope(note, scope) && (!q || note.title.toLowerCase().includes(q))
		);
	}, [notes, scope, query]);
	const open =
		selected && shown.some((note) => note.id === selected) ? selected : (shown[0]?.id ?? null);
	useEffect(() => {
		if (notes && open !== selected) onSelect(open);
	}, [notes, open, selected, onSelect]);
	const note = useNoteText(open, locale);
	useEffect(() => {
		void window.brigadir.readSettings().then(
			({ settings }) => setProvider(settings.agents.provider),
			() => {}
		);
	}, []);
	useEffect(() => setSelection(null), [open, view]);
	useEffect(() => setQuote(null), [open]);
	// spec/notifications-slack-notes-and-schedules#notes: View ▸ Layout ▸ Chat (⌘1) shows or hides the note's chat, as in a task.
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (action === 'layout-chat' && !document.querySelector('dialog[open]'))
					setChatOpen((value) => !value);
			}),
		[]
	);
	const project = (id: string | null) => projects.find((p) => p.id === id);
	const create = async () => {
		try {
			onSelect(
				await window.brigadir.createNote(typeof scope === 'object' ? scope.project : null, '')
			);
		} catch {
			toastError(t(locale, 'Could not create the note.'));
		}
	};
	const menu = async (id: string) => {
		const action = await window.brigadir.noteMenu(id);
		if (action === 'delete') setDeleting(id);
		else if (action === 'task')
			onCreateTask(
				id === open && note.doc
					? { ...note.doc, text: note.text }
					: await window.brigadir.readNote(id),
				null
			);
		else if (action) onSelect(id);
	};
	const copyNote = async (id: string, target: HTMLElement) => {
		const box = target.getBoundingClientRect();
		try {
			if (await window.brigadir.noteCopyMenu(id, note.text, box.left, box.bottom + 4))
				showToast(t(locale, 'Copied'));
		} catch {
			toastError(t(locale, 'Could not copy the note.'));
		}
	};
	const pickProject = async (id: string, target: HTMLElement) => {
		const box = target.getBoundingClientRect();
		const choice = await window.brigadir.noteProjectMenu(id, box.left, box.bottom + 4);
		if (choice) await window.brigadir.setNoteProject(id, choice === 'none' ? null : choice);
	};
	const doc = note.doc;
	const title = doc ? noteTitle(note.text) || t(locale, 'Untitled note') : '';
	const owner = doc ? project(doc.project) : undefined;
	return (
		<div className={s.body} ref={bodyRef} data-notes-body data-chat={chatOpen}>
			{list && (
				<nav className={s.list} aria-label={t(locale, 'Notes')}>
					<div className={s.listHead} data-size="s">
						<SearchField
							locale={locale}
							size="s"
							className={s.search}
							label={t(locale, 'Filter notes')}
							placeholder={t(locale, 'Filter notes')}
							value={query}
							onChange={setQuery}
						/>
						<IconButton size="s" label={t(locale, 'New note')} onClick={() => void create()}>
							<Glyph name="plus" size={14} />
						</IconButton>
					</div>
					<div className={s.rows}>
						{shown.map((item) => (
							<NoteRow
								key={item.id}
								note={item}
								project={project(item.project)}
								slot={colors.get(item.project ?? '') ?? 0}
								selected={item.id === open}
								locale={locale}
								onOpen={() => onSelect(item.id)}
								onMenu={() => void menu(item.id)}
							/>
						))}
						{notes && !shown.length && query && <p className={s.none}>{t(locale, 'No matches')}</p>}
					</div>
				</nav>
			)}
			{notes && !notes.some((item) => inScope(item, scope)) ? (
				<div className={s.empty}>
					<Glyph name="note" size={40} />
					<h1>{t(locale, 'No notes yet')}</h1>
					<Button appearance="primary" onClick={() => void create()}>
						<Glyph name="plus" size={13} />
						{t(locale, 'New note')}
					</Button>
				</div>
			) : doc && open ? (
				<>
					<section className={s.note} aria-label={title} ref={noteRef}>
						<header className={s.noteHead} data-size="s">
							<span className={s.noteTitle}>{title}</span>
							<button
								type="button"
								className={s.pick}
								data-none={!owner || undefined}
								title={t(locale, 'Note project')}
								onClick={(event) => void pickProject(open, event.currentTarget)}>
								{owner && (
									<ProjectIcon project={owner} slot={colors.get(owner.id) ?? 0} size={14} />
								)}
								<span>{owner?.name ?? t(locale, 'No project')}</span>
								<Glyph name="chevron-down" size={8} />
							</button>
							<span className={s.saved} role="status">
								{note.save === 'saving'
									? t(locale, 'Saving…')
									: note.save === 'saved' && !chatOpen
										? t(locale, 'Saved')
										: ''}
							</span>
							<span className={s.gap} />
							<IconButton
								size="s"
								label={t(locale, 'Copy note')}
								onClick={(event) => void copyNote(open, event.currentTarget)}>
								<Glyph name="copy" size={14} />
							</IconButton>
							{/* spec/notifications-slack-notes-and-schedules#notes: with the chat open the header is narrow — Create task is its glyph, «Saved» goes. */}
							{chatOpen ? (
								<IconButton
									size="s"
									label={t(locale, 'Create task')}
									onClick={() => onCreateTask({ ...doc, text: note.text }, null)}>
									<Glyph name="task-new" size={14} />
								</IconButton>
							) : (
								<Button size="s" onClick={() => onCreateTask({ ...doc, text: note.text }, null)}>
									<Glyph name="task-new" size={13} />
									{t(locale, 'Create task')}
								</Button>
							)}
							<Segments
								size="s"
								label={t(locale, 'Note text')}
								value={view}
								iconOnly
								options={[
									{
										value: 'code',
										label: t(locale, 'Code'),
										icon: <Glyph name="code" size={14} />,
									},
									{
										value: 'side',
										label: t(locale, 'Side by side'),
										icon: <Glyph name="md-side" size={14} />,
									},
									{
										value: 'preview',
										label: t(locale, 'Preview'),
										icon: <Glyph name="md-preview" size={14} />,
									},
								]}
								onChange={(value) => setView(value as 'code' | 'side' | 'preview')}
							/>
							<IconButton
								size="s"
								label={t(locale, chatOpen ? 'Hide chat' : 'Show chat')}
								hint={withShortcut(t(locale, chatOpen ? 'Hide chat' : 'Show chat'), chatShortcut)}
								aria-pressed={chatOpen}
								onClick={() => setChatOpen((value) => !value)}>
								<Glyph name="chat" size={14} />
							</IconButton>
							<IconButton
								size="s"
								label={t(locale, 'Note actions')}
								onClick={() => void menu(open)}>
								<Glyph name="more" size={14} />
							</IconButton>
						</header>
						<div className={s.views} data-view={view}>
							{view !== 'preview' && (
								<NoteEditor
									noteId={open}
									text={note.text}
									label={t(locale, 'Note text')}
									empty={t(locale, 'Write a note in Markdown')}
									gone={t(locale, 'Task deleted')}
									selectionHost={selectionHost}
									selectionEnd={selection?.endLine ?? null}
									tasks={taskInfo}
									tasksKey={tasksKey}
									onChange={note.change}
									onSelection={setSelection}
									onOpenTask={onOpenTask}
								/>
							)}
							{view !== 'code' && (
								<div
									className={s.preview}
									onClickCapture={(event) => {
										const mark = (event.target as HTMLElement).closest<HTMLInputElement>(
											'input[data-note-line]'
										);
										if (mark) {
											event.preventDefault();
											const next = toggleInText(
												note.text.split('\n'),
												Number(mark.dataset.noteLine) - 1
											);
											if (next) note.change(next.join('\n'));
											return;
										}
										const link = (event.target as HTMLElement).closest('a');
										const match = link
											?.getAttribute('href')
											?.match(/^brigadir:\/\/task\/([\w-]+)\/([\w-]+)$/);
										if (!link) return;
										event.preventDefault();
										if (match) onOpenTask(match[1]!, match[2]!);
									}}>
									<MarkdownStill html={renderNote(note.text)} />
								</div>
							)}
						</div>
						{selection &&
							createPortal(
								<div className={editorStyles.annotation}>
									<SelectionFloat start={() => selectionStartRect(noteRef.current)}>
										<SelectionActions
											locale={locale}
											label={`${title} · ${selection.startLine === selection.endLine ? selection.startLine : `${selection.startLine}–${selection.endLine}`}`}
											onTask={() => {
												const part = selection;
												collapseSelection(noteRef.current);
												setSelection(null);
												onCreateTask({ ...doc, text: note.text }, part);
											}}
											onCompose={() => {
												// spec/notifications-slack-notes-and-schedules#note-tasks: the selected lines go into the note's chat as a quote.
												const lines = note.text
													.split('\n')
													.slice(selection.startLine - 1, selection.endLine);
												collapseSelection(noteRef.current);
												setSelection(null);
												setChatOpen(true);
												setQuote((current) => ({
													id: (current?.id ?? 0) + 1,
													text: lines.join('\n'),
												}));
											}}
											onDismiss={() => setSelection(null)}
										/>
									</SelectionFloat>
								</div>,
								selectionHost
							)}
					</section>
					{chatOpen && (
						<ResizeHandle
							label={t(locale, 'Resize chat')}
							value={chatWidth}
							min={300}
							max={chatMax}
							onChange={(value) => useSurfaceLayout.getState().resize('noteChatWidth', value)}
							onCommit={() => useSurfaceLayout.getState().save()}
						/>
					)}
					{chatOpen && (
						<NoteChat
							key={doc.id}
							width={chatWidth}
							note={doc}
							text={note.text}
							locale={locale}
							defaultProvider={provider}
							quote={quote}
							onHide={() => setChatOpen(false)}
							onLines={(from, to) => {
								if (revealLines(noteRef.current, from, to)) return;
								setView('side');
								requestAnimationFrame(() => revealLines(noteRef.current, from, to));
							}}
						/>
					)}
				</>
			) : (
				<div className={s.empty}>{notes && <p>{t(locale, 'Select a note')}</p>}</div>
			)}
			{deleting && (
				<ConfirmDialog
					title={t(locale, 'Delete the note?')}
					locale={locale}
					action={t(locale, 'Delete')}
					danger
					error={t(locale, 'Could not delete the note.')}
					cancel={() => setDeleting(null)}
					confirm={async () => {
						await window.brigadir.deleteNote(deleting);
						if (deleting === open) onSelect(null);
						setDeleting(null);
					}}>
					<p>
						<b>
							{notes?.find((item) => item.id === deleting)?.title || t(locale, 'Untitled note')}
						</b>
					</p>
					<p>{t(locale, 'The note and its chat will be deleted. Tasks from it stay.')}</p>
				</ConfirmDialog>
			)}
		</div>
	);
}
/**
 * spec/notifications-slack-notes-and-schedules#notes → spec/sidebar#section-rail: the Notes screen — the open note and its chat. The rail's Notes section lists the notes in
 * the sidebar (`SidebarNotes`), so the screen has neither the scope tabs nor its own list column.
 */
export function NotesScreen({
	locale,
	projects,
	selected,
	onSelect,
	onSearch,
	tasks,
	onCreateTask,
	onOpenTask,
}: {
	locale: Locale;
	projects: Project[];
	selected: string | null;
	onSelect(id: string | null): void;
	onSearch(): void;
	tasks: AgentTask[];
	onCreateTask(note: NoteDocument, part: NoteSelection | null): void;
	onOpenTask(projectId: string, taskId: string): void;
}) {
	return (
		<section className={s.screen} aria-label={t(locale, 'Notes')} data-notes-screen>
			<ProjectTitlebar title={t(locale, 'Notes')}>
				<AgentsButton />
				<IconButton label={t(locale, 'Search Everywhere')} onClick={onSearch}>
					<Glyph name="search" size={15} />
				</IconButton>
			</ProjectTitlebar>
			<NotesBody
				locale={locale}
				projects={projects}
				scope="all"
				list={false}
				selected={selected}
				onSelect={onSelect}
				tasks={tasks}
				onCreateTask={onCreateTask}
				onOpenTask={onOpenTask}
			/>
		</section>
	);
}
/**
 * spec/notifications-slack-notes-and-schedules#notes: Notes in the sidebar strip — the note glyph and the count of all notes, before Remote; pressed while the
 * Notes screen is open. No list of notes in the sidebar.
 */
export function NotesButton({
	locale,
	open,
	size,
	onClick,
}: {
	locale: Locale;
	open: boolean;
	size: 's' | 'm';
	onClick(): void;
}) {
	const notes = useNotes(),
		shortcut = useCommandShortcut()('notes'),
		label = t(locale, 'Notes');
	return (
		<IconButton
			size={size}
			shape="auto"
			className={s.notesButton}
			hint={withShortcut(label, shortcut)}
			label={`${label} · ${notes?.length ?? 0}`}
			aria-pressed={open}
			data-notes-button
			onClick={onClick}>
			<Glyph name="note" size={16} />
			<span>{notes?.length ?? ''}</span>
		</IconButton>
	);
}
