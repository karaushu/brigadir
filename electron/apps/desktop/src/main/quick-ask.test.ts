import { expect, it } from 'vitest';
import type { AgentEvent, QuickAskEvent } from '@brigadir/core';
import { QuickAsks } from './quick-ask';

/** spec/notifications-slack-notes-and-schedules#slack-agent: the answer's messages stay apart in the stream, so `ACK: …` ends its own line. */
it('a new message or text after a tool call starts its own paragraph', () => {
	const sent: QuickAskEvent[] = [];
	const asks = new QuickAsks({
		send: (event: QuickAskEvent) => void sent.push(event),
	} as unknown as ConstructorParameters<typeof QuickAsks>[0]);
	const thread = {
		id: 'q',
		closed: false,
		answering: true,
		said: null,
		roots: ['/repo'],
		tools: new Map(),
		options: [],
	};
	const event = (value: AgentEvent) =>
		(asks as unknown as { event(thread: unknown, event: AgentEvent): void }).event(thread, value);
	const text = (messageId: string | null, value: string): AgentEvent => ({
		kind: 'message.delta',
		role: 'assistant',
		messageId,
		content: { kind: 'text', text: value },
	});
	const said = () =>
		sent
			.filter((item) => item.kind === 'text')
			.map((item) => (item.kind === 'text' ? item.text : ''))
			.join('');
	event(text('a', 'ACK: Looking '));
	event(text('a', 'it up.'));
	// The ACK line is complete the moment the agent turns to a tool, not when its answer starts.
	event({ kind: 'tool.changed', patch: { id: 't', title: 'Read', status: 'pending' } });
	expect(said()).toBe('ACK: Looking it up.\n\n');
	event({ kind: 'tool.changed', patch: { id: 't', status: 'completed' } });
	event(text('b', 'Found it.'));
	event(text('c', 'ACTION create_task {}'));
	event({
		kind: 'message.delta',
		role: 'thought',
		messageId: null,
		content: { kind: 'text', text: 'hm' },
	});
	event(text(null, 'Done.'));
	event(text(null, ' All of it.'));
	expect(said()).toBe(
		'ACK: Looking it up.\n\nFound it.\n\nACTION create_task {}\n\nDone. All of it.'
	);
});
