import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore } from '@brigadir/persistence';
import { Preparations } from './preparations';
import { LaunchSettingsStore } from './launch-settings';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-preparations-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'original\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		settings = new LaunchSettingsStore(store.root),
		changes: string[] = [];
	const preparations = new Preparations(store.root, resolve('apps/desktop/out/services'), (key) => {
		changes.push(key.id);
	});
	return { root, repo, git, store, project, settings, preparations, changes };
}
it('persists project choices, refuses unavailable scopes and keeps future settings intact', async () => {
	const { repo, store, project, settings } = await setup();
	const original = await settings.read(project.id);
	expect(original.scopes).toHaveLength(1);
	expect(original.scopes[0]!.selected).toBe(true);
	await settings.save(project.id, {
		...original,
		branch: 'unused',
		isolation: 'worktree',
		baseRef: 'main',
		scopes: original.scopes.map((scope) => ({ ...scope, selected: false })),
	});
	const nested = join(repo, 'nested');
	await mkdir(nested);
	await promisify(execFile)('git', ['init', '-q'], { cwd: nested });
	const next = await settings.read(project.id);
	expect(next.scopes.find((scope) => scope.name === '.')?.selected).toBe(false);
	expect(next.scopes.find((scope) => scope.name === 'nested')).toMatchObject({ selected: false });
	await expect(
		settings.resolve(project.id, {
			...next,
			branch: '',
			scopes: [{ ...next.scopes[0]!, id: '0000000000000000' }],
		})
	).rejects.toThrow('unavailable');
	const path = join(store.root, 'projects', project.id, 'workspace.json'),
		future = '{"schemaVersion":44,"settings":{}}';
	await writeFile(path, future);
	await expect(settings.save(project.id, { ...original, branch: '' })).rejects.toThrow();
	expect(await readFile(path, 'utf8')).toBe(future);
});
it('prepares once, publishes progress, resolves all task file access to the managed root and preserves author changes', async () => {
	const { repo, git, store, project, settings, preparations, changes } = await setup();
	await writeFile(join(repo, 'file.txt'), 'author staged\n');
	await git('add', '.');
	await writeFile(join(repo, 'file.txt'), 'author working\n');
	const before = (await git('status', '--porcelain')).stdout;
	const launch = {
		...(await settings.read(project.id)),
		isolation: 'worktree' as const,
		branch: 'brigadir/integration',
		baseRef: 'main',
		setupCommand: 'echo setup-ready; echo prepared > setup.txt',
	};
	const task = await store.createTask(
		project.id,
		'Isolated',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	await expect(store.projectForTask(task)).rejects.toThrow();
	const first = preparations.prepare(task);
	expect(preparations.prepare(task)).toBe(first);
	await first;
	const managed = await store.projectForTask(task);
	expect(managed.path).not.toBe(repo);
	expect(await readFile(join(managed.path, 'file.txt'), 'utf8')).toBe('original\n');
	expect(await readFile(join(managed.path, 'setup.txt'), 'utf8')).toBe('prepared\n');
	expect(await store.task(task)).toMatchObject({
		status: 'queued',
		preparation: { state: 'ready' },
	});
	expect(await preparations.log(task)).toContain('setup-ready');
	expect(changes.length).toBeGreaterThan(3);
	expect((await git('status', '--porcelain')).stdout).toBe(before);
	await store.setStatus(task, 'done');
	await preparations.prepare(task);
	expect((await store.task(task)).status).toBe('done');
	await preparations.remove(task);
	await expect(readFile(join(managed.path, 'setup.txt'))).rejects.toThrow();
	expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('author working\n');
}, 15000);
it('discards a prepared worktree, keeps the task and its branch, and refuses while the task runs', async () => {
	const { repo, git, store, project, settings, preparations } = await setup();
	const launch = {
		...(await settings.read(project.id)),
		isolation: 'worktree' as const,
		branch: 'brigadir/discard',
		baseRef: 'main',
		setupCommand: '',
	};
	const task = await store.createTask(
		project.id,
		'Isolated',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	await preparations.prepare(task);
	const managed = await store.projectForTask(task);
	expect(await readFile(join(managed.path, 'file.txt'), 'utf8')).toBe('original\n');
	await store.setStatus(task, 'working');
	await expect(preparations.discard(task)).rejects.toThrow(
		'Stop the task before removing its worktree'
	);
	await store.setStatus(task, 'completed');
	await preparations.discard(task);
	expect((await store.task(task)).preparation).toBeUndefined();
	expect((await store.task(task)).worktreeBranch).toBeUndefined();
	expect((await store.task(task)).title).toBe('Isolated');
	await expect(readFile(join(managed.path, 'file.txt'), 'utf8')).rejects.toThrow();
	expect((await git('branch', '--list', 'brigadir/discard')).stdout).toContain('brigadir/discard');
	const plain = await store.createTask(
		project.id,
		'In place',
		'claude',
		'gui',
		'New task',
		'queued',
		{ ...(await settings.read(project.id)), branch: '' }
	);
	await expect(preparations.discard(plain)).rejects.toThrow('The task has no worktree');
});
it('cancels setup, exposes failure and its log, retries the same worktree and recovers interrupted metadata', async () => {
	const { root, store, project, settings, preparations } = await setup();
	const launch = {
		...(await settings.read(project.id)),
		isolation: 'worktree' as const,
		branch: 'brigadir/cancel',
		baseRef: 'main',
		setupCommand:
			'if test ! -f attempt; then touch attempt; echo setup-running; sleep 30; fi; echo finished',
	};
	const task = await store.createTask(
		project.id,
		'Cancel',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	const first = preparations.prepare(task);
	const failed = expect(first).rejects.toThrow();
	await expect.poll(() => preparations.log(task)).toContain('setup-running');
	expect(await preparations.cancel(task)).toBe(true);
	await failed;
	expect(await store.task(task)).toMatchObject({
		status: 'interrupted',
		preparation: { state: 'failed' },
	});
	await preparations.prepare(task);
	expect((await store.task(task)).preparation?.state).toBe('ready');
	expect(await preparations.log(task)).toContain('finished');
	await store.setStatus(task, 'preparing');
	await preparations.recover();
	expect(await store.task(task)).toMatchObject({
		status: 'interrupted',
		preparation: { state: 'failed' },
	});
	const log = join(await store.taskDir(task), 'worktree-setup.log');
	await rm(log);
	await writeFile(join(root, 'private'), 'not a setup log');
	await symlink(join(root, 'private'), log);
	await expect(preparations.log(task)).rejects.toThrow();
	await preparations.remove(task);
}, 15000);
it('keeps hidden read-only nested repositories as context in an isolated task', async () => {
	const { repo, git, store, project, settings, preparations } = await setup();
	await writeFile(join(repo, '.gitignore'), 'context/\n');
	await git('add', '.gitignore');
	await git('commit', '-m', 'Ignore context');
	const child = join(repo, 'context');
	await mkdir(child);
	const childGit = (...args: string[]) => promisify(execFile)('git', args, { cwd: child });
	await childGit('init', '-b', 'main');
	await childGit('config', 'user.name', 'Fixture');
	await childGit('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(child, 'read.txt'), 'context\n');
	await childGit('add', '.');
	await childGit('commit', '-m', 'Context');
	const defaults = await settings.read(project.id);
	const launch = {
		...defaults,
		isolation: 'worktree' as const,
		branch: 'brigadir/hidden-context',
		baseRef: 'main',
		scopes: defaults.scopes.map((scope) =>
			scope.name === 'context' ? { ...scope, selected: false } : scope
		),
	};
	const task = await store.createTask(
		project.id,
		'Context',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	await preparations.prepare(task);
	const managed = await store.projectForTask(task);
	expect(await readFile(join(managed.path, 'context/read.txt'), 'utf8')).toBe('context\n');
	const { Snapshots } = await import('@brigadir/git');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	expect(snapshots.current.scopes.find((scope) => scope.name === 'context')).toMatchObject({
		selected: false,
		available: true,
	});
	const managedScope = snapshots.current.scopes.find((scope) => scope.name === 'context')!,
		sourceScope = launch.scopes.find((scope) => scope.name === 'context')!;
	expect(managedScope.id).not.toBe(sourceScope.id);
	await snapshots.setScope({ id: managedScope.id, selected: true });
	expect(
		(await store.task(task)).launch!.scopes.find((scope) => scope.name === 'context')
	).toMatchObject({ id: sourceScope.id, selected: true });
	expect(snapshots.current.scopes.find((scope) => scope.name === 'context')!.selected).toBe(true);
	await preparations.remove(task);
	expect(await readFile(join(child, 'read.txt'), 'utf8')).toBe('context\n');
}, 15000);

it('serializes independent project scope controls and collapse without resetting launch defaults', async () => {
	const { project, settings } = await setup();
	const original = await settings.read(project.id),
		id = original.scopes[0]!.id;
	await settings.save(project.id, {
		...original,
		branch: '',
		setupCommand: 'echo setup',
		baseRef: 'main',
	});
	await Promise.all([
		settings.collapse(project.id, true),
		settings.updateScope(project.id, { id, selected: false }),
		settings.updateScope(project.id, { id, selected: false }),
	]);
	expect(await settings.collapsed(project.id)).toBe(true);
	expect(await settings.read(project.id)).toMatchObject({
		baseRef: 'main',
		setupCommand: 'echo setup',
		scopes: [{ id, selected: false }],
	});
	await settings.save(project.id, { ...(await settings.read(project.id)), branch: '' });
	expect(await settings.collapsed(project.id)).toBe(true);
});
it('describes a folder from outside for one task, never the project, and checks it again at launch (spec/projects-and-board#external-folders, spec/projects-and-board#external-folders)', async () => {
	const { repo, project, settings } = await setup();
	const outside = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-outside-')));
	roots.push(outside);
	const backend = join(outside, 'backend');
	await mkdir(backend);
	await promisify(execFile)('git', ['init', '-q'], { cwd: backend });
	const notes = join(outside, 'notes');
	await mkdir(notes);
	await writeFile(join(notes, 'brief.md'), 'context');
	const git = await settings.describeFolder(project.id, backend);
	expect(git).toMatchObject({ kind: 'external', name: 'backend', selected: true, path: backend });
	const plain = await settings.describeFolder(project.id, notes, [{ name: 'notes' }]);
	// A name already taken in the sheet adds the parent folder.
	expect(plain).toMatchObject({
		kind: 'folder',
		name: `${basename(outside)}/notes`,
		selected: true,
	});
	await expect(settings.describeFolder(project.id, join(repo, '.'))).rejects.toThrow(
		'inside the project'
	);
	// The project does not change: defaults are only repos under the root.
	expect((await settings.read(project.id)).scopes.map((scope) => scope.name)).toEqual(['.']);
	const defaults = await settings.read(project.id),
		launch = await settings.resolve(project.id, {
			...defaults,
			branch: '',
			scopes: [...defaults.scopes, git, { ...plain, selected: false }],
		});
	expect(launch.scopes.map((scope) => [scope.name, scope.selected])).toEqual([
		['.', true],
		['backend', true],
	]);
	await settings.save(project.id, launch);
	expect((await settings.read(project.id)).scopes.map((scope) => scope.name)).toEqual(['.']);
	// A forged id does not pass: the path is checked again.
	await expect(
		settings.resolve(project.id, {
			...defaults,
			branch: '',
			scopes: [...defaults.scopes, { ...git, id: '0000000000000000' }],
		})
	).rejects.toThrow('A selected repo is unavailable');
});
it('names an auto branch with the agent, frees a taken name and keeps the derived name when the agent fails (spec/git#agent-branch-names)', async () => {
	const { repo, git, store, project, settings } = await setup();
	await git('branch', 'brigadir/agent-route');
	const answers = ['Agent route', '', ''];
	const calls: string[] = [];
	const preparations = new Preparations(
		store.root,
		resolve('apps/desktop/out/services'),
		() => {},
		async (title, prompt) => {
			calls.push(`${title}|${prompt}`);
			const answer = answers.shift()!;
			if (answer === '') throw new Error('timeout');
			return answer;
		}
	);
	const base = {
		...(await settings.read(project.id)),
		isolation: 'worktree' as const,
		baseRef: 'main',
		setupCommand: '',
	};
	const named = await store.createTask(
		project.id,
		'Add the route',
		'claude',
		'gui',
		'New task',
		'queued',
		{ ...base, branch: 'brigadir/add-route', branchAuto: true }
	);
	await preparations.prepare(named);
	let task = await store.task(named);
	expect(calls[0]).toBe('Add the route|Add the route');
	expect(task.launch).toMatchObject({ branch: 'brigadir/agent-route-2' });
	expect(task.launch?.branchAuto).toBeUndefined();
	expect(task.worktreeBranch).toBe('brigadir/agent-route-2');
	const fallback = await store.createTask(
		project.id,
		'Fix totals',
		'claude',
		'gui',
		'New task',
		'queued',
		{ ...base, branch: 'brigadir/fix-totals', branchAuto: true }
	);
	await preparations.prepare(fallback);
	task = await store.task(fallback);
	expect(task.launch?.branch).toBe('brigadir/fix-totals');
	const manual = await store.createTask(
		project.id,
		'Manual',
		'claude',
		'gui',
		'New task',
		'queued',
		{ ...base, branch: 'brigadir/mine' }
	);
	await preparations.prepare(manual);
	expect(calls).toHaveLength(2);
	expect((await store.task(manual)).launch?.branch).toBe('brigadir/mine');
	expect((await git('branch', '--list', 'brigadir/*')).stdout).toContain('brigadir/agent-route-2');
	void repo;
});

it('switches the branches of a task without isolation once, with its dirty choice, and keeps them out of project settings (spec/git#main-tree-branches)', async () => {
	const { repo, git, store, project, settings, preparations } = await setup();
	await git('branch', 'staging');
	await writeFile(join(repo, 'file.txt'), 'author working\n');
	const defaults = await settings.read(project.id),
		scopeId = defaults.scopes[0]!.id;
	const launch = await settings.resolve(project.id, {
		...defaults,
		branch: '',
		isolation: 'in-place',
		switches: [{ scopeId, branch: 'staging', dirty: 'stash' }],
	});
	expect(launch.switches).toEqual([{ scopeId, branch: 'staging', dirty: 'stash' }]);
	await settings.save(project.id, launch);
	expect(JSON.stringify(await settings.read(project.id))).not.toContain('switches');
	const task = await store.createTask(
		project.id,
		'Fix in staging',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	await preparations.prepare(task);
	expect((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim()).toBe('staging');
	expect((await git('stash', 'list', '--format=%gs')).stdout).toContain('brigadir: main → staging');
	expect(await store.task(task)).toMatchObject({
		status: 'queued',
		preparation: { state: 'ready', step: 'switch' },
	});
	// A start after success does not switch again.
	await git('switch', '-q', 'main');
	await preparations.prepare(task);
	expect((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim()).toBe('main');
	// A dirty tree with no choice fails with the reason and stays as it was.
	const clean = await store.createTask(
		project.id,
		'Clean only',
		'claude',
		'gui',
		'New task',
		'queued',
		{ ...launch, switches: [{ scopeId, branch: 'staging' }] }
	);
	await writeFile(join(repo, 'file.txt'), 'again\n');
	await expect(preparations.prepare(clean)).rejects.toThrow('uncommitted');
	expect(await store.task(clean)).toMatchObject({
		status: 'failed',
		preparation: { state: 'failed', step: 'switch:repo' },
	});
	expect((await git('symbolic-ref', '--short', 'HEAD')).stdout.trim()).toBe('main');
	expect(await readFile(join(repo, 'file.txt'), 'utf8')).toBe('again\n');
});

it('pulls the repos a task without isolation stays on before its start, and starts anyway when a pull cannot fast-forward (spec/git#pull)', async () => {
	const { root, repo, git, store, project, settings, preparations } = await setup();
	const origin = join(root, 'origin.git');
	await promisify(execFile)('git', ['clone', '-q', '--bare', repo, origin]);
	await git('remote', 'add', 'origin', origin);
	await git('fetch', '-q', 'origin');
	await git('branch', '-q', '-u', 'origin/main', 'main');
	const other = join(root, 'other');
	await promisify(execFile)('git', ['clone', '-q', origin, other]);
	const og = (...args: string[]) => promisify(execFile)('git', args, { cwd: other });
	await og('config', 'user.name', 'F');
	await og('config', 'user.email', 'f@x');
	await writeFile(join(other, 'new.txt'), 'n\n');
	await og('add', '.');
	await og('commit', '-qm', 'On origin');
	await og('push', '-q', 'origin', 'main');
	const defaults = await settings.read(project.id),
		scopeId = defaults.scopes[0]!.id;
	const launch = await settings.resolve(project.id, {
		...defaults,
		branch: '',
		isolation: 'in-place',
		pull: [scopeId],
	});
	expect(launch.pull).toEqual([scopeId]);
	const task = await store.createTask(
		project.id,
		'Fresh',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	await preparations.prepare(task);
	expect(await readFile(join(repo, 'new.txt'), 'utf8')).toBe('n\n');
	expect(await store.task(task)).toMatchObject({
		status: 'queued',
		preparation: { state: 'ready' },
	});
	// Diverged: the start goes on without the pull.
	await writeFile(join(other, 'more.txt'), 'm\n');
	await og('add', '.');
	await og('commit', '-qm', 'More');
	await og('push', '-q', 'origin', 'main');
	await writeFile(join(repo, 'local.txt'), 'l\n');
	await git('add', '.');
	await git('commit', '-qm', 'Local');
	const second = await store.createTask(
		project.id,
		'Diverged',
		'claude',
		'gui',
		'New task',
		'queued',
		launch
	);
	await preparations.prepare(second);
	expect(await store.task(second)).toMatchObject({
		status: 'queued',
		preparation: { state: 'ready' },
	});
	await expect(readFile(join(repo, 'more.txt'))).rejects.toThrow();
});
