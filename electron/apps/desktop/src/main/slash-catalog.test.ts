import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultModules } from '@brigadir/core';
import { SessionStore } from '@brigadir/persistence';
import {
	agentHomes,
	codexServers,
	frontMatter,
	isSlashCatalogRequest,
	readSlashCatalog,
} from './slash-catalog';

let root = '',
	home = '',
	project = '',
	data = '';
const put = async (path: string, text: string) => {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, text);
};
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'brigadir-slash-'));
	home = join(root, 'home');
	project = join(root, 'repo');
	data = join(root, 'data');
	await mkdir(project, { recursive: true });
	await put(
		join(data, 'projects/p/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'p', name: 'repo', path: project } })
	);
	await put(
		join(data, 'projects/p/tasks/t/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 't', projectId: 'p', title: 'T', status: 'done', provider: 'claude' },
		})
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('spec/composer#slash-menu: список `/` з диска', () => {
	it('читає фронтматер: однорядкові поля, блоки й лапки', () => {
		expect(
			frontMatter('---\nname: probe\ndescription: "Quoted: yes"\nargument-hint: <file>\n---\nBody')
		).toEqual({
			fields: { name: 'probe', description: 'Quoted: yes', 'argument-hint': '<file>' },
			body: 'Body',
		});
		expect(frontMatter('---\ndescription: >\n  two\n  lines\n---\n').fields.description).toBe(
			'two lines'
		);
		expect(frontMatter('# Title\ntext')).toEqual({ fields: {}, body: '# Title\ntext' });
	});
	it('Claude: команди, скіли, увімкнені плагіни, синхронізовані скіли й сервери MCP', async () => {
		const claude = join(home, '.claude');
		await put(
			join(project, '.claude/commands/deploy.md'),
			'---\ndescription: Deploy the app\nargument-hint: <env>\n---\nRun the deploy.'
		);
		await put(join(claude, 'commands/frontend/component.md'), '# Make a component\n');
		await put(
			join(project, '.claude/skills/probe-skill/SKILL.md'),
			'---\nname: probe-skill\ndescription: Probe\n---\n'
		);
		await put(join(claude, 'skills/notes/SKILL.md'), '---\ndescription: Notes\n---\n');
		await put(
			join(claude, 'skills/synced/acct/docx/SKILL.md'),
			'---\nname: docx\ndescription: Word\n---\n'
		);
		const figma = join(claude, 'plugins/cache/official/figma/1.0.0'),
			off = join(claude, 'plugins/cache/official/off/1.0.0');
		await put(
			join(figma, 'skills/figma-use/SKILL.md'),
			'---\nname: figma-use\ndescription: Use Figma\n---\n'
		);
		await put(join(figma, 'commands/sync.md'), 'Sync the file');
		await put(join(off, 'skills/hidden/SKILL.md'), '---\nname: hidden\n---\n');
		await put(
			join(claude, 'plugins/installed_plugins.json'),
			JSON.stringify({
				version: 2,
				plugins: {
					'figma@official': [{ installPath: figma }],
					'off@official': [{ installPath: off }],
				},
			})
		);
		await put(
			join(claude, 'settings.json'),
			JSON.stringify({ enabledPlugins: { 'figma@official': true, 'off@official': false } })
		);
		await put(
			join(claude, 'plugins/synced/acct/cowork/skills/make/SKILL.md'),
			'---\nname: make\n---\n'
		);
		await put(
			join(home, '.claude.json'),
			JSON.stringify({
				mcpServers: { webstorm: {} },
				projects: { [project]: { mcpServers: { local: {} } } },
			})
		);
		await put(
			join(project, '.mcp.json'),
			JSON.stringify({ mcpServers: { shared: {}, webstorm: {} } })
		);
		const catalog = await readSlashCatalog(
			await SessionStore.at(data),
			{ projectId: 'p', provider: 'claude', taskId: 't' },
			defaultModules,
			agentHomes({}, home)
		);
		expect(catalog.commands).toEqual([
			{ name: 'deploy', description: 'Deploy the app', inputHint: '<env>' },
			{ name: 'component', description: 'Make a component', inputHint: null },
			{ name: 'figma:sync', description: 'Sync the file', inputHint: null },
		]);
		expect(catalog.skills.map((skill) => skill.name)).toEqual([
			'probe-skill',
			'notes',
			'figma:figma-use',
			'cowork:make',
		]);
		expect(catalog.skillBasenames).toEqual(['docx']);
		expect(catalog.servers).toEqual(['webstorm', 'local', 'shared']);
		expect(catalog.tools.map((tool) => tool.tool)).toEqual([
			'ask_user',
			'create_task',
			'tasks_list',
			'task_send',
			'propose_review',
			'review_reply',
			'add_folder',
			'browser_open',
			'browser_state',
			'browser_read',
			'browser_console',
			'browser_network',
			'browser_screenshot',
			'browser_ui',
			'browser_act',
			'browser_show',
			'commands_list',
			'commands_run',
			'commands_output',
			'commands_stop',
			'console_list',
			'console_read',
			'editor_state',
			'editor_restart_language_servers',
			'pr_state',
		]);
		expect(catalog.tools[0]).toMatchObject({
			server: 'brigadir',
			description: expect.stringContaining('Ask the human'),
		});
	});
	it('CLAUDE_CONFIG_DIR замінює і ~/.claude, і ~/.claude.json', () => {
		expect(agentHomes({ CLAUDE_CONFIG_DIR: '/cfg', CODEX_HOME: '/cx' }, '/h')).toEqual({
			home: '/h',
			claude: '/cfg',
			claudeJson: '/cfg/.claude.json',
			codex: '/cx',
		});
		expect(agentHomes({}, '/h')).toEqual({
			home: '/h',
			claude: '/h/.claude',
			claudeJson: '/h/.claude.json',
			codex: '/h/.codex',
		});
	});
	it('модулі й роль бригади міняють інструменти brigadir', async () => {
		const store = await SessionStore.at(data),
			homes = agentHomes({}, home);
		const off = await readSlashCatalog(
			store,
			{ projectId: 'p', provider: 'claude' },
			{ ...defaultModules, browser: false, simulator: false, commands: false },
			homes
		);
		expect(off.tools.map((tool) => tool.tool)).toEqual([
			'ask_user',
			'create_task',
			'tasks_list',
			'task_send',
			'propose_review',
			'review_reply',
			'add_folder',
			'console_list',
			'console_read',
			'editor_state',
			'editor_restart_language_servers',
			'pr_state',
		]);
		const noPr = await readSlashCatalog(
			store,
			{ projectId: 'p', provider: 'claude' },
			{ ...defaultModules, browser: false, simulator: false, pullRequests: false, commands: false },
			homes
		);
		expect(noPr.tools.map((tool) => tool.tool)).toEqual([
			'ask_user',
			'create_task',
			'tasks_list',
			'task_send',
			'propose_review',
			'review_reply',
			'add_folder',
			'console_list',
			'console_read',
			'editor_state',
			'editor_restart_language_servers',
		]);
		const foreman = await readSlashCatalog(
			store,
			{ projectId: 'p', provider: 'claude', crew: true },
			{ ...defaultModules, browser: false, simulator: false },
			homes
		);
		expect(foreman.tools.map((tool) => tool.tool)).toContain('propose_plan');
	});
	it('Codex: скіли як $назва (з .system і .agents) і сервери з config.toml', async () => {
		const codex = join(home, '.codex');
		await put(
			join(codex, 'skills/random-landos/SKILL.md'),
			'---\nname: random-landos\ndescription: Landing prompts\n---\n'
		);
		await put(
			join(codex, 'skills/.system/skill-creator/SKILL.md'),
			'---\nname: skill-creator\n---\nCreate skills'
		);
		await put(
			join(project, '.agents/skills/probe-skill/SKILL.md'),
			'---\nname: probe-skill\n---\n'
		);
		await put(
			join(codex, 'config.toml'),
			'model = "gpt"\n[mcp_servers.node_repl]\ncommand = "x"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."computer-use"]\nargs = []\n[mcp_servers.off]\nenabled = false\n[desktop]\n'
		);
		const catalog = await readSlashCatalog(
			await SessionStore.at(data),
			{ projectId: 'p', provider: 'codex' },
			defaultModules,
			agentHomes({}, home)
		);
		expect(catalog.skills.map((skill) => [skill.name, skill.description])).toEqual([
			['$probe-skill', ''],
			['$random-landos', 'Landing prompts'],
			['$skill-creator', 'Create skills'],
		]);
		expect(catalog.commands).toEqual([]);
		expect(catalog.servers).toEqual(['node_repl', 'computer-use']);
	});
	it('codexServers не бере підтаблиці й вимкнені сервери', () => {
		expect(
			codexServers(
				'[mcp_servers.a]\n[mcp_servers.a.env]\n[mcp_servers.b]\nenabled = false\n[mcp_servers.c]\n'
			)
		).toEqual(['a', 'c']);
	});
	it('перевіряє запит IPC', () => {
		expect(isSlashCatalogRequest({ projectId: 'p', provider: 'claude' })).toBe(true);
		expect(
			isSlashCatalogRequest({ projectId: 'p', provider: 'codex', taskId: 't', crew: false })
		).toBe(true);
		expect(isSlashCatalogRequest({ projectId: 'p', provider: 'gpt' })).toBe(false);
		expect(isSlashCatalogRequest({ projectId: '../x', provider: 'claude' })).toBe(false);
		expect(isSlashCatalogRequest({ projectId: 'p', provider: 'claude', path: '/etc' })).toBe(false);
	});
});
