import { useRef, useState, type ReactNode } from 'react';
import {
	t,
	type AgentTask,
	type FileDiff,
	type Locale,
	type MessageKey,
	type PRDefinitionPlace,
	type PRDraft,
	type PRRefKey,
} from '@brigadir/core';
import { CodeLocations } from './CodeLocations';
import { DiffView, type PRDiff } from './DiffView';
import { usePRReview } from './pr-review';
import { usePullRequests } from './PullRequests';
import { useWorkspace } from './store';
import { PRLinkContext, type PRDiffActions } from './PRThreads';
import { Glyph } from './ui/Glyph';
import { Button } from './ui/Controls';
import { FilePath } from './ui/FilePath';
import { notify, toastError } from './ui/Toast';
import styles from './PRDiffView.module.css';
import diffStyles from './DiffView.module.css';
import { LoadingStatus, Skeleton } from './ui/Loading';

/** Above a PR file: where it came from — the Overview summary (spec/pull-requests-and-ci#pr-summary) or ⌘+click from another file (`from`, spec/pull-requests-and-ci#pr-definition). */
const fileName = (path: string) => path.split('/').at(-1) || path;
export type PRCrumb = {
	text: string;
	start: number | null;
	end: number | null;
	from?: { path: string; line: number };
};
/** spec/pull-requests-and-ci#pr-threads: a PR file in the diff tab — the task diff's engine and renderer, with GitHub threads and review drafts over it. */
export function PRDiffView({
	task,
	target,
	diff,
	locale,
	onCompose,
	crumb = null,
	onBack,
	onDeliver,
	onGoTo,
	onJumpToSource,
	head,
	highlight: landing,
	summary,
}: {
	/** spec/appearance#evolution-redesign: the review modal's summary markers on this file. */ summary?: PRDiff['summary'];
	/** spec/appearance#evolution-redesign: the review modal's compact file row in place of the diff header; a function places the layout controls. */ head?:
		ReactNode | ((layout: ReactNode) => ReactNode);
	/** spec/appearance#evolution-redesign: lines a summary link lands on. */ highlight?: {
		start: number;
		end: number;
	} | null;
	task: AgentTask;
	target: PRRefKey;
	diff: FileDiff;
	locale: Locale;
	onDeliver?: ((text: string, to: AgentTask) => Promise<void>) | undefined;
	onCompose(
		text: string,
		focus?: boolean,
		immediate?: boolean,
		name?: string,
		after?: string
	): Promise<boolean>;
	crumb?: PRCrumb | null;
	onBack?: () => void;
	/** spec/editor#reopen-closed-tab: F4 opens the task's own copy of the file; absent when the task's tree has none. */
	onJumpToSource?: ((line?: number) => void) | undefined;
	/** spec/pull-requests-and-ci#pr-definition: open a definition found in the PR head; `from` is the clicked line. */ onGoTo?: (
		place: PRDefinitionPlace,
		word: string,
		from: number
	) => void;
}) {
	const { detail, review, busy, error, actions } = usePRReview(task, target),
		viewer = usePullRequests()?.data?.viewer ?? null,
		tasks = useWorkspace((state) => state.workspace?.tasks);
	// spec/pull-requests-and-ci#review-drafts: the drafts belong to the PR; a reply under an agent's draft goes to the review task that wrote it.
	const author = (draft: PRDraft) =>
		draft.taskId
			? tasks?.find(
					(item) =>
						item.projectId === task.projectId &&
						item.id === draft.taskId &&
						item.prReview?.mode === 'review'
				)
			: task.prReview?.mode === 'review'
				? task
				: undefined;
	const path = diff.file.path;
	/** spec/notifications-slack-notes-and-schedules#message-classes: each failed PR action is its own toast that names it; GitHub's raw answer stays out of the interface. */
	const named = async (done: Promise<boolean>, failure: MessageKey) => {
		const ok = await done;
		if (!ok) toastError(t(locale, failure));
		return ok;
	};
	const post = (input: Parameters<typeof actions.addDraft>[0], now: boolean) =>
		now
			? named(actions.commentNow(input), 'GitHub did not accept the comment.')
			: named(actions.addDraft(input), 'Could not save the draft.');
	const prActions: PRDiffActions = {
		viewer,
		busy,
		error,
		reply: (thread, body, now) =>
			post(
				{
					path: thread.path,
					side: thread.side,
					line: thread.line ?? 1,
					startLine: null,
					body,
					replyTo: thread.comments[0]!.databaseId,
				},
				now
			),
		resolve: async (thread, resolved) => {
			await named(
				actions.resolve(thread.id, resolved),
				resolved ? 'Could not resolve the thread.' : 'Could not reopen the thread.'
			);
		},
		comment: (range, body, now) =>
			post(
				{
					path,
					side: range.side === 'old' ? ('LEFT' as const) : ('RIGHT' as const),
					line: range.end,
					startLine: range.start < range.end ? range.start : null,
					body,
					replyTo: null,
				},
				now
			),
		editDraft: async (draft, body) => {
			await named(actions.editDraft(draft.id, body), 'Could not save the draft.');
		},
		removeDraft: async (draft) => {
			await named(actions.removeDraft(draft.id), 'Could not delete the draft.');
		},
		discuss: onDeliver
			? (draft, body) => {
					const to = author(draft);
					return to
						? named(
								actions.discuss(draft.id, body, (text) => onDeliver(text, to)),
								'Could not send the answer to the agent.'
							)
						: Promise.resolve(false);
				}
			: undefined,
		canDiscuss: (draft) => Boolean(author(draft)),
		openOnGitHub: (url) => {
			void window.brigadir
				.openPullRequestLink(task.projectId, task.id, target.scopeId, url)
				.catch(() => {});
		},
	};
	/** spec/pull-requests-and-ci#pr-definition: ⌘+click on a name — one place opens at once, several open the list; the last click wins. */
	const request = useRef(0),
		[found, setFound] = useState<{
			word: string;
			from: number;
			places: PRDefinitionPlace[];
			truncated: boolean;
		} | null>(null);
	const definition = onGoTo
		? (line: number, column: number, text: string) => {
				const id = ++request.current;
				void window.brigadir.findPullRequestDefinition(task, target, path, line, column, text).then(
					(answer) => {
						if (id !== request.current) return;
						if (answer.state === 'stale') {
							toastError(t(locale, 'The file changed. Refresh the PR.'));
							return;
						}
						if (!answer.places.length) {
							// Nothing is wrong and nothing was done: information, not success (spec/notifications-slack-notes-and-schedules#message-classes).
							notify('info', t(locale, 'No definition found.'));
							return;
						}
						if (answer.places.length === 1) onGoTo(answer.places[0]!, answer.word, line);
						else
							setFound({
								word: answer.word,
								from: line,
								places: answer.places,
								truncated: answer.truncated,
							});
					},
					() => {
						if (id === request.current) toastError(t(locale, 'Could not find the definition.'));
					}
				);
			}
		: undefined;
	const crumbLine = crumb?.start
		? ` · ${crumb.end && crumb.end !== crumb.start ? t(locale, 'lines {start}–{end}').replace('{start}', String(crumb.start)).replace('{end}', String(crumb.end)) : t(locale, 'line {n}').replace('{n}', String(crumb.start))}`
		: '';
	const banner = crumb?.from ? (
		<div className={styles.crumb} data-size="s" role="status">
			<Glyph name="symbol" size={12} />
			<span>
				{t(locale, 'Definition of {name}').replace('{name}', crumb.text)}
				{crumbLine}
			</span>
			<Button onClick={onBack}>
				<Glyph name="chevron-left" size={10} />
				{t(locale, 'Back to {file}').replace('{file}', fileName(crumb.from.path))}
			</Button>
		</div>
	) : (
		crumb && (
			<div className={styles.crumb} data-size="s" role="status">
				<Glyph name="generate" size={12} />
				<span>
					{t(locale, 'From the summary: {text}').replace('{text}', crumb.text)}
					{crumb.start
						? ` · ${crumb.end && crumb.end !== crumb.start ? t(locale, 'lines {start}–{end}').replace('{start}', String(crumb.start)).replace('{end}', String(crumb.end)) : t(locale, 'line {n}').replace('{n}', String(crumb.start))}`
						: ''}
				</span>
				<Button onClick={onBack}>
					<Glyph name="chevron-left" size={10} />
					{t(locale, 'Back to Overview')}
				</Button>
			</div>
		)
	);
	return (
		<PRLinkContext.Provider value={prActions.openOnGitHub}>
			{/* spec/pull-requests-and-ci#pr-definition: a file the PR did not change takes no review comments — GitHub accepts them only on diff lines. */}
			<DiffView
				diff={diff}
				locale={locale}
				task={task}
				comments={[]}
				pr={
					diff.unchanged
						? undefined
						: {
								threads: detail?.threads ?? [],
								drafts: review.drafts,
								actions: prActions,
								summary,
							}
				}
				highlight={
					landing
						? { side: 'new', ...landing }
						: crumb?.start
							? { side: 'new', start: crumb.start, end: crumb.end ?? crumb.start }
							: null
				}
				banner={banner}
				head={head}
				canOpenEditor={false}
				onReviewChanged={async () => {}}
				onCompose={onCompose}
				onOpenEditor={() => {}}
				onDefinition={definition}
				onJumpToSource={onJumpToSource}
				onRevert={() => {}}
			/>
			{found && (
				<CodeLocations
					title="Go to definition"
					languageName=""
					locale={locale}
					note={t(locale, 'Found by name in the PR branch.')}
					tag={(id) =>
						found.places.some((place) => place.path === id && !place.changed)
							? t(locale, 'Unchanged in the PR')
							: null
					}
					result={{
						locations: found.places.map((place) => ({
							fileId: place.path,
							path: place.path,
							line: place.line,
							column: place.column,
							preview: place.preview,
							readOnly: false,
							byName: true,
						})),
						source: 'fallback',
						language: null,
						truncated: found.truncated,
					}}
					open={(location) => {
						const place = found.places.find(
							(item) =>
								item.path === location.path &&
								item.line === location.line &&
								item.column === location.column
						);
						setFound(null);
						if (place) onGoTo?.(place, found.word, found.from);
					}}
					close={() => setFound(null)}
				/>
			)}
		</PRLinkContext.Provider>
	);
}

/** spec/pull-requests-and-ci#pr-files: a PR file between the click and its diff — `branch` while main fetches the PR, `file` while it reads the diff. */
export type PROpening = PRRefKey & {
	path: string;
	key: string;
	phase: 'branch' | 'file' | 'failed';
	placeholder: boolean;
	retry(): void;
};
/** The diff header as it will be, without counts yet, and one status line where the diff starts; a failure in the same place with «Retry». */
export function PRFileOpening({ opening, locale }: { opening: PROpening; locale: Locale }) {
	return (
		<section
			className={diffStyles.diff}
			data-pr-opening={opening.phase}
			aria-busy={opening.phase !== 'failed'}>
			<header className={diffStyles.header}>
				<FilePath path={opening.path} />
			</header>
			{opening.phase === 'failed' ? (
				<div className={styles.openError} role="alert">
					<Glyph name="check-fail" size={13} />
					<span>{t(locale, 'The file could not be read.')}</span>
					<Button size="s" onClick={opening.retry}>
						{t(locale, 'Retry')}
					</Button>
				</div>
			) : (
				<div className={styles.opening}>
					<Skeleton widths={[62, 84, 48, 76, 36, 70]} />
					<LoadingStatus
						label={t(
							locale,
							opening.phase === 'branch'
								? 'Downloading the PR branch from GitHub…'
								: 'Reading the file changes…'
						)}
						under
						delay={0}
					/>
				</div>
			)}
		</section>
	);
}
