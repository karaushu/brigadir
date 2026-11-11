import {
	crewIssues,
	resolveCrew,
	templateLookup,
	type AgentProvider,
	type CrewLibrary,
	type CrewSpec,
	type ProjectReviewNotes,
} from '@brigadir/core';
/**
 * spec/pull-requests-and-ci#review-crew: a PR review by a crew. The task stays `Review #N` with `prReview`; its agent is the foreman, who gives each reviewer
 * the whole PR, merges what they found and leaves each finding once as a `pr_comment` draft.
 */
export function resolveReviewCrew(
	library: CrewLibrary,
	templateId: string,
	defaultProvider: AgentProvider
): CrewSpec {
	const template = library.crews.find((item) => item.id === templateId);
	if (!template) throw new Error('The crew template is unavailable');
	const lookup = templateLookup(library.agents),
		issues = crewIssues(template, lookup);
	if (issues.length) throw new Error(issues[0]!.message);
	const crew = resolveCrew(template, { lookup, defaultProvider });
	if (!crew.root.agents.length) throw new Error('The crew has no reviewers');
	return crew;
}
export type ReviewCrewPromptInput = {
	pr: { number: number; title: string; head: string; base: string };
	/** spec/pull-requests-and-ci#review-with-agent: the foreman sits in the main tree on the person's branch; without it, in the review worktree on the PR head. */
	quick: boolean;
	/** The repo of the PR relative to the project (`.` for the root) and the merge base of the PR with its base branch. */
	repo: string;
	mergeBase: string;
	crew: CrewSpec;
	/** spec/pull-requests-and-ci#review-launch: the project's review notes and the person's instructions (`reviewGuidance`), empty when none. */
	guidance?: string;
};
/** English by rule 12: the foreman's first prompt. The host starts reviewers without a plan in a review task (spec/pull-requests-and-ci#review-crew). */
export function reviewCrewPrompt({
	pr,
	quick,
	repo,
	mergeBase,
	crew,
	guidance = '',
}: ReviewCrewPromptInput) {
	const prRef = `refs/brigadir-v2/pr/${pr.number}`,
		names = crew.root.agents.map((agent) => agent.name),
		listed = names.map((name) => `\`${name}\``).join(', '),
		example = names.join(', ');
	const reading = quick
		? `Each reviewer works in its own worktree checked out at the PR head; no setup command ran there, so dependencies may be missing. The PR head is fetched as ${prRef} in the repo ${repo}; its merge base with ${pr.base} is ${mergeBase}. Tell each reviewer to read the change with \`git -C ${repo} diff ${mergeBase} ${prRef}\`, a file with \`git -C ${repo} show ${prRef}:<path>\`, and to search with \`git -C ${repo} grep <pattern> ${prRef}\`.`
		: `Each reviewer works in its own worktree checked out at the PR head (${prRef} in the repo ${repo}). Its merge base with ${pr.base} is ${mergeBase}: tell each reviewer to read the change with \`git -C ${repo} diff ${mergeBase} HEAD\` and the files of its tree.`;
	const own = quick
		? `Your own tree is the person's branch, not the PR: read the PR from git the same way when you check a finding, and do not switch branches.`
		: `Your own tree is the PR head; read it when you check a finding.`;
	return [
		`You lead the review crew of pull request #${pr.number} "${pr.title}" (${pr.head} → ${pr.base}). Your reviewers: ${listed}.`,
		`This is a review the person already asked for: there is no plan to propose. Do not call propose_plan. Right away, call create_worker_task once for each reviewer (agent: its name) and give each of them the whole PR to review on its own; do not split the files between them.`,
		`${reading} Each reviewer reads the existing review threads too, changes no code and commits nothing, and reports every finding in its final message as one line \`path:line — finding\`, the most important first.`,
		own,
		`Reports arrive by themselves when a reviewer finishes. Read each with read_report. Merge the findings that are the same, settle disagreements between the reviewers by reading the code yourself, and drop what does not hold. Leave each remaining finding once as a draft comment on its lines with the pr_comment tool; the last line of its body names who found it, like \`— ${example}\`. Accept each reviewer's task with accept_task once you have its report. The person sends the review. Do not change code.`,
		...(guidance
			? [
					`Pass everything below word for word into each reviewer's brief, and follow it yourself when you merge the findings.${guidance}`,
				]
			: []),
	].join('\n\n');
}

/**
 * spec/pull-requests-and-ci#review-launch, spec/pull-requests-and-ci#review-notes: what a review prompt ends with — the project's notes (its text, or REVIEW.md
 * read at the merge base), then the person's instructions for this review as typed. Empty when there is neither.
 */
export function reviewGuidance(
	projectNotes: ProjectReviewNotes | undefined,
	notes: string,
	repo: string,
	mergeBase: string
) {
	const parts = [
		projectNotes?.source === 'text' ? `Review notes of this project:\n${projectNotes.text}` : '',
		projectNotes?.source === 'file'
			? `This project keeps its review notes in REVIEW.md: read it at the merge base with \`git -C ${repo} show ${mergeBase}:REVIEW.md\` and follow it. If there is no such file, go on without it.`
			: '',
		notes.trim() ? `Instructions from the person for this review:\n${notes}` : '',
	].filter(Boolean);
	return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}
