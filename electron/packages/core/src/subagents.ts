/** spec/chat#subagents: what a subagent block shows — its answer, its calls and its state — from the rows of its own session. */
import type { ActivityRow } from './activity';
export type SubagentRow = Extract<ActivityRow, { kind: 'subagent' }>;
export type SubagentView = {
	/** The answer: the subagent's last text after its last call, or the text it handed back. Null while it works or when it wrote none. */
	answer: string | null;
	/** Its own rows without the answer: text between calls, calls, nested subagents. */
	rows: ActivityRow[];
	calls: number;
	errors: number;
	state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
	/** The call still running, shown under the collapsed header. */
	live: Extract<ActivityRow, { kind: 'tool' }> | null;
};

/**
 * A hand-back: the subagent's last call, finished, whose whole input is one `message` text. Some Claude builds end a subagent this
 * way instead of a last message; it is the answer, not a call (spec/chat#subagents). Known by its input's shape, never by a tool name.
 */
function handBack(row: ActivityRow): string | null {
	if (row.kind !== 'tool' || row.tool.status !== 'completed' || !row.tool.input) return null;
	try {
		const input: unknown = JSON.parse(row.tool.input);
		if (input && typeof input === 'object' && !Array.isArray(input)) {
			const keys = Object.keys(input);
			const message = (input as Record<string, unknown>).message;
			if (keys.length === 1 && typeof message === 'string' && message.trim()) return message;
		}
	} catch {}
	return null;
}

export function subagentView(row: SubagentRow): SubagentView {
	let rows = row.rows,
		answer: string | null = null;
	const lastTool = rows.findLastIndex((item) => item.kind === 'tool' || item.kind === 'subagent');
	const last = rows.at(-1);
	if (
		last?.kind === 'message' &&
		last.role === 'assistant' &&
		rows.indexOf(last) > lastTool &&
		row.state !== null
	) {
		answer = last.text.trim() || null;
		rows = rows.slice(0, -1);
	} else if (lastTool >= 0) {
		const text = handBack(rows[lastTool]!);
		if (
			text !== null &&
			rows.slice(lastTool + 1).every((item) => item.kind === 'message' && item.role !== 'assistant')
		) {
			answer = text;
			rows = rows.filter((_, index) => index !== lastTool);
		}
	}
	const tools = rows.filter(
		(item): item is Extract<ActivityRow, { kind: 'tool' }> => item.kind === 'tool'
	);
	const state = row.state ?? (row.finishedAt !== null ? 'interrupted' : 'running');
	const live =
		state === 'running'
			? (tools.findLast(
					(tool) =>
						tool.finishedAt === null &&
						tool.tool.status !== 'completed' &&
						tool.tool.status !== 'failed'
				) ?? null)
			: null;
	return {
		answer,
		rows,
		calls: tools.length,
		errors: tools.filter((tool) => tool.tool.status === 'failed').length,
		state,
		live,
	};
}

/** Header time: the adapter's run time when it sent one, otherwise from the start to the end (or now), like a call row. */
export function subagentElapsed(row: SubagentRow, now: number): number {
	return row.durationMs ?? Math.max(0, (row.finishedAt ?? now) - row.startedAt);
}

/** First line of the answer for the collapsed block: markdown marks dropped, one line. */
export function answerLine(text: string): string {
	const line =
		text
			.split(/\r?\n/)
			.map((item) => item.trim())
			.find((item) => item && !/^[-*_#`>]+$/.test(item)) ?? '';
	return line
		.replace(/^#+\s*/, '')
		.replace(/^[-*]\s+/, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/** spec/chat#subagents: the prompt of a `think` call in an older log (a subagent before subagent sessions): the input's `prompt` text, so the
 *  row shows what the agent asked instead of raw JSON. Null when the input has none. */
export function toolInputPrompt(input: string): string | null {
	try {
		const value: unknown = JSON.parse(input);
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const prompt = (value as Record<string, unknown>).prompt;
			return typeof prompt === 'string' && prompt.trim() ? prompt : null;
		}
	} catch {}
	return null;
}
