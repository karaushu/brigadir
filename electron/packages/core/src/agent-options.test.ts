import { expect, it } from 'vitest';
import {
	agentOptionKind,
	orderAgentOptions,
	nextAgentMode,
	catalogOptions,
	selectOption,
	modelDisplayName,
	fastOptionOn,
	capsuleShows,
	typicalChoices,
} from './agent-options';
import type { AgentOption } from './agent';
it('orders only advertised options without changing labels or losing unknown options', () => {
	const option = (id: string, category: string | null): AgentOption => ({
			id,
			category,
			name: id,
			description: null,
			kind: 'boolean',
			value: false,
		}),
		items = [
			option('extra-a', null),
			option('fast', null),
			option('approval', 'mode'),
			option('thinking', 'thought_level'),
			option('selected', 'model'),
			option('extra-b', null),
		];
	expect(orderAgentOptions(items).map((item) => item.id)).toEqual([
		'selected',
		'thinking',
		'approval',
		'fast',
		'extra-a',
		'extra-b',
	]);
	expect(items[0]?.id).toBe('extra-a');
	expect(orderAgentOptions(items).every((item) => items.includes(item))).toBe(true);
	expect(agentOptionKind(option('reasoning_effort', null))).toBe('effort');
	expect(orderAgentOptions([])).toEqual([]);
});

it('cycles advertised modes with wrapping and does not invent unavailable modes', () => {
	const modes = [
		{ id: 'auto', name: 'Auto', description: null },
		{ id: 'manual', name: 'Manual', description: null },
	];
	expect(nextAgentMode([], modes, 'manual')).toEqual({ kind: 'setMode', modeId: 'auto' });
	expect(nextAgentMode([], [], null)).toBeNull();
	expect(
		nextAgentMode(
			[
				{
					id: 'approval',
					category: 'mode',
					name: 'Mode',
					description: null,
					kind: 'select',
					value: 'b',
					choices: [
						{ value: 'a', name: 'A', description: null, group: null },
						{ value: 'b', name: 'B', description: null, group: null },
					],
				},
			],
			modes,
			'manual'
		)
	).toEqual({ kind: 'setOption', id: 'approval', value: 'a' });
});

it('gives the options of the chosen model and falls back to the advertised catalog (spec/agents-and-providers#catalog)', () => {
	const select = (
		id: string,
		category: string,
		values: string[],
		value = values[0]!
	): AgentOption => ({
		id,
		category,
		name: id,
		description: null,
		kind: 'select',
		value,
		choices: values.map((item) => ({ value: item, name: item, description: null, group: null })),
	});
	const model = select('model', 'model', ['default', 'haiku']),
		effort = select('effort', 'thought_level', ['low', 'high'], 'high');
	const catalog = {
		options: [model, effort],
		byModel: {
			default: [model, effort],
			haiku: [select('model', 'model', ['default', 'haiku'], 'haiku')],
		},
	};
	expect(selectOption(catalogOptions(catalog, 'haiku'), 'effort')).toBeUndefined();
	expect(selectOption(catalogOptions(catalog, 'default'), 'effort')?.value).toBe('high');
	expect(catalogOptions(catalog, 'unknown')).toBe(catalog.options);
	expect(catalogOptions({ options: [model] }, 'haiku')).toEqual([model]);
	expect(catalogOptions(null, 'haiku')).toEqual([]);
	expect(
		selectOption(
			[
				{
					id: 'fast',
					category: null,
					name: 'fast',
					description: null,
					kind: 'boolean',
					value: false,
				},
			],
			'model'
		)
	).toBeUndefined();
});

it('knows Codex fast-mode as the fast option (spec/agents-and-providers#catalog)', () => {
	const option = (id: string, category: string | null): AgentOption => ({
		id,
		category,
		name: id,
		description: null,
		kind: 'boolean',
		value: false,
	});
	expect(agentOptionKind(option('fast-mode', 'model_config'))).toBe('fast');
	expect(agentOptionKind(option('fast', 'model_config'))).toBe('fast');
	expect(agentOptionKind(option('trace', null))).toBe('other');
});
it('spec/composer#capsule-squeeze: shortens a model name only by the provider prefix and reads fast on from booleans and selects', () => {
	expect(modelDisplayName('claude-opus-5', 'claude')).toBe('opus-5');
	expect(modelDisplayName('Claude-Haiku-4-5', 'claude')).toBe('Haiku-4-5');
	expect(modelDisplayName('Opus (1M context)', 'claude')).toBe('Opus (1M context)');
	expect(modelDisplayName('gpt-6-sol', 'codex')).toBe('gpt-6-sol');
	expect(modelDisplayName('claude-', 'claude')).toBe('claude-');
	expect(modelDisplayName('claude-opus-5', undefined)).toBe('claude-opus-5');
	const select = (value: string): AgentOption => ({
		id: 'fast-mode',
		category: 'model_config',
		name: 'Fast mode',
		description: null,
		kind: 'select',
		value,
		choices: [
			{ value: 'off', name: 'Off', description: null, group: null },
			{ value: 'on', name: 'On', description: null, group: null },
		],
	});
	expect(fastOptionOn(select('on'))).toBe(true);
	expect(fastOptionOn(select('off'))).toBe(false);
	expect(
		fastOptionOn({
			id: 'fast',
			category: null,
			name: 'Fast',
			description: null,
			kind: 'boolean',
			value: true,
		})
	).toBe(true);
});
it('the capsule shows model and effort always, the mode off its typical choice, Fast and flags only when on (spec/composer#agent-capsule)', () => {
	const select = (
		id: string,
		category: string | null,
		value: string,
		choices: string[]
	): AgentOption => ({
		id,
		category,
		name: id,
		description: null,
		kind: 'select',
		value,
		choices: choices.map((choice) => ({
			value: choice,
			name: choice[0]!.toUpperCase() + choice.slice(1),
			description: null,
			group: null,
		})),
	});
	const flag = (id: string, value: boolean): AgentOption => ({
		id,
		category: null,
		name: id,
		description: null,
		kind: 'boolean',
		value,
	});
	expect(capsuleShows(select('model', 'model', 'opus', ['opus', 'sonnet']))).toBe(true);
	expect(capsuleShows(select('effort', 'thought_level', 'low', ['low', 'high']))).toBe(true);
	// The choice named `default` is typical wherever the agent lists it; otherwise its first. A choice whose
	// value or name is `auto` is typical too, whichever agent lists it.
	const claudeModes = ['acceptEdits', 'default', 'plan', 'auto', 'bypassPermissions'];
	expect(typicalChoices(select('mode', 'mode', 'plan', claudeModes))).toEqual(['default', 'auto']);
	expect(capsuleShows(select('mode', 'mode', 'default', claudeModes))).toBe(false);
	expect(capsuleShows(select('mode', 'mode', 'auto', claudeModes))).toBe(false);
	expect(capsuleShows(select('mode', 'mode', 'plan', claudeModes))).toBe(true);
	expect(capsuleShows(select('mode', 'mode', 'bypassPermissions', claudeModes))).toBe(true);
	expect(capsuleShows(select('mode', 'mode', 'manual', ['manual', 'auto', 'full']))).toBe(false);
	expect(capsuleShows(select('mode', 'mode', 'auto', ['manual', 'auto', 'full']))).toBe(false);
	expect(capsuleShows(select('mode', 'mode', 'full', ['manual', 'auto', 'full']))).toBe(true);
	const named = select('mode', 'mode', 'agent', ['manual', 'agent']);
	if (named.kind === 'select') named.choices[1]!.name = 'Auto mode';
	expect(capsuleShows(named)).toBe(false);
	expect(capsuleShows(select('mode', 'mode', 'autopilot', ['manual', 'autopilot']))).toBe(true);
	expect(capsuleShows(flag('fast', false))).toBe(false);
	expect(capsuleShows(flag('fast', true))).toBe(true);
	expect(capsuleShows(select('fast', null, 'off', ['off', 'on']))).toBe(false);
	expect(capsuleShows(select('fast', null, 'on', ['off', 'on']))).toBe(true);
	expect(capsuleShows(flag('web_search', false))).toBe(false);
	expect(capsuleShows(flag('web_search', true))).toBe(true);
	expect(capsuleShows(select('sandbox', null, 'strict', ['strict', 'loose']))).toBe(true);
	// spec/composer#capsule-segments: an On/Off select of the agent's (Claude's Ultracode) is a flag — off hides its segment, as Fast's.
	expect(capsuleShows(select('ultracode', 'model_config', 'off', ['on', 'off']))).toBe(false);
	expect(capsuleShows(select('ultracode', 'model_config', 'on', ['on', 'off']))).toBe(true);
	expect(capsuleShows(select('choice', null, 'off', ['on', 'off', 'auto']))).toBe(true);
});
