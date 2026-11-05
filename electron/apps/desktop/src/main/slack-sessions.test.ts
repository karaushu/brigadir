import { afterEach, expect, it, vi } from 'vitest';
import type { QuickAskEvent } from '@brigadir/core';
import { SlackSessions, type SlackSessionDeps } from './slack-sessions';

afterEach(() => {
	vi.useRealTimers();
});

const thread = { channel: 'C1', ts: '1.0' };
const input = (question: string) => ({
	thread,
	question,
	language: 'en' as const,
	choice: { provider: 'codex' as const, model: 'gpt-6', effort: 'high' },
	context: null,
});
/** A fake QuickAsks: `reply` decides each turn — text, a failure, or nothing (it hangs). */
function fake(reply: (question: string) => string | 'fail' | 'hang') {
	const log = {
		asks: [] as { id: string; key: unknown; mode: string; provider?: string; effort?: string }[],
		follows: [] as string[],
		stops: [] as string[],
		closed: [] as string[],
	};
	const listeners = new Map<string, (event: QuickAskEvent) => void>();
	const turn = (id: string, question: string) => {
		const value = reply(question);
		if (value === 'hang') {
			listeners.get(id)?.({ id, kind: 'text', text: 'partial' });
			return;
		}
		if (value === 'fail') listeners.get(id)?.({ id, kind: 'failed', message: 'no', quota: false });
		else {
			listeners.get(id)?.({ id, kind: 'text', text: value });
			listeners.get(id)?.({ id, kind: 'done', milliseconds: 1, stopped: false });
		}
	};
	let ids = 0;
	const deps: SlackSessionDeps = {
		ask: async (key, request, mode) => {
			log.asks.push({
				id: request.id,
				key,
				mode,
				...(request.provider ? { provider: request.provider } : {}),
				...(request.effort ? { effort: request.effort } : {}),
			});
			turn(request.id, request.question);
		},
		followUp: async (_key, id, question) => {
			if (log.closed.includes(id)) throw new Error('This quick question is closed');
			log.follows.push(id);
			turn(id, question);
		},
		stop: async (id) => {
			log.stops.push(id);
		},
		close: (id) => log.closed.push(id),
		listen: (id, listener) => {
			if (listener) listeners.set(id, listener);
			else listeners.delete(id);
		},
		ensureMainTree: async () => {},
		newId: () => `s${++ids}`,
	};
	return { log, deps };
}

it('passes the chosen agent and keeps a task’s session for the thread until it fails', async () => {
	let fail = false;
	const { log, deps } = fake((question) => (fail ? 'fail' : `re: ${question}`));
	const sessions = new SlackSessions(deps);
	const task = { projectId: 'p', id: 't' };
	expect(await sessions.askTask(task, input('why?'))).toBe('re: why?');
	expect(log.asks).toEqual([
		{ id: 's1', key: task, mode: 'aboutTask', provider: 'codex', effort: 'high' },
	]);
	expect(sessions.session('C1', '1.0')).toEqual({ mode: 'aboutTask', task });
	expect(await sessions.askTask(task, input('and?'))).toBe('re: and?');
	expect(log.follows).toEqual(['s1']);
	// A failed turn closes the session; the next question opens a new one.
	fail = true;
	expect(await sessions.askTask(task, input('again?'))).toBeNull();
	expect(log.closed).toEqual(['s1']);
	expect(sessions.session('C1', '1.0')).toBeNull();
	fail = false;
	expect(await sessions.askTask(task, input('now?'))).toBe('re: now?');
	expect(log.asks.map((item) => item.id)).toEqual(['s1', 's2']);
	sessions.closeAll();
	expect(log.closed).toEqual(['s1', 's2']);
});

it('opens a new session when the old one was closed by its own idle timer, or the thread asks about another task', async () => {
	const { log, deps } = fake((question) => `re: ${question}`);
	const sessions = new SlackSessions(deps);
	await sessions.askTask({ projectId: 'p', id: 't' }, input('one'));
	log.closed.push('s1');
	expect(await sessions.askTask({ projectId: 'p', id: 't' }, input('two'))).toBe('re: two');
	expect(log.asks.map((item) => item.id)).toEqual(['s1', 's2']);
	expect(await sessions.askCode('p', input('three'))).toBe('re: three');
	expect(log.asks.at(-1)).toMatchObject({ id: 's3', key: { projectId: 'p', id: 'main-tree' } });
	expect(log.closed).toContain('s2');
	sessions.closeAll();
});

it('stops a turn after five minutes and answers with what came, then closes the session ten minutes later', async () => {
	vi.useFakeTimers();
	const { log, deps } = fake(() => 'hang');
	const sessions = new SlackSessions(deps);
	const asked = sessions.askCode('p', input('slow'));
	await vi.advanceTimersByTimeAsync(300_000);
	expect(await asked).toBe('partial');
	expect(log.stops).toEqual(['s1']);
	expect(sessions.session('C1', '1.0')).toEqual({ mode: 'aboutCode', projectId: 'p' });
	await vi.advanceTimersByTimeAsync(600_000);
	expect(log.closed).toEqual(['s1']);
	expect(sessions.session('C1', '1.0')).toBeNull();
});
