import { expect, it, vi } from 'vitest';
import type { EventRecord, SessionEvent } from '@brigadir/core';
vi.mock('./ToolTerminal', () => ({ default: () => null }));
const { displayRows, conversationSearchText } = await import('./Conversation');
const record = (seq: number, event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-09-23T00:00:00.000Z',
	event,
});
const answer = '## Heading\n\nSome **bold** text and `code`.\n\n```ts\nconst value = 1;\n```\n\n';
function journal(turns: number) {
	const records: EventRecord[] = [];
	let seq = 0;
	for (let i = 0; i < turns; i++) {
		records.push(record(++seq, { kind: 'turn.started', text: `Question ${i}` }));
		for (let k = 0; k < 20; k++)
			records.push(
				record(++seq, {
					kind: 'message.delta',
					role: 'assistant',
					messageId: `m${i}`,
					content: { kind: 'text', text: answer },
				})
			);
		records.push(record(++seq, { kind: 'turn.completed', reason: 'end_turn' } as SessionEvent));
	}
	return records;
}
it('reuses parsed answers and unchanged blocks while the last answer streams', () => {
	const cache = new Map(),
		records = journal(3),
		first = displayRows(records, cache);
	const grown = [
		...records.slice(0, -1),
		record(1000, {
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'm2',
			content: { kind: 'text', text: 'Tail.' },
		}),
		records.at(-1)!,
	];
	const second = displayRows(grown, cache),
		byId = new Map(first.map((row) => [row.id, row]));
	const markdown = second.filter((row) => row.kind === 'markdown');
	expect(markdown.filter((row) => byId.get(row.id) === row).length).toBe(markdown.length - 1);
	expect(second.map((row) => row.id)).toEqual(displayRows(grown).map((row) => row.id));
	expect(JSON.stringify(second)).toBe(JSON.stringify(displayRows(grown)));
});
it('a URL streamed in pieces ends as one link; the search finds its text, not its markup (spec/chat#web-links)', () => {
	const url = 'https://github.com/acme/shop-app/pull/1062',
		cache = new Map();
	const at = (text: string) =>
		displayRows(
			[
				record(1, { kind: 'turn.started', text: 'Q' }),
				record(2, {
					kind: 'message.delta',
					role: 'assistant',
					messageId: 'm',
					content: { kind: 'text', text },
				}),
			],
			cache
		).filter((row) => row.kind === 'markdown');
	at('opened a draft PR: https://github.com/acme/sho');
	const [row] = at(`opened a draft PR: ${url}.`);
	expect(row?.kind === 'markdown' && row.html).toBe(
		`<p>opened a draft PR: <a href="${url}" title="${url}">${url}</a>.</p>\n`
	);
	expect(conversationSearchText(row!)).toBe(`opened a draft PR: ${url}.\n`);
});
it('calls in a row fold into one group: Bash, failures and Edit too; an agent message closes it (spec/chat#tool-groups)', () => {
	const tool = (seq: number, id: string, name: string, status: string, extra: object = {}) =>
		record(seq, {
			kind: 'tool.changed',
			patch: { id, name, title: `${name} ${id}`, status, ...extra },
		} as SessionEvent);
	const rows = displayRows([
		record(1, { kind: 'turn.started', text: 'Q' }),
		tool(2, 'a', 'Bash', 'completed', { category: 'execute' }),
		record(3, {
			kind: 'message.delta',
			role: 'thought',
			messageId: 'h',
			content: { kind: 'text', text: 'hmm' },
		}),
		tool(4, 'b', 'Bash', 'failed', { category: 'execute', exitCode: 1, output: 'grep: no match' }),
		tool(5, 'c', 'Edit', 'completed', { category: 'edit' }),
		record(6, {
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'm',
			content: { kind: 'text', text: 'Found it.' },
		}),
		tool(7, 'd', 'Read', 'completed', { category: 'read' }),
		record(8, {
			kind: 'message.delta',
			role: 'thought',
			messageId: 'h2',
			content: { kind: 'text', text: 'next' },
		}),
	]);
	expect(rows.map((row) => row.kind)).toEqual([
		'message',
		'toolGroup',
		'markdown',
		'tool',
		'message',
	]);
	const group = rows[1]!;
	expect(group.kind === 'toolGroup' && group.tools.map((tool) => tool.tool.id)).toEqual([
		'a',
		'b',
		'c',
	]);
	expect(group.kind === 'toolGroup' && group.items.map((item) => item.kind)).toEqual([
		'tool',
		'message',
		'tool',
		'tool',
	]);
	expect(group.id).toBe('group-1/tool/a');
	expect(conversationSearchText(group)).toContain('grep: no match');
	expect(conversationSearchText(group)).toContain('hmm');
});
it('a subagent is its own block that closes a tool group; its own calls fold inside it and its answer leaves its rows (spec/chat#subagents)', () => {
	const tool = (id: string, subagentId?: string): SessionEvent => ({
		kind: 'tool.changed',
		...(subagentId ? { subagentId } : {}),
		patch: { id, name: 'Bash', title: `ls ${id}`, status: 'completed' },
	});
	const rows = displayRows([
		record(1, { kind: 'turn.started', text: 'Q' }),
		record(2, tool('a')),
		record(3, tool('b')),
		record(4, {
			kind: 'subagent.started',
			id: 's',
			parentId: null,
			name: 'Map files',
			prompt: 'List src.',
		}),
		record(5, tool('c', 's')),
		record(6, tool('d', 's')),
		record(7, {
			kind: 'message.delta',
			subagentId: 's',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'Two files.' },
		}),
		record(8, { kind: 'subagent.changed', id: 's', state: 'completed' }),
		record(9, tool('e')),
		record(10, tool('f')),
	]);
	expect(rows.map((row) => row.kind)).toEqual([
		'message',
		'toolGroup',
		'subagentBlock',
		'toolGroup',
	]);
	const block = rows[2]!;
	if (block.kind !== 'subagentBlock') throw new Error('no block');
	expect(block.items.map((row) => row.kind)).toEqual(['toolGroup']);
	expect(block.view).toMatchObject({ answer: 'Two files.', calls: 2, state: 'completed' });
	expect(block.answer.map((row) => row.html)).toEqual(['<p>Two files.</p>\n']);
	expect(conversationSearchText(block)).toContain('Map files');
	expect(conversationSearchText(block)).toContain('ls c');
	expect(conversationSearchText(block)).toContain('Two files.');
});
