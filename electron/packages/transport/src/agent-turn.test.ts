// spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent began on its own, on the wire of a live run (fixtures/claude-agent-turn.jsonl):
// Claude Code after a background task, and the same shape told by codex `threadStatus`.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@brigadir/core';
import { AgentTransport, type TransportOptions } from './transport';
let directory: string;
let events: AgentEvent[];
const transports: AgentTransport[] = [];
const saved = new Map<string, string | undefined>();
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'brigadir-agent-turn-'));
	events = [];
});
afterEach(async () => {
	for (const transport of transports.splice(0)) {
		transport.close();
		await transport.closed;
	}
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	await rm(directory, { recursive: true, force: true });
});
const fixture = fileURLToPath(new URL('../fixtures/agent.mjs', import.meta.url));
function env(key: string, value: string) {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	process.env[key] = value;
}
async function start(scenario: string, overrides: Partial<TransportOptions> = {}) {
	const transport = await AgentTransport.start({
		provider: 'claude',
		cwd: directory,
		startupTimeoutMs: 3000,
		adapter: {
			command: process.execPath,
			args: [fixture, scenario, join(directory, 'wire.jsonl')],
		},
		onEvent: (event) => {
			events.push(event);
		},
		...overrides,
	});
	transports.push(transport);
	return transport;
}
async function wire() {
	return (await readFile(join(directory, 'wire.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { event: string; params: unknown });
}
/** The host's part: journals the turn (here, a marker) and says whether it took it. */
const begun =
	(answer = true) =>
	async () => {
		events.push({ kind: 'unhandled', name: 'BEGIN' });
		return answer;
	};
const kinds = () => events.map((event) => (event.kind === 'unhandled' ? event.name : event.kind));
const ends = () => kinds().filter((kind) => kind === 'turn.completed').length;
const said = (text: string) =>
	events.some(
		(event) =>
			event.kind === 'message.delta' &&
			event.content.kind === 'text' &&
			event.content.text.startsWith(text)
	);

it('opens after our turn ended, on session_state_changed running, and closes on idle after everything the turn sent', async () => {
	const transport = await start('agent-turn', { agentTurn: begun() });
	await transport.send({ kind: 'prompt', text: 'background' });
	expect(ends()).toBe(1);
	await vi.waitFor(() => expect(ends()).toBe(2), { timeout: 5000 });
	const own = kinds().indexOf('BEGIN');
	expect(own).toBeGreaterThan(kinds().indexOf('turn.completed'));
	const turn = events.slice(own + 1);
	expect(turn.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	// Its calls and its answer belong to it, not to the turn before.
	expect(
		turn.flatMap((event) =>
			event.kind === 'tool.changed' && event.patch.status === 'completed' ? [event.patch.id] : []
		)
	).toEqual(['toolu_01NxTDzwsZXZqEhRJQ5FS5nD', 'toolu_013t5mUCP1qYSkrd8PGuS4ix']);
	expect(
		turn.some(
			(event) =>
				event.kind === 'message.delta' &&
				event.content.kind === 'text' &&
				event.content.text.startsWith('The backgrou')
		)
	).toBe(true);
	expect(
		events
			.slice(0, own)
			.some(
				(event) =>
					event.kind === 'tool.changed' && event.patch.id === 'toolu_01NxTDzwsZXZqEhRJQ5FS5nD'
			)
	).toBe(false);
	expect(transport.running).toBe(false);
	expect((await wire()).find((item) => item.event === 'new')?.params).toMatchObject({
		_meta: {
			claudeCode: {
				emitRawSDKMessages: expect.arrayContaining([
					{ type: 'system', subtype: 'session_state_changed' },
				]),
			},
		},
	});
	// The connection is free again: the next prompt runs as usual.
	await transport.send({ kind: 'prompt', text: 'hello' });
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
});

it("adds the person's message to that turn as a prompt the turn answers, and ends once", async () => {
	env('BRIGADIR_FIXTURE_AGENT_TURN_HOLD', '1');
	const transport = await start('agent-turn', { agentTurn: begun() });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(
		async () => expect((await wire()).some((item) => item.event === 'agent-turn')).toBe(true),
		{ timeout: 5000 }
	);
	await vi.waitFor(() => expect(kinds()).toContain('BEGIN'));
	expect(await transport.steer('also this', [], [], async () => {})).toEqual({
		outcome: 'injected',
	});
	await vi.waitFor(() => expect(ends()).toBe(2), { timeout: 5000 });
	const turn = events.slice(kinds().indexOf('BEGIN'));
	expect(
		turn.some(
			(event) =>
				event.kind === 'message.delta' &&
				event.content.kind === 'text' &&
				event.content.text === 'heard: also this'
		)
	).toBe(true);
	expect(turn.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	// claude-agent-acp has no turn of ours to steer into (promptRequired), so the message goes as a prompt the turn answers.
	const calls = (await wire()).map((item) => item.event),
		steer = calls.indexOf('steer');
	expect(steer).toBeGreaterThan(-1);
	expect(calls.indexOf('agent-turn-fold')).toBeGreaterThan(steer);
	expect(transport.running).toBe(false);
});

it('stops on Stop: the turn ends cancelled, and the next prompt runs', async () => {
	env('BRIGADIR_FIXTURE_AGENT_TURN_HOLD', '1');
	const transport = await start('agent-turn', { agentTurn: begun() });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(
		async () => expect((await wire()).some((item) => item.event === 'agent-turn')).toBe(true),
		{ timeout: 5000 }
	);
	await vi.waitFor(() => expect(kinds()).toContain('BEGIN'));
	await transport.send({ kind: 'cancel' });
	await vi.waitFor(
		() => expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'cancelled' }),
		{ timeout: 5000 }
	);
	expect(transport.running).toBe(false);
	await transport.send({ kind: 'prompt', text: 'hello' });
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
});

it('closes the turn 20 s after Stop when the agent never says it is idle (here shorter)', async () => {
	env('BRIGADIR_FIXTURE_AGENT_TURN_HOLD', '1');
	env('BRIGADIR_FIXTURE_AGENT_TURN_DEAF', '1');
	env('BRIGADIR_STEER_STOP_MS', '300');
	const transport = await start('agent-turn', { agentTurn: begun() });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(() => expect(kinds()).toContain('BEGIN'), { timeout: 5000 });
	await vi.waitFor(async () =>
		expect((await wire()).some((item) => item.event === 'agent-turn')).toBe(true)
	);
	const started = Date.now();
	await transport.send({ kind: 'cancel' });
	await vi.waitFor(() => expect(ends()).toBe(2), { timeout: 5000 });
	expect(Date.now() - started).toBeLessThan(5000);
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'cancelled' });
	// One end per turn, whichever came first.
	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(ends()).toBe(2);
});

it('leaves the turn to a prompt the host is starting: no turn of its own, the connection is free', async () => {
	const transport = await start('agent-turn', { agentTurn: begun(false) });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(() => expect(kinds()).toContain('BEGIN'), { timeout: 5000 });
	await vi.waitFor(() => expect(said('The backgrou')).toBe(true), { timeout: 5000 });
	await vi.waitFor(() => expect(transport.running).toBe(false));
	expect(ends()).toBe(1);
	await transport.send({ kind: 'prompt', text: 'hello' });
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
});

it("without the host's hook opens nothing, as before", async () => {
	const transport = await start('agent-turn');
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(() => expect(said('The backgrou')).toBe(true), { timeout: 5000 });
	expect(ends()).toBe(1);
	expect(transport.running).toBe(false);
});

it('opens and closes the same way on codex threadStatus, never on the statuses of our own prompt', async () => {
	const transport = await start('agent-turn-codex', { provider: 'codex', agentTurn: begun() });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(() => expect(ends()).toBe(2), { timeout: 5000 });
	expect(kinds().filter((kind) => kind === 'BEGIN')).toHaveLength(1);
	const turn = events.slice(kinds().indexOf('BEGIN'));
	expect(
		turn.some((event) => event.kind === 'tool.changed' && event.patch.id === 'codex-own')
	).toBe(true);
	expect(turn.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	expect(transport.running).toBe(false);
});

// The host under load: the end of a turn takes a while to journal, so the connection is still busy with that turn when the
// agent says it works again 50 ms after its `idle` (spec/chat-turns-plans-and-questions#agent-started-turns, races).
const slowEnds = {
	onEvent: async (event: AgentEvent) => {
		events.push(event);
		if (event.kind === 'turn.completed') await new Promise((resolve) => setTimeout(resolve, 300));
	},
};

it("opens the agent's turn that began while our turn was still settling, once ours lets go", async () => {
	const transport = await start('agent-turn-quick', { agentTurn: begun(), ...slowEnds });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(() => expect(ends()).toBe(2), { timeout: 5000 });
	expect(kinds().filter((kind) => kind === 'BEGIN')).toHaveLength(1);
	const own = kinds().indexOf('BEGIN');
	expect(own).toBeGreaterThan(kinds().indexOf('turn.completed'));
	expect(events.at(-1)).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	// Its calls belong to it, not to the turn before.
	expect(
		events
			.slice(0, own)
			.some(
				(event) =>
					event.kind === 'tool.changed' && event.patch.id === 'toolu_01NxTDzwsZXZqEhRJQ5FS5nD'
			)
	).toBe(false);
	expect(
		events
			.slice(own)
			.some(
				(event) =>
					event.kind === 'tool.changed' && event.patch.id === 'toolu_01NxTDzwsZXZqEhRJQ5FS5nD'
			)
	).toBe(true);
	await vi.waitFor(() => expect(transport.running).toBe(false));
});

it('opens the next turn of the agent that began while its previous one was still settling', async () => {
	env('BRIGADIR_FIXTURE_AGENT_TURN_TWICE', '1');
	const transport = await start('agent-turn-quick', { agentTurn: begun(), ...slowEnds });
	await transport.send({ kind: 'prompt', text: 'background' });
	await vi.waitFor(() => expect(ends()).toBe(3), { timeout: 5000 });
	// Each start after the end before it, each end after its start.
	const order = kinds().filter((kind) => kind === 'BEGIN' || kind === 'turn.completed');
	expect(order).toEqual(['turn.completed', 'BEGIN', 'turn.completed', 'BEGIN', 'turn.completed']);
	await vi.waitFor(() => expect(transport.running).toBe(false));
});

it('opens nothing after our turn when the agent stays idle, however long our turn takes to settle', async () => {
	const transport = await start('agent-turn-quick', { agentTurn: begun(), ...slowEnds });
	await transport.send({ kind: 'prompt', text: 'hello' });
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(kinds()).not.toContain('BEGIN');
	expect(ends()).toBe(1);
	expect(transport.running).toBe(false);
});
