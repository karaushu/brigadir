import { HelperCapsule, useHelperRun } from './HelperAgent';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	fileCount,
	mergeBlock,
	mergeBlockLabels,
	mergeControlState,
	prAge,
	t,
	type AgentTask,
	type Locale,
	type PRAgentAnswer,
	type PRRefKey,
	type PRSummary,
	type PRSummaryItem,
	type PRThread,
	type PullRequestDetail,
	type PRMergeMethod,
	type FileDiff,
	keepsBranch,
	isOpenPR,
} from '@brigadir/core';
import { readDetail, usePRReview } from './pr-review';
import { generateSummary, usePRSummary } from './pr-summary';
import { StartReviewButton } from './PRReviewModal';
import { usePullRequests } from './PullRequests';
import { Avatar, CommitRow, PRStateGlyph } from './PullRequestPanel';
import { CommentText, PRLinkContext } from './PRThreads';
import { useFitRow } from './ui/fit-row';
import { Glyph } from './ui/Glyph';
import { Button, Choice, IconButton, Segments, SplitButton } from './ui/Controls';
import { MenuItem, MenuPopover } from './ui/Popover';
import { TextArea, TextInput } from './ui/Input';
import { PopupClose } from './ui/PopupClose';
import { showToast, toastError } from './ui/Toast';
import { mergedState, useCIRuns } from './CIRuns';
import { CIGlyph, currentStep, ciDuration } from './ui/RunSteps';
import { openTaskPR } from './task-state';
import { Delayed, LoadingStatus, Skeleton } from './ui/Loading';
import styles from './PROverview.module.css';
import { primaryKey } from './ui/primary-key';

type Filter = 'all' | 'comments' | 'commits' | 'checks';
type Glyphs = Parameters<typeof Glyph>[0]['name'];
type Entry =
	| { id: string; at: string; kind: 'thread'; thread: PRThread }
	| {
			id: string;
			at: string;
			kind: 'comment';
			author: string;
			body: string;
			url: string;
			label?: string;
	  }
	| { id: string; at: string; kind: 'commits'; commits: PullRequestDetail['commits'] }
	| { id: string; at: string; kind: 'check'; check: PullRequestDetail['checks'][number] };
export type OverviewLinks = {
	openFile(
		path: string,
		line: number | null,
		crumb?: { text: string; start: number | null; end: number | null }
	): void;
	openCommitFile?: ((sha: string, diff: FileDiff, fileId: string) => void) | undefined;
	handToAgent?: ((text: string) => Promise<boolean>) | undefined;
	/** spec/pull-requests-and-ci#resolve-conflicts: the reason in words when it did not start; null — started. */ resolveConflicts?:
		((how: 'agent' | 'manual') => Promise<string | null>) | undefined;
};
/** Below this Overview width the cards stand in a column; the header row measures its own fit (`useFitRow`). */
const cardsNarrow = 640;
/**
 * spec/pull-requests-and-ci#pr-overview: Overview — the PR's full page in an editor tab: a summary (reviewers, checks, merge), the description,
 * a filtered timeline, «Спитати агента» under each comment, a field at the bottom addressed `У PR | Агенту`; `Згенерувати підсумок`
 * (spec/pull-requests-and-ci#pr-summary), `Змерджити PR…` only at `CLEAN` (spec/pull-requests-and-ci#merge).
 */
export function PROverview({
	task,
	target,
	locale,
	projectName,
	links,
}: {
	task: AgentTask;
	target: PRRefKey;
	locale: Locale;
	projectName: string;
	links: OverviewLinks;
}) {
	const { detail, detailError, busy, actions } = usePRReview(task, target),
		[filter, setFilter] = useState<Filter>('all'),
		shared = usePRSummary(task, target),
		// spec/appearance#evolution-redesign: the same cache as the review modal; Overview shows the summary of the current head only.
		summary = shared.summary && shared.summary.headSha === detail?.headSha ? shared.summary : null,
		summaryBusy = shared.busy,
		summaryError =
			shared.error && shared.error !== 'failed'
				? t(locale, 'The summary could not be generated: {reason}').replace(
						'{reason}',
						shared.error
					)
				: shared.error
					? t(locale, 'The summary could not be generated.')
					: '';
	const [answers, setAnswers] = useState<Record<string, PRAgentAnswer | 'loading' | 'error'>>({});
	const entries = useMemo(() => (detail ? timeline(detail) : []), [detail]);
	// spec/pull-requests-and-ci#ci: a merged PR — the deploy in the «Мердж» card and as a timeline row; a 5 s cache shares the read with the Checks tab.
	const mergeSha = detail?.summary.state === 'MERGED' ? (detail.mergeSha ?? null) : null,
		ci = useCIRuns(
			task,
			locale,
			mergeSha ? target.scopeId : null,
			mergeSha ? { sha: mergeSha } : null,
			() => true,
			`#${target.number}`
		),
		after = mergeSha ? mergedState(ci, locale) : null;
	// Every hook stands above the early return: a hook after it threw React #310 when the PR was read after the first render.
	const helper = useHelperRun('prSummary'),
		// The header gives way when its words no longer fit beside a title of 120 px (measured, spec/appearance#evolution-redesign): «Start
		// review», the capsules and «Merge PR…» become glyphs, the title ends in «…». The cards stand in a column under
		// `cardsNarrow` or with the narrow header (`data-narrow`).
		fit = useFitRow(
			[locale, detail?.summary.state, helper.settings, helper.catalogs, helper.run],
			cardsNarrow
		),
		narrow = fit.narrow,
		scopeName = usePullRequests()?.data?.repos.find(
			(item) => item.scopeId === target.scopeId
		)?.name;
	if (!detail)
		return (
			<div className={styles.page} data-pr-overview>
				{detailError ? (
					<p className={styles.hint} role="alert">
						{t(locale, 'The PR could not be read.')}
					</p>
				) : (
					// spec/appearance#loading: the Overview's own blocks as bars — the header, the description, the timeline — with the short
					// network line under them, after 150 ms.
					<Delayed>
						<header className={styles.header} aria-hidden="true">
							<Skeleton widths={[58, 34]} />
						</header>
						<div className={styles.body}>
							<Skeleton widths={[94, 86, 60]} />
							<Skeleton widths={[40, 88, 70]} />
							<Skeleton widths={[36, 76, 52]} />
							<LoadingStatus label={t(locale, 'Reading the PR from GitHub…')} under delay={0} />
						</div>
					</Delayed>
				)}
			</div>
		);
	const pr = detail.summary,
		unresolved = detail.threads.filter((thread) => !thread.resolved).length;
	const shown = entries.filter(
		(entry) =>
			filter === 'all' ||
			(filter === 'comments' && (entry.kind === 'thread' || entry.kind === 'comment')) ||
			(filter === 'commits' && entry.kind === 'commits') ||
			(filter === 'checks' && entry.kind === 'check')
	);
	async function generate() {
		await generateSummary(task, target, helper.run);
	}
	async function ask(id: string, question: { threadId: string } | { question: string }) {
		setAnswers((value) => ({ ...value, [id]: 'loading' }));
		try {
			const answer = await window.brigadir.askPullRequestAgent(task, target, question);
			setAnswers((value) => ({ ...value, [id]: answer }));
		} catch {
			setAnswers((value) => ({ ...value, [id]: 'error' }));
		}
	}
	/** spec/notifications-slack-notes-and-schedules#message-classes: a comment GitHub did not take is a toast; the composer keeps the text. */
	const post = async (body: string) => {
		const done = await actions.comment(body);
		if (!done) toastError(t(locale, 'GitHub did not accept the comment.'));
		return done;
	};
	const drop = (id: string) =>
		setAnswers((value) => {
			const next = { ...value };
			delete next[id];
			return next;
		});
	const repo = !scopeName || scopeName === '.' ? projectName : scopeName;
	const commits = detail.commits.length,
		passed = detail.checks.filter(
			(check) => check.state === 'pass' || check.state === 'skipping'
		).length;
	const openLink = (url: string) => {
		void window.brigadir
			.openPullRequestLink(task.projectId, task.id, target.scopeId, url)
			.catch(() => {});
	};
	return (
		<PRLinkContext.Provider value={openLink}>
			<div
				ref={fit.boxRef}
				className={styles.page}
				data-pr-overview={target.number}
				data-narrow={narrow || fit.below || undefined}>
				<header className={styles.header}>
					<div ref={fit.rowRef} className={styles.titleRow} data-size="m">
						<PRStateGlyph pr={pr} />
						<h1 title={pr.title}>{pr.title}</h1>
						<span className={styles.number}>#{pr.number}</span>
						<span className={styles.space} />
						{/* A narrow tab (about 400 px): when the words do not fit the title keeps 120 px and ends in «…»,
						    «Start review», the capsule and «Merge PR…» are glyphs with their names in the tooltips. */}
						{isOpenPR(pr) && (
							<StartReviewButton locale={locale} task={task} target={target} iconOnly={narrow} />
						)}
						{/* spec/appearance#evolution-redesign: the summary button shrinks to ✦; the same cache as the review. */}
						<IconButton
							label={t(
								locale,
								summaryBusy ? 'Generating…' : summary ? 'Generate again' : 'Generate a summary'
							)}
							hint={t(locale, 'The agent looks at what was done and where')}
							disabled={summaryBusy}
							onClick={() => {
								void generate();
							}}>
							<Glyph name={summaryBusy ? 'check-run' : 'generate'} size={12} />
						</IconButton>
						<HelperCapsule
							locale={locale}
							title={t(locale, 'Summary agent')}
							state={helper}
							disabled={summaryBusy}
							narrow={narrow}
							onRun={(run) => {
								void generateSummary(task, target, run);
							}}
						/>
						<IconButton
							label={t(locale, 'Open on GitHub')}
							onClick={() => {
								void window.brigadir
									.openPullRequestPage(task.projectId, task.id, target.scopeId, target.number)
									.catch(() => {});
							}}>
							<Glyph name="external" size={11} />
						</IconButton>
						<MergeControl
							task={task}
							target={target}
							detail={detail}
							locale={locale}
							narrow={narrow}
						/>
					</div>
					<div className={styles.meta}>
						<Avatar login={pr.author} />
						<b>{pr.author}</b>
						<span>
							{t(locale, 'wants to merge {n} from').replace('{n}', commitWord(locale, commits))}
						</span>
						<code>{pr.head}</code>
						<span>{t(locale, 'into')}</span>
						<code>{pr.base}</code>
						<span>· {repo}</span>
					</div>
					<div className={styles.cards}>
						<section className={styles.card} aria-label={t(locale, 'Reviewers')}>
							<h2>{t(locale, 'Reviewers')}</h2>
							{pr.reviewers.length ? (
								pr.reviewers.map((reviewer) => (
									<div key={reviewer.login} className={styles.reviewer}>
										<Avatar login={reviewer.login} />
										{reviewer.login}
										<span className={styles.space} />
										<ReviewerState state={reviewer.state} locale={locale} />
									</div>
								))
							) : (
								<p className={styles.cap}>{t(locale, 'Nobody yet')}</p>
							)}
						</section>
						<section className={styles.card} aria-label={t(locale, 'Checks')}>
							<h2>
								{t(locale, 'Checks')}
								{detail.checks.length ? ` · ${passed}/${detail.checks.length}` : ''}
							</h2>
							{detail.checks
								.filter((check) => check.state === 'fail' || check.state === 'pending')
								.slice(0, 2)
								.map((check, index) => (
									<div key={index} className={styles.fact} data-state={check.state}>
										<Glyph name={check.state === 'fail' ? 'check-fail' : 'check-run'} size={12} />
										<code>{check.name}</code>
										<small>
											{t(locale, check.state === 'fail' ? 'check failed' : 'check running')}
										</small>
									</div>
								))}
							{passed > 0 && (
								<p className={styles.cap}>
									{detail.checks
										.filter((check) => check.state === 'pass')
										.map((check) => check.name)
										.slice(0, 4)
										.join(', ')}{' '}
									{t(locale, 'checks green')}
								</p>
							)}
							{!detail.checks.length && <p className={styles.cap}>{t(locale, 'No checks')}</p>}
						</section>
						<MergeCard
							task={task}
							target={target}
							detail={detail}
							locale={locale}
							resolve={links.resolveConflicts}
							after={after}
						/>
					</div>
				</header>
				<div className={styles.body}>
					{(summary || summaryBusy || summaryError) && (
						<SummaryCard
							summary={summary}
							busy={summaryBusy}
							error={summaryError}
							locale={locale}
							regenerate={() => {
								void generate();
							}}
							capsule={
								<HelperCapsule
									locale={locale}
									title={t(locale, 'Summary agent')}
									state={helper}
									narrow={narrow || fit.below}
									onRun={(run) => {
										void generateSummary(task, target, run);
									}}
								/>
							}
							open={(item, text) => {
								if (item.path)
									links.openFile(item.path, item.start, { text, start: item.start, end: item.end });
							}}
						/>
					)}
					{detail.body.trim() && (
						<article className={styles.description}>
							<div className={styles.who}>
								<Avatar login={pr.author} />
								<b>{pr.author}</b>
								<small>
									{summary ? `${t(locale, 'description')} · ` : ''}
									{prAge(locale, detail.createdAt)}
								</small>
							</div>
							<div className={styles.text}>
								<CommentText text={detail.body} />
							</div>
						</article>
					)}
					<div className={styles.filterRow}>
						<Segments
							label={t(locale, 'Timeline')}
							value={filter}
							onChange={(value) => setFilter(value as Filter)}
							options={[
								{ value: 'all', label: t(locale, 'All') },
								{ value: 'comments', label: t(locale, 'Comments') },
								{ value: 'commits', label: t(locale, 'Commits') },
								{ value: 'checks', label: t(locale, 'Checks') },
							]}
						/>
						<span className={styles.space} />
						{unresolved > 0 && (
							<small className={styles.cap}>
								{t(locale, '{n} unresolved').replace('{n}', String(unresolved))}
							</small>
						)}
					</div>
					<div
						className={styles.timeline}
						data-size="s"
						role="list"
						aria-label={t(locale, 'Timeline')}>
						{shown.map((entry) => (
							<div key={entry.id} role="listitem">
								{entry.kind === 'thread' ? (
									<ThreadEntry
										thread={entry.thread}
										locale={locale}
										busy={busy}
										answer={answers[entry.id]}
										ask={() => {
											void ask(entry.id, { threadId: entry.thread.id });
										}}
										drop={() => drop(entry.id)}
										actions={actions}
										own={pr.mine}
										links={links}
										open={() => links.openFile(entry.thread.path, entry.thread.line)}
									/>
								) : entry.kind === 'comment' ? (
									<CommentEntry
										author={entry.author}
										at={entry.at}
										body={entry.body}
										label={entry.label}
										locale={locale}
										answer={answers[entry.id]}
										ask={() => {
											void ask(entry.id, {
												question: `Explain this pull request comment by ${entry.author}: ${entry.body}`,
											});
										}}
										drop={() => drop(entry.id)}
										post={post}
										links={links}
										own={pr.mine}
									/>
								) : entry.kind === 'commits' ? (
									filter === 'commits' ? (
										<div className={styles.commits}>
											{[...entry.commits].reverse().map((commit) => (
												<CommitRow
													key={commit.sha}
													task={task}
													target={target}
													commit={commit}
													locale={locale}
													projectName={projectName}
													open={(value, fileId) =>
														links.openCommitFile?.(commit.sha, value, fileId)
													}
												/>
											))}
										</div>
									) : (
										<button
											type="button"
											className={styles.event}
											data-commits
											title={t(locale, 'Show the commits')}
											onClick={() => setFilter('commits')}>
											<Glyph name="commit-dot" size={12} />
											<span>
												{commitWord(locale, entry.commits.length)} ·{' '}
												<code>{entry.commits.at(-1)!.sha.slice(0, 7)}</code>{' '}
												{entry.commits.at(-1)!.subject}
											</span>
											<span className={styles.space} />
											<small>{prAge(locale, entry.at)}</small>
										</button>
									)
								) : (
									<div className={styles.event} data-state={entry.check.state}>
										<Glyph
											name={entry.check.state === 'fail' ? 'check-fail' : 'check-run'}
											size={12}
										/>
										<span>
											Checks · <code>{entry.check.name}</code>{' '}
											{t(locale, entry.check.state === 'fail' ? 'failed' : 'running')}
										</span>
										<span className={styles.space} />
										{entry.check.state === 'fail' && entry.check.link && (
											<Button
												variant="ghost"
												onClick={() => {
													void window.brigadir
														.openPullRequestLink(
															task.projectId,
															task.id,
															target.scopeId,
															entry.check.link
														)
														.catch(() => {});
												}}>
												{t(locale, 'Log on GitHub')}
											</Button>
										)}
									</div>
								)}
							</div>
						))}
						{after && (filter === 'all' || filter === 'checks') && (
							<div role="listitem">
								<button
									type="button"
									className={styles.event}
									data-ci-event={after.state}
									onClick={() => openTaskPR(task, target, 'checks')}>
									<CIGlyph state={after.state === 'running' ? 'running' : after.state} />
									<span>{afterLine(locale, after)}</span>
									<span className={styles.space} />
									<small>{after.detail ? prAge(locale, after.detail.run.createdAt) : ''}</small>
								</button>
							</div>
						)}
						{!shown.length && !after && (
							<p className={styles.hint}>{t(locale, 'Nothing here yet')}</p>
						)}
						{Object.entries(answers)
							.filter(([id]) => id.startsWith('question:'))
							.map(([id, answer]) => (
								<AgentAnswer
									key={id}
									answer={answer}
									locale={locale}
									own={pr.mine}
									drop={() => drop(id)}
									post={post}
									links={links}
								/>
							))}
					</div>
				</div>
				<Composer
					locale={locale}
					busy={busy}
					post={post}
					ask={(question) => {
						void ask(`question:${Date.now()}`, { question });
					}}
				/>
			</div>
		</PRLinkContext.Provider>
	);
}
/** spec/pull-requests-and-ci#ci: the deploy row (or a run without a deploy) in the «Мердж» card of a merged PR; a click opens the PR panel's Checks tab. */
function DeployFact({
	task,
	target,
	after,
	locale,
}: {
	task: AgentTask;
	target: PRRefKey;
	after: NonNullable<ReturnType<typeof mergedState>>;
	locale: Locale;
}) {
	const deploy = after.detail?.deploy ?? null,
		job = deploy ? after.detail!.jobs.find((item) => item.id === deploy.jobId) : undefined,
		at = job ? currentStep(job) : null;
	const title = deploy
		? t(
				locale,
				deploy.state === 'pass'
					? 'Deployed to {env}'
					: deploy.state === 'fail'
						? 'Deploy to {env} failed'
						: 'Deploying to {env}'
			).replace('{env}', deploy.environment)
		: after.text;
	const note =
		deploy?.state === 'running' && at
			? `${at.step.name}${at.step.seconds !== null ? ` · ${ciDuration(locale, at.step.seconds)}` : ''}`
			: deploy?.state === 'fail' && at
				? `${at.step.name} · ${t(locale, 'step {n} of {total}')
						.replace('{n}', String(at.index + 1))
						.replace('{total}', String(job!.steps.length))}`
				: after.detail?.run.seconds != null
					? `${prAge(locale, after.detail.run.createdAt)} · ${ciDuration(locale, after.detail.run.seconds)}`
					: '';
	return (
		<button
			type="button"
			className={styles.deployFact}
			data-state={after.state}
			data-ci-deploy-fact
			onClick={() => openTaskPR(task, target, 'checks')}>
			<span className={styles.deployLine}>
				<CIGlyph state={after.state === 'running' ? 'running' : after.state} />
				<span>{title}</span>
				{deploy?.state === 'running' && job && at && (
					<small>
						{at.index + 1}/{job.steps.length}
					</small>
				)}
			</span>
			{note && <small className={styles.deployNote}>{note}</small>}
		</button>
	);
}
function afterLine(locale: Locale, after: NonNullable<ReturnType<typeof mergedState>>) {
	const deploy = after.detail?.deploy,
		job = deploy ? after.detail!.jobs.find((item) => item.id === deploy.jobId) : undefined,
		at = job ? currentStep(job) : null;
	if (!deploy)
		return after.detail
			? `${after.detail.run.workflow} #${after.detail.run.number} · ${after.text}`
			: after.text;
	const title = t(
		locale,
		deploy.state === 'pass'
			? 'Deployed to {env}'
			: deploy.state === 'fail'
				? 'Deploy to {env} failed'
				: 'Deploying to {env}'
	).replace('{env}', deploy.environment);
	return deploy.state === 'pass'
		? `${title} · ${after.detail!.run.workflow} #${after.detail!.run.number}`
		: at
			? `${title} · ${at.step.name}`
			: title;
}
/** «Потрібне 1 схвалення», «Потрібні 2 схвалення», «Потрібно 5 схвалень». */
/**
 * spec/pull-requests-and-ci#merge-card: the Merge card says in words what keeps «Merge PR…» off — the same `mergeBlock` — and a draft is taken out
 * of draft here. Conflicts come first, then the reason; a PR GitHub lets merge has one line.
 */
function MergeCard({
	task,
	target,
	detail,
	locale,
	resolve,
	after,
}: {
	task: AgentTask;
	target: PRRefKey;
	detail: PullRequestDetail;
	locale: Locale;
	resolve?: OverviewLinks['resolveConflicts'];
	after: ReturnType<typeof mergedState>;
}) {
	const pr = detail.summary,
		block = mergeBlock(detail),
		[busy, setBusy] = useState(false),
		list = usePullRequests();
	const conflicting = detail.mergeable === 'CONFLICTING' || detail.mergeState === 'DIRTY',
		pushOff = !detail.canPush
			? t(locale, 'You cannot push to the PR branch.')
			: detail.crossRepository
				? t(locale, 'The PR branch is in a fork: resolve the conflict on GitHub.')
				: null,
		canReady = block === 'draft' && (pr.mine || detail.canMerge);
	async function ready() {
		setBusy(true);
		try {
			await window.brigadir.readyPullRequest(task, target);
			await readDetail(task, target, true);
			void list?.refresh(true);
		} catch {
			toastError(t(locale, 'Could not take the PR out of draft.'), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void ready();
					},
				},
			});
		} finally {
			setBusy(false);
		}
	}
	const fact = (state: 'pass' | 'fail' | 'wait', glyph: Glyphs, text: string, mark?: string) => (
		<div className={styles.fact} data-state={state} data-merge-reason={mark}>
			<Glyph name={glyph} size={12} />
			{text}
		</div>
	);
	return (
		<section
			className={`${styles.card} ${styles.mergeCard}`}
			aria-label={t(locale, 'Merging')}
			data-merge-card={block ?? 'clean'}>
			<h2>{t(locale, 'Merging')}</h2>
			{block === null ? (
				fact('pass', 'check-pass', t(locale, 'Can be merged'), 'clean')
			) : block === 'closed' ? (
				<>
					{fact(
						'wait',
						pr.state === 'MERGED' ? 'pr-merged' : 'pr-closed',
						t(locale, pr.state === 'MERGED' ? 'The PR is merged' : 'The PR is closed'),
						'closed'
					)}
					{after && <DeployFact task={task} target={target} after={after} locale={locale} />}
				</>
			) : (
				<>
					{fact(
						conflicting ? 'fail' : 'pass',
						conflicting ? 'check-fail' : 'check-pass',
						t(locale, conflicting ? 'Conflicts with {base}' : 'Without conflicts').replace(
							'{base}',
							pr.base
						),
						conflicting ? 'conflicts' : undefined
					)}
					{block === 'approvals' &&
						fact(
							'wait',
							'history',
							approvalsNeeded(locale, detail.requiredApprovals ?? 1),
							'approvals'
						)}
					{block === 'checks' &&
						fact('fail', 'check-fail', t(locale, mergeBlockLabels.checks), 'checks')}
					{block === 'draft' &&
						fact('wait', 'pr-draft', t(locale, mergeBlockLabels.draft), 'draft')}
					{(block === 'permission' || block === 'blocked') &&
						fact('wait', 'history', t(locale, mergeBlockLabels[block]), block)}
					{conflicting &&
						resolve &&
						(pushOff ? (
							fact('wait', 'history', pushOff, 'no-push')
						) : (
							<ResolveConflictsButton detail={detail} locale={locale} run={resolve} />
						))}
					{canReady && (
						<Button
							data-ready
							disabled={busy}
							title={t(
								locale,
								'Take the PR out of draft: GitHub asks the reviewers, and the PR can be merged'
							)}
							onClick={() => {
								void ready();
							}}>
							{t(locale, busy ? 'Working…' : 'Ready for review')}
						</Button>
					)}
				</>
			)}
		</section>
	);
}
/** spec/pull-requests-and-ci#merge, spec/appearance#evolution-redesign: why «Merge PR…» is off, in words — or what it does; the same `mergeBlock` as the Merge card. */
export function mergeWhy(detail: PullRequestDetail, locale: Locale) {
	const block = mergeBlock(detail),
		base = detail.summary.base;
	return block
		? t(locale, mergeBlockLabels[block]).replace('{base}', base)
		: t(locale, 'Merge the PR into {base}').replace('{base}', base);
}
const prConflicting = (detail: PullRequestDetail) =>
	detail.mergeable === 'CONFLICTING' || detail.mergeState === 'DIRTY';
/**
 * spec/pull-requests-and-ci#merge, spec/appearance#evolution-redesign: «Merge PR…» of the Overview header and the
 * review modal — one control (rule 17). Off with the reason in its tooltip while GitHub does not let merge; a merged or
 * closed PR shows its state instead (spec/pull-requests-and-ci#merge); narrow — the glyph with the name in the tooltip. With `resolve` (the review
 * modal) a conflict puts the amber `Resolve conflicts… ▾` of the Merge card in its place (spec/pull-requests-and-ci#resolve-conflicts, spec/appearance#evolution-redesign).
 */
export function MergeControl({
	task,
	target,
	detail,
	locale,
	narrow = false,
	resolve,
}: {
	task: AgentTask;
	target: PRRefKey;
	detail: PullRequestDetail;
	locale: Locale;
	narrow?: boolean;
	resolve?: OverviewLinks['resolveConflicts'];
}) {
	const { actions } = usePRReview(task, target),
		[merging, setMerging] = useState(false);
	const pr = detail.summary,
		block = mergeBlock(detail),
		why = mergeWhy(detail, locale);
	// spec/pull-requests-and-ci#merge: a merged or closed PR shows its state where «Merge PR…» stood, not a disabled button.
	if (pr.state === 'MERGED' || pr.state === 'CLOSED')
		return (
			<span className={styles.stateChip} data-state={pr.state} data-merge-state>
				<Glyph name={pr.state === 'MERGED' ? 'pr-merged' : 'pr-closed'} size={12} />
				{t(locale, pr.state === 'MERGED' ? 'Merged' : 'Closed')}
			</span>
		);
	const pushOff = !detail.canPush
		? t(locale, 'You cannot push to the PR branch.')
		: detail.crossRepository
			? t(locale, 'The PR branch is in a fork: resolve the conflict on GitHub.')
			: null;
	if (resolve && mergeControlState(detail, true) === 'conflicts')
		return (
			<ResolveConflictsButton
				detail={detail}
				locale={locale}
				run={resolve}
				appearance="warning"
				short={narrow}
			/>
		);
	const title = resolve && prConflicting(detail) && pushOff ? pushOff : why;
	return (
		<>
			{narrow ? (
				<IconButton
					data-merge
					label={t(locale, 'Merge PR…')}
					hint={title}
					disabled={Boolean(block)}
					onClick={() => setMerging(true)}>
					<Glyph name="pr-merged" size={12} />
				</IconButton>
			) : (
				<Button data-merge disabled={Boolean(block)} title={title} onClick={() => setMerging(true)}>
					{t(locale, 'Merge PR…')}
				</Button>
			)}
			{merging && (
				<MergeDialog
					detail={detail}
					locale={locale}
					close={() => setMerging(false)}
					merge={async (method, deleteBranch) => {
						const done = await actions.merge(method, deleteBranch);
						if (done) {
							setMerging(false);
							showToast(t(locale, 'PR #{n} merged').replace('{n}', String(pr.number)));
						}
						return done;
					}}
				/>
			)}
		</>
	);
}
/** spec/pull-requests-and-ci#resolve-conflicts: the way the main part runs; a choice in the menu runs it and stays for this window. spec/appearance#evolution-redesign: the dialog first. */
let resolveHow: 'agent' | 'manual' = 'manual';
/**
 * spec/pull-requests-and-ci#resolve-conflicts, spec/appearance#evolution-redesign: `Resolve conflicts… ▾` under «Conflicts with <base>»: the base is merged into the PR branch in that
 * branch's task, which opens on the Conflicts dialog; or the agent resolves. Without a push into the PR branch the card says why.
 */
function ResolveConflictsButton({
	detail,
	locale,
	run,
	appearance,
	short = false,
}: {
	detail: PullRequestDetail;
	locale: Locale;
	run(how: 'agent' | 'manual'): Promise<string | null>;
	/** spec/appearance#evolution-redesign: amber in the review modal; the card's own look otherwise. Its size is then the row's (rule 16). */ appearance?: 'warning';
	/** A narrow review modal: «Resolve ▾». */ short?: boolean;
}) {
	const [how, setHow] = useState(resolveHow),
		[open, setOpen] = useState(false),
		[busy, setBusy] = useState(false),
		toggle = useRef<HTMLButtonElement>(null);
	async function start(value: 'agent' | 'manual') {
		resolveHow = value;
		setHow(value);
		setOpen(false);
		setBusy(true);
		try {
			const reason = await run(value);
			if (reason) toastError(reason);
		} finally {
			setBusy(false);
		}
	}
	// spec/appearance#evolution-redesign: «Resolve in the dialog» opens the Conflicts dialog in the PR branch's task; the agent stays in the menu.
	const items = [
		{
			value: 'manual' as const,
			label: t(locale, 'Resolve in the dialog'),
			caption: t(locale, 'Merge {base} into the PR branch, then pick per file').replace(
				'{base}',
				detail.summary.base
			),
		},
		{
			value: 'agent' as const,
			label: t(locale, 'Let the agent resolve'),
			caption: t(locale, 'The agent resolves; you review, finish the merge and push'),
		},
	];
	return (
		<SplitButton
			{...(appearance ? { appearance } : { size: 's' as const, className: styles.resolve })}
			data-resolve-conflicts={how}
			disabled={busy}
			title={t(locale, 'Merge {base} into the PR branch and resolve the conflict').replace(
				'{base}',
				detail.summary.base
			)}
			onClick={() => {
				void start(how);
			}}
			second={{
				label: t(locale, 'How to resolve'),
				ref: toggle,
				expanded: open,
				disabled: busy,
				onClick: () => setOpen((value) => !value),
			}}
			menu={
				<MenuPopover
					open={open}
					onClose={() => setOpen(false)}
					anchor={toggle}
					align="start"
					width={264}
					focus="checked"
					label={t(locale, 'How to resolve')}
					locale={locale}>
					{items.map((item) => (
						<MenuItem
							key={item.value}
							kind="radio"
							checked={item.value === how}
							description={item.caption}
							onSelect={() => {
								void start(item.value);
							}}>
							{item.label}
						</MenuItem>
					))}
				</MenuPopover>
			}>
			{how === 'agent' && <Glyph name="generate" size={11} />}
			{busy ? (
				t(locale, 'Working…')
			) : short ? (
				t(locale, 'Resolve (conflict)')
			) : (
				<>
					<span className={styles.wide}>{t(locale, 'Resolve conflicts…')}</span>
					<span className={styles.narrow}>{t(locale, 'Resolve (conflict)')}</span>
				</>
			)}
		</SplitButton>
	);
}
function approvalsNeeded(locale: Locale, count: number) {
	if (locale === 'en') return `${count} approval${count === 1 ? '' : 's'} required`;
	const form = new Intl.PluralRules('uk').select(count);
	return `${form === 'one' ? 'Потрібне' : form === 'few' ? 'Потрібні' : 'Потрібно'} ${count} ${form === 'one' ? 'схвалення' : form === 'few' ? 'схвалення' : 'схвалень'}`;
}
function commitWord(locale: Locale, count: number) {
	if (locale === 'en') return `${count} commit${count === 1 ? '' : 's'}`;
	const word =
		({ one: 'коміт', few: 'коміти', many: 'комітів', other: 'коміта' } as Record<string, string>)[
			new Intl.PluralRules('uk').select(count)
		] ?? 'комітів';
	return `${count} ${word}`;
}
function timeline(detail: PullRequestDetail): Entry[] {
	const entries: Entry[] = [
		...detail.threads.map((thread) => ({
			id: `thread:${thread.id}`,
			at: thread.comments[0]?.createdAt ?? detail.createdAt,
			kind: 'thread' as const,
			thread,
		})),
		...detail.comments.map((comment) => ({
			id: `comment:${comment.id}`,
			at: comment.createdAt,
			kind: 'comment' as const,
			author: comment.author,
			body: comment.body,
			url: comment.url,
		})),
		...detail.reviews
			.filter((review) => review.body.trim())
			.map((review) => ({
				id: `review:${review.id}`,
				at: review.submittedAt,
				kind: 'comment' as const,
				author: review.author,
				body: review.body,
				url: '',
				label: review.state,
			})),
		...detail.checks
			.filter((check) => check.state === 'fail' || check.state === 'pending')
			.map((check, index) => ({
				id: `check:${index}:${check.name}`,
				at: new Date().toISOString(),
				kind: 'check' as const,
				check,
			})),
	];
	// Consecutive commits are one row: «4 коміти · sha subject».
	const commits = [...detail.commits].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	if (commits.length)
		entries.push({
			id: `commits:${commits.at(-1)!.sha}`,
			at: commits.at(-1)!.at,
			kind: 'commits',
			commits,
		});
	return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function ReviewerState({ state, locale }: { state: string; locale: Locale }) {
	const label = t(
		locale,
		state === 'REQUESTED'
			? 'Waiting for the review'
			: state === 'APPROVED'
				? 'Approved'
				: state === 'CHANGES_REQUESTED'
					? 'Changes requested'
					: 'Commented'
	);
	return (
		<span
			className={styles.reviewerState}
			data-state={state}
			title={label}
			role="img"
			aria-label={label}>
			{state === 'REQUESTED' ? (
				<span className={styles.dot} />
			) : (
				<Glyph
					name={
						state === 'APPROVED'
							? 'check-pass'
							: state === 'CHANGES_REQUESTED'
								? 'review-changes'
								: 'bubble'
					}
					size={12}
				/>
			)}
		</span>
	);
}
function snippet(hunk: string | null) {
	const line = hunk?.split('\n').filter(Boolean).at(-1) ?? null;
	return line && !line.startsWith('@@') ? line : null;
}
function ThreadEntry({
	thread,
	locale,
	busy,
	answer,
	ask,
	drop,
	actions,
	own,
	links,
	open,
}: {
	thread: PRThread;
	locale: Locale;
	busy: boolean;
	answer: PRAgentAnswer | 'loading' | 'error' | undefined;
	ask(): void;
	drop(): void;
	actions: ReturnType<typeof usePRReview>['actions'];
	own: boolean;
	links: OverviewLinks;
	open(): void;
}) {
	const [first, ...replies] = thread.comments,
		[replying, setReplying] = useState(''),
		[composing, setComposing] = useState(false),
		code = snippet(thread.hunk);
	if (!first) return null;
	const reply = async (body: string) => {
		const done = await actions.commentNow({
			path: thread.path,
			side: thread.side,
			line: thread.line ?? 1,
			startLine: null,
			body,
			replyTo: first.databaseId,
		});
		if (done) {
			setReplying('');
			setComposing(false);
		} else toastError(t(locale, 'GitHub did not accept the comment.'));
		return done;
	};
	return (
		<div className={styles.entry} data-resolved={thread.resolved}>
			<Avatar login={first.author} size="m" />
			<div className={styles.column}>
				<div className={styles.who}>
					<b>{first.author}</b>
					<small>{prAge(locale, first.createdAt)}</small>
					{thread.resolved && (
						<small className={styles.resolved}>
							<Glyph name="tick" size={10} />
							{t(locale, 'Resolved')}
						</small>
					)}
				</div>
				<div className={styles.quote}>
					<button type="button" className={styles.place} onClick={open}>
						{thread.path.split('/').at(-1)}
						{thread.line ? `:${thread.line}` : ''}
					</button>
					{code && (
						<div className={styles.code} data-sign={code[0]}>
							{code}
						</div>
					)}
					<div className={styles.quoteText}>
						<CommentText text={first.body} />
					</div>
					{replies.map((item) => (
						<div key={item.id} className={styles.reply}>
							<Avatar login={item.author} />
							<div>
								<b>{item.author}</b> <small>{prAge(locale, item.createdAt)}</small>
								<CommentText text={item.body} />
							</div>
						</div>
					))}
				</div>
				{composing ? (
					<div className={styles.inline}>
						<TextArea
							aria-label={t(locale, 'Reply…')}
							placeholder={t(locale, 'Reply…')}
							value={replying}
							autoFocus
							onChange={(event) => setReplying(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									event.stopPropagation();
									setComposing(false);
								}
								if (event.key === 'Enter' && primaryKey(event) && replying.trim())
									void reply(replying);
							}}
						/>
						<div className={styles.row}>
							<span className={styles.space} />
							<Button variant="ghost" onClick={() => setComposing(false)}>
								{t(locale, 'Cancel')}
							</Button>
							<Button
								appearance="primary"
								disabled={busy || !replying.trim()}
								onClick={() => {
									void reply(replying);
								}}>
								{t(locale, 'Reply now')}
							</Button>
						</div>
					</div>
				) : (
					<div className={styles.row}>
						<Button onClick={() => setComposing(true)}>{t(locale, 'Reply')}</Button>
						<Button data-selected={answer !== undefined || undefined} onClick={ask}>
							<Glyph name="generate" size={11} />
							{t(locale, 'Ask the agent')}
						</Button>
						<Button
							variant="ghost"
							disabled={busy}
							onClick={() => {
								void actions.resolve(thread.id, !thread.resolved);
							}}>
							{t(locale, thread.resolved ? 'Reopen' : 'Resolve')}
						</Button>
					</div>
				)}
				{answer !== undefined && (
					<AgentAnswer
						answer={answer}
						locale={locale}
						own={own}
						drop={drop}
						post={reply}
						links={links}
						use={(setReplyText) => {
							setComposing(true);
							setReplying(setReplyText);
						}}
					/>
				)}
			</div>
		</div>
	);
}
function CommentEntry({
	author,
	at,
	body,
	label,
	locale,
	answer,
	ask,
	drop,
	post,
	links,
	own,
}: {
	author: string;
	at: string;
	body: string;
	label?: string | undefined;
	locale: Locale;
	answer: PRAgentAnswer | 'loading' | 'error' | undefined;
	ask(): void;
	drop(): void;
	post(body: string): Promise<boolean>;
	links: OverviewLinks;
	own: boolean;
}) {
	return (
		<div className={styles.entry}>
			<Avatar login={author} size="m" />
			<div className={styles.column}>
				<div className={styles.who}>
					<b>{author}</b>
					{label && label !== 'COMMENTED' && (
						<small className={styles.review} data-state={label}>
							{t(
								locale,
								label === 'APPROVED'
									? 'approved'
									: label === 'CHANGES_REQUESTED'
										? 'requested changes'
										: 'reviewed'
							)}
						</small>
					)}
					<small>{prAge(locale, at)}</small>
				</div>
				<div className={styles.text}>
					<CommentText text={body} />
				</div>
				<div className={styles.row}>
					<Button data-selected={answer !== undefined || undefined} onClick={ask}>
						<Glyph name="generate" size={11} />
						{t(locale, 'Ask the agent')}
					</Button>
				</div>
				{answer !== undefined && (
					<AgentAnswer
						answer={answer}
						locale={locale}
						own={own}
						drop={drop}
						post={post}
						links={links}
					/>
				)}
			</div>
		</div>
	);
}
/** The agent's answer under a comment: an explanation, a reply draft or an edit. */
function AgentAnswer({
	answer,
	locale,
	own,
	drop,
	post,
	links,
	use,
}: {
	answer: PRAgentAnswer | 'loading' | 'error';
	locale: Locale;
	own: boolean;
	drop(): void;
	post(body: string): Promise<boolean>;
	links: OverviewLinks;
	use?: (text: string) => void;
}) {
	const [editing, setEditing] = useState(false),
		[text, setText] = useState(typeof answer === 'object' ? answer.text : ''),
		[busy, setBusy] = useState(false);
	useEffect(() => {
		if (typeof answer === 'object') setText(answer.text);
	}, [answer]);
	if (answer === 'loading')
		return (
			<div className={styles.agent} role="status">
				<div className={styles.agentHead}>
					<Glyph name="generate" size={11} />
					<span>{t(locale, 'The agent is thinking…')}</span>
				</div>
			</div>
		);
	if (answer === 'error')
		return (
			<div className={styles.agent} data-error role="alert">
				<div className={styles.agentHead}>
					<Glyph name="generate" size={11} />
					<span>{t(locale, 'The agent could not answer.')}</span>
					<span className={styles.space} />
					<Button variant="ghost" onClick={drop}>
						{t(locale, 'Hide')}
					</Button>
				</div>
			</div>
		);
	const heading = t(
		locale,
		answer.kind === 'reply'
			? 'Agent · a draft reply'
			: answer.kind === 'change'
				? 'Agent · a change for the task'
				: 'Agent · an explanation for you'
	);
	return (
		<div className={styles.agent} data-kind={answer.kind}>
			<div className={styles.agentHead}>
				<Glyph name="generate" size={11} />
				<span>{heading}</span>
			</div>
			{editing ? (
				<TextArea
					className={styles.agentEdit}
					aria-label={heading}
					value={text}
					autoFocus
					onChange={(event) => setText(event.target.value)}
				/>
			) : (
				<div className={styles.agentText}>
					<CommentText text={text} />
				</div>
			)}
			<div className={styles.row}>
				<span className={styles.space} />
				{answer.kind === 'explanation' && (
					<>
						<Button variant="ghost" onClick={drop}>
							{t(locale, 'Hide')}
						</Button>
						<Button
							onClick={() => {
								if (use) use(text);
								else {
									setEditing(true);
								}
							}}>
							{t(locale, 'Turn into a reply')}
						</Button>
					</>
				)}
				{answer.kind === 'reply' && (
					<>
						<Button variant="ghost" onClick={drop}>
							{t(locale, 'Discard')}
						</Button>
						<Button onClick={() => setEditing((value) => !value)}>
							{t(locale, editing ? 'Done' : 'Edit')}
						</Button>
						<Button
							appearance="primary"
							disabled={busy || !text.trim()}
							onClick={() => {
								setBusy(true);
								void post(text).then((done) => {
									setBusy(false);
									if (done) drop();
								});
							}}>
							{t(locale, 'Send to the PR')}
						</Button>
					</>
				)}
				{answer.kind === 'change' && (
					<>
						<Button variant="ghost" onClick={drop}>
							{t(locale, 'Discard')}
						</Button>
						<Button
							appearance="primary"
							disabled={busy || !links.handToAgent}
							title={own ? undefined : t(locale, 'Only for your own PR')}
							onClick={() => {
								setBusy(true);
								void links.handToAgent!(text).then((done) => {
									setBusy(false);
									if (done) drop();
								});
							}}>
							<Glyph name="generate" size={11} />
							{t(locale, 'Apply')}
						</Button>
					</>
				)}
				{answer.kind === 'explanation' && editing && (
					<Button
						appearance="primary"
						disabled={busy || !text.trim()}
						onClick={() => {
							setBusy(true);
							void post(text).then((done) => {
								setBusy(false);
								if (done) drop();
							});
						}}>
						{t(locale, 'Send to the PR')}
					</Button>
				)}
			</div>
		</div>
	);
}
function SummaryCard({
	summary,
	busy,
	error,
	locale,
	regenerate,
	open,
	capsule,
}: {
	/** spec/appearance#evolution-redesign: the Helper agent's capsule — who writes the summary; a choice writes it again. */ capsule: ReactNode;
	summary: PRSummary | null;
	busy: boolean;
	error: string;
	locale: Locale;
	regenerate(): void;
	open(item: PRSummaryItem, text: string): void;
}) {
	const link = (item: PRSummaryItem) =>
		item.path ? (
			<>
				<button type="button" className={styles.link} onClick={() => open(item, item.text)}>
					{item.path.split('/').at(-1)}
				</button>
				{item.start && (
					<small className={styles.lines}>
						{item.end && item.end !== item.start ? `${item.start}–${item.end}` : item.start}
					</small>
				)}
			</>
		) : null;
	return (
		<section
			className={styles.summary}
			data-size="s"
			aria-label={t(locale, 'Summary from the agent')}
			aria-busy={busy}>
			<div className={styles.summaryHead}>
				<Glyph name="generate" size={13} />
				<h2>{t(locale, 'Summary from the agent')}</h2>
				{capsule}
				{summary && (
					<small>
						{fileCount(locale, summary.files)} · {summary.seconds} {locale === 'en' ? 's' : 'с'}
					</small>
				)}
				<span className={styles.space} />
				{summary && !busy && (
					<Button variant="ghost" onClick={regenerate}>
						<Glyph name="generate" size={11} />
						{t(locale, 'Generate again')}
					</Button>
				)}
			</div>
			{busy && !summary && <p className={styles.cap}>{t(locale, 'Generating…')}</p>}
			{error && (
				<p className={styles.cap} role="alert">
					{error}
				</p>
			)}
			{summary && summary.done.length > 0 && (
				<div className={styles.section}>
					<h3>{t(locale, 'What was done')}</h3>
					{summary.done.map((item, index) => (
						<p key={index} className={styles.item}>
							– {link(item)} {item.text}
						</p>
					))}
				</div>
			)}
			{summary && summary.watch.length > 0 && (
				<div className={styles.section}>
					<h3>{t(locale, 'What to look at')}</h3>
					{summary.watch.map((item, index) => (
						<p key={index} className={styles.watch}>
							<Glyph name="review-warning" size={12} />
							<span>
								{link(item)} {item.text}
							</span>
						</p>
					))}
				</div>
			)}
		</section>
	);
}
/** The field at the bottom of Overview: `У PR` — a comment on the PR on GitHub, `Агенту` — a question about the PR whose answer only you see. */
function Composer({
	locale,
	busy,
	post,
	ask,
}: {
	locale: Locale;
	busy: boolean;
	post(body: string): Promise<boolean>;
	ask(question: string): void;
}) {
	const [to, setTo] = useState<'pr' | 'agent'>('agent'),
		[text, setText] = useState(''),
		input = useRef<HTMLInputElement>(null);
	const send = async () => {
		if (!text.trim()) return;
		if (to === 'agent') {
			ask(text);
			setText('');
		} else if (await post(text)) setText('');
	};
	return (
		<div className={styles.composer} data-size="m">
			<Segments
				label={t(locale, 'Addressee')}
				value={to}
				onChange={(value) => {
					setTo(value as 'pr' | 'agent');
					input.current?.focus();
				}}
				options={[
					{ value: 'pr', label: t(locale, 'To the PR'), icon: <Glyph name="github" size={11} /> },
					{
						value: 'agent',
						label: t(locale, 'To the agent'),
						icon: <Glyph name="generate" size={11} />,
					},
				]}
			/>
			<TextInput
				ref={input}
				className={styles.field}
				aria-label={t(
					locale,
					to === 'agent' ? 'Ask the agent about this PR…' : 'Comment on this PR…'
				)}
				placeholder={t(
					locale,
					to === 'agent' ? 'Ask the agent about this PR…' : 'Comment on this PR…'
				)}
				value={text}
				disabled={busy}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter' && !event.shiftKey) {
						event.preventDefault();
						void send();
					}
				}}
			/>
			<IconButton
				appearance="primary"
				variant="solid"
				label={t(locale, 'Send')}
				disabled={busy || !text.trim()}
				onClick={() => {
					void send();
				}}>
				<Glyph name="send-plane" size={13} />
			</IconButton>
		</div>
	);
}
/** spec/pull-requests-and-ci#merge: the merge confirmation — the allowed methods, the commits, «Видалити гілку», the outcome in words; an error keeps the dialog. */
function MergeDialog({
	detail,
	locale,
	close,
	merge,
}: {
	detail: PullRequestDetail;
	locale: Locale;
	close(): void;
	merge(method: PRMergeMethod, deleteBranch: boolean): Promise<boolean>;
}) {
	// A fork's branch is not this repository's to delete (spec/remote-access-and-mobile#phone-task-tools); main, master, stage and
	// staging are never deleted by a merge.
	const deletable = !detail.crossRepository && !keepsBranch(detail.summary.head);
	const dialog = useRef<HTMLDialogElement>(null),
		[method, setMethod] = useState<PRMergeMethod>(detail.defaultMergeMethod),
		[remove, setRemove] = useState(deletable),
		[busy, setBusy] = useState(false),
		[failed, setFailed] = useState('');
	useEffect(() => {
		const previous = document.activeElement,
			element = dialog.current!;
		element.showModal();
		return () => {
			element.close();
			if (previous instanceof HTMLElement && previous.isConnected)
				previous.focus({ preventScroll: true });
		};
	}, []);
	const pr = detail.summary,
		labels: Record<PRMergeMethod, 'Squash' | 'Merge commit method' | 'Rebase'> = {
			squash: 'Squash',
			merge: 'Merge commit method',
			rebase: 'Rebase',
		};
	const outcome = t(
		locale,
		method === 'squash'
			? 'Squash makes one commit in {base}.'
			: method === 'rebase'
				? 'Rebase puts the commits on top of {base} one by one.'
				: 'A merge commit joins the branch into {base}.'
	).replace('{base}', pr.base);
	return (
		<dialog
			ref={dialog}
			className={styles.merge}
			data-size="m"
			aria-labelledby="pr-merge-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) close();
			}}>
			<div className={styles.mergeHead}>
				<Glyph name="pr-merged" size={13} />
				<h2 id="pr-merge-title">
					{t(locale, 'Merge PR #{n} into {base}?')
						.replace('{n}', String(pr.number))
						.replace('{base}', pr.base)}
				</h2>
				<PopupClose
					locale={locale}
					close={() => {
						if (!busy) close();
					}}
				/>
			</div>
			<div className={styles.methods} role="radiogroup" aria-label={t(locale, 'Merge method')}>
				{detail.mergeMethods.map((value) => (
					<label key={value} className={styles.method}>
						<Choice
							type="radio"
							name="pr-merge-method"
							label={t(locale, labels[value])}
							checked={method === value}
							onChange={() => setMethod(value)}
						/>
						<span>{t(locale, labels[value])}</span>
						{value === detail.defaultMergeMethod && <small>{t(locale, 'the repo default')}</small>}
					</label>
				))}
			</div>
			<div className={styles.goes}>
				<h3>
					{t(locale, '{n} will go').replace('{n}', commitWord(locale, detail.commits.length))}
				</h3>
				{detail.commits.slice(0, 3).map((commit) => (
					<div key={commit.sha} className={styles.goesRow}>
						<code>{commit.sha.slice(0, 7)}</code>
						<span>{commit.subject}</span>
					</div>
				))}
				{detail.commits.length > 3 && (
					<small>+{commitWord(locale, detail.commits.length - 3)}</small>
				)}
			</div>
			{deletable && (
				<label className={styles.check}>
					<Choice
						type="checkbox"
						label={t(locale, 'Delete the branch')}
						checked={remove}
						onChange={(event) => setRemove(event.target.checked)}
					/>
					<span>
						{t(locale, 'Delete the branch')} <code>{pr.head}</code>
					</span>
				</label>
			)}
			<p className={styles.cap}>{outcome}</p>
			{failed && (
				<p className={styles.mergeError} role="alert">
					{failed}
				</p>
			)}
			<div className={styles.row}>
				<span className={styles.space} />
				<Button disabled={busy} onClick={close}>
					{t(locale, 'Cancel')}
				</Button>
				<Button
					appearance="primary"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						setFailed('');
						void merge(method, remove && deletable).then((done) => {
							setBusy(false);
							if (!done)
								setFailed(t(locale, 'GitHub did not merge the PR. The dialog stays open.'));
						});
					}}>
					{t(locale, busy ? 'Working…' : 'Merge')}
				</Button>
			</div>
		</dialog>
	);
}
