import { expect, it } from 'vitest';
import { relayJournal, type EventRecord, type SessionEvent } from './index';
it('reassembles streamed words and retains the original goal when a long journal is reduced', () => {
	const events: SessionEvent[] = [{ kind: 'turn.started', text: 'Keep the original objective' }];
	for (const text of ['A streamed ', 'answer split ', 'across chunks.'])
		events.push({
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text },
		});
	events.push({ kind: 'turn.completed', reason: 'end_turn' });
	const records = (): EventRecord[] =>
		events.map((event, i) => ({ schemaVersion: 1, seq: i + 1, at: '2026-09-21T10:00:00Z', event }));
	expect(relayJournal(records())).toContain('Assistant: A streamed answer split across chunks.');
	for (let i = 0; i < 1000; i++) {
		events.push({ kind: 'turn.started', text: `Request ${i}: ${'x'.repeat(1000)}` });
		events.push({
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: `Result ${i}: ${'y'.repeat(1000)}` },
		});
	}
	const text = relayJournal(records());
	expect(text.length).toBeLessThan(52500);
	expect(text).toContain('Original request: Keep the original objective');
	expect(text).toContain('Result 999');
	expect(text).not.toContain('Result 1:');
});
