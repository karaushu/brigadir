import { execFile } from 'node:child_process';
import { access, chmod, constants, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
	isEnvironmentCheck,
	signInCommands,
	versionOf,
	type AgentCheck,
	type EnvironmentCheck,
} from '@brigadir/core';
import { adapterCommand } from '@brigadir/transport';
import { Forge, ghCommand } from '@brigadir/forge';
import { loginShell } from '@brigadir/host/login-shell';
type Run = (
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv
) => Promise<{ code: number; stdout: string; stderr: string }>;
const run: Run = (command, args, env) =>
	new Promise((done) => {
		execFile(command, args, { env, timeout: 8000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
			const code = error
				? typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
					? Number((error as { code: number }).code)
					: 127
				: 0;
			done({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
/**
 * A Mac app opened from Finder gets a short PATH (/usr/bin:/bin…): the login shell's PATH is where npm, brew and the CLIs
 * live. A Linux desktop session's PATH misses what `.bashrc` adds (Fedora puts `~/.local/bin` there, where Claude Code's
 * installer goes), so it is read the same way from the person's login shell (spec/architecture-and-platform#linux-package); fish joins `$PATH` with `:` too.
 */
let shellPath: Promise<string> | null = null;
async function readShellPath(runner: Run, platform: NodeJS.Platform = process.platform) {
	const shell = loginShell(process.env, platform);
	const result = await runner(shell, ['-ilc', 'printf %s "$PATH"'], process.env).catch(() => null);
	const found = result && result.code === 0 ? (result.stdout.trim().split('\n').pop() ?? '') : '';
	return [
		...new Set(
			[
				...found.split(delimiter),
				...(process.env.PATH ?? '').split(delimiter),
				...(platform === 'darwin'
					? ['/opt/homebrew/bin', '/usr/local/bin']
					: [join(homedir(), '.local/bin'), '/usr/local/bin']),
			].filter(Boolean)
		),
	].join(delimiter);
}
/**
 * spec/remote-access-and-mobile#browser-from-device: a folder whose `open` and `xdg-open` do nothing, first in the PATH of a sign-in a device started: the
 * agent's CLI prints its page instead of opening it on this machine, and the device opens it.
 */
let quietFolder: Promise<string> | null = null;
export function quietBrowser(): Promise<string> {
	quietFolder ??= (async () => {
		const folder = join(tmpdir(), 'brigadir-quiet-browser');
		await mkdir(folder, { recursive: true, mode: 0o700 });
		for (const name of ['open', 'xdg-open']) {
			const file = join(folder, name);
			await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
			await chmod(file, 0o700);
		}
		return folder;
	})().catch((error: unknown) => {
		quietFolder = null;
		throw error;
	});
	return quietFolder;
}
/** Read once per start; a test passes its own runner and gets a fresh read. */
export function loginShellPath(
	runner: Run = run,
	platform: NodeJS.Platform = process.platform
): Promise<string> {
	if (runner !== run) return readShellPath(runner, platform);
	shellPath ??= readShellPath(run);
	return shellPath;
}
async function onPath(name: string, path: string) {
	for (const directory of path.split(delimiter).filter(Boolean)) {
		const command = resolve(directory, name);
		try {
			await access(command, constants.X_OK);
			return command;
		} catch {
			/* next */
		}
	}
	return null;
}
const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);
/** spec/settings-modules-and-onboarding#settings-keys. Nothing here asks for a password: the Keychain lookup checks that Claude Code's item exists, not its value. */
export class EnvironmentCheckService {
	constructor(
		private runner: Run = run,
		private home = homedir(),
		private searchPath: () => Promise<string> = () => loginShellPath(runner),
		private platform: NodeJS.Platform = process.platform
	) {}
	async check(): Promise<EnvironmentCheck> {
		const fake = process.env.BRIGADIR_TEST_ENVIRONMENT;
		if (fake) {
			const value: unknown = JSON.parse(fake);
			if (!isEnvironmentCheck(value)) throw new Error('Invalid test environment');
			return value;
		}
		const path = await this.searchPath(),
			env = { ...process.env, PATH: path };
		const [claude, codex, git, gh] = await Promise.all([
			this.agent('claude', path, env),
			this.agent('codex', path, env),
			this.tool('git', path, env),
			this.gh(path, env),
		]);
		return { agents: [claude, codex], git, gh };
	}
	private async agent(
		provider: 'claude' | 'codex',
		path: string,
		env: NodeJS.ProcessEnv
	): Promise<AgentCheck> {
		const adapter = adapterCommand(provider, path),
			cli = await onPath(provider, path),
			npx = await onPath('npx', path);
		const via =
			adapter.command !== 'npx'
				? adapter.command.includes(`${'/_npx/'}`)
					? 'cache'
					: 'path'
				: npx
					? 'npx'
					: null;
		const version = cli ? versionOf((await this.runner(cli, ['--version'], env)).stdout) : null;
		return {
			provider,
			found: Boolean(via || cli),
			via,
			version,
			signIn: await this.signIn(provider, env, cli),
		};
	}
	private async signIn(
		provider: 'claude' | 'codex',
		env: NodeJS.ProcessEnv,
		cli: string | null
	): Promise<AgentCheck['signIn']> {
		let stored: AgentCheck['signIn'];
		if (provider === 'codex')
			stored = (await exists(
				join(process.env.CODEX_HOME ?? join(this.home, '.codex'), 'auth.json')
			))
				? 'signed-in'
				: 'signed-out';
		else if (
			await exists(
				join(process.env.CLAUDE_CONFIG_DIR ?? join(this.home, '.claude'), '.credentials.json')
			)
		)
			stored = 'signed-in';
		// spec/architecture-and-platform#linux-package: only macOS keeps Claude Code's sign-in in the Keychain; elsewhere the file is all there is.
		else if (this.platform !== 'darwin') stored = 'signed-out';
		else {
			const keychain = await this.runner(
				'/usr/bin/security',
				['find-generic-password', '-s', 'Claude Code-credentials'],
				env
			);
			stored = keychain.code === 0 ? 'signed-in' : keychain.code === 44 ? 'signed-out' : 'unknown';
		}
		// spec/agents-and-providers#sign-in-recovery: a stored sign-in can be expired; the CLI's own status says so (the Keychain item outlives the session).
		return stored === 'signed-in' && cli && (await this.signedIn(provider, cli, env)) === false
			? 'expired'
			: stored;
	}
	/** spec/agents-and-providers#sign-in-recovery: the CLI's own sign-in status; null when it cannot tell (old CLI, unreadable output). */
	async signedIn(
		provider: 'claude' | 'codex',
		cli?: string | null,
		env?: NodeJS.ProcessEnv
	): Promise<boolean | null> {
		if (process.env.BRIGADIR_TEST_LOGIN) return null;
		const path = env?.PATH ?? (await this.searchPath()),
			command = cli ?? (await onPath(provider, path));
		if (!command) return null;
		const result = await this.runner(
			command,
			provider === 'claude' ? ['auth', 'status'] : ['login', 'status'],
			env ?? { ...process.env, PATH: path }
		);
		if (provider === 'codex')
			return result.code === 0
				? true
				: /not logged in/i.test(result.stdout + result.stderr)
					? false
					: null;
		try {
			const value: unknown = JSON.parse(result.stdout);
			return value &&
				typeof value === 'object' &&
				typeof (value as { loggedIn?: unknown }).loggedIn === 'boolean'
				? (value as { loggedIn: boolean }).loggedIn
				: null;
		} catch {
			return null;
		}
	}
	private async tool(name: string, path: string, env: NodeJS.ProcessEnv) {
		const command = await onPath(name, path);
		if (!command) return { found: false, version: null };
		return {
			found: true,
			version: versionOf((await this.runner(command, ['--version'], env)).stdout),
		};
	}
	private async gh(path: string, env: NodeJS.ProcessEnv) {
		const command = await onPath('gh', path);
		if (!command) return { auth: 'missing' as const, version: null };
		const forge = new Forge(ghCommand(command));
		return {
			auth: await forge.auth(this.home),
			version: versionOf((await this.runner(command, ['--version'], env)).stdout),
		};
	}
	/** spec/agents-and-providers#cli-updates: the provider's CLI from the login shell's PATH for its own `update`; null without one. A test passes a script
	 *  through `BRIGADIR_TEST_CLI_UPDATE` that stands in for both CLIs. */
	async cliCommand(
		provider: 'claude' | 'codex'
	): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv } | null> {
		const path = await this.searchPath(),
			env = { ...process.env, PATH: path },
			fake = process.env.BRIGADIR_TEST_CLI_UPDATE;
		if (fake)
			return {
				command: process.execPath,
				args: [fake, provider],
				env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
			};
		const command = await onPath(provider, path);
		return command ? { command, args: [], env: { ...env, ELECTRON_RUN_AS_NODE: undefined } } : null;
	}
	/** spec/agents-and-providers#sign-in-recovery: the agent's own sign-in command, run by the app; a test passes a script through `BRIGADIR_TEST_LOGIN`. */
	async loginCommand(provider: 'claude' | 'codex', quiet = false) {
		const path = await this.searchPath(),
			// spec/remote-access-and-mobile#browser-from-device: a sign-in for a device — `open` and `xdg-open` that do nothing come first, `BROWSER` is empty.
			env = quiet
				? { ...process.env, PATH: `${await quietBrowser()}${delimiter}${path}`, BROWSER: 'true' }
				: { ...process.env, PATH: path },
			fake = process.env.BRIGADIR_TEST_LOGIN;
		if (fake)
			return {
				command: process.execPath,
				args: [fake, provider],
				env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
			};
		const command = await onPath(provider, path);
		if (!command) throw new Error(`${provider} is not installed`);
		return { command, args: [...signInCommands[provider]], env };
	}
}
