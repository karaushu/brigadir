import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import type { RelayDiff, TaskKey } from '@brigadir/core';
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
const { git, GitError, Snapshots, readRelayDiff, readChanges, readSnapshots } =
	await import('./index');
const { monorepo } = await import('./monorepo.fixture');
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** Reference readRelayDiff: a separate `git diff` per file. */
async function legacy(store: SessionStore, key: TaskKey): Promise<RelayDiff> {
	const doc = await readSnapshots(store, key),
		changes = await readChanges(store, key),
		current = doc?.checkpoints[doc.checkpoints.length - 1],
		base = doc?.checkpoints[0];
	const result: RelayDiff = { stat: '', patch: '', files: [], truncated: false };
	if (!doc || !current || !base) return { ...result, stat: 'No captured changes.' };
	let added = 0,
		removed = 0;
	const lines: string[] = [];
	for (const [index, file] of changes.files.entries()) {
		const scope = changes.scopes.find((scope) => scope.id === file.scopeId)!,
			path = posix.join(scope.name, file.path);
		added += file.additions;
		removed += file.deletions;
		if (index < 1000)
			lines.push(
				`${JSON.stringify(path)} | ${file.binary ? 'binary' : `+${file.additions} -${file.deletions}`} (${file.status})`
			);
		else result.truncated = true;
		if (file.after && !file.gitlink && result.files.length < 20) result.files.push(path);
		if (index >= 128 || Buffer.byteLength(result.patch) > 120000) {
			result.truncated = true;
			continue;
		}
		const before =
				base.trees.find((tree) => tree.scopeId === scope.id) ??
				doc.checkpoints
					.slice(0, current.id + 1)
					.flatMap((point) => point.trees)
					.find((tree) => tree.scopeId === scope.id),
			after = current.trees.find((tree) => tree.scopeId === scope.id);
		if (!before || !after) continue;
		try {
			const patch = await git(
				scope.path,
				[
					'diff',
					'--no-ext-diff',
					'--no-textconv',
					'--no-color',
					'--unified=3',
					before.tree,
					after.tree,
					'--',
					`:(top,literal)${file.oldPath}`,
					...(file.path === file.oldPath ? [] : [`:(top,literal)${file.path}`]),
				],
				{ maxBytes: 128000 }
			);
			if (Buffer.byteLength(result.patch) + patch.length > 128000) {
				result.truncated = true;
				continue;
			}
			result.patch += `\nScope: ${JSON.stringify(scope.name)}\n${patch.toString('utf8')}`;
		} catch (error) {
			if (!(error instanceof GitError) || !error.message.includes('resource limit')) throw error;
			result.truncated = true;
		}
	}
	result.stat = `${changes.files.length} files changed, ${added} insertions, ${removed} deletions\n${lines.join('\n')}`;
	if (Buffer.byteLength(result.stat) > 100000) {
		result.stat = Buffer.from(result.stat).subarray(0, 100000).toString('utf8');
		result.truncated = true;
	}
	if (result.truncated) result.patch += '\n[Patch truncated to fit the handoff budget.]';
	return result;
}
it('builds the same handoff patch with one git diff per repo (GIT-15)', async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-relay-')));
	roots.push(dir);
	const m = await monorepo(dir, 300);
	const store = await SessionStore.at(join(dir, 'data')),
		project = await store.addProject(m.repo),
		key = await store.createTask(project.id, 'Relay', 'claude'),
		snapshots = await Snapshots.open(store, key);
	await writeFile(join(m.repo, 'd0/f0.txt'), 'x\n'.repeat(3000));
	await git(m.repo, ['add', '-A']);
	await git(m.repo, ['commit', '-qm', 'big file']);
	await snapshots.capture('baseline');
	for (let i = 1; i < 60; i++)
		await writeFile(join(m.repo, `d${i % 10}`, `f${i}.txt`), `relay ${i}\n`);
	await rm(join(m.repo, 'd0/f10.txt'));
	await rm(join(m.repo, 'd1/f11.txt'));
	await symlink('f2.txt', join(m.repo, 'd1/f11.txt'));
	await chmod(join(m.repo, 'd3/f13.txt'), 0o755);
	await writeFile(join(m.repo, 'd4/tab\tand "quote".txt'), 'odd name\n');
	await writeFile(join(m.repo, 'd5/blob.bin'), Buffer.from([0, 1, 2, 255]));
	await writeFile(join(m.repo, 'd0/f0.txt'), 'y\n'.repeat(70000));
	await git(m.repo, ['mv', 'd6/f16.txt', 'd6/renamed.txt']).catch(() => {});
	await writeFile(join(m.kit, 'd0/f0.txt'), 'kit\n');
	await git(m.kit, ['commit', '-qam', 'kit moved']);
	await writeFile(join(m.kit, 'd1/f1.txt'), 'kit dirty\n');
	await snapshots.capture('turn');
	const reference = await legacy(store, key);
	spawned.git.length = 0;
	const relay = await readRelayDiff(store, key);
	expect(relay).toEqual(reference);
	expect(relay.truncated).toBe(true);
	expect(relay.patch).toContain('Scope: "kit"');
	expect(relay.patch).toContain('new file mode 120000');
	// One diff per repo (not one per file, 61 here) plus the rename, read alone to keep its pairing.
	expect(spawned.git.filter((args) => args[0] === 'diff').length).toBeLessThanOrEqual(3);
	// A submodule shown as a log (a different section shape) falls back to one diff per file with the same result.
	await git(m.repo, ['config', 'diff.submodule', 'log']);
	expect(await readRelayDiff(store, key)).toEqual(await legacy(store, key));
}, 60000);
