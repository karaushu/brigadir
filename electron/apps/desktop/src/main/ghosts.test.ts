import { it, expect } from 'vitest';
import { Ghosts } from './ghosts';
import type { EventRecord, SessionEvent, SessionSnapshot } from '@brigadir/core';
const key = { projectId: 'project', id: 'task' },
	record = (seq: number, event: SessionEvent): EventRecord => ({
		schemaVersion: 1,
		seq,
		at: '2026-09-21T00:00:00Z',
		event,
	});
const completed = [
	record(1, { kind: 'turn.started', text: 'Що змінилось?' }),
	record(2, {
		kind: 'message.delta',
		role: 'assistant',
		messageId: null,
		content: { kind: 'text', text: 'Виправлено; можу перевірити.' },
	}),
	record(3, { kind: 'turn.completed', reason: 'end_turn' }),
];
// Claude as the helper: its quota warnings stop hints (spec/composer-steering-queue-and-ghost#ghost-headless); the default is Codex.
const claudeHint = async () => ({
	provider: 'claude' as const,
	model: null,
	preferredModel: 'haiku',
	name: 'Haiku',
	effort: null,
});
it('avoids hidden/disabled calls, caches one attempt per turn and rechecks gates before displaying a result', async () => {
	let context = { enabled: false, visible: true, composerEmpty: true, reviewPending: 0 },
		calls = 0,
		finish: (text: string) => void = () => {},
		snapshot: SessionSnapshot = { key, records: completed, connected: true, issue: null };
	const ghosts = new Ghosts({
		read: async () => snapshot,
		context: async () => context,
		write: async (prompt) => {
			calls++;
			expect(prompt).toContain('Що змінилось?');
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	expect(await ghosts.request(key, 3, 'disabled')).toBeNull();
	context.enabled = true;
	context.visible = false;
	expect(await ghosts.request(key, 3, 'hidden')).toBeNull();
	expect(calls).toBe(0);
	context.visible = true;
	const pending = ghosts.request(key, 3, 'active');
	await expect.poll(() => calls).toBe(1);
	expect(await ghosts.request(key, 3, 'duplicate')).toBeNull();
	context.composerEmpty = false;
	finish('Перевір зміни');
	expect(await pending).toBeNull();
	context.composerEmpty = true;
	expect(await ghosts.request(key, 3, 'no-retry')).toBeNull();
	expect(calls).toBe(1);
	snapshot = {
		...snapshot,
		records: [...completed, ...completed.map((item) => ({ ...item, seq: item.seq + 3 }))],
	};
	const next = ghosts.request(key, 6, 'next');
	await expect.poll(() => calls).toBe(2);
	finish('"Перевір зміни"\nsecond line');
	expect(await next).toBe('Перевір зміни');
	expect(await ghosts.request(key, 6, 'cached')).toBe('Перевір зміни');
	expect(calls).toBe(2);
});
it('propagates typing, new-turn and quota cancellation to the process signal', async () => {
	let calls = 0;
	const signals: AbortSignal[] = [];
	const ghosts = new Ghosts({
		target: claudeHint,
		read: async () => ({ key, records: completed, connected: true, issue: null }),
		context: async () => ({ enabled: true, visible: true, composerEmpty: true, reviewPending: 0 }),
		write: async (_, signal) => {
			calls++;
			signals.push(signal);
			return new Promise((_, reject) =>
				signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
			);
		},
	});
	const pending = ghosts.request(key, 3, 'typing');
	await expect.poll(() => calls).toBe(1);
	ghosts.cancel(key, 'typing');
	expect(await pending).toBeNull();
	expect(signals[0]?.aborted).toBe(true);
	for (const event of [
		{ kind: 'turn.started', text: 'new' },
		{ kind: 'rate-limit.changed', status: 'allowed_warning', window: 'weekly', resetsAt: null },
	] as const) {
		const before = calls,
			task = { ...key, id: event.kind },
			work = ghosts.request(task, 3, event.kind);
		await expect.poll(() => calls).toBe(before + 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		ghosts.observe(task, record(4, event));
		expect(await work).toBeNull();
		expect(signals.at(-1)?.aborted).toBe(true);
	}
});
it('remembers a one-shot quota warning across turns and cancels all outstanding hints when disabled', async () => {
	let calls = 0,
		mode: 'warn' | 'hold' = 'warn';
	const ghosts = new Ghosts({
		target: claudeHint,
		read: async () => ({ key, records: completed, connected: true, issue: null }),
		context: async () => ({ enabled: true, visible: true, composerEmpty: true, reviewPending: 0 }),
		write: async (_, signal, onLimit) => {
			calls++;
			if (mode === 'warn') {
				onLimit({
					kind: 'rate-limit.changed',
					status: 'allowed_warning',
					window: 'five_hour',
					resetsAt: null,
				});
				throw new Error('quota');
			}
			return new Promise((_, reject) =>
				signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
			);
		},
	});
	expect(await ghosts.request(key, 3, 'warning')).toBeNull();
	expect(await ghosts.request({ ...key, id: 'other' }, 3, 'blocked')).toBeNull();
	expect(calls).toBe(1);
	ghosts.observe(
		key,
		record(4, {
			kind: 'rate-limit.changed',
			status: 'allowed',
			window: 'five_hour',
			resetsAt: null,
		})
	);
	mode = 'hold';
	const pending = ghosts.request({ ...key, id: 'another' }, 3, 'pending');
	await expect.poll(() => calls).toBe(2);
	ghosts.cancelAll();
	expect(await pending).toBeNull();
});
it('writes with the resolved provider; a Claude warning never stops a Codex hint, an exhausted Codex window does (spec/composer-steering-queue-and-ghost#ghost-headless)', async () => {
	const targets: string[] = [];
	let exhausted = false,
		target: import('@brigadir/core').GhostTarget | null = {
			provider: 'codex',
			model: 'gpt-6-luna',
			preferredModel: null,
			name: '6 Luna',
			effort: null,
		};
	const warned = [
		...completed,
		record(4, {
			kind: 'rate-limit.changed',
			status: 'allowed_warning',
			window: 'five_hour',
			resetsAt: null,
		}),
	];
	let records = warned;
	const ghosts = new Ghosts({
		target: async () => target,
		exhausted: (provider) => provider === 'codex' && exhausted,
		read: async () => ({ key, records, connected: true, issue: null }),
		context: async () => ({ enabled: true, visible: true, composerEmpty: true, reviewPending: 0 }),
		write: async (_, __, ___, chosen) => {
			targets.push(`${chosen.provider}/${chosen.model}`);
			return 'Далі';
		},
	});
	ghosts.observe(key, warned.at(-1)!);
	records = [...warned, record(5, { kind: 'turn.completed', reason: 'end_turn' })];
	expect(await ghosts.request(key, 5, 'codex')).toBe('Далі');
	expect(targets).toEqual(['codex/gpt-6-luna']);
	exhausted = true;
	records = [...records, record(6, { kind: 'turn.completed', reason: 'end_turn' })];
	expect(await ghosts.request(key, 6, 'exhausted')).toBeNull();
	exhausted = false;
	target = {
		provider: 'claude',
		model: 'haiku',
		preferredModel: null,
		name: 'Haiku 4.5',
		effort: null,
	};
	records = [...records, record(7, { kind: 'turn.completed', reason: 'end_turn' })];
	expect(await ghosts.request(key, 7, 'claude')).toBeNull();
	target = null;
	records = [...records, record(8, { kind: 'turn.completed', reason: 'end_turn' })];
	expect(await ghosts.request(key, 8, 'none')).toBeNull();
	expect(targets).toEqual(['codex/gpt-6-luna']);
});
