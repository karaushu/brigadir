/**
 * spec/remote-access-and-mobile#phone-pr-list: a PR without a task hands work to an agent in a new task.
 * Review with an agent — the reviewer agent, Quick (no checkout, the default) or In a worktree; Resolve conflicts — only
 * Let the agent resolve, resolving by hand stays on the computer. After the start the task's chat opens.
 */
import { useEffect, useState } from 'react';
import {
	agentOptionKind,
	catalogOptions,
	selectOption,
	t,
	type AgentOption,
	type AgentProvider,
	type Locale,
	type PRRefKey,
	type PullRequestDetail,
} from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { Glyph } from '../../renderer/ui/Glyph';
import { Caption, Group, RowIcon, SectionHead, Sheet, SheetRow } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { back, navigate } from '../router';
import { useMobile, useOffline } from '../store';
import { loadPRList } from './prs';
import type { PRContext } from './PullRequest';
import sheets from '../screens/Sheets.module.css';
import s from './PullRequest.module.css';

const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).replace(
		/^Error invoking remote method '[^']+': (Error: )?/,
		''
	);
/** The agent a new task starts with: the machine's provider and its catalog's default model and effort. */
function useDefaultAgent() {
	const [agent, setAgent] = useState<{ provider: AgentProvider; name: string } | null>(null);
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const provider = (await window.brigadir.readSettings()).settings.agents.provider;
				// The provider at once; its default model and effort when the catalog answers.
				if (live) setAgent({ provider, name: provider === 'claude' ? 'Claude' : 'Codex' });
				const catalog = await window.brigadir.readProviderCatalog(provider);
				if (!catalog) return;
				const model = selectOption(catalog.options, 'model');
				const options: AgentOption[] = catalogOptions(catalog, model?.value);
				const effort = options.find(
					(option): option is Extract<AgentOption, { kind: 'select' }> =>
						option.kind === 'select' && agentOptionKind(option) === 'effort'
				);
				const name = [
					model?.choices.find((choice) => choice.value === model.value)?.name ?? model?.value,
					effort?.choices.find((choice) => choice.value === effort.value)?.name ?? effort?.value,
				]
					.filter(Boolean)
					.join(' · ');
				if (live)
					setAgent({ provider, name: name || (provider === 'claude' ? 'Claude' : 'Codex') });
			} catch {
				// The row says the provider only when the catalog cannot be read.
			}
		})();
		return () => {
			live = false;
		};
	}, []);
	return agent;
}
export function PRAgentSheet({
	mode,
	context,
	prRef,
	detail,
	locale,
}: {
	mode: 'review' | 'conflict';
	context: PRContext;
	prRef: PRRefKey;
	detail: PullRequestDetail;
	locale: Locale;
}) {
	const machine = useMobile((state) => state.machine),
		offline = useOffline(),
		agent = useDefaultAgent();
	const [where, setWhere] = useState<'quick' | 'worktree'>('quick'),
		[busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	const pr = detail.summary,
		review = mode === 'review';
	const start = async () => {
		setBusy(true);
		setError(null);
		try {
			const key = await context.key();
			let task;
			if (review)
				task = (await window.brigadir.startPullRequestAgent(key, prRef, 'review', false, where))
					.task;
			else {
				const result = await window.brigadir.resolvePullRequestConflicts(key, prRef, 'agent');
				task = result.task;
				// The task already on the PR branch takes the prompt in its chat; a new one started with it (spec/pull-requests-and-ci#resolve-conflicts).
				if (!result.created && result.prompt) {
					const target = { projectId: task.projectId, id: task.id };
					await window.brigadir.startSession(target).catch(() => null);
					await window.brigadir.sendCommand(target, { kind: 'prompt', text: result.prompt });
				}
			}
			void loadPRList(context.projectId, false);
			// The sheet's entry becomes the chat: «back» from it leads to the PR, as after any other step forward.
			navigate({ screen: 'task', projectId: task.projectId, taskId: task.id });
		} catch (reason) {
			setError(message(reason));
		} finally {
			setBusy(false);
		}
	};
	const title = `${t(locale, review ? 'Review with an agent' : 'Resolve conflicts')} · #${pr.number}`;
	return (
		<Sheet label={title} title={title} locale={locale} close={back}>
			<div data-pr-agent-sheet={mode}>
				<p className={`${sheets.dialogText} ${s.lead}`}>
					{review
						? t(
								locale,
								'The agent rereads the PR and leaves comments on the lines. They become drafts of your review: nothing goes to GitHub without you.'
							)
						: t(
								locale,
								'The agent merges {base} into {head} in a worktree on {machine} and resolves the conflict. The merge and the push are yours; a usual push updates the PR.'
							)
								.replace('{base}', pr.base)
								.replace('{head}', pr.head)
								.replace('{machine}', machine)}
				</p>
				<Group>
					<SheetRow
						icon={
							<RowIcon>
								<Icon name="plus" size={18} />
							</RowIcon>
						}
						title={t(locale, 'New task')}
						sub={
							<span className="ell">
								{t(locale, review ? 'Review' : 'Conflict')} #{pr.number} · {pr.title}
							</span>
						}
					/>
					<SheetRow
						icon={
							<RowIcon>
								<Glyph name={agent?.provider === 'codex' ? 'openai' : 'claude'} size={16} />
							</RowIcon>
						}
						title={agent?.name ?? '…'}
						sub={t(locale, review ? 'Reviewer · writes no code' : 'The project’s default agent')}
					/>
				</Group>
				{review && (
					<>
						<SectionHead>{t(locale, 'Where it works')}</SectionHead>
						<Group>
							{(['quick', 'worktree'] as const).map((place) => (
								<SheetRow
									key={place}
									role="menuitemradio"
									checked={where === place}
									icon={<span className={sheets.radio} data-on={where === place || undefined} />}
									title={t(locale, place === 'quick' ? 'Quickly' : 'In a worktree')}
									sub={
										place === 'quick'
											? t(locale, 'No checkout: the agent reads the diffs and files from GitHub')
											: t(
													locale,
													'The PR branch on {machine} — the agent can run the tests'
												).replace('{machine}', machine)
									}
									data={{ where: place }}
									onClick={() => setWhere(place)}
								/>
							))}
						</Group>
					</>
				)}
				{!review && (
					<Caption className={sheets.captionTop}>
						{t(
							locale,
							'Resolving by hand is on the computer: the merge strip and the editor are there.'
						)}
					</Caption>
				)}
				{error && <p className={s.error}>{error}</p>}
				<div className={s.send} data-size="xl">
					<Button
						appearance="primary"
						className={s.wide}
						data-pr-agent-start
						disabled={busy || offline}
						onClick={() => void start()}>
						<Icon name="spark" size={18} />
						{t(locale, review ? 'Start the review' : 'Hand to the agent (conflict)')}
					</Button>
				</div>
			</div>
		</Sheet>
	);
}
