/**
 * A task's state and its second line in a list (spec/sidebar#layout card): the activity — a tool and its file, a question, a permission,
 * a plan — or the state. One text for the computer's sidebar and the phone's cards (spec/remote-access-and-mobile#phone-app).
 */
import {
	browserShowCard,
	mcpActivityTitle,
	t,
	type AgentTask,
	type Locale,
	type MessageKey,
} from '@brigadir/core';

export const statusLabels: Record<AgentTask['status'], MessageKey> = {
	'rate-limited': 'Rate limited',
	queued: 'Queued',
	preparing: 'Preparing…',
	working: 'Working',
	'needs-you': 'Needs you',
	done: 'Done',
	interrupted: 'Interrupted',
	failed: 'Error',
	backlog: 'Backlog',
	completed: 'Completed task',
};
export function taskActivityText(locale: Locale, task: AgentTask): string {
	const activity = task.activity;
	return activity?.kind === 'permission' && activity.title === browserShowCard.title
		? `${t(locale, 'Permission')} · ${t(locale, browserShowCard.title)}`
		: activity?.kind === 'plan'
			? t(locale, 'Plan for approval')
			: activity
				? [
						activity.kind === 'tool'
							? (mcpActivityTitle(locale, activity.title) ?? activity.title)
							: t(
									locale,
									activity.kind === 'question'
										? 'Question'
										: activity.kind === 'proposal'
											? 'New task'
											: 'Permission'
								),
						activity.kind === 'tool' ? activity.path?.split(/[\\/]/).at(-1) : activity.title,
					]
						.filter(Boolean)
						.join(' · ')
				: t(locale, task.blockedBy?.length ? 'Waiting for the lock' : statusLabels[task.status]);
}
/**
 * spec/tasks#worktree-preparation: in the sidebar, a «Preparing…» or «Queued» card shows the
 * task's branch row before its worktree exists — the planned name, or `brigadir/…` while the agent is yet to name it
 * (spec/git#agent-branch-names). Once the tree exists, `taskTree` takes over.
 */
export function cardTree(locale: Locale, task: AgentTask): AgentTask['taskTree'] | null {
	if (task.taskTree) return task.taskTree;
	const launch = task.launch;
	if ((task.status !== 'preparing' && task.status !== 'queued') || launch?.isolation !== 'worktree')
		return null;
	const branch =
		task.worktreeBranch ?? (launch.branchAuto ? t(locale, 'brigadir/…') : launch.branch);
	return branch ? { branch, worktree: true } : null;
}
