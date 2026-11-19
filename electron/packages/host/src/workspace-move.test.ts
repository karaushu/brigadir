import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { moveFate, type EventRecord, type SessionEvent } from '@brigadir/core';
import { SessionStore } from '@brigadir/persistence';
import { Snapshots, gitText, readChanges, readSnapshots } from '@brigadir/git';
import { monorepo } from '../../git/src/monorepo.fixture';
import { applySwitch, prepareMove, restoreProject, type MoveDocument } from './workspace-move';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

it('spec/crew#auto-move: the rules of one path', () => {
	const a = { mode: '100644', oid: 'a' },
		b = { mode: '100644', oid: 'b' },
		c = { mode: '100644', oid: 'c' },
		link = { mode: '160000', oid: 'l' };
	expect(moveFate(a, a, b, false)).toEqual({ kind: 'take' });
	expect(moveFate(null, null, b, false)).toEqual({ kind: 'take' });
	expect(moveFate(a, a, null, false)).toEqual({ kind: 'take' });
	expect(moveFate(a, b, b, false)).toEqual({ kind: 'skip' });
	expect(moveFate(a, a, b, true)).toEqual({ kind: 'stay', reason: 'person' });
	expect(moveFate(a, b, c, false)).toEqual({ kind: 'merge' });
	expect(moveFate(null, b, c, false)).toEqual({ kind: 'stay', reason: 'conflict' });
	expect(moveFate(a, a, link, false)).toEqual({ kind: 'skip' });
});

it('spec/crew#auto-move: the reference case — root, two submodules, an ignored nested repo and a worktree — moves only the task’s own changes', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-move-'));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const fixture = await monorepo(dir, 3);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(fixture.repo);
	const key = await store.createTask(project.id, 'Couriers list', 'claude');
	const path = (...parts: string[]) => join(project.path, ...parts);
	const status = async (repo: string) =>
		(
			await gitText(repo, [
				'status',
				'--porcelain',
				'--untracked-files=all',
				'--ignore-submodules=all',
			])
		)
			.split('\n')
			.filter(Boolean)
			.sort();
	// The person's dirty state before the task: a submodule's file and a file of the ignored nested repo.
	await writeFile(path('kit', 'd0', 'f0.txt'), 'person kit\n');
	await writeFile(path('apps', 'admin', 'd1', 'f1.txt'), 'person admin\n');
	const repos = ['', 'kit', 'skills', 'apps/admin', 'apps/plain'];
	const before = Object.fromEntries(
		await Promise.all(repos.map(async (repo) => [repo, await status(path(repo))] as const))
	);
	const worktreeBefore = await status(fixture.wt);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	const events: SessionEvent[] = [{ kind: 'turn.started', text: 'go' } as SessionEvent];
	// The agent writes in every repo of the task.
	await writeFile(path('d0', 'f0.txt'), 'agent root\n');
	await writeFile(path('root-new.txt'), 'new\n');
	await writeFile(path('kit', 'agent.txt'), 'kit\n');
	await writeFile(path('skills', 'd0', 'f0.txt'), 'agent skills\n');
	await writeFile(path('apps', 'admin', 'agent.txt'), 'admin\n');
	await writeFile(path('apps', 'plain', 'd0', 'f0.txt'), 'agent plain\n');
	const point = await snapshots.capture('turn');
	events.push({ kind: 'checkpoint.created', checkpoint: point!.id }, {
		kind: 'turn.completed',
		reason: 'end_turn',
	} as SessionEvent);
	const records = (): EventRecord[] =>
		events.map((event, seq) => ({ schemaVersion: 1, seq, at: new Date().toISOString(), event }));
	const scopesBefore = (await readSnapshots(store, key))!.scopes.map((scope) => [
		scope.name,
		scope.id,
	]);
	const doc: MoveDocument = {
		schemaVersion: 1,
		id: '11111111-1111-4111-8111-111111111111',
		hireId: '22222222-2222-4222-8222-222222222222',
		decision: { id: '22222222-2222-4222-8222-222222222222', approved: true, parts: null },
		state: 'moving',
		repos: [],
	};
	const prepared = await prepareMove(
		{
			store,
			key,
			services: { mcpEntry: resolve('apps/desktop/out/services/mcp-relay') },
			records,
		},
		doc
	);
	await restoreProject(store, key, await applySwitch(store, key, prepared));
	const worktree = (await store.projectForTask(key)).path;
	const inWorktree = (...parts: string[]) => readFile(join(worktree, ...parts), 'utf8');
	expect(await inWorktree('d0', 'f0.txt')).toBe('agent root\n');
	expect(await inWorktree('root-new.txt')).toBe('new\n');
	expect(await inWorktree('kit', 'agent.txt')).toBe('kit\n');
	expect(await inWorktree('kit', 'd0', 'f0.txt')).toBe('file 0\n');
	expect(await inWorktree('skills', 'd0', 'f0.txt')).toBe('agent skills\n');
	expect(await inWorktree('apps', 'admin', 'agent.txt')).toBe('admin\n');
	expect(await inWorktree('apps', 'admin', 'd1', 'f1.txt')).toBe('file 1\n');
	expect(await inWorktree('apps', 'plain', 'd0', 'f0.txt')).toBe('agent plain\n');
	for (const repo of repos)
		expect(await gitText(join(worktree, repo), ['symbolic-ref', '--short', 'HEAD'])).toBe(
			'brigadir/couriers-list'
		);
	// Every repo of the project folder is back to its state before the task; the root's linked worktree was never touched.
	for (const repo of repos) expect([repo, await status(path(repo))]).toEqual([repo, before[repo]]);
	expect(await status(fixture.wt)).toEqual(worktreeBefore);
	expect(await readFile(path('kit', 'd0', 'f0.txt'), 'utf8')).toBe('person kit\n');
	// The repos keep their ids in the worktree, and the task's diff is what moved.
	const moved = await Snapshots.open(store, key);
	await moved.capture('baseline');
	expect(moved.current.scopes.map((scope) => [scope.name, scope.id])).toEqual(
		expect.arrayContaining(scopesBefore)
	);
	const changes = await readChanges(store, key);
	expect(
		changes.files
			.map((file) => {
				const scope = moved.current.scopes.find((item) => item.id === file.scopeId)!;
				return scope.name === '.' ? file.path : `${scope.name}/${file.path}`;
			})
			.sort()
	).toEqual([
		'apps/admin/agent.txt',
		'apps/plain/d0/f0.txt',
		'd0/f0.txt',
		'kit/agent.txt',
		'root-new.txt',
		'skills/d0/f0.txt',
	]);
}, 60_000);
