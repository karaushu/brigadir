import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	crewPalette,
	templateLookup,
	type AutoTask,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';

/**
 * spec/crew#auto-move through the built host and the scripted agent: an Auto task in the project's checkout hires two workers; the host moves
 * it into a worktree at the end of the turn, restarts there, resumes the session and starts the workers from the agent's commit.
 */
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
}, 60_000);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 60_000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read().catch(() => undefined);
		if (value !== undefined) return value;
		await delay(100);
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
	}).then((result) => result.stdout.trim());
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-auto-move-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	// The restarted host and the worker hosts are detached: stop them with the fixture tree.
	cleanup.push(async () => {
		await run('pkill', ['-f', root]).catch(() => {});
	});
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'seed');
	// The person's dirty state before the task.
	await writeFile(join(repo, 'README.md'), 'hello\nperson\n');
	await writeFile(join(repo, 'notes.txt'), 'mine\n');
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
	return { root, repo: project.path, store, task };
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
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'crew'],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'ignore',
	});
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
	});
	const client = await attach(store, key, child.pid);
	await client.startAgent();
	await until(async () =>
		(await client.snapshot()).records.find((r) => r.event.kind === 'session.started')
	);
	return client;
}
async function attach(store: SessionStore, key: TaskKey, pid?: number): Promise<HostClient> {
	const identity = await until(async () => {
		const id = await readIdentity(store, key);
		return id && (pid === undefined || id.pid === pid) ? id : undefined;
	});
	const client = await connectHost(identity);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	return client;
}
const journal = async (store: SessionStore, key: TaskKey): Promise<readonly EventRecord[]> =>
	(await store.journal(key)).records;

it('an Auto task without isolation hires two workers: it moves into a worktree, the person’s files stay, the workers start from its commit', async () => {
	const { repo, store, task } = await setup();
	const statusBefore = await git(repo, 'status', '--porcelain', '--untracked-files=all');
	const client = await launch(store, task);
	const parts = [
		{
			title: 'API',
			role: 'Developer',
			zone: ['apps/api/**'],
			lines: 300,
			prompt: 'Build the API.',
		},
		{
			title: 'Web',
			role: 'Developer',
			zone: ['apps/web/**'],
			lines: 300,
			prompt: 'Build the web.',
		},
	];
	await client.command({
		kind: 'prompt',
		text: [
			'@write apps/api/lead.ts export const lead = 1;',
			'@write apps/web/lead.ts export const web = 1;',
			`@call hire_workers ${JSON.stringify({ summary: 'API and web are apart.', parts })}`,
		].join('\n'),
	});
	const requested = await until(async () =>
		(await journal(store, task)).find((record) => record.event.kind === 'crew.hire.requested')
	);
	if (requested.event.kind !== 'crew.hire.requested') throw new Error('unreachable');
	await client.command({
		kind: 'decideHire',
		decision: { id: requested.event.hire.id, approved: true, parts: null },
	});
	// The first host stops (`moved`), the next one starts in the worktree and finishes the hire.
	const resolved = await until(
		async () =>
			(await journal(store, task)).find((record) => record.event.kind === 'crew.hire.resolved'),
		120_000
	);
	const records = await journal(store, task);
	expect(
		records.some(
			(record) => record.event.kind === 'host.stopped' && record.event.reason === 'moved'
		)
	).toBe(true);
	expect(resolved.event).toMatchObject({ kind: 'crew.hire.resolved', approved: true });
	if (resolved.event.kind !== 'crew.hire.resolved') throw new Error('unreachable');
	expect(resolved.event.hired).toHaveLength(2);
	expect(
		records.filter((record) => record.event.kind === 'workspace.move').map((r) => r.event)
	).toMatchObject([
		{ state: 'moving', repos: ['repo'] },
		{ state: 'moved', branch: 'brigadir/client-details', base: 'main', stayed: [] },
	]);
	const moved = await store.task(task);
	expect(moved.launch).toMatchObject({ isolation: 'worktree', branch: 'brigadir/client-details' });
	const worktree = (await store.projectForTask(task)).path;
	// The agent's files are committed on the task's branch in the worktree; the person's dirty files are not there.
	expect(await git(worktree, 'status', '--porcelain')).toBe('');
	expect(await git(worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'apps/api/lead.ts\napps/web/lead.ts'
	);
	expect(await readFile(join(worktree, 'README.md'), 'utf8')).toBe('hello\n');
	// The project folder is as it was before the task.
	expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(statusBefore);
	// The workers are tasks in worktrees that start from that commit.
	const head = await git(worktree, 'rev-parse', 'HEAD');
	for (const hired of resolved.event.hired) {
		const key = { projectId: task.projectId, id: hired.taskId };
		const worker = await until(async () => {
			const value = await store.task(key);
			return value.preparation?.state === 'ready' ? value : undefined;
		}, 120_000);
		expect(worker.launch?.baseRef).toBe('brigadir/client-details');
		const copy = (await store.projectForTask(key)).path;
		expect(await git(copy, 'merge-base', '--is-ancestor', head, 'HEAD').then(() => true)).toBe(
			true
		);
	}
	// The lead's session resumed in the worktree and got the hire's result.
	const next = await attach(store, task);
	await until(async () =>
		(await next.snapshot()).records.find(
			(record) =>
				record.event.kind === 'turn.started' &&
				record.event.text.startsWith('The task moved into a worktree')
		)
	);
}, 240_000);

it('a move that fails keeps everything where it was: the hire is refused and the agent goes on alone in the project folder', async () => {
	const { repo, store, task } = await setup();
	// The setup command fails, after the copies exist: they go again, the project folder never changed.
	await store.updateTask(task, {
		launch: {
			isolation: 'in-place',
			branch: '',
			baseRef: 'main',
			setupCommand: 'exit 3',
			scopes: [],
		},
	});
	const client = await launch(store, task);
	const parts = [
		{
			title: 'API',
			role: 'Developer',
			zone: ['apps/api/**'],
			lines: 300,
			prompt: 'Build the API.',
		},
		{
			title: 'Web',
			role: 'Developer',
			zone: ['apps/web/**'],
			lines: 300,
			prompt: 'Build the web.',
		},
	];
	await client.command({
		kind: 'prompt',
		text: [
			'@write apps/api/lead.ts export const lead = 1;',
			`@call hire_workers ${JSON.stringify({ summary: 'Apart.', parts })}`,
		].join('\n'),
	});
	const requested = await until(async () =>
		(await journal(store, task)).find((record) => record.event.kind === 'crew.hire.requested')
	);
	if (requested.event.kind !== 'crew.hire.requested') throw new Error('unreachable');
	const statusAtHire = await git(repo, 'status', '--porcelain', '--untracked-files=all');
	await client.command({
		kind: 'decideHire',
		decision: { id: requested.event.hire.id, approved: true, parts: null },
	});
	// The same host goes on: the agent hears the refusal in a turn of its own.
	await until(async () =>
		(await client.snapshot()).records.find(
			(record) =>
				record.event.kind === 'turn.started' &&
				record.event.text.startsWith('The task could not move into a worktree')
		)
	);
	const records = await journal(store, task);
	expect(records.some((record) => record.event.kind === 'host.stopped')).toBe(false);
	expect(records.findLast((record) => record.event.kind === 'workspace.move')?.event).toMatchObject(
		{
			state: 'failed',
			message: expect.stringContaining('Setup command failed'),
		}
	);
	expect(
		records.findLast((record) => record.event.kind === 'crew.hire.resolved')?.event
	).toMatchObject({ approved: false, reason: 'no-worktree', hired: [] });
	expect((await store.task(task)).launch?.isolation).toBe('in-place');
	expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(statusAtHire);
	expect(await readFile(join(repo, 'apps', 'api', 'lead.ts'), 'utf8')).toBe(
		'export const lead = 1;\n'
	);
	expect(await git(repo, 'branch', '--list', 'brigadir/*')).toBe('');
}, 240_000);
