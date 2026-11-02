import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Scope, SnapshotDocument, TaskKey } from '@brigadir/core';
import { SessionStore, atomicJson } from '@brigadir/persistence';
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			if (command === 'git') spawned.git.push(args);
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, gitText, Snapshots, readSnapshots, changedFiles } = await import('./index');
const { initRepo, monorepo } = await import('./monorepo.fixture');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const temp = async (name: string) => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), `brigadir-${name}-`)));
	roots.push(dir);
	return dir;
};
/** Only brigadir refs: gc and diff reads must survive on them alone. */
const ours = async (cwd: string) =>
	(await gitText(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/brigadir-v2']))
		.split('\n')
		.filter(Boolean)
		.map((line) => line.split(' ') as [string, string]);
const names = async (cwd: string) => (await ours(cwd)).map(([name]) => name).sort();
async function task(repo: string, dir: string) {
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(repo),
		key = await store.createTask(project.id, 'Refs', 'claude');
	return { store, key };
}
/** Every tree and commit of every checkpoint exists, and after `gc --prune=now` the diffs of all adjacent checkpoints read. */
async function everyCheckpointSurvivesGc(doc: SnapshotDocument, repos: string[]) {
	const scopes = new Map(doc.scopes.map((scope) => [scope.id, scope]));
	for (const repo of repos)
		await git(repo, [
			'-c',
			'gc.reflogExpire=now',
			'-c',
			'gc.reflogExpireUnreachable=now',
			'reflog',
			'expire',
			'--all',
		]).then(() => git(repo, ['gc', '--prune=now', '--quiet']));
	let diffs = 0;
	for (const [i, point] of doc.checkpoints.entries())
		for (const tree of point.trees) {
			const scope = scopes.get(tree.scopeId)!;
			await git(scope.path, ['cat-file', '-e', `${tree.commit}^{commit}`]);
			await git(scope.path, ['cat-file', '-e', `${tree.tree}^{tree}`]);
			const before = doc.checkpoints
				.slice(0, i)
				.findLast((p) => p.trees.some((t) => t.scopeId === tree.scopeId))
				?.trees.find((t) => t.scopeId === tree.scopeId);
			if (before) {
				await changedFiles(scope as Scope, before.tree, tree.tree);
				diffs++;
			}
		}
	return diffs;
}
const tipOf = (key: TaskKey, scopeId: string) =>
	`refs/brigadir-v2/tip/${key.projectId}/${key.id}/${scopeId}`;
const snapOf = (key: TaskKey, scopeId: string, id: number | string) =>
	`refs/brigadir-v2/snap/${key.projectId}/${key.id}/${scopeId}/${id}`;

it('keeps one tip ref per task and repo after many captures; every checkpoint stays reachable through gc (GIT-11)', async () => {
	const dir = await temp('refs-many'),
		repo = join(dir, 'repo');
	await initRepo(repo, 20);
	const { store, key } = await task(repo, dir);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	for (let i = 0; i < 30; i++) {
		await writeFile(join(repo, `d${i % 10}/f${i % 20}.txt`), `turn ${i}\n`);
		await snapshots.capture(i % 3 ? 'tools' : 'turn');
	}
	const doc = snapshots.current,
		scope = doc.scopes[0]!;
	expect(doc.checkpoints).toHaveLength(31);
	expect(await names(repo)).toEqual([tipOf(key, scope.id)]);
	// The tip is the last commit; every earlier commit is its ancestor.
	expect(await gitText(repo, ['rev-parse', tipOf(key, scope.id)])).toBe(
		doc.checkpoints.at(-1)!.trees[0]!.commit
	);
	for (const point of doc.checkpoints)
		await git(repo, ['merge-base', '--is-ancestor', point.trees[0]!.commit, tipOf(key, scope.id)]);
	expect(doc.checkpoints.at(-1)!.trees[0]!.ref).toBe(tipOf(key, scope.id));
	// User refs untouched.
	expect((await gitText(repo, ['for-each-ref', '--format=%(refname)'])).split('\n').sort()).toEqual(
		[tipOf(key, scope.id), 'refs/heads/main'].sort()
	);
	expect(await everyCheckpointSurvivesGc(doc, [repo])).toBe(30);
	// The document still reads, the history still reads.
	expect((await readSnapshots(store, key))!.checkpoints).toHaveLength(31);
}, 30_000);

it('does not add git processes to a capture (GIT-11)', async () => {
	const dir = await temp('refs-count'),
		repo = join(dir, 'repo');
	await initRepo(repo, 20);
	const { store, key } = await task(repo, dir);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	await writeFile(join(repo, 'd0/f0.txt'), 'warm\n');
	await snapshots.capture('turn');
	const counts: number[] = [];
	for (let i = 0; i < 10; i++) {
		await writeFile(join(repo, `d${i % 10}/f${i}.txt`), `count ${i}\n`);
		spawned.git.length = 0;
		await snapshots.capture('turn');
		counts.push(spawned.git.length);
	}
	// 6 per capture of one changed repo — cat-file, ls-files, add, write-tree, commit-tree, update-ref; the tip adds none.
	expect(counts).toEqual(Array(10).fill(6));
	// A fresh instance (main-process save or refresh) confirms the tip once: one for-each-ref more.
	const fresh = await Snapshots.open(store, key);
	await writeFile(join(repo, 'd1/f1.txt'), 'fresh\n');
	spawned.git.length = 0;
	await fresh.capture('turn');
	expect(spawned.git.length).toBe(7);
	expect(spawned.git.filter((args) => args.includes('for-each-ref'))).toHaveLength(1);
});

it('continues the chain of a repo that was missing in the previous checkpoint (GIT-11)', async () => {
	const dir = await temp('refs-gap'),
		repo = join(dir, 'repo'),
		nested = join(repo, 'nested');
	await initRepo(repo, 3);
	await initRepo(nested, 3);
	const { store, key } = await task(repo, dir);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	const id = snapshots.current.scopes.find((scope) => scope.name === 'nested')!.id;
	await writeFile(join(nested, 'd0/f0.txt'), 'one\n');
	await snapshots.capture('turn');
	const before = snapshots.current.checkpoints
		.at(-1)!
		.trees.find((tree) => tree.scopeId === id)!.commit;
	await rename(join(nested, '.git'), join(nested, '.git-away'));
	await writeFile(join(repo, 'd1/f1.txt'), 'root\n');
	await snapshots.capture('turn');
	expect(snapshots.current.checkpoints.at(-1)!.trees.some((tree) => tree.scopeId === id)).toBe(
		false
	);
	await rename(join(nested, '.git-away'), join(nested, '.git'));
	await snapshots.capture('refresh');
	await writeFile(join(nested, 'd1/f1.txt'), 'two\n');
	await snapshots.capture('turn');
	const doc = snapshots.current,
		after = doc.checkpoints.at(-2)!.trees.find((tree) => tree.scopeId === id)!.commit;
	// The returning repo's first commit continues from its last snapshot: no keeper ref is needed.
	expect(await gitText(nested, ['rev-parse', `${after}^`])).toBe(before);
	expect(await names(nested)).toEqual([tipOf(key, id)]);
	expect(await names(repo)).toEqual([
		tipOf(key, doc.scopes.find((scope) => scope.name === '.')!.id),
	]);
	expect(await everyCheckpointSurvivesGc(doc, [repo, nested])).toBeGreaterThan(3);
});

it('keeps a tip it cannot prove to be an ancestor under its own ref (GIT-11)', async () => {
	const dir = await temp('refs-keeper'),
		repo = join(dir, 'repo');
	await initRepo(repo, 3);
	const { store, key } = await task(repo, dir);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	await writeFile(join(repo, 'd0/f0.txt'), 'one\n');
	await snapshots.capture('turn');
	const scope = snapshots.current.scopes[0]!,
		tip = tipOf(key, scope.id),
		last = snapshots.current.checkpoints.at(-1)!.trees[0]!;
	// A capture that moved the tip and then failed to write snapshots.json leaves a commit no checkpoint knows.
	const orphan = await gitText(repo, [
		'commit-tree',
		last.tree,
		'-p',
		last.commit,
		'-m',
		'Brigadir snapshot 2',
	]);
	await git(repo, ['update-ref', tip, orphan, last.commit]);
	await writeFile(join(repo, 'd1/f1.txt'), 'two\n');
	const point = (await snapshots.capture('turn'))!;
	expect(await gitText(repo, ['rev-parse', `${point.trees[0]!.commit}^`])).toBe(last.commit);
	expect(await names(repo)).toEqual([snapOf(key, scope.id, 2), tip].sort());
	expect(await gitText(repo, ['rev-parse', snapOf(key, scope.id, 2)])).toBe(orphan);
	// Idempotent: the next capture takes the fast path and keeps the keeper.
	await writeFile(join(repo, 'd2/f2.txt'), 'three\n');
	await snapshots.capture('turn');
	expect(await names(repo)).toEqual([snapOf(key, scope.id, 2), tip].sort());
	await everyCheckpointSurvivesGc(snapshots.current, [repo]);
	await git(repo, ['cat-file', '-e', `${orphan}^{commit}`]);
});

/** The legacy document and refs: a ref per new commit, whose parent is only the previous checkpoint's tree. */
async function legacy(
	store: SessionStore,
	key: TaskKey,
	drop?: { scopeId: string; checkpoint: number }
) {
	const file = join(await store.taskDir(key), 'snapshots.json'),
		doc = JSON.parse(await readFile(file, 'utf8')) as SnapshotDocument;
	if (drop)
		doc.checkpoints[drop.checkpoint]!.trees = doc.checkpoints[drop.checkpoint]!.trees.filter(
			(tree) => tree.scopeId !== drop.scopeId
		);
	const paths = new Map(doc.scopes.map((scope) => [scope.id, scope.path]));
	for (const scope of doc.scopes)
		await git(scope.path, ['update-ref', '-d', tipOf(key, scope.id)]).catch(() => {});
	for (const [i, point] of doc.checkpoints.entries())
		for (const tree of point.trees) {
			const previous = doc.checkpoints[i - 1]?.trees.find((item) => item.scopeId === tree.scopeId),
				cwd = paths.get(tree.scopeId)!;
			if (previous?.tree === tree.tree) {
				Object.assign(tree, { commit: previous.commit, ref: previous.ref });
				continue;
			}
			const commit = await gitText(cwd, [
				'commit-tree',
				tree.tree,
				...(previous ? ['-p', previous.commit] : []),
				'-m',
				`Brigadir snapshot ${i}`,
			]);
			Object.assign(tree, { commit, ref: snapOf(key, tree.scopeId, i) });
			await git(cwd, ['update-ref', tree.ref, commit]);
		}
	await atomicJson(file, doc);
	return doc;
}

it('consolidates the per-checkpoint refs of an old document on the next capture, keeping a broken chain (GIT-11)', async () => {
	const dir = await temp('refs-legacy'),
		repo = join(dir, 'repo'),
		nested = join(repo, 'nested');
	await initRepo(repo, 3);
	await initRepo(nested, 3);
	const { store, key } = await task(repo, dir);
	let snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	for (let i = 0; i < 8; i++) {
		await writeFile(join(repo, `d${i % 3}/f${i % 3}.txt`), `root ${i}\n`);
		await writeFile(join(nested, `d${i % 3}/f${i % 3}.txt`), `nested ${i}\n`);
		await snapshots.capture('turn');
	}
	const root = snapshots.current.scopes.find((scope) => scope.name === '.')!.id,
		inner = snapshots.current.scopes.find((scope) => scope.name === 'nested')!.id;
	// The legacy layout rebuilds the nested chain from scratch after checkpoint 4, where the repo was missing.
	const old = await legacy(store, key, { scopeId: inner, checkpoint: 4 });
	expect(await names(repo)).toHaveLength(9);
	expect(await names(nested)).toHaveLength(8);
	expect(await readSnapshots(store, key)).toMatchObject({ checkpoints: old.checkpoints });
	snapshots = await Snapshots.open(store, key);
	await writeFile(join(repo, 'd0/f0.txt'), 'next\n');
	await writeFile(join(nested, 'd0/f0.txt'), 'next\n');
	await snapshots.capture('turn');
	expect(await names(repo)).toEqual([tipOf(key, root)]);
	// Checkpoint 3 ends the old chain: nothing newer descends from it, so its ref stays.
	expect(await names(nested)).toEqual([snapOf(key, inner, 3), tipOf(key, inner)].sort());
	const doc = snapshots.current;
	expect(doc.checkpoints.slice(0, 9)).toEqual(old.checkpoints);
	expect(doc.checkpoints.at(-1)!.trees.every((tree) => tree.ref === tipOf(key, tree.scopeId))).toBe(
		true
	);
	// Mixed historical and tip names read back.
	expect((await readSnapshots(store, key))!.checkpoints).toHaveLength(10);
	// Idempotent.
	await writeFile(join(nested, 'd1/f1.txt'), 'again\n');
	await (await Snapshots.open(store, key)).capture('turn');
	expect(await names(nested)).toEqual([snapOf(key, inner, 3), tipOf(key, inner)].sort());
	expect(
		await everyCheckpointSurvivesGc((await readSnapshots(store, key))!, [repo, nested])
	).toBeGreaterThan(15);
}, 30_000);

it('leaves the refs as they are when the cleanup fails and finishes it on a later capture (GIT-11)', async () => {
	const dir = await temp('refs-retry'),
		repo = join(dir, 'repo');
	await initRepo(repo, 3);
	const { store, key } = await task(repo, dir);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	for (let i = 0; i < 4; i++) {
		await writeFile(join(repo, 'd0/f0.txt'), `v${i}\n`);
		await snapshots.capture('turn');
	}
	const scope = snapshots.current.scopes[0]!;
	await legacy(store, key);
	const before = await names(repo);
	expect(before).toHaveLength(5);
	// A held ref lock makes the delete transaction fail as a whole.
	const lock = join(repo, '.git', `${snapOf(key, scope.id, 2)}.lock`);
	await writeFile(lock, '');
	const fresh = await Snapshots.open(store, key);
	await writeFile(join(repo, 'd1/f1.txt'), 'x\n');
	await fresh.capture('turn');
	expect(await names(repo)).toEqual([...before, tipOf(key, scope.id)].sort());
	await rm(lock);
	await writeFile(join(repo, 'd2/f2.txt'), 'y\n');
	await fresh.capture('turn');
	expect(await names(repo)).toEqual([tipOf(key, scope.id)]);
	await everyCheckpointSurvivesGc(fresh.current, [repo]);
});

it('keeps one tip per repo in submodule and nested scopes with the same process count; user refs stay untouched (GIT-11)', async () => {
	const dir = await temp('refs-mono'),
		m = await monorepo(dir, 30);
	const { store, key } = await task(m.repo, dir);
	const repos = [m.repo, m.kit, m.skills, m.admin, m.plain],
		user = async () =>
			Promise.all(
				repos.map(
					async (repo) =>
						`${await gitText(repo, ['for-each-ref', '--format=%(refname) %(objectname)', '--exclude=refs/brigadir-v2/**', 'refs'])}\n${await gitText(repo, ['rev-parse', 'HEAD'])}\n${await gitText(repo, ['status', '--porcelain'])}`
				)
			);
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	expect(
		Object.fromEntries(snapshots.current.scopes.map((scope) => [scope.name, scope.kind]))
	).toEqual({
		'.': 'root',
		'apps/admin': 'nested',
		'apps/plain': 'nested',
		kit: 'submodule',
		skills: 'submodule',
	});
	const counts: number[] = [];
	for (let i = 0; i < 6; i++) {
		for (const path of [m.repo, m.kit, m.skills, m.plain, m.wt, m.admin])
			await writeFile(join(path, `d0/x${i}.txt`), `${i}\n`);
		const userBefore = await user();
		spawned.git.length = 0;
		await snapshots.capture('turn');
		counts.push(spawned.git.length);
		expect(await user()).toEqual(userBefore);
	}
	// The same count as per-checkpoint refs with the same repos and edits: 32 per capture of five changed repos.
	expect(counts).toEqual(Array(6).fill(32));
	const doc = snapshots.current;
	for (const scope of doc.scopes) expect(await names(scope.path)).toEqual([tipOf(key, scope.id)]);
	expect(await everyCheckpointSurvivesGc(doc, repos)).toBe(30);
}, 30_000);

it('keeps the tips of worktree scopes in the shared refs of their main repos (GIT-11)', async () => {
	const dir = await temp('refs-worktree'),
		main = join(dir, 'main'),
		plain = join(dir, 'plain');
	await initRepo(main, 5);
	await initRepo(plain, 5);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(main),
		hash = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 16);
	const key = await store.createTask(project.id, 'Worktree', 'claude'),
		ws = join(dir, 'data', 'worktrees', project.id, key.id);
	await git(main, ['worktree', 'add', '-q', '-b', 'task', ws]);
	await git(plain, ['worktree', 'add', '-q', '-b', 'task', join(ws, 'apps/plain')]);
	await store.updateTask(key, {
		launch: {
			isolation: 'worktree',
			branch: 'task',
			baseRef: 'main',
			setupCommand: '',
			scopes: [
				{ id: hash(join(ws, 'apps/plain')), name: 'apps/plain', kind: 'worktree', selected: true },
			],
		},
	});
	await atomicJson(join(await store.taskDir(key), 'worktree.json'), {
		schemaVersion: 1,
		root: ws,
		state: 'ready',
		branch: 'task',
	});
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	expect(
		Object.fromEntries(snapshots.current.scopes.map((scope) => [scope.name, scope.kind]))
	).toEqual({ '.': 'root', 'apps/plain': 'worktree' });
	for (let i = 0; i < 5; i++) {
		await writeFile(join(ws, 'd0/f0.txt'), `ws ${i}\n`);
		await writeFile(join(ws, 'apps/plain/d1/f1.txt'), `plain ${i}\n`);
		await snapshots.capture('turn');
	}
	const doc = snapshots.current,
		id = (name: string) => doc.scopes.find((scope) => scope.name === name)!.id;
	expect(await names(main)).toEqual([tipOf(key, id('.'))]);
	expect(await names(plain)).toEqual([tipOf(key, id('apps/plain'))]);
	expect(await names(ws)).toEqual(await names(main));
	expect(await everyCheckpointSurvivesGc(doc, [main, plain])).toBe(10);
}, 30_000);
