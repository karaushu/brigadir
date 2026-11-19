import { useRef, useState } from 'react';
import {
	autoBudgetLimits,
	autoHireTotal,
	autoHireable,
	autoRootName,
	budgetLabel,
	crewLabel,
	hireSplitLabel,
	hireTitle,
	hireTotalLabel,
	hiredTitle,
	planPartCountLabel,
	refusalText,
	staysWithLabel,
	t,
	type AgentTask,
	type AutoBudget,
	type AutoHire,
	type AutoHirePart,
	type AutoHired,
	type CrewSpecAgent,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { Button, Chip, Popup, PopupMarks, Stepper } from './ui/Controls';
import { TextInput } from './ui/Input';
import { Popover } from './ui/Popover';
import { primaryKey } from './ui/primary-key';
import { CardFold, PartPrompt, PlanSummaryText, agentGlyph, crewChoices } from './Crew';
import { canHire, hireDecision, hireEdited, partEdits, refusedNumbers } from './hire-card';
import styles from './Crew.module.css';
/**
 * spec/chat-turns-plans-and-questions#hire-card: the Auto agent's hire as the crew plan card (rule 17: the same card, its parts and prompt
 * control): per part a title, the role, the budget, the zone and the prompt. The person edits, hires (`Hire {n}`) or keeps the work with the
 * agent (`Do it yourself`). It renders from the journal, so it is there again after a restart.
 */
export function HireCard({
	hire,
	task,
	revision,
	locale,
	disabled,
	send,
}: {
	hire: AutoHire;
	task: AgentTask;
	revision: number;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const [parts, setParts] = useState<AutoHirePart[]>(hire.parts);
	const roles = task.auto?.roles ?? [],
		agent = autoRootName(task.provider ?? 'claude'),
		hireable = autoHireable(parts),
		edited = hireEdited(hire, parts),
		refused = refusedNumbers(parts),
		number = new Intl.NumberFormat(locale);
	const update = (id: string, patch: Partial<AutoHirePart>) =>
		setParts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	const decide = (approved: boolean) => {
		if (disabled || (approved && !canHire(parts))) return;
		send({ kind: 'decideHire', decision: hireDecision(hire, parts, approved) });
	};
	const role = (id: string) => roles.find((item) => item.id === id);
	return (
		<section
			className={`${styles.plan} ${styles.hire}`}
			data-hire-id={hire.id}
			aria-label={hireTitle(locale, agent, parts.length)}
			onKeyDown={(event) => {
				// ⌘↩ hires; the prompt field's own ⌘↩ (it closes the field) is handled first and prevented.
				if (event.key === 'Enter' && primaryKey(event) && !event.defaultPrevented) {
					event.preventDefault();
					decide(true);
				}
			}}>
			<header>
				<Glyph name="helmet" size={16} />
				<strong>{hireTitle(locale, agent, parts.length)}</strong>
				{edited && <span className={styles.edited}>{t(locale, 'edited')}</span>}
				<small>
					<span className={styles.glyphs}>
						{hireable.map((part) => {
							const item = role(part.role);
							return item ? <Glyph key={part.id} name={agentGlyph(item)} size={10} /> : null;
						})}
					</span>
					{hireTotalLabel(locale, autoHireTotal(parts))}
				</small>
			</header>
			{hire.summary && (
				<PlanSummaryText
					id={hire.id}
					text={hire.summary}
					task={task}
					locale={locale}
					revision={revision}
				/>
			)}
			<ol aria-label={t(locale, 'Plan parts')}>
				{parts.map((part, index) => {
					const proposed = hire.parts[index]!,
						changes = partEdits(proposed, part),
						off = !!part.refused,
						chosen = role(part.role);
					return (
						<li
							key={part.id}
							data-hire-part={part.id}
							data-warning={off}
							data-refused={off || undefined}>
							<div className={styles.partRow} data-size="s">
								<span className={styles.partIndex}>{number.format(index + 1)}</span>
								<TextInput
									aria-label={`${t(locale, 'Part')} ${index + 1}`}
									value={part.title}
									disabled={disabled || off}
									maxLength={80}
									onChange={(event) => update(part.id, { title: event.target.value })}
								/>
								<small>{t(locale, 'assigned to')}</small>
								<span className={styles.agent} data-edited={changes.role || undefined}>
									<PopupMarks.Provider value>
										<Popup
											label={t(locale, 'Role')}
											chip
											align="end"
											menuWidth={260}
											disabled={disabled || off}
											value={part.role}
											icon={chosen ? <Glyph name={agentGlyph(chosen)} size={11} /> : undefined}
											options={roles.map((item) => ({
												value: item.id,
												label: crewLabel(locale, item.name),
												icon: <Glyph name={agentGlyph(item)} size={11} />,
												...(crewChoices(item) ? { tail: crewChoices(item)! } : {}),
											}))}
											onChange={(value) => {
												const next = roles.find((item) => item.id === value);
												if (next) update(part.id, { role: next.id, roleName: next.name });
											}}
											{...(chosen ? {} : { displayValue: crewLabel(locale, part.roleName) })}
										/>
									</PopupMarks.Provider>
								</span>
								<BudgetChip
									budget={part.budget}
									edited={changes.budget}
									disabled={disabled || off}
									locale={locale}
									onChange={(budget) => update(part.id, { budget })}
								/>
							</div>
							<p className={styles.partFiles}>
								{part.zone.map((path) => (
									<span key={path} className={`${styles.chip} ${styles.zoneChip}`}>
										<Glyph name="folder" size={11} />
										<span>{path}</span>
									</span>
								))}
								{part.scopes.map((scope) => (
									<span key={scope} className={styles.tag}>
										{scope}
									</span>
								))}
							</p>
							<PartPrompt
								part={part}
								index={index}
								locale={locale}
								disabled={disabled || off}
								onChange={(prompt) => update(part.id, { prompt })}
							/>
							{part.refused && (
								<p className={styles.issue}>
									<Glyph name="review-warning" size={11} />
									{refusalText(locale, part.refused)}
								</p>
							)}
						</li>
					);
				})}
			</ol>
			<footer data-size="m">
				<span className={styles.differences} data-blocked={refused.length > 0}>
					{refused.length
						? staysWithLabel(locale, refused, agent)
						: hireSplitLabel(locale, parts.length, hireable.length)}
				</span>
				<Button disabled={disabled} onClick={() => decide(false)}>
					{t(locale, 'Do it yourself')}
				</Button>
				<Button
					appearance="primary"
					disabled={disabled || !canHire(parts)}
					onClick={() => decide(true)}>
					{refused.length
						? t(locale, 'Hire {n}').replace('{n}', number.format(hireable.length))
						: t(locale, 'Hire')}
				</Button>
			</footer>
		</section>
	);
}
/** The part's budget chip: working time and tokens, edited in a popover of two steppers within the host's limits. */
function BudgetChip({
	budget,
	edited,
	disabled,
	locale,
	onChange,
}: {
	budget: AutoBudget;
	edited: boolean;
	disabled: boolean;
	locale: Locale;
	onChange(budget: AutoBudget): void;
}) {
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null);
	const limits = autoBudgetLimits;
	return (
		<>
			<Chip
				ref={anchor}
				className={styles.budget}
				data-edited={edited || undefined}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${t(locale, 'Budget')}: ${budgetLabel(locale, budget)}`}
				onClick={() => setOpen(true)}>
				<Glyph name="clock" size={11} />
				{budgetLabel(locale, budget)}
			</Chip>
			<Popover
				open={open}
				onClose={() => setOpen(false)}
				anchor={anchor}
				label={t(locale, 'Budget')}
				locale={locale}
				align="end"
				width={240}>
				<div className={styles.budgetFields} data-size="s">
					<span>{t(locale, 'Minutes of work')}</span>
					<Stepper
						size="s"
						label={t(locale, 'Minutes of work')}
						value={budget.minutes}
						min={limits.minutes.min}
						max={limits.minutes.max}
						step={limits.minutes.step}
						increaseLabel={t(locale, 'More time')}
						decreaseLabel={t(locale, 'Less time')}
						onChange={(minutes) => onChange({ ...budget, minutes })}
					/>
					<span>{t(locale, 'Thousands of tokens')}</span>
					<Stepper
						size="s"
						label={t(locale, 'Thousands of tokens')}
						value={Math.round(budget.tokens / 1000)}
						min={limits.tokens.min / 1000}
						max={limits.tokens.max / 1000}
						step={limits.tokens.step / 1000}
						increaseLabel={t(locale, 'More tokens')}
						decreaseLabel={t(locale, 'Fewer tokens')}
						onChange={(thousands) => onChange({ ...budget, tokens: thousands * 1000 })}
					/>
				</div>
				<p className={styles.budgetNote}>
					{t(locale, 'A worker over its budget stops and waits for you.')}
				</p>
			</Popover>
		</>
	);
}
/** spec/chat-turns-plans-and-questions#hire-card: the decided hire folds into one framed row; the chevron lists the parts and who took them. */
export function HireSummary({
	hire,
	parts,
	approved,
	noWorktree = false,
	hired,
	at,
	task,
	locale,
	open,
	onToggle,
}: {
	hire: AutoHire;
	parts: readonly AutoHirePart[] | null;
	approved: boolean;
	/** spec/crew#auto-move: the move into a worktree failed, so nobody was hired. */
	noWorktree?: boolean;
	hired: readonly AutoHired[];
	at: string;
	task: AgentTask;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
}) {
	const items = parts ?? hire.parts,
		agent = autoRootName(task.provider ?? 'claude'),
		roles = task.auto?.roles ?? [];
	const who = (part: AutoHirePart) => {
		const taken = hired.find((item) => item.partId === part.id),
			role: CrewSpecAgent | undefined = roles.find((item) => item.id === part.role);
		return (
			<span key={part.id} className={styles.summaryAgent}>
				{taken && role ? <Glyph name={agentGlyph(role)} size={10} /> : null}
				{taken ? crewLabel(locale, taken.role) : agent}
			</span>
		);
	};
	return (
		<CardFold
			data={{ 'data-hire-summary': hire.id, 'data-approved': approved }}
			title={approved ? hiredTitle(locale, hired.length) : t(locale, 'Not hired')}
			count={approved ? '' : planPartCountLabel(locale, items.length)}
			tail={
				approved ? (
					items.filter((part) => hired.some((item) => item.partId === part.id)).map(who)
				) : (
					<>
						<small>{t(locale, '{agent} does it itself').replace('{agent}', agent)}</small>
						{noWorktree && <small>{t(locale, 'no worktree')}</small>}
					</>
				)
			}
			at={at}
			rows={items.map((part) => ({ id: part.id, title: part.title, who: who(part) }))}
			open={open}
			onToggle={onToggle}
		/>
	);
}
