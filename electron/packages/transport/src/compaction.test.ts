import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personClaudeWindow, personCodexLimit, tomlHasKey } from './compaction';
let root: string, home: string, cwd: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'brigadir-compaction-'));
	home = join(root, 'home');
	cwd = join(root, 'project');
	await mkdir(join(home, '.claude'), { recursive: true });
	await mkdir(join(home, '.codex'), { recursive: true });
	await mkdir(join(cwd, '.claude'), { recursive: true });
	await mkdir(join(cwd, '.codex'), { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
// spec/agents-and-providers#compaction-window
it("finds the person's own Claude window in the environment and in every settings file", async () => {
	expect(personClaudeWindow({}, cwd, home)).toBe(false);
	expect(personClaudeWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }, cwd, home)).toBe(true);
	await writeFile(join(home, '.claude', 'settings.json'), '{"model":"opus"}');
	expect(personClaudeWindow({}, cwd, home)).toBe(false);
	await writeFile(join(cwd, '.claude', 'settings.local.json'), '{"autoCompactWindow":400000}');
	expect(personClaudeWindow({}, cwd, home)).toBe(true);
	await rm(join(cwd, '.claude', 'settings.local.json'));
	await writeFile(
		join(cwd, '.claude', 'settings.json'),
		'{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"500000"}}'
	);
	expect(personClaudeWindow({}, cwd, home)).toBe(true);
	await rm(join(cwd, '.claude', 'settings.json'));
	// `CLAUDE_CONFIG_DIR` moves the user settings; a file that does not parse sets nothing.
	const config = join(root, 'claude-config');
	await mkdir(config);
	await writeFile(join(config, 'settings.json'), '{"autoCompactWindow":300000}');
	expect(personClaudeWindow({ CLAUDE_CONFIG_DIR: config }, cwd, home)).toBe(true);
	await writeFile(join(config, 'settings.json'), '{"autoCompactWindow":');
	expect(personClaudeWindow({ CLAUDE_CONFIG_DIR: config }, cwd, home)).toBe(false);
});
it("finds the person's own Codex limit in CODEX_CONFIG and in every config.toml", async () => {
	expect(personCodexLimit({}, {}, cwd, home)).toBe(false);
	expect(personCodexLimit({ model_auto_compact_token_limit: 1 }, {}, cwd, home)).toBe(true);
	await writeFile(
		join(home, '.codex', 'config.toml'),
		'model = "x"\n# model_auto_compact_token_limit = 1\n'
	);
	expect(personCodexLimit({}, {}, cwd, home)).toBe(false);
	await writeFile(join(cwd, '.codex', 'config.toml'), 'model_auto_compact_token_limit = 90000\n');
	expect(personCodexLimit({}, {}, cwd, home)).toBe(true);
	await rm(join(cwd, '.codex', 'config.toml'));
	const codexHome = join(root, 'codex-home');
	await mkdir(codexHome);
	await writeFile(
		join(codexHome, 'config.toml'),
		'[profiles.a]\n  model_auto_compact_token_limit=1\n'
	);
	expect(personCodexLimit({}, { CODEX_HOME: codexHome }, cwd, home)).toBe(true);
});
it('reads only real TOML keys: the same text in a string, a comment or an array is not one', () => {
	const key = 'model_auto_compact_token_limit';
	for (const text of [
		'developer_instructions = """\nExample:\nmodel_auto_compact_token_limit = 1\n"""\n',
		"developer_instructions = \'\'\'\nmodel_auto_compact_token_limit = 1\n\'\'\'\n",
		'note = "model_auto_compact_token_limit = 1"\n',
		'# model_auto_compact_token_limit = 1\n',
		'list = [\n  "a",\n  "model_auto_compact_token_limit = 1",\n]\n',
		'[model_auto_compact_token_limit]\nmodel = "x"\n',
		'escaped = "a \\" model_auto_compact_token_limit = 1"\n',
	])
		expect(tomlHasKey(text, key)).toBe(false);
	for (const text of [
		'model_auto_compact_token_limit = 1\n',
		'model = "x"\n[profiles.long]\n  model_auto_compact_token_limit=1\n',
		'profiles.long.model_auto_compact_token_limit = 1\n',
		'"model_auto_compact_token_limit" = 1\n',
		'profiles = { long = { model = "x", model_auto_compact_token_limit = 1 } }\n',
		'instructions = """\ntext\n"""\nmodel_auto_compact_token_limit = 1\n',
	])
		expect(tomlHasKey(text, key)).toBe(true);
});
it("ignores the key inside the person's developer instructions", async () => {
	await writeFile(
		join(home, '.codex', 'config.toml'),
		'developer_instructions = """\nSet model_auto_compact_token_limit = 90000 for long runs.\nmodel_auto_compact_token_limit = 90000\n"""\n'
	);
	expect(personCodexLimit({}, {}, cwd, home)).toBe(false);
});
