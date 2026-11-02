import {
	isRecord,
	parseSlackAnswer,
	slackActionOf,
	slackActions,
	slackAgentMessage,
	slackAllowed,
	slackAnsweredLine,
	slackAnsweredMessage,
	slackAnswerReply,
	slackReply,
	slackThreadReplyOf,
	type SlackAnswer,
	type SlackSettings,
	type TaskKey,
} from '@brigadir/core';

/**
 * What a thread reply did: `sent` to the agent (steering while a turn runs, else a new turn); `gone` / `archived` — no task
 * to send to; `waiting` — `Ask in Brigadir` has not been approved; `terminal` — a CLI task; `busy` — the agent could not
 * start (no free slot).
 */
export type SlackSendResult = 'sent' | 'gone' | 'archived' | 'waiting' | 'terminal' | 'busy';
/** A click's end: `answered` here; `already` — answered in Brigadir (or the request ended); `gone` — no task or schedule. */
export type SlackAnswerResult = 'answered' | 'already' | 'gone';
/** spec/notifications-slack-notes-and-schedules#slack: what Slack may do to the agent in Brigadir. */
export type SlackAnswering = {
	sendToTask(task: TaskKey, text: string): Promise<SlackSendResult>;
	/** The same path as the OS notification and the notice center: the request is checked live, then answered once. */
	answer(answer: SlackAnswer): Promise<SlackAnswerResult>;
};
export type SlackAnswerDeps = SlackAnswering & {
	api(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	settings(): SlackSettings;
	botUser(): string | null;
	/** The task whose messages go to this thread; any other thread is not ours. */
	taskOfThread(channel: string, ts: string): TaskKey | null;
};
const seenLimit = 300;

/**
 * spec/notifications-slack-notes-and-schedules#slack: a reply in a task's thread goes to its agent, and the buttons of Needs you and of a schedule's «Ask» answer
 * them. Only the people the mentions allow; everyone else gets an ephemeral refusal. Push and merge stay in the app.
 */
export class SlackAnswers {
	private seen: string[] = [];
	constructor(private readonly deps: SlackAnswerDeps) {}
	/** `message.channels` / `message.groups` / `message.im`: only a person's reply in a task's thread is ours. */
	/** `true` when the message was a reply in a task's thread and is handled here. */
	async message(payload: Record<string, unknown>): Promise<boolean> {
		const reply = slackThreadReplyOf(payload, this.deps.botUser());
		if (!reply) return false;
		const task = this.deps.taskOfThread(reply.channel, reply.threadTs);
		if (!task) return false;
		// Slack sends an envelope again when the ack was late; one reply goes to the agent once.
		if (this.seen.includes(reply.id)) return true;
		this.seen.push(reply.id);
		if (this.seen.length > seenLimit) this.seen.splice(0, this.seen.length - seenLimit);
		const where = { channel: reply.channel, user: reply.user, replyTs: reply.threadTs };
		if (!slackAllowed(this.deps.settings(), reply.user)) {
			await this.ephemeral(where, slackAnswerReply.notAllowed);
			return true;
		}
		let result: SlackSendResult;
		try {
			result = await this.deps.sendToTask(task, slackAgentMessage(reply.user, reply.text));
		} catch (error) {
			await this.reply(where, slackReply.failed(reason(error)));
			return true;
		}
		if (result === 'sent') await this.reply(where, slackAnswerReply.sent);
		else await this.ephemeral(where, slackAnswerReply[result]);
		return true;
	}
	/** A click on one of our answer buttons; the mentions' buttons are not ours. */
	owns(payload: Record<string, unknown>) {
		const action = Array.isArray(payload.actions) ? payload.actions[0] : null;
		return (
			isRecord(action) &&
			typeof action.action_id === 'string' &&
			slackActionOf(action.action_id) === slackActions.answer
		);
	}
	async interactive(payload: Record<string, unknown>) {
		if (payload.type !== 'block_actions' || !Array.isArray(payload.actions)) return;
		const action = payload.actions[0],
			answer = isRecord(action) ? parseSlackAnswer(action.value) : null,
			user = isRecord(payload.user) && typeof payload.user.id === 'string' ? payload.user.id : null,
			container = isRecord(payload.container) ? payload.container : {},
			channel =
				isRecord(payload.channel) && typeof payload.channel.id === 'string'
					? payload.channel.id
					: typeof container.channel_id === 'string'
						? container.channel_id
						: null,
			messageTs = typeof container.message_ts === 'string' ? container.message_ts : null;
		if (!answer || !user || !channel || !messageTs) return;
		const where = {
			channel,
			user,
			replyTs: typeof container.thread_ts === 'string' ? container.thread_ts : messageTs,
		};
		if (!slackAllowed(this.deps.settings(), user)) {
			await this.ephemeral(where, slackAnswerReply.notAllowed);
			return;
		}
		let result: SlackAnswerResult;
		try {
			result = await this.deps.answer(answer);
		} catch (error) {
			await this.reply(where, slackReply.failed(reason(error)));
			return;
		}
		const text =
			isRecord(payload.message) && typeof payload.message.text === 'string'
				? payload.message.text
				: null;
		// Answered anywhere, the buttons go: here they give way to who answered.
		if (text)
			await this.deps
				.api('chat.update', {
					channel,
					ts: messageTs,
					...slackAnsweredMessage(
						text,
						result === 'answered' ? slackAnsweredLine(answer, user) : null
					),
				})
				.catch(() => {});
		if (result === 'already') await this.reply(where, slackAnswerReply.already);
		else if (result === 'gone')
			await this.ephemeral(
				where,
				answer.kind === 'schedule' ? slackAnswerReply.scheduleGone : slackAnswerReply.gone
			);
	}
	private reply(where: { channel: string; replyTs: string }, text: string) {
		return this.deps.api('chat.postMessage', {
			channel: where.channel,
			thread_ts: where.replyTs,
			text,
			unfurl_links: false,
			unfurl_media: false,
		});
	}
	private ephemeral(where: { channel: string; replyTs: string; user: string }, text: string) {
		return this.deps.api('chat.postEphemeral', {
			channel: where.channel,
			user: where.user,
			thread_ts: where.replyTs,
			text,
		});
	}
}
function reason(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
