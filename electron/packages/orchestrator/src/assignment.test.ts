import { expect, it } from 'vitest';
import { crewAssignmentLimit, type EventRecord, type SessionEvent } from '@brigadir/core';
import {
	assignmentBlock,
	assignmentHeader,
	compactionDue,
	partAssignment,
	planDigest,
} from './assignment';

const record = (seq: number, event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '',
	event,
});
const compacted: SessionEvent = { kind: 'context.compacted', before: 1, after: null };

it('finds the newest compaction no assignment block answered (spec/crew#assignment-after-compaction)', () => {
	expect(compactionDue([])).toBeNull();
	expect(compactionDue([record(1, compacted)])).toBe(1);
	const answered = record(2, {
		kind: 'crew.assignment.restored',
		compactedSeq: 1,
		assignment: ['part'],
	});
	expect(compactionDue([record(1, compacted), answered])).toBeNull();
	// A second compaction is due again; one block answers every compaction up to its seq.
	expect(compactionDue([record(1, compacted), answered, record(3, compacted)])).toBe(3);
	expect(
		compactionDue([
			record(1, compacted),
			record(2, compacted),
			record(3, { kind: 'crew.assignment.restored', compactedSeq: 2, assignment: [] }),
		])
	).toBeNull();
	expect(
		compactionDue([
			record(1, compacted),
			record(2, compacted),
			record(3, { kind: 'crew.assignment.restored', compactedSeq: 1, assignment: [] }),
		])
	).toBe(2);
});

it('keeps the whole block within 128 000 chars: the prompt and criteria whole, comments as they fit, the rest counted (spec/crew#assignment-after-compaction)', () => {
	const prompt = 'p'.repeat(100_000),
		acceptance = 'a'.repeat(20_000);
	const comments = Array.from({ length: 10 }, (_, index) => ({
		author: 'Reviewer',
		path: `out/${index}.ts`,
		start: 1,
		end: 2,
		text: 'c'.repeat(5_000),
	}));
	const text = partAssignment({ part: 2, title: 'Phones', prompt, acceptance, comments });
	expect(text).toContain(prompt);
	expect(text).toContain(acceptance);
	// Each comment is clipped to 2 000 chars; three fit the room the prompt leaves.
	expect(text).toContain(
		`1. Reviewer, out/0.ts lines 1-2: ${'c'.repeat(2_000)}\n[The comment is longer`
	);
	expect(text).toContain('3. Reviewer, out/2.ts');
	expect(text).not.toContain('4. Reviewer');
	expect(text).toMatch(/\n7 more open comments are left out\.$/);
	const block = assignmentBlock([{ kind: 'part', text }]);
	expect(block.startsWith(`${assignmentHeader}\n\nPart 2: Phones\n`)).toBe(true);
	expect(block.length).toBeLessThanOrEqual(crewAssignmentLimit);
	expect(block).not.toContain('The rest of the assignment');
	// A block past the bound (a lead's part and digest together) is cut with a note.
	const long = assignmentBlock([
		{ kind: 'part', text },
		{ kind: 'plan', text: 'd'.repeat(50_000) },
	]);
	expect(long.length).toBeLessThanOrEqual(crewAssignmentLimit);
	expect(long).toMatch(/\[The rest of the assignment is left out\.\]$/);
});

it("writes the plan digest with each part's state, executor and question, and bounds it (spec/crew#assignment-after-compaction)", () => {
	expect(
		planDigest({
			summary: '',
			parts: [
				{
					title: 'Client list',
					agent: 'Developer',
					state: 'working',
					taskId: 't1',
					memberPart: { number: 2, title: 'Client card' },
				},
			],
		})
	).toBe(
		'Your approved plan and where each part stands:\n1. Client list — Developer: working, task t1, now on part 2: Client card\nRead a part in detail with task_status and read_report.'
	);
	const huge = planDigest({
		summary: 's'.repeat(10_000),
		parts: Array.from({ length: 64 }, (_, index) => ({
			title: 't'.repeat(2_000),
			agent: `A${index}`,
			state: 'not started',
			question: { id: `q${index}`, text: 'q'.repeat(5_000) },
		})),
	});
	expect(huge).toContain(`${'s'.repeat(4_000)}\n[The summary is longer; the rest is left out.]`);
	expect(huge.length).toBeLessThanOrEqual(crewAssignmentLimit - assignmentHeader.length);
	expect(huge).toMatch(/\[The rest of the digest is left out\.\]$/);
});
