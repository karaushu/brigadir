import { expect, it } from 'vitest';
import { promptQueue, isQueuedPrompt, isOwnQueuedPrompt } from './prompt-queue';
import { isSessionEvent } from './event-validation';
import { isSessionCommand, type EventRecord, type SessionEvent } from './session';
const first = {
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		command: { kind: 'prompt' as const, text: 'first' },
		attachments: [],
	},
	second = {
		...first,
		id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		command: { kind: 'prompt' as const, text: 'second' },
	};
const records = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, i) => ({
		event,
		seq: i + 1,
		schemaVersion: 1,
		at: new Date(0).toISOString(),
	}));
it('replays queued, removed and consumed IDs without replaying an interrupted active turn', () => {
	const events: SessionEvent[] = [
		{ kind: 'turn.started', text: 'active' },
		{ kind: 'prompt.queued', prompt: first },
		{ kind: 'prompt.queued', prompt: second },
		{ kind: 'prompt.queued', prompt: first },
		{ kind: 'host.stopped', reason: 'crash' },
	];
	expect(promptQueue(records(events)).prompts).toEqual([first, second]);
	events.push(
		{ kind: 'prompt.removed', id: second.id },
		{ kind: 'turn.started', text: 'first', queuedPromptId: first.id }
	);
	expect(promptQueue(records(events)).prompts).toEqual([]);
});
it('keeps a failed queue paused through startup until explicitly resumed and validates durable events', () => {
	const events: SessionEvent[] = [
		{ kind: 'prompt.queued', prompt: first },
		{ kind: 'session.failed', message: 'Limit' },
		{ kind: 'host.stopped', reason: 'shutdown' },
	];
	expect(promptQueue(records(events))).toEqual({ prompts: [first], paused: true });
	events.push({ kind: 'queue.resumed' });
	expect(promptQueue(records(events)).paused).toBe(false);
	expect(events.every(isSessionEvent)).toBe(true);
	expect(isQueuedPrompt({ ...first, command: { kind: 'cancel' } })).toBe(false);
	expect(isSessionEvent({ kind: 'turn.started', text: 'bad', queuedPromptId: 'foreign' })).toBe(
		false
	);
	expect(isSessionCommand({ kind: 'removeQueuedPrompt', id: first.id })).toBe(true);
	expect(isSessionCommand({ kind: 'removeQueuedPrompt', id: 'bad' })).toBe(false);
});

it('retains pending prompts when parking a task and resumes only on an explicit command', () => {
	const events: SessionEvent[] = [
		{ kind: 'prompt.queued', prompt: first },
		{ kind: 'queue.paused' },
		{ kind: 'turn.completed', reason: 'cancelled' },
		{ kind: 'host.stopped', reason: 'shutdown' },
	];
	expect(events.every(isSessionEvent)).toBe(true);
	expect(isSessionCommand({ kind: 'pausePromptQueue' })).toBe(true);
	expect(promptQueue(records(events))).toEqual({ prompts: [first], paused: true });
	events.push({ kind: 'queue.resumed' });
	expect(promptQueue(records(events))).toEqual({ prompts: [first], paused: false });
});
it('does not pause an empty queue when the host fails to start, so the first prompt runs after Resume (spec/composer-steering-queue-and-ghost#prompt-queue)', () => {
	const events: SessionEvent[] = [
		{ kind: 'session.failed', message: 'unsafe_path' },
		{ kind: 'host.stopped', reason: 'startup_failed' },
	];
	expect(promptQueue(records(events))).toEqual({ prompts: [], paused: false });
	events.push({ kind: 'prompt.queued', prompt: first });
	expect(promptQueue(records(events))).toEqual({ prompts: [first], paused: false });
});
it("keeps a crew service prompt in the FIFO but out of the person's deck (spec/composer-steering-queue-and-ghost#queue-deck)", () => {
	const question = {
		id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
		command: {
			kind: 'prompt' as const,
			text: 'Worker `Reviewer · checks` asks (questionId q1):\nWhich?',
			crew: { kind: 'question' as const, questionId: 'q1', agent: 'Reviewer' },
		},
		attachments: [],
	};
	const queue = promptQueue(
		records([
			{ kind: 'prompt.queued', prompt: first },
			{ kind: 'prompt.queued', prompt: question },
		])
	);
	expect(queue.prompts).toHaveLength(2);
	expect(queue.prompts.filter(isOwnQueuedPrompt)).toEqual([first]);
	expect(
		isOwnQueuedPrompt({
			...first,
			command: { kind: 'submitReview', text: 'review', review: {} as never },
		} as never)
	).toBe(true);
});
