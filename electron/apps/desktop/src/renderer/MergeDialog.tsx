import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
	commitCount,
	fileCount,
	relativeAge,
	t,
	type AgentTask,
	type BranchList,
	type GitBranch,
	type HistoryScope,
	type Locale,
	type MergePreview,
	type MergeState,
} from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { ClearField } from './ui/ClearField';
import { PopupClose } from './ui/PopupClose';
import { gitErrorText } from './git-errors';
import styles from './MergeDialog.module.css';
import { Spinner } from './ui/Loading';

type Props = {
	task: AgentTask;
	locale: Locale;
	scope: HistoryScope;
	repoName: string;
	into: string;
	branches: BranchList;
	onClose(): void;
	onMerged(): void;
	onConflicts(state: MergeState | null): void;
	onError(message: string): void;
};
type Step = 'pick' | 'confirm';

/**
 * spec/git#merge: «Куди» is the current branch; «Що змерджити» opens at once with focus in the search.
 * Another target would need a checkout of the task's working tree, so «Куди» does not change.
 */
export function MergeDialog({
	task,
	locale,
	scope,
	repoName,
	into,
	branches,
	onClose,
	onMerged,
	onConflicts,
	onError,
}: Props) {
	const dialog = useRef<HTMLDialogElement>(null),
		search = useRef<HTMLInputElement>(null);
	// Clearing the chosen branch brings the search field back: it is focused once React adds it, not in a timer that may come first.
	const [searchFocus, setSearchFocus] = useState(0);
	useLayoutEffect(() => {
		if (searchFocus) search.current?.focus();
	}, [searchFocus]);
	const [query, setQuery] = useState(''),
		[active, setActive] = useState(0),
		[from, setFrom] = useState<string | null>(null);
	const [preview, setPreview] = useState<MergePreview | null | 'loading'>(null),
		[step, setStep] = useState<Step>('pick');
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	const external = scope.kind === 'external' && task.launch?.isolation === 'worktree';

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null,
			element = dialog.current!;
		element.showModal();
		search.current?.focus({ preventScroll: true });
		return () => {
			if (element.open) element.close();
			previous?.focus?.({ preventScroll: true });
		};
	}, []);

	const candidates = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return branches.branches.filter(
			(branch) => branch.name !== into && (!needle || branch.name.toLowerCase().includes(needle))
		);
	}, [branches, into, query]);
	const recent = candidates.filter((branch) => !branch.remote),
		remote = candidates.filter((branch) => branch.remote),
		flat = [...recent, ...remote];
	useEffect(() => {
		setActive((index) => Math.min(index, Math.max(0, flat.length - 1)));
	}, [flat.length]);

	async function pick(branch: GitBranch) {
		setFrom(branch.name);
		setQuery('');
		setPreview('loading');
		setError('');
		try {
			setPreview(await window.brigadir.previewMerge(task, scope.id, into, branch.name));
		} catch (cause) {
			setPreview(null);
			setError(gitErrorText(locale, cause));
		}
	}
	function keys(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (flat.length)
				setActive(
					(index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length
				);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const branch = flat[active];
			if (branch) void pick(branch);
		}
	}
	async function merge() {
		if (!from) return;
		setBusy(true);
		setError('');
		try {
			const outcome = await window.brigadir.startMerge(task, scope.id, into, from);
			// spec/appearance#evolution-redesign: «did not resolve itself» — the parent opens the Conflicts dialog in place of this one.
			if (outcome.status === 'conflicts')
				onConflicts(await window.brigadir.readMergeState(task, scope.id));
			else onMerged();
		} catch (cause) {
			setError(gitErrorText(locale, cause));
			setStep('pick');
		} finally {
			setBusy(false);
		}
	}
	const close = () => {
		if (!busy) onClose();
	};
	const ready = from && preview && preview !== 'loading' && !preview.upToDate;
	const list = (title: string, items: GitBranch[], offset: number) =>
		items.length > 0 && (
			<>
				<div className={styles.group}>{title}</div>
				{items.map((branch, index) => (
					<div
						key={branch.name}
						id={`merge-branch-${offset + index}`}
						role="option"
						aria-selected={active === offset + index}
						className={styles.option}
						data-active={active === offset + index}
						onPointerMove={() => setActive(offset + index)}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => void pick(branch)}>
						<span>{branch.name}</span>
						<small>{relativeAge(locale, new Date(branch.updatedAt).toISOString())}</small>
					</div>
				))}
			</>
		);

	return createPortal(
		<dialog
			ref={dialog}
			className={styles.dialog}
			data-size="m"
			aria-labelledby="merge-title"
			onKeyDown={(event) => {
				if (event.key === 'Escape') event.stopPropagation();
			}}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}>
			<header className={styles.header}>
				<h2 id="merge-title">
					{t(
						locale,
						step === 'confirm' ? 'Merge into a repo outside the worktree?' : 'Merge a branch'
					)}
				</h2>
				<span className={styles.repo}>{repoName}</span>
				<PopupClose locale={locale} close={close} />
			</header>
			{step === 'pick' && (
				<div className={styles.body}>
					<label className={styles.label}>{t(locale, 'Into')}</label>
					<div className={styles.fixed} aria-readonly="true">
						<span>{into}</span>
						<small>{t(locale, 'current')}</small>
					</div>
					<label className={styles.label} htmlFor="merge-search">
						{t(locale, 'What to merge')}
					</label>
					{from && !query ? (
						<button
							type="button"
							className={styles.chosen}
							onClick={() => {
								setFrom(null);
								setPreview(null);
								setSearchFocus((value) => value + 1);
							}}>
							<span>{from}</span>
							<Glyph name="close" size={10} />
						</button>
					) : (
						<div className={styles.combo}>
							<div className={styles.search}>
								<Glyph name="search" size={12} />
								<input
									ref={search}
									id="merge-search"
									role="combobox"
									aria-expanded="true"
									aria-controls="merge-branches"
									aria-activedescendant={flat.length ? `merge-branch-${active}` : undefined}
									placeholder={t(locale, 'Search branches')}
									value={query}
									onChange={(event) => {
										setQuery(event.target.value);
										setActive(0);
									}}
									onKeyDown={keys}
								/>
								<ClearField
									locale={locale}
									value={query}
									onClear={() => {
										setQuery('');
										setActive(0);
									}}
								/>
								<small>{candidates.length}</small>
							</div>
							<div
								id="merge-branches"
								role="listbox"
								aria-label={t(locale, 'What to merge')}
								className={styles.menu}
								data-size="s">
								{list(t(locale, 'Recent'), recent, 0)}
								{recent.length > 0 && remote.length > 0 && <div className={styles.separator} />}
								{list(t(locale, 'Remote branches'), remote, recent.length)}
								{!flat.length && <p className={styles.empty}>{t(locale, 'No branches match')}</p>}
							</div>
						</div>
					)}
					<p className={styles.summary} role="status">
						{!from || !preview ? (
							t(locale, 'Select a branch')
						) : preview === 'loading' ? (
							<Spinner />
						) : preview.upToDate ? (
							t(locale, 'Already up to date')
						) : (
							<>
								{commitCount(locale, preview.commits)} · {fileCount(locale, preview.files.length)} ·{' '}
								<span data-warning={preview.conflicts.length > 0}>
									{t(
										locale,
										preview.conflicts.length ? 'Conflict expected' : 'No conflicts expected'
									)}
								</span>
								{preview.conflicts.length > 0 && (
									<span className={styles.paths}>{preview.conflicts.join(', ')}</span>
								)}
							</>
						)}
					</p>
				</div>
			)}
			{step === 'confirm' && (
				<div className={styles.body}>
					<p className={styles.confirm}>
						{t(
							locale,
							'The task runs in a worktree, but this repo stays in place: the merge writes to your working tree.'
						)}
					</p>
					<p className={styles.where}>
						<strong>{repoName}</strong>
					</p>
				</div>
			)}
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}
			<footer className={styles.footer}>
				<Button onClick={close} disabled={busy}>
					{t(locale, 'Cancel')}
				</Button>
				{step === 'pick' ? (
					<Button
						appearance="primary"
						disabled={!ready || busy}
						onClick={() => {
							if (external) setStep('confirm');
							else void merge();
						}}>
						{t(locale, 'Merge')}
					</Button>
				) : (
					<Button appearance="primary" disabled={busy} onClick={() => void merge()}>
						{t(locale, 'Merge here')}
					</Button>
				)}
			</footer>
		</dialog>,
		document.body
	);
}
