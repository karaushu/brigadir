import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type KeyboardEvent,
} from 'react';
import {
	doneTodoItems,
	externalLink,
	formatTime,
	placeTodoItem,
	stepTodoItem,
	t,
	todoListName,
	type Locale,
	type Project,
	type TodoItem,
	type TodoList,
} from '@brigadir/core';
import { Button, Choice, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { HeaderChip } from './ui/HeaderChip';
import { ChatCardChip } from './ui/ChatCard';
import { EmptyState } from './ui/EmptyState';
import { SkeletonRows } from './ui/Loading';
import { showToast, toastError } from './ui/Toast';
import { ProjectTitlebar } from './ProjectBoard';
import { MarkdownStill } from './MarkdownBlock';
import { markdown } from './markdown';
import { patchTodoList, takeFreshTodoList, useTodoLists } from './todo-data';
import { moveTodoList, newTodoList, TodoDeleteDialog } from './SidebarTodo';
import s from './TodoScreen.module.css';

/** What `Make a task` hands the launch sheet: the title, the description as the prompt and the list's project. */
export type TodoTaskSeed = { title: string; prompt: string; project: string | null };
/** spec/todo-and-slack-inbox#todo-item: a done item stays in place this long, so a second click takes it back. */
const DONE_DELAY = 1000;
const isField = (target: EventTarget | null) =>
	target instanceof HTMLElement && !!target.closest('input:not([type=checkbox]),textarea');
/** The Slack message's time, `14:20`, from its timestamp. */
const sourceTime = (ts: string) => {
	const seconds = Number(ts.split('.')[0]);
	return Number.isFinite(seconds) && seconds > 0 ? formatTime(seconds * 1000) : '';
};

/**
 * spec/todo-and-slack-inbox#todo-entry: the Todo screen — the open list: its name (click to rename), its project chip and `…`; `Add a to-do` on top;
 * the open items in the person's order; `Done · N` under them, folded. `Select a list` / `No lists yet` · `New list` when none is open.
 */
export function TodoScreen({
	locale,
	projects,
	selected,
	onSelect,
	onMakeTask,
}: {
	locale: Locale;
	projects: Project[];
	selected: string | null;
	onSelect(id: string | null): void;
	onMakeTask(seed: TodoTaskSeed): void;
}) {
	const lists = useTodoLists();
	const list = lists?.find((item) => item.id === selected) ?? null;
	// A list deleted here or elsewhere closes.
	useEffect(() => {
		if (lists && selected && !list) onSelect(null);
	}, [lists, selected, list, onSelect]);
	return (
		<section
			className={s.screen}
			aria-label={t(locale, 'Todo')}
			data-todo-screen
			data-todo-list={list?.id}>
			{list ? (
				<TodoListView
					key={list.id}
					locale={locale}
					list={list}
					projects={projects}
					onClose={() => onSelect(null)}
					onMakeTask={onMakeTask}
				/>
			) : (
				<>
					<ProjectTitlebar
						title={
							<span className={s.title}>
								<Glyph name="todo" size={16} />
								<span className={s.name}>{t(locale, 'Todo')}</span>
							</span>
						}
					/>
					{!lists ? (
						<div className={s.scroll}>
							<div className={s.column}>
								<SkeletonRows count={5} height={34} />
							</div>
						</div>
					) : !lists.length ? (
						<EmptyState glyph="todo" title={t(locale, 'No lists yet')}>
							<Button appearance="primary" onClick={() => void newTodoList(locale, onSelect)}>
								<Glyph name="plus" size={13} />
								{t(locale, 'New list')}
							</Button>
						</EmptyState>
					) : (
						<EmptyState glyph="todo" title={t(locale, 'Select a list')} />
					)}
				</>
			)}
		</section>
	);
}

type Drop = { id: string; side: 'before' | 'after' };

function TodoListView({
	locale,
	list,
	projects,
	onClose,
	onMakeTask,
}: {
	locale: Locale;
	list: TodoList;
	projects: Project[];
	onClose(): void;
	onMakeTask(seed: TodoTaskSeed): void;
}) {
	const [selectedItem, setSelectedItem] = useState<string | null>(null),
		[editing, setEditing] = useState<string | null>(null),
		[settling, setSettling] = useState<ReadonlySet<string>>(new Set()),
		[doneOpen, setDoneOpen] = useState(false),
		[renaming, setRenaming] = useState(() => takeFreshTodoList(list.id)),
		[deleting, setDeleting] = useState(false),
		[dragging, setDragging] = useState<string | null>(null),
		[drop, setDrop] = useState<Drop | null>(null),
		[draft, setDraft] = useState('');
	const listRef = useRef<HTMLDivElement>(null),
		addRef = useRef<HTMLInputElement>(null),
		chipRef = useRef<HTMLButtonElement>(null),
		timers = useRef(new Map<string, ReturnType<typeof setTimeout>>()),
		/** spec/todo-and-slack-inbox#todo-item: ⌘Z while the list is open brings back what ⌫ deleted. */
		undo = useRef<{ item: TodoItem; index: number }[]>([]),
		/** Items added on this screen: an empty title deletes such an item. */
		fresh = useRef(new Set<string>());
	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending.values()) clearTimeout(timer);
		};
	}, []);
	const project = projects.find((item) => item.id === list.project);
	const open = list.items.filter((item) => !item.done || settling.has(item.id)),
		done = doneTodoItems(list).filter((item) => !settling.has(item.id));
	const reachable = [...open, ...(doneOpen ? done : [])].map((item) => item.id);
	const current = list.items.find((item) => item.id === selectedItem) ?? null;
	const focusList = () => listRef.current?.focus({ preventScroll: true });
	const fail = () => toastError(t(locale, 'Could not save the to-do.'));
	const patchItem = (id: string, patch: Partial<TodoItem>) =>
		patchTodoList(list.id, (value) => ({
			...value,
			items: value.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
		}));
	const toggle = (item: TodoItem) => {
		const next = !item.done;
		patchItem(item.id, { done: next, doneAt: next ? new Date().toISOString() : null });
		const timer = timers.current.get(item.id);
		if (timer) clearTimeout(timer);
		timers.current.delete(item.id);
		if (next) {
			setSettling((value) => new Set(value).add(item.id));
			timers.current.set(
				item.id,
				setTimeout(() => {
					timers.current.delete(item.id);
					setSettling((value) => {
						const rest = new Set(value);
						rest.delete(item.id);
						return rest;
					});
				}, DONE_DELAY)
			);
		} else
			setSettling((value) => {
				const rest = new Set(value);
				rest.delete(item.id);
				return rest;
			});
		void window.brigadir.updateTodoItem(list.id, item.id, { done: next }).catch(fail);
	};
	const fold = (item: TodoItem, value: boolean) => {
		if (!item.description || item.open === value) return;
		patchItem(item.id, { open: value });
		void window.brigadir.updateTodoItem(list.id, item.id, { open: value }).catch(fail);
	};
	const remove = async (item: TodoItem, quiet = false) => {
		const index = reachable.indexOf(item.id);
		const next = reachable[index + 1] ?? reachable[index - 1] ?? null;
		patchTodoList(list.id, (value) => ({
			...value,
			items: value.items.filter((one) => one.id !== item.id),
		}));
		if (selectedItem === item.id) setSelectedItem(next);
		try {
			const removed = await window.brigadir.removeTodoItem(list.id, item.id);
			if (!removed || quiet) return;
			undo.current.push(removed);
			showToast(t(locale, 'To-do deleted'), {
				label: t(locale, 'Undo'),
				run: () => void restore(),
			});
		} catch {
			fail();
		}
	};
	const restore = async () => {
		const last = undo.current.pop();
		if (!last) return;
		await window.brigadir.restoreTodoItem(list.id, last.item, last.index).catch(fail);
		setSelectedItem(last.item.id);
	};
	const step = (item: TodoItem, delta: -1 | 1) => {
		const items = stepTodoItem(list.items, item.id, delta);
		if (!items) return;
		patchTodoList(list.id, (value) => ({ ...value, items }));
		void window.brigadir.stepTodoItem(list.id, item.id, delta).catch(fail);
	};
	const add = async () => {
		const title = draft.trim();
		if (!title) return;
		setDraft('');
		try {
			fresh.current.add(await window.brigadir.addTodoItem(list.id, title, ''));
		} catch {
			setDraft(title);
			fail();
		}
	};
	const save = (item: TodoItem, title: string, description: string) => {
		setEditing(null);
		focusList();
		if (!title.trim()) {
			if (fresh.current.has(item.id)) void remove(item, true);
			return;
		}
		if (title.trim() === item.title && description.trim() === item.description) return;
		const patch = {
			title: title.trim(),
			description: description.trim(),
			// A description written now starts unfolded.
			...(!item.description && description.trim() ? { open: true } : {}),
		};
		patchItem(item.id, patch);
		void window.brigadir.updateTodoItem(list.id, item.id, patch).catch(fail);
	};
	const moveToList = async (item: TodoItem, x: number | null, y: number | null) => {
		const target = await window.brigadir.todoListPickMenu(list.id, x, y);
		if (target)
			await window.brigadir
				.moveTodoItemToList(list.id, item.id, target)
				.catch(() => toastError(t(locale, 'Could not move the to-do.')));
	};
	const menu = async (item: TodoItem, x: number | null, y: number | null) => {
		setSelectedItem(item.id);
		const action = await window.brigadir.todoItemMenu(x, y);
		if (action === 'edit') setEditing(item.id);
		else if (action === 'delete') void remove(item);
		else if (action === 'move') void moveToList(item, x, y);
		else if (action === 'task')
			onMakeTask({
				title: item.title,
				prompt: item.description || item.title,
				project: list.project,
			});
	};
	const moveSelection = (delta: -1 | 1) => {
		if (!reachable.length) return;
		const index = selectedItem ? reachable.indexOf(selectedItem) : -1;
		const next =
			index < 0
				? reachable[delta > 0 ? 0 : reachable.length - 1]!
				: reachable[Math.min(reachable.length - 1, Math.max(0, index + delta))]!;
		setSelectedItem(next);
		document
			.querySelector(`[data-todo-item="${next}"]`)
			?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
	};
	/** One handler for the keys and their menu items (rule 11): the menu dispatches the same action. */
	const act = (action: string) => {
		if (action === 'todo-add') return addRef.current?.focus();
		if (action === 'todo-next') return moveSelection(1);
		if (action === 'todo-previous') return moveSelection(-1);
		if (action === 'todo-undo') return void restore();
		if (!current) return;
		if (action === 'todo-toggle') toggle(current);
		else if (action === 'todo-unfold') fold(current, true);
		else if (action === 'todo-fold') fold(current, false);
		else if (action === 'todo-edit') setEditing(current.id);
		else if (action === 'todo-delete') void remove(current);
		else if (action === 'todo-move-up') step(current, -1);
		else if (action === 'todo-move-down') step(current, 1);
	};
	const actRef = useRef(act);
	actRef.current = act;
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (document.querySelector('dialog[open]')) return;
				if (action.startsWith('todo-')) actRef.current(action);
			}),
		[]
	);
	const keys: Record<string, string> = {
		ArrowDown: 'todo-next',
		ArrowUp: 'todo-previous',
		' ': 'todo-toggle',
		ArrowRight: 'todo-unfold',
		ArrowLeft: 'todo-fold',
		Enter: 'todo-edit',
		Backspace: 'todo-delete',
		Delete: 'todo-delete',
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (editing || isField(event.target)) return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		const action = keys[event.key];
		if (!action) return;
		event.preventDefault();
		act(action);
	};
	const onDragOver = (event: DragEvent, item: TodoItem) => {
		if (!dragging || item.done) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		const box = event.currentTarget.getBoundingClientRect();
		const side = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
		if (drop?.id !== item.id || drop.side !== side) setDrop({ id: item.id, side });
	};
	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		const id = dragging,
			target = drop;
		setDragging(null);
		setDrop(null);
		if (!id || !target || target.id === id) return;
		const openIds = list.items
			.filter((item) => !item.done && item.id !== id)
			.map((item) => item.id);
		const before =
			target.side === 'before' ? target.id : (openIds[openIds.indexOf(target.id) + 1] ?? null);
		const items = placeTodoItem(list.items, id, before);
		if (!items) return;
		patchTodoList(list.id, (value) => ({ ...value, items }));
		void window.brigadir.placeTodoItem(list.id, id, before).catch(fail);
	};
	const name = todoListName(locale, list);
	const row = (item: TodoItem) => (
		<TodoRow
			key={item.id}
			locale={locale}
			item={item}
			selected={item.id === selectedItem}
			editing={item.id === editing}
			draggable={!item.done && !editing}
			drop={drop?.id === item.id ? drop.side : null}
			onSelect={() => setSelectedItem(item.id)}
			onToggle={() => toggle(item)}
			onFold={(value) => fold(item, value)}
			onEdit={() => {
				setSelectedItem(item.id);
				setEditing(item.id);
			}}
			onSave={(title, description) => save(item, title, description)}
			onMenu={(x, y) => void menu(item, x, y)}
			onDragStart={(event) => {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('text/plain', item.title);
				setDragging(item.id);
				setSelectedItem(item.id);
			}}
			onDragOver={(event) => onDragOver(event, item)}
			onDrop={onDrop}
			onDragEnd={() => {
				setDragging(null);
				setDrop(null);
			}}
			onFocusList={focusList}
		/>
	);
	return (
		<>
			<ProjectTitlebar
				title={
					<span className={s.title}>
						<Glyph name="todo" size={16} />
						{renaming ? (
							<NameField
								locale={locale}
								initial={list.name}
								onDone={(value) => {
									setRenaming(false);
									if (value !== null && value.trim() !== list.name)
										void window.brigadir
											.renameTodoList(list.id, value)
											.catch(() => toastError(t(locale, 'Could not rename the list.')));
								}}
							/>
						) : (
							<button
								type="button"
								className={s.name}
								data-untitled={!list.name.trim() || undefined}
								title={t(locale, 'Rename…')}
								onClick={() => setRenaming(true)}>
								{name}
							</button>
						)}
						<span className={s.chip}>
							<HeaderChip
								ref={chipRef}
								filled
								title={t(locale, 'List project')}
								onClick={(event) => void moveTodoList(locale, list.id, event.currentTarget)}>
								<Glyph name="folder" size={11} />
								{project?.name ?? t(locale, 'No project')}
							</HeaderChip>
						</span>
					</span>
				}>
				<IconButton
					label={t(locale, 'List actions')}
					onClick={async () => {
						const action = await window.brigadir.todoListMenu(list.id);
						if (action === 'rename') setRenaming(true);
						else if (action === 'delete') setDeleting(true);
						else if (action === 'project')
							await moveTodoList(locale, list.id, chipRef.current ?? undefined);
					}}>
					<Glyph name="more" size={15} />
				</IconButton>
			</ProjectTitlebar>
			<div className={s.scroll}>
				<div className={s.column}>
					<form
						className={s.add}
						onSubmit={(event) => {
							event.preventDefault();
							void add();
						}}>
						<Glyph name="plus" size={14} />
						<input
							ref={addRef}
							className={s.addInput}
							value={draft}
							maxLength={500}
							placeholder={t(locale, 'Add a to-do')}
							aria-label={t(locale, 'Add a to-do')}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									event.preventDefault();
									setDraft('');
									focusList();
								}
								if (event.key === 'ArrowDown' && !draft) {
									event.preventDefault();
									focusList();
									moveSelection(1);
								}
							}}
						/>
						<kbd className={s.enter} aria-hidden="true">
							↩
						</kbd>
					</form>
					<div
						ref={listRef}
						className={s.items}
						role="list"
						tabIndex={0}
						aria-label={name}
						aria-activedescendant={selectedItem ? `todo-${selectedItem}` : undefined}
						data-todo-selected={!!current}
						onKeyDown={onKeyDown}
						onDragLeave={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
						}}>
						{open.map(row)}
						{done.length > 0 && (
							<>
								<button
									type="button"
									className={s.doneHead}
									aria-expanded={doneOpen}
									tabIndex={-1}
									onClick={() => {
										setDoneOpen((value) => !value);
										focusList();
									}}>
									<span className={s.chevron} data-open={doneOpen}>
										<Glyph name="sidebar-chevron" size={10} />
									</span>
									{t(locale, 'Done · {n}').replace(
										'{n}',
										new Intl.NumberFormat(locale).format(done.length)
									)}
								</button>
								<div className={s.disclosure} data-open={doneOpen} inert={!doneOpen}>
									<div>{done.map(row)}</div>
								</div>
							</>
						)}
					</div>
				</div>
			</div>
			{deleting && (
				<TodoDeleteDialog
					locale={locale}
					list={list}
					close={() => setDeleting(false)}
					deleted={() => {
						setDeleting(false);
						onClose();
					}}
				/>
			)}
		</>
	);
}

/** The header's name being typed: ↩ or a click elsewhere keeps it, Esc puts the old one back. */
function NameField({
	locale,
	initial,
	onDone,
}: {
	locale: Locale;
	initial: string;
	onDone(value: string | null): void;
}) {
	const [value, setValue] = useState(initial),
		ref = useRef<HTMLInputElement>(null),
		ended = useRef(false);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	const end = (result: string | null) => {
		if (ended.current) return;
		ended.current = true;
		onDone(result);
	};
	return (
		<input
			ref={ref}
			className={s.nameInput}
			value={value}
			maxLength={120}
			placeholder={t(locale, 'Untitled list')}
			aria-label={t(locale, 'Name')}
			onChange={(event) => setValue(event.target.value)}
			onBlur={() => end(value)}
			onKeyDown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					end(value);
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					end(null);
				}
			}}
		/>
	);
}

/**
 * spec/todo-and-slack-inbox#todo-item: one to-do — the checkbox, the title with its chevron right after it when there is a description (the title folds
 * and unfolds it; the chevron turns with the disclosure motion), the Markdown description indented to the title, the Slack source chip, and on
 * hover the drag handle and `…`. The whole row hovers and is selected (rule 15).
 */
function TodoRow({
	locale,
	item,
	selected,
	editing,
	draggable,
	drop,
	onSelect,
	onToggle,
	onFold,
	onEdit,
	onSave,
	onMenu,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
	onFocusList,
}: {
	locale: Locale;
	item: TodoItem;
	selected: boolean;
	editing: boolean;
	draggable: boolean;
	drop: 'before' | 'after' | null;
	onSelect(): void;
	onToggle(): void;
	onFold(open: boolean): void;
	onEdit(): void;
	onSave(title: string, description: string): void;
	onMenu(x: number | null, y: number | null): void;
	onDragStart(event: DragEvent): void;
	onDragOver(event: DragEvent): void;
	onDrop(event: DragEvent): void;
	onDragEnd(): void;
	onFocusList(): void;
}) {
	const hasDescription = !!item.description;
	const html = useMemo(
		() => (hasDescription ? markdown.render(item.description) : ''),
		[hasDescription, item.description]
	);
	const source = item.source;
	const chip = source && (
		<span className={s.source}>
			<ChatCardChip
				title={t(locale, 'Open in Slack')}
				onClick={() => void window.brigadir.openWebLink(source.permalink)}>
				<Glyph name="slack" size={11} />
				<b>{source.channel}</b>
				{` · ${source.author}`}
				{sourceTime(source.ts) ? ` · ${sourceTime(source.ts)}` : ''}
			</ChatCardChip>
		</span>
	);
	return (
		<div
			id={`todo-${item.id}`}
			role="listitem"
			className={s.item}
			data-todo-item={item.id}
			data-selected={selected || undefined}
			data-done={item.done || undefined}
			data-editing={editing || undefined}
			data-drop={drop ?? undefined}
			draggable={draggable}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onDragEnd={onDragEnd}
			onMouseDown={(event) => {
				if (!isField(event.target)) onSelect();
			}}
			onClick={(event) => {
				if (!editing && !isField(event.target)) onFocusList();
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				onMenu(event.clientX, event.clientY);
			}}>
			{draggable && (
				<span className={s.handle} title={t(locale, 'Drag to reorder')} aria-hidden="true">
					<Glyph name="list" size={12} />
				</span>
			)}
			<Choice
				type="checkbox"
				label={`${t(locale, 'Done (to-do)')} · ${item.title}`}
				checked={item.done}
				tabIndex={-1}
				onChange={onToggle}
			/>
			{editing ? (
				<TodoEditor locale={locale} item={item} onSave={onSave} />
			) : (
				<div className={s.body}>
					<button
						type="button"
						className={s.titleButton}
						tabIndex={-1}
						aria-expanded={hasDescription ? item.open : undefined}
						onClick={() => (hasDescription ? onFold(!item.open) : onEdit())}>
						<span className={s.itemTitle}>{item.title}</span>
						{hasDescription && (
							<span className={s.chevron} data-open={item.open}>
								<Glyph name="sidebar-chevron" size={10} />
							</span>
						)}
						{source && hasDescription && !item.open && (
							<span className={s.mini} title={t(locale, 'Open in Slack')}>
								<Glyph name="slack" size={11} />
							</span>
						)}
					</button>
					{hasDescription ? (
						<div className={s.disclosure} data-open={item.open} inert={!item.open}>
							<div>
								<div
									className={s.description}
									onClickCapture={(event) => {
										const link = (event.target as HTMLElement).closest('a');
										if (link) {
											event.preventDefault();
											event.stopPropagation();
											const href = externalLink(link.getAttribute('href'));
											if (href) void window.brigadir.openWebLink(href);
											return;
										}
										onEdit();
									}}>
									<MarkdownStill html={html} />
								</div>
								{chip}
							</div>
						</div>
					) : (
						chip
					)}
				</div>
			)}
			{!editing && (
				<span className={s.more}>
					<IconButton
						size="s"
						label={t(locale, 'To-do actions')}
						tabIndex={-1}
						onClick={(event) => {
							const box = event.currentTarget.getBoundingClientRect();
							onMenu(box.left, box.bottom + 4);
						}}>
						<Glyph name="more" size={14} />
					</IconButton>
				</span>
			)}
		</div>
	);
}

/** The title and description typed in place: Esc, ⌘↩ or a click elsewhere saves; ↩ in the title saves too. */
function TodoEditor({
	locale,
	item,
	onSave,
}: {
	locale: Locale;
	item: TodoItem;
	onSave(title: string, description: string): void;
}) {
	const [title, setTitle] = useState(item.title),
		[description, setDescription] = useState(item.description),
		box = useRef<HTMLDivElement>(null),
		titleRef = useRef<HTMLInputElement>(null),
		textRef = useRef<HTMLTextAreaElement>(null),
		saved = useRef(false);
	const save = useCallback(() => {
		if (saved.current) return;
		saved.current = true;
		onSave(title, description);
	}, [onSave, title, description]);
	useEffect(() => {
		titleRef.current?.focus();
		const end = titleRef.current?.value.length ?? 0;
		titleRef.current?.setSelectionRange(end, end);
	}, []);
	// The description grows with its text.
	useEffect(() => {
		const area = textRef.current;
		if (!area) return;
		area.style.height = 'auto';
		area.style.height = `${area.scrollHeight}px`;
	}, [description]);
	const keys = (event: KeyboardEvent, field: 'title' | 'description') => {
		if (
			event.key === 'Escape' ||
			(event.key === 'Enter' && (event.metaKey || event.ctrlKey || field === 'title'))
		) {
			event.preventDefault();
			event.stopPropagation();
			save();
		}
	};
	return (
		<div
			ref={box}
			className={s.editor}
			onBlur={(event) => {
				if (!box.current?.contains(event.relatedTarget as Node | null)) save();
			}}>
			<input
				ref={titleRef}
				className={s.editTitle}
				value={title}
				maxLength={500}
				aria-label={t(locale, 'Title')}
				onChange={(event) => setTitle(event.target.value)}
				onKeyDown={(event) => keys(event, 'title')}
			/>
			<textarea
				ref={textRef}
				className={s.editDescription}
				value={description}
				rows={1}
				maxLength={20000}
				placeholder={t(locale, 'Description')}
				aria-label={t(locale, 'Description')}
				onChange={(event) => setDescription(event.target.value)}
				onKeyDown={(event) => keys(event, 'description')}
			/>
		</div>
	);
}
