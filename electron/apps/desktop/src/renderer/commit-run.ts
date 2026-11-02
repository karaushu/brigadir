import { create } from 'zustand';
import {
	commitCount,
	dropCommitted,
	scopeCount,
	t,
	type AgentTask,
	type CommitBasketPlan,
	type CommitBasketState,
	type CommitBasketsResult,
	type Locale,
} from '@brigadir/core';
import { openCommitDialog, updateTaskState } from './task-state';
import { useWorkspace } from './store';
import { notify, toastError } from './ui/Toast';
/**
 * spec/git#commit-dialog: the commit dialog's sequence lives here, not in the dialog — Esc hides the dialog and the commits go
 * on; the result reaches the strip (main writes `commits.json`), a toast and the task's baskets.
 */
export type CommitStep = {
	state: CommitBasketState;
	sha?: string | undefined;
	output?: string | undefined;
};
export type CommitRun = {
	running: boolean;
	/** Basket id → its step; the baskets of the run in their order. */ steps: Record<
		string,
		CommitStep
	>;
	order: string[];
	/** The baskets as they were sent: a committed one stays on screen from here once it left the task's baskets. */ plan: CommitBasketPlan[];
	push: boolean;
};
export const useCommitRuns = create<{ runs: Record<string, CommitRun> }>(() => ({ runs: {} }));
const runKey = (task: { projectId: string; id: string }) => `${task.projectId}/${task.id}`;
function setRun(key: string, update: (run: CommitRun | undefined) => CommitRun | undefined) {
	useCommitRuns.setState((state) => {
		const next = update(state.runs[key]),
			runs = { ...state.runs };
		if (next) runs[key] = next;
		else delete runs[key];
		return { runs };
	});
}
/** `Push commits…` for these repos one after another, each the forge dialog with its own SHA confirmation; the dialog's
 *  `Push` / `Commit and push` and the strip's SHA line share it (spec/git#commit-dialog). */
export function pushRepos(
	forge: {
		refresh(remote: boolean, fresh?: boolean): Promise<unknown>;
		open(action: 'push', id: string, returnFocus?: HTMLElement | null, done?: () => void): void;
	},
	ids: string[]
) {
	const next = (rest: string[]) => {
		const [id, ...more] = rest;
		if (id) forge.open('push', id, null, () => next(more));
	};
	void forge.refresh(false, true).then(() => next(ids));
}
export function clearCommitRun(task: AgentTask) {
	setRun(runKey(task), (run) => (run?.running ? run : undefined));
}
/** A repo's name as the Repos chip and the panel root show it: the project's own root («.») is the project's name. */
export function repoDisplayName(task: Pick<AgentTask, 'projectId'>, name: string) {
	if (name !== '.') return name;
	return (
		useWorkspace.getState().workspace?.projects.find((value) => value.id === task.projectId)
			?.name ?? name
	);
}
/** The result toast: «Committed 3 commits to business.» / «… in 2 repos.» with Push (spec/appearance#evolution-redesign, after a commit). */
function committedToast(
	task: AgentTask,
	locale: Locale,
	result: CommitBasketsResult,
	push: ((scopeIds: string[]) => void) | null
) {
	const repos = [
		...new Map(
			result.committed.map((item) => [item.scopeId, repoDisplayName(task, item.name)])
		).entries(),
	];
	if (!repos.length) return;
	const commits = commitCount(locale, result.committed.length),
		one = repos.length === 1;
	const text = one
		? t(locale, 'Committed {commits} to {repo}.')
				.replace('{commits}', commits)
				.replace('{repo}', repos[0]![1])
		: t(locale, 'Committed {commits} in {repos}.')
				.replace('{commits}', commits)
				.replace('{repos}', scopeCount(locale, repos.length));
	notify('success', text, {
		...(one ? { bold: repos[0]![1] } : {}),
		...(push
			? {
					action: {
						label: t(locale, one ? 'Push' : 'Push all'),
						run: () => push(repos.map(([id]) => id)),
					},
				}
			: {}),
	});
}
export async function runCommitBaskets({
	task,
	locale,
	revision,
	plan,
	push,
	pushNow,
}: {
	task: AgentTask;
	locale: Locale;
	revision: string;
	plan: CommitBasketPlan[];
	/** Opens `Push commits…` for these repos, one after another (the forge dialog with its own SHA confirmation). */
	push: ((scopeIds: string[]) => void) | null;
	/** «Commit and push»: the push dialog opens right after the commits. */
	pushNow: boolean;
}): Promise<CommitBasketsResult | null> {
	const key = runKey(task);
	if (useCommitRuns.getState().runs[key]?.running) return null;
	setRun(key, () => ({
		running: true,
		push: pushNow,
		plan,
		order: plan.map((basket) => basket.id),
		steps: Object.fromEntries(plan.map((basket) => [basket.id, { state: 'waiting' }])),
	}));
	const stop = window.brigadir.onCommitProgress((progress) => {
		if (progress.key.projectId !== task.projectId || progress.key.id !== task.id) return;
		setRun(key, (run) =>
			run
				? {
						...run,
						steps: {
							...run.steps,
							[progress.basketId]: {
								state: progress.state,
								sha: progress.sha,
								output: progress.output,
							},
						},
					}
				: run
		);
	});
	try {
		const result = await window.brigadir.commitBaskets(task, revision, plan);
		const done = new Set(
			result.baskets
				.filter((basket) => basket.state === 'done' || basket.state === 'skipped')
				.map((basket) => basket.id)
		);
		setRun(key, (run) => ({
			running: false,
			push: pushNow,
			plan,
			order: run?.order ?? plan.map((basket) => basket.id),
			steps: Object.fromEntries(
				result.baskets.map((basket) => [
					basket.id,
					{ state: basket.state, sha: basket.sha, output: basket.output },
				])
			),
		}));
		const failed = result.baskets.find((basket) => basket.state === 'failed');
		if (!failed) {
			// All in: the dialog closes and starts afresh next time; the strip shows every SHA.
			updateTaskState(task, {
				commitDialog: null,
				commitBaskets: null,
				commitUndo: null,
				commitMessage: null,
			});
			setRun(key, () => undefined);
		} else {
			updateTaskState(task, (state) => ({
				commitBaskets: state.commitBaskets && {
					...state.commitBaskets,
					baskets: dropCommitted(state.commitBaskets.baskets, done),
				},
			}));
			toastError(t(locale, 'Commit stopped: a hook or Git refused it.'), {
				action: { label: t(locale, 'Show'), run: () => openCommitDialog(task) },
			});
		}
		// «Commit and push» goes straight to the push dialog, whose own toast reports the push.
		if (!failed && !(pushNow && push)) committedToast(task, locale, result, push);
		if (pushNow && !failed && push && result.committed.length)
			push([...new Set(result.committed.map((item) => item.scopeId))]);
		return result;
	} catch (error) {
		setRun(key, () => undefined);
		const text = error instanceof Error ? error.message : '';
		toastError(
			text.includes('Files changed') || text.includes('branch changed')
				? `${t(locale, 'Could not commit the changes.')} ${t(locale, 'Files changed. Review the commit list again.')}`
				: text.includes('Wait for the agent')
					? `${t(locale, 'Could not commit the changes.')} ${t(locale, 'Wait for the agent to finish before committing')}`
					: t(locale, 'Could not commit the changes.')
		);
		return null;
	} finally {
		stop();
	}
}
