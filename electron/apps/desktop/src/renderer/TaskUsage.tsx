import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
	budgetLead,
	budgetPopupValues,
	budgetTone,
	crewTaskLabel,
	formatTokenCount,
	pausedWorkersText,
	quotaSpans,
	raiseChoices,
	t,
	taskTokenSum,
	tokenCount,
	tokenMembers,
	type AgentProvider,
	type AgentTask,
	type BudgetDecision,
	type BudgetLead,
	type BudgetQuestion,
	type Locale,
	type ProviderTokens,
	type QuotaSpan,
	type SessionCommand,
	type TaskTokenSum,
	type TokenBudget,
	type TokenHold,
} from '@brigadir/core';
import { Button, Popup, SplitButton } from './ui/Controls';
import { DeckList, DeckRow, DeckRowButton } from './ui/Deck';
import { Glyph } from './ui/Glyph';
import { MenuItem, MenuPopover, Popover } from './ui/Popover';
import { ProgressBar } from './ui/ProgressBar';
import { InputCard } from './ui/SessionInputs';
import { useWorkspace } from './store';
import s from './TaskUsage.module.css';

/** spec/agents-and-providers#task-tokens: what a task's views show — its count over its members, its budget and its hold. A member shows only itself. */
export type TaskTokensView = {
	root: AgentTask;
	member: boolean;
	sum: TaskTokenSum;
	budget: TokenBudget | undefined;
	hold: TokenHold | null;
	lead: BudgetLead | null;
	spans: QuotaSpan[];
	/** The crew's members besides the root (workers, leads, reviewers). */ workers: number;
	label(taskId: string): string;
};
export function tokensView(
	task: AgentTask,
	tasks: readonly AgentTask[],
	locale: Locale
): TaskTokensView {
	const member = Boolean(task.crewTaskId && task.crewTaskId !== task.id),
		root = member
			? (tasks.find((item) => item.id === task.crewTaskId && item.projectId === task.projectId) ??
				task)
			: task,
		own = member ? [task] : tokenMembers(root, tasks),
		sum = member ? taskTokenSum(task, [task]) : taskTokenSum(root, tasks),
		budget = member ? undefined : root.tokenBudget;
	return {
		root,
		member,
		sum,
		budget,
		hold: member ? null : (root.tokenHold ?? null),
		lead: budgetLead(sum, budget),
		spans: quotaSpans(own.map((item) => item.tokens)),
		workers: Math.max(0, own.length - 1),
		label: (taskId) => {
			if (taskId === root.id && !member) return t(locale, 'Agent');
			const item = tasks.find((entry) => entry.id === taskId);
			return item ? crewTaskLabel(item, tasks) : t(locale, 'Agent');
		},
	};
}
export function useTaskTokens(task: AgentTask, locale: Locale): TaskTokensView {
	const tasks = useWorkspace((state) => state.workspace?.tasks);
	return useMemo(() => tokensView(task, tasks ?? [task], locale), [task, tasks, locale]);
}
export const providerName = (locale: Locale, provider: AgentProvider) =>
	t(locale, provider === 'claude' ? 'Claude' : 'Codex');
const short = (tokens: number, estimated: boolean) =>
	`${estimated ? '≈' : ''}${formatTokenCount(tokens)}`;
export type CounterTone = 'normal' | 'near' | 'reached';
/**
 * spec/composer#task-usage: the counter's text. The sum; near a budget the provider nearest it and its budget (`Claude 1.7m of 2m`); while held at a
 * budget, that provider's figure and `· paused`.
 */
export function counterText(
	locale: Locale,
	view: TaskTokensView
): { text: string; tone: CounterTone } {
	const { sum, hold, lead } = view,
		of = (provider: AgentProvider, budget: number) => {
			const item = sum.providers.find((entry) => entry.provider === provider);
			return t(locale, '{provider} {used} of {budget}')
				.replace('{provider}', providerName(locale, provider))
				.replace('{used}', short(item?.tokens ?? 0, item?.estimated ?? false))
				.replace('{budget}', formatTokenCount(budget));
		};
	if (hold)
		return {
			text: t(locale, '{text} · paused').replace('{text}', of(hold.provider, hold.budget)),
			tone: 'reached',
		};
	if (lead && lead.tone !== 'normal' && lead.tone !== 'none')
		return {
			text: of(lead.provider, lead.budget),
			tone: lead.tone === 'near' ? 'near' : 'reached',
		};
	return {
		text: `${sum.estimated ? '≈' : ''}${tokenCount(locale, sum.tokens)}`,
		tone: 'normal',
	};
}
const partsTitle = (locale: Locale, item: ProviderTokens) =>
	t(
		locale,
		'New input {a} · written to cache {b} · output {c} · re-read from cache {d}, not counted'
	)
		.replace('{a}', formatTokenCount(item.parts.input))
		.replace('{b}', formatTokenCount(item.parts.cacheWrite))
		.replace('{c}', formatTokenCount(item.parts.output))
		.replace('{d}', formatTokenCount(item.parts.cacheRead));
const noLimit = 'none';
/** spec/agents-and-providers#task-budget: the budget popup of one provider — Settings ▸ Agents and `Task usage` share it. */
export function BudgetPopup({
	locale,
	provider,
	value,
	disabled,
	label,
	onChange,
}: {
	locale: Locale;
	provider: AgentProvider;
	value: number | undefined;
	disabled: boolean;
	label?: string;
	onChange(value: number | null): void;
}) {
	return (
		<Popup
			label={
				label ??
				t(locale, '{provider} budget').replace('{provider}', providerName(locale, provider))
			}
			disabled={disabled}
			fit
			value={value === undefined ? noLimit : String(value)}
			options={[
				{ value: noLimit, label: t(locale, 'No limit') },
				...budgetPopupValues(value).map((size) => ({
					value: String(size),
					label: formatTokenCount(size),
				})),
			]}
			onChange={(next) => onChange(next === noLimit ? null : Number(next))}
		/>
	);
}
const percent = (share: number) => `${Math.round(share * 100)}%`;
/** spec/agents-and-providers#task-quota-span: the account's share at the task's first reading and now — the account's, not the task's. */
function QuotaLines({ spans, locale }: { spans: QuotaSpan[]; locale: Locale }) {
	if (!spans.length) return null;
	return (
		<footer className={s.quota} data-task-quota>
			<small>{t(locale, 'Account limits since the task started')}</small>
			<ul>
				{spans.map((span) => (
					<li key={`${span.provider}-${span.kind}`}>
						<span>
							{providerName(locale, span.provider)} ·{' '}
							{t(locale, span.kind === 'five-hour' ? '5-hour limit' : 'Weekly limit')}
						</span>
						{span.reset && <small>{t(locale, 'since it reset')}</small>}
						<span className={s.count}>
							{percent(span.before)} → {percent(span.now)}
						</span>
					</li>
				))}
			</ul>
		</footer>
	);
}
/** spec/composer#task-usage: one group per provider — its count, the budget popup and bar, its agents; then the account lines. */
export function UsageBreakdown({
	view,
	locale,
	disabled,
	onBudget,
}: {
	view: TaskTokensView;
	locale: Locale;
	disabled: boolean;
	onBudget?(provider: AgentProvider, value: number | null): void;
}) {
	const providers: ProviderTokens[] = (['claude', 'codex'] as const).flatMap((provider) => {
		const item = view.sum.providers.find((entry) => entry.provider === provider);
		if (item) return [item];
		return view.budget?.[provider] !== undefined
			? [
					{
						provider,
						tokens: 0,
						estimated: false,
						parts: { input: 0, cacheWrite: 0, output: 0, cacheRead: 0 },
						members: [],
					},
				]
			: [];
	});
	return (
		<div className={s.breakdown}>
			{providers.map((item) => {
				const budget = view.budget?.[item.provider],
					tone = budgetTone(item.tokens, budget);
				return (
					<section
						key={item.provider}
						className={s.provider}
						data-usage-provider={item.provider}
						data-tone={tone}>
						<header data-size="s" title={partsTitle(locale, item)}>
							<Glyph name={item.provider === 'claude' ? 'claude' : 'openai'} size={12} />
							<strong>{providerName(locale, item.provider)}</strong>
							<span className={s.used} data-tone={tone}>
								{short(item.tokens, item.estimated)}
							</span>
							{!view.member && onBudget && (
								<>
									{budget !== undefined && <span className={s.of}>{t(locale, 'of')}</span>}
									<BudgetPopup
										locale={locale}
										provider={item.provider}
										value={budget}
										disabled={disabled}
										onChange={(value) => onBudget(item.provider, value)}
									/>
								</>
							)}
						</header>
						{budget !== undefined && (
							<ProgressBar
								value={item.tokens}
								total={budget}
								tone={tone === 'reached' ? 'red' : tone === 'near' ? 'amber' : 'accent'}
							/>
						)}
						{item.members.length > 0 && (
							<ul>
								{item.members.map((member) => (
									<li key={member.taskId}>
										<span>{view.label(member.taskId)}</span>
										<span className={s.count}>{short(member.tokens, member.estimated)}</span>
									</li>
								))}
							</ul>
						)}
					</section>
				);
			})}
			<QuotaLines spans={view.spans} locale={locale} />
		</div>
	);
}
/** spec/composer#task-usage: the counter at the right end of the environment footer and its `Task usage` popover. */
export function TaskUsageCounter({
	task,
	locale,
	disabled,
	send,
}: {
	task: AgentTask;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const view = useTaskTokens(task, locale);
	return <TaskUsageCounterView view={view} locale={locale} disabled={disabled} send={send} />;
}
export function TaskUsageCounterView({
	view,
	locale,
	disabled,
	send,
	open: initial = false,
}: {
	view: TaskTokensView;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
	open?: boolean;
}) {
	const [open, setOpen] = useState(initial),
		button = useRef<HTMLButtonElement>(null),
		id = useId();
	if (!view.sum.providers.length && !view.budget) return null;
	const { text, tone } = counterText(locale, view);
	return (
		<>
			<button
				ref={button}
				type="button"
				className={s.counter}
				data-task-usage
				data-tone={tone}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				title={tokenCount(locale, view.sum.tokens)}
				onClick={() => setOpen((value) => !value)}>
				{text}
			</button>
			<Popover
				id={id}
				open={open}
				onClose={() => setOpen(false)}
				anchor={button}
				returnFocus={button}
				side="top"
				align="end"
				width={340}
				label={t(locale, 'Task usage')}
				title={t(locale, 'Task usage')}
				headerExtra={
					<span className={s.total}>
						{view.sum.estimated ? '≈' : ''}
						{tokenCount(locale, view.sum.tokens)}
					</span>
				}
				locale={locale}
				note={
					view.member
						? t(locale, 'Counted in the budget of {task}.').replace('{task}', view.root.title)
						: undefined
				}>
				<UsageBreakdown
					view={view}
					locale={locale}
					disabled={disabled}
					onBudget={(provider, budget) => send({ kind: 'setTokenBudget', provider, budget })}
				/>
			</Popover>
		</>
	);
}
/** `Raise to {n}` — the primary split button of the budget question; its menu holds the larger values and `No limit for this task`. */
function RaiseButton({
	question,
	tokens,
	locale,
	disabled,
	answer,
}: {
	question: Pick<BudgetQuestion, 'budget'>;
	tokens: number;
	locale: Locale;
	disabled: boolean;
	answer(decision: BudgetDecision, budget?: number): void;
}) {
	const [menu, setMenu] = useState(false),
		toggle = useRef<HTMLButtonElement>(null);
	const choices = raiseChoices(question.budget, tokens),
		raise = (value: number) => t(locale, 'Raise to {n}').replace('{n}', formatTokenCount(value));
	return (
		<SplitButton
			appearance="primary"
			disabled={disabled}
			onClick={() => answer('raise', choices[0])}
			second={{
				label: t(locale, 'More budgets'),
				ref: toggle,
				expanded: menu,
				onClick: () => setMenu((value) => !value),
			}}
			menu={
				<MenuPopover
					open={menu}
					onClose={() => setMenu(false)}
					anchor={toggle}
					side="top"
					align="end"
					width={240}
					label={t(locale, 'More budgets')}
					title={t(locale, 'More budgets')}
					locale={locale}>
					{choices.map((value) => (
						<MenuItem key={value} onSelect={() => answer('raise', value)}>
							{raise(value)}
						</MenuItem>
					))}
					<MenuItem onSelect={() => answer('unlimited')}>
						{t(locale, 'No limit for this task')}
					</MenuItem>
				</MenuPopover>
			}>
			{raise(choices[0]!)}
		</SplitButton>
	);
}
export const budgetTitle = (locale: Locale, provider: AgentProvider) =>
	t(locale, '{provider} budget reached').replace('{provider}', providerName(locale, provider));
/** The answer's words under the folded card (spec/chat-turns-plans-and-questions#budget-card). */
export const budgetAnswerText = (locale: Locale, decision: BudgetDecision, budget?: number) =>
	decision === 'raise'
		? t(locale, 'Raise to {n}').replace('{n}', formatTokenCount(budget ?? 0))
		: t(
				locale,
				decision === 'unlimited'
					? 'No limit for this task'
					: decision === 'finish'
						? 'Finish turns, then stop'
						: 'Stop now'
			);
const pausedText = (locale: Locale, workers: number) =>
	workers > 0 ? pausedWorkersText(locale, workers) : t(locale, 'The task is paused.');
/** spec/chat-turns-plans-and-questions#budget-card: the question in the chat while it waits; folded into one line with the answer once decided. */
export function BudgetCard({
	question,
	view,
	locale,
	disabled,
	send,
}: {
	question: BudgetQuestion;
	view: TaskTokensView;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const title = budgetTitle(locale, question.provider);
	const decide = (decision: BudgetDecision, budget?: number) =>
		send({
			kind: 'decideBudget',
			id: question.id,
			decision,
			...(budget !== undefined ? { budget } : {}),
		});
	const tokens = Math.max(
		question.tokens,
		view.sum.providers.find((item) => item.provider === question.provider)?.tokens ?? 0
	);
	return (
		<InputCard
			glyph="pause"
			title={title}
			hint={t(locale, '{used} of {budget} tokens')
				.replace('{used}', short(question.tokens, question.estimated))
				.replace('{budget}', formatTokenCount(question.budget))}
			since={Date.parse(question.at)}
			label={t(locale, 'Budget question')}
			locale={locale}
			data-budget-card="waiting"
			actions={
				<>
					<Button variant="ghost" disabled={disabled} onClick={() => decide('stop')}>
						{t(locale, 'Stop now')}
					</Button>
					<Button disabled={disabled} onClick={() => decide('finish')}>
						{t(locale, 'Finish turns, then stop')}
					</Button>
					<RaiseButton
						question={question}
						tokens={tokens}
						locale={locale}
						disabled={disabled}
						answer={decide}
					/>
				</>
			}>
			<div className={s.cardBody}>
				<p>{pausedText(locale, view.workers)}</p>
				<small>
					{t(
						locale,
						'Turns that run now finish. Nothing new starts: no hires, no deliveries, no queued messages.'
					)}
				</small>
			</div>
		</InputCard>
	);
}
/** spec/chat-turns-plans-and-questions#budget-strip: the same question over the composer while it waits; its chevron opens the breakdown. */
export function BudgetStrip({
	question,
	view,
	locale,
	disabled,
	send,
}: {
	question: BudgetQuestion;
	view: TaskTokensView;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}): ReactNode {
	const [shown, setShown] = useState(false);
	const decide = (decision: BudgetDecision, budget?: number) =>
		send({
			kind: 'decideBudget',
			id: question.id,
			decision,
			...(budget !== undefined ? { budget } : {}),
		});
	const tokens = Math.max(
		question.tokens,
		view.sum.providers.find((item) => item.provider === question.provider)?.tokens ?? 0
	);
	return (
		<>
			<DeckList label={t(locale, 'Budget question')} data-budget-strip>
				<DeckRow
					hover
					tone="amber"
					label={
						<span className={s.stripGlyph}>
							<Glyph name="pause" size={12} />
						</span>
					}
					actions={
						<>
							<Button size="s" variant="ghost" disabled={disabled} onClick={() => decide('stop')}>
								{t(locale, 'Stop now')}
							</Button>
							<Button
								size="s"
								disabled={disabled}
								onClick={() => decide('finish')}
								title={t(locale, 'Finish turns, then stop')}>
								{t(locale, 'Finish turns')}
							</Button>
							<RaiseButton
								question={question}
								tokens={tokens}
								locale={locale}
								disabled={disabled}
								answer={decide}
							/>
						</>
					}>
					<DeckRowButton expanded={shown} onClick={() => setShown(!shown)}>
						<p>
							<b>{t(locale, 'Budget reached')}</b>
						</p>
					</DeckRowButton>
				</DeckRow>
			</DeckList>
			{shown && (
				<div className={s.stripDetails}>
					<UsageBreakdown view={view} locale={locale} disabled />
					<small>{t(locale, 'Turns that run now finish; nothing new starts.')}</small>
				</div>
			)}
		</>
	);
}
/** spec/sidebar#card-tokens: the sum on a card's tree line — amber near a budget, red at it; never the budget itself. */
export function CardTokens({ task, locale }: { task: AgentTask; locale: Locale }) {
	const tasks = useWorkspace((state) => state.workspace?.tasks);
	const view = useMemo(() => tokensView(task, tasks ?? [task], locale), [task, tasks, locale]);
	if (!view.sum.providers.length) return null;
	const tone = view.hold ? 'reached' : (view.lead?.tone ?? 'none');
	return (
		<span
			className={s.card}
			data-card-tokens
			data-tone={tone === 'near' || tone === 'reached' ? tone : undefined}
			title={tokenCount(locale, view.sum.tokens)}>
			{short(view.sum.tokens, view.sum.estimated)}
		</span>
	);
}
/** spec/sidebar#crew-card: a member's own count in its worker row's tail. */
export function MemberTokens({ task, locale }: { task: AgentTask; locale: Locale }) {
	const view = useMemo(() => tokensView(task, [task], locale), [task, locale]);
	if (!view.sum.providers.length) return null;
	return (
		<span className={s.member} data-member-tokens title={tokenCount(locale, view.sum.tokens)}>
			{short(view.sum.tokens, view.sum.estimated)}
		</span>
	);
}
