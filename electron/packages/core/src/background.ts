import type { BackgroundState, BackgroundStopReason } from './agent';
import type { EventRecord } from './session';

/** spec/chat-turns-plans-and-questions#background-commands: a background command as the journal tells it. `turnSeq`: the `turn.started` of the turn that started it. */
export type BackgroundCommand = {
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
	return backgroundCommands(records).filter((command) => {
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
	return backgroundCommands(records).filter((command) => command.turnSeq === turnSeq);
}
/** What the sidebar card says while the turn is over and work goes on: the name of one command, or the number of them. */
export type BackgroundSummary = { count: number; name: string | null };
export function backgroundSummary(records: readonly EventRecord[]): BackgroundSummary | null {
	const live = liveBackground(records);
	return live.length
		? { count: live.length, name: live.length === 1 ? live[0]!.name : null }
		: null;
}
export function isBackgroundSummary(value: unknown): value is BackgroundSummary {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(v.count) &&
		Number(v.count) > 0 &&
		Number(v.count) <= 1000 &&
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
