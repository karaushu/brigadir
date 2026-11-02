import type { AgentProvider } from '@brigadir/core';
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
export type AdapterCommand = { command: string; args: string[] };
/** Only launch names live here. Modes, models and capabilities always come from ACP. */
const adapters = {
	claude: { binary: 'claude-agent-acp', package: '@agentclientprotocol/claude-agent-acp' },
	codex: { binary: 'codex-acp', package: '@agentclientprotocol/codex-acp' },
} satisfies Record<AgentProvider, { binary: string; package: string }>;
export function adapterCommand(
	provider: AgentProvider,
	searchPath = process.env.PATH ?? ''
): AdapterCommand {
	const adapter = adapters[provider];
	for (const directory of searchPath.split(delimiter).filter(Boolean)) {
		const command = resolve(directory, adapter.binary);
		try {
			accessSync(command, constants.X_OK);
			return { command, args: [] };
		} catch {
			/* next directory */
		}
	}
	// An adapter npx already installed runs directly. Through `npx` every session would pay a registry
	// check and keep an `npm exec` parent (~88 MB) alive for its whole life; refreshAdapterCache brings updates.
	const installed = installedAdapter(provider);
	return installed
		? { command: installed, args: [] }
		: { command: 'npx', args: ['--yes', adapter.package] };
}
const npxRoot = () => join(process.env.npm_config_cache ?? join(homedir(), '.npm'), '_npx');
const newer = (a: string, b: string) => {
	const x = a.split(/[.-]/).map(Number),
		y = b.split(/[.-]/).map(Number);
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
};
/** The highest installed version of the provider's adapter in the npx cache, or null. Read-only and synchronous (a few directories). */
export function installedAdapter(provider: AgentProvider, root = npxRoot()): string | null {
	const adapter = adapters[provider];
	let best: { bin: string; version: string } | null = null;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return null;
	}
	for (const entry of entries) {
		const dir = join(root, entry, 'node_modules'),
			bin = join(dir, '.bin', adapter.binary);
		try {
			const version = String(
				(
					JSON.parse(readFileSync(join(dir, adapter.package, 'package.json'), 'utf8')) as {
						version?: unknown;
					}
				).version ?? ''
			);
			if (!/^\d+\.\d+\.\d+/.test(version) || !completeInstall(dir)) continue;
			accessSync(bin, constants.X_OK);
			if (!best || newer(version, best.version)) best = { bin, version };
		} catch {
			/* not this adapter */
		}
	}
	return best?.bin ?? null;
}
/** spec/agents-and-providers#adapter-launch: every package npm recorded as installed (`node_modules/.package-lock.json`) still has its `package.json`.
 *  An install cut off mid-download (the refresh timer, a quit) leaves a dependency without it — for Claude, a truncated
 *  native `claude` that every spawn rejects (EBADMACHO), while npx keeps reusing the folder as installed. */
function completeInstall(modules: string): boolean {
	try {
		const lock = JSON.parse(readFileSync(join(modules, '.package-lock.json'), 'utf8')) as {
			packages?: Record<string, unknown>;
		};
		return Object.keys(lock.packages ?? {}).every(
			(path) =>
				!path.startsWith('node_modules/') || existsSync(join(modules, '..', path, 'package.json'))
		);
	} catch {
		return false;
	}
}
/** Installs the latest adapter into the npx cache without running it; the app calls this once per start.
 *  spec/agents-and-providers#adapter-launch: first removes the provider's incomplete installs, so npx downloads them again instead of reusing the folder. */
export function adapterRefreshCommand(provider: AgentProvider, root = npxRoot()): AdapterCommand {
	const adapter = adapters[provider];
	let entries: string[] = [];
	try {
		entries = readdirSync(root);
	} catch {
		/* no cache yet */
	}
	for (const entry of entries) {
		const modules = join(root, entry, 'node_modules');
		if (existsSync(join(modules, adapter.package, 'package.json')) && !completeInstall(modules))
			rmSync(join(root, entry), { recursive: true, force: true });
	}
	return {
		command: 'npx',
		args: ['--yes', `--package=${adapters[provider].package}@latest`, '--', 'node', '-e', ''],
	};
}
/** spec/agents-and-providers#quota-sources: the `codex` CLI the cached codex-acp already depends on (`@openai/codex`), else `codex` from PATH.
 *  Null when neither exists: Codex limits are then simply unknown. */
export function codexCommand(
	searchPath = process.env.PATH ?? '',
	root = npxRoot()
): AdapterCommand | null {
	const adapter = installedAdapter('codex', root);
	const candidates = [
		...(adapter ? [join(dirname(adapter), 'codex')] : []),
		...searchPath
			.split(delimiter)
			.filter(Boolean)
			.map((directory) => resolve(directory, 'codex')),
	];
	return firstExecutable(candidates);
}
/** spec/agents-and-providers#quota-sources: the unmodified `claude` from PATH reads `/usage`, no ACP adapter.
 *  Null without it: the `/usage` windows are then unknown, turns still bring 5h and 7d. */
export function claudeCommand(searchPath = process.env.PATH ?? ''): AdapterCommand | null {
	return firstExecutable(
		searchPath
			.split(delimiter)
			.filter(Boolean)
			.map((directory) => resolve(directory, 'claude'))
	);
}
function firstExecutable(candidates: string[]): AdapterCommand | null {
	for (const command of candidates) {
		try {
			accessSync(command, constants.X_OK);
			return { command, args: [] };
		} catch {
			/* next */
		}
	}
	return null;
}
