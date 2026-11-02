// spec/chat-turns-plans-and-questions#background-commands: background commands through the host — the journal, the task's summary for the sidebar, «Output», «Stop»,
// and a host that stops under a running command. Fixtures: packages/transport/fixtures/claude-background.jsonl and
// `background-live` (a real process writing its output file).
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { backgroundCommands, type EventRecord, type TaskKey } from '@brigadir/core';
import { connectHost, readIdentity } from './index';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 20000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await read();
		if (v !== undefined) return v;
		await delay(25);
	}
	throw new Error('Condition timed out');
}
async function launch(scenario: string) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-background-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	// The fixture's command outlives a stopped host on purpose (spec/chat-turns-plans-and-questions#background-commands); the test ends it.
	cleanup.push(async () => {
		for (const line of (await readFile(join(root, 'wire.jsonl'), 'utf8').catch(() => '')).split(
			'\n'
		)) {
			try {
				const entry = JSON.parse(line) as { event: string; params: { pid: number } };
				if (entry.event === 'background-pid') process.kill(-entry.params.pid, 'SIGKILL');
			} catch {
				/* gone */
			}
		}
	});
	await mkdir(join(root, 'repo'));
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(join(root, 'repo'));
	const key: TaskKey = await store.createTask(project.id, 'Test', 'claude');
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), scenario, join(root, 'wire.jsonl')],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
		cwd: join(root, 'repo'),
	});
	let diagnostics = '';
	child.stderr.on('data', (c) => {
		diagnostics += c;
	});
	const exited = new Promise<void>((done) => child.once('exit', () => done()));
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
	const journal = async () =>
		(await readFile(join(await store.taskDir(key), 'events.jsonl'), 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as EventRecord);
	return { store, key, client, exited, journal, repo: join(root, 'repo') };
}

it('journals the command and keeps the summary on the task while it runs; Claude goes on by itself after it (spec/chat-turns-plans-and-questions#agent-started-turns)', async () => {
	const { store, key, client } = await launch('background-done');
	await client.command({ kind: 'prompt', text: 'run it' });
	await until(async () => ((await store.task(key)).background ? true : undefined));
	expect((await store.task(key)).background).toEqual({
		count: 1,
		name: 'Print six ticks three seconds apart, then finished',
	});
	const list = await until(async () => {
		const records = (await client.snapshot()).records;
		return backgroundCommands(records)[0]?.state === 'completed' ? records : undefined;
	});
	const command = backgroundCommands(list)[0]!;
	expect(command.outputPath).toBe('/tmp/brigadir-fixture/fixture-session/tasks/b01ijw66c.output');
	expect(command.turnSeq).toBe(list.find((record) => record.event.kind === 'turn.started')!.seq);
	await until(async () => ((await store.task(key)).background === null ? true : undefined));
	await until(async () =>
		(await client.snapshot()).records.some(
			(record) => record.event.kind === 'turn.started' && record.event.origin === 'agent'
		)
			? true
			: undefined
	);
}, 30000);
it('reads the output tail, stops the command on «Зупинити», and a missing file is said so', async () => {
	const { client, repo } = await launch('background-live');
	await client.command({ kind: 'prompt', text: 'run it' });
	await until(async () =>
		backgroundCommands((await client.snapshot()).records)[0]?.outputPath ? true : undefined
	);
	await until(async () =>
		(await client.backgroundOutput('blive')).text.includes('begin') ? true : undefined
	);
	await expect(client.backgroundOutput('nope')).rejects.toThrow();
	await client.command({ kind: 'stopBackground', id: 'blive' });
	const records = (await client.snapshot()).records;
	expect(backgroundCommands(records)[0]).toMatchObject({ state: 'stopped', reason: 'person' });
	await expect(client.command({ kind: 'stopBackground', id: 'blive' })).rejects.toThrow(
		'not running'
	);
	await rm(join(repo, 'tasks'), { recursive: true, force: true });
	expect(await client.backgroundOutput('blive')).toEqual({ text: '', missing: true });
}, 30000);
it('a host that stops under a running command journals it as stopped (closed) before host.stopped, and does nothing to it', async () => {
	const { client, exited, journal } = await launch('background-live');
	await client.command({ kind: 'prompt', text: 'run it' });
	await until(async () =>
		backgroundCommands((await client.snapshot()).records)[0] ? true : undefined
	);
	await client.command({ kind: 'shutdown' });
	await exited;
	const records = await journal(),
		stopped = records.findIndex(
			(record) => record.event.kind === 'background.changed' && record.event.state === 'stopped'
		);
	expect(records[stopped]!.event).toEqual({
		kind: 'background.changed',
		id: 'blive',
		state: 'stopped',
		reason: 'closed',
	});
	expect(records.findIndex((record) => record.event.kind === 'host.stopped')).toBeGreaterThan(
		stopped
	);
}, 30000);
