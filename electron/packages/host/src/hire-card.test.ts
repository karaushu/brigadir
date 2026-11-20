import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	crewPalette,
	pendingInputs,
	promptQueue,
	templateLookup,
	type AutoTask,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';

/** spec/crew#auto-hire through the built host and the scripted agent: the hire card while its turn runs, across a host restart and under Enter. */
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
}, 60_000);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read().catch(() => undefined);
		if (value !== undefined) return value;
		await delay(50);
	}
	throw new Error('Condition timed out');
}
const git = (cwd: string, ...args: string[]) =>
	run('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'T',
			GIT_AUTHOR_EMAIL: 't@x',
			GIT_COMMITTER_NAME: 'T',
			GIT_COMMITTER_EMAIL: 't@x',
		},
	});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-hire-card-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	cleanup.push(async () => {
		await run('pkill', ['-f', root]).catch(() => {});
	});
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'seed');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const roles = crewPalette(
		builtinAgentTemplates,
		{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'claude' },
		[]
	).templates;
	const auto: AutoTask = { roles, budget: { minutes: 40, tokens: 400_000 } };
	let task = await store.createTask(project.id, 'Client details', 'claude');
	task = await store.updateTask(task, { auto });
	return { store, task };
}
async function launch(
	store: SessionStore,
	key: TaskKey,
	scenario = 'crew',
	env: Record<string, string> = {}
) {
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
	const child: ChildProcess = spawn(
		process.execPath,
		[resolve('apps/desktop/out/services/host.cjs'), config],
		{ stdio: 'ignore', env: { ...process.env, BRIGADIR_STEER_HOLD_MS: '200', ...env } }
	);
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
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
	return { child, client };
}
const parts = [
	{ title: 'API', role: 'Developer', zone: ['apps/api/**'], lines: 300, prompt: 'Build the API.' },
	{ title: 'Web', role: 'Developer', zone: ['apps/web/**'], lines: 300, prompt: 'Build the web.' },
];
const hirePrompt = `@call hire_workers ${JSON.stringify({ summary: 'API and web are apart.', parts })}`;
const journal = async (store: SessionStore, key: TaskKey): Promise<readonly EventRecord[]> =>
	(await store.journal(key)).records;

it('a host that exits while the hire card waits leaves the task needs-you, with the card', async () => {
	const { store, task } = await setup();
	const first = await launch(store, task);
	await first.client.command({ kind: 'prompt', text: hirePrompt });
	await until(async () =>
		(await journal(store, task)).find((record) => record.event.kind === 'crew.hire.requested')
	);
	// The status follows the journal row.
	await until(async () => ((await store.task(task)).status === 'needs-you' ? true : undefined));
	first.child.kill('SIGKILL');
	await until(async () =>
		first.child.exitCode !== null || first.child.signalCode ? true : undefined
	);
	// A short idle time: the waiting card keeps the host, like a question.
	const second = await launch(store, task, 'crew', { BRIGADIR_TEST_IDLE_MS: '300' });
	await delay(2500);
	expect(second.child.exitCode).toBeNull();
	const records = await journal(store, task);
	expect(records.some((record) => record.event.kind === 'host.stopped')).toBe(true);
	expect(pendingInputs(records).crewHire).not.toBeNull();
	expect((await store.task(task)).status).toBe('needs-you');
}, 120_000);
it('Enter while the hire card waits is held until the card is answered, then reaches the agent', async () => {
	const { store, task } = await setup();
	const { client } = await launch(store, task, 'crew-steering');
	await client.command({ kind: 'prompt', text: hirePrompt });
	const requested = await until(async () =>
		(await journal(store, task)).find((record) => record.event.kind === 'crew.hire.requested')
	);
	if (requested.event.kind !== 'crew.hire.requested') throw new Error('unreachable');
	await client.command({ kind: 'prompt', text: 'also add a README', steer: true });
	// Well past the hold window: the message stays with the host, the call stays in the turn.
	await delay(1500);
	let records = await journal(store, task);
	expect(records.some((record) => record.event.kind === 'prompt.steered')).toBe(false);
	expect(promptQueue(records).held?.map((item) => item.command.text)).toEqual([
		'also add a README',
	]);
	expect(records.filter((record) => record.event.kind === 'turn.completed')).toHaveLength(0);
	await client.command({
		kind: 'decideHire',
		decision: { id: requested.event.hire.id, approved: false, parts: null },
	});
	records = await until(async () => {
		const value = await journal(store, task);
		return value.some((record) => record.event.kind === 'prompt.steered') ? value : undefined;
	});
	const resolved = records.find((record) => record.event.kind === 'crew.hire.resolved')!,
		steered = records.find((record) => record.event.kind === 'prompt.steered')!;
	expect(steered.seq).toBeGreaterThan(resolved.seq);
}, 120_000);
