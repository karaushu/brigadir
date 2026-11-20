import {
	findingCount,
	t,
	type CrewWorkerRow,
	type Locale,
	type TaskReviewMember,
	type TaskReviewView,
} from '@brigadir/core';
/**
 * spec/sidebar#crew-card: how a worker row of a crew card reads. A dismissed Auto worker is quiet and shows its own `+N −M` in place of its
 * provider; a worker over its budget says `over budget` in place of its part.
 */
export function workerRowState(row: Pick<CrewWorkerRow, 'task' | 'dismissed'>): {
	quiet: boolean;
	overBudget: boolean;
	counts: { additions: number; deletions: number } | null;
} {
	return {
		quiet: row.dismissed,
		overBudget: !row.dismissed && row.task.overBudget === true,
		// A dismissed worker that changed nothing shows no counts.
		counts:
			row.dismissed &&
			((row.task.changeSummary?.additions ?? 0) > 0 || (row.task.changeSummary?.deletions ?? 0) > 0)
				? {
						additions: row.task.changeSummary?.additions ?? 0,
						deletions: row.task.changeSummary?.deletions ?? 0,
					}
				: null,
	};
}
/** spec/reviews#surfaces: `Review`, `N findings · waits`, `Approved`, `N open` (amber), `Accepted`, `Review stopped`, `Review did not start`. */
export function reviewerState(
	view: Pick<TaskReviewView, 'members'>,
	taskId: string,
	locale: Locale
): { state?: string; stateTone?: 'amber' } {
	const member = view.members.find((item) => item.taskId === taskId);
	if (!member) return {};
	switch (member.state) {
		case 'starting':
		case 'reading':
		case 'checking':
			return { state: t(locale, 'Review') };
		case 'findings':
			return { state: `${findingCount(locale, member.findings)} · ${t(locale, 'waits')}` };
		case 'approved':
			return { state: t(locale, 'Approved') };
		case 'open':
			return {
				state: t(locale, '{count} open').replace('{count}', findingCount(locale, member.findings)),
				stateTone: 'amber',
			};
		case 'accepted':
			return { state: t(locale, 'Accepted') };
		case 'stopped':
			return { state: t(locale, 'Review stopped') };
		case 'failed':
			return { state: t(locale, 'Review did not start') };
		default:
			return {};
	}
}
/**
 * spec/reviews#surfaces: a reviewer of the task's own review keeps its row only while the current review counts it — a review that did not
 * start has none, and an earlier review's reviewers have none. Workers and a crew's own reviewers stay.
 */
export function currentReviewerRows<Row extends Pick<CrewWorkerRow, 'task' | 'reviewer'>>(
	rows: readonly Row[],
	members: readonly Pick<TaskReviewMember, 'taskId'>[]
): Row[] {
	return rows.filter(
		(row) => !row.reviewer || members.some((member) => member.taskId === row.task.id)
	);
}
/**
 * spec/reviews#surfaces: a solo task has its reviewer card only while the current review counts reviewers — before its first review and after
 * one that did not start it is a plain task row. A crew's card always stays.
 */
export function reviewCardShown(task: { crew?: unknown }, rows: readonly unknown[]): boolean {
	return Boolean(task.crew) || rows.length > 0;
}
