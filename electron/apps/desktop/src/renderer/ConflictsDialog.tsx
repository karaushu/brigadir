import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	conflictCount,
	conflictProgress,
	conflictRowState,
	fileCount,
	t,
	type AgentTask,
	type ConflictFile,
	type Locale,
	type MergeState,
	type MessageKey,
} from '@brigadir/core';
import { mergeEnded, useTaskState } from './task-state';
import { useForge } from './Forge';
import { gitErrorText } from './git-errors';
import { MergeView } from './MergeView';
import { ModalDialog } from './ui/ModalDialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Banner } from './ui/Banner';
import { FileListBox } from './ui/FileListBox';
import { BranchName } from './ui/BranchName';
import { Button, Choice, IconButton } from './ui/Controls';
import { GenerateButton } from './ui/GenerateButton';
import { FileIcon } from './ui/FileIcon';
import { Glyph } from './ui/Glyph';
import { notify, showToast, toastError } from './ui/Toast';
import styles from './ConflictsDialog.module.css';

/**
 * spec/appearance#evolution-redesign, spec/git#conflicts: the Conflicts dialog of one repo — every conflicted file with its state and actions
 * (`Accept yours` / `Accept theirs` / `Merge…` / ✦, `Keep` / `Delete` for a file deleted on one side), bulk accept of the
 * selected, the agent on the click of ✦ only, `Abort merge…` and `Continue`, which commits the merge (or continues the
 * rebase) once every file is resolved and every agent result accepted. `Merge…` opens the three columns over it.
 */
export const shortName = (path: string) => path.split('/').at(-1) || path;
export const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');
export const agentName = (task: AgentTask) => (task.provider === 'codex' ? 'Codex' : 'Claude');
/** A sentence of the catalogue with React parts in its `{placeholders}` (a branch that squeezes in the middle). */
export function fill(text: string, parts: Record<string, ReactNode>): ReactNode[] {
	return text
		.split(/(\{[a-z]+\})/)
		.map((piece, index) =>
			/^\{[a-z]+\}$/.test(piece) && piece.slice(1, -1) in parts ? (
				<span key={index}>{parts[piece.slice(1, -1)]}</span>
			) : (
				piece
			)
		);
}
/** `business · Merging stage into brigadir/…-method` / `· Rebasing <branch> onto <base> · commit 2 of 5`. */
export function MergeWhere({
	locale,
	repo,
	state,
}: {
	locale: Locale;
	repo: string;
	state: MergeState;
}) {
	return (
		<span className={styles.where}>
			<span>{repo}</span>
			<span>·</span>
			{state.kind === 'rebase' ? (
				<>
					{fill(t(locale, 'Rebasing {branch} onto {base}'), {
						branch: <BranchName name={state.into} />,
						base: state.from,
					})}
					{state.step && (
						<span>
							·{' '}
							{t(locale, 'commit {n} of {m}')
								.replace('{n}', String(state.step.current))
								.replace('{m}', String(state.step.total))}
						</span>
					)}
				</>
			) : (
				fill(t(locale, 'Merging {from} into {into}'), {
					from: state.from,
					into: <BranchName name={state.into} />,
				})
			)}
		</span>
	);
}
export function failureText(locale: Locale, key: MessageKey, cause: unknown, file?: string) {
	const action = file ? t(locale, key).replace('{file}', file) : t(locale, key),
		reason = gitErrorText(locale, cause);
	return reason === t(locale, 'The request failed.') ? action : `${action} ${reason}`;
}
/** The repo's name as the panel shows it: discovery's «.» is the project. */
export function useRepoName(task: AgentTask, scopeId: string, projectName: string) {
	const [name, setName] = useState('');
	useEffect(() => {
		let live = true;
		void window.brigadir.readHistoryScopes(task).then(
			(scopes) => {
				const scope = scopes.find((item) => item.id === scopeId);
				if (live && scope) setName(scope.name === '.' ? projectName : scope.name);
			},
			() => {}
		);
		return () => {
			live = false;
		};
	}, [task.id, task.projectId, scopeId]);
	return name;
}

export function ConflictsDialog({
	task,
	locale,
	agentBusy,
	projectName,
	refreshKey,
}: {
	task: AgentTask;
	locale: Locale;
	agentBusy: boolean;
	projectName: string;
	/** The task's checkpoint and changed files: a merge resolved or committed elsewhere shows here too. */ refreshKey: string;
}) {
	const [{ conflictsDialog }, setTask] = useTaskState(task);
	const { scopeId, file: openFile, abort: abortFirst } = conflictsDialog!;
	const forge = useForge(),
		repo = useRepoName(task, scopeId, projectName),
		agent = agentName(task);
	const [state, setState] = useState<MergeState | null>(null),
		[failed, setFailed] = useState(false),
		[working, setWorking] = useState<Set<string>>(new Set()),
		[selected, setSelected] = useState<Set<string>>(new Set()),
		[abort, setAbort] = useState(Boolean(abortFirst)),
		[continuing, setContinuing] = useState(false);
	const request = useRef(0),
		mounted = useRef(true),
		seen = useRef(false);
	const close = () => setTask({ conflictsDialog: null });
	async function load() {
		const id = ++request.current;
		try {
			const next = await window.brigadir.readMergeState(task, scopeId);
			if (!mounted.current || id !== request.current) return;
			setFailed(false);
			// Finished or aborted elsewhere (the terminal, another window): nothing is left to resolve here.
			if (!next) {
				if (seen.current) close();
				else setState(null);
				return;
			}
			seen.current = true;
			setState(next);
			setSelected(
				(old) =>
					new Set(
						[...old].filter((path) =>
							next.conflicts.some((file) => file.path === path && !file.resolved)
						)
					)
			);
		} catch {
			if (mounted.current && id === request.current) setFailed(true);
		}
	}
	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [scopeId, agentBusy, refreshKey]);
	// The select-all box is half-checked while only some rows are selected.
	useEffect(() => {
		const box = document.querySelector<HTMLInputElement>(
			'[data-conflicts-dialog] [data-select-all]'
		);
		const all =
			state?.conflicts.filter((file) => {
				const row = conflictRowState(file);
				return row === 'open' || row === 'deleted' || row === 'failed';
			}).length ?? 0;
		if (box) box.indeterminate = selected.size > 0 && selected.size < all;
	});
	// The agent's turn ends without a checkpoint of ours: read again while it runs.
	useEffect(() => {
		if (!state?.agentRunning) return;
		const timer = setInterval(() => void load(), 1500);
		return () => clearInterval(timer);
	}, [state?.agentRunning]);

	async function act(
		paths: string[],
		run: () => Promise<MergeState | null | void>,
		failure: MessageKey,
		file?: string
	) {
		setWorking((old) => new Set([...old, ...paths]));
		try {
			const next = await run();
			if (next !== undefined && mounted.current) {
				if (next) setState(next);
				else void load();
			}
		} catch (cause) {
			toastError(failureText(locale, failure, cause, file && shortName(file)), {
				bold: file && shortName(file),
			});
		} finally {
			if (mounted.current)
				setWorking((old) => new Set([...old].filter((path) => !paths.includes(path))));
		}
	}
	const take = (path: string, side: 'ours' | 'theirs') =>
		act(
			[path],
			() => window.brigadir.resolveConflict(task, scopeId, path, side),
			'Could not resolve the conflict in {file}.',
			path
		);
	const accept = (path: string) =>
		act(
			[path],
			() => window.brigadir.markConflictResolved(task, scopeId, path),
			'Could not mark {file} resolved.',
			path
		);
	const reopen = (path: string) =>
		act(
			[path],
			() => window.brigadir.reopenConflict(task, scopeId, path),
			'Could not bring the conflict in {file} back.',
			path
		);
	const askAgent = (paths: string[] | null) =>
		act(
			paths ?? [],
			() =>
				window.brigadir
					.askAgentToResolve(task, scopeId, paths)
					.then(() => window.brigadir.readMergeState(task, scopeId)),
			paths?.length === 1
				? 'Could not resolve {file} with the agent.'
				: 'Could not hand the conflicts to the agent.',
			paths?.length === 1 ? paths[0] : undefined
		);
	async function bulk(side: 'ours' | 'theirs') {
		const paths = [...selected];
		setSelected(new Set());
		for (const path of paths) await take(path, side);
	}
	async function finish() {
		if (!state) return;
		setContinuing(true);
		try {
			const outcome = await window.brigadir.finishMerge(task, scopeId);
			window.dispatchEvent(new Event(mergeEnded));
			if (outcome.status === 'conflicts') {
				notify('info', t(locale, 'The next commit stopped with conflicts.'));
				seen.current = true;
				void load();
				return;
			}
			close();
			const text =
				state.kind === 'rebase'
					? t(locale, 'Rebased {branch} onto {base}.')
							.replace('{branch}', state.into)
							.replace('{base}', state.from)
					: t(locale, 'Merged {from} into {into}.')
							.replace('{from}', state.from)
							.replace('{into}', state.into);
			showToast(
				text,
				forge
					? {
							label: t(locale, 'Push'),
							run: () => {
								void forge.refresh(false, true).then(() => forge.open('push', scopeId));
							},
						}
					: undefined
			);
		} catch (cause) {
			toastError(failureText(locale, 'Could not commit the merge.', cause));
		} finally {
			if (mounted.current) setContinuing(false);
		}
	}

	// A function, not a component: the dialog must not mount again on every render (focus, showModal).
	if (openFile && state)
		return (
			<>
				{conflictsList()}
				<MergeView
					task={task}
					locale={locale}
					scopeId={scopeId}
					path={openFile}
					repo={repo}
					state={state}
					agentBusy={agentBusy}
					onState={(next) => {
						if (next) setState(next);
						else void load();
					}}
					onClose={() => setTask({ conflictsDialog: { scopeId, file: null } })}
				/>
			</>
		);
	return conflictsList();

	function conflictsList() {
		const progress = state ? conflictProgress(state) : null,
			rows = state?.conflicts ?? [],
			open = rows.filter((file) => !file.resolved),
			selectable = (file: ConflictFile) => {
				const row = conflictRowState(file);
				return row === 'open' || row === 'deleted' || row === 'failed';
			},
			choosable = rows.filter(selectable).map((file) => file.path),
			running = state?.agentRunning ?? false,
			agentFailed = rows.filter((file) => conflictRowState(file) === 'failed'),
			text = (file: ConflictFile) => file.places > 0 && !file.deleted && !file.binary;
		const agentTargets = selected.size
			? [...selected].filter((path) => rows.some((file) => file.path === path && text(file)))
			: open.filter(text).map((file) => file.path);
		const where = state ? <MergeWhere locale={locale} repo={repo} state={state} /> : null;
		const rebase = state?.kind === 'rebase';
		return (
			<ModalDialog
				title={t(locale, 'Conflicts')}
				locale={locale}
				close={close}
				width={640}
				top={64}
				data-conflicts-dialog
				note={where}
				headerExtra={
					<GenerateButton
						label={
							selected.size
								? t(locale, 'Resolve {n} with the agent').replace('{n}', String(selected.size))
								: t(locale, 'Resolve with the agent')
						}
						disabled={running || !agentTargets.length}
						onClick={() => void askAgent(selected.size ? agentTargets : null)}
					/>
				}
				footer={
					<>
						<Button disabled={!state || running || continuing} onClick={() => setAbort(true)}>
							{t(locale, rebase ? 'Abort rebase…' : 'Abort merge…')}
						</Button>
						<span className={styles.progress} role="status" data-conflicts-progress>
							{!progress ? null : running ? (
								t(locale, 'Waiting for the agent')
							) : progress.canContinue ? (
								<>
									<Glyph name="tick" size={12} />
									{t(locale, 'All {n} resolved').replace('{n}', String(progress.total))}
								</>
							) : (
								`${t(locale, '{n} of {m} resolved')
									.replace('{n}', String(progress.resolved))
									.replace('{m}', String(progress.total))}${
									progress.review
										? ` · ${t(locale, '{n} to review').replace('{n}', String(progress.review))}`
										: ''
								}`
							)}
						</span>
						<Button
							appearance="primary"
							disabled={!progress?.canContinue || continuing}
							title={
								progress?.canContinue
									? t(locale, rebase ? 'Continue the rebase' : 'Commit the merge')
									: t(locale, 'Resolve every conflict place first.')
							}
							onClick={() => void finish()}>
							{t(locale, 'Continue')}
						</Button>
					</>
				}>
				{running && (
					<Banner
						tone="working"
						title={t(locale, '{agent} is resolving {files}…')
							.replace('{agent}', agent)
							.replace('{files}', fileCount(locale, progress?.running || 1))}
						note={t(
							locale,
							'Each file opens for review in the merge view. You can keep resolving the others.'
						)}
						action={
							<Button
								onClick={() =>
									void act(
										[],
										() => window.brigadir.stopConflictAgent(task, scopeId),
										'Could not stop the agent.'
									)
								}>
								{t(locale, 'Stop')}
							</Button>
						}
					/>
				)}
				{!running && agentFailed.length > 0 && (
					<Banner
						tone="error"
						title={
							agentFailed.length === 1
								? t(locale, 'The agent could not resolve {file}.').replace(
										'{file}',
										shortName(agentFailed[0]!.path)
									)
								: t(locale, 'The agent could not resolve the files.')
						}
						note={
							progress?.review
								? t(locale, 'Ready for review: {n}.').replace('{n}', String(progress.review))
								: undefined
						}
						action={
							<GenerateButton
								label={t(locale, 'Try again')}
								onClick={() => void askAgent(agentFailed.map((file) => file.path))}
							/>
						}
					/>
				)}
				{failed && !state && (
					<p className={styles.empty} role="alert">
						{t(locale, 'Could not read the conflicts.')}{' '}
						<Button onClick={() => void load()}>{t(locale, 'Retry')}</Button>
					</p>
				)}
				{state && (
					<FileListBox role="list" aria-label={t(locale, 'Conflicts')} className={styles.list}>
						<div className={styles.head} data-size="s">
							<Choice
								type="checkbox"
								label={t(locale, 'Select all')}
								checked={choosable.length > 0 && selected.size === choosable.length}
								disabled={!choosable.length || running}
								data-select-all
								onChange={() =>
									setSelected(selected.size === choosable.length ? new Set() : new Set(choosable))
								}
							/>
							{selected.size ? (
								<>
									<b>{t(locale, '{n} selected').replace('{n}', String(selected.size))}</b>
									<span className={styles.grow} />
									<Button onClick={() => void bulk('ours')}>{t(locale, 'Accept yours')}</Button>
									<Button onClick={() => void bulk('theirs')}>{t(locale, 'Accept theirs')}</Button>
								</>
							) : (
								<>
									<b>{fileCount(locale, rows.length)}</b>
									<span>
										{open.length
											? t(locale, '{n} with conflicts').replace('{n}', String(open.length))
											: t(locale, 'all resolved')}
									</span>
									<span className={styles.grow} />
								</>
							)}
						</div>
						{rows.map((file) => (
							<ConflictRow
								key={file.path}
								file={file}
								into={state.into}
								from={state.from}
								locale={locale}
								selected={selected.has(file.path)}
								busy={working.has(file.path) || (running && conflictRowState(file) === 'running')}
								lockAll={continuing}
								onSelect={() => {
									const next = new Set(selected);
									if (next.has(file.path)) next.delete(file.path);
									else next.add(file.path);
									setSelected(next);
								}}
								selectable={selectable(file) && !running}
								take={(side) => void take(file.path, side)}
								accept={() => void accept(file.path)}
								reopen={() => void reopen(file.path)}
								merge={() => setTask({ conflictsDialog: { scopeId, file: file.path } })}
								agent={() => void askAgent([file.path])}
								agentOff={running || !text(file)}
							/>
						))}
					</FileListBox>
				)}
				{abort && state && (
					<ConfirmDialog
						title={t(locale, rebase ? 'Abort the rebase?' : 'Abort the merge?')}
						locale={locale}
						action={t(locale, rebase ? 'Abort rebase' : 'Abort merge')}
						danger
						error={(cause) => failureText(locale, 'Could not abort the merge.', cause)}
						cancel={() => setAbort(false)}
						confirm={async () => {
							await window.brigadir.abortMerge(task, scopeId);
							window.dispatchEvent(new Event(mergeEnded));
							setAbort(false);
							close();
							notify(
								'info',
								t(
									locale,
									rebase
										? 'Rebase aborted. The branch is back to {sha}.'
										: 'Merge aborted. The tree is back to {sha}.'
								).replace('{sha}', state.head)
							);
						}}>
						<p>
							{fill(t(locale, 'The tree goes back to {sha} on {branch}.'), {
								sha: <code>{state.head}</code>,
								branch: state.into,
							})}{' '}
							{progress?.resolved ? (
								<strong>
									{t(locale, 'Resolved files will be lost: {n}.').replace(
										'{n}',
										String(progress.resolved)
									)}
								</strong>
							) : null}{' '}
							{progress?.review ? t(locale, "The agent's result will be lost.") : null}
						</p>
					</ConfirmDialog>
				)}
			</ModalDialog>
		);
	}
}

function ConflictRow({
	file,
	into,
	from,
	locale,
	selected,
	selectable,
	busy,
	lockAll,
	onSelect,
	take,
	accept,
	reopen,
	merge,
	agent,
	agentOff,
}: {
	file: ConflictFile;
	into: string;
	from: string;
	locale: Locale;
	selected: boolean;
	selectable: boolean;
	busy: boolean;
	lockAll: boolean;
	onSelect(): void;
	take(side: 'ours' | 'theirs'): void;
	accept(): void;
	reopen(): void;
	merge(): void;
	agent(): void;
	agentOff: boolean;
}) {
	const row = conflictRowState(file),
		off = busy || lockAll;
	const status: ReactNode =
		row === 'resolved' ? (
			<span className={styles.status} data-tone="done">
				<Glyph name="tick" size={12} />
				{t(
					locale,
					file.resolution === 'theirs'
						? 'Side: theirs'
						: file.resolution === 'merged'
							? 'Resolved: merged'
							: file.resolution === 'kept'
								? 'Resolved: kept'
								: file.resolution === 'deleted'
									? 'Resolved: deleted'
									: file.resolution === 'yours'
										? 'Side: yours'
										: 'Conflict resolved'
				)}
			</span>
		) : row === 'running' ? (
			<span className={styles.status} data-tone="agent">
				<Glyph name="agent-spinner" size={12} />
				{t(locale, 'Resolving…')}
			</span>
		) : row === 'review' ? (
			<span className={styles.status} data-tone="agent">
				<Glyph name="generate" size={12} />
				{t(locale, 'Resolved by the agent ·')}
				<button type="button" className={styles.review} disabled={off} onClick={merge}>
					{t(locale, 'review (conflict)')}
				</button>
			</span>
		) : row === 'failed' ? (
			<span className={styles.status} data-tone="error">
				<Glyph name="toast-error" size={12} />
				{t(locale, 'Agent failed')}
			</span>
		) : (
			<span className={styles.status} data-tone="warning">
				<i className={styles.dot} />
				{file.deleted
					? file.deleted === 'both'
						? t(locale, 'deleted on both sides')
						: t(locale, 'deleted in {branch}').replace(
								'{branch}',
								file.deleted === 'ours' ? into : from
							)
					: file.places > 0
						? conflictCount(locale, file.places)
						: t(locale, 'Conflict')}
			</span>
		);
	return (
		<div
			role="listitem"
			className={styles.row}
			data-conflict-row={file.path}
			data-state={row}
			data-selected={selected || undefined}
			title={file.path}>
			{selectable ? (
				<Choice
					type="checkbox"
					label={`${t(locale, 'Select')} ${file.path}`}
					checked={selected}
					disabled={off}
					onChange={onSelect}
				/>
			) : (
				<span className={styles.noBox} />
			)}
			<FileIcon name={shortName(file.path)} />
			<span className={styles.name}>{shortName(file.path)}</span>
			<span className={styles.dir}>{folderOf(file.path)}</span>
			{status}
			<div className={styles.actions} data-size="s">
				{row === 'resolved' ? (
					<IconButton
						className={styles.back}
						label={t(locale, 'Back to the conflict')}
						disabled={off}
						onClick={reopen}>
						<Glyph name="undo" size={12} />
					</IconButton>
				) : row === 'running' ? null : row === 'review' ? (
					<Button disabled={off} onClick={accept}>
						{t(locale, 'Accept')}
					</Button>
				) : file.deleted ? (
					<>
						{file.deleted !== 'both' && (
							<Button
								disabled={off}
								onClick={() => take(file.deleted === 'ours' ? 'theirs' : 'ours')}>
								{t(locale, 'Keep the file')}
							</Button>
						)}
						<Button
							disabled={off}
							onClick={() => take(file.deleted === 'theirs' ? 'theirs' : 'ours')}>
							{t(locale, 'Delete the file')}
						</Button>
					</>
				) : (
					<>
						<Button disabled={off} onClick={() => take('ours')}>
							{t(locale, 'Accept yours')}
						</Button>
						<Button disabled={off} onClick={() => take('theirs')}>
							{t(locale, 'Accept theirs')}
						</Button>
						<Button
							disabled={off || Boolean(file.binary)}
							title={file.binary ? t(locale, 'The file is not text: accept one side.') : undefined}
							onClick={merge}>
							{t(locale, 'Merge by hand…')}
						</Button>
						<IconButton
							label={t(locale, 'Resolve with the agent')}
							disabled={off || agentOff}
							onClick={agent}>
							<Glyph name="generate" size={12} />
						</IconButton>
					</>
				)}
			</div>
		</div>
	);
}
