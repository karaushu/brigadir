import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sessions } from './sessions';
const spawned = vi.hoisted(() => ({ git: 0, live: 0, peak: 0 }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			const child = actual.spawn(command, args, options);
			if (command === 'git') {
				spawned.git++;
				spawned.live++;
				spawned.peak = Math.max(spawned.peak, spawned.live);
				child.once('close', () => {
					spawned.live--;
				});
			}
			return child;
		}) as typeof actual.spawn,
	};
});
const { Forge } = await import('@brigadir/forge');
const { SessionStore } = await import('@brigadir/persistence');
const { gitText, Snapshots } = await import('@brigadir/git');
const { ForgeActions } = await import('./forge');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function repo(path: string, remote: string) {
	await mkdir(path, { recursive: true });
	await mkdir(remote, { recursive: true });
	await gitText(remote, ['init', '--bare', '-b', 'main']);
	await gitText(path, ['init', '-b', 'main']);
	await gitText(path, ['config', 'user.name', 'Fixture']);
	await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
	await writeFile(join(path, 'file'), 'base');
	await gitText(path, ['add', '-A']);
	await gitText(path, ['commit', '-m', 'Baseline']);
	await gitText(path, ['remote', 'add', 'origin', remote]);
	await gitText(path, ['push', '-u', 'origin', 'main']);
	await gitText(path, ['switch', '-c', 'feature']);
	await writeFile(join(path, 'file'), 'feature');
	await gitText(path, ['commit', '-am', 'Feature']);
}
it('serves task-switch GitHub reads from a short per-repo cache, re-reads only PR state on focus, dedupes and caps parallel git (GIT-04)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-forge-cache-'));
	roots.push(dir);
	const root = join(dir, 'repo');
	await repo(root, join(dir, 'remote.git'));
	await writeFile(join(root, '.gitignore'), 'apps/\n');
	await gitText(root, ['add', '-A']);
	await gitText(root, ['commit', '-m', 'Ignore']);
	for (const name of ['one', 'two', 'three'])
		await repo(join(root, 'apps', name), join(dir, `${name}.git`));
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(root),
		tasks = [
			await store.createTask(project.id, 'First', 'claude'),
			await store.createTask(project.id, 'Second', 'claude'),
		];
	for (const task of tasks) await (await Snapshots.open(store, task)).capture('baseline');
	const calls: string[][] = [];
	let live = 0,
		peak = 0;
	const forge = new Forge(async (_, args) => {
		calls.push(args);
		live++;
		peak = Math.max(peak, live);
		await new Promise((resolve) => setTimeout(resolve, 20));
		live--;
		if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
		if (args[0] === 'repo')
			return {
				code: 0,
				stdout: JSON.stringify({
					nameWithOwner: `fixture/${args[2]!.split('/').at(-1)}`,
					url: `https://github.com/fixture/${args[2]!.split('/').at(-1)!.replace('.git', '')}`,
					defaultBranchRef: { name: 'main' },
				}),
				stderr: '',
			};
		if (args[1] === 'list')
			return {
				code: 0,
				stdout: JSON.stringify([
					{
						number: 3,
						url: 'https://github.com/fixture/x/pull/3',
						title: 'PR',
						state: 'OPEN',
						headRefName: 'feature',
						baseRefName: 'main',
					},
				]),
				stderr: '',
			};
		if (args[1] === 'view')
			return {
				code: 0,
				stdout: JSON.stringify({
					number: 3,
					url: 'https://github.com/fixture/x/pull/3',
					title: 'PR',
					state: 'OPEN',
					headRefName: 'feature',
					baseRefName: 'main',
					mergeable: 'MERGEABLE',
				}),
				stderr: '',
			};
		if (args[1] === 'checks') return { code: 0, stdout: '[]', stderr: '' };
		throw new Error('Unexpected command');
	});
	const sessions = {
			read: async () => ({ records: [] }),
			command: async () => {},
		} as unknown as Sessions,
		actions = new ForgeActions(store.root, sessions, forge);
	spawned.peak = 0;
	const first = await actions.read(tasks[0]!, true);
	const firstPeak = spawned.peak;
	expect(calls).toHaveLength(17);
	expect(first.scopes).toHaveLength(4);
	expect(first.scopes.every((item) => item.pr?.number === 3 && item.details)).toBe(true);
	// Switching back and forth between tasks of the same repos within the TTL: no gh at all.
	calls.length = 0;
	const again = await actions.read(tasks[0]!, true),
		other = await actions.read(tasks[1]!, true);
	expect(again.scopes.map((item) => item.pr?.number)).toEqual(
		first.scopes.map((item) => item.pr?.number)
	);
	expect(other.scopes).toHaveLength(4);
	expect(calls).toHaveLength(0);
	expect(firstPeak).toBeLessThanOrEqual(6);
	expect(peak).toBeLessThanOrEqual(4);
	// Window focus re-reads auth, PR state and checks (a logout or a PR merged elsewhere shows up), not repo metadata.
	calls.length = 0;
	await actions.read(tasks[0]!, true, true);
	expect(calls.map((args) => args.slice(0, 2).join(' ')).sort()).toEqual([
		'auth status',
		...Array(4).fill('pr checks'),
		...Array(4).fill('pr list'),
		...Array(4).fill('pr view'),
	]);
	// After the PR TTL a task switch asks GitHub again; concurrent reads share one request per repo.
	vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
	try {
		calls.length = 0;
		await Promise.all([actions.read(tasks[0]!, true), actions.read(tasks[1]!, true)]);
	} finally {
		vi.useRealTimers();
	}
	expect(calls.filter((args) => args[1] === 'list')).toHaveLength(4);
	expect(calls.filter((args) => args[0] === 'auth' || args[0] === 'repo')).toHaveLength(0);
}, 60000);
