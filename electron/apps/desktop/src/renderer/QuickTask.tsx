import { useEffect, useRef, useState } from 'react';
import {
	formatAccelerator,
	t,
	type Locale,
	type MainTreeBranch,
	type TaskLaunch,
	type AgentTask,
} from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { PopupClose } from './ui/PopupClose';
import { TextInput } from './ui/Input';
import styles from './QuickTask.module.css';
import { primaryKey } from './ui/primary-key';
import { useCommandShortcut } from './ui/use-command-shortcut';

type Glyphs = Parameters<typeof Glyph>[0]['name'];
/** The context the sheet opened with: a chip in the prompt field and the text that goes to the agent in English (rule 12). */
export type QuickContext = { icon: Glyphs; label: string; text: string };
/** spec/tasks#quick-tasks: what opened the sheet — a selection in the editor, PR comments, the field under the main tree, ⌘N. */
export type QuickTaskRequest = {
	projectId: string;
	scopeId: string | null;
	title?: string;
	prompt?: string;
	context?: QuickContext[];
	/** The PR branch: when it is not the current one, the main tree switches to it if clean. */ branch?: string;
};
/**
 * «New quick task»: a name and a prompt with context, the agent from Settings, «<branch> · No isolation».
 * After the start the person stays in the main tree; the task is a card in the sidebar.
 */
export function QuickTask({
	request,
	locale,
	close,
	more,
	started,
}: {
	request: QuickTaskRequest;
	locale: Locale;
	close(): void;
	more(request: QuickTaskRequest): void;
	started(task: AgentTask): void;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		prompt = useRef<HTMLTextAreaElement>(null),
		previous = useRef<Element | null>(null);
	const [title, setTitle] = useState(request.title ?? ''),
		[text, setText] = useState(request.prompt ?? ''),
		[context, setContext] = useState(request.context ?? []);
	const [agent, setAgent] = useState<{
			provider: 'claude' | 'codex';
			transport: 'gui' | 'terminal';
		} | null>(null),
		[launch, setLaunch] = useState<TaskLaunch | null>(null),
		[branch, setBranch] = useState<MainTreeBranch | null>(null),
		[current, setCurrent] = useState<string | null>(null);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	useEffect(() => {
		previous.current = document.activeElement;
		dialog.current!.showModal();
		prompt.current?.focus();
		let active = true;
		void Promise.all([
			window.brigadir.readSettings(),
			window.brigadir.readLaunchSettings(request.projectId),
			window.brigadir.readScopePanel(request.projectId, null),
		])
			.then(([{ settings }, defaults, scopes]) => {
				if (!active) return;
				setAgent({ provider: settings.agents.provider, transport: settings.agents.transport });
				setLaunch({ ...defaults, isolation: 'in-place', branch: '' } as TaskLaunch);
				setCurrent(
					scopes.scopes.find((scope) => scope.id === request.scopeId)?.branch ??
						scopes.scopes[0]?.branch ??
						null
				);
			})
			.catch(() => {
				if (active) setError(t(locale, 'The settings could not be read.'));
			});
		if (request.branch && request.scopeId)
			void window.brigadir
				.readMainTreeBranch(request.projectId, request.scopeId, request.branch)
				.then(
					(value) => {
						if (active) setBranch(value);
					},
					() => {}
				);
		return () => {
			active = false;
			dialog.current?.close();
			const node = previous.current;
			if (node instanceof HTMLElement && node.isConnected) node.focus({ preventScroll: true });
		};
	}, []);
	// The PR branch is not the current one: a clean tree switches, a dirty one offers a worktree on the PR branch.
	const switching = Boolean(branch && branch.current !== branch.branch),
		worktree = switching && Boolean(branch?.dirty);
	const shownBranch = switching ? branch!.branch : (current ?? '');
	async function start() {
		if (busy || !agent || !launch || (!text.trim() && !context.length)) return;
		setBusy(true);
		setError('');
		try {
			if (switching && !worktree)
				await window.brigadir.switchMainTreeBranch(
					request.projectId,
					request.scopeId!,
					branch!.branch
				);
			const body = [text.trim(), ...context.map((item) => item.text)].filter(Boolean).join('\n\n');
			const options: TaskLaunch = worktree
				? { ...launch, isolation: 'worktree', baseRef: `origin/${branch!.branch}`, branch: '' }
				: launch;
			const task = await window.brigadir.createTask(
				request.projectId,
				body,
				agent.provider,
				agent.transport,
				false,
				options,
				undefined,
				title.trim() ? { name: title.trim() } : undefined
			);
			await window.brigadir.startSession(task);
			started(task);
			close();
		} catch (failure) {
			setError(
				failure instanceof Error && failure.message
					? failure.message
					: t(locale, 'The request failed.')
			);
			setBusy(false);
		}
	}
	return (
		<dialog
			ref={dialog}
			className={styles.sheet}
			aria-labelledby="quick-task-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) close();
			}}
			onKeyDown={(event) => {
				if (
					event.key === 'Enter' &&
					(primaryKey(event) || event.target instanceof HTMLInputElement)
				) {
					event.preventDefault();
					void start();
				}
			}}>
			<header className={styles.header}>
				<Glyph name="generate" size={13} />
				<h2 id="quick-task-title">{t(locale, 'New quick task')}</h2>
				<PopupClose
					locale={locale}
					close={() => {
						if (!busy) close();
					}}
				/>
			</header>
			<TextInput
				size="l"
				className={styles.title}
				aria-label={t(locale, 'Task name')}
				placeholder={t(locale, 'Task name')}
				value={title}
				disabled={busy}
				onChange={(event) => setTitle(event.target.value)}
			/>
			<div className={styles.prompt}>
				<textarea
					ref={prompt}
					aria-label={t(locale, 'Prompt')}
					placeholder={t(locale, 'What should the agent do?')}
					value={text}
					disabled={busy}
					onChange={(event) => setText(event.target.value)}
					rows={2}
				/>
				{context.length > 0 && (
					<span className={styles.chips}>
						{context.map((item, index) => (
							<span key={index} className={styles.chip} title={item.text}>
								<Glyph name={item.icon} size={10} />
								{item.label}
								<button
									type="button"
									className={styles.remove}
									aria-label={`${t(locale, 'Remove')} · ${item.label}`}
									disabled={busy}
									onClick={() => setContext((value) => value.filter((_, at) => at !== index))}>
									<Glyph name="xmark" size={8} />
								</button>
							</span>
						))}
					</span>
				)}
			</div>
			<div className={styles.facts}>
				{agent && (
					<span className={styles.fact} data-provider={agent.provider}>
						<Glyph name={agent.provider === 'claude' ? 'claude' : 'openai'} size={11} />
						{t(locale, agent.provider === 'claude' ? 'Claude' : 'Codex')}
					</span>
				)}
				{shownBranch && (
					<span
						className={styles.fact}
						title={t(
							locale,
							worktree
								? 'The task gets its own worktree on the PR branch'
								: 'A quick task writes straight into the project working tree'
						)}>
						<Glyph name={worktree ? 'sidebar-worktree' : 'sidebar-branch'} size={11} />
						{shownBranch} · {t(locale, worktree ? 'Worktree' : 'No isolation')}
					</span>
				)}
			</div>
			{switching && (
				<p className={styles.note} role="status">
					<Glyph name="review-warning" size={13} />
					<span>
						{t(
							locale,
							worktree
								? 'The main tree has uncommitted changes on {current}, so the task gets a worktree on {branch}.'
								: 'The main tree switches from {current} to {branch}: the working tree is clean. The branch stays after the task.'
						)
							.split(/(\{current\}|\{branch\})/)
							.map((part, index) =>
								part === '{current}' ? (
									<code key={index}>{branch!.current ?? '—'}</code>
								) : part === '{branch}' ? (
									<code key={index}>{branch!.branch}</code>
								) : (
									part
								)
							)}
					</span>
				</p>
			)}
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}
			<footer className={styles.footer} data-size="l">
				<Button
					variant="ghost"
					disabled={busy}
					onClick={() => more({ ...request, title, prompt: text, context })}>
					{t(locale, 'More options…')}
				</Button>
				<span className={styles.space} />
				<span className={styles.enter} aria-hidden="true">
					{formatAccelerator('Enter')}
				</span>
				<Button
					appearance="primary"
					disabled={busy || !agent || !launch || (!text.trim() && !context.length)}
					onClick={() => {
						void start();
					}}>
					{t(locale, busy ? 'Working…' : 'Start')}
				</Button>
			</footer>
		</dialog>
	);
}
/** The field under the main tree: «New quick task in <branch>…» opens the sheet (spec/tasks#quick-tasks). */
export function QuickTaskBar({
	locale,
	branch,
	open,
}: {
	locale: Locale;
	branch: string | null;
	open(): void;
}) {
	const newTaskKey = useCommandShortcut()('new-task');
	return (
		<button
			type="button"
			className={styles.bar}
			data-quick-task-bar
			data-toast-avoid
			onClick={open}>
			<Glyph name="generate" size={13} />
			<span className={styles.placeholder}>
				{t(locale, 'New quick task in {branch}…').replace('{branch}', branch ?? 'main')}
			</span>
			{branch && (
				<span className={styles.barChip}>
					<Glyph name="sidebar-branch" size={10} />
					{branch} · {t(locale, 'No isolation')}
				</span>
			)}
			{newTaskKey && <kbd className={styles.kbd}>{newTaskKey}</kbd>}
		</button>
	);
}
