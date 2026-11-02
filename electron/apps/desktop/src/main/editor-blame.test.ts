import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			if (command === 'git') spawned.git.push(args.slice(6));
			return actual.spawn(command, args, options as never);
		}) as typeof actual.spawn,
	};
});
const { discoverScopes, gitText } = await import('@brigadir/git');
const { lineHunks } = await import('@brigadir/diff');
const { EditorBlames } = await import('./editor-blame');
import type { Changes } from './changes';
import type { GitHistory } from './git-history';
import type { Scope } from '@brigadir/core';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const key = { projectId: 'p', id: 't' };
async function setup() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-editor-blame-')));
	roots.push(dir);
	// A monorepo in miniature: the root repo and a nested repo that owns kit/.
	const root = join(dir, 'mono'),
		kit = join(root, 'kit');
	await mkdir(kit, { recursive: true });
	for (const path of [root, kit]) {
		await gitText(path, ['init', '-q', '-b', 'main']);
		await gitText(path, ['config', 'user.name', 'Fixture']);
		await gitText(path, ['config', 'user.email', 'f@localhost']);
	}
	await writeFile(join(root, '.gitignore'), 'kit/\n');
	await gitText(root, ['add', '-A']);
	await gitText(root, ['commit', '-qm', 'root']);
	await writeFile(join(kit, 'a.ts'), 'one\ntwo\nthree\n');
	await gitText(kit, ['add', '-A']);
	await gitText(kit, ['-c', 'user.name=Ada Lovelace', 'commit', '-qm', 'feat: kit a']);
	const scopes: Scope[] = [...(await discoverScopes(root)), ...(await discoverScopes(kit))];
	const history = {
		owner: async (_key: unknown, absolute: string) =>
			scopes
				.filter((scope) => absolute.startsWith(scope.path + '/'))
				.sort((a, b) => b.path.length - a.path.length)[0] ?? null,
	} as unknown as GitHistory;
	const changes = {
		compute: async (data: { before: string; after: string }) => ({
			hunks: lineHunks(data.before, data.after),
			tooLarge: false,
		}),
	} as unknown as Changes;
	const blames = new EditorBlames(changes, history, async () => ({
		absolute: join(kit, 'a.ts'),
		readOnly: false,
	}));
	return { root, kit, blames, scopes };
}

it('blames in the repo that owns the file, maps unsaved lines and caches on the disk stamp and HEAD (spec/editor#line-author)', async () => {
	const { kit, blames, scopes } = await setup();
	const kitScope = scopes.find((scope) => scope.path === kit)!;
	const blame = (text: string) => blames.read(key, 'id', text);
	const runs = () => spawned.git.filter((args) => args[0] === 'blame').length;
	spawned.git.length = 0;
	const first = await blame('one\ntwo\nthree\n');
	expect(first).toMatchObject({
		state: 'ready',
		scopeId: kitScope.id,
		path: 'a.ts',
		lines: [0, 0, 0, -3],
		origins: [1, 2, 3, 0],
	});
	if (first.state !== 'ready') throw new Error('ready');
	expect(first.commits[0]!.author).toBe('Ada Lovelace');
	// An edit in the buffer only: no new blame; the changed line is not saved.
	expect(await blame('one\nTWO\nthree\n')).toMatchObject({ lines: [0, -2, 0, -3] });
	expect(runs()).toBe(1);
	// A save changes the stamp: the line on disk is now not committed.
	await new Promise((resolve) => setTimeout(resolve, 15));
	await writeFile(join(kit, 'a.ts'), 'one\nTWO\nthree\n');
	expect(await blame('one\nTWO\nthree\n')).toMatchObject({ lines: [0, -1, 0, -3] });
	expect(runs()).toBe(2);
	// A commit moves HEAD: blame runs again and the line has its commit.
	await gitText(kit, ['commit', '-qam', 'fix: two']);
	const committed = await blame('one\nTWO\nthree\n');
	expect(runs()).toBe(3);
	if (committed.state !== 'ready') throw new Error('ready');
	expect(committed.commits.map((item) => item.summary)).toEqual(['feat: kit a', 'fix: two']);
});

it('answers none outside Git and untracked for a file without a commit', async () => {
	const { kit, blames } = await setup();
	const outside = new EditorBlames(
		{} as Changes,
		{ owner: async () => null } as unknown as GitHistory,
		async () => ({ absolute: join(kit, 'a.ts'), readOnly: false })
	);
	expect(await outside.read(key, 'id', 'x')).toEqual({ state: 'none' });
	await writeFile(join(kit, 'b.ts'), 'new\n');
	const fresh = new EditorBlames(
		{} as Changes,
		(blames as unknown as { history: GitHistory }).history,
		async () => ({ absolute: join(kit, 'b.ts'), readOnly: false })
	);
	expect(await fresh.read(key, 'id', 'new\n')).toMatchObject({ state: 'untracked', path: 'b.ts' });
});
