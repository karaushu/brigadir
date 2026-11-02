import { useEffect } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { AgentTask, HelperRun, PRRefKey, PRSummary } from '@brigadir/core';

/**
 * spec/pull-requests-and-ci#pr-summary, spec/appearance#evolution-redesign: the agent summary of one PR, shared by the review modal and Overview. Main keeps it on disk by
 * head SHA; here it is read once per PR, written on request (or by the review on its first open) and stopped.
 * `error` is the reason in main's words; `stopped` — the person pressed Stop, which is not a failure.
 */
export type PRSummaryState = {
	summary: PRSummary | null;
	read: boolean;
	busy: boolean;
	error: string;
	stopped: boolean;
	/** spec/appearance#evolution-redesign: the «What to check» ticks — the person's own, never sent to GitHub; `headSha:index`. */ checked: Record<
		string,
		true
	>;
	/** spec/appearance#evolution-redesign, diff markers: markers the person dismissed — their own, by `summarySpotKey` (head SHA, kind, index). */ dismissed: Record<
		string,
		true
	>;
	/** The latest call: an older one replaced by the capsule's choice does not end the busy state. */ attempt?: number;
};
const stores = new Map<string, StoreApi<PRSummaryState>>();
const keyOf = (task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) =>
	`${task.projectId}/${task.id}/${ref.scopeId}/${ref.number}`;
function store(task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) {
	const id = keyOf(task, ref);
	let value = stores.get(id);
	if (!value) {
		value = createStore<PRSummaryState>(() => ({
			summary: null,
			read: false,
			busy: false,
			error: '',
			stopped: false,
			checked: {},
			dismissed: {},
		}));
		stores.set(id, value);
	}
	return value;
}
/** The one-shot call failed on the agent's sign-in (transport `signInRequired`), not on the PR. */
export const summarySignIn = 'Agent sign-in required';
const reason = (error: unknown) =>
	error instanceof Error
		? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
		: '';
export function readSummary(task: AgentTask, ref: PRRefKey) {
	const value = store(task, ref);
	return window.brigadir.readPullRequestSummary(task, ref).then(
		(summary) => {
			// A summary written meanwhile is newer than what the disk had when the read started.
			value.setState((state) => ({
				read: true,
				summary: state.busy ? state.summary : (summary ?? state.summary),
			}));
			return summary;
		},
		() => {
			value.setState({ read: true });
			return null;
		}
	);
}
/** spec/appearance#evolution-redesign: `run` — the capsule's agent for this summary; it replaces a summary being written by another one. */
export async function generateSummary(task: AgentTask, ref: PRRefKey, run?: HelperRun | null) {
	const value = store(task, ref);
	if (value.getState().busy && !run) return;
	const attempt = (value.getState().attempt ?? 0) + 1;
	value.setState({ busy: true, error: '', stopped: false, attempt });
	try {
		const summary = await window.brigadir.generatePullRequestSummary(task, ref, run ?? null);
		if (value.getState().attempt === attempt) value.setState({ summary, busy: false, read: true });
	} catch (error) {
		if (value.getState().attempt !== attempt) return;
		value.setState((state) =>
			state.stopped ? { busy: false } : { busy: false, error: reason(error) || 'failed' }
		);
	}
}
/** spec/appearance#evolution-redesign: ticks a «What to check» item of this summary on or off; a new summary starts with none ticked. */
export function toggleSummaryCheck(task: AgentTask, ref: PRRefKey, key: string) {
	store(task, ref).setState(({ checked }) => {
		const next = { ...checked };
		if (next[key]) delete next[key];
		else next[key] = true;
		return { checked: next };
	});
}
/** spec/appearance#evolution-redesign: hides a marker of the summary in the diff for this person, on this head SHA; nothing goes to GitHub. */
export function dismissSummarySpot(task: AgentTask, ref: PRRefKey, key: string) {
	store(task, ref).setState(({ dismissed }) =>
		dismissed[key] ? {} : { dismissed: { ...dismissed, [key]: true } }
	);
}
/** Test seam: the state of one PR's summary. */
export const summaryState = (task: Pick<AgentTask, 'projectId' | 'id'>, ref: PRRefKey) =>
	store(task, ref).getState();
export function stopSummary(task: AgentTask, ref: PRRefKey) {
	store(task, ref).setState({ stopped: true });
	void window.brigadir.stopPullRequestSummary(task, ref).catch(() => {});
}
export function usePRSummary(task: AgentTask, ref: PRRefKey | null) {
	const empty = store({ projectId: '', id: '' }, { scopeId: '', number: 0 }),
		value = ref ? store(task, ref) : empty,
		state = useStore(value);
	useEffect(() => {
		if (ref && !value.getState().read) void readSummary(task, ref);
	}, [task.projectId, task.id, ref?.scopeId, ref?.number]);
	return state;
}
