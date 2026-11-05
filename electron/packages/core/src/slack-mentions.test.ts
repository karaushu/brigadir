import { describe, expect, it } from 'vitest';
import { defaultSlackSettings, isAppToken, isSlackSettings, withSlackDefaults } from './slack';
import {
	slackActionOf,
	slackAckOf,
	slackAgentSteps,
	slackButtons,
	slackFindTasks,
	slackMentionText,
	slackNoteText,
	slackProjectPrefix,
	slackReply,
	slackThreadText,
	type SlackTaskInfo,
	slackNamedProject,
	slackLocalize,
	slackLanguage,
	slackTitleKey,
	slackWithoutAck,
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
		{ action: 'brigadir_watch', label: 'A', value: 'k:a' },
		{ action: 'brigadir_watch', label: 'B', value: 'k:b' },
	]);
	expect(message.blocks[1]).toMatchObject({
		type: 'actions',
		elements: [{ action_id: 'brigadir_watch:0' }, { action_id: 'brigadir_watch:1' }],
	});
	expect(slackActionOf('brigadir_watch:1')).toBe('brigadir_watch');
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

it('answers in the request’s language', () => {
	expect(slackLanguage('що зараз у роботі?')).toBe('uk');
	expect(slackLanguage('what is in progress?')).toBe('en');
	expect(
		slackLocalize('🛠️ *In progress* — business\n• Done button — Done (`b`)\n… and 3 more', 'uk')
	).toBe('🛠️ *В роботі* — business\n• Done button — Готово (`b`)\n… і ще 3');
	expect(slackLocalize('🗺️ Plan: 1 of 3 · Write tests\n🕒 Updated 5m ago', 'uk')).toBe(
		'🗺️ План: 1 з 3 · Write tests\n🕒 Оновлено 5 хв тому'
	);
});

describe('the Slack agent’s answer (spec/notifications-slack-notes-and-schedules#slack-agent)', () => {
	it('posts the ACK line as soon as it is finished, and never twice', () => {
		expect(slackAckOf('ACK: Пішов дивитись')).toBeNull();
		expect(slackAckOf('ACK: Пішов дивитись, що зарелізили сьогодні\nСьогодні')).toEqual({
			ack: 'Пішов дивитись, що зарелізили сьогодні',
			rest: 'Сьогодні',
		});
		expect(slackAckOf('Сьогодні нічого\n')).toBeNull();
		expect(slackWithoutAck('ACK: Дивлюсь')).toBe('');
		expect(slackWithoutAck('Відповідь')).toBe('Відповідь');
	});
	it('takes the ACTION lines out of the words and drops the ones that do not parse', () => {
		const { text, actions } = slackAgentSteps(
			[
				'Передаю агенту задачі «Кнопка».',
				'ACTION send_to_task {"task": "t1", "text": "Make the button blue"}',
				'`ACTION create_task {"project": "admin", "title": "Нова кнопка", "prompt": "Add a button"}`',
				'ACTION watch {"kinds": ["ci", "merged"]}',
				'ACTION note {"kind": "summary"}',
				'ACTION create_task {"title": "no project"}',
				'ACTION send_to_task {broken',
			].join('\n')
		);
		expect(text).toBe('Передаю агенту задачі «Кнопка».');
		expect(actions).toEqual([
			{ kind: 'send_to_task', task: 't1', text: 'Make the button blue' },
			{ kind: 'create_task', projects: ['admin'], title: 'Нова кнопка', prompt: 'Add a button' },
			{ kind: 'watch', kinds: ['ci', 'pr-merged'] },
			{ kind: 'note', note: 'summary' },
		]);
	});
});
