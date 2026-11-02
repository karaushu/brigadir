import { restoreTasks } from './Archive';
import { TextInput } from './ui/Input';
import {
	useEffect,
	useLayoutEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import {
	commandShortcut,
	menuCommands,
	matchesAccelerator,
	commandAccelerator,
	formatAccelerator,
	archiveSearch,
	archiveWhen,
	prAge,
	allGroupLimit,
	allGroups,
	commandCount,
	defaultKeymap,
	defaultTextSearchOptions,
	matchAt,
	prStateText,
	searchActions,
	searchCount,
	searchPullRequests,
	searchSettings,
	searchTabLabels,
	t,
	taskCount,
	textPattern,
	textSearchReady,
	toggleSetting,
	visibleSearchTabs,
	type ActionEntry,
	type AgentTask,
	type AllGroup,
	type FileSearchResult,
	type Locale,
	type MessageKey,
	type PRHit,
	type Project,
	type SearchTab,
	type SettingEntry,
	type SettingsSnapshot,
	type SettingsTab,
	type TextMatch,
	type TextSearchOptions,
	type TextSearchRequest,
	type WorkspaceSnapshot,
} from '@brigadir/core';
import { useWorkspace } from './store';
import {
	attachTaskContext,
	attachTaskFile,
	openTaskEditor,
	openTaskPR,
	showTaskCommand,
	showTaskDiff,
} from './task-state';
import {
	commandRows,
	runCommand,
	runStateLabel,
	RunGlyph,
	stopCommand,
	useCommandEditor,
	useCommandRuns,
	type CommandRow,
} from './ProjectCommands';
import { usePullRequests } from './PullRequests';
import { menuContextBeforeModal } from './menu-context';
import { StatusIcon, SwitchMark } from './ui/Controls';
import { PRMarkGlyph, PRStateGlyph } from './ui/PRGlyphs';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import { PopupClose } from './ui/PopupClose';
import { SearchTextPane, useTextSearch, TextOptions } from './SearchText';
import styles from './Search.module.css';
import { primaryKey } from './ui/primary-key';
import { SkeletonRows } from './ui/Loading';

const statusLabels: Record<AgentTask['status'], MessageKey> = {
	'rate-limited': 'Rate limited',
	queued: 'Queued',
	preparing: 'Preparing…',
	working: 'Working',
	'needs-you': 'Needs you',
	done: 'Done',
	interrupted: 'Interrupted',
	failed: 'Error',
	backlog: 'Backlog',
	completed: 'Completed task',
};
export type SearchMode = 'all' | 'quick' | 'commands' | 'text' | 'actions';
/** spec/search-menus-and-commands#project-commands: a command row, or one of the two rows a typed line adds. */
type CommandOption =
	| { kind: 'command'; row: CommandRow; group: 'running' | 'saved' }
	| { kind: 'once'; group: 'new' }
	| { kind: 'save'; group: 'new' };
type FileHit = FileSearchResult['entries'][number];
type Row =
	| { kind: 'task'; key: string; task: AgentTask }
	/** spec/tasks#archive: a task in the archive, its own group «In the archive»; ↩ opens it read-only, ⌘↩ restores. */
	| { kind: 'archived'; key: string; task: AgentTask }
	| { kind: 'file'; key: string; entry: FileHit }
	| { kind: 'action'; key: string; action: ActionEntry }
	| { kind: 'setting'; key: string; setting: SettingEntry }
	| { kind: 'pr'; key: string; hit: PRHit }
	| { kind: 'command'; key: string; option: CommandOption }
	| { kind: 'text'; key: string; match: TextMatch };
type Item =
	| {
			type: 'group';
			key: string;
			label: string;
			count?: string | undefined;
			more?: { n: number; tab: SearchTab } | undefined;
			busy?: boolean;
	  }
	| { type: 'file'; key: string; path: string; scope: string; count: number }
	| { type: 'row'; row: Row; index: number };
const alive = (row: CommandRow) => row.state === 'starting' || row.state === 'running';
const groupTab: Record<AllGroup, SearchTab> = {
	agents: 'agents',
	files: 'files',
	actions: 'actions',
	prs: 'prs',
	commands: 'commands',
	text: 'text',
};
const rowGroup: Record<Row['kind'], AllGroup> = {
	task: 'agents',
	archived: 'agents',
	file: 'files',
	action: 'actions',
	setting: 'actions',
	pr: 'prs',
	command: 'commands',
	text: 'text',
};
/** spec/search-menus-and-commands#search-tabs: what was opened from the search in this run of the app, newest first. */
type Recent =
	| { kind: 'task'; projectId: string; id: string }
	| { kind: 'file'; projectId: string; taskId: string; entry: FileHit }
	| { kind: 'pr'; scopeId: string; number: number }
	| { kind: 'action'; id: string };
let recents: Recent[] = [];
const recentKey = (item: Recent) =>
	item.kind === 'task'
		? `t/${item.projectId}/${item.id}`
		: item.kind === 'file'
			? `f/${item.projectId}/${item.taskId}/${item.entry.id}`
			: item.kind === 'pr'
				? `p/${item.scopeId}/${item.number}`
				: `a/${item.id}`;
function remember(item: Recent) {
	recents = [item, ...recents.filter((other) => recentKey(other) !== recentKey(item))].slice(0, 12);
}
/** Text options stay as set for the rest of the run (spec/search-menus-and-commands#search-tabs). */
let textOptions: TextSearchOptions = { ...defaultTextSearchOptions };

export function Search({
	mode,
	initialQuery = '',
	workspace,
	task,
	mainTree = null,
	project,
	locale,
	close,
	openSettings,
}: {
	mode: SearchMode;
	initialQuery?: string;
	workspace: WorkspaceSnapshot | null;
	task: AgentTask | undefined;
	mainTree?: AgentTask | null;
	project?: Project | undefined;
	locale: Locale;
	close(): void;
	openSettings(tab: SettingsTab, target: { setting?: string; keymap?: string }): void;
}) {
	const appearance = useWorkspace((state) => state.appearance),
		modules = appearance.modules,
		keymap = appearance.keymap ?? defaultKeymap;
	const commandKey = (id: string) => {
		const command = menuCommands.find((item) => item.id === id);
		return command && commandAccelerator(command, keymap);
	};
	const quick = mode === 'quick',
		shown: readonly SearchTab[] = quick ? ['files'] : visibleSearchTabs(modules);
	const [tab, setTab] = useState<SearchTab>(
		mode === 'quick'
			? 'files'
			: mode === 'commands' && modules.commands
				? 'commands'
				: mode === 'text'
					? 'text'
					: mode === 'actions'
						? 'actions'
						: 'all'
	);
	const [query, setQuery] = useState(initialQuery),
		[selected, setSelected] = useState(0),
		[error, setError] = useState('');
	const [files, setFiles] = useState<FileSearchResult & { query: string }>({
			entries: [],
			truncated: false,
			query: '',
		}),
		[filesLoading, setFilesLoading] = useState(false);
	const [options, setOptionsState] = useState<TextSearchOptions>(textOptions);
	const setOptions = (next: TextSearchOptions) => {
		textOptions = next;
		setOptionsState(next);
	};
	const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
	const dialog = useRef<HTMLDialogElement>(null),
		input = useRef<HTMLInputElement>(null),
		listId = useId();
	useLayoutEffect(() => {
		const previous = document.activeElement,
			node = dialog.current;
		node?.showModal();
		return () => {
			node?.close();
			if (previous instanceof HTMLElement && previous.isConnected)
				previous.focus({ preventScroll: true });
		};
	}, []);
	useEffect(() => {
		if (initialQuery) input.current?.select();
	}, []);
	useEffect(() => {
		void window.brigadir.readSettings().then(setSettings, () => {});
	}, []);
	useEffect(() => {
		if (!shown.includes(tab)) setTab('all');
	}, [shown.join()]);

	// spec/search-menus-and-commands#search-tabs: without a task Files and Text read the project's main tree (spec/tasks#quick-tasks), opened on first need.
	const shownMain = mainTree && mainTree.projectId === project?.id ? mainTree : null;
	const [lazyMain, setLazyMain] = useState<AgentTask | null>(null);
	const fileTask =
		task ?? shownMain ?? (lazyMain && lazyMain.projectId === project?.id ? lazyMain : null);
	const needsFiles =
		tab === 'files' || tab === 'text' || (tab === 'all' && query.trim().length > 0);
	useEffect(() => {
		if (task || shownMain || !project || !needsFiles || lazyMain?.projectId === project.id) return;
		let active = true;
		void window.brigadir.openMainTree(project.id).then(
			(value) => {
				if (active) setLazyMain(value);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [task?.id, shownMain?.id, project?.id, needsFiles]);

	const filesWanted = (tab === 'files' || (tab === 'all' && query.trim().length > 0)) && fileTask;
	useEffect(() => {
		setError('');
		if (!filesWanted || !fileTask) {
			setFilesLoading(false);
			return;
		}
		let active = true;
		setFilesLoading(true);
		const asked = query;
		const timer = setTimeout(() => {
			void window.brigadir
				.searchFiles(fileTask, asked)
				.then(
					(result) => {
						if (active) setFiles({ ...result, query: asked });
					},
					() => {
						if (active) setError(t(locale, 'The request failed.'));
					}
				)
				.finally(() => {
					if (active) setFilesLoading(false);
				});
		}, 100);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [query, Boolean(filesWanted), fileTask?.id, fileTask?.projectId, locale]);
	useEffect(() => {
		setSelected(0);
	}, [tab, query]);

	const textRequest: TextSearchRequest | null =
		fileTask && textSearchReady(query, tab) && !quick ? { query: query.trim(), ...options } : null;
	const invalidPattern = textRequest !== null && textPattern(textRequest) === null;
	const text = useTextSearch(
		invalidPattern ? null : (fileTask ?? null),
		invalidPattern ? null : textRequest
	);

	// Agents: title, project and prompt (spec/search-menus-and-commands#search-tabs).
	const projectName = (id: string) =>
		workspace?.projects.find((item) => item.id === id)?.name ?? '';
	const rank = (item: AgentTask) =>
		item.status === 'needs-you' ? 0 : item.status === 'working' ? 1 : 2;
	const agents = useMemo(
		() =>
			(workspace?.tasks ?? [])
				.filter(
					(item) =>
						!item.archived &&
						matchAt(`${item.title}\n${projectName(item.projectId)}\n${item.prompt ?? ''}`, query) >=
							0
				)
				.sort((a, b) => rank(a) - rank(b))
				.slice(0, 100),
		[workspace, query]
	);
	// PR from the list already read (spec/search-menus-and-commands#search-tabs).
	const prData = usePullRequests()?.data ?? null;
	const prs = useMemo(
		() => (modules.pullRequests && prData ? searchPullRequests(query, prData.repos) : []),
		[prData, query, modules.pullRequests]
	);
	// Actions and settings (spec/search-menus-and-commands#search-tabs).
	const actions = useMemo(
		() =>
			searchActions(query, {
				context: menuContextBeforeModal(),
				modules,
				keymap: appearance.keymap ?? defaultKeymap,
				locale,
			}),
		[query, modules, appearance.keymap, locale]
	);
	const settingRows = useMemo(
		() =>
			query.trim() || tab === 'actions'
				? searchSettings(query, settings?.settings ?? null, locale)
				: [],
		[query, settings, locale, tab]
	);
	// Commands (spec/search-menus-and-commands#project-commands).
	const { runs } = useCommandRuns(
		modules.commands && (tab === 'commands' || tab === 'all') ? task : undefined
	);
	const commandProject = task
		? workspace?.projects.find((item) => item.id === task.projectId)
		: project;
	const matched = modules.commands
		? commandRows(commandProject, runs).filter((row) =>
				`${row.command.name}\n${row.command.command}`
					.toLocaleLowerCase()
					.includes(query.trim().toLocaleLowerCase())
			)
		: [];
	const commandOptions: CommandOption[] = [
		...matched
			.filter(alive)
			.map((row) => ({ kind: 'command' as const, row, group: 'running' as const })),
		...matched
			.filter((row) => !alive(row))
			.map((row) => ({ kind: 'command' as const, row, group: 'saved' as const })),
		...(query.trim() && tab === 'commands'
			? [
					{ kind: 'once' as const, group: 'new' as const },
					{ kind: 'save' as const, group: 'new' as const },
				]
			: []),
	];

	const fileRows: Row[] = files.entries.map((entry) => ({
		kind: 'file',
		key: `f/${entry.id}`,
		entry,
	}));
	const taskRows: Row[] = agents.map((item) => ({
		kind: 'task',
		key: `t/${item.projectId}/${item.id}`,
		task: item,
	}));
	// spec/tasks#archive: the archive's own source, shared with the Archive window; only for a typed query.
	const archivedRows: Row[] = useMemo(
		() =>
			query.trim() && workspace
				? archiveSearch(
						workspace.tasks,
						workspace.projects,
						{ query, projectId: null, by: null },
						locale
					)
						.slice(0, 50)
						.map((item) => ({
							kind: 'archived' as const,
							key: `r/${item.projectId}/${item.id}`,
							task: item,
						}))
				: [],
		[workspace, query, locale]
	);
	const prRows: Row[] = prs.map((hit) => ({
		kind: 'pr',
		key: `p/${hit.scopeId}/${hit.pr.number}`,
		hit,
	}));
	const actionRows: Row[] = actions.map((action) => ({
		kind: 'action',
		key: `a/${action.id}`,
		action,
	}));
	const settingRowsList: Row[] = settingRows.map((setting) => ({
		kind: 'setting',
		key: `s/${setting.id}`,
		setting,
	}));
	const commandRowsList: Row[] = commandOptions.map((option, index) => ({
		kind: 'command',
		key: option.kind === 'command' ? `c/${option.row.command.id}` : `c/${option.kind}/${index}`,
		option,
	}));
	const textRows: Row[] = text.matches.map((match, index) => ({
		kind: 'text',
		key: `x/${index}`,
		match,
	}));

	// spec/search-menus-and-commands#search-tabs: «Recent» on an empty «All».
	const recentRows = (): Row[] => {
		const out: Row[] = [];
		for (const item of recents) {
			if (item.kind === 'task') {
				const found = workspace?.tasks.find(
					(value) => value.projectId === item.projectId && value.id === item.id
				);
				if (found) out.push({ kind: 'task', key: recentKey(item), task: found });
			} else if (item.kind === 'file') {
				if (fileTask && fileTask.projectId === item.projectId && fileTask.id === item.taskId)
					out.push({ kind: 'file', key: recentKey(item), entry: item.entry });
			} else if (item.kind === 'pr') {
				const hit = searchPullRequests('', prData?.repos ?? []).find(
					(value) => value.scopeId === item.scopeId && value.pr.number === item.number
				);
				if (hit && modules.pullRequests) out.push({ kind: 'pr', key: recentKey(item), hit });
			} else {
				const action = searchActions('', {
					context: menuContextBeforeModal(),
					modules,
					keymap: appearance.keymap ?? defaultKeymap,
					locale,
				}).find((value) => value.id === item.id);
				if (action) out.push({ kind: 'action', key: recentKey(item), action });
			}
		}
		for (const item of (workspace?.tasks ?? [])
			.filter((value) => value.status === 'needs-you' || value.status === 'working')
			.sort((a, b) => rank(a) - rank(b)))
			if (out.length < 6 && !out.some((row) => row.kind === 'task' && row.task === item))
				out.push({ kind: 'task', key: `t/${item.projectId}/${item.id}`, task: item });
		return out.slice(0, 6);
	};

	const textCount = `${text.matches.length}${text.running ? '…' : ''}`;
	const counts: Partial<Record<SearchTab, string>> = {
		agents: String(agents.length + archivedRows.length),
		files: filesLoading && files.query !== query ? '…' : String(files.entries.length),
		text: textRequest ? textCount : '',
		prs: String(prs.length),
		commands: String(matched.length),
		actions: String(actions.length + settingRows.length),
	};
	// Build the list for the tab.
	const items: Item[] = [];
	const rows: Row[] = [];
	const push = (row: Row) => {
		items.push({ type: 'row', row, index: rows.length });
		rows.push(row);
	};
	const group = (
		key: string,
		label: string,
		count?: string,
		more?: { n: number; tab: SearchTab },
		busy = false
	) => items.push({ type: 'group', key, label, count, more, busy });
	// spec/tasks#archive: «In the archive» right under Agents in All, under the live tasks in Agents.
	const archiveGroup = () => {
		if (!archivedRows.length) return;
		group(
			'archive',
			t(locale, 'In the archive'),
			String(archivedRows.length),
			tab === 'all' && archivedRows.length > allGroupLimit
				? { n: archivedRows.length - allGroupLimit, tab: 'agents' }
				: undefined
		);
		(tab === 'all' ? archivedRows.slice(0, allGroupLimit) : archivedRows).forEach(push);
	};
	if (tab === 'all') {
		if (!query.trim()) {
			const recent = recentRows();
			if (recent.length) {
				group('recent', t(locale, 'Recently opened'));
				recent.forEach(push);
			}
		} else
			for (const name of allGroups) {
				const list =
					name === 'agents'
						? taskRows
						: name === 'files'
							? fileRows
							: name === 'actions'
								? [...actionRows, ...settingRowsList]
								: name === 'prs'
									? prRows
									: name === 'commands'
										? commandRowsList
										: textRows;
				const busy = name === 'text' && text.running;
				if (!list.length && !busy) {
					if (name === 'agents') archiveGroup();
					continue;
				}
				const total =
					name === 'text'
						? text.matches.length > allGroupLimit
							? `${allGroupLimit} ${t(locale, 'of')} ${textCount}`
							: textCount
						: String(list.length);
				group(
					name,
					t(locale, searchTabLabels[groupTab[name]]),
					total,
					list.length > allGroupLimit
						? { n: list.length - allGroupLimit, tab: groupTab[name] }
						: undefined,
					busy
				);
				list.slice(0, allGroupLimit).forEach(push);
				if (name === 'agents') archiveGroup();
			}
	} else if (tab === 'agents') {
		taskRows.forEach(push);
		archiveGroup();
	} else if (tab === 'files') fileRows.forEach(push);
	else if (tab === 'text') {
		let last = '';
		for (const row of textRows) {
			const { match } = row as Extract<Row, { kind: 'text' }>;
			if (match.path !== last) {
				last = match.path;
				items.push({
					type: 'file',
					key: `file-${match.path}`,
					path: match.path,
					scope: match.scope,
					count: text.matches.filter((value) => value.path === match.path).length,
				});
			}
			push(row);
		}
	} else if (tab === 'prs') {
		const labels: Record<PRHit['group'], MessageKey> = {
			waiting: 'Waiting for you',
			mine: 'Yours',
			others: 'Others',
			closed: 'Recently closed',
		};
		let last = '';
		for (const row of prRows) {
			const hit = (row as Extract<Row, { kind: 'pr' }>).hit;
			if (hit.group !== last) {
				last = hit.group;
				group(
					`pr-${hit.group}`,
					t(locale, labels[hit.group]),
					String(prs.filter((value) => value.group === hit.group).length)
				);
			}
			push(row);
		}
	} else if (tab === 'actions') {
		if (actionRows.length) {
			group('actions', t(locale, 'Actions'), String(actionRows.length));
			actionRows.forEach(push);
		}
		if (settingRowsList.length) {
			group('settings', t(locale, 'Settings'), String(settingRowsList.length));
			settingRowsList.forEach(push);
		}
	} else if (tab === 'commands') {
		const labels: Record<CommandOption['group'], MessageKey> = {
			running: 'Running now',
			saved: 'Commands',
			new: 'New',
		};
		let last = '';
		for (const row of commandRowsList) {
			const option = (row as Extract<Row, { kind: 'command' }>).option;
			if (option.group !== last) {
				last = option.group;
				group(`cmd-${option.group}`, t(locale, labels[option.group]));
			}
			push(row);
		}
	}
	const active = Math.min(selected, Math.max(0, rows.length - 1)),
		current = rows[active];
	const fail = () => setError(t(locale, 'The request failed.'));

	// ── Actions ──
	const show = () => {
		location.hash = 'workspace';
	};
	async function owner() {
		if (task) return task;
		if (!project) return null;
		const store = useWorkspace.getState();
		return store.mainTree?.task.projectId === project.id
			? store.mainTree.task
			: store.openMainTree(project.id, null);
	}
	function editCommand(option: CommandOption | undefined) {
		if (!commandProject || !option || option.kind === 'once') return;
		close();
		useCommandEditor.getState().open({
			projectId: commandProject.id,
			command: option.kind === 'command' ? option.row.command : null,
			...(option.kind === 'save' ? { line: query.trim() } : {}),
			task,
		});
	}
	/** Enter runs and shows; `background` (⌘Enter) runs without leaving the search target; a live command is only shown. */
	async function runOption(option: CommandOption | undefined, background = false) {
		if (!option || !task) return;
		if (option.kind === 'save') {
			editCommand(option);
			return;
		}
		if (option.kind === 'once') {
			await runCommand(task, { line: query.trim() }, background);
			if (!background) show();
			close();
			return;
		}
		if (alive(option.row) && option.row.run && !background) {
			showTaskCommand(task, option.row.run.id, option.row.command.id, option.row.run.title);
			show();
			close();
			return;
		}
		await runCommand(task, { commandId: option.row.command.id }, background);
		if (!background) {
			show();
			close();
		}
	}
	async function openFile(entry: { id: string }, line?: number, column?: number) {
		if (!fileTask) return;
		const document = await window.brigadir.readEditorFile(fileTask, entry.id);
		const target = task ?? (await owner());
		if (!target) return;
		await openTaskEditor(target, document, line, column);
		show();
		close();
	}
	async function primary(row: Row | undefined) {
		if (!row) return;
		try {
			if (row.kind === 'task' || row.kind === 'archived') {
				remember({ kind: 'task', projectId: row.task.projectId, id: row.task.id });
				useWorkspace.getState().selectTask(row.task.projectId, row.task.id);
				show();
				close();
			} else if (row.kind === 'file') {
				if (filesLoading) return;
				if (fileTask)
					remember({
						kind: 'file',
						projectId: fileTask.projectId,
						taskId: fileTask.id,
						entry: row.entry,
					});
				await openFile(row.entry);
			} else if (row.kind === 'text')
				await openFile({ id: row.match.fileId }, row.match.line, row.match.column);
			else if (row.kind === 'pr') {
				remember({ kind: 'pr', scopeId: row.hit.scopeId, number: row.hit.pr.number });
				const target = await owner();
				if (!target) return;
				openTaskPR(target, { scopeId: row.hit.scopeId, number: row.hit.pr.number });
				show();
				close();
			} else if (row.kind === 'action') {
				remember({ kind: 'action', id: row.action.id });
				close();
				// The focus goes back where it was first, so the item acts on what it would act on from the menu.
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						void window.brigadir.runMenuCommand(row.action.id).catch(() => {});
					})
				);
			} else if (row.kind === 'setting') {
				const next =
					row.setting.toggle !== null && settings
						? toggleSetting(row.setting.id, settings.settings)
						: null;
				if (next) {
					setSettings(await window.brigadir.saveSettings(next));
					return;
				}
				close();
				openSettings(row.setting.tab, { setting: row.setting.id });
			} else await runOption(row.option);
		} catch {
			setError(
				t(
					locale,
					row.kind === 'file' || row.kind === 'text'
						? 'The file could not be read.'
						: 'The request failed.'
				)
			);
		}
	}
	async function secondary(row: Row | undefined) {
		if (!row) return;
		try {
			if (row.kind === 'task') {
				useWorkspace.getState().selectTask(row.task.projectId, row.task.id);
				showTaskDiff(row.task);
				show();
				close();
			} else if (row.kind === 'archived') await restoreTasks([row.task]);
			else if (row.kind === 'file') {
				if (!task) return;
				await attachTaskFile(task, row.entry.id);
				show();
				close();
			} else if (row.kind === 'text') {
				if (!task) return;
				const { match } = row;
				await attachTaskContext(task, {
					kind: 'text',
					name: `${match.path.split('/').at(-1)}:${match.line}`,
					text: `${match.path}:${match.line}\n${match.text}`,
				});
				show();
				close();
			} else if (row.kind === 'pr') {
				const projectId = task?.projectId ?? project?.id;
				if (projectId)
					await window.brigadir.openPullRequestPage(
						projectId,
						task?.id ?? null,
						row.hit.scopeId,
						row.hit.pr.number
					);
			} else if (row.kind === 'action') {
				close();
				openSettings('appearance', { keymap: row.action.label });
			} else if (row.kind === 'setting') {
				close();
				openSettings(row.setting.tab, { setting: row.setting.id });
			} else await runOption(row.option, true);
		} catch {
			fail();
		}
	}
	function nextFile(direction: 1 | -1) {
		if (tab !== 'text' || !current || current.kind !== 'text') return;
		const path = current.match.path;
		for (let i = active + direction; i >= 0 && i < rows.length; i += direction) {
			const row = rows[i];
			if (row?.kind === 'text' && row.match.path !== path) {
				if (direction === -1) {
					const target = row.match.path;
					let first = i;
					while (
						first > 0 &&
						(rows[first - 1] as Row).kind === 'text' &&
						(rows[first - 1] as Extract<Row, { kind: 'text' }>).match.path === target
					)
						first--;
					setSelected(first);
				} else setSelected(i);
				return;
			}
		}
	}

	// ── Rendering ──
	const fileProjectName = fileTask ? projectName(fileTask.projectId) : '';
	const strong = (value: string) => {
		const at = matchAt(value, query);
		const length = query.trim().length;
		return at < 0 || !length ? (
			value
		) : (
			<>
				{value.slice(0, at)}
				<strong>{value.slice(at, at + length)}</strong>
				{value.slice(at + length)}
			</>
		);
	};
	const fuzzy = (value: string) => {
		const needle = query.trim().toLocaleLowerCase();
		if (!needle) return value;
		const points = new Set<number>();
		let cursor = 0;
		for (const char of needle) {
			const next = value.toLocaleLowerCase().indexOf(char, cursor);
			if (next < 0) return value;
			points.add(next);
			cursor = next + 1;
		}
		return [...value].map((char, index) =>
			points.has(index) ? <strong key={index}>{char}</strong> : char
		);
	};
	const marks = (value: string, ranges: [number, number][]) => {
		const out: ReactNode[] = [];
		let at = 0;
		ranges.forEach(([from, to], index) => {
			out.push(value.slice(at, from), <mark key={index}>{value.slice(from, to)}</mark>);
			at = to;
		});
		out.push(value.slice(at));
		return out;
	};
	// The PR panel's state glyph (rule 17); the wrapper only places it in the row.
	const prIcon = (state: PRHit['pr']['state']) => (
		<span className={styles.prIcon}>
			<PRStateGlyph pr={{ state }} />
		</span>
	);
	function rowBody(row: Row): ReactNode {
		if (row.kind === 'archived')
			return (
				<>
					<Glyph name="archive-box" size={14} />
					<span className={styles.title}>{strong(row.task.title)}</span>
					<small>{`${t(locale, 'in the archive {when}').replace('{when}', archiveWhen(locale, row.task.archived!.at, Date.now()))} · ${projectName(row.task.projectId)}`}</small>
				</>
			);
		if (row.kind === 'task')
			return (
				<>
					<StatusIcon
						status={row.task.status}
						label={t(locale, statusLabels[row.task.status])}
						size={14}
					/>
					<span className={styles.title}>{strong(row.task.title)}</span>
					<small>{`${t(locale, statusLabels[row.task.status])} · ${projectName(row.task.projectId)}`}</small>
				</>
			);
		if (row.kind === 'file') {
			const dir = row.entry.path.includes('/')
				? row.entry.path.slice(0, row.entry.path.lastIndexOf('/'))
				: '';
			return (
				<>
					<Glyph name="search-file" size={13} />
					<span className={styles.title} data-mono>
						{fuzzy(row.entry.name)}
					</span>
					<small data-mono>{dir || (row.entry.scope === '.' ? '' : row.entry.scope)}</small>
					{row.entry.scope && row.entry.scope !== '.' && row.entry.scope !== fileProjectName && (
						<span className={styles.chip}>{row.entry.scope}</span>
					)}
				</>
			);
		}
		if (row.kind === 'action')
			return (
				<>
					<Glyph name="search-action" size={14} />
					<span className={styles.title}>
						{row.action.matchedEnglish ? row.action.label : strong(row.action.label)}
						{row.action.matchedEnglish && (
							<span className={styles.english}> {strong(row.action.english)}</span>
						)}
					</span>
					<small>{row.action.group}</small>
					{row.action.shortcut && <kbd>{row.action.shortcut}</kbd>}
				</>
			);
		if (row.kind === 'setting')
			return (
				<>
					<Glyph name="search-setting" size={14} />
					<span className={styles.title}>{strong(row.setting.label)}</span>
					<small>{row.setting.path}</small>
					{row.setting.toggle !== null ? (
						<SwitchMark
							checked={row.setting.toggle}
							label={t(locale, row.setting.toggle ? 'On' : 'Off')}
						/>
					) : (
						row.setting.value && <kbd>{row.setting.value}</kbd>
					)}
				</>
			);
		if (row.kind === 'pr') {
			const { pr } = row.hit;
			if (tab === 'prs')
				return (
					<>
						{prIcon(pr.state)}
						<span className={styles.column}>
							<span className={styles.title}>
								<span className={styles.dim}>#{pr.number}</span> {strong(pr.title)}
							</span>
							<small>
								{[
									pr.mine ? t(locale, 'you') : pr.author,
									prAge(locale, pr.updatedAt),
									row.hit.repo === '.' ? projectName(project?.id ?? '') : row.hit.repo,
								].join(' · ')}
							</small>
						</span>
						{pr.waiting && (
							<span className={styles.waiting}>
								<PRMarkGlyph pr={pr} locale={locale} />
							</span>
						)}
						<span className={styles.state} data-state={pr.state}>
							{prStateText(locale, pr)}
						</span>
					</>
				);
			return (
				<>
					{prIcon(pr.state)}
					<span className={styles.title}>
						<span className={styles.dim}>#{pr.number}</span> {strong(pr.title)}
					</span>
					<small>
						{[
							pr.mine ? t(locale, 'you') : pr.author,
							prAge(locale, pr.updatedAt),
							row.hit.repo === '.' ? projectName(project?.id ?? '') : row.hit.repo,
							prStateText(locale, pr).toLocaleLowerCase(),
						].join(' · ')}
					</small>
				</>
			);
		}
		if (row.kind === 'text') {
			const { match } = row;
			if (tab === 'text')
				return (
					<>
						<span className={styles.line}>{match.line}</span>
						<code className={styles.code}>{marks(match.text, match.ranges)}</code>
					</>
				);
			return (
				<>
					<Glyph name="search-file" size={13} />
					<span className={styles.column}>
						<span className={styles.textHead}>
							<span data-mono>
								{match.path.split('/').at(-1)}
								<span className={styles.dim}>:{match.line}</span>
							</span>
							<small data-mono>
								{match.path.includes('/') ? match.path.slice(0, match.path.lastIndexOf('/')) : ''}
							</small>
						</span>
						<code className={styles.code}>
							{marks(
								match.text.trimStart(),
								match.ranges.map(([a, b]): [number, number] => {
									const cut = match.text.length - match.text.trimStart().length;
									return [a - cut, b - cut];
								})
							)}
						</code>
					</span>
				</>
			);
		}
		const { option } = row;
		if (option.kind === 'command')
			return (
				<>
					<RunGlyph state={option.row.state} />
					<b>{strong(option.row.command.name)}</b>
					<code>{strong(option.row.command.command)}</code>
					<small>
						{[
							option.row.command.repo || commandProject?.name,
							t(locale, runStateLabel[option.row.state ?? 'idle']),
							option.row.state === 'running' && option.row.run?.run?.port
								? `:${option.row.run.run.port}`
								: option.row.state === 'failed'
									? `exit ${option.row.run?.exitCode}`
									: '',
						]
							.filter(Boolean)
							.join(' · ')}
					</small>
				</>
			);
		return (
			<>
				{option.kind === 'once' ? (
					<Glyph name="command-play" size={12} />
				) : (
					<Glyph name="plus" size={12} />
				)}
				<b>{t(locale, option.kind === 'once' ? 'Run once' : 'Save as command…')}</b>
				{option.kind === 'once' ? <code>{query.trim()}</code> : <span />}
				<small>{formatAccelerator(option.kind === 'once' ? 'Alt+Enter' : 'CmdOrCtrl+E')}</small>
			</>
		);
	}
	const renderRow = (row: Row, index: number) => {
		const command = row.kind === 'command',
			disabled = command && !task;
		return (
			<button
				key={row.key}
				id={`${listId}-${index}`}
				role="option"
				tabIndex={-1}
				aria-selected={active === index}
				aria-disabled={disabled || undefined}
				data-kind={row.kind}
				data-two={
					(row.kind === 'pr' && tab === 'prs') ||
					(row.kind === 'text' && tab !== 'text') ||
					undefined
				}
				data-command={command || undefined}
				data-file={row.kind === 'file' || undefined}
				data-archived={row.kind === 'archived' || undefined}
				title={
					row.kind === 'task' || row.kind === 'archived'
						? row.task.title
						: row.kind === 'file'
							? row.entry.path
							: row.kind === 'command' && row.option.kind === 'command'
								? row.option.row.command.command
								: undefined
				}
				ref={(element) => {
					if (active === index) element?.scrollIntoView({ block: 'nearest' });
				}}
				onPointerMove={() => setSelected(index)}
				onClick={() => {
					void primary(row);
				}}>
				{rowBody(row)}
			</button>
		);
	};
	const switchTab = (next: SearchTab) => {
		setTab(next);
		input.current?.focus();
	};
	const groupNode = (item: Extract<Item, { type: 'group' }>) => (
		<div
			key={`g-${item.key}`}
			role="presentation"
			className={styles.group}
			data-size="s"
			data-search-group={item.key}>
			<span>{item.label}</span>
			{item.count && <span className={styles.groupCount}>{item.count}</span>}
			{item.busy && <span className={styles.spinner} aria-hidden="true" />}
			{item.more && (
				<button
					type="button"
					tabIndex={-1}
					className={styles.more}
					onClick={() => switchTab(item.more!.tab)}
					aria-label={`${t(locale, 'More')} ${item.more.n} · ${item.label}`}>
					{t(locale, 'More')} {item.more.n}
					<Glyph name="search-more" size={10} />
				</button>
			)}
		</div>
	);

	// Footer: hints for the selected row's type (spec/search-menus-and-commands#search-tabs), the state on the right.
	const kind = current?.kind;
	// The keys of the footer as this platform spells them: `⌘↩` on macOS, `Ctrl+Enter` on Windows and Linux.
	const enter = formatAccelerator('Enter') + ' ',
		primaryEnter = formatAccelerator('CmdOrCtrl+Enter') + ' ';
	const hints: string[] = ['↑↓ ' + t(locale, 'Select result')];
	if (tab === 'text') hints.push(formatAccelerator('Alt+Down') + ' ' + t(locale, 'Next file'));
	if (kind === 'task')
		hints.push(enter + t(locale, 'Show task'), primaryEnter + t(locale, 'Show changes'));
	else if (kind === 'archived')
		hints.push(enter + t(locale, 'Show task'), primaryEnter + t(locale, 'Restore from archive'));
	else if (kind === 'file')
		hints.push(
			enter + t(locale, task || !fileTask ? 'Open result' : 'Open in the main tree'),
			...(task ? [primaryEnter + t(locale, 'To composer')] : [])
		);
	else if (kind === 'text')
		hints.push(
			enter + t(locale, 'Open at the line'),
			...(task ? [primaryEnter + t(locale, 'Line to chat')] : [])
		);
	else if (kind === 'pr')
		hints.push(
			enter + t(locale, 'Open in the PR panel'),
			primaryEnter + t(locale, 'Open on GitHub')
		);
	else if (kind === 'action')
		hints.push(enter + t(locale, 'Run the action'), primaryEnter + t(locale, 'Change shortcut'));
	else if (kind === 'setting')
		hints.push(
			...(current?.kind === 'setting' && current.setting.toggle !== null
				? [enter + t(locale, 'Toggle the setting'), primaryEnter + t(locale, 'Open in Settings')]
				: [enter + t(locale, 'Open in Settings')])
		);
	else if (kind === 'command')
		hints.push(
			enter + t(locale, 'Run and show'),
			primaryEnter + t(locale, 'Run in the background'),
			...((key) => (key ? [`${key} ${t(locale, 'Stop command')}`] : []))(
				commandShortcut('command-stop', keymap)
			)
		);
	else if (tab !== 'all' || query.trim()) hints.push(enter + t(locale, 'Open result'));
	if (tab === 'all' && query.trim() && rows.length)
		hints.push(formatAccelerator('CmdOrCtrl+Right') + ' ' + t(locale, 'Whole group'));
	if (tab === 'text')
		hints.push(
			['Alt+C', 'Alt+W', 'Alt+X'].map((key) => formatAccelerator(key)).join(' ') +
				' ' +
				t(locale, 'Options')
		);
	if (!quick) hints.push(formatAccelerator('Tab') + ' ' + t(locale, 'Switch tab'));
	hints.push(formatAccelerator('Escape') + ' ' + t(locale, 'Close'));
	const fileCount = new Set(text.matches.map((match) => match.path)).size;
	const textStatus = invalidPattern
		? t(locale, 'Invalid regular expression')
		: textRequest
			? `${searchCount(locale, 'match', text.matches.length)} ${t(locale, 'in')} ${searchCount(locale, 'file-in', fileCount)}${text.running ? ` · ${t(locale, 'searching…')}` : ''}`
			: '';
	const status =
		tab === 'all'
			? text.running
				? t(locale, 'searching the text…')
				: query.trim() && !rows.length
					? t(locale, 'no matches')
					: ''
			: tab === 'agents'
				? taskCount(locale, rows.length)
				: tab === 'files'
					? `${searchCount(locale, 'file', files.entries.length)}${fileProjectName ? ` · ${fileProjectName}` : ''}`
					: tab === 'text'
						? textStatus
						: tab === 'prs'
							? `${prs.length} PR${
									prData?.repos.length
										? ` · ${prData.repos
												.map((repo) =>
													repo.name === '.' ? projectName(project?.id ?? '') : repo.name
												)
												.filter(Boolean)
												.join(', ')}`
										: ''
								}`
							: tab === 'actions'
								? `${searchCount(locale, 'action', actionRows.length)} · ${searchCount(locale, 'setting', settingRowsList.length)}`
								: `${commandCount(locale, commandProject?.commands?.length ?? 0)}${commandProject ? ` · ${commandProject.name}` : ''}`;
	const searched = tab === 'all' && query.trim() && !rows.length && !text.running && !filesLoading;

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.defaultPrevented || event.nativeEvent.isComposing) return;
		const target = event.target as HTMLElement,
			isInput = target === input.current,
			isOption = target.getAttribute('role') === 'option';
		if (!isInput && !isOption) return;
		const key = event.key,
			code = event.nativeEvent.code;
		if ((key === 'ArrowDown' || key === 'ArrowUp') && event.altKey && tab === 'text') {
			event.preventDefault();
			nextFile(key === 'ArrowDown' ? 1 : -1);
		} else if (key === 'ArrowDown' || key === 'ArrowUp') {
			event.preventDefault();
			setSelected((value) =>
				Math.max(0, Math.min(rows.length - 1, value + (key === 'ArrowDown' ? 1 : -1)))
			);
		} else if (key === 'ArrowRight' && primaryKey(event) && tab === 'all' && current) {
			event.preventDefault();
			switchTab(groupTab[rowGroup[current.kind]]);
		} else if (
			tab === 'text' &&
			event.altKey &&
			!event.metaKey &&
			!event.ctrlKey &&
			(code === 'KeyC' || code === 'KeyW' || code === 'KeyX')
		) {
			event.preventDefault();
			setOptions({
				...options,
				...(code === 'KeyC'
					? { caseSensitive: !options.caseSensitive }
					: code === 'KeyW'
						? { wholeWord: !options.wholeWord }
						: { regex: !options.regex }),
			});
		} else if (tab === 'commands' && key === 'Enter' && event.altKey) {
			event.preventDefault();
			if (query.trim() && task) void runOption({ kind: 'once', group: 'new' }).catch(fail);
		} else if (key === 'Enter' && primaryKey(event)) {
			event.preventDefault();
			void secondary(current);
		} else if (key === 'Enter') {
			event.preventDefault();
			void primary(current);
		} else if (tab === 'commands' && primaryKey(event) && key.toLowerCase() === 'e') {
			event.preventDefault();
			editCommand(current?.kind === 'command' ? current.option : undefined);
		} else if (
			tab === 'commands' &&
			(matchesAccelerator(event, commandKey('command-run')) ||
				matchesAccelerator(event, commandKey('command-stop')))
		) {
			event.preventDefault();
			const option = current?.kind === 'command' ? current.option : undefined;
			if (option?.kind !== 'command' || !task) return;
			if (matchesAccelerator(event, commandKey('command-stop'))) {
				if (option.row.run && alive(option.row)) void stopCommand(task, option.row.run).catch(fail);
			} else void runCommand(task, { commandId: option.row.command.id }, true).catch(fail);
		} else if (key === 'Tab' && !quick && isInput) {
			event.preventDefault();
			switchTab(
				shown[(shown.indexOf(tab) + (event.shiftKey ? shown.length - 1 : 1)) % shown.length]!
			);
		}
	};

	const placeholder =
		tab === 'all'
			? t(locale, 'Tasks, files, text, PR, actions…')
			: tab === 'commands'
				? t(locale, 'Command or a new line…')
				: t(locale, 'Search');
	const listLabel = t(locale, quick ? 'Search files' : searchTabLabels[tab]);
	const noFileTarget = (tab === 'files' || tab === 'text') && !fileTask;
	const list = (
		<div
			id={listId}
			role="listbox"
			aria-label={listLabel}
			className={styles.results}
			data-tab={tab}>
			{items.map((item) =>
				item.type === 'group' ? (
					groupNode(item)
				) : item.type === 'file' ? (
					<div key={item.key} role="presentation" className={styles.fileHead} title={item.path}>
						<Glyph name="search-file" size={13} />
						<b>{item.path.split('/').at(-1)}</b>
						<span>
							{item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''}
						</span>
						<small>{item.count}</small>
					</div>
				) : (
					renderRow(item.row, item.index)
				)
			)}
			{tab === 'text' && text.running && (
				<p className={styles.progressRow} role="status">
					<span className={styles.spinner} aria-hidden="true" />
					{`${t(locale, 'Searching further…')} ${text.scanned} ${t(locale, 'of')} ${searchCount(locale, 'file', text.total)}`}
				</p>
			)}
			{tab === 'text' && text.truncated && (
				<p className={styles.progressRow}>{t(locale, 'Showing the first 2,000 matches')}</p>
			)}
			{!items.length &&
				!searched &&
				!(tab === 'text' && (text.running || !query.trim())) &&
				!(tab === 'all' && !query.trim()) && (
					<p className={styles.empty}>
						{tab === 'commands'
							? t(locale, commandProject?.commands?.length ? 'No results' : 'No commands')
							: t(locale, 'No results')}
					</p>
				)}
			{tab === 'text' && !query.trim() && (
				<p className={styles.empty}>{t(locale, 'Type to search the text of the files')}</p>
			)}
		</div>
	);
	return (
		<dialog
			ref={dialog}
			className={styles.dialog}
			data-tab={tab}
			aria-label={t(locale, quick ? 'Search files' : 'Search Everywhere')}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onKeyDown={onKeyDown}>
			<header data-size="l">
				<div className={styles.query}>
					<Glyph name="search" size={14} />
					<TextInput
						embedded
						ref={input}
						role="combobox"
						aria-label={t(locale, 'Search')}
						aria-autocomplete="list"
						aria-expanded={rows.length > 0}
						aria-controls={listId}
						aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
						placeholder={placeholder}
						value={query}
						maxLength={tab === 'commands' ? 8000 : 200}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<ClearField locale={locale} value={query} onClear={() => setQuery('')} />
				</div>
				<PopupClose locale={locale} close={close} />
			</header>
			{!quick && (
				<div role="tablist" aria-label={t(locale, 'Search')} className={styles.tabs} data-size="s">
					{shown.map((value) => {
						const count =
							(tab === 'all' && query.trim()) || value === tab ? counts[value] : undefined;
						return (
							<button
								key={value}
								type="button"
								role="tab"
								tabIndex={-1}
								aria-selected={tab === value}
								data-zero={count === '0' || undefined}
								onClick={() => switchTab(value)}>
								{t(locale, searchTabLabels[value])}
								{count && (
									<span className={styles.tabCount} aria-hidden="true">
										{count}
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}
			{tab === 'text' && (
				<TextOptions
					options={options}
					setOptions={setOptions}
					task={fileTask}
					rootName={fileProjectName}
					locale={locale}
					focusInput={() => input.current?.focus()}
				/>
			)}
			{tab === 'text' && (
				<div className={styles.progress} aria-hidden="true">
					{text.running && (
						<i
							style={{
								width: `${text.total ? Math.round((text.scanned / text.total) * 100) : 0}%`,
							}}
						/>
					)}
				</div>
			)}
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{noFileTarget && !project ? (
				<p className={styles.empty}>{t(locale, 'Select a project')}</p>
			) : noFileTarget ? (
				<SkeletonRows count={8} height={34} />
			) : tab === 'commands' && !task ? (
				<>
					{<p className={styles.notice}>{t(locale, 'Open a task to run a command')}</p>}
					{list}
				</>
			) : tab === 'files' && filesLoading && files.query !== query && !files.entries.length ? (
				<SkeletonRows count={8} height={34} />
			) : searched ? (
				<div className={styles.nothing}>
					<strong>
						{t(locale, 'Nothing found for «{query}»').replace('{query}', query.trim())}
					</strong>
					<span>
						{t(
							locale,
							modules.pullRequests
								? 'Searched tasks of every project, files, text, PR, actions and settings.'
								: 'Searched tasks of every project, files, text, actions and settings.'
						)}
					</span>
				</div>
			) : tab === 'text' ? (
				<SearchTextPane
					task={fileTask}
					list={list}
					current={current?.kind === 'text' ? current.match : null}
					matches={text.matches}
					locale={locale}
				/>
			) : (
				<>
					{!task && fileTask && tab === 'files' && (
						<p className={styles.notice}>
							<Glyph name="search-repo" size={12} />
							<span>
								{t(locale, 'No task is open: searching the main tree of')}{' '}
								<b>{projectName(fileTask.projectId)}</b>
							</span>
						</p>
					)}
					{list}
				</>
			)}
			{files.truncated && tab === 'files' && (
				<p className={styles.empty}>{t(locale, 'Search is incomplete.')}</p>
			)}
			<footer>
				{hints.map((hint) => (
					<span key={hint}>{hint}</span>
				))}
				<span className={styles.count}>{status}</span>
			</footer>
		</dialog>
	);
}
