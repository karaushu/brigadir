import { promptDisplayText } from './prompt-tokens';
import { activityRows } from './activity';
import type { EventRecord } from './session';
import type { ChangeRange } from './changes';
import { isPlanApproval, planRejectOption } from './plan-approval';
export type TurnSummary = {
	id: string;
	seq: number;
	number: number;
	title: string;
	at: string;
	duration: number | null;
	tools: number;
	/**
	 * spec/chat-turns-plans-and-questions#turn-footer: `returned` — the turn ended because its plan went back (plan chat, `Plan further…`, a plan
	 * review's findings, `Fix N`): the normal end of a planning turn, not an interruption.
	 */
	status: 'running' | 'done' | 'returned' | 'interrupted' | 'failed';
	range: ChangeRange | null;
};
type TurnFold = {
	turns: TurnSummary[];
	checkpoint: number | null;
	active: TurnSummary | undefined;
	tools: Set<string>;
	/** The running turn's plan approvals and their reject option. */
	plans: Map<string, string | null>;
	/** The running turn's plan went back. */
	returned: boolean;
};
function foldTurns(state: TurnFold, records: readonly EventRecord[], from: number) {
	const finish = (at: string, status: TurnSummary['status']) => {
		const active = state.active;
		if (active) {
			active.duration = Math.max(0, Date.parse(at) - Date.parse(active.at));
			active.status = status;
			state.active = undefined;
		}
	};
	for (let i = from; i < records.length; i++) {
		const { seq, at, event } = records[i]!;
		if (event.kind === 'checkpoint.created') {
			state.checkpoint = event.checkpoint;
			if (state.active?.range) state.active.range.current = state.checkpoint;
		}
		if (event.kind === 'turn.started') {
			finish(at, 'interrupted');
			state.tools = new Set();
			state.plans = new Map();
			state.returned = false;
			state.active = {
				id: String(seq),
				seq,
				number: state.turns.length + 1,
				title:
					promptDisplayText(event.text, event.attachments ?? [])
						.split(/\r?\n/, 1)[0]
						?.slice(0, 120) ?? '',
				at,
				duration: null,
				tools: 0,
				status: 'running',
				range:
					state.checkpoint === null ? null : { base: state.checkpoint, current: state.checkpoint },
			};
			state.turns.push(state.active);
		}
		if (event.kind === 'tool.changed' && state.active) {
			state.tools.add(event.patch.id);
			state.active.tools = state.tools.size;
		}
		if (event.kind === 'permission.requested' && isPlanApproval(event.request))
			state.plans.set(event.request.id, planRejectOption(event.request)?.id ?? null);
		if (
			event.kind === 'permission.resolved' &&
			event.optionId !== null &&
			state.plans.get(event.id) === event.optionId
		)
			state.returned = true;
		if (event.kind === 'turn.completed')
			finish(
				at,
				event.reason !== 'cancelled' ? 'done' : state.returned ? 'returned' : 'interrupted'
			);
		if (event.kind === 'session.failed') finish(at, 'failed');
		if (event.kind === 'host.stopped') finish(at, 'interrupted');
	}
}
const emptyFold = (): TurnFold => ({
	turns: [],
	checkpoint: null,
	active: undefined,
	tools: new Set(),
	plans: new Map(),
	returned: false,
});
/** spec/chat-turns-plans-and-questions#turn-footer: the last turn's plan went back — its `cancelled` end is not an interruption. */
export function lastTurnPlanReturned(records: readonly EventRecord[]): boolean {
	const plans = new Map<string, string | null>();
	let start = records.length;
	while (start > 0 && records[start - 1]!.event.kind !== 'turn.started') start--;
	if (start === 0) return false;
	for (let i = start; i < records.length; i++) {
		const event = records[i]!.event;
		if (event.kind === 'permission.requested' && isPlanApproval(event.request))
			plans.set(event.request.id, planRejectOption(event.request)?.id ?? null);
		if (
			event.kind === 'permission.resolved' &&
			event.optionId !== null &&
			plans.get(event.id) === event.optionId
		)
			return true;
	}
	return false;
}
/** Both transports journal the same boundaries; checkpoint IDs, not wall clock, own the diff. */
export function turnSummaries(records: readonly EventRecord[]): TurnSummary[] {
	const state = emptyFold();
	foldTurns(state, records, 0);
	return state.turns;
}
/** `turnSummaries` over a journal that grows by appending (perf review TUI-12): only new records are folded. A journal whose
 * last seen record is no longer in place (a new snapshot) starts over. Only the running turn changes; it is copied before
 * that, so arrays handed out earlier keep their objects. */
export function turnSummarizer() {
	let seen: readonly EventRecord[] = [],
		state = emptyFold(),
		result: TurnSummary[] = [];
	return (records: readonly EventRecord[]): TurnSummary[] => {
		if (records === seen) return result;
		const continues =
			seen.length > 0 &&
			records.length >= seen.length &&
			records[seen.length - 1] === seen[seen.length - 1];
		if (!continues) state = emptyFold();
		else if (records.length === seen.length) {
			seen = records;
			return result;
		} else if (state.active) {
			const copy = { ...state.active, range: state.active.range && { ...state.active.range } };
			state.turns[state.turns.length - 1] = copy;
			state.active = copy;
		}
		foldTurns(state, records, continues ? seen.length : 0);
		seen = records;
		result = state.turns.slice();
		return result;
	};
}

/** Copy the same assistant blocks the transcript displays, within one turn only. */
export function turnResponse(records: readonly EventRecord[], seq: number): string {
	const start = records.findIndex(
		(record) => record.seq === seq && record.event.kind === 'turn.started'
	);
	if (start < 0) return '';
	let end = start + 1;
	while (
		end < records.length &&
		!['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(
			records[end]!.event.kind
		)
	)
		end++;
	return activityRows(records.slice(start, end))
		.flatMap((row) => (row.kind === 'message' && row.role === 'assistant' ? [row.text] : []))
		.join('\n\n');
}
