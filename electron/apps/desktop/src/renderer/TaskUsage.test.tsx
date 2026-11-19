import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentTask, BudgetQuestion, TaskOwnTokens } from '@brigadir/core';
import {
	BudgetCard,
	BudgetStrip,
	MemberTokens,
	TaskUsageCounterView,
	UsageBreakdown,
	counterText,
	tokensView,
} from './TaskUsage';

// The card's `waiting {age}` ticks on the client only; a server render reads the clock once.
vi.mock('./ui/second-tick', () => ({ useSecondTick: () => Date.now() }));
const own = (input: number, extra: Partial<TaskOwnTokens> = {}): TaskOwnTokens => ({
	input,
	cacheWrite: 0,
	output: 0,
	cacheRead: input * 20,
	estimate: 0,
	running: false,
	...extra,
});
const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
	id,
	projectId: 'p1',
	title: id,
	status: 'working',
	provider: 'claude',
	...extra,
});
/** A crew as on the canvas (U-A): a Claude foreman and two Claude workers, one Codex worker. */
const crew = (
	budget?: AgentTask['tokenBudget'],
	foreman = 620_000,
	extra: Partial<AgentTask> = {}
) => [
	task('root', { tokens: own(foreman), ...(budget ? { tokenBudget: budget } : {}), ...extra }),
	task('dev', {
		crewTaskId: 'root',
		crewNodeId: 'n1',
		title: 'Details screen',
		tokens: own(240_000),
	}),
	task('test', {
		crewTaskId: 'root',
		crewNodeId: 'n2',
		title: 'Client flows',
		tokens: own(70_000),
	}),
	task('api', {
		crewTaskId: 'root',
		crewNodeId: 'n3',
		title: 'API endpoints',
		provider: 'codex',
		tokens: own(310_000),
	}),
];
const view = (tasks: AgentTask[], index = 0) => tokensView(tasks[index]!, tasks, 'en');

it('the counter: the sum, ≈ while a turn runs, the provider near its budget, paused at it, no budget never toned', () => {
	expect(counterText('en', view(crew()))).toEqual({ text: '1.2m tokens', tone: 'normal' });
	const running = crew();
	running[1] = { ...running[1]!, tokens: own(240_000, { estimate: 100_000, running: true }) };
	expect(counterText('en', view(running))).toEqual({ text: '≈1.3m tokens', tone: 'normal' });
	expect(counterText('en', view(crew({ claude: 2_000_000 }, 1_390_000)))).toEqual({
		text: 'Claude 1.7m of 2m',
		tone: 'near',
	});
	const held = crew({ claude: 2_000_000 }, 1_690_000, {
		tokenHold: {
			id: 'b1',
			provider: 'claude',
			tokens: 2_000_000,
			budget: 2_000_000,
			state: 'asked',
		},
	});
	expect(counterText('en', view(held))).toEqual({
		text: 'Claude 2m of 2m · paused',
		tone: 'reached',
	});
	expect(counterText('uk', tokensView(held[0]!, held, 'uk')).text).toBe(
		'Claude 2m з 2m · на паузі'
	);
	// Far past any budget there is none: the sum only.
	expect(counterText('en', view(crew(undefined, 50_000_000))).tone).toBe('normal');
	// A task whose agents reported nothing yet has no counter.
	const html = renderToStaticMarkup(
		<TaskUsageCounterView view={view([task('new')])} locale="en" disabled={false} send={() => {}} />
	);
	expect(html).toBe('');
});

it('a member shows only its own count, and its popover names the budget it is counted in', () => {
	const tasks = crew({ claude: 2_000_000 });
	const member = view(tasks, 3);
	expect(member.member).toBe(true);
	expect(counterText('en', member).text).toBe('310k tokens');
	const html = renderToStaticMarkup(
		<UsageBreakdown view={member} locale="en" disabled={false} onBudget={() => {}} />
	);
	expect(html).not.toContain('aria-haspopup="listbox"');
});

it('Task usage: a group per provider with its budget popup, bar and agents, the parts in a tooltip, the account lines', () => {
	const tasks = crew({ claude: 2_000_000 });
	tasks[0] = {
		...tasks[0]!,
		tokens: own(620_000, {
			quota: {
				claude: {
					'five-hour': {
						first: { remaining: 0.71, resetsAt: 1000, at: '2026-11-13T10:00:00Z' },
						windowFirst: { remaining: 0.71, resetsAt: 1000, at: '2026-11-13T10:00:00Z' },
						last: { remaining: 0.52, resetsAt: 1000, at: '2026-11-13T11:00:00Z' },
					},
				},
			},
		}),
	};
	const html = renderToStaticMarkup(
		<UsageBreakdown view={view(tasks)} locale="en" disabled={false} onBudget={() => {}} />
	);
	expect(html).toContain('data-usage-provider="claude"');
	expect(html).toContain('data-usage-provider="codex"');
	expect(html).toContain('930k');
	expect(html).toContain('>Agent<');
	expect(html).toContain('Details screen');
	expect(html).toContain('No limit');
	expect(html).toMatch(/re-read from cache 18\.6m, not counted/);
	expect(html).toContain('Account limits since the task started');
	expect(html).toContain('71% → 52%');
	expect(html.match(/data-tone="accent"/g)).toHaveLength(1);
});

const question: BudgetQuestion = {
	id: 'b1',
	provider: 'claude',
	tokens: 2_000_000,
	budget: 2_000_000,
	estimated: false,
	seq: 9,
	at: new Date().toISOString(),
};
it('the budget card: the paused crew, the three answers with Raise to the next value', () => {
	const html = renderToStaticMarkup(
		<BudgetCard
			question={question}
			view={view(crew({ claude: 2_000_000 }))}
			locale="en"
			disabled={false}
			send={() => {}}
		/>
	);
	expect(html).toContain('Claude budget reached');
	expect(html).toContain('2m of 2m tokens');
	expect(html).toContain('The task and its 3 workers are paused.');
	expect(html).toContain('Stop now');
	expect(html).toContain('Finish turns, then stop');
	expect(html).toContain('Raise to 3m');
	const solo = renderToStaticMarkup(
		<BudgetCard
			question={{ ...question, estimated: true }}
			view={view([task('solo', { tokens: own(2_000_000), tokenBudget: { claude: 2_000_000 } })])}
			locale="uk"
			disabled={false}
			send={() => {}}
		/>
	);
	expect(solo).toContain('Задача на паузі.');
	expect(solo).toContain('≈2m з 2m токенів');
	expect(solo).toContain('Підняти до 3m');
});

it('the strip over the composer: Budget reached and the short answers', () => {
	const html = renderToStaticMarkup(
		<BudgetStrip
			question={question}
			view={view(crew({ claude: 2_000_000 }))}
			locale="en"
			disabled={false}
			send={() => {}}
		/>
	);
	expect(html).toContain('data-budget-strip');
	expect(html).toContain('data-tone="amber"');
	expect(html).toContain('Budget reached');
	expect(html).toContain('Finish turns<');
	expect(html).toContain('Raise to 3m');
	// The row's chevron expands the breakdown (spec/chat-turns-plans-and-questions#budget-strip).
	expect(html).toMatch(
		/aria-label="Expand"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-label="Expand"/
	);
});

it("a worker row shows the member's own count, ≈ while its turn runs", () => {
	const html = renderToStaticMarkup(
		<MemberTokens
			task={task('dev', { tokens: own(240_000, { estimate: 5000, running: true }) })}
			locale="en"
		/>
	);
	expect(html).toContain('≈245k');
});

it('a budget change reads the workspace again once the command went through, and not after a refusal', async () => {
	const { changeBudget } = await import('./TaskUsage');
	const sent: unknown[] = [];
	let reloads = 0;
	const reload = async () => {
		reloads++;
	};
	await changeBudget(async (command) => (sent.push(command), true), 'claude', 2_000_000, reload);
	expect(sent).toEqual([{ kind: 'setTokenBudget', provider: 'claude', budget: 2_000_000 }]);
	expect(reloads).toBe(1);
	await changeBudget(async () => false, 'codex', null, reload);
	expect(reloads).toBe(1);
});
