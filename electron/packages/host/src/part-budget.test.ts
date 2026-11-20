import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { promptQueue, type EventRecord, type TaskKey } from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';

/** spec/crew#auto-budget through the built host and the scripted agent: a worker stopped at its part budget does not run on. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (value !== undefined) return value;
		await delay(25);
	}
	throw new Error('Condition timed out');
}
async function launch() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-part-budget-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	await mkdir(join(root, 'repo'));
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(join(root, 'repo'));
	const key: TaskKey = await store.createTask(project.id, 'API', 'claude');
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal'],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'ignore',
	});
	cleanup.push(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill('SIGTERM');
		await until(async () =>
			child.exitCode !== null || child.signalCode !== null ? true : undefined
		).catch(() => child.kill('SIGKILL'));
	});
	const identity = await until(async () => {
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client: HostClient = await connectHost(identity);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	await client.startAgent();
	await until(async () =>
		(await client.snapshot()).records.find((r) => r.event.kind === 'session.started')
	);
	return { store, key, client };
}
const started = (records: readonly EventRecord[]) =>
	records.flatMap((record) => (record.event.kind === 'turn.started' ? [record.event.text] : []));

it('a worker stopped at its part budget starts nothing queued until the person’s message continues it', async () => {
	const { store, key, client } = await launch();
	await client.command({ kind: 'prompt', text: 'hold' });
	await until(async () => (started((await client.snapshot()).records).length ? true : undefined));
	// A message that waited behind the turn, and a service prompt that comes after the stop.
	await client.command({ kind: 'prompt', text: 'queued before' });
	await client.command({
		kind: 'overBudget',
		title: 'API',
		budget: { minutes: 40, tokens: 400_000 },
		used: { minutes: 41, tokens: 12_000 },
	});
	await client.command({ kind: 'prompt', text: 'report', crew: { kind: 'review-continue' } });
	const exceeded = await until(async () =>
		(await client.snapshot()).records.find((r) => r.event.kind === 'crew.budget.exceeded')
	);
	await delay(1500);
	let records = (await client.snapshot()).records;
	expect(started(records)).toEqual(['hold']);
	expect(promptQueue(records).prompts.map((item) => item.command.text)).toEqual([
		'queued before',
		'report',
	]);
	expect(await store.task(key)).toMatchObject({ status: 'needs-you', overBudget: true });
	// The person continues the part: their message runs first, then what waited.
	await client.command({ kind: 'prompt', text: 'go on' });
	records = await until(async () => {
		const value = (await client.snapshot()).records;
		return started(value).length >= 4 ? value : undefined;
	});
	expect(started(records)).toEqual(['hold', 'go on', 'queued before', 'report']);
	expect(records.findIndex((r) => r.seq === exceeded.seq)).toBeGreaterThan(0);
	expect((await store.task(key)).overBudget).toBe(false);
}, 60_000);

it('a continuation taken while the queue is paused lifts the stop on disk; a refused one does not', async () => {
	const { store, key, client } = await launch();
	const stop = () =>
		client.command({
			kind: 'overBudget',
			title: 'API',
			budget: { minutes: 40, tokens: 400_000 },
			used: { minutes: 41, tokens: 12_000 },
		});
	await stop();
	await client.command({ kind: 'prompt', text: 'report', crew: { kind: 'review-continue' } });
	await client.command({ kind: 'pausePromptQueue' });
	await client.command({ kind: 'prompt', text: 'go on' });
	let records = (await client.snapshot()).records;
	expect(promptQueue(records).prompts.map((item) => item.command.text)).toEqual([
		'go on',
		'report',
	]);
	// A restart now keeps the continuation: the stop is lifted on disk.
	expect((await store.task(key)).overBudget).toBe(false);
	await client.command({ kind: 'resumePromptQueue' });
	records = await until(async () => {
		const value = (await client.snapshot()).records;
		return started(value).length >= 2 ? value : undefined;
	});
	expect(started(records)).toEqual(['go on', 'report']);
	// Stopped again with a full, paused queue: the message must wait in the queue, is refused, and the stop stays.
	await until(async () => (!(await client.status()).busy ? true : undefined));
	await stop();
	for (let index = 0; index < 32; index++)
		await client.command({ kind: 'prompt', text: `r${index}`, crew: { kind: 'review-continue' } });
	await client.command({ kind: 'pausePromptQueue' });
	await expect(client.command({ kind: 'prompt', text: 'go on' })).rejects.toThrow(
		'The prompt queue is full'
	);
	expect((await store.task(key)).overBudget).toBe(true);
}, 60_000);
