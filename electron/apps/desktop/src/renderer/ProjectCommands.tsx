import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
} from 'react';
import {
	commandDirectory,
	commandFolder,
	isCommandLine,
	isCommandName,
	projectCommandLimit,
	repoOf,
	runState,
	scriptLine,
	t,
	withShortcut,
	documentForTerminal,
	type AgentTask,
	type CommandRunRef,
	type PackageScript,
	type PackageScripts,
	type ProjectScripts,
	type Locale,
	type MessageKey,
	type Project,
	type ProjectCommand,
	type RunState,
	type TerminalInfo,
} from '@brigadir/core';
import { create } from 'zustand';
import { useWorkspace } from './store';
import { useCommandShortcut } from './ui/use-command-shortcut';
import {
	openTaskBrowser,
	setTaskCommand,
	showTaskCommand,
	showTaskTool,
	useTaskState,
} from './task-state';
import { Button, Choice, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { SegmentGroup, SegmentPart } from './ui/SegmentGroup';
import { TextArea, TextInput } from './ui/Input';
import { PopupClose } from './ui/PopupClose';
import { Popover } from './ui/Popover';
import { usePresence } from './ui/use-presence';
import { toastError } from './ui/Toast';
import s from './ProjectCommands.module.css';
/** spec/search-menus-and-commands#project-commands: a saved command and the console tab that runs it in this task, if any. */
export type CommandRow = {
	command: ProjectCommand;
	run: TerminalInfo | undefined;
	state: RunState | null;
};
export const runStateLabel: Record<RunState | 'idle', MessageKey> = {
	starting: 'starting',
	running: 'running',
	failed: 'crashed',
	done: 'finished',
	stopped: 'stopped',
	idle: 'not run yet',
};
const alive = (state: RunState | null) => state === 'starting' || state === 'running';
export function RunGlyph({ state, size = 12 }: { state: RunState | null; size?: number }) {
	return (
		<span className={s.glyph} data-state={state ?? 'idle'} aria-hidden="true">
			{state === 'running' ? (
				<span className={s.dot} />
			) : (
				<Glyph
					name={
						state === 'starting'
							? 'agent-run'
							: state === 'failed'
								? 'agent-failed'
								: state === 'done'
									? 'agent-idle'
									: state === 'stopped'
										? 'command-halt'
										: 'command-idle'
					}
					size={size}
				/>
			)}
		</span>
	);
}
/** The command tabs of a task. Reads never start a host; every run, port and exit re-reads them. */
export function useCommandRuns(task: AgentTask | undefined) {
	const [runs, setRuns] = useState<TerminalInfo[]>([]);
	const version = useRef(0);
	const refresh = useCallback(async () => {
		if (!task) return;
		const current = ++version.current;
		try {
			const value = await window.brigadir.readCommandRuns(task);
			if (current === version.current) setRuns(value);
		} catch {
			/* The next event reads again. */
		}
	}, [task?.id, task?.projectId]);
	useEffect(() => {
		if (!task) return;
		setRuns([]);
		void refresh();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = window.brigadir.onTerminalEvent(({ key, event }) => {
			if (key.id !== task.id || key.projectId !== task.projectId || !(event.run || event.exited))
				return;
			clearTimeout(timer);
			timer = setTimeout(() => void refresh(), 60);
		});
		const local = (event: Event) => {
			const detail = (event as CustomEvent<{ projectId: string; id: string }>).detail;
			if (detail.id === task.id && detail.projectId === task.projectId) void refresh();
		};
		addEventListener('brigadir:command-runs', local);
		return () => {
			clearTimeout(timer);
			stop();
			removeEventListener('brigadir:command-runs', local);
		};
	}, [task?.id, task?.projectId]);
	return { runs, refresh };
}
export function commandRows(project: Project | undefined, runs: TerminalInfo[]): CommandRow[] {
	return (project?.commands ?? []).map((command) => {
		const run = runs.find((item) => item.run?.commandId === command.id);
		return { command, run, state: run ? runState(run) : null };
	});
}
const changed = (task: AgentTask) =>
	dispatchEvent(
		new CustomEvent('brigadir:command-runs', { detail: { projectId: task.projectId, id: task.id } })
	);
/** Runs (or restarts) a saved command or a «Run once» line and, unless `background`, shows its tab. */
export async function runCommand(task: AgentTask, ref: CommandRunRef, background = false) {
	const info = await window.brigadir.runProjectCommand(task, ref);
	changed(task);
	if (!background)
		showTaskCommand(task, info.id, 'commandId' in ref ? ref.commandId : null, info.title);
	else {
		// spec/task-window-workspace#work-area: a command run from its menu row still lives as a tab of the bottom group, not brought forward.
		showTaskTool(task, documentForTerminal(info.id, info.title), 'bottom', true);
		if ('commandId' in ref) setTaskCommand(task, ref.commandId);
	}
	return info;
}
export async function stopCommand(task: AgentTask, run: TerminalInfo) {
	await window.brigadir.terminalCommand(task, { kind: 'stop', id: run.id });
	changed(task);
}
export async function openCommandPort(task: AgentTask, run: TerminalInfo) {
	if (run.run?.port) await openTaskBrowser(task, `http://localhost:${run.run.port}/`);
}
/** spec/search-menus-and-commands#package-scripts: the command of the script `name` of the `package.json` at a project-relative `path`. */
async function scriptCommand(projectId: string, path: string, name: string) {
	const folder = path.split('/').slice(0, -1).join('/');
	const scripts = await window.brigadir.readProjectScripts(projectId);
	const found = scripts.packages.find((item) => commandDirectory(item) === folder);
	const repo = found?.repo ?? repoOf(scripts.repos, folder);
	return {
		folder,
		draft: {
			name,
			command: scriptLine(found?.manager ?? 'npm', name),
			repo,
			directory: repo ? folder.slice(repo.length).replace(/^\//, '') : folder,
		},
	};
}
/** `Run script`: a «Run once» tab in the folder of the `package.json`, nothing saved. */
export async function runScript(task: AgentTask, path: string, name: string, locale: Locale) {
	try {
		const { folder, draft } = await scriptCommand(task.projectId, path, name);
		await runCommand(task, { line: draft.command, ...(folder ? { directory: folder } : {}) });
	} catch {
		toastError(t(locale, 'Could not run the script.'));
	}
}
/** `Add to commands…`: the editor filled with the script, or the saved command that already runs it. */
export async function addScriptCommand(
	task: AgentTask,
	path: string,
	name: string,
	locale: Locale
) {
	let draft: Omit<ProjectCommand, 'id'>;
	try {
		draft = (await scriptCommand(task.projectId, path, name)).draft;
	} catch {
		toastError(t(locale, 'Could not read the scripts of package.json.'));
		return;
	}
	const project = useWorkspace
			.getState()
			.workspace?.projects.find((item) => item.id === task.projectId),
		saved = project?.commands?.find(
			(command) =>
				command.repo === draft.repo &&
				command.directory === draft.directory &&
				command.command === draft.command
		);
	useCommandEditor
		.getState()
		.open({ projectId: task.projectId, command: saved ?? null, ...(saved ? {} : { draft }), task });
}

/** One editor for the whole window: the toolbar menu, the search tab and the File menu open it. */
type EditorRequest = {
	projectId: string;
	command: ProjectCommand | null;
	line?: string;
	/** spec/search-menus-and-commands#package-scripts: a new command filled from a `package.json` script. */
	draft?: Omit<ProjectCommand, 'id'>;
	task?: AgentTask | undefined;
};
export const useCommandEditor = create<{
	request: EditorRequest | null;
	open(request: EditorRequest): void;
	close(): void;
}>((set) => ({
	request: null,
	open: (request) => set({ request }),
	close: () => set({ request: null }),
}));
export async function saveCommands(projectId: string, commands: ProjectCommand[]) {
	await window.brigadir.saveProjectCommands(projectId, commands);
	await useWorkspace.getState().load();
}
/** spec/notifications-slack-notes-and-schedules#message-classes: a failed command action is a toast that names the action and the command; the raw error stays out. */
export function commandFailed(
	locale: Locale,
	key: MessageKey,
	values: { name?: string; port?: number } = {}
) {
	toastError(
		t(locale, key)
			.replace('{name}', values.name ?? '')
			.replace('{port}', String(values.port ?? ''))
	);
}
export async function commandMenu(
	task: AgentTask,
	project: Project,
	row: CommandRow,
	edit: () => void,
	locale: Locale
) {
	const name = row.command.name,
		attempt = (
			key: MessageKey,
			work: () => Promise<unknown>,
			values: { name?: string; port?: number } = { name }
		) =>
			work().then(
				() => {},
				() => commandFailed(locale, key, values)
			);
	let action: string | null;
	try {
		action = await window.brigadir.projectCommandMenu({
			running: alive(row.state),
			shown: !!row.run,
			port: !!row.run?.run?.port && alive(row.state),
		});
	} catch {
		commandFailed(locale, 'Could not open the menu.');
		return;
	}
	const commands = project.commands ?? [];
	if (action === 'run' || action === 'restart')
		await attempt('Could not run «{name}».', () => runCommand(task, { commandId: row.command.id }));
	if (action === 'stop' && row.run)
		await attempt('Could not stop «{name}».', () => stopCommand(task, row.run!));
	if (action === 'show' && row.run)
		showTaskCommand(task, row.run.id, row.command.id, row.run.title);
	if (action === 'open' && row.run)
		await attempt('Could not open localhost:{port}.', () => openCommandPort(task, row.run!), {
			port: row.run.run?.port ?? 0,
		});
	if (action === 'edit') edit();
	if (action === 'duplicate' && commands.length < projectCommandLimit) {
		const index = commands.indexOf(row.command);
		await attempt('Could not duplicate «{name}».', () =>
			saveCommands(project.id, [
				...commands.slice(0, index + 1),
				{ ...row.command, id: crypto.randomUUID(), name: `${row.command.name} 2`.slice(0, 80) },
				...commands.slice(index + 1),
			])
		);
	}
	if (action === 'delete')
		await attempt('Could not delete «{name}».', () =>
			saveCommands(
				project.id,
				commands.filter((command) => command.id !== row.command.id)
			)
		);
}

/** spec/search-menus-and-commands#project-commands: the current command of this task, its Run / Restart / Stop, and a menu of every command of the project. */
export function CommandsButton({
	task,
	locale,
	size,
}: {
	task: AgentTask;
	locale: Locale;
	size: 'full' | 'compact' | 'minimal';
}) {
	const compact = size !== 'full';
	const shortcut = useCommandShortcut();
	const project = useWorkspace((state) =>
		state.workspace?.projects.find((item) => item.id === task.projectId)
	);
	const [{ commandCurrent }, setTask] = useTaskState(task);
	const { runs } = useCommandRuns(task),
		rows = commandRows(project, runs),
		[open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null);
	const current =
		rows.find((row) => row.command.id === commandCurrent) ??
		rows.find((row) => alive(row.state)) ??
		rows[0];
	const others = rows.filter((row) => row !== current && alive(row.state)).length;
	const act = (key: MessageKey, command: ProjectCommand, work: () => Promise<unknown>) => {
		void work().catch(() => commandFailed(locale, key, { name: command.name }));
	};
	const edit = (command: ProjectCommand | null) => {
		setOpen(false);
		useCommandEditor.getState().open({ projectId: task.projectId, command, task });
	};
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (document.querySelector('dialog[open]')) return;
				if (action === 'command-run' && current)
					act('Could not run «{name}».', current.command, () =>
						runCommand(task, { commandId: current.command.id })
					);
				if (action === 'command-stop' && current?.run && alive(current.state))
					act('Could not stop «{name}».', current.command, () => stopCommand(task, current.run!));
			}),
		[task.id, task.projectId, current?.command.id, current?.run?.id, current?.state]
	);
	if (!project) return null;
	const name = current?.command.name ?? t(locale, 'Commands');
	return (
		<>
			<SegmentGroup className={s.control} data-quick-commands data-fit={size}>
				<SegmentPart
					ref={anchor}
					wide
					className={s.current}
					aria-haspopup="dialog"
					aria-expanded={open}
					aria-label={`${t(locale, 'Project commands')}${current ? ` · ${name} · ${t(locale, runStateLabel[current.state ?? 'idle'])}` : ''}`}
					title={`${compact ? `${name} · ` : ''}${withShortcut(t(locale, 'Project commands'), shortcut('commands'))}`}
					onClick={() => setOpen((value) => !value)}>
					{current ? <RunGlyph state={current.state} /> : <Glyph name="command-play" size={10} />}
					{(!compact || (!current && size === 'compact')) && <span className={s.name}>{name}</span>}
					{others > 0 && <span className={s.more}>+{others}</span>}
					<Glyph name="chevron-down" size={9} />
				</SegmentPart>
				{current &&
					size !== 'minimal' &&
					(alive(current.state)
						? [
								<SegmentPart
									key="restart"
									aria-label={t(locale, 'Restart {name}').replace('{name}', current.command.name)}
									title={withShortcut(t(locale, 'Restart'), shortcut('command-run'))}
									onClick={() =>
										act('Could not run «{name}».', current.command, () =>
											runCommand(task, { commandId: current.command.id })
										)
									}>
									<Glyph name="refresh" size={13} />
								</SegmentPart>,
								<SegmentPart
									key="stop"
									aria-label={t(locale, 'Stop {name}').replace('{name}', current.command.name)}
									title={withShortcut(t(locale, 'Stop'), shortcut('command-stop'))}
									onClick={() =>
										act('Could not stop «{name}».', current.command, () =>
											stopCommand(task, current.run!)
										)
									}>
									<Glyph name="command-stop" size={11} />
								</SegmentPart>,
							]
						: [
								<SegmentPart
									key="run"
									data-run
									aria-label={t(locale, 'Run {name}').replace('{name}', current.command.name)}
									title={withShortcut(t(locale, 'Run'), shortcut('command-run'))}
									onClick={() =>
										act('Could not run «{name}».', current.command, () =>
											runCommand(task, { commandId: current.command.id })
										)
									}>
									<Glyph name="command-play" size={12} />
								</SegmentPart>,
							])}
			</SegmentGroup>
			<CommandsMenu
				open={open}
				close={() => setOpen(false)}
				anchor={anchor}
				task={task}
				project={project}
				rows={rows}
				locale={locale}
				pick={(id) => setTask({ commandCurrent: id })}
				edit={edit}
			/>
		</>
	);
}
function CommandsMenu({
	open,
	close,
	anchor,
	task,
	project,
	rows,
	locale,
	pick,
	edit,
}: {
	open: boolean;
	close(): void;
	anchor: React.RefObject<HTMLButtonElement | null>;
	task: AgentTask;
	project: Project;
	rows: CommandRow[];
	locale: Locale;
	pick(id: string): void;
	edit(command: ProjectCommand | null): void;
}) {
	const opener = useCommandShortcut()('commands');
	const act = (
		key: MessageKey,
		values: { name?: string; port?: number },
		work: () => Promise<unknown>
	) => {
		void work().catch(() => commandFailed(locale, key, values));
	};
	const show = (row: CommandRow) => {
		pick(row.command.id);
		close();
		if (row.run) showTaskCommand(task, row.run.id, row.command.id, row.run.title);
		else
			act('Could not run «{name}».', { name: row.command.name }, () =>
				runCommand(task, { commandId: row.command.id })
			);
	};
	return (
		<Popover
			open={open}
			onClose={close}
			anchor={anchor}
			width={400}
			className={s.menu}
			label={t(locale, 'Project commands')}
			title={`${t(locale, 'Commands')} · ${project.name}`}
			locale={locale}
			initialFocus={(popover) => popover.querySelector<HTMLElement>('[data-command-row] button')}>
			{rows.length ? (
				<div className={s.rows}>
					{rows.map((row) => (
						<div
							key={row.command.id}
							data-command-row={row.command.id}
							data-state={row.state ?? 'idle'}
							className={s.row}
							onContextMenu={(event) => {
								event.preventDefault();
								void commandMenu(task, project, row, () => edit(row.command), locale);
							}}>
							<RunGlyph state={row.state} />
							<button
								type="button"
								className={s.rowMain}
								title={row.run ? t(locale, 'Show in console') : t(locale, 'Run')}
								onClick={() => show(row)}>
								<span>
									<b>{row.command.name}</b>
									<small>{row.command.repo || project.name}</small>
								</span>
								<code>{row.command.command}</code>
							</button>
							{row.state === 'running' && row.run?.run?.port && (
								<Button
									size="s"
									appearance="primary"
									className={s.port}
									title={t(locale, 'Open in browser')}
									onClick={() =>
										act('Could not open localhost:{port}.', { port: row.run!.run!.port! }, () =>
											openCommandPort(task, row.run!)
										)
									}>
									:{row.run.run.port}
								</Button>
							)}
							{row.state === 'failed' && <span className={s.exit}>exit {row.run?.exitCode}</span>}
							{alive(row.state) ? (
								<IconButton
									className={s.action}
									label={t(locale, 'Stop {name}').replace('{name}', row.command.name)}
									hint={t(locale, 'Stop')}
									onClick={() =>
										act('Could not stop «{name}».', { name: row.command.name }, () =>
											stopCommand(task, row.run!)
										)
									}>
									<Glyph name="command-stop" size={12} />
								</IconButton>
							) : (
								<IconButton
									className={s.action}
									data-run
									label={t(locale, 'Run {name}').replace('{name}', row.command.name)}
									hint={t(locale, 'Run')}
									onClick={() => {
										pick(row.command.id);
										act('Could not run «{name}».', { name: row.command.name }, () =>
											runCommand(task, { commandId: row.command.id }, true)
										);
									}}>
									<Glyph name="command-play" size={12} />
								</IconButton>
							)}
						</div>
					))}
				</div>
			) : (
				<div className={s.empty}>
					<p>{t(locale, 'No commands')}</p>
					<code>pnpm run dev</code>
				</div>
			)}
			<footer>
				{rows.length ? (
					<button type="button" className={s.item} onClick={() => edit(null)}>
						<Glyph name="plus" size={12} />
						<span>{t(locale, 'New command…')}</span>
					</button>
				) : (
					<Button appearance="primary" onClick={() => edit(null)}>
						{t(locale, 'Add command…')}
					</Button>
				)}
				{opener && <span className={s.hint}>{opener}</span>}
			</footer>
		</Popover>
	);
}

/** spec/search-menus-and-commands#project-commands: name, line, repo and a folder inside it; the path under the folder is where the command starts in this task. */
export function CommandEditorHost({ locale }: { locale: Locale }) {
	const request = useCommandEditor((state) => state.request),
		[shown, setShown] = useState(request);
	const present = usePresence(!!request);
	useEffect(() => {
		if (request) setShown(request);
	}, [request]);
	return present && shown ? (
		<CommandEditor
			key={`${shown.projectId}/${shown.command?.id ?? 'new'}/${shown.line ?? ''}/${shown.draft ? JSON.stringify(shown.draft) : ''}`}
			request={shown}
			open={!!request}
			locale={locale}
			close={() => useCommandEditor.getState().close()}
		/>
	) : null;
}
function CommandEditor({
	request,
	open,
	locale,
	close,
}: {
	request: EditorRequest;
	open: boolean;
	locale: Locale;
	close(): void;
}) {
	const project = useWorkspace((state) =>
		state.workspace?.projects.find((item) => item.id === request.projectId)
	);
	const dialog = useRef<HTMLDialogElement>(null),
		first = useRef<HTMLInputElement>(null),
		returnFocus = useRef<Element | null>(document.activeElement);
	const filled = request.command ?? request.draft;
	const [name, setName] = useState(filled?.name ?? ''),
		[line, setLine] = useState(
			request.command?.command ?? request.line ?? request.draft?.command ?? ''
		),
		[repo, setRepo] = useState(filled?.repo ?? ''),
		[folder, setFolder] = useState(filled?.directory ?? ''),
		[agentRuns, setAgentRuns] = useState(request.command?.agentRuns === true);
	// spec/search-menus-and-commands#package-scripts: the scripts of the chosen repo; the name follows a picked script until the person types their own.
	const [scripts, setScripts] = useState<ProjectScripts | null>(null),
		[scriptsOpen, setScriptsOpen] = useState(false),
		[picked, setPicked] = useState<string | null>(request.draft?.name ?? null),
		scriptsButton = useRef<HTMLButtonElement>(null),
		lineId = useId();
	useEffect(() => {
		let active = true;
		void window.brigadir.readProjectScripts(request.projectId).then(
			(value) => {
				if (active) setScripts(value);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [request.projectId]);
	const packages = scripts?.packages.filter((item) => item.repo === repo) ?? [];
	function pickScript(source: PackageScripts, script: PackageScript) {
		setLine(scriptLine(source.manager, script.name));
		setFolder(source.directory);
		if (!name.trim() || name === picked) setName(script.name);
		setPicked(script.name);
		setScriptsOpen(false);
	}
	const [repos, setRepos] = useState<{ path: string; name: string }[]>([]),
		[saving, setSaving] = useState(false),
		[error, setError] = useState('');
	useEffect(() => {
		let active = true;
		void window.brigadir.readScopePanel(request.projectId, null).then(
			(panel) => {
				if (!active || !project) return;
				const root = project.path.replace(/\/$/, '');
				setRepos(
					panel.scopes
						.map((scope) => ({
							path:
								scope.path === root
									? ''
									: scope.path.startsWith(`${root}/`)
										? scope.path.slice(root.length + 1)
										: '',
							name: scope.path === root ? project.name : scope.name,
						}))
						.filter(
							(item, index, all) => all.findIndex((other) => other.path === item.path) === index
						)
				);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [request.projectId, project?.path]);
	useLayoutEffect(() => {
		const node = dialog.current!;
		if (open) {
			node.showModal();
			first.current?.focus();
		} else {
			node.close();
			requestAnimationFrame(() => {
				const target = returnFocus.current;
				if (
					!document.querySelector('dialog[open]') &&
					target instanceof HTMLElement &&
					target.isConnected
				)
					target.focus({ preventScroll: true });
			});
		}
		return () => node.close();
	}, [open]);
	const directory = commandFolder(folder),
		valid =
			isCommandName(name) &&
			isCommandLine(line) &&
			!directory
				.split('/')
				.some((part) => part === '..' || part === '.git' || part === '.brigadir');
	const place = commandDirectory({ repo, directory }),
		tree = request.task?.launch?.isolation === 'worktree' ? 'worktree' : (project?.name ?? '');
	// spec/notifications-slack-notes-and-schedules#message-classes: the editor is modal, so a failure stays a line in it and names the action.
	async function submit(event: FormEvent | null, run: boolean) {
		event?.preventDefault();
		if (!project || !valid || saving) return;
		setSaving(true);
		setError('');
		const command: ProjectCommand = {
			id: request.command?.id ?? crypto.randomUUID(),
			name: name.trim(),
			command: line,
			repo,
			directory,
			...(agentRuns ? { agentRuns } : {}),
		};
		const commands = project.commands ?? [];
		try {
			await saveCommands(
				project.id,
				request.command
					? commands.map((item) => (item.id === command.id ? command : item))
					: [...commands, command]
			);
		} catch {
			setError(t(locale, 'Could not save the command.'));
			setSaving(false);
			return;
		}
		try {
			if (run && request.task) await runCommand(request.task, { commandId: command.id });
			close();
		} catch {
			setError(t(locale, 'Could not run «{name}».').replace('{name}', command.name));
		} finally {
			setSaving(false);
		}
	}
	async function remove() {
		if (!project || !request.command || saving) return;
		setSaving(true);
		setError('');
		try {
			await saveCommands(
				project.id,
				(project.commands ?? []).filter((item) => item.id !== request.command!.id)
			);
			close();
		} catch {
			setError(t(locale, 'Could not delete the command.'));
		} finally {
			setSaving(false);
		}
	}
	const title = t(locale, request.command ? 'Edit command' : 'New command');
	return (
		<dialog
			ref={dialog}
			className={s.editor}
			aria-label={title}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}>
			<header>
				<h2>{title}</h2>
				<span>{project?.name}</span>
				<PopupClose locale={locale} close={close} />
			</header>
			<form onSubmit={(event) => void submit(event, false)}>
				<label>
					<span>{t(locale, 'Name')}</span>
					<TextInput
						size="l"
						ref={first}
						value={name}
						maxLength={80}
						placeholder={t(locale, 'Development server')}
						disabled={saving}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<div className={s.field}>
					<div className={s.fieldHead} data-size="s">
						<label htmlFor={lineId}>{t(locale, 'Command')}</label>
						{packages.length > 0 && (
							<Button
								ref={scriptsButton}
								variant="ghost"
								aria-haspopup="dialog"
								aria-expanded={scriptsOpen}
								disabled={saving}
								onClick={() => setScriptsOpen((value) => !value)}>
								{t(locale, 'Scripts')}
								<Glyph name="chevron-down" size={9} />
							</Button>
						)}
					</div>
					<TextArea
						id={lineId}
						size="l"
						className={s.line}
						rows={2}
						value={line}
						maxLength={8000}
						placeholder="pnpm run dev"
						spellCheck={false}
						disabled={saving}
						onChange={(event) => setLine(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void submit(null, true);
							}
						}}
					/>
				</div>
				<ScriptsMenu
					open={scriptsOpen && packages.length > 0}
					close={() => setScriptsOpen(false)}
					anchor={scriptsButton}
					packages={packages}
					locale={locale}
					pick={pickScript}
				/>
				<fieldset>
					<legend>{t(locale, 'Repo')}</legend>
					<div className={s.repos}>
						{(repos.length ? repos : [{ path: '', name: project?.name ?? '' }]).map((item) => (
							<Button
								key={item.path}
								aria-pressed={repo === item.path}
								disabled={saving}
								onClick={() => setRepo(item.path)}>
								<code>{item.path || item.name}</code>
							</Button>
						))}
					</div>
				</fieldset>
				<label>
					<span>
						{t(locale, 'Folder inside the repo')} <small>{t(locale, 'optional')}</small>
					</span>
					<TextInput
						size="l"
						className={s.mono}
						value={folder}
						maxLength={4096}
						placeholder="."
						spellCheck={false}
						disabled={saving}
						onChange={(event) => setFolder(event.target.value)}
					/>
				</label>
				<p className={s.place}>
					<span>{t(locale, 'In this task')}</span>
					<code>{[tree, place].filter(Boolean).join('/') || '.'}</code>
				</p>
				{/* spec/search-menus-and-commands#agent-command-tools: agents of every task run and stop this command without a permission card. */}
				<label className={s.agentRuns}>
					<Choice
						type="checkbox"
						label={t(locale, 'Agents can run it without confirmation')}
						checked={agentRuns}
						disabled={saving}
						onChange={(event) => setAgentRuns(event.target.checked)}
					/>
					<span>{t(locale, 'Agents can run it without confirmation')}</span>
				</label>
				{error && (
					<p role="alert" className={s.error}>
						{error}
					</p>
				)}
				<footer>
					{request.command && (
						<Button appearance="danger" disabled={saving} onClick={() => void remove()}>
							{t(locale, 'Delete')}
						</Button>
					)}
					<span />
					<Button type="button" disabled={saving} onClick={close}>
						{t(locale, 'Cancel')}
					</Button>
					<Button type="submit" disabled={!valid || saving}>
						{t(locale, 'Save')}
					</Button>
					{request.task && (
						<Button
							appearance="primary"
							type="button"
							disabled={!valid || saving}
							onClick={() => void submit(null, true)}>
							<Glyph name="command-play" size={9} />
							{t(locale, 'Save and run')}
						</Button>
					)}
				</footer>
			</form>
		</dialog>
	);
}
/** spec/search-menus-and-commands#package-scripts: the scripts of the repo's `package.json` files, a group per file when there are several. */
function ScriptsMenu({
	open,
	close,
	anchor,
	packages,
	locale,
	pick,
}: {
	open: boolean;
	close(): void;
	anchor: React.RefObject<HTMLButtonElement | null>;
	packages: PackageScripts[];
	locale: Locale;
	pick(source: PackageScripts, script: PackageScript): void;
}) {
	return (
		<Popover
			open={open}
			onClose={close}
			anchor={anchor}
			align="end"
			width={400}
			className={`${s.menu} ${s.scripts}`}
			label={`${t(locale, 'Scripts')} · package.json`}
			title={`${t(locale, 'Scripts')} · package.json`}
			locale={locale}
			initialFocus={(popover) => popover.querySelector<HTMLElement>('[data-script-row] button')}>
			<div className={s.rows}>
				{packages.map((source) => (
					<section key={source.directory} data-script-file={source.directory}>
						{packages.length > 1 && (
							<p className={s.group}>
								{[source.directory, 'package.json'].filter(Boolean).join('/')}
							</p>
						)}
						{source.scripts.map((script) => (
							<div key={script.name} data-script-row={script.name} className={s.row}>
								<button
									type="button"
									className={s.rowMain}
									title={scriptLine(source.manager, script.name)}
									onClick={() => pick(source, script)}>
									<span>
										<b>{script.name}</b>
									</span>
									<code>{script.body}</code>
								</button>
							</div>
						))}
					</section>
				))}
			</div>
		</Popover>
	);
}
