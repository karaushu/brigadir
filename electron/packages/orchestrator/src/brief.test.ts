import { it, expect } from 'vitest';
import {
	approvedSpec,
	builtinAgentTemplates,
	composeCrew,
	crewPalette,
	resolveCrew,
	templateLookup,
	type AgentTemplate,
	type CrewTemplate,
	type ProviderCatalog,
} from '@brigadir/core';
import { foremanBrief, workerContext } from './brief';
import { crewToolsBrief } from './tools-brief';
const tester: AgentTemplate = {
	id: 'tester',
	name: 'Tester',
	role: 'developer',
	summary: 'Writes Playwright e2e tests; give it every test part.',
	instructions: 'You write tests.',
	builtin: false,
};
const lookup = templateLookup([tester]);
const crew: CrewTemplate = {
	schemaVersion: 1,
	id: 'c',
	name: 'C',
	builtin: false,
	root: {
		id: 'root',
		name: 'Бригадир',
		template: 'foreman-default',
		agents: [
			{
				id: 'lead',
				name: 'UI-лід',
				template: 'foreman-default',
				summary: 'Owns the admin screens',
				zone: ['apps/ui/**'],
				agents: [
					{
						id: 'dev',
						name: 'Верстальник',
						template: 'developer',
						summary: 'Lays out React screens',
					},
				],
			},
			{
				id: 'api',
				name: 'API',
				template: 'developer',
				provider: 'codex',
				choices: { configOptions: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } },
				choiceNames: { model: 'GPT-6 Astra' },
				checkedBy: ['review'],
				zone: ['services/api/**'],
			},
			{ id: 'tests', name: 'Тести', template: 'tester', checkedBy: ['review'] },
			{ id: 'plain', name: 'Розробник', template: 'developer' },
			{ id: 'review', name: 'Ревʼюер', template: 'reviewer' },
		],
	},
};
const defaults = (provider: 'claude' | 'codex') =>
	provider === 'claude'
		? {
				choices: { configOptions: { model: 'claude-sonnet-5', effort: 'high' } },
				choiceNames: { model: 'Claude Sonnet 5', effort: 'High' },
			}
		: null;
const spec = resolveCrew(crew, {
	lookup,
	defaultProvider: 'claude',
	defaults,
	now: '2026-09-25T10:00:00.000Z',
});

it('tells the foreman the specialty, model and effort of each agent (spec/crew-templates-and-editor#roster)', () => {
	const brief = foremanBrief(spec, 'root');
	expect(brief).toContain(
		'`UI-лід` (Owns the admin screens; Claude · Claude Sonnet 5 · High; leads `Верстальник`; zone `apps/ui/**`)'
	);
	expect(brief).toContain(
		'`API` (Codex · GPT-6 Astra · xhigh; zone `services/api/**`; checked by `Ревʼюер`)'
	);
	expect(brief).toContain(
		'`Тести` (Writes Playwright e2e tests; give it every test part; Claude · Claude Sonnet 5 · High; checked by `Ревʼюер`)'
	);
	expect(brief).toContain('`Розробник` (Claude · Claude Sonnet 5 · High)');
	expect(brief).not.toContain('Lays out React screens');
});
it('names the provider default when no model is chosen, leaves out an unknown effort, and shows the lead only its branch', () => {
	const bare = resolveCrew(crew, {
		lookup,
		defaultProvider: 'codex',
		now: '2026-09-25T10:00:00.000Z',
	});
	expect(foremanBrief(bare, 'root')).toContain('`Розробник` (Codex · provider default model)');
	const lead = foremanBrief(spec, 'lead');
	expect(lead).toContain(
		'Your agents: `Верстальник` (Lays out React screens; Claude · Claude Sonnet 5 · High; zone `apps/ui/**`)'
	);
	expect(lead).not.toContain('GPT-6 Astra');
});
it('keeps models of other agents away from workers (spec/crew#worker-context)', () => {
	for (const id of ['api', 'tests', 'dev', 'review'])
		expect(workerContext(spec, id)).not.toMatch(/GPT-6|Sonnet|provider default|High|xhigh/);
});
it("names the crew's tools to the foreman and a lead so the plan carries the check, never to a worker (spec/agents-and-providers#tools-awareness)", () => {
	const all = { browser: true, simulator: true, commands: true },
		none = { browser: false, simulator: false, commands: false };
	for (const id of ['root', 'lead']) {
		const brief = foremanBrief(spec, id, all);
		expect(brief).toContain(crewToolsBrief(all));
		expect(brief).toContain('opens the page in the browser and checks it');
		expect(brief).toContain('checks it on the simulator after implementing');
	}
	expect(foremanBrief(spec, 'root')).not.toContain('browser_');
	expect(workerContext(spec, 'dev', all)).not.toContain('browser_');
	const browserOnly = crewToolsBrief({ ...none, browser: true });
	expect(browserOnly).toContain('browser_*');
	expect(browserOnly).not.toMatch(/simulator|commands/);
	expect(crewToolsBrief(none)).toBe('');
	expect(foremanBrief(spec, 'root', none)).toBe(foremanBrief(spec, 'root'));
});
it('tells every foreman to wait for its research subagent instead of repeating the search (spec/crew#foreman-brief)', () => {
	for (const id of ['root', 'lead']) {
		const brief = workerContext(spec, id);
		expect(brief).toContain('do not research the same question yourself while it runs');
		expect(brief).toContain('Run it in the foreground instead when your next step depends on it');
	}
	expect(workerContext(spec, 'dev')).not.toContain('do not research the same question yourself');
});

it('gives a composing foreman the palette instead of a roster, and the roster once the crew is approved (spec/crew#compose)', () => {
	const option = (id: string, category: string, values: string[]) => ({
		id,
		name: id,
		description: null,
		category,
		kind: 'select' as const,
		value: values[0]!,
		choices: values.map((value) => ({
			value,
			name: value.toUpperCase(),
			description: null,
			group: null,
		})),
	});
	const catalog: ProviderCatalog = {
		provider: 'claude',
		modes: [],
		options: [option('model', 'model', ['opus', 'haiku'])],
		byModel: {
			opus: [option('effort', 'thought_level', ['low', 'max'])],
			haiku: [option('effort', 'thought_level', ['low'])],
		},
	};
	const foreman = resolveCrew(
		{
			schemaVersion: 1,
			id: 'compose',
			name: 'Crew',
			builtin: true,
			root: { id: 'root', name: 'Foreman', template: 'foreman-default' },
		},
		{ lookup, defaultProvider: 'claude', now: '2026-10-09T10:00:00.000Z' }
	);
	const composing = {
		...foreman,
		compose: crewPalette(
			[...builtinAgentTemplates, tester],
			{ lookup, defaultProvider: 'claude' },
			[catalog]
		),
	};
	const brief = foremanBrief(composing, 'root');
	expect(brief).toContain('You compose your crew yourself');
	expect(brief).toContain(
		'Templates: `Developer` (developer; default Claude · provider default model), `Reviewer` (reviewer; default Claude · provider default model), `Tester` (developer; Writes Playwright e2e tests; give it every test part; default Claude · provider default model).'
	);
	expect(brief).toContain('Models: Claude: `OPUS` (effort LOW, MAX), `HAIKU` (effort LOW).');
	expect(brief).toContain(
		'Always add at least one reviewer, and put a reviewer in checkedBy of every developer'
	);
	expect(brief).not.toContain('Your agents:');
	let id = 0;
	const approved = approvedSpec(
		composing,
		composeCrew(
			composing,
			[
				{ name: 'API', template: 'Developer', model: 'opus', effort: 'max', checkedBy: ['Check'] },
				{ name: 'Check', template: 'Reviewer' },
			],
			() => `agent-${++id}`
		)
	);
	const after = foremanBrief(approved, 'root');
	expect(after).toContain('Your agents: `API` (Claude · OPUS · MAX; checked by `Check`)');
	expect(after).not.toContain('You compose your crew');
});
