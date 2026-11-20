import { describe, expect, it } from 'vitest';
import {
	changeSize,
	defaultSmallTaskLimit,
	hiredPartsBack,
	isReviewSettings,
	smokeMinutesOf,
	overSmallTask,
	runningHires,
	smallTaskLimitOf,
	taskClassAdds,
	taskClassOf,
	tripwireArmed,
	tripwireFired,
} from './task-class';
import { isSessionEvent } from './event-validation';
import type { ChangedFile } from './changes';
import type { EventRecord, SessionEvent } from './session';

const file = (
	path: string,
	additions: number,
	deletions: number,
	extra: Partial<ChangedFile> = {}
) =>
	({
		id: path,
		scopeId: 'root',
		path,
		oldPath: path,
		status: 'M',
		beforeMode: '100644',
		afterMode: '100644',
		before: null,
		after: null,
		additions,
		deletions,
		binary: false,
		generated: false,
		gitlink: false,
		...extra,
	}) satisfies ChangedFile;
const journal = (...events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: '2026-11-19T10:00:00.000Z',
		event,
	}));
const hire = (taskIds: string[]): SessionEvent => ({
	kind: 'crew.hire.resolved',
	id: 'hire',
	approved: true,
	parts: null,
	hired: taskIds.map((taskId) => ({
		partId: taskId,
		taskId,
		name: 'Developer',
		role: 'Developer',
	})),
});
const dismissed = (
	taskId: string,
	reason: 'accepted' | 'discarded' = 'accepted'
): SessionEvent => ({
	kind: 'crew.worker.dismissed',
	taskId,
	nodeId: taskId,
	name: 'Developer',
	title: 'Part',
	reason,
});

describe('spec/reviews#tripwire', () => {
	it('counts files and added plus deleted lines, without generated files, binaries or submodule pointers', () => {
		expect(
			changeSize([
				file('src/a.ts', 10, 2),
				file('src/b.ts', 1, 0),
				file('pnpm-lock.yaml', 900, 400, { generated: true }),
				file('logo.png', 0, 0, { binary: true }),
				file('vendor/lib', 1, 1, { gitlink: true }),
			])
		).toEqual({ files: 2, lines: 13 });
	});
	it('fires past the limit: more files or more lines', () => {
		expect(overSmallTask({ files: 15, lines: 300 }, defaultSmallTaskLimit)).toBe(false);
		expect(overSmallTask({ files: 16, lines: 10 }, defaultSmallTaskLimit)).toBe(true);
		expect(overSmallTask({ files: 2, lines: 301 }, defaultSmallTaskLimit)).toBe(true);
	});
	it('reads the limit from the settings, a missing or broken one as the default (spec/settings-modules-and-onboarding#settings-keys)', () => {
		expect(smallTaskLimitOf({ reviews: { smallTask: { files: 4, lines: 50 } } })).toEqual({
			files: 4,
			lines: 50,
		});
		expect(smallTaskLimitOf({})).toEqual({ files: 15, lines: 300 });
		expect(smallTaskLimitOf({ reviews: { smallTask: { files: 0, lines: 50 } } })).toEqual({
			files: 15,
			lines: 300,
		});
		expect(isReviewSettings({ smallTask: { files: 500, lines: 20_000 }, smokeMinutes: 60 })).toBe(
			true
		);
		expect(isReviewSettings({ smallTask: { files: 501, lines: 300 }, smokeMinutes: 10 })).toBe(
			false
		);
		expect(isReviewSettings({ smallTask: { files: 15, lines: 9 }, smokeMinutes: 10 })).toBe(false);
		// spec/smoke-run#limit: `Smoke run limit` is 1–60 minutes; a document from before it reads as 10.
		expect(isReviewSettings({ smallTask: { files: 15, lines: 300 }, smokeMinutes: 61 })).toBe(
			false
		);
		expect(isReviewSettings({ smallTask: { files: 15, lines: 300 } })).toBe(false);
		expect(smokeMinutesOf({ reviews: { smallTask: { files: 4, lines: 50 } } })).toBe(10);
		expect(
			smokeMinutesOf({ reviews: { smallTask: { files: 4, lines: 50 }, smokeMinutes: 25 } })
		).toBe(25);
		expect(
			smokeMinutesOf({ reviews: { smallTask: { files: 4, lines: 50 }, smokeMinutes: 0 } })
		).toBe(10);
	});
	it('watches a task with no class or a Small one, until it fires once', () => {
		expect(tripwireArmed([])).toBe(true);
		const small = journal({ kind: 'task.class', class: 'small', reason: 'one file', by: 'agent' });
		expect(tripwireArmed(small)).toBe(true);
		expect(
			tripwireArmed(journal({ kind: 'task.class', class: 'medium', reason: 'an API', by: 'agent' }))
		).toBe(false);
		const fired = journal(
			{ kind: 'task.class', class: 'small', reason: 'one file', by: 'agent' },
			{
				kind: 'task-review.started',
				id: 'r1',
				point: 'mid',
				startedBy: 'host',
				reviewers: ['Codex'],
				threshold: { files: 16, lines: 40 },
			}
		);
		// The review's start alone counts: a host that stopped before the raise does not fire again.
		expect(tripwireFired(fired)).toBe(true);
		// The agent lowering the class back to Small does not re-arm it.
		const lowered = journal(
			{
				kind: 'task.class',
				class: 'medium',
				reason: '',
				by: 'host',
				previous: 'small',
				cause: 'threshold',
				files: 16,
				lines: 40,
			},
			{
				kind: 'task.class',
				class: 'small',
				reason: 'back to one file',
				by: 'agent',
				previous: 'medium',
			}
		);
		expect(taskClassOf(lowered)).toBe('small');
		expect(tripwireArmed(lowered)).toBe(false);
	});
});

describe('spec/reviews#large-review', () => {
	it('the hired parts are back once no worker runs and a part was accepted since the newest hire', () => {
		expect(hiredPartsBack(journal(hire(['w1', 'w2']), dismissed('w1')))).toBe(false);
		expect(runningHires(journal(hire(['w1', 'w2']), dismissed('w1')))).toEqual(['w2']);
		expect(hiredPartsBack(journal(hire(['w1', 'w2']), dismissed('w1'), dismissed('w2')))).toBe(
			true
		);
		expect(hiredPartsBack(journal(hire(['w1']), dismissed('w1', 'discarded')))).toBe(false);
	});
	it('a mid-task review that started after the hire covers it', () => {
		const records = journal(hire(['w1']), dismissed('w1'), {
			kind: 'task-review.started',
			id: 'r1',
			point: 'mid',
			startedBy: 'host',
			reviewers: ['Codex'],
			hired: true,
		});
		expect(hiredPartsBack(records)).toBe(false);
	});
});

describe('spec/reviews#classes', () => {
	it('the newest class event is the class; the chat row says what it adds', () => {
		expect(taskClassOf([])).toBeNull();
		expect(
			taskClassOf(
				journal(
					{ kind: 'task.class', class: 'small', reason: 'one file', by: 'agent' },
					{
						kind: 'task.class',
						class: 'large',
						reason: '',
						by: 'host',
						previous: 'small',
						cause: 'hire',
					}
				)
			)
		).toBe('large');
		expect(taskClassAdds('small', true)).toBe('review before PR');
		expect(taskClassAdds('medium', false)).toBe('plan · plan review');
		expect(taskClassAdds('large', false)).toBe('plan · reviews');
		expect(taskClassAdds('large', true)).toBe('plan · reviews · workers');
	});
	it('validates the journal event (rule 2)', () => {
		expect(isSessionEvent({ kind: 'task.class', class: 'small', reason: 'x', by: 'agent' })).toBe(
			true
		);
		expect(
			isSessionEvent({
				kind: 'task.class',
				class: 'medium',
				reason: '',
				by: 'host',
				previous: 'small',
				cause: 'threshold',
				files: 16,
				lines: 400,
			})
		).toBe(true);
		expect(isSessionEvent({ kind: 'task.class', class: 'huge', reason: 'x', by: 'agent' })).toBe(
			false
		);
		expect(
			isSessionEvent({ kind: 'task.class', class: 'small', reason: 'x', by: 'agent', cause: 'why' })
		).toBe(false);
		expect(
			isSessionEvent({
				kind: 'task-review.started',
				id: 'r1',
				point: 'mid',
				startedBy: 'host',
				reviewers: [],
				threshold: { files: 3, lines: 9 },
			})
		).toBe(true);
	});
});
