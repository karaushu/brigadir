import { describe, expect, it } from 'vitest';
import {
	approvedSpec,
	builtinAgentTemplates,
	composeCrew,
	composedSpec,
	crewPalette,
	foremanTemplateId,
	isComposing,
	isCrewLaunch,
	isCrewPlan,
	isCrewPlanDecision,
	isCrewSpec,
	planDifferences,
	resolveCrew,
	specAsTemplate,
	templateLookup,
	type AgentTemplate,
	type CrewSpec,
	type ProviderCatalog,
} from './index';

const select = (id: string, category: string, values: string[]) => ({
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
const claude: ProviderCatalog = {
	provider: 'claude',
	modes: [],
	options: [
		select('model', 'model', ['opus', 'haiku']),
		select('effort', 'thought_level', ['low', 'high']),
	],
	byModel: {
		opus: [
			select('model', 'model', ['opus', 'haiku']),
			select('effort', 'thought_level', ['low', 'high', 'max']),
		],
		haiku: [select('model', 'model', ['opus', 'haiku'])],
	},
};
const designer: AgentTemplate = {
	id: 'designer',
	name: 'Designer',
	role: 'reviewer',
	summary: 'Checks screens and tokens',
	instructions: 'Check the UI.',
	builtin: false,
};
const lookup = templateLookup([designer]);
function composing(): CrewSpec {
	const spec = resolveCrew(
		{
			schemaVersion: 1,
			id: 'compose',
			name: 'Crew',
			builtin: true,
			root: { id: 'root', name: 'Foreman', template: foremanTemplateId },
		},
		{ lookup, defaultProvider: 'claude', now: '2026-10-09T00:00:00.000Z' }
	);
	return {
		...spec,
		compose: crewPalette(
			[...builtinAgentTemplates, designer],
			{ lookup, defaultProvider: 'claude' },
			[claude, { provider: 'codex', options: [], modes: [] }]
		),
	};
}
/** A library with every reviewer template removed: the crew may go without a reviewer (spec/crew#compose). */
function withoutReviewers(spec: CrewSpec): CrewSpec {
	const compose = spec.compose!;
	return {
		...spec,
		compose: {
			...compose,
			templates: compose.templates.filter((template) => template.role !== 'reviewer'),
		},
	};
}
let ids = 0;
const newId = () => `agent-${++ids}`;

describe('crew palette (spec/crew#compose)', () => {
	it('resolves every non-foreman template and the models with their efforts', () => {
		const spec = composing();
		expect(isCrewSpec(spec)).toBe(true);
		expect(isComposing(spec)).toBe(true);
		expect(spec.compose!.templates.map((item) => [item.name, item.role, item.template])).toEqual([
			['Developer', 'developer', 'developer'],
			['Reviewer', 'reviewer', 'reviewer'],
			['Designer', 'reviewer', 'designer'],
		]);
		const entry = spec.compose!.providers[0]!;
		expect(entry.model?.choices.map((choice) => choice.name)).toEqual(['OPUS', 'HAIKU']);
		expect(entry.efforts?.opus?.choices.map((choice) => choice.value)).toEqual([
			'low',
			'high',
			'max',
		]);
		expect(entry.efforts?.haiku).toBeUndefined();
		expect(entry.effort?.choices.map((choice) => choice.value)).toEqual(['low', 'high']);
		expect(spec.compose!.providers[1]).toEqual({ provider: 'codex' });
	});
});

describe('composeCrew (spec/crew#compose)', () => {
	it('builds nodes from template, model, effort, zone and checks by name', () => {
		const spec = composing();
		const crew = composeCrew(
			spec,
			[
				{
					name: 'API',
					template: 'developer',
					model: 'Opus',
					effort: 'max',
					summary: 'Server routes',
					zone: ['./services/api/**'],
					checkedBy: ['Design check'],
				},
				{ name: 'Design check', template: 'Designer', checkedBy: [] },
				{ name: 'UI', template: 'Developer', checkedBy: ['Design check'] },
			],
			newId
		);
		expect(crew.map((item) => item.name)).toEqual(['API', 'Design check', 'UI']);
		expect(crew[0]).toMatchObject({
			template: 'developer',
			role: 'developer',
			provider: 'claude',
			requestedChoices: { configOptions: { model: 'opus', effort: 'max' } },
			choiceNames: { model: 'OPUS', effort: 'MAX' },
			summary: 'Server routes',
			zone: ['services/api/**'],
		});
		expect(crew[0]!.checkedBy).toEqual([crew[1]!.id]);
		expect(crew[0]!.instructions).toContain('You implement your part');
		expect(crew[1]).toMatchObject({
			template: 'designer',
			role: 'reviewer',
			summary: 'Checks screens and tokens',
			instructions: 'Check the UI.',
		});
		expect(crew[2]!.checkedBy).toEqual([crew[1]!.id]);
		const proposed = composedSpec(spec, crew);
		expect(isCrewSpec(proposed)).toBe(true);
		expect(
			planDifferences(proposed, 'root', [
				{
					id: 'p1',
					title: 'Routes',
					agent: 'API',
					prompt: 'x',
					files: ['services/api/a.ts'],
					scopes: [],
				},
				{ id: 'p2', title: 'Screens', agent: 'UI', prompt: 'y', files: [], scopes: [] },
			])
		).toEqual([]);
		const approved = approvedSpec(spec, crew);
		expect(approved.compose).toBeUndefined();
		expect(isComposing(approved)).toBe(false);
		expect(isCrewSpec(approved)).toBe(true);
	});
	it('drops an effort the new model does not have, and the template choices on another provider', () => {
		const spec = withoutReviewers(composing());
		spec.compose!.templates[0] = {
			...spec.compose!.templates[0]!,
			requestedChoices: { configOptions: { model: 'opus', effort: 'max' } },
			choiceNames: { model: 'OPUS', effort: 'MAX' },
		};
		expect(
			composeCrew(spec, [{ name: 'Fast', template: 'Developer', model: 'haiku' }], newId)[0]
		).toMatchObject({
			requestedChoices: { configOptions: { model: 'haiku' } },
			choiceNames: { model: 'HAIKU' },
		});
		expect(
			composeCrew(spec, [{ name: 'Other', template: 'Developer', provider: 'Codex' }], newId)[0]
		).toMatchObject({ provider: 'codex', requestedChoices: {}, choiceNames: {} });
	});
	it('fails with what is available, so the agent can retry', () => {
		const spec = withoutReviewers(composing()),
			fail = (crew: unknown, on = spec) => {
				try {
					composeCrew(on, crew, newId);
				} catch (error) {
					return (error as Error).message;
				}
				return 'no error';
			};
		expect(fail(undefined)).toMatch(/pass crew/);
		expect(fail([{ name: 'A', template: 'Tester' }])).toBe(
			'Unknown template Tester for A. Templates: Developer.'
		);
		expect(fail([{ name: 'A', template: 'Developer', model: 'sonnet' }])).toBe(
			'Unknown Claude model sonnet for A. Models: OPUS, HAIKU.'
		);
		expect(fail([{ name: 'A', template: 'Developer', model: 'haiku', effort: 'low' }])).toMatch(
			/A has no effort levels/
		);
		expect(fail([{ name: 'A', template: 'Developer', provider: 'gemini' }])).toMatch(
			/Unknown provider gemini for A\. Providers: Claude, Codex\./
		);
		expect(
			fail([
				{ name: 'A', template: 'Developer' },
				{ name: 'A', template: 'Developer' },
			])
		).toBe('Two agents are named A.');
		expect(fail([{ name: 'Foreman', template: 'Developer' }])).toBe(
			'Two agents are named Foreman.'
		);
		expect(
			fail([
				{ name: 'A', template: 'Developer', checkedBy: ['B'] },
				{ name: 'B', template: 'Developer' },
			])
		).toBe('B is not a reviewer and cannot check A.');
		expect(fail([{ name: 'R', template: 'Reviewer' }], composing())).toMatch(
			/at least one developer/
		);
		expect(fail([{ name: 'A', template: 'Developer', zone: ['../x'] }])).toBe(
			'The zone of A has an invalid path.'
		);
		expect(
			composeCrew.bind(
				null,
				approvedSpec(spec, composeCrew(spec, [{ name: 'A', template: 'Developer' }], newId)),
				[{ name: 'B', template: 'Developer' }],
				newId
			)
		).toThrow(/already set/);
	});
	it('needs a reviewer for every developer while the palette has one (spec/crew#compose)', () => {
		const spec = composing(),
			fail = (crew: unknown) => () => composeCrew(spec, crew, newId);
		expect(
			fail([
				{ name: 'API', template: 'Developer' },
				{ name: 'UI', template: 'Developer' },
			])
		).toThrow(
			'The crew needs at least one reviewer to check the developers. Reviewer templates: Reviewer, Designer.'
		);
		expect(
			fail([
				{ name: 'API', template: 'Developer', checkedBy: ['Check'] },
				{ name: 'UI', template: 'Developer' },
				{ name: 'Check', template: 'Reviewer' },
			])
		).toThrow('Every developer needs a reviewer in checkedBy: UI.');
		expect(
			composeCrew(
				spec,
				[
					{ name: 'API', template: 'Developer', checkedBy: ['Check'] },
					{ name: 'UI', template: 'Developer', checkedBy: ['Check'] },
					{ name: 'Check', template: 'Reviewer' },
				],
				newId
			).map((agent) => agent.checkedBy.length)
		).toEqual([1, 1, 0]);
	});
});

describe('records with a crew', () => {
	it('validates plans, decisions and launches', () => {
		const spec = withoutReviewers(composing()),
			crew = composeCrew(spec, [{ name: 'API', template: 'Developer' }], newId),
			part = { id: 'p1', title: 'Routes', agent: 'API', prompt: 'x', files: [], scopes: [] };
		expect(isCrewPlan({ id: 'plan', parts: [part], summary: '', crew })).toBe(true);
		expect(isCrewPlan({ id: 'plan', parts: [part], summary: '', crew: [] })).toBe(false);
		expect(isCrewPlanDecision({ id: 'plan', approved: true, parts: null, crew })).toBe(true);
		expect(isCrewPlanDecision({ id: 'plan', approved: true, parts: null })).toBe(true);
		expect(isCrewLaunch({ compose: true })).toBe(true);
		expect(isCrewLaunch({ compose: true, template: specAsTemplate(spec, () => true) })).toBe(true);
		expect(
			isCrewLaunch({
				compose: true,
				template: specAsTemplate(composedSpec(spec, crew), () => true),
			})
		).toBe(false);
		expect(isCrewLaunch({ compose: false })).toBe(false);
	});
	it('opens a resolved crew in the editor and resolves it back unchanged', () => {
		const spec = composing(),
			crew = composeCrew(
				spec,
				[
					{
						name: 'API',
						template: 'Developer',
						model: 'opus',
						zone: ['api/**'],
						checkedBy: ['Look'],
					},
					{ name: 'Look', template: 'Designer' },
					{ name: 'UI', template: 'Developer', checkedBy: ['Look'] },
				],
				newId
			);
		const template = specAsTemplate(composedSpec(spec, crew), (id) => !!lookup(id));
		expect(template.root.template).toBe(foremanTemplateId);
		expect(resolveCrew(template, { lookup, defaultProvider: 'claude' }).root.agents).toEqual(crew);
		// A template gone from the library keeps what the agent was told as its addition.
		const orphan = specAsTemplate(composedSpec(spec, crew), (id) => id !== 'designer').root
			.agents![1]!;
		expect(orphan).toMatchObject({ template: null, extraInstructions: 'Check the UI.' });
	});
});
