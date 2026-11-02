import type { EventRecord } from './session';
import type { ToolPatch } from './agent';
import { toolHeadline } from './tool-output';
/** spec/chat-turns-plans-and-questions#turn-status-row: the last log row while a turn runs — the state word, when the turn began and the latest running tool. */
/** `tool`: the running call itself, so the row can name an MCP call the way the log does (spec/chat#mcp-calls). */
/** `subagent`: the name of the latest subagent still at work, when no call of the agent itself runs (spec/chat#subagents). */
export type TurnStatus = {
	state: 'thinking' | 'writing' | 'working';
	startedAt: number;
	target: string | null;
	more: number;
	tool?: ToolPatch;
	subagent?: string;
};
const ends = new Set(['turn.completed', 'session.failed', 'host.stopped']);
/** Null when no turn runs or when the turn waits for a person (a permission, question or crew plan card is the call). */
export function turnStatus(records: readonly EventRecord[]): TurnStatus | null {
	let start = -1;
	for (let index = records.length - 1; index >= 0; index--) {
		const kind = records[index]!.event.kind;
		if (ends.has(kind)) return null;
		if (kind === 'turn.started') {
			start = index;
			break;
		}
	}
	if (start < 0) return null;
	const tools = new Map<string, { patch: ToolPatch; done: boolean }>(),
		subagents = new Map<string, string>(),
		waiting = new Set<string>();
	let last: 'thought' | 'answer' | 'tool' | null = null;
	for (let index = start + 1; index < records.length; index++) {
		const e = records[index]!.event;
		// spec/chat#subagents: a subagent's own text and calls stay in its block; the turn row names the subagent instead.
		if (e.kind === 'subagent.started') subagents.set(e.id, e.name);
		if (e.kind === 'subagent.changed' && e.state) subagents.delete(e.id);
		if ((e.kind === 'message.delta' || e.kind === 'tool.changed') && e.subagentId) continue;
		if (e.kind === 'message.delta' && e.role !== 'user' && !e.parentId)
			last = e.role === 'assistant' ? 'answer' : 'thought';
		if (e.kind === 'tool.changed') {
			const tool = tools.get(e.patch.id),
				patch = { ...tool?.patch, ...e.patch };
			tools.set(e.patch.id, { patch, done: ['completed', 'failed'].includes(patch.status ?? '') });
			last = 'tool';
		}
		if (e.kind === 'permission.requested') waiting.add(`permission/${e.request.id}`);
		if (e.kind === 'permission.resolved') waiting.delete(`permission/${e.id}`);
		if (e.kind === 'question.requested') waiting.add(`question/${e.question.id}`);
		if (e.kind === 'question.resolved') waiting.delete(`question/${e.id}`);
		if (e.kind === 'crew.question.requested') waiting.add(`crew-question/${e.question.id}`);
		if (e.kind === 'crew.question.resolved') waiting.delete(`crew-question/${e.id}`);
		if (e.kind === 'task.proposal.requested') waiting.add(`proposal/${e.proposal.id}`);
		if (e.kind === 'task.proposal.resolved') waiting.delete(`proposal/${e.id}`);
		if (e.kind === 'crew.plan.requested') waiting.add(`crew-plan/${e.plan.id}`);
		if (e.kind === 'crew.plan.resolved') waiting.delete(`crew-plan/${e.id}`);
	}
	if (waiting.size) return null;
	const startedAt = Date.parse(records[start]!.at);
	// A Map keeps first-insertion order: a later patch updates a tool in place, so the latest started one sits last.
	const running = [...tools.values()].filter((tool) => !tool.done);
	if (running.length) {
		const patch = running.at(-1)!.patch,
			head = patch.title ? toolHeadline(patch) : null;
		return {
			state: 'working',
			startedAt,
			target: head?.target || patch.name || null,
			more: running.length - 1,
			tool: patch,
		};
	}
	if (subagents.size)
		return {
			state: 'working',
			startedAt,
			target: null,
			more: subagents.size - 1,
			subagent: [...subagents.values()].at(-1)!,
		};
	return { state: last === 'answer' ? 'writing' : 'thinking', startedAt, target: null, more: 0 };
}
/**
 * spec/chat-turns-plans-and-questions#turn-status-row: the status row the log shows — the running turn's, or «thinking» from the click on Send (`submittedAt`) until the
 * host echoes `turn.started`. None once the turn ended or while it waits for a person.
 */
export function shownTurnStatus(
	records: readonly EventRecord[],
	submittedAt: number | null
): TurnStatus | null {
	const status = turnStatus(records);
	if (status) return status;
	const lastTurn = records.findLast((record) =>
		['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(record.event.kind)
	);
	return submittedAt !== null && lastTurn?.event.kind !== 'turn.started'
		? { state: 'thinking', startedAt: submittedAt, target: null, more: 0 }
		: null;
}
