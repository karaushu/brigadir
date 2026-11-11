import type { EventRecord, SessionEvent } from './session';
import { isPlanApproval } from './plan-approval';
import type { TaskActivity } from './workspace';
type State = { activity: TaskActivity | null; toolId: string | null };
/** spec/chat#subagent-block: subagent names by id — a subagent's own calls read as `Subagent · <name>`, like the turn status row. */
type Names = Map<string, string>;
function next(state: State, event: SessionEvent, names: Names): State {
	if (event.kind === 'subagent.started') {
		names.set(event.id, event.name);
		return {
			activity: { kind: 'tool', title: event.name.slice(0, 240), path: null, subagent: true },
			toolId: null,
		};
	}
	if (event.kind === 'tool.changed' && event.subagentId && names.has(event.subagentId))
		return {
			activity: {
				kind: 'tool',
				title: names.get(event.subagentId)!.slice(0, 240),
				path: null,
				subagent: true,
			},
			toolId: null,
		};
	if (
		[
			'turn.started',
			'turn.completed',
			'session.failed',
			'host.stopped',
			'permission.resolved',
			'question.resolved',
			'task.proposal.resolved',
		].includes(event.kind)
	)
		return { activity: null, toolId: null };
	if (event.kind === 'task.proposal.requested')
		return {
			activity: {
				kind: 'proposal',
				title: (event.proposal.title ?? event.proposal.prompt.split('\n')[0] ?? '').slice(0, 240),
				path: null,
			},
			toolId: null,
		};
	if (event.kind === 'question.requested')
		return {
			activity: { kind: 'question', title: event.question.question.slice(0, 240), path: null },
			toolId: null,
		};
	if (event.kind === 'permission.requested')
		return {
			activity: {
				kind: isPlanApproval(event.request) ? 'plan' : 'permission',
				title: event.request.tool.title?.slice(0, 240) ?? '',
				path: null,
			},
			toolId: null,
		};
	if (event.kind === 'tool.changed') {
		const previous =
				state.toolId === event.patch.id && state.activity?.kind === 'tool' ? state.activity : null,
			title = event.patch.title?.slice(0, 240) ?? previous?.title ?? '',
			path = event.patch.locations?.[0]?.path?.slice(0, 1024) ?? previous?.path ?? null;
		return {
			activity: title || path ? { kind: 'tool', title, path } : null,
			toolId: event.patch.id,
		};
	}
	return state;
}
/** Tail-derived current activity; lifecycle boundaries never leave stale tool/request text. */
export function taskActivity(records: readonly EventRecord[]): TaskActivity | null {
	const names: Names = new Map();
	return records.reduce<State>((state, record) => next(state, record.event, names), {
		activity: null,
		toolId: null,
	}).activity;
}
