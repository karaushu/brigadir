import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { onSessionEvent } from './session-events';
import {
	ageShort,
	commitCount,
	fileCommitCount,
	fileCount,
	historyCommitMatches,
	historyLimitMax,
	historyPageSize,
	historyQuery,
	t,
	type AgentTask,
	type MessageKey,
	type BranchList,
	type CommitFiles,
	type FileDiff,
	type HistoryPage,
	type HistoryScope,
	type Locale,
	type MergeState,
} from '@brigadir/core';
import { Button, IconButton, Popup, Segments } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { mergeEnded, openConflictsDialog, openTaskHistoryFile, useTaskState } from './task-state';
import type { CommitDiffSource } from './commit-diffs';
import { MergeDialog } from './MergeDialog';
import { gitErrorText } from './git-errors';
import { resolveToast, toastError, toastWarning } from './ui/Toast';
import styles from './GitHistory.module.css';
import { ChangeCounts } from './ui/ChangeCounts';
import { BranchName } from './ui/BranchName';
import { SkeletonRows } from './ui/Loading';
/** spec/notifications-slack-notes-and-schedules#message-classes: a failure names its action; a git reason main already maps to a sentence follows it, the raw text never shows. */
function gitFailure(locale: Locale, key: MessageKey, cause: unknown, file?: string) {
	const action = file ? t(locale, key).replace('{file}', file) : t(locale, key),
		reason = gitErrorText(locale, cause);
	return reason === t(locale, 'The request failed.') ? action : `${action} ${reason}`;
}
const fileName = (path: string) => path.split('/').at(-1) || path;

/**
 * The Diff / History switch. Tabs, not radios: the toolbar's «Diff» radio already picks the surface,
 * and two identical radios on screen would confuse both a screen reader user and the tests. It lives
 * in the one changes-panel header for both modes, so the pill slides instead of reappearing.
 */
/** spec/pull-requests-and-ci#pr-panel: Turns is the changes panel's third mode beside History: two slices of the same changes over time. */
export function ChangesViewSwitch({
	locale,
	value,
	onChange,
}: {
	locale: Locale;
	value: 'diff' | 'history' | 'turns';
	onChange(value: 'diff' | 'history' | 'turns'): void;
}) {
	return (
		<Segments
			tablist
			label={t(locale, 'Changes view')}
			value={value}
			onChange={(view) => onChange(view as 'diff' | 'history' | 'turns')}
			options={[
				{ value: 'diff', label: t(locale, 'Diff') },
				{ value: 'history', label: t(locale, 'History') },
				{ value: 'turns', label: t(locale, 'Turns') },
			]}
		/>
	);
}

type Props = {
	task: AgentTask;
	locale: Locale;
	projectName: string;
	agentBusy: boolean;
	refreshKey: string;
	/** spec/pull-requests-and-ci#pr-panel: the header search finds commits by subject, author or SHA. */ query?: string;
	/** The slot for History's actions in the shared changes-panel header. */ actions: HTMLElement | null;
	onOpenDiff(key: string, diff: FileDiff, source: CommitDiffSource): void;
	onOpenFile(scopeId: string, path: string): void;
};

/** spec/git#merge: the changes panel's History mode — one branch of one repo; merge is a separate button. */
export function GitHistory({
	task,
	locale,
	projectName,
	agentBusy,
	refreshKey,
	query = '',
	actions,
	onOpenDiff,
	onOpenFile,
}: Props) {
	/** Discovery names the project root «.»; the person sees the project's name, as in Repos. */
	const repoName = (name: string) => (name === '.' ? projectName : name);
	const [{ historyScope, historyBranch, historyPath, selected }, setTask] = useTaskState(task);
	/** spec/git#history-search: the search goes to git over the whole history; it waits 200 ms of quiet typing, a cleared field is at once. */
	const live = historyQuery(query);
	const [search, setSearch] = useState(live);
	useEffect(() => {
		if (!live) {
			setSearch('');
			return;
		}
		const timer = setTimeout(() => setSearch(live), 200);
		return () => clearTimeout(timer);
	}, [live]);
	/** spec/editor#line-author: pages of 100; another repo, branch, file or search starts from the first page. */
	const [more, setMore] = useState({ search, limit: historyPageSize });
	const limit = more.search === search ? more.limit : historyPageSize;
	useEffect(() => {
		setMore({ search, limit: historyPageSize });
		setPage(null);
	}, [historyScope, historyBranch, historyPath]);
	const [scopes, setScopes] = useState<HistoryScope[] | null>(null);
	const [branches, setBranches] = useState<BranchList | null>(null);
	const [page, setPage] = useState<HistoryPage | null>(null);
	const [open, setOpen] = useState<Record<string, CommitFiles | 'loading'>>({});
	const [merge, setMerge] = useState<MergeState | null>(null);
	const [dialog, setDialog] = useState(false);
	/** A failed background read, shown once per failure streak (spec/notifications-slack-notes-and-schedules#message-classes). */
	const [readFailure, setReadFailure] = useState<string | null>(null);
	const request = useRef(0),
		scopesFailed = useRef(false);
	const scope = scopes?.find((item) => item.id === historyScope) ?? null;

	useEffect(() => {
		let live = true;
		void window.brigadir.readHistoryScopes(task).then(
			(list) => {
				if (!live) return;
				if (scopesFailed.current) resolveToast(t(locale, 'Could not read the Git history.'));
				scopesFailed.current = false;
				setScopes(list);
				if (!list.some((item) => item.id === historyScope && item.available)) {
					const first =
						list.find((item) => item.available && item.selected) ??
						list.find((item) => item.available);
					setTask({ historyScope: first?.id ?? null, historyBranch: null });
				}
			},
			() => {
				if (live && !scopesFailed.current) {
					scopesFailed.current = true;
					toastWarning(t(locale, 'Could not read the Git history.'));
				}
			}
		);
		return () => {
			live = false;
		};
	}, [task.id, task.projectId, refreshKey]);

	const load = useCallback(async () => {
		if (!scope?.available) {
			setBranches(null);
			setPage(null);
			setMerge(null);
			return;
		}
		const id = ++request.current;
		try {
			const [list, state] = await Promise.all([
				window.brigadir.readBranches(task, scope.id),
				window.brigadir.readMergeState(task, scope.id),
			]);
			if (id !== request.current) return;
			setBranches(list);
			setMerge(state);
			const branch = list.branches.some((item) => item.name === historyBranch)
				? historyBranch!
				: (list.current ?? list.branches[0]?.name ?? null);
			if (branch !== historyBranch) setTask({ historyBranch: branch });
			const history = branch
				? await window.brigadir.readHistory(
						task,
						scope.id,
						branch,
						historyPath,
						limit,
						search || null
					)
				: null;
			if (id === request.current) {
				setPage(history);
				setReadFailure(null);
			}
		} catch (cause) {
			if (id === request.current)
				setReadFailure(gitFailure(locale, 'Could not read the Git history.', cause));
		}
	}, [
		task.id,
		task.projectId,
		scope?.id,
		scope?.available,
		historyBranch,
		historyPath,
		limit,
		search,
		locale,
	]);
	useEffect(() => {
		void load();
	}, [load, refreshKey]);
	// spec/appearance#evolution-redesign: the Conflicts dialog committed or aborted a merge — the tree may be the same, the branch is not.
	useEffect(() => {
		const again = () => void load();
		window.addEventListener(mergeEnded, again);
		return () => window.removeEventListener(mergeEnded, again);
	}, [load]);
	const reload = useRef(load);
	reload.current = load;
	useEffect(() => {
		// spec/notifications-slack-notes-and-schedules#message-classes class B: with nothing to show, the failure stands in place of the list (below); a toast only over a stale page.
		if (readFailure && page)
			toastWarning(readFailure, {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void reload.current();
					},
				},
			});
	}, [readFailure]);
	// The person saved a file in the editor or the agent finished a turn — markers may have dropped. A new checkpoint already
	// arrives through `refreshKey`, so it does not load the history twice; `scopes.changed` without a new tree does not.
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id !== task.id || key.projectId !== task.projectId) return;
			if (record && !['file.saved', 'scopes.changed', 'turn.completed'].includes(record.event.kind))
				return;
			clearTimeout(timer);
			timer = setTimeout(() => {
				void load();
			}, 120);
		});
		return () => {
			stop();
			clearTimeout(timer);
		};
	}, [load, task.id, task.projectId]);

	async function toggle(sha: string) {
		if (open[sha]) {
			setOpen(({ [sha]: _, ...rest }) => rest);
			return;
		}
		if (!scope) return;
		setOpen((state) => ({ ...state, [sha]: 'loading' }));
		try {
			const files = await window.brigadir.readHistoryCommit(task, scope.id, sha);
			setOpen((state) => ({ ...state, [sha]: files }));
		} catch (cause) {
			setOpen(({ [sha]: _, ...rest }) => rest);
			toastError(gitFailure(locale, 'Could not open the commit.', cause), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void toggle(sha);
					},
				},
			});
		}
	}
	function openHistoryFile(scopeId: string, sha: string, path: string) {
		void openTaskHistoryFile(task, scopeId, sha, path).catch((cause) =>
			toastError(gitFailure(locale, 'Could not open {file}.', cause, fileName(path)), {
				bold: fileName(path),
				action: { label: t(locale, 'Retry'), run: () => openHistoryFile(scopeId, sha, path) },
			})
		);
	}
	async function openFile(sha: string, fileId: string, path: string) {
		if (!scope) return;
		try {
			onOpenDiff(
				`history:${sha.slice(0, 7)}:${scope.id}/${path}`,
				await window.brigadir.readHistoryFile(task, scope.id, sha, fileId),
				{ kind: 'history', scopeId: scope.id, sha, id: fileId }
			);
		} catch (cause) {
			toastError(gitFailure(locale, 'Could not open {file}.', cause, fileName(path)), {
				bold: fileName(path),
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void openFile(sha, fileId, path);
					},
				},
			});
		}
	}

	const scopeOptions = (scopes ?? []).map((item) => ({
		value: item.id,
		label: repoName(item.name),
		disabled: !item.available,
		...(item.available
			? {}
			: {
					tail: t(
						locale,
						item.kind === 'external' ? 'Folder unavailable' : 'A selected repo is unavailable'
					),
				}),
	}));
	const local = branches?.branches.filter((item) => !item.remote) ?? [],
		remote = branches?.branches.filter((item) => item.remote) ?? [];
	const branchOptions = [...local, ...remote].map((item) => ({
		value: item.name,
		label: item.name,
		...(item.name === branches?.current
			? { tail: t(locale, 'current') }
			: item.remote
				? { tail: t(locale, 'Remote branches') }
				: {}),
	}));
	/** spec/git#history-search: until git answers the typed text, the rows on screen narrow locally and the count line says it is searching. */
	const answered = page !== null && (page.query ?? '') === live;
	const commits = !page
		? []
		: answered
			? page.commits
			: page.commits.filter((commit) => historyCommitMatches(commit, live));
	const mergeReason = !scope
		? null
		: !scope.canMerge
			? t(locale, 'Add the repo to the task before merging.')
			: agentBusy
				? t(locale, 'Wait for the agent to finish before merging.')
				: merge
					? t(locale, 'A merge is already in progress.')
					: !branches?.current
						? t(locale, 'Merge into the current branch only.')
						: null;

	return (
		<div className={styles.root}>
			{actions &&
				createPortal(
					<Button
						disabled={Boolean(mergeReason)}
						title={mergeReason ?? undefined}
						onClick={() => setDialog(true)}>
						{t(locale, 'Merge…')}
					</Button>,
					actions
				)}
			{/* spec/task-window#panel: the selectors are a row of size S, the branch squeezed in its middle. */}
			<div className={styles.selectors} data-size="s" data-filtered={Boolean(historyPath)}>
				{scopes && scopes.length > 0 && (
					<Popup
						label={t(locale, 'Repo')}
						options={scopeOptions}
						value={historyScope ?? ''}
						onChange={(value) => {
							setOpen({});
							setTask({ historyScope: value, historyBranch: null, historyPath: null });
						}}
					/>
				)}
				{branchOptions.length > 0 && (
					<Popup
						label={t(locale, 'Branch')}
						options={branchOptions}
						value={historyBranch ?? ''}
						displayValue={historyBranch ? <BranchName name={historyBranch} /> : undefined}
						onChange={(value) => {
							setOpen({});
							setTask({ historyBranch: value });
						}}
					/>
				)}
			</div>
			{historyPath && (
				<div className={styles.filter} data-file-filter>
					<span className={styles.chip} data-size="s">
						<Glyph name="file" size={12} />
						<span className={styles.chipLabel}>{t(locale, 'File')}</span>
						<span className={styles.chipName}>{historyPath.split('/').at(-1)}</span>
						<span className={styles.chipDir}>
							{historyPath.includes('/') ? historyPath.slice(0, historyPath.lastIndexOf('/')) : ''}
						</span>
						<IconButton
							label={t(locale, 'Remove the file filter')}
							onClick={() => setTask({ historyPath: null })}>
							<Glyph name="close" size={10} />
						</IconButton>
					</span>
				</div>
			)}
			{/* spec/appearance#evolution-redesign: a merge in progress is the banner over the panel and the Conflicts dialog, not a strip here. */}
			<div className={styles.commits} data-size="s" role="list" aria-label={t(locale, 'History')}>
				{scopes === null || (scope && !page && !readFailure) ? (
					<SkeletonRows count={8} height={44} />
				) : !scope ? (
					<p className={styles.hint}>{t(locale, 'No Git snapshots')}</p>
				) : readFailure && !page ? (
					<div className={styles.failure} role="alert" data-history-failure>
						<p>{readFailure}</p>
						<Button
							size="s"
							onClick={() => {
								void load();
							}}>
							{t(locale, 'Retry')}
						</Button>
					</div>
				) : !page || (answered && !page.commits.length) ? (
					<p className={styles.hint}>
						{page && live
							? t(locale, 'Nothing found')
							: historyPath && historyBranch
								? t(locale, 'No commits with this file yet: Git does not track it.')
								: historyBranch
									? t(locale, 'No commits')
									: t(locale, 'Select a branch')}
					</p>
				) : (
					<>
						<p className={styles.meta} role={answered ? undefined : 'status'}>
							{!answered ? (
								t(locale, 'Searching…')
							) : historyPath ? (
								fileCommitCount(locale, page.commits.length, page.truncated)
							) : (
								<>
									{commitCount(locale, page.commits.length)}
									{page.truncated ? '+' : ''}
								</>
							)}
						</p>
						{commits.map((commit, index) => {
							const files = open[commit.sha];
							// spec/editor#line-author: with a file filter a click opens that file's diff in the commit; the row of the open tab is lit.
							const fileTab =
								historyPath && scope && commit.file
									? `history:${commit.sha.slice(0, 7)}:${scope.id}/${commit.file.path}`
									: null;
							const expanded = historyPath
								? fileTab !== null && selected === fileTab
								: Boolean(files);
							return (
								<div
									key={commit.sha}
									role="listitem"
									className={styles.commit}
									data-open={expanded}>
									<span
										className={styles.rail}
										data-first={index === 0}
										data-last={index === commits.length - 1 && !page.truncated}>
										<span />
									</span>
									<div className={styles.body}>
										{historyPath ? (
											<button
												className={styles.head}
												aria-current={expanded || undefined}
												disabled={!commit.file}
												onClick={() => {
													if (scope && commit.file)
														openHistoryFile(scope.id, commit.sha, commit.file.path);
												}}>
												<span className={styles.subject}>{commit.subject}</span>
												<code>{commit.sha.slice(0, 7)}</code>
											</button>
										) : (
											<button
												className={styles.head}
												aria-expanded={expanded}
												onClick={() => void toggle(commit.sha)}>
												<span className={styles.subject}>{commit.subject}</span>
												<code>{commit.sha.slice(0, 7)}</code>
											</button>
										)}
										<small className={styles.byline}>
											{commit.author} · {ageShort(locale, commit.time)}
											{historyPath ? (
												<>
													{commit.parents.length > 1 ? ` · ${t(locale, 'Merge commit')}` : ''}
													{commit.file?.renamedFrom ? (
														` · ${t(locale, 'renamed from {path}').replace('{path}', commit.file.renamedFrom)}`
													) : commit.file && (commit.file.additions || commit.file.deletions) ? (
														<>
															{' '}
															·{' '}
															<ChangeCounts
																additions={commit.file.additions}
																deletions={commit.file.deletions}
																locale={locale}
																className={styles.counts}
																nonzero
															/>
														</>
													) : (
														''
													)}
												</>
											) : commit.parents.length > 1 ? (
												` · ${t(locale, 'Merge commit')}`
											) : commit.files ? (
												` · ${fileCount(locale, commit.files)}`
											) : (
												''
											)}
										</small>
										{files === 'loading' && <SkeletonRows count={3} height={24} single />}
										{files && files !== 'loading' && (
											<div className={styles.files}>
												{files.files.map((file) => (
													<button
														key={file.id}
														className={styles.file}
														title={
															file.oldPath !== file.path
																? `${file.oldPath} → ${file.path}`
																: file.path
														}
														disabled={file.gitlink}
														onClick={() => void openFile(commit.sha, file.id, file.path)}>
														<span className={styles.path}>{file.path}</span>
														{file.binary ? (
															<small>{t(locale, 'Binary file')}</small>
														) : (
															<ChangeCounts
																additions={file.additions}
																deletions={file.deletions}
																locale={locale}
																className={styles.counts}
																split
															/>
														)}
													</button>
												))}
											</div>
										)}
									</div>
								</div>
							);
						})}
					</>
				)}
			</div>
			{answered && page?.truncated && limit < historyLimitMax && (
				<footer className={styles.more}>
					<Button
						onClick={() =>
							setMore({ search, limit: Math.min(historyLimitMax, limit + historyPageSize) })
						}>
						{t(locale, 'Show 100 more')}
					</Button>
				</footer>
			)}
			{dialog && scope && branches?.current && (
				<MergeDialog
					task={task}
					locale={locale}
					scope={scope}
					repoName={repoName(scope.name)}
					into={branches.current}
					branches={branches}
					onClose={() => setDialog(false)}
					onMerged={() => {
						setDialog(false);
						void load();
					}}
					onConflicts={(state) => {
						// spec/appearance#evolution-redesign: «did not resolve itself» leads into the Conflicts dialog.
						setMerge(state);
						setDialog(false);
						openConflictsDialog(task, scope.id);
					}}
					onError={() => {}}
				/>
			)}
		</div>
	);
}
