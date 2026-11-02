import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultSlackSettings, type SlackNotice, type SlackSettings } from '@brigadir/core';
import { Slack } from './slack';

const token = 'xoxb-1234567890-abcdefghij';
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const done = (task = 't'): SlackNotice => ({
	kind: 'taskDone',
	repo: 'business',
	branch: 'b',
	task: { projectId: 'p', id: task, title: 'Phone validation' },
	summary: null,
});
async function setup(
	options: { env?: Record<string, string>; settings?: Partial<SlackSettings>; dotenv?: string } = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slack-'));
	roots.push(root);
	const project = join(root, 'project');
	await rm(project, { recursive: true, force: true });
	await import('node:fs/promises').then((fs) => fs.mkdir(project));
	if (options.dotenv) await writeFile(join(project, '.env.local'), options.dotenv);
	const calls: { method: string; body: any; auth: string }[] = [];
	const replies: Record<string, unknown>[] = [];
	let offline = false;
	const states: string[] = [];
	const refused: string[] = [];
	const settings: SlackSettings = {
		...defaultSlackSettings,
		// «Turn ended» is off by default; these tests post it.
		events: { ...defaultSlackSettings.events, taskDone: true },
		memberId: 'U1AB',
		...options.settings,
	};
	const slack = new Slack({
		dataRoot: async () => root,
		vault: () => ({ seal: (text) => Buffer.from(`v:${text}`), open: (b) => b.toString().slice(2) }),
		env: options.env ?? {},
		projects: async () => [{ id: 'p', name: 'business', path: project }],
		settings: () => settings,
		enabled: () => true,
		changed: (state) => states.push(state.state),
		refused: (error) => refused.push(error),
		retryMs: 60_000,
		fetch: (async (url: string, init: RequestInit) => {
			if (offline) throw new TypeError('fetch failed');
			const method = url.split('/').pop()!;
			calls.push({
				method,
				body: JSON.parse(String(init.body)),
				auth: (init.headers as Record<string, string>).authorization ?? '',
			});
			const reply =
				replies.shift() ??
				(method === 'auth.test'
					? { ok: true, user: 'team_ci_bot', team: 'acme-team' }
					: { ok: true, channel: 'D123', ts: `${calls.length}.0` });
			return new Response(JSON.stringify(reply));
		}) as typeof fetch,
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
	return {
		root,
		slack,
		calls,
		replies,
		states,
		refused,
		settle,
		offline: (value: boolean) => (offline = value),
	};
}

it('finds the token in a project’s .env.local, posts the first event and replies to its thread after it', async () => {
	const { slack, calls, settle } = await setup({ dotenv: `SLACK_CI_BOT_TOKEN=${token}\n` });
	expect(await slack.refresh()).toEqual({
		state: 'on',
		source: 'file',
		file: 'business/.env.local',
		bot: 'team_ci_bot',
		team: 'acme-team',
		listen: { state: 'off' },
		appToken: false,
	});
	slack.post(done(), 'p');
	slack.post({ ...done(), kind: 'needsYou', reason: 'A question to answer' } as SlackNotice, 'p');
	await settle();
	const posts = calls.filter((call) => call.method === 'chat.postMessage');
	expect(posts.map((call) => [call.body.channel, call.body.thread_ts])).toEqual([
		['U1AB', undefined],
		['D123', '2.0'],
	]);
	expect(calls.every((call) => call.auth === `Bearer ${token}`)).toBe(true);
});

it('seals a token only after Slack accepts it, and a revoked one stops every message', async () => {
	const { slack, root, replies, calls, states, settle } = await setup();
	replies.push({ ok: false, error: 'invalid_auth' });
	await expect(slack.setToken(token)).rejects.toThrow('invalid_auth');
	await expect(readFile(join(root, 'slack', 'token.json'), 'utf8')).rejects.toThrow();
	await slack.setToken(token);
	expect(JSON.parse(await readFile(join(root, 'slack', 'token.json'), 'utf8')).sealed).toBe(
		Buffer.from(`v:${token}`).toString('base64')
	);
	expect(slack.state()).toMatchObject({ state: 'on', source: 'keychain' });
	replies.push({ ok: false, error: 'token_revoked' });
	slack.post(done(), 'p');
	await settle();
	expect(slack.state()).toMatchObject({ state: 'token', error: 'token_revoked' });
	const before = calls.length;
	slack.post(done('other'), 'p');
	await settle();
	expect(calls.length).toBe(before);
	expect(states).toContain('token');
});

it('keeps messages while Slack is unreachable and drops only the one a channel refused', async () => {
	const { slack, calls, replies, refused, settle, offline } = await setup({
		env: { SLACK_CI_BOT_TOKEN: token },
		settings: { projects: { p: { channel: '#deploys', mention: 'S05UAUB2GVD' } } },
	});
	await slack.refresh();
	offline(true);
	slack.post(done('a'), 'p');
	slack.post(done('b'), 'p');
	await settle();
	expect(slack.state()).toMatchObject({ state: 'down', waiting: 2 });
	offline(false);
	replies.push({ ok: true }, { ok: false, error: 'not_in_channel' });
	await slack.refresh();
	await settle();
	expect(refused).toEqual(['not_in_channel']);
	const posts = calls.filter((call) => call.method === 'chat.postMessage');
	expect(posts.at(-1)?.body).toMatchObject({ channel: '#deploys' });
	expect(posts.at(-1)?.body.text.startsWith('<!subteam^S05UAUB2GVD>\n🏁 *Turn ended*')).toBe(true);
	slack.dispose();
});

it('posts nothing for an event switched off', async () => {
	const { slack, calls, settle } = await setup({
		env: { SLACK_CI_BOT_TOKEN: token },
		settings: { events: { ...defaultSlackSettings.events, taskDone: false } },
	});
	await slack.refresh();
	slack.post(done(), 'p');
	await settle();
	expect(calls.map((call) => call.method)).toEqual(['auth.test']);
});
