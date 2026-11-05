import { slackEscape } from './slack';
import type { SlackLanguage } from './slack-mentions';
import { isRecord, taskStatuses, type TaskStatus } from './workspace';
/**
 * spec/notifications-slack-notes-and-schedules#slack: a mention asks the bot to watch something and write in the same thread
 * when it happens. Pure: what a watch is, the words that ask for one, and its texts; main/slack-watches.ts keeps the watches and fires them.
 */
export const slackWatchKinds = ['ci', 'pr-merged', 'task-done'] as const;
export type SlackWatchKind = (typeof slackWatchKinds)[number];
/** The PR a watch reads: the task whose scopes hold it (`taskId`), the repo's scope, the number. */
export type SlackWatchPR = {
	projectId: string;
	taskId: string | null;
	scopeId: string;
	number: number;
	url: string;
};
export type SlackWatch = {
	id: string;
	kind: SlackWatchKind;
	/** The thread it answers in. */
	channel: string;
	ts: string;
	/** Who asked (`U…`): the answer mentions them. */
	by: string;
	language: SlackLanguage;
	created: number;
	/** The task it is about (task-done), or the task that has the PR. */
	task: { projectId: string; id: string; title: string } | null;
	pr: SlackWatchPR | null;
	/** ci: the run with the bell (spec/pull-requests-and-ci#ci-bell); `bell` — the bell was put by this watch. */
	run?: { id: number; bell: boolean };
	/** task-done: the state seen last; the watch fires when it turns Done or Completed. */
	last?: TaskStatus;
	/** The answer that did not reach Slack yet (Slack down): sent again on the next pass. */
	outbox?: string;
};
export const slackWatchLimit = 50;
export const slackWatchDays = 7;
const isId = (value: unknown, limit = 512) =>
	typeof value === 'string' && value.length > 0 && value.length <= limit;
export function isSlackWatch(value: unknown): value is SlackWatch {
	if (!isRecord(value)) return false;
	const task = value.task,
		pr = value.pr,
		run = value.run;
	return (
		isId(value.id, 64) &&
		(slackWatchKinds as readonly unknown[]).includes(value.kind) &&
		isId(value.channel, 40) &&
		isId(value.ts, 40) &&
		isId(value.by, 40) &&
		(value.language === 'en' || value.language === 'uk') &&
		typeof value.created === 'number' &&
		(task === null ||
			(isRecord(task) &&
				isId(task.projectId) &&
				isId(task.id) &&
				typeof task.title === 'string')) &&
		(pr === null ||
			(isRecord(pr) &&
				isId(pr.projectId) &&
				(pr.taskId === null || isId(pr.taskId)) &&
				isId(pr.scopeId) &&
				Number.isSafeInteger(pr.number) &&
				Number(pr.number) > 0 &&
				typeof pr.url === 'string')) &&
		(value.kind === 'task-done' ? task !== null : pr !== null) &&
		(run === undefined ||
			(isRecord(run) && Number.isSafeInteger(run.id) && typeof run.bell === 'boolean')) &&
		(value.last === undefined || (taskStatuses as readonly unknown[]).includes(value.last)) &&
		(value.outbox === undefined || typeof value.outbox === 'string')
	);
}

/** PR numbers a message names: `#123`, `PR 123`, a GitHub `/pull/123` link. */
export function slackPRNumbers(text: string): number[] {
	return [
		...new Set(
			[...text.matchAll(/(?:#|\bpr\s*#?|\/pull\/)(\d{1,7})\b/gi)].map((match) => Number(match[1]))
		),
	];
}

const prLink = (pr: Pick<SlackWatchPR, 'url' | 'number'>) =>
	pr.url ? `<${pr.url.replace(/[<>|]/g, '')}|#${pr.number}>` : `#${pr.number}`;
/** One line of what is watched: `🧪 CI finishes — #12`. */
export function slackWatchSubject(watch: Pick<SlackWatch, 'kind' | 'task' | 'pr'>): string {
	if (watch.kind === 'task-done')
		return `🏁 Task is done — ${slackEscape(watch.task?.title ?? '')}`;
	const pr = watch.pr ? prLink(watch.pr) : '';
	return watch.kind === 'ci' ? `🧪 CI finishes — ${pr}` : `🔀 PR is merged — ${pr}`;
}
/** The watches' texts, in English like every reply; `slackLocalize` puts them into the request's language. */
export const slackWatchReply = {
	watching: (watches: readonly Pick<SlackWatch, 'kind' | 'task' | 'pr'>[]) =>
		[
			'👀 *Watching* — I’ll write here when:',
			...watches.map((watch) => `• ${slackWatchSubject(watch)}`),
		].join('\n'),
	stopped: (count: number) => `🛑 *Stopped watching*${count > 1 ? ` · ${count}` : ''}`,
	nothing: '🤷 *Nothing to stop* — no watches in this thread',
	what: '👀 *What should I watch?*',
	noOpenPR: '🔎 *No open PR* — name it as `#123`',
	noPR: (numbers: readonly number[]) =>
		`🔎 *No PR ${numbers.map((number) => `#${number}`).join(', ')} on Brigadir’s tasks*`,
	severalPRs: '🔀 *Several PRs* — which one?',
	tooMany: `🚦 *Too many watches* — at most ${slackWatchLimit}. Stop some: «stop watching».`,
	completed: (title: string) => `✅ *Already completed* — ${slackEscape(title)}`,
	expired: (watch: Pick<SlackWatch, 'kind' | 'task' | 'pr'>) =>
		`⌛ *Stopped watching after ${slackWatchDays} days*\n${slackWatchSubject(watch)}`,
	prClosed: (pr: Pick<SlackWatchPR, 'url' | 'number'>, repo: string) =>
		`🚫 *PR closed without merge* — ${slackEscape(repo)} ${prLink(pr)}`,
	/** The button labels of «What should I watch?». */
	labels: { ci: 'CI finishes', 'pr-merged': 'PR is merged', 'task-done': 'Task is done' },
} as const;
