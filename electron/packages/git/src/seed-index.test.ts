import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
const spawned = vi.hoisted(() => ({ git: [] as { cwd: string; args: string[] }[] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: { cwd: string }) => {
			if (command === 'git') spawned.git.push({ cwd: options.cwd, args: args.slice(6) });
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, gitText, GitError, Snapshots, plainIndex } = await import('./index');
const { monorepo, initRepo } = await import('./monorepo.fixture');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** Reference unseeded snapshot: `read-tree HEAD` into an empty index, then the same steps as capture. */
async function reference(path: string, dir: string, excluded: string[] = []) {
	const env = { GIT_INDEX_FILE: join(dir, `reference-${Math.random()}`) },
		head = await gitText(path, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => null);
	await git(path, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
	const known = new Set(
			(await git(path, ['ls-files', '--cached', '-z'], { env })).toString('utf8').split('\0')
		),
		missing: string[] = [];
	for (const file of (await git(path, ['ls-files', '--cached', '-z']))
		.toString('utf8')
		.split('\0')
		.filter(Boolean))
		if (
			!known.has(file) &&
			(await lstat(join(path, file)).then(
				() => true,
				() => false
			))
		)
			missing.push(file);
	if (missing.length)
		await git(
			path,
			['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
			{ env, input: missing.join('\0') + '\0' }
		);
	await git(
		path,
		['add', '-A', '--', '.', ...excluded.map((local) => `:(top,literal,exclude)${local}`)],
		{ env }
	);
	return gitText(path, ['write-tree'], { env });
}
async function task(dir: string, repo: string) {
	const store = await SessionStore.at(join(dir, `data-${Math.random()}`)),
		project = await store.addProject(repo);
	return Snapshots.open(store, await store.createTask(project.id, 'Seed', 'claude'));
}
/** The first snapshot's tree and whether the index was seeded from the user's index. */
async function baseline(dir: string, repo: string, path = repo) {
	const snapshots = await task(dir, repo);
	spawned.git.length = 0;
	await snapshots.capture('baseline');
	const scope = snapshots.current.scopes.find((item) => item.path === path)!,
		tree = snapshots.current.checkpoints[0]!.trees.find((item) => item.scopeId === scope.id)!.tree;
	return {
		tree,
		seeded: spawned.git.some(
			(call) => call.cwd === path && call.args[0] === 'read-tree' && call.args[1] === '-m'
		),
	};
}
it('seeds the first snapshot from the user index and writes the same trees in every repo kind (GIT-08)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-seed-')));
	roots.push(dir);
	const m = await monorepo(dir, 200);
	await writeFile(join(m.repo, 'd1/f1.txt'), 'unstaged\n');
	await writeFile(join(m.repo, 'd2/f2.txt'), 'staged\n');
	await git(m.repo, ['add', 'd2/f2.txt']);
	await writeFile(join(m.repo, 'd2/f2.txt'), 'file 2\n');
	await rm(join(m.repo, 'd3/f3.txt'));
	await writeFile(join(m.repo, 'new.txt'), 'untracked\n');
	await writeFile(join(m.kit, 'd0/f0.txt'), 'kit dirty\n');
	await writeFile(join(m.wt, 'd4/f4.txt'), 'worktree dirty\n');
	const index = await readFile(join(m.repo, '.git/index'));
	const snapshots = await task(dir, m.repo);
	spawned.git.length = 0;
	await snapshots.capture('baseline');
	expect(await readFile(join(m.repo, '.git/index'))).toEqual(index);
	const seeded = new Set(
		spawned.git
			.filter((call) => call.args[0] === 'read-tree' && call.args[1] === '-m')
			.map((call) => relative(m.repo, call.cwd) || '.')
	);
	expect([...seeded].sort()).toEqual(['.', 'apps/admin', 'apps/plain', 'kit', 'skills']);
	for (const scope of snapshots.current.scopes) {
		const excluded = scope.kind === 'root' ? ['apps/plain', '.claude/worktrees/wt'] : [];
		expect(
			snapshots.current.checkpoints[0]!.trees.find((item) => item.scopeId === scope.id)!.tree,
			scope.name
		).toBe(await reference(scope.path, dir, excluded));
	}
	// A worktree scope has its index under the main repo's .git/worktrees.
	const wt = await baseline(dir, m.wt);
	expect(wt).toEqual({ tree: await reference(m.wt, dir), seeded: true });
}, 60000);
it('keeps the fresh index for flags read-tree -m would carry over, split index, conflicts and unborn repos (GIT-08)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-seed-flags-')));
	roots.push(dir);
	const cases: [string, (repo: string) => Promise<void>, boolean][] = [
		['plain v2', async () => {}, true],
		[
			'index v4',
			async (repo) => {
				await git(repo, ['update-index', '--index-version', '4']);
				await writeFile(join(repo, 'd1/f1.txt'), 'changed\n');
			},
			true,
		],
		[
			'rm --cached ignored',
			async (repo) => {
				await writeFile(join(repo, '.gitignore'), 'd2/\n');
				await git(repo, ['rm', '-q', '--cached', 'd2/f2.txt']);
			},
			true,
		],
		[
			'force-added ignored',
			async (repo) => {
				await writeFile(join(repo, '.gitignore'), 'secret.txt\n');
				await writeFile(join(repo, 'secret.txt'), 'forced\n');
				await git(repo, ['add', '-f', 'secret.txt']);
			},
			true,
		],
		[
			'intent-to-add',
			async (repo) => {
				await writeFile(join(repo, 'ita.txt'), 'later\n');
				await git(repo, ['add', '-N', 'ita.txt']);
			},
			false,
		],
		[
			'skip-worktree',
			async (repo) => {
				await git(repo, ['update-index', '--skip-worktree', 'd1/f1.txt']);
				await writeFile(join(repo, 'd1/f1.txt'), 'hidden change\n');
			},
			false,
		],
		[
			'assume-unchanged',
			async (repo) => {
				await git(repo, ['update-index', '--assume-unchanged', 'd1/f1.txt']);
				await writeFile(join(repo, 'd1/f1.txt'), 'hidden change\n');
			},
			false,
		],
		[
			'split index',
			async (repo) => {
				await git(repo, ['update-index', '--split-index']);
				await writeFile(join(repo, 'd1/f1.txt'), 'changed\n');
			},
			false,
		],
		[
			'conflict',
			async (repo) => {
				await gitText(repo, ['switch', '-q', '-c', 'other']);
				await writeFile(join(repo, 'd1/f1.txt'), 'other\n');
				await git(repo, ['commit', '-qam', 'other']);
				await gitText(repo, ['switch', '-q', 'main']);
				await writeFile(join(repo, 'd1/f1.txt'), 'main\n');
				await git(repo, ['commit', '-qam', 'main']);
				await git(repo, ['merge', 'other']).catch((error) => {
					if (!(error instanceof GitError)) throw error;
				});
			},
			false,
		],
	];
	for (const [name, prepare, seeded] of cases) {
		const repo = join(dir, name.replace(/\W/g, '-'));
		await initRepo(repo, 20);
		await prepare(repo);
		expect(await baseline(dir, repo), name).toEqual({ tree: await reference(repo, dir), seeded });
	}
	const unborn = join(dir, 'unborn');
	await mkdir(unborn);
	await git(unborn, ['init', '-q']);
	await writeFile(join(unborn, 'first.txt'), 'first\n');
	expect(await baseline(dir, unborn)).toEqual({
		tree: await reference(unborn, dir),
		seeded: false,
	});
	const sha256 = join(dir, 'sha256');
	await mkdir(sha256);
	await git(sha256, ['init', '-q', '--object-format=sha256']);
	await git(sha256, ['config', 'user.name', 'Fixture']);
	await git(sha256, ['config', 'user.email', 'fixture@localhost']);
	await writeFile(join(sha256, 'a.txt'), 'a\n');
	await git(sha256, ['add', '-A']);
	await git(sha256, ['commit', '-qm', 'a']);
	await writeFile(join(sha256, 'a.txt'), 'b\n');
	expect(await baseline(dir, sha256)).toEqual({ tree: await reference(sha256, dir), seeded: true });
}, 90000);
it('rejects an index whose checksum does not match or whose entries it cannot parse (GIT-08)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-seed-parse-')));
	roots.push(dir);
	const repo = join(dir, 'repo');
	await initRepo(repo, 5);
	const bytes = await readFile(join(repo, '.git/index')),
		plain = plainIndex(bytes, 20)!;
	// Without extensions the plain copy is byte-identical except for the dropped extensions and the new checksum.
	expect(plain.subarray(0, 12)).toEqual(bytes.subarray(0, 12));
	expect(plainIndex(plain, 20)).toEqual(plain);
	const broken = Buffer.from(bytes);
	broken[20]! ^= 1;
	expect(plainIndex(broken, 20)).toBeNull();
	expect(plainIndex(bytes.subarray(0, 40), 20)).toBeNull();
	expect(plainIndex(bytes, 32)).toBeNull();
});
