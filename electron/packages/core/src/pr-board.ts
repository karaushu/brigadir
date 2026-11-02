import { isOpenPR, recentlyClosed, type PullRequestSummary } from './pull-requests';
import type { AgentTask } from './workspace';

/** spec/projects-and-board#pr-mode: PR board columns and list sections. */
export type PRColumn = 'draft' | 'open' | 'review' | 'closed';
export const prColumnOrder: readonly PRColumn[] = ['draft', 'open', 'review', 'closed'];
/** spec/projects-and-board#pr-mode: the `Pull requests` tab filter. */
export type PRFilter = 'all' | 'mine' | 'waiting';
export const prFilters: readonly PRFilter[] = ['all', 'mine', 'waiting'];

/** A review started here (spec/projects-and-board#pr-mode): drafts, a general comment or verdict (`note`), viewed files — from the PR review file (spec/pull-requests-and-ci#review-drafts). */
export type PRLocalReview = {
	drafts: number;
	note: boolean;
	viewed: { n: number; of: number } | null;
};
export function reviewStarted(local: PRLocalReview | null | undefined) {
	return Boolean(local && (local.drafts > 0 || local.note || (local.viewed?.n ?? 0) > 0));
}
/** A PR key within a project: the canonical repo id (spec/pull-requests-and-ci#review-drafts) and the number. */
export const prKeyOf = (scopeId: string, number: number) => `${scopeId}#${number}`;
/** spec/projects-and-board#pr-mode: the project panel tab and the PR filter, persisted next to Board / List. */
/** spec/notifications-slack-notes-and-schedules#notes: `notes` — the project's notes, the Notes screen filtered to the project. */
export type ProjectTab = 'tasks' | 'prs' | 'notes';
export type ProjectMode = {
	tab: ProjectTab;
	filter: PRFilter;
	/** spec/projects-and-board#pr-mode: the repo the PR tab shows, `boardRepoKey` (`<projectId>/<scopeId>`); none — all repos. */ repo?:
		string | null;
};
export const defaultProjectMode: ProjectMode = { tab: 'tasks', filter: 'all' };
export const isProjectMode = (value: unknown): value is ProjectMode =>
	typeof value === 'object' &&
	value !== null &&
	((value as ProjectMode).tab === 'tasks' ||
		(value as ProjectMode).tab === 'prs' ||
		(value as ProjectMode).tab === 'notes') &&
	prFilters.includes((value as ProjectMode).filter) &&
	((value as ProjectMode).repo === undefined ||
		(value as ProjectMode).repo === null ||
		(typeof (value as ProjectMode).repo === 'string' &&
			(value as ProjectMode).repo!.length <= 400));
/** spec/projects-and-board#pr-mode: a repo of the board — the project and the repo's main-tree id. */
export const boardRepoKey = (projectId: string, scopeId: string) => `${projectId}/${scopeId}`;
/** A GitHub review by someone other than the author: approved, requested changes or commented (a requested reviewer is not a review yet). */
export function reviewedOnGitHub(pr: Pick<PullRequestSummary, 'author' | 'reviewers'>) {
	return pr.reviewers.some(
		(r) =>
			r.login !== pr.author &&
			(r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED')
	);
}

/** The column of one PR; `null` — closed more than 7 days ago, not on the board. A draft with a review stays a draft. */
export function prColumn(
	pr: PullRequestSummary,
	local: PRLocalReview | null | undefined,
	now = Date.now()
): PRColumn | null {
	if (!isOpenPR(pr)) return recentlyClosed(pr, now) ? 'closed' : null;
	if (pr.state === 'DRAFT') return 'draft';
	return reviewedOnGitHub(pr) || reviewStarted(local) ? 'review' : 'open';
}

export function prPasses(
	pr: Pick<PullRequestSummary, 'mine' | 'waiting' | 'state'>,
	filter: PRFilter
) {
	return filter === 'all' || (filter === 'mine' ? pr.mine : isOpenPR(pr) && pr.waiting);
}

/**
 * spec/projects-and-board#pr-mode: PRs by column. Open columns put those waiting for you first, then newer by `updatedAt`;
 * closed ones sort by close time. Empty columns stay: the board draws them dashed.
 */
export function prColumns<T extends { pr: PullRequestSummary; local?: PRLocalReview | null }>(
	items: readonly T[],
	filter: PRFilter = 'all',
	now = Date.now()
): { column: PRColumn; items: T[] }[] {
	const by = new Map<PRColumn, T[]>(prColumnOrder.map((column) => [column, []]));
	for (const item of items) {
		if (!prPasses(item.pr, filter)) continue;
		const column = prColumn(item.pr, item.local, now);
		if (column) by.get(column)!.push(item);
	}
	const time = (pr: PullRequestSummary, closed: boolean) =>
		Date.parse((closed ? pr.closedAt : null) ?? pr.updatedAt) || 0;
	return prColumnOrder.map((column) => ({
		column,
		items: [...by.get(column)!].sort(
			(a, b) =>
				(column === 'closed' ? 0 : Number(b.pr.waiting) - Number(a.pr.waiting)) ||
				time(b.pr, column === 'closed') - time(a.pr, column === 'closed')
		),
	}));
}

/** The count on `Waiting for you` (spec/projects-and-board#pr-mode): open PRs waiting for you. */
export const waitingCount = (prs: readonly PullRequestSummary[]) =>
	prs.filter((pr) => isOpenPR(pr) && pr.waiting).length;
/**
 * The task a PR belongs to (spec/remote-access-and-mobile#phone-pr-list; spec/projects-and-board#pr-mode — the `Task …` button on a PR card): the PR recorded on a live task of the project — by its address,
 * which names the repo too, or by the repo id and number when the task works in the main tree.
 */
export function prTask(
	tasks: readonly AgentTask[],
	projectId: string,
	item: { scopeId: string; number: number; url?: string | undefined }
): AgentTask | null {
	return (
		tasks.find(
			(task) =>
				task.projectId === projectId &&
				!task.archived &&
				Object.entries(task.pullRequests ?? {}).some(
					([scopeId, ref]) =>
						ref.number === item.number &&
						((item.url !== undefined && ref.url === item.url) || scopeId === item.scopeId)
				)
		) ?? null
	);
}
