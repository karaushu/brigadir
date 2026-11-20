import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	approvedSpec,
	builtinAgentTemplates,
	composeCrew,
	crewPalette,
	resolveCrew,
	templateLookup,
	type AgentTemplate,
	type CrewSpec,
	type CrewTemplate,
	type ProviderCatalog,
} from '@brigadir/core';
import { foremanBrief, verification, workerContext } from './brief';
import { crewToolsBrief } from './tools-brief';
const tester: AgentTemplate = {
	id: 'tester',
	name: 'Tester',
	role: 'developer',
	whenToUse: 'Writes Playwright e2e tests; give it every test part.',
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
				whenToUse: 'Owns the admin screens',
				zone: ['apps/ui/**'],
				agents: [
					{
						id: 'dev',
						name: 'Верстальник',
						template: 'developer',
						whenToUse: 'Lays out React screens',
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

it('tells the foreman the When to use, model and effort of each agent (spec/crew-templates-and-editor#roster)', () => {
	const brief = foremanBrief(spec, 'root');
	expect(brief).toContain(
		'`UI-лід` (when to use: Owns the admin screens; Claude · Claude Sonnet 5 · High; leads `Верстальник`; zone `apps/ui/**`)'
	);
	expect(brief).toContain(
		'`API` (when to use: Parts with a clear spec; Codex · GPT-6 Astra · xhigh; zone `services/api/**`; checked by `Ревʼюер`)'
	);
	expect(brief).toContain(
		'`Тести` (when to use: Writes Playwright e2e tests; give it every test part; Claude · Claude Sonnet 5 · High; checked by `Ревʼюер`)'
	);
	expect(brief).toContain(
		'`Розробник` (when to use: Parts with a clear spec; Claude · Claude Sonnet 5 · High)'
	);
	expect(brief).toContain('Give each part to the agent whose when-to-use line and zone fit it.');
	expect(brief).not.toContain('Lays out React screens');
});
it('names the provider default when no model is chosen, leaves out an unknown effort, and shows the lead only its branch', () => {
	const bare = resolveCrew(crew, {
		lookup,
		defaultProvider: 'codex',
		now: '2026-09-25T10:00:00.000Z',
	});
	expect(foremanBrief(bare, 'root')).toContain(
		'`Розробник` (when to use: Parts with a clear spec; Codex · provider default model)'
	);
	const lead = foremanBrief(spec, 'lead');
	expect(lead).toContain(
		'Your agents: `Верстальник` (when to use: Lays out React screens; Claude · Claude Sonnet 5 · High; zone `apps/ui/**`)'
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
		expect(brief).toContain('runs them as project commands');
		expect(brief).toContain(
			'A check in the browser or simulator is the one smoke described above, not a step of every part.'
		);
		expect(brief).not.toContain('checks it on the simulator after implementing');
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
	// The person's own `Tester` stands in for the built-in one: a name means one template.
	expect(brief).toContain(
		'Templates: `Developer` (writes code; when to use: Parts with a clear spec; default Claude · provider default model), `Senior developer` (writes code; when to use: Migrations, refactors, unclear specs; default Claude · Opus · High), `Technical writer` (writes code; when to use: Writes docs, changes no behaviour; default Claude · Sonnet), `Reviewer` (checks, writes no code; when to use: Checks the work, writes no code; default Claude · provider default model), `Designer` (checks, writes no code; when to use: Checks screens against the design; default Claude · provider default model), `Security reviewer` (checks, writes no code; when to use: Looks for security defects in changes; default Claude · Opus · High), `Tester` (writes code; when to use: Writes Playwright e2e tests; give it every test part; default Claude · provider default model). Pick a template by its when-to-use line, not by its name.'
	);
	expect(brief).toContain('Models: Claude: `OPUS` (effort LOW, MAX), `HAIKU` (effort LOW).');
	// spec/crew#compose: the fewest agents; one developer without a reviewer is a whole crew for one chain of steps.
	expect(brief).toContain("crew: the fewest agents the task's independent parts need");
	expect(brief).toContain('one developer and no reviewer is the whole crew');
	expect(brief).toContain('Add a reviewer only where a part needs a second reader');
	// spec/crew#smoke: the check roles in the palette's terms.
	expect(brief).toContain('Add a designer only when the task names a design source to match.');
	expect(brief).toContain(
		'At most one agent runs the smoke in the running app, and nobody checks it.'
	);
	expect(brief).not.toMatch(/Always add at least one reviewer|checkedBy of every developer/);
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
	expect(after).toContain(
		'Your agents: `API` (when to use: Parts with a clear spec; Claude · OPUS · MAX; checked by `Check`)'
	);
	expect(after).not.toContain('You compose your crew');
});

it('ladders effort from medium to high and then to a stronger model in a fresh session, with no rule that the checker outranks the author (spec/crew#model-ladder)', () => {
	const brief = foremanBrief(spec, 'root');
	expect(brief).toContain('Effort medium is the default; for a harder part raise it, up to high.');
	expect(brief).toContain('The step past high is a stronger model in a fresh session');
	expect(brief).not.toContain('at least as strong as whoever wrote it');
});
it("runs the plan in the foreman's own task, passes acceptance for reviewers and stops returns at the review limit; the foreman still writes no code (spec/crew#foreman-brief)", () => {
	const brief = foremanBrief(spec, 'root');
	expect(brief).toContain('never create a separate task for it');
	expect(brief).toContain('pass acceptance: what must hold for the part to count as done');
	expect(brief).toContain(
		'when you are told a part reached its review limit, accept it or put the decision to the human'
	);
	expect(brief).toContain('your returns do not start the count again');
	expect(brief).not.toContain('returns spends');
	expect(brief).toContain('You do not write code yourself.');
	expect(brief).not.toContain('EnterPlanMode');
});
it('tells every foreman how the crew checks its work in the running app: one time-boxed smoke, no matrix, no review of it (spec/crew#smoke)', () => {
	for (const id of ['root', 'lead']) {
		const brief = foremanBrief(spec, id);
		expect(brief).toContain(verification);
		for (const phrase of [
			'a worker proves its part with the command its prompt names',
			'do not ask every worker to drive the simulator or the browser',
			'give it as one part to one agent, once, on the integrated work',
			'10 minutes unless the task needs another',
			'no list of checks with a screenshot each, no repeats to be sure',
			'no run per device or configuration unless the task is about that device',
			'Nobody reviews the smoke report',
			"Design fidelity is the designer's check",
			'names its design source in its prompt',
		])
			expect(brief).toContain(phrase);
	}
	expect(workerContext(spec, 'dev')).not.toContain(verification);
});
it('builds the brief of an old snapshot from the role texts it was resolved with (spec/crew-templates-and-editor#snapshot)', () => {
	const old = JSON.parse(
		readFileSync(
			new URL('../../core/src/fixtures/crew-snapshot-default.json', import.meta.url),
			'utf8'
		)
	) as CrewSpec;
	const designer = workerContext(old, 'designer');
	expect(designer).toContain('neighbouring screens and the design tokens of the project');
	expect(designer).not.toContain('expected from the design, found in the app');
	expect(designer).toContain('You check `Screens`');
	expect(foremanBrief(old, 'root')).toContain(verification);
});
