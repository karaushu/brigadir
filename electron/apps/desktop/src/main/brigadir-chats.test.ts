import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Attachments, SessionStore } from '@brigadir/persistence';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
	brigadirCards,
	defaultAppSettings,
	type AppSettings,
	type BrigadirChatEvent,
	attachmentToken,
	projectToken,
	taskToken,
} from '@brigadir/core';
import { BrigadirChats, type BrigadirChatDeps } from './brigadir-chats';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(over: Partial<BrigadirChatDeps> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-chat-'));
	roots.push(root);
	let settings: AppSettings = structuredClone(defaultAppSettings);
	const events: BrigadirChatEvent[] = [],
		created: unknown[] = [],
		opened: string[] = [],
		notes: string[] = [];
	const slackState = { bot: false, app: false, memberId: false, listening: false };
	const deps: BrigadirChatDeps = {
		root,
		mcp: {
			register: async () => ({ name: 'brigadir', command: 'x', args: [], env: [] }),
			unregister: () => {},
		},
		send: (event) => events.push(event),
		locale: () => 'en',
		settings: () => settings,
		saveSettings: async (next) => {
			settings = next;
		},
		openSettings: (key) => key === 'taskColumns',
		openRemoteSettings: () => {},
		projects: async () => [{ id: 'p1', name: 'b2c', path: '/tmp/b2c' }],
		openProject: () => 'p1',
		facts: async () => ({
			text: '- t1 «ATT»',
			tasks: [{ projectId: 'p1', id: 't1', title: 'ATT' }],
		}),
		choice: () => ({ provider: 'claude', model: null }),
		today: () => '2026-11-20',
		createTask: async (input) => {
			created.push(input);
			return { projectId: input.projectId, id: 'new' };
		},
		sendToTask: async () => 'sent',
		askTask: async () => 'because',
		openTask: () => {},
		createNote: async (_project, text) => {
			notes.push(text);
			return 'n1';
		},
		openExternal: (url) => opened.push(url),
		slack: {
			connectBot: async (token) => {
				if (token === 'bad') throw new Error('invalid_auth');
				slackState.bot = true;
				return {
					bot: 'Jarvis',
					team: 'acme',
					scopes: token === 'few' ? 'chat:write' : null,
					appId: 'A1',
				};
			},
			connectApp: async () => {
				slackState.app = true;
			},
			state: () => slackState,
		},
		...over,
	};
	const chats = new BrigadirChats(deps);
	const chat = await chats.create();
	const tool = (name: string, args: Record<string, unknown>) =>
		(
			chats as unknown as {
				tool(chat: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
			}
		).tool(chat.id, name, args, new AbortController().signal);
	const cards = async () => brigadirCards((await chats.read(chat.id)).rows);
	const until = async (check: () => Promise<boolean>) => {
		for (let i = 0; i < 100 && !(await check()); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
	};
	return {
		chats,
		chat,
		tool,
		cards,
		until,
		events,
		created,
		opened,
		notes,
		get settings() {
			return settings;
		},
	};
}

it('changes a setting with a card the person can undo (spec/settings-modules-and-onboarding#brigadir-chat-cards)', async () => {
	const test = await setup();
	expect(await test.tool('settings_set', { key: 'typography.editor.size', value: 13 })).toEqual({
		key: 'typography.editor.size',
		before: 12,
		after: 13,
	});
	expect(test.settings.typography.editor.size).toBe(13);
	const [card] = await test.cards();
	expect(card).toMatchObject({
		type: 'setting',
		state: 'done',
		before: 12,
		after: 13,
		place: 'Settings ▸ Appearance ▸ Editor ▸ Size',
	});
	await test.chats.undo(test.chat.id, card!.id);
	expect(test.settings.typography.editor.size).toBe(12);
	expect((await test.cards())[0]).toMatchObject({ state: 'undone' });
	await expect(test.chats.undo(test.chat.id, card!.id)).rejects.toThrow('Nothing to undo');
	await expect(
		test.tool('settings_set', { key: 'typography.editor.size', value: 99 })
	).rejects.toThrow('takes 8–24');
});

it('holds a change behind Apply until the person answers', async () => {
	const test = await setup();
	const call = test.tool('settings_set', { key: 'modules.browser', value: false });
	await test.until(async () => (await test.cards()).length > 0);
	const [card] = await test.cards();
	expect(card).toMatchObject({ state: 'pending' });
	expect(test.settings.modules.browser).toBe(true);
	expect(test.chats.answer(test.chat.id, card!.id, 'apply')).toBe(true);
	await call;
	expect(test.settings.modules.browser).toBe(false);
	const cancelled = test.tool('settings_set', { key: 'modules.notes', value: false });
	await test.until(async () => (await test.cards()).length > 1);
	test.chats.answer(test.chat.id, (await test.cards())[1]!.id, 'cancel');
	expect(await cancelled).toBe('The person cancelled the change.');
	expect(test.settings.modules.notes).toBe(true);
});

it('takes a secret from its card, never through the agent, and tells the agent only the check', async () => {
	const test = await setup();
	const call = test.tool('secret_request', { kind: 'slackBotToken' });
	await test.until(async () => (await test.cards()).some((card) => card.type === 'secret'));
	const secret = () => test.cards().then((cards) => cards.find((card) => card.type === 'secret')!);
	test.chats.answer(test.chat.id, (await secret()).id, 'secret', 'bad');
	await test.until(
		async () =>
			(await secret()).type === 'secret' &&
			((await secret()) as { state: string }).state === 'error'
	);
	expect(await secret()).toMatchObject({ state: 'error', result: 'invalid_auth' });
	test.chats.answer(test.chat.id, (await secret()).id, 'secret', 'few');
	const answer = String(await call);
	expect(answer).toContain('lacks scopes');
	expect(answer).not.toContain('few');
	expect(await secret()).toMatchObject({
		state: 'scopes',
		link: 'https://api.slack.com/apps/A1/oauth',
	});
	const rows = JSON.stringify((await test.chats.read(test.chat.id)).rows);
	expect(rows).not.toContain('"few"');
});

it('walks the Slack setup and proposes tasks the person starts or declines', async () => {
	const test = await setup();
	const steps = String(await test.tool('setup_start', { kind: 'slack', name: 'Jarvis' }));
	expect(steps).toContain('Create in Slack');
	const link = (await test.cards()).find((card) => card.type === 'link')!;
	expect(link).toMatchObject({ label: 'Create in Slack', title: 'Create the Jarvis app' });
	await test.chats.openLink(test.chat.id, link.id);
	expect(test.opened[0]).toContain('manifest_json=');
	expect((await test.chats.list()).setups[0]).toMatchObject({
		kind: 'slack',
		status: '1 of 5 · Create in Slack',
		chat: test.chat.id,
	});
	await expect(test.tool('open_link', { url: 'https://evil.example', label: 'x' })).rejects.toThrow(
		'Only links'
	);
	const task = test.tool('create_task', {
		projects: ['b2c'],
		title: 'Test',
		prompt: 'Do it',
		base: 'master',
	});
	await test.until(async () => (await test.cards()).some((card) => card.type === 'task'));
	test.chats.answer(
		test.chat.id,
		(await test.cards()).find((card) => card.type === 'task')!.id,
		'start'
	);
	expect(await task).toMatchObject({ task: 'new', started: true });
	expect(test.created[0]).toMatchObject({ projectId: 'p1', baseRef: 'master', title: 'Test' });
	await expect(test.tool('send_to_task', { task: 'nope', text: 'x' })).rejects.toThrow(
		'No task nope'
	);
	expect(await test.tool('ask_task', { task: 'ATT', question: 'why?' })).toBe('because');
});

it('lists chats newest first and drops archived ones', async () => {
	const test = await setup();
	const second = await test.chats.create();
	await test.chats.rename(second.id, 'Slack-бот Jarvis');
	expect((await test.chats.list()).chats.map((chat) => chat.title)).toContain('Slack-бот Jarvis');
	await test.chats.archive(second.id);
	expect((await test.chats.list()).chats.map((chat) => chat.id)).toEqual([test.chat.id]);
	await test.chats.remove(test.chat.id);
	expect((await test.chats.list()).chats).toEqual([]);
});

it('saves notes and tells the chat about a watched task once per kind (spec/settings-modules-and-onboarding#brigadir-chat-tools)', async () => {
	const test = await setup();
	expect(await test.tool('note', { text: 'купити молоко', title: 'Покупки' })).toEqual({
		note: 'n1',
		saved: true,
	});
	expect(test.notes).toEqual(['# Покупки\n\nкупити молоко']);
	expect((await test.cards()).at(-1)).toMatchObject({ type: 'note', note: 'n1', title: 'Покупки' });
	await expect(test.tool('note', { text: 'x', project: 'nope' })).rejects.toThrow(
		'No project nope'
	);
	expect(String(await test.tool('watch', { task: 't1', kinds: ['ci', 'done'] }))).toContain(
		'ci, done'
	);
	const event = {
		task: { projectId: 'p1', id: 't1' },
		text: 'CI passed · b2c (main)',
		tone: 'green' as const,
		link: 'https://github.com/x',
	};
	await test.chats.notice({ kind: 'ci', ...event });
	await test.chats.notice({ kind: 'ci', ...event });
	await test.chats.notice({ kind: 'prMerged', ...event, text: 'PR merged' });
	expect(
		(await test.cards())
			.filter((card) => card.type === 'event')
			.map((card) => card.type === 'event' && card.text)
	).toEqual(['CI passed · b2c (main)']);
	expect(await test.tool('unwatch', {})).toBe('Stopped watching.');
	await test.chats.notice({ kind: 'taskDone', ...event, text: 'Turn ended' });
	expect((await test.cards()).filter((card) => card.type === 'event')).toHaveLength(1);
});

it('keeps archived chats apart and restores them', async () => {
	const test = await setup();
	await test.chats.archive(test.chat.id);
	expect((await test.chats.list()).archived.map((chat) => chat.id)).toEqual([test.chat.id]);
	expect(await test.chats.archivedChat(test.chat.id)).toBe(true);
	await test.chats.unarchive(test.chat.id);
	expect((await test.chats.list()).chats.map((chat) => chat.id)).toEqual([test.chat.id]);
});

it('sends attachments in their places and names task and project pills for the tools (spec/composer#chat-composer)', async () => {
	const fixture = fileURLToPath(
		new URL('../../../../packages/transport/fixtures/agent.mjs', import.meta.url)
	);
	const data = await mkdtemp(join(tmpdir(), 'brigadir-chat-data-'));
	roots.push(data);
	const store = await SessionStore.at(data),
		assets = new Attachments(store),
		wire = join(data, 'wire.jsonl');
	const { chats, chat } = await setup({
		root: join(store.root, 'assistant'),
		attachments: (id, ids) => assets.resolve({ chat: 'brigadir', id }, ids),
		projects: async () => [{ id: 'p1', name: 'b2c', path: store.root }],
		adapter: { command: process.execPath, args: [fixture, 'normal', wire] },
	});
	const png =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
	const image = await assets.create(
		{ chat: 'brigadir', id: chat.id },
		{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: png }
	);
	const text = `why ${taskToken('t1')} in ${projectToken('p1')}? ${attachmentToken(image.id)} thanks`;
	await chats.checkAttachments(chat.id, [image.id]);
	await chats.send(chat.id, text, [image.id]);
	chats.closeAll();
	const state = await chats.read(chat.id);
	expect(state.rows.find((row) => row.kind === 'prompt')).toMatchObject({
		text,
		attachments: [{ id: image.id, kind: 'image' }],
	});
	// The title reads names, not tokens.
	expect(state.meta.title).toBe('why @ATT in @b2c? @shot.png thanks');
	const blocks = (await readFile(wire, 'utf8'))
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; params: unknown })
		.find((line) => line.event === 'prompt-blocks')!.params as {
		type: string;
		text?: string;
		data?: string;
	}[];
	expect(blocks.map((block) => block.type)).toEqual(['text', 'image', 'text']);
	expect(blocks[0]!.text).toContain(
		`why the task "ATT" (id t1, project "b2c") in the project "b2c" (folder ${JSON.stringify(store.root)})? `
	);
	expect(blocks[1]!.data).toBe(png);
	expect(blocks[2]!.text).toBe(' thanks');
	await expect(
		chats.checkAttachments(chat.id, ['0b1c2d3e-0000-4000-8000-000000000009'])
	).rejects.toThrow();
});
