import { selectOption } from './agent-options';
import type { ProviderCatalog } from './crew';
import { isId, isRecord } from './workspace';
import { isHelperAgent, type AgentProviderId, type HelperAgent, type HelperRun } from './settings';
/**
 * spec/appearance#evolution-redesign: an agent per action on top of «one for all». Each action inherits — tasks from the Default agent, one-off
 * texts from the Helper agent — until Settings ▸ Agents ▸ Customize per action (or `Remember for …` in the in-place capsule)
 * gives it its own model · effort.
 */
export const taskActions = [
	'review',
	'reviewSuggestions',
	'taskReview',
	'agentFix',
	'conflicts',
] as const;
export const helperActions = [
	'prSummary',
	'reviewDrafts',
	'commitMessage',
	'prText',
	'branchName',
	'split',
	'projectIcon',
	'promptHint',
] as const;
/**
 * spec/notifications-slack-notes-and-schedules#slack: Slack's own two. `slackAnswers` — the helper's one-shots of a mention (its kind, the answer
 * from the facts, a note's summary), inherits the Helper agent; `slackCode` — the read-only side session that answers a
 * question about the code or a task, inherits the Default agent (a task's question — the task's own provider).
 */
export const slackAgentActions = ['slackAnswers', 'slackCode'] as const;
export const agentActions = [...taskActions, ...helperActions, ...slackAgentActions] as const;
export type TaskAction = (typeof taskActions)[number];
export type HelperAction = (typeof helperActions)[number];
export type SlackAgentAction = (typeof slackAgentActions)[number];
export type AgentAction = (typeof agentActions)[number];
/** Only the changed actions are stored; an absent key inherits. For a task action `effort` null is the model's own default,
 *  for a one-off text the lowest level, as for the Helper agent. */
export type ActionAgents = Partial<Record<AgentAction, HelperAgent>>;
export function isAgentAction(value: unknown): value is AgentAction {
	return agentActions.includes(value as AgentAction);
}
export function isTaskAction(action: AgentAction): action is TaskAction {
	return taskActions.includes(action as TaskAction);
}
/** The actions that inherit the Default agent (a session: effort null is the model's own); the rest inherit the Helper agent. */
export function inheritsDefaultAgent(action: AgentAction): boolean {
	return isTaskAction(action) || action === 'slackCode';
}
export function isActionAgents(value: unknown): value is ActionAgents {
	return (
		isRecord(value) &&
		Object.entries(value).every(([key, agent]) => isAgentAction(key) && isHelperAgent(agent))
	);
}
/** An older settings file has no `actionAgents`: every action inherits. An entry that is not an action or not an
 *  agent is dropped — that action inherits too. */
export function migrateActionAgents(value: Record<string, unknown>): Record<string, unknown> {
	const stored = value.actionAgents;
	if (isActionAgents(stored)) return value;
	return {
		...value,
		actionAgents: isRecord(stored)
			? Object.fromEntries(
					Object.entries(stored).filter(
						([key, agent]) => isAgentAction(key) && isHelperAgent(agent)
					)
				)
			: {},
	};
}
/** Remember (an agent) or Reset (null) one action; the others stay as they are. */
export function withActionAgent(
	agents: ActionAgents,
	action: AgentAction,
	agent: HelperAgent | null
): ActionAgents {
	const { [action]: _, ...rest } = agents;
	return agent ? { ...rest, [action]: agent } : rest;
}
export function changedActions(agents: ActionAgents): AgentAction[] {
	return agentActions.filter((action) => agents[action]);
}
/**
 * spec/pull-requests-and-ci#review-crew: a crew instead of one agent — the Crew segment of «Review with an agent ▾». Only the review actions take a crew; the
 * entry names a library crew by id and keeps its name for Settings ▸ Agents ▸ Customize per action (`Crew · <name>`).
 */
export const crewActions = ['review', 'reviewSuggestions', 'taskReview'] as const;
export type CrewAction = (typeof crewActions)[number];
export type ActionCrew = { templateId: string; name: string };
export type ActionCrews = Partial<Record<CrewAction, ActionCrew>>;
export function isCrewAction(value: unknown): value is CrewAction {
	return crewActions.includes(value as CrewAction);
}
export function isActionCrew(value: unknown): value is ActionCrew {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		isId(value.templateId) &&
		typeof value.name === 'string' &&
		value.name.trim().length > 0 &&
		value.name.length <= 200
	);
}
export function isActionCrews(value: unknown): value is ActionCrews {
	return (
		isRecord(value) &&
		Object.entries(value).every(([key, crew]) => isCrewAction(key) && isActionCrew(crew))
	);
}
/** An older settings file has no `actionCrews`; an entry that is not a review action or not a crew is dropped. */
export function migrateActionCrews(value: Record<string, unknown>): Record<string, unknown> {
	const stored = value.actionCrews;
	if (isActionCrews(stored)) return value;
	return {
		...value,
		actionCrews: isRecord(stored)
			? Object.fromEntries(
					Object.entries(stored).filter(([key, crew]) => isCrewAction(key) && isActionCrew(crew))
				)
			: {},
	};
}
/** Remember (a crew) or Reset (null) one action's crew; the others stay as they are. */
export function withActionCrew(
	crews: ActionCrews,
	action: CrewAction,
	crew: ActionCrew | null
): ActionCrews {
	const { [action]: _, ...rest } = crews;
	return crew ? { ...rest, [action]: crew } : rest;
}
/**
 * spec/pull-requests-and-ci#review-crew: the crew of a review — the one-time crew of the menu, else (unless an agent was chosen for this review) the crew the
 * action remembers; null runs one agent. The agent and the crew exclude each other, here as in the menu.
 */
export function actionCrewId(
	action: TaskAction,
	run: HelperRun | null | undefined,
	crew: string | null | undefined,
	crews: ActionCrews
): string | null {
	if (crew) return crew;
	if (run || !isCrewAction(action)) return null;
	return crews[action]?.templateId ?? null;
}
type Catalogs = Partial<Record<AgentProviderId, ProviderCatalog | null>>;
export type ActionChoice = {
	/** `run` — the capsule's one-time choice; `action` — the action's own setting; `default` — the Default or Helper agent. */
	source: 'run' | 'action' | 'default';
	run: HelperRun | null;
};
/**
 * The order for every action: the one-time choice of the capsule → the action's setting → the Default / Helper agent
 * (`run: null`). A choice whose provider is off is skipped; so is a setting whose model a known catalog no longer lists. A
 * catalog that is not known yet never makes a setting unavailable.
 */
export function actionChoice(
	action: AgentAction,
	run: HelperRun | null | undefined,
	agents: ActionAgents,
	enabled: Record<AgentProviderId, boolean>,
	catalogs: Catalogs = {}
): ActionChoice {
	if (run && enabled[run.provider]) return { source: 'run', run };
	const own = agents[action];
	if (own && enabled[own.provider]) {
		const catalog = catalogs[own.provider],
			model = catalog ? selectOption(catalog.options, 'model') : undefined;
		if (!model || model.choices.some((choice) => choice.value === own.model))
			return {
				source: 'action',
				run: { provider: own.provider, model: own.model, effort: own.effort },
			};
	}
	return { source: 'default', run: null };
}
/** The task's agent options from a choice: the model and, when chosen, the effort, by the catalog's own option ids. */
export function taskLaunchOptions(
	run: HelperRun,
	catalog: ProviderCatalog | null | undefined
): { id: string; value: string }[] {
	if (!catalog) return [];
	const model = selectOption(catalog.options, 'model'),
		effort = selectOption(catalog.byModel?.[run.model] ?? catalog.options, 'effort');
	return [
		...(model ? [{ id: model.id, value: run.model }] : []),
		...(effort && run.effort ? [{ id: effort.id, value: run.effort }] : []),
	];
}
