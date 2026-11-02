import * as Git from '@brigadir/git';
import { test, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, readWorkspace } from '@brigadir/persistence';
import { Snapshots, git } from '@brigadir/git';
import { TaskDiffs } from './task-diffs';
test('reads snapshot deltas independently from journal unread and invalidates the cache on new checkpoints', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sidebar-diffs-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		await git(repo, ['init', '-b', 'main']);
		await writeFile(join(repo, 'file'), 'base');
		const store = await SessionStore.at(data),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Review', 'claude'),
			snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		const totalCalls = vi.spyOn(Git, 'snapshotTotals');
		const diffs = new TaskDiffs(data),
			read = async () => diffs.decorate(await readWorkspace({ dataDir: data }));
		expect((await read()).tasks[0]?.hasUnreviewedChanges).toBe(false);
		await writeFile(join(repo, 'file'), 'changed');
		await snapshots.capture('turn');
		expect((await read()).tasks[0]).toMatchObject({
			hasUnreviewedChanges: true,
			changeSummary: { additions: 1, deletions: 1 },
			taskTree: { branch: 'main', worktree: false },
		});
		expect((await read()).tasks[0]?.hasUnreviewedChanges).toBe(true);
		expect(totalCalls).toHaveBeenCalledTimes(1);
		await snapshots.setScope({ id: snapshots.current.scopes[0]!.id, selected: false });
		expect((await read()).tasks[0]?.hasUnreviewedChanges).toBe(false);
		const path = join(await store.taskDir(task), 'snapshots.json');
		await rm(path);
		await symlink(join(repo, 'file'), path);
		expect((await read()).issues[0]?.code).toBe('unreadable');
	} finally {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	}
});
test.each(['task', 'head'] as const)(
	'a released worktree keeps its change summary and is not reported unreadable (%s base)',
	async (base) => {
		const { Worktrees, discoverScopes } = await import('@brigadir/git'),
			{ ProcessCoordinator } = await import('@brigadir/persistence'),
			{ resolve } = await import('node:path'),
			{ readFile } = await import('node:fs/promises');
		const root = await mkdtemp(join(tmpdir(), 'released-diffs-'));
		try {
			const data = join(root, 'data'),
				repo = join(root, 'repo');
			await mkdir(repo);
			await git(repo, ['init', '-b', 'main']);
			await git(repo, ['config', 'user.name', 'F']);
			await git(repo, ['config', 'user.email', 'f@example.invalid']);
			await writeFile(join(repo, 'file'), 'base\n');
			await git(repo, ['add', '.']);
			await git(repo, ['commit', '-m', 'Initial']);
			const store = await SessionStore.at(data),
				project = await store.addProject(repo),
				task = await store.createTask(project.id, 'Isolated', 'claude'),
				trees = new Worktrees(
					store,
					new ProcessCoordinator(resolve('apps/desktop/out/services/process-owner'))
				);
			const state = await trees.prepare(task, { branch: 'brigadir/released', baseRef: 'main' });
			await store.updateTask(task, {
				launch: {
					isolation: 'worktree',
					branch: state.branch,
					baseRef: 'main',
					setupCommand: '',
					scopes: (await discoverScopes(repo)).map(({ id, name, kind }) => ({
						id,
						name,
						kind,
						selected: true,
					})),
				},
			});
			const snapshots = await Snapshots.open(store, task);
			await snapshots.capture('baseline');
			await writeFile(join(state.root, 'file'), 'base\nadded\n');
			await snapshots.capture('turn');
			const diffs = new TaskDiffs(data);
			diffs.diffBase = base;
			const read = async () => diffs.decorate(await readWorkspace({ dataDir: data }));
			const live = await read();
			expect(live.issues).toEqual([]);
			expect(live.tasks[0]?.changeSummary).toEqual({ additions: 1, deletions: 0 });
			await trees.remove(task);
			expect(
				await readFile(join(await store.taskDir(task), 'worktree-released.json'), 'utf8')
			).toContain('brigadir/released');
			const released = await new TaskDiffs(data).decorate(await readWorkspace({ dataDir: data }));
			expect(released.issues).toEqual([]);
			expect(released.tasks[0]?.changeSummary).toEqual({ additions: 1, deletions: 0 });
			expect(released.tasks[0]?.hasUnreviewedChanges).toBe(true);
			// The Diff panel of the archived task still lists the files and reads their blobs from the source repo.
			const changes = await Git.readChanges(store, task, base === 'head' ? 'head' : undefined),
				scope = changes.scopes[0]!;
			expect(scope.available).toBe(false);
			expect(changes.files.map((file) => file.path)).toEqual(['file']);
			expect((await Git.readBlobs(scope, [changes.files[0]!.after]))[0]?.text).toBe(
				'base\nadded\n'
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	30000
);

test('a checkout of the root repo from outside stands for the root in the task tree (spec/tasks#agent-worktrees)', async () => {
	const { realpath } = await import('node:fs/promises');
	const root = await realpath(await mkdtemp(join(tmpdir(), 'stand-in-diffs-')));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo'),
			outside = join(root, 'repo-validation');
		await mkdir(repo);
		await git(repo, ['init', '-b', 'main']);
		await git(repo, ['config', 'user.name', 'F']);
		await git(repo, ['config', 'user.email', 'f@example.invalid']);
		await writeFile(join(repo, 'file'), 'base');
		await git(repo, ['add', '-A']);
		await git(repo, ['commit', '-qm', 'base']);
		const store = await SessionStore.at(data),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Handoff', 'claude'),
			snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		const read = async () =>
			(await new TaskDiffs(data).decorate(await readWorkspace({ dataDir: data }))).tasks[0];
		expect((await read())?.taskTree).toEqual({ branch: 'main', worktree: false });
		await git(repo, ['worktree', 'add', '-q', '-b', 'feature', outside]);
		const rootScope = snapshots.current.scopes.find((scope) => scope.kind === 'root')!;
		await snapshots.addScope({
			id: 'a1b2c3d4e5f60718',
			name: 'repo-validation',
			kind: 'external',
			selected: true,
			path: outside,
			worktreeOf: rootScope.id,
		});
		expect((await read())?.taskTree).toEqual({
			branch: 'feature',
			worktree: true,
			scopeId: 'a1b2c3d4e5f60718',
		});
		await git(repo, ['worktree', 'remove', '--force', outside]);
		await snapshots.capture('refresh');
		expect((await read())?.taskTree).toEqual({ branch: 'main', worktree: false });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
