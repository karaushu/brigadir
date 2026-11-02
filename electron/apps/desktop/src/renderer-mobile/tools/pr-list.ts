/**
 * spec/remote-access-and-mobile#phone-pr-list: what the phone's project PR list computes from `readPullRequests` without a window — the repos on GitHub
 * and their names, the chips and their counts, the groups after the search, the task a PR belongs to. The list draws these;
 * vitest keeps them.
 */
import {
	isOpenPR,
	prGroups,
	type AgentTask,
	type PRGroup,
	type PullRequestSummary,
	type PullRequestsSnapshot,
	type RepoPullRequests,
} from '@brigadir/core';

export type PRChip = 'all' | 'waiting' | 'mine';
export type PRItem = { pr: PullRequestSummary; scopeId: string; repo: string };
export type PRSection = { group: PRGroup; items: PRItem[] };

/** The root repo is called by the project's name (spec/pull-requests-and-ci#repo-picker). */
export const repoName = (repo: Pick<RepoPullRequests, 'name'>, project: string) =>
	repo.name === '.' ? project : repo.name;
/** The repos the list can show: those with a GitHub remote; a repo whose read failed stays (its error is the banner). */
export function githubRepos(snapshot: PullRequestsSnapshot): RepoPullRequests[] {
	return snapshot.repos.filter((repo) => repo.repository !== null || repo.error !== null);
}
export function prItems(
	snapshot: PullRequestsSnapshot,
	project: string,
	scopeId: string | null
): PRItem[] {
	return snapshot.repos
		.filter((repo) => scopeId === null || repo.scopeId === scopeId)
		.flatMap((repo) =>
			repo.prs.map((pr) => ({ pr, scopeId: repo.scopeId, repo: repoName(repo, project) }))
		);
}
/** The chips' numbers: open PRs, those waiting for your review, your own (the groups Waiting for you and Yours). */
export function chipCounts(items: readonly PRItem[]): Record<PRChip, number> {
	const open = items.filter((item) => isOpenPR(item.pr));
	return {
		all: open.length,
		waiting: open.filter((item) => item.pr.waiting).length,
		mine: open.filter((item) => !item.pr.waiting && item.pr.mine).length,
	};
}
/** The default chip (spec/remote-access-and-mobile#phone-pr-list): Waiting for you while such PRs exist, otherwise All. */
export const defaultChip = (items: readonly PRItem[]): PRChip =>
	chipCounts(items).waiting > 0 ? 'waiting' : 'all';
/** The segment «PR N ●»: open PRs of every repo, and whether any waits for your review. */
export function prBadge(snapshot: PullRequestsSnapshot | null) {
	const prs = snapshot?.repos.flatMap((repo) => repo.prs) ?? [];
	const open = prs.filter(isOpenPR);
	return { open: open.length, waiting: open.some((pr) => pr.waiting) };
}
/** The search looks at the title, the branch, the author and the repo, as the computer's PR panel (spec/pull-requests-and-ci#pr-list). */
export function prMatches(item: PRItem, query: string): boolean {
	const q = query.trim().toLocaleLowerCase();
	if (!q) return true;
	return [item.pr.title, item.pr.head, item.pr.author, item.repo, `#${item.pr.number}`].some(
		(text) => text.toLocaleLowerCase().includes(q)
	);
}
/**
 * The groups of spec/pull-requests-and-ci#pr-list after the chip and the search. A chip keeps its one group; Recently closed shows with All and
 * no search — and with `closed` when the list has no open PR (Show closed).
 */
export function prSections(
	items: readonly PRItem[],
	{ chip, query, closed = false }: { chip: PRChip; query: string; closed?: boolean },
	now = Date.now()
): PRSection[] {
	const found = items.filter((item) => prMatches(item, query)),
		anyOpen = items.some((item) => isOpenPR(item.pr));
	const byPR = new Map(found.map((item) => [item.pr, item]));
	return prGroups(
		found.map((item) => item.pr),
		now
	)
		.filter(({ group }) =>
			group === 'closed'
				? chip === 'all' && !query.trim() && (anyOpen || closed)
				: chip === 'all' || chip === group
		)
		.map(({ group, prs }) => ({ group, items: prs.map((pr) => byPR.get(pr)!) }));
}
/** The task a PR belongs to (spec/remote-access-and-mobile#phone-pr-list) — one function with the project screen's PR board (spec/projects-and-board#pr-mode). */
export { prTask } from '@brigadir/core';
