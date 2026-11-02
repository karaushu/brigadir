import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessCoordinator, SessionStore } from '@brigadir/persistence';
import { Worktrees } from './worktrees';
import { Snapshots } from './snapshots';
import { gitText } from './command';
import { discoverScopes, worktreePaths } from './scopes';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repository(path: string) {
	await mkdir(path, { recursive: true });
	await gitText(path, ['init', '-b', 'main']);
	await gitText(path, ['config', 'user.name', 'Fixture']);
	await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
	await writeFile(join(path, 'package.json'), '{}\n');
	await gitText(path, ['add', '.']);
	await gitText(path, ['commit', '-m', 'Initial']);
}
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-worktrees-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await repository(repo);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Isolated', 'claude'),
		processes = new ProcessCoordinator(resolve('apps/desktop/out/services/process-owner'));
	return { root, repo, store, task, trees: new Worktrees(store, processes) };
}
it('assembles root, submodule and ignored nested repo before setup, leaves the source index alone, and removes only managed copies', async () => {
	const { root, repo, store, task, trees } = await setup(),
		module = join(root, 'module');
	await repository(module);
	await gitText(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'kit']);
	await writeFile(join(repo, '.gitignore'), 'apps/\n');
	await gitText(repo, ['add', '.']);
	await gitText(repo, ['commit', '-m', 'Submodule']);
	const nested = join(repo, 'apps/admin');
	await repository(nested);
	const before = await gitText(repo, ['status', '--porcelain=v1']),
		events: string[] = [];
	const state = await trees.prepare(
		task,
		{
			branch: 'brigadir/isolated',
			baseRef: 'main',
			setupCommand:
				'test -f kit/package.json && test -f apps/admin/package.json && echo ready > setup.txt',
		},
		(value) => {
			events.push(value.step);
		}
	);
	expect(state.state).toBe('ready');
	expect(state.repositories.map((item) => item.relativePath)).toEqual(['', 'kit', 'apps/admin']);
	expect(await readFile(join(state.root, 'setup.txt'), 'utf8')).toBe('ready\n');
	expect(events.indexOf('kit')).toBeLessThan(events.indexOf('apps/admin'));
	expect(events.lastIndexOf('apps/admin')).toBeLessThan(events.indexOf('setup'));
	expect(await gitText(repo, ['status', '--porcelain=v1'])).toBe(before);
	for (const entry of state.repositories)
		expect(await gitText(join(state.root, entry.relativePath), ['branch', '--show-current'])).toBe(
			'brigadir/isolated'
		);
	expect((await trees.prepare(task, { branch: state.branch, baseRef: state.baseRef })).state).toBe(
		'ready'
	);
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
	expect(snapshots.current.scopes.map((scope) => [scope.name, scope.kind])).toEqual([
		['.', 'root'],
		['apps/admin', 'nested'],
		['kit', 'submodule'],
	]);
	expect(snapshots.current.checkpoints[0]?.trees).toHaveLength(3);
	await trees.remove(task);
	expect(await trees.read(task)).toBeNull();
	await expect(readFile(join(state.root, 'setup.txt'))).rejects.toThrow();
	for (const entry of state.repositories) {
		expect(await worktreePaths(entry.source)).not.toContain(join(state.root, entry.relativePath));
		expect(
			await gitText(entry.source, ['show-ref', '--verify', `refs/heads/${state.branch}`])
		).toBeTruthy();
	}
	expect(await readFile(join(repo, 'package.json'), 'utf8')).toBe('{}\n');
	expect(await readFile(join(nested, 'package.json'), 'utf8')).toBe('{}\n');
}, 20000);
it('copies ignored .env files of every repo before setup, only when asked, and keeps tracked and existing ones (spec/git#worktree-env)', async () => {
	const { root, repo, store, task, trees } = await setup();
	await writeFile(join(repo, '.gitignore'), '.env*\n!.env.example\nnode_modules/\napps/\n');
	await writeFile(join(repo, '.env.example'), 'TRACKED=1\n');
	await gitText(repo, ['add', '.']);
	await gitText(repo, ['commit', '-m', 'Ignore env']);
	await writeFile(join(repo, '.env'), 'ROOT=1\n');
	await writeFile(join(repo, '.env.local'), 'LOCAL=1\n');
	await writeFile(join(repo, '.envrc'), 'use node\n');
	await mkdir(join(repo, 'web'), { recursive: true });
	await writeFile(join(repo, 'web/.env.development.local'), 'WEB=1\n');
	await mkdir(join(repo, 'node_modules/pkg'), { recursive: true });
	await writeFile(join(repo, 'node_modules/pkg/.env'), 'DEP=1\n');
	const secret = join(root, 'secret.env');
	await writeFile(secret, 'LINKED=1\n');
	await mkdir(join(repo, 'linked'));
	await symlink(secret, join(repo, 'linked/.env'));
	const nested = join(repo, 'apps/admin');
	await repository(nested);
	await writeFile(join(nested, '.gitignore'), '.env.local\n');
	await gitText(nested, ['add', '.']);
	await gitText(nested, ['commit', '-m', 'Ignore']);
	await writeFile(join(nested, '.env.local'), 'ADMIN=1\n');
	const state = await trees.prepare(task, {
		branch: 'brigadir/env',
		baseRef: 'main',
		copyEnvFiles: true,
		setupCommand: 'cat .env apps/admin/.env.local > setup.txt',
	});
	expect(await readFile(join(state.root, 'setup.txt'), 'utf8')).toBe('ROOT=1\nADMIN=1\n');
	for (const [path, text] of <[string, string][]>[
		['.env.local', 'LOCAL=1\n'],
		['.envrc', 'use node\n'],
		['web/.env.development.local', 'WEB=1\n'],
		['linked/.env', 'LINKED=1\n'],
		['.env.example', 'TRACKED=1\n'],
	])
		expect(await readFile(join(state.root, path), 'utf8')).toBe(text);
	await expect(readFile(join(state.root, 'node_modules/pkg/.env'))).rejects.toThrow();
	expect(await gitText(state.root, ['status', '--porcelain=v1'])).toBe('?? setup.txt');
	await writeFile(join(state.root, '.env'), 'EDITED=1\n');
	const { copyEnvFiles } = await import('./worktrees');
	expect(await copyEnvFiles(repo, state.root)).toEqual([]);
	expect(await readFile(join(state.root, '.env'), 'utf8')).toBe('EDITED=1\n');
	const other = await store.createTask(task.projectId, 'Plain', 'claude'),
		plain = await trees.prepare(other, { branch: 'brigadir/no-env', baseRef: 'main' });
	await expect(readFile(join(plain.root, '.env'))).rejects.toThrow();
}, 20000);
it('records setup failure with logs and retries on the same copies and branch', async () => {
	const { repo, store, task, trees } = await setup();
	await expect(
		trees.prepare(task, {
			branch: 'brigadir/retry',
			baseRef: 'main',
			setupCommand: 'echo setup-failed; exit 7',
		})
	).rejects.toThrow('Setup command failed (7)');
	const failed = (await trees.read(task))!;
	expect(failed.state).toBe('failed');
	expect(failed.repositories.every((repo) => repo.ready)).toBe(true);
	expect(await readFile(join(await store.taskDir(task), 'worktree-setup.log'), 'utf8')).toContain(
		'setup-failed'
	);
	const before = await worktreePaths(repo);
	const ready = await trees.prepare(task, {
		branch: failed.branch,
		baseRef: 'main',
		setupCommand: 'echo recovered > ready.txt',
	});
	expect(ready.root).toBe(failed.root);
	expect(await worktreePaths(repo)).toEqual(before);
	expect(await readFile(join(ready.root, 'ready.txt'), 'utf8')).toBe('recovered\n');
	await trees.remove(task);
});
it('validates options and future manifests without changing them, and does not adopt an existing branch or directory', async () => {
	const { repo, store, task, trees } = await setup();
	await expect(trees.prepare(task, { branch: 'bad..branch', baseRef: 'main' })).rejects.toThrow(
		'Invalid worktree options'
	);
	await expect(trees.prepare(task, { branch: 'main', baseRef: 'main' })).rejects.toThrow(
		'already exists'
	);
	const path = join(await store.taskDir(task), 'worktree.json'),
		future = '{"schemaVersion":8,"payload":"keep"}';
	await writeFile(path, future);
	await expect(trees.prepare(task, { branch: 'brigadir/test', baseRef: 'main' })).rejects.toThrow(
		'unsupported_schema'
	);
	await expect(trees.remove(task)).rejects.toThrow();
	expect(await readFile(path, 'utf8')).toBe(future);
	await rm(path);
	const destination = join(store.root, 'worktrees', task.projectId, task.id);
	await mkdir(destination, { recursive: true });
	await writeFile(join(destination, 'mine'), 'keep');
	await expect(trees.prepare(task, { branch: 'brigadir/test', baseRef: 'main' })).rejects.toThrow(
		'already exists without a manifest'
	);
	expect(await readFile(join(destination, 'mine'), 'utf8')).toBe('keep');
	expect(await worktreePaths(repo)).toEqual([await realpath(repo)]);
});
it('keeps a failed partial preparation retryable and refuses a linked destination on cleanup', async () => {
	const { root, repo, task, trees } = await setup();
	const nested = join(repo, 'nested');
	await repository(nested);
	await gitText(nested, ['branch', '-m', 'other']);
	await expect(
		trees.prepare(task, { branch: 'brigadir/partial', baseRef: 'main' })
	).rejects.toThrow();
	const failed = (await trees.read(task))!;
	expect(failed.repositories[0]!.ready).toBe(true);
	expect(failed.repositories[1]!.ready).toBe(false);
	await gitText(nested, ['branch', 'main']);
	expect(
		(await trees.prepare(task, { branch: failed.branch, baseRef: failed.baseRef })).state
	).toBe('ready');
	const external = join(root, 'external');
	await mkdir(external);
	await writeFile(join(external, 'keep'), 'keep');
	// An unexpected link must stop cleanup rather than following it into another directory.
	const destination = join(failed.root, 'nested');
	await gitText(nested, ['worktree', 'remove', '--force', destination]);
	await symlink(external, destination);
	await expect(trees.remove(task)).rejects.toThrow('unsafe_path');
	expect(await readFile(join(external, 'keep'), 'utf8')).toBe('keep');
	await rm(destination);
	await trees.remove(task);
});
it('cancels the supervised setup before retrying the same worktree', async () => {
	const { store, task, trees } = await setup(),
		controller = new AbortController();
	const result = trees.prepare(
		task,
		{
			branch: 'brigadir/cancel',
			baseRef: 'main',
			setupCommand: 'echo started > started; sleep 30',
		},
		() => {},
		controller.signal
	);
	const rejected = expect(result).rejects.toThrow('Setup command failed (125)');
	await expect
		.poll(async () => {
			const state = await trees.read(task);
			return state ? readFile(join(state.root, 'started'), 'utf8').catch(() => null) : null;
		})
		.toBe('started\n');
	controller.abort();
	await rejected;
	const state = (await trees.read(task))!;
	expect(state.state).toBe('failed');
	const processes = new ProcessCoordinator(resolve('apps/desktop/out/services/process-owner'));
	expect(await processes.identity(state.setupOwner!.pid)).toBeNull();
	expect(
		(
			await trees.prepare(task, {
				branch: state.branch,
				baseRef: state.baseRef,
				setupCommand: 'echo resumed',
			})
		).state
	).toBe('ready');
	await trees.remove(task);
});
it('fetches the requested origin base rather than copying the current branch or index', async () => {
	const { root, repo, task, trees } = await setup(),
		remote = join(root, 'remote.git');
	await gitText(root, ['clone', '--bare', repo, remote]);
	await gitText(repo, ['remote', 'add', 'origin', remote]);
	await gitText(repo, ['checkout', '-b', 'author-work']);
	await writeFile(join(repo, 'only-author.txt'), 'author');
	await gitText(repo, ['add', '.']);
	await gitText(repo, ['commit', '-m', 'Author branch']);
	await writeFile(join(repo, 'staged.txt'), 'staged');
	await gitText(repo, ['add', 'staged.txt']);
	const index = await gitText(repo, ['diff', '--cached']);
	const state = await trees.prepare(task, {
		branch: 'brigadir/from-origin',
		baseRef: 'origin/main',
	});
	await expect(readFile(join(state.root, 'only-author.txt'))).rejects.toThrow();
	await expect(readFile(join(state.root, 'staged.txt'))).rejects.toThrow();
	expect(await gitText(repo, ['branch', '--show-current'])).toBe('author-work');
	expect(await gitText(repo, ['diff', '--cached'])).toBe(index);
	await trees.remove(task);
});
it('counts uncommitted files per repo without the submodule echo and prepares again on its own released branch (spec/tasks#delete-task)', async () => {
	const { root, repo, store, task, trees } = await setup(),
		module = join(root, 'module');
	await repository(module);
	await gitText(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'kit']);
	await gitText(repo, ['commit', '-m', 'Submodule']);
	expect(await trees.uncommitted(task)).toBeNull();
	const state = await trees.prepare(task, { branch: 'brigadir/released', baseRef: 'main' });
	expect(await trees.uncommitted(task)).toBe(0);
	await writeFile(join(state.root, 'package.json'), '{"changed":true}\n');
	await mkdir(join(state.root, 'new'));
	await writeFile(join(state.root, 'new/a.txt'), 'a');
	await writeFile(join(state.root, 'new/b.txt'), 'b');
	await writeFile(join(state.root, 'kit/package.json'), '{"kit":true}\n');
	expect(await trees.uncommitted(task)).toBe(4);
	await trees.remove(task);
	expect(await trees.uncommitted(task)).toBeNull();
	// The task's own branch is taken again; a branch it never owned is still refused.
	expect((await trees.prepare(task, { branch: 'brigadir/released', baseRef: 'main' })).state).toBe(
		'ready'
	);
	await trees.remove(task);
	await gitText(repo, ['branch', 'brigadir/foreign']);
	await expect(
		trees.prepare(task, { branch: 'brigadir/foreign', baseRef: 'main' })
	).rejects.toThrow('already exists');
	await store.task(task);
}, 20000);
