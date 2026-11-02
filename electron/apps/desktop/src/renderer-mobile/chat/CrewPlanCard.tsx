/**
 * spec/chat-turns-plans-and-questions#plan-row, spec/remote-access-and-mobile#phone-app: the foreman's split on the phone — the reasoning, the parts with their files
 * and the worker as a picker (a sheet of the crew's agents), «Відхилити» / «Запустити воркерів». The parts' text is read here,
 * not edited: editing a prompt belongs to the computer.
 */
import { create } from 'zustand';
import {
	crewLabel,
	planBlocked,
	planDifferences,
	planSplitLabel,
	t,
	type AgentTask,
	type CrewPlan,
	type CrewPlanPart,
	type CrewSpec,
	type CrewSpecAgent,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { Glyph } from '../../renderer/ui/Glyph';
import { markdown } from '../../renderer/markdown';
import { Icon } from '../ui/Icon';
import { openSheet } from '../router';
import s from './Cards.module.css';

/** The person's choice of workers while the card waits, by plan id: the card and the picker sheet share it. */
export const usePlanEdits = create<{
	parts: Record<string, CrewPlanPart[]>;
	set(planId: string, parts: CrewPlanPart[]): void;
}>((set) => ({
	parts: {},
	set: (planId, parts) => set((state) => ({ parts: { ...state.parts, [planId]: parts } })),
}));
export function planAgents(plan: CrewPlan, task: AgentTask): CrewSpecAgent[] {
	return (plan.crew ?? task.crew?.root.agents ?? []).filter((agent) => agent.role !== 'reviewer');
}
const composed = (spec: CrewSpec, plan: CrewPlan): CrewSpec =>
	plan.crew ? { ...spec, root: { ...spec.root, agents: plan.crew } } : spec;
export function CrewPlanCard({
	plan,
	task,
	locale,
	disabled,
	send,
}: {
	plan: CrewPlan;
	task: AgentTask;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const edited = usePlanEdits((state) => state.parts[plan.id]),
		parts = edited ?? plan.parts;
	const agents = planAgents(plan, task),
		reviewers = (plan.crew ?? task.crew?.root.agents ?? []).filter(
			(agent) => agent.role === 'reviewer'
		);
	const spec = task.crew ? composed(task.crew, plan) : null,
		blocked = spec ? planBlocked(planDifferences(spec, spec.root.id, parts)) : false;
	const footer = [
		planSplitLabel(locale, parts.length, new Set(parts.map((part) => part.agent)).size),
		...(reviewers.length
			? [
					t(locale, reviewers.length === 1 ? '{names} checks each' : '{names} check each').replace(
						'{names}',
						reviewers.map((item) => crewLabel(locale, item.name)).join(', ')
					),
				]
			: []),
	].join(' · ');
	return (
		<section
			className={s.plan}
			data-plan-id={plan.id}
			aria-label={t(locale, 'The foreman proposes a split')}>
			<header className={s.planHead}>
				<Glyph name="helmet" size={18} />
				<span>{t(locale, 'The foreman proposes a split')}</span>
			</header>
			{plan.summary && (
				<div
					className={s.lead}
					dangerouslySetInnerHTML={{ __html: markdown.render(plan.summary) }}
				/>
			)}
			{parts.map((part, index) => {
				const agent = agents.find((item) => item.name === part.agent);
				return (
					<div key={part.id} className={s.part} data-plan-part={part.id}>
						<span className={s.number}>{index + 1}</span>
						<div className={s.partBody}>
							<b>{part.title}</b>
							{(part.files.length > 0 || part.scopes.length > 0) && (
								<span className={`mono ${s.files}`}>
									{[...part.files, ...part.scopes].join(' · ')}
								</span>
							)}
							<button
								type="button"
								className={s.who}
								disabled={disabled}
								aria-haspopup="dialog"
								data-plan-agent
								onClick={() => openSheet({ kind: 'agent', planId: plan.id, partId: part.id })}>
								{agent?.provider && (
									<Glyph name={agent.provider === 'claude' ? 'claude' : 'openai'} size={13} />
								)}
								{crewLabel(locale, part.agent)}
								<Icon name="chev" size={14} />
							</button>
						</div>
					</div>
				);
			})}
			<footer className={s.planFoot}>
				<small>{footer}</small>
				<div className={s.pair} data-size="l">
					<Button
						disabled={disabled}
						onClick={() =>
							send({ kind: 'decidePlan', decision: { id: plan.id, approved: false, parts: null } })
						}>
						{t(locale, 'Reject')}
					</Button>
					<Button
						appearance="primary"
						disabled={disabled || blocked}
						onClick={() =>
							send({
								kind: 'decidePlan',
								decision: { id: plan.id, approved: true, parts: edited ? parts : null },
							})
						}>
						{t(locale, 'Start workers')}
					</Button>
				</div>
			</footer>
		</section>
	);
}
