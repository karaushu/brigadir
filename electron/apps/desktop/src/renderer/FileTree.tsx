import { TextInput } from './ui/Input';
import { fileDragType } from './ui/file-drop';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
	t,
	fileCount,
	fileStatusLetter,
	newFileFolder,
	sameFileEntries,
	type AgentTask,
	type FileEntry,
	type Locale,
	type Scope,
	type MessageKey,
} from '@brigadir/core';
import { useTaskState, rowPosition, attachTaskFile, openTaskTerminal } from './task-state';
import { Rows } from './ui/Rows';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import { useCommandShortcut } from './ui/use-command-shortcut';
import { FileIcon } from './ui/FileIcon';
import { listStep } from './ui/list-keys';
import { resolveToast, toastError, toastWarning } from './ui/Toast';
import { AddFolderRow, PanelRepoRoot, useRepos, type RepoScope } from './Repos';
import { RepoRoot } from './ui/RepoRoot';
import styles from './FileTree.module.css';
import { SkeletonRows } from './ui/Loading';
type FileRow = FileEntry & { depth: number; parent: string | null; ancestors: string[] };
/** spec/appearance#evolution-redesign: a repo of the task as a root of the tree; `folder` is the id its children are read under. */
type RootRow = { id: string; kind: 'repo'; folder: string; scope: RepoScope; parent: null };
type AddRow = { id: 'add-folder'; kind: 'add'; parent: null };
type TreeRow = FileRow | RootRow | AddRow;
const isFile = (row: TreeRow): row is FileRow => row.kind !== 'repo' && row.kind !== 'add';
/** The id a repo's children are read under: the project's root keeps `root`, any other repo is `scope:<id>`. */
export const repoFolder = (scope: { id: string; kind: string }) =>
	scope.kind === 'root' ? 'root' : `scope:${scope.id}`;
// spec/task-window#files-look: row geometry: 8 px from the edge, 18 px a level, a 14 px disclosure column.
const indent = 16,
	inset = 8,
	disclosure = 14;
const statusLabels: Record<NonNullable<FileEntry['status']>, MessageKey> = {
	modified: 'Modified',
	added: 'Added',
	deleted: 'Deleted',
	renamed: 'Renamed',
	untracked: 'Untracked',
	conflict: 'Conflict',
};
export function FileTree({
	task,
	locale,
	projectName,
	scopes,
	refreshControl,
	changeCount,
	openChanges,
	open,
}: {
	task: AgentTask;
	locale: Locale;
	projectName: string;
	scopes: Scope[];
	refreshControl: ReactNode;
	changeCount: number;
	openChanges(): void;
	open(id: string, path?: string): void;
}) {
	const [
		{
			positions,
			fileChildren: children,
			fileExpanded: expanded,
			fileSelection,
			fileReveal,
			fileFilter,
			showIgnored,
		},
		setTask,
	] = useTaskState(task);
	const [navigationTarget, setNavigationTarget] = useState<string | undefined>();
	// Find focuses the filter while the tree has the focus (the editor's Find, the keymap's key).
	const findKey = useCommandShortcut()('editor-find');
	const [searching, setSearching] = useState(false);
	const [truncated, setTruncated] = useState(false),
		[searchFailed, setSearchFailed] = useState(false),
		[released, setReleased] = useState(false),
		[matches, setMatches] = useState<FileEntry[]>([]);
	const failing = useRef(new Set<string>());
	const repos = useRepos();
	const root = useRef<HTMLDivElement>(null),
		filter = useRef<HTMLInputElement>(null),
		generation = useRef(0),
		pendingFocus = useRef<string | null>(null),
		typeahead = useRef({ text: '', at: 0 });
	// spec/notifications-slack-notes-and-schedules#message-classes: a cut list is a note in place; a failed read is a warning toast once while any folder keeps failing (the poll retries).
	async function load(id: string | null) {
		const epoch = generation.current,
			folder = id ?? 'root';
		try {
			const result = await window.brigadir.listFiles(task, id, showIgnored);
			if (epoch !== generation.current) return;
			if (failing.current.delete(folder) && !failing.current.size)
				resolveToast(t(locale, 'Could not read the folder.'));
			setReleased(result.released === true);
			setTask((state) =>
				sameFileEntries(state.fileChildren[folder], result.entries)
					? state
					: { fileChildren: { ...state.fileChildren, [folder]: result.entries } }
			);
			setTruncated(result.truncated);
		} catch {
			if (epoch !== generation.current) return;
			if (!failing.current.size) toastWarning(t(locale, 'Could not read the folder.'));
			failing.current.add(folder);
		}
	}
	useEffect(() => () => failing.current.clear(), [task.id, task.projectId]);
	useEffect(() => {
		generation.current++;
		for (const id of failing.current) if (!expanded.has(id)) failing.current.delete(id);
		const refresh = () => {
			for (const id of expanded) void load(id === 'root' ? null : id);
		};
		refresh();
		const timer = setInterval(refresh, 3000);
		return () => {
			generation.current++;
			clearInterval(timer);
		};
	}, [task.id, task.projectId, expanded, showIgnored]);
	useEffect(() => {
		let active = true;
		setMatches([]);
		setSearching(Boolean(fileFilter.trim()));
		setSearchFailed(false);
		if (!fileFilter.trim()) return;
		const timer = setTimeout(() => {
			void window.brigadir.searchFiles(task, fileFilter, showIgnored).then(
				(result) => {
					if (active) {
						setMatches(result.entries);
						setTruncated(result.truncated);
						setSearching(false);
					}
				},
				() => {
					if (active) {
						setSearchFailed(true);
						setSearching(false);
						toastError(t(locale, 'Could not filter the tree.'));
					}
				}
			);
		}, 150);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [task.id, task.projectId, fileFilter, showIgnored]);
	useEffect(
		() =>
			window.brigadir.onEditorAction((action) => {
				if (action === 'find' && root.current?.contains(document.activeElement)) {
					filter.current?.focus();
					filter.current?.select();
				}
			}),
		[]
	);
	// spec/appearance#evolution-redesign: each repo of the task is a root of the list (the project's root first); a nested repo is its own
	// root, never a folder inside its parent. Until the repos are read, the project's root stands alone. A project folder
	// that is no repo itself is a plain root first («—» for the branch, no actions): its own files live there.
	const plainRoot: RepoScope = {
		...(scopes.find((scope) => scope.kind === 'root') ?? {
			id: 'root',
			path: '',
			name: '.',
			kind: 'root' as const,
			branch: null,
			selected: true,
		}),
		owners: [],
		additions: 0,
		deletions: 0,
		firstFile: null,
	};
	const read = repos?.data?.scopes ?? [];
	const plain = !read.some((scope) => scope.kind === 'root');
	const roots: RepoScope[] = plain ? [plainRoot, ...read] : read;
	const rootNames = new Set(
		roots.filter((scope) => scope.kind !== 'root').map((scope) => scope.name)
	);
	const rows: TreeRow[] = [];
	function visit(id: string, depth: number, ancestors: string[]) {
		for (const entry of children[id] ?? []) {
			if (entry.scopeName && rootNames.has(entry.scopeName)) continue;
			rows.push({ ...entry, depth, parent: id, ancestors });
			if (expanded.has(entry.id)) visit(entry.id, depth + 1, [...ancestors, entry.id]);
		}
	}
	if (fileFilter.trim())
		rows.push(...matches.map((entry) => ({ ...entry, depth: 0, parent: null, ancestors: [] })));
	else {
		for (const scope of roots) {
			const folder = repoFolder(scope);
			rows.push({ id: `repo:${folder}`, kind: 'repo', folder, scope, parent: null });
			if (expanded.has(folder)) visit(folder, 0, []);
		}
		if (repos && !repos.mainTree) rows.push({ id: 'add-folder', kind: 'add', parent: null });
	}
	const selected = rows.find((row) => row.id === fileSelection),
		activeFolder =
			selected?.kind === 'directory' && expanded.has(selected.id) ? selected.id : selected?.parent;
	const revealListed = Boolean(fileReveal && rows.some((row) => row.id === fileReveal));
	// spec/chat#folder-links: a folder link waits for its row (each level loads in turn), then scrolls to it once.
	useEffect(() => {
		if (!revealListed || !fileReveal) return;
		const id = fileReveal;
		setTask({ fileReveal: null });
		setNavigationTarget(undefined);
		requestAnimationFrame(() => setNavigationTarget(id));
	}, [revealListed, fileReveal]);
	function toggle(row: Pick<TreeRow, 'id'>, value = !expanded.has(row.id)) {
		setTask((state) => {
			const next = new Set(state.fileExpanded);
			if (value) next.add(row.id);
			else next.delete(row.id);
			return { fileExpanded: next };
		});
	}
	function select(row: TreeRow, reveal = false) {
		setNavigationTarget(reveal ? row.id : undefined);
		if (!reveal) pendingFocus.current = null;
		setTask({ fileSelection: row.id });
	}
	function activate(row: TreeRow) {
		if (row.kind === 'repo') toggle({ id: row.folder });
		else if (row.kind === 'add') repos?.addFolder();
		else if (row.kind === 'file') open(row.id, row.path);
		else if (row.kind === 'directory') toggle(row);
	}
	/**
	 * The tree's keys for a file row and a repo root alike: ↑↓ Home End, → opens or steps in, ← closes or steps out, letters
	 * seek. «Add folder…» ends the list but is a button, not a tree item: the keys walk the tree items, Tab reaches it.
	 */
	function keyDown(event: KeyboardEvent<HTMLDivElement>, row: TreeRow) {
		if (event.target !== event.currentTarget) return;
		const items = rows.filter((item) => item.kind !== 'add');
		const index = items.findIndex((item) => item.id === row.id);
		const folder = row.kind === 'repo' ? row.folder : row.kind === 'directory' ? row.id : null;
		let next: TreeRow | undefined;
		if (event.key === 'Enter') {
			event.preventDefault();
			activate(row);
			return;
		}
		const step = listStep(event.key, index, items.length);
		if (step !== null) next = items[step];
		else if (event.key === 'ArrowRight' && folder) {
			event.preventDefault();
			if (!expanded.has(folder)) toggle({ id: folder }, true);
			else next = items[index + 1];
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (folder && expanded.has(folder)) toggle({ id: folder }, false);
			else if (row.parent !== null)
				next = items.find((item) => item.id === row.parent || item.id === `repo:${row.parent}`);
		} else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
			const now = performance.now();
			typeahead.current = {
				text:
					(now - typeahead.current.at < 750 ? typeahead.current.text : '') +
					event.key.toLocaleLowerCase(),
				at: now,
			};
			next = [...items.slice(index + 1), ...items.slice(0, index + 1)].find((item) =>
				(item.kind === 'repo' ? item.scope.name : item.name)
					.toLocaleLowerCase()
					.startsWith(typeahead.current.text)
			);
		}
		if (next) {
			event.preventDefault();
			pendingFocus.current = next.id;
			select(next, true);
		}
	}
	const focusTarget = (row: TreeRow) =>
		fileSelection === row.id ||
		(!rows.some((item) => item.id === fileSelection) && row.id === rows[0]?.id)
			? 0
			: -1;
	const focusPending = (id: string) => (node: HTMLElement | null) => {
		if (node && pendingFocus.current === id) {
			pendingFocus.current = null;
			node.focus({ preventScroll: true });
		}
	};
	function setIgnored(value: boolean) {
		setTask({ showIgnored: value, fileChildren: {} });
	}
	// spec/tasks#released-worktree: no worktree, no tree: a calm note instead of rows and errors; the poll above brings the tree back once the worktree exists again.
	if (released)
		return (
			<div ref={root} data-menu-tree className={styles.tree}>
				<p role="status">
					<strong>{t(locale, 'Worktree removed')}</strong>
					<br />
					{t(locale, 'The files return when the task continues and its worktree is created again.')}
				</p>
			</div>
		);
	return (
		<div ref={root} data-menu-tree className={styles.tree}>
			<header data-size="m">
				<div className={styles.search}>
					<Glyph name="tree-search" size={12} />
					<TextInput
						embedded
						ref={filter}
						aria-label={t(locale, 'Filter files')}
						placeholder={t(locale, 'Filter the tree')}
						value={fileFilter}
						maxLength={200}
						onChange={(event) => setTask({ fileFilter: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === 'Escape' && fileFilter) {
								event.stopPropagation();
								setTask({ fileFilter: '' });
							}
						}}
					/>
					{fileFilter ? (
						<ClearField
							locale={locale}
							value={fileFilter}
							onClear={() => setTask({ fileFilter: '' })}
						/>
					) : (
						findKey && <kbd>{findKey}</kbd>
					)}
				</div>
				{refreshControl}
				<IconButton
					label={t(locale, showIgnored ? 'Hide ignored files' : 'Show ignored files')}
					aria-pressed={showIgnored}
					onClick={() => setIgnored(!showIgnored)}>
					<Glyph name="tree-eye" size={14} />
				</IconButton>
			</header>
			{truncated && <p role="status">{t(locale, 'Not all files are shown.')}</p>}
			{fileFilter.trim() && !rows.length && !truncated && !searchFailed && searching && (
				<div role="status" aria-label={t(locale, 'Searching…')}>
					<SkeletonRows count={6} height={24} single />
				</div>
			)}
			{fileFilter.trim() && !rows.length && !truncated && !searchFailed && !searching && (
				<p role="status">{t(locale, 'No results')}</p>
			)}
			<Rows
				position={rowPosition(positions, fileFilter ? 'tree-filter' : 'tree')}
				targetId={navigationTarget}
				targetAlign="nearest"
				role="tree"
				label={t(locale, 'Project files')}
				rows={rows}
				followOutput={false}
				estimatedHeight={28}
				render={(row) =>
					row.kind === 'repo' && plain && row.scope === plainRoot ? (
						<RepoRoot
							name={projectName}
							aria-label={projectName}
							expanded={expanded.has(row.folder)}
							toggleLabel={`${t(locale, expanded.has(row.folder) ? 'Collapse folder' : 'Expand folder')} · ${projectName}`}
							onToggle={() => {
								select(row);
								toggle({ id: row.folder });
							}}
							branch={<span>—</span>}
							ref={focusPending(row.id)}
							role="treeitem"
							aria-level={1}
							aria-selected={fileSelection === row.id}
							aria-expanded={expanded.has(row.folder)}
							tabIndex={focusTarget(row)}
							className={styles.root}
							onKeyDown={(event) => keyDown(event, row)}
						/>
					) : row.kind === 'repo' ? (
						<PanelRepoRoot
							scope={row.scope}
							expanded={expanded.has(row.folder)}
							onToggle={() => {
								select(row);
								toggle({ id: row.folder });
							}}
							rowRef={focusPending(row.id)}
							rowProps={{
								role: 'treeitem',
								'aria-level': 1,
								'aria-selected': fileSelection === row.id,
								'aria-expanded': expanded.has(row.folder),
								tabIndex: focusTarget(row),
								className: styles.root,
								onClick: (event) => {
									select(row);
									toggle({ id: row.folder });
									event.currentTarget.focus({ preventScroll: true });
								},
								onKeyDown: (event) => keyDown(event, row),
							}}
						/>
					) : row.kind === 'add' ? (
						<div role="none" className={styles.add}>
							<AddFolderRow />
						</div>
					) : (
						<div
							ref={focusPending(row.id)}
							draggable={row.kind !== 'unavailable'}
							onDragStart={(event) => {
								event.dataTransfer.effectAllowed = 'copy';
								event.dataTransfer.setData(
									fileDragType,
									JSON.stringify({ projectId: task.projectId, taskId: task.id, id: row.id })
								);
							}}
							role="treeitem"
							aria-label={row.name}
							aria-description={[
								row.status ? t(locale, statusLabels[row.status]) : '',
								row.ignored ? t(locale, 'Ignored') : '',
								row.scopeKind ?? '',
							]
								.filter(Boolean)
								.join(' · ')}
							aria-level={fileFilter ? 1 : row.depth + 2}
							aria-selected={fileSelection === row.id}
							aria-expanded={row.kind === 'directory' ? expanded.has(row.id) : undefined}
							aria-disabled={row.kind === 'unavailable'}
							tabIndex={focusTarget(row)}
							data-file-id={row.id}
							data-status={row.status}
							data-ignored={row.ignored}
							className={styles.item}
							title={row.path}
							style={{ paddingLeft: inset + row.depth * indent }}
							onClick={(event) => {
								select(row);
								event.currentTarget.focus({ preventScroll: true });
							}}
							onDoubleClick={() => activate(row)}
							onContextMenu={(event) => {
								if (row.kind === 'unavailable') return;
								event.preventDefault();
								select(row);
								const anchor = event.currentTarget;
								void window.brigadir.fileMenu(task, row.id, 'tree').then(
									async (action) => {
										const named = (key: MessageKey) => () =>
											toastError(t(locale, key).replace('{file}', row.name), { bold: row.name });
										if (action === 'open') open(row.id);
										// spec/editor#new-file: New file… in this folder, or in this file's folder; the task view holds the popover.
										if (action === 'new-file')
											dispatchEvent(
												new CustomEvent('brigadir:new-file', {
													detail: {
														projectId: task.projectId,
														id: task.id,
														folder: newFileFolder(
															row.path,
															row.kind === 'directory' ? 'directory' : 'file'
														),
														anchor: anchor.isConnected ? anchor : null,
													},
												})
											);
										if (action === 'attach')
											await attachTaskFile(task, row.id).catch(
												named('Could not add {file} to the composer.')
											);
										if (action === 'terminal')
											await openTaskTerminal(task, row.id).catch(
												named('Could not open a terminal in {file}.')
											);
									},
									() => toastError(t(locale, 'Could not open the menu.'))
								);
							}}
							onKeyDown={(event) => keyDown(event, row)}>
							{row.ancestors.map((id, level) => (
								<span
									key={id}
									className={styles.guide}
									data-active={id === activeFolder}
									style={{ left: inset + level * indent + disclosure / 2 - 0.5 }}
								/>
							))}
							{row.kind === 'directory' ? (
								<button
									tabIndex={-1}
									aria-label={`${t(locale, expanded.has(row.id) ? 'Collapse folder' : 'Expand folder')} · ${row.name}`}
									onClick={(event) => {
										event.stopPropagation();
										select(row);
										toggle(row);
									}}>
									<Glyph name={expanded.has(row.id) ? 'hide' : 'tree-right'} size={10} />
								</button>
							) : (
								<span className={styles.disclosure} />
							)}
							<FileIcon
								name={row.name}
								directory={row.kind === 'directory'}
								library={row.name === 'node_modules'}
							/>
							<span className={styles.name}>{fileFilter ? row.path : row.name}</span>
							{row.scopeKind && (
								<small className={styles.badge} title={`${row.scopeName} · ${row.scopeKind}`}>
									{row.scopeKind === 'submodule' ? 'sub' : row.scopeKind === 'worktree' ? '⑂' : '⧉'}
								</small>
							)}
							{(() => {
								const branch = scopes.find((scope) => scope.name === row.scopeName)?.branch;
								return row.scopeKind && branch ? (
									<span className={styles.branch} title={branch}>
										<Glyph name="tree-branch" size={11} />
										<span>{branch}</span>
									</span>
								) : null;
							})()}
							{(() => {
								// spec/appearance#evolution-redesign: a changed file ends with its git letter, its state name on hover.
								const letter = fileStatusLetter(row);
								return letter && row.status ? (
									<span
										className={styles.letter}
										data-status={row.status}
										title={t(locale, statusLabels[row.status])}
										aria-hidden>
										{letter}
									</span>
								) : null;
							})()}
						</div>
					)
				}
			/>
			<footer>
				<span>
					{t(locale, showIgnored ? 'Ignored files are shown' : 'Ignored files are hidden')}
				</span>
				<Button
					size="s"
					appearance="primary"
					variant="ghost"
					onClick={() => setIgnored(!showIgnored)}>
					{t(locale, showIgnored ? 'Hide' : 'Show')}
				</Button>
			</footer>
		</div>
	);
}
