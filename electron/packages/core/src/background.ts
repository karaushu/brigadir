import type { BackgroundState, BackgroundStopReason } from './agent';
import type { EventRecord } from './session';

/** spec/chat-turns-plans-and-questions#background-commands: a background command as the journal tells it. `turnSeq`: the `turn.started` of the turn that started it.
 *  `kind: 'subagent'` (spec/chat-turns-plans-and-questions#background-subagents): a subagent that outlived its turn; `id` is its session, it has no tool call or output file. */
export type BackgroundCommand = {
	kind: 'command' | 'subagent';
	id: string;
	toolId: string | null;
	name: string;
	seq: number;
	turnSeq: number | null;
	startedAt: number;
	state: 'running' | BackgroundState;
	reason: BackgroundStopReason | null;
	finishedAt: number | null;
	finishedSeq: number | null;
	outputPath: string | null;
};
/** spec/chat#subagent-transport: a subagent's session id as the adapter names it (Claude agent ids, UUIDs). */
export function isSubagentId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}
/** Claude's task ids (`b01ijw66c`), Codex exec ids; never a path. */
export function isBackgroundId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
}
/** The adapter's own output file of this command: absolute, no `..`, ending `tasks/<id>.output` (claude-agent-acp's rule). */
export function isBackgroundPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 4096 &&
		value.startsWith('/') &&
		!value.includes('\0') &&
		!value.split('/').includes('..') &&
		/\/tasks\/[A-Za-z0-9_-]{1,96}\.output$/.test(value)
	);
}
export function backgroundPathOf(value: unknown, id: string): boolean {
	return isBackgroundPath(value) && value.endsWith(`/tasks/${id}.output`);
}

/**
 * Every background command of the journal in the order it started. One that no event ended stops with the host: a
 * `host.stopped` or a new `session.started` after it means the adapter that ran it is gone (spec/chat-turns-plans-and-questions#background-commands); the host
 * journals that too, this only keeps an older journal from showing a dead row as live.
 */
export function backgroundCommands(records: readonly EventRecord[]): BackgroundCommand[] {
	const all = new Map<string, BackgroundCommand>();
	let turnSeq: number | null = null;
	const end = (
		command: BackgroundCommand,
		state: BackgroundState,
		reason: BackgroundStopReason | null,
		record: EventRecord
	) => {
		command.state = state;
		command.reason = reason;
		command.finishedAt = Date.parse(record.at);
		command.finishedSeq = record.seq;
	};
	for (const record of records) {
		const e = record.event;
		if (e.kind === 'turn.started') turnSeq = record.seq;
		else if (e.kind === 'background.started') {
			if (!all.has(e.id))
				all.set(e.id, {
					kind: 'command',
					id: e.id,
					toolId: e.toolId,
					name: e.name,
					seq: record.seq,
					turnSeq,
					startedAt: Date.parse(record.at),
					state: 'running',
					reason: null,
					finishedAt: null,
					finishedSeq: null,
					outputPath: null,
				});
		} else if (e.kind === 'background.changed') {
			const command = all.get(e.id);
			if (!command) continue;
			if (e.outputPath) command.outputPath = e.outputPath;
			if (e.state && command.state === 'running')
				end(command, e.state, e.state === 'stopped' ? (e.reason ?? 'person') : null, record);
		} else if (e.kind === 'host.stopped' || e.kind === 'session.started')
			for (const command of all.values())
				if (command.state === 'running')
					end(command, 'stopped', e.kind === 'host.stopped' ? 'closed' : 'restarted', record);
	}
	return [...all.values()];
}
export function liveBackground(records: readonly EventRecord[]): BackgroundCommand[] {
	return backgroundCommands(records).filter((command) => command.state === 'running');
}

/**
 * spec/chat-turns-plans-and-questions#background-subagents: the subagents still running when the turn they started in ended. From then on each stays
 * background work until it ends, through later turns; one that ended inside its turn never is. Its end is its own state (`cancelled` reads as
 * stopped), else the session's: `session.failed`, `host.stopped`, a new `session.started`.
 */
export function backgroundSubagents(records: readonly EventRecord[]): BackgroundCommand[] {
	const all = new Map<string, BackgroundCommand>(),
		left: BackgroundCommand[] = [];
	let turnSeq: number | null = null;
	const end = (item: BackgroundCommand, state: BackgroundState, record: EventRecord) => {
		item.state = state;
		item.finishedAt = Date.parse(record.at);
		item.finishedSeq = record.seq;
	};
	for (const record of records) {
		const e = record.event;
		if (e.kind === 'turn.started') turnSeq = record.seq;
		else if (e.kind === 'subagent.started') {
			if (!all.has(e.id))
				all.set(e.id, {
					kind: 'subagent',
					id: e.id,
					toolId: null,
					name: e.name,
					seq: record.seq,
					turnSeq,
					startedAt: Date.parse(record.at),
					state: 'running',
					reason: null,
					finishedAt: null,
					finishedSeq: null,
					outputPath: null,
				});
		} else if (e.kind === 'subagent.changed' && e.state) {
			const item = all.get(e.id);
			if (!item) continue;
			if (e.state === 'running') {
				item.state = 'running';
				item.finishedAt = item.finishedSeq = null;
			} else if (item.state === 'running')
				end(item, e.state === 'cancelled' ? 'stopped' : e.state, record);
		} else if (e.kind === 'turn.completed') {
			for (const item of all.values())
				if (item.state === 'running' && !left.includes(item)) left.push(item);
		} else if (
			e.kind === 'session.failed' ||
			e.kind === 'host.stopped' ||
			e.kind === 'session.started'
		)
			for (const item of all.values()) if (item.state === 'running') end(item, 'stopped', record);
	}
	return left;
}
/** Commands and background subagents in the order they started: what the deck, the footer chip and the sidebar show. */
export function backgroundWork(records: readonly EventRecord[]): BackgroundCommand[] {
	return [...backgroundCommands(records), ...backgroundSubagents(records)].sort(
		(a, b) => a.seq - b.seq
	);
}

/** How long a finished command stays in the deck before it leaves (its summary shows for 4 s). */
export const backgroundSettleMs = 4000;
/**
 * spec/chat-turns-plans-and-questions#background-commands: the rows of the «In the background» deck. Running ones; a finished one for `backgroundSettleMs`; a failed one until the
 * agent's next turn begins or the person dismisses it. A stopped one leaves at once.
 */
export function backgroundDeck(
	records: readonly EventRecord[],
	now: number,
	dismissed: ReadonlySet<string> = new Set()
): BackgroundCommand[] {
	const lastTurn = records.findLast((record) => record.event.kind === 'turn.started')?.seq ?? 0;
	return backgroundWork(records).filter((command) => {
		if (dismissed.has(command.id)) return false;
		if (command.state === 'running') return true;
		if (command.state === 'completed')
			return command.finishedAt !== null && now - command.finishedAt < backgroundSettleMs;
		if (command.state === 'failed')
			return command.finishedSeq !== null && lastTurn < command.finishedSeq;
		return false;
	});
}
/** spec/chat-turns-plans-and-questions#background-commands: the chip in a turn's footer — what the turn left in the background. */
export function turnBackground(
	records: readonly EventRecord[],
	turnSeq: number
): BackgroundCommand[] {
	return backgroundWork(records).filter((command) => command.turnSeq === turnSeq);
}
/** What the sidebar card says while the turn is over and work goes on: the name of one item, or the number of them. `subagents`: how many of
 *  `count` are background subagents (spec/chat-turns-plans-and-questions#background-subagents); absent in older task files. */
export type BackgroundSummary = { count: number; name: string | null; subagents?: number };
export function backgroundSummary(records: readonly EventRecord[]): BackgroundSummary | null {
	const live = backgroundWork(records).filter((item) => item.state === 'running');
	const subagents = live.filter((item) => item.kind === 'subagent').length;
	return live.length
		? {
				count: live.length,
				name: live.length === 1 ? live[0]!.name : null,
				...(subagents ? { subagents } : {}),
			}
		: null;
}
/** spec/chat#subagent-transport: the subagents at work now, in the turn or in the background; what «Stop» may stop. */
export function runningSubagents(records: readonly EventRecord[]): Set<string> {
	const running = new Set<string>();
	for (const { event: e } of records) {
		if (e.kind === 'subagent.started') running.add(e.id);
		else if (e.kind === 'subagent.changed' && e.state)
			if (e.state === 'running') running.add(e.id);
			else running.delete(e.id);
		else if (
			e.kind === 'session.failed' ||
			e.kind === 'host.stopped' ||
			e.kind === 'session.started'
		)
			running.clear();
	}
	return running;
}
/** The live background subagents (they keep the host up, like commands). */
export function liveBackgroundSubagents(records: readonly EventRecord[]): BackgroundCommand[] {
	return backgroundSubagents(records).filter((item) => item.state === 'running');
}
export function isBackgroundSummary(value: unknown): value is BackgroundSummary {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(v.count) &&
		Number(v.count) > 0 &&
		Number(v.count) <= 1000 &&
		(v.subagents === undefined ||
			(Number.isSafeInteger(v.subagents) &&
				Number(v.subagents) > 0 &&
				Number(v.subagents) <= Number(v.count))) &&
		(v.name === null || (typeof v.name === 'string' && v.name.length <= 4096))
	);
}
/** spec/chat-turns-plans-and-questions#background-commands: the tail the «Output» popover shows; the host reads at most this much from the end of the file. */
export const backgroundTailBytes = 64 * 1024;
export const backgroundTailLines = 200;
/** The last lines of what the host read; a partial first line from the middle of the file is dropped. */
export function outputTail(text: string, truncated: boolean, lines = backgroundTailLines): string {
	let all = text.replace(/\r\n?/g, '\n').split('\n');
	if (truncated) all = all.slice(1);
	if (all.at(-1) === '') all.pop();
	return all.slice(-lines).join('\n');
}
