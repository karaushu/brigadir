import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson, safePath, readDocument } from '@brigadir/persistence';
import {
	pendingInputs,
	taskReviewSpec,
	type AgentTask,
	type CrewSpecAgent,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';

/** spec/agents-and-providers#budget-reached on a real host with the fixture agent: `spend N` reports N new tokens at its turn end. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 10000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (value !== undefined) return value;
		await delay(25);
	}
	throw new Error('Condition timed out');
}
async function setup(budget?: AgentTask['tokenBudget']) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-budget-test-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'repo'));
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(join(root, 'repo'));
	const task = await store.createTask(project.id, 'Test', 'claude');
	if (budget) await store.updateTask(task, { tokenBudget: budget });
	return { store, task: await store.task(task) };
}
async function launch(store: SessionStore, key: TaskKey) {
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
		stdio: 'pipe',
	});
	let diagnostics = '';
	child.stderr.on('data', (chunk) => {
		diagnostics += chunk;
	});
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	const kill = async () => {
		if (exited()) return;
		child.kill('SIGTERM');
		await until(async () => (exited() ? true : undefined)).catch(() => child.kill('SIGKILL'));
	};
	cleanup.push(kill);
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
		(await client.snapshot()).records.find((r) => r.event.kind === 'session.started')
	);
	return { client, kill };
}
const records = async (client: HostClient) => (await client.snapshot()).records;
const find = (client: HostClient, test: (record: EventRecord) => boolean, timeout?: number) =>
	until(async () => (await records(client)).find(test), timeout);
const kind =
	<K extends EventRecord['event']['kind']>(name: K) =>
	(
		record: EventRecord
	): record is EventRecord & { event: Extract<EventRecord['event'], { kind: K }> } =>
		record.event.kind === name;
const turnsDone = async (client: HostClient) =>
	(await records(client)).filter((record) => record.event.kind === 'turn.completed').length;

it('a turn that passes the budget asks once, holds the queue, and a raise resumes it', async () => {
	const { store, task } = await setup({ claude: 1000 });
	const { client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'spend 1200' });
	const reached = await find(client, kind('budget.reached'));
	expect(reached.event).toMatchObject({ provider: 'claude', budget: 1000, tokens: 1200 });
	await until(async () => ((await turnsDone(client)) === 1 ? true : undefined));
	// The figure on the task counts new tokens only; cache reads are kept apart.
	const stored = await until(async () => {
		const value = await store.task(task);
		return value.tokens?.input === 1200 && value.tokenHold?.state === 'asked' ? value : undefined;
	});
	expect(stored.tokens).toMatchObject({
		input: 1200,
		cacheRead: 12_000,
		running: false,
		estimate: 0,
	});
	expect(stored.status).toBe('needs-you');
	// Nothing new starts: the next message waits in the queue.
	await client.command({ kind: 'prompt', text: 'spend 10' });
	await find(client, kind('prompt.queued'));
	await delay(400);
	expect((await records(client)).filter(kind('turn.started'))).toHaveLength(1);
	expect(pendingInputs(await records(client)).budget?.id).toBe(reached.event.id);
	await expect(
		client.command({ kind: 'decideBudget', id: 'other', decision: 'finish' })
	).rejects.toThrow();
	await client.command({
		kind: 'decideBudget',
		id: reached.event.id,
		decision: 'raise',
		budget: 3_000_000,
	});
	await find(client, kind('budget.decided'));
	const resumed = await find(
		client,
		(record) => record.event.kind === 'turn.started' && Boolean(record.event.queuedPromptId)
	);
	expect(resumed.event).toMatchObject({ text: 'spend 10' });
	expect((await store.task(task)).tokenBudget).toEqual({ claude: 3_000_000 });
	expect((await store.task(task)).tokenHold).toBeNull();
	await until(async () => ((await turnsDone(client)) === 2 ? true : undefined));
	expect((await records(client)).filter(kind('budget.reached'))).toHaveLength(1);
});

it('asks in the middle of a turn from the estimate', async () => {
	const { store, task } = await setup({ claude: 1000 });
	const { client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'spend 1500 slow' });
	const reached = await find(client, kind('budget.reached'));
	expect(reached.event).toMatchObject({ estimated: true, tokens: 1500 });
	// Asked before the turn ended: the running turn is not stopped by the question.
	const done = (await records(client)).find(kind('turn.completed'));
	expect(done === undefined || done.seq > reached.seq).toBe(true);
	await find(client, kind('turn.completed'));
});

it('finish keeps the task paused until its budget changes; No limit in Task usage lifts it', async () => {
	const { store, task } = await setup({ claude: 1000, codex: 2_000_000 });
	const { client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'spend 1200' });
	const reached = await find(client, kind('budget.reached'));
	await client.command({ kind: 'decideBudget', id: reached.event.id, decision: 'finish' });
	await find(client, kind('budget.decided'));
	await until(async () =>
		(await store.task(task)).tokenHold?.state === 'finish' ? true : undefined
	);
	await client.command({ kind: 'prompt', text: 'spend 5' });
	await find(client, kind('prompt.queued'));
	await delay(400);
	expect((await records(client)).filter(kind('turn.started'))).toHaveLength(1);
	await client.command({ kind: 'setTokenBudget', provider: 'claude', budget: null });
	await find(
		client,
		(record) => record.event.kind === 'turn.started' && record.event.text === 'spend 5'
	);
	expect((await store.task(task)).tokenBudget).toEqual({ codex: 2_000_000 });
});

it('Stop now cancels the running turn', async () => {
	const { store, task } = await setup({ claude: 1000 });
	const { client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'spend 2000 hold' });
	const reached = await find(client, kind('budget.reached'));
	expect(reached.event.estimated).toBe(true);
	await client.command({ kind: 'decideBudget', id: reached.event.id, decision: 'stop' });
	const done = await find(client, kind('turn.completed'));
	expect(done.event.reason).toBe('cancelled');
	await until(async () =>
		(await store.task(task)).tokenHold?.state === 'stop' ? true : undefined
	);
});

it('a budget raised in Task usage while the question waits answers it', async () => {
	const { store, task } = await setup({ claude: 1000 });
	const { client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'spend 1200' });
	const reached = await find(client, kind('budget.reached'));
	// At or below the count the question stays.
	await client.command({ kind: 'setTokenBudget', provider: 'claude', budget: 1000 });
	await delay(200);
	expect((await records(client)).some(kind('budget.decided'))).toBe(false);
	await client.command({ kind: 'setTokenBudget', provider: 'claude', budget: 5_000_000 });
	const decided = await find(client, kind('budget.decided'));
	expect(decided.event).toMatchObject({
		id: reached.event.id,
		decision: 'raise',
		budget: 5_000_000,
	});
});

it('a restart while paused keeps the question and the hold, and never asks twice', async () => {
	const { store, task } = await setup({ claude: 1000 });
	const first = await launch(store, task);
	await first.client.command({ kind: 'prompt', text: 'spend 1200' });
	const reached = await find(first.client, kind('budget.reached'));
	await until(async () => ((await turnsDone(first.client)) === 1 ? true : undefined));
	await first.client.command({ kind: 'prompt', text: 'spend 5' });
	await find(first.client, kind('prompt.queued'));
	first.client.close();
	await first.kill();
	const second = await launch(store, task);
	await delay(3500);
	const after = await records(second.client);
	expect(after.filter(kind('budget.reached'))).toHaveLength(1);
	expect(pendingInputs(after).budget?.id).toBe(reached.event.id);
	expect((await store.task(task)).tokenHold).toMatchObject({
		id: reached.event.id,
		state: 'asked',
	});
	expect(after.filter(kind('turn.started'))).toHaveLength(1);
	await second.client.command({
		kind: 'decideBudget',
		id: reached.event.id,
		decision: 'unlimited',
	});
	await find(
		second.client,
		(record) => record.event.kind === 'turn.started' && record.event.text === 'spend 5'
	);
	expect((await store.task(task)).tokenBudget).toEqual({});
}, 30_000);

it('an old task without a budget only counts', async () => {
	const { store, task } = await setup();
	expect(task.tokenBudget).toBeUndefined();
	const { client } = await launch(store, task);
	await client.command({ kind: 'prompt', text: 'spend 900000' });
	await until(async () => ((await turnsDone(client)) === 1 ? true : undefined));
	await until(async () => ((await store.task(task)).tokens?.input === 900000 ? true : undefined));
	await delay(200);
	expect((await records(client)).some(kind('budget.reached'))).toBe(false);
});

it("a crew member holds its queue while the root is held, and resumes when the root's hold lifts", async () => {
	const { store, task: root } = await setup({ claude: 1000 });
	// A reviewer of the root's own review is a member like a crew worker (spec/reviews#reviewer-sessions).
	const base = taskReviewSpec('claude', []),
		reviewer: CrewSpecAgent = {
			...base.root,
			id: 'review-r1',
			name: 'Reviewer',
			role: 'reviewer',
			checkedBy: [],
			agents: [],
		};
	await store.updateTask(root, { reviewCrew: taskReviewSpec('claude', [reviewer]) });
	const member = await store.createTask(root.projectId, 'Member', 'claude');
	await store.updateTask(member, {
		crewTaskId: root.id,
		crewNodeId: reviewer.id,
		parentTaskId: root.id,
	});
	// The root reaches its budget from the member's figure alone: the member's tokens count toward the root's budget.
	await store.updateTask(member, {
		tokens: { input: 900, cacheWrite: 200, output: 0, cacheRead: 0, estimate: 0, running: false },
	});
	const rootHost = await launch(store, root);
	const reached = await find(rootHost.client, kind('budget.reached'), 8000);
	expect(reached.event).toMatchObject({ tokens: 1100, budget: 1000 });
	await until(async () =>
		(await store.task(root)).tokenHold?.state === 'asked' ? true : undefined
	);
	const { client } = await launch(store, member);
	await client.command({ kind: 'prompt', text: 'spend 1' });
	await find(client, kind('prompt.queued'));
	await delay(400);
	expect((await records(client)).some(kind('turn.started'))).toBe(false);
	await rootHost.client.command({
		kind: 'decideBudget',
		id: reached.event.id,
		decision: 'raise',
		budget: 1_000_000,
	});
	// Within the member's 3 s poll.
	await find(
		client,
		(record) => record.event.kind === 'turn.started' && record.event.text === 'spend 1',
		8000
	);
	const doc = await readDocument(await safePath(await store.taskDir(member), 'task.json'));
	expect((doc.task as AgentTask).tokenBudget).toBeUndefined();
}, 30_000);

it('a new task takes the default budget from the settings', async () => {
	const { store, task } = await setup();
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { agents: { taskBudget: { claude: 2_000_000, codex: null } } },
	});
	const next = await store.createTask(task.projectId, 'Next', 'codex');
	expect(next.tokenBudget).toEqual({ claude: 2_000_000 });
	expect(task.tokenBudget).toBeUndefined();
});
