import { useState } from 'react';
import {
	describeRule,
	formatTime,
	providerName,
	t,
	taskProposalFolderName,
	type AgentTask,
	type Locale,
	type TaskProposal,
	type TaskProposalContext,
	type TaskProposalResult,
} from '@brigadir/core';
import { Button, Chevron } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { useWorkspace } from './store';
import { toastError } from './ui/Toast';
import styles from './TaskProposal.module.css';

const lines = (text: string) => text.split('\n').length;
function contextChip(item: TaskProposalContext, index: number, locale: Locale) {
	const [glyph, label, title]: [Parameters<typeof Glyph>[0]['name'], string, string | undefined] =
		item.kind === 'summary'
			? ['relay-summary', t(locale, 'Task summary'), undefined]
			: item.kind === 'diff'
				? [
						'relay-diff',
						item.full
							? `${t(locale, 'Task diff')} · ${t(locale, 'full patch')}`
							: t(locale, 'Task diff'),
						undefined,
					]
				: item.kind === 'file'
					? ['file', item.path.split('/').at(-1) ?? item.path, item.path]
					: ['paperclip', item.name, item.text.slice(0, 400)];
	return (
		<span
			key={`${item.kind}-${index}`}
			className={styles.chip}
			data-context={item.kind}
			title={title}>
			<Glyph name={glyph} size={12} />
			<span>{label}</span>
		</span>
	);
}
/** The chips under the prompt: the agent the proposal names (spec/tasks#agent-created-tasks), the context the new task gets, then the folders that
 *  join it (spec/projects-and-board#external-folders). */
function Chips({ proposal, locale }: { proposal: TaskProposal; locale: Locale }) {
	const agent = proposal.agent;
	if (!agent && !proposal.context.length && !proposal.folders.length) return null;
	return (
		<div className={styles.chips}>
			{agent && (
				<span className={styles.chip} data-agent={agent.provider}>
					<Glyph name={agent.provider === 'claude' ? 'claude' : 'openai'} size={12} />
					<span>
						{[providerName(agent.provider), agent.modelName, agent.effortName]
							.filter(Boolean)
							.join(' · ')}
					</span>
				</span>
			)}
			{proposal.context.map((item, index) => contextChip(item, index, locale))}
			{proposal.folders.map((folder) => (
				<span key={folder} className={styles.chip} data-folder title={folder}>
					<Glyph name="folder" size={12} />
					<span>{taskProposalFolderName(folder)}</span>
				</span>
			))}
		</div>
	);
}
function Prompt({ proposal, folded }: { proposal: TaskProposal; folded: boolean }) {
	return (
		<>
			{proposal.title && <strong className={styles.name}>{proposal.title}</strong>}
			<p className={styles.prompt} data-folded={folded}>
				{proposal.prompt}
			</p>
		</>
	);
}

/**
 * spec/tasks#agent-created-tasks: the task the agent proposes with `create_task`, a card in the chat of the plan card's family (spec/chat-turns-plans-and-questions#plan-row).
 * `Create` makes it in this project; `Open in the sheet…` opens the launch sheet filled with it; `Decline` answers no.
 */
export function TaskProposalCard({
	proposal,
	task,
	locale,
	disabled,
	onSheet,
}: {
	proposal: TaskProposal;
	task: AgentTask;
	locale: Locale;
	disabled: boolean;
	onSheet(proposal: TaskProposal): void;
}) {
	const agent = task.provider ? providerName(task.provider) : '',
		long = lines(proposal.prompt) > 6 || proposal.prompt.length > 480;
	const [whole, setWhole] = useState(false),
		[busy, setBusy] = useState<'create' | 'decline' | null>(null);
	// spec/notifications-slack-notes-and-schedules#message-classes: a failed answer is a toast with Retry, not a line in the card.
	const act = async (kind: 'create' | 'decline') => {
		setBusy(kind);
		try {
			if (kind === 'create') await window.brigadir.createProposedTask(task, proposal.id);
			else await window.brigadir.declineProposedTask(task, proposal.id);
		} catch {
			setBusy(null);
			toastError(
				t(
					locale,
					kind === 'create' ? 'The task could not be created.' : 'Could not decline the task.'
				),
				{
					action: {
						label: t(locale, 'Retry'),
						run: () => {
							void act(kind);
						},
					},
				}
			);
		}
	};
	return (
		<section
			className={styles.card}
			aria-label={t(locale, 'New task')}
			data-task-proposal={proposal.id}>
			<header className={styles.head}>
				<span className={styles.wait} aria-hidden="true" />
				<Glyph name="task-new" size={14} />
				<strong>{t(locale, 'New task')}</strong>
				{agent && (
					<small className={styles.hint}>
						{t(locale, '{agent} proposes a task').replace('{agent}', agent)}
					</small>
				)}
			</header>
			<div className={styles.body}>
				<Prompt proposal={proposal} folded={long && !whole} />
				{long && (
					<button
						type="button"
						className={styles.whole}
						aria-expanded={whole}
						onClick={() => setWhole((value) => !value)}>
						{t(locale, whole ? 'Collapse prompt' : 'Whole prompt')}
					</button>
				)}
				<Chips proposal={proposal} locale={locale} />
			</div>
			<footer className={styles.foot}>
				<small className={styles.note}>
					{proposal.start === 'schedule' && proposal.schedule
						? `${describeRule(locale, proposal.schedule.rule, proposal.schedule.timeZone)} · ${t(locale, 'Each run starts a new task.')}`
						: t(
								locale,
								proposal.start === 'now'
									? 'Starts once created · new branch'
									: 'Goes to the backlog · new branch'
							)}
				</small>
				<Button
					variant="ghost"
					disabled={disabled || busy !== null}
					onClick={() => {
						void act('decline');
					}}>
					{t(locale, 'Decline')}
				</Button>
				{/* spec/notifications-slack-notes-and-schedules#schedules: a proposed schedule is made from the card and edited in the Schedules section. */}
				{proposal.start !== 'schedule' && (
					<Button disabled={disabled || busy !== null} onClick={() => onSheet(proposal)}>
						{t(locale, 'Open in the sheet…')}
					</Button>
				)}
				<Button
					appearance="primary"
					disabled={disabled || busy !== null}
					onClick={() => {
						void act('create');
					}}>
					{t(locale, proposal.start === 'schedule' ? 'Schedule (verb)' : 'Create')}
				</Button>
			</footer>
		</section>
	);
}

/** After the answer the card folds into one row (spec/chat-turns-plans-and-questions#plan-approval); a created task opens from its arrow. */
export function TaskProposalSummary({
	proposal,
	created,
	at,
	locale,
	open,
	onToggle,
}: {
	proposal: TaskProposal;
	created: TaskProposalResult;
	at: string;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
}) {
	const title = created?.title ?? proposal.title ?? proposal.prompt.split('\n')[0] ?? '';
	// spec/notifications-slack-notes-and-schedules#schedules: a proposed schedule folds into «Schedule created», its arrow opens the Schedules section on it.
	const schedule = proposal.start === 'schedule';
	const go = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (!created) return;
		if (schedule)
			useWorkspace.getState().openSchedules({ projectId: created.projectId, id: created.id });
		else useWorkspace.getState().selectTask(created.projectId, created.id);
	};
	const openLabel = t(locale, schedule ? 'Open schedule' : 'Open task');
	return (
		<details
			className={styles.summary}
			data-task-proposal-summary={created ? 'created' : 'declined'}
			open={open}
			onToggle={onToggle}>
			<summary>
				{created ? (
					<Glyph name={schedule ? 'schedule' : 'agent-idle'} size={13} />
				) : (
					<Glyph name="xmark" size={13} />
				)}
				<strong>
					{t(
						locale,
						schedule
							? created
								? 'Schedule created'
								: 'Schedule not created'
							: created
								? 'Task created'
								: 'Task not created'
					)}
				</strong>
				<span className={styles.title}>{title}</span>
				<span className={styles.space} />
				<small className={styles.time}>{formatTime(at)}</small>
				{created && (
					<button
						type="button"
						className={styles.icon}
						aria-label={openLabel}
						title={openLabel}
						onClick={go}>
						<Glyph name="search-more" size={12} />
					</button>
				)}
				<Chevron />
			</summary>
			{open && (
				<div className={styles.body} data-open>
					<Prompt proposal={proposal} folded={false} />
					<Chips proposal={proposal} locale={locale} />
				</div>
			)}
		</details>
	);
}
