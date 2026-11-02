/**
 * spec/remote-access-and-mobile#phone-task-tools: the task's pull request — the overview with the checks and why it cannot be
 * merged yet, the checks (a failed one: Log on GitHub, Ask the agent), the unresolved threads and the comments with a
 * comment box; Review and the merge are sheets. Every write re-reads the PR from GitHub, as the computer's `pr-review`.
 * spec/remote-access-and-mobile#phone-pr-list: the same screen for a PR from the project's list, in the main tree's context.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	approvalCount,
	commentCount,
	commitCount,
	failedCheckCount,
	formatDuration,
	isOpenPR,
	unresolvedCount,
	relativeAge,
	t,
	type AgentTask,
	type Locale,
	type PRAgentAnswer,
	type PRMergeMethod,
	type PRRefKey,
	type PRReviewDraft,
	type PRReviewEvent,
	type PRThread,
	type PullRequestDetail,
	keepsBranch,
	type TaskKey,
} from '@brigadir/core';
import { Button, StatusIcon, Switch } from '../../renderer/ui/Controls';
import { statusLabels } from '../../renderer/task-line';
import { Avatar } from '../../renderer/ui/Avatar';
import { CIGlyph } from '../../renderer/ui/RunSteps';
import { BackButton, NavBar, NavIcon } from '../ui/Nav';
import { Caption, Group, RowIcon, SectionHead, Sheet, SheetRow } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { Loading } from '../ui/Loading';
import { CommentBox } from '../chat/CommentBox';
import { back, navigate, openSheet, useRouter } from '../router';
import { useMobile, useOffline } from '../store';
import { keyOf, loadForge, taskName, useTools } from './data';
import { checkState, checksGlyph, checksLine, fileName, mergeLine } from './logic';
import { mainTreeKey, usePRLists } from './prs';
import { prTask, repoName } from './pr-list';
import { PRAgentSheet } from './PRAgentSheet';
import screen from '../screens/Screen.module.css';
import sheets from '../screens/Sheets.module.css';
import s from './PullRequest.module.css';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The task's PR: the one main recorded for its branch, else the one the forge read found. */
function usePRRef(task: AgentTask): {
	ref: PRRefKey | null;
	repo: string | null;
	searched: boolean;
} {
	const forge = useTools((state) => state.forge[taskName(task)]);
	const recorded = Object.entries(task.pullRequests ?? {})[0];
	useEffect(() => {
		void loadForge(keyOf(task), true);
	}, [task.projectId, task.id]);
	const scope = forge?.value?.scopes.find((item) =>
		recorded ? item.scope.id === recorded[0] : item.pr
	);
	if (recorded)
		return {
			ref: { scopeId: recorded[0], number: recorded[1].number },
			repo: scope?.scope.name ?? null,
			searched: true,
		};
	return {
		ref: scope?.pr ? { scopeId: scope.scope.id, number: scope.pr.number } : null,
		repo: scope?.scope.name ?? null,
		searched: Boolean(forge),
	};
}
/**
 * Where a PR screen works (spec/remote-access-and-mobile#phone-pr-list): the task's tree, or the project's main tree for a PR from the project's list —
 * the reads take `taskId: null` there, the writes the main tree's hidden record (`mainTreeKey`), as the computer's PR panel
 * without a task.
 */
export type PRContext = {
	projectId: string;
	taskId: string | null;
	key(): Promise<TaskKey>;
	/** The chat a failed check's Ask the agent goes to; none — the button is not there. */ chat: AgentTask | null;
};
export const taskContext = (task: AgentTask): PRContext => ({
	projectId: task.projectId,
	taskId: task.id,
	key: async () => keyOf(task),
	chat: task,
});
/** One viewer login per machine session: «Goes to GitHub as …» under the review's Send. */
let viewer: Promise<string | null> | null = null;
function readViewer(context: PRContext) {
	viewer ??= window.brigadir
		.readPullRequests(context.projectId, context.taskId, false)
		.then((snapshot) => snapshot.viewer)
		.catch(() => {
			viewer = null;
			return null;
		});
	return viewer;
}
export function PullRequest({ task, locale }: { task: AgentTask; locale: Locale }) {
	const { ref, repo, searched } = usePRRef(task);
	const context = useMemo(() => taskContext(task), [task.projectId, task.id]);
	return (
		<PRScreen
			context={context}
			prRef={ref}
			repo={repo}
			searched={searched}
			backLabel={t(locale, 'Chat')}
			locale={locale}
		/>
	);
}
/**
 * spec/remote-access-and-mobile#phone-pr-list: a PR from the project's list — the same screen in the main tree's
 * context; its task's row on top when a task of the project has it, Review with an agent when none does.
 */
export function ProjectPullRequest({
	projectId,
	scopeId,
	number,
	locale,
}: {
	projectId: string;
	scopeId: string;
	number: number;
	locale: Locale;
}) {
	const workspace = useMobile((state) => state.workspace),
		list = usePRLists((state) => state.lists[projectId]?.value ?? null);
	const project = workspace?.projects.find((item) => item.id === projectId);
	const listed = list?.repos.find((item) => item.scopeId === scopeId),
		summary = listed?.prs.find((pr) => pr.number === number);
	const owner = prTask(workspace?.tasks ?? [], projectId, { scopeId, number, url: summary?.url });
	const context = useMemo<PRContext>(
		() => ({ projectId, taskId: null, key: () => mainTreeKey(projectId), chat: owner }),
		[projectId, owner?.id]
	);
	const ref = useMemo(() => ({ scopeId, number }), [scopeId, number]);
	return (
		<PRScreen
			context={context}
			prRef={ref}
			repo={listed && project ? repoName(listed, project.name) : null}
			searched
			backLabel={project?.name ?? t(locale, 'Projects')}
			locale={locale}
			list={{ owner, several: (list?.repos.filter((item) => item.repository).length ?? 0) > 1 }}
		/>
	);
}
function PRScreen({
	context,
	prRef: ref,
	repo,
	searched,
	backLabel,
	list,
	locale,
}: {
	context: PRContext;
	prRef: PRRefKey | null;
	repo: string | null;
	searched: boolean;
	backLabel: string;
	/** A PR from the project's list (spec/remote-access-and-mobile#phone-pr-list): the task it belongs to, and whether the project has several repos. */ list?: {
		owner: AgentTask | null;
		several: boolean;
	};
	locale: Locale;
}) {
	const { sheet } = useRouter(),
		offline = useOffline();
	const [detail, setDetail] = useState<PullRequestDetail | null>(null),
		[review, setReview] = useState<PRReviewDraft | null>(null),
		[error, setError] = useState<string | null>(null),
		[links, setLinks] = useState<Record<string, string>>({}),
		[replyTo, setReplyTo] = useState<PRThread | null>(null),
		[answers, setAnswers] = useState<Record<string, PRAgentAnswer | 'asking' | 'failed'>>({});
	const refKey = ref ? `${ref.scopeId}#${ref.number}` : null;
	const read = useCallback(
		async (fresh: boolean) => {
			if (!ref) return;
			try {
				const [value, draft] = await Promise.all([
					window.brigadir.readPullRequestDetail(context.projectId, context.taskId, ref, fresh),
					context
						.key()
						.then((key) => window.brigadir.readPullRequestReview(key, ref))
						.catch(() => null),
				]);
				setDetail(value);
				if (draft) setReview(draft);
				setError(null);
			} catch (reason) {
				setError(message(reason));
			}
		},
		[refKey, context]
	);
	useEffect(() => {
		setDetail(null);
		void read(true);
	}, [read]);
	// The browser leaves only from a tap (a popup blocker): the addresses are asked for before it.
	useEffect(() => {
		if (!detail || !ref) return;
		let live = true;
		const wanted = [
			['page', null] as const,
			...detail.checks
				.filter((check) => check.state === 'fail' && check.link)
				.map((check) => [check.link, check.link] as const),
		];
		void Promise.all(
			wanted.map(async ([name, link]) => {
				try {
					const url =
						link === null
							? await window.brigadir.readPullRequestPageUrl(
									context.projectId,
									context.taskId,
									ref.scopeId,
									ref.number
								)
							: await window.brigadir.readPullRequestLinkUrl(
									context.projectId,
									context.taskId,
									ref.scopeId,
									link
								);
					return [name, url] as const;
				} catch {
					return null;
				}
			})
		).then((pairs) => {
			if (live)
				setLinks(
					Object.fromEntries(pairs.filter((pair): pair is [string, string] => pair !== null))
				);
		});
		return () => {
			live = false;
		};
	}, [detail?.id, detail?.checks.map((check) => check.link).join()]);
	const act = async (run: () => Promise<unknown>) => {
		try {
			await run();
			await read(true);
			return true;
		} catch (reason) {
			setError(message(reason));
			return false;
		}
	};
	const pr = detail?.summary ?? null;
	const checks = useMemo(() => (detail ? checksLine(detail.checks) : null), [detail]);
	const line = detail ? mergeLine(detail) : null;
	const threads = (detail?.threads ?? []).filter((thread) => !thread.resolved);
	const unresolved = threads.length;
	const comments = [
		...threads.map((thread) => ({
			kind: 'thread' as const,
			at: thread.comments[0]?.createdAt ?? '',
			thread,
		})),
		...(detail?.comments ?? []).map((comment) => ({
			kind: 'comment' as const,
			at: comment.createdAt,
			comment,
		})),
	].sort((a, b) => a.at.localeCompare(b.at));
	// spec/remote-access-and-mobile#phone-pr-list: a PR from the list names its repo first; a conflict says so in place of the count.
	const conflict = line?.kind === 'block' && line.block === 'conflicts';
	const sub = detail
		? [
				list && repo ? repo : null,
				conflict ? lowerFirst(locale, mergeText(locale, line!, detail)) : null,
				!conflict && checks && checks.total
					? `${t(locale, 'Checks')} ${checks.passed}/${checks.total}`
					: null,
				conflict
					? null
					: list && detail.summary.waiting
						? lowerFirst(locale, t(locale, 'Waiting for your review'))
						: line?.kind === 'ready' && detail.summary.reviewDecision === 'APPROVED'
							? t(locale, 'approved')
							: checks?.state === 'fail'
								? failedCheckCount(
										locale,
										detail.checks.filter((check) => check.state === 'fail').length
									)
								: commentCount(
										locale,
										detail.threads.reduce((sum, thread) => sum + thread.comments.length, 0) +
											detail.comments.length
									),
			]
				.filter(Boolean)
				.join(' · ')
		: '';
	const askCheck = async (name: string, link: string) => {
		const chat = context.chat;
		if (!chat) return;
		const text = `The check "${name}" failed on PR #${ref?.number} (${pr?.head ?? 'its branch'}). Read its failed log (${link}; for a GitHub Actions run \`gh run view <run id> --log-failed\`), find the cause and fix it. Do not push: the person confirms the push.`;
		try {
			await window.brigadir.startSession(keyOf(chat)).catch(() => null);
			await window.brigadir.sendCommand(keyOf(chat), { kind: 'prompt', text });
			if (context.taskId) back();
			else navigate({ screen: 'task', projectId: chat.projectId, taskId: chat.id });
		} catch (reason) {
			setError(message(reason));
		}
	};
	const ask = async (thread: PRThread) => {
		if (!ref) return;
		setAnswers((all) => ({ ...all, [thread.id]: 'asking' }));
		try {
			const answer = await window.brigadir.askPullRequestAgent(await context.key(), ref, {
				threadId: thread.id,
			});
			setAnswers((all) => ({ ...all, [thread.id]: answer }));
		} catch {
			setAnswers((all) => ({ ...all, [thread.id]: 'failed' }));
		}
	};
	return (
		<div className={screen.screen} data-screen="tool" data-tool="pr">
			<NavBar
				left={<BackButton label={backLabel} locale={locale} onClick={back} />}
				title={ref ? `PR #${ref.number}` : t(locale, 'Pull request')}
				sub={sub}
				right={
					ref && (
						<>
							<NavIcon
								icon="link"
								quiet
								label={t(locale, 'Open on GitHub')}
								disabled={!links.page}
								onClick={() =>
									links.page && window.open(links.page, '_blank', 'noopener,noreferrer')
								}
							/>
							<Button
								appearance="primary"
								variant="ghost"
								className={s.reviewButton}
								data-pr-review
								disabled={!detail || offline}
								onClick={() => openSheet({ kind: 'review' })}>
								{t(locale, 'Review (verb)')}
							</Button>
						</>
					)
				}
			/>
			<div className={screen.scroll}>
				{!ref ? (
					<p className={screen.empty}>{searched ? t(locale, 'No pull request') : ''}</p>
				) : !detail ? (
					error ? (
						<p className={screen.empty}>{error}</p>
					) : (
						<Loading locale={locale} label={t(locale, 'Reading the PR from GitHub…')} />
					)
				) : (
					<div className={s.stack} data-pr={detail.summary.number}>
						<div className={s.head}>
							<h1>
								{detail.summary.title} <span>#{detail.summary.number}</span>
							</h1>
							<div className={s.meta}>
								<span className={s.state} data-state={detail.summary.state}>
									<Icon name="prOpen" size={12} />
									{t(
										locale,
										detail.summary.state === 'MERGED'
											? 'PR merged'
											: detail.summary.state === 'CLOSED'
												? 'PR closed'
												: detail.summary.state === 'DRAFT'
													? 'PR draft'
													: 'PR open'
									)}
								</span>
								<Icon name="branch" size={13} />
								<span className="mono">{detail.summary.head}</span>
								<span>→</span>
								<span className="mono">{detail.summary.base}</span>
								{repo && <span>· {repo}</span>}
							</div>
						</div>
						{list?.owner ? (
							<Group className={s.taskRow}>
								<SheetRow
									icon={
										<RowIcon>
											<StatusIcon
												status={list.owner.status}
												question={list.owner.activity?.kind === 'question'}
												label={t(locale, statusLabels[list.owner.status])}
												size={18}
											/>
										</RowIcon>
									}
									title={t(locale, 'PR task')}
									sub={
										<span className="ell">
											{list.owner.title} ·{' '}
											{lowerFirst(locale, t(locale, statusLabels[list.owner.status]))}
										</span>
									}
									chevron
									data={{ 'pr-task': list.owner.id }}
									onClick={() =>
										navigate({
											screen: 'task',
											projectId: list.owner!.projectId,
											taskId: list.owner!.id,
										})
									}
								/>
							</Group>
						) : (
							list &&
							isOpenPR(detail.summary) && (
								<div className={s.agentReview} data-size="l">
									<Button
										className={s.wide}
										data-agent-review
										disabled={offline}
										onClick={() => openSheet({ kind: 'pr-agent', mode: 'review' })}>
										<Icon name="spark" size={16} className={s.spark} />
										{t(locale, 'Review with an agent')}
									</Button>
									<Caption className={s.agentCaption}>
										{t(
											locale,
											'This PR has no task: the agent works in a new task and leaves draft comments.'
										)}
									</Caption>
								</div>
							)
						)}
						<div className={s.card} data-pr-overview>
							{checks && checks.total > 0 && (
								<div className={s.row}>
									<CheckIcon state={checks.state} />
									<span>
										{t(locale, 'Checks')} {checks.passed}/{checks.total}
									</span>
									<span className={s.space} />
									<small>
										{checks.state === 'pass'
											? t(locale, 'all passed')
											: checks.named
												? `${checks.named.name} ${t(locale, checks.named.state === 'fail' ? 'failed (check)' : 'check running')}`
												: ''}
									</small>
								</div>
							)}
							<div className={s.row}>
								{detail.summary.reviewers[0] ? (
									<>
										<Avatar login={detail.summary.reviewers[0].login} size="l" />
										<span className="ell">{detail.summary.reviewers[0].login}</span>
										<small>· {reviewState(locale, detail.summary.reviewers[0].state)}</small>
									</>
								) : (
									<small>{t(locale, 'Nobody yet')}</small>
								)}
								<span className={s.space} />
								<Avatar login={detail.summary.author} size="l" />
								<small className="ell">
									{detail.summary.mine ? t(locale, 'you') : detail.summary.author}
								</small>
							</div>
							{line && (
								<div className={s.row} data-merge-line={line.kind}>
									<Icon
										name={
											line.kind === 'ready' || line.kind === 'merged'
												? 'tick'
												: line.kind === 'waiting'
													? 'hourglass'
													: 'alert'
										}
										className={
											line.kind === 'ready' || line.kind === 'merged' ? s.green : undefined
										}
									/>
									<span>{mergeText(locale, line, detail)}</span>
								</div>
							)}
							{list && conflict && detail.canPush && !detail.crossRepository && (
								<div className={`${s.row} ${s.column}`} data-size="l">
									<Button
										className={s.wide}
										data-resolve-conflicts
										disabled={offline}
										onClick={() => openSheet({ kind: 'pr-agent', mode: 'conflict' })}>
										<Icon name="spark" size={15} className={s.spark} />
										{t(locale, 'Resolve conflicts')}
									</Button>
									<small>
										{t(
											locale,
											'The agent merges {base} into the PR branch in a new task; the merge and the push are yours.'
										).replace('{base}', detail.summary.base)}
									</small>
								</div>
							)}
							{detail.summary.state !== 'MERGED' && detail.summary.state !== 'CLOSED' && (
								<div className={s.row} data-size="l">
									<Button
										appearance="primary"
										className={s.wide}
										data-merge
										disabled={line?.kind !== 'ready' || offline}
										title={line?.kind === 'ready' ? undefined : mergeText(locale, line!, detail)}
										onClick={() => openSheet({ kind: 'merge' })}>
										{t(locale, 'Merge PR…')}
									</Button>
								</div>
							)}
						</div>
						{detail.checks.length > 0 && (
							<>
								<SectionHead count={`${checks!.passed}/${checks!.total}`}>
									{t(locale, 'Checks')}
								</SectionHead>
								<div className={s.card} data-pr-checks>
									{detail.checks.map((check) => (
										<div
											key={`${check.workflow}/${check.name}`}
											className={s.row}
											data-check={check.name}>
											<CIGlyph state={checkState(check)} size={16} />
											<span className={`mono ell ${s.checkName}`}>{check.name}</span>
											<span className={s.space} />
											<small>
												{[
													check.state === 'fail'
														? t(locale, 'failed (check)')
														: check.state === 'pending'
															? t(locale, 'check running')
															: null,
													check.seconds !== null
														? formatDuration(locale, check.seconds * 1000)
														: null,
												]
													.filter(Boolean)
													.join(' · ')}
											</small>
										</div>
									))}
									{detail.checks
										.filter((check) => check.state === 'fail')
										.slice(0, 1)
										.map((check) => (
											<div key="fail-actions" className={`${s.row} ${s.pair}`} data-size="l">
												<Button
													data-check-log
													disabled={!links[check.link]}
													onClick={() =>
														links[check.link] &&
														window.open(links[check.link], '_blank', 'noopener,noreferrer')
													}>
													<Icon name="link" />
													{t(locale, 'Log on GitHub')}
												</Button>
												{context.chat && (
													<Button
														data-check-ask
														disabled={offline}
														onClick={() => void askCheck(check.name, check.link)}>
														<Icon name="spark" size={15} />
														{t(locale, 'Ask the agent')}
													</Button>
												)}
											</div>
										))}
								</div>
							</>
						)}
						{comments.length > 0 && (
							<SectionHead count={unresolved ? unresolvedCount(locale, unresolved) : undefined}>
								{t(locale, 'Comments')}
							</SectionHead>
						)}
						{comments.map((item) =>
							item.kind === 'thread' ? (
								<Thread
									key={item.thread.id}
									thread={item.thread}
									locale={locale}
									answer={answers[item.thread.id]}
									disabled={offline}
									reply={() => setReplyTo(item.thread)}
									ask={() => void ask(item.thread)}
								/>
							) : (
								<div key={item.comment.id} className={s.comment} data-pr-comment>
									<div className={s.who}>
										<Avatar login={item.comment.author} size="l" />
										<b>{item.comment.author}</b>
										<small>{relativeAge(locale, item.comment.createdAt)}</small>
									</div>
									<div className={s.body}>{item.comment.body}</div>
								</div>
							)
						)}
						{error && <p className={s.error}>{error}</p>}
					</div>
				)}
			</div>
			{ref && detail && (
				<div className={screen.bottom} data-clear>
					<CommentBox
						locale={locale}
						disabled={offline}
						placeholder={
							replyTo
								? t(locale, 'Reply to {author}…').replace(
										'{author}',
										replyTo.comments[0]?.author ?? ''
									)
								: t(locale, 'Comment on this PR…')
						}
						replyTo={replyTo?.comments[0]?.author ?? null}
						cancelReply={() => setReplyTo(null)}
						send={async (text) => {
							const thread = replyTo;
							const ok = await act(async () =>
								thread
									? window.brigadir.commentPullRequestNow(await context.key(), ref, {
											path: thread.path,
											side: thread.side,
											line: thread.line ?? 1,
											startLine: null,
											body: text,
											replyTo: thread.comments[0]?.databaseId ?? null,
										})
									: window.brigadir.commentPullRequest(await context.key(), ref, text)
							);
							if (ok) setReplyTo(null);
							return ok;
						}}
					/>
				</div>
			)}
			{sheet?.kind === 'review' && ref && detail && (
				<ReviewSheet
					context={context}
					prRef={ref}
					detail={detail}
					review={review}
					locale={locale}
					done={() => void read(true)}
				/>
			)}
			{sheet?.kind === 'pr-agent' && ref && detail && (
				<PRAgentSheet
					mode={sheet.mode}
					context={context}
					prRef={ref}
					detail={detail}
					locale={locale}
				/>
			)}
			{sheet?.kind === 'merge' && ref && detail && (
				<MergeSheet
					context={context}
					prRef={ref}
					detail={detail}
					locale={locale}
					done={() => void read(true)}
				/>
			)}
		</div>
	);
}
const lowerFirst = (locale: Locale, text: string) =>
	text.slice(0, 1).toLocaleLowerCase(locale) + text.slice(1);
function CheckIcon({ state }: { state: 'pass' | 'fail' | 'pending' | 'none' }) {
	return <CIGlyph state={checksGlyph(state)} size={16} />;
}
function reviewState(locale: Locale, state: string) {
	return t(
		locale,
		state === 'APPROVED'
			? 'approved'
			: state === 'CHANGES_REQUESTED'
				? 'requested changes'
				: state === 'REQUESTED'
					? 'review requested'
					: 'commented (review)'
	);
}
function mergeText(locale: Locale, line: ReturnType<typeof mergeLine>, detail: PullRequestDetail) {
	switch (line.kind) {
		case 'ready':
			return t(locale, 'Can be merged');
		case 'merged':
			return t(locale, 'The PR is merged');
		case 'waiting':
			return line.checks && line.approvals
				? t(locale, 'Waiting for checks and {approvals}').replace(
						'{approvals}',
						approvalCount(locale, line.approvals)
					)
				: line.checks
					? t(locale, 'Waiting for checks')
					: t(locale, 'Waiting for {approvals}').replace(
							'{approvals}',
							approvalCount(locale, line.approvals)
						);
		case 'block':
			return line.block === 'conflicts'
				? t(locale, 'Conflicts with {base}').replace('{base}', detail.summary.base)
				: t(
						locale,
						line.block === 'checks'
							? 'Checks did not pass'
							: line.block === 'draft'
								? 'The PR is a draft'
								: line.block === 'closed'
									? 'The PR is closed'
									: line.block === 'permission'
										? 'You cannot merge in this repo'
										: line.block === 'approvals'
											? 'An approval is required'
											: 'GitHub does not allow merging yet'
					);
	}
}
function Thread({
	thread,
	locale,
	answer,
	disabled,
	reply,
	ask,
}: {
	thread: PRThread;
	locale: Locale;
	answer: PRAgentAnswer | 'asking' | 'failed' | undefined;
	disabled: boolean;
	reply(): void;
	ask(): void;
}) {
	const first = thread.comments[0];
	const code = thread.hunk?.split('\n').at(-1) ?? null;
	return (
		<div className={s.comment} data-pr-thread={thread.id}>
			{first && (
				<div className={s.who}>
					<Avatar login={first.author} size="l" />
					<b>{first.author}</b>
					<small>{relativeAge(locale, first.createdAt)}</small>
				</div>
			)}
			<div className={s.code}>
				<div className={`mono ${s.place}`}>
					{fileName(thread.path)}
					{thread.line !== null ? `:${thread.line}` : ''}
				</div>
				{code !== null && (
					<div
						className={`mono ${s.snippet}`}
						data-kind={
							code.startsWith('+') ? 'added' : code.startsWith('-') ? 'removed' : undefined
						}>
						{code}
					</div>
				)}
			</div>
			{thread.comments.map((comment, index) => (
				<div key={comment.id} className={s.body}>
					{index > 0 && <b>{comment.author}: </b>}
					{comment.body}
				</div>
			))}
			{answer && (
				<div className={s.answer} data-agent-answer>
					<small>
						{answer === 'asking'
							? t(locale, 'The agent is thinking…')
							: answer === 'failed'
								? t(locale, 'The agent could not answer.')
								: t(
										locale,
										answer.kind === 'reply'
											? 'Agent · a draft reply'
											: answer.kind === 'change'
												? 'Agent · a change for the task'
												: 'Agent · an explanation for you'
									)}
					</small>
					{typeof answer === 'object' && <div>{answer.text}</div>}
				</div>
			)}
			<div className={s.actions} data-size="l">
				<Button disabled={disabled} data-thread-reply onClick={reply}>
					{t(locale, 'Reply')}
				</Button>
				<Button disabled={disabled || answer === 'asking'} data-thread-ask onClick={ask}>
					<Icon name="spark" size={15} />
					{t(locale, 'Ask the agent')}
				</Button>
			</div>
		</div>
	);
}
const decisions: {
	event: PRReviewEvent;
	title: 'Comment (review)' | 'Approve' | 'Request changes' | 'Agent fixes it';
}[] = [
	{ event: 'COMMENT', title: 'Comment (review)' },
	{ event: 'APPROVE', title: 'Approve' },
	{ event: 'REQUEST_CHANGES', title: 'Request changes' },
	{ event: 'AGENT', title: 'Agent fixes it' },
];
function ReviewSheet({
	context,
	prRef,
	detail,
	review,
	locale,
	done,
}: {
	context: PRContext;
	prRef: PRRefKey;
	detail: PullRequestDetail;
	review: PRReviewDraft | null;
	locale: Locale;
	done(): void;
}) {
	const [event, setEvent] = useState<PRReviewEvent>(review?.event ?? 'COMMENT'),
		[body, setBody] = useState(review?.body ?? ''),
		[sending, setSending] = useState(false),
		[error, setError] = useState<string | null>(null),
		[login, setLogin] = useState<string | null>(null);
	useEffect(() => {
		void readViewer(context).then(setLogin);
	}, []);
	const mine = detail.summary.mine;
	const drafts = review?.drafts ?? [];
	const submit = async () => {
		setSending(true);
		setError(null);
		try {
			const key = await context.key();
			if (event === 'AGENT') {
				await window.brigadir.setPullRequestReview(key, prRef, { body });
				const result = await window.brigadir.startPullRequestAgent(
					key,
					prRef,
					'fix',
					review?.sendComments ?? false
				);
				// This PR's task already exists (it is this task): the prompt goes into its chat (spec/pull-requests-and-ci#review-with-agent).
				if (!result.created && result.prompt)
					await window.brigadir.sendCommand(
						{ projectId: result.task.projectId, id: result.task.id },
						{ kind: 'prompt', text: result.prompt }
					);
			} else {
				await window.brigadir.setPullRequestReview(key, prRef, { body, event });
				await window.brigadir.submitPullRequestReview(key, prRef);
			}
			done();
			back();
		} catch (reason) {
			setError(message(reason));
		} finally {
			setSending(false);
		}
	};
	return (
		<Sheet
			label={t(locale, 'Review (noun)')}
			title={`${t(locale, 'Review (noun)')} · #${detail.summary.number}`}
			locale={locale}
			close={back}
			tall
			top={70}>
			<div className={s.sheetBody} data-review-sheet>
				<Group>
					{decisions.map((decision) => {
						const own =
							mine && (decision.event === 'APPROVE' || decision.event === 'REQUEST_CHANGES');
						return (
							<SheetRow
								key={decision.event}
								role="menuitemradio"
								checked={event === decision.event}
								disabled={own}
								icon={
									<span className={sheets.radio} data-on={event === decision.event || undefined} />
								}
								title={t(locale, decision.title)}
								{...(decision.event === 'COMMENT'
									? { sub: t(locale, 'No decision') }
									: decision.event === 'AGENT'
										? { sub: t(locale, 'The task agent makes the fixes from the comments') }
										: own
											? {
													sub: t(
														locale,
														decision.event === 'APPROVE'
															? 'you cannot approve your own PR'
															: 'you cannot request changes on your own PR'
													),
												}
											: {})}
								data={{ decision: decision.event }}
								onClick={() => setEvent(decision.event)}
							/>
						);
					})}
				</Group>
				<label className={s.fieldLabel}>
					<span>{t(locale, 'General comment')}</span>
					<textarea
						className={s.field}
						value={body}
						data-review-body
						onChange={(change) => setBody(change.target.value)}
					/>
				</label>
				{drafts.length > 0 && (
					<>
						<SectionHead count={String(drafts.length)}>{t(locale, 'Drafts')}</SectionHead>
						<Group>
							{drafts.map((draft) => (
								<SheetRow
									key={draft.id}
									icon={
										<RowIcon>
											<Icon name="comment" size={18} />
										</RowIcon>
									}
									title={
										<span className={`mono ${s.draftPlace}`}>
											{fileName(draft.path)}:{draft.line}
										</span>
									}
									sub={<span className={s.line}>{draft.body}</span>}
								/>
							))}
						</Group>
					</>
				)}
				<span className={s.space} />
				{error && <p className={s.error}>{error}</p>}
				<div className={s.send} data-size="xl">
					<Button
						appearance="primary"
						className={s.wide}
						data-review-send
						disabled={sending || (event === 'COMMENT' && !body.trim() && !drafts.length)}
						onClick={() => void submit()}>
						{t(locale, event === 'AGENT' ? 'Hand to the agent' : 'Send review')}
					</Button>
					<Caption className={s.center}>
						{event === 'AGENT'
							? t(locale, 'The agent of the PR task makes the fixes. Push only after you confirm.')
							: login
								? t(locale, 'Goes to GitHub as {login}.').replace('{login}', login)
								: t(locale, 'Goes to GitHub.')}
					</Caption>
				</div>
			</div>
		</Sheet>
	);
}
const methodNames: Record<PRMergeMethod, 'Squash' | 'Merge commit method' | 'Rebase'> = {
	squash: 'Squash',
	merge: 'Merge commit method',
	rebase: 'Rebase',
};
const methodNotes: Record<
	PRMergeMethod,
	| 'Squash makes one commit in {base}.'
	| 'A merge commit joins the branch into {base}.'
	| 'Rebase puts the commits on top of {base} one by one.'
> = {
	squash: 'Squash makes one commit in {base}.',
	merge: 'A merge commit joins the branch into {base}.',
	rebase: 'Rebase puts the commits on top of {base} one by one.',
};
function MergeSheet({
	context,
	prRef,
	detail,
	locale,
	done,
}: {
	context: PRContext;
	prRef: PRRefKey;
	detail: PullRequestDetail;
	locale: Locale;
	done(): void;
}) {
	const methods = (['squash', 'merge', 'rebase'] as const).filter((method) =>
		detail.mergeMethods.includes(method)
	);
	// A fork's branch is not this repository's to delete (security review, spec/remote-access-and-mobile#phone-task-tools); main, master, stage and
	// staging are never deleted by a merge.
	const deletable = !detail.crossRepository && !keepsBranch(detail.summary.head);
	const [method, setMethod] = useState<PRMergeMethod>(detail.defaultMergeMethod),
		[remove, setRemove] = useState(deletable),
		[merging, setMerging] = useState(false),
		[failed, setFailed] = useState(false);
	const base = detail.summary.base;
	const merge = async () => {
		setMerging(true);
		setFailed(false);
		try {
			await window.brigadir.mergePullRequest(
				await context.key(),
				prRef,
				method,
				remove && deletable
			);
			done();
			back();
		} catch {
			setFailed(true);
		} finally {
			setMerging(false);
		}
	};
	return (
		<Sheet
			label={t(locale, 'Merge PR…')}
			title={t(locale, 'Merge PR #{n} into {base}?')
				.replace('{n}', String(detail.summary.number))
				.replace('{base}', base)}
			locale={locale}
			close={back}>
			<div data-merge-sheet>
				<Group>
					{methods.map((item) => (
						<SheetRow
							key={item}
							role="menuitemradio"
							checked={method === item}
							icon={<span className={sheets.radio} data-on={method === item || undefined} />}
							title={t(locale, methodNames[item])}
							{...(item === detail.defaultMergeMethod ? { sub: t(locale, 'Repo default') } : {})}
							data={{ method: item }}
							onClick={() => setMethod(item)}
						/>
					))}
				</Group>
				{detail.commits.length > 0 && (
					<>
						<SectionHead>
							{t(locale, '{n} will go').replace('{n}', commitCount(locale, detail.commits.length))}
						</SectionHead>
						<Group>
							{detail.commits.slice(0, 3).map((commit) => (
								<div key={commit.sha} className={s.commit}>
									<span className="mono">{commit.sha.slice(0, 7)}</span>
									<span className="ell">{commit.subject}</span>
								</div>
							))}
						</Group>
					</>
				)}
				{deletable && (
					<Group className={sheets.gap12}>
						<SheetRow
							title={t(locale, 'Delete the branch')}
							sub={<span className="mono">{detail.summary.head}</span>}
							tail={
								<span data-size="l" className={sheets.switchTail}>
									<Switch
										label={t(locale, 'Delete the branch')}
										checked={remove}
										onChange={setRemove}
									/>
								</span>
							}
						/>
					</Group>
				)}
				<Caption className={sheets.captionTop}>
					{t(locale, methodNotes[method]).replace('{base}', base)}{' '}
					{t(locale, 'A merge on GitHub cannot be undone.')}
				</Caption>
				{failed && (
					<p className={s.error}>
						{t(locale, 'GitHub did not merge the PR. The dialog stays open.')}
					</p>
				)}
				<div className={s.mergeButtons} data-size="xl">
					<Button onClick={back}>{t(locale, 'Cancel')}</Button>
					<Button
						appearance="primary"
						data-merge-confirm
						disabled={merging}
						onClick={() => void merge()}>
						{t(locale, 'Merge')}
					</Button>
				</div>
			</div>
		</Sheet>
	);
}
