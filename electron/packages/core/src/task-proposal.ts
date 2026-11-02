import { isId, isRecord } from './workspace';
import type { TaskLaunch } from './launch';
import type { PromptAttachment } from './attachments';
import { utf8Bytes } from './utf8';
import { catalogOptions, selectOption } from './agent-options';
import type { ProviderCatalog } from './crew';
import { providerName } from './quota';
import {
	isScheduleRule,
	isTimeZone,
	scheduleMissedValues,
	type ScheduleMissed,
	type ScheduleRule,
} from './schedules';
/**
 * spec/tasks#agent-created-tasks: a task the agent proposes with `create_task` in the same project. The host shows it as a card and waits;
 * main creates the task when the person presses `Створити` (or the sheet it opened is submitted) and answers the host.
 */
export type TaskProposalContext =
	| { kind: 'summary' }
	| { kind: 'diff'; full: boolean }
	| { kind: 'file'; path: string }
	| { kind: 'text'; name: string; text: string };
/** spec/tasks#agent-created-tasks: the agent `create_task` names for the new task; without it the task inherits the source's agent. */
export type TaskAgentRequest = { provider: 'claude' | 'codex'; model?: string; effort?: string };
/** spec/tasks#agent-created-tasks: that agent checked against the provider's catalog before the card shows — what the new task launches with. */
export type TaskProposalAgent = {
	provider: 'claude' | 'codex';
	options: { id: string; value: string }[];
	modelName: string | null;
	effortName: string | null;
};
export type TaskProposal = {
	id: string;
	title: string | null;
	prompt: string;
	context: TaskProposalContext[];
	folders: string[];
	start: 'now' | 'backlog' | 'schedule';
	agent?: TaskProposalAgent;
	/** spec/notifications-slack-notes-and-schedules#schedules: `start: schedule` — the person makes a schedule from the card; every run is a new task from the prompt. */
	schedule?: { rule: ScheduleRule; timeZone: string; missed: ScheduleMissed };
};
/** What the card and the agent learn: the created task, or `null` when the person declined. */
export type TaskProposalResult = { projectId: string; id: string; title: string } | null;
/** What the sheet opened from a proposal starts with (`Відкрити в аркуші…`). */
export type TaskProposalDraft = {
	prompt: string;
	title: string | null;
	launch: TaskLaunch;
	provider: 'claude' | 'codex';
	transport: 'gui' | 'terminal';
	options: { id: string; value: string | boolean }[];
	attachments: PromptAttachment[];
};
export const taskProposalLimits = {
	title: 80,
	prompt: 100_000,
	context: 10,
	text: 256 * 1024,
	name: 200,
	folders: 5,
	path: 4096,
} as const;
const path = (v: unknown): v is string =>
	typeof v === 'string' &&
	v.startsWith('/') &&
	v.length <= taskProposalLimits.path &&
	!v.includes('\0');
export function isTaskProposalContext(v: unknown): v is TaskProposalContext {
	if (!isRecord(v)) return false;
	switch (v.kind) {
		case 'summary':
			return Object.keys(v).length === 1;
		case 'diff':
			return typeof v.full === 'boolean';
		case 'file':
			return path(v.path);
		case 'text':
			return (
				typeof v.name === 'string' &&
				v.name.trim().length > 0 &&
				v.name.length <= taskProposalLimits.name &&
				typeof v.text === 'string' &&
				v.text.trim().length > 0 &&
				utf8Bytes(v.text) <= taskProposalLimits.text
			);
		default:
			return false;
	}
}
const provider = (v: unknown): v is 'claude' | 'codex' => v === 'claude' || v === 'codex';
const word = (v: unknown): v is string =>
	typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
export function isTaskAgentRequest(v: unknown): v is TaskAgentRequest {
	return (
		isRecord(v) &&
		provider(v.provider) &&
		(v.model === undefined || word(v.model)) &&
		(v.effort === undefined || word(v.effort)) &&
		Object.keys(v).every((key) => ['provider', 'model', 'effort'].includes(key))
	);
}
export function isTaskProposalAgent(v: unknown): v is TaskProposalAgent {
	return (
		isRecord(v) &&
		provider(v.provider) &&
		Array.isArray(v.options) &&
		v.options.length <= 2 &&
		v.options.every(
			(option) =>
				isRecord(option) &&
				word(option.id) &&
				word(option.value) &&
				Object.keys(option).length === 2
		) &&
		(v.modelName === null || word(v.modelName)) &&
		(v.effortName === null || word(v.effortName)) &&
		Object.keys(v).length === 4
	);
}
/**
 * spec/tasks#agent-created-tasks: the named model and effort by the catalog's own option ids (rule 7) — a model by its value or name, an effort
 * among the levels of that model (spec/agents-and-providers#catalog). An unknown one throws with what is available, for the agent to retry.
 */
export function resolveTaskAgent(
	request: TaskAgentRequest,
	catalog: Pick<ProviderCatalog, 'options' | 'byModel'> | null | undefined
): TaskProposalAgent {
	const agent = providerName(request.provider),
		result: TaskProposalAgent = {
			provider: request.provider,
			options: [],
			modelName: null,
			effortName: null,
		};
	if (!request.model && !request.effort) return result;
	if (!catalog)
		throw new Error(
			`The ${agent} models are not known yet: its CLI is missing, signed out or still starting. Leave model and effort out to use its default.`
		);
	const pick = (kind: 'model' | 'effort', wanted: string, model?: string) => {
		const option = selectOption(catalogOptions(catalog, model), kind);
		if (!option) throw new Error(`${agent} offers no ${kind} choice; leave ${kind} out.`);
		const needle = wanted.trim().toLocaleLowerCase(),
			choice =
				option.choices.find((item) => item.value.toLocaleLowerCase() === needle) ??
				option.choices.find((item) => item.name.toLocaleLowerCase() === needle);
		if (!choice)
			throw new Error(
				`${agent} has no ${kind} «${wanted}»${model ? ` for the model ${model}` : ''}. Available: ${option.choices
					.map((item) => (item.name === item.value ? item.value : `${item.value} (${item.name})`))
					.join(', ')}.`
			);
		result.options.push({ id: option.id, value: choice.value });
		return choice;
	};
	const model = request.model ? pick('model', request.model) : null;
	if (model) result.modelName = model.name;
	if (request.effort) result.effortName = pick('effort', request.effort, model?.value).name;
	return result;
}
const single = (items: unknown[], kind: string) =>
	items.filter((item) => isRecord(item) && item.kind === kind).length <= 1;
export function isTaskProposal(v: unknown): v is TaskProposal {
	return (
		isRecord(v) &&
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		v.id.length <= 64 &&
		(v.title === null ||
			(typeof v.title === 'string' &&
				v.title.trim().length > 0 &&
				v.title.length <= taskProposalLimits.title)) &&
		typeof v.prompt === 'string' &&
		v.prompt.trim().length > 0 &&
		v.prompt.length <= taskProposalLimits.prompt &&
		Array.isArray(v.context) &&
		v.context.length <= taskProposalLimits.context &&
		v.context.every(isTaskProposalContext) &&
		single(v.context, 'summary') &&
		single(v.context, 'diff') &&
		Array.isArray(v.folders) &&
		v.folders.length <= taskProposalLimits.folders &&
		v.folders.every(path) &&
		new Set(v.folders).size === v.folders.length &&
		(v.start === 'now' || v.start === 'backlog' || v.start === 'schedule') &&
		(v.start === 'schedule'
			? isRecord(v.schedule) &&
				isScheduleRule(v.schedule.rule) &&
				isTimeZone(v.schedule.timeZone) &&
				scheduleMissedValues.includes(v.schedule.missed as ScheduleMissed)
			: v.schedule === undefined) &&
		(v.agent === undefined || isTaskProposalAgent(v.agent))
	);
}
export function isTaskProposalResult(v: unknown): v is TaskProposalResult {
	return (
		v === null ||
		(isRecord(v) &&
			isId(v.projectId) &&
			isId(v.id) &&
			typeof v.title === 'string' &&
			v.title.length <= 200 &&
			Object.keys(v).length === 3)
	);
}
/** A folder's chip name on the card: its last path segment, as spec/projects-and-board#external-folders names an added folder. */
export function taskProposalFolderName(folder: string) {
	return folder.replace(/\/+$/, '').split('/').at(-1) || folder;
}
