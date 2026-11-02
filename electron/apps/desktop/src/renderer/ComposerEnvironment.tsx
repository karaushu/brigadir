import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
	t,
	type AgentTask,
	type Locale,
	type ScopePanelSnapshot,
	type ScopeLockView,
} from '@brigadir/core';
import { ContentionChip } from './ContentionChip';
import { Glyph } from './ui/Glyph';
import { BranchName } from './ui/BranchName';
import { ChangeCounts } from './ui/ChangeCounts';
import { Popover } from './ui/Popover';
import { useWorkspace } from './store';
import styles from './ComposerEnvironment.module.css';
import { SkeletonRows } from './ui/Loading';
type Repo = ScopePanelSnapshot['scopes'][number];
/** spec/composer#island, spec/composer#capsule-squeeze: where the agent writes — the island's full-width footer: worktree or no isolation, its branch, the task's
 *  `+N −M`, the base, `N repo`. The whole footer is one button that opens the task repos above the island; it never folds. */
export function ComposerEnvironment({
	task,
	locale,
	contended = [],
	notices,
}: {
	task: AgentTask;
	locale: Locale;
	/** spec/notifications-slack-notes-and-schedules#repo-contention: the chip stands right of the footer button, its own target. */ contended?: readonly ScopeLockView[];
	/** spec/notifications-slack-notes-and-schedules#notice-chips: the other class S chips, after it. */ notices?: ReactNode;
}) {
	const [open, setOpen] = useState(false),
		[repos, setRepos] = useState<Repo[] | null>(null),
		[failed, setFailed] = useState(false);
	const root = useRef<HTMLDivElement>(null),
		button = useRef<HTMLButtonElement>(null),
		island = useRef<HTMLElement | null>(null),
		id = useId();
	const projectName = useWorkspace(
		(state) => state.workspace?.projects.find((project) => project.id === task.projectId)?.name
	);
	useEffect(() => {
		if (!open) return;
		let active = true;
		setFailed(false);
		void window.brigadir.readScopePanel(task.projectId, task.id).then(
			(value) => {
				if (active) setRepos(value.scopes.filter((scope) => scope.selected));
			},
			() => {
				if (active) setFailed(true);
			}
		);
		return () => {
			active = false;
		};
	}, [open, task.projectId, task.id]);
	// A task without a tree yet still shows its ongoing states (spec/notifications-slack-notes-and-schedules#notice-chips): the footer holds the chips alone.
	const tree = task.taskTree;
	if (!tree)
		return notices ? (
			<div className={styles.root} data-composer-environment data-notices-only>
				{notices}
			</div>
		) : null;
	// spec/tasks#agent-worktrees: a checkout of the root's repo from outside stands for the root; the task itself stays without isolation.
	const standIn = tree.scopeId,
		isolated = tree.worktree && !standIn,
		selected = task.launch?.scopes.filter((scope) => scope.selected) ?? [];
	const inPlaceRepo = isolated && selected.some((scope) => scope.kind === 'external');
	const base = isolated ? task.launch?.baseRef : undefined,
		counts = task.changeSummary,
		number = new Intl.NumberFormat(locale);
	const branch = tree.branch ?? t(locale, 'Detached HEAD'),
		label = `${t(locale, tree.worktree ? 'Worktree' : 'No isolation')} · ${branch}`;
	return (
		<div
			ref={root}
			className={styles.root}
			data-isolation={tree.worktree ? 'worktree' : 'in-place'}
			data-detached={tree.branch === null || undefined}
			data-open={open}
			data-composer-environment>
			<button
				ref={button}
				type="button"
				className={styles.open}
				aria-label={label}
				title={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => {
					island.current = button.current?.closest('form') ?? button.current;
					setOpen((value) => !value);
				}}>
				<Glyph name={tree.worktree ? 'sidebar-worktree' : 'sidebar-branch'} size={11} />
				{tree.branch === null ? (
					<span className={styles.branch}>{branch}</span>
				) : (
					<BranchName name={branch} className={styles.branch} />
				)}
				{counts && (counts.additions > 0 || counts.deletions > 0) && (
					<ChangeCounts
						additions={counts.additions}
						deletions={counts.deletions}
						locale={locale}
						className={styles.counts}
						data-composer-counts
					/>
				)}
				{base && (
					<span className={styles.base}>
						{t(locale, 'from')} {base}
					</span>
				)}
				{selected.length > 1 && (
					<span className={styles.repos}>
						{inPlaceRepo && <span className={styles.dot} aria-hidden="true" />}
						{number.format(selected.length)} {t(locale, 'repos')}
					</span>
				)}
			</button>
			{contended.length > 0 && (
				<ContentionChip task={task} locale={locale} placement="composer" scopes={contended} />
			)}
			{notices}
			<Popover
				id={id}
				open={open}
				onClose={() => setOpen(false)}
				anchor={island}
				returnFocus={button}
				side="top"
				width={340}
				label={t(locale, 'Task repos')}
				locale={locale}
				className={styles.popover}
				note={base ? `${t(locale, 'Worktree')} · ${t(locale, 'from')} ${base}` : undefined}>
				{failed ? (
					<p role="alert">{t(locale, 'Some data could not be read.')}</p>
				) : repos === null ? (
					<SkeletonRows count={3} height={36} />
				) : (
					<ul>
						{repos.map((repo) => {
							const inPlace = repo.id !== standIn && (!isolated || repo.kind === 'external');
							return (
								<li key={repo.id} data-in-place={inPlace || undefined}>
									<Glyph name={inPlace ? 'sidebar-branch' : 'sidebar-worktree'} size={11} />
									<span className={styles.name}>
										{repo.name === '.' ? (projectName ?? repo.name) : repo.name}
									</span>
									{repo.branch ? (
										<BranchName name={repo.branch} className={styles.repoBranch} />
									) : (
										<span className={styles.repoBranch}>{t(locale, 'Detached HEAD')}</span>
									)}
									{inPlace ? (
										<small>{t(locale, 'No isolation')}</small>
									) : (
										(repo.additions > 0 || repo.deletions > 0) && (
											<ChangeCounts
												additions={repo.additions}
												deletions={repo.deletions}
												locale={locale}
												className={styles.counts}
											/>
										)
									)}
								</li>
							);
						})}
					</ul>
				)}
			</Popover>
		</div>
	);
}
