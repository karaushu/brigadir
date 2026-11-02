import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { agentShell, loginShell } from './login-shell';

describe('login shell (spec/architecture-and-platform#linux-package)', () => {
	const usable = (path: string) => !path.includes('missing');
	it('takes $SHELL, then the passwd entry, then the platform default', () => {
		expect(
			loginShell({ SHELL: '/usr/bin/fish' }, 'linux', { passwd: () => '/bin/bash', usable })
		).toBe('/usr/bin/fish');
		expect(loginShell({}, 'linux', { passwd: () => '/bin/bash', usable })).toBe('/bin/bash');
		// A relative or missing $SHELL does not count.
		expect(loginShell({ SHELL: 'zsh' }, 'linux', { passwd: () => '/bin/bash', usable })).toBe(
			'/bin/bash'
		);
		expect(
			loginShell({ SHELL: '/missing/zsh' }, 'linux', { passwd: () => '/bin/bash', usable })
		).toBe('/bin/bash');
		expect(loginShell({}, 'linux', { passwd: () => null, usable })).toBe('/bin/sh');
		expect(loginShell({}, 'darwin', { passwd: () => null, usable })).toBe('/bin/zsh');
	});
	it('starts the agent through the login shell on Linux and through zsh on macOS', () => {
		expect(agentShell('claude', ['--resume', 'x'], 'darwin', '/usr/bin/fish')).toEqual({
			file: '/bin/zsh',
			args: ['-l', '-c', 'exec "$@"', 'brigadir', 'claude', '--resume', 'x'],
		});
		expect(agentShell('claude', ['--resume', 'x'], 'linux', '/bin/bash')).toEqual({
			file: '/bin/bash',
			args: ['-l', '-c', 'exec "$@"', 'brigadir', 'claude', '--resume', 'x'],
		});
		expect(agentShell('codex', ['--', 'a prompt'], 'linux', '/usr/bin/fish')).toEqual({
			file: '/usr/bin/fish',
			args: ['-l', '-c', 'exec $argv', 'codex', '--', 'a prompt'],
		});
		// A shell that does not take `exec "$@"` gets /bin/sh; main already put the login shell's PATH in the environment.
		expect(agentShell('claude', [], 'linux', '/usr/bin/nu')).toEqual({
			file: '/bin/sh',
			args: ['-l', '-c', 'exec "$@"', 'brigadir', 'claude'],
		});
	});
	it.each(['/bin/bash', '/bin/zsh', '/bin/sh'])(
		'passes every argument through %s unchanged',
		(shell) => {
			const { file, args } = agentShell('printf', ['%s|', 'a b', "it's", '$HOME'], 'linux', shell);
			expect(execFileSync(file, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })).toBe(
				"a b|it's|$HOME|"
			);
		}
	);
});
