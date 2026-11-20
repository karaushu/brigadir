import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSlackSettings, type SlackSettings } from '@brigadir/core';
import { SlackInbox, type SlackInboxAgentResult, type SlackInboxTodo } from './slack-inbox';
import { Slack } from './slack';
import type { SocketLike } from './slack-socket';

const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const at = (hour: number, minute = 0) => new Date(2026, 10, 20, hour, minute).getTime();
const ts = (ms: number, n = 100) => `${Math.floor(ms / 1000)}.000${n}`;
const olenaTs = ts(at(14, 20)),
	rootTs = ts(at(14, 2));

/** A fake Slack Web API for the person's token: what each method answers, and every call made. */
function fakeApi() {
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	const search: Record<string, unknown[]> = {};
	const api = async (method: string, body: Record<string, unknown>) => {
		calls.push({ method, body });
		switch (method) {
			case 'chat.getPermalink':
				return {
					ok: true,
					permalink: `https://acme.slack.com/archives/${body.channel}/p${String(body.message_ts).replace('.', '')}`,
				};
			case 'conversations.replies':
				return body.ts === rootTs
					? {
							ok: true,
							messages: [
								{ user: 'UIHOR', ts: rootTs, text: 'Банер мигає на 1.14.2' },
								{ user: 'UOLENA', ts: olenaTs, text: '<@UME> нові тексти до пʼятниці?' },
							],
						}
					: { ok: true, messages: [] };
			case 'conversations.history':
				return { ok: true, messages: [] };
			case 'users.info':
				return {
					ok: true,
					user: {
						real_name: {
							UOLENA: 'Olena Kovalenko',
							UIHOR: 'Ihor Romaniuk',
							UMAKS: 'Maksym Shevchuk',
							UME: 'Andy',
						}[String(body.user)],
					},
				};
			case 'usergroups.list':
				return {
					ok: true,
					usergroups: [
						{ id: 'SIOS', users: ['UME'] },
						{ id: 'SWEB', users: ['UX'] },
					],
				};
			case 'search.messages': {
				const query = String(body.query);
				const key = query.startsWith('from:me')
					? 'from'
					: query.startsWith('to:me')
						? 'to'
						: 'member';
				return { ok: true, messages: { matches: search[key] ?? [], paging: { pages: 1 } } };
			}
			default:
				throw new Error(`unexpected ${method}`);
		}
	};
	return { api, calls, search };
}
function fakeTodo() {
	const added: Parameters<SlackInboxTodo['addTodo']>[0][] = [],
		removed: string[] = [];
	const todo: SlackInboxTodo = {
		addTodo: async (input) => {
			added.push(input);
			return {
				listId: 'todo-1',
				listName: input.list ?? 'Inbox',
				project: input.project,
				itemId: 'i1',
			};
		},
		removeTodo: async (_list, item) => {
			removed.push(item);
		},
		todoLists: async () => [
			{ name: 'Release 1.15', project: 'b2c', updatedAt: '2026-11-19T00:00:00Z' },
			{ name: 'Inbox', project: 'b2c', updatedAt: '2026-11-01T00:00:00Z' },
		],
	};
	return { todo, added, removed };
}
async function setup(
	options: { todo?: boolean; agent?: (prompt: string) => SlackInboxAgentResult } = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slack-inbox-'));
	roots.push(root);
	const { api, calls, search } = fakeApi(),
		todos = fakeTodo(),
		prompts: string[] = [],
		views: number[] = [];
	let now = at(18, 40);
	const agent =
		options.agent ??
		((prompt: string): SlackInboxAgentResult =>
			prompt.startsWith('Someone mentioned')
				? {
						kind: 'text',
						text: '{"ask": "Нові ATT-тексти до пʼятниці", "due": "2026-11-21", "fyi": false, "summary": "Нові ATT-тексти", "todo": {"title": "Оновити ATT-тексти", "description": "uk, en, pl"}, "list": "Release 1.15"}',
					}
				: prompt.startsWith("Summarize the person's day")
					? {
							kind: 'text',
							text: `{"asks": [{"id": "C1/${olenaTs}", "line": "ATT texts"}], "did": ["Answered Ihor"], "worth": ["Release tomorrow"]}`,
						}
					: { kind: 'text', text: '{"lines": ["A calm week"]}' });
	const make = () =>
		new SlackInbox({
			dataRoot: async () => root,
			api,
			account: () => ({ user: 'UME', team: 'acme' }),
			botUser: () => 'UBOT',
			countHere: () => false,
			locale: () => 'uk',
			agent: async (prompt) => {
				prompts.push(prompt);
				return agent(prompt);
			},
			projects: async () => [{ id: 'b2c', name: 'b2c' }],
			channelProject: async (channel) => (channel === 'C1' ? 'b2c' : null),
			channelName: async (channel) => (channel === 'C1' ? 'b2c' : null),
			todo: () => (options.todo ? todos.todo : null),
			changed: (view) => views.push(view.waiting),
			now: () => now,
			summaryDelayMs: 10,
		});
	const inbox = make();
	disposers.push(() => inbox.dispose());
	const event = (event: Record<string, unknown>, user = true) =>
		inbox.event({
			event: { type: 'message', ...event },
			authorizations: [{ user_id: user ? 'UME' : 'UBOT', is_bot: !user }],
		});
	return {
		root,
		inbox,
		calls,
		search,
		prompts,
		views,
		event,
		todos,
		make,
		setNow: (value: number) => (now = value),
		settle: async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			await inbox.settled();
		},
	};
}

describe('SlackInbox (spec/todo-and-slack-inbox#slack-inbox)', () => {
	it('keeps a mention with its thread, names and the agent’s answer; the person’s reply answers it', async () => {
		const test = await setup();
		await test.event({
			channel: 'C1',
			user: 'UOLENA',
			ts: olenaTs,
			thread_ts: rootTs,
			text: '<@UME> нові тексти до пʼятниці?',
			channel_type: 'channel',
		});
		await test.settle();
		let view = await test.inbox.view();
		expect(view.mentions).toHaveLength(1);
		const [mention] = view.mentions;
		expect(mention).toMatchObject({
			id: `C1/${olenaTs}`,
			channelName: 'b2c',
			kind: 'member',
			thread: rootTs,
			status: 'waiting',
			agentState: 'done',
			permalink: `https://acme.slack.com/archives/C1/p${olenaTs.replace('.', '')}`,
		});
		expect(mention!.context.map((item) => item.user)).toEqual(['UIHOR', 'UOLENA']);
		expect(mention!.agent?.list).toBeNull();
		expect(view.people.UOLENA).toBe('Olena Kovalenko');
		expect(view.waiting).toBe(1);
		// The prompt is English and names the person by name, the thread marked.
		expect(test.prompts[0]).toContain('Write ask, summary and todo in Ukrainian.');
		expect(test.prompts[0]).toContain('>> Olena Kovalenko: @Andy нові тексти');
		// The person writes in the thread: answered, and it is a day's own message.
		await test.event({
			channel: 'C1',
			user: 'UME',
			ts: ts(at(14, 40)),
			thread_ts: rootTs,
			text: 'так, до пʼятниці',
		});
		await test.settle();
		view = await test.inbox.view();
		expect(view.mentions[0]!.status).toBe('answered');
		expect(view.days[0]).toMatchObject({
			day: '2026-11-20',
			mentions: 1,
			waiting: 0,
			wrote: 1,
			threads: 1,
		});
		// The journal is appended, never rewritten; a new inbox reads the latest state.
		const lines = (await readFile(join(test.root, 'slack-inbox', 'mentions.jsonl'), 'utf8'))
			.trim()
			.split('\n');
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect((await test.make().view()).mentions[0]!.answered).toBe('reply');
		expect(await readdir(join(test.root, 'slack-inbox', 'days'))).toEqual(['2026-11-20.json']);
	});
	it('a reply in a thread the person wrote in counts; a DM of the bot does not', async () => {
		const test = await setup();
		await test.event({ channel: 'C1', user: 'UME', ts: rootTs, text: 'the banner blinks' });
		await test.event({
			channel: 'C1',
			user: 'UIHOR',
			ts: ts(at(15)),
			thread_ts: rootTs,
			text: 'fixed in 1.14.3',
		});
		await test.event(
			{ channel: 'D9', user: 'UMAKS', ts: ts(at(15, 5)), text: 'to the bot', channel_type: 'im' },
			false
		);
		await test.event({
			channel: 'D1',
			user: 'UMAKS',
			ts: ts(at(15, 6)),
			text: 'ліміт API?',
			channel_type: 'im',
		});
		await test.event({
			channel: 'C2',
			user: 'UMAKS',
			ts: ts(at(15, 7)),
			text: '<!subteam^SIOS|@ios> look',
		});
		await test.event({ channel: 'C2', user: 'UBOT', ts: ts(at(15, 8)), text: '<@UME> CI passed' });
		await test.settle();
		const view = await test.inbox.view();
		expect(view.mentions.map((mention) => [mention.channel, mention.kind])).toEqual([
			['C2', 'group'],
			['D1', 'dm'],
			['C1', 'thread'],
		]);
	});
	it('fills the gap with search.messages on start and marks the day searched', async () => {
		const test = await setup();
		test.search.member = [
			{
				ts: olenaTs,
				user: 'UOLENA',
				text: '<@UME> нові тексти',
				permalink: `https://acme.slack.com/archives/C1/p1?thread_ts=${rootTs}`,
				channel: { id: 'C1', name: 'b2c' },
			},
		];
		test.search.to = [
			{
				ts: ts(at(13, 5)),
				user: 'UMAKS',
				text: 'ліміт?',
				permalink: 'https://x/p2',
				channel: { id: 'D1', is_im: true },
			},
		];
		test.search.from = [
			{
				ts: ts(at(14, 40)),
				user: 'UME',
				text: 'ok',
				permalink: `https://x/p3?thread_ts=${rootTs}`,
				channel: { id: 'C1', name: 'b2c' },
			},
		];
		await test.inbox.catchUp();
		await test.settle();
		const queries = test.calls
			.filter((call) => call.method === 'search.messages')
			.map((call) => call.body.query);
		expect(queries).toEqual([
			'<@UME> after:2026-11-13',
			'to:me after:2026-11-13',
			'from:me after:2026-11-13',
		]);
		const view = await test.inbox.view();
		expect(view.mentions.map((mention) => [mention.channel, mention.kind, mention.status])).toEqual(
			[
				['C1', 'member', 'answered'],
				['D1', 'dm', 'waiting'],
			]
		);
		expect(view.mentions[0]!.permalink).toBe(
			`https://acme.slack.com/archives/C1/p1?thread_ts=${rootTs}`
		);
		const state = JSON.parse(await readFile(join(test.root, 'slack-inbox', 'state.json'), 'utf8'));
		expect(state).toMatchObject({
			schemaVersion: 1,
			searchDay: '2026-11-20',
			groups: { ids: ['SIOS'] },
		});
		// The next start searches from the day it reached.
		test.setNow(at(18, 40) + 86_400_000);
		await test.inbox.catchUp();
		expect(test.calls.filter((call) => call.method === 'search.messages').at(-1)!.body.query).toBe(
			'from:me after:2026-11-19'
		);
	});
	it('makes a day’s summary on Refresh, and says when the agent is out of quota', async () => {
		let quota = false;
		const test = await setup({
			agent: (prompt) =>
				quota
					? { kind: 'quota' }
					: prompt.startsWith('Someone mentioned')
						? {
								kind: 'text',
								text: '{"ask": "texts", "fyi": false, "summary": "texts", "due": null, "todo": null, "list": null}',
							}
						: {
								kind: 'text',
								text: `{"asks": [{"id": "C1/${olenaTs}", "line": "ATT texts"}], "did": ["Answered Ihor"], "worth": ["Release tomorrow"]}`,
							},
		});
		await test.event({
			channel: 'C1',
			user: 'UOLENA',
			ts: olenaTs,
			thread_ts: rootTs,
			text: '<@UME> тексти',
		});
		await test.settle();
		await test.inbox.refresh({ kind: 'day', day: '2026-11-20' });
		let day = (await test.inbox.view()).days[0]!;
		expect(day.file).toMatchObject({
			state: 'ready',
			summary: {
				asks: [{ id: `C1/${olenaTs}`, line: 'ATT texts' }],
				did: ['Answered Ihor'],
				worth: ['Release tomorrow'],
			},
		});
		expect(
			test.prompts.some((prompt) => prompt.includes(`[C1/${olenaTs}] Olena Kovalenko in #b2c`))
		).toBe(true);
		quota = true;
		await test.inbox.refresh(null);
		day = (await test.inbox.view()).days[0]!;
		expect(day.file?.state).toBe('quota');
		// The summary made before stays readable.
		expect(day.file?.summary?.did).toEqual(['Answered Ihor']);
		const mention = (await test.inbox.view()).mentions[0]!;
		expect(mention.status).toBe('waiting');
	});
	it('on the first opening of a day summarizes yesterday and, in a new week, last week', async () => {
		const test = await setup();
		await test.event({
			channel: 'C1',
			user: 'UOLENA',
			ts: olenaTs,
			thread_ts: rootTs,
			text: '<@UME> тексти',
		});
		await test.settle();
		// Monday, Nov 23.
		test.setNow(new Date(2026, 10, 23, 9).getTime());
		await test.inbox.opened(true);
		await test.settle();
		const view = await test.inbox.view();
		expect(view.days.find((day) => day.day === '2026-11-20')?.file?.state).toBe('ready');
		expect(view.weeks.find((week) => week.week === '2026-W47')?.file).toMatchObject({
			state: 'ready',
			lines: ['A calm week'],
		});
		const before = test.prompts.length;
		await test.inbox.opened(false);
		await test.inbox.opened(true);
		expect(test.prompts.length).toBe(before);
	});
	it('Add to Todo puts the to-do in the channel’s project and the agent’s list; Undo takes it back', async () => {
		const test = await setup({ todo: true });
		await test.event({
			channel: 'C1',
			user: 'UOLENA',
			ts: olenaTs,
			thread_ts: rootTs,
			text: '<@UME> тексти',
		});
		await test.settle();
		let mention = (await test.inbox.view()).mentions[0]!;
		expect(mention.agent?.list).toBe('Release 1.15');
		expect(mention.target).toEqual({ project: 'b2c', list: 'Release 1.15' });
		const ref = await test.inbox.addTodo(mention.id);
		expect(ref).toEqual({
			listId: 'todo-1',
			listName: 'Release 1.15',
			project: 'b2c',
			itemId: 'i1',
		});
		expect(test.todos.added[0]).toEqual({
			project: 'b2c',
			list: 'Release 1.15',
			title: 'Оновити ATT-тексти',
			description: 'uk, en, pl',
			source: {
				kind: 'slack',
				permalink: mention.permalink,
				channel: '#b2c',
				author: 'Olena Kovalenko',
				ts: olenaTs,
				mention: mention.id,
			},
		});
		mention = (await test.inbox.view()).mentions[0]!;
		expect(mention.todo).toEqual(ref);
		expect(mention.target).toBeNull();
		await test.inbox.undoTodo(mention.id);
		expect(test.todos.removed).toEqual(['i1']);
		expect((await test.inbox.view()).mentions[0]!.todo).toBeNull();
	});
	it('Done answers without a reply; a dismissed suggestion stays dismissed; without Todo there is no Add', async () => {
		const test = await setup();
		await test.event({
			channel: 'C1',
			user: 'UOLENA',
			ts: olenaTs,
			thread_ts: rootTs,
			text: '<@UME> тексти',
		});
		await test.settle();
		const id = `C1/${olenaTs}`;
		await test.inbox.done(id);
		await test.inbox.dismiss(id);
		const view = await test.make().view();
		expect(view.todo).toBe(false);
		expect(view.mentions[0]).toMatchObject({
			answered: 'done',
			status: 'answered',
			suggestion: 'dismissed',
			target: null,
		});
		await expect(test.inbox.addTodo(id)).rejects.toThrow('Todo is off');
	});
});

class FakeSocket implements SocketLike {
	readyState = 1;
	sent: unknown[] = [];
	closed = false;
	onopen: SocketLike['onopen'] = null;
	onmessage: SocketLike['onmessage'] = null;
	onclose: SocketLike['onclose'] = null;
	onerror: SocketLike['onerror'] = null;
	constructor(readonly url: string) {}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
	}
	emit(value: unknown) {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
}

describe('Slack with the person’s token (spec/todo-and-slack-inbox#slack-inbox-source)', () => {
	it('seals the user token after auth.test, listens for the section without @ mentions, and keeps a DM of the person away from the bot', async () => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-slack-user-'));
		roots.push(root);
		const settings: SlackSettings = { ...defaultSlackSettings, memberId: 'UME' };
		const sockets: FakeSocket[] = [];
		const calls: { method: string; auth: string }[] = [];
		const helper: string[] = [];
		const slack = new Slack({
			dataRoot: async () => root,
			vault: () => ({
				seal: (text) => Buffer.from(`v:${text}`),
				open: (b) => b.toString().slice(2),
			}),
			env: { SLACK_CI_BOT_TOKEN: 'xoxb-1234567890-abcdefghij' },
			projects: async () => [],
			settings: () => settings,
			enabled: () => true,
			changed: () => {},
			refused: () => {},
			backoff: () => 10,
			socket: (url) => {
				const socket = new FakeSocket(url);
				sockets.push(socket);
				return socket;
			},
			brigadir: {
				helper: async (prompt: string) => {
					helper.push(prompt);
					return null;
				},
			} as never,
			inbox: {
				locale: () => 'en',
				agent: async () => ({ kind: 'none' }),
				projects: async () => [],
				todo: () => null,
				changed: () => {},
			},
			fetch: (async (url: string, init: RequestInit) => {
				const method = url.split('/').pop()!,
					auth = (init.headers as Record<string, string>).authorization ?? '';
				calls.push({ method, auth });
				const user = auth.includes('xoxp-');
				const reply =
					method === 'auth.test'
						? user
							? auth.includes('xoxp-bad')
								? { ok: false, error: 'invalid_auth' }
								: { ok: true, user: 'andy', user_id: 'UME', team: 'acme' }
							: { ok: true, user: 'ci_bot', user_id: 'UBOT', team: 'acme' }
						: method === 'apps.connections.open'
							? { ok: true, url: 'wss://wss.slack.test/link' }
							: method === 'search.messages'
								? { ok: true, messages: { matches: [], paging: { pages: 1 } } }
								: method === 'users.info'
									? { ok: true, user: { real_name: 'Maksym Shevchuk' } }
									: { ok: true, messages: [], permalink: 'https://acme.slack.com/archives/D1/p1' };
				return new Response(JSON.stringify(reply), {
					headers:
						user && method === 'auth.test'
							? { 'x-oauth-scopes': 'channels:history,users:read' }
							: {},
				});
			}) as typeof fetch,
		});
		disposers.push(() => slack.dispose());
		await slack.refresh();
		expect(slack.state().account).toEqual({ state: 'off' });
		await expect(slack.connectUser('xoxp-bad-1234567890')).rejects.toThrow('invalid_auth');
		expect(slack.state().account).toEqual({ state: 'off' });
		const state = await slack.connectUser('xoxp-1234-5678-abcdef');
		expect(state.account).toEqual({
			state: 'on',
			user: 'andy',
			team: 'acme',
			missing: ['groups:history', 'im:history', 'mpim:history', 'usergroups:read', 'search:read'],
		});
		const sealed = JSON.parse(await readFile(join(root, 'slack', 'user-token.json'), 'utf8'));
		expect(sealed).toEqual({
			schemaVersion: 1,
			sealed: Buffer.from('v:xoxp-1234-5678-abcdef').toString('base64'),
		});
		expect(JSON.stringify(slack.state())).not.toContain('xoxp-');
		// No app token yet: nothing to listen with.
		expect(slack.state().listen).toEqual({ state: 'no-token' });
		await slack.setAppToken('xapp-1-A0123-4567-abcdef');
		await new Promise((resolve) => setTimeout(resolve, 30));
		// `Create tasks from Slack` is off, yet the section's events open Socket Mode.
		expect(settings.mentions.on).toBe(false);
		expect(sockets).toHaveLength(1);
		sockets[0]!.emit({ type: 'hello', num_connections: 1 });
		sockets[0]!.emit({
			envelope_id: 'e1',
			type: 'events_api',
			payload: {
				event_id: 'Ev1',
				authorizations: [{ user_id: 'UME', is_bot: false }],
				event: {
					type: 'message',
					channel: 'D1',
					channel_type: 'im',
					user: 'UMAKS',
					ts: '1793354600.000200',
					text: 'ліміт API?',
				},
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		await slack.inbox!.settled();
		const view = await slack.inbox!.view();
		expect(view.mentions.map((mention) => [mention.channel, mention.kind])).toEqual([['D1', 'dm']]);
		// The section's reads go with the person's token; the bot never answered the DM.
		expect(
			calls
				.filter((call) => call.method === 'conversations.history')
				.every((call) => call.auth.includes('xoxp-'))
		).toBe(true);
		expect(calls.some((call) => call.method === 'chat.postMessage')).toBe(false);
		expect(helper).toEqual([]);
		await slack.disconnectUser();
		expect(slack.state().account).toEqual({ state: 'off' });
		expect(sockets[0]!.closed).toBe(true);
	});
});
