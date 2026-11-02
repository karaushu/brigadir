import { commentCount, t, type AgentTask, type Locale, type PRRefKey } from '@brigadir/core';
import type { QuickTaskRequest } from './QuickTask';

/**
 * spec/tasks#quick-tasks: in the main tree «To the agent» on a PR is a quick task without isolation on the PR's branch (it switches the
 * tree if clean). The review's drafts go along as context. Shared by the main tree's task view and the project screen (spec/projects-and-board#pr-mode).
 */
export async function prFixQuickTask(
	task: AgentTask,
	ref: PRRefKey,
	locale: Locale
): Promise<Omit<QuickTaskRequest, 'projectId'>> {
	const [review, detail] = await Promise.all([
		window.brigadir.readPullRequestReview(task, ref),
		window.brigadir.readPullRequestDetail(task.projectId, task.id, ref, false),
	]);
	const lines = review.drafts
		.map((draft) => `- ${draft.path}:${draft.line}: ${draft.body}`)
		.join('\n');
	return {
		scopeId: ref.scopeId,
		title: `${t(locale, 'Fixes')} #${ref.number}`,
		prompt: `Address the review of pull request #${ref.number} "${detail.summary.title}". Do not push: the person confirms the push.`,
		branch: detail.summary.head,
		context: [
			...(lines
				? [
						{
							icon: 'github' as const,
							label: `${commentCount(locale, review.drafts.length)} · #${ref.number}`,
							text: `Review comments:\n${lines}`,
						},
					]
				: []),
			{
				icon: 'pr-branch' as const,
				label: `PR #${ref.number} · ${detail.summary.head}`,
				text: `Pull request #${ref.number}: ${detail.summary.head} → ${detail.summary.base}.`,
			},
		],
	};
}
/** spec/pull-requests-and-ci#review-modal, spec/pull-requests-and-ci#hand-to-agent: a prompt to a task that already exists (the task of one's own PR); the host starts if it slept. */
export async function deliverPrompt(
	target: AgentTask,
	text: string,
	attachment?: { name: string; text: string }
) {
	const ids = attachment
			? [(await window.brigadir.createAttachment(target, { kind: 'text', ...attachment })).id]
			: undefined,
		command = { kind: 'prompt' as const, text, ...(ids ? { attachmentIds: ids } : {}) };
	try {
		await window.brigadir.sendCommand(target, command);
	} catch {
		await window.brigadir.startSession(target);
		await window.brigadir.sendCommand(target, command);
	}
}
