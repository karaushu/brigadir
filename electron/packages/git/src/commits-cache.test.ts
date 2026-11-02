import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scope } from '@brigadir/core';
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
const { gitText } = await import('./command');
const { discoverScopes } = await import('./scopes');
const { previewCommits } = await import('./commits');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function init(path: string, commit = true) {
	await mkdir(path, { recursive: true });
	await gitText(path, ['init', '-b', 'main']);
	await gitText(path, ['config', 'user.name', 'Fixture']);
	await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
	if (commit) {
		await writeFile(join(path, 'a.txt'), 'aaa\n');
		await writeFile(join(path, 'b.txt'), 'bbb\n');
		await gitText(path, ['add', '-A']);
		await gitText(path, ['commit', '-m', 'Initial']);
	}
}
/** Cached and uncached previews must be the same JSON (hence the same revision); returns git processes of the cached read. */
async function same(scopes: Scope[]) {
	spawned.git.length = 0;
	const cached = await previewCommits(scopes);
	const count = spawned.git.length;
	const reference = await previewCommits(scopes, undefined, true);
	expect(JSON.stringify(cached)).toBe(JSON.stringify(reference));
	return { count, cached };
}
it('reuses an unchanged repo preview and rebuilds it on any change of status, content, HEAD or branch (GIT-12)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-cache-'));
	roots.push(root);
	await init(root);
	await writeFile(join(root, 'a.txt'), 'changed\n');
	await rm(join(root, 'b.txt'));
	await writeFile(join(root, 'new.txt'), 'new\n');
	const scopes = await discoverScopes(root);
	const first = await same(scopes);
	expect(first.cached.scopes[0]!.files.map((file) => `${file.status}${file.path}`)).toEqual([
		' Ma.txt',
		' Db.txt',
		'??new.txt',
	]);
	// Nothing changed: status, HEAD and branch only; no temporary index, no hash-object, no diff-tree.
	const again = await same(scopes);
	expect(again.count).toBe(3);
	expect(again.cached.revision).toBe(first.cached.revision);
	// Same size, same status letter, new content: stat changes, so the tree and the diff are rebuilt.
	await writeFile(join(root, 'a.txt'), 'CHANGED\n');
	await utimes(join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
	const content = await same(scopes);
	expect(content.count).toBeGreaterThan(3);
	expect(content.cached.revision).not.toBe(first.cached.revision);
	await gitText(root, ['add', 'a.txt']);
	const staged = await same(scopes);
	expect(staged.cached.scopes[0]!.files[0]!.status).toBe('M ');
	await gitText(root, ['switch', '-c', 'other']);
	const branch = await same(scopes);
	expect(branch.count).toBe(3);
	expect(branch.cached.scopes[0]!.scope.branch).toBe('other');
	await gitText(root, ['commit', '-m', 'Stage a']);
	const head = await same(scopes);
	expect(head.cached.scopes[0]!.head).toBe(await gitText(root, ['rev-parse', 'HEAD']));
	// A directory in status is an embedded repo or submodule: `add` records its HEAD, so that HEAD joins the key.
	await init(join(root, 'embedded'));
	const embedded = await same(scopes);
	expect(embedded.cached.scopes[0]!.files.some((file) => file.path === 'embedded/')).toBe(true);
	expect((await same(scopes)).count).toBe(4);
	await writeFile(join(root, 'embedded/a.txt'), 'moved\n');
	await gitText(join(root, 'embedded'), ['commit', '-qam', 'Move']);
	const moved = await same(scopes);
	expect(moved.count).toBeGreaterThan(4);
	expect(moved.cached.revision).not.toBe(embedded.cached.revision);
	// A plain directory without its own repo is not described by stat: always rebuilt.
	await mkdir(join(root, 'plain'));
	await gitText(root, [
		'update-index',
		'--add',
		'--cacheinfo',
		`160000,${await gitText(root, ['rev-parse', 'HEAD'])},plain`,
	]);
	const plain = await same(scopes);
	expect(plain.cached.scopes[0]!.files.some((file) => file.path === 'plain')).toBe(true);
	expect((await same(scopes)).count).toBeGreaterThan(4);
}, 30000);
it('previews an unborn repo against the empty tree, cached or not', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-cache-unborn-'));
	roots.push(root);
	await init(root, false);
	await writeFile(join(root, 'first.txt'), 'first\n');
	const scopes = await discoverScopes(root);
	const first = await same(scopes);
	expect(first.cached.scopes[0]!.head).toBeNull();
	expect(first.cached.scopes[0]!.files[0]!.diff?.before).toBeNull();
	expect((await same(scopes)).count).toBe(3);
});
