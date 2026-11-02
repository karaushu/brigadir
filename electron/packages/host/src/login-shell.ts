import { accessSync, constants } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, isAbsolute } from 'node:path';

/** Shells that take `-l -c 'exec "$@"' name args…` the way sh does (spec/architecture-and-platform#linux-package). */
const posixShells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'yash', 'ash']);

const executable = (path: string) => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

/** The passwd entry's shell, through NSS (LDAP and SSSD included); null when the OS does not say. */
function passwdShell(): string | null {
	try {
		return userInfo().shell ?? null;
	} catch {
		return null;
	}
}

/**
 * spec/architecture-and-platform#linux-package: the person's login shell — `$SHELL`, else the passwd entry, else `/bin/zsh` on macOS and `/bin/sh` elsewhere.
 * Only an absolute path to an executable counts.
 */
export function loginShell(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
	options: { passwd?: () => string | null; usable?: (path: string) => boolean } = {}
): string {
	const usable = options.usable ?? executable;
	for (const candidate of [env.SHELL, (options.passwd ?? passwdShell)()])
		if (candidate && isAbsolute(candidate) && usable(candidate)) return candidate;
	return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

/**
 * spec/architecture-and-platform#linux-package: how the agent's CLI starts in its terminal. macOS keeps `/bin/zsh -l`. Elsewhere the login shell runs it,
 * so what the person exports in their profile (API keys, version managers' PATH) reaches the agent: sh-like shells take
 * `exec "$@"` with a `$0`, fish takes `exec $argv`, and any other shell (nu, xonsh, tcsh, elvish) is replaced by `/bin/sh -l`
 * — main has already put the login shell's PATH into the environment (spec/architecture-and-platform#packaging).
 */
export function agentShell(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	shell: string = loginShell(process.env, platform)
): { file: string; args: string[] } {
	const file = platform === 'darwin' ? '/bin/zsh' : shell;
	const name = basename(file);
	if (name === 'fish') return { file, args: ['-l', '-c', 'exec $argv', command, ...args] };
	if (posixShells.has(name))
		return { file, args: ['-l', '-c', 'exec "$@"', 'brigadir', command, ...args] };
	return { file: '/bin/sh', args: ['-l', '-c', 'exec "$@"', 'brigadir', command, ...args] };
}
