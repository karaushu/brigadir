import {
	t,
	taskCount,
	scopeCount,
	type AgentTask,
	type Locale,
	type ScopeLockView,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { NoticeChip, NoticeLede, NoticeRepoRow, type NoticePlacement } from './ui/NoticeChip';
import { useWorkspace } from './store';
import styles from './ContentionChip.module.css';

/** spec/notifications-slack-notes-and-schedules#repo-contention: the fact behind a contended repo for this task — the repo and its owner set, in any order. A third task
 *  joining is a new fact, so the composer popover opens by itself once more. */
export const contentionKey = (task: Pick<AgentTask, 'projectId' | 'id'>, scope: ScopeLockView) =>
	`contention|${task.projectId}/${task.id}|${scope.path}|${scope.owners
		.map((owner) => `${owner.key.projectId}/${owner.key.id}`)
		.sort()
		.join(',')}`;

/** spec/notifications-slack-notes-and-schedules#repo-contention: contended repos as a NoticeChip —
 *  `kit · mixed changes` in the composer, `2 tasks` in the repo heading; the popover lists the tasks per repo. */
export function ContentionChip({
	task,
	locale,
	scopes,
	placement,
}: {
	task: AgentTask;
	locale: Locale;
	scopes: readonly ScopeLockView[];
	placement: NoticePlacement;
}) {
	const projectName = useWorkspace(
		(state) => state.workspace?.projects.find((project) => project.id === task.projectId)?.name
	);
	if (!scopes.length) return null;
	const name = (scope: ScopeLockView) =>
		scope.name === '.' ? (projectName ?? scope.name) : scope.name;
	const label =
		placement === 'repo'
			? taskCount(locale, scopes[0]!.owners.length)
			: scopes.length === 1
				? t(locale, '{repo} · mixed changes').replace('{repo}', name(scopes[0]!))
				: t(locale, '{repos} · mixed changes').replace(
						'{repos}',
						scopeCount(locale, scopes.length)
					);
	const me = `${task.projectId}/${task.id}`,
		id = (owner: ScopeLockView['owners'][number]) => `${owner.key.projectId}/${owner.key.id}`;
	return (
		<NoticeChip
			locale={locale}
			placement={placement}
			icon="scope-lock"
			label={label}
			data-contention-chip={placement}
			accessibleLabel={t(locale, 'Mixed changes: {repos}').replace(
				'{repos}',
				scopes.map(name).join(', ')
			)}
			facts={scopes.map((scope) => contentionKey(task, scope))}
			title={t(locale, 'Mixed changes')}
			autoNote={t(locale, 'Opened because another task writes to this repo.')}
			clickNote={t(locale, 'Opens by itself when another task joins the repo.')}>
			{(close) => (
				<>
					<NoticeLede>
						{t(
							locale,
							'The tasks write to one repo without isolation. Each diff also shows the others’ changes.'
						)}
					</NoticeLede>
					{scopes.map((scope) => (
						<section key={scope.path} data-contended-scope={name(scope)}>
							<NoticeRepoRow
								icon="scope-lock"
								name={name(scope)}
								count={taskCount(locale, scope.owners.length)}
							/>
							{[...scope.owners]
								.sort((a, b) => Number(id(b) === me) - Number(id(a) === me))
								.map((owner) =>
									id(owner) === me ? (
										<div key={me} className={styles.task}>
											<span className={styles.title}>{owner.title}</span>
											<small>{t(locale, 'this task')}</small>
										</div>
									) : (
										<button
											key={id(owner)}
											type="button"
											className={styles.task}
											title={t(locale, 'Open task')}
											onClick={() => {
												close(false);
												useWorkspace.getState().selectTask(owner.key.projectId, owner.key.id);
											}}>
											<span className={styles.title}>{owner.title}</span>
											<Glyph name="tree-right" size={9} />
										</button>
									)
								)}
						</section>
					))}
				</>
			)}
		</NoticeChip>
	);
}
