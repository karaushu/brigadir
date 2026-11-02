import { expect, it } from 'vitest';
import { defaultSlackSettings, isAppToken, isSlackSettings, withSlackDefaults } from './slack';
import {
	parseSlackIntent,
	slackActionOf,
	slackActiveText,
	slackButtons,
	slackFindTasks,
	slackIntentFallback,
	slackIntentPrompt,
	slackMentionText,
	slackNoteText,
	slackProjectPrefix,
	slackReply,
	slackStatusText,
	slackThreadText,
	type SlackTaskInfo,
	slackNamedProject,
	slackLocalize,
	slackLanguage,
	slackAsksActive,
	slackAsksQuestion,
	slackAskAgentOf,
	slackTitleKey,
} from './slack-mentions';

const projects = [
	{ id: 'p1', name: 'business' },
	{ id: 'p2', name: 'Acme App' },
];
const info = (patch: Partial<SlackTaskInfo>): SlackTaskInfo => ({
	projectId: 'p1',
	id: 't1',
	title: 'Phone validation',
	status: 'working',
	branch: null,
	prs: [],
	updatedAt: '2026-10-30T10:00:00.000Z',
	...patch,
});

it('keeps old settings loading and checks the mentions part', () => {
	const old = { memberId: '', events: {}, projects: {} };
	expect(withSlackDefaults(old)).toEqual(defaultSlackSettings);
	expect(isSlackSettings(withSlackDefaults(old))).toBe(true);
	const mentions = {
		on: true,
		who: 'people',
		people: ['U1AB', 'W2CD'],
		start: 'ask',
		agent: null,
	};
	expect(isSlackSettings({ ...defaultSlackSettings, mentions })).toBe(true);
	expect(
		isSlackSettings({ ...defaultSlackSettings, mentions: { ...mentions, people: ['bob'] } })
	).toBe(false);
	expect(
		isSlackSettings({
			...defaultSlackSettings,
			mentions: { ...mentions, people: ['U1AB', 'U1AB'] },
		})
	).toBe(false);
	expect(isAppToken('xapp-1-A0-123-abcdef')).toBe(true);
	expect(isAppToken('xoxb-1234567890-abc')).toBe(false);
});

it('reads the mention without the bot and Slack markup', () => {
	expect(
		slackMentionText('<@UBOT> fix <#C1|deploys> for <@U2> &amp; see <https://x.io/a|this>', 'UBOT')
	).toBe('fix #deploys for @U2 & see this (https://x.io/a)');
	expect(slackMentionText('<@UBOT>   status of #12', null)).toBe('status of #12');
});

it('picks the project from `in <project>:` and says when it names none', () => {
	expect(slackProjectPrefix('in business: fix the phone field', projects)).toEqual({
		project: 'p1',
		rest: 'fix the phone field',
	});
	expect(slackProjectPrefix('In acme app: add a test', projects)).toEqual({
		project: 'p2',
		rest: 'add a test',
	});
	expect(slackProjectPrefix('в business: що в роботі?', projects)).toMatchObject({ project: 'p1' });
	expect(slackProjectPrefix('in mobile: x', projects)).toEqual({ unknown: 'mobile', rest: 'x' });
	expect(slackProjectPrefix('fix it: now', projects)).toBeNull();
});

it('parses the model’s one word and falls back to keyword rules', () => {
	expect(parseSlackIntent('task')).toEqual({ kind: 'task' });
	expect(parseSlackIntent('  Status.\n')).toEqual({ kind: 'status' });
	expect(parseSlackIntent('note summary')).toEqual({ kind: 'note', note: 'summary' });
	expect(parseSlackIntent('note — thread')).toEqual({ kind: 'note', note: 'thread' });
	expect(parseSlackIntent('note')).toEqual({ kind: 'note', note: 'unclear' });
	expect(parseSlackIntent('I think this is a task')).toBeNull();
	expect(parseSlackIntent(null)).toBeNull();

	expect(slackIntentFallback('fix the phone validation on signup')).toEqual({ kind: 'task' });
	expect(slackIntentFallback('додай тест на логін')).toEqual({ kind: 'task' });
	expect(slackIntentFallback('what is the status of phone validation?')).toEqual({
		kind: 'status',
	});
	expect(slackIntentFallback('на якому етапі задача з телефоном')).toEqual({ kind: 'status' });
	expect(slackIntentFallback('#421')).toEqual({ kind: 'status' });
	expect(slackIntentFallback('what’s in progress')).toEqual({ kind: 'status' });
	expect(slackIntentFallback('save a summary of this thread')).toEqual({
		kind: 'note',
		note: 'unclear',
	});
	expect(slackIntentFallback('save the decision')).toEqual({ kind: 'note', note: 'summary' });
	expect(slackIntentFallback('запиши тред')).toEqual({ kind: 'note', note: 'thread' });
	expect(slackIntentFallback('нотатка')).toEqual({ kind: 'note', note: 'unclear' });
	expect(slackIntentFallback('hello there')).toEqual({ kind: 'unsure' });
	// A question (a question word or `?`) is about the tasks: the status answer takes it, not «not sure».
	expect(slackIntentFallback('чому „New printer library" робилась так довго')).toEqual({
		kind: 'status',
	});
	expect(slackIntentFallback('who reviewed the printer library')).toEqual({ kind: 'status' });
	expect(slackIntentFallback('скільки ще лишилось')).toEqual({ kind: 'status' });
	expect(slackAsksQuestion('hello there')).toBe(false);
	expect(slackAsksQuestion('щось там?')).toBe(true);
	expect(slackAsksQuestion('щось там')).toBe(false);
});

it('tells a question about the project’s code from one about its tasks (spec/notifications-slack-notes-and-schedules#slack)', () => {
	expect(parseSlackIntent('code')).toEqual({ kind: 'code' });
	expect(slackIntentPrompt('як працює логін?', null)).toContain('code — a question about how');
	expect(slackIntentFallback('як у business працює авторизація?')).toEqual({ kind: 'code' });
	expect(slackIntentFallback('де обробляється webhook Stripe?')).toEqual({ kind: 'code' });
	expect(slackIntentFallback('how does the auth middleware work?')).toEqual({ kind: 'code' });
	expect(slackIntentFallback('where is the Stripe webhook handled?')).toEqual({ kind: 'code' });
	expect(slackIntentFallback('which file has the printer driver?')).toEqual({ kind: 'code' });
	// A task, a state or a PR stays what it was.
	expect(slackIntentFallback('fix where the webhook is handled')).toEqual({ kind: 'task' });
	expect(slackIntentFallback('where is the PR for phone validation?')).toEqual({ kind: 'status' });
	expect(slackIntentFallback('як там задача з телефоном?')).toEqual({ kind: 'status' });
	expect(slackLocalize(slackReply.askingCode('business'), 'uk')).toBe(
		'⏳ Питаю агента в business…'
	);
});

it('writes the thread as plain text and keeps it under 8 KB', () => {
	const text = slackThreadText([
		{ user: 'U1', ts: '1793354520.000100', text: 'Phone field drops <@U2>' },
		{
			user: 'U2',
			ts: '1793354580.0002',
			text: 'see',
			files: [{ name: 'a.png', url: 'https://f/a' }],
		},
	]);
	expect(text).toBe(
		'U1 · 2026-10-30 10:02 UTC\nPhone field drops @U2\n\nU2 · 2026-10-30 10:03 UTC\nsee\n📎 a.png: https://f/a'
	);
	const long = slackThreadText(
		Array.from({ length: 100 }, (_, index) => ({
			user: 'U1',
			ts: String(1793354520 + index),
			text: `${index} ${'x'.repeat(200)}`,
		}))
	);
	expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(8 * 1024);
	expect(long.startsWith('U1 · ')).toBe(true);
	expect(long).toContain('messages left out');
	expect(long).toContain('99 x');
});

it('finds a task by PR number, branch or title words', () => {
	const tasks = [
		info({ id: 'a', title: 'Phone validation', prs: [{ number: 421, url: 'u', state: 'OPEN' }] }),
		info({ id: 'b', title: 'Login page redesign', branch: 'claude/login' }),
		info({ id: 'c', title: 'Login rate limit', updatedAt: '2026-10-30T11:00:00.000Z' }),
	];
	expect(slackFindTasks('how is #421?', tasks).map((task) => task.id)).toEqual(['a']);
	expect(slackFindTasks('status of claude/login', tasks).map((task) => task.id)).toEqual(['b']);
	expect(slackFindTasks('where is phone validation', tasks).map((task) => task.id)).toEqual(['a']);
	expect(slackFindTasks('login', tasks).map((task) => task.id)).toEqual(['c', 'b']);
	expect(slackFindTasks('status of the payment export', tasks)).toEqual([]);
	// A quoted title is found whole, quotes and case aside.
	const quoted = [...tasks, info({ id: 'd', title: 'New printer library' })];
	for (const text of [
		'чому „New printer library" робилась так довго?',
		'why did «new printer library» take so long?',
		'"NEW PRINTER LIBRARY" — what is left?',
	])
		expect(slackFindTasks(text, quoted).map((task) => task.id)).toEqual(['d']);
	expect(slackTitleKey(' „New  printer library" ')).toBe('new printer library');
	expect(slackAskAgentOf('ASK_AGENT: „New printer library"')).toBe('New printer library');
});

it('answers about state from Brigadir’s data only', () => {
	const now = Date.parse('2026-10-30T10:05:00.000Z');
	expect(
		slackStatusText({
			task: info({
				branch: 'claude/phone',
				prs: [{ number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN' }],
			}),
			project: 'business',
			plan: { done: 2, total: 5, current: 'Write the validator' },
			ci: 'running',
			now,
		}).split('\n')
	).toEqual([
		'⚙️ *Working* — business (`claude/phone`)',
		'📋 Task: Phone validation',
		'🗺️ Plan: 2 of 5 · Write the validator',
		'🔀 PR: <https://github.com/o/r/pull/12|#12> · open',
		'🧪 CI: running',
		'🕒 Updated 5m ago',
	]);
	expect(
		slackStatusText({
			task: info({ status: 'done', updatedAt: null }),
			project: 'b',
			plan: null,
			ci: null,
			now,
		})
	).toBe('🏁 *Done* — b\n📋 Task: Phone validation');
	expect(slackActiveText('business', [info({}), info({ id: 'x', status: 'completed' })])).toBe(
		'🛠️ *In progress* — business\n• Phone validation — Working'
	);
	expect(slackActiveText('business', [])).toBe('💤 *Nothing in progress* — business');
});

it('writes replies, notes and buttons', () => {
	expect(slackReply.taskCreated('business', 'Fix <b>')).toBe(
		'🆕 *Task created* — business\n📋 Task: Fix &lt;b&gt;'
	);
	expect(slackReply.taskWaiting('business', 'Fix')).toBe(
		'⏳ *Waiting for approval in Brigadir* — business\n📋 Task: Fix'
	);
	expect(slackReply.noteSaved('Release plan')).toBe('📝 *Note saved* — Release plan');
	expect(
		slackNoteText({
			title: 'Release plan',
			channel: 'deploys',
			permalink: 'https://x.slack.com/archives/C1/p1',
			body: 'U1 · …\nhi',
		})
	).toBe(
		'# Release plan\n\nFrom Slack: [#deploys thread](https://x.slack.com/archives/C1/p1)\n\nU1 · …\nhi\n'
	);
	const message = slackButtons('Which one?', [
		{ action: 'brigadir_show', label: 'A', value: 'k:a' },
		{ action: 'brigadir_show', label: 'B', value: 'k:b' },
	]);
	expect(message.blocks[1]).toMatchObject({
		type: 'actions',
		elements: [{ action_id: 'brigadir_show:0' }, { action_id: 'brigadir_show:1' }],
	});
	expect(slackActionOf('brigadir_show:1')).toBe('brigadir_show');
	expect(slackActionOf('other')).toBeNull();
});

it('finds a project named as a whole word, only when one is named', () => {
	const projects = [
		{ id: 'p', name: 'business' },
		{ id: 'q', name: 'admin' },
	];
	expect(slackNamedProject('що зараз у роботі в business?', projects)).toBe('p');
	expect(slackNamedProject('business vs admin', projects)).toBeNull();
	expect(slackNamedProject('businesses', projects)).toBeNull();
});

it('answers in the request’s language and counts the board’s In progress as in progress', () => {
	expect(slackAsksActive('що зараз у роботі в business?')).toBe(true);
	expect(slackLanguage('що зараз у роботі?')).toBe('uk');
	expect(slackLanguage('what is in progress?')).toBe('en');
	expect(
		slackLocalize('🛠️ *In progress* — business\n• Done button — Done (`b`)\n… and 3 more', 'uk')
	).toBe('🛠️ *В роботі* — business\n• Done button — Готово (`b`)\n… і ще 3');
	expect(slackLocalize('🗺️ Plan: 1 of 3 · Write tests\n🕒 Updated 5m ago', 'uk')).toBe(
		'🗺️ План: 1 з 3 · Write tests\n🕒 Оновлено 5 хв тому'
	);
});
