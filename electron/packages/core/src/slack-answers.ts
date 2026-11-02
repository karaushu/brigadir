import { isRecord } from './workspace';
import { slackEscape, type SlackNotice, type SlackSettings } from './slack';
import { slackActions, slackPlain, type SlackButton } from './slack-mentions';
import type { TaskKey, UserQuestion } from './session';
/**
 * spec/notifications-slack-notes-and-schedules#slack: Slack answers the agent — a reply in a task's thread goes to its agent (steering spec/composer-steering-queue-and-ghost#steering), and the buttons of
 * Needs you and of a schedule's «Ask» answer them. Pure: main/slack-answers.ts reads Slack and Brigadir. English, like every
 * Slack message of the app; the text to the agent is English too (rule 12).
 */

/** The listed people, the person's own member ID, or anyone when `Anyone in the channel` is on. */
export function slackAllowed(settings: SlackSettings, user: string): boolean {
	return (
		settings.mentions.who === 'anyone' ||
		user === settings.memberId ||
		settings.mentions.people.includes(user)
	);
}

/** One reply in a thread, as the steering needs it. */
export type SlackThreadReply = {
	id: string;
	user: string;
	channel: string;
	ts: string;
	threadTs: string;
	text: string;
};
/** A person's new message (a file or `Also send to #channel` too); edits, deletions and the bots' own are not replies. */
const replySubtypes = new Set([undefined, 'thread_broadcast', 'file_share']);
/**
 * A `message` event that is a person's reply inside a thread; `null` for a thread's root, a bot, an edit, an empty text,
 * and a message that mentions the bot (the mentions answer those, spec/notifications-slack-notes-and-schedules#slack).
 */
export function slackThreadReplyOf(
	payload: Record<string, unknown>,
	botUser: string | null
): SlackThreadReply | null {
	const event = payload.event;
	if (!isRecord(event) || event.type !== 'message') return null;
	if (event.bot_id || !replySubtypes.has(event.subtype as string | undefined)) return null;
	const { user, channel, ts, thread_ts: threadTs, text } = event;
	if (
		typeof user !== 'string' ||
		typeof channel !== 'string' ||
		typeof ts !== 'string' ||
		typeof threadTs !== 'string' ||
		typeof text !== 'string' ||
		threadTs === ts ||
		user === botUser ||
		!text.trim()
	)
		return null;
	if (botUser && text.includes(`<@${botUser}`)) return null;
	return {
		id: typeof payload.event_id === 'string' ? payload.event_id : `${channel}/${ts}`,
		user,
		channel,
		ts,
		threadTs,
		text,
	};
}
/** What the agent reads: who wrote in the task's Slack thread, then their words as plain text. */
export function slackAgentMessage(user: string, text: string): string {
	return `A reply from @${user} in this task's Slack thread:\n\n${slackPlain(text).trim()}`;
}

/** A button's answer; Slack sends its value back, so a click works after a restart too. */
export type SlackAnswer =
	| { kind: 'permission'; task: TaskKey; request: string; option: 'allow' | 'deny' }
	| { kind: 'question'; task: TaskKey; request: string; option: string }
	| { kind: 'schedule'; projectId: string; schedule: string; option: 'run' | 'skip' };
const valueLimit = 2000;
export function slackAnswerValue(answer: SlackAnswer): string {
	return JSON.stringify(
		answer.kind === 'schedule'
			? { k: 's', p: answer.projectId, s: answer.schedule, o: answer.option }
			: {
					k: answer.kind === 'permission' ? 'p' : 'q',
					p: answer.task.projectId,
					t: answer.task.id,
					r: answer.request,
					o: answer.option,
				}
	);
}
/** The value back as an answer; anything not ours, or not whole, is `null`. */
export function parseSlackAnswer(value: unknown): SlackAnswer | null {
	if (typeof value !== 'string' || value.length > valueLimit) return null;
	let data: unknown;
	try {
		data = JSON.parse(value);
	} catch {
		return null;
	}
	if (!isRecord(data) || typeof data.p !== 'string' || !data.p || typeof data.o !== 'string')
		return null;
	if (data.k === 's')
		return typeof data.s === 'string' && data.s && (data.o === 'run' || data.o === 'skip')
			? { kind: 'schedule', projectId: data.p, schedule: data.s, option: data.o }
			: null;
	if (typeof data.t !== 'string' || !data.t || typeof data.r !== 'string' || !data.r) return null;
	const task = { projectId: data.p, id: data.t };
	if (data.k === 'p')
		return data.o === 'allow' || data.o === 'deny'
			? { kind: 'permission', task, request: data.r, option: data.o }
			: null;
	return data.k === 'q' && data.o
		? { kind: 'question', task, request: data.r, option: data.o }
		: null;
}

const questionChoices = 5;
/** A question gets buttons only when it has a few single choices; free text or several answers are for Brigadir. */
export function slackQuestionChoices(question: UserQuestion): string[] | null {
	if (question.allowsMultiple || !question.options.length) return null;
	if (question.options.length > questionChoices) return null;
	return question.options.map((option) => option.label);
}
/** The buttons of a Needs you or a schedule's «Ask»; `null` — the message has none (and a value that would not fit). */
export function slackNoticeButtons(notice: SlackNotice): SlackButton[] | null {
	const button = (label: string, answer: SlackAnswer, style?: SlackButton['style']) => ({
		action: slackActions.answer,
		label,
		value: slackAnswerValue(answer),
		...(style ? { style } : {}),
	});
	let buttons: SlackButton[] = [];
	if (notice.kind === 'scheduleAsk') {
		const answer = (option: 'run' | 'skip') =>
			({
				kind: 'schedule',
				projectId: notice.projectId,
				schedule: notice.scheduleId,
				option,
			}) as const;
		buttons = [button('Run now', answer('run'), 'primary'), button('Skip', answer('skip'))];
	} else if (notice.kind === 'needsYou' && notice.ask) {
		const task = { projectId: notice.task.projectId, id: notice.task.id },
			ask = notice.ask;
		buttons =
			ask.kind === 'permission'
				? ask.options.map((option) =>
						button(
							option === 'allow' ? 'Allow' : 'Deny',
							{ kind: 'permission', task, request: ask.request, option },
							option === 'allow' ? 'primary' : 'danger'
						)
					)
				: ask.options.map((option) =>
						button(option, { kind: 'question', task, request: ask.request, option })
					);
	}
	return buttons.length && buttons.every((item) => item.value.length <= valueLimit)
		? buttons
		: null;
}
/** The line that takes the buttons' place once answered from Slack. */
export function slackAnsweredLine(answer: SlackAnswer, user: string): string {
	const who = `<@${user.replace(/[^A-Z0-9]/g, '')}>`;
	switch (answer.kind) {
		case 'permission':
			return answer.option === 'allow' ? `✅ Allowed by ${who}` : `🚫 Denied by ${who}`;
		case 'question':
			return `✅ ${slackEscape(answer.option)} — chosen by ${who}`;
		case 'schedule':
			return answer.option === 'run' ? `▶️ Run now by ${who}` : `⏭️ Skipped by ${who}`;
	}
}
/** The answered message: its text stays, the buttons give way to `line` (none — they only go). */
export function slackAnsweredMessage(text: string, line: string | null) {
	return {
		text,
		blocks: [
			{ type: 'section', text: { type: 'mrkdwn', text } },
			...(line ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: line }] }] : []),
		],
	};
}
/** The bot's answers to a reply or a click. */
export const slackAnswerReply = {
	sent: '✅ *Sent to the agent*',
	already: '🙅 *Answered in Brigadir already*',
	notAllowed: 'Only the people in Brigadir’s Slack settings can talk to the agent here.',
	gone: 'The task is gone.',
	archived: 'The task is in the archive in Brigadir.',
	waiting: 'The task waits for approval in Brigadir.',
	terminal: 'This task runs in a terminal. Answer in Brigadir.',
	busy: 'The agent could not start now. Try again later.',
	scheduleGone: 'The schedule is gone.',
} as const;
