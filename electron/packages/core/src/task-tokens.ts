import type { AgentProvider } from './agent';
import type { EventRecord, SessionEvent } from './session';
import type { AgentTask } from './workspace';

/**
 * spec/agents-and-providers#task-tokens: the tokens a task used, per provider, and its budget (spec/agents-and-providers#task-budget).
 * Pure functions over journal events and task documents: the host that checks the budget, the views and a part budget share them.
 */
export type TokenParts = { input: number; cacheWrite: number; output: number; cacheRead: number };
/** What the counter counts: new input, cache writes and output. Cache reads re-read the same context on every model call and are left out. */
export const countedTokens = (parts: TokenParts) => parts.input + parts.cacheWrite + parts.output;

export type QuotaSpanKind = 'five-hour' | 'weekly';
export const quotaSpanKinds: readonly QuotaSpanKind[] = ['five-hour', 'weekly'];
/** spec/agents-and-providers#task-quota-span: one reading of the account's remaining share. */
export type QuotaMark = { remaining: number; resetsAt: number | null; at: string };
/** The task's first reading, its first one of the current window and its latest one. */
export type QuotaMarks = { first: QuotaMark; windowFirst: QuotaMark; last: QuotaMark };
export type TaskQuotaMarks = Partial<
	Record<AgentProvider, Partial<Record<QuotaSpanKind, QuotaMarks>>>
>;

/** spec/agents-and-providers#task-tokens: one task's own figure, kept by its host in `task.json` as `tokens`. */
export type TaskOwnTokens = TokenParts & {
	/** The running turn's estimate: the growth of its context; 0 between turns. */ estimate: number;
	running: boolean;
	quota?: TaskQuotaMarks;
};
/**
 * The reducer's state: the stored figure plus the last context size it saw and the session opening (spec/agents-and-providers#opening-share):
 * `opening` — the opening size the running turn counted (0 when none), `openingShare` — the part of an opening it counts, `learnedShare` — the
 * part the last finished turn with an opening turned out to pay.
 */
export type TokenTally = TaskOwnTokens & {
	used: number | null;
	opening: number;
	openingShare: number;
	learnedShare: number | null;
};

export const emptyTokenTally = (openingShare = 1): TokenTally => ({
	input: 0,
	cacheWrite: 0,
	output: 0,
	cacheRead: 0,
	estimate: 0,
	running: false,
	used: null,
	opening: 0,
	openingShare: isOpeningShare(openingShare) ? openingShare : 1,
	learnedShare: null,
});
/** spec/agents-and-providers#opening-share: a share of a session's opening context, 0 to 1. */
export const isOpeningShare = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
/** Two readings belong to one window when their reset times are within ten minutes (a provider may round them). */
const sameWindow = (a: QuotaMark, b: QuotaMark) =>
	a.resetsAt === null || b.resetsAt === null
		? a.resetsAt === b.resetsAt
		: Math.abs(a.resetsAt - b.resetsAt) < 600;
function markQuota(
	quota: TaskQuotaMarks | undefined,
	event: SessionEvent & { kind: 'quota.observed' },
	at: string
) {
	let next = quota;
	for (const window of event.windows) {
		if (window.kind !== 'five-hour' && window.kind !== 'weekly') continue;
		if (!Number.isFinite(window.remaining)) continue;
		const mark: QuotaMark = { remaining: window.remaining, resetsAt: window.resetsAt, at },
			provider = { ...(next?.[event.provider] ?? {}) },
			old = provider[window.kind];
		provider[window.kind] = old
			? {
					first: old.first,
					windowFirst: sameWindow(old.last, mark) ? old.windowFirst : mark,
					last: mark,
				}
			: { first: mark, windowFirst: mark, last: mark };
		next = { ...(next ?? {}), [event.provider]: provider };
	}
	return next;
}
/**
 * spec/agents-and-providers#task-tokens: one journal event folded into the task's own figure. A finished turn's `turn.usage` is exact; while a turn runs,
 * every rise of the context size (`usage.changed.used`) adds to the estimate, which the turn's `turn.usage` replaces. A session's first size inside a
 * turn (its opening: system prompt, tools, a loaded history) adds only `openingShare` of itself, since a provider's cache often already holds most of
 * it; that turn's `turn.usage` then tells the share it paid (spec/agents-and-providers#opening-share).
 */
export function reduceTokenTally(tally: TokenTally, event: SessionEvent, at = ''): TokenTally {
	switch (event.kind) {
		case 'session.started':
			return { ...tally, used: null };
		case 'turn.started':
			return { ...tally, running: true, estimate: 0, opening: 0 };
		case 'usage.changed': {
			if (!Number.isFinite(event.used) || event.used < 0) return tally;
			if (tally.used === null) {
				if (!tally.running) return { ...tally, used: event.used };
				return {
					...tally,
					used: event.used,
					opening: event.used,
					estimate: tally.estimate + Math.round(event.used * tally.openingShare),
				};
			}
			const rise = Math.max(0, event.used - tally.used);
			return {
				...tally,
				used: event.used,
				estimate: tally.running ? tally.estimate + rise : tally.estimate,
			};
		}
		case 'turn.usage': {
			let { openingShare, learnedShare } = tally;
			if (tally.opening > 0) {
				// What the turn paid past its growth after the opening is what the opening cost.
				const growth = tally.estimate - Math.round(tally.opening * tally.openingShare),
					paid = event.input + event.cacheWrite + event.output - growth;
				learnedShare = Math.round(Math.min(1, Math.max(0, paid / tally.opening)) * 1000) / 1000;
				openingShare = learnedShare;
			}
			return {
				...tally,
				input: tally.input + event.input,
				cacheWrite: tally.cacheWrite + event.cacheWrite,
				output: tally.output + event.output,
				cacheRead: tally.cacheRead + event.cacheRead,
				estimate: 0,
				running: false,
				opening: 0,
				openingShare,
				learnedShare,
			};
		}
		case 'turn.completed':
		case 'session.failed':
		case 'host.stopped':
			return tally.running || tally.estimate || tally.opening
				? { ...tally, running: false, estimate: 0, opening: 0 }
				: tally;
		case 'quota.observed': {
			const quota = markQuota(tally.quota, event, at);
			return quota ? { ...tally, quota } : tally;
		}
		default:
			return tally;
	}
}
export function tokenTally(records: readonly EventRecord[], openingShare = 1): TokenTally {
	return records.reduce(
		(tally, record) => reduceTokenTally(tally, record.event, record.at),
		emptyTokenTally(openingShare)
	);
}
/** The figure as `task.json` keeps it. */
export function ownTokens(tally: TokenTally): TaskOwnTokens {
	const {
		used: _used,
		opening: _opening,
		openingShare: _share,
		learnedShare: _learned,
		...own
	} = tally;
	return own;
}
/** Nothing reported yet: no counter (spec/agents-and-providers#usage-principles). */
export const hasTokens = (own: TaskOwnTokens) =>
	countedTokens(own) + own.estimate + own.cacheRead > 0;

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isRecordLike = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
function isQuotaMark(value: unknown): value is QuotaMark {
	return (
		isRecordLike(value) &&
		typeof value.remaining === 'number' &&
		value.remaining >= 0 &&
		value.remaining <= 1 &&
		(value.resetsAt === null ||
			(typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt))) &&
		typeof value.at === 'string' &&
		value.at.length <= 40
	);
}
function isQuotaMarks(value: unknown): value is TaskQuotaMarks {
	return (
		isRecordLike(value) &&
		Object.entries(value).every(
			([provider, kinds]) =>
				(provider === 'claude' || provider === 'codex') &&
				isRecordLike(kinds) &&
				Object.entries(kinds).every(
					([kind, marks]) =>
						quotaSpanKinds.includes(kind as QuotaSpanKind) &&
						isRecordLike(marks) &&
						isQuotaMark(marks.first) &&
						isQuotaMark(marks.windowFirst) &&
						isQuotaMark(marks.last)
				)
		)
	);
}
export function isTaskOwnTokens(value: unknown): value is TaskOwnTokens {
	return (
		isRecordLike(value) &&
		isCount(value.input) &&
		isCount(value.cacheWrite) &&
		isCount(value.output) &&
		isCount(value.cacheRead) &&
		isCount(value.estimate) &&
		typeof value.running === 'boolean' &&
		(value.quota === undefined || isQuotaMarks(value.quota))
	);
}

// ── Summing over a task's members ───────────────────────────────────────

/** spec/agents-and-providers#task-tokens: the task whose budget covers this one — a crew's root (`crewTaskId`), else the task itself. */
export function budgetRootId(task: Pick<AgentTask, 'id' | 'crewTaskId'>): string {
	return task.crewTaskId ?? task.id;
}
/** The task and every task that carries its id as `crewTaskId`: foreman, leads, workers, reviewers, the reviewers of a solo task. */
export function tokenMembers<T extends Pick<AgentTask, 'id' | 'projectId' | 'crewTaskId'>>(
	root: T,
	tasks: readonly T[]
): T[] {
	return [
		root,
		...tasks.filter(
			(task) =>
				task.id !== root.id && task.projectId === root.projectId && task.crewTaskId === root.id
		),
	];
}
export type TokenMember = {
	taskId: string;
	provider: AgentProvider;
	/** Counted tokens with the running estimate. */ tokens: number;
	estimated: boolean;
	parts: TokenParts;
};
export function memberTokens(
	task: Pick<AgentTask, 'id' | 'provider' | 'tokens'>
): TokenMember | null {
	const own = task.tokens;
	if (!own || !task.provider || !hasTokens(own)) return null;
	return {
		taskId: task.id,
		provider: task.provider,
		tokens: countedTokens(own) + own.estimate,
		estimated: own.estimate > 0,
		parts: {
			input: own.input,
			cacheWrite: own.cacheWrite,
			output: own.output,
			cacheRead: own.cacheRead,
		},
	};
}
export type ProviderTokens = {
	provider: AgentProvider;
	tokens: number;
	estimated: boolean;
	parts: TokenParts;
	members: TokenMember[];
};
export type TaskTokenSum = { tokens: number; estimated: boolean; providers: ProviderTokens[] };
export const tokenProviders: readonly AgentProvider[] = ['claude', 'codex'];
export function sumTokens(members: readonly (TokenMember | null)[]): TaskTokenSum {
	const providers: ProviderTokens[] = [];
	for (const provider of tokenProviders) {
		const own = members.filter((member): member is TokenMember => member?.provider === provider);
		if (!own.length) continue;
		providers.push({
			provider,
			tokens: own.reduce((sum, member) => sum + member.tokens, 0),
			estimated: own.some((member) => member.estimated),
			parts: own.reduce(
				(sum, member) => ({
					input: sum.input + member.parts.input,
					cacheWrite: sum.cacheWrite + member.parts.cacheWrite,
					output: sum.output + member.parts.output,
					cacheRead: sum.cacheRead + member.parts.cacheRead,
				}),
				{ input: 0, cacheWrite: 0, output: 0, cacheRead: 0 }
			),
			members: own,
		});
	}
	return {
		tokens: providers.reduce((sum, item) => sum + item.tokens, 0),
		estimated: providers.some((item) => item.estimated),
		providers,
	};
}
/** spec/agents-and-providers#task-tokens: a task's count over itself and its members, from their `task.json` figures. */
export function taskTokenSum(root: AgentTask, tasks: readonly AgentTask[]): TaskTokenSum {
	return sumTokens(tokenMembers(root, tasks).map(memberTokens));
}
export const providerTokens = (sum: TaskTokenSum, provider: AgentProvider) =>
	sum.providers.find((item) => item.provider === provider)?.tokens ?? 0;

// ── Budget ──────────────────────────────────────────────────────────────

/** spec/agents-and-providers#task-budget: tokens per provider; a provider without a key has no limit. */
export type TokenBudget = Partial<Record<AgentProvider, number>>;
/** Settings ▸ Agents `Task budget`: null — `No limit`. */
export type TaskBudgetSetting = Record<AgentProvider, number | null>;
export const tokenBudgetChoices = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000] as const;
/** `Raise to …` values (spec/agents-and-providers#budget-reached). */
export const tokenBudgetRaises = [
	1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000,
] as const;
export const budgetNearShare = 0.8;
export function isTokenBudgetValue(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1000 && value <= 1e12;
}
export function isTokenBudget(value: unknown): value is TokenBudget {
	return (
		isRecordLike(value) &&
		Object.entries(value).every(
			([provider, budget]) =>
				(provider === 'claude' || provider === 'codex') && isTokenBudgetValue(budget)
		)
	);
}
export const defaultTaskBudgetSetting = (): TaskBudgetSetting => ({ claude: null, codex: null });
export function isTaskBudgetSetting(value: unknown): value is TaskBudgetSetting {
	return (
		isRecordLike(value) &&
		Object.keys(value).every((key) => key === 'claude' || key === 'codex') &&
		tokenProviders.every(
			(provider) => value[provider] === null || isTokenBudgetValue(value[provider])
		)
	);
}
/** The budget a new task takes from the setting; undefined — no limit at all. */
export function budgetFromSetting(
	setting: TaskBudgetSetting | null | undefined
): TokenBudget | undefined {
	if (!setting) return undefined;
	const budget: TokenBudget = {};
	for (const provider of tokenProviders) {
		const value = setting[provider];
		if (value !== null && isTokenBudgetValue(value)) budget[provider] = value;
	}
	return Object.keys(budget).length ? budget : undefined;
}
export type BudgetTone = 'none' | 'normal' | 'near' | 'reached';
export function budgetTone(tokens: number, budget: number | undefined): BudgetTone {
	if (budget === undefined) return 'none';
	if (tokens >= budget) return 'reached';
	return tokens >= budget * budgetNearShare ? 'near' : 'normal';
}
export type BudgetLead = {
	provider: AgentProvider;
	tokens: number;
	budget: number;
	estimated: boolean;
	tone: BudgetTone;
};
/** The provider nearest its budget (the highest share); null without any budget. */
export function budgetLead(sum: TaskTokenSum, budget: TokenBudget | undefined): BudgetLead | null {
	let lead: BudgetLead | null = null;
	for (const provider of tokenProviders) {
		const limit = budget?.[provider];
		if (limit === undefined) continue;
		const item = sum.providers.find((entry) => entry.provider === provider),
			tokens = item?.tokens ?? 0;
		if (!lead || tokens / limit > lead.tokens / lead.budget)
			lead = {
				provider,
				tokens,
				budget: limit,
				estimated: item?.estimated ?? false,
				tone: budgetTone(tokens, limit),
			};
	}
	return lead;
}
/** The provider whose count reached its budget, the highest share first; null while every one is under. */
export function reachedBudget(
	sum: TaskTokenSum,
	budget: TokenBudget | undefined
): BudgetLead | null {
	const lead = budgetLead(sum, budget);
	return lead?.tone === 'reached' ? lead : null;
}
/** `Raise to …`: three values above both the budget and the count; the first is the split button's own. */
export function raiseChoices(budget: number, tokens: number): number[] {
	const floor = Math.max(budget, tokens),
		values: number[] = tokenBudgetRaises.filter((value) => value > floor);
	let last = values.at(-1) ?? floor;
	while (values.length < 3 && last < 1e12) {
		last = Math.min(1e12, Math.max(last * 2, floor * 2));
		values.push(last);
	}
	return values.slice(0, 3);
}
/** The popup's values: the choices plus a stored value they do not list. */
export function budgetPopupValues(current: number | undefined): number[] {
	const values: number[] = [...tokenBudgetChoices];
	if (current !== undefined && !values.includes(current)) values.push(current);
	return values.sort((a, b) => a - b);
}

// ── Reaching it: the journal's question and the hold ────────────────────

export type BudgetDecision = 'raise' | 'unlimited' | 'finish' | 'stop';
export const budgetDecisions: readonly BudgetDecision[] = ['raise', 'unlimited', 'finish', 'stop'];
export type BudgetQuestion = {
	id: string;
	provider: AgentProvider;
	tokens: number;
	budget: number;
	estimated: boolean;
	seq: number;
	at: string;
};
export type BudgetJournal = {
	pending: BudgetQuestion | null;
	/** `finish` or `stop`: the task stays paused while this provider's budget is still `budget`. */
	stopped: {
		id: string;
		provider: AgentProvider;
		tokens: number;
		budget: number;
		decision: 'finish' | 'stop';
	} | null;
};
export const emptyBudgetJournal = (): BudgetJournal => ({ pending: null, stopped: null });
export function reduceBudgetJournal(state: BudgetJournal, record: EventRecord): BudgetJournal {
	const event = record.event;
	if (event.kind === 'budget.reached')
		return {
			pending: {
				id: event.id,
				provider: event.provider,
				tokens: event.tokens,
				budget: event.budget,
				estimated: event.estimated,
				seq: record.seq,
				at: record.at,
			},
			stopped: null,
		};
	if (event.kind === 'budget.decided' && state.pending?.id === event.id) {
		const asked = state.pending;
		return {
			pending: null,
			stopped:
				event.decision === 'finish' || event.decision === 'stop'
					? {
							id: asked.id,
							provider: asked.provider,
							tokens: asked.tokens,
							budget: asked.budget,
							decision: event.decision,
						}
					: null,
		};
	}
	return state;
}
export function budgetJournal(records: readonly EventRecord[]): BudgetJournal {
	return records.reduce(reduceBudgetJournal, emptyBudgetJournal());
}
/** spec/agents-and-providers#budget-reached: the root task's hold, kept in its `task.json` as `tokenHold` so every member reads it. */
export type TokenHold = {
	id: string;
	provider: AgentProvider;
	tokens: number;
	budget: number;
	state: 'asked' | 'finish' | 'stop';
};
export function tokenHold(
	journal: BudgetJournal,
	budget: TokenBudget | undefined
): TokenHold | null {
	if (journal.pending) {
		const { id, provider, tokens, budget: limit } = journal.pending;
		return { id, provider, tokens, budget: limit, state: 'asked' };
	}
	const stopped = journal.stopped;
	if (stopped && budget?.[stopped.provider] === stopped.budget)
		return {
			id: stopped.id,
			provider: stopped.provider,
			tokens: stopped.tokens,
			budget: stopped.budget,
			state: stopped.decision,
		};
	return null;
}
export function isTokenHold(value: unknown): value is TokenHold {
	return (
		isRecordLike(value) &&
		typeof value.id === 'string' &&
		value.id.length > 0 &&
		value.id.length <= 64 &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		isCount(value.tokens) &&
		isTokenBudgetValue(value.budget) &&
		(value.state === 'asked' || value.state === 'finish' || value.state === 'stop')
	);
}
/** spec/agents-and-providers#budget-reached: the count reached a budget and nothing holds the task yet — ask. */
export function budgetToAsk(
	sum: TaskTokenSum,
	budget: TokenBudget | undefined,
	journal: BudgetJournal
): BudgetLead | null {
	if (tokenHold(journal, budget)) return null;
	return reachedBudget(sum, budget);
}
/** The budget after an answer; the raise value must lie above the question's budget. */
export function decidedBudget(
	budget: TokenBudget | undefined,
	question: Pick<BudgetQuestion, 'provider' | 'budget'>,
	decision: BudgetDecision,
	value?: number
): TokenBudget | undefined {
	if (decision === 'finish' || decision === 'stop') return budget;
	const next: TokenBudget = { ...(budget ?? {}) };
	if (decision === 'unlimited') delete next[question.provider];
	else {
		if (!isTokenBudgetValue(value) || value <= question.budget) throw new Error('Invalid budget');
		next[question.provider] = value;
	}
	return Object.keys(next).length ? next : undefined;
}
/**
 * spec/agents-and-providers#budget-reached: a budget changed in `Task usage` while the question waits answers it when the new budget lies above the count
 * (`raise`) or is gone (`unlimited`); otherwise the question stays.
 */
export function popoverAnswer(
	question: Pick<BudgetQuestion, 'provider' | 'tokens'>,
	next: TokenBudget | undefined,
	tokens: number
): { decision: 'raise' | 'unlimited'; budget?: number } | null {
	const value = next?.[question.provider];
	if (value === undefined) return { decision: 'unlimited' };
	return value > Math.max(tokens, question.tokens) ? { decision: 'raise', budget: value } : null;
}

// ── The account's quota while the task ran ──────────────────────────────

export type QuotaSpan = {
	provider: AgentProvider;
	kind: QuotaSpanKind;
	before: number;
	now: number;
	/** The window reset after the task's first reading: `before` is the current window's first one. */ reset: boolean;
};
/** spec/agents-and-providers#task-quota-span: the account's share at the task's first reading and its latest, over all members. */
export function quotaSpans(members: readonly (TaskOwnTokens | undefined)[]): QuotaSpan[] {
	const spans: QuotaSpan[] = [];
	for (const provider of tokenProviders)
		for (const kind of quotaSpanKinds) {
			const marks = members.flatMap((own) => {
				const value = own?.quota?.[provider]?.[kind];
				return value ? [value] : [];
			});
			if (!marks.length) continue;
			const last = marks.reduce(
					(latest, item) => (item.last.at > latest.at ? item.last : latest),
					marks[0]!.last
				),
				starts = marks.flatMap((item) => [item.first, item.windowFirst]),
				first = starts.reduce((earliest, item) => (item.at < earliest.at ? item : earliest)),
				current = starts
					.filter((item) => sameWindow(item, last))
					.reduce<QuotaMark | null>(
						(earliest, item) => (!earliest || item.at < earliest.at ? item : earliest),
						null
					);
			const before = current ?? last;
			spans.push({
				provider,
				kind,
				before: before.remaining,
				now: last.remaining,
				reset: !sameWindow(first, last),
			});
		}
	return spans;
}
