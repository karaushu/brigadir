import { expect, it } from 'vitest';
import {
	crewReportDone,
	crewReviewRounds,
	crewReviewStep,
	isCrewPartBrief,
	isCrewWorkerRecord,
	isReviewRun,
} from './crew-runtime';

const record = {
	taskId: 'task-1',
	nodeId: 'developer',
	name: 'Developer',
	title: 'Client details',
	createdAt: '2026-01-01T00:00:00.000Z',
	planPartId: null,
};

it('loads a worker record written before the part kept its prompt and rounds, and checks the new fields (spec/crew#files)', () => {
	expect(isCrewWorkerRecord(record)).toBe(true);
	expect(isCrewWorkerRecord({ ...record, rounds: 2, limitTold: true })).toBe(true);
	expect(isCrewWorkerRecord({ ...record, rounds: -1 })).toBe(false);
	expect(isCrewWorkerRecord({ ...record, rounds: 1.5 })).toBe(false);
	expect(isCrewWorkerRecord({ ...record, limitTold: 'yes' })).toBe(false);
	const run = {
		reviewId: 'r1',
		taskId: 'task-1',
		nodeId: 'developer',
		name: 'Developer',
		title: 'Client details',
		reportSeq: 3,
		reportHash: 'h',
		scopeSnapshots: [],
		round: 1,
		reviewerNodeIds: ['reviewer'],
		dispatched: [],
		verdicts: [],
		state: 'comments',
		createdAt: '2026-01-01T00:00:00.000Z',
	};
	expect(isReviewRun(run)).toBe(true);
	expect(isReviewRun({ ...run, part: 2 })).toBe(true);
	expect(isReviewRun({ ...run, part: 0 })).toBe(false);
});

it('calls a report done only when the task is done after an end_turn (spec/crew#reports)', () => {
	expect(crewReportDone('done', 'end_turn')).toBe(true);
	expect(crewReportDone('done', 'max_tokens')).toBe(false);
	expect(crewReportDone('done', 'max_turn_requests')).toBe(false);
	expect(crewReportDone('done', 'refusal')).toBe(false);
	expect(crewReportDone('interrupted', 'cancelled')).toBe(false);
	expect(crewReportDone('rate-limited', 'end_turn')).toBe(false);
	expect(crewReportDone('needs-you', 'end_turn')).toBe(false);
	expect(crewReportDone('failed', null)).toBe(false);
});

it('opens a round while the part has rounds left, tells the parent once at the limit, and sends the rest up (spec/crew#review-limit)', () => {
	const step = (rounds: number, limitTold = false, done = true, files = 1) =>
		crewReviewStep({ done, files, rounds, limitTold });
	expect(crewReviewRounds).toBe(2);
	expect(step(0)).toBe('review');
	expect(step(1)).toBe('review');
	expect(step(2)).toBe('limit');
	expect(step(3)).toBe('limit');
	expect(step(3, true)).toBe('report');
	expect(step(0, false, false)).toBe('report');
	expect(step(0, false, true, 0)).toBe('report');
	// A report that is not done spends nothing, even past the limit.
	expect(step(5, false, false)).toBe('report');
});

it('checks the part brief a member keeps for its reviewers (spec/crew#workers)', () => {
	const brief = { schemaVersion: 1, part: 2, prompt: 'Build it.' };
	expect(isCrewPartBrief(brief)).toBe(true);
	expect(isCrewPartBrief({ ...brief, acceptance: 'Tests pass.', clipped: true })).toBe(true);
	expect(isCrewPartBrief({ ...brief, prompt: 'x'.repeat(100_001) })).toBe(false);
	expect(isCrewPartBrief({ ...brief, acceptance: 'x'.repeat(20_001) })).toBe(false);
	expect(isCrewPartBrief({ ...brief, part: 0 })).toBe(false);
});
