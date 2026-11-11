import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, ProcessCoordinator, atomicJson } from '@brigadir/persistence';
import { pendingInputs, promptQueue, type EventRecord, type TaskKey } from '@brigadir/core';
import { connectHost, readIdentity, ScopeLocks, type HostClient } from './index';
import { hostIdleMs, idleBlocker, idleTimeout, type IdleState } from './idle';
const run = promisify(execFile);
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
/** A tiny idle timeout: a host that should stay must outlive several of them. */
const idleMs = 300,
	outlive = () => delay(idleMs * 4);
const helper = resolve('apps/desktop/out/services/process-owner');
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-idle-test-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo);
	await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	await writeFile(join(repo, 'README.md'), 'hello\n');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Idle', 'claude');
	return { root, store, task, log: join(root, 'agent.jsonl') };
}
async function launch(store: SessionStore, key: TaskKey, log: string, consoleOnly = false) {
	const dir = await store.taskDir(key);
	const config = join(dir, 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		consoleOnly,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', log],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
		env: { ...process.env, BRIGADIR_TEST_IDLE_MS: String(idleMs) },
	});
	let diagnostics = '';
	child.stderr.on('data', (c) => {
		diagnostics += c;
	});
	cleanup.push(async () => {
		if (alive(child)) {
			child.kill('SIGTERM');
			await until(async () => (alive(child) ? undefined : true)).catch(() => child.kill('SIGKILL'));
		}
	});
	const identity = await until(async () => {
		if (child.exitCode !== null) throw new Error(diagnostics);
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(identity);
	cleanup.push(async () => client.close());
	if (!consoleOnly) {
		await until(async () => ((await client.snapshot()).connected ? true : undefined));
		await client.startAgent();
		await until(async () =>
			(await client.snapshot()).records.findLast((r) => r.event.kind === 'session.started')
		);
	}
	return { child, client };
}
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const exited = (child: ChildProcess) => until(async () => (alive(child) ? undefined : true));
async function event(client: HostClient, kind: EventRecord['event']['kind'], after = 0) {
	return until(async () =>
		(await client.snapshot()).records.find((r) => r.seq > after && r.event.kind === kind)
	);
}
const last = async (client: HostClient) => (await client.snapshot()).records.at(-1)!.seq;
const agentLog = async (path: string) =>
	(await readFile(path, 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { event: string; params: unknown });

it('names every blocker and a 15-minute default that only a test variable shortens', () => {
	const quiet: IdleState = {
		terminal: false,
		busy: false,
		starting: false,
		saving: false,
		inputs: 0,
		queued: 0,
		quota: false,
		consoles: false,
		visible: false,
		crew: 'none',
		status: 'done',
	};
	expect(idleBlocker(quiet)).toBeNull();
	expect(idleBlocker({ ...quiet, crew: 'settled' })).toBeNull();
	expect(idleBlocker({ ...quiet, status: 'interrupted' })).toBeNull();
	expect(
		[
			{ terminal: true },
			{ busy: true },
			{ starting: true },
			{ saving: true },
			{ inputs: 1 },
			{ queued: 1 },
			{ quota: true },
			{ consoles: true },
			{ visible: true },
			{ crew: 'worker' as const },
			{ crew: 'active' as const },
			{ status: 'preparing' as const },
			{ status: 'queued' as const },
		].map((change) => idleBlocker({ ...quiet, ...change }))
	).toEqual([
		'terminal',
		'turn',
		'turn',
		'saving',
		'input',
		'queue',
		'quota',
		'console',
		'visible',
		'crew',
		'crew',
		'launch',
		'launch',
	]);
	expect(hostIdleMs).toBe(15 * 60_000);
	expect(idleTimeout({})).toBe(hostIdleMs);
	expect(idleTimeout({ BRIGADIR_TEST_IDLE_MS: '250' })).toBe(250);
	expect(idleTimeout({ BRIGADIR_TEST_IDLE_MS: 'x' })).toBe(hostIdleMs);
});

it('stops an idle GUI host like Stop: reason idle, status kept, repo locks released, session resumed on restart', async () => {
	const { store, task, log } = await setup();
	const { child, client } = await launch(store, task, log);
	const locks = new ScopeLocks(store, new ProcessCoordinator(helper));
	expect((await locks.snapshot()).some((lock) => lock.owner.key.id === task.id)).toBe(true);
	// The selected task stays up; losing the UI peer forgets the selection.
	await client.visible(true);
	await client.command({ kind: 'prompt', text: 'hello' });
	await event(client, 'turn.completed');
	await outlive();
	expect(alive(child)).toBe(true);
	client.close();
	await exited(child);
	const journal = await store.journal(task);
	expect(journal.records.at(-1)!.event).toEqual({ kind: 'host.stopped', reason: 'idle' });
	expect((await store.task(task)).status).toBe('done');
	expect(await locks.snapshot()).toEqual([]);
	// The next start loads the same provider session instead of opening a new one.
	const restarted = await launch(store, task, log);
	await restarted.client.visible(true);
	const records = (await restarted.client.snapshot()).records.filter(
		(r) => r.event.kind === 'session.started'
	);
	expect(records.map((r) => r.event.kind === 'session.started' && r.event.sessionId)).toEqual([
		'fixture-session',
		'fixture-session',
	]);
	expect(
		(await agentLog(log))
			.map((entry) => entry.event)
			.filter((name) => name === 'new' || name === 'load')
	).toEqual(['new', 'load']);
	const before = await last(restarted.client);
	await restarted.client.command({ kind: 'prompt', text: 'hello again' });
	await event(restarted.client, 'turn.completed', before);
	expect((await store.task(task)).status).toBe('done');
}, 30000);

it('keeps the host while a console, a turn, a paused queue, a permission or the selection holds it', async () => {
	const { store, task, log } = await setup();
	const { child, client } = await launch(store, task, log);
	await client.visible(true);
	const console = (await client.terminal({ kind: 'create', role: 'console' })) as { id: string };
	await client.visible(false);
	await outlive();
	expect(alive(child)).toBe(true);
	// A running turn: the console may go, the turn holds.
	let before = await last(client);
	await client.command({ kind: 'prompt', text: 'hold' });
	await event(client, 'turn.started', before);
	await client.terminal({ kind: 'close', id: console.id });
	await outlive();
	expect(alive(child)).toBe(true);
	// A paused queue with a prompt, after the turn was stopped the way Stop does it.
	await client.command({ kind: 'prompt', text: 'later' });
	await client.command({ kind: 'pausePromptQueue' });
	before = await last(client);
	await client.command({ kind: 'cancel' });
	await event(client, 'turn.completed', before);
	const queued = promptQueue((await client.snapshot()).records);
	expect(queued.paused).toBe(true);
	expect(queued.prompts).toHaveLength(1);
	await outlive();
	expect(alive(child)).toBe(true);
	// A pending permission.
	await client.visible(true);
	await client.command({ kind: 'removeQueuedPrompt', id: queued.prompts[0]!.id });
	await client.command({ kind: 'resumePromptQueue' });
	before = await last(client);
	await client.command({ kind: 'prompt', text: 'permission' });
	await event(client, 'permission.requested', before);
	await client.visible(false);
	await outlive();
	expect(alive(child)).toBe(true);
	const pending = pendingInputs((await client.snapshot()).records).permissions[0]!;
	before = await last(client);
	await client.command({ kind: 'answerPermission', id: pending.id, optionId: 'deny' });
	await event(client, 'turn.completed', before);
	await exited(child);
	expect((await store.journal(task)).records.at(-1)!.event).toEqual({
		kind: 'host.stopped',
		reason: 'idle',
	});
}, 30000);

it('a host of an older app records its version and stops at the turn boundary, selected or not (spec/architecture-and-platform#auto-update)', async () => {
	const { store, task, log } = await setup();
	const { child, client } = await launch(store, task, log);
	const version = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8')).version;
	expect((await readIdentity(store, task))?.appVersion).toBe(version);
	await client.visible(true);
	let before = await last(client);
	await client.command({ kind: 'prompt', text: 'hold' });
	await event(client, 'turn.started', before);
	await client.command({ kind: 'retire' });
	await outlive();
	expect(alive(child)).toBe(true);
	before = await last(client);
	await client.command({ kind: 'cancel' });
	await event(client, 'turn.completed', before);
	await exited(child);
	expect((await store.journal(task)).records.at(-1)!.event).toEqual({
		kind: 'host.stopped',
		reason: 'update',
	});
}, 30000);

it('never stops a CLI task host for idleness', async () => {
	const { store, task, log } = await setup();
	await store.updateTask(task, { transport: 'terminal' });
	const { child } = await launch(store, task, log, true);
	await outlive();
	expect(alive(child)).toBe(true);
}, 20000);

it('opens a console in the main tree, which has no provider, and starts no agent there (spec/tasks#quick-tasks)', async () => {
	const { store, task, log } = await setup();
	const tree = await store.ensureMainTree(task.projectId);
	const { child, client } = await launch(store, tree, log, true);
	const created = (await client.terminal({ kind: 'create', role: 'console' })) as {
		id: string;
		role: string;
	};
	expect(created.role).toBe('console');
	expect(
		((await client.terminal({ kind: 'list' })) as { id: string }[]).map((item) => item.id)
	).toContain(created.id);
	await expect(client.startAgent()).rejects.toThrow('Task has no provider');
	expect(alive(child)).toBe(true);
}, 20000);

it('a console-only host with no agent takes Pause queue, so Complete stops it (spec/tasks#archive-actions)', async () => {
	const { store, task, log } = await setup();
	const { client } = await launch(store, task, log, true);
	await until(async () => ((await client.status()).connected ? true : undefined));
	await expect(client.command({ kind: 'pausePromptQueue' })).resolves.toEqual({ accepted: true });
}, 20000);

it('a repeated pull request record neither journals nor keeps the host alive (spec/tasks#lock-registry)', async () => {
	const { store, task, log } = await setup();
	const { child, client } = await launch(store, task, log);
	const before = await last(client);
	await client.command({ kind: 'prompt', text: 'hello' });
	await event(client, 'turn.completed', before);
	const { readSnapshots } = await import('@brigadir/git');
	const scopeId = (await readSnapshots(store, task))!.scopes[0]!.id;
	const pr = {
		number: 1065,
		url: 'https://github.com/o/r/pull/1065',
		title: 'Merged',
		state: 'MERGED' as const,
		head: 'feature',
		base: 'main',
	};
	await client.command({ kind: 'recordPullRequest', scopeId, pr });
	// The same PR in another key order, as a forge refresh sends it, every third of the idle wait: only the first record counts.
	for (let index = 0; index < 8 && alive(child); index++) {
		await client
			.command({
				kind: 'recordPullRequest',
				scopeId,
				pr: {
					base: 'main',
					head: 'feature',
					state: 'MERGED',
					title: 'Merged',
					url: pr.url,
					number: 1065,
				},
			})
			.catch(() => {});
		await delay(idleMs / 3);
	}
	await exited(child);
	const records = (await store.journal(task)).records;
	expect(records.filter((r) => r.event.kind === 'pull-request.changed')).toHaveLength(1);
	expect(records.at(-1)!.event).toEqual({ kind: 'host.stopped', reason: 'idle' });
	expect((await store.task(task)).pullRequests?.[scopeId]?.number).toBe(1065);
}, 30000);
