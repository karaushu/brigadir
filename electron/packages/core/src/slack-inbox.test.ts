import { describe, expect, it } from 'vitest';
import {
	addDays,
	dayKey,
	isSlackInboxTarget,
	isSlackMention,
	isUserToken,
	missingUserScopes,
	slackAnswers,
	slackArchiveRows,
	slackArchived,
	slackDayAnswer,
	slackDayPrompt,
	slackDayRows,
	slackInitials,
	slackIsOwn,
	slackLatestMentions,
	slackMentionAnswer,
	slackMentionKind,
	slackMentionPrompt,
	slackMentionStatus,
	slackRecentMentions,
	slackTextPieces,
	slackTodoList,
	slackTodoOf,
	slackWeekAnswer,
	slackWeekPrompt,
	slackWeekRows,
	weekDays,
	weekKey,
	weekMonday,
	type SlackMe,
	type SlackMention,
	type SlackMentionRow,
} from './slack-inbox';
import { slackManifest } from './brigadir-chat';
import { slackInboxCount } from './messages';

const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
	new Date(year, month - 1, day, hour, minute).getTime();
const ts = (ms: number) => `${Math.floor(ms / 1000)}.000100`;
const me: SlackMe = {
	user: 'UME',
	groups: ['SIOS'],
	bot: 'UBOT',
	here: false,
	threads: new Set(['C1/1700000000.000100']),
	ownDm: true,
};
function mention(over: Partial<SlackMention> = {}): SlackMention {
	const time = over.ts ?? '1700000000.000200',
		channel = over.channel ?? 'C1';
	return {
		id: `${channel}/${time}`,
		ts: time,
		channel,
		channelName: 'b2c',
		dm: false,
		author: 'UOLENA',
		text: '<@UME> нові тексти до пʼятниці',
		thread: null,
		kind: 'member',
		permalink: 'https://acme.slack.com/archives/C1/p1700000000000200',
		answered: null,
		agentState: 'pending',
		agent: null,
		suggestion: 'open',
		todo: null,
		context: [],
		...over,
	};
}

describe('the person’s token (spec/todo-and-slack-inbox#slack-inbox-source)', () => {
	it('takes only a user token and names the missing user scopes', () => {
		expect(isUserToken('xoxp-1234-5678-abcdef')).toBe(true);
		expect(isUserToken('xoxb-1234-5678-abcdef')).toBe(false);
		expect(missingUserScopes('channels:history,users:read')).toEqual([
			'groups:history',
			'im:history',
			'mpim:history',
			'usergroups:read',
			'search:read',
		]);
		expect(missingUserScopes(null)).toEqual([]);
	});
	it('puts the user scopes and user events into the setup manifest', () => {
		const manifest = slackManifest('Jarvis');
		expect(manifest.oauth_config.scopes.user).toContain('search:read');
		expect(manifest.settings.event_subscriptions.user_events).toEqual([
			'message.channels',
			'message.groups',
			'message.im',
			'message.mpim',
		]);
	});
});

describe('what counts as a mention', () => {
	const message = (over: Record<string, string>) => ({
		ts: '1700000001.000100',
		channel: 'C1',
		user: 'UOLENA',
		...over,
	});
	it('the member ID, a user group of the person, a DM, a reply in the person’s thread', () => {
		expect(slackMentionKind(message({ text: 'hi <@UME>' }), me)).toBe('member');
		expect(slackMentionKind(message({ text: 'hi <@UME|andy>' }), me)).toBe('member');
		expect(slackMentionKind(message({ text: '<!subteam^SIOS|@ios> look' }), me)).toBe('group');
		expect(slackMentionKind(message({ text: '<!subteam^SWEB|@web> look' }), me)).toBeNull();
		expect(slackMentionKind(message({ text: 'hey', channel: 'D1', channel_type: 'im' }), me)).toBe(
			'dm'
		);
		expect(
			slackMentionKind(message({ text: 'hey', channel: 'G1', channel_type: 'mpim' }), me)
		).toBe('dm');
		expect(slackMentionKind(message({ text: 'next', thread_ts: '1700000000.000100' }), me)).toBe(
			'thread'
		);
		expect(
			slackMentionKind(message({ text: 'next', thread_ts: '1700000000.000999' }), me)
		).toBeNull();
	});
	it('a DM of the bot is not the person’s', () => {
		expect(
			slackMentionKind(message({ text: 'hey', channel: 'D1', channel_type: 'im' }), {
				...me,
				ownDm: false,
			})
		).toBeNull();
	});
	it('@here and @channel only with the switch on', () => {
		expect(slackMentionKind(message({ text: '<!here> release' }), me)).toBeNull();
		expect(slackMentionKind(message({ text: '<!channel> release' }), { ...me, here: true })).toBe(
			'here'
		);
	});
	it('never the bot’s posts, the person’s own, edits or joins', () => {
		expect(slackMentionKind(message({ text: '<@UME>', user: 'UBOT' }), me)).toBeNull();
		expect(slackMentionKind(message({ text: '<@UME>', bot_id: 'B1' }), me)).toBeNull();
		expect(slackMentionKind(message({ text: '<@UME>', user: 'UME' }), me)).toBeNull();
		expect(slackMentionKind(message({ text: '<@UME>', subtype: 'channel_join' }), me)).toBeNull();
		expect(slackMentionKind(message({ text: '<@UME>', subtype: 'thread_broadcast' }), me)).toBe(
			'member'
		);
		expect(slackIsOwn(message({ user: 'UME', text: 'ok' }), me)).toBe(true);
		expect(slackIsOwn(message({ user: 'UME', text: 'ok', subtype: 'message_changed' }), me)).toBe(
			false
		);
	});
});

describe('answered and waiting', () => {
	it('the person wrote after it in its thread; a DM — anywhere in that DM', () => {
		const root = mention();
		expect(slackAnswers(root, { channel: 'C1', ts: '1700000005.000100', thread: root.ts })).toBe(
			true
		);
		expect(slackAnswers(root, { channel: 'C1', ts: '1700000005.000100', thread: null })).toBe(
			false
		);
		expect(slackAnswers(root, { channel: 'C1', ts: '1699999999.000100', thread: root.ts })).toBe(
			false
		);
		const reply = mention({ thread: '1700000000.000100' });
		expect(
			slackAnswers(reply, { channel: 'C1', ts: '1700000005.000100', thread: '1700000000.000100' })
		).toBe(true);
		const dm = mention({ channel: 'D1', dm: true });
		expect(slackAnswers(dm, { channel: 'D1', ts: '1700000005.000100', thread: null })).toBe(true);
		expect(slackAnswers(dm, { channel: 'D2', ts: '1700000005.000100', thread: null })).toBe(false);
	});
	it('an ask waits at once; no ask is FYI; without the agent 24 h make it Waiting', () => {
		const time = ts(at(2026, 11, 20, 14, 20));
		const agent = { ask: 'texts', due: null, fyi: false, summary: 'texts', todo: null, list: null };
		expect(slackMentionStatus(mention({ ts: time, agent }), at(2026, 11, 20, 15))).toBe('waiting');
		expect(
			slackMentionStatus(
				mention({ ts: time, agent: { ...agent, ask: null, fyi: true } }),
				at(2026, 11, 20, 15)
			)
		).toBe('fyi');
		expect(
			slackMentionStatus(mention({ ts: time, agent, answered: 'done' }), at(2026, 11, 20, 15))
		).toBe('answered');
		expect(slackMentionStatus(mention({ ts: time }), at(2026, 11, 20, 15))).toBe('fyi');
		expect(slackMentionStatus(mention({ ts: time }), at(2026, 11, 21, 14, 21))).toBe('waiting');
		expect(slackMentionStatus(mention({ ts: time, kind: 'here' }), at(2026, 11, 22))).toBe('fyi');
	});
});

describe('days, weeks and the archive', () => {
	it('keys days and ISO weeks', () => {
		expect(dayKey(at(2026, 11, 20, 23, 59))).toBe('2026-11-20');
		expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
		expect(weekKey('2026-11-20')).toBe('2026-W47');
		expect(weekKey('2027-01-01')).toBe('2026-W53');
		expect(weekMonday('2026-11-20')).toBe('2026-11-16');
		expect(weekDays('2026-W47')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
	});
	const now = at(2026, 11, 20, 18, 40);
	const rows: SlackMentionRow[] = [
		{ ...mention({ ts: ts(at(2026, 11, 20, 14, 20)) }), status: 'waiting', target: null },
		{
			...mention({ ts: ts(at(2026, 11, 20, 11, 40)), thread: '1' }),
			status: 'answered',
			target: null,
		},
		{ ...mention({ ts: ts(at(2026, 11, 19, 9)) }), status: 'answered', target: null },
		{ ...mention({ ts: ts(at(2026, 11, 12, 9)) }), status: 'fyi', target: null },
	];
	it('Mentions — the last 7 days, newest first', () => {
		expect(slackRecentMentions(rows, now).map((row) => row.ts)).toEqual(
			rows.slice(0, 3).map((row) => row.ts)
		);
	});
	it('Days with counts, today always; Weeks of those days', () => {
		const days = slackDayRows(
			rows,
			new Map([
				[
					'2026-11-18',
					{
						schemaVersion: 1 as const,
						day: '2026-11-18',
						wrote: [
							{
								ts: ts(at(2026, 11, 18)),
								channel: 'C1',
								channelName: 'b2c',
								thread: null,
								text: 'ok',
							},
						],
						state: 'none' as const,
						madeAt: null,
						summary: null,
					},
				],
			]),
			now
		);
		expect(days.map((day) => [day.day, day.mentions, day.waiting, day.wrote])).toEqual([
			['2026-11-20', 2, 1, 0],
			['2026-11-19', 1, 0, 0],
			['2026-11-18', 0, 0, 1],
			['2026-11-12', 1, 0, 0],
		]);
		expect(days[0]!.threads).toBe(2);
		const weeks = slackWeekRows(days, new Map(), now);
		expect(weeks.map((week) => [week.week, week.mentions, week.waiting])).toEqual([
			['2026-W47', 3, 1],
			['2026-W46', 1, 0],
		]);
	});
	it('older than 30 days goes to the archive, one row per month', () => {
		expect(slackArchived(ts(at(2026, 10, 20)), now)).toBe(true);
		expect(slackArchived(ts(at(2026, 10, 25)), now)).toBe(false);
		expect(
			slackArchiveRows([
				{ ts: ts(at(2026, 10, 2)) },
				{ ts: ts(at(2026, 10, 9)) },
				{ ts: ts(at(2026, 9, 9)) },
			])
		).toEqual([
			{ month: '2026-10', mentions: 2 },
			{ month: '2026-09', mentions: 1 },
		]);
	});
	it('reads the latest state of each mention from the journal lines', () => {
		const first = mention(),
			later = { ...first, answered: 'done' as const };
		expect(slackLatestMentions([first, { junk: true }, later])).toEqual([later]);
		expect(isSlackMention({ ...first, id: 'C1/1' })).toBe(false);
	});
	it('checks the section’s targets', () => {
		expect(isSlackInboxTarget({ kind: 'day', day: '2026-11-20' })).toBe(true);
		expect(isSlackInboxTarget({ kind: 'week', week: '2026-W47' })).toBe(true);
		expect(isSlackInboxTarget({ kind: 'mention', id: 'C1/1700000000.000200' })).toBe(true);
		expect(isSlackInboxTarget({ kind: 'month', month: '2026-10' })).toBe(true);
		expect(isSlackInboxTarget({ kind: 'mention', id: '../x' })).toBe(false);
	});
});

describe('Add to Todo (spec/todo-and-slack-inbox#slack-inbox-to-todo)', () => {
	const lists = [
		{ name: 'Inbox', project: 'b2c', updatedAt: '2026-11-01T00:00:00Z' },
		{ name: 'Release 1.15', project: 'b2c', updatedAt: '2026-11-19T00:00:00Z' },
		{ name: 'Ideas', project: null, updatedAt: '2026-11-20T00:00:00Z' },
	];
	it('the agent’s list in the project, else the latest changed, else a new Inbox', () => {
		expect(slackTodoList('b2c', 'inbox', lists)).toBe('Inbox');
		expect(slackTodoList('b2c', 'Nope', lists)).toBe('Release 1.15');
		expect(slackTodoList(null, null, lists)).toBe('Ideas');
		expect(slackTodoList('admin', null, lists)).toBe('Inbox');
	});
	it('the agent’s to-do, else its line, else the message', () => {
		expect(slackTodoOf(mention()).title).toBe('@UME нові тексти до пʼятниці');
		expect(
			slackTodoOf(
				mention({
					agent: {
						ask: 'texts',
						due: null,
						fyi: false,
						summary: 's',
						todo: { title: 'Update ATT texts', description: 'uk, en, pl' },
						list: null,
					},
				})
			)
		).toEqual({ title: 'Update ATT texts', description: 'uk, en, pl' });
	});
});

describe('the agent (spec/todo-and-slack-inbox#slack-inbox-agent)', () => {
	it('asks in English for JSON in the interface language, with the lists to pick from', () => {
		const prompt = slackMentionPrompt({
			locale: 'uk',
			today: '2026-11-20',
			author: 'Olena',
			where: '#b2c',
			text: '@Andy нові тексти',
			thread: [{ author: 'Olena', text: '@Andy нові тексти', mention: true }],
			lists: ['Release 1.15'],
		});
		expect(prompt).toContain('Write ask, summary and todo in Ukrainian.');
		expect(prompt).toContain('"Release 1.15"');
		expect(prompt).toContain('>> Olena: @Andy нові тексти');
	});
	it('reads the per-mention answer and drops a list it made up', () => {
		const said = `Here it is:\n{"ask": "Нові ATT-тексти до пʼятниці", "due": "2026-11-21", "fyi": false, "summary": "Нові ATT-тексти", "todo": {"title": "Оновити ATT-тексти", "description": "uk, en, pl"}, "list": "release 1.15"}`;
		expect(slackMentionAnswer(said, ['Release 1.15'])).toEqual({
			ask: 'Нові ATT-тексти до пʼятниці',
			due: '2026-11-21',
			fyi: false,
			summary: 'Нові ATT-тексти',
			todo: { title: 'Оновити ATT-тексти', description: 'uk, en, pl' },
			list: 'Release 1.15',
		});
		expect(
			slackMentionAnswer(
				'{"ask": null, "summary": "FYI onboarding", "list": "Made up", "todo": {"title": "x"}}',
				[]
			)
		).toEqual({
			ask: null,
			due: null,
			fyi: true,
			summary: 'FYI onboarding',
			todo: null,
			list: null,
		});
		expect(slackMentionAnswer('no json', [])).toBeNull();
		expect(slackMentionAnswer('{"ask": "x"}', [])).toBeNull();
	});
	it('reads a day: asks of known mentions only, did and worth', () => {
		const prompt = slackDayPrompt({
			locale: 'en',
			day: '2026-11-20',
			mentions: [{ id: 'C1/1.1', author: 'Olena', where: '#b2c', text: 'texts', ask: 'texts' }],
			wrote: [{ where: '#b2c', thread: 'C1/1.1', text: 'on it' }],
		});
		expect(prompt).toContain('[C1/1.1] Olena in #b2c: texts');
		expect(prompt).toContain('3 to 6 lines');
		expect(
			slackDayAnswer(
				'{"asks": [{"id": "C1/1.1", "line": "Texts by Friday"}, {"id": "C9/9", "line": "x"}], "did": ["Answered Olena"], "worth": ["Release tomorrow", 3]}',
				['C1/1.1']
			)
		).toEqual({
			asks: [{ id: 'C1/1.1', line: 'Texts by Friday' }],
			did: ['Answered Olena'],
			worth: ['Release tomorrow'],
		});
		expect(slackDayAnswer('{}', [])).toBeNull();
	});
	it('reads a week: five to eight lines', () => {
		expect(
			slackWeekPrompt({
				locale: 'en',
				from: '2026-11-10',
				to: '2026-11-16',
				days: [{ day: '2026-11-10', mentions: 3, did: ['a'], worth: ['b'], asks: ['c'] }],
			})
		).toContain('asked: c');
		expect(slackWeekAnswer('{"lines": ["one", "two", "", "three"]}')).toEqual([
			'one',
			'two',
			'three',
		]);
		expect(slackWeekAnswer('{"lines": []}')).toBeNull();
	});
});

describe('the text as the screen shows it', () => {
	it('lights the person, names the others, keeps links', () => {
		expect(
			slackTextPieces(
				'<@UME> глянь <@UO> і <https://x.dev|PR> &amp; <!here>',
				{ UO: 'Olena Kovalenko', UME: 'Andy' },
				'UME'
			)
		).toEqual([
			{ kind: 'me', text: '@Andy' },
			{ kind: 'text', text: ' глянь ' },
			{ kind: 'mention', text: '@Olena Kovalenko' },
			{ kind: 'text', text: ' і ' },
			{ kind: 'link', text: 'PR', url: 'https://x.dev' },
			{ kind: 'text', text: ' & ' },
			{ kind: 'mention', text: '@here' },
		]);
		expect(slackInitials('Olena Kovalenko')).toBe('OK');
		expect(slackInitials('olena')).toBe('O');
	});
	it('counts in four Ukrainian forms (rule 9)', () => {
		expect(slackInboxCount('uk', 'mention', 1).text).toBe('1 згадка');
		expect(slackInboxCount('uk', 'mention', 3).text).toBe('3 згадки');
		expect(slackInboxCount('uk', 'mention', 9).text).toBe('9 згадок');
		expect(slackInboxCount('uk', 'mention', 1.5).text).toBe('1,5 згадки');
		expect(slackInboxCount('uk', 'waiting', 2).text).toBe('2 чекають');
		expect(slackInboxCount('en', 'thread', 1).text).toBe('1 thread');
		expect(slackInboxCount('en', 'mention', 32).text).toBe('32 mentions');
	});
});
