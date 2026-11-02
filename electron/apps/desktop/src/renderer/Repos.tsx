import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react';
import { onSessionEvent } from './session-events';
import {
	MAIN_TREE_ID,
	affectsScopes,
	commitCount,
	fileCount,
	inTask,
	projectColors,
	t,
	type BranchSwitchState,
	type MergeState,
	type AgentTask,
	type Project,
	type Locale,
	type MessageKey,
	type ScopePanelSnapshot,
	type ScopeUpdate,
} from '@brigadir/core';
import { IconButton } from './ui/Controls';
import { resolveToast, showToast as toastSuccess, toastError, toastWarning } from './ui/Toast';
import { Glyph } from './ui/Glyph';
import {
	MenuItem as MenuRow,
	MenuPopover,
	MenuSection,
	MenuSeparator,
	Popover,
} from './ui/Popover';
import { BranchPicker, StashPopover, gitAction, type BranchRepo } from './BranchPicker';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { requestForgeAction, useScopeForge } from './Forge';
import {
	openCommitDialog,
	openConflictsDialog,
	openTaskPullRequests,
	openTaskScope,
	useTaskState,
} from './task-state';
import { RepoPRCounter } from './PullRequests';
import { useWorkspace } from './store';
import { ChangeCounts } from './ui/ChangeCounts';
import { BranchName } from './ui/BranchName';
import { ProjectIcon } from './ui/ProjectIcon';
import { RepoRoot } from './ui/RepoRoot';
import { HeaderChip } from './ui/HeaderChip';
import styles from './Repos.module.css';
import { SkeletonRows } from './ui/Loading';

/**
 * spec/appearance#evolution-redesign, spec/task-window#repo-line: the repos of a task live in its header and as roots of its panel, not in the sidebar.
 * One read per task view feeds the header's chip, the «Repos k/n» popover and the roots of Files and Changes; every
 * repo action (spec/sidebar#layout, spec/projects-and-board#repo-selection, spec/projects-and-board#folders-mid-task, spec/git#main-tree-branches, spec/git#pull) is in a repo's «…» here.
 */
export type RepoScope = ScopePanelSnapshot['scopes'][number];
type GlyphName = Parameters<typeof Glyph>[0]['name'];
type MenuItem =
	| { separator: true }
	| { section: string; separator?: false }
	| {
			separator?: false;
			section?: undefined;
			icon: GlyphName;
			label: string;
			checked?: boolean;
			disabled?: boolean;
			danger?: boolean;
			title?: string;
			tail?: ReactNode;
			reason?: string | undefined;
			run(): void;
	  };
type Repos = {
	project: Project;
	task: AgentTask;
	/** The project's main tree (spec/tasks#quick-tasks): no task repos to add or remove, a Git group in each repo's menu. */ mainTree: boolean;
	locale: Locale;
	data: ScopePanelSnapshot | null;
	saving: boolean;
	update(change: ScopeUpdate): Promise<void>;
	addFolder(): void;
	/** The task runs in its own worktree: «Remove worktree…» is one of its actions. */ worktree: boolean;
	/** spec/tasks#quick-tasks: the main tree's current repo — the subtitle's, the quick task's; `null` is the first. */ current:
		string | null;
	removeWorktree(returnFocus: RefObject<HTMLElement | null>): void;
};
const ReposContext = createContext<Repos | null>(null);
export const useRepos = () => useContext(ReposContext);
export const repoName = (project: Project, scope: { name: string }) =>
	scope.name === '.' ? project.name : scope.name;

/** One read of the task's repos for a task view and everything under it. */
export function ReposProvider({
	value,
	children,
}: {
	value: ReturnType<typeof useReposState>;
	children: ReactNode;
}) {
	return (
		<ReposContext.Provider value={value.repos}>
			{children}
			{value.dialog}
		</ReposContext.Provider>
	);
}
/**
 * The read of the task's repos, retried on its own; a failure is one warning toast per streak (spec/notifications-slack-notes-and-schedules#message-classes). The task view
 * holds it (its own lists need the repos) and hands it down with `ReposProvider`.
 */
export function useReposState(
	project: Project | undefined,
	task: AgentTask,
	mainTree: boolean,
	locale: Locale,
	current: string | null = null
): { repos: Repos | null; dialog: ReactNode } {
	const [data, setData] = useState<ScopePanelSnapshot | null>(null),
		[saving, setSaving] = useState(false),
		[removing, setRemoving] = useState<RefObject<HTMLElement | null> | null>(null);
	const refresh = useRef<() => Promise<void>>(async () => {}),
		writing = useRef(false),
		revision = useRef(0);
	useEffect(() => {
		let active = true,
			reading = false,
			pending = false,
			failed = false;
		const read = async () => {
			if (reading) {
				pending = true;
				return;
			}
			if (writing.current) return;
			reading = true;
			const request = revision.current;
			try {
				if (!project) return;
				const value = await window.brigadir.readScopePanel(project.id, task.id);
				if (active && request === revision.current) {
					setData(value);
					if (failed) resolveToast(t(locale, 'Could not read the repo list.'));
					failed = false;
				}
			} catch {
				if (active && request === revision.current) {
					if (!failed) {
						failed = true;
						toastWarning(t(locale, 'Could not read the repo list.'), {
							action: {
								label: t(locale, 'Retry'),
								run: () => {
									void refresh.current();
								},
							},
						});
					}
					retry();
				}
			} finally {
				reading = false;
				if (pending && active) {
					pending = false;
					void read();
				}
			}
		};
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const retry = () => {
			if (!retryTimer)
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					if (active) void read();
				}, 1500);
		};
		refresh.current = read;
		void read();
		// Repo rows change on lifecycle and checkpoint events, never on streamed deltas; the slow timer catches other owners' locks,
		// the window's focus what was done outside (a commit in a terminal, spec/git#pull).
		const focus = () => void read();
		addEventListener('focus', focus);
		const interval = setInterval(() => {
				if (!document.hidden) void read();
			}, 30000),
			stop = onSessionEvent(({ key, record }) => {
				if (key.projectId === project?.id && affectsScopes(record)) void read();
			});
		return () => {
			active = false;
			removeEventListener('focus', focus);
			clearInterval(interval);
			clearTimeout(retryTimer);
			stop();
			if (failed) resolveToast(t(locale, 'Could not read the repo list.'));
		};
	}, [project?.id, task.id]);
	/** spec/notifications-slack-notes-and-schedules#message-classes: a failed change is its own toast that names the repo; Retry repeats the change. */
	const failed = (key: MessageKey, retry: () => void, repo?: string) =>
		toastError(repo ? t(locale, key).replace('{repo}', repo) : t(locale, key), {
			bold: repo,
			action: { label: t(locale, 'Retry'), run: retry },
		});
	async function write(work: () => Promise<void>, fail: () => void) {
		if (writing.current) return;
		writing.current = true;
		revision.current++;
		setSaving(true);
		try {
			await work();
		} catch {
			fail();
		} finally {
			writing.current = false;
			setSaving(false);
			await refresh.current();
		}
	}
	const update = (change: ScopeUpdate): Promise<void> => {
		if (writing.current) return Promise.resolve();
		if (!project) return Promise.resolve();
		const scope = data?.scopes.find((item) => item.id === change.id),
			name = scope ? repoName(project, scope) : change.id;
		setData((data) =>
			data
				? {
						...data,
						scopes: data.scopes.map((scope) =>
							scope.id === change.id ? { ...scope, selected: change.selected } : scope
						),
					}
				: data
		);
		return write(
			() => window.brigadir.updateScope(project.id, task.id, change),
			() =>
				failed(
					change.selected
						? 'Could not add {repo} to the task.'
						: 'Could not remove {repo} from the task.',
					() => {
						void update(change);
					},
					name
				)
		);
	};
	// spec/projects-and-board#folders-mid-task: a folder from outside joins the task, also while its agent runs; a failure is a toast with Retry.
	const addFolder = () => {
		if (mainTree || !project) return;
		void write(
			async () => {
				await window.brigadir.addScopeFolder(project.id, task.id);
			},
			() => failed('The folder could not be added.', addFolder)
		);
	};
	const worktree = !mainTree && task.launch?.isolation === 'worktree' && Boolean(task.preparation);
	return {
		repos: project
			? {
					project,
					task,
					mainTree,
					locale,
					data,
					saving,
					update,
					addFolder,
					worktree,
					current,
					removeWorktree: (returnFocus) => setRemoving(returnFocus),
				}
			: null,
		dialog: removing && (
			<ConfirmDialog
				locale={locale}
				danger
				title={t(locale, 'Remove the worktree?')}
				action={t(locale, 'Remove')}
				error={t(locale, 'Could not remove the worktree.')}
				returnFocus={removing}
				cancel={() => setRemoving(null)}
				confirm={async () => {
					await window.brigadir.removeWorktree(task);
					setRemoving(null);
					await refresh.current();
				}}>
				<p>
					{t(
						locale,
						"The task's copy of the repos will be removed. Branches and commits stay, and the next start prepares a new worktree."
					)}
				</p>
			</ConfirmDialog>
		),
	};
}
/** The repo the header names: the project's root, else the first repo of the task. */
export function mainRepo(data: ScopePanelSnapshot | null) {
	const scopes = data?.scopes ?? [];
	return (
		scopes.find((scope) => scope.kind === 'root' && inTask(scope)) ??
		scopes.find(inTask) ??
		scopes.find((scope) => scope.kind === 'root') ??
		scopes[0] ??
		null
	);
}
/** Zero changes are not shown (spec/sidebar#layout): the pair appears once anything changes. */
export function RepoCounts({
	additions,
	deletions,
	locale,
}: {
	additions: number;
	deletions: number;
	locale: Locale;
}) {
	if (!additions && !deletions) return null;
	return (
		<ChangeCounts
			additions={additions}
			deletions={deletions}
			locale={locale}
			className={styles.counts}
		/>
	);
}
/** spec/git#pull: ↑N to push and ↓N to pull — from the forge where there is one, else from the repo's own read. */
function useUpstream(scope: RepoScope) {
	const repos = useRepos()!,
		forge = useScopeForge(scope.id);
	const mainRow = repos.mainTree || repos.task.launch?.isolation !== 'worktree';
	return {
		behind: mainRow ? (scope.upstream?.behind ?? 0) : 0,
		// The main tree also takes the panel's own read: a commit made outside shows before the forge reads again.
		push: repos.mainTree
			? Math.max(forge?.push ?? 0, scope.upstream?.ahead ?? 0)
			: (forge?.push ?? 0),
		forge,
	};
}
/** The PR of the task in this repo while it is open (spec/sidebar#repos), with its checks; `number` adds `#N`. */
function PRMark({ scope, number = false }: { scope: RepoScope; number?: boolean }) {
	const forge = useScopeForge(scope.id),
		repos = useRepos()!;
	if (repos.mainTree || forge?.pr?.state !== 'OPEN') return null;
	return (
		<span
			className={styles.pr}
			data-state={forge.state}
			title={`${forge.pr.title} · #${forge.pr.number}`}
			data-repo-pr>
			<Glyph name="pr-branch" size={11} />
			{number && <span className={styles.mono}>#{forge.pr.number}</span>}
			{forge.state === 'pending' ? (
				<Glyph name="check-pending" size={11} />
			) : forge.state === 'pass' ? (
				<Glyph name="badge-pass" size={11} />
			) : forge.state === 'fail' ? (
				<Glyph name="badge-fail" size={11} />
			) : forge.state === 'unknown' ? (
				<span>?</span>
			) : null}
		</span>
	);
}
/** The lock of a repo another task holds (spec/tasks#launch-sheet, spec/notifications-slack-notes-and-schedules#repo-contention): its holders in the tooltip. */
function LockMark({
	scope,
	locale,
	count,
}: {
	scope: RepoScope;
	locale: Locale;
	/** A panel's repo heading: the glyph and how many other tasks hold the repo. */ count?: boolean;
}) {
	const repos = useRepos()!;
	const others = scope.owners.filter(
		(owner) => owner.key.projectId !== repos.task.projectId || owner.key.id !== repos.task.id
	);
	if (!others.length) return null;
	return count ? (
		<RepoLock locale={locale} owners={others} contended={scope.owners.length > 1} />
	) : (
		<span
			className={styles.lock}
			title={`${t(locale, 'Busy')} · ${others.map((owner) => owner.title).join(' · ')}`}
			data-repo-lock
			data-contended={scope.owners.length > 1 || undefined}>
			<Glyph name="scope-lock" size={11} />
		</span>
	);
}
/** spec/notifications-slack-notes-and-schedules#notice-chips: a repo heading another task holds and this one does not mix with — not a chip, the amber
 *  lock and the number of the other tasks, their titles in the tooltip. Mixed changes stand there as the ContentionChip. */
export function RepoLock({
	locale,
	owners,
	contended,
}: {
	locale: Locale;
	/** The other tasks holding the repo. */ owners: readonly { title: string }[];
	contended?: boolean;
}) {
	return (
		<span
			className={styles.lock}
			data-count
			title={`${t(locale, 'Busy')} · ${owners.map((owner) => owner.title).join(' · ')}`}
			data-repo-lock
			data-contended={contended || undefined}>
			<Glyph name="scope-lock" size={12} />
			{new Intl.NumberFormat(locale).format(owners.length)}
		</span>
	);
}
/**
 * A repo's actions: its «…» menu (spec/sidebar#layout, spec/projects-and-board#repo-selection, spec/pull-requests-and-ci#pr-panel, spec/git#main-tree-branches), the branch picker (spec/git#main-tree-branches) and the dialogs they open.
 * `extra` goes last: «Remove worktree…» when the task has one repo (spec/appearance#evolution-redesign).
 */
export function useRepoActions(
	scope: RepoScope,
	{ anchor, extra = [] }: { anchor: RefObject<HTMLElement | null>; extra?: MenuItem[] }
) {
	const repos = useRepos()!,
		{ project, task, mainTree, locale, saving, data } = repos;
	const [open, setOpen] = useState(false),
		trigger = useRef<HTMLButtonElement>(null),
		branchButton = useRef<HTMLButtonElement>(null),
		forge = useScopeForge(scope.id);
	const name = repoName(project, scope),
		canChangeRepos = data?.canChangeRepos ?? false;
	const unavailable = scope.available === false;
	const canOpenFile = Boolean(!mainTree && inTask(scope) && scope.firstFile);
	const label = `${t(locale, 'Repo actions')} · ${name}`;
	const git = scope.kind !== 'folder' && scope.kind !== 'external' && !unavailable;
	// spec/git#main-tree-branches: the Git group is the main tree's; spec/task-window#repo-line: the picker also stands where a task works in place.
	const gitMenu = mainTree && git,
		picks = git && (mainTree || task.launch?.isolation !== 'worktree'),
		repo: BranchRepo = { projectId: project.id, scopeId: scope.id, name };
	const [state, setState] = useState<BranchSwitchState | null>(null),
		[picker, setPicker] = useState<'list' | 'new' | null>(null),
		[stashOpen, setStashOpen] = useState(false),
		[confirm, setConfirm] = useState<'discard' | 'undo' | null>(null);
	// spec/git#commit-dialog: «Commit…» carries the count of this repo's files to commit, read when the menu opens.
	const [commitFiles, setCommitFiles] = useState<number | null>(null);
	useEffect(() => {
		if (!open || !git) return;
		let active = true;
		setCommitFiles(null);
		void window.brigadir.readCommits(task).then(
			(value) => {
				if (active)
					setCommitFiles(
						value.preview.scopes.find((item) => item.scope.id === scope.id)?.files.length ?? 0
					);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [open]);
	const commitItem: MenuItem = {
		icon: 'commit-dot',
		label: t(locale, 'Commit…'),
		tail: commitFiles || undefined,
		disabled: commitFiles === 0,
		reason: commitFiles === 0 ? t(locale, 'There are no changes.') : undefined,
		run: () => openCommitDialog(task, scope.id),
	};
	// spec/appearance#evolution-redesign: a merge or rebase in progress in this repo — its section leads the menu; branch changes wait.
	const [merging, setMerging] = useState<MergeState | null>(null);
	useEffect(() => {
		if (!open || !git) return;
		let active = true;
		void window.brigadir.readMergeStates(task).then(
			(states) => {
				if (active) setMerging(states.find((item) => item.scopeId === scope.id) ?? null);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [open]);
	const mergeItems: MenuItem[] = merging
		? [
				{
					section: t(
						locale,
						merging.kind === 'rebase' ? 'Rebase in progress' : 'Merge in progress'
					),
				},
				{
					icon: 'review-warning',
					label: t(locale, 'Resolve conflicts…'),
					tail: merging.conflicts.filter((file) => !file.resolved).length || undefined,
					run: () => openConflictsDialog(task, scope.id),
				},
				{
					icon: 'undo',
					label: t(locale, merging.kind === 'rebase' ? 'Abort rebase…' : 'Abort merge…'),
					run: () => openConflictsDialog(task, scope.id, null, true),
				},
			]
		: [];
	useEffect(() => {
		if (!open || !gitMenu) return;
		let active = true;
		setState(null);
		void window.brigadir.readBranchSwitch(project.id, scope.id).then(
			(value) => {
				if (active) setState(value);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [open]);
	const items: MenuItem[] = mainTree
		? [...mergeItems]
		: [
				...mergeItems,
				...(mergeItems.length ? [{ separator: true } as const] : []),
				{
					icon: scope.selected ? 'scope-lock' : 'sidebar-eye',
					label: scope.selected ? t(locale, 'Remove from the task…') : t(locale, 'Add to the task'),
					checked: scope.selected,
					disabled: saving || !canChangeRepos || unavailable,
					...(canChangeRepos
						? {}
						: { reason: t(locale, 'Stop the task before changing its repos.') }),
					run: () => {
						void repos.update({ id: scope.id, selected: !scope.selected });
					},
				},
			];
	// spec/pull-requests-and-ci#ready-card: the main tree's repo makes a PR of its current branch too; its push and checks stay with the Git group.
	if (mainTree && forge && git && forge.pr?.state !== 'OPEN')
		items.push({
			icon: 'pr-branch',
			label: t(locale, 'Create PR…'),
			disabled: forge.blocked,
			...(forge.reason ? { reason: forge.reason } : {}),
			run: () => forge.open('pr', trigger.current),
		});
	if (!mainTree && (forge || git)) {
		const actions: MenuItem[] = git ? [commitItem] : [];
		if (forge && forge.push > 0)
			actions.push({
				icon: 'push-commits',
				label: t(locale, 'Push commits…'),
				tail: forge.push,
				run: () => forge.open('push', trigger.current),
			});
		if (forge?.pr?.state === 'OPEN')
			actions.push({
				icon:
					forge.state === 'fail'
						? 'check-fail'
						: forge.state === 'pending'
							? 'check-pending'
							: 'check-pass',
				label: t(locale, 'Checks…'),
				tail: `#${forge.pr.number}`,
				run: () => forge.open('checks', trigger.current),
			});
		if (forge?.pr)
			actions.push({
				icon: 'external',
				label: t(locale, 'Open on GitHub'),
				run: () => {
					void window.brigadir.openPullRequest(task, scope.id).catch(() => {});
				},
			});
		if (forge && forge.pr?.state !== 'OPEN')
			actions.push({
				icon: 'pr-branch',
				label: t(locale, 'Create PR…'),
				disabled: forge.blocked,
				...(forge.reason ? { reason: forge.reason } : {}),
				run: () => forge.open('pr', trigger.current),
			});
		if (actions.length) items.push({ separator: true }, ...actions);
	}
	if (canOpenFile)
		items.push(
			{ separator: true },
			{
				icon: 'file',
				label: t(locale, 'Open first change'),
				run: () => {
					openTaskScope(task, scope.id, scope.firstFile!);
				},
			}
		);
	if (gitMenu) {
		const held = state?.heldBy
			? t(
					locale,
					'The task {task} is working in {repo} without isolation. You can switch the branch once it stops.'
				)
					.replace('{task}', state.heldBy.title)
					.replace('{repo}', name)
			: merging
				? t(locale, 'Finish or abort the merge first.')
				: undefined;
		const current = state?.branches.find((branch) => branch.current),
			off = !state || !!held;
		const pullReason =
			held ??
			(!current?.upstream
				? t(locale, 'The branch has no upstream on origin.')
				: current.gone
					? t(locale, 'The branch {branch} was deleted from origin after the PR merged.').replace(
							'{branch}',
							current.name
						)
					: undefined);
		const undoReason =
			held ??
			(state?.last?.pushed
				? t(locale, 'The commit is already on origin. Only a new commit (revert) can undo it.')
				: state?.last?.root
					? t(locale, 'This is the first commit of the repo.')
					: undefined);
		if (items.length) items.push({ separator: true });
		items.push(
			{ section: 'Git' },
			commitItem,
			{
				icon: 'sidebar-branch',
				label: t(locale, 'Switch branch…'),
				disabled: off,
				reason: held,
				run: () => setPicker('list'),
			},
			{ icon: 'plus', label: t(locale, 'New branch…'), disabled: off, run: () => setPicker('new') },
			{ separator: true },
			{
				icon: 'git-pull',
				label: t(locale, 'Pull'),
				tail: current?.behind ? `↓${current.behind}` : undefined,
				disabled: off || !!pullReason,
				reason: pullReason,
				run: () => {
					void gitAction(
						locale,
						() => window.brigadir.pullBranch(project.id, scope.id),
						(count) =>
							count
								? `${name} · ${t(locale, 'pulled {commits}').replace('{commits}', commitCount(locale, count))}`
								: t(locale, 'Nothing new on origin.')
					);
				},
			},
			{
				icon: 'git-stash',
				label: t(locale, 'Stash changes'),
				tail: state?.dirty.length || undefined,
				disabled: off || !state?.dirty.length,
				reason:
					held ?? (state && !state.dirty.length ? t(locale, 'There are no changes.') : undefined),
				run: () => {
					void gitAction(
						locale,
						() => window.brigadir.stashChanges(project.id, scope.id),
						() => t(locale, 'Changes stashed.')
					);
				},
			},
			{
				icon: 'git-unstash',
				label: t(locale, 'Restore from stash…'),
				tail: state?.stashes || undefined,
				disabled: off || !state?.stashes,
				reason: held ?? (state && !state.stashes ? t(locale, 'No stash entries.') : undefined),
				run: () => setStashOpen(true),
			},
			{
				icon: 'undo',
				label: t(locale, 'Undo last commit…'),
				disabled: off || !state?.last || !!undoReason,
				reason: undoReason === held ? undefined : undoReason,
				run: () => setConfirm('undo'),
			},
			{ separator: true },
			{
				icon: 'trash',
				label: t(locale, 'Discard changes…'),
				danger: true,
				disabled: off || !state?.dirty.length,
				run: () => setConfirm('discard'),
			}
		);
	}
	if (extra.length) items.push({ separator: true }, ...extra);
	const dialogs = (
		<>
			<RepoMenu
				open={open}
				locale={locale}
				label={label}
				items={items}
				anchor={trigger}
				close={() => setOpen(false)}
				width={gitMenu ? 260 : 240}
			/>
			{picks && (
				<BranchPicker
					repo={repo}
					anchor={anchor}
					returnFocus={branchButton}
					open={picker !== null}
					start={picker ?? 'list'}
					onClose={() => setPicker(null)}
					locale={locale}
				/>
			)}
			{gitMenu && (
				<StashPopover
					repo={repo}
					anchor={trigger}
					open={stashOpen}
					onClose={() => setStashOpen(false)}
					locale={locale}
				/>
			)}
			{confirm === 'discard' && state && (
				<ConfirmDialog
					locale={locale}
					danger
					title={t(locale, 'Discard changes in {repo}?').replace('{repo}', name)}
					action={t(locale, 'Discard')}
					cancel={() => setConfirm(null)}
					confirm={async () => {
						await window.brigadir.discardChanges(
							project.id,
							scope.id,
							state.dirty.filter((file) => file.untracked).map((file) => file.path)
						);
						setConfirm(null);
						toastSuccess(t(locale, 'Changes discarded.'));
					}}>
					<p>
						<strong>{fileCount(locale, state.dirty.length)}</strong>.{' '}
						{t(
							locale,
							'They go back to the last commit, and new files are deleted. This cannot be undone.'
						)}
					</p>
				</ConfirmDialog>
			)}
			{confirm === 'undo' && state?.last && (
				<ConfirmDialog
					locale={locale}
					title={t(locale, 'Undo the last commit?')}
					action={t(locale, 'Undo commit')}
					cancel={() => setConfirm(null)}
					confirm={async () => {
						await window.brigadir.undoLastCommit(project.id, scope.id);
						setConfirm(null);
						toastSuccess(t(locale, 'The commit is undone. Its changes are in the tree.'));
					}}>
					<p>
						<code>{state.last.sha.slice(0, 7)}</code> {state.last.subject} —{' '}
						{t(locale, 'It leaves the branch, and its changes stay in the tree uncommitted.')}
					</p>
				</ConfirmDialog>
			)}
		</>
	);
	const button =
		items.length > 0 ? (
			<IconButton
				ref={trigger}
				size="s"
				className={styles.more}
				aria-haspopup="menu"
				aria-expanded={open}
				label={label}
				onClick={(event) => {
					event.stopPropagation();
					setOpen((value) => !value);
				}}>
				<Glyph name="more" size={14} />
			</IconButton>
		) : null;
	return {
		name,
		label,
		button,
		dialogs,
		trigger,
		branchButton,
		picks,
		picking: picker !== null,
		openPicker: () => setPicker((value) => (value ? null : 'list')),
		openMenu: () => setOpen((value) => !value),
		menuOpen: open,
	};
}
function RepoMenu({
	open,
	locale,
	label,
	items,
	anchor,
	close,
	width = 240,
}: {
	open: boolean;
	locale: Locale;
	label: string;
	items: MenuItem[];
	anchor: RefObject<HTMLElement | null>;
	close(): void;
	width?: number;
}) {
	return (
		<MenuPopover
			open={open}
			onClose={close}
			anchor={anchor}
			align="end"
			width={width}
			label={label}
			locale={locale}>
			{items.map((item, index) =>
				item.separator ? (
					<MenuSeparator key={index} />
				) : item.section !== undefined ? (
					<MenuSection key={index}>{item.section}</MenuSection>
				) : (
					<MenuRow
						key={index}
						kind={item.checked === undefined ? 'action' : 'check'}
						checked={!!item.checked}
						icon={<Glyph name={item.icon} size={12} />}
						tail={item.tail}
						disabled={!!item.disabled}
						danger={!!item.danger}
						reason={item.reason}
						title={item.title}
						hands={
							item.icon === 'sidebar-branch' || item.icon === 'plus' || item.icon === 'git-unstash'
						}
						onSelect={item.run}>
						{item.label}
					</MenuRow>
				)
			)}
		</MenuPopover>
	);
}
/** «Remove worktree…» as a menu row: disabled with its reason while the task runs (spec/tasks#released-worktree). */
function removeWorktreeItem(repos: Repos, returnFocus: RefObject<HTMLElement | null>): MenuItem {
	const can = repos.data?.canChangeRepos ?? false;
	return {
		icon: 'trash',
		label: t(repos.locale, 'Remove worktree…'),
		disabled: !can,
		...(can ? {} : { reason: t(repos.locale, 'Stop the task before removing its worktree.') }),
		run: () => repos.removeWorktree(returnFocus),
	};
}
/** The task's repos that count in `k/n`: what is in the task over every repo of the project. */
const tally = (data: ScopePanelSnapshot | null) => ({
	inTask: data?.scopes.filter((scope) => scope.selected).length ?? 0,
	all: data?.scopes.length ?? 0,
});

/**
 * spec/appearance#evolution-redesign: the second line of the task header — one chip for the main repo (mark, name, branch, ↑↓, lock, PR), the
 * «+N ▾» of the other repos, then the task's state. The chip opens the branch picker where the branch is the main
 * tree's, the repo's actions elsewhere (spec/task-window#repo-line).
 */
export function TaskRepoLine({
	status,
	links,
}: {
	status: ReactNode;
	/** spec/appearance#evolution-redesign: the task's relations after the state — their chip shrinks before the repo chip. */ links?: ReactNode;
}) {
	const repos = useRepos();
	const scope = mainRepo(repos?.data ?? null);
	return (
		<div className={styles.line} data-task-repo-line>
			{repos && scope ? <RepoChip scope={scope} /> : <span className={styles.placeholder} />}
			{repos && (repos.data?.scopes.length ?? 0) > 1 && <ReposButton />}
			{status !== null && (
				<>
					<span className={styles.dot} aria-hidden="true">
						·
					</span>
					<span className={styles.status}>{status}</span>
				</>
			)}
			{links}
		</div>
	);
}
function RepoChip({ scope }: { scope: RepoScope }) {
	const repos = useRepos()!,
		{ project, locale } = repos;
	const chip = useRef<HTMLButtonElement>(null);
	const single = (repos.data?.scopes.length ?? 0) <= 1;
	const actions = useRepoActions(scope, {
		anchor: chip,
		extra: single && repos.worktree ? [removeWorktreeItem(repos, chip)] : [],
	});
	const { behind, push } = useUpstream(scope);
	// A string selector: a fresh Map from the store on every read would re-render without end.
	const ids = useWorkspace((state) =>
			(state.workspace?.projects.map((item) => item.id) ?? []).join('\n')
		),
		color = useMemo(
			() => projectColors(ids ? ids.split('\n') : []).get(project.id) ?? 0,
			[ids, project.id]
		);
	return (
		<>
			<HeaderChip
				ref={(node) => {
					chip.current = node;
					actions.branchButton.current = node;
					actions.trigger.current = node;
				}}
				data-repo-chip
				aria-haspopup={actions.picks ? 'dialog' : 'menu'}
				aria-expanded={actions.picks ? actions.picking : actions.menuOpen}
				aria-label={
					actions.picks
						? `${t(locale, 'Switch branch')} · ${actions.name}`
						: `${t(locale, 'Repo actions')} · ${actions.name}`
				}
				title={`${actions.name} · ${scope.branch ?? t(locale, 'Detached HEAD')}`}
				onClick={() => (actions.picks ? actions.openPicker() : actions.openMenu())}>
				<ProjectIcon project={project} slot={color} size={14} />
				<span className={styles.chipName}>{actions.name}</span>
				{scope.kind !== 'folder' && scope.kind !== 'external' && (
					<>
						<Glyph name="sidebar-branch" size={11} />
						<BranchName name={scope.branch ?? '—'} className={styles.branch} />
					</>
				)}
				{push > 0 && <span className={styles.mono}>↑{push}</span>}
				{behind > 0 && <span className={styles.mono}>↓{behind}</span>}
				<LockMark scope={scope} locale={locale} />
				<PRMark scope={scope} number />
			</HeaderChip>
			{actions.dialogs}
		</>
	);
}
/** «+N ▾»: the popover of every repo of the task (spec/appearance#evolution-redesign). */
function ReposButton() {
	const repos = useRepos()!,
		{ locale, data } = repos;
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null);
	const { inTask: k, all: n } = tally(data);
	const others = Math.max(0, (data?.scopes.length ?? 0) - 1);
	return (
		<>
			<HeaderChip
				ref={anchor}
				count
				filled
				data-repos-button
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${t(locale, 'Repos')} · ${k}/${n}`}
				title={`${t(locale, 'Repos')} · ${k}/${n}`}
				onClick={() => setOpen((value) => !value)}>
				+{others}
				<Glyph name="chevron-down" size={9} />
			</HeaderChip>
			<ReposPopover open={open} anchor={anchor} onClose={() => setOpen(false)} />
		</>
	);
}
export function ReposPopover({
	open,
	anchor,
	onClose,
}: {
	open: boolean;
	anchor: RefObject<HTMLElement | null>;
	onClose(): void;
}) {
	const repos = useRepos()!,
		{ locale, data, mainTree, saving } = repos;
	const { inTask: k, all: n } = tally(data);
	const [menu, setMenu] = useState(false),
		more = useRef<HTMLButtonElement>(null);
	return (
		<Popover
			open={open}
			onClose={onClose}
			anchor={anchor}
			label={t(locale, 'Repos')}
			title={
				<>
					{t(locale, 'Repos')} <span className={styles.tally}>{`${k}/${n}`}</span>
				</>
			}
			locale={locale}
			width={330}
			size="s"
			data-repos-popover
			headerExtra={
				repos.worktree ? (
					<>
						<IconButton
							ref={more}
							size="s"
							aria-haspopup="menu"
							aria-expanded={menu}
							label={t(locale, 'Worktree actions')}
							onClick={() => setMenu((value) => !value)}>
							<Glyph name="more" size={14} />
						</IconButton>
						<RepoMenu
							open={menu}
							locale={locale}
							label={t(locale, 'Worktree actions')}
							anchor={more}
							close={() => setMenu(false)}
							items={[removeWorktreeItem(repos, more)]}
						/>
					</>
				) : undefined
			}>
			<div className={styles.list} role="list">
				{!data && <SkeletonRows count={3} height={44} />}
				{data?.scopes.map((scope) => (
					<PopoverRow key={scope.id} scope={scope} close={onClose} />
				))}
			</div>
			{!mainTree && (
				<>
					<MenuSeparator />
					<button
						type="button"
						className={styles.addFolder}
						data-add-folder
						disabled={saving}
						onClick={repos.addFolder}>
						<Glyph name="folder-plus" size={12} />
						<span>{t(locale, 'Add folder…')}</span>
					</button>
				</>
			)}
		</Popover>
	);
}
function PopoverRow({ scope, close }: { scope: RepoScope; close(): void }) {
	const repos = useRepos()!,
		{ locale, mainTree, saving, data } = repos;
	const row = useRef<HTMLDivElement>(null);
	const actions = useRepoActions(scope, { anchor: row });
	const { behind, push } = useUpstream(scope);
	const outside = !mainTree && !scope.selected,
		unavailable = scope.available === false;
	if (outside && !unavailable)
		return (
			<div className={styles.outside} role="listitem" data-scope={scope.name}>
				<span className={styles.rowName}>{actions.name}</span>
				{scope.kind === 'submodule' && (
					<span className={styles.kind}>{t(locale, 'Submodule')}</span>
				)}
				<span>{t(locale, 'outside the task')}</span>
				<span className={styles.space} />
				<IconButton
					size="s"
					label={`${t(locale, 'Add to the task')} · ${actions.name}`}
					disabled={saving || !(data?.canChangeRepos ?? false)}
					onClick={() => void repos.update({ id: scope.id, selected: true })}>
					<Glyph name="plus" size={12} />
				</IconButton>
				{actions.dialogs}
			</div>
		);
	return (
		<div
			ref={row}
			className={styles.row}
			role="listitem"
			data-scope={scope.name}
			data-unavailable={unavailable || undefined}>
			<div className={styles.rowFirst}>
				<span className={styles.rowName} title={scope.path}>
					{actions.name}
				</span>
				{scope.kind === 'submodule' && (
					<span className={styles.kind}>{t(locale, 'Submodule')}</span>
				)}
				<span className={styles.space} />
				<RepoCounts additions={scope.additions} deletions={scope.deletions} locale={locale} />
				<PRChip scope={scope} />
				<RepoPRs scope={scope} onOpen={close} />
				<LockMark scope={scope} locale={locale} />
				{actions.button}
			</div>
			<div className={styles.rowSecond}>
				{scope.kind === 'folder' || scope.kind === 'external' ? (
					<span>{scope.branch ?? '—'}</span>
				) : actions.picks ? (
					<button
						ref={actions.branchButton}
						type="button"
						className={styles.branchButton}
						aria-haspopup="dialog"
						aria-expanded={actions.picking}
						aria-label={`${t(locale, 'Switch branch')} · ${actions.name}`}
						data-branch-button
						onClick={actions.openPicker}>
						<Glyph name="chevron-down" size={9} />
						<BranchName name={scope.branch ?? '—'} />
					</button>
				) : (
					<span className={styles.branchText}>
						<Glyph name="sidebar-branch" size={10} />
						<BranchName name={scope.branch ?? '—'} />
					</span>
				)}
				<span className={styles.space} />
				{push > 0 && <span className={styles.mono}>↑{push}</span>}
				{behind > 0 && <span className={styles.mono}>↓{behind}</span>}
			</div>
			{actions.dialogs}
		</div>
	);
}
/**
 * spec/pull-requests-and-ci#repo-counter, spec/pull-requests-and-ci#repo-picker: the repo's PR counter — open and recently closed PRs, a mark when some wait for you; it opens
 * the PR tab on this repo. A repo whose task PR is open shows that PR instead (spec/task-window#repo-line).
 */
function RepoPRs({ scope, onOpen }: { scope: RepoScope; onOpen?: () => void }) {
	const repos = useRepos()!,
		forge = useScopeForge(scope.id);
	const [{ panel, panelShown, prFilter }] = useTaskState(repos.task);
	if (!repos.mainTree && forge?.pr?.state === 'OPEN') return null;
	return (
		<span className={styles.prCounter}>
			<RepoPRCounter
				scopeId={scope.id}
				locale={repos.locale}
				active={panel === 'prs' && panelShown && prFilter === scope.id}
				onOpen={() => {
					openTaskPullRequests(repos.task, scope.id);
					onOpen?.();
				}}
			/>
		</span>
	);
}
/** The PR of the popover's row: a chip that opens its checks (spec/pull-requests-and-ci#pr-panel). */
function PRChip({ scope }: { scope: RepoScope }) {
	const forge = useScopeForge(scope.id),
		repos = useRepos()!;
	if (repos.mainTree || forge?.pr?.state !== 'OPEN') return null;
	return (
		<button
			type="button"
			className={styles.prChip}
			data-state={forge.state}
			title={`${forge.pr.title} · ${forge.pr.state}`}
			aria-label={`PR #${forge.pr.number} · ${t(repos.locale, 'Checks')}`}
			onClick={() => forge.open('checks')}>
			<PRMark scope={scope} number />
		</button>
	);
}

/**
 * spec/appearance#evolution-redesign: a repo as a root of the panel. The row folds what is under it; `…` carries the
 * repo's actions, the branch opens the picker where it is the main tree's; a repo outside the task is grey with `+`.
 */
export function PanelRepoRoot({
	scope,
	expanded,
	onToggle,
	rowProps = {},
	rowRef,
	notices,
	lock = true,
}: {
	scope: RepoScope;
	expanded: boolean;
	onToggle(): void;
	rowProps?: Omit<
		Parameters<typeof RepoRoot>[0],
		'name' | 'expanded' | 'toggleLabel' | 'onToggle' | 'branch'
	>;
	rowRef?: (node: HTMLDivElement | null) => void;
	/** Chips of the repo's state at the end of the second line: unavailable, contended (spec/notifications-slack-notes-and-schedules#repo-contention, spec/notifications-slack-notes-and-schedules#notice-chips). */ notices?: ReactNode;
	/** spec/notifications-slack-notes-and-schedules#notice-chips: false where `notices` already carries the repo's mixed changes (the ContentionChip). */ lock?: boolean;
}) {
	const repos = useRepos()!,
		{ locale, mainTree, saving, data } = repos;
	const row = useRef<HTMLDivElement | null>(null);
	const single = (data?.scopes.length ?? 0) <= 1;
	const actions = useRepoActions(scope, {
		anchor: row,
		extra: single && repos.worktree ? [removeWorktreeItem(repos, row)] : [],
	});
	const { behind, push } = useUpstream(scope);
	const outside = !mainTree && !scope.selected,
		unavailable = scope.available === false;
	const git = scope.kind !== 'folder' && scope.kind !== 'external';
	// spec/tasks#quick-tasks: in the main tree a root is also the repo the tree is on; a press on another root makes it current and opens it.
	const current =
		mainTree &&
		(repos.current === scope.id || (repos.current === null && data?.scopes[0]?.id === scope.id));
	const toggle = () => {
		if (mainTree && !current && !unavailable) {
			void useWorkspace.getState().openMainTree(repos.project.id, scope.id);
			if (!expanded) onToggle();
		} else onToggle();
	};
	return (
		<>
			<RepoRoot
				{...rowProps}
				data-current={current || undefined}
				ref={(node) => {
					row.current = node;
					rowRef?.(node);
				}}
				name={actions.name}
				aria-label={actions.name}
				title={scope.path}
				expanded={expanded}
				toggleLabel={`${t(locale, expanded ? 'Collapse folder' : 'Expand folder')} · ${actions.name}`}
				onToggle={toggle}
				outside={outside}
				unavailable={unavailable}
				data-scope={scope.name}
				kind={scope.kind === 'submodule' ? t(locale, 'Submodule') : undefined}
				counts={
					outside ? undefined : (
						<RepoCounts additions={scope.additions} deletions={scope.deletions} locale={locale} />
					)
				}
				actions={
					outside && !unavailable ? (
						<IconButton
							size="s"
							className={styles.rootAction}
							label={`${t(locale, 'Add to the task')} · ${actions.name}`}
							disabled={saving || !(data?.canChangeRepos ?? false)}
							onClick={(event) => {
								event.stopPropagation();
								void repos.update({ id: scope.id, selected: true });
							}}>
							<Glyph name="plus" size={12} />
						</IconButton>
					) : (
						actions.button
					)
				}
				branch={
					outside ? (
						<span>{t(locale, 'outside the task')}</span>
					) : !git ? (
						<span>{scope.branch ?? '—'}</span>
					) : actions.picks ? (
						<button
							ref={actions.branchButton}
							type="button"
							className={styles.rootBranch}
							aria-haspopup="dialog"
							aria-expanded={actions.picking}
							aria-label={`${t(locale, 'Switch branch')} · ${actions.name}`}
							data-branch-button
							onClick={(event) => {
								event.stopPropagation();
								actions.openPicker();
							}}>
							<Glyph name="sidebar-branch" size={10} />
							<BranchName name={scope.branch ?? '—'} />
						</button>
					) : (
						<>
							<Glyph name="sidebar-branch" size={10} />
							<BranchName name={scope.branch ?? '—'} />
						</>
					)
				}
				marks={
					outside ? undefined : (
						<>
							{push > 0 && <PushMark scope={scope} count={push} />}
							{behind > 0 && <PullMark scope={scope} count={behind} />}
							{lock && <LockMark scope={scope} locale={locale} count />}
							<PRMark scope={scope} />
							<RepoPRs scope={scope} />
							{notices}
						</>
					)
				}
			/>
			{actions.dialogs}
		</>
	);
}
/** ↑N opens Push (spec/git#pull): the task's forge, or the main tree's with the request handed over. */
function PushMark({ scope, count }: { scope: RepoScope; count: number }) {
	const repos = useRepos()!,
		forge = useScopeForge(scope.id),
		{ locale, project } = repos;
	return (
		<button
			type="button"
			className={styles.mark}
			data-push
			title={t(locale, 'Push commits')}
			aria-label={`${t(locale, 'Push commits')} · ${repoName(project, scope)}`}
			onClick={(event) => {
				event.stopPropagation();
				if (forge) forge.open('push');
				else requestForgeAction({ projectId: project.id, id: MAIN_TREE_ID }, 'push', scope.id);
			}}>
			↑{count}
		</button>
	);
}
/** ↓N pulls at once (spec/git#pull). */
function PullMark({ scope, count }: { scope: RepoScope; count: number }) {
	const repos = useRepos()!,
		{ locale, project, task, mainTree } = repos;
	const [pulling, setPulling] = useState(false),
		name = repoName(project, scope);
	return (
		<button
			type="button"
			className={styles.mark}
			data-pull
			disabled={pulling}
			title={t(locale, 'Pull · {commits}').replace('{commits}', commitCount(locale, count))}
			aria-label={`${t(locale, 'Pull')} · ${name}`}
			onClick={(event) => {
				event.stopPropagation();
				if (pulling) return;
				setPulling(true);
				void gitAction(
					locale,
					() => window.brigadir.pullBranch(project.id, scope.id, mainTree ? null : task.id),
					(pulled) =>
						pulled
							? `${name} · ${t(locale, 'pulled {commits}').replace('{commits}', commitCount(locale, pulled))}`
							: t(locale, 'Nothing new on origin.')
				).finally(() => setPulling(false));
			}}>
			↓{count}
		</button>
	);
}
/** «Add folder…» — the last row of the panel's list (spec/projects-and-board#folders-mid-task; a task only, not the main tree). */
export function AddFolderRow() {
	const repos = useRepos();
	if (!repos || repos.mainTree) return null;
	return (
		<button
			type="button"
			className={styles.panelAdd}
			data-add-folder
			disabled={repos.saving}
			onClick={repos.addFolder}>
			<Glyph name="folder-plus" size={12} />
			<span>{t(repos.locale, 'Add folder…')}</span>
		</button>
	);
}
