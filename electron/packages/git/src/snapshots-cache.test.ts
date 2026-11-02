import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { Snapshots, readSnapshots } from './index';
import { initRepo } from './monorepo.fixture';
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('parses snapshots.json once per file version and still checks repo paths on every read (GIT-17)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-snapshots-cache-')));
	roots.push(dir);
	const repo = join(dir, 'repo'),
		nested = join(repo, 'nested');
	await initRepo(repo, 3);
	await initRepo(nested, 2);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(repo),
		key = await store.createTask(project.id, 'Cache', 'claude'),
		snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	await writeFile(join(repo, 'd0/f0.txt'), 'changed\n');
	await snapshots.capture('turn');
	const file = join(await store.taskDir(key), 'snapshots.json'),
		spy = vi.spyOn(JSON, 'parse'),
		parses = () => spy.mock.calls.filter(([text]) => String(text).includes('"checkpoints"')).length;
	const first = await readSnapshots(store, key);
	const parsed = parses();
	expect(parsed).toBe(1);
	const second = await readSnapshots(store, key);
	expect(parses()).toBe(parsed);
	expect(second).toEqual(first);
	expect(second).toEqual(snapshots.current);
	// Shared checkpoints are frozen; scopes are the caller's own copies.
	expect(() => {
		(second!.checkpoints as unknown[]).push({});
	}).toThrow();
	second!.scopes[0]!.selected = !second!.scopes[0]!.selected;
	expect((await readSnapshots(store, key))!.scopes[0]!.selected).toBe(first!.scopes[0]!.selected);
	// Availability is a filesystem fact, recomputed on a cache hit.
	await rename(join(nested, '.git'), join(nested, '.git-away'));
	expect(
		(await readSnapshots(store, key))!.scopes.find((scope) => scope.name === 'nested')?.available
	).toBe(false);
	expect(parses()).toBe(parsed);
	await rename(join(nested, '.git-away'), join(nested, '.git'));
	// A new version is parsed and validated again, including a broken one.
	await writeFile(join(repo, 'd1/f1.txt'), 'again\n');
	await snapshots.capture('turn');
	await readSnapshots(store, key);
	expect(parses()).toBe(parsed + 1);
	const doc = JSON.parse(await readFile(file, 'utf8'));
	doc.checkpoints[0].trees[0].ref = 'refs/elsewhere/0';
	await atomicJson(file, doc);
	await expect(readSnapshots(store, key)).rejects.toThrow('Invalid snapshot tree');
});
it('writes the snapshot document with the same bytes as atomicJson (GIT-17)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-snapshots-text-')));
	roots.push(dir);
	const repo = join(dir, 'repo');
	await initRepo(repo, 3);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(repo),
		key = await store.createTask(project.id, 'Text', 'claude'),
		snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	await writeFile(join(repo, 'd0/f0.txt'), 'changed\n');
	await snapshots.capture('turn');
	const file = join(await store.taskDir(key), 'snapshots.json'),
		written = await readFile(file);
	await atomicJson(file, JSON.parse(written.toString('utf8')));
	expect(await readFile(file)).toEqual(written);
});
