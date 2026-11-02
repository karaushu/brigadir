/**
 * spec/tasks#agent-created-tasks on the phone: the task the agent proposes with `create_task` keeps its task in «Потрібен ти» until the person answers,
 * so the phone answers it too — «Відхилити» or «Створити» (the same task the computer's card makes). «Відкрити в аркуші…» is the
 * computer's launch sheet and stays there. The card is the plan card's family, as on the computer.
 */
import { useState } from 'react';
import {
	providerName,
	t,
	taskProposalFolderName,
	type AgentTask,
	type Locale,
	type TaskProposal,
} from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { Glyph } from '../../renderer/ui/Glyph';
import s from './Cards.module.css';

const long = (prompt: string) => prompt.split('\n').length > 6 || prompt.length > 480;
const contextName = (locale: Locale, item: TaskProposal['context'][number]) =>
	item.kind === 'summary'
		? t(locale, 'Task summary')
		: item.kind === 'diff'
			? t(locale, 'Task diff')
			: item.kind === 'file'
				? (item.path.split('/').at(-1) ?? item.path)
				: item.name;
export function ProposalCard({
	proposal,
	task,
	locale,
	disabled,
}: {
	proposal: TaskProposal;
	task: AgentTask;
	locale: Locale;
	disabled: boolean;
}) {
	const [whole, setWhole] = useState(false),
		[busy, setBusy] = useState<'create' | 'decline' | null>(null),
		[failed, setFailed] = useState<'create' | 'decline' | null>(null);
	const agent = task.provider ? providerName(task.provider) : '',
		folded = long(proposal.prompt) && !whole,
		context = [
			...proposal.context.map((item) => contextName(locale, item)),
			...proposal.folders.map(taskProposalFolderName),
		];
	const act = async (kind: 'create' | 'decline') => {
		setBusy(kind);
		setFailed(null);
		try {
			const key = { projectId: task.projectId, id: task.id };
			if (kind === 'create') await window.brigadir.createProposedTask(key, proposal.id);
			else await window.brigadir.declineProposedTask(key, proposal.id);
		} catch {
			setFailed(kind);
		} finally {
			setBusy(null);
		}
	};
	return (
		<section className={s.plan} data-task-proposal={proposal.id} aria-label={t(locale, 'New task')}>
			<header className={s.planHead}>
				<Glyph name="task-new" size={16} />
				<span>{t(locale, 'New task')}</span>
				{agent && (
					<small className={s.headNote}>
						{t(locale, '{agent} proposes a task').replace('{agent}', agent)}
					</small>
				)}
			</header>
			<div className={s.lead}>
				{proposal.title && <b className={s.proposalTitle}>{proposal.title}</b>}
				<p className={s.prompt} data-folded={folded || undefined}>
					{proposal.prompt}
				</p>
				{long(proposal.prompt) && (
					<button
						type="button"
						className={s.whole}
						aria-expanded={whole}
						onClick={() => setWhole((value) => !value)}>
						{t(locale, whole ? 'Collapse prompt' : 'Whole prompt')}
					</button>
				)}
				{proposal.agent && (
					<small className={s.context} data-agent={proposal.agent.provider}>
						{[
							providerName(proposal.agent.provider),
							proposal.agent.modelName,
							proposal.agent.effortName,
						]
							.filter(Boolean)
							.join(' · ')}
					</small>
				)}
				{context.length > 0 && <small className={s.context}>{context.join(' · ')}</small>}
			</div>
			<footer className={s.planFoot}>
				<small role={failed ? 'alert' : undefined} data-error={failed ? '' : undefined}>
					{failed
						? t(
								locale,
								failed === 'create'
									? 'The task could not be created.'
									: 'Could not decline the task.'
							)
						: t(
								locale,
								proposal.start === 'now'
									? 'Starts once created · new branch'
									: 'Goes to the backlog · new branch'
							)}
				</small>
				<div className={s.pair} data-size="l">
					<Button
						disabled={disabled || busy !== null}
						data-proposal-decline
						onClick={() => void act('decline')}>
						{t(locale, 'Decline')}
					</Button>
					<Button
						appearance="primary"
						disabled={disabled || busy !== null}
						data-proposal-create
						onClick={() => void act('create')}>
						{t(locale, 'Create')}
					</Button>
				</div>
			</footer>
		</section>
	);
}
