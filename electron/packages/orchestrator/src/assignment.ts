import {
	crewAssignmentCommentLimit,
	crewAssignmentLimit,
	crewDigestSummaryLimit,
	type CrewAssignment,
	type EventRecord,
} from '@brigadir/core';

/** spec/crew#assignment-after-compaction: the first line of the block, English by rule 12. */
export const assignmentHeader =
	'Your context was compacted. This is your current assignment as it was given to you; where your summary differs, this text is right.';
const clip = (text: string, limit: number, note: string) =>
	text.length > limit ? `${text.slice(0, limit)}\n${note}` : text;

/**
 * spec/crew#assignment-after-compaction: the seq of the newest `context.compacted` that no `crew.assignment.restored` answered yet, null when every
 * compaction was answered. A restored record answers every compaction up to its `compactedSeq`.
 */
export function compactionDue(records: readonly EventRecord[]): number | null {
	let due: number | null = null;
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'context.compacted') due = record.seq;
		else if (event.kind === 'crew.assignment.restored' && due !== null && event.compactedSeq >= due)
			due = null;
	}
	return due;
}

export type AssignmentComment = {
	author: string;
	path: string;
	start: number;
	end: number;
	text: string;
};
/**
 * A developer's open part: its prompt as `crew-part.json` keeps it, the acceptance criteria, then the open review comments in the order they were
 * written, as many as fit the block; the rest are counted.
 */
export function partAssignment(input: {
	part: number;
	title: string;
	prompt: string;
	clipped?: boolean;
	acceptance?: string;
	comments: readonly AssignmentComment[];
}): string {
	const prompt = input.prompt.trim(),
		acceptance = input.acceptance?.trim() ?? '';
	const head = [
		`Part ${input.part}: ${input.title}`,
		...(prompt
			? [
					'<part_prompt>',
					input.clipped ? `${prompt}\n[The prompt is longer; the rest is left out.]` : prompt,
					'</part_prompt>',
				]
			: []),
		...(acceptance ? ['Acceptance criteria:', '<acceptance>', acceptance, '</acceptance>'] : []),
	].join('\n');
	if (!input.comments.length) return head;
	// The header line, the separators and the count line take the rest of the bound.
	let room = crewAssignmentLimit - assignmentHeader.length - head.length - 200;
	const lines: string[] = [];
	for (const comment of input.comments) {
		const line = `${lines.length + 1}. ${comment.author}, ${comment.path} lines ${comment.start}-${comment.end}: ${clip(comment.text.trim(), crewAssignmentCommentLimit, '[The comment is longer; the rest is left out.]')}`;
		if (line.length + 1 > room) break;
		room -= line.length + 1;
		lines.push(line);
	}
	const left = input.comments.length - lines.length;
	return [
		head,
		'Open review comments on this part:',
		...lines,
		...(left ? [`${left} more open ${left === 1 ? 'comment is' : 'comments are'} left out.`] : []),
	].join('\n');
}
/** A reviewer's open check: the check line, where the report and the diff are, then the part as the check prompt gives it (`partBrief`). */
export function checkAssignment(input: {
	taskId: string;
	name: string;
	reviewId: string;
	round: number;
	rounds: number;
	part: string;
}): string {
	return `Check task ${input.taskId} of \`${input.name}\` (reviewId ${input.reviewId}, round ${input.round} of ${input.rounds}).\nRead the report with read_report and the change with read_diff, passing this reviewId, then either submit_review(taskId, reviewId, comments) or approve(taskId, reviewId).${input.part}`;
}
export type DigestPart = {
	title: string;
	agent: string;
	state: string;
	/** The member's task, and its current part when it differs from the plan's. */
	taskId?: string;
	memberPart?: { number: number; title: string };
	question?: { id: string; text: string };
};
/** The foreman's or a lead's approved plan as code sees it: each part's state, executor and open question. */
export function planDigest(input: { summary: string; parts: readonly DigestPart[] }): string {
	const summary = clip(
		input.summary.trim(),
		crewDigestSummaryLimit,
		'[The summary is longer; the rest is left out.]'
	);
	const text = [
		'Your approved plan and where each part stands:',
		...(summary ? ['<plan_summary>', summary, '</plan_summary>'] : []),
		...input.parts.map((part, index) => {
			const executor = part.taskId
				? `, task ${part.taskId}${part.memberPart ? `, now on part ${part.memberPart.number}: ${part.memberPart.title}` : ''}`
				: '';
			const question = part.question
				? `\n   Open question ${part.question.id}: ${clip(part.question.text.trim(), 1000, '[The question is longer; the rest is left out.]')}`
				: '';
			return `${index + 1}. ${part.title} — ${part.agent}: ${part.state}${executor}${question}`;
		}),
		'Read a part in detail with task_status and read_report.',
	].join('\n');
	const limit = crewAssignmentLimit - assignmentHeader.length - 2;
	return text.length > limit
		? `${text.slice(0, limit - 40)}\n[The rest of the digest is left out.]`
		: text;
}
/** The `.context` block: the header line, then each piece; never longer than the bound. */
export function assignmentBlock(pieces: readonly CrewAssignment[]): string {
	const text = [assignmentHeader, ...pieces.map((piece) => piece.text)].join('\n\n');
	return text.length > crewAssignmentLimit
		? `${text.slice(0, crewAssignmentLimit - 50)}\n[The rest of the assignment is left out.]`
		: text;
}
