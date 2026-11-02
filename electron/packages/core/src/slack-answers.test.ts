import { expect, it } from 'vitest';
import { defaultSlackSettings, slackNoticeEvent, slackText, type SlackNotice } from './slack';
import {
	parseSlackAnswer,
	slackAgentMessage,
	slackAllowed,
	slackAnsweredLine,
	slackAnsweredMessage,
	slackAnswerValue,
	slackNoticeButtons,
	slackQuestionChoices,
	slackThreadReplyOf,
	type SlackAnswer,
} from './slack-answers';

const task = { projectId: 'p', id: 't', title: 'Phone validation' };
const reply = (event: Record<string, unknown>) => ({
	event_id: 'Ev1',
	event: {
		type: 'message',
		user: 'U2CD',
		channel: 'C0DEPLOY',
		ts: '2.0',
		thread_ts: '1.0',
		text: 'use the E.164 format',
		...event,
	},
});

it('takes a person’s reply in a thread and leaves roots, bots, edits and mentions of the bot', () => {
	expect(slackThreadReplyOf(reply({}), 'UBOT')).toEqual({
		id: 'Ev1',
		user: 'U2CD',
		channel: 'C0DEPLOY',
		ts: '2.0',
		threadTs: '1.0',
		text: 'use the E.164 format',
	});
	expect(slackThreadReplyOf(reply({ subtype: 'thread_broadcast' }), 'UBOT')).not.toBeNull();
	for (const event of [
		{ thread_ts: undefined },
		{ thread_ts: '2.0' },
		{ bot_id: 'B1' },
		{ subtype: 'message_changed' },
		{ subtype: 'bot_message' },
		{ user: 'UBOT' },
		{ text: '  ' },
		{ text: '<@UBOT> what state?' },
		{ type: 'app_mention' },
	])
		expect(slackThreadReplyOf(reply(event), 'UBOT')).toBeNull();
});

it('tells the agent who wrote in the thread, in English and plain text', () => {
	expect(slackAgentMessage('U2CD', 'see <https://x.test|the doc> &amp; <@U3EF>')).toBe(
		"A reply from @U2CD in this task's Slack thread:\n\nsee the doc (https://x.test) & @U3EF"
	);
});

it('lets the listed people and the person’s own member ID answer', () => {
	const settings = {
		...defaultSlackSettings,
		memberId: 'U1AB',
		mentions: { ...defaultSlackSettings.mentions, people: ['U2CD'] },
	};
	expect(['U1AB', 'U2CD', 'U9ZZ'].map((user) => slackAllowed(settings, user))).toEqual([
		true,
		true,
		false,
	]);
	expect(
		slackAllowed({ ...settings, mentions: { ...settings.mentions, who: 'anyone' } }, 'U9ZZ')
	).toBe(true);
});

it('puts Allow · Deny on a permission and says what the tool is', () => {
	const notice: SlackNotice = {
		kind: 'needsYou',
		repo: 'business',
		branch: 'claude/phone',
		task,
		reason: 'A permission to answer',
		ask: {
			kind: 'permission',
			request: 'perm-1',
			tool: 'Run\n`pnpm test`',
			options: ['allow', 'deny'],
		},
	};
	expect(slackText(notice).split('\n')).toEqual([
		'🙋 *Needs you* — business (`claude/phone`)',
		'📋 Task: Phone validation',
		"🔐 A permission to answer: `Run 'pnpm test'`",
	]);
	const buttons = slackNoticeButtons(notice)!;
	expect(buttons.map((button) => [button.label, button.style])).toEqual([
		['Allow', 'primary'],
		['Deny', 'danger'],
	]);
	expect(parseSlackAnswer(buttons[0]!.value)).toEqual({
		kind: 'permission',
		task: { projectId: 'p', id: 't' },
		request: 'perm-1',
		option: 'allow',
	});
	// Without a request to answer the message stays a plain notice.
	const { ask: _ask, ...plain } = notice;
	expect(slackNoticeButtons(plain)).toBeNull();
	expect(slackText(plain)).toContain('💬 A permission to answer · answer in Brigadir');
});

it('gives a question buttons only for a few single choices', () => {
	const question = (options: number, allowsMultiple = false) => ({
		id: 'q1',
		question: 'Which format?',
		header: 'Format',
		options: Array.from({ length: options }, (_, index) => ({
			label: `Option ${index + 1}`,
			description: '',
		})),
		allowsFreeText: true,
		allowsMultiple,
	});
	expect(slackQuestionChoices(question(2))).toEqual(['Option 1', 'Option 2']);
	expect(slackQuestionChoices(question(6))).toBeNull();
	expect(slackQuestionChoices(question(2, true))).toBeNull();
	expect(slackQuestionChoices(question(0))).toBeNull();
	const notice: SlackNotice = {
		kind: 'needsYou',
		repo: 'business',
		branch: 'b',
		task,
		reason: 'A question to answer',
		ask: {
			kind: 'question',
			request: 'q1',
			question: 'Which format?',
			options: ['E.164', 'Local'],
		},
	};
	expect(slackText(notice)).toContain('❓ Which format?');
	expect(slackNoticeButtons(notice)!.map((button) => parseSlackAnswer(button.value))).toEqual([
		{ kind: 'question', task: { projectId: 'p', id: 't' }, request: 'q1', option: 'E.164' },
		{ kind: 'question', task: { projectId: 'p', id: 't' }, request: 'q1', option: 'Local' },
	]);
});

it('asks Run now · Skip for a schedule’s missed runs under the Needs you event', () => {
	const notice: SlackNotice = {
		kind: 'scheduleAsk',
		projectId: 'p',
		scheduleId: 's_1',
		schedule: 'Nightly deps',
		project: 'business',
		count: 3,
	};
	expect(slackNoticeEvent(notice)).toBe('needsYou');
	expect(slackText(notice).split('\n')).toEqual([
		'🙋 *Needs you* — business',
		'🗓️ Schedule: Nightly deps',
		'💬 3 runs missed · run once now or skip?',
	]);
	expect(
		slackNoticeButtons(notice)!.map((button) => [button.label, parseSlackAnswer(button.value)])
	).toEqual([
		['Run now', { kind: 'schedule', projectId: 'p', schedule: 's_1', option: 'run' }],
		['Skip', { kind: 'schedule', projectId: 'p', schedule: 's_1', option: 'skip' }],
	]);
});

it('reads back only whole answers and names who answered', () => {
	const answer: SlackAnswer = {
		kind: 'question',
		task: { projectId: 'p', id: 't' },
		request: 'q',
		option: 'A & B',
	};
	expect(parseSlackAnswer(slackAnswerValue(answer))).toEqual(answer);
	for (const value of [
		'',
		'x',
		'{"k":"p","p":"p","t":"t","r":"r","o":"maybe"}',
		'{"k":"s","p":"p","o":"run"}',
		null,
	])
		expect(parseSlackAnswer(value)).toBeNull();
	expect(slackAnsweredLine(answer, 'U1AB')).toBe('✅ A &amp; B — chosen by <@U1AB>');
	expect(
		slackAnsweredLine(
			{ kind: 'permission', task: answer.task, request: 'r', option: 'allow' },
			'U1AB'
		)
	).toBe('✅ Allowed by <@U1AB>');
	expect(slackAnsweredMessage('text', null).blocks).toEqual([
		{ type: 'section', text: { type: 'mrkdwn', text: 'text' } },
	]);
});
