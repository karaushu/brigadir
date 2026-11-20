import type { PermissionRequest } from './agent';
import { agentOptionKind } from './agent-options';
import { isPlanApproval, sessionModes } from './plan-approval';
import type { EventRecord, SessionEvent } from './session';
import type { TaskClass } from './task-class';
/**
 * spec/reviews#plan-mode: plan mode by the host — a class that owes a plan puts the session into the plan mode of its catalog between
 * turns. Pure: the host decides with these, the chat draws `plan.mode`. No table per agent (rule 7): the plan mode is the catalog's choice
 * named `plan`.
 */

export type PlanClass = Exclude<TaskClass, 'small'>;
/** The plan mode of the session's catalog and where the session stands. `option` is null for a legacy mode. */
export type PlanModeChoice = {
	option: string | null;
	name: string;
	value: string;
	valueName: string;
	current: string | null;
	currentName: string | null;
	/** Every choice of that option or mode, for names. */
	choices: { value: string; name: string }[];
};
const isPlanWord = (value: string) => value.trim().toLowerCase() === 'plan';
/** spec/reviews#plan-mode: a choice whose value or name is `plan` — of the `mode` option, else of another select option, else a legacy mode. */
export function planModeChoice(records: readonly EventRecord[]): PlanModeChoice | null {
	const latest = records.findLast(
		(record) => record.event.kind === 'session.started' || record.event.kind === 'options.changed'
	)?.event;
	const options = latest && 'options' in latest ? latest.options : [];
	const selects = options.flatMap((option) =>
		option.kind === 'select' && ['mode', 'other'].includes(agentOptionKind(option)) ? [option] : []
	);
	const modeOption = selects.some((option) => agentOptionKind(option) === 'mode');
	for (const option of [
		...selects.filter((option) => agentOptionKind(option) === 'mode'),
		...selects.filter((option) => agentOptionKind(option) !== 'mode'),
	]) {
		const choice = option.choices.find((item) => isPlanWord(item.value) || isPlanWord(item.name));
		if (choice)
			return {
				option: option.id,
				name: option.name,
				value: choice.value,
				valueName: choice.name,
				current: option.value,
				currentName:
					option.choices.find((item) => item.value === option.value)?.name ?? option.value,
				choices: option.choices.map((item) => ({ value: item.value, name: item.name })),
			};
	}
	// spec/composer#capsule-segments: legacy modes count only where no option is the mode.
	if (modeOption) return null;
	const started = records.findLast((record) => record.event.kind === 'session.started')?.event;
	if (started?.kind !== 'session.started') return null;
	const mode = started.modes.find((item) => isPlanWord(item.id) || isPlanWord(item.name));
	if (!mode) return null;
	const current = sessionModes(records).at(-1) ?? started.modeId ?? null;
	return {
		option: null,
		name: 'Mode',
		value: mode.id,
		valueName: mode.name,
		current,
		currentName:
			current === null
				? null
				: (started.modes.find((item) => item.id === current)?.name ?? current),
		choices: started.modes.map((item) => ({ value: item.id, name: item.name })),
	};
}
/** A plan for approval answered with an allowing option. */
function approvals(records: readonly EventRecord[]): Set<number> {
	const requests = new Map<string, PermissionRequest>(),
		seqs = new Set<number>();
	for (const record of records) {
		const e = record.event;
		if (e.kind === 'permission.requested') requests.set(e.request.id, e.request);
		if (e.kind === 'permission.resolved' && e.optionId !== null) {
			const request = requests.get(e.id);
			if (
				request &&
				isPlanApproval(request) &&
				request.options.find((option) => option.id === e.optionId)?.kind.startsWith('allow')
			)
				seqs.add(record.seq);
		}
	}
	return seqs;
}
/**
 * spec/reviews#plan-mode: the plan a class owes — from the agent's `set_task_class` to Medium or Large until a plan for approval is approved.
 * A plan approved since the class was last Small settles it; the host's raises (tripwire, hire) owe none.
 */
export function planOwed(
	records: readonly EventRecord[]
): { since: number; class: PlanClass } | null {
	const approved = approvals(records);
	let owed = null as { since: number; class: PlanClass } | null,
		settled = false;
	for (const record of records) {
		const e = record.event;
		if (approved.has(record.seq)) {
			owed = null;
			settled = true;
		} else if (e.kind === 'task.class') {
			if (e.class === 'small') {
				owed = null;
				settled = false;
			} else if (owed) owed = { since: owed.since, class: e.class };
			else if (e.by === 'agent' && !settled) owed = { since: record.seq, class: e.class };
		}
	}
	return owed;
}
type PlanModeEvent = Extract<SessionEvent, { kind: 'plan.mode' }>;
const planModeAfter = (records: readonly EventRecord[], since: number) =>
	records.flatMap((record) =>
		record.seq > since && record.event.kind === 'plan.mode' ? [record.event] : []
	);
/** The person moved the plan option off after the host's switch: the class's plan keeps no switch. */
const declined = (records: readonly EventRecord[], since: number) =>
	planModeAfter(records, since).some((event) => event.by === 'person' && !event.on);
/** spec/reviews#plan-mode: before a turn — the switch into the plan mode, when a plan is owed and the session is not in it. */
export function planModeDue(
	records: readonly EventRecord[]
): (PlanModeChoice & { class: PlanClass }) | null {
	const owed = planOwed(records),
		choice = planModeChoice(records);
	if (!owed || !choice || choice.current === choice.value || declined(records, owed.since))
		return null;
	return { ...choice, class: owed.class };
}
/** spec/reviews#plan-mode: the ask at a turn's end — a plan owed, a plan mode in the catalog, no plan presented and no ask since it became owed. */
export function planAskDue(
	records: readonly EventRecord[]
): { since: number; class: PlanClass } | null {
	const owed = planOwed(records);
	if (!owed || !planModeChoice(records) || declined(records, owed.since)) return null;
	for (const record of records) {
		if (record.seq <= owed.since) continue;
		const e = record.event;
		if (e.kind === 'permission.requested' && isPlanApproval(e.request)) return null;
		if (
			e.kind === 'prompt.queued' &&
			e.prompt.command.kind === 'prompt' &&
			e.prompt.command.crew?.kind === 'plan-ask'
		)
			return null;
		if (e.kind === 'turn.started' && e.crew?.kind === 'plan-ask') return null;
	}
	return owed;
}
/** spec/reviews#plan-mode: the ask (English, rule 12). */
export function planAskPrompt(value: PlanClass): string {
	return `This task is ${value === 'medium' ? 'Medium' : 'Large'}: present a plan for approval before you change anything more. Brigadir switched this session into plan mode: research without editing files, then present the plan. If files were already changed, the plan covers what is done and what is left.`;
}
/**
 * spec/reviews#plan-mode: back to writing — a turn with a plan approval ended with the session still in the plan choice the host set; the host
 * sets the value from before its switch.
 */
export function planModeReturn(
	records: readonly EventRecord[]
): (PlanModeChoice & { class: PlanClass; previous: string; previousName: string }) | null {
	const set = records.findLast(
		(record) => record.event.kind === 'plan.mode' && record.event.by === 'host' && record.event.on
	);
	if (set?.event.kind !== 'plan.mode' || set.event.previous === undefined) return null;
	const switched = set.event;
	if (planModeAfter(records, set.seq).length) return null;
	const turn = records.findLast((record) => record.event.kind === 'turn.started');
	const approved = approvals(records);
	if (![...approved].some((seq) => seq > set.seq && seq > (turn?.seq ?? 0))) return null;
	const choice = planModeChoice(records);
	if (
		!choice ||
		choice.option !== (switched.option ?? null) ||
		choice.current !== choice.value ||
		choice.value !== switched.value
	)
		return null;
	return {
		...choice,
		class: switched.class,
		previous: switched.previous!,
		previousName: switched.previousName ?? switched.previous!,
	};
}
/** spec/reviews#plan-mode: the person's own change of the plan option after the host's switch, while the class owes its plan. */
export function planModeDeclined(
	records: readonly EventRecord[],
	command:
		{ kind: 'setMode'; modeId: string } | { kind: 'setOption'; id: string; value: string | boolean }
): PlanModeEvent | null {
	const owed = planOwed(records),
		choice = planModeChoice(records);
	if (!owed || !choice || declined(records, owed.since)) return null;
	if (!planModeAfter(records, owed.since).some((event) => event.by === 'host' && event.on))
		return null;
	const value =
		command.kind === 'setOption'
			? command.id === choice.option && typeof command.value === 'string'
				? command.value
				: null
			: choice.option === null
				? command.modeId
				: null;
	if (value === null || value === choice.value) return null;
	return {
		kind: 'plan.mode',
		on: false,
		by: 'person',
		class: owed.class,
		...(choice.option !== null ? { option: choice.option } : {}),
		name: choice.name,
		value,
		valueName: choice.choices.find((item) => item.value === value)?.name ?? value,
	};
}
