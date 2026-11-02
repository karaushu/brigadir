import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitText } from './command';
import { discoverScopes } from './scopes';
import { publishState, pushReviewed } from './publish';
it('uses origin/base for ahead counts and pushes only the reviewed head to a local bare remote', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-publish-')),
		repo = join(root, 'repo'),
		remote = join(root, 'remote.git');
	try {
		await mkdir(repo);
		await mkdir(remote);
		await gitText(remote, ['init', '--bare', '-b', 'main']);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'file'), 'first');
		await gitText(repo, ['add', 'file']);
		await gitText(repo, ['commit', '-m', 'Initial']);
		await gitText(repo, ['remote', 'add', 'origin', remote]);
		await gitText(repo, ['push', '-u', 'origin', 'main']);
		await gitText(repo, ['switch', '-c', 'feature']);
		await writeFile(join(repo, 'file'), 'second');
		await gitText(repo, ['commit', '-am', 'Next']);
		const scopes = await discoverScopes(repo),
			scope = scopes[0]!,
			state = await publishState(scope, scopes, 'main');
		expect(state).toMatchObject({
			ahead: 1,
			pushAhead: 1,
			published: false,
			baseRef: 'origin/main',
		});
		expect(state.commits[0]?.subject).toBe('Next');
		await pushReviewed(scope, state);
		expect(await gitText(remote, ['rev-parse', 'refs/heads/feature'])).toBe(state.head);
		expect((await publishState(scope, scopes, 'main')).pushAhead).toBe(0);
		expect(await gitText(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
			'origin/feature'
		);
		await writeFile(join(repo, 'file'), 'third');
		await gitText(repo, ['commit', '-am', 'Unseen']);
		await expect(pushReviewed(scope, state)).rejects.toThrow('changed');
		expect(await gitText(remote, ['rev-parse', 'refs/heads/feature'])).toBe(state.head);
		// Simulate an updated remote base while local main remains behind.
		await gitText(repo, [
			'update-ref',
			'refs/remotes/origin/main',
			await gitText(repo, ['rev-parse', 'HEAD']),
		]);
		expect((await publishState(scope, scopes, 'main')).ahead).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
