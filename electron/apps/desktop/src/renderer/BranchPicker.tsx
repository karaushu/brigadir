import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import {
	CARRY_CONFLICT_MESSAGE,
	FETCH_FAILED,
	localName,
	commitCount,
	fileCount,
	t,
	uncommittedCount,
	validBranch,
	type BranchSwitchState,
	type Locale,
	type StashEntry,
	type SwitchBranch,
	type SwitchMode,
} from '@brigadir/core';
import { Button, ChoiceButton, Popup } from './ui/Controls';
import { TextInput } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import { ChangeCounts } from './ui/ChangeCounts';
import { MenuItem, MenuList, MenuSection, MenuSeparator, Popover } from './ui/Popover';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { showToast, toastError, toastWarning } from './ui/Toast';
import { formatDateTime } from '@brigadir/core';
import { useWorkspace } from './store';
import { showTaskDiff } from './task-state';
import styles from './BranchPicker.module.css';
import { SkeletonRows } from './ui/Loading';

/** A main-tree repo the picker works on: the project and the repo's id and name as the row shows it. */
export type BranchRepo = { projectId: string; scopeId: string; name: string };

const failure = (error: unknown) => String(error instanceof Error ? error.message : error);
/** The ↓/↑ of a local branch against its upstream; «current» for the checked-out one (spec/git#main-tree-branches). */
export function branchTail(locale: Locale, branch: SwitchBranch) {
	if (branch.current) return t(locale, 'current');
	if (branch.worktree) return 'worktree';
	return (
		[branch.behind ? `↓${branch.behind}` : '', branch.ahead ? `↑${branch.ahead}` : '']
			.filter(Boolean)
			.join(' ') || undefined
	);
}
export function worktreeReason(locale: Locale, branch: SwitchBranch) {
	return branch.worktreeTask
		? t(locale, 'Checked out in the worktree of {task}.').replace('{task}', branch.worktreeTask)
		: t(locale, 'Checked out in another worktree.');
}
const matches = (branch: SwitchBranch, query: string) =>
	!query || branch.name.toLocaleLowerCase().includes(query.toLocaleLowerCase());

/** Opens the main tree of the repo on Changes with the commit bar (spec/git#main-tree-branches «Commit first»). */
export async function commitFirst(repo: BranchRepo) {
	const tree = await useWorkspace.getState().openMainTree(repo.projectId, repo.scopeId);
	showTaskDiff(tree);
}

/** Runs a switch and says how it went; the toasts carry the next step (spec/git#main-tree-branches). */
export async function runSwitch(
	repo: BranchRepo,
	locale: Locale,
	branch: string,
	mode: SwitchMode,
	extra: { discardPaths?: string[]; offline?: boolean } = {}
): Promise<boolean> {
	try {
		const result = await window.brigadir.switchBranchTo(repo.projectId, repo.scopeId, {
			branch,
			mode,
			...extra,
		});
		const text = `${repo.name} → ${result.current}${result.pulled ? ` · ${t(locale, 'pulled {commits}').replace('{commits}', commitCount(locale, result.pulled))}` : ''}${result.stash ? `. ${t(locale, 'Changes stashed.')}` : ''}`;
		if (result.stash) {
			const sha = result.stash;
			showToast(text, {
				label: t(locale, 'Restore'),
				run: () => {
					void restoreStash(repo, locale, sha);
				},
			});
		} else showToast(text);
		return true;
	} catch (error) {
		const message = failure(error);
		if (message.includes(FETCH_FAILED))
			toastError(t(locale, 'Could not switch: origin is unreachable.'), {
				action: {
					label: t(locale, 'Switch without pull'),
					run: () => {
						void runSwitch(repo, locale, branch, mode, { ...extra, offline: true });
					},
				},
			});
		else if (message.includes(CARRY_CONFLICT_MESSAGE))
			toastWarning(
				t(locale, 'Your changes conflict with {branch}. Nothing was changed.').replace(
					'{branch}',
					branch
				),
				{
					bold: branch,
					action: {
						label: t(locale, 'Stash and switch'),
						run: () => {
							void runSwitch(repo, locale, branch, 'stash');
						},
					},
				}
			);
		else
			toastError(gitFailure(locale, message, 'Could not switch the branch.'), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void runSwitch(repo, locale, branch, mode, extra);
					},
				},
			});
		return false;
	}
}
/** A refusal main explains in words the person can act on; anything else is the action's own failure. */
function gitFailure(locale: Locale, message: string, fallback: Parameters<typeof t>[1]) {
	if (message.includes('without isolation'))
		return t(locale, 'The repo is busy with another task.');
	if (message.includes('Another Git operation'))
		return t(locale, 'Another Git operation is in progress.');
	if (message.includes('already exists'))
		return t(locale, 'A branch with this name already exists.');
	if (message.includes('a diverged branch pulls by rebase'))
		return t(locale, 'Commit or stash the changes first: a diverged branch pulls by rebase.');
	if (message.includes('diverged'))
		return t(locale, 'The branch has diverged from origin. Pull only fast-forwards.');
	if (message.includes('already on origin'))
		return t(locale, 'The commit is already on origin. Only a new commit (revert) can undo it.');
	return t(locale, fallback);
}
export async function restoreStash(repo: BranchRepo, locale: Locale, sha: string) {
	try {
		await window.brigadir.restoreStash(repo.projectId, repo.scopeId, sha);
		showToast(t(locale, 'Restored from the stash.'));
	} catch {
		toastWarning(
			t(locale, 'Could not restore: the changes conflict. The entry stays in the stash.')
		);
	}
}
/** A git tool of the row menu: the action, a toast with what happened, a retry when it failed. */
export async function gitAction<T>(
	locale: Locale,
	work: () => Promise<T>,
	done: (value: T) => string | null,
	fallback: Parameters<typeof t>[1] = 'The git action failed.'
): Promise<void> {
	try {
		const value = await work(),
			text = done(value);
		if (text) showToast(text);
	} catch (error) {
		toastError(gitFailure(locale, failure(error), fallback), {
			action: {
				label: t(locale, 'Retry'),
				run: () => {
					void gitAction(locale, work, done, fallback);
				},
			},
		});
	}
}

type Step =
	| { kind: 'list' }
	| { kind: 'dirty'; target: string }
	| { kind: 'new'; name: string; base: string };

/**
 * spec/git#main-tree-branches: the branch picker of a main-tree repo — the list with search, the dirty step, a new branch. One popover;
 * Esc in a step goes back to the list, Esc in the list closes it.
 */
export function BranchPicker({
	repo,
	anchor,
	returnFocus,
	open,
	onClose,
	locale,
	start = 'list',
}: {
	repo: BranchRepo;
	anchor: RefObject<HTMLElement | null>;
	/** The branch button when the popover stands over the whole row. */ returnFocus?: RefObject<HTMLElement | null>;
	open: boolean;
	onClose(): void;
	locale: Locale;
	/** `new` — the menu's «New branch…» opens the picker on its step. */ start?: 'list' | 'new';
}) {
	const [data, setData] = useState<BranchSwitchState | null>(null),
		[step, setStep] = useState<Step>({ kind: 'list' }),
		[query, setQuery] = useState(''),
		[busy, setBusy] = useState(false),
		[discarding, setDiscarding] = useState<string | null>(null);
	const search = useRef<HTMLInputElement>(null),
		name = useRef<HTMLInputElement>(null),
		root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Each open reads again, and a closed picker forgets: a tree changed since must reach the dirty step, never a stale list.
		if (!open) {
			setData(null);
			return;
		}
		let active = true;
		setStep({ kind: 'list' });
		setQuery('');
		setBusy(false);
		// The local refs show at once; the fetch of the remotes refreshes the list behind them.
		let first = true;
		const loaded = (value: BranchSwitchState) => {
			if (!active) return;
			setData(value);
			if (first && start === 'new') {
				first = false;
				setStep({
					kind: 'new',
					name: '',
					base:
						value.branches.find((branch) => branch.current)?.upstream ?? value.current ?? 'main',
				});
			}
		};
		void window.brigadir.readBranchSwitch(repo.projectId, repo.scopeId).then(loaded, () => {});
		void window.brigadir
			.readBranchSwitch(repo.projectId, repo.scopeId, true)
			.then(loaded, () => {});
		return () => {
			active = false;
		};
	}, [open, start, repo.projectId, repo.scopeId]);
	// Esc inside a step: one step back (window capture runs before the popover's own Esc on document).
	useEffect(() => {
		if (!open || step.kind === 'list' || discarding) return;
		const key = (event: KeyboardEvent) => {
			if (
				event.key !== 'Escape' ||
				(!root.current?.contains(document.activeElement) &&
					document.activeElement !== document.body)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			setStep({ kind: 'list' });
			requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
		};
		addEventListener('keydown', key, true);
		return () => removeEventListener('keydown', key, true);
	}, [open, step.kind, discarding]);
	useEffect(() => {
		requestAnimationFrame(() => {
			if (step.kind === 'new') name.current?.focus({ preventScroll: true });
			else if (step.kind === 'dirty')
				root.current
					?.querySelector<HTMLElement>('button')
					?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
		});
	}, [step.kind]);
	const local = data?.branches.filter((branch) => !branch.remote && matches(branch, query)) ?? [],
		remote = data?.branches.filter((branch) => branch.remote && matches(branch, query)) ?? [];
	const held = data?.heldBy ?? null,
		first = [...local, ...remote].find((branch) => !branch.worktree && !branch.current);
	async function run(target: string, mode: SwitchMode, extra: { discardPaths?: string[] } = {}) {
		setBusy(true);
		const ok = await runSwitch(repo, locale, target, mode, extra);
		setBusy(false);
		if (ok) onClose();
	}
	function pick(branch: SwitchBranch) {
		if (!data || held || branch.worktree) return;
		if (branch.current) {
			onClose();
			return;
		}
		if (data.dirty.length) setStep({ kind: 'dirty', target: branch.name });
		else void run(branch.name, 'clean');
	}
	const currentUpstream = data?.branches.find((branch) => branch.current)?.upstream;
	const newBranch = () =>
		setStep({ kind: 'new', name: query.trim(), base: currentUpstream ?? data?.current ?? 'main' });
	const target =
		step.kind === 'dirty'
			? data?.branches.find((branch) => branch.name === step.target)
			: undefined;
	const title =
		step.kind === 'dirty'
			? `${data?.current ?? 'HEAD'} → ${target ? localName(target) : step.target}`
			: step.kind === 'new'
				? `${t(locale, 'New branch')} · ${repo.name}`
				: `Branch · ${repo.name}`;
	const row = (branch: SwitchBranch) => (
		<Fragment key={branch.name}>
			<MenuItem
				kind="radio"
				keepOpen
				checked={branch.current}
				disabled={!!held || !!branch.worktree || busy}
				tail={branchTail(locale, branch)}
				reason={branch.worktree && !held ? worktreeReason(locale, branch) : undefined}
				data-branch={branch.name}
				onSelect={() => pick(branch)}>
				<code className={styles.name}>{branch.name}</code>
			</MenuItem>
		</Fragment>
	);
	const bases = branchBases(data);
	return (
		<>
			<Popover
				open={open}
				onClose={onClose}
				anchor={anchor}
				returnFocus={returnFocus}
				label={title}
				locale={locale}
				width={320}
				side="top"
				className={styles.picker}
				data-branch-picker={step.kind}
				initialFocus={(popover) => popover.querySelector<HTMLElement>('input')}>
				<div ref={root} className={styles.content}>
					{step.kind === 'list' && (
						<>
							{held && (
								<div className={styles.note} role="status">
									<Glyph name="scope-lock" size={12} />
									<span>
										{t(
											locale,
											'The task {task} is working in {repo} without isolation. You can switch the branch once it stops.'
										)
											.replace('{task}', held.title)
											.replace('{repo}', repo.name)}
									</span>
								</div>
							)}
							{held && (
								<div className={styles.noteAction} data-size="s">
									<Button
										size="s"
										onClick={() => {
											useWorkspace.getState().selectTask(held.projectId, held.id);
											onClose();
										}}>
										{t(locale, 'Open task')}
									</Button>
								</div>
							)}
							<label className={styles.search} data-idle={!!held || undefined}>
								<Glyph name="search" size={12} />
								<input
									ref={search}
									type="search"
									aria-label={t(locale, 'Search branches')}
									placeholder={t(locale, 'Search branches')}
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											if (first) pick(first);
											else if (!held && query.trim()) newBranch();
										} else if (event.key === 'ArrowDown') {
											event.preventDefault();
											root.current
												?.querySelector<HTMLElement>('[role^=menuitem]:not(:disabled)')
												?.focus({ preventScroll: true });
										}
									}}
								/>
								<ClearField locale={locale} value={query} onClear={() => setQuery('')} />
							</label>
							<MenuList label="Branch" before={search}>
								{/* The popover opens at once and places itself by its first height: the rows hold it from the start. */}
								{!data && <SkeletonRows count={6} height={28} single delay={0} />}
								{local.length > 0 && <MenuSection>{t(locale, 'Local branches')}</MenuSection>}
								{local.map(row)}
								{remote.length > 0 && <MenuSection>{t(locale, 'Remote branches')}</MenuSection>}
								{remote.map(row)}
								{data && !local.length && !remote.length && (
									<p className={styles.empty}>{t(locale, 'No branches match')}</p>
								)}
								{!held && data && (
									<>
										<MenuSeparator />
										<MenuItem
											keepOpen
											icon={<Glyph name="plus" size={12} />}
											disabled={busy}
											onSelect={newBranch}>
											{t(locale, 'New branch…')}
											{query.trim() && (
												<>
													{' '}
													<code className={styles.name}>{query.trim()}</code>
												</>
											)}
										</MenuItem>
									</>
								)}
							</MenuList>
						</>
					)}
					{step.kind === 'dirty' && data && (
						<>
							<div className={styles.note} role="status">
								<Glyph name="review-warning" size={14} />
								<span>
									<strong>{uncommittedCount(locale, data.dirty.length)}</strong> · {repo.name}.{' '}
									{t(locale, 'Git won’t switch the branch while they are in the tree.')}
								</span>
							</div>
							<ul className={styles.files}>
								{data.dirty.slice(0, 8).map((file) => (
									<li key={file.path}>
										<span className={styles.status}>{file.status}</span>
										<span className={styles.path}>{file.path}</span>
										<ChangeCounts
											additions={file.additions}
											deletions={file.deletions}
											locale={locale}
											nonzero
											split
										/>
									</li>
								))}
								{data.dirty.length > 8 && (
									<li className={styles.more}>+{fileCount(locale, data.dirty.length - 8)}</li>
								)}
							</ul>
							<div className={styles.choices}>
								<ChoiceButton
									appearance="primary"
									disabled={busy}
									title={t(locale, 'Stash and switch')}
									description={t(
										locale,
										'The changes go to the stash. Bring them back from ⋯ ▸ Restore from stash.'
									)}
									onClick={() => {
										void run(step.target, 'stash');
									}}
								/>
								<ChoiceButton
									disabled={busy}
									title={t(locale, 'Bring the changes')}
									description={t(locale, 'Works when {branch} doesn’t touch these files.').replace(
										'{branch}',
										step.target
									)}
									onClick={() => {
										void run(step.target, 'carry');
									}}
								/>
								<ChoiceButton
									disabled={busy}
									title={t(locale, 'Commit first')}
									onClick={() => {
										onClose();
										void commitFirst(repo);
									}}
								/>
								<ChoiceButton
									appearance="danger"
									disabled={busy}
									title={t(locale, 'Discard and switch…')}
									description={t(locale, 'The changes are lost. You confirm first.')}
									onClick={() => setDiscarding(step.target)}
								/>
							</div>
							<div className={styles.footer} data-size="s">
								<Button size="s" variant="ghost" onClick={() => setStep({ kind: 'list' })}>
									<Glyph name="chevron-left" size={12} />
									{t(locale, 'To the list')}
								</Button>
							</div>
						</>
					)}
					{step.kind === 'new' && (
						<NewBranchForm
							locale={locale}
							bases={bases}
							name={step.name}
							base={step.base}
							busy={busy}
							action={t(locale, 'Create and switch')}
							inputRef={name}
							change={(name, base) => setStep({ kind: 'new', name, base })}
							cancel={() => setStep({ kind: 'list' })}
							submit={() => {
								void create();
							}}
						/>
					)}
				</div>
			</Popover>
			{discarding && data && (
				<ConfirmDialog
					locale={locale}
					danger
					title={t(locale, 'Discard changes in {repo}?').replace('{repo}', repo.name)}
					action={t(locale, 'Discard')}
					cancel={() => setDiscarding(null)}
					confirm={async () => {
						const target = discarding;
						setDiscarding(null);
						await run(target, 'discard', {
							discardPaths: data.dirty.filter((file) => file.untracked).map((file) => file.path),
						});
					}}>
					<p>
						<strong>{fileCount(locale, data.dirty.length)}</strong>.{' '}
						{t(
							locale,
							'They go back to the last commit, and new files are deleted. This cannot be undone.'
						)}
					</p>
				</ConfirmDialog>
			)}
		</>
	);
	async function create() {
		if (step.kind !== 'new' || !validBranch(step.name)) return;
		setBusy(true);
		try {
			const result = await window.brigadir.createMainTreeBranch(repo.projectId, repo.scopeId, {
				name: step.name,
				base: step.base,
			});
			showToast(`${repo.name} → ${result.current}`);
			onClose();
		} catch (error) {
			toastError(gitFailure(locale, failure(error), 'Could not switch the branch.'));
		} finally {
			setBusy(false);
		}
	}
}

/** spec/git#main-tree-branches: the name and the base of a new branch — a step of the picker, and the sheet's «New branch…» (rule 17). */
export function NewBranchForm({
	locale,
	bases,
	name,
	base,
	busy = false,
	action,
	inputRef,
	change,
	cancel,
	submit,
}: {
	locale: Locale;
	bases: string[];
	name: string;
	base: string;
	busy?: boolean;
	action: string;
	inputRef?: RefObject<HTMLInputElement | null>;
	change(name: string, base: string): void;
	cancel(): void;
	submit(): void;
}) {
	return (
		<>
			<label className={styles.field}>
				<span>{t(locale, 'Name')}</span>
				<TextInput
					ref={inputRef}
					size="m"
					value={name}
					aria-invalid={!!name && !validBranch(name)}
					onChange={(event) => change(event.target.value, base)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && validBranch(name)) {
							event.preventDefault();
							submit();
						}
					}}
				/>
			</label>
			<div className={styles.field}>
				<span>{t(locale, 'from')}</span>
				<Popup
					size="m"
					label={t(locale, 'Base ref')}
					search={{
						placeholder: t(locale, 'Search branches'),
						empty: t(locale, 'No branches match'),
						clear: t(locale, 'Clear the field'),
					}}
					value={base}
					options={[...(bases.includes(base) ? [] : [base]), ...bases].map((value) => ({
						value,
						label: value,
					}))}
					onChange={(next) => change(name, next)}
				/>
			</div>
			<p className={styles.hint}>{t(locale, 'Uncommitted changes move to the new branch.')}</p>
			<div className={styles.footer} data-size="m" data-end>
				<Button onClick={cancel}>{t(locale, 'Cancel')}</Button>
				<Button appearance="primary" disabled={busy || !validBranch(name)} onClick={submit}>
					{action}
				</Button>
			</div>
		</>
	);
}
/** Every name a new branch can start from: the branches and the upstreams of the local ones. */
export function branchBases(state: BranchSwitchState | null) {
	return [
		...new Set(
			(state?.branches.flatMap((branch) => [branch.upstream, branch.name]) ?? []).filter(
				(value): value is string => !!value
			)
		),
	];
}

/** spec/git#main-tree-branches «Restore from stash…»: the entries with where they came from; Restore and the bin on hover. */
export function StashPopover({
	repo,
	anchor,
	open,
	onClose,
	locale,
}: {
	repo: BranchRepo;
	anchor: RefObject<HTMLElement | null>;
	open: boolean;
	onClose(): void;
	locale: Locale;
}) {
	const [entries, setEntries] = useState<StashEntry[] | null>(null),
		[dropping, setDropping] = useState<StashEntry | null>(null);
	const read = () =>
		window.brigadir
			.readStashes(repo.projectId, repo.scopeId)
			.then(setEntries, () => setEntries([]));
	useEffect(() => {
		if (open) {
			setEntries(null);
			void read();
		}
	}, [open]);
	return (
		<>
			<Popover
				open={open}
				onClose={onClose}
				anchor={anchor}
				label={`${t(locale, 'Stash')} · ${repo.name}`}
				locale={locale}
				width={320}
				side="top"
				align="end"
				data-stash-popover>
				<ul className={styles.stashes}>
					{entries?.map((entry) => (
						<li key={entry.sha} className={styles.stash} data-stash={entry.sha}>
							<Glyph name="git-stash" size={12} />
							<span className={styles.two}>
								<b>
									{entry.branch ?? 'HEAD'} · {fileCount(locale, entry.files)}
								</b>
								<small>
									{entry.ours && /→ (.+)$/.test(entry.message)
										? t(locale, 'before switching to {branch}').replace(
												'{branch}',
												/→ (.+)$/.exec(entry.message)![1]!
											)
										: entry.ours
											? t(locale, 'by hand')
											: entry.message}{' '}
									· {formatDateTime(entry.time)}
								</small>
							</span>
							<span className={styles.stashActions} data-size="s">
								<Button
									size="s"
									variant="ghost"
									appearance="primary"
									onClick={() => {
										onClose();
										void restoreStash(repo, locale, entry.sha);
									}}>
									{t(locale, 'Restore')}
								</Button>
								<Button
									size="s"
									variant="ghost"
									aria-label={t(locale, 'Delete…')}
									title={t(locale, 'Delete…')}
									onClick={() => setDropping(entry)}>
									<Glyph name="trash" size={12} />
								</Button>
							</span>
						</li>
					))}
					{entries && !entries.length && (
						<li className={styles.empty}>{t(locale, 'No stash entries.')}</li>
					)}
					{!entries && (
						<li>
							<SkeletonRows count={3} height={34} />
						</li>
					)}
				</ul>
				{!!entries?.length && (
					<p className={styles.hint}>
						{t(
							locale,
							'«Restore» puts the changes into the current branch and removes the entry. On a conflict the entry stays.'
						)}
					</p>
				)}
			</Popover>
			{dropping && (
				<ConfirmDialog
					locale={locale}
					danger
					title={t(locale, 'Delete the stash entry?')}
					action={t(locale, 'Delete')}
					cancel={() => setDropping(null)}
					confirm={async () => {
						await window.brigadir.dropStash(repo.projectId, repo.scopeId, dropping.sha);
						setDropping(null);
						await read();
					}}>
					<p>
						<strong>
							{dropping.branch ?? 'HEAD'} · {fileCount(locale, dropping.files)}
						</strong>
						. {t(locale, 'The changes in it will be lost. This cannot be undone.')}
					</p>
				</ConfirmDialog>
			)}
		</>
	);
}
