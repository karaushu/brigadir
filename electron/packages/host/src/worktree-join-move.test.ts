import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { inTask, type EventRecord, type TaskKey } from '@brigadir/core';
import { readChanges, readSnapshots } from '@brigadir/git';
import { connectHost, readIdentity, type HostClient } from './index';

/**
 * spec/tasks#agent-worktrees and spec/tasks#move-to-worktree through the built host and the scripted agent: a worktree the agent makes joins the
 * task, one made by someone else does not join silently; the person's `Move to a worktree` is the hire's move with its own starter.
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
async function setup(launchPatch: { setupCommand?: string } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-wt-join-')));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	// A restarted host is detached: stop it with the fixture tree.
	cleanup.push(async () => {
		await run('pkill', ['-f', root]).catch(() => {});
	});
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'seed');
	// The person's dirty state before the task stays theirs.
	await writeFile(join(repo, 'notes.txt'), 'mine\n');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	let task = await store.createTask(project.id, 'Client details', 'claude');
	if (launchPatch.setupCommand !== undefined)
		task = await store.updateTask(task, {
			launch: {
				isolation: 'in-place',
				branch: '',
				baseRef: 'main',
				setupCommand: launchPatch.setupCommand,
				scopes: [],
			},
		});
	return { root, repo: project.path, store, task };
}
/** The app's connection: it describes a folder the way main does (`describeFolder`). */
const folder = async (method: string, params: unknown) => {
	if (method !== 'folder') throw new Error(`Unexpected ${method}`);
	const canonical = await realpath((params as { path: string }).path);
	return {
		id: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
		name: canonical.split('/').at(-1)!,
		kind: 'external',
		selected: true,
		path: canonical,
	};
};
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
	return { client, child };
}
async function attach(store: SessionStore, key: TaskKey, pid?: number): Promise<HostClient> {
	const identity = await until(async () => {
		const id = await readIdentity(store, key);
		return id && (pid === undefined || id.pid === pid) ? id : undefined;
	});
	const client = await connectHost(identity, undefined, undefined, undefined, folder);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	return client;
}
const journal = async (store: SessionStore, key: TaskKey): Promise<readonly EventRecord[]> =>
	(await store.journal(key)).records;
async function turn(client: HostClient, text: string) {
	const before = (await client.snapshot()).records.at(-1)?.seq ?? 0;
	await client.command({ kind: 'prompt', text });
	return until(async () =>
		(await client.snapshot()).records.find(
			(record) => record.seq > before && record.event.kind === 'turn.completed'
		)
	);
}
const kinds = (records: readonly EventRecord[], kind: string) =>
	records.filter((record) => record.event.kind === kind).map((record) => record.event);

it('a worktree the agent makes joins the task: its commits are the task’s, a review reads it, and a removed one says so, after a restart too', async () => {
	const { root, repo, store, task } = await setup();
	const { client, child } = await launch(store, task);
	const feature = join(root, 'repo-feature');
	await turn(client, `worktree-add feature ${feature}`);
	const joined = await until(async () =>
		kinds(await journal(store, task), 'worktree.joined').at(0)
	);
	const rootId = (await store.task(task)).launch?.scopes.find((scope) => scope.kind === 'root')?.id;
	expect(joined).toMatchObject({
		kind: 'worktree.joined',
		name: 'repo-feature',
		path: feature,
		repo: 'repo',
		branch: 'feature',
		standsForRoot: true,
		by: 'agent',
	});
	expect(
		(await store.task(task)).launch?.scopes.find((scope) => scope.path === feature)
	).toMatchObject({
		kind: 'external',
		selected: true,
		worktreeOf: rootId,
	});
	// The agent commits in its worktree; the task's diff holds that commit, and the review of the task reads the repo.
	await turn(
		client,
		`sh cd ${feature} && echo 'export const api = 1;' > api.ts && git add -A && git commit -qm api && echo more >> README.md`
	);
	const doc = (await readSnapshots(store, task))!;
	const scope = doc.scopes.find((item) => item.path === feature)!;
	expect(inTask(scope)).toBe(true);
	expect(
		(await readChanges(store, task)).files
			.filter((file) => file.scopeId === scope.id)
			.map((file) => file.path)
			.sort()
	).toEqual(['README.md', 'api.ts']);
	// The root's own folder did not change in the task.
	expect(await git(repo, 'status', '--porcelain')).toBe('?? notes.txt');
	// A second worktree the agent makes and removes again in the next turn.
	const scratch = join(root, 'repo-scratch');
	await turn(client, `worktree-add scratch ${scratch}`);
	await until(async () =>
		kinds(await journal(store, task), 'worktree.joined').length === 2 ? true : undefined
	);
	await turn(client, `sh git worktree remove --force ${scratch} && git branch -D scratch`);
	// The person's next message goes at once while the folder leaves the task.
	await turn(client, 'hello');
	expect(
		await until(async () => kinds(await journal(store, task), 'worktree.removed').at(0))
	).toMatchObject({ name: 'repo-scratch', branch: 'scratch', branchKept: false });
	// The host joined it, so the host lets it go: no unavailable folder stays behind.
	await until(async () =>
		(await store.task(task)).launch?.scopes.some((scope) => scope.path === scratch)
			? undefined
			: true
	);
	// The host stops; the joined worktree's folder goes while it is down; the next host says so.
	child.kill('SIGTERM');
	await until(async () =>
		child.exitCode !== null || child.signalCode !== null ? true : undefined
	);
	await rm(feature, { recursive: true, force: true });
	await launch(store, task);
	expect(
		await until(async () =>
			kinds(await journal(store, task), 'worktree.removed').find(
				(event) => event.kind === 'worktree.removed' && event.name === 'repo-feature'
			)
		)
	).toMatchObject({ branch: 'feature', branchKept: true });
	// Each worktree joined once.
	expect(kinds(await journal(store, task), 'worktree.joined')).toHaveLength(2);
}, 120_000);

it('a worktree made by someone else does not join silently: outside the turns it is left alone, inside one the person decides', async () => {
	const { root, repo, store, task } = await setup();
	const { client } = await launch(store, task);
	await turn(client, 'hello');
	// The person makes a worktree between the agent's turns.
	await git(repo, 'worktree', 'add', '-q', '-b', 'person', join(root, 'person-tree'));
	await turn(client, 'hello');
	// A script makes one during the turn, named by no tool: the host cannot tell whose it is and asks.
	await writeFile(
		join(root, 'make.sh'),
		`git -C ${repo} worktree add -q -b other ${join(root, 'other-tree')}\n`
	);
	await client.command({ kind: 'prompt', text: `sh sh ${join(root, 'make.sh')}` });
	const asked = await until(async () =>
		(await journal(store, task)).find(
			(record) =>
				record.event.kind === 'permission.requested' &&
				record.event.request.tool.title?.startsWith('Add worktree')
		)
	);
	if (asked.event.kind !== 'permission.requested') throw new Error('unreachable');
	expect(asked.event.request.tool.title).toBe('Add worktree other-tree · other to the task');
	await client.command({ kind: 'answerPermission', id: asked.event.request.id, optionId: 'deny' });
	await turn(client, 'hello');
	const records = await journal(store, task);
	expect(kinds(records, 'worktree.joined')).toEqual([]);
	expect(
		records.filter(
			(record) =>
				record.event.kind === 'permission.requested' &&
				record.event.request.tool.title?.startsWith('Add worktree')
		)
	).toHaveLength(1);
	const scopes = (await store.task(task)).launch?.scopes ?? [];
	expect(scopes.some((scope) => scope.path?.endsWith('-tree'))).toBe(false);
}, 120_000);

it('the person moves an idle task into a worktree: only its changes go, the project folder is back, the agent hears where it runs', async () => {
	const { repo, store, task } = await setup();
	const { client } = await launch(store, task);
	const statusBefore = await git(repo, 'status', '--porcelain', '--untracked-files=all');
	await turn(client, "sh echo 'export const api = 1;' > api.ts");
	await client.command({ kind: 'moveToWorktree' });
	const moved = await until(
		async () =>
			kinds(await journal(store, task), 'workspace.move').find(
				(event) => event.kind === 'workspace.move' && event.state === 'moved'
			),
		120_000
	);
	expect(moved).toMatchObject({ by: 'person', branch: 'brigadir/client-details', stayed: [] });
	expect(
		kinds(await journal(store, task), 'workspace.move').map(
			(event) => event.kind === 'workspace.move' && event.state
		)
	).toEqual(['moving', 'moved']);
	const after = await store.task(task);
	expect(after.launch).toMatchObject({ isolation: 'worktree', branch: 'brigadir/client-details' });
	const worktree = (await store.projectForTask(task)).path;
	expect(await readFile(join(worktree, 'api.ts'), 'utf8')).toBe('export const api = 1;\n');
	await expect(readFile(join(worktree, 'notes.txt'))).rejects.toThrow();
	expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(statusBefore);
	// The next prompt starts with where the task now runs, once.
	const next = await attach(store, task);
	await turn(next, 'hello');
	expect(
		JSON.parse(await readFile(join(await store.taskDir(task), 'workspace-move.json'), 'utf8'))
	).toMatchObject({ by: 'person', state: 'moved', told: true });
	// A second move is refused: the task has a worktree now.
	await expect(next.command({ kind: 'moveToWorktree' })).rejects.toThrow(
		'The task already has a worktree.'
	);
}, 240_000);

it('a move during a turn waits for it; a waiting move can be cancelled; a failed move loses nothing', async () => {
	const { repo, store, task } = await setup();
	const { client } = await launch(store, task);
	await turn(client, "sh echo 'export const api = 1;' > api.ts");
	// The project's setup command fails, after the copies exist.
	const root = (await readSnapshots(store, task))!.scopes.find((scope) => scope.kind === 'root')!;
	await store.updateTask(task, {
		launch: {
			isolation: 'in-place',
			branch: '',
			baseRef: 'main',
			setupCommand: 'exit 3',
			scopes: [{ id: root.id, name: '.', kind: 'root', selected: true }],
		},
	});
	// The turn waits on a permission card: the move waits with it, and the person cancels it.
	await client.command({ kind: 'prompt', text: 'permission' });
	const held = await until(async () =>
		(await journal(store, task)).find((record) => record.event.kind === 'permission.requested')
	);
	await client.command({ kind: 'moveToWorktree' });
	expect(kinds(await journal(store, task), 'workspace.move').at(-1)).toMatchObject({
		state: 'waiting',
		by: 'person',
	});
	await client.command({ kind: 'cancelMove' });
	expect(kinds(await journal(store, task), 'workspace.move').at(-1)).toMatchObject({
		state: 'cancelled',
	});
	await expect(client.command({ kind: 'cancelMove' })).rejects.toThrow();
	// Again, and this time it goes once the turn ends; the setup command fails, so nothing moves.
	await client.command({ kind: 'moveToWorktree' });
	if (held.event.kind !== 'permission.requested') throw new Error('unreachable');
	const statusAtMove = await git(repo, 'status', '--porcelain', '--untracked-files=all');
	await client.command({
		kind: 'answerPermission',
		id: held.event.request.id,
		optionId: held.event.request.options[0]!.id,
	});
	const failed = await until(
		async () =>
			kinds(await journal(store, task), 'workspace.move').find(
				(event) => event.kind === 'workspace.move' && event.state === 'failed'
			),
		120_000
	);
	expect(failed).toMatchObject({ message: expect.stringContaining('Setup command failed') });
	const states = kinds(await journal(store, task), 'workspace.move').map(
		(event) => event.kind === 'workspace.move' && event.state
	);
	expect(states).toEqual(['waiting', 'cancelled', 'waiting', 'moving', 'failed']);
	expect((await store.task(task)).launch?.isolation).toBe('in-place');
	expect(await git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe(statusAtMove);
	expect(await readFile(join(repo, 'api.ts'), 'utf8')).toBe('export const api = 1;\n');
	expect(await git(repo, 'branch', '--list', 'brigadir/*')).toBe('');
	// The same host goes on in the project folder.
	expect((await journal(store, task)).some((record) => record.event.kind === 'host.stopped')).toBe(
		false
	);
	await turn(client, 'hello');
}, 240_000);
