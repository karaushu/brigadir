import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			if (command === 'git') spawned.git.push(args.slice(6));
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { gitText, discoverScopes, publishState } = await import('./index');
const { monorepo } = await import('./monorepo.fixture');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('checks a submodule pointer against remote branches once per remote ref state (GIT-16)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-publish-sub-')));
	roots.push(dir);
	const m = await monorepo(dir, 20),
		scopes = await discoverScopes(m.repo),
		top = scopes.find((scope) => scope.kind === 'root')!;
	const contains = () =>
		spawned.git.filter((args) => args[0] === 'branch' && args.includes('--contains')).length;
	const warned = async () => {
		spawned.git.length = 0;
		const warnings = (await publishState(top, scopes, 'main')).warnings;
		return { warnings, contains: contains() };
	};
	const reference = async () =>
		(await gitText(m.kit, [
			'branch',
			'-r',
			'--contains',
			await gitText(m.repo, ['rev-parse', 'HEAD:kit']),
		]))
			? []
			: ['kit'];
	expect((await warned()).warnings).toEqual([]);
	expect(await warned()).toEqual({ warnings: [], contains: 0 });
	// A pointer to a commit no remote branch has: a warning, checked once, then from cache.
	await writeFile(join(m.kit, 'local.txt'), 'local\n');
	await gitText(m.kit, ['add', '-A']);
	await gitText(m.kit, ['commit', '-qm', 'local']);
	await gitText(m.repo, ['commit', '-qam', 'move kit']);
	expect(await warned()).toEqual({ warnings: await reference(), contains: 1 });
	expect(await warned()).toEqual({ warnings: ['kit'], contains: 0 });
	// The remote learns the commit (as a fetch would): the ref file changes and the warning goes.
	await gitText(m.kit, [
		'update-ref',
		'refs/remotes/origin/main',
		await gitText(m.kit, ['rev-parse', 'HEAD']),
	]);
	expect(await warned()).toEqual({ warnings: [], contains: 1 });
	expect(await reference()).toEqual([]);
	// Packed refs are part of the state too.
	await gitText(m.kit, ['pack-refs', '--all']);
	await gitText(m.kit, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1']);
	await gitText(m.kit, ['pack-refs', '--all']);
	expect(await warned()).toEqual({ warnings: ['kit'], contains: 1 });
	expect(await reference()).toEqual(['kit']);
}, 30000);
