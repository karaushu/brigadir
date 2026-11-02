import { expect, it } from 'vitest';
import {
	affectsScopes,
	agentRunning,
	hostStatus,
	idleStopped,
	isBusy,
	isHostStatus,
	type EventRecord,
	type SessionEvent,
} from './session';
const record = (seq: number, event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-09-23T00:00:00.000Z',
	event,
});
it('summarizes a host without its journal', () => {
	const records = [
		record(1, { kind: 'session.started', sessionId: 'a', modes: [], modeId: null, options: [] }),
		record(2, { kind: 'session.failed', message: 'x' }),
		record(3, { kind: 'session.started', sessionId: 'b', modes: [], modeId: null, options: [] }),
		record(4, { kind: 'turn.started', text: 'go' }),
	];
	expect(hostStatus(records, true)).toEqual({
		connected: true,
		seq: 4,
		started: 3,
		failed: 2,
		busy: true,
	});
	expect(hostStatus([], false)).toEqual({
		connected: false,
		seq: 0,
		started: null,
		failed: null,
		busy: false,
	});
	expect(
		hostStatus([...records, record(5, { kind: 'host.stopped', reason: 'x' })], false).busy
	).toBe(false);
	expect(isBusy(records)).toBe(true);
	expect(isBusy(records.slice(0, 3))).toBe(false);
	// A wave-1 host answers without `busy`; it still validates.
	expect(isHostStatus({ connected: true, seq: 4, started: 3, failed: 2 })).toBe(true);
	expect(isHostStatus({ connected: true, seq: 4, started: 3, failed: 2, busy: 1 })).toBe(false);
	expect(isHostStatus(hostStatus(records, true))).toBe(true);
	expect(isHostStatus({ connected: true, seq: '4', started: null, failed: null })).toBe(false);
});
it('refreshes scopes on lifecycle and checkpoints, not on streamed deltas', () => {
	expect(affectsScopes(null)).toBe(true);
	expect(affectsScopes(record(1, { kind: 'checkpoint.created', checkpoint: 1 }))).toBe(true);
	expect(affectsScopes(record(2, { kind: 'host.stopped', reason: 'shutdown' }))).toBe(true);
	expect(
		affectsScopes(
			record(3, {
				kind: 'message.delta',
				role: 'assistant',
				messageId: null,
				content: { kind: 'text', text: 'x' },
			})
		)
	).toBe(false);
});
it('treats only an idle stop of a started session as resumable (spec/architecture-and-platform#host-lifecycle)', () => {
	const started = record(1, {
			kind: 'session.started',
			sessionId: 'a',
			modes: [],
			modeId: null,
			options: [],
		}),
		turn = [
			record(2, { kind: 'turn.started', text: 'go' }),
			record(3, { kind: 'turn.completed', reason: 'end_turn' }),
		];
	expect(idleStopped([started, ...turn, record(4, { kind: 'host.stopped', reason: 'idle' })])).toBe(
		true
	);
	// Stop, a crash or a failed start keep the banner; a console-only host that came and went does not hide the idle stop.
	expect(
		idleStopped([started, ...turn, record(4, { kind: 'host.stopped', reason: 'shutdown' })])
	).toBe(false);
	expect(
		idleStopped([
			started,
			...turn,
			record(4, { kind: 'host.stopped', reason: 'idle' }),
			record(5, { kind: 'host.stopped', reason: 'console_closed' }),
		])
	).toBe(true);
	expect(
		idleStopped([
			started,
			...turn,
			record(4, { kind: 'host.stopped', reason: 'idle' }),
			record(5, { kind: 'session.failed', message: 'x' }),
		])
	).toBe(false);
	expect(
		idleStopped([
			started,
			...turn,
			record(4, { kind: 'host.stopped', reason: 'idle' }),
			record(5, { kind: 'session.started', sessionId: 'a', modes: [], modeId: null, options: [] }),
		])
	).toBe(false);
	// Without a started session there is nothing to resume: the Start banner stays.
	expect(idleStopped([record(1, { kind: 'host.stopped', reason: 'idle' })])).toBe(false);
	expect(idleStopped([])).toBe(false);
});
it('counts a session as live only until a host stops after it', () => {
	const started = record(1, {
		kind: 'session.started',
		sessionId: 'a',
		modes: [],
		modeId: null,
		options: [],
	});
	expect(agentRunning([started, record(2, { kind: 'turn.completed', reason: 'end_turn' })])).toBe(
		true
	);
	// The app quit yesterday; today a host came up only for the task's consoles (spec/task-window-workspace#restore-window): connected, without an agent.
	expect(
		agentRunning([
			started,
			record(2, { kind: 'host.stopped', reason: 'terminated' }),
			record(3, { kind: 'checkpoint.created', checkpoint: 1 }),
		])
	).toBe(false);
	expect(
		agentRunning([
			started,
			record(2, { kind: 'host.stopped', reason: 'terminated' }),
			record(3, { kind: 'session.started', sessionId: 'a', modes: [], modeId: null, options: [] }),
		])
	).toBe(true);
	expect(agentRunning([])).toBe(false);
});
