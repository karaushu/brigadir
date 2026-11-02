import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitText, git } from './command';
import { discoverScopes } from './scopes';
import { writeFileSync } from 'node:fs';
import { previewCommits, commitPreview, commitBaskets, parseStatus } from './commits';
async function init(path: string) {
	await mkdir(path, { recursive: true });
	await gitText(path, ['init', '-b', 'main']);
	await gitText(path, ['config', 'user.name', 'Fixture']);
	await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
	await writeFile(join(path, 'file.txt'), 'baseline\n');
	await gitText(path, ['add', 'file.txt']);
	await gitText(path, ['commit', '-m', 'Initial']);
}
it('lists real files, preserves index on preview, rejects stale content and commits reviewed renames/deletions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-test-'));
	try {
		await init(root);
		await gitText(root, ['mv', 'file.txt', 'new name.txt']);
		await mkdir(join(root, 'new'));
		await writeFile(join(root, 'new/українська.txt'), 'new content\n');
		const index = await readFile(join(root, '.git/index')),
			scopes = await discoverScopes(root),
			preview = await previewCommits(scopes);
		expect(preview.scopes[0]!.files.map((file) => file.path)).toEqual([
			'new name.txt',
			'new/українська.txt',
		]);
		expect(await readFile(join(root, '.git/index'))).toEqual(index);
		await writeFile(join(root, 'new name.txt'), 'changed after review\n');
		await expect(commitPreview(preview, scopes, 'No stale commits')).rejects.toThrow(
			'Files changed'
		);
		expect(await gitText(root, ['log', '-1', '--format=%s'])).toBe('Initial');
		const fresh = await previewCommits(scopes);
		const result = await commitPreview(fresh, scopes, 'Test: Unicode and rename\n\nBody');
		expect(result.error).toBeNull();
		expect(result.committed).toHaveLength(1);
		expect(await gitText(root, ['status', '--porcelain'])).toBe('');
		await gitText(root, ['rm', 'new name.txt']);
		const deletion = await previewCommits(scopes);
		expect((await commitPreview(deletion, scopes, 'Delete renamed file')).error).toBeNull();
		expect(await gitText(root, ['status', '--porcelain'])).toBe('');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('commits child repositories before parents and records the final submodule pointer', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-commit-topology-')),
		root = join(dir, 'root'),
		child = join(dir, 'source');
	try {
		await init(root);
		await init(child);
		await git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'kit']);
		await gitText(root, ['commit', '-am', 'Add module']);
		await gitText(join(root, 'kit'), ['config', 'user.name', 'Fixture']);
		await gitText(join(root, 'kit'), ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(root, '.gitignore'), 'nested/\n');
		await gitText(root, ['add', '.gitignore']);
		await gitText(root, ['commit', '-m', 'Ignore independent root']);
		await init(join(root, 'nested'));
		await writeFile(join(root, 'kit/file.txt'), 'child change\n');
		await writeFile(join(root, 'nested/file.txt'), 'independent change\n');
		const scopes = await discoverScopes(root),
			preview = await previewCommits(scopes);
		expect(preview.scopes.map((item) => item.scope.name)).toEqual(['kit', 'nested', '.']);
		const result = await commitPreview(preview, scopes, 'Ordered update');
		expect(result.error).toBeNull();
		expect(result.committed.map((item) => item.name)).toEqual(['kit', 'nested', '.']);
		expect(await gitText(root, ['rev-parse', 'HEAD:kit'])).toBe(
			await gitText(join(root, 'kit'), ['rev-parse', 'HEAD'])
		);
		expect(await gitText(root, ['status', '--porcelain'])).toBe('');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it('does not commit a parent after a child fails and parses conflict/rename records strictly', async () => {
	expect(parseStatus('R  new\0old\0?? -dash\0')).toEqual([
		{ path: '-dash', oldPath: '-dash', status: '??' },
		{ path: 'new', oldPath: 'old', status: 'R ' },
	]);
	expect(() => parseStatus('UU file\0')).toThrow('conflicts');
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-fail-'));
	try {
		await init(root);
		await writeFile(join(root, '.gitignore'), 'nested/\n');
		await gitText(root, ['add', '.gitignore']);
		await gitText(root, ['commit', '-m', 'Ignore']);
		await init(join(root, 'nested'));
		await writeFile(join(root, 'nested/file.txt'), 'child\n');
		await writeFile(join(root, 'file.txt'), 'parent\n');
		await writeFile(join(root, 'nested/.git/index.lock'), 'owned by another git');
		const before = await gitText(root, ['rev-parse', 'HEAD']),
			scopes = await discoverScopes(root),
			preview = await previewCommits(scopes),
			result = await commitPreview(preview, scopes, 'Must stop');
		expect(result.error).toContain('index.lock');
		expect(result.committed).toEqual([]);
		expect(await gitText(root, ['rev-parse', 'HEAD'])).toBe(before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('supports a first commit without inventing a HEAD', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-unborn-'));
	try {
		await gitText(root, ['init', '-b', 'main']);
		await gitText(root, ['config', 'user.name', 'Fixture']);
		await gitText(root, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(root, 'first.txt'), 'first\n');
		const scopes = await discoverScopes(root),
			preview = await previewCommits(scopes);
		expect(preview.scopes[0]!.head).toBeNull();
		expect(preview.scopes[0]!.files[0]!.diff?.before).toBeNull();
		const result = await commitPreview(preview, scopes, 'Initial commit');
		expect(result.error).toBeNull();
		expect(result.committed).toHaveLength(1);
		expect((await previewCommits(scopes)).scopes).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('commits baskets in order with hooks, stops at a failing hook and retries the rest (spec/git#commit-dialog)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-baskets-'));
	try {
		await init(root);
		await gitText(root, ['config', 'core.hooksPath', '.git/hooks']);
		await mkdir(join(root, '.git/hooks'), { recursive: true });
		await writeFile(
			join(root, '.git/hooks/pre-commit'),
			'#!/bin/sh\nif git diff --cached --name-only | grep -q bad.txt; then echo "lint: 2 problems in bad.txt"; exit 1; fi\n',
			{ mode: 0o755 }
		);
		await gitText(root, ['mv', 'file.txt', 'renamed.txt']);
		await writeFile(join(root, 'a.txt'), 'a\n');
		await writeFile(join(root, 'bad.txt'), 'bad\n');
		await writeFile(join(root, 'c.txt'), 'c\n');
		const scopes = await discoverScopes(root),
			scopeId = scopes[0]!.id;
		let preview = await previewCommits(scopes);
		const steps: string[] = [];
		const plan = [
			{ id: 'b1', scopeId, message: 'First: rename and a', files: ['renamed.txt', 'a.txt'] },
			{ id: 'b2', scopeId, message: 'Second: bad', files: ['bad.txt'] },
			{ id: 'b3', scopeId, message: 'Third: c', files: ['c.txt'] },
		];
		const result = await commitBaskets(preview, scopes, plan, undefined, (id, state) =>
			steps.push(`${id}:${state}`)
		);
		expect(steps).toEqual(['b1:running', 'b1:done', 'b2:running', 'b2:failed']);
		expect(result.committed).toHaveLength(1);
		expect(result.baskets.map((basket) => basket.state)).toEqual(['done', 'failed', 'waiting']);
		expect(result.baskets[1]!.output).toContain('lint: 2 problems in bad.txt');
		expect(await gitText(root, ['log', '-1', '--format=%s'])).toBe('First: rename and a');
		expect(
			(await gitText(root, ['show', '--name-status', '--format=', 'HEAD'])).split('\n').sort()
		).toEqual(['A\ta.txt', 'R100\tfile.txt\trenamed.txt']);
		// Retry the rest after the fix: a fresh preview, the remaining baskets; a committed file is no longer there.
		await writeFile(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
		preview = await previewCommits(scopes);
		await expect(
			commitBaskets(preview, scopes, [{ ...plan[0]!, files: ['a.txt'] }])
		).rejects.toThrow('Files changed');
		const retry = await commitBaskets(preview, scopes, plan.slice(1));
		expect(retry.error).toBeNull();
		expect(await gitText(root, ['log', '--format=%s', '-3'])).toBe(
			'Third: c\nSecond: bad\nFirst: rename and a'
		);
		expect(await gitText(root, ['status', '--porcelain'])).toBe('');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('commits the reviewed blobs of a basket, not a later edit of the working tree', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commit-reviewed-'));
	try {
		await init(root);
		await writeFile(join(root, 'a.txt'), 'reviewed\n');
		await writeFile(join(root, 'b.txt'), 'b\n');
		const scopes = await discoverScopes(root),
			scopeId = scopes[0]!.id,
			preview = await previewCommits(scopes);
		const result = await commitBaskets(
			preview,
			scopes,
			[
				{ id: 'b1', scopeId, message: 'A', files: ['a.txt'] },
				{ id: 'b2', scopeId, message: 'B', files: ['b.txt'] },
			],
			undefined,
			(id, state) => {
				// Something rewrites a.txt between the baskets; the first commit already holds the reviewed text.
				if (id === 'b1' && state === 'done') writeFileSync(join(root, 'a.txt'), 'later\n');
			}
		);
		expect(result.error).toBeNull();
		expect(await gitText(root, ['show', 'HEAD~1:a.txt'])).toBe('reviewed');
		expect(await gitText(root, ['show', 'HEAD:b.txt'])).toBe('b');
		expect(await gitText(root, ['status', '--porcelain'])).toBe('M a.txt');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
