import { useCallback, useEffect, useRef, useState } from 'react';
import { onSessionEvent } from './session-events';
import { ReviewButton } from './TaskReview';
import {
	t,
	type AgentTask,
	type Locale,
	type CommitPreview,
	type CommitResult,
	type TimelineEntry,
	commitCount,
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	menuCommands,
} from '@brigadir/core';
import { useWorkspace } from './store';
import { mergeEnded, openCommitDialog } from './task-state';
import { useCommitRuns, pushRepos, repoDisplayName } from './commit-run';
import { useForge } from './Forge';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { DiffOptions } from './ui/DiffOptions';
import styles from './CommitStrip.module.css';
import { ChangeCounts } from './ui/ChangeCounts';
import { resolveToast, toastWarning } from './ui/Toast';
/**
 * spec/git#commit-dialog: the foot of the Diff tab is ONE row. Left — the snapshot picker
 * «Current snapshot · 14 ▾» (the funnel's «Compare snapshots» popover); right — the total `+N −M` of every repo and a soft
 * «Commit» that opens the commit dialog. Nothing to commit — the picker alone, same height. Just committed with
 * nothing left — `✓ a41c9e2` (or `✓ 3 commits`) and `Push` / `Push all` in the button's place; with changes left the SHA
 * line stays over the row. A merge or rebase that stopped, or a task still being prepared — the picker alone.
 */
export function CommitStrip({
	task,
	locale,
	snapshot,
	range,
	timeline,
	onRange,
	commit = true,
}: {
	task: AgentTask;
	locale: Locale;
	/** The picker's text: `Current snapshot · 14` / `Saved snapshots · 14`. */ snapshot: string;
	range: { base: number; current: number } | null;
	timeline: TimelineEntry[];
	onRange(value: { base: number; current: number } | null): void;
	/** False while the task is being prepared: the row keeps only the snapshot picker. */ commit?: boolean;
}) {
	const shortcuts = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap,
		forge = useForge(),
		running = useCommitRuns((state) =>
			Boolean(state.runs[`${task.projectId}/${task.id}`]?.running)
		);
	const [preview, setPreview] = useState<CommitPreview | null>(null),
		[result, setResult] = useState<CommitResult | null>(null),
		request = useRef(0),
		mounted = useRef(true),
		readFailed = useRef(false);
	// spec/git#conflicts: while a merge or rebase stopped in a repo of the task, the row steps aside: the Changes banner
	// («N conflicts · Resolve…», then «Conflicts resolved · Continue…») leads, and Continue in the dialog commits the merge.
	const [merging, setMerging] = useState(false);
	const refresh = useCallback(async () => {
		const id = ++request.current;
		const stopped = await window.brigadir.readMergeStates(task).then(
			(states) => states.length > 0,
			() => false
		);
		if (!mounted.current || request.current !== id) return;
		setMerging(stopped);
		if (stopped) {
			// The commit list cannot be read with unmerged files; that is the merge's state, not a failure.
			if (readFailed.current) resolveToast(t(locale, 'Could not read the commit list.'));
			readFailed.current = false;
			return;
		}
		try {
			const data = await window.brigadir.readCommits(task);
			if (mounted.current && request.current === id) {
				setPreview(data.preview);
				setResult(data.result);
				if (readFailed.current) resolveToast(t(locale, 'Could not read the commit list.'));
				readFailed.current = false;
			}
		} catch {
			if (mounted.current && request.current === id && !readFailed.current) {
				readFailed.current = true;
				toastWarning(t(locale, 'Could not read the commit list.'), {
					action: {
						label: t(locale, 'Retry'),
						run: () => {
							void refresh();
						},
					},
				});
			}
		}
	}, [task.id, task.projectId, locale]);
	useEffect(() => {
		mounted.current = true;
		void refresh();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ key, record }) => {
			if (
				key.id === task.id &&
				key.projectId === task.projectId &&
				(!record ||
					['turn.completed', 'checkpoint.created', 'file.saved', 'scopes.changed'].includes(
						record.event.kind
					))
			) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					void refresh();
				}, 2000);
			}
		});
		const focus = () => {
			void refresh();
		};
		window.addEventListener('focus', focus);
		window.addEventListener(mergeEnded, focus);
		return () => {
			mounted.current = false;
			request.current++;
			stop();
			clearTimeout(timer);
			window.removeEventListener('focus', focus);
			window.removeEventListener(mergeEnded, focus);
		};
	}, [refresh]);
	// The dialog's sequence ended (Esc may have hidden it before): the SHA line and the counts are read at once.
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running) void refresh();
		wasRunning.current = running;
	}, [running, refresh]);
	const files = preview?.scopes.flatMap((item) => item.files) ?? [],
		additions = files.reduce((sum, file) => sum + (file.diff?.additions ?? 0), 0),
		deletions = files.reduce((sum, file) => sum + (file.diff?.deletions ?? 0), 0),
		key = commandAccelerator(
			menuCommands.find((item) => item.id === 'commit')!,
			shortcuts
		);
	// The SHA line: one repo — its SHAs; a monorepo — each repo's name before its SHAs.
	const committed = [
		...(result?.committed ?? [])
			.reduce(
				(repos, item) =>
					repos.set(item.scopeId, {
						name: repoDisplayName(task, item.name),
						shas: [...(repos.get(item.scopeId)?.shas ?? []), item.sha.slice(0, 7)],
					}),
				new Map<string, { name: string; shas: string[] }>()
			)
			.entries(),
	];
	// Push stays while a committed repo has commits not on origin; without a forge snapshot of the repo it is offered too.
	const unpushed = forge
		? committed
				.map(([id]) => id)
				.filter((id) => {
					const item = forge.data?.scopes.find((value) => value.scope.id === id);
					return !item || item.git.pushAhead > 0;
				})
		: [];
	const shas = committed
			.map(([, repo]) => `${committed.length > 1 ? `${repo.name} ` : ''}${repo.shas.join(' ')}`)
			.join(' · '),
		total = result?.committed.length ?? 0,
		active = commit && !merging,
		// Nothing left after the commit: the result takes the button's place in the row.
		inline = active && !files.length && total > 0,
		push =
			unpushed.length > 0 && forge ? (
				inline ? (
					<Button
						appearance="primary"
						variant="soft"
						title={t(locale, 'Push commits · {commits}').replace('{commits}', shas)}
						onClick={() => pushRepos(forge, unpushed)}>
						{t(locale, unpushed.length > 1 ? 'Push all' : 'Push')}
					</Button>
				) : (
					<>
						<span aria-hidden="true">·</span>
						<Button appearance="primary" variant="ghost" onClick={() => pushRepos(forge, unpushed)}>
							{t(locale, unpushed.length > 1 ? 'Push all' : 'Push')}
						</Button>
					</>
				)
			) : null;
	return (
		<section className={styles.root} aria-label={t(locale, 'Commit')}>
			{active && result && (
				<>
					{committed.length > 0 && files.length > 0 && (
						<div className={styles.done} role="status" data-size="s">
							<span>
								{t(locale, 'Committed')}{' '}
								{committed.map(([id, repo], index) => (
									<span key={id}>
										{index > 0 && ' · '}
										{committed.length > 1 && `${repo.name} `}
										{repo.shas.map((sha, at) => (
											<span key={sha}>
												{at > 0 && ' '}
												<code>{sha}</code>
											</span>
										))}
									</span>
								))}
							</span>
							{push}
						</div>
					)}
					{result.error && <p className={styles.error}>{result.error}</p>}
				</>
			)}
			<div className={styles.row} data-size="s">
				<DiffOptions
					locale={locale}
					range={range}
					timeline={timeline}
					onRange={onRange}
					snapshot={snapshot}
				/>
				<span />
				{active && files.length > 0 && (
					<>
						<ChangeCounts
							additions={additions}
							deletions={deletions}
							locale={locale}
							className={styles.counts}
							split
						/>
						{/* spec/diff-and-review#agent-review-surfaces: `Review…` beside Commit, with the review's state. */}
						<ReviewButton task={task} locale={locale} />
						{/* While the dialog's commits run (it may be hidden), the button keeps its width, a spinner in place of the name. */}
						<Button
							appearance="primary"
							variant="soft"
							className={styles.open}
							data-busy={running || undefined}
							aria-disabled={running || undefined}
							aria-label={running ? t(locale, 'Committing…') : undefined}
							title={
								!running && key ? `${t(locale, 'Commit…')} · ${formatAccelerator(key)}` : undefined
							}
							onClick={() => {
								if (!running) openCommitDialog(task);
							}}>
							<span>{t(locale, 'Commit changes')}</span>
							{running && (
								<i>
									<Glyph name="agent-spinner" size={12} />
								</i>
							)}
						</Button>
					</>
				)}
				{inline && (
					<>
						<span className={styles.ok} role="status" title={`${t(locale, 'Committed')} ${shas}`}>
							<Glyph name="check-pass" size={12} />
							{total === 1 ? <code>{committed[0]![1].shas[0]}</code> : commitCount(locale, total)}
						</span>
						{push}
					</>
				)}
				{/* spec/diff-and-review#agent-review-surfaces: with everything committed `Review…` stays — the review reads the task's changes, not the uncommitted ones. */}
				{active && !files.length && <ReviewButton task={task} locale={locale} />}
			</div>
		</section>
	);
}
