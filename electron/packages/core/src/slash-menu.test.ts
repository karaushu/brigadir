import { describe, expect, it } from 'vitest';
import type { EventRecord } from './session';
import {
	agentSlashCommands,
	loggedMcpTools,
	matchSlash,
	slashEntries,
	slashIndex,
	slashTrigger,
	slashWords,
	type SlashCatalog,
} from './slash-menu';

const at = '2026-10-06T00:00:00.000Z';
const catalog = (overrides: Partial<SlashCatalog> = {}): SlashCatalog => ({
	provider: 'claude',
	commands: [],
	skills: [],
	skillBasenames: [],
	tools: [],
	servers: [],
	...overrides,
});
const names = (entries: { label: string }[]) => entries.map((entry) => entry.label);

describe('spec/composer#slash-menu: / будь-де в тексті', () => {
	it('відкривається першим символом, після пробілу й з нового рядка', () => {
		expect(slashTrigger('/', 1)).toEqual({ from: 0, to: 1, query: '', start: true });
		expect(slashTrigger('fix it with /rev', 16)).toEqual({
			from: 12,
			to: 16,
			query: 'rev',
			start: false,
		});
		expect(slashTrigger('first line\n/figma:fig', 21)).toEqual({
			from: 11,
			to: 21,
			query: 'figma:fig',
			start: false,
		});
		expect(slashTrigger('use /review now', 7)).toEqual({
			from: 4,
			to: 11,
			query: 're',
			start: false,
		});
	});
	it('лишає текстом шлях, `/` посеред слова й запит із пробілом', () => {
		expect(slashTrigger('a/b', 3)).toBeNull();
		expect(slashTrigger('/usr/bin', 8)).toBeNull();
		expect(slashTrigger('see /usr/bin', 8)).toBeNull();
		expect(slashTrigger('/compact now', 12)).toBeNull();
	});
});

describe('spec/composer#slash-menu: джерела списку', () => {
	const disk = catalog({
		commands: [{ name: 'deploy', description: 'Deploy the app', inputHint: null }],
		skills: [
			{ name: 'probe-skill', description: 'Probe', inputHint: null },
			{ name: 'figma:figma-use', description: 'Use the Figma plugin API', inputHint: null },
		],
		skillBasenames: ['docx'],
		tools: [
			{ server: 'brigadir', tool: 'browser_open', description: 'open the browser' },
			{ server: 'brigadir', tool: 'ask_user', description: 'Ask the human' },
		],
		servers: ['webstorm', 'brigadir'],
	});
	it('до старту агента бере диск і позначає список попереднім', () => {
		const { entries, preliminary } = slashEntries({ catalog: disk, agent: null });
		expect(preliminary).toBe(true);
		expect(entries.map((entry) => [entry.kind, entry.label, entry.anywhere])).toEqual([
			['command', '/deploy', true],
			['skill', '/probe-skill', true],
			['skill', '/figma:figma-use', true],
			['tool', 'mcp__brigadir__browser_open', true],
			['tool', 'mcp__brigadir__ask_user', true],
			['tool', 'mcp__webstorm', true],
		]);
		expect(entries.find((entry) => entry.label === 'mcp__webstorm')?.server).toBe(true);
	});
	it('після commands.changed бере список агента; вбудовані команди — лише першим символом', () => {
		const agent = [
			{ name: 'compact', description: 'Free up context', inputHint: '<instructions>' },
			{ name: 'probe-skill', description: 'Probe', inputHint: null },
			{ name: 'deploy', description: 'Deploy the app', inputHint: null },
			{ name: 'anthropic-skills:docx', description: 'Word', inputHint: null },
			{ name: 'mcp:server:prompt', description: '', inputHint: null },
		];
		const { entries, preliminary } = slashEntries({ catalog: disk, agent });
		expect(preliminary).toBe(false);
		expect(
			entries
				.filter((entry) => entry.kind !== 'tool')
				.map((entry) => [entry.kind, entry.label, entry.anywhere])
		).toEqual([
			['command', '/compact', false],
			['skill', '/probe-skill', true],
			['command', '/deploy', true],
			['skill', '/anthropic-skills:docx', true],
			['command', '/mcp:server:prompt', false],
		]);
		expect(names(matchSlash(entries, '', false))).not.toContain('/compact');
		expect(names(matchSlash(entries, '', true))).toContain('/compact');
	});
	it('скіл Codex вставляється як $назва', () => {
		const { entries } = slashEntries({
			catalog: catalog({ provider: 'codex' }),
			agent: [
				{ name: 'review', description: 'Review', inputHint: null },
				{ name: '$random-landos', description: 'Landing prompts', inputHint: null },
			],
		});
		expect(entries.map((entry) => [entry.kind, entry.insert, entry.anywhere])).toEqual([
			['command', '/review', false],
			['skill', '$random-landos', true],
		]);
		expect(names(matchSlash(entries, 'rand', false))).toEqual(['$random-landos']);
	});
	it('додає інструменти, які агент уже викликав, і дії', () => {
		const { entries } = slashEntries({
			catalog: disk,
			agent: null,
			logged: [
				{ server: 'webstorm', tool: 'get_file' },
				{ server: 'brigadir', tool: 'ask_user' },
			],
			actions: [{ action: 'attach', label: 'Attach files', description: '' }],
		});
		expect(names(entries.filter((entry) => entry.kind === 'tool'))).toEqual([
			'mcp__brigadir__browser_open',
			'mcp__brigadir__ask_user',
			'mcp__webstorm__get_file',
		]);
		expect(entries.at(-1)).toMatchObject({
			kind: 'action',
			action: 'attach',
			insert: '',
			anywhere: true,
		});
	});
	it('бере останній список команд агента й інструменти з лога', () => {
		const records: EventRecord[] = [
			{
				schemaVersion: 1,
				seq: 1,
				at,
				event: {
					kind: 'commands.changed',
					commands: [{ name: 'old', description: '', inputHint: null }],
				},
			},
			{
				schemaVersion: 1,
				seq: 2,
				at,
				event: {
					kind: 'commands.changed',
					commands: [{ name: 'compact', description: '', inputHint: null }],
				},
			},
			{
				schemaVersion: 1,
				seq: 3,
				at,
				event: {
					kind: 'tool.changed',
					patch: {
						id: 't1',
						name: 'mcp__webstorm__get_file',
						title: 'get_file',
						status: 'pending',
					},
				},
			},
			{
				schemaVersion: 1,
				seq: 4,
				at,
				event: {
					kind: 'tool.changed',
					patch: {
						id: 't2',
						title: 'mcp.figma.get_screenshot',
						input: '{"server":"figma","tool":"get_screenshot","arguments":{}}',
					},
				},
			},
			{
				schemaVersion: 1,
				seq: 5,
				at,
				event: { kind: 'tool.changed', patch: { id: 't3', name: 'Bash', title: 'ls' } },
			},
		];
		expect(agentSlashCommands(records)?.map((command) => command.name)).toEqual(['compact']);
		expect(agentSlashCommands([])).toBeNull();
		expect(loggedMcpTools(records)).toEqual([
			{ server: 'webstorm', tool: 'get_file' },
			{ server: 'figma', tool: 'get_screenshot' },
		]);
	});
});

describe('spec/composer#slash-menu: ранжування', () => {
	const { entries } = slashEntries({
		catalog: catalog({
			skills: [
				{ name: 'figma:figma-use', description: '', inputHint: null },
				{ name: 'review-pr', description: '', inputHint: null },
			],
			tools: [{ server: 'brigadir', tool: 'browser_open', description: 'Open a page' }],
		}),
		agent: null,
		actions: [{ action: 'attach', label: 'Attach files', description: '' }],
	});
	it('групи в сталому порядку (дії вище за MCP-інструменти), збіг на початку останньої частини назви — першим', () => {
		expect(names(matchSlash(entries, 'use', false))).toEqual(['/figma:figma-use']);
		expect(names(matchSlash(entries, 'open', false))).toEqual(['mcp__brigadir__browser_open']);
		expect(names(matchSlash(entries, 'page', false))).toEqual(['mcp__brigadir__browser_open']);
		expect(names(matchSlash(entries, 'att', false))).toEqual(['Attach files']);
		expect(names(matchSlash(entries, '', false))).toEqual([
			'/figma:figma-use',
			'/review-pr',
			'Attach files',
			'mcp__brigadir__browser_open',
		]);
		expect(names(matchSlash(entries, 'zzz', true))).toEqual([]);
	});
	it('усередині групи збіг на початку вище за збіг у назві й в описі', () => {
		const ranked = slashEntries({
			catalog: catalog({
				skills: [
					{ name: 'deep-review', description: '', inputHint: null },
					{ name: 'usage', description: 'Show the review of limits', inputHint: null },
					{ name: 'review', description: '', inputHint: null },
				],
			}),
			agent: null,
		}).entries;
		expect(names(matchSlash(ranked, 'rev', false))).toEqual(['/review', '/deep-review', '/usage']);
	});
});

describe('spec/composer#slash-highlight: відомі назви в тексті', () => {
	const { entries } = slashEntries({
		catalog: catalog({
			skills: [{ name: 'deep-review', description: 'Rigorous review', inputHint: null }],
			tools: [{ server: 'brigadir', tool: 'browser_open', description: 'open' }],
		}),
		agent: [
			{ name: 'deep-review', description: 'Rigorous review', inputHint: null },
			{ name: 'compact', description: 'Compact the context', inputHint: null },
		],
		actions: [{ action: 'attach', label: 'Attach files', description: '' }],
	});
	const index = slashIndex(entries);
	const words = (text: string, start = true) =>
		slashWords(text, index, start).map((found) => text.slice(found.from, found.to));
	it('скіл — першим словом і посеред тексту, без розділових знаків речення', () => {
		expect(words('/deep-review then fix it')).toEqual(['/deep-review']);
		expect(words('Also run /deep-review, then (/deep-review).')).toEqual([
			'/deep-review',
			'/deep-review',
		]);
		expect(slashWords('run /deep-review now', index, false)).toEqual([
			{ from: 4, to: 16, entry: expect.objectContaining({ kind: 'skill' }) },
		]);
	});
	it('вбудована команда — лише першим словом повідомлення', () => {
		expect(words('/compact now')).toEqual(['/compact']);
		expect(words('then /compact')).toEqual([]);
		expect(words('/compact now', false)).toEqual([]);
	});
	it('шлях, схожа назва й дія лишаються текстом; інструмент MCP — будь-де', () => {
		expect(words('check /usr/local/bin and /deep-reviewer and a/deep-review')).toEqual([]);
		expect(words('Attach files')).toEqual([]);
		expect(words('then call mcp__brigadir__browser_open.')).toEqual([
			'mcp__brigadir__browser_open',
		]);
	});
	it('порожній список нічого не знаходить', () => {
		expect(slashWords('/deep-review', slashIndex([]), true)).toEqual([]);
	});
});
