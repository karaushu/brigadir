/** spec/chat#tool-groups: tool calls in a row fold into one group; its header names the count, the tools, the changed files, the errors and the time. */
import type { ToolPatch } from './agent';
import type { Locale } from './messages';
import { mcpCall, mcpVerb } from './mcp-tools';

/** How a log row takes part in a group: a tool call, a thought (inside a run only) or a boundary. */
export type ToolRunRole = 'tool' | 'thought' | 'break';
export type ToolRun<T> = { kind: 'group'; items: T[]; tools: T[] } | { kind: 'row'; row: T };

/**
 * Splits log rows into runs. A run is the longest stretch of tool calls, with the agent's thoughts between them;
 * a thought at either end stays outside. A run of two calls or more becomes a group, one call stays a plain row.
 */
export function toolRuns<T>(rows: readonly T[], role: (row: T) => ToolRunRole): ToolRun<T>[] {
	const out: ToolRun<T>[] = [];
	let i = 0;
	while (i < rows.length) {
		if (role(rows[i]!) !== 'tool') {
			out.push({ kind: 'row', row: rows[i]! });
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < rows.length && role(rows[j + 1]!) !== 'break') j++;
		while (role(rows[j]!) === 'thought') j--;
		const items = rows.slice(i, j + 1),
			tools = items.filter((row) => role(row) === 'tool');
		if (tools.length >= 2) out.push({ kind: 'group', items, tools });
		else for (const row of items) out.push({ kind: 'row', row });
		i = j + 1;
	}
	return out;
}

export type ToolGroupCall = {
	id: string;
	tool: ToolPatch;
	startedAt: number;
	finishedAt: number | null;
};
export type ToolGroupFile = {
	path: string;
	additions: number;
	deletions: number;
	/** The call and its content index whose diff the chip opens. */ callId: string;
	index: number;
};
export type ToolGroupSummary = {
	calls: number;
	/** Provider tool names by count, most used first; calls without a name (Codex) are counted but not named (spec/agents-and-providers#mapper-rules). */
	mix: { name: string; count: number }[];
	errors: number;
	running: boolean;
	files: ToolGroupFile[];
	/** Calls shown under the collapsed header: failed ones and the ones still running, in log order. */
	pinned: string[];
};

export const callFailed = (call: ToolGroupCall) => call.tool.status === 'failed';
export const callRunning = (call: ToolGroupCall) =>
	call.finishedAt === null && call.tool.status !== 'completed' && call.tool.status !== 'failed';

/** The name a call counts under in the header's tools: the provider's name, an MCP call by its action (spec/chat#mcp-calls), not `mcp__…`. */
export function toolGroupName(locale: Locale, tool: ToolPatch): string | undefined {
	const call = mcpCall(tool);
	return call ? mcpVerb(locale, call, 'done') : tool.name;
}

export function toolGroupSummary(
	calls: readonly ToolGroupCall[],
	nameOf: (tool: ToolPatch) => string | undefined = (tool) => tool.name
): ToolGroupSummary {
	const mix = new Map<string, number>(),
		files = new Map<string, ToolGroupFile>(),
		pinned: string[] = [];
	let errors = 0,
		running = false;
	for (const call of calls) {
		const name = nameOf(call.tool);
		if (name) mix.set(name, (mix.get(name) ?? 0) + 1);
		const failed = callFailed(call),
			live = callRunning(call);
		if (failed) errors++;
		if (live) running = true;
		if (failed || live) pinned.push(call.id);
		call.tool.content?.forEach((content, index) => {
			if (content.kind !== 'diff') return;
			const { additions, deletions } = lineChangeCount(content.before, content.after),
				seen = files.get(content.path);
			// Several edits of one file make one chip; it opens the latest of them.
			files.set(
				content.path,
				seen
					? {
							...seen,
							additions: seen.additions + additions,
							deletions: seen.deletions + deletions,
							callId: call.id,
							index,
						}
					: { path: content.path, additions, deletions, callId: call.id, index }
			);
		});
	}
	return {
		calls: calls.length,
		mix: [...mix].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
		errors,
		running,
		files: [...files.values()],
		pinned,
	};
}

/** The header's time: the calls' own durations added up, as the rows under it show them; a running call counts to `now`. */
export function toolGroupDuration(calls: readonly ToolGroupCall[], now: number): number {
	return calls.reduce(
		(sum, call) =>
			sum +
			Math.max(0, (call.finishedAt ?? (callRunning(call) ? now : call.startedAt)) - call.startedAt),
		0
	);
}

/** «3 Read · 2 Grep · 1 Edit · 1 Bash», then «+N» for the rest. */
export function toolMixText(mix: ToolGroupSummary['mix'], limit = 4): string {
	const shown = mix.slice(0, limit).map((item) => `${item.count} ${item.name}`),
		rest = mix.slice(limit).reduce((sum, item) => sum + item.count, 0);
	return [...shown, ...(rest ? [`+${rest}`] : [])].join(' · ');
}

/** Added and removed lines between two texts (the same count a diff shows); large inputs fall back to the trimmed middle. */
export function lineChangeCount(
	before: string | null,
	after: string
): { additions: number; deletions: number } {
	const a = before === null || before === '' ? [] : before.replace(/\n$/, '').split('\n'),
		b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length,
		endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const x = a.slice(start, endA),
		y = b.slice(start, endB);
	if (!x.length || !y.length || x.length * y.length > 4_000_000)
		return { additions: y.length, deletions: x.length };
	let previous = new Uint32Array(y.length + 1);
	for (let i = 1; i <= x.length; i++) {
		const row = new Uint32Array(y.length + 1);
		for (let j = 1; j <= y.length; j++)
			row[j] = x[i - 1] === y[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
		previous = row;
	}
	const common = previous[y.length]!;
	return { additions: y.length - common, deletions: x.length - common };
}

/** The chip's directory: «kit/…/» for a nested file, «kit/» for one level, nothing at the root. */
export function chipDirectory(path: string): string {
	const parts = path.split('/');
	if (parts.length < 2) return '';
	return parts.length === 2 ? `${parts[0]}/` : `${parts[0]}/…/`;
}
