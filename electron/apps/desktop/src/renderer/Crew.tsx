import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	formatAccelerator,
	formatTime,
	agentOptionKindOf,
	composedSpec,
	resolveCrew,
	specAsTemplate,
	templateLookup,
	type CrewLibrary,
	commentCount,
	crewAgentCountLabel,
	crewLevelCountLabel,
	crewLabel,
	planBlocked,
	planDifferences,
	planDifferenceText,
	planPartCountLabel,
	planSplitLabel,
	t,
	type CrewPlanDifference,
	type AgentTask,
	type CrewPlan,
	type CrewPlanPart,
	type CrewQuestion,
	type CrewReportSummary,
	type CrewSpec,
	type CrewSpecAgent,
	type CrewTemplate,
	type EventRecord,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { Button, Chevron, Popup, PopupMarks } from './ui/Controls';
import { TextInput, TextArea } from './ui/Input';
import styles from './Crew.module.css';
import { ChangeCounts } from './ui/ChangeCounts';
import { toastError } from './ui/Toast';
import { CrewEditor } from './CrewEditor';
import { markdown, MarkdownBlock, MarkdownStill } from './MarkdownBlock';
import { primaryKey } from './ui/primary-key';
/** Built-in names are stored in English and shown in the interface language (spec/crew-templates-and-editor#builtin-templates); the phone shows them too. */
export { crewLabel };
export function crewModel(
	agent: Pick<CrewSpecAgent, 'choiceNames' | 'requestedChoices'>
): string | null {
	const names = agent.choiceNames,
		options = agent.requestedChoices.configOptions ?? {};
	const key = Object.keys(options).find((id) => /model/i.test(id)) ?? Object.keys(options)[0];
	return key ? (names[key] ?? String(options[key])) : null;
}
/** spec/crew#compose: `model · effort` of a node as the provider named them; nothing when both are the provider's defaults. */
export function crewChoices(
	agent: Pick<CrewSpecAgent, 'choiceNames' | 'requestedChoices'>
): string | null {
	const options = agent.requestedChoices.configOptions ?? {},
		effort = Object.keys(options).find((id) => agentOptionKindOf(id) === 'effort');
	return (
		[crewModel(agent), effort ? (agent.choiceNames[effort] ?? String(options[effort])) : null]
			.filter(Boolean)
			.join(' · ') || null
	);
}
export function crewDepth(agent: CrewSpecAgent): number {
	return agent.agents.length ? 1 + Math.max(...agent.agents.map(crewDepth)) : 0;
}
export function crewCount(agent: CrewSpecAgent): number {
	return agent.agents.reduce((sum, child) => sum + 1 + crewCount(child), 0);
}
/** Launch crew: the foreman then each child by name with its provider glyph; a lead carries `(+N)`; the model lives in the tooltip. */
export function CrewRoster({
	spec,
	locale,
	unavailable = [],
}: {
	spec: CrewSpec;
	locale: Locale;
	unavailable?: string[];
}) {
	const chip = (agent: CrewSpecAgent, foreman: boolean) => {
		const model = crewModel(agent),
			count = crewCount(agent),
			warn = unavailable.includes(agent.id);
		return (
			<span
				key={agent.id}
				className={styles.chip}
				data-warning={warn}
				title={
					model ? `${crewLabel(locale, agent.name)} · ${model}` : crewLabel(locale, agent.name)
				}>
				{foreman || agent.role === 'foreman' ? (
					<Glyph name="helmet" size={11} />
				) : (
					<Glyph name={agent.provider === 'claude' ? 'claude' : 'openai'} size={11} />
				)}
				<span>{crewLabel(locale, agent.name)}</span>
				{foreman && model && <small>· {model}</small>}
				{!foreman && count > 0 && <small>(+{count})</small>}
				{warn && model && <small>· {model}</small>}
			</span>
		);
	};
	return (
		<div className={styles.roster} data-crew-roster>
			{chip(spec.root, true)}
			{spec.root.agents.map((agent) => chip(agent, false))}
		</div>
	);
}
/** Launch crew popup rows: `<name>  <count>` or `<count> · <levels>` for two-level crews. */
export function crewTemplateTail(locale: Locale, template: CrewTemplate): string {
	const count = (agent: CrewTemplate['root']): number =>
			(agent.agents ?? []).reduce((sum, child) => sum + 1 + count(child), 0),
		depth = (agent: CrewTemplate['root']): number =>
			agent.agents?.length ? 1 + Math.max(...agent.agents.map(depth)) : 0;
	const agents = count(template.root),
		levels = depth(template.root);
	return levels > 1 ? `${agents} · ${crewLevelCountLabel(locale, levels)}` : String(agents);
}
export function crewHeader(locale: Locale, spec: CrewSpec): string {
	return `${t(locale, 'Foreman').toLocaleLowerCase(locale)} + ${crewAgentCountLabel(locale, crewCount(spec.root))} · ${crewLevelCountLabel(locale, crewDepth(spec.root))}`;
}
/** spec/chat-turns-plans-and-questions#plan-row: the plan card as a brief in the foreman's chat, editable until the human decides (spec/crew#task-type, spec/crew-templates-and-editor#after-launch). */
export function PlanCard({
	plan,
	spec: taskSpec,
	task,
	revision,
	locale,
	disabled,
	send,
}: {
	plan: CrewPlan;
	spec: CrewSpec;
	/** None — the intro's sample window (spec/settings-modules-and-onboarding#intro-steps): the summary without file links, nothing read through main. */ task: AgentTask | null;
	revision: number;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const [parts, setParts] = useState<CrewPlanPart[]>(plan.parts);
	// spec/crew#compose: a composing foreman's crew comes with the plan; the person edits it in the crew editor before approving both.
	const [crew, setCrew] = useState<CrewSpecAgent[] | null>(plan.crew ?? null),
		[library, setLibrary] = useState<CrewLibrary | null>(null);
	const spec = crew ? composedSpec(taskSpec, crew) : taskSpec,
		crewEdited = !!plan.crew && JSON.stringify(crew) !== JSON.stringify(plan.crew);
	const editCrew = () => {
		void window.brigadir
			.readTemplates()
			.then(setLibrary, () => toastError(t(locale, 'The templates could not be read.')));
	};
	const crewDone = (template: CrewTemplate) => {
		if (!library) return;
		try {
			setCrew(
				resolveCrew(template, {
					lookup: templateLookup(library.agents),
					defaultProvider: taskSpec.root.provider,
				}).root.agents
			);
			setLibrary(null);
		} catch {
			// spec/notifications-slack-notes-and-schedules#message-classes: the action and the object, not the resolver's raw message (the editor already blocks Done on issues).
			toastError(t(locale, 'Could not apply the edited crew.'));
		}
	};
	const templateName = (id: string | undefined) =>
		id
			? (taskSpec.compose?.templates.find((item) => item.template === id || item.id === id)?.name ??
				library?.agents.find((item) => item.id === id)?.name)
			: undefined;
	const agents = spec.root.agents.filter((agent) => agent.role !== 'reviewer'),
		reviewers = spec.root.agents.filter((agent) => agent.role === 'reviewer');
	const differences = planDifferences(spec, spec.root.id, parts),
		blocked = planBlocked(differences),
		edited = JSON.stringify(parts) !== JSON.stringify(plan.parts);
	const incomplete = parts.some((part) => !part.title.trim() || !part.prompt.trim());
	const update = (id: string, patch: Partial<CrewPlanPart>) =>
		setParts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	const text = (difference: CrewPlanDifference) => planDifferenceText(locale, difference, parts);
	const blockedParts = parts.flatMap((part, index) =>
		differences.some((item) => item.partId === part.id && item.code !== 'idle_agent')
			? [index + 1]
			: []
	);
	const general = differences.filter((item) => item.partId === null),
		number = new Intl.NumberFormat(locale);
	const names = reviewers.map((item) => crewLabel(locale, item.name)).join(', ');
	const footer = blockedParts.length
		? t(
				locale,
				blockedParts.length === 1
					? 'Part {n}: differences with the crew. Start waits for a fix.'
					: 'Parts {n}: differences with the crew. Start waits for a fix.'
			).replace('{n}', blockedParts.map((item) => number.format(item)).join(', '))
		: general.some((item) => item.code === 'empty')
			? text(general.find((item) => item.code === 'empty')!)
			: incomplete
				? t(locale, 'Every part needs a title and a prompt.')
				: [
						planSplitLabel(locale, parts.length, new Set(parts.map((part) => part.agent)).size),
						...(reviewers.length
							? [
									t(
										locale,
										reviewers.length === 1 ? '{names} checks each' : '{names} check each'
									).replace('{names}', names),
								]
							: []),
						...general.map(text),
					].join(' · ');
	return (
		<section
			className={styles.plan}
			data-plan-id={plan.id}
			aria-label={t(locale, 'The foreman proposes a split')}>
			<header>
				<Glyph name="helmet" size={16} />
				<strong>{t(locale, 'The foreman proposes a split')}</strong>
				<small title={spec.root.agents.map((item) => crewLabel(locale, item.name)).join(', ')}>
					<span className={styles.glyphs}>
						{spec.root.agents.map((item) => (
							<Glyph key={item.id} name={agentGlyph(item)} size={10} />
						))}
					</span>
					{crew
						? t(locale, 'crew from the foreman')
						: `${t(locale, 'Crew').toLocaleLowerCase(locale)} ${crewLabel(locale, spec.name)}`}{' '}
					· {crewAgentCountLabel(locale, crewCount(spec.root))}
				</small>
			</header>
			{plan.summary && (
				<PlanSummaryText
					id={plan.id}
					text={plan.summary}
					task={task}
					locale={locale}
					revision={revision}
				/>
			)}
			{crew && (
				<div className={styles.planCrew} data-plan-crew data-edited={crewEdited || undefined}>
					<div className={styles.planCrewHead} data-size="s">
						<strong>{t(locale, 'Crew members')}</strong>
						{crewEdited && <small>{t(locale, 'edited')}</small>}
						<Button disabled={disabled} onClick={editCrew}>
							<Glyph name="edit" size={11} />
							{t(locale, 'Edit crew…')}
						</Button>
					</div>
					<div role="list" aria-label={t(locale, 'Crew members')}>
						{crew.map((agent) => {
							const choices = crewChoices(agent),
								template = templateName(agent.template),
								checks = crew.filter((item) => item.checkedBy.includes(agent.id));
							return (
								<div
									role="listitem"
									key={agent.id}
									className={styles.member}
									data-crew-member={agent.id}>
									<Glyph name={agentGlyph(agent)} size={11} />
									<strong>{crewLabel(locale, agent.name)}</strong>
									{template && <small>{crewLabel(locale, template)}</small>}
									{choices && <small className={styles.memberModel}>{choices}</small>}
									{checks.length > 0 && (
										<small>
											{t(locale, 'checks {names}').replace(
												'{names}',
												checks.map((item) => crewLabel(locale, item.name)).join(', ')
											)}
										</small>
									)}
									{agent.summary && (
										<span className={styles.memberSummary} title={agent.summary}>
											{agent.summary}
										</span>
									)}
									{agent.zone.length > 0 && (
										<span className={styles.memberZone}>
											{agent.zone.map((path) => (
												<code key={path}>{path}</code>
											))}
										</span>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
			{library && crew && (
				<CrewEditor
					template={specAsTemplate(spec, (id) => library.agents.some((item) => item.id === id))}
					library={library}
					locale={locale}
					oneOff
					rootLocked
					close={() => setLibrary(null)}
					done={crewDone}
					libraryChanged={setLibrary}
				/>
			)}
			<ol aria-label={t(locale, 'Plan parts')}>
				{parts.map((part, index) => {
					const agent = agents.find((item) => item.name === part.agent),
						issues = differences.filter((item) => item.partId === part.id),
						warning = issues.length > 0;
					return (
						<li key={part.id} data-plan-part={part.id} data-warning={warning}>
							<div className={styles.partRow} data-size="s">
								<span className={styles.partIndex}>{number.format(index + 1)}</span>
								<TextInput
									aria-label={`${t(locale, 'Part')} ${index + 1}`}
									value={part.title}
									disabled={disabled}
									maxLength={80}
									onChange={(event) => update(part.id, { title: event.target.value })}
								/>
								<small>{t(locale, 'assigned to')}</small>
								{/* spec/crew#activity: a tint chip without a chevron; its list ticks the part's agent. */}
								<span className={styles.agent} data-warning={warning}>
									<PopupMarks.Provider value>
										<Popup
											label={t(locale, 'Agent')}
											chip
											align="end"
											disabled={disabled}
											value={agent?.id ?? ''}
											options={agents.map((item) => ({
												value: item.id,
												label: crewLabel(locale, item.name),
												icon: <Glyph name={agentGlyph(item)} size={11} />,
											}))}
											onChange={(value) => {
												const next = agents.find((item) => item.id === value);
												if (next) update(part.id, { agent: next.name });
											}}
											{...(agent ? {} : { displayValue: part.agent })}
										/>
									</PopupMarks.Provider>
								</span>
							</div>
							{(part.files.length > 0 || part.scopes.length > 0) && (
								<p className={styles.partFiles}>
									{part.files.map((file) => (
										<code key={file}>{file}</code>
									))}
									{part.scopes.map((scope) => (
										<span key={scope} className={styles.tag}>
											{scope}
										</span>
									))}
								</p>
							)}
							<PartPrompt
								part={part}
								index={index}
								locale={locale}
								disabled={disabled}
								onChange={(prompt) => update(part.id, { prompt })}
							/>
							{issues.map((item, i) => (
								<p key={i} className={styles.issue}>
									<Glyph name="review-warning" size={11} />
									{text(item)}
								</p>
							))}
						</li>
					);
				})}
			</ol>
			<footer data-size="m">
				<span className={styles.differences} data-blocked={blockedParts.length > 0 || blocked}>
					{footer}
				</span>
				<Button
					disabled={disabled}
					onClick={() =>
						send({ kind: 'decidePlan', decision: { id: plan.id, approved: false, parts: null } })
					}>
					{t(locale, 'Reject')}
				</Button>
				<Button
					appearance="primary"
					disabled={disabled || blocked || incomplete}
					onClick={() =>
						send({
							kind: 'decidePlan',
							decision: {
								id: plan.id,
								approved: true,
								parts: edited ? parts.map((part) => ({ ...part, title: part.title.trim() })) : null,
								...(crewEdited && crew ? { crew } : {}),
							},
						})
					}>
					{t(locale, 'Start workers')}
				</Button>
			</footer>
		</section>
	);
}
/** The foreman's reasoning above the parts: chat markdown, as the agent's plan body (spec/chat-turns-plans-and-questions#plan-approval). */
function PlanSummaryText({
	id,
	text,
	task,
	locale,
	revision,
}: {
	id: string;
	text: string;
	task: AgentTask | null;
	locale: Locale;
	revision: number;
}) {
	const tokens = useMemo(() => markdown.parse(text, {}), [text]),
		html = useMemo(() => markdown.renderer.render(tokens, markdown.options, {}), [tokens]);
	return (
		<div className={styles.summary} data-plan-summary-text>
			{task ? (
				<MarkdownBlock
					rowId={`plan-summary:${id}`}
					html={html}
					tokens={tokens}
					locale={locale}
					task={task}
					revision={revision}
				/>
			) : (
				<MarkdownStill html={html} />
			)}
		</div>
	);
}

function agentGlyph(
	agent: Pick<CrewSpecAgent, 'role' | 'provider'>
): 'helmet' | 'claude' | 'openai' {
	return agent.role === 'foreman' ? 'helmet' : agent.provider === 'claude' ? 'claude' : 'openai';
}
/** spec/chat-turns-plans-and-questions#plan-row: two lines of the worker prompt, `Whole prompt` unfolds it; edit in place, ⌘↩ closes, Esc restores. */
function PartPrompt({
	part,
	index,
	locale,
	disabled,
	onChange,
}: {
	part: CrewPlanPart;
	index: number;
	locale: Locale;
	disabled: boolean;
	onChange(prompt: string): void;
}) {
	const [open, setOpen] = useState(false),
		[editing, setEditing] = useState<string | null>(null),
		[clamped, setClamped] = useState(false);
	const text = useRef<HTMLDivElement>(null),
		field = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const node = text.current;
		if (!node || open) return;
		const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [part.prompt, open, editing]);
	useEffect(() => {
		if (editing !== null) {
			const node = field.current;
			node?.focus();
			node?.setSelectionRange(node.value.length, node.value.length);
		}
	}, [editing !== null]);
	const label = `${t(locale, 'Prompt')} ${index + 1}`;
	if (editing !== null)
		return (
			<div className={styles.promptEdit}>
				<TextArea
					ref={field}
					aria-label={label}
					rows={4}
					value={part.prompt}
					onChange={(event) => onChange(event.target.value)}
					onBlur={() => setEditing(null)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && primaryKey(event)) {
							event.preventDefault();
							setEditing(null);
						}
						if (event.key === 'Escape') {
							event.preventDefault();
							event.stopPropagation();
							onChange(editing);
							setEditing(null);
						}
					}}
				/>
				<small>
					<span>
						{t(locale, 'Done')} {formatAccelerator('CmdOrCtrl+Enter')}
					</span>
				</small>
			</div>
		);
	return (
		<div className={styles.prompt}>
			<div ref={text} className={styles.promptText} data-open={open}>
				{part.prompt}
			</div>
			{!disabled && (
				<Button
					size="s"
					className={styles.promptEditButton}
					aria-label={`${t(locale, 'Edit prompt')} · ${label}`}
					onClick={() => setEditing(part.prompt)}>
					<Glyph name="edit" size={11} />
					{t(locale, 'Edit prompt')}
				</Button>
			)}
			{(clamped || open) && (
				<Button
					size="s"
					appearance="primary"
					variant="ghost"
					className={styles.promptMore}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}>
					{t(locale, open ? 'Collapse prompt' : 'Whole prompt')}
				</Button>
			)}
		</div>
	);
}
/** spec/chat-turns-plans-and-questions#plan-row: after the decision the card folds into one framed row; the chevron lists the parts read-only. */
export function PlanSummary({
	plan,
	parts,
	approved,
	at,
	spec,
	locale,
	open,
	onToggle,
}: {
	plan: CrewPlan;
	parts: readonly CrewPlanPart[] | null;
	approved: boolean;
	at: string;
	spec: CrewSpec | null;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
}) {
	const items = parts ?? plan.parts,
		number = new Intl.NumberFormat(locale);
	const glyph = (name: string) => {
		const agent = spec?.root.agents.find((item) => item.name === name);
		return agent ? <Glyph name={agentGlyph(agent)} size={10} /> : null;
	};
	const agent = (name: string) => (
		<span key={name} className={styles.summaryAgent}>
			{glyph(name)}
			{crewLabel(locale, name)}
		</span>
	);
	return (
		<details
			className={styles.planSummary}
			data-plan-summary={plan.id}
			data-approved={approved}
			open={open}
			onToggle={onToggle}>
			<summary>
				<Glyph name="helmet" size={13} />
				<strong>{t(locale, approved ? 'Plan approved' : 'Plan rejected')}</strong>
				<small>{planPartCountLabel(locale, items.length)}</small>
				<span className={styles.summaryTail}>
					{approved ? (
						[...new Set(items.map((item) => item.agent))].map(agent)
					) : (
						<small>{t(locale, 'the foreman will make a new plan')}</small>
					)}
				</span>
				<time dateTime={at}>{formatTime(at)}</time>
				<Chevron />
			</summary>
			<ol>
				{items.map((item, index) => (
					<li key={item.id}>
						<span>{number.format(index + 1)}</span>
						<span>{item.title}</span>
						{agent(item.agent)}
					</li>
				))}
			</ol>
		</details>
	);
}
function Counts({ report, locale }: { report: CrewReportSummary; locale: Locale }) {
	return (
		<ChangeCounts
			additions={report.additions}
			deletions={report.deletions}
			locale={locale}
			className={styles.counts}
		/>
	);
}
/** Crew activity: service rows of the crew in the foreman's activity (spec/crew-templates-and-editor#after-launch, spec/crew#notes). */
export function CrewEventRow({
	record,
	locale,
	tasks,
	pendingQuestions,
	disabled,
	send,
}: {
	record: EventRecord;
	locale: Locale;
	tasks: readonly AgentTask[];
	pendingQuestions: readonly CrewQuestion[];
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const e = record.event;
	const name = (agent: string) => crewLabel(locale, agent);
	if (e.kind === 'turn.started' && e.crew) {
		const marker = e.crew;
		if (marker.kind === 'report' || marker.kind === 'branch-report') {
			const report = marker.report;
			return (
				<div className={styles.service} data-crew-row="report">
					<Glyph name="agent-idle" size={12} />
					<small>{t(locale, 'report')}</small>
					<span className={styles.label}>
						<span>{name(report.name)} · </span>
						{report.title}
					</span>
					<Counts report={report} locale={locale} />
					{report.outside > 0 && (
						<small className={styles.warn}>
							{t(locale, 'outside the zone: {n}').replace('{n}', String(report.outside))}
						</small>
					)}
					{report.verdict === 'approved' && (
						<small className={styles.ok}>{t(locale, 'approved')}</small>
					)}
					{report.verdict === 'disputed' && (
						<small className={styles.warn}>{t(locale, 'disputed')}</small>
					)}
				</div>
			);
		}
		// spec/crew#parts: the dropped part shows as its own service row (crew.part.dropped); the prompt to the foreman adds none.
		if (marker.kind === 'question' || marker.kind === 'part-dropped') return null;
		return (
			<div className={styles.service} data-crew-row="plan-decision">
				<Glyph name="helmet" size={12} />
				<small>{t(locale, marker.approved ? 'Plan approved' : 'Plan rejected')}</small>
			</div>
		);
	}
	// spec/chat-turns-plans-and-questions#plan-row: the decision shows as the folded summary on the card's place (Conversation).
	if (e.kind === 'crew.plan.resolved') return null;
	// spec/crew#parts: the next part of a member is the same service row as its creation.
	if (e.kind === 'crew.worker.created' || e.kind === 'crew.part.started')
		return (
			<div className={styles.service} data-crew-row="worker">
				<Glyph name="agent-run" size={12} />
				<small>{t(locale, 'worker')}</small>
				<span className={styles.label}>
					<span>{name(e.name)} · </span>
					{e.title}
				</span>
			</div>
		);
	if (e.kind === 'crew.part.dropped')
		return (
			<div className={styles.service} data-crew-row="part-dropped">
				<Glyph name="agent-run" size={12} />
				<small>{t(locale, 'worker')}</small>
				<span className={styles.label}>
					<span>{name(e.name)} · </span>
					{t(locale, 'merge aborted, part withdrawn')}
				</span>
			</div>
		);
	if (e.kind === 'crew.note')
		return (
			<div className={styles.service} data-crew-row="note">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<rect
						x="3"
						y="2.4"
						width="10"
						height="11.2"
						rx="1.6"
						stroke="currentColor"
						strokeWidth="1.2"
					/>
					<path
						d="M5.6 6h4.8M5.6 8.6h4.8M5.6 11.2h3"
						stroke="currentColor"
						strokeWidth="1.2"
						strokeLinecap="round"
					/>
				</svg>
				<small>{t(locale, 'note')}</small>
				<span className={styles.label}>
					<span>{name(e.note.author)} · </span>
					{e.note.text}
				</span>
				{e.note.files?.[0] && <code>{e.note.files[0].split('/').at(-1)}</code>}
			</div>
		);
	if (e.kind === 'crew.question.requested') {
		const pending = pendingQuestions.find((item) => item.id === e.question.id);
		if (!pending) return null;
		return <CrewQuestionRow question={pending} locale={locale} disabled={disabled} send={send} />;
	}
	// spec/chat#tool-calls: the answer folds into its plate (CrewAnswerRow, with the fold state from Conversation).
	if (e.kind === 'crew.question.resolved') return null;
	if (e.kind === 'crew.review')
		return (
			<div className={styles.service} data-crew-row="review" data-state={e.state}>
				<Glyph name="review" size={12} />
				<small>{t(locale, 'check')}</small>
				<span className={styles.label}>
					<span>{name(e.reviewer)} · </span>
					{name(e.name)}
				</span>
				<small>{t(locale, 'round {n} of 2').replace('{n}', String(e.round))}</small>
				{e.state === 'approved' || (e.approved && e.state === 'reviewing') ? (
					<small className={styles.ok}>{t(locale, 'approved')}</small>
				) : e.state === 'disputed' ? (
					<small className={styles.warn}>{t(locale, 'disputed')}</small>
				) : e.comments > 0 ? (
					<small>{commentCount(locale, e.comments)}</small>
				) : null}
			</div>
		);
	if (e.kind === 'crew.accepted')
		return (
			<div
				className={styles.service}
				data-crew-row="accepted"
				data-conflicts={e.conflicts.length > 0}>
				<Glyph name="agent-idle" size={12} />
				<small>{t(locale, 'accepted')}</small>
				<span className={styles.label}>{name(e.name)}</span>
				{e.conflicts.length > 0 && (
					<small className={styles.warn}>
						{t(locale, 'Merge conflicts: {files}').replace('{files}', e.conflicts.join(', '))}
					</small>
				)}
			</div>
		);
	if (e.kind === 'crew.worker.stopped')
		return (
			<div className={styles.service} data-crew-row="stopped">
				<Glyph name="agent-failed" size={12} />
				<small>{t(locale, 'stopped')}</small>
				<span className={styles.label}>{name(e.name)}</span>
				<small className={styles.warn}>
					{t(locale, 'The worker stopped: {reason}').replace('{reason}', e.reason)}
				</small>
			</div>
		);
	void tasks;
	return null;
}
/**
 * spec/chat#tool-calls: an answered crew question is one plate like the waiting row —
 * `question · Agent · text · answered by foreman`. The chevron unfolds the answer; the whole plate hovers (rule 15).
 */
export function CrewAnswerRow({
	question,
	answer,
	answeredBy,
	locale,
	open,
	onToggle,
}: {
	question: CrewQuestion | null;
	answer: string | null;
	answeredBy: 'foreman' | 'human' | null;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
}) {
	const who =
		answer === null
			? t(locale, 'Interrupted')
			: t(locale, answeredBy === 'human' ? 'answered by you' : 'answered by the foreman');
	const head = (
		<>
			<Glyph name="question" size={12} />
			<small>{t(locale, 'question')}</small>
			<span className={styles.label}>
				{question && <span>{crewLabel(locale, question.agent)} · </span>}
				{question?.question ?? answer}
			</span>
			<small>{who}</small>
		</>
	);
	if (answer === null)
		return (
			<div className={`${styles.service} ${styles.answer}`} data-crew-row="answer">
				{head}
			</div>
		);
	return (
		<details className={styles.answer} data-crew-row="answer" open={open} onToggle={onToggle}>
			<summary className={styles.service}>
				<Chevron />
				{head}
			</summary>
			<p>{answer}</p>
		</details>
	);
}
/** Amber question row: the foreman answers; after five minutes the human may (spec/crew#ask-foreman). */
export function CrewQuestionRow({
	question,
	locale,
	disabled,
	send,
}: {
	question: CrewQuestion;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const [answer, setAnswer] = useState('');
	const escalated = question.state === 'escalated';
	return (
		<div className={styles.question} data-crew-row="question" data-escalated={escalated}>
			<div className={styles.service}>
				<Glyph name="question" size={12} />
				<small>{t(locale, 'question')}</small>
				<span className={styles.label}>
					<span>{crewLabel(locale, question.agent)} · </span>
					{question.question}
				</span>
				{!escalated && <small>{t(locale, 'waiting for the foreman')}</small>}
			</div>
			{escalated && (
				<div className={styles.escalation} data-size="m">
					<p>{t(locale, 'The foreman did not answer in five minutes. You can answer for it.')}</p>
					{question.options.length > 0 && (
						<div className={styles.options}>
							{question.options.map((option) => (
								<Button
									key={option}
									disabled={disabled}
									onClick={() =>
										send({ kind: 'answerCrewQuestion', id: question.id, answer: option })
									}>
									{option}
								</Button>
							))}
						</div>
					)}
					<TextArea
						rows={1}
						aria-label={t(locale, 'Answer')}
						placeholder={t(locale, 'Your answer…')}
						value={answer}
						disabled={disabled}
						onChange={(event) => setAnswer(event.target.value)}
					/>
					<Button
						appearance="primary"
						disabled={disabled || !answer.trim()}
						onClick={() =>
							send({ kind: 'answerCrewQuestion', id: question.id, answer: answer.trim() })
						}>
						{t(locale, 'Submit answer')}
					</Button>
				</div>
			)}
		</div>
	);
}
