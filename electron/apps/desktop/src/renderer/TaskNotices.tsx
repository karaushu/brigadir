import {
	t,
	scopeCount,
	fileCount,
	type AgentTask,
	type EventRecord,
	type Locale,
	type Scope,
} from '@brigadir/core';
import {
	NoticeChip,
	NoticeLede,
	NoticeRepoName,
	NoticeRepoRow,
	type NoticePlacement,
} from './ui/NoticeChip';
import { AuthCard } from './AuthCard';
import { limitMinutes, rateResetLabel } from './RateLimit';
import styles from './TaskNotices.module.css';

/** spec/notifications-slack-notes-and-schedules#notice-chips: class S on the NoticeChip (spec/notifications-slack-notes-and-schedules#repo-contention) — no banner; a chip in the composer footer (the CLI shelf in a CLI task)
 *  and, where the state is about a repo, in its heading of the Changes panel. Each chip's popover opens by itself once
 *  per new fact (its key below). */
type Key = Pick<AgentTask, 'projectId' | 'id'>;
const taskId = (task: Key) => `${task.projectId}/${task.id}`;
const repoName = (name: string, projectName: string | undefined) =>
	name === '.' ? (projectName ?? name) : name;
const SHOWN_PATHS = 6;

type Violation = { scopeId: string; name: string; paths: string[]; seq: number };
/** The last read-only warning of each repo, and the files the one before it did not list (they are «new»). */
export function readOnlyViolations(
	records: readonly EventRecord[]
): (Violation & { fresh: string[] })[] {
	const all = records.flatMap((record) =>
		record.event.kind === 'scope.violation'
			? [
					{
						scopeId: record.event.scopeId,
						name: record.event.name,
						paths: record.event.paths,
						seq: record.seq,
					},
				]
			: []
	);
	const last = new Map<string, Violation>(),
		previous = new Map<string, Violation>();
	for (const item of all) {
		const before = last.get(item.scopeId);
		if (before) previous.set(item.scopeId, before);
		last.set(item.scopeId, item);
	}
	return [...last.values()].map((item) => {
		const before = previous.get(item.scopeId);
		return {
			...item,
			fresh: before ? item.paths.filter((path) => !before.paths.includes(path)) : [],
		};
	});
}
/** Fact: the task, the repo and its sorted file list — another file changing is a new fact. */
export const readOnlyKey = (task: Key, item: Pick<Violation, 'scopeId' | 'paths'>) =>
	`readonly|${taskId(task)}|${item.scopeId}|${[...item.paths].sort().join(',')}`;

export function ReadOnlyChip({
	task,
	locale,
	records,
	projectName,
	placement = 'composer',
}: {
	task: Key;
	locale: Locale;
	records: readonly EventRecord[];
	projectName?: string | undefined;
	placement?: NoticePlacement;
}) {
	const items = readOnlyViolations(records);
	if (!items.length) return null;
	const name = (item: Violation) => repoName(item.name, projectName);
	const label =
		items.length === 1
			? t(locale, '{repo} · changed').replace('{repo}', name(items[0]!))
			: t(locale, '{repos} · changed').replace('{repos}', scopeCount(locale, items.length));
	return (
		<NoticeChip
			locale={locale}
			placement={placement}
			icon="review-warning"
			label={label}
			data-readonly-chip={placement}
			accessibleLabel={t(locale, 'A read-only repo changed: {repos}').replace(
				'{repos}',
				items.map(name).join(', ')
			)}
			facts={items.map((item) => readOnlyKey(task, item))}
			title={t(locale, 'A read-only repo changed')}
			autoNote={t(locale, 'Opened because files changed in a read-only repo.')}
			clickNote={t(locale, 'Opens by itself when other files change there.')}>
			{() => (
				<>
					<NoticeLede>
						{t(
							locale,
							'The task only reads these repos, but files in them changed during the turn.'
						)}
					</NoticeLede>
					{items.map((item) => (
						<section key={item.scopeId} data-readonly-scope={name(item)}>
							<NoticeRepoRow name={name(item)} count={fileCount(locale, item.paths.length)} />
							<ul className={styles.paths}>
								{item.paths.slice(0, SHOWN_PATHS).map((path) => (
									<li key={path} title={path}>
										<span>
											<bdi>{path}</bdi>
										</span>
										{item.fresh.includes(path) && (
											<small className={styles.fresh}>{t(locale, 'new (file)')}</small>
										)}
									</li>
								))}
								{item.paths.length > SHOWN_PATHS && (
									<li className={styles.more}>
										+{new Intl.NumberFormat(locale).format(item.paths.length - SHOWN_PATHS)}
									</li>
								)}
							</ul>
						</section>
					))}
				</>
			)}
		</NoticeChip>
	);
}

/** Fact: the task and the sorted set of its repos that are not on disk. */
export const unavailableKey = (task: Key, scopes: readonly Pick<Scope, 'id'>[]) =>
	`unavailable|${taskId(task)}|${scopes
		.map((scope) => scope.id)
		.sort()
		.join(',')}`;

export function UnavailableChip({
	task,
	locale,
	scopes,
	projectName,
	placement,
}: {
	task: Key;
	locale: Locale;
	scopes: readonly Scope[];
	projectName?: string | undefined;
	placement: NoticePlacement;
}) {
	if (!scopes.length) return null;
	const name = (scope: Scope) =>
		scope.kind === 'root' ? repoName(scope.name, projectName) : scope.name;
	const label =
		placement === 'repo'
			? t(locale, 'unavailable (repo)')
			: scopes.length === 1
				? t(locale, '{repo} · unavailable').replace('{repo}', name(scopes[0]!))
				: t(locale, '{repos} · unavailable').replace('{repos}', scopeCount(locale, scopes.length));
	return (
		<NoticeChip
			locale={locale}
			placement={placement}
			icon="review-warning"
			label={label}
			data-unavailable-chip={placement}
			accessibleLabel={t(locale, 'Unavailable repos: {repos}').replace(
				'{repos}',
				scopes.map(name).join(', ')
			)}
			facts={[unavailableKey(task, scopes)]}
			title={t(locale, 'Unavailable repos')}
			autoNote={t(locale, 'Opened because a repo of the task is unavailable.')}
			clickNote={t(locale, 'Opens by itself when another repo becomes unavailable.')}>
			{() => (
				<>
					<NoticeLede>
						{t(
							locale,
							'Brigadir does not see these repos on disk. Their changes are not tracked until the folder comes back.'
						)}
					</NoticeLede>
					<ul className={styles.paths}>
						{scopes.map((scope) => (
							<li key={scope.id} data-unavailable-scope={name(scope)}>
								<NoticeRepoName>{name(scope)}</NoticeRepoName>
								<small className={styles.where} title={scope.path}>
									<bdi>{scope.path}</bdi>
								</small>
							</li>
						))}
					</ul>
				</>
			)}
		</NoticeChip>
	);
}

/** Fact: the task and the reset time — the next limit is a new fact. */
export const rateLimitKey = (task: Key, resetsAt: number | null) =>
	`ratelimit|${taskId(task)}|${resetsAt ?? 'unknown'}`;

export function RateLimitChip({
	task,
	locale,
	limit,
	queued,
}: {
	task: Key;
	locale: Locale;
	limit: { resetsAt: number | null };
	queued: boolean;
}) {
	return (
		<NoticeChip
			locale={locale}
			placement="composer"
			icon="agent-hourglass"
			label={t(locale, 'Limit · {time}').replace('{time}', limitMinutes(locale, limit.resetsAt))}
			data-rate-chip
			accessibleLabel={`${t(locale, 'Subscription limit reached.')} ${rateResetLabel(limit.resetsAt, locale)}`}
			facts={[rateLimitKey(task, limit.resetsAt)]}
			title={t(locale, 'Subscription limit')}
			autoNote={t(locale, 'Opened because the agent reached the subscription limit.')}
			clickNote={t(locale, 'Opens by itself at the next limit.')}>
			{() => (
				<NoticeLede>
					<p>
						<strong>{t(locale, 'Subscription limit reached.')}</strong>{' '}
						{rateResetLabel(limit.resetsAt, locale)}
					</p>
					{queued && <p>{t(locale, 'Queued messages will resume after the reset.')}</p>}
				</NoticeLede>
			)}
		</NoticeChip>
	);
}

/** spec/agents-and-providers#sign-in-recovery + spec/notifications-slack-notes-and-schedules#notice-chips: while the sign-in has not happened, the composer keeps a chip; its popover is the same card with
 *  the same actions and state. It never opens by itself: the card at the failed reply is the first showing. */
export function AuthChip({
	provider,
	locale,
	card,
}: {
	provider: 'claude' | 'codex';
	locale: Locale;
	card: Omit<Parameters<typeof AuthCard>[0], 'provider' | 'locale' | 'embedded'>;
}) {
	const agent = provider === 'codex' ? 'Codex' : 'Claude';
	return (
		<NoticeChip
			locale={locale}
			placement="composer"
			icon="agent-key"
			label={t(locale, '{agent} · sign-in needed').replace('{agent}', agent)}
			data-auth-chip
			accessibleLabel={t(locale, '{agent} asks you to sign in again').replace('{agent}', agent)}
			title={t(locale, '{agent} asks you to sign in again').replace('{agent}', agent)}>
			{() => (
				<div className={styles.cardBody}>
					<AuthCard provider={provider} locale={locale} embedded {...card} />
				</div>
			)}
		</NoticeChip>
	);
}
