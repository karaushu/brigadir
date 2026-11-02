import { it, expect } from 'vitest';
import { ghostSuggestion, ghostTurn } from './ghost';
import type { EventRecord, SessionEvent } from './session';
const record = (seq: number, event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-09-18T00:00:00.000Z',
	event,
});
const done = [
	record(1, { kind: 'turn.started', text: 'go' }),
	record(2, { kind: 'turn.completed', reason: 'end_turn' }),
];
it('suggests only after a finished turn without pending inputs or queued prompts', () => {
	expect(ghostSuggestion([], 1, 'en')).toBeNull();
	expect(ghostSuggestion([record(1, { kind: 'turn.started', text: 'go' })], 1, 'en')).toBeNull();
	expect(
		ghostSuggestion(
			[
				...done,
				record(3, { kind: 'turn.started', text: 'again' }),
				record(4, { kind: 'turn.completed', reason: 'cancelled' }),
			],
			1,
			'en'
		)
	).toBeNull();
	expect(
		ghostSuggestion(
			[
				...done,
				record(3, {
					kind: 'permission.requested',
					request: { id: 'p', tool: { id: 't' }, options: [] },
				}),
			],
			1,
			'en'
		)
	).toBeNull();
	expect(
		ghostSuggestion(
			[
				...done,
				record(3, {
					kind: 'prompt.queued',
					prompt: { id: 'q', command: { kind: 'prompt', text: 'later' }, attachments: [] },
				}),
			],
			1,
			'en'
		)
	).toBeNull();
	expect(
		ghostSuggestion([...done, record(3, { kind: 'host.stopped', reason: 'exit' })], 1, 'en')
	).toBeNull();
	// An idle stop ends no turn (spec/architecture-and-platform#host-lifecycle): the hint of the finished turn stays.
	expect(
		ghostSuggestion([...done, record(3, { kind: 'host.stopped', reason: 'idle' })], 1, 'en')
	).toEqual({ kind: 'review', text: 'Submit review (1 comment)' });
});
it('prefers unsent review comments, then an unfinished plan, in the interface language', () => {
	expect(ghostSuggestion(done, 3, 'en')).toEqual({
		kind: 'review',
		text: 'Submit review (3 comments)',
	});
	expect(ghostSuggestion(done, 1, 'uk')).toEqual({
		kind: 'review',
		text: 'Надіслати ревʼю (1 коментар)',
	});
	const planned = [
		record(1, { kind: 'turn.started', text: 'plan it' }),
		record(2, {
			kind: 'plan.changed',
			entries: [{ text: 'a', priority: 'high', status: 'pending' }],
		}),
		record(3, { kind: 'turn.completed', reason: 'end_turn' }),
	];
	expect(ghostSuggestion(planned, 0, 'en')).toEqual({ kind: 'proceed', text: 'Proceed' });
	expect(ghostSuggestion(planned, 2, 'en')).toEqual({
		kind: 'review',
		text: 'Submit review (2 comments)',
	});
	expect(
		ghostSuggestion(
			[
				...planned,
				record(4, { kind: 'turn.started', text: 'do' }),
				record(5, { kind: 'turn.completed', reason: 'end_turn' }),
			],
			0,
			'en'
		)
	).toBeNull();
	expect(
		ghostSuggestion(
			[
				record(1, { kind: 'turn.started', text: 'x' }),
				record(2, {
					kind: 'plan.changed',
					entries: [{ text: 'a', priority: 'high', status: 'completed' }],
				}),
				record(3, { kind: 'turn.completed', reason: 'end_turn' }),
			],
			0,
			'en'
		)
	).toBeNull();
	expect(ghostSuggestion(done, 0, 'en')).toBeNull();
	expect(ghostTurn(done)).toBe(2);
	expect(ghostTurn([])).toBeNull();
});

import { ghostHeadlessPolicy, ghostTail, ghostLine, ghostPrompt, ghostQuotaBlocked } from './ghost';
it('gates paid hints independently of context usage, at the warning threshold of any unexpired subscription window', () => {
	const records = [
			record(1, { kind: 'turn.started', text: 'Поясни зміни' }),
			record(2, {
				kind: 'message.delta',
				role: 'assistant',
				messageId: null,
				content: { kind: 'text', text: 'Пояснення. Що далі?' },
			}),
			record(3, { kind: 'turn.completed', reason: 'end_turn' }),
		],
		base = {
			enabled: true,
			visible: true,
			composerEmpty: true,
			dismissed: false,
			heuristicFound: false,
			records,
		};
	expect(ghostHeadlessPolicy(base)).toBe('allowed');
	for (const [field, value, reason] of [
		['enabled', false, 'disabled'],
		['visible', false, 'hidden'],
		['composerEmpty', false, 'composer'],
		['dismissed', true, 'dismissed'],
		['heuristicFound', true, 'heuristic'],
	] as const)
		expect(ghostHeadlessPolicy({ ...base, [field]: value })).toBe(reason);
	expect(
		ghostHeadlessPolicy({
			...base,
			records: [
				...records,
				record(4, { kind: 'usage.changed', used: 100, capacity: 100, cost: null }),
			],
		})
	).toBe('allowed');
	const warning = record(4, {
		kind: 'rate-limit.changed',
		status: 'allowed_warning',
		window: 'five_hour',
		resetsAt: 200,
	});
	expect(ghostHeadlessPolicy({ ...base, records: [...records, warning], now: 100000 })).toBe(
		'quota'
	);
	expect(
		ghostQuotaBlocked(
			[
				...records,
				warning,
				record(5, {
					kind: 'rate-limit.changed',
					status: 'allowed',
					window: 'seven_day',
					resetsAt: 300,
				}),
			],
			100000
		)
	).toBe(true);
	expect(ghostQuotaBlocked([...records, warning], 200000)).toBe(false);
	expect(
		ghostQuotaBlocked(
			[
				...records,
				warning,
				record(5, {
					kind: 'rate-limit.changed',
					status: 'allowed',
					window: 'five_hour',
					resetsAt: 300,
				}),
			],
			100000
		)
	).toBe(false);
	expect(ghostTail(records)).toEqual({ user: 'Поясни зміни', assistant: 'Пояснення. Що далі?' });
	expect(ghostPrompt(ghostTail(records))).toContain('THE LANGUAGE THE USER WRITES IN');
	expect(ghostLine('```text\n- "Продовжуй реалізацію"\nЩе варіант\n```')).toBe(
		'Продовжуй реалізацію'
	);
	expect(ghostLine('a'.repeat(500))).toHaveLength(200);
});
