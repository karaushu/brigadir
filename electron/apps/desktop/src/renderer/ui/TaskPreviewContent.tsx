import { t, type AgentTask, type Locale } from '@brigadir/core';
import s from './TaskPreviewContent.module.css';

/** Full, selectable task details inside the shared popover; absent metadata adds no empty rows. */
export function TaskPreviewContent({
	task,
	agent,
	status,
	provider,
	locale,
}: {
	task: AgentTask;
	agent: string;
	status: string;
	provider: AgentTask['provider'];
	locale: Locale;
}) {
	const fields = [
		[t(locale, 'Agent'), agent],
		[t(locale, 'Status'), status],
		[
			t(locale, 'Provider'),
			provider ? t(locale, provider === 'claude' ? 'Claude' : 'Codex') : null,
		],
		[t(locale, 'Model'), task.modelName],
		[t(locale, 'Effort'), task.effortName],
		[t(locale, 'Branch'), task.taskTree?.branch ?? task.worktreeBranch],
		[t(locale, 'Repos'), task.scopeNames?.join(', ')],
	];
	return (
		<div className={s.content}>
			<h3>{task.title}</h3>
			<dl>
				{fields
					.filter(([, value]) => value)
					.map(([label, value]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
			</dl>
			{task.prompt && (
				<section aria-label={t(locale, 'Description')}>
					<h4>{t(locale, 'Description')}</h4>
					<p>{task.prompt}</p>
				</section>
			)}
		</div>
	);
}
