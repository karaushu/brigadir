import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { open, readdir } from 'node:fs/promises';
import {
	findSpecAgent,
	isRecord,
	type AgentTask,
	type AppModules,
	type SlashCatalog,
	type SlashCommandInfo,
	isSlashCatalogRequest,
	type SlashCatalogRequest,
	type TaskKey,
} from '@brigadir/core';
import type { SessionStore } from '@brigadir/persistence';
export { isSlashCatalogRequest, type SlashCatalogRequest };
import { brigadirToolList, crewProcessRole, type CrewProcessRole } from '@brigadir/host/mcp-list';
/**
 * spec/composer#slash-menu: what the agent of a task will see in `/`, read from disk before it starts. Only reads: the files are the
 * agent's own settings and the project's, and nothing here starts a server or writes. Each file is read up to 64 KiB,
 * each folder up to 500 entries, so a huge plugin cache does not stall the menu.
 */
export type AgentHomes = { home: string; claude: string; claudeJson: string; codex: string };
export function agentHomes(env: NodeJS.ProcessEnv = process.env, home = homedir()): AgentHomes {
	// Claude Code moves both `~/.claude` and `~/.claude.json` into CLAUDE_CONFIG_DIR; Codex reads CODEX_HOME.
	const config = env.CLAUDE_CONFIG_DIR;
	return {
		home,
		claude: config ?? join(home, '.claude'),
		claudeJson: config ? join(config, '.claude.json') : join(home, '.claude.json'),
		codex: env.CODEX_HOME ?? join(home, '.codex'),
	};
}

const fileLimit = 64 * 1024,
	entryLimit = 500;
async function readText(path: string): Promise<string | null> {
	try {
		const handle = await open(path, 'r');
		try {
			const buffer = Buffer.alloc(fileLimit);
			const { bytesRead } = await handle.read(buffer, 0, fileLimit, 0);
			return buffer.subarray(0, bytesRead).toString('utf8');
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}
async function readJson(path: string, limit = fileLimit): Promise<Record<string, unknown> | null> {
	try {
		const handle = await open(path, 'r');
		try {
			const { size } = await handle.stat();
			if (size > limit) return null;
			const value: unknown = JSON.parse((await handle.readFile()).toString('utf8'));
			return isRecord(value) ? value : null;
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}
async function entries(dir: string) {
	try {
		return (await readdir(dir, { withFileTypes: true })).slice(0, entryLimit);
	} catch {
		return [];
	}
}

/** The YAML front matter of a command or a skill: one-line `key: value` pairs and `>`/`|` blocks; the rest is ignored. */
export function frontMatter(text: string): { fields: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { fields: {}, body: text };
	const fields: Record<string, string> = {},
		lines = match[1]!.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]!);
		if (!pair) continue;
		let value = pair[2]!.trim();
		if (/^[>|][+-]?$/.test(value)) {
			const block: string[] = [];
			while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!))
				block.push(lines[++index]!.trim());
			value = block.join(' ');
		}
		fields[pair[1]!] = value.replace(/^(['"])(.*)\1$/, '$2');
	}
	return { fields, body: text.slice(match[0].length) };
}
function info(name: string, text: string): SlashCommandInfo {
	const { fields, body } = frontMatter(text);
	const first =
		body
			.split(/\r?\n/)
			.map((line) => line.replace(/^#+\s*/, '').trim())
			.find(Boolean) ?? '';
	return {
		name,
		description: (fields.description ?? first).slice(0, 500),
		inputHint: fields['argument-hint'] || null,
	};
}
/** `<dir>/<name>/SKILL.md`; the name is the front matter's, or the folder's. */
async function skillsIn(dir: string, prefix = ''): Promise<SlashCommandInfo[]> {
	const found: SlashCommandInfo[] = [];
	for (const entry of await entries(dir)) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const text = await readText(join(dir, entry.name, 'SKILL.md'));
		if (text === null) continue;
		const skill = info(entry.name, text);
		found.push({ ...skill, name: `${prefix}${frontMatter(text).fields.name || entry.name}` });
	}
	return found;
}
/** `<dir>/**.md` to three levels; Claude names a command by its file, the folder only groups it. */
async function commandsIn(dir: string, prefix = '', depth = 0): Promise<SlashCommandInfo[]> {
	const found: SlashCommandInfo[] = [];
	for (const entry of await entries(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory() && depth < 2)
			found.push(...(await commandsIn(path, prefix, depth + 1)));
		else if (entry.name.endsWith('.md')) {
			const text = await readText(path);
			if (text !== null) found.push(info(`${prefix}${basename(entry.name, '.md')}`, text));
		}
	}
	return found;
}
function unique<T extends { name: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	return items.filter((item) => !seen.has(item.name) && Boolean(seen.add(item.name)));
}

/** Plugins Claude loads: enabled in the user's or the project's settings, installed, plus those synced from claude.ai. */
async function claudePlugins(
	homes: AgentHomes,
	project: string
): Promise<{ name: string; path: string }[]> {
	const enabled = new Map<string, boolean>();
	for (const path of [
		join(homes.claude, 'settings.json'),
		join(project, '.claude', 'settings.json'),
		join(project, '.claude', 'settings.local.json'),
	]) {
		const settings = await readJson(path, 1024 * 1024);
		const value = settings?.enabledPlugins;
		if (isRecord(value))
			for (const [id, on] of Object.entries(value))
				if (typeof on === 'boolean') enabled.set(id, on);
	}
	const installed = (
		await readJson(join(homes.claude, 'plugins', 'installed_plugins.json'), 4 * 1024 * 1024)
	)?.plugins;
	const plugins: { name: string; path: string }[] = [];
	for (const [id, on] of enabled) {
		if (!on || !isRecord(installed)) continue;
		const install = installed[id],
			first = Array.isArray(install) ? install[0] : null;
		if (isRecord(first) && typeof first.installPath === 'string')
			plugins.push({ name: id.split('@')[0]!, path: first.installPath });
	}
	for (const account of await entries(join(homes.claude, 'plugins', 'synced')))
		for (const plugin of await entries(join(homes.claude, 'plugins', 'synced', account.name)))
			if (plugin.isDirectory())
				plugins.push({
					name: plugin.name,
					path: join(homes.claude, 'plugins', 'synced', account.name, plugin.name),
				});
	for (const plugin of plugins) {
		const manifest = await readJson(join(plugin.path, '.claude-plugin', 'plugin.json'));
		if (typeof manifest?.name === 'string' && manifest.name) plugin.name = manifest.name;
	}
	return plugins;
}

async function claudeCatalog(
	homes: AgentHomes,
	project: string
): Promise<Omit<SlashCatalog, 'tools' | 'provider'>> {
	const commands = [
		...(await commandsIn(join(project, '.claude', 'commands'))),
		...(await commandsIn(join(homes.claude, 'commands'))),
	];
	const skills = [
		...(await skillsIn(join(project, '.claude', 'skills'))),
		...(await skillsIn(join(homes.claude, 'skills'))),
	];
	for (const plugin of await claudePlugins(homes, project)) {
		skills.push(...(await skillsIn(join(plugin.path, 'skills'), `${plugin.name}:`)));
		commands.push(...(await commandsIn(join(plugin.path, 'commands'), `${plugin.name}:`)));
	}
	// Skills synced from claude.ai: the agent names them `<namespace>:<name>`, which only it knows.
	const skillBasenames: string[] = [];
	for (const account of await entries(join(homes.claude, 'skills', 'synced')))
		skillBasenames.push(
			...(await skillsIn(join(homes.claude, 'skills', 'synced', account.name))).map(
				(skill) => skill.name
			)
		);
	const servers: string[] = [];
	const config = await readJson(homes.claudeJson, 16 * 1024 * 1024),
		projects = config?.projects;
	const local =
		isRecord(projects) && isRecord(projects[project]) ? projects[project].mcpServers : null;
	for (const value of [
		config?.mcpServers,
		local,
		(await readJson(join(project, '.mcp.json')))?.mcpServers,
	])
		if (isRecord(value)) servers.push(...Object.keys(value));
	return {
		commands: unique(commands),
		skills: unique(skills),
		skillBasenames,
		servers: [...new Set(servers)],
	};
}

/** `[mcp_servers.<name>]` headers of Codex's config, without `enabled = false`; subtables (`.env`) are not servers. */
export function codexServers(toml: string): string[] {
	const servers: string[] = [];
	let current: string | null = null;
	for (const line of toml.split(/\r?\n/)) {
		const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
		if (header) {
			const name = /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(header[1]!.trim());
			current = name ? (name[1] ?? name[2]!) : null;
			if (current && !servers.includes(current)) servers.push(current);
			continue;
		}
		if (current && /^\s*enabled\s*=\s*false\b/.test(line)) {
			servers.splice(servers.indexOf(current), 1);
			current = null;
		}
	}
	return servers;
}
async function codexCatalog(
	homes: AgentHomes,
	project: string
): Promise<Omit<SlashCatalog, 'tools' | 'provider'>> {
	const skills: SlashCommandInfo[] = [];
	for (const dir of [
		join(project, '.agents', 'skills'),
		join(project, '.codex', 'skills'),
		join(homes.codex, 'skills'),
		join(homes.codex, 'skills', '.system'),
		join(homes.home, '.agents', 'skills'),
	])
		skills.push(...(await skillsIn(dir)).map((skill) => ({ ...skill, name: `$${skill.name}` })));
	return {
		commands: [],
		skills: unique(skills),
		skillBasenames: [],
		servers: codexServers((await readText(join(homes.codex, 'config.toml'))) ?? ''),
	};
}

/** The crew role the host gives a task's MCP session (host `readCrewContext`); none — a single agent. */
async function crewRole(store: SessionStore, task: AgentTask): Promise<CrewProcessRole | null> {
	if (task.crew) return 'foreman';
	if (!task.crewTaskId || !task.crewNodeId) return null;
	const crew = (await store.task({ projectId: task.projectId, id: task.crewTaskId })).crew,
		node = crew && findSpecAgent(crew.root, task.crewNodeId);
	return node ? crewProcessRole(node.role, false) : null;
}

/** A task's catalog (its working tree, role and PR review) or, from the New task sheet, a project's. */
export async function readSlashCatalog(
	store: SessionStore,
	request: SlashCatalogRequest,
	modules: AppModules,
	homes = agentHomes()
): Promise<SlashCatalog> {
	const key: TaskKey | null = request.taskId
		? { projectId: request.projectId, id: request.taskId }
		: null;
	const task = key ? await store.task(key) : null;
	// spec/tasks#released-worktree: a task whose worktree was removed reads the catalog of its project's own tree.
	const project = (
		key && !(await store.releasedWorktree(key))
			? await store.projectForTask(key)
			: await store.project(request.projectId)
	).path;
	const role = task ? await crewRole(store, task) : request.crew ? 'foreman' : null;
	const disk =
		request.provider === 'codex'
			? await codexCatalog(homes, project)
			: await claudeCatalog(homes, project);
	const tools = brigadirToolList(role, modules, task?.prReview?.mode === 'review').map((tool) => ({
		server: 'brigadir',
		tool: tool.name,
		description: tool.description,
	}));
	return {
		provider: request.provider,
		...disk,
		tools,
		servers: disk.servers.filter((server) => server !== 'brigadir'),
	};
}
