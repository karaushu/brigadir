import { describe, expect, it } from 'vitest';
import journals from './fixtures/token-journals.json';
import type { EventRecord, SessionEvent } from './session';
import { isSessionCommand, pendingInputs, waitsForPerson } from './session';
import { isSessionEvent } from './event-validation';
import { isAgentTask, type AgentTask } from './workspace';
import {
	budgetFromSetting,
	budgetJournal,
	budgetLead,
	budgetPopupValues,
	budgetToAsk,
	budgetTone,
	countedTokens,
	decidedBudget,
	emptyTokenTally,
	isTaskBudgetSetting,
	ownTokens,
	popoverAnswer,
	quotaSpans,
	raiseChoices,
	reachedBudget,
	reduceTokenTally,
	taskTokenSum,
	tokenHold,
	tokenMembers,
	tokenTally,
} from './task-tokens';

/** Recorded journals (fixtures/token-journals.json): a solo Claude task, and a crew — a Claude foreman (its first 12 turns), a Claude developer and two
 *  Codex reviewers. Only turn boundaries, usage and quota records are kept; texts are dropped. */
type Journal = {
	id: string;
	provider: 'claude' | 'codex';
	crewTaskId?: string;
	records: EventRecord[];
};
const solo = journals.solo as Journal,
	crew = journals.crew as Journal[];
const task = (journal: Journal, records = journal.records): AgentTask => ({
	id: journal.id,
	projectId: 'p1',
	title: journal.id,
	status: 'working',
	provider: journal.provider,
	...(journal.crewTaskId ? { crewTaskId: journal.crewTaskId } : {}),
	tokens: ownTokens(tokenTally(records)),
});
let seq = 1000;
const record = (event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq: ++seq,
	at: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
	event,
});

describe('tokens of a task (spec/agents-and-providers#task-tokens)', () => {
	it('counts new input, cache writes and output of finished turns, never cache reads', () => {
		const tally = tokenTally(solo.records);
		expect(tally).toMatchObject({
			input: 260,
			cacheWrite: 149_732,
			output: 31_114,
			cacheRead: 14_597_542,
		});
		expect(countedTokens(tally)).toBe(181_106);
		expect(tally.running).toBe(false);
		expect(tally.estimate).toBe(0);
	});
	it('adds the growth of the context while a turn runs, and the turn end replaces it with the exact figure', () => {
		const records = solo.records,
			start = records.findIndex((item) => item.event.kind === 'turn.started'),
			end = records.findIndex((item, index) => index > start && item.event.kind === 'turn.usage'),
			before = tokenTally(records.slice(0, start)),
			middle = records.slice(0, end).findLastIndex((item) => item.event.kind === 'usage.changed'),
			running = tokenTally(records.slice(0, middle + 1));
		expect(running.running).toBe(true);
		expect(running.estimate).toBeGreaterThan(0);
		const used = records
			.slice(start, middle + 1)
			.flatMap((item) => (item.event.kind === 'usage.changed' ? [item.event.used] : []));
		// The first size of a new session counts whole; the rest is every rise.
		const growth = used.reduce(
			(sum, value, index) => sum + (index === 0 ? value : Math.max(0, value - used[index - 1]!)),
			0
		);
		expect(running.estimate).toBe(growth);
		const done = tokenTally(records.slice(0, end + 1)),
			turn = records[end]!.event as Extract<SessionEvent, { kind: 'turn.usage' }>;
		expect(done.estimate).toBe(0);
		expect(countedTokens(done)).toBe(
			countedTokens(before) + turn.input + turn.cacheWrite + turn.output
		);
	});
	it('a fall of the context (a compaction) adds nothing, and a stop drops the estimate', () => {
		let tally = reduceTokenTally(emptyTokenTally(), { kind: 'turn.started', text: '' });
		for (const used of [10_000, 30_000, 12_000, 20_000])
			tally = reduceTokenTally(tally, {
				kind: 'usage.changed',
				used,
				capacity: 200_000,
				cost: null,
			});
		expect(tally.estimate).toBe(38_000);
		tally = reduceTokenTally(tally, { kind: 'host.stopped', reason: 'shutdown' });
		expect(tally).toMatchObject({ estimate: 0, running: false });
	});
	it('sums a crew over its foreman, workers and reviewers, split by provider', () => {
		const tasks = crew.map((journal) => task(journal)),
			root = tasks[0]!;
		expect(tokenMembers(root, tasks).map((item) => item.id)).toEqual([
			'crew-root',
			'crew-dev',
			'crew-check-notes',
			'crew-check-api',
		]);
		const sum = taskTokenSum(root, tasks);
		expect(sum.providers.map((item) => [item.provider, item.tokens, item.members.length])).toEqual([
			['claude', 384_525 + 210_777, 2],
			['codex', 376_696 + 125_696, 2],
		]);
		expect(sum.tokens).toBe(595_302 + 502_392);
		expect(sum.estimated).toBe(false);
		expect(sum.providers[1]!.parts.cacheRead).toBe(15_765_504 + 4_237_312);
		// A member's own count is its own: the reviewer's popover shows only itself.
		expect(taskTokenSum(tasks[2]!, tasks).tokens).toBe(376_696);
	});
	it("a member's running turn marks the crew's count as an estimate", () => {
		const dev = crew[1]!,
			cut = dev.records.findIndex((item) => item.event.kind === 'turn.usage') - 1,
			tasks = [task(crew[0]!), task(dev, dev.records.slice(0, cut)), task(crew[2]!)];
		const sum = taskTokenSum(tasks[0]!, tasks);
		expect(sum.estimated).toBe(true);
		expect(sum.providers.find((item) => item.provider === 'claude')!.estimated).toBe(true);
		expect(sum.providers.find((item) => item.provider === 'codex')!.estimated).toBe(false);
	});
	it("shows the account's share at the task's first reading and now", () => {
		const tasks = crew.map((journal) => task(journal));
		const spans = quotaSpans(tasks.map((item) => item.tokens));
		// The 5-hour window reset while the developer worked: its first reading of the new window is the start.
		expect(
			spans.map((span) => [
				span.provider,
				span.kind,
				span.before,
				Math.round(span.now * 100),
				span.reset,
			])
		).toEqual([
			['claude', 'five-hour', 1, 9, true],
			['claude', 'weekly', 0.89, 60, false],
		]);
	});
	it('a window that reset during the task starts from its own first reading', () => {
		const reading = (remaining: number, resetsAt: number) =>
			record({
				kind: 'quota.observed',
				provider: 'claude',
				complete: false,
				windows: [
					{
						id: 'five_hour',
						kind: 'five-hour',
						model: null,
						minutes: 300,
						remaining,
						resetsAt,
						exhausted: false,
					},
				],
			});
		const tally = tokenTally([
			reading(0.4, 1000),
			reading(0.2, 1000),
			reading(0.9, 19_000),
			reading(0.7, 19_000),
		]);
		expect(quotaSpans([tally])).toEqual([
			{ provider: 'claude', kind: 'five-hour', before: 0.9, now: 0.7, reset: true },
		]);
	});
	it('old tasks without tokens read as no counter', () => {
		const old: AgentTask = {
			id: 'old',
			projectId: 'p1',
			title: 'Old',
			status: 'done',
			provider: 'claude',
		};
		expect(isAgentTask(old)).toBe(true);
		expect(taskTokenSum(old, [old])).toEqual({ tokens: 0, estimated: false, providers: [] });
	});
});

describe('task budget (spec/agents-and-providers#task-budget)', () => {
	it('a new task takes the default per provider; No limit leaves the key out', () => {
		expect(budgetFromSetting({ claude: null, codex: null })).toBeUndefined();
		expect(budgetFromSetting({ claude: 2_000_000, codex: null })).toEqual({ claude: 2_000_000 });
		expect(isTaskBudgetSetting({ claude: 500_000, codex: 10_000_000 })).toBe(true);
		expect(isTaskBudgetSetting({ claude: -1, codex: null })).toBe(false);
	});
	it('stores the budget, the figure and the hold on the task; old tasks have none', () => {
		const stored = task(solo);
		expect(isAgentTask({ ...stored, tokenBudget: { claude: 2_000_000 } })).toBe(true);
		expect(
			isAgentTask({
				...stored,
				tokenHold: {
					id: 'b1',
					provider: 'claude',
					tokens: 2_100_000,
					budget: 2_000_000,
					state: 'asked',
				},
			})
		).toBe(true);
		expect(isAgentTask({ ...stored, tokenBudget: { claude: 'lots' } })).toBe(false);
		expect(isAgentTask({ ...stored, tokenBudget: { gemini: 1_000_000 } })).toBe(false);
	});
	it('is near from 80 % and reached at the budget; no budget is never either', () => {
		expect(budgetTone(1_599_999, 2_000_000)).toBe('normal');
		expect(budgetTone(1_600_000, 2_000_000)).toBe('near');
		expect(budgetTone(2_000_000, 2_000_000)).toBe('reached');
		expect(budgetTone(9e9, undefined)).toBe('none');
	});
	it('names the provider nearest its budget', () => {
		const tasks = crew.map((journal) => task(journal)),
			sum = taskTokenSum(tasks[0]!, tasks);
		expect(budgetLead(sum, { claude: 2_000_000, codex: 600_000 })).toMatchObject({
			provider: 'codex',
			tone: 'near',
		});
		expect(budgetLead(sum, undefined)).toBeNull();
		// One provider at its budget pauses the whole task, whatever the other's count.
		expect(reachedBudget(sum, { claude: 10_000_000, codex: 500_000 })).toMatchObject({
			provider: 'codex',
			tokens: 502_392,
			budget: 500_000,
		});
	});
	it('reaches the budget mid-turn from the estimate and at a turn end from the exact figure', () => {
		const records = solo.records,
			end = records.findIndex((item) => item.event.kind === 'turn.usage'),
			middle = records.slice(0, end).findLastIndex((item) => item.event.kind === 'usage.changed');
		const running = task(solo, records.slice(0, middle + 1)),
			exact = task(solo, records.slice(0, end + 1));
		const estimate = taskTokenSum(running, [running]),
			finished = taskTokenSum(exact, [exact]);
		expect(estimate.estimated).toBe(true);
		const mid = budgetToAsk(estimate, { claude: estimate.tokens }, budgetJournal([]));
		expect(mid).toMatchObject({ provider: 'claude', estimated: true });
		const atEnd = budgetToAsk(finished, { claude: finished.tokens }, budgetJournal([]));
		expect(atEnd).toMatchObject({ provider: 'claude', estimated: false });
		expect(budgetToAsk(finished, { claude: finished.tokens + 1 }, budgetJournal([]))).toBeNull();
	});
	it('offers three raises above both the budget and the count', () => {
		expect(raiseChoices(2_000_000, 2_000_000)).toEqual([3_000_000, 5_000_000, 10_000_000]);
		expect(raiseChoices(2_000_000, 3_400_000)).toEqual([5_000_000, 10_000_000, 20_000_000]);
		expect(raiseChoices(500_000, 510_000)).toEqual([1_000_000, 2_000_000, 3_000_000]);
		expect(raiseChoices(100_000_000, 100_000_000)).toEqual([200_000_000, 400_000_000, 800_000_000]);
		expect(budgetPopupValues(3_000_000)).toEqual([
			500_000, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 10_000_000,
		]);
	});
});

describe('reaching the budget (spec/agents-and-providers#budget-reached)', () => {
	const reached = record({
		kind: 'budget.reached',
		id: 'b1',
		provider: 'claude',
		tokens: 2_050_000,
		budget: 2_000_000,
		estimated: true,
	});
	it('journals new event kinds and commands that validate', () => {
		expect(isSessionEvent(reached.event)).toBe(true);
		expect(
			isSessionEvent({ kind: 'budget.decided', id: 'b1', decision: 'raise', budget: 3_000_000 })
		).toBe(true);
		expect(isSessionEvent({ kind: 'budget.decided', id: 'b1', decision: 'later' })).toBe(false);
		expect(
			isSessionCommand({ kind: 'decideBudget', id: 'b1', decision: 'raise', budget: 3_000_000 })
		).toBe(true);
		expect(isSessionCommand({ kind: 'decideBudget', id: 'b1', decision: 'raise' })).toBe(false);
		expect(isSessionCommand({ kind: 'decideBudget', id: 'b1', decision: 'stop', budget: 1 })).toBe(
			false
		);
		expect(isSessionCommand({ kind: 'setTokenBudget', provider: 'codex', budget: null })).toBe(
			true
		);
		expect(isSessionCommand({ kind: 'setTokenBudget', provider: 'codex', budget: 5 })).toBe(false);
	});
	it('the question waits for the person and holds the task, also after a restart', () => {
		const records = [reached, record({ kind: 'host.stopped', reason: 'shutdown' })],
			inputs = pendingInputs(records);
		expect(inputs.budget).toMatchObject({ id: 'b1', provider: 'claude', estimated: true });
		expect(waitsForPerson(inputs)).toBe(true);
		expect(tokenHold(budgetJournal(records), { claude: 2_000_000 })).toMatchObject({
			state: 'asked',
		});
		// Nothing asks twice for one pause.
		const tasks = [task(solo)],
			sum = { ...taskTokenSum(tasks[0]!, tasks), tokens: 9e6 };
		expect(budgetToAsk(sum, { claude: 2_000_000 }, budgetJournal(records))).toBeNull();
	});
	it('a raise lifts the hold and sets the new budget', () => {
		const decided = record({
				kind: 'budget.decided',
				id: 'b1',
				decision: 'raise',
				budget: 3_000_000,
			}),
			journal = budgetJournal([reached, decided]),
			budget = decidedBudget(
				{ claude: 2_000_000, codex: 1_000_000 },
				journal.pending ?? { provider: 'claude', budget: 2_000_000 },
				'raise',
				3_000_000
			);
		expect(budget).toEqual({ claude: 3_000_000, codex: 1_000_000 });
		expect(tokenHold(journal, budget)).toBeNull();
		expect(pendingInputs([reached, decided]).budget).toBeNull();
		expect(() =>
			decidedBudget(
				{ claude: 2_000_000 },
				{ provider: 'claude', budget: 2_000_000 },
				'raise',
				2_000_000
			)
		).toThrow();
	});
	it('No limit removes the provider’s budget', () => {
		expect(
			decidedBudget({ claude: 2_000_000 }, { provider: 'claude', budget: 2_000_000 }, 'unlimited')
		).toBeUndefined();
	});
	it('finish and stop keep the task paused until its budget changes', () => {
		for (const decision of ['finish', 'stop'] as const) {
			const journal = budgetJournal([
				reached,
				record({ kind: 'budget.decided', id: 'b1', decision }),
			]);
			expect(tokenHold(journal, { claude: 2_000_000 })).toMatchObject({
				state: decision,
				tokens: 2_050_000,
			});
			expect(tokenHold(journal, { claude: 5_000_000 })).toBeNull();
			expect(tokenHold(journal, undefined)).toBeNull();
			expect(
				pendingInputs([reached, record({ kind: 'budget.decided', id: 'b1', decision })]).budget
			).toBeNull();
		}
	});
	it('a budget changed in Task usage answers the question only above the count', () => {
		const question = { provider: 'claude' as const, tokens: 2_050_000 };
		expect(popoverAnswer(question, { claude: 5_000_000 }, 2_100_000)).toEqual({
			decision: 'raise',
			budget: 5_000_000,
		});
		expect(popoverAnswer(question, {}, 2_100_000)).toEqual({ decision: 'unlimited' });
		expect(popoverAnswer(question, { claude: 2_000_000 }, 2_100_000)).toBeNull();
	});
	it('an old journal without budget records holds nothing', () => {
		expect(tokenHold(budgetJournal(solo.records), { claude: 1 })).toBeNull();
		expect(pendingInputs(solo.records).budget).toBeNull();
	});
});
