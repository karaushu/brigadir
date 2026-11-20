import { isId, isRecord } from './workspace';
import {
	autoCrewId,
	crewName,
	crewNameLimit,
	isCrewName,
	isCrewSpecAgent,
	normalizeZonePath,
	whenToUseLine,
	zonePrefix,
	crewAgentsPerNodeLimit,
	type CrewSpec,
	type CrewSpecAgent,
} from './crew';
import type { AgentProvider } from './agent';
/**
 * spec/crew#auto: the `Auto` task — one agent that writes the code itself and may hire workers for independent parts.
 * Pure types, validators and the host's gates; the host runs them, the card shows them.
 */

/** spec/crew#auto-budget: working minutes and tokens a hired part may spend before it goes to the person. */
export type AutoBudget = { minutes: number; tokens: number };
export const autoBudgetLimits = {
	minutes: { min: 5, max: 600, step: 5 },
	tokens: { min: 50_000, max: 20_000_000, step: 50_000 },
} as const;
export const defaultAutoBudget: AutoBudget = { minutes: 40, tokens: 400_000 };
const within = (value: unknown, limits: { min: number; max: number }) =>
	Number.isSafeInteger(value) && Number(value) >= limits.min && Number(value) <= limits.max;
export function isAutoBudget(value: unknown): value is AutoBudget {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		within(value.minutes, autoBudgetLimits.minutes) &&
		within(value.tokens, autoBudgetLimits.tokens)
	);
}
/** A budget value from an agent or a field, kept inside the limits. */
export function clampAutoBudget(
	input: Partial<Record<keyof AutoBudget, unknown>>,
	fallback: AutoBudget
): AutoBudget {
	const clamp = (value: unknown, limits: { min: number; max: number }, otherwise: number) =>
		typeof value === 'number' && Number.isFinite(value)
			? Math.min(limits.max, Math.max(limits.min, Math.round(value)))
			: otherwise;
	return {
		minutes: clamp(input.minutes, autoBudgetLimits.minutes, fallback.minutes),
		tokens: clamp(input.tokens, autoBudgetLimits.tokens, fallback.tokens),
	};
}
/** spec/settings-modules-and-onboarding#settings-keys: Settings ▸ Auto. */
export type AutoSettings = { anyModel: boolean; partBudget: AutoBudget };
export const defaultAutoSettings: AutoSettings = {
	anyModel: false,
	partBudget: { ...defaultAutoBudget },
};
export function isAutoSettings(value: unknown): value is AutoSettings {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		typeof value.anyModel === 'boolean' &&
		isAutoBudget(value.partBudget)
	);
}
/** spec/crew#auto-roles: what an Auto task stores at its start — the roles it hires from and the part budget of that moment. */
export type AutoTask = { roles: CrewSpecAgent[]; budget: AutoBudget };
export function isAutoTask(value: unknown): value is AutoTask {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		Array.isArray(value.roles) &&
		value.roles.length <= crewAgentsPerNodeLimit &&
		value.roles.every(
			(role) =>
				isCrewSpecAgent(role) &&
				(role as CrewSpecAgent).agents.length === 0 &&
				(role as CrewSpecAgent).role !== 'foreman'
		) &&
		new Set((value.roles as CrewSpecAgent[]).map((role) => role.id)).size === value.roles.length &&
		isAutoBudget(value.budget)
	);
}
/** spec/crew#auto-root: the Auto agent as the root of its crew — the task's own provider and choices, named after the provider. */
export function autoSpec(task: {
	provider?: AgentProvider;
	createdAt?: string;
	launchOptions?: { id: string; value: string | boolean }[];
	modelName?: string;
	effortName?: string;
	agentOptions?: { id: string; category?: string | null }[];
}): CrewSpec {
	const provider = task.provider ?? 'claude';
	const configOptions = Object.fromEntries(
		(task.launchOptions ?? []).map((option) => [option.id, option.value])
	);
	return {
		schemaVersion: 1,
		templateId: autoCrewId,
		name: 'Auto',
		resolvedAt:
			task.createdAt && Number.isFinite(Date.parse(task.createdAt))
				? task.createdAt
				: new Date(0).toISOString(),
		root: {
			id: 'root',
			name: autoRootName(provider),
			role: 'foreman',
			provider,
			requestedChoices: Object.keys(configOptions).length ? { configOptions } : {},
			choiceNames: {},
			whenToUse: '',
			instructions: '',
			extraInstructions: '',
			zone: [],
			checkedBy: [],
			agents: [],
		},
	};
}
/** The root's name is what workers and the card call the agent: `Claude wants to hire 3 workers`. */
export function autoRootName(provider: AgentProvider): string {
	return provider === 'codex' ? 'Codex' : 'Claude';
}
/** spec/sidebar#crew-card: an Auto worker's row starts with its role, not its unique node name. */
export function autoRoleLabel(auto: AutoTask | undefined, node: CrewSpecAgent): string {
	return (
		(node.template && auto?.roles.find((role) => role.id === node.template)?.name) || node.name
	);
}

// ── hire ─────────────────────────────────────────────────────────────

/** spec/crew#auto-gates: the host refuses a part whose zone overlaps another part's or a running worker's, or that is too small for a session of its own. */
export type AutoPartRefusal =
	| {
			code: 'overlap';
			message: string;
			path: string;
			/** The 1-based number of the earlier part it overlaps, or null for a running worker. */ part:
				number | null;
			worker?: string;
	  }
	| { code: 'small'; message: string; lines: number; files: number };
export type AutoHirePart = {
	id: string;
	title: string;
	/** The role's id on the task (`AutoTask.roles`). */ role: string;
	roleName: string;
	prompt: string;
	zone: string[];
	scopes: string[];
	acceptance?: string;
	budget: AutoBudget;
	/** The agent's estimate of what the part changes; the size gate reads it. */ estimate: {
		files: number;
		lines: number;
	};
	refused?: AutoPartRefusal;
};
export type AutoHire = { id: string; summary: string; parts: AutoHirePart[] };
/** `parts`: the person's edit (titles, roles, budgets, prompts); null keeps the proposal. */
export type AutoHireDecision = { id: string; approved: boolean; parts: AutoHirePart[] | null };
export type AutoHired = { partId: string; taskId: string; name: string; role: string };
export const autoHirePartLimit = 16,
	autoSummaryLimit = 20_000,
	autoPartPromptLimit = 100_000,
	autoAcceptanceLimit = 20_000,
	autoZoneLimit = 256;
/** spec/crew#auto-gates: a part under this many changed lines is cheaper done by the agent than briefed to a fresh session. */
export const autoPartMinLines = 50;
const text = (value: unknown, limit: number): value is string =>
	typeof value === 'string' && value.length <= limit && !value.includes('\0');
const count = (value: unknown) =>
	Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000;
function isRefusal(value: unknown): value is AutoPartRefusal {
	if (!isRecord(value) || !text(value.message, 2000)) return false;
	if (value.code === 'overlap')
		return (
			text(value.path, 1024) &&
			(value.part === null || (Number.isSafeInteger(value.part) && Number(value.part) >= 1)) &&
			(value.worker === undefined || isCrewName(value.worker))
		);
	return value.code === 'small' && count(value.lines) && count(value.files);
}
export function isAutoHirePart(value: unknown): value is AutoHirePart {
	return (
		isRecord(value) &&
		isId(value.id) &&
		text(value.title, crewNameLimit) &&
		value.title.trim().length > 0 &&
		isId(value.role) &&
		isCrewName(value.roleName) &&
		text(value.prompt, autoPartPromptLimit) &&
		value.prompt.trim().length > 0 &&
		Array.isArray(value.zone) &&
		value.zone.length > 0 &&
		value.zone.length <= autoZoneLimit &&
		value.zone.every((path) => typeof path === 'string' && normalizeZonePath(path) === path) &&
		Array.isArray(value.scopes) &&
		value.scopes.length <= 512 &&
		value.scopes.every((scope) => text(scope, 4096)) &&
		(value.acceptance === undefined || text(value.acceptance, autoAcceptanceLimit)) &&
		isAutoBudget(value.budget) &&
		isRecord(value.estimate) &&
		count(value.estimate.files) &&
		count(value.estimate.lines) &&
		(value.refused === undefined || isRefusal(value.refused))
	);
}
export function isAutoHire(value: unknown): value is AutoHire {
	return (
		isRecord(value) &&
		isId(value.id) &&
		text(value.summary, autoSummaryLimit) &&
		Array.isArray(value.parts) &&
		value.parts.length >= 1 &&
		value.parts.length <= autoHirePartLimit &&
		value.parts.every(isAutoHirePart) &&
		new Set((value.parts as AutoHirePart[]).map((part) => part.id)).size === value.parts.length
	);
}
export function isAutoHireDecision(value: unknown): value is AutoHireDecision {
	return (
		isRecord(value) &&
		isId(value.id) &&
		typeof value.approved === 'boolean' &&
		(value.parts === null ||
			(Array.isArray(value.parts) &&
				value.parts.length >= 1 &&
				value.parts.length <= autoHirePartLimit &&
				value.parts.every(isAutoHirePart)))
	);
}
export function isAutoHired(value: unknown): value is AutoHired {
	return (
		isRecord(value) &&
		isId(value.partId) &&
		isId(value.taskId) &&
		isCrewName(value.name) &&
		isCrewName(value.role)
	);
}
/** Two zones overlap when a static prefix of one lies inside the other's (globs count as their directory). The returned path is the narrower one. */
export function zonesOverlap(a: readonly string[], b: readonly string[]): string | null {
	for (const left of a)
		for (const right of b) {
			const l = zonePrefix(left),
				r = zonePrefix(right);
			if (l === '' || r === '' || l === r) return l.length >= r.length ? left : right;
			if (l.startsWith(`${r}/`)) return left;
			if (r.startsWith(`${l}/`)) return right;
		}
	return null;
}
/**
 * spec/crew#auto-gates: the host's verdict on each part, in order. A part too small for a worker, or whose zone overlaps an earlier
 * hireable part or a running worker, is refused and stays with the agent; the rest can be hired. English messages for the agent (rule 12);
 * the card words them from the codes.
 */
export function autoHireGates(
	parts: readonly AutoHirePart[],
	running: readonly { name: string; zone: readonly string[] }[],
	minLines = autoPartMinLines
): AutoHirePart[] {
	const passed: { index: number; zone: readonly string[] }[] = [];
	return parts.map((part, index) => {
		const { refused: _old, ...rest } = part;
		if (part.estimate.lines < minLines) {
			const files = Math.max(part.estimate.files, 1);
			return {
				...rest,
				refused: {
					code: 'small',
					lines: part.estimate.lines,
					files,
					message: `Too small for a worker: about ${part.estimate.lines} lines in ${files === 1 ? 'one file' : `${files} files`}.`,
				},
			};
		}
		for (const earlier of passed) {
			const path = zonesOverlap(part.zone, earlier.zone);
			if (path)
				return {
					...rest,
					refused: {
						code: 'overlap',
						path,
						part: earlier.index + 1,
						message: `Not independent: part ${earlier.index + 1} writes ${path} too.`,
					},
				};
		}
		for (const worker of running) {
			const path = zonesOverlap(part.zone, worker.zone);
			if (path)
				return {
					...rest,
					refused: {
						code: 'overlap',
						path,
						part: null,
						worker: worker.name,
						message: `Not independent: ${worker.name} already writes ${path}.`,
					},
				};
		}
		passed.push({ index, zone: part.zone });
		return rest;
	});
}
/** The parts a decision hires: the edited ones when the person edited, without the refused. */
export function autoHireable(parts: readonly AutoHirePart[]): AutoHirePart[] {
	return parts.filter((part) => !part.refused);
}
/** spec/chat-turns-plans-and-questions#hire-card: the header's sum over the parts that can be hired. */
export function autoHireTotal(parts: readonly AutoHirePart[]): AutoBudget {
	return autoHireable(parts).reduce(
		(sum, part) => ({
			minutes: sum.minutes + part.budget.minutes,
			tokens: sum.tokens + part.budget.tokens,
		}),
		{ minutes: 0, tokens: 0 }
	);
}
/**
 * The person's edit may change titles, roles, budgets and prompts; zones, scopes and estimates are what the gates read, so they stay as
 * proposed, and the gates run again on the result.
 */
export function editedHireParts(
	proposed: readonly AutoHirePart[],
	edited: readonly AutoHirePart[] | null
): AutoHirePart[] | null {
	if (!edited) return null;
	if (edited.length !== proposed.length) return null;
	const result: AutoHirePart[] = [];
	for (const [index, part] of proposed.entries()) {
		const edit = edited[index]!;
		if (edit.id !== part.id) return null;
		result.push({
			...part,
			title: crewName(edit.title).slice(0, crewNameLimit) || part.title,
			role: edit.role,
			roleName: edit.roleName,
			prompt: edit.prompt.trim() ? edit.prompt : part.prompt,
			budget: edit.budget,
		});
	}
	return result;
}

// ── another model ────────────────────────────────────────────────────

/** spec/crew#auto-model: the agent asks for a model outside its roles; `role` is the role the part goes to when the person keeps it. */
export type AutoModelRequest = {
	id: string;
	reason: string;
	role: string;
	part?: string;
	provider?: AgentProvider;
	model?: string;
	effort?: string;
};
/** What the person (or, with `Any catalog model`, the agent) chose: catalog option ids and values with their names (rule 7). */
export type AutoModelChoice = { id: string; value: string; name: string };
export type AutoModelAnswer = {
	provider: AgentProvider;
	model: AutoModelChoice | null;
	effort: AutoModelChoice | null;
	/** `Save as role`: the new role's name; it goes to the library as well. */ saveAs?: string;
};
export const autoModelReasonLimit = 2000;
const provider = (value: unknown): value is AgentProvider =>
	value === 'claude' || value === 'codex';
export function isAutoModelRequest(value: unknown): value is AutoModelRequest {
	return (
		isRecord(value) &&
		isId(value.id) &&
		text(value.reason, autoModelReasonLimit) &&
		isCrewName(value.role) &&
		(value.part === undefined || text(value.part, crewNameLimit)) &&
		(value.provider === undefined || provider(value.provider)) &&
		(value.model === undefined || text(value.model, 200)) &&
		(value.effort === undefined || text(value.effort, 200))
	);
}
const isModelChoice = (value: unknown): value is AutoModelChoice =>
	isRecord(value) &&
	Object.keys(value).length === 3 &&
	text(value.id, 200) &&
	value.id.length > 0 &&
	text(value.value, 200) &&
	text(value.name, 200);
export function isAutoModelAnswer(value: unknown): value is AutoModelAnswer {
	return (
		isRecord(value) &&
		provider(value.provider) &&
		(value.model === null || isModelChoice(value.model)) &&
		(value.effort === null || isModelChoice(value.effort)) &&
		(value.saveAs === undefined || (isCrewName(value.saveAs) && value.saveAs.trim().length > 0))
	);
}
/** The role a model answer adds to the task: the base role's rights and instructions on the chosen provider and options; its When to use is the agent's reason. */
export function modelRole(
	base: CrewSpecAgent,
	answer: AutoModelAnswer,
	id: string,
	reason: string
): CrewSpecAgent {
	const chosen = [answer.model, answer.effort].filter((item): item is AutoModelChoice => !!item);
	const named = chosen.map((item) => item.name).join(' · ');
	const configOptions = Object.fromEntries(chosen.map((item) => [item.id, item.value]));
	const choiceNames = Object.fromEntries(chosen.map((item) => [item.id, item.name]));
	const { summary: _summary, ...rest } = base;
	return {
		...rest,
		id,
		whenToUse: whenToUseLine(reason),
		name: crewName(
			answer.saveAs?.trim() || `${base.name} · ${named || autoRootName(answer.provider)}`
		).slice(0, crewNameLimit),
		template: id,
		provider: answer.provider,
		requestedChoices: Object.keys(configOptions).length ? { configOptions } : {},
		choiceNames,
		agents: [],
		checkedBy: [],
		zone: [],
	};
}
/** A role by its name, case-insensitively; an id matches too. */
export function autoRole(auto: AutoTask, wanted: string): CrewSpecAgent | undefined {
	const needle = wanted.trim().toLocaleLowerCase('en');
	return (
		auto.roles.find((role) => role.id === wanted) ??
		auto.roles.find((role) => role.name.trim().toLocaleLowerCase('en') === needle)
	);
}
