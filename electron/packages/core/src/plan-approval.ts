import type { PermissionRequest } from './agent';
import { selectOption } from './agent-options';
import type { EventRecord, SessionEvent } from './session';

/** spec/chat-turns-plans-and-questions#plan-approval: a permission whose tool is ACP `switch_mode` is the plan for approval. */
export function isPlanApproval(request: PermissionRequest): boolean {
	return request.tool.category === 'switch_mode';
}

/** The plan text: the tool's text content, else the last plan document of the session before the request (Codex). Never `rawInput` (rule 7). */
export function planApprovalText(
	request: PermissionRequest,
	records: readonly EventRecord[],
	before: number
): string | null {
	const content = (request.tool.content ?? [])
		.flatMap((item) => (item.kind === 'text' && item.text.trim() ? [item.text] : []))
		.join('\n\n');
	return content || lastPlanDocument(records, before);
}
/** The last plan document of the session before `before` that the agent has not removed (Codex `plan_update`). */
function lastPlanDocument(records: readonly EventRecord[], before: number): string | null {
	const removed = new Set<string>();
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i]!;
		if (record.seq >= before) continue;
		const e = record.event;
		if (e.kind === 'plan.removed') removed.add(e.planId);
		if (e.kind === 'plan.document' && !removed.has(e.planId) && e.text.trim()) return e.text;
	}
	return null;
}

/** spec/chat-turns-plans-and-questions#plan-row: the plan document behind the agent's checklist — the last plan for approval before `before`, else the last plan document (Codex). */
export function checklistPlan(records: readonly EventRecord[], before: number): string | null {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i]!;
		if (record.seq >= before) continue;
		const e = record.event;
		if (e.kind === 'permission.requested' && isPlanApproval(e.request))
			return planApprovalText(e.request, records, record.seq);
	}
	return lastPlanDocument(records, before);
}

type Option = PermissionRequest['options'][number];
/** `Погодити`: the agent's first `allow_once`, else its first `allow_*`. */
export function planApproveOption(request: PermissionRequest): Option | null {
	return (
		request.options.find((option) => option.kind === 'allow_once') ??
		request.options.find((option) => option.kind.startsWith('allow')) ??
		null
	);
}

/** spec/chat-turns-plans-and-questions#plan-approval: the session mode a record sets — the legacy mode or the value of the `mode` option; `null` when it says nothing. */
export function recordModeId(event: SessionEvent): string | null {
	if (event.kind === 'mode.changed') return event.modeId;
	if (event.kind === 'session.started')
		return event.modeId ?? selectOption(event.options, 'mode')?.value ?? null;
	if (event.kind === 'options.changed') return selectOption(event.options, 'mode')?.value ?? null;
	return null;
}
/** The session's modes before `before`, without repeats in a row: the last one is the mode at that point. */
export function sessionModes(
	records: readonly EventRecord[],
	before = Number.MAX_SAFE_INTEGER
): string[] {
	const modes: string[] = [];
	for (const record of records) {
		if (record.seq >= before) break;
		const mode = recordModeId(record.event);
		if (mode !== null && mode !== modes.at(-1)) modes.push(mode);
	}
	return modes;
}
/** spec/chat-turns-plans-and-questions#plan-approval: the mode the session had before it went into the mode of the plan request; `null` without a change. */
export function planPriorMode(records: readonly EventRecord[], before: number): string | null {
	const modes = sessionModes(records, before);
	return modes.length > 1 ? modes.at(-2)! : null;
}
/** The name the agent gives a mode: `availableModes`, else the choice of its `mode` option. */
export function sessionModeName(records: readonly EventRecord[], modeId: string): string | null {
	for (let i = records.length - 1; i >= 0; i--) {
		const e = records[i]!.event;
		if (e.kind === 'session.started') {
			const mode = e.modes.find((item) => item.id === modeId);
			if (mode) return mode.name;
		}
		if (e.kind === 'session.started' || e.kind === 'options.changed') {
			const choice = selectOption(e.options, 'mode')?.choices.find((item) => item.value === modeId);
			if (choice) return choice.name;
		}
	}
	return null;
}
const words = (value: string) =>
	new Set(
		value
			.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean)
	);
export type PlanApproveChoice = { option: Option; returnMode: string | null };
/**
 * spec/chat-turns-plans-and-questions#plan-approval: `Погодити` brings back the mode the session had before the plan. The agent's `allow_*` option whose id or
 * name carries every word of that mode's id or name, the smallest of them (`exit-plan-auto`, not `exit-plan-clear-auto`);
 * no such single option — `allow_once` and `returnMode`, which the host sets once the agent leaves the plan. No table of
 * agent options (rule 7).
 */
export function planApproveChoice(
	request: PermissionRequest,
	records: readonly EventRecord[],
	before: number
): PlanApproveChoice | null {
	const fallback = planApproveOption(request);
	if (!fallback) return null;
	const prior = planPriorMode(records, before);
	if (prior === null) return { option: fallback, returnMode: null };
	const name = sessionModeName(records, prior),
		keys = [words(prior), ...(name ? [words(name)] : [])].filter((key) => key.size > 0);
	const candidates = planAllowOptions(request)
		.map((option) => ({ option, words: new Set([...words(option.id), ...words(option.name)]) }))
		.filter((candidate) => keys.some((key) => [...key].every((word) => candidate.words.has(word))));
	const smallest = candidates.filter((candidate) =>
		candidates.every(
			(other) => other === candidate || [...candidate.words].every((word) => other.words.has(word))
		)
	);
	return smallest.length === 1
		? { option: smallest[0]!.option, returnMode: null }
		: { option: fallback, returnMode: prior };
}
/** spec/chat-turns-plans-and-questions#plan-approval: the mode after an approved plan — within the turn of the answer, `returnMode` once the session reached it,
 *  else the first mode after the plan's own; `null` when the session did not leave it. */
export function planApprovedMode(
	records: readonly EventRecord[],
	resolvedIndex: number
): string | null {
	const resolved = records[resolvedIndex];
	if (resolved?.event.kind !== 'permission.resolved') return null;
	const plan = sessionModes(records, resolved.seq).at(-1) ?? null,
		after: string[] = [];
	for (const record of records.slice(resolvedIndex + 1)) {
		const e = record.event;
		if (['turn.completed', 'session.failed', 'host.stopped', 'turn.started'].includes(e.kind))
			break;
		const mode = recordModeId(e);
		if (mode !== null && mode !== plan) after.push(mode);
	}
	const wanted = resolved.event.returnMode;
	return wanted && after.includes(wanted) ? wanted : (after[0] ?? null);
}
/** The chevron menu: every `allow_*` option of the agent, names as they are. */
export function planAllowOptions(request: PermissionRequest): Option[] {
	return request.options.filter((option) => option.kind.startsWith('allow'));
}
/** `Планувати далі…` and `Надіслати правки` answer with the agent's first `reject_*`. */
export function planRejectOption(request: PermissionRequest): Option | null {
	return (
		request.options.find((option) => option.kind === 'reject_once') ??
		request.options.find((option) => option.kind.startsWith('reject')) ??
		null
	);
}

const feedbackLead =
	'I did not approve the plan. Change it as follows, then present the revised plan for approval again:\n\n';
/** English by rule 12: what the person wants changed. */
export function planFeedbackPrompt(text: string): string {
	return `${feedbackLead}${text.trim()}`;
}
/** The person's own words back from a feedback prompt, for the folded row (spec/chat-turns-plans-and-questions#plan-approval); `null` for any other prompt. */
export function planPromptFeedback(prompt: string): string | null {
	return prompt.startsWith(feedbackLead) ? prompt.slice(feedbackLead.length) : null;
}
const chatLead =
	'I wrote this while your plan was waiting for approval. If it is a question, answer it. Change the plan only where my message asks for a change. Then present the plan for approval again, unchanged if nothing needs to change:\n\n';
/** English by rule 12: what the person wrote in the chat while the plan waited (spec/chat-turns-plans-and-questions#plan-chat). */
export function planChatPrompt(text: string): string {
	return `${chatLead}${text}`;
}
/** The person's own words back from a chat-while-the-plan-waits prompt, for their row; `null` for any other prompt. */
export function planChatWords(prompt: string): string | null {
	return prompt.startsWith(chatLead) ? prompt.slice(chatLead.length) : null;
}
/** English by rule 12: the person edited the plan copy; the agent sees that version before anything is approved. */
export function planEditsPrompt(text: string): string {
	return `I edited your plan. Treat this version as the plan, adjust it only where something is wrong, and present it for approval again:\n\n${text.trim()}`;
}

/** The first markdown heading, else the first non-empty line, for the collapsed row and the file name. */
export function planTitle(text: string): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const heading = lines.find((line) => /^#{1,6}\s/.test(line));
	return (heading ?? lines[0] ?? '')
		.replace(/^#{1,6}\s+/, '')
		.replace(/[*_`]/g, '')
		.slice(0, 200);
}
/** `plans/<slug>.md`: ASCII, at most 60 characters, `plan` when the title has nothing usable. */
export function planSlug(text: string): string {
	const slug = planTitle(text)
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return slug || 'plan';
}
export function planLineCount(text: string): number {
	return text.replace(/\s+$/, '').split(/\r?\n/).length;
}
/** Line endings and trailing blanks do not count as an edit. */
export function samePlanText(a: string, b: string): boolean {
	const norm = (value: string) => value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
	return norm(a) === norm(b);
}
