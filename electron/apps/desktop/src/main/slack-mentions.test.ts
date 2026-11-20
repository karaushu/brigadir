import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
	defaultSlackSettings,
	type SlackAnswer,
	type SlackNotice,
	type SlackSettings,
	type SlackTaskInfo,
} from '@brigadir/core';
import { Slack, type SlackDeps } from './slack';
import type { SlackAnswerResult, SlackSendResult } from './slack-answers';
import type { SlackTaskInput } from './slack-mentions';
import type { SocketLike } from './slack-socket';
import { SlackSessions } from './slack-sessions';

const botToken = 'xoxb-1234567890-abcdefghij',
	appToken = 'xapp-1-A0123-4567-abcdef';
const roots: string[] = [];
const slacks: Slack[] = [];
const sides: SlackSessions[] = [];
afterEach(async () => {
	for (const slack of slacks.splice(0)) slack.dispose();
	for (const side of sides.splice(0)) side.closeAll();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

const thread = '1793354520.000100',
	mentionTs = '1793354600.000200',
	permalink = 'https://acme.slack.com/archives/C0DEPLOY/p1793354520000100';
function mention(user: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		envelope_id: `env-${Math.random()}`,
		type: 'events_api',
		payload: {
			event_id: `Ev${Math.random()}`,
			event: {
				type: 'app_mention',
				user,
				channel: 'C0DEPLOY',
				ts: mentionTs,
				thread_ts: thread,
				text: `<@UBOT> ${text}`,
				...extra,
			},
		},
	};
}

let agentReply: (task: { projectId: string; id: string }, question: string) => string | null = () =>
	null;
let helperReply: (prompt: string) => string | null = () => null;
let codeReply: (question: string) => string = () => '';
async function setup(
	mentions: Partial<SlackSettings['mentions']> = {},
	extra: Partial<SlackDeps> = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slack-mentions-'));
	roots.push(root);
	const calls: { method: string; body: Record<string, any>; auth: string }[] = [];
	const sockets: FakeSocket[] = [];
	const created: SlackTaskInput[] = [];
	const notes: { project: string | null; text: string }[] = [];
	// spec/notifications-slack-notes-and-schedules#slack-note: the notes `append` can find, and what was added to them.
	const noteList: { id: string; title: string; project: string | null }[] = [];
	const appended: { id: string; addition: string }[] = [];
	const projectList = [{ id: 'p', name: 'business', path: root }];
	let notesOn = true;
	const tasks: SlackTaskInfo[] = [];
	const sent: { task: { projectId: string; id: string }; text: string }[] = [];
	const answers: SlackAnswer[] = [];
	// spec/notifications-slack-notes-and-schedules#slack: the side sessions over a fake QuickAsks — what opened, what followed up, what closed.
	const quick = {
		asks: [] as {
			key: { projectId: string; id: string };
			mode: string;
			question: string;
			id: string;
		}[],
		follows: [] as { id: string; question: string }[],
		/** What each new session got besides the question: Brigadir's tasks and the projects. */
		contexts: [] as { facts?: string; projects?: { name: string; path: string }[] }[],
		closed: [] as string[],
		trees: [] as string[],
		clock: 0,
	};
	const listeners = new Map<string, (event: any) => void>();
	const answer = (id: string, question: string) => {
		listeners.get(id)?.({ id, kind: 'text', text: codeReply(question) });
		listeners.get(id)?.({ id, kind: 'done', milliseconds: 1, stopped: false });
	};
	let sessionIds = 0;
	const side = new SlackSessions({
		ask: async (key, request, mode, _thread, context) => {
			quick.asks.push({ key, mode, question: request.question, id: request.id });
			quick.contexts.push(context ?? {});
			answer(request.id, request.question);
		},
		followUp: async (_key, id, question) => {
			if (quick.closed.includes(id)) throw new Error('This quick question is closed');
			quick.follows.push({ id, question });
			answer(id, question);
		},
		stop: async () => {},
		close: (id) => quick.closed.push(id),
		listen: (id, listener) => {
			if (listener) listeners.set(id, listener);
			else listeners.delete(id);
		},
		ensureMainTree: async (projectId) => {
			quick.trees.push(projectId);
		},
		newId: () => `s${++sessionIds}`,
		now: () => quick.clock,
	});
	sides.push(side);
	const results: { send: SlackSendResult; answer: SlackAnswerResult } = {
		send: 'sent',
		answer: 'answered',
	};
	const settings: SlackSettings = {
		...defaultSlackSettings,
		// «Task done» is off by default; these tests post it.
		events: { ...defaultSlackSettings.events, taskDone: true },
		memberId: 'U1AB',
		projects: { p: { channel: 'C0DEPLOY', mention: '' } },
		mentions: { ...defaultSlackSettings.mentions, on: true, people: ['U2CD'], ...mentions },
	};
	const slack = new Slack({
		dataRoot: async () => root,
		vault: () => ({ seal: (text) => Buffer.from(`v:${text}`), open: (b) => b.toString().slice(2) }),
		env: { SLACK_CI_BOT_TOKEN: botToken },
		projects: async () => projectList,
		settings: () => settings,
		enabled: () => true,
		changed: () => {},
		refused: () => {},
		retryMs: 60_000,
		backoff: () => 10,
		socket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		brigadir: {
			notesOn: () => notesOn,
			helper: async (prompt: string) => helperReply(prompt),
			askAgent: async (task, question) => agentReply(task, question),
			askCode: (projectId, question, language, thread, agent) =>
				side.askCode(projectId ?? 'p', {
					thread,
					question,
					language,
					choice: {},
					context: thread.context,
					...(agent?.facts ? { facts: agent.facts } : {}),
					...(agent?.ack ? { ack: agent.ack } : {}),
				}),
			sideSession: (channel, ts) => side.session(channel, ts),
			createTask: async (input) => {
				created.push(input);
				return { projectId: input.projectId, id: 't9', title: input.title };
			},
			tasks: async () => tasks,
			status: async () => ({ plan: { done: 1, total: 3, current: 'Write tests' }, ci: null }),
			createNote: async (project, text) => {
				notes.push({ project, text });
			},
			notes: async () => noteList,
			appendNote: async (id, addition) => {
				appended.push({ id, addition });
			},
			sendToTask: async (task, text) => {
				sent.push({ task, text });
				return results.send;
			},
			answer: async (answer) => {
				answers.push(answer);
				return results.answer;
			},
		},
		fetch: (async (url: string, init: RequestInit) => {
			const method = url.split('/').pop()!,
				type = (init.headers as Record<string, string>)['content-type'] ?? '';
			const body = type.startsWith('application/json')
				? JSON.parse(String(init.body))
				: Object.fromEntries(new URLSearchParams(String(init.body)));
			calls.push({
				method,
				body,
				auth: (init.headers as Record<string, string>).authorization ?? '',
			});
			const reply =
				method === 'auth.test'
					? { ok: true, user: 'dev_ci_bot', user_id: 'UBOT', team: 'acme-team' }
					: method === 'apps.connections.open'
						? { ok: true, url: `wss://wss.slack.test/link/?n=${calls.length}` }
						: method === 'conversations.replies'
							? {
									ok: true,
									messages: [
										{ user: 'U2CD', ts: thread, text: 'Phone field drops the plus' },
										{ user: 'U2CD', ts: mentionTs, text: 'the mention itself' },
									],
								}
							: method === 'chat.getPermalink'
								? { ok: true, permalink }
								: method === 'conversations.info'
									? { ok: false, error: 'missing_scope' }
									: { ok: true, channel: 'C0DEPLOY', ts: `${calls.length}.0` };
			return new Response(JSON.stringify(reply));
		}) as typeof fetch,
		...extra,
	});
	slacks.push(slack);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
	return {
		root,
		slack,
		calls,
		sockets,
		created,
		notes,
		noteList,
		appended,
		projectList,
		tasks,
		sent,
		answers,
		results,
		settings,
		settle,
		quick,
		notesOff: () => (notesOn = false),
		posts: () => calls.filter((call) => call.method === 'chat.postMessage'),
	};
}
async function listening(extra: Partial<SlackDeps> = {}) {
	const test = await setup({}, extra);
	expect((await test.slack.refresh()).listen).toEqual({ state: 'no-token' });
	await test.slack.setAppToken(appToken);
	await test.settle();
	expect(test.sockets).toHaveLength(1);
	test.sockets[0]!.emit({ type: 'hello', num_connections: 1 });
	expect(test.slack.state().listen).toEqual({ state: 'on' });
	return test;
}

it('opens Socket Mode with the app token, sealed apart, and reconnects when Slack asks', async () => {
	const { slack, root, calls, sockets, settle, settings } = await listening();
	const opens = calls.filter((call) => call.method === 'apps.connections.open');
	expect(opens.map((call) => call.auth)).toEqual([`Bearer ${appToken}`, `Bearer ${appToken}`]);
	const sealed = JSON.parse(await readFile(join(root, 'slack', 'app-token.json'), 'utf8'));
	expect(Buffer.from(sealed.sealed, 'base64').toString()).toBe(`v:${appToken}`);
	expect(JSON.stringify(slack.state())).not.toContain('xapp-');
	sockets[0]!.emit({ type: 'disconnect', reason: 'refresh_requested' });
	await settle();
	expect(sockets[0]!.closed).toBe(true);
	expect(sockets).toHaveLength(2);
	// The switch off stops listening.
	settings.mentions = { ...settings.mentions, on: false };
	expect((await slack.listen()).listen).toEqual({ state: 'off' });
	expect(sockets[1]!.closed).toBe(true);
});

it('carries a mention to the agent and makes the task it asks for, with the thread as its context', async () => {
	const { sockets, created, posts, settle, slack, quick } = await listening();
	codeReply = () =>
		'Ставлю задачу.\nACTION create_task {"project": "business", "title": "Fix phone validation", "prompt": "Fix the phone validation on signup"}';
	const envelope = mention('U2CD', 'fix the phone validation on signup');
	try {
		sockets[0]!.emit(envelope);
		expect(sockets[0]!.sent).toEqual([{ envelope_id: envelope.envelope_id }]);
		await settle();
		// The bot only carries: the message goes to the agent as is.
		expect(quick.asks.map((item) => [item.mode, item.question])).toEqual([
			['aboutCode', 'fix the phone validation on signup'],
		]);
		expect(created).toEqual([
			{
				projectId: 'p',
				title: 'Fix phone validation',
				prompt: 'Fix the phone validation on signup',
				context: 'U2CD · 2026-10-30 10:02 UTC\nPhone field drops the plus',
				start: true,
				thread: { channel: 'C0DEPLOY', ts: thread, permalink },
				alsoProjects: [],
			},
		]);
		expect(
			posts()
				.map((post) => post.body.text)
				.slice(-2)
		).toEqual(['Ставлю задачу.', '🆕 *Task created* — business\n📋 Task: Fix phone validation']);
		// The same envelope again (a late ack) is not a second task.
		sockets[0]!.emit(envelope);
		await settle();
		expect(created).toHaveLength(1);
	} finally {
		codeReply = () => '';
	}
	// The task's own events answer in the thread it came from.
	slack.post(
		{
			kind: 'taskDone',
			repo: 'business',
			branch: 'b',
			task: { projectId: 'p', id: 't9', title: 'x' },
			summary: null,
		} as SlackNotice,
		'p'
	);
	await settle();
	expect(posts().at(-1)?.body).toMatchObject({ channel: 'C0DEPLOY', thread_ts: thread });
});

it('refuses someone not on the list with an ephemeral message', async () => {
	const { sockets, created, calls, settle } = await listening();
	sockets[0]!.emit(mention('U9ZZ', 'fix the phone validation'));
	await settle();
	expect(created).toEqual([]);
	expect(
		calls.filter((call) => call.method === 'chat.postEphemeral').map((call) => call.body)
	).toEqual([
		{
			channel: 'C0DEPLOY',
			user: 'U9ZZ',
			thread_ts: thread,
			text: 'Only the people in Brigadir’s Slack settings can create tasks.',
		},
	]);
});

it('gives the agent Brigadir’s tasks and saves a note when it asks, behind the Notes module', async () => {
	const { sockets, tasks, posts, calls, notes, notesOff, settle, quick } = await listening();
	tasks.push({
		projectId: 'p',
		id: 'a',
		title: 'Phone validation',
		status: 'working',
		branch: 'claude/phone',
		prs: [],
		updatedAt: null,
	});
	codeReply = (question) =>
		question.includes('запиши')
			? 'ACTION note {"kind": "thread"}'
			: '⚙️ Phone validation — в роботі';
	try {
		sockets[0]!.emit(mention('U1AB', 'what is the status of phone validation?'));
		await settle();
		expect(quick.contexts[0]!.facts).toContain(
			'- task a "Phone validation" (project business); state Working; board column In progress; branch claude/phone; plan 1 of 3'
		);
		expect(posts().at(-1)?.body.text).toBe('⚙️ Phone validation — в роботі');
		sockets[0]!.emit(mention('U1AB', 'запиши тред'));
		await settle();
		expect(notes).toHaveLength(1);
		expect(notes[0]!.project).toBe('p');
		expect(notes[0]!.text).toContain(`From Slack: [#C0DEPLOY thread](${permalink})`);
		expect(notes[0]!.text).toContain('Phone field drops the plus');
		expect(posts().at(-1)?.body.text).toBe(
			'📝 *Нотатку збережено* — business\n🗒️ Нотатка: Phone field drops the plus'
		);
		notesOff();
		sockets[0]!.emit(mention('U1AB', 'запиши тред'));
		await settle();
		expect(calls.filter((call) => call.method === 'chat.postEphemeral').at(-1)?.body.text).toBe(
			'Нотатки вимкнені в Бригадирі.'
		);
	} finally {
		codeReply = () => '';
	}
});

/** A task's thread, as a posted event starts it: the first event of the task is a message, its `ts` the thread. */
async function taskThread(test: Awaited<ReturnType<typeof listening>>, notice?: SlackNotice) {
	test.slack.post(
		notice ?? {
			kind: 'taskDone',
			repo: 'business',
			branch: 'b',
			task: { projectId: 'p', id: 't9', title: 'Phone validation' },
			summary: null,
		},
		'p'
	);
	await test.settle();
	const post = test.posts().at(-1)!;
	return { post, ts: `${test.calls.indexOf(post) + 1}.0` };
}
function threadReply(
	user: string,
	threadTs: string,
	text: string,
	extra: Record<string, unknown> = {}
) {
	return {
		envelope_id: `env-${Math.random()}`,
		type: 'events_api',
		payload: {
			event_id: `Ev${Math.random()}`,
			event: {
				type: 'message',
				user,
				channel: 'C0DEPLOY',
				ts: `${threadTs}9`,
				thread_ts: threadTs,
				text,
				...extra,
			},
		},
	};
}
function click(
	user: string,
	message: { ts: string; text: string },
	button: any,
	threadTs?: string
) {
	return {
		envelope_id: `env-${Math.random()}`,
		type: 'interactive',
		payload: {
			type: 'block_actions',
			user: { id: user },
			channel: { id: 'C0DEPLOY' },
			container: {
				channel_id: 'C0DEPLOY',
				message_ts: message.ts,
				...(threadTs ? { thread_ts: threadTs } : {}),
			},
			message: { text: message.text },
			actions: [{ action_id: button.action_id, value: button.value }],
		},
	};
}
const ephemerals = (test: Awaited<ReturnType<typeof listening>>) =>
	test.calls.filter((call) => call.method === 'chat.postEphemeral').map((call) => call.body);

it('sends a listed person’s reply in a task’s thread to its agent and says so', async () => {
	const test = await listening();
	const { ts } = await taskThread(test);
	test.sockets[0]!.emit(threadReply('U2CD', ts, 'use <https://e164.test|E.164> please'));
	await test.settle();
	expect(test.sent).toEqual([
		{
			task: { projectId: 'p', id: 't9' },
			text: "A reply from @U2CD in this task's Slack thread:\n\nuse E.164 (https://e164.test) please",
		},
	]);
	expect(test.posts().at(-1)?.body).toMatchObject({
		channel: 'C0DEPLOY',
		thread_ts: ts,
		text: '✅ *Sent to the agent*',
	});
	// The bot's own, an edit, a mention of the bot (the mentions answer it) and a thread that is no task's are not sent.
	for (const envelope of [
		threadReply('U2CD', ts, 'bot says', { bot_id: 'B1' }),
		threadReply('U2CD', ts, 'edited', { subtype: 'message_changed' }),
		threadReply('U2CD', ts, '<@UBOT> what state?'),
		threadReply('U2CD', '1700000000.000001', 'elsewhere'),
	])
		test.sockets[0]!.emit(envelope);
	await test.settle();
	expect(test.sent).toHaveLength(1);
});

it('refuses a reply from someone not on the list and says when the task is gone', async () => {
	const test = await listening();
	const { ts } = await taskThread(test);
	test.sockets[0]!.emit(threadReply('U9ZZ', ts, 'do it differently'));
	await test.settle();
	expect(test.sent).toEqual([]);
	expect(ephemerals(test).at(-1)).toMatchObject({
		user: 'U9ZZ',
		thread_ts: ts,
		text: 'Only the people in Brigadir’s Slack settings can talk to the agent here.',
	});
	test.results.send = 'gone';
	test.sockets[0]!.emit(threadReply('U1AB', ts, 'still there?'));
	await test.settle();
	expect(ephemerals(test).at(-1)).toMatchObject({ user: 'U1AB', text: 'The task is gone.' });
});

it('answers a permission from its button once, then says it was answered in Brigadir', async () => {
	const test = await listening();
	const { post, ts } = await taskThread(test, {
		kind: 'needsYou',
		repo: 'business',
		branch: 'b',
		task: { projectId: 'p', id: 't9', title: 'Phone validation' },
		reason: 'A permission to answer',
		ask: {
			kind: 'permission',
			request: 'perm-1',
			tool: 'Run pnpm test',
			options: ['allow', 'deny'],
		},
	});
	const [allow] = post.body.blocks[1].elements;
	expect(post.body.blocks[1].elements.map((item: any) => item.text.text)).toEqual([
		'Allow',
		'Deny',
	]);
	const message = { ts, text: post.body.text };
	// Someone not on the list cannot answer.
	test.sockets[0]!.emit(click('U9ZZ', message, allow));
	await test.settle();
	expect(test.answers).toEqual([]);
	expect(ephemerals(test).at(-1)?.user).toBe('U9ZZ');
	test.sockets[0]!.emit(click('U2CD', message, allow));
	await test.settle();
	expect(test.answers).toEqual([
		{ kind: 'permission', task: { projectId: 'p', id: 't9' }, request: 'perm-1', option: 'allow' },
	]);
	const update = test.calls.filter((call) => call.method === 'chat.update').at(-1)!.body;
	expect(update).toMatchObject({ channel: 'C0DEPLOY', ts, text: post.body.text });
	expect(update.blocks.at(-1)).toEqual({
		type: 'context',
		elements: [{ type: 'mrkdwn', text: '✅ Allowed by <@U2CD>' }],
	});
	// The same request answered in Brigadir first: the buttons go and the thread hears why.
	test.results.answer = 'already';
	test.sockets[0]!.emit(click('U1AB', message, allow));
	await test.settle();
	expect(test.answers).toHaveLength(2);
	expect(test.posts().at(-1)?.body).toMatchObject({
		thread_ts: ts,
		text: '🙅 *Answered in Brigadir already*',
	});
});

it('posts a schedule’s «Ask» with Run now · Skip and answers the click', async () => {
	const test = await listening();
	const { post, ts } = await taskThread(test, {
		kind: 'scheduleAsk',
		projectId: 'p',
		scheduleId: 's_1',
		schedule: 'Nightly deps',
		project: 'business',
		count: 2,
	});
	expect(post.body.thread_ts).toBeUndefined();
	const [run] = post.body.blocks[1].elements;
	expect(post.body.blocks[1].elements.map((item: any) => item.text.text)).toEqual([
		'Run now',
		'Skip',
	]);
	test.sockets[0]!.emit(click('U1AB', { ts, text: post.body.text }, run));
	await test.settle();
	expect(test.answers).toEqual([
		{ kind: 'schedule', projectId: 'p', schedule: 's_1', option: 'run' },
	]);
	expect(
		test.calls
			.filter((call) => call.method === 'chat.update')
			.at(-1)!
			.body.blocks.at(-1).elements[0].text
	).toBe('▶️ Run now by <@U1AB>');
});

it('takes a message in the bot’s DM as a mention — Slack sends no app_mention there — and starts in the project it names', async () => {
	const { sockets, posts, settle, quick } = await listening();
	codeReply = () => 'У business зараз у роботі Phone validation.';
	try {
		sockets[0]!.emit({
			envelope_id: 'env-dm',
			type: 'events_api',
			payload: {
				event_id: 'EvDM',
				event: {
					type: 'message',
					channel_type: 'im',
					user: 'U1AB',
					channel: 'D0DEV',
					ts: mentionTs,
					text: 'що зараз у роботі в business?',
				},
			},
		});
		await settle();
	} finally {
		codeReply = () => '';
	}
	expect(quick.asks[0]!.key).toEqual({ projectId: 'p', id: 'main-tree' });
	expect(posts().at(-1)?.body).toMatchObject({
		channel: 'D0DEV',
		text: 'У business зараз у роботі Phone validation.',
	});
});

it('asks a task’s agent when the Slack agent says so, and cuts the code out of its answer', async () => {
	const { sockets, tasks, posts, settle } = await listening();
	tasks.push({
		projectId: 'p',
		id: 'a',
		title: 'Phone validation',
		status: 'working',
		branch: 'claude/phone',
		prs: [],
		updatedAt: null,
	});
	const asked: string[] = [];
	codeReply = () => 'ACTION ask_task {"task": "a", "question": "чому так довго?"}';
	agentReply = (task, question) => {
		asked.push(`${task.id}: ${question}`);
		return 'Чекаємо на E.164.\n```ts\nconst secret = 1;\n```';
	};
	try {
		sockets[0]!.emit(mention('U1AB', 'чому phone validation так довго?'));
		await settle();
	} finally {
		codeReply = () => '';
		agentReply = () => null;
	}
	expect(asked).toEqual(['a: чому так довго?']);
	const texts = posts().map((post) => post.body.text);
	expect(texts.at(-2)).toBe('⏳ Питаю агента задачі «Phone validation»…');
	expect(texts.at(-1)).toBe('Чекаємо на E.164.\n_(code omitted)_');
});

it('watches a PR’s CI and merge from the task’s thread, asks what to watch when unclear, and stops — each as the agent asks', async () => {
	const read: string[] = [];
	const test = await listening({
		watching: {
			pr: async (pr) => {
				read.push(`${pr.taskId}/${pr.scopeId}#${pr.number}`);
				return {
					state: 'OPEN',
					repo: 'business',
					head: 'claude/phone',
					base: 'main',
					url: 'https://github.com/acme/business/pull/12',
					headSha: 'abc1234',
					mergeSha: null,
				};
			},
			runs: async () => [],
			run: async () => {
				throw new Error('no run');
			},
			bells: async () => [],
			bell: async () => {},
			task: async () => ({ status: 'working', repo: 'business', branch: 'claude/phone' }),
		},
	});
	const { sockets, tasks, posts, settle, root } = test;
	codeReply = (question) =>
		question === 'fix the phone field'
			? 'ACTION create_task {"project": "business", "title": "fix the phone field"}'
			: question.startsWith('Напиши')
				? 'ACTION watch {"kinds": ["ci", "merged"]}'
				: question === 'let me know when it happens'
					? 'ACTION watch {"kinds": []}'
					: question.includes('#77')
						? 'ACTION watch {"kinds": ["merged"]}'
						: 'ACTION unwatch {}';
	sockets[0]!.emit(mention('U1AB', 'fix the phone field'));
	await settle();
	tasks.push({
		projectId: 'p',
		id: 't9',
		title: 'fix the phone field',
		status: 'working',
		branch: 'claude/phone',
		prs: [
			{
				number: 11,
				url: 'https://github.com/acme/business/pull/11',
				state: 'MERGED',
				scopeId: 's',
			},
			{
				number: 12,
				url: 'https://github.com/acme/business/pull/12',
				state: 'OPEN',
				scopeId: 's',
			},
		],
		updatedAt: null,
	});
	sockets[0]!.emit(
		mention('U2CD', 'Напиши мені тут, коли CI цієї піарки пройде або коли піарка буде змержена')
	);
	await settle();
	expect(posts().at(-1)!.body).toMatchObject({ channel: 'C0DEPLOY', thread_ts: thread });
	expect(posts().at(-1)!.body.text).toBe(
		[
			'👀 *Стежу* — напишу тут, коли:',
			'• 🧪 CI завершиться — <https://github.com/acme/business/pull/12|#12>',
			'• 🔀 PR змержать — <https://github.com/acme/business/pull/12|#12>',
		].join('\n')
	);
	const file = JSON.parse(await readFile(join(root, 'slack', 'watches.json'), 'utf8'));
	expect(
		file.watches.map((watch: any) => [watch.kind, watch.by, watch.ts, watch.pr.number])
	).toEqual([
		['ci', 'U2CD', thread, 12],
		['pr-merged', 'U2CD', thread, 12],
	]);
	// The new watches look at once: the PR is read once for both.
	expect(read).toEqual(['t9/s#12']);

	sockets[0]!.emit(mention('U1AB', 'let me know when it happens'));
	await settle();
	const ask = posts().at(-1)!.body;
	expect(ask.blocks[1].elements.map((item: any) => item.text.text)).toEqual([
		'CI finishes',
		'PR is merged',
		'Task is done',
	]);
	const click = ask.blocks[1].elements[2];
	sockets[0]!.emit({
		envelope_id: 'env-watch',
		type: 'interactive',
		payload: {
			type: 'block_actions',
			user: { id: 'U1AB' },
			channel: { id: 'C0DEPLOY' },
			container: { channel_id: 'C0DEPLOY', message_ts: '9.0', thread_ts: thread },
			message: { text: ask.text },
			actions: [{ action_id: click.action_id, value: click.value }],
		},
	});
	await settle();
	expect(posts().at(-1)!.body.text).toBe(
		'👀 *Watching* — I’ll write here when:\n• 🏁 Task is done — fix the phone field'
	);

	sockets[0]!.emit(mention('U1AB', 'let me know when #77 is merged', { thread_ts: undefined }));
	await settle();
	expect(posts().at(-1)!.body.text).toBe('🔎 *No PR #77 on Brigadir’s tasks*');

	sockets[0]!.emit(mention('U2CD', 'не стеж більше'));
	await settle();
	expect(posts().at(-1)!.body.text).toBe('🛑 *Більше не стежу* · 3');
	expect(JSON.parse(await readFile(join(root, 'slack', 'watches.json'), 'utf8')).watches).toEqual(
		[]
	);
	codeReply = () => '';
});

it('keeps one agent session per thread for ten minutes: a mention or a plain reply continues it', async () => {
	const { sockets, posts, settle, quick } = await listening();
	codeReply = (question) =>
		question.includes('авторизація')
			? 'Сесію перевіряє `verifyToken` у src/auth/session.ts.\n```ts\nconst key = 1;\n```'
			: `answer: ${question}`;
	try {
		sockets[0]!.emit(mention('U1AB', 'як у business працює авторизація?'));
		await settle();
		expect(quick.trees).toEqual(['p']);
		expect(quick.asks).toEqual([
			{
				key: { projectId: 'p', id: 'main-tree' },
				mode: 'aboutCode',
				question: 'як у business працює авторизація?',
				id: 's1',
			},
		]);
		let texts = posts().map((post) => post.body.text);
		expect(texts.at(-1)).toBe(
			'Сесію перевіряє `verifyToken` у src/auth/session.ts.\n_(code omitted)_'
		);
		// A mention in the same thread within ten minutes goes to the same session.
		quick.clock += 9 * 60_000;
		sockets[0]!.emit(mention('U1AB', 'а де перевіряється токен?'));
		await settle();
		// So does a plain reply, without the mention: «перевір».
		sockets[0]!.emit(threadReply('U1AB', thread, 'перевір'));
		await settle();
		expect(quick.follows).toEqual([
			{ id: 's1', question: 'а де перевіряється токен?' },
			{ id: 's1', question: 'перевір' },
		]);
		expect(quick.asks).toHaveLength(1);
		texts = posts().map((post) => post.body.text);
		expect(texts.at(-1)).toBe('answer: перевір');
		// Ten idle minutes later the thread’s session is closed: the next message opens a new one.
		quick.clock += 11 * 60_000;
		sockets[0]!.emit(mention('U1AB', 'where is the Stripe webhook handled?'));
		await settle();
		expect(quick.closed).toContain('s1');
		expect(quick.asks.map((item) => item.id)).toEqual(['s1', 's2']);
	} finally {
		codeReply = () => '';
	}
});

it('posts the agent’s «going to look» first, then its answer (spec/notifications-slack-notes-and-schedules#slack-agent)', async () => {
	const { sockets, posts, settle, quick, settings } = await listening();
	// No channel project: the agent starts in the first project and works it out.
	settings.projects = {};
	codeReply = () =>
		'ACK: Пішов дивитись, що зарелізили сьогодні\nСьогодні в production пішли #1171 і #1216 (деплой о 14:02).';
	try {
		sockets[0]!.emit(
			mention('U1AB', 'что по админке залили сегодня в прод?', { channel: 'C0OTHER' })
		);
		await settle();
	} finally {
		codeReply = () => '';
	}
	expect(quick.asks[0]!.key).toEqual({ projectId: 'p', id: 'main-tree' });
	const texts = posts().map((post) => post.body.text);
	expect(texts.slice(-2)).toEqual([
		'⏳ Пішов дивитись, що зарелізили сьогодні',
		'Сьогодні в production пішли #1171 і #1216 (деплой о 14:02).',
	]);
	expect(texts.join('\n')).not.toContain('Який проєкт');
});

it('hands a change to the agent of the task that covers it', async () => {
	const { sockets, tasks, posts, sent, settle } = await listening();
	tasks.push({
		projectId: 'p',
		id: 'b',
		title: 'Signup button',
		status: 'done',
		branch: 'claude/button',
		prs: [],
		updatedAt: null,
	});
	codeReply = () =>
		'ACTION send_to_task {"task": "b", "text": "Make the signup button blue, as asked in Slack."}';
	try {
		sockets[0]!.emit(mention('U1AB', 'зроби кнопку реєстрації синьою'));
		await settle();
	} finally {
		codeReply = () => '';
	}
	expect(sent).toEqual([
		{
			task: { projectId: 'p', id: 'b' },
			text: "A reply from @U1AB in this task's Slack thread:\n\nMake the signup button blue, as asked in Slack.",
		},
	]);
	expect(posts().at(-1)?.body.text).toBe('📨 *Передав агенту задачі* «Signup button»');
});

// spec/notifications-slack-notes-and-schedules#slack-agent-post.
function agentFetch(
	calls: { method: string; body: Record<string, any> }[],
	post: (body: Record<string, any>) => Record<string, unknown>
) {
	return (async (url: string, init: RequestInit) => {
		const method = url.split('/').pop()!,
			type = (init.headers as Record<string, string>)['content-type'] ?? '';
		const body = type.startsWith('application/json')
			? JSON.parse(String(init.body))
			: Object.fromEntries(new URLSearchParams(String(init.body)));
		calls.push({ method, body });
		const reply =
			method === 'auth.test'
				? { ok: true, user: 'brigadir_bot', user_id: 'UBOT', team: 'acme-team' }
				: method === 'users.info'
					? { ok: true, user: { real_name: 'Brigadir', profile: { display_name: '' } } }
					: method === 'conversations.list'
						? { ok: true, channels: [{ id: 'G0AIDEV', name: 'ai-dev' }] }
						: method === 'conversations.info'
							? { ok: true, channel: { name: 'ai-dev' } }
							: method === 'chat.getPermalink'
								? { ok: true, permalink: 'https://acme.slack.com/archives/G0AIDEV/p1' }
								: method === 'chat.postMessage'
									? post(body)
									: { ok: true };
		return new Response(JSON.stringify(reply));
	}) as typeof fetch;
}

it('posts an agent’s message as the bot to a channel by name, and says how to invite the bot when it is not there', async () => {
	const calls: { method: string; body: Record<string, any> }[] = [];
	let inChannel = false;
	const { slack } = await setup(
		{},
		{
			fetch: agentFetch(calls, (body) =>
				inChannel
					? { ok: true, channel: body.channel, ts: '1793884455.669649' }
					: { ok: false, error: 'channel_not_found' }
			),
		}
	);
	await slack.refresh();
	const task = { projectId: 'p', id: 't1' };
	expect(await slack.agentTarget(task, { channel: '#ai-dev' })).toEqual({
		bot: 'Brigadir',
		label: '#ai-dev',
		channel: 'G0AIDEV',
		threadTs: null,
	});
	expect(await slack.agentPost(task, { channel: '#ai-dev', text: 'на stage' })).toEqual({
		posted: false,
		reason:
			'The bot @Brigadir is not in #ai-dev. Ask the person to run /invite @Brigadir in that channel, then call slack_post again.',
	});
	inChannel = true;
	expect(await slack.agentPost(task, { channel: '#ai-dev', text: 'на stage' })).toEqual({
		posted: true,
		channel: 'G0AIDEV',
		ts: '1793884455.669649',
		permalink: 'https://acme.slack.com/archives/G0AIDEV/p1',
	});
	expect(calls.filter((call) => call.method === 'chat.postMessage').at(-1)!.body).toMatchObject({
		channel: 'G0AIDEV',
		text: 'на stage',
	});
	// A reply under a message by its link; a task without a Slack thread needs a channel.
	await slack.agentPost(task, {
		thread: 'https://acme.slack.com/archives/G0AIDEV/p1793884455669649',
		text: 'ще',
	});
	expect(calls.filter((call) => call.method === 'chat.postMessage').at(-1)!.body).toMatchObject({
		channel: 'G0AIDEV',
		thread_ts: '1793884455.669649',
	});
	await expect(slack.agentPost(task, { text: 'x' })).rejects.toThrow(
		'This task has no Slack thread: name a channel.'
	);
});

it('makes one task across the projects the agent names; their folders join it', async () => {
	const test = await listening({
		projects: async () => [
			{ id: 'p', name: 'business', path: '/w/business' },
			{ id: 'adm', name: 'admin', path: '/w/admin' },
			{ id: 'cho', name: 'choice', path: '/w/chooice.app' },
		],
	});
	codeReply = () =>
		'ACTION create_task {"projects": ["admin", "chooice.app"], "title": "Сховати треди", "prompt": "Hide chat threads"}';
	try {
		test.sockets[0]!.emit(mention('U1AB', 'зробіть задачу'));
		await test.settle();
	} finally {
		codeReply = () => '';
	}
	expect(test.created).toHaveLength(1);
	expect(test.created[0]).toMatchObject({
		projectId: 'adm',
		alsoProjects: ['cho'],
		title: 'Сховати треди',
		prompt: 'Hide chat threads',
	});
	expect(test.posts().at(-1)?.body.text).toBe(
		'🆕 *Задачу створено* — admin + choice\n📋 Задача: Сховати треди'
	);
});

/** Presses the button with this label in the bot's last message with buttons. */
function press(test: Awaited<ReturnType<typeof listening>>, label: string, user = 'U1AB') {
	const ask = test
		.posts()
		.filter((post) => post.body.blocks?.length)
		.at(-1)!.body;
	const button = ask.blocks[1].elements.find((item: any) => item.text.text === label);
	expect(button, label).toBeTruthy();
	test.sockets[0]!.emit(click(user, { ts: '9.0', text: ask.text }, button, thread));
	return test.settle();
}
const buttonLabels = (test: Awaited<ReturnType<typeof listening>>) =>
	test
		.posts()
		.at(-1)!
		.body.blocks[1].elements.map((item: any) => item.text.text);

it('saves the person’s own words as a note, titled as asked, in the channel’s project or a named one', async () => {
	const test = await listening();
	const { sockets, notes, posts, settle, projectList } = test;
	projectList.push({ id: 'p2', name: 'admin', path: test.root });
	codeReply = (question) =>
		question.includes('Olha')
			? 'Зберігаю.\nACTION note {"kind": "text", "text": "deploy after 6 pm, ask olha first", "title": "Deploy window"}'
			: question.includes('admin')
				? 'ACTION note {"kind": "text", "text": "Кнопка «Далі» сіра", "project": "Admin"}'
				: question.includes('shop')
					? 'ACTION note {"kind": "text", "text": "x", "project": "shop"}'
					: 'ACTION note {"kind": "text", "text": "Buy milk tomorrow", "title": "Milk"}';
	try {
		sockets[0]!.emit(mention('U1AB', 'save a note: Deploy after 6 pm,\nask Olha first'));
		await settle();
		expect(notes).toEqual([
			{
				project: 'p',
				text: `# Deploy window\n\nFrom Slack: [#C0DEPLOY thread](${permalink})\n\nDeploy after 6 pm,\nask Olha first\n`,
			},
		]);
		expect(posts().at(-1)?.body.text).toBe('📝 *Note saved* — business\n🗒️ Note: Deploy window');

		// A project other than the channel's; no title asked for — the words' first line.
		sockets[0]!.emit(mention('U1AB', 'запиши в admin: Кнопка «Далі» сіра'));
		await settle();
		expect(notes[1]!.project).toBe('p2');
		expect(notes[1]!.text).toMatch(/^# Кнопка «Далі» сіра\n/);
		expect(posts().at(-1)?.body.text).toBe(
			'📝 *Нотатку збережено* — admin\n🗒️ Нотатка: Кнопка «Далі» сіра'
		);

		// An unknown project is asked back with the list; nothing is saved.
		sockets[0]!.emit(mention('U1AB', 'note in shop: x'));
		await settle();
		expect(notes).toHaveLength(2);
		expect(posts().at(-1)?.body.text).toBe(
			'🤔 *No project shop in Brigadir*\nProjects: business, admin'
		);

		// Words the person did not write are not saved.
		sockets[0]!.emit(mention('U1AB', 'save something about groceries'));
		await settle();
		expect(notes).toHaveLength(2);
		expect(posts().at(-1)?.body.text).toBe(
			'🤔 *The note’s text is not in the message* — write it after the mention.'
		);
	} finally {
		codeReply = () => '';
	}
});

it('asks which project when a name means several, and saves where the person pressed', async () => {
	const test = await listening();
	test.projectList.push(
		{ id: 'w', name: 'admin', path: `${test.root}/admin-web` },
		{ id: 'a', name: 'Admin', path: `${test.root}/admin-api` }
	);
	codeReply = () => 'ACTION note {"kind": "text", "text": "rotate keys", "project": "admin"}';
	try {
		test.sockets[0]!.emit(mention('U1AB', 'note for admin: rotate keys'));
		await test.settle();
		expect(test.posts().at(-1)!.body.text).toBe(
			'🤔 *Several projects match admin* — admin (admin-web) · Admin (admin-api). Which project?'
		);
		expect(buttonLabels(test)).toEqual(['admin · admin-web', 'Admin · admin-api']);
		expect(test.notes).toEqual([]);
		await press(test, 'Admin · admin-api');
		expect(test.notes.map((note) => note.project)).toEqual(['a']);
		expect(test.posts().at(-1)!.body.text).toBe('📝 *Note saved* — Admin\n🗒️ Note: rotate keys');
	} finally {
		codeReply = () => '';
	}
});

it('adds to the one note the name means, asks among several, and offers to create one when none', async () => {
	const test = await listening();
	const { sockets, notes, noteList, appended, posts, settle, projectList } = test;
	projectList.push({ id: 'p2', name: 'admin', path: test.root });
	noteList.push(
		{ id: 'n1', title: 'Release plan', project: 'p' },
		{ id: 'n2', title: 'Release checklist', project: null },
		{ id: 'n3', title: 'Release checklist', project: 'p2' }
	);
	codeReply = (question) =>
		question.includes('plan')
			? 'ACTION note {"kind": "text", "text": "freeze at noon", "append": "release plan"}'
			: question.includes('checklist in admin')
				? 'ACTION note {"kind": "text", "text": "smoke on staging", "append": "Release checklist", "project": "admin"}'
				: question.includes('checklist')
					? 'ACTION note {"kind": "text", "text": "tag the build", "append": "Release checklist"}'
					: 'ACTION note {"kind": "text", "text": "ask design", "append": "Ideas"}';
	try {
		sockets[0]!.emit(mention('U1AB', 'add to the note release plan: freeze at noon'));
		await settle();
		expect(appended).toEqual([
			{
				id: 'n1',
				addition: `From Slack: [#C0DEPLOY thread](${permalink})\n\nfreeze at noon\n`,
			},
		]);
		expect(posts().at(-1)?.body.text).toBe(
			'📝 *Added to the note* — business\n🗒️ Note: Release plan'
		);

		// Several notes match: one line with the candidates and a button each; nothing is added until one is pressed.
		sockets[0]!.emit(mention('U1AB', 'add to release checklist: tag the build'));
		await settle();
		expect(posts().at(-1)?.body.text).toBe(
			'🤔 *Several notes match «Release checklist»* — Release checklist (No project) · Release checklist (admin). Which note?'
		);
		expect(buttonLabels(test)).toEqual([
			'Release checklist · No project',
			'Release checklist · admin',
		]);
		expect(appended).toHaveLength(1);
		await press(test, 'Release checklist · No project');
		expect(appended.at(-1)).toMatchObject({ id: 'n2' });
		expect(appended.at(-1)!.addition).toContain('tag the build');
		expect(posts().at(-1)?.body.text).toBe(
			'📝 *Added to the note* — No project\n🗒️ Note: Release checklist'
		);

		// A named project narrows the notes to its own.
		sockets[0]!.emit(mention('U1AB', 'add to the release checklist in admin: smoke on staging'));
		await settle();
		expect(appended.at(-1)).toMatchObject({ id: 'n3' });

		// No note: said so, with `Create note`; nothing is guessed.
		sockets[0]!.emit(mention('U1AB', 'add to Ideas: ask design'));
		await settle();
		expect(posts().at(-1)?.body.text).toBe('🔎 *No note «Ideas»* — create one?');
		expect(buttonLabels(test)).toEqual(['Create note']);
		expect(notes).toEqual([]);
		await press(test, 'Create note');
		expect(notes).toEqual([
			{
				project: 'p',
				text: `# Ideas\n\nFrom Slack: [#C0DEPLOY thread](${permalink})\n\nask design\n`,
			},
		]);
		expect(posts().at(-1)?.body.text).toBe('📝 *Note saved* — business\n🗒️ Note: Ideas');
		expect(appended).toHaveLength(3);
	} finally {
		codeReply = () => '';
	}
});

it('keeps the new note forms behind the Notes module and the allow-list', async () => {
	const test = await listening();
	const { sockets, notes, appended, noteList, settle, quick } = test;
	noteList.push({ id: 'n1', title: 'Release plan', project: 'p' });
	codeReply = (question) =>
		question.includes('plan')
			? 'ACTION note {"kind": "text", "text": "freeze", "append": "Release plan"}'
			: 'ACTION note {"kind": "text", "text": "buy milk"}';
	try {
		// Someone not on the list never reaches the agent.
		sockets[0]!.emit(mention('U9ZZ', 'save a note: buy milk'));
		await settle();
		expect(quick.asks).toEqual([]);
		expect(ephemerals(test).at(-1)).toMatchObject({
			user: 'U9ZZ',
			text: 'Only the people in Brigadir’s Slack settings can create tasks.',
		});
		test.notesOff();
		sockets[0]!.emit(mention('U1AB', 'save a note: buy milk'));
		await settle();
		sockets[0]!.emit(mention('U1AB', 'add to Release plan: freeze'));
		await settle();
		expect(notes).toEqual([]);
		expect(appended).toEqual([]);
		expect(ephemerals(test).slice(-2)).toEqual([
			expect.objectContaining({ user: 'U1AB', text: 'Notes are off in Brigadir.' }),
			expect.objectContaining({ user: 'U1AB', text: 'Notes are off in Brigadir.' }),
		]);
	} finally {
		codeReply = () => '';
	}
});
