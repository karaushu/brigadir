import type { CrewWorkerRow } from '@brigadir/core';
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
