import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore } from '@brigadir/persistence';
import { LaunchSettingsStore, defaultBaseRef, unattendedBaseRef } from './launch-settings';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
it('drops the crew a project remembered: the sheet starts on Auto and the file no longer keeps it (spec/tasks#sheet-rail)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-settings-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'x\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		settings = new LaunchSettingsStore(store.root, () => 'in-place'),
		file = join(store.root, 'projects', project.id, 'workspace.json');
	for (const crewTemplateId of ['compose', 'mine']) {
		await writeFile(
			file,
			JSON.stringify({
				schemaVersion: 1,
				settings: {
					isolation: 'worktree',
					baseRef: 'main',
					setupCommand: 'pnpm i',
					scopes: [],
					crewTemplateId,
				},
			})
		);
		const read = await settings.read(project.id);
		expect(read).not.toHaveProperty('crewTemplateId');
		expect(read.baseRef).toBe('main');
		expect(read.setupCommand).toBe('pnpm i');
		await settings.save(project.id, { ...read, branch: 'brigadir/x' });
		const saved = JSON.parse(await readFile(file, 'utf8')) as { settings: Record<string, unknown> };
		expect(saved.settings).not.toHaveProperty('crewTemplateId');
		expect(saved.settings.baseRef).toBe('main');
	}
});
it('a project with no remembered base starts from its own default branch (spec/tasks#sheet-base-ref)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-base-ref-'));
	roots.push(root);
	const repo = join(root, 'repo'),
		remote = join(root, 'remote.git');
	await mkdir(repo);
	const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
	await git(root, 'init', '-q', '--bare', '-b', 'develop', remote);
	await git(repo, 'init', '-q', '-b', 'develop');
	await git(repo, 'config', 'user.name', 'Fixture');
	await git(repo, 'config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'x\n');
	await git(repo, 'add', '.');
	await git(repo, 'commit', '-q', '-m', 'Initial');
	// A repo without a remote: its own checkout.
	expect(await defaultBaseRef(repo)).toBe('HEAD');
	await git(repo, 'remote', 'add', 'origin', remote);
	await git(repo, 'push', '-q', 'origin', 'develop');
	await git(repo, 'fetch', '-q', 'origin');
	await git(repo, 'remote', 'set-head', 'origin', '-d');
	// No origin/HEAD and neither main nor master: still the checkout.
	expect(await defaultBaseRef(repo)).toBe('HEAD');
	await git(repo, 'remote', 'set-head', 'origin', 'develop');
	expect(await defaultBaseRef(repo)).toBe('origin/develop');
});
it('a task with no sheet starts from the branch named, else a remembered base that still exists, else the default (spec/notifications-slack-notes-and-schedules#slack-agent)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-unattended-base-'));
	roots.push(root);
	const repo = join(root, 'repo'),
		remote = join(root, 'remote.git');
	await mkdir(repo);
	const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
	await git(root, 'init', '-q', '--bare', '-b', 'master', remote);
	await git(repo, 'init', '-q', '-b', 'master');
	await git(repo, 'config', 'user.name', 'Fixture');
	await git(repo, 'config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'x\n');
	await git(repo, 'add', '.');
	await git(repo, 'commit', '-q', '-m', 'Initial');
	await git(repo, 'remote', 'add', 'origin', remote);
	await git(repo, 'push', '-q', 'origin', 'master', 'master:release');
	await git(repo, 'fetch', '-q', 'origin', 'master');
	await git(repo, 'remote', 'set-head', 'origin', 'master');
	// The remembered `origin/main` is not in this repo: its default instead of a failed fetch.
	expect(await unattendedBaseRef(repo, 'origin/main', null)).toBe('origin/master');
	expect(await unattendedBaseRef(repo, 'origin/master', null)).toBe('origin/master');
	// A named branch: the remote's, even one not fetched yet; one nobody has is an error that names it.
	expect(await unattendedBaseRef(repo, 'origin/main', 'master')).toBe('origin/master');
	expect(await unattendedBaseRef(repo, 'origin/main', 'release')).toBe('origin/release');
	await expect(unattendedBaseRef(repo, 'origin/master', 'main')).rejects.toThrow('No branch main');
});
