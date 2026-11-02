// spec/chat-turns-plans-and-questions#agent-started-turns: a turn the agent began on its own goes through the host like any turn — journal, status, busy, Stop, the person's
// message. The fixture replays the wire of the live probe (packages/transport/fixtures/claude-agent-turn.jsonl).
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	activityRows,
	promptQueue,
	turnSummaries,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 10000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await read();
		if (v !== undefined) return v;
		await delay(25);
	}
	throw new Error('Condition timed out');
}
function env(values: Record<string, string>) {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	cleanup.push(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}
async function launch(scenario = 'agent-turn') {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-agent-turn-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'repo'));
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(join(root, 'repo'));
	const key: TaskKey = await store.createTask(project.id, 'Test', 'claude');
	const log = join(root, 'wire.jsonl');
	env({ BRIGADIR_FIXTURE_LOG: log });
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), scenario],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
	});
	let diagnostics = '';
	child.stderr.on('data', (c) => {
		diagnostics += c;
	});
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await until(async () =>
				child.exitCode !== null || child.signalCode !== null ? true : undefined
			).catch(() => child.kill('SIGKILL'));
		}
	});
	const identity = await until(async () => {
		if (child.exitCode !== null) throw new Error(diagnostics);
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(identity);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	await client.startAgent();
	await until(async () =>
		(await client.snapshot()).records.findLast((r) => r.event.kind === 'session.started')
	);
	const wire = async () =>
		(await readFile(log, 'utf8').catch(() => ''))
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string; params: unknown });
	return { store, key, client, wire };
}
const records = async (client: HostClient) => (await client.snapshot()).records;
const starts = (list: readonly EventRecord[]) =>
	list.filter((record) => record.event.kind === 'turn.started');
const ends = (list: readonly EventRecord[]) =>
	list.filter((record) => record.event.kind === 'turn.completed');
/** Waits for the agent's own turn: the second `turn.started`, the one with `origin: 'agent'`. */
const agentStarted = (client: HostClient) =>
	until(async () =>
		(await records(client)).find(
			(record) => record.event.kind === 'turn.started' && record.event.origin === 'agent'
		)
	);

it("journals the turn the agent began on its own: its own boundaries, no person's row, working → done (spec/chat-turns-plans-and-questions#agent-started-turns)", async () => {
	const { store, key, client } = await launch();
	await client.command({ kind: 'prompt', text: 'background' });
	const started = await agentStarted(client);
	expect(started.event).toEqual({ kind: 'turn.started', text: '', origin: 'agent' });
	await until(async () => (ends(await records(client)).length === 2 ? true : undefined));
	const list = await records(client),
		first = ends(list)[0]!,
		last = ends(list)[1]!;
	expect(first.seq).toBeLessThan(started.seq);
	expect(last.event).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	// Everything the agent did after the background task sits between its own boundaries.
	const inside = list.filter((record) => record.seq > started.seq && record.seq < last.seq);
	expect(
		inside.some(
			(record) =>
				record.event.kind === 'tool.changed' &&
				record.event.patch.id === 'toolu_01NxTDzwsZXZqEhRJQ5FS5nD'
		)
	).toBe(true);
	expect(
		list
			.filter((record) => record.seq > first.seq && record.seq < started.seq)
			.some(
				(record) => record.event.kind === 'tool.changed' || record.event.kind === 'message.delta'
			)
	).toBe(false);
	// The log shows one person's row (the prompt), the turn rail and footers count two turns.
	expect(
		activityRows(list).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['background']);
	expect(turnSummaries(list).map((turn) => turn.status)).toEqual(['done', 'done']);
	expect((await store.task(key)).status).toBe('done');
	// The host is free: the next prompt is a turn of its own.
	await client.command({ kind: 'prompt', text: 'hello' });
	await until(async () => (ends(await records(client)).length === 3 ? true : undefined));
	expect(
		starts(await records(client)).map((record) =>
			record.event.kind === 'turn.started' ? record.event.text : ''
		)
	).toEqual(['background', '', 'hello']);
}, 20000);

it("takes the person's message into that turn and keeps a queued one for after it (spec/chat-turns-plans-and-questions#agent-started-turns)", async () => {
	env({ BRIGADIR_FIXTURE_AGENT_TURN_HOLD: '1', BRIGADIR_STEER_HOLD_MS: '150' });
	const { store, key, client, wire } = await launch();
	await client.command({ kind: 'prompt', text: 'background' });
	await agentStarted(client);
	await until(async () =>
		(await wire()).some((item) => item.event === 'agent-turn') ? true : undefined
	);
	expect((await store.task(key)).status).toBe('working');
	// Enter: the message goes into the agent's turn; ⌘↩ after it: a queued message waits for that turn's end.
	await client.command({ kind: 'prompt', text: 'also this', steer: true });
	await client.command({ kind: 'prompt', text: 'after it' });
	await until(async () =>
		(await wire()).some((item) => item.event === 'agent-turn-fold') ? true : undefined
	);
	const list = await until(async () => {
		const value = await records(client);
		return ends(value).length >= 3 ? value : undefined;
	});
	const agent = starts(list).find(
		(record) => record.event.kind === 'turn.started' && record.event.origin === 'agent'
	)!;
	const steered = list.find((record) => record.event.kind === 'prompt.steered')!,
		closed = ends(list)[1]!;
	expect(steered.seq).toBeGreaterThan(agent.seq);
	expect(steered.seq).toBeLessThan(closed.seq);
	expect(
		list.some(
			(record) =>
				record.event.kind === 'message.delta' &&
				record.event.content.kind === 'text' &&
				record.event.content.text === 'heard: also this' &&
				record.seq < closed.seq
		)
	).toBe(true);
	// The queued message became the next turn, after the agent's.
	const next = starts(list).at(-1)!;
	expect(next.event).toMatchObject({ kind: 'turn.started', text: 'after it' });
	expect(next.seq).toBeGreaterThan(closed.seq);
	expect(promptQueue(list).prompts).toEqual([]);
	expect(
		activityRows(list).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['background', 'also this', 'after it']);
}, 20000);

it("stops the agent's own turn on Stop: cancelled and interrupted (spec/chat-turns-plans-and-questions#agent-started-turns)", async () => {
	env({ BRIGADIR_FIXTURE_AGENT_TURN_HOLD: '1' });
	const { store, key, client, wire } = await launch();
	await client.command({ kind: 'prompt', text: 'background' });
	await agentStarted(client);
	await until(async () =>
		(await wire()).some((item) => item.event === 'agent-turn') ? true : undefined
	);
	expect((await client.status()).busy).toBe(true);
	await client.command({ kind: 'cancel' });
	const closed = await until(async () => ends(await records(client))[1]);
	expect(closed.event).toEqual({ kind: 'turn.completed', reason: 'cancelled' });
	expect((await wire()).some((item) => item.event === 'agent-turn-cancel')).toBe(true);
	await until(async () => ((await store.task(key)).status === 'interrupted' ? true : undefined));
}, 20000);
