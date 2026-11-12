import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const { git, Snapshots, watchScopes } = await import('./index');
const { monorepo, initRepo } = await import('./monorepo.fixture');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** All watchers have settled: 2 s without a new git process (debounce 750 ms). */
async function settled() {
	let seen = -1;
	while (seen !== spawned.git.length) {
		seen = spawned.git.length;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}
it('five hosts: no git for plain directories, one repo on a HEAD change, discovery for a new, moved or nested repo (GIT-09)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-watch-')));
	roots.push(dir);
	const m = await monorepo(dir, 100);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(m.repo),
		hosts: Awaited<ReturnType<typeof Snapshots.open>>[] = [];
	for (let i = 0; i < 5; i++) {
		const snapshots = await Snapshots.open(
			store,
			await store.createTask(project.id, `Host ${i}`, 'claude')
		);
		await snapshots.capture('baseline');
		hosts.push(snapshots);
	}
	// The host's own wiring: the change picks the refresh, known repos come from the document.
	const closes = hosts.map((snapshots) =>
		watchScopes(
			m.repo,
			async (change) => {
				await snapshots.capture('refresh', snapshots.refreshOptions(change));
			},
			() => snapshots.current.scopes.map((scope) => scope.path)
		)
	);
	const step = async (run: () => Promise<unknown>) => {
		await settled();
		spawned.git.length = 0;
		await run();
		const own = spawned.git.length;
		await settled();
		return spawned.git.slice(own);
	};
	try {
		// No git at all, rather than discovery and all repos in each host for every dotless rename (270).
		expect(
			await step(async () => {
				await mkdir(join(m.repo, 'coverage/lcov/report'), { recursive: true });
				await writeFile(join(m.repo, 'Makefile'), 'all:\n');
				await mkdir(join(m.repo, 'apps/plain/out'));
			})
		).toEqual([]);
		// Each host reads the branch and snapshots only the root, not every repo (260).
		const root = hosts[0]!.current.scopes.find((scope) => scope.kind === 'root')!,
			before = hosts.map((snapshots) => snapshots.current.checkpoints.at(-1)!);
		await writeFile(join(m.admin, 'd0/f0.txt'), 'admin edit\n');
		const head = await step(() => git(m.repo, ['checkout', '-q', '-b', 'other']));
		expect(
			head.filter((call) => call.args[0] === 'rev-parse' && call.args[1] === '--show-toplevel')
		).toEqual([]);
		expect(new Set(head.map((call) => call.cwd))).toEqual(new Set([m.repo]));
		expect(head.filter((call) => call.args[0] === 'symbolic-ref')).toHaveLength(5);
		expect(head.length).toBeLessThanOrEqual(5 * 10);
		for (const [i, snapshots] of hosts.entries()) {
			expect(snapshots.current.scopes.find((scope) => scope.id === root.id)?.branch).toBe('other');
			// Other repos keep the previous tree until the next full checkpoint (the admin edit is not in yet).
			const point = snapshots.current.checkpoints.at(-1)!;
			for (const tree of point.trees.filter((tree) => tree.scopeId !== root.id))
				expect(before[i]!.trees).toContainEqual(tree);
		}
		const fresh = join(m.repo, 'apps/fresh');
		await step(() => git(dir, ['init', '-q', fresh]));
		for (const snapshots of hosts)
			expect(snapshots.current.scopes.find((scope) => scope.path === fresh)?.available).toBe(true);
		// A repo moved under a new name, and a directory moved in with a repo two levels down.
		await step(() => rename(m.plain, join(m.repo, 'apps/plain2')));
		for (const snapshots of hosts) {
			expect(snapshots.current.scopes.find((scope) => scope.name === 'apps/plain')?.available).toBe(
				false
			);
			expect(
				snapshots.current.scopes.find((scope) => scope.name === 'apps/plain2')?.available
			).toBe(true);
		}
		const outside = join(dir, 'outside');
		await initRepo(join(outside, 'libs/deep'));
		await step(() => rename(outside, join(m.repo, 'vendored')));
		for (const snapshots of hosts)
			expect(
				snapshots.current.scopes.find((scope) => scope.name === 'vendored/libs/deep')?.available
			).toBe(true);
	} finally {
		for (const close of closes) close();
	}
}, 120000);

it('a commit moves HEAD without rewriting .git/HEAD: in the root, a submodule and a worktree outside the project', async () => {
	const { movesHead } = await import('./watch-scopes');
	expect(movesHead(['HEAD'])).toBe(true);
	expect(movesHead(['logs', 'HEAD'])).toBe(true);
	expect(movesHead(['refs', 'heads', 'feature', 'x'])).toBe(true);
	expect(movesHead(['refs', 'heads', 'main.lock'])).toBe(false);
	expect(movesHead(['HEAD.lock'])).toBe(false);
	expect(movesHead(['index'])).toBe(false);
	expect(movesHead(['refs', 'remotes', 'origin', 'main'])).toBe(false);
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-watch-head-')));
	roots.push(dir);
	const m = await monorepo(dir, 4),
		away = join(dir, 'away');
	await git(m.repo, ['worktree', 'add', '-q', away, '-b', 'away']);
	const changes: { discover: boolean; heads: string[] }[] = [];
	const close = watchScopes(
		m.repo,
		async (change) => {
			changes.push(change);
		},
		() => [m.repo, m.kit, m.skills, away]
	);
	const after = async (run: () => Promise<unknown>) => {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		changes.length = 0;
		await run();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		return new Set(changes.flatMap((change) => change.heads));
	};
	const commit = (path: string) =>
		git(path, [
			'-c',
			'user.name=F',
			'-c',
			'user.email=f@localhost',
			'commit',
			'-q',
			'--allow-empty',
			'-m',
			'x',
		]);
	try {
		expect(await after(() => commit(m.repo))).toEqual(new Set([m.repo]));
		expect(await after(() => commit(m.kit))).toEqual(new Set([m.kit]));
		// The worktree's branch ref lives in the shared git dir, so the root may refresh too.
		expect(await after(() => commit(away))).toContain(away);
		expect(changes.every((change) => !change.discover)).toBe(true);
	} finally {
		close();
	}
	// A task in its own worktree: the project is the worktree, its git dir lies outside it.
	const closeAway = watchScopes(
		away,
		async (change) => {
			changes.push(change);
		},
		() => [away]
	);
	try {
		expect(await after(() => commit(away))).toEqual(new Set([away]));
	} finally {
		closeAway();
	}
}, 60000);
