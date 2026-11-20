import { describe, expect, it } from 'vitest';
import { defaultSlackSettings, isAppToken, isSlackSettings, withSlackDefaults } from './slack';
import {
	slackActionOf,
	slackAckOf,
	slackAgentSteps,
	slackButtons,
	slackFindTasks,
	slackMentionText,
	slackFindNotes,
	slackNoteAddition,
	slackNoteAppended,
	slackNoteText,
	slackProjectPrefix,
	slackProjectsNamed,
	slackVerbatim,
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
		name: 'business',
		rest: 'fix the phone field',
	});
	expect(slackProjectPrefix('In acme app: add a test', projects)).toEqual({
		project: 'p2',
		name: 'acme app',
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
	expect(slackLocalize(slackReply.noteSaved('admin', 'Release plan'), 'en')).toBe(
		'📝 *Note saved* — admin\n🗒️ Note: Release plan'
	);
	expect(slackLocalize(slackReply.noteAdded(null, 'Плани'), 'uk')).toBe(
		'📝 *Додано до нотатки* — Без проєкту\n🗒️ Нотатка: Плани'
	);
	expect(
		slackLocalize(
			slackReply.severalNotes('план', [
				{ title: 'План релізу', project: 'admin' },
				{ title: 'План', project: null },
			]),
			'uk'
		)
	).toBe(
		'🤔 *Підходить кілька нотаток «план»* — План релізу (admin) · План (Без проєкту). Яку нотатку?'
	);
	expect(
		slackLocalize(
			slackReply.severalProjects('admin', ['admin (admin-web)', 'admin (admin-api)']),
			'en'
		)
	).toBe(
		'🤔 *Several projects match admin* — admin (admin-web) · admin (admin-api). Which project?'
	);
	expect(slackLocalize(slackReply.agentSilent, 'uk')).toBe(
		'🤷 *Агент не відповів* — спитай у Бригадирі.'
	);
	// Names are never translated: a note titled like a fixed phrase stays as it is.
	expect(slackLocalize(slackReply.noteChoice('Create note', null), 'uk')).toBe(
		'Create note · Без проєкту'
	);
	expect(slackLocalize(slackReply.noteSaved('R&D <x>', 'Which note?'), 'uk')).toBe(
		'📝 *Нотатку збережено* — R&amp;D &lt;x&gt;\n🗒️ Нотатка: Which note?'
	);
	expect(slackLocalize(slackReply.noteChoice('R&D', 'admin'), 'en')).toBe('R&D · admin');
	expect(slackLocalize(slackReply.noNote('Ideas'), 'uk')).toBe(
		'🔎 *Немає нотатки «Ideas»* — створити?'
	);
	expect(
		slackNoteAppended(
			'# Plan\n\n- ship\n\n\n',
			slackNoteAddition({ channel: '#deploys', permalink: null, body: 'freeze at noon' })
		)
	).toBe('# Plan\n\n- ship\n\nFrom Slack: #deploys thread\n\nfreeze at noon\n');
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
				'ACTION create_task {"projects": ["b2c"], "title": "ATT", "base": "master"}',
				'ACTION create_task {"projects": ["b2c"], "title": "Bad base", "base": "--upload-pack=x"}',
				'ACTION watch {"kinds": ["ci", "merged"]}',
				'ACTION note {"kind": "summary"}',
				'ACTION note {"kind": "text", "text": "  купити  молоко ", "title": "Покупки", "append": "Списки", "project": "home"}',
				'ACTION note {"kind": "text"}',
				'ACTION create_task {"title": "no project"}',
				'ACTION send_to_task {broken',
			].join('\n')
		);
		expect(text).toBe('Передаю агенту задачі «Кнопка».');
		expect(actions).toEqual([
			{ kind: 'send_to_task', task: 't1', text: 'Make the button blue' },
			{
				kind: 'create_task',
				projects: ['admin'],
				title: 'Нова кнопка',
				prompt: 'Add a button',
				base: null,
			},
			{ kind: 'create_task', projects: ['b2c'], title: 'ATT', prompt: null, base: 'master' },
			{ kind: 'create_task', projects: ['b2c'], title: 'Bad base', prompt: null, base: null },
			{ kind: 'watch', kinds: ['ci', 'pr-merged'] },
			{
				kind: 'note',
				note: 'summary',
				text: null,
				title: null,
				append: null,
				project: null,
			},
			{
				kind: 'note',
				note: 'text',
				text: '  купити  молоко ',
				title: 'Покупки',
				append: 'Списки',
				project: 'home',
			},
		]);
	});
});

describe('notes from Slack', () => {
	it('finds the person’s words as they wrote them, spacing, quotes and case aside', () => {
		const message = 'save a note: Deploy “after” 6 pm —\n  ask Olha first';
		expect(slackVerbatim('deploy "after" 6 pm - ask olha first', [message])).toBe(
			'Deploy “after” 6 pm —\n  ask Olha first'
		);
		expect(slackVerbatim('Купити молоко', ['', 'тред: купити   молоко!'])).toBe('купити   молоко');
		expect(slackVerbatim('Buy milk tomorrow', [message])).toBeNull();
		expect(slackVerbatim('   ', [message])).toBeNull();
	});
	it('names notes by exact title first, else by a part of it; several stay several', () => {
		const notes = [
			{ id: 'n1', title: 'Release plan', project: 'p1' },
			{ id: 'n2', title: 'Release plan v2', project: null },
			{ id: 'n3', title: '', project: null },
			{ id: 'n4', title: 'Ideas', project: 'p2' },
		];
		expect(slackFindNotes('«release plan»', notes).map((note) => note.id)).toEqual(['n1']);
		expect(slackFindNotes('release', notes).map((note) => note.id)).toEqual(['n1', 'n2']);
		expect(slackFindNotes('roadmap', notes)).toEqual([]);
		expect(slackFindNotes('', notes)).toEqual([]);
	});
	it('names projects by name, id or folder, case aside', () => {
		const list = [
			{ id: 'p1', name: 'admin', folder: 'admin-web' },
			{ id: 'p2', name: 'Admin', folder: 'admin-api' },
			{ id: 'p3', name: 'business' },
		];
		expect(slackProjectsNamed('ADMIN', list).map((item) => item.id)).toEqual(['p1', 'p2']);
		expect(slackProjectsNamed('admin-api', list).map((item) => item.id)).toEqual(['p2']);
		expect(slackProjectsNamed('p3', list).map((item) => item.id)).toEqual(['p3']);
		expect(slackProjectsNamed('shop', list)).toEqual([]);
	});
});
