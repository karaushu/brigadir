import { describe, expect, it } from 'vitest';
import {
	actionChoice,
	actionCrewId,
	isActionCrews,
	migrateActionCrews,
	withActionCrew,
	agentActions,
	changedActions,
	inheritsDefaultAgent,
	isActionAgents,
	migrateActionAgents,
	taskLaunchOptions,
	withActionAgent,
} from './action-agents';
import { defaultAppSettings, isAppSettings, type HelperAgent } from './settings';
import { helperPlan } from './ghost-model';
import type { ProviderCatalog } from './crew';

const on = { claude: true, codex: true };
const sonnet: HelperAgent = {
	provider: 'claude',
	model: 'sonnet',
	name: 'Sonnet 5',
	effort: 'medium',
};
const luna: HelperAgent = {
	provider: 'codex',
	model: 'gpt-6-luna',
	name: '6 Luna',
	effort: 'high',
};
const claude: ProviderCatalog = {
	provider: 'claude',
	modes: [],
	options: [
		{
			kind: 'select',
			id: 'model',
			category: 'model',
			name: 'Model',
			description: null,
			value: 'opus',
			choices: [
				{ value: 'opus', name: 'Opus 5.5', description: null, group: null },
				{ value: 'haiku', name: 'Haiku 4.5', description: null, group: null },
			],
		},
		{
			kind: 'select',
			id: 'effort',
			category: 'thought_level',
			name: 'Effort',
			description: null,
			value: 'high',
			choices: [
				{ value: 'low', name: 'Low', description: null, group: null },
				{ value: 'high', name: 'High', description: null, group: null },
			],
		},
	],
};

describe('the agent of an action (spec/appearance#evolution-redesign)', () => {
	it('takes the one-time choice, then the action’s setting, then the Default / Helper agent', () => {
		const run = { provider: 'codex' as const, model: 'gpt-6-luna-mini', effort: null };
		const agents = { prSummary: sonnet };
		expect(actionChoice('prSummary', run, agents, on)).toEqual({ source: 'run', run });
		expect(actionChoice('prSummary', null, agents, on)).toEqual({
			source: 'action',
			run: { provider: 'claude', model: 'sonnet', effort: 'medium' },
		});
		// Another action inherits: the Helper agent (or the Default agent for a task) decides.
		expect(actionChoice('commitMessage', null, agents, on)).toEqual({
			source: 'default',
			run: null,
		});
		expect(actionChoice('review', undefined, {}, on)).toEqual({ source: 'default', run: null });
	});
	it('skips a choice whose provider is off and a setting whose model a known catalog has dropped', () => {
		const off = { claude: false, codex: true };
		expect(
			actionChoice(
				'prSummary',
				{ provider: 'claude', model: 'opus', effort: null },
				{ prSummary: luna },
				off
			).source
		).toBe('action');
		expect(actionChoice('prSummary', null, { prSummary: sonnet }, off).source).toBe('default');
		// `sonnet` is not in the catalog any more; an unknown catalog keeps the setting.
		expect(actionChoice('prSummary', null, { prSummary: sonnet }, on, { claude }).source).toBe(
			'default'
		);
		expect(actionChoice('prSummary', null, { prSummary: sonnet }, on, {}).source).toBe('action');
	});
	it('makes the Helper agent plan run the action’s agent', () => {
		const pick = actionChoice('commitMessage', null, { commitMessage: luna }, on).run;
		expect(helperPlan(pick, sonnet, on, {}).target).toMatchObject({
			provider: 'codex',
			model: 'gpt-6-luna',
			effort: 'high',
		});
		// Inheriting: the Helper agent of Settings.
		expect(
			helperPlan(actionChoice('commitMessage', null, {}, on).run, sonnet, on, {}).target
		).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'medium' });
	});
	it('starts a task with the model and the chosen effort of the action’s agent', () => {
		expect(
			taskLaunchOptions({ provider: 'claude', model: 'haiku', effort: 'low' }, claude)
		).toEqual([
			{ id: 'model', value: 'haiku' },
			{ id: 'effort', value: 'low' },
		]);
		// Effort null is the model's own level: not sent.
		expect(taskLaunchOptions({ provider: 'claude', model: 'haiku', effort: null }, claude)).toEqual(
			[{ id: 'model', value: 'haiku' }]
		);
		expect(taskLaunchOptions({ provider: 'claude', model: 'haiku', effort: null }, null)).toEqual(
			[]
		);
	});
});

describe('Remember and Reset (spec/appearance#evolution-redesign)', () => {
	it('remembers one action, resets one and resets all', () => {
		let agents = withActionAgent({}, 'prSummary', sonnet);
		agents = withActionAgent(agents, 'review', luna);
		expect(changedActions(agents)).toEqual(['review', 'prSummary']);
		// Remembering again replaces the action's agent.
		agents = withActionAgent(agents, 'prSummary', luna);
		expect(agents.prSummary).toEqual(luna);
		agents = withActionAgent(agents, 'review', null);
		expect(agents).toEqual({ prSummary: luna });
		expect(changedActions({})).toEqual([]);
		expect(Object.keys(withActionAgent(agents, 'prSummary', null))).toEqual([]);
	});
	it('stores only actions it knows with a whole agent', () => {
		expect(isActionAgents({ prSummary: sonnet, review: luna })).toBe(true);
		expect(isActionAgents({})).toBe(true);
		expect(isActionAgents({ chat: sonnet })).toBe(false);
		expect(isActionAgents({ prSummary: { provider: 'claude', model: 'sonnet' } })).toBe(false);
		expect(agentActions).toHaveLength(15);
		expect(isActionAgents({ slackAnswers: luna, slackCode: sonnet })).toBe(true);
		expect(isAppSettings({ ...defaultAppSettings, actionAgents: { split: luna } })).toBe(true);
		expect(isAppSettings({ ...defaultAppSettings, actionAgents: { split: null } })).toBe(false);
	});
});

describe('Slack’s two actions (spec/notifications-slack-notes-and-schedules#slack)', () => {
	it('answers by the action’s own agent while it is set and on, else by the default', () => {
		expect(actionChoice('slackAnswers', null, { slackAnswers: luna }, on)).toEqual({
			source: 'action',
			run: { provider: 'codex', model: 'gpt-6-luna', effort: 'high' },
		});
		expect(actionChoice('slackCode', null, { slackAnswers: luna }, on)).toEqual({
			source: 'default',
			run: null,
		});
		expect(
			actionChoice('slackCode', null, { slackCode: luna }, { claude: true, codex: false })
		).toEqual({ source: 'default', run: null });
		expect(actionChoice('slackCode', null, { slackCode: sonnet }, on, { claude }).source).toBe(
			'default'
		);
	});
	it('inherits: code questions from the Default agent, answers from the Helper agent', () => {
		expect(inheritsDefaultAgent('slackCode')).toBe(true);
		expect(inheritsDefaultAgent('review')).toBe(true);
		expect(inheritsDefaultAgent('slackAnswers')).toBe(false);
		expect(inheritsDefaultAgent('prSummary')).toBe(false);
	});
});

describe('the settings migration (spec/appearance#evolution-redesign)', () => {
	it('reads no actionAgents as every action inheriting', () => {
		const { actionAgents: _, ...legacy } = defaultAppSettings;
		const migrated = migrateActionAgents(legacy);
		expect(migrated.actionAgents).toEqual({});
		expect(isAppSettings(migrated)).toBe(true);
	});
	it('keeps a valid map as it is and drops an entry that is not an action or not an agent', () => {
		const value = { ...defaultAppSettings, actionAgents: { review: luna } };
		expect(migrateActionAgents(value)).toBe(value);
		expect(
			migrateActionAgents({
				...defaultAppSettings,
				actionAgents: { review: luna, chat: sonnet, prSummary: { provider: 'gemini' } },
			}).actionAgents
		).toEqual({ review: luna });
		expect(
			migrateActionAgents({ ...defaultAppSettings, actionAgents: 'all' }).actionAgents
		).toEqual({});
	});
});

describe('the crew of a review action (spec/pull-requests-and-ci#review-crew)', () => {
	const crew = { templateId: 'review', name: 'Review crew' };
	it('takes the one-time crew, else the remembered one unless an agent was chosen for this review', () => {
		expect(actionCrewId('review', null, 'mine', { review: crew })).toBe('mine');
		expect(actionCrewId('review', null, null, { review: crew })).toBe('review');
		expect(actionCrewId('review', sonnet, null, { review: crew })).toBeNull();
		expect(actionCrewId('reviewSuggestions', null, null, { review: crew })).toBeNull();
		expect(actionCrewId('agentFix', null, null, { review: crew })).toBeNull();
	});
	it('remembers and resets one action and validates the map in the settings', () => {
		const crews = withActionCrew({}, 'review', crew);
		expect(crews).toEqual({ review: crew });
		expect(withActionCrew(crews, 'review', null)).toEqual({});
		expect(isActionCrews({ review: crew })).toBe(true);
		expect(isActionCrews({ agentFix: crew })).toBe(false);
		expect(isActionCrews({ review: { templateId: 'review' } })).toBe(false);
		expect(isActionCrews({ review: { templateId: '../x', name: 'x' } })).toBe(false);
		expect(isAppSettings({ ...defaultAppSettings, actionCrews: { review: crew } })).toBe(true);
		expect(isAppSettings({ ...defaultAppSettings, actionCrews: { review: null } })).toBe(false);
		const { actionCrews: _, ...legacy } = defaultAppSettings;
		expect(isAppSettings(legacy)).toBe(false);
		const migrated = migrateActionCrews(legacy);
		expect(migrated.actionCrews).toEqual({});
		expect(isAppSettings(migrated)).toBe(true);
		expect(
			migrateActionCrews({ ...defaultAppSettings, actionCrews: { review: crew, conflicts: crew } })
				.actionCrews
		).toEqual({ review: crew });
	});
});
