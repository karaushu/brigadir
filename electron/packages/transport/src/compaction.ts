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
		tomlHasKey(readText(path), 'model_auto_compact_token_limit')
	);
}
/**
 * Whether a TOML document sets `key` in any table: a key at the start of a line, or inside an inline table, whose last dotted part is `key`.
 * Strings (multi-line ones included), comments and array values are skipped, so the same text inside a value is not a key. Not a full parser:
 * a malformed document is read as far as it goes.
 */
export function tomlHasKey(text: string, key: string): boolean {
	const bare = /[A-Za-z0-9_-]/;
	const stack: ('[' | '{')[] = [];
	let i = 0,
		atKey = true;
	/** The end of a string that opens at `i` with `quote` (one or three characters), or the end of the text. */
	const skipString = (quote: string): number => {
		const escapes = quote[0] === '"';
		let j = i + quote.length;
		while (j < text.length) {
			if (escapes && text[j] === '\\') j += 2;
			else if (text.startsWith(quote, j)) {
				j += quote.length;
				// A multi-line string may end with up to two more quotes of its own.
				while (quote.length === 3 && text[j] === quote[0]) j++;
				return j;
			} else if (quote.length === 1 && text[j] === '\n') return j;
			else j++;
		}
		return j;
	};
	/** A dotted key at `i` followed by `=`: its last part, and where the value starts; null when there is none. */
	const readKey = (): { last: string; end: number } | null => {
		let j = i,
			last = '';
		for (;;) {
			while (text[j] === ' ' || text[j] === '\t') j++;
			if (text[j] === '"' || text[j] === "'") {
				const start = j;
				i = j;
				j = skipString(text[j]!);
				last = text.slice(start + 1, j - 1);
			} else {
				const start = j;
				while (j < text.length && bare.test(text[j]!)) j++;
				if (j === start) return null;
				last = text.slice(start, j);
			}
			while (text[j] === ' ' || text[j] === '\t') j++;
			if (text[j] === '.') j++;
			else return text[j] === '=' ? { last, end: j + 1 } : null;
		}
	};
	while (i < text.length) {
		const c = text[i]!;
		if (c === '\n') {
			atKey = stack.length === 0;
			i++;
		} else if (c === ' ' || c === '\t' || c === '\r') i++;
		else if (c === '#') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (atKey && stack.length === 0 && c === '[') {
			// A table header: `[table]` or `[[array.of.tables]]`.
			while (i < text.length && text[i] !== '\n') i++;
		} else if (atKey) {
			const start = i,
				found = readKey();
			if (found?.last === key) return true;
			i = found ? found.end : start + 1;
			atKey = false;
		} else if (c === '"' || c === "'") {
			i = skipString(text.startsWith(c.repeat(3), i) ? c.repeat(3) : c);
		} else if (c === '[' || c === '{') {
			stack.push(c);
			atKey = c === '{';
			i++;
		} else if (c === ']' || c === '}') {
			stack.pop();
			i++;
		} else if (c === ',') {
			atKey = stack.at(-1) === '{';
			i++;
		} else i++;
	}
	return false;
}
