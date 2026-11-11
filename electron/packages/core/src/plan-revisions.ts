import { isPlanApproval, planApprovalText, planEditsPrompt } from './plan-approval';
import type { Locale } from './messages';
import type { EventRecord } from './session';

/** spec/chat-turns-plans-and-questions#plan-revisions: what a revision of a plan for approval is compared with. */
export type PlanRevisionBase = {
	/** This revision's place among the session's plans for approval, from 1. */
	revision: number;
	/** The text before it: the revision before, or the person's edits the agent received; `null` for the first revision. */
	base: { text: string; revision: number; edited: boolean } | null;
};

const editsLead = planEditsPrompt('.').slice(0, -1);
/** The edited plan back from a `Send edits` prompt; `null` for any other prompt. */
export function planPromptEdits(prompt: string): string | null {
	return prompt.startsWith(editsLead) ? prompt.slice(editsLead.length) : null;
}

/** The first prompt the person sent after `from` (a turn they started, or one they queued), up to `to`. */
function personPrompt(records: readonly EventRecord[], from: number, to: number): string | null {
	for (const record of records) {
		if (record.seq <= from || record.seq >= to) continue;
		const e = record.event;
		if (e.kind === 'turn.started' && e.origin !== 'agent') return e.text;
		if (e.kind === 'prompt.queued') return e.prompt.command.text;
	}
	return null;
}

/** spec/chat-turns-plans-and-questions#plan-revisions: the revision number of the plan request at `seq` and its base. */
export function planRevisionBase(records: readonly EventRecord[], seq: number): PlanRevisionBase {
	let previous: { seq: number; id: string; text: string } | null = null,
		revision = 0;
	for (const record of records) {
		if (record.seq > seq) break;
		const e = record.event;
		if (e.kind !== 'permission.requested' || !isPlanApproval(e.request)) continue;
		const text = planApprovalText(e.request, records, record.seq);
		if (text === null) continue;
		revision++;
		if (record.seq === seq) break;
		previous = { seq: record.seq, id: e.request.id, text };
	}
	if (!previous) return { revision: Math.max(revision, 1), base: null };
	const answered =
			records.find(
				(record) =>
					record.seq > previous.seq &&
					record.event.kind === 'permission.resolved' &&
					record.event.id === previous.id
			)?.seq ?? previous.seq,
		prompt = personPrompt(records, answered, seq),
		edits = prompt ? planPromptEdits(prompt) : null;
	return {
		revision,
		base: edits
			? { text: edits, revision: revision - 1, edited: true }
			: { text: previous.text, revision: revision - 1, edited: false },
	};
}

const ukForms = (count: number, forms: Record<'one' | 'few' | 'many' | 'other', string>) =>
	forms[new Intl.PluralRules('uk').select(count) as 'one' | 'few' | 'many' | 'other'] ?? forms.many;
/** «3 sections» / «3 розділи» (rule 9: four Ukrainian forms). */
export function planSectionsLabel(locale: Locale, count: number): string {
	const n = new Intl.NumberFormat(locale).format(count);
	return locale === 'en'
		? `${n} ${count === 1 ? 'section' : 'sections'}`
		: `${n} ${ukForms(count, { one: 'розділ', few: 'розділи', many: 'розділів', other: 'розділу' })}`;
}
/** «4 unchanged lines» / «4 незмінені рядки» (rule 9). */
export function planUnchangedLabel(locale: Locale, count: number): string {
	const n = new Intl.NumberFormat(locale).format(count);
	return locale === 'en'
		? `${n} unchanged ${count === 1 ? 'line' : 'lines'}`
		: `${n} ${ukForms(count, {
				one: 'незмінений рядок',
				few: 'незмінені рядки',
				many: 'незмінених рядків',
				other: 'незміненого рядка',
			})}`;
}
