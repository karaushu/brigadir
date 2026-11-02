import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
const spawned = vi.hoisted(() => ({ git: [] as { cwd: string; args: string[] }[] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: { cwd: string }) => {
			if (command === 'git') spawned.git.push({ cwd: options.cwd, args });
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, gitText, GitError, Snapshots, worktreePaths } = await import('./index');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function init(path: string) {
	await mkdir(path, { recursive: true });
	await git(path, ['init', '-q']);
	await git(path, ['config', 'user.name', 'Fixture']);
	await git(path, ['config', 'user.email', 'fixture@localhost']);
	await writeFile(join(path, 'file.txt'), 'base\n');
	await git(path, ['add', '-A']);
	await git(path, ['commit', '-qm', 'base']);
}
/** Reference unbatched capture for one scope: one check-ignore per nested repo or worktree, then `add -A` in a fresh index. */
async function reference(root: string, dir: string, children: string[]) {
	const env = { GIT_INDEX_FILE: join(dir, `reference-${Math.random()}`) },
		exclusions: string[] = [];
	await git(root, ['read-tree', 'HEAD'], { env });
	for (const path of new Set([...children, ...(await worktreePaths(root))])) {
		if (!path.startsWith(`${root}/`)) continue;
		const local = relative(root, path);
		try {
			await gitText(root, ['check-ignore', '--quiet', '--', local]);
		} catch (e) {
			if (!(e instanceof GitError) || e.code !== 1) throw e;
			exclusions.push(`:(top,literal,exclude)${local}`);
		}
	}
	await git(root, ['add', '-A', '--', '.', ...exclusions], { env });
	return gitText(root, ['write-tree'], { env });
}
it('captures the same trees with one batched check-ignore and worktree list only where worktrees exist (GIT-07)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-capture-'));
	roots.push(dir);
	const repo = join(dir, 'repo'),
		source = join(dir, 'kit-source');
	await init(repo);
	await init(source);
	await writeFile(join(repo, '.gitignore'), 'ignored/\n');
	await git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'kit']);
	await git(repo, ['add', '-A']);
	await git(repo, ['commit', '-qm', 'kit']);
	await init(join(repo, 'apps/plain'));
	await init(join(repo, 'ignored/repo'));
	await git(repo, ['worktree', 'add', '-q', join(repo, '.wt/one'), '-b', 'one']);
	const kit = join(repo, 'kit');
	await git(kit, ['config', 'user.name', 'Fixture']);
	await git(kit, ['config', 'user.email', 'fixture@localhost']);
	await writeFile(join(kit, 'file.txt'), 'dirty tracked\n');
	await writeFile(join(kit, 'untracked.txt'), 'dirty untracked\n');
	await writeFile(join(repo, 'root.txt'), 'root\n');
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Capture', 'claude');
	const snapshots = await Snapshots.open(store, task),
		children = snapshots.current.scopes
			.filter((scope) => scope.kind !== 'submodule' && scope.kind !== 'root')
			.map((scope) => scope.path);
	expect(snapshots.current.scopes.map((scope) => scope.name).sort()).toEqual([
		'.',
		'apps/plain',
		'ignored/repo',
		'kit',
	]);
	spawned.git.length = 0;
	await snapshots.capture('baseline');
	const top = snapshots.current.scopes.find((scope) => scope.kind === 'root')!,
		tree = () =>
			snapshots.current.checkpoints.at(-1)!.trees.find((item) => item.scopeId === top.id)!.tree;
	expect(tree()).toBe(await reference(top.path, dir, children));
	await writeFile(join(repo, 'root.txt'), 'changed\n');
	spawned.git.length = 0;
	await snapshots.capture('turn');
	const calls = [...spawned.git];
	expect(tree()).toBe(await reference(top.path, dir, children));
	expect(
		calls.filter((call) => call.cwd === top.path && call.args.includes('check-ignore'))
	).toHaveLength(1);
	// Only a repo with linked worktrees (or a worktree itself) needs `worktree list`; plain nested repos and submodules skip it.
	expect(
		calls
			.filter((call) => call.args.includes('worktree'))
			.map((call) => relative(top.path, call.cwd) || '.')
	).toEqual(['.']);
	// A moved submodule HEAD is still recorded, dirty or not; an ignored nested repo stays out.
	await git(kit, ['commit', '-qam', 'moved']);
	await writeFile(join(kit, 'file.txt'), 'dirty again\n');
	await snapshots.capture('turn');
	expect(tree()).toBe(await reference(top.path, dir, children));
	expect(await gitText(repo, ['ls-tree', tree(), 'kit'])).toContain(
		await gitText(kit, ['rev-parse', 'HEAD'])
	);
}, 30000);
/** Reference uncached capture on the same persistent index: both `ls-files` every time. */
async function uncached(root: string, index: string) {
	const env = { GIT_INDEX_FILE: index };
	try {
		await lstat(index);
	} catch {
		await git(root, ['read-tree', 'HEAD'], { env });
	}
	const known = new Set(
			(await git(root, ['ls-files', '--cached', '-z'], { env })).toString('utf8').split('\0')
		),
		missing: string[] = [];
	for (const file of (await git(root, ['ls-files', '--cached', '-z']))
		.toString('utf8')
		.split('\0')
		.filter(Boolean))
		if (
			!known.has(file) &&
			(await lstat(join(root, file)).then(
				() => true,
				() => false
			))
		)
			missing.push(file);
	if (missing.length)
		await git(
			root,
			['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
			{ env, input: missing.join('\0') + '\0' }
		);
	await git(root, ['add', '-A', '--', '.'], { env });
	return gitText(root, ['write-tree'], { env });
}
it('lists an index only when its file changed and captures the same trees (GIT-18)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-listing-')));
	roots.push(dir);
	const repo = join(dir, 'repo');
	await init(repo);
	await writeFile(join(repo, '.gitignore'), '*.log\n');
	await writeFile(join(repo, 'keep.log'), 'forced\n');
	await git(repo, ['add', '-f', '.gitignore', 'keep.log']);
	await git(repo, ['commit', '-qm', 'ignored but tracked']);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Listing', 'claude'),
		snapshots = await Snapshots.open(store, task);
	const reference = join(dir, 'reference-index'),
		listings = () => spawned.git.filter((call) => call.args.includes('ls-files')).length;
	const step = async (change: () => Promise<unknown>) => {
		await change();
		spawned.git.length = 0;
		await snapshots.capture('turn');
		const count = listings();
		expect(snapshots.current.checkpoints.at(-1)!.trees[0]!.tree).toBe(
			await uncached(repo, reference)
		);
		return count;
	};
	// Our index is rewritten by every capture (`add -A`, `write-tree`), so it is always listed; the user's only when it changed.
	await snapshots.capture('baseline');
	await uncached(repo, reference);
	expect(await step(async () => {})).toBe(1);
	expect(await step(() => writeFile(join(repo, 'file.txt'), 'edited\n'))).toBe(1);
	// The agent force-adds an ignored file: the user index changed.
	expect(
		await step(async () => {
			await writeFile(join(repo, 'new.log'), 'agent\n');
			await git(repo, ['add', '-f', 'new.log']);
		})
	).toBe(2);
	expect(await step(async () => {})).toBe(1);
	// A tracked ignored file deleted and recreated without any user index change still returns.
	await step(() => rm(join(repo, 'keep.log')));
	expect(await step(() => writeFile(join(repo, 'keep.log'), 'back\n'))).toBe(1);
	expect(
		await gitText(repo, [
			'show',
			`${snapshots.current.checkpoints.at(-1)!.trees[0]!.tree}:keep.log`,
		])
	).toBe('back');
}, 30000);
