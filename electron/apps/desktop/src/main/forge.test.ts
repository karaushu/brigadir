import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Forge, type GhRunner } from '@brigadir/forge';
import { SessionStore } from '@brigadir/persistence';
import { gitText, Snapshots } from '@brigadir/git';
import { ForgeActions } from './forge';
import type { Sessions } from './sessions';
import type { PRRef, SessionCommand, TaskKey } from '@brigadir/core';
// Each test drives real git: fixture repos, a bare remote and ForgeActions, ~170 git processes (2–2.5 s alone). Nothing in
// them waits on a clock or polls, so the outcome is fixed; only the wall time grows when other test files spawn git in
// parallel (5.0 s next to apps/desktop/src/main). The budget is explicit, like forge-cache.test.ts, not vitest's 5 s.
vi.setConfig({ testTimeout: 30_000 });
it('keeps local refresh off the network, creates PRs through reviewed pushes, records provenance and can push again', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-forge-actions-')),
		repo = join(dir, 'repo'),
		remote = join(dir, 'remote.git');
	try {
		await mkdir(repo);
		await mkdir(remote);
		await gitText(remote, ['init', '--bare', '-b', 'main']);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'file'), 'base');
		await gitText(repo, ['add', 'file']);
		await gitText(repo, ['commit', '-m', 'Baseline']);
		await gitText(repo, ['remote', 'add', 'origin', remote]);
		await gitText(repo, ['push', '-u', 'origin', 'main']);
		await gitText(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
		const store = await SessionStore.at(join(dir, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Feature title', 'claude');
		await store.setStatus(task, 'done');
		const snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		await gitText(repo, ['switch', '-c', 'feature']);
		await writeFile(join(repo, 'file'), 'feature');
		await gitText(repo, ['commit', '-am', 'Add feature']);
		await snapshots.capture('refresh');
		let prs: unknown[] = [];
		const calls: { args: string[]; input?: string }[] = [];
		const runner: GhRunner = async (_, args, input) => {
			calls.push({ args, ...(input === undefined ? {} : { input }) });
			if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
			if (args[0] === 'repo')
				return {
					code: 0,
					stdout: JSON.stringify({
						nameWithOwner: 'fixture/repo',
						url: 'https://github.com/fixture/repo',
						defaultBranchRef: { name: 'main' },
					}),
					stderr: '',
				};
			if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(prs), stderr: '' };
			if (args[1] === 'view')
				return {
					code: 0,
					stdout: JSON.stringify({ ...(prs[0] as object), mergeable: 'MERGEABLE' }),
					stderr: '',
				};
			if (args[1] === 'checks') return { code: 0, stdout: '[]', stderr: '' };
			if (args[1] === 'create') {
				prs = [
					{
						number: 12,
						url: 'https://github.com/fixture/repo/pull/12',
						title: args[args.indexOf('--title') + 1],
						state: 'OPEN',
						headRefName: 'feature',
						baseRefName: 'main',
					},
				];
				return { code: 0, stdout: 'https://github.com/fixture/repo/pull/12\n', stderr: '' };
			}
			throw new Error('Unexpected command');
		};
		const sessions = {
			activity: async () => ({ connected: false, busy: false, started: false }),
			command: async (key: TaskKey, command: SessionCommand) => {
				if (command.kind === 'recordPullRequest')
					await store.updateTask(key, { pullRequests: { [command.scopeId]: command.pr } });
				else if (command.kind === 'checkpoint') await snapshots.capture('refresh');
			},
		} as unknown as Sessions;
		const actions = new ForgeActions(store.root, sessions, new Forge(runner)),
			first = await actions.read(task, true),
			scope = first.scopes[0]!;
		expect(scope.blockers).toEqual([]);
		const before = calls.length;
		await actions.read(task, false);
		expect(calls).toHaveLength(before);
		const draft = await actions.preparePR(task, scope.scope.id);
		expect(draft.title).toBe('Feature title');
		const result = await actions.createPR(task, draft.id, {
			title: 'Reviewed title',
			body: 'Reviewed\n\nbody',
			branch: 'feature',
			web: false,
		});
		expect(result.scopes[0]?.pr).toMatchObject({ number: 12, title: 'Reviewed title' });
		expect((await store.task(task)).pullRequests?.[scope.scope.id]?.number).toBe(12);
		expect(await gitText(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
			await gitText(repo, ['rev-parse', 'HEAD'])
		);
		expect(calls.find((call) => call.args[1] === 'create')?.input).toBe('Reviewed\n\nbody');
		// spec/pull-requests-and-ci#from-into: an open PR of the branch no longer shuts the dialog — the pair says why it cannot be created.
		const again = await actions.preparePR(task, scope.scope.id);
		expect(await actions.checkPR(task, again.id, { head: 'feature', base: 'main' })).toMatchObject({
			reason: 'A pull request is already open',
			open: 12,
		});
		actions.discard(task, again.id);
		await writeFile(join(repo, 'file'), 'follow-up');
		await gitText(repo, ['commit', '-am', 'Follow up']);
		const push = await actions.preparePush(task, scope.scope.id);
		expect(push.pr?.number).toBe(12);
		expect(push.steps[0]?.commits[0]?.subject).toBe('Follow up');
		await actions.push(task, push.id);
		expect(await gitText(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
			await gitText(repo, ['rev-parse', 'HEAD'])
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it('reviews and pushes submodules before their parent, stopping on a changed child remote', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-forge-order-')),
		repo = join(dir, 'repo'),
		source = join(dir, 'child'),
		remote = join(dir, 'parent.git'),
		childRemote = join(dir, 'child.git');
	const init = async (path: string) => {
		await mkdir(path);
		await gitText(path, ['init', '-b', 'main']);
		await gitText(path, ['config', 'user.name', 'Fixture']);
		await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(path, 'file'), 'base');
		await gitText(path, ['add', 'file']);
		await gitText(path, ['commit', '-m', 'Baseline']);
	};
	try {
		await init(repo);
		await init(source);
		for (const path of [remote, childRemote]) {
			await mkdir(path);
			await gitText(path, ['init', '--bare', '-b', 'main']);
		}
		await gitText(source, ['remote', 'add', 'origin', childRemote]);
		await gitText(source, ['push', 'origin', 'main']);
		await gitText(repo, [
			'-c',
			'protocol.file.allow=always',
			'submodule',
			'add',
			childRemote,
			'kit',
		]);
		await gitText(repo, ['commit', '-am', 'Add submodule']);
		await gitText(repo, ['remote', 'add', 'origin', remote]);
		await gitText(repo, ['push', '-u', 'origin', 'main']);
		await gitText(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
		await gitText(repo, ['switch', '-c', 'feature']);
		const child = join(repo, 'kit');
		await gitText(child, ['config', 'user.name', 'Fixture']);
		await gitText(child, ['config', 'user.email', 'fixture@example.invalid']);
		await gitText(child, ['switch', '-c', 'feature']);
		await writeFile(join(child, 'file'), 'child update');
		await gitText(child, ['commit', '-am', 'Child update']);
		await gitText(repo, ['commit', '-am', 'Update submodule pointer']);
		const store = await SessionStore.at(join(dir, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Publish modules', 'claude'),
			snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		const actions = new ForgeActions(
				store.root,
				{} as Sessions,
				new Forge(async () => ({ code: 1, stdout: '', stderr: 'You are not logged in' }))
			),
			read = await actions.read(task, false),
			parent = read.scopes.find((item) => item.scope.name === '.')!;
		expect(parent.git.warnings).toEqual(['kit']);
		const draft = await actions.preparePush(task, parent.scope.id);
		expect(draft.steps.map((step) => step.name)).toEqual(['kit', 'repo']);
		await gitText(child, ['remote', 'set-url', 'origin', join(dir, 'changed.git')]);
		await expect(actions.push(task, draft.id)).rejects.toThrow('remote changed');
		await expect(
			gitText(remote, ['rev-parse', '--verify', 'refs/heads/feature'])
		).rejects.toThrow();
		await gitText(child, ['remote', 'set-url', 'origin', childRemote]);
		const result = await actions.push(task, draft.id);
		expect(await gitText(childRemote, ['rev-parse', 'refs/heads/feature'])).toBe(
			await gitText(repo, ['rev-parse', 'HEAD:kit'])
		);
		expect(await gitText(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
			await gitText(repo, ['rev-parse', 'HEAD'])
		);
		expect(result.scopes.find((item) => item.scope.name === '.')?.git.warnings).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it('automatically branches reviewed commits on main, preserves local edits and retries the same branch', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-pr-auto-')),
		repo = join(dir, 'repo'),
		remote = join(dir, 'remote.git');
	try {
		await mkdir(repo);
		await mkdir(remote);
		await gitText(remote, ['init', '--bare', '-b', 'main']);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'file'), 'base\n');
		await gitText(repo, ['add', '.']);
		await gitText(repo, ['commit', '-m', 'Baseline']);
		await gitText(repo, ['remote', 'add', 'origin', remote]);
		await gitText(repo, ['push', '-u', 'origin', 'main']);
		const base = await gitText(repo, ['rev-parse', 'HEAD']);
		await writeFile(join(repo, 'file'), 'reviewed\n');
		await gitText(repo, ['commit', '-am', 'Reviewed work']);
		const reviewed = await gitText(repo, ['rev-parse', 'HEAD']);
		await writeFile(join(repo, 'file'), 'staged\n');
		await gitText(repo, ['add', 'file']);
		await writeFile(join(repo, 'file'), 'unstaged\n');
		await writeFile(join(repo, 'untracked'), 'keep me');
		const status = await gitText(repo, ['status', '--porcelain']),
			index = await gitText(repo, ['write-tree']);
		const store = await SessionStore.at(join(dir, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Useful work', 'claude'),
			snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		let active = false,
			fail = true,
			prs: unknown[] = [];
		let creates = 0;
		const runner: GhRunner = async (_, args) => {
			if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
			if (args[0] === 'repo')
				return {
					code: 0,
					stdout: JSON.stringify({
						nameWithOwner: 'fixture/repo',
						url: 'https://github.com/fixture/repo',
						defaultBranchRef: { name: 'main' },
					}),
					stderr: '',
				};
			if (args[1] === 'list') return { code: 0, stdout: JSON.stringify(prs), stderr: '' };
			if (args[1] === 'view')
				return {
					code: 0,
					stdout: JSON.stringify({ ...(prs[0] as object), mergeable: 'MERGEABLE' }),
					stderr: '',
				};
			if (args[1] === 'checks') return { code: 0, stdout: '[]', stderr: '' };
			if (args[1] === 'create') {
				creates++;
				if (fail) return { code: 1, stdout: '', stderr: 'Fixture creation failed' };
				prs = [
					{
						number: 17,
						url: 'https://github.com/fixture/repo/pull/17',
						title: 'Useful work',
						state: 'OPEN',
						headRefName: args[args.indexOf('--head') + 1],
						baseRefName: 'main',
					},
				];
				return { code: 0, stdout: 'https://github.com/fixture/repo/pull/17\n', stderr: '' };
			}
			throw new Error('Unexpected command');
		};
		const sessions = {
			activity: async () => ({ connected: active, busy: active, started: true }),
			command: async (key: TaskKey, command: SessionCommand) => {
				if (command.kind === 'recordPullRequest')
					await store.updateTask(key, { pullRequests: { [command.scopeId]: command.pr } });
				else if (command.kind === 'checkpoint') await snapshots.capture('refresh');
			},
		} as unknown as Sessions;
		const actions = new ForgeActions(store.root, sessions, new Forge(runner)),
			scope = (await actions.read(task, true)).scopes[0]!;
		expect(scope.blockers).toEqual([]);
		const cancelled = await actions.preparePR(task, scope.scope.id);
		expect(cancelled).toMatchObject({
			createsBranch: true,
			hasUncommittedChanges: true,
			canRename: false,
		});
		actions.discard(task, cancelled.id);
		expect(await gitText(repo, ['branch', '--show-current'])).toBe('main');
		await expect(
			gitText(repo, ['show-ref', '--verify', `refs/heads/${cancelled.branch}`])
		).rejects.toThrow();
		const draft = await actions.preparePR(task, scope.scope.id),
			input = { title: draft.title, body: draft.body, branch: draft.branch, web: false };
		expect(draft.branch).toMatch(/^brigadir\/useful-work-[a-f0-9]{8}$/);
		expect(draft.steps[0]).toMatchObject({ branch: draft.branch, published: false, count: 1 });
		active = true;
		await expect(actions.createPR(task, draft.id, input)).rejects.toThrow('Wait for the agent');
		expect(await gitText(repo, ['branch', '--show-current'])).toBe('main');
		active = false;
		await gitText(repo, ['config', 'remote.origin.pushurl', join(dir, 'different.git')]);
		await expect(actions.createPR(task, draft.id, input)).rejects.toThrow('remote changed');
		await gitText(repo, ['config', '--unset', 'remote.origin.pushurl']);
		await expect(actions.createPR(task, draft.id, input)).rejects.toThrow(
			'Fixture creation failed'
		);
		expect(await gitText(repo, ['branch', '--show-current'])).toBe(draft.branch);
		expect(await gitText(repo, ['rev-parse', 'refs/heads/main'])).toBe(reviewed);
		expect(await gitText(remote, ['rev-parse', 'refs/heads/main'])).toBe(base);
		expect(await gitText(remote, ['rev-parse', `refs/heads/${draft.branch}`])).toBe(reviewed);
		expect(await gitText(repo, ['status', '--porcelain'])).toBe(status);
		expect(await gitText(repo, ['write-tree'])).toBe(index);
		expect(creates).toBe(1);
		fail = false;
		const result = await actions.createPR(task, draft.id, input);
		expect(result.scopes[0]?.pr?.number).toBe(17);
		expect(creates).toBe(2);
		expect(await gitText(repo, ['branch', '--show-current'])).toBe(draft.branch);
		expect(await gitText(repo, ['status', '--porcelain'])).toBe(status);
		expect(await gitText(repo, ['write-tree'])).toBe(index);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it('records a known pull request once: refreshes that repeat it send nothing, a changed state is recorded (spec/tasks#lock-registry)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-forge-dedupe-')),
		repo = join(dir, 'repo'),
		remote = join(dir, 'remote.git');
	try {
		await mkdir(repo);
		await mkdir(remote);
		await gitText(remote, ['init', '--bare', '-b', 'main']);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'file'), 'base');
		await gitText(repo, ['add', 'file']);
		await gitText(repo, ['commit', '-m', 'Baseline']);
		await gitText(repo, ['remote', 'add', 'origin', remote]);
		await gitText(repo, ['push', '-u', 'origin', 'main']);
		await gitText(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
		const store = await SessionStore.at(join(dir, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Merged', 'claude');
		await store.setStatus(task, 'done');
		const snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		await gitText(repo, ['switch', '-c', 'feature']);
		await writeFile(join(repo, 'file'), 'feature');
		await gitText(repo, ['commit', '-am', 'Add feature']);
		await snapshots.capture('refresh');
		let state = 'MERGED';
		const runner: GhRunner = async (_, args) => {
			if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
			if (args[0] === 'repo')
				return {
					code: 0,
					stdout: JSON.stringify({
						nameWithOwner: 'fixture/repo',
						url: 'https://github.com/fixture/repo',
						defaultBranchRef: { name: 'main' },
					}),
					stderr: '',
				};
			const pr = {
				number: 1065,
				url: 'https://github.com/fixture/repo/pull/1065',
				title: 'Merged',
				state,
				headRefName: 'feature',
				baseRefName: 'main',
			};
			if (args[1] === 'list') return { code: 0, stdout: JSON.stringify([pr]), stderr: '' };
			if (args[1] === 'view')
				return { code: 0, stdout: JSON.stringify({ ...pr, mergeable: 'UNKNOWN' }), stderr: '' };
			if (args[1] === 'checks') return { code: 0, stdout: '[]', stderr: '' };
			throw new Error('Unexpected command');
		};
		const records: PRRef[] = [];
		const sessions = {
			activity: async () => ({ connected: false, busy: false, started: false }),
			command: async (key: TaskKey, command: SessionCommand) => {
				if (command.kind === 'recordPullRequest') {
					records.push(command.pr);
					await store.updateTask(key, { pullRequests: { [command.scopeId]: command.pr } });
				}
			},
		} as unknown as Sessions;
		const actions = new ForgeActions(store.root, sessions, new Forge(runner));
		// task.json is read back with sorted keys, GitHub answers in another order: only fields decide.
		for (let index = 0; index < 4; index++) await actions.read(task, true, true);
		expect(records).toHaveLength(1);
		const scopeId = (await actions.read(task, false)).scopes[0]!.scope.id;
		expect(Object.keys((await store.task(task)).pullRequests![scopeId]!)).toEqual([
			'base',
			'head',
			'number',
			'state',
			'title',
			'url',
		]);
		state = 'CLOSED';
		await actions.read(task, true, true);
		await actions.read(task, true, true);
		expect(records.map((pr) => pr.state)).toEqual(['MERGED', 'CLOSED']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it('spec/pull-requests-and-ci#from-into: a PR from another branch into a chosen base goes out at the checked SHA, without a checkout', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-pr-pair-')),
		repo = join(dir, 'repo'),
		remote = join(dir, 'remote.git');
	try {
		await mkdir(repo);
		await mkdir(remote);
		await gitText(remote, ['init', '--bare', '-b', 'main']);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'file'), 'base');
		await gitText(repo, ['add', 'file']);
		await gitText(repo, ['commit', '-m', 'Baseline']);
		await gitText(repo, ['remote', 'add', 'origin', remote]);
		await gitText(repo, ['push', '-u', 'origin', 'main']);
		await gitText(repo, ['push', 'origin', 'main:stage']);
		await gitText(repo, ['fetch', 'origin']);
		await gitText(repo, ['switch', '-c', 'other']);
		await writeFile(join(repo, 'other'), 'other');
		await gitText(repo, ['add', 'other']);
		await gitText(repo, ['commit', '-m', 'Other work']);
		await gitText(repo, ['switch', '-c', 'feature', 'main']);
		await writeFile(join(repo, 'file'), 'feature');
		await gitText(repo, ['commit', '-am', 'Feature work']);
		const store = await SessionStore.at(join(dir, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Feature title', 'claude');
		await (await Snapshots.open(store, task)).capture('baseline');
		const creates: string[][] = [];
		const runner: GhRunner = async (_, args) => {
			if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
			if (args[0] === 'repo')
				return {
					code: 0,
					stdout: JSON.stringify({
						nameWithOwner: 'fixture/repo',
						url: 'https://github.com/fixture/repo',
						defaultBranchRef: { name: 'main' },
					}),
					stderr: '',
				};
			if (args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
			if (args[1] === 'create') {
				creates.push(args);
				return { code: 0, stdout: 'https://github.com/fixture/repo/pull/30\n', stderr: '' };
			}
			throw new Error('Unexpected command');
		};
		const recorded: SessionCommand[] = [];
		const sessions = {
			activity: async () => ({ connected: false, busy: false, started: false }),
			command: async (_: TaskKey, command: SessionCommand) => {
				recorded.push(command);
			},
		} as unknown as Sessions;
		const actions = new ForgeActions(store.root, sessions, new Forge(runner)),
			scope = (await actions.read(task, true)).scopes[0]!,
			draft = await actions.preparePR(task, scope.scope.id);
		expect(draft).toMatchObject({ branch: 'feature', base: 'main' });
		expect(draft.bases).toEqual(expect.arrayContaining(['main', 'stage']));
		expect(draft.bases).not.toContain('HEAD');
		expect(draft.heads.map((entry) => entry.name)).toEqual(
			expect.arrayContaining(['feature', 'other', 'main'])
		);
		expect(await actions.checkPR(task, draft.id, { head: 'main', base: 'main' })).toMatchObject({
			reason: 'Choose different branches',
		});
		expect(await actions.checkPR(task, draft.id, { head: 'main', base: 'stage' })).toMatchObject({
			ahead: 0,
			reason: 'No commits ahead of base',
		});
		await expect(actions.checkPR(task, draft.id, { head: 'other', base: 'nope' })).rejects.toThrow(
			'Base branch is unavailable'
		);
		const pair = await actions.checkPR(task, draft.id, { head: 'other', base: 'stage' });
		expect(pair).toMatchObject({ ahead: 1, reason: null, open: null, title: 'Other work' });
		expect(pair.steps).toMatchObject([{ branch: 'other', published: false, count: 1 }]);
		// A commit after the check is not what the dialog showed: Create PR refuses until the pair is checked again.
		const seen = await gitText(repo, ['rev-parse', 'refs/heads/other']),
			unseen = await gitText(repo, [
				'commit-tree',
				await gitText(repo, ['rev-parse', 'other^{tree}']),
				'-p',
				seen,
				'-m',
				'Unseen',
			]);
		await gitText(repo, ['update-ref', 'refs/heads/other', unseen]);
		const input = {
			title: 'Other',
			body: 'Body',
			branch: 'feature',
			head: 'other',
			base: 'stage',
			web: false,
		};
		await expect(actions.createPR(task, draft.id, input)).rejects.toThrow('The branch changed');
		expect(creates).toHaveLength(0);
		await gitText(repo, ['update-ref', 'refs/heads/other', seen]);
		await actions.checkPR(task, draft.id, { head: 'other', base: 'stage' });
		await actions.createPR(task, draft.id, input);
		expect(creates[0]).toEqual(expect.arrayContaining(['--head', 'other', '--base', 'stage']));
		expect(await gitText(remote, ['rev-parse', 'refs/heads/other'])).toBe(
			await gitText(repo, ['rev-parse', 'refs/heads/other'])
		);
		expect(await gitText(repo, ['branch', '--show-current'])).toBe('feature');
		expect(await gitText(repo, ['config', 'branch.other.remote'])).toBe('origin');
		expect(recorded.some((command) => command.kind === 'recordPullRequest')).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
