import { expect, it } from 'vitest';
import {
	builtinAgentTemplates,
	defaultAutoBudget,
	isAutoTask,
	type AgentTemplate,
	type ProviderCatalog,
} from '@brigadir/core';
import { autoModelAnswer, autoTaskSnapshot } from './auto-launch';

it('stores the roles an Auto task hires from: the library without the foreman, the own template over a built-in of its name, enabled providers only (spec/crew#auto-roles)', () => {
	const own: AgentTemplate = {
		id: 'own-dev',
		name: 'Developer',
		role: 'developer',
		provider: 'codex',
		instructions: 'Own developer.',
		builtin: false,
	};
	const both = autoTaskSnapshot(
		[...builtinAgentTemplates, own],
		'claude',
		{ claude: true, codex: true },
		defaultAutoBudget
	);
	expect(isAutoTask(both)).toBe(true);
	expect(both.roles.some((role) => role.role === 'foreman')).toBe(false);
	expect(both.roles.filter((role) => role.name === 'Developer').map((role) => role.id)).toEqual([
		'own-dev',
	]);
	expect(both.budget).toEqual(defaultAutoBudget);
	const claudeOnly = autoTaskSnapshot(
		[...builtinAgentTemplates, own],
		'claude',
		{ claude: true, codex: false },
		{ minutes: 20, tokens: 200_000 }
	);
	expect(claudeOnly.roles.every((role) => role.provider === 'claude')).toBe(true);
	expect(claudeOnly.roles.some((role) => role.id === 'own-dev')).toBe(false);
	expect(claudeOnly.budget).toEqual({ minutes: 20, tokens: 200_000 });
});

const catalog: Pick<ProviderCatalog, 'options' | 'byModel'> = {
	options: [
		{
			kind: 'select',
			id: 'model',
			name: 'Model',
			category: 'model',
			value: 'gpt-6-astra',
			choices: [
				{ value: 'gpt-6-astra', name: '6 Astra' },
				{ value: 'gpt-6-luna', name: '6 Luna' },
			],
		},
		{
			kind: 'select',
			id: 'reasoning_effort',
			name: 'Reasoning effort',
			category: 'thought_level',
			value: 'medium',
			choices: [
				{ value: 'medium', name: 'Medium' },
				{ value: 'high', name: 'High' },
			],
		},
	],
} as never;

it('asks the person for another model unless Any catalog model is on and the agent named one (spec/crew#auto-model)', () => {
	const request = {
		id: 'q1',
		reason: 'Vision',
		role: 'Developer',
		provider: 'codex' as const,
		model: '6 Luna',
		effort: 'high',
	};
	expect(autoModelAnswer(request, false, catalog)).toEqual({ ask: true });
	expect(autoModelAnswer({ id: 'q1', reason: 'Vision', role: 'Developer' }, true, catalog)).toEqual(
		{ ask: true }
	);
	expect(autoModelAnswer(request, true, catalog)).toEqual({
		provider: 'codex',
		model: { id: 'model', value: 'gpt-6-luna', name: '6 Luna' },
		effort: { id: 'reasoning_effort', value: 'high', name: 'High' },
	});
	expect(() => autoModelAnswer({ ...request, model: 'GPT-9' }, true, catalog)).toThrow(
		/no model «GPT-9»/
	);
	expect(() => autoModelAnswer(request, true, null)).toThrow(/not known yet/);
});
