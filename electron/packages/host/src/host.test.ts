import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson, readProjectFile } from '@brigadir/persistence';
import { pendingInputs, planChatPrompt, type EventRecord, type TaskKey } from '@brigadir/core';
import { connectHost, readIdentity, Peer, type HostClient, type HostIdentity } from './index';
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
async function setup(provider: 'claude' | 'codex' = 'claude') {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-host-test-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'repo'));
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(join(root, 'repo'));
	const task = await store.createTask(project.id, 'Test', provider);
	return { root, store, task };
}
async function launch(store: SessionStore, key: TaskKey, scenario = 'normal') {
	const dir = await store.taskDir(key);
	const config = join(dir, 'config.json');
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
	const started = await until(async () =>
		(await client.snapshot()).records.findLast((r) => r.event.kind === 'session.started')
	);
	const status = await client.status();
	expect(status.connected).toBe(true);
	expect(status.started).toBeGreaterThanOrEqual(started.seq);
	expect(status.busy).toBe(false);
	// A cursor sends only the tail; one past the end is the state without records.
	const tail = await client.snapshot(started.seq);
	expect(tail.connected).toBe(true);
	expect(tail.records.every((r) => r.seq > started.seq)).toBe(true);
	expect((await client.snapshot(Number.MAX_SAFE_INTEGER)).records).toEqual([]);
	return { child, identity, client };
}
async function event(client: HostClient, kind: EventRecord['event']['kind'], after = 0) {
	return until(async () =>
		(await client.snapshot()).records.find((r) => r.seq > after && r.event.kind === kind)
	);
}
it('separate host survives detach during permission, validates answers, cancels and resumes', async () => {
	const { store, task } = await setup();
	const { client, identity, child } = await launch(store, task);
	expect((await stat(identity.socket)).mode & 0o777).toBe(0o600);
	await client.command({ kind: 'prompt', text: 'permission' });
	const requested = await event(client, 'permission.requested');
	client.close();
	await delay(100);
	expect(child.exitCode).toBeNull();
	const second = await connectHost(identity);
	cleanup.push(async () => second.close());
	const pending = pendingInputs((await second.snapshot()).records).permissions[0]!;
	await expect(
		second.command({ kind: 'answerPermission', id: pending.id, optionId: 'invented' })
	).rejects.toThrow('invalid');
	await second.command({ kind: 'answerPermission', id: pending.id, optionId: 'allow' });
	await event(second, 'turn.completed', requested.seq);
	await expect(
		second.command({ kind: 'answerPermission', id: pending.id, optionId: 'allow' })
	).rejects.toThrow('already resolved');
	const sequence = (await second.snapshot()).records.at(-1)!.seq;
	await second.command({ kind: 'prompt', text: 'hold' });
	await second.command({ kind: 'cancel' });
	expect((await event(second, 'turn.completed', sequence)).event).toEqual({
		kind: 'turn.completed',
		reason: 'cancelled',
	});
	await second.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	const journal = await store.journal(task);
	expect(journal.issue).toBeNull();
	expect(journal.records.map((r) => r.seq)).toEqual(journal.records.map((_, i) => i + 1));
	const restarted = await launch(store, task);
	const restored = await restarted.client.snapshot();
	await until(async () =>
		(await restarted.client.snapshot()).records.filter((r) => r.event.kind === 'session.started')
			.length === 2
			? true
			: undefined
	);
	expect(restored.records.slice(0, journal.records.length)).toEqual(journal.records);
	expect(JSON.stringify((await restarted.client.snapshot()).records)).not.toContain(
		'Historical replay'
	);
}, 20000);
it('waits for a starting agent instead of rejecting the prompt sent meanwhile', async () => {
	const { store, task } = await setup();
	const dir = await store.taskDir(task);
	const config = join(dir, 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key: task,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'slow-init'],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
	});
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	});
	const identity = await until(async () => {
		const id = await readIdentity(store, task);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(identity);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	expect((await client.snapshot()).records.some((r) => r.event.kind === 'session.started')).toBe(
		false
	);
	await client.command({ kind: 'prompt', text: 'hello' });
	expect((await event(client, 'turn.started')).event).toMatchObject({
		kind: 'turn.started',
		text: 'hello',
	});
	await event(client, 'turn.completed');
}, 20000);
it('real MCP stdio keeps a question through UI replacement, restricts role and accepts one answer', async () => {
	const { store, task } = await setup();
	const { client, identity } = await launch(store, task);
	const forbidden = new Peer(createConnection(identity.socket));
	cleanup.push(async () => forbidden.close());
	await forbidden.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	await expect(forbidden.request('command', { kind: 'prompt', text: 'bad' })).rejects.toThrow(
		'not available'
	);
	await expect(forbidden.request('snapshot', {})).rejects.toThrow('not available');
	await expect(
		forbidden.request('save_file', {
			path: 'file.txt',
			expectedVersion: 'a'.repeat(64),
			text: 'forbidden',
		})
	).rejects.toThrow('not available');
	await client.command({ kind: 'prompt', text: 'question' });
	await event(client, 'question.requested');
	const replacement = await connectHost(identity);
	cleanup.push(async () => replacement.close());
	const q = pendingInputs((await replacement.snapshot()).records).questions[0]!;
	await expect(
		replacement.command({ kind: 'answerQuestion', id: q.id, answer: { labels: ['Red'], text: '' } })
	).rejects.toThrow('invalid');
	await replacement.command({
		kind: 'answerQuestion',
		id: q.id,
		answer: { labels: ['Blue', 'Green'], text: 'Both' },
	});
	await event(replacement, 'turn.completed');
	const saved = await store.journal(task);
	expect(pendingInputs(saved.records).questions).toEqual([]);
	expect(saved.records.filter((r) => r.event.kind === 'question.resolved')).toHaveLength(1);
	expect(
		saved.records.some(
			(r) =>
				r.event.kind === 'message.delta' &&
				r.event.content.kind === 'text' &&
				r.event.content.text.includes('Both')
		)
	).toBe(true);
	await replacement.command({ kind: 'prompt', text: 'question' });
	await expect
		.poll(async () => pendingInputs((await replacement.snapshot()).records).questions.length)
		.toBe(1);
	const skipped = pendingInputs((await replacement.snapshot()).records).questions[0]!;
	await replacement.command({ kind: 'answerQuestion', id: skipped.id, answer: null });
	await expect
		.poll(
			async () =>
				(await replacement.snapshot()).records.filter(
					(record) => record.event.kind === 'turn.completed'
				).length
		)
		.toBe(2);
	expect(
		(await replacement.snapshot()).records.find(
			(record) => record.event.kind === 'question.resolved' && record.event.id === skipped.id
		)?.event
	).toEqual({ kind: 'question.resolved', id: skipped.id, answer: null });
	await expect(
		replacement.command({
			kind: 'answerQuestion',
			id: skipped.id,
			answer: { labels: ['Blue'], text: '' },
		})
	).rejects.toThrow('already resolved');
}, 20000);
it('accepts a review batch once across retry and restart', async () => {
	const { store, task } = await setup();
	const { client, child } = await launch(store, task);
	const command = {
		kind: 'submitReview' as const,
		text: 'review feedback',
		review: {
			id: 'a'.repeat(64),
			comments: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: 1 }],
		},
	};
	await client.command(command);
	await event(client, 'turn.completed');
	await client.command(command);
	expect(
		(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.started')
	).toHaveLength(1);
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	const restarted = await launch(store, task);
	await restarted.client.command(command);
	expect(
		(await restarted.client.snapshot()).records.filter((r) => r.event.kind === 'turn.started')
	).toHaveLength(1);
}, 20000);
it('live host serializes editor save, rejects active turns and keeps the user index', async () => {
	const { root, store, task } = await setup();
	const repo = join(root, 'repo');
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-q');
	await writeFile(join(repo, 'file.txt'), 'before\n');
	await git('add', 'file.txt');
	const index = await readFile(join(repo, '.git/index'));
	const { client } = await launch(store, task);
	const content = await readProjectFile(repo, 'file.txt');
	await client.command({ kind: 'prompt', text: 'hold' });
	await event(client, 'turn.started');
	const request = { path: 'file.txt', expectedVersion: content.version, text: 'after\n' };
	await expect(client.saveFile(request)).rejects.toThrow('finish');
	expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('before\n');
	await client.command({ kind: 'cancel' });
	await event(client, 'turn.completed');
	expect((await client.saveFile(request)).status).toBe('saved');
	expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('after\n');
	expect((await client.saveFile(request)).status).toBe('conflict');
	const records = (await client.snapshot()).records;
	expect(records.filter((r) => r.event.kind === 'file.saved')).toHaveLength(1);
	expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1));
	expect(await readFile(join(repo, '.git/index'))).toEqual(index);
}, 20000);
it('holds an after-turn save until the turn ends and writes only the newest one (spec/editor#save-during-turn)', async () => {
	const { root, store, task } = await setup();
	const repo = join(root, 'repo');
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(join(repo, 'file.txt'), 'before\n');
	const { client } = await launch(store, task);
	const content = await readProjectFile(repo, 'file.txt');
	await client.command({ kind: 'prompt', text: 'hold' });
	await event(client, 'turn.started');
	const request = { path: 'file.txt', expectedVersion: content.version, afterTurn: true };
	const first = client.saveFile({ ...request, text: 'first\n' });
	const firstSettled = first.then(
		() => 'saved',
		(error: Error) => error.message
	);
	const second = client.saveFile({ ...request, text: 'second\n' });
	expect(await firstSettled).toContain('newer save');
	expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('before\n');
	await client.command({ kind: 'cancel' });
	expect((await second).status).toBe('saved');
	expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('second\n');
	const records = (await client.snapshot()).records;
	const saved = records.findIndex((r) => r.event.kind === 'file.saved'),
		completed = records.findIndex((r) => r.event.kind === 'turn.completed');
	expect(records.filter((r) => r.event.kind === 'file.saved')).toHaveLength(1);
	expect(saved).toBeGreaterThan(completed);
}, 20000);

it('publishes discovered scopes through the live journal without a prompt or manual refresh', async () => {
	const { root, store, task } = await setup();
	const { client } = await launch(store, task);
	const nested = join(root, 'repo', 'new.repo');
	await mkdir(nested);
	await promisify(execFile)('git', ['init', '-q'], { cwd: nested });
	await writeFile(join(nested, 'nested.txt'), 'baseline\n');
	await event(client, 'scopes.changed');
	const { readSnapshots } = await import('@brigadir/git');
	await until(async () => {
		const doc = await readSnapshots(store, task);
		return doc?.scopes.some((scope) => scope.name === 'new.repo' && scope.available)
			? true
			: undefined;
	});
	expect(
		(await client.snapshot()).records.some((record) => record.event.kind === 'turn.started')
	).toBe(false);
	expect((await store.journal(task)).issue).toBeNull();
}, 15000);

it('persists a FIFO through host restart, removes exact IDs and consumes queued attachments once', async () => {
	const { store, task } = await setup();
	const { client, child } = await launch(store, task);
	const { promptQueue } = await import('@brigadir/core');
	const { Attachments } = await import('@brigadir/persistence');
	const asset = await new Attachments(store).create(task, {
		kind: 'text',
		name: 'Context',
		text: 'Keep this context.',
	});
	await client.command({ kind: 'prompt', text: 'hold' });
	await client.command({ kind: 'prompt', text: 'hold' });
	await client.command({ kind: 'prompt', text: 'remove me' });
	await client.command({ kind: 'prompt', text: 'third', attachmentIds: [asset.id] });
	const queued = promptQueue((await store.journal(task)).records).prompts;
	expect(queued.map((item) => item.command.text)).toEqual(['hold', 'remove me', 'third']);
	expect(queued[2]?.attachments[0]?.id).toBe(asset.id);
	await client.command({ kind: 'removeQueuedPrompt', id: queued[1]!.id });
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	const restarted = await launch(store, task);
	await until(async () =>
		(await restarted.client.snapshot()).records.some(
			(record) =>
				record.event.kind === 'turn.started' && record.event.queuedPromptId === queued[0]!.id
		)
			? true
			: undefined
	);
	expect(
		promptQueue((await restarted.client.snapshot()).records).prompts.map(
			(item) => item.command.text
		)
	).toEqual(['third']);
	await expect(
		restarted.client.command({ kind: 'removeQueuedPrompt', id: queued[0]!.id })
	).rejects.toThrow('no longer queued');
	await restarted.client.command({ kind: 'prompt', text: 'fourth' });
	await restarted.client.command({ kind: 'cancel' });
	await until(async () => {
		const r = (await restarted.client.snapshot()).records;
		return r.filter((record) => record.event.kind === 'turn.completed').length >= 3
			? true
			: undefined;
	});
	const journal = await store.journal(task);
	expect(journal.issue).toBeNull();
	const started = journal.records.flatMap((record) =>
		record.event.kind === 'turn.started' ? [record.event] : []
	);
	expect(started.map((event) => event.text)).toEqual(['hold', 'hold', 'third', 'fourth']);
	expect(
		started.find((event) => event.text === 'third')?.attachments?.map((item) => item.id)
	).toEqual([asset.id]);
	expect(promptQueue(journal.records).prompts).toEqual([]);
}, 20000);
it('pauses queued work after failure, preserves it on restart and resumes only explicitly', async () => {
	const { store, task } = await setup(),
		{ client, child } = await launch(store, task);
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'hold' });
	await client.command({ kind: 'prompt', text: 'fail' });
	await client.command({ kind: 'prompt', text: 'after failure' });
	await client.command({ kind: 'cancel' });
	await event(client, 'session.failed');
	let state = promptQueue((await client.snapshot()).records);
	expect(state.paused).toBe(true);
	expect(state.prompts.map((item) => item.command.text)).toEqual(['after failure']);
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	const restarted = await launch(store, task);
	state = promptQueue((await restarted.client.snapshot()).records);
	expect(state.paused).toBe(true);
	expect(state.prompts).toHaveLength(1);
	await restarted.client.command({ kind: 'resumePromptQueue' });
	await until(async () => {
		const r = (await restarted.client.snapshot()).records;
		return r.some(
			(record) => record.event.kind === 'turn.started' && record.event.text === 'after failure'
		) && r.at(-1)?.event.kind === 'turn.completed'
			? true
			: undefined;
	});
	expect(promptQueue((await restarted.client.snapshot()).records).prompts).toEqual([]);
}, 20000);
it('closes an abruptly interrupted turn and pauses queued work before a replacement host accepts clients', async () => {
	const { store, task } = await setup(),
		{ client, child } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'hold' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'after recovery' });
	child.kill('SIGKILL');
	await until(async () => (child.signalCode ? true : undefined));
	client.close();
	const replacement = await launch(store, task),
		snapshot = await replacement.client.snapshot();
	const { promptQueue } = await import('@brigadir/core');
	expect(snapshot.records.filter((record) => record.event.kind === 'turn.started')).toHaveLength(1);
	expect(
		snapshot.records.findLast((record) =>
			['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(
				record.event.kind
			)
		)?.event
	).toMatchObject({
		kind: 'host.stopped',
		reason: 'The previous host exited during an active turn.',
	});
	expect(promptQueue(snapshot.records)).toMatchObject({
		paused: true,
		prompts: [{ command: { text: 'after recovery' } }],
	});
	expect((await store.task(task)).status).toBe('interrupted');
	await replacement.client.command({ kind: 'resumePromptQueue' });
	await until(async () =>
		(await replacement.client.snapshot()).records.some(
			(record) => record.event.kind === 'turn.completed'
		)
			? true
			: undefined
	);
	expect(
		(await replacement.client.snapshot()).records.filter(
			(record) => record.event.kind === 'turn.started'
		)
	).toHaveLength(2);
}, 20000);

it('holds explicit FIFO on structured rejection, survives host restart and never repeats the rejected turn', async () => {
	const { store, task } = await setup(),
		{ client, child } = await launch(store, task);
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'limit-known' });
	await event(client, 'message.delta');
	await client.command({ kind: 'prompt', text: 'after quota' });
	await client.command({ kind: 'cancel' });
	await event(client, 'session.failed');
	expect((await store.task(task)).status).toBe('rate-limited');
	expect(promptQueue((await client.snapshot()).records)).toMatchObject({
		paused: false,
		prompts: [{ command: { text: 'after quota' } }],
		rateLimits: [{ window: 'five_hour' }],
	});
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	const replacement = await launch(store, task);
	await event(replacement.client, 'rate-limit.expired');
	await event(replacement.client, 'turn.completed');
	const records = (await replacement.client.snapshot()).records;
	expect(records.flatMap((r) => (r.event.kind === 'turn.started' ? [r.event.text] : []))).toEqual([
		'limit-known',
		'after quota',
	]);
	expect(promptQueue(records).prompts).toEqual([]);
	expect((await store.task(task)).rateLimit).toBeNull();
	expect((await store.task(task)).status).toBe('done');
}, 20000);
it('keeps unknown quota until provider clearance, preserves explicit pause and treats warning as nonblocking', async () => {
	const { store, task } = await setup(),
		{ client } = await launch(store, task);
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'limit-unknown' });
	await event(client, 'message.delta');
	await client.command({ kind: 'prompt', text: 'manual pause survives' });
	await client.command({ kind: 'pausePromptQueue' });
	await client.command({ kind: 'cancel' });
	await event(client, 'session.failed');
	expect((await store.task(task)).rateLimit).toEqual({ resetsAt: null });
	await client.command({ kind: 'setMode', modeId: 'manual' });
	await until(async () => ((await store.task(task)).status === 'interrupted' ? true : undefined));
	await delay(100);
	expect(promptQueue((await client.snapshot()).records)).toMatchObject({
		paused: true,
		prompts: [{ command: { text: 'manual pause survives' } }],
		rateLimits: [],
	});
	await client.command({ kind: 'resumePromptQueue' });
	const finished = await event(client, 'turn.completed');
	await client.command({ kind: 'prompt', text: 'limit-warning' });
	await event(client, 'message.delta', finished.seq);
	await client.command({ kind: 'prompt', text: 'after warning' });
	await client.command({ kind: 'cancel' });
	await until(async () =>
		(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed').length === 3
			? true
			: undefined
	);
	expect((await store.task(task)).status).toBe('done');
	expect(promptQueue((await client.snapshot()).records)).toMatchObject({
		paused: false,
		prompts: [],
		rateLimits: [],
	});
	expect((await client.snapshot()).records.some((r) => r.event.kind === 'rate-limit.expired')).toBe(
		false
	);
}, 20000);
it('does not restart a rejected turn without an explicitly queued message', async () => {
	const { store, task } = await setup(),
		{ client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'limit-known' });
	await event(client, 'message.delta');
	await client.command({ kind: 'cancel' });
	await event(client, 'session.failed');
	await event(client, 'rate-limit.expired');
	expect(
		(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.started')
	).toHaveLength(1);
	expect((await store.task(task)).status).toBe('interrupted');
}, 20000);

// spec/composer-steering-queue-and-ghost#steering: the person's message during a GUI turn goes into that turn through `_session/steering`. spec/composer-steering-queue-and-ghost#steering-hold: the host holds it
// first; Claude's window is short here so these tests do not wait 5 s.
process.env.BRIGADIR_STEER_HOLD_MS = '150';
const assistantText = (records: EventRecord[]) =>
	records
		.flatMap((record) =>
			record.event.kind === 'message.delta' &&
			record.event.role === 'assistant' &&
			record.event.content.kind === 'text'
				? [record.event.content.text]
				: []
		)
		.join('');
it('steers a message into the running turn: one turn, no queue, the message in the log where it was sent (spec/composer-steering-queue-and-ghost#steering)', async () => {
	const { store, task } = await setup(),
		{ client } = await launch(store, task, 'steering');
	const { promptQueue, activityRows } = await import('@brigadir/core');
	expect(
		(await client.snapshot()).records.findLast((record) => record.event.kind === 'session.started')
			?.event
	).toMatchObject({ steering: true });
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'make it faster', steer: true });
	const done = await event(client, 'turn.completed');
	const records = (await client.snapshot()).records;
	expect(records.filter((record) => record.event.kind === 'turn.started')).toHaveLength(1);
	expect(records.find((record) => record.event.kind === 'prompt.steered')?.event).toMatchObject({
		prompt: { command: { kind: 'prompt', text: 'make it faster' } },
	});
	expect(records.some((record) => record.event.kind === 'prompt.queued')).toBe(false);
	expect(promptQueue(records).prompts).toEqual([]);
	expect(assistantText(records)).toBe('heard: make it faster');
	expect(done.event).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	expect(
		activityRows(records).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['steer-wait', 'make it faster']);
	expect((await store.task(task)).status).toBe('done');
}, 20000);
it('queues a steered message the agent declined and runs it as the next turn, shown once (spec/composer-steering-queue-and-ghost#steering)', async () => {
	const { store, task } = await setup(),
		{ client } = await launch(store, task, 'steering-late');
	const { promptQueue, activityRows } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'after the turn', steer: true });
	const queued = await event(client, 'prompt.queued');
	const steered = (await client.snapshot()).records.find(
		(record) => record.event.kind === 'prompt.steered'
	);
	expect(
		steered &&
			steered.event.kind === 'prompt.steered' &&
			queued.event.kind === 'prompt.queued' &&
			steered.event.prompt.id === queued.event.prompt.id
	).toBe(true);
	expect(
		promptQueue((await client.snapshot()).records).prompts.map((item) => item.command.text)
	).toEqual(['after the turn']);
	await client.command({ kind: 'cancel' });
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
			.length === 2
			? true
			: undefined
	);
	const records = (await client.snapshot()).records;
	expect(
		records
			.filter((record) => record.event.kind === 'turn.started')
			.map((record) => record.event.kind === 'turn.started' && record.event.text)
	).toEqual(['steer-wait', 'after the turn']);
	expect(
		activityRows(records).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['steer-wait', 'after the turn']);
}, 20000);
it('adopts the turn a codex-shaped adapter starts from a late steer and ends it on threadStatus idle (spec/composer-steering-queue-and-ghost#steering)', async () => {
	const { root, store, task } = await setup(),
		gate = join(root, 'adopted-output'),
		saved = process.env.BRIGADIR_FIXTURE_ADOPTED_GATE;
	process.env.BRIGADIR_FIXTURE_ADOPTED_GATE = gate;
	cleanup.push(async () => {
		if (saved === undefined) delete process.env.BRIGADIR_FIXTURE_ADOPTED_GATE;
		else process.env.BRIGADIR_FIXTURE_ADOPTED_GATE = saved;
	});
	const { client } = await launch(store, task, 'steering-codex');
	const { promptQueue, activityRows } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'one more thing', steer: true });
	// The adopted turn's output is a fixture timer in real time; hold it until the host journaled that turn, so a slow machine cannot reorder them.
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.started')
			.length === 2
			? true
			: undefined
	);
	await writeFile(gate, '');
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
			.length === 2
			? true
			: undefined
	);
	const records = (await client.snapshot()).records,
		started = records.flatMap((record) =>
			record.event.kind === 'turn.started' ? [record.event] : []
		);
	expect(started.map((item) => item.text)).toEqual(['steer-wait', 'one more thing']);
	const steered = records.find((record) => record.event.kind === 'prompt.steered');
	expect(
		steered?.event.kind === 'prompt.steered' &&
			started[1]?.queuedPromptId === steered.event.prompt.id
	).toBe(true);
	// The adopted turn's own output lands after its turn.started, and the host is free again afterwards.
	const second = records.findIndex(
			(record) => record.event.kind === 'turn.started' && record.event.text === 'one more thing'
		),
		adopted = records.findIndex(
			(record) =>
				record.event.kind === 'message.delta' &&
				record.event.content.kind === 'text' &&
				record.event.content.text.startsWith('adopted:')
		);
	expect(adopted).toBeGreaterThan(second);
	expect(records.at(-1)?.event).toEqual({ kind: 'turn.completed', reason: 'end_turn' });
	expect(
		activityRows(records).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['steer-wait', 'one more thing']);
	expect(promptQueue(records).prompts).toEqual([]);
	expect((await client.status()).busy).toBe(false);
	await client.command({ kind: 'prompt', text: 'plain' });
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
			.length === 3
			? true
			: undefined
	);
}, 20000);
it('keeps crew reports and reviews in the FIFO while steering is available (spec/composer-steering-queue-and-ghost#steering)', async () => {
	const { store, task } = await setup(),
		{ client } = await launch(store, task, 'steering');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({
		kind: 'submitReview',
		text: 'Review text',
		review: {
			id: 'b'.repeat(64),
			comments: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1 }],
		},
	});
	await client.command({ kind: 'prompt', text: 'behind the review', steer: true });
	const records = (await client.snapshot()).records;
	expect(records.some((record) => record.event.kind === 'prompt.steered')).toBe(false);
	expect(
		promptQueue(records).prompts.map((item) =>
			item.command.kind === 'prompt' ? item.command.text : 'review'
		)
	).toEqual(['review', 'behind the review']);
	await client.command({ kind: 'cancel' });
}, 20000);
it('steers only what the composer marks: app and crew prompts keep the FIFO (spec/composer-steering-queue-and-ghost#steering)', async () => {
	const { store, task } = await setup(),
		{ client } = await launch(store, task, 'steering');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'from the foreman' });
	const records = (await client.snapshot()).records;
	expect(records.some((record) => record.event.kind === 'prompt.steered')).toBe(false);
	expect(
		promptQueue(records).prompts.map((item) => item.command.kind === 'prompt' && item.command.text)
	).toEqual(['from the foreman']);
	await client.command({ kind: 'cancel' });
}, 20000);
it('declines a second steer while an adopted turn runs and queues it for the next turn (spec/composer-steering-queue-and-ghost#steering)', async () => {
	process.env.BRIGADIR_FIXTURE_ADOPTED_MS = '1200';
	cleanup.push(async () => {
		delete process.env.BRIGADIR_FIXTURE_ADOPTED_MS;
	});
	const { store, task } = await setup(),
		{ client } = await launch(store, task, 'steering-codex');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'first', steer: true });
	await until(async () =>
		(await client.snapshot()).records.some(
			(record) => record.event.kind === 'turn.started' && record.event.text === 'first'
		)
			? true
			: undefined
	);
	await client.command({ kind: 'prompt', text: 'second', steer: true });
	await until(async () =>
		promptQueue((await client.snapshot()).records).prompts.some(
			(item) => item.command.kind === 'prompt' && item.command.text === 'second'
		)
			? true
			: undefined
	);
	await until(
		async () =>
			(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
				.length === 3
				? true
				: undefined,
		15000
	);
	const records = (await client.snapshot()).records;
	expect(
		records.flatMap((record) => (record.event.kind === 'turn.started' ? [record.event.text] : []))
	).toEqual(['steer-wait', 'first', 'second']);
	// The adopted turn closed on its own idle, not on the old turn's flags: its output lies inside it.
	const second = records.findIndex(
			(record) => record.event.kind === 'turn.started' && record.event.text === 'first'
		),
		closed = records.findIndex(
			(record, index) => index > second && record.event.kind === 'turn.completed'
		),
		output = records.findIndex(
			(record) =>
				record.event.kind === 'message.delta' &&
				record.event.content.kind === 'text' &&
				record.event.content.text === 'adopted: first'
		);
	expect(output).toBeGreaterThan(second);
	expect(output).toBeLessThan(closed);
	expect((await client.status()).busy).toBe(false);
}, 30000);
it('closes an adopted turn that ended before the steer was answered (spec/composer-steering-queue-and-ghost#steering)', async () => {
	process.env.BRIGADIR_FIXTURE_ADOPTED_FAST = '1';
	cleanup.push(async () => {
		delete process.env.BRIGADIR_FIXTURE_ADOPTED_FAST;
	});
	const { store, task } = await setup(),
		{ client } = await launch(store, task, 'steering-codex');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'quick', steer: true });
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
			.length === 2
			? true
			: undefined
	);
	expect(
		(await client.snapshot()).records.flatMap((record) =>
			record.event.kind === 'turn.started' ? [record.event.text] : []
		)
	).toEqual(['steer-wait', 'quick']);
	await until(async () => ((await client.status()).busy ? undefined : true));
	await client.command({ kind: 'prompt', text: 'plain' });
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
			.length === 3
			? true
			: undefined
	);
}, 20000);

// spec/composer-steering-queue-and-ghost#steering-hold: the host holds the message until the step boundary.
const seqOf = (records: EventRecord[], test: (record: EventRecord) => boolean) =>
	records.find(test)?.seq ?? -1;
it('holds a message until the top-level tool finishes, not a subagent tool, and then steers it (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { activityRows } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'tool-steer' });
	await until(async () =>
		(await client.snapshot()).records.some(
			(record) => record.event.kind === 'tool.changed' && record.event.patch.id === 'child'
		)
			? true
			: undefined
	);
	await client.command({ kind: 'prompt', text: 'use the other file', steer: true });
	const held = await event(client, 'prompt.held');
	expect(
		(await client.snapshot()).records.some((record) => record.event.kind === 'prompt.steered')
	).toBe(false);
	expect(
		activityRows((await client.snapshot()).records).find(
			(row) => row.kind === 'message' && row.text === 'use the other file'
		)
	).toMatchObject({ waiting: true });
	await event(client, 'turn.completed');
	const records = (await client.snapshot()).records;
	const child = seqOf(
			records,
			(record) =>
				record.event.kind === 'tool.changed' &&
				record.event.patch.id === 'child' &&
				record.event.patch.status === 'completed'
		),
		top = seqOf(
			records,
			(record) =>
				record.event.kind === 'tool.changed' &&
				record.event.patch.id === 'top' &&
				record.event.patch.status === 'completed'
		),
		steered = seqOf(records, (record) => record.event.kind === 'prompt.steered');
	expect(held.seq).toBeLessThan(steered);
	expect(steered).toBeGreaterThan(top);
	expect(top).toBeGreaterThan(child);
	expect(assistantText(records)).toBe('heard: use the other file');
	const rows = activityRows(records).filter((row) => row.kind === 'message' && row.role === 'user');
	expect(rows.map((row) => row.kind === 'message' && row.text)).toEqual([
		'tool-steer',
		'use the other file',
	]);
	expect(rows[1]).not.toHaveProperty('waiting');
}, 20000);
it("steers a held message when Claude's window ends with no boundary (spec/composer-steering-queue-and-ghost#steering-hold)", async () => {
	process.env.BRIGADIR_STEER_HOLD_MS = '600';
	cleanup.push(async () => {
		process.env.BRIGADIR_STEER_HOLD_MS = '150';
	});
	const { store, task } = await setup('claude'),
		{ client } = await launch(store, task, 'steering');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'in the window', steer: true });
	await event(client, 'turn.completed');
	const records = (await client.snapshot()).records,
		held = records.find((record) => record.event.kind === 'prompt.held')!,
		steered = records.find((record) => record.event.kind === 'prompt.steered')!;
	expect(Date.parse(steered.at) - Date.parse(held.at)).toBeGreaterThanOrEqual(550);
	expect(assistantText(records)).toBe('heard: in the window');
}, 20000);
it('removes a held message before the boundary and refuses to remove a sent one (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { activityRows, promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'tool-steer' });
	await event(client, 'tool.changed');
	await client.command({ kind: 'prompt', text: 'never mind', steer: true });
	const held = await event(client, 'prompt.held');
	await client.command({
		kind: 'removeQueuedPrompt',
		id: held.event.kind === 'prompt.held' ? held.event.prompt.id : '',
	});
	await event(client, 'turn.completed');
	const records = (await client.snapshot()).records;
	expect(records.some((record) => record.event.kind === 'prompt.steered')).toBe(false);
	expect(assistantText(records)).toBe('no steer');
	expect(
		activityRows(records).some((row) => row.kind === 'message' && row.text === 'never mind')
	).toBe(false);
	expect(promptQueue(records).held).toEqual([]);
	// After the boundary the message is the agent's: it cannot be taken back.
	await client.command({ kind: 'prompt', text: 'tool-steer' });
	const second = (await client.snapshot()).records.at(-1)!.seq;
	await event(client, 'tool.changed', second);
	await client.command({ kind: 'prompt', text: 'keep this', steer: true });
	const kept = await event(client, 'prompt.held', second);
	await event(client, 'prompt.steered', second);
	await expect(
		client.command({
			kind: 'removeQueuedPrompt',
			id: kept.event.kind === 'prompt.held' ? kept.event.prompt.id : '',
		})
	).rejects.toThrow('no longer queued');
}, 20000);
it('turns held messages into the next turns, in order, when the turn ends first (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { activityRows } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'first held', steer: true });
	await client.command({ kind: 'prompt', text: 'second held', steer: true });
	await client.command({ kind: 'cancel' });
	await until(async () =>
		(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
			.length === 3
			? true
			: undefined
	);
	const records = (await client.snapshot()).records;
	expect(
		records.flatMap((record) => (record.event.kind === 'turn.started' ? [record.event.text] : []))
	).toEqual(['steer-wait', 'first held', 'second held']);
	expect(records.some((record) => record.event.kind === 'prompt.steered')).toBe(false);
	expect(
		activityRows(records).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['steer-wait', 'first held', 'second held']);
}, 20000);
it('moves messages the dead host held into the paused FIFO on restart (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client, child } = await launch(store, task, 'steering');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'survive the crash', steer: true });
	await event(client, 'prompt.held');
	child.kill('SIGKILL');
	await until(async () => (child.signalCode ? true : undefined));
	client.close();
	const replacement = await launch(store, task, 'steering'),
		records = (await replacement.client.snapshot()).records;
	expect(promptQueue(records)).toMatchObject({
		paused: true,
		held: [],
		prompts: [{ command: { text: 'survive the crash' } }],
	});
}, 20000);
it('sends a queued message now: it leaves the FIFO, is held and goes at the boundary (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { activityRows, promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'tool-steer' });
	await event(client, 'tool.changed');
	await client.command({ kind: 'prompt', text: 'from the deck' });
	const queued = await event(client, 'prompt.queued');
	const id = queued.event.kind === 'prompt.queued' ? queued.event.prompt.id : '';
	await client.command({ kind: 'steerQueuedPrompt', id });
	expect(promptQueue((await client.snapshot()).records)).toMatchObject({
		prompts: [],
		held: [{ id }],
	});
	await event(client, 'turn.completed');
	const records = (await client.snapshot()).records;
	expect(assistantText(records)).toBe('heard: from the deck');
	expect(records.filter((record) => record.event.kind === 'turn.started')).toHaveLength(1);
	expect(
		activityRows(records).flatMap((row) =>
			row.kind === 'message' && row.role === 'user' ? [row.text] : []
		)
	).toEqual(['tool-steer', 'from the deck']);
	await expect(client.command({ kind: 'steerQueuedPrompt', id })).rejects.toThrow(
		'no longer queued'
	);
}, 20000);
it('puts a held message in front of what was queued after it when the turn ends (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'held first', steer: true });
	await event(client, 'prompt.held');
	await client.command({
		kind: 'submitReview',
		text: 'Review text',
		review: {
			id: 'c'.repeat(64),
			comments: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', version: 1 }],
		},
	});
	await client.command({ kind: 'prompt', text: 'sent later', steer: true });
	expect(
		promptQueue((await client.snapshot()).records).prompts.map((item) =>
			item.command.kind === 'prompt' ? item.command.text : 'review'
		)
	).toEqual(['review', 'sent later']);
	await client.command({ kind: 'cancel' });
	await until(
		async () =>
			(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
				.length === 4
				? true
				: undefined,
		15000
	);
	expect(
		(await client.snapshot()).records.flatMap((record) =>
			record.event.kind === 'turn.started' ? [record.event.text] : []
		)
	).toEqual(['steer-wait', 'held first', 'Review text', 'sent later']);
}, 30000);
it('keeps a queued message sent now in its place when it goes back to the FIFO (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'queued A' });
	await client.command({ kind: 'prompt', text: 'queued B' });
	const a = promptQueue((await client.snapshot()).records).prompts[0]!;
	await client.command({ kind: 'steerQueuedPrompt', id: a.id });
	await client.command({ kind: 'cancel' });
	await until(
		async () =>
			(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
				.length === 3
				? true
				: undefined,
		15000
	);
	expect(
		(await client.snapshot()).records.flatMap((record) =>
			record.event.kind === 'turn.started' ? [record.event.text] : []
		)
	).toEqual(['steer-wait', 'queued A', 'queued B']);
}, 30000);
it('lets a message sent now go into the turn although a message held in an earlier turn still waits in the FIFO (spec/composer-steering-queue-and-ghost#steering-hold)', async () => {
	const { store, task } = await setup('codex'),
		{ client } = await launch(store, task, 'steering');
	const { promptQueue } = await import('@brigadir/core');
	await client.command({ kind: 'prompt', text: 'steer-wait' });
	await event(client, 'turn.started');
	await client.command({ kind: 'prompt', text: 'tool-steer' });
	await client.command({ kind: 'prompt', text: 'held before' });
	const before = promptQueue((await client.snapshot()).records).prompts[1]!;
	await client.command({ kind: 'steerQueuedPrompt', id: before.id });
	await client.command({ kind: 'cancel' });
	// FIFO is now [tool-steer, held before]; tool-steer runs with «held before» still queued behind it.
	await until(async () =>
		(await client.snapshot()).records.some(
			(record) => record.event.kind === 'turn.started' && record.event.text === 'tool-steer'
		)
			? true
			: undefined
	);
	await client.command({ kind: 'prompt', text: 'now please' });
	const c = promptQueue((await client.snapshot()).records).prompts.find(
		(item) => item.command.kind === 'prompt' && item.command.text === 'now please'
	)!;
	await client.command({ kind: 'steerQueuedPrompt', id: c.id });
	await until(
		async () =>
			(await client.snapshot()).records.filter((record) => record.event.kind === 'turn.completed')
				.length >= 2
				? true
				: undefined,
		15000
	);
	expect(assistantText((await client.snapshot()).records)).toContain('heard: now please');
}, 30000);
// spec/agents-and-providers#sign-in-recovery: a sign-in failure is retried on a fresh adapter process with the same prompt; `auth` ignores other failures.
it('retries a turn that failed on the sign-in on a fresh adapter process', async () => {
	const { root, store, task } = await setup();
	const signed = join(root, 'signed-in'),
		log = join(root, 'fixture.jsonl');
	const saved = {
		auth: process.env.BRIGADIR_TEST_AUTH_FILE,
		log: process.env.BRIGADIR_FIXTURE_LOG,
	};
	process.env.BRIGADIR_TEST_AUTH_FILE = signed;
	process.env.BRIGADIR_FIXTURE_LOG = log;
	cleanup.push(async () => {
		for (const [key, value] of [
			['BRIGADIR_TEST_AUTH_FILE', saved.auth],
			['BRIGADIR_FIXTURE_LOG', saved.log],
		] as const)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	});
	const { client } = await launch(store, task);
	const processes = async () =>
		(await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.filter((line) => JSON.parse(line).event === 'process').length;
	await client.command({ kind: 'prompt', text: 'auth one' });
	const failed = await event(client, 'session.failed');
	expect(failed.event).toMatchObject({ message: 'Authentication required', reason: 'auth' });
	expect((await store.task(task)).failure).toBe('auth');
	expect((await store.task(task)).status).toBe('failed');
	expect(await processes()).toBe(1);
	// Still signed out: the retry runs on a new process and fails the same way.
	await client.command({ kind: 'retryTurn', reason: 'auth' });
	const again = await event(client, 'session.failed', failed.seq);
	expect(again.event).toMatchObject({ reason: 'auth' });
	expect(await processes()).toBe(2);
	await writeFile(signed, '');
	await client.command({ kind: 'retryTurn' });
	const done = await event(client, 'turn.completed', again.seq);
	const records = (await client.snapshot()).records;
	expect(
		records
			.filter((record) => record.seq > again.seq && record.event.kind === 'turn.started')
			.map((record) => record.event.kind === 'turn.started' && record.event.text)
	).toEqual(['auth one']);
	expect(
		records.some(
			(record) =>
				record.seq < done.seq &&
				record.event.kind === 'message.delta' &&
				record.event.content.kind === 'text' &&
				record.event.content.text === 'Signed in: auth one'
		)
	).toBe(true);
	expect(await processes()).toBe(3);
	await until(async () => ((await store.task(task)).failure === null ? true : undefined));
	// Another failure: a retry after a sign-in leaves it alone; a plain retry with no failure is an error.
	await client.command({ kind: 'prompt', text: 'fail' });
	const plain = await event(client, 'session.failed', done.seq);
	await client.command({ kind: 'retryTurn', reason: 'auth' });
	await delay(300);
	expect(
		(await client.snapshot()).records.filter(
			(record) => record.seq > plain.seq && record.event.kind === 'turn.started'
		)
	).toEqual([]);
	expect(await processes()).toBe(3);
});
it('asks the window for editor_state and pr_state and answers a closed window without an error (spec/agents-and-providers#context-tools)', async () => {
	const { store, task } = await setup();
	const { identity } = await launch(store, task);
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	const asked: unknown[] = [];
	const ui = await connectHost(
		identity,
		undefined,
		undefined,
		undefined,
		async (method, params) => {
			asked.push([method, params]);
			return {
				window: 'open',
				tabs: [{ kind: 'file', path: 'src/a.ts', active: true, unsaved: false }],
			};
		}
	);
	expect(await mcp.request('editor_state', {})).toEqual({
		window: 'open',
		tabs: [{ kind: 'file', path: 'src/a.ts', active: true, unsaved: false }],
	});
	await mcp.request('pr_state', {});
	expect(asked).toEqual([
		['context', { tool: 'editor' }],
		['context', { tool: 'pr' }],
	]);
	ui.close();
	await until(async () => {
		const value = (await mcp.request('editor_state', {})) as { window?: string };
		return value.window === 'closed' ? value : undefined;
	});
	expect(await mcp.request('pr_state', {})).toMatchObject({ window: 'closed', open: false });
	expect(asked).toHaveLength(2);
});

it('asks the app to restart the language servers and words its answer for the agent (spec/editor-code-intelligence#language-server-restart)', async () => {
	const { store, task } = await setup();
	const { identity } = await launch(store, task);
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	const answers = [
		{ off: false, restarted: ['TypeScript'] },
		{ off: false, restarted: [] },
		{ off: true, restarted: [] },
	];
	const asked: unknown[] = [];
	await connectHost(identity, undefined, undefined, undefined, async (method, params) => {
		asked.push([method, params]);
		return answers.shift();
	});
	expect(await mcp.request('editor_restart_language_servers', {})).toEqual({
		restarted: ['TypeScript'],
	});
	expect(await mcp.request('editor_restart_language_servers', {})).toMatchObject({
		restarted: [],
		note: expect.stringContaining('No language server runs'),
	});
	expect(await mcp.request('editor_restart_language_servers', {})).toMatchObject({
		restarted: [],
		note: expect.stringContaining('off in Settings'),
	});
	expect(asked).toEqual([
		['code_restart', {}],
		['code_restart', {}],
		['code_restart', {}],
	]);
});

// spec/chat-turns-plans-and-questions#plan-approval: `Погодити` with `returnMode` sets the mode back once the agent leaves the plan, and only then.
it('returns the mode from before the plan after the agent leaves it, and ignores a mode outside the catalog', async () => {
	const { store, task } = await setup();
	const { client } = await launch(store, task, 'plan-modes');
	const records = async () => (await client.snapshot()).records;
	const modes = async (after: number) =>
		(await records()).flatMap((r) =>
			r.seq > after && r.event.kind === 'mode.changed' ? [r.event.modeId] : []
		);
	await client.command({ kind: 'prompt', text: 'plan accept-edits' });
	const requested = await event(client, 'permission.requested');
	if (requested.event.kind !== 'permission.requested') throw new Error('No plan');
	await client.command({
		kind: 'answerPermission',
		id: requested.event.request.id,
		optionId: 'exit-plan-default',
		returnMode: 'acceptEdits',
	});
	const done = await event(client, 'turn.completed');
	expect(await modes(0)).toEqual(['acceptEdits', 'plan', 'default', 'acceptEdits']);
	expect(
		(await records()).find((r) => r.event.kind === 'permission.resolved')?.event
	).toMatchObject({ optionId: 'exit-plan-default', returnMode: 'acceptEdits' });
	await client.command({ kind: 'prompt', text: 'plan' });
	const again = await event(client, 'permission.requested', done.seq);
	if (again.event.kind !== 'permission.requested') throw new Error('No plan');
	await client.command({
		kind: 'answerPermission',
		id: again.event.request.id,
		optionId: 'exit-plan-default',
		returnMode: 'invented',
	});
	await event(client, 'turn.completed', done.seq);
	expect(await modes(done.seq)).toEqual(['plan', 'default']);
	expect(
		(await records()).findLast((r) => r.event.kind === 'permission.resolved')?.event
	).not.toHaveProperty('returnMode');
});

// spec/chat-turns-plans-and-questions#plan-chat: Enter while a plan waits rejects the plan and the message runs as the next turn, wrapped for the agent.
it('answers a waiting plan with the message sent from the composer', async () => {
	const { store, task } = await setup();
	const { client } = await launch(store, task, 'plan-modes');
	await client.command({ kind: 'prompt', text: 'plan' });
	const requested = await event(client, 'permission.requested');
	await client.command({ kind: 'prompt', text: 'Why two phases?', steer: true });
	const resolved = await event(client, 'permission.resolved', requested.seq);
	expect(resolved.event).toMatchObject({ optionId: 'reject' });
	const next = await event(client, 'turn.started', resolved.seq);
	expect(next.event).toMatchObject({ text: planChatPrompt('Why two phases?') });
	expect((await client.snapshot()).records.some((r) => r.event.kind === 'prompt.held')).toBe(false);
});

// spec/tasks#agent-created-tasks: `create_task` waits on its card; main answers with the created task, `Відхилити` and Stop with null.
it('keeps create_task waiting for the card, checks the folders and answers with the created task or a decline', async () => {
	const { root, store, task } = await setup();
	const { client, identity } = await launch(store, task);
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	await expect(
		mcp.request('create_task', { prompt: 'Idle', context: [], folders: [], start: 'now' })
	).rejects.toThrow('No turn is active');
	await client.command({ kind: 'prompt', text: 'permission' });
	await event(client, 'permission.requested');
	const outside = join(root, 'backend');
	await mkdir(outside);
	await expect(
		mcp.request('create_task', {
			prompt: 'Inside',
			context: [],
			folders: [join(root, 'repo')],
			start: 'now',
		})
	).rejects.toThrow('is inside the project');
	await expect(
		mcp.request('create_task', {
			prompt: 'Gone',
			context: [],
			folders: [join(root, 'nope')],
			start: 'now',
		})
	).rejects.toThrow('does not exist');
	await expect(
		mcp.request('create_task', {
			prompt: 'No file',
			context: [{ kind: 'file', path: join(root, 'missing.md') }],
			folders: [],
			start: 'now',
		})
	).rejects.toThrow('does not exist');
	const created = mcp.request('create_task', {
		title: 'Backend API',
		prompt: 'Add the endpoint',
		context: [{ kind: 'summary' }, { kind: 'text', name: 'Notes', text: 'Use v2' }],
		folders: [outside],
		start: 'backlog',
	});
	const requested = await event(client, 'task.proposal.requested');
	if (requested.event.kind !== 'task.proposal.requested') throw new Error('No proposal');
	expect(requested.event.proposal).toMatchObject({
		title: 'Backend API',
		prompt: 'Add the endpoint',
		folders: [await realpath(outside)],
		start: 'backlog',
	});
	expect((await store.task(task)).status).toBe('needs-you');
	expect(pendingInputs((await client.snapshot()).records).proposals.map((item) => item.id)).toEqual(
		[requested.event.proposal.id]
	);
	await client.command({
		kind: 'resolveTaskProposal',
		id: requested.event.proposal.id,
		task: {
			projectId: task.projectId,
			id: '00000000-0000-4000-8000-000000000001',
			title: 'Backend API',
		},
	});
	expect(await created).toEqual({
		created: true,
		task: { id: '00000000-0000-4000-8000-000000000001', title: 'Backend API' },
		start: 'backlog',
	});
	await expect(
		client.command({ kind: 'resolveTaskProposal', id: requested.event.proposal.id, task: null })
	).rejects.toThrow('already resolved');
	const declined = mcp.request('create_task', {
		prompt: 'Second',
		context: [],
		folders: [],
		start: 'now',
	});
	const second = await event(client, 'task.proposal.requested', requested.seq);
	if (second.event.kind !== 'task.proposal.requested') throw new Error('No proposal');
	await client.command({ kind: 'resolveTaskProposal', id: second.event.proposal.id, task: null });
	expect(await declined).toMatchObject({ created: false });
	// Stop answers a waiting card with null, like a question.
	const stopped = mcp
		.request('create_task', { prompt: 'Third', context: [], folders: [], start: 'now' })
		.catch((error) => error);
	const third = await event(client, 'task.proposal.requested', second.seq);
	if (third.event.kind !== 'task.proposal.requested') throw new Error('No proposal');
	const thirdId = third.event.proposal.id;
	await client.command({ kind: 'cancel' });
	await until(async () =>
		(await client.snapshot()).records.find(
			(r) =>
				r.event.kind === 'task.proposal.resolved' && r.event.id === thirdId && r.event.task === null
		)
	);
	expect(await stopped).toMatchObject({ created: false });
});

// spec/tasks#agent-created-tasks: the agent `create_task` names is resolved by main before the card shows; an unknown one fails the call.
it('asks main for the agent create_task names and keeps the answer on the proposal', async () => {
	const { store, task } = await setup();
	const { identity } = await launch(store, task);
	const asked: unknown[] = [],
		agent = {
			provider: 'codex',
			options: [{ id: 'model', value: 'gpt-6-astra' }],
			modelName: '6 Astra',
			effortName: null,
		};
	const client = await connectHost(
		identity,
		undefined,
		undefined,
		undefined,
		async (method, params) => {
			if (method !== 'task_agent') throw new Error(`Unexpected ${method}`);
			asked.push(params);
			if ((params as { model?: string }).model === 'nope')
				throw new Error('Codex has no model «nope»');
			return agent;
		}
	);
	cleanup.push(async () => client.close());
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	await client.command({ kind: 'prompt', text: 'permission' });
	await event(client, 'permission.requested');
	const base = { prompt: 'Review the PR', context: [], folders: [], start: 'now' };
	await expect(
		mcp.request('create_task', { ...base, agent: { provider: 'codex', model: 'nope' } })
	).rejects.toThrow('no model «nope»');
	await expect(
		mcp.request('create_task', { ...base, agent: { provider: 'gemini' } })
	).rejects.toThrow('Invalid agent');
	const created = mcp.request('create_task', {
		...base,
		agent: { provider: 'codex', model: 'gpt-6-astra' },
	});
	const requested = await event(client, 'task.proposal.requested');
	if (requested.event.kind !== 'task.proposal.requested') throw new Error('No proposal');
	expect(requested.event.proposal.agent).toEqual(agent);
	expect(asked).toEqual([
		{ provider: 'codex', model: 'nope' },
		{ provider: 'codex', model: 'gpt-6-astra' },
	]);
	await client.command({
		kind: 'resolveTaskProposal',
		id: requested.event.proposal.id,
		task: null,
	});
	expect(await created).toMatchObject({ created: false });
});

// spec/projects-and-board#folders-mid-task: a folder joins a running task — read-only at once, a git repo after the person allows it; the roots follow on the next turn.
it('adds a folder to a running task through add_folder and reconnects the adapter with it before the next turn', async () => {
	const { root, store, task } = await setup();
	const log = join(root, 'fixture.jsonl');
	const saved = process.env.BRIGADIR_FIXTURE_LOG;
	process.env.BRIGADIR_FIXTURE_LOG = log;
	cleanup.push(async () => {
		if (saved === undefined) delete process.env.BRIGADIR_FIXTURE_LOG;
		else process.env.BRIGADIR_FIXTURE_LOG = saved;
	});
	const docs = join(root, 'docs'),
		backend = join(root, 'backend');
	await mkdir(docs);
	await mkdir(backend);
	await promisify(execFile)('git', ['init', '-q'], { cwd: backend });
	const { identity } = await launch(store, task, 'directories');
	const choice = async (path: string) => {
		const canonical = await realpath(path);
		return {
			id: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
			name: canonical.split('/').at(-1)!,
			kind: canonical.endsWith('backend') ? 'external' : 'folder',
			selected: true,
			path: canonical,
		};
	};
	// The app's own connection answers `folder` (it registers the folder in the project); a second ui peer would replace it.
	const client = await connectHost(
		identity,
		undefined,
		undefined,
		undefined,
		async (method, params) => {
			if (method !== 'folder') throw new Error(`Unexpected ${method}`);
			return choice((params as { path: string }).path);
		}
	);
	cleanup.push(async () => client.close());
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	await client.command({ kind: 'prompt', text: 'permission' });
	const held = await event(client, 'permission.requested');
	await expect(mcp.request('add_folder', { path: join(root, 'repo') })).rejects.toThrow(
		'is inside the project'
	);
	await expect(mcp.request('add_folder', { path: join(root, 'nope') })).rejects.toThrow(
		'does not exist'
	);
	// spec/agents-and-providers#tool-permissions: both ask the person with the host's card; the agent's own permission card does not stand before our tools.
	const allow = async (path: string, title: string, after: number) => {
		const added = mcp.request('add_folder', { path });
		const asked = await until(async () =>
			(await client.snapshot()).records.find(
				(r) => r.seq > after && r.event.kind === 'permission.requested'
			)
		);
		if (asked.event.kind !== 'permission.requested') throw new Error('No permission');
		expect(asked.event.request.tool.title).toBe(title);
		await client.command({ kind: 'answerPermission', id: asked.event.request.id, optionId: 'add' });
		return { result: await added, seq: asked.seq };
	};
	const read = await allow(docs, 'Add docs to the task · read only', held.seq);
	expect(read.result).toMatchObject({ added: true, name: 'docs', writable: false });
	const repo = await allow(backend, 'Add backend to the task', read.seq);
	expect(repo.result).toMatchObject({ added: true, name: 'backend', writable: true });
	const scopes = (await store.task(task))
		.launch!.scopes.filter((scope) => scope.path)
		.map((scope) => [scope.kind, scope.selected]);
	expect(scopes).toEqual([
		['folder', true],
		['external', true],
	]);
	expect(await mcp.request('add_folder', { path: docs })).toMatchObject({
		added: false,
		reason: 'The folder is already in the task.',
	});
	// The turn ends; the next prompt reconnects the adapter with the folders among its roots.
	if (held.event.kind !== 'permission.requested') throw new Error('No permission');
	await client.command({
		kind: 'answerPermission',
		id: held.event.request.id,
		optionId: held.event.request.options[0]!.id,
	});
	const done = await event(client, 'turn.completed', held.seq);
	await client.command({ kind: 'prompt', text: 'hello' });
	await event(client, 'turn.completed', done.seq);
	const loads = (await readFile(log, 'utf8'))
		.trim()
		.split('\n')
		.map(
			(line) => JSON.parse(line) as { event: string; params: { additionalDirectories?: string[] } }
		)
		.filter((entry) => entry.event === 'load');
	expect(loads.at(-1)?.params.additionalDirectories).toEqual(
		expect.arrayContaining([await realpath(docs), await realpath(backend)])
	);
}, 30000);

// spec/tasks#agent-worktrees: a worktree the agent makes with its own shell tool joins the task as another checkout of the root;
// one that existed before the host started does not.
it('adopts a worktree the agent created itself and marks it as the root checkout', async () => {
	const { root, store, task } = await setup();
	const repo = join(root, 'repo'),
		run = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await run('init', '-q', '-b', 'main');
	await run('config', 'user.name', 'F');
	await run('config', 'user.email', 'f@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'base\n');
	await run('add', '-A');
	await run('commit', '-qm', 'base');
	await run('worktree', 'add', '-q', '-b', 'old', join(root, 'old'));
	const { identity } = await launch(store, task);
	const asked: string[] = [];
	const client = await connectHost(
		identity,
		undefined,
		undefined,
		undefined,
		async (method, params) => {
			if (method !== 'folder') throw new Error(`Unexpected ${method}`);
			const canonical = await realpath((params as { path: string }).path);
			asked.push(canonical);
			return {
				id: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
				name: canonical.split('/').at(-1)!,
				kind: 'external',
				selected: true,
				path: canonical,
			};
		}
	);
	cleanup.push(async () => client.close());
	const outside = join(await realpath(root), 'repo-validation');
	await client.command({ kind: 'prompt', text: `worktree-add feature ${outside}` });
	await event(client, 'turn.completed');
	const adopted = await until(async () =>
		(await store.task(task)).launch?.scopes.find((scope) => scope.path === outside)
	);
	const rootId = (await store.task(task)).launch?.scopes.find((scope) => scope.kind === 'root')?.id;
	expect(adopted).toMatchObject({ kind: 'external', selected: true, worktreeOf: rootId });
	expect(rootId).toBeDefined();
	expect(asked).toEqual([outside]);
	await until(async () =>
		(await client.snapshot()).records.some((record) => record.event.kind === 'scopes.changed')
	);
}, 30000);

// spec/search-menus-and-commands#agent-command-tools: the agent reads the saved commands, runs one in the console of the task and stops it; a command without
// `agentRuns` asks the person once per task, and `Always allow agents` marks it in project.json.
it('runs the project commands for the agent through commands_*, asking for a command without agentRuns', async () => {
	const { root, store, task } = await setup();
	const saved = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR, SHELL: process.env.SHELL };
	Object.assign(process.env, { HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh' });
	cleanup.push(async () => {
		for (const [name, value] of Object.entries(saved))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	});
	await writeFile(
		join(root, 'repo', 'server.cjs'),
		"process.stdout.write('  Local: \\x1b[36mhttp://localhost:5173/\\x1b[0m\\r\\n');setInterval(()=>{},1000);"
	);
	await store.setProjectCommands(task.projectId, [
		{
			id: 'dev',
			name: 'Dev',
			command: `'${process.execPath}' server.cjs`,
			repo: '',
			directory: '',
		},
		{ id: 'seed', name: 'Seed', command: 'echo seeded', repo: '', directory: '', agentRuns: true },
		{ id: 'deploy', name: 'Deploy', command: 'echo deployed', repo: '', directory: '' },
	]);
	const { identity, client } = await launch(store, task);
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	const listed = (await mcp.request('commands_list', {})) as {
		commands: { id: string; state: string; cwd: string; agentRuns: boolean }[];
	};
	expect(listed.commands.map((item) => [item.id, item.state, item.agentRuns])).toEqual([
		['dev', 'not run', false],
		['seed', 'not run', true],
		['deploy', 'not run', false],
	]);
	expect(listed.commands[0]!.cwd).toBe(await realpath(join(root, 'repo')));
	// A marked command runs at once and waits for its exit.
	expect(await mcp.request('commands_run', { id: 'seed' })).toMatchObject({
		state: 'done',
		exitCode: 0,
		output: expect.stringContaining('seeded'),
	});
	const asked = async (after: number) => {
		const record = await until(async () =>
			(await client.snapshot()).records.find(
				(r) => r.seq > after && r.event.kind === 'permission.requested'
			)
		);
		if (record.event.kind !== 'permission.requested') throw new Error('No permission');
		return record;
	};
	const dev = mcp.request('commands_run', { id: 'dev' });
	const card = await asked(0);
	if (card.event.kind !== 'permission.requested') throw new Error('No permission');
	expect(card.event.request.tool.title).toBe(`Run Dev · '${process.execPath}' server.cjs`);
	expect(card.event.request.options.map((option) => option.name)).toEqual([
		'Allow in this task',
		'Always allow agents',
		'Deny',
	]);
	await client.command({ kind: 'answerPermission', id: card.event.request.id, optionId: 'agents' });
	expect(await dev).toMatchObject({
		state: 'running',
		port: 5173,
		url: 'http://localhost:5173',
		output: expect.stringContaining('Local: http://localhost:5173/'),
	});
	expect(
		(await store.project(task.projectId)).commands?.find((item) => item.id === 'dev')?.agentRuns
	).toBe(true);
	expect(await mcp.request('commands_run', { id: 'dev' })).toMatchObject({
		state: 'running',
		note: expect.stringContaining('already running'),
	});
	expect(await mcp.request('commands_output', { id: 'dev', lines: 1 })).toMatchObject({
		output: '  Local: http://localhost:5173/',
	});
	expect(await mcp.request('commands_stop', { id: 'dev' })).toMatchObject({ state: 'stopped' });
	const deploy = mcp.request('commands_run', { id: 'deploy' }).then(
		() => new Error('allowed'),
		(error: Error) => error
	);
	const second = await asked(card.seq);
	if (second.event.kind !== 'permission.requested') throw new Error('No permission');
	await client.command({ kind: 'answerPermission', id: second.event.request.id, optionId: 'deny' });
	expect((await deploy).message).toContain('did not allow running Deploy');
	expect(
		(await store.project(task.projectId)).commands?.find((item) => item.id === 'deploy')?.agentRuns
	).toBeUndefined();
	await expect(mcp.request('commands_run', { id: 'nope' })).rejects.toThrow(
		'No saved command nope'
	);
}, 30000);

// spec/terminal-and-cli-agents#agent-console-tools: the agent sees the console sessions of its task and reads their last lines; nothing to read is an answer, not a crash.
it('lists and reads the console of the task for the agent through console_*', async () => {
	const { root, store, task } = await setup();
	const saved = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR, SHELL: process.env.SHELL };
	Object.assign(process.env, { HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh' });
	cleanup.push(async () => {
		for (const [name, value] of Object.entries(saved))
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
	});
	const { identity, client } = await launch(store, task);
	const mcp = new Peer(createConnection(identity.socket));
	cleanup.push(async () => mcp.close());
	await mcp.request('handshake', {
		protocolVersion: 1,
		key: task,
		instance: identity.instance,
		role: 'mcp',
		token: identity.mcpToken,
	});
	expect(await mcp.request('console_list', {})).toEqual({
		consoles: [],
		note: expect.stringContaining('No console is open'),
	});
	await expect(mcp.request('console_read', {})).rejects.toThrow('No console is open');
	const first = (await client.terminal({ kind: 'create', role: 'console' })) as { id: string },
		second = (await client.terminal({ kind: 'create', role: 'console' })) as { id: string };
	await client.terminal({
		kind: 'input',
		id: first.id,
		data: "printf 'METRO \\033[32mready\\033[0m\\n'\r",
	});
	await until(async () =>
		((await mcp.request('console_read', { id: first.id })) as { output: string }).output.includes(
			'METRO ready'
		)
	);
	const listed = (await mcp.request('console_list', {})) as {
		consoles: { id: string; state: string; cwd: string; folder: string }[];
	};
	expect(listed.consoles.map((item) => [item.id, item.state, item.folder])).toEqual([
		[first.id, 'running', '.'],
		[second.id, 'running', '.'],
	]);
	expect(listed.consoles[0]!.cwd).toBe(await realpath(join(root, 'repo')));
	expect(await mcp.request('console_read', { id: first.id, lines: 400 })).toMatchObject({
		id: first.id,
		state: 'running',
		output: expect.not.stringContaining('\x1b['),
	});
	// Without an id: the newest of several, said so.
	expect(await mcp.request('console_read', {})).toMatchObject({
		id: second.id,
		note: expect.stringContaining('newest of 2'),
	});
	await expect(mcp.request('console_read', { id: 'gone' })).rejects.toThrow('No console gone');
}, 30000);
