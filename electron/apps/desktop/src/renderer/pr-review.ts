import { useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { onSessionEvent } from './session-events';
import {
	requested,
	slow,
	saved,
	failed,
	savingAfter,
	type ViewedPending,
	type ViewedError,
} from './pr-viewed';
import {
	emptyReviewDraft,
	type AgentTask,
	type PRDraftInput,
	type PRRefKey,
	type PRReviewDraft,
	type PRReviewEvent,
	type PullRequestDetail,
} from '@brigadir/core';

/**
 * spec/pull-requests-and-ci#pr-list, spec/diff-and-review#review-comments: one PR in a task — its details from GitHub and the review draft from the
 * task's disk. Shared by the PR panel, the PR file diff tabs and the «Review ▾» form, so a draft added in a diff is in the footer at once.
 * Reads happen on open, on window focus and after our own action; there is no polling (spec/pull-requests-and-ci#reading-and-refresh).
 */
export type PRReviewState = {
	detail: PullRequestDetail | null;
	detailError: string;
	review: PRReviewDraft;
	busy: boolean;
	error: string;
	sent: { event: Exclude<PRReviewEvent, 'AGENT'>; at: number } | null;
	/** spec/pull-requests-and-ci#pr-files: «Viewed» requests in flight per file path, and the last one GitHub did not save. */ viewing: ViewedPending;
	viewedError: ViewedError | null;
};
type Entry = {
	store: StoreApi<PRReviewState>;
	users: number;
	revision: number;
	viewedSeq: number;
	/** Form fields (`setReview`) on their way to disk, and how many were asked: a read that overlaps one keeps the
	 *  person's newer choice. */ writing: number;
	formSeq: number;
};
const entries = new Map<string, Entry>();
const keyOf = (task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) =>
	`${task.projectId}/${task.id}/${ref.scopeId}/${ref.number}`;
function entry(task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) {
	const id = keyOf(task, ref);
	let value = entries.get(id);
	if (!value) {
		value = {
			store: createStore<PRReviewState>(() => ({
				detail: null,
				detailError: '',
				review: emptyReviewDraft(),
				busy: false,
				error: '',
				sent: null,
				viewing: {},
				viewedError: null,
			})),
			users: 0,
			revision: 0,
			viewedSeq: 0,
			writing: 0,
			formSeq: 0,
		};
		entries.set(id, value);
	}
	return value;
}
/**
 * spec/appearance#evolution-redesign: which PR's review modal is open in a task. The PR panel footer and Overview open it; TaskView renders it
 * over the work area, so both entries show the same modal.
 */
const reviewOpen = createStore<Record<string, PRRefKey | null>>(() => ({}));
const taskOf = (task: Pick<AgentTask, 'projectId' | 'id'>) => `${task.projectId}/${task.id}`;
export function openReview(task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) {
	reviewOpen.setState({ [taskOf(task)]: { scopeId: ref.scopeId, number: ref.number } });
}
export function closeReview(task: Pick<AgentTask, 'projectId' | 'id'>) {
	reviewOpen.setState({ [taskOf(task)]: null });
}
export function useReviewOpen(task: Pick<AgentTask, 'projectId' | 'id'>): PRRefKey | null {
	return useStore(reviewOpen, (state) => state[taskOf(task)] ?? null);
}
/** The store of one PR outside React (unit tests). */
export const prReviewStore = (task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) =>
	entry(task, ref).store;
const message = (error: unknown) =>
	error instanceof Error && error.message
		? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
		: String(error);
export function readDetail(task: AgentTask, ref: PRRefKey, fresh = false) {
	const value = entry(task, ref),
		revision = ++value.revision;
	return window.brigadir.readPullRequestDetail(task.projectId, task.id, ref, fresh).then(
		(detail) => {
			if (revision === value.revision) value.store.setState({ detail, detailError: '' });
			return detail;
		},
		(error) => {
			if (revision === value.revision) value.store.setState({ detailError: message(error) });
		}
	);
}
/**
 * spec/pull-requests-and-ci#pr-files: «Viewed» is optimistic. The mark and `{n} of {total} viewed` change at the click; after `savingAfter` ms
 * the box shows that it is saving; GitHub's answer keeps the mark in the PR files, without a new read of the whole PR.
 * A failure returns GitHub's mark and names the file. No `busy`: the review form does not wait for a checkbox.
 */
export async function markViewed(
	task: Pick<AgentTask, 'projectId' | 'id'>,
	ref: PRRefKey,
	path: string,
	viewed: boolean,
	after = savingAfter
): Promise<boolean> {
	const value = entry(task, ref),
		seq = ++value.viewedSeq,
		store = value.store;
	store.setState((state) => requested(state, path, viewed, seq));
	const timer = setTimeout(() => store.setState((state) => slow(state, path, seq)), after);
	try {
		await window.brigadir.markPullRequestFileViewed(task as AgentTask, ref, path, viewed);
		store.setState((state) => {
			const next = saved(
				{ viewing: state.viewing, files: state.detail?.files ?? [] },
				path,
				viewed,
				seq
			);
			return {
				viewing: next.viewing,
				...(state.detail ? { detail: { ...state.detail, files: next.files } } : {}),
			};
		});
		return true;
	} catch (error) {
		store.setState((state) => failed(state, path, viewed, seq, message(error)));
		return false;
	} finally {
		clearTimeout(timer);
	}
}
export function readReview(task: AgentTask, ref: PRRefKey) {
	const value = entry(task, ref),
		seq = value.formSeq;
	return window.brigadir.readPullRequestReview(task, ref).then(
		(review) =>
			value.store.setState((state) => ({
				review:
					value.writing || value.formSeq !== seq
						? {
								...review,
								body: state.review.body,
								event: state.review.event,
								sendComments: state.review.sendComments,
							}
						: review,
			})),
		() => {}
	);
}
/** An action on the draft or GitHub: busy, the error in words, fresh details after a GitHub write. */
async function act(
	task: AgentTask,
	ref: PRRefKey,
	work: () => Promise<PRReviewDraft | void>,
	github = false
): Promise<boolean> {
	const value = entry(task, ref);
	value.store.setState({ busy: true, error: '' });
	try {
		const review = await work();
		if (review) value.store.setState({ review });
		if (github) await readDetail(task, ref, true);
		return true;
	} catch (error) {
		value.store.setState({ error: message(error) });
		return false;
	} finally {
		value.store.setState({ busy: false });
	}
}
export function reviewActions(task: AgentTask, ref: PRRefKey) {
	return {
		refresh: () => readDetail(task, ref, true),
		addDraft: (input: PRDraftInput) =>
			act(task, ref, () => window.brigadir.addPullRequestDraft(task, ref, input)),
		editDraft: (id: string, body: string) =>
			act(task, ref, () => window.brigadir.editPullRequestDraft(task, ref, id, body)),
		removeDraft: (id: string) =>
			act(task, ref, () => window.brigadir.removePullRequestDraft(task, ref, id)),
		/** spec/appearance#evolution-redesign: `Accept` on an agent's suggestion. */
		acceptDraft: (id: string) =>
			act(task, ref, () => window.brigadir.acceptPullRequestDraft(task, ref, id)),
		/** spec/pull-requests-and-ci#review-modal: `Accept all` / `Drop all` over the agent's suggestions — one busy span, the writes one after another. */
		acceptDrafts: (ids: string[]) =>
			act(task, ref, async () => {
				let review: PRReviewDraft | undefined;
				for (const id of ids) review = await window.brigadir.acceptPullRequestDraft(task, ref, id);
				return review;
			}),
		removeDrafts: (ids: string[]) =>
			act(task, ref, async () => {
				let review: PRReviewDraft | undefined;
				for (const id of ids) review = await window.brigadir.removePullRequestDraft(task, ref, id);
				return review;
			}),
		/** spec/pull-requests-and-ci#review-with-agent: a reply under an agent's draft — into its thread, then the prompt goes to the review task. */
		discuss: (id: string, body: string, send: (prompt: string) => Promise<void>) =>
			act(task, ref, async () => {
				const { review, prompt } = await window.brigadir.discussPullRequestDraft(
					task,
					ref,
					id,
					body
				);
				entry(task, ref).store.setState({ review });
				await send(prompt);
				return review;
			}),
		/** Form fields are written quietly: no busy, so the verdict switch is not blocked by saving text; the reply does not overwrite a newer choice. */
		setReview: async (patch: { body?: string; event?: PRReviewEvent; sendComments?: boolean }) => {
			const value = entry(task, ref);
			value.store.setState((state) => ({ review: { ...state.review, ...patch } }));
			value.writing++;
			value.formSeq++;
			try {
				const saved = await window.brigadir.setPullRequestReview(task, ref, patch);
				value.store.setState((state) => ({
					review: {
						...saved,
						body: state.review.body,
						event: state.review.event,
						sendComments: state.review.sendComments,
					},
				}));
				return true;
			} catch (error) {
				value.store.setState({ error: message(error) });
				return false;
			} finally {
				value.writing--;
			}
		},
		commentNow: (input: PRDraftInput) =>
			act(task, ref, () => window.brigadir.commentPullRequestNow(task, ref, input), true),
		comment: (body: string) =>
			act(task, ref, () => window.brigadir.commentPullRequest(task, ref, body), true),
		resolve: (thread: string, resolved: boolean) =>
			act(
				task,
				ref,
				() => window.brigadir.resolvePullRequestThread(task, ref, thread, resolved),
				true
			),
		viewed: (path: string, viewed: boolean) => markViewed(task, ref, path, viewed),
		dismissViewedError: () => entry(task, ref).store.setState({ viewedError: null }),
		submit: async () => {
			const value = entry(task, ref),
				event = value.store.getState().review.event;
			const done = await act(
				task,
				ref,
				() => window.brigadir.submitPullRequestReview(task, ref),
				true
			);
			if (done && event !== 'AGENT') value.store.setState({ sent: { event, at: Date.now() } });
			return done;
		},
		merge: (method: 'squash' | 'merge' | 'rebase', deleteBranch: boolean) =>
			act(task, ref, () => window.brigadir.mergePullRequest(task, ref, method, deleteBranch), true),
	};
}
export type ReviewActions = ReturnType<typeof reviewActions>;
/** A PR subscription: the first read, fresh on window focus; the state lives while the PR is open anywhere. */
export function usePRReview(
	task: AgentTask,
	ref: PRRefKey
): PRReviewState & { actions: ReviewActions } {
	const value = entry(task, ref),
		state = useStore(value.store);
	useEffect(() => {
		const current = entry(task, ref);
		current.users++;
		if (!current.store.getState().detail) void readDetail(task, ref);
		void readReview(task, ref);
		const focus = () => {
			void readDetail(task, ref, true);
		};
		window.addEventListener('focus', focus);
		// spec/pull-requests-and-ci#review-with-agent, spec/pull-requests-and-ci#review-drafts: a review task's agent adds PR drafts through pr_comment — the form
		// of any task in the project sees them after its tool call or turn.
		const stop = onSessionEvent(({ key, record }) => {
			if (
				key.projectId === task.projectId &&
				record &&
				(record.event.kind === 'tool.changed' || record.event.kind === 'turn.completed')
			)
				void readReview(task, ref);
		});
		return () => {
			window.removeEventListener('focus', focus);
			stop();
			current.users--;
		};
	}, [task.projectId, task.id, ref.scopeId, ref.number]);
	return { ...state, actions: reviewActions(task, ref) };
}
