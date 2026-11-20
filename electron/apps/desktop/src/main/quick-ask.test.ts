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
	event(text('a', 'ACK: Creating '));
	event(text('a', 'the task.'));
	event(text('b', 'ACTION create_task {}'));
	event({ kind: 'tool.changed', patch: { id: 't', title: 'Read', status: 'completed' } });
	event(text(null, 'Done.'));
	event(text(null, ' All of it.'));
	expect(
		sent
			.filter((item) => item.kind === 'text')
			.map((item) => (item.kind === 'text' ? item.text : ''))
			.join('')
	).toBe('ACK: Creating the task.\n\nACTION create_task {}\n\nDone. All of it.');
});
