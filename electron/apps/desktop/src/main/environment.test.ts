import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionOf } from '@brigadir/core';
import { EnvironmentCheckService, loginShellPath } from './environment';
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function bin(dir: string, name: string) {
	const file = join(dir, name);
	await writeFile(file, '#!/bin/sh\necho ok\n');
	await chmod(file, 0o755);
	return file;
}
it('reads versions from --version lines', () => {
	expect(versionOf('git version 2.50.1 (Apple Git-155)')).toBe('2.50.1');
	expect(versionOf('gh version 2.74.0 (2025-06-10)')).toBe('2.74.0');
	expect(versionOf('nothing')).toBeNull();
});
// spec/settings-modules-and-onboarding#settings-keys: agents found on PATH, sign-in read from files and the Keychain item, git and gh with versions.
it('checks agents, sign-in, git and gh without asking for secrets', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-environment-'));
	roots.push(root);
	const binDir = join(root, 'bin'),
		home = join(root, 'home');
	await mkdir(binDir);
	await mkdir(join(home, '.codex'), { recursive: true });
	await bin(binDir, 'claude-agent-acp');
	await bin(binDir, 'claude');
	await bin(binDir, 'git');
	await writeFile(join(home, '.codex', 'auth.json'), '{}');
	const calls: string[][] = [];
	const service = new EnvironmentCheckService(
		async (command, args) => {
			calls.push([command, ...args]);
			if (args[0] === '-ilc') return { code: 0, stdout: binDir, stderr: '' };
			if (command.endsWith('/claude'))
				return { code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
			if (command.endsWith('/git')) return { code: 0, stdout: 'git version 2.50.1\n', stderr: '' };
			if (command === '/usr/bin/security') return { code: 0, stdout: 'keychain: …', stderr: '' };
			return { code: 127, stdout: '', stderr: '' };
		},
		home,
		async () => binDir
	);
	const saved = process.env.PATH;
	process.env.PATH = '/usr/bin:/bin';
	try {
		const result = await service.check();
		expect(result.agents[0]).toEqual({
			provider: 'claude',
			found: true,
			via: 'path',
			version: '2.1.0',
			signIn: 'signed-in',
		});
		expect(result.agents[1]).toMatchObject({
			provider: 'codex',
			signIn: 'signed-in',
			version: null,
		});
		expect(result.git).toEqual({ found: true, version: '2.50.1' });
		expect(result.gh.auth).toBe('missing');
		const keychain = calls.find((call) => call[0] === '/usr/bin/security')!;
		expect(keychain).not.toContain('-w');
		expect(keychain).not.toContain('-g');
	} finally {
		process.env.PATH = saved;
	}
});
it('keeps the login shell PATH ahead of the short app PATH', async () => {
	const path = await loginShellPath(async () => ({
		code: 0,
		stdout: 'motd\n/opt/tools/bin:/usr/bin',
		stderr: '',
	}));
	expect(path.split(':').slice(0, 2)).toEqual(['/opt/tools/bin', '/usr/bin']);
});
// spec/architecture-and-platform#linux-package: Claude Code keeps its sign-in in a file on Linux; the Keychain is never asked there.
it('reads the Claude sign-in from the credentials file on Linux, without the Keychain', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-environment-linux-'));
	roots.push(root);
	const binDir = join(root, 'bin'),
		home = join(root, 'home');
	await mkdir(binDir);
	await mkdir(join(home, '.claude'), { recursive: true });
	await bin(binDir, 'claude');
	const calls: string[][] = [];
	const runner = async (command: string, args: string[]) => {
		calls.push([command, ...args]);
		return command.endsWith('/claude')
			? { code: 0, stdout: '{"loggedIn":true}', stderr: '' }
			: { code: 127, stdout: '', stderr: '' };
	};
	const service = new EnvironmentCheckService(runner, home, async () => binDir, 'linux');
	expect((await service.check()).agents[0]!.signIn).toBe('signed-out');
	await writeFile(join(home, '.claude', '.credentials.json'), '{}');
	expect((await service.check()).agents[0]!.signIn).toBe('signed-in');
	expect(calls.some((call) => call[0] === '/usr/bin/security')).toBe(false);
});
it('adds ~/.local/bin on Linux and Homebrew on macOS after the login shell PATH (spec/architecture-and-platform#linux-package)', async () => {
	const shell = async () => ({ code: 0, stdout: '/opt/tools/bin', stderr: '' });
	const saved = process.env.PATH;
	process.env.PATH = '/usr/bin:/bin';
	try {
		const linux = (await loginShellPath(shell, 'linux')).split(':');
		expect(linux[0]).toBe('/opt/tools/bin');
		expect(linux.some((entry) => entry.endsWith('/.local/bin'))).toBe(true);
		expect(linux).not.toContain('/opt/homebrew/bin');
		expect((await loginShellPath(shell, 'darwin')).split(':')).toContain('/opt/homebrew/bin');
	} finally {
		process.env.PATH = saved;
	}
});
