import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@brigadir/core';

/** The text of a small config file, or '' when it does not exist or cannot be read. */
function readText(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return '';
	}
}
function readJson(path: string): unknown {
	try {
		return JSON.parse(readText(path)) as unknown;
	} catch {
		return null;
	}
}
/**
 * spec/agents-and-providers#compaction-window: the person set Claude's window themselves — the variable in the environment, or
 * `autoCompactWindow` / `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` in their user settings or the session folder's project settings.
 */
export function personClaudeWindow(
	env: NodeJS.ProcessEnv,
	cwd: string,
	home: string = homedir()
): boolean {
	if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) return true;
	const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
	return [
		join(config, 'settings.json'),
		join(cwd, '.claude', 'settings.json'),
		join(cwd, '.claude', 'settings.local.json'),
	].some((path) => {
		const settings = readJson(path);
		return (
			isRecord(settings) &&
			(settings.autoCompactWindow !== undefined ||
				(isRecord(settings.env) && settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined))
		);
	});
}
/**
 * spec/agents-and-providers#compaction-window: the person set Codex's limit themselves — the key in their own `CODEX_CONFIG`, or a
 * `model_auto_compact_token_limit` line in their `config.toml` or the session folder's `.codex/config.toml` (any table: a profile counts too).
 */
export function personCodexLimit(
	overrides: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
	cwd: string,
	home: string = homedir()
): boolean {
	if (overrides.model_auto_compact_token_limit !== undefined) return true;
	const codex = env.CODEX_HOME || join(home, '.codex');
	return [join(codex, 'config.toml'), join(cwd, '.codex', 'config.toml')].some((path) =>
		/^[ \t]*["']?model_auto_compact_token_limit["']?[ \t]*=/m.test(readText(path))
	);
}
