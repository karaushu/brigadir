/**
 * The chat's rows as the log shows them (spec/chat#tool-groups groups, spec/chat#subagents subagent blocks, answers split into markdown blocks): one model
 * for the computer's Conversation and the phone's chat (spec/remote-access-and-mobile#phone-app). No React, no styles: a pure projection of the journal.
 */
import {
	activityRows,
	subagentView,
	toolRuns,
	type ActivityRow,
	type EventRecord,
	type SubagentRow,
	type SubagentView,
	type TurnStatus,
} from '@brigadir/core';
import { markdown, type MarkdownTokens } from './markdown';
export type ToolRow = Extract<ActivityRow, { kind: 'tool' }>;
export type ThoughtRow = Extract<ActivityRow, { kind: 'message' }>;
/** spec/chat#tool-groups: tool calls in a row, with the thoughts between them; `tools` are the calls only. */
export type ToolGroupRow = {
	id: string;
	kind: 'toolGroup';
	tools: ToolRow[];
	items: (ToolRow | ThoughtRow)[];
};
/** spec/chat#subagents: a subagent block; `items` are its own rows as the log shows them, `answer` its answer as markdown blocks. */
export type SubagentDisplayRow = {
	id: string;
	kind: 'subagentBlock';
	row: SubagentRow;
	view: SubagentView;
	items: DisplayRow[];
	answer: MarkdownRow[];
};
export type DisplayRow =
	| Exclude<ActivityRow, { kind: 'subagent' }>
	| ToolGroupRow
	| SubagentDisplayRow
	| { id: string; kind: 'markdown'; html: string; tokens: MarkdownTokens }
	| { id: string; kind: 'turnStatus'; status: TurnStatus };
export type MarkdownRow = Extract<DisplayRow, { kind: 'markdown' }>;
/** Parsed answers by message id: a streamed delta re-parses only the message it grew (perf review CHAT-01). */
export type MarkdownCache = Map<string, { text: string; blocks: MarkdownRow[] }>;
export function displayRows(
	records: EventRecord[],
	cache: MarkdownCache = new Map()
): DisplayRow[] {
	const seen = new Set<string>();
	const blocks = (id: string, text: string): MarkdownRow[] => {
		seen.add(id);
		const cached = cache.get(id);
		if (cached?.text === text) return cached.blocks;
		const row = { id, text };
		// Unchanged leading blocks keep their objects, so rows above the growing tail are not re-rendered.
		const previous = new Map(cached?.blocks.map((block) => [block.id, block]));
		const tokens = markdown.parse(row.text, {});
		const blocks: MarkdownRow[] = [];
		let from = 0;
		for (let i = 0; i < tokens.length; i++)
			if (tokens[i]!.level === 0 && tokens[i]!.nesting !== 1) {
				const id = `${row.id}/${from}`,
					html = markdown.renderer.render(tokens.slice(from, i + 1), markdown.options, {}),
					old = previous.get(id);
				blocks.push(
					old?.html === html
						? old
						: { id, kind: 'markdown', tokens: tokens.slice(from, i + 1), html }
				);
				from = i + 1;
			}
		cache.set(row.id, { text: row.text, blocks });
		return blocks;
	};
	// spec/chat#tool-groups: every run of two calls or more folds into one group, failed calls and Edit/Write included; an agent message,
	// a card or a user message closes it, a thought between calls stays inside. spec/chat#subagents: a subagent block closes it too, and its
	// own rows fold the same way inside it.
	const display = (rows: ActivityRow[]): DisplayRow[] =>
		toolRuns(
			rows.flatMap((row): DisplayRow[] => {
				if (row.kind === 'subagent') {
					const view = subagentView(row);
					return [
						{
							id: row.id,
							kind: 'subagentBlock',
							row,
							view,
							items: display(view.rows),
							answer: view.answer ? blocks(`${row.id}/answer`, view.answer) : [],
						},
					];
				}
				return row.kind === 'message' && row.role === 'assistant'
					? blocks(row.id, row.text)
					: [row];
			}),
			(row) =>
				row.kind === 'tool'
					? 'tool'
					: row.kind === 'message' && row.role === 'thought'
						? 'thought'
						: 'break'
		).map((run): DisplayRow =>
			run.kind === 'row'
				? run.row
				: {
						id: `group-${run.tools[0]!.id}`,
						kind: 'toolGroup',
						tools: run.tools as ToolRow[],
						items: run.items as (ToolRow | ThoughtRow)[],
					}
		);
	const result = display(activityRows(records));
	for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
	return result;
}
