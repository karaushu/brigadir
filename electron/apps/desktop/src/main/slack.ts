import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
	dotenvToken,
	isAppToken,
	isBotToken,
	isRecord,
	slackButtons,
	slackMention,
	slackNoticeButtons,
	slackNoticeEvent,
	slackPermalinkTarget,
	slackText,
	slackThreadReplyOf,
	type SlackBotState,
	type SlackListen,
	type SlackNotice,
	type SlackSettings,
	type SlackState,
	type SlackTokenSource,
	type TaskKey,
	type CIFinished,
	type CIRunDetail,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath } from '@brigadir/persistence';
import type { KeyVault } from '@brigadir/remote';
import { SlackAnswers } from './slack-answers';
import { SlackMentions, type SlackBrigadir } from './slack-mentions';
import { SlackSocket, type SocketFactory } from './slack-socket';
import { SlackWatches, type SlackWatching } from './slack-watches';

/** A project whose `.env.local` / `.env` may hold `SLACK_CI_BOT_TOKEN`, as watch-ci reads it. */
export type SlackProject = { id: string; name: string; path: string };
export type SlackDeps = {
	dataRoot(): Promise<string>;
	vault(): KeyVault;
	env: Record<string, string | undefined>;
	projects(): Promise<SlackProject[]>;
	settings(): SlackSettings;
	enabled(): boolean;
	changed(state: SlackState): void;
	/** A message Slack refused for a reason other than the token (a channel the bot is not in) — the center shows it. */
	refused(error: string): void;
	fetch?: typeof fetch;
	retryMs?: number;
	/** spec/notifications-slack-notes-and-schedules#slack: what the `@bot` mentions do in Brigadir; without it the app never listens. */
	brigadir?: SlackBrigadir;
	/** spec/notifications-slack-notes-and-schedules#slack «watch and tell me here»: the PR, CI and task reads of a watch; without it no watches. */
	watching?: SlackWatching;
	watchPollMs?: number;
	/** Socket Mode's WebSocket; the global one of Electron's main by default, a fake in tests. */
	socket?: SocketFactory;
	backoff?: (attempt: number) => number;
};
type Token = { value: string; source: SlackTokenSource; file: string | null };
type Thread = { channel: string; ts: string };
type Pending = { notice: SlackNotice; projectId: string | null };
/** Slack's errors that mean the token itself is gone; any other error drops only that message. */
const tokenErrors = new Set([
	'invalid_auth',
	'not_authed',
	'token_revoked',
	'token_expired',
	'account_inactive',
	'missing_scope',
]);
const queueLimit = 50,
	threadLimit = 500,
	retryMs = 30_000;
/** The app token's own refusals: Socket Mode waits for a new one. */
const appTokenErrors = new Set([
	'invalid_auth',
	'not_authed',
	'token_revoked',
	'token_expired',
	'account_inactive',
	'missing_scope',
	'not_allowed_token_type',
	'invalid_token_type',
]);
class SlackError extends Error {
	constructor(
		readonly code: string,
		readonly network = false
	) {
		super(code);
	}
}

/**
 * spec/notifications-slack-notes-and-schedules#slack: the person's CI bot posts the app's events. One task — one thread (the first event a message, the rest
 * replies, kept in `slack/threads.json`); offline messages wait in memory, at most 50, and are not resent after a restart.
 * The token is read in main only — sealed in `slack/token.json` by the OS key store, else `SLACK_CI_BOT_TOKEN`, else a
 * project's `.env.local` / `.env`; it never reaches the renderer, a log or an agent.
 */
export class Slack {
	private token: Token | null = null;
	private current: SlackBotState = { state: 'off' };
	private listening: SlackListen = { state: 'off' };
	private queue: Pending[] = [];
	private threads = new Map<string, Thread>();
	/** A `Where` channel typed by name → its ID, learned from `chat.postMessage` and `conversations.info`. */
	private channels = new Map<string, string>();
	private channelNames = new Map<string, string | null>();
	private loaded: Promise<void>;
	private sending: Promise<void> = Promise.resolve();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private botUser: string | null = null;
	/** spec/notifications-slack-notes-and-schedules#slack-agent-post: the bot's name as Slack shows it (display name), else its username. */
	private botName: string | null = null;
	private appToken: string | null | undefined = undefined;
	private readonly socket: SlackSocket;
	private readonly mentions: SlackMentions | null;
	private readonly answers: SlackAnswers | null;
	private readonly watches: SlackWatches | null;
	constructor(private readonly deps: SlackDeps) {
		this.loaded = this.loadThreads();
		this.watches =
			deps.brigadir && deps.watching
				? new SlackWatches({
						...deps.watching,
						file: (write) => this.file('watches.json', write),
						post: (thread, text) =>
							this.call('chat.postMessage', {
								channel: thread.channel,
								thread_ts: thread.ts,
								text,
								unfurl_links: false,
								unfurl_media: false,
							}),
						ready: () =>
							this.deps.enabled() &&
							!!this.token &&
							this.current.state !== 'off' &&
							this.current.state !== 'token',
						...(deps.watchPollMs ? { pollMs: deps.watchPollMs } : {}),
					})
				: null;
		const watches = this.watches;
		this.socket = new SlackSocket({
			open: async () => {
				const value = await this.call('apps.connections.open', {}, { app: true, form: true });
				if (typeof value.url !== 'string' || !value.url.startsWith('wss://'))
					throw new SlackError('bad_response', true);
				return value.url;
			},
			socket: deps.socket ?? ((url) => new WebSocket(url) as unknown as ReturnType<SocketFactory>),
			envelope: (envelope) => void this.envelope(envelope.type, envelope.payload),
			changed: (state) =>
				this.setListen(
					state === 'connecting'
						? { state: 'connecting' }
						: state === 'on'
							? { state: 'on' }
							: state === 'down'
								? { state: 'down' }
								: { state: 'token', error: state.token }
				),
			isTokenError: (error) => error instanceof SlackError && appTokenErrors.has(error.code),
			...(deps.backoff ? { backoff: deps.backoff } : {}),
		});
		this.mentions = deps.brigadir
			? new SlackMentions({
					...deps.brigadir,
					api: (method, body, form) => this.call(method, body, { form: !!form }),
					settings: () => this.deps.settings(),
					projects: async () =>
						(await this.deps.projects()).map(({ id, name, path }) => ({
							id,
							name,
							folder: basename(path),
						})),
					botUser: () => this.botUser,
					channelProject: (channel) => this.channelProject(channel),
					channelName: (channel) => this.channelName(channel),
					taskOfThread: (channel, ts) => this.taskOfThread(channel, ts),
					threadStarted: (task, thread) => this.threadStarted(task, thread),
					...(watches
						? {
								watch: (inputs) => watches.add(inputs),
								unwatch: (channel, ts) => watches.cancel(channel, ts),
								watchNow: () => void watches.poll().catch(() => {}),
							}
						: {}),
				})
			: null;
		this.answers = deps.brigadir
			? new SlackAnswers({
					sendToTask: (task, text) => deps.brigadir!.sendToTask(task, text),
					answer: (answer) => deps.brigadir!.answer(answer),
					api: (method, body) => this.call(method, body),
					settings: () => this.deps.settings(),
					botUser: () => this.botUser,
					taskOfThread: (channel, ts) => this.taskOfThread(channel, ts),
				})
			: null;
	}
	state(): SlackState {
		return { ...this.current, listen: this.listening, appToken: !!this.appToken };
	}
	/** `<dataRoot>/slack/<name>`, the folder made on first write; a symlink on the way is refused. */
	private async file(name: string, write = false) {
		const root = await this.deps.dataRoot();
		if (write) await mkdir(join(root, 'slack'), { recursive: true, mode: 0o700 });
		return safePath(root, 'slack', name);
	}
	private async loadThreads() {
		try {
			const value = await readDocument(await this.file('threads.json'));
			if (isRecord(value) && isRecord(value.channels))
				for (const [name, id] of Object.entries(value.channels))
					if (typeof id === 'string') this.channels.set(name, id);
			if (isRecord(value) && isRecord(value.threads))
				for (const [key, thread] of Object.entries(value.threads))
					if (
						isRecord(thread) &&
						typeof thread.channel === 'string' &&
						typeof thread.ts === 'string'
					)
						this.threads.set(key, { channel: thread.channel, ts: thread.ts });
		} catch {
			// No file yet or not ours — threads start again.
		}
	}
	private async saveThreads() {
		const entries = [...this.threads].slice(-threadLimit);
		this.threads = new Map(entries);
		await atomicJson(await this.file('threads.json', true), {
			schemaVersion: 1,
			threads: Object.fromEntries(entries),
			channels: Object.fromEntries([...this.channels].slice(-100)),
		});
	}
	private set(state: SlackBotState) {
		this.current = state;
		this.deps.changed(this.state());
	}
	private setListen(state: SlackListen) {
		this.listening = state;
		this.deps.changed(this.state());
	}
	private async sealed(
		name = 'token.json',
		valid: (token: string) => boolean = isBotToken
	): Promise<string | null> {
		try {
			const value = await readDocument(await this.file(name));
			if (!isRecord(value) || typeof value.sealed !== 'string') return null;
			const token = this.deps.vault().open(Buffer.from(value.sealed, 'base64'));
			return valid(token) ? token : null;
		} catch {
			return null;
		}
	}
	private async findToken(): Promise<Token | null> {
		const sealed = await this.sealed();
		if (sealed) return { value: sealed, source: 'keychain', file: null };
		const env = this.deps.env.SLACK_CI_BOT_TOKEN?.trim();
		if (env && isBotToken(env)) return { value: env, source: 'env', file: null };
		for (const project of await this.deps.projects().catch(() => []))
			for (const name of ['.env.local', '.env']) {
				const text = await readFile(join(project.path, name), 'utf8').catch(() => null),
					value = text && dotenvToken(text);
				if (value) return { value, source: 'file', file: `${project.name}/${name}` };
			}
		return null;
	}
	/** Reads the token again and asks Slack who it is; the module turned off forgets the token. */
	async refresh(): Promise<SlackState> {
		if (!this.deps.enabled()) {
			this.token = null;
			this.queue = [];
			this.set({ state: 'off' });
			await this.listen();
			return this.state();
		}
		this.token = await this.findToken();
		if (!this.token) {
			this.set({ state: 'off' });
			await this.listen();
			return this.state();
		}
		const { source, file } = this.token;
		this.set({ state: 'checking', source, file });
		try {
			const auth = await this.call('auth.test', {});
			this.botUser = typeof auth.user_id === 'string' ? auth.user_id : null;
			this.botName = null;
			this.set({
				state: 'on',
				source,
				file,
				bot: typeof auth.user === 'string' ? auth.user : 'bot',
				team: typeof auth.team === 'string' ? auth.team : '',
			});
			this.flush();
		} catch (error) {
			this.fail(error);
		}
		await this.listen();
		return this.state();
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack: Socket Mode runs while the module, the `Create tasks from Slack` switch, the bot token and the App-Level
	 * Token are all there; anything missing stops it. Called after every change of these.
	 */
	async listen(): Promise<SlackState> {
		if (this.appToken === undefined)
			this.appToken = await this.sealed('app-token.json', isAppToken);
		const wanted =
			!!this.mentions &&
			this.deps.enabled() &&
			this.deps.settings().mentions.on &&
			!!this.token &&
			this.current.state !== 'token';
		if (!wanted) {
			this.socket.stop();
			if (this.listening.state !== 'off') this.setListen({ state: 'off' });
			return this.state();
		}
		if (!this.appToken) {
			this.socket.stop();
			if (this.listening.state !== 'no-token') this.setListen({ state: 'no-token' });
			return this.state();
		}
		// A refused app token waits for a new one instead of asking Slack again on every settings change.
		if (!this.socket.active && this.listening.state !== 'token') this.socket.start();
		return this.state();
	}
	/** The App-Level Token (`xapp-…`): sealed only after `apps.connections.open` accepted it; never shown again. */
	async setAppToken(value: string): Promise<SlackState> {
		const token = value.trim();
		if (!isAppToken(token)) throw new Error('This is not an app-level token (xapp-…).');
		await this.call('apps.connections.open', {}, { app: true, form: true, token });
		await atomicJson(await this.file('app-token.json', true), {
			schemaVersion: 1,
			sealed: this.deps.vault().seal(token).toString('base64'),
		});
		this.appToken = token;
		this.socket.stop();
		this.listening = { state: 'connecting' };
		return this.listen();
	}
	/** Forgets the App-Level Token; the app stops listening. */
	async disconnectApp(): Promise<SlackState> {
		await rm(await this.file('app-token.json'), { force: true });
		this.appToken = null;
		this.socket.stop();
		return this.listen();
	}
	/** spec/notifications-slack-notes-and-schedules#slack: a mention or a reply in a task's thread; a click on the mentions' buttons or on an answer's. */
	private envelope(type: 'events_api' | 'interactive', payload: Record<string, unknown>) {
		if (!this.mentions || !this.answers || !this.socket.active) return;
		const event = isRecord(payload.event) ? payload.event : null;
		return (
			type === 'events_api'
				? event?.type === 'message'
					? this.message(payload, event)
					: this.mentions.event(payload)
				: this.answers.owns(payload)
					? this.answers.interactive(payload)
					: this.mentions.interactive(payload)
		).catch(() => {});
	}
	/**
	 * A message event: a reply in a task's thread goes to its agent. Slack sends no `app_mention` in the bot's DM — a new
	 * message there, or a reply in a DM thread that is not a task's, is a mention.
	 */
	private async message(payload: Record<string, unknown>, event: Record<string, unknown>) {
		if (await this.answers!.message(payload)) return;
		// spec/notifications-slack-notes-and-schedules#slack-which-project: a plain reply that may name the project of a waiting task.
		const reply = slackThreadReplyOf(payload, this.botUser);
		if (reply && this.mentions!.waits(reply.channel, reply.threadTs, reply.user)) {
			await this.mentions!.event({ ...payload, event: { ...event, type: 'app_mention' } });
			return;
		}
		if (event.channel_type !== 'im' || event.bot_id || typeof event.subtype === 'string') return;
		await this.mentions!.event({ ...payload, event: { ...event, type: 'app_mention' } });
	}
	/** The project whose `Where` channel this is: typed as the ID, or a name the bot learned or Slack names. */
	private async channelProject(channel: string): Promise<string | null> {
		const routes = Object.entries(this.deps.settings().projects).filter(
			([, route]) => route.channel.trim() !== ''
		);
		const id = channel.toUpperCase(),
			bare = (value: string) => value.trim().replace(/^#/, '');
		for (const [project, route] of routes)
			if (
				bare(route.channel).toUpperCase() === id ||
				this.channels.get(bare(route.channel)) === channel
			)
				return project;
		const name = await this.channelName(channel);
		if (!name) return null;
		for (const [project, route] of routes)
			if (bare(route.channel).toLowerCase() === name.toLowerCase()) return project;
		return null;
	}
	/** `conversations.info` once per channel; without `channels:read` Slack refuses and the name stays unknown. */
	private async channelName(channel: string): Promise<string | null> {
		if (this.channelNames.has(channel)) return this.channelNames.get(channel) ?? null;
		let name: string | null = null;
		try {
			const value = await this.call('conversations.info', { channel }, { form: true });
			name =
				isRecord(value.channel) && typeof value.channel.name === 'string'
					? value.channel.name
					: null;
		} catch {
			name = null;
		}
		this.channelNames.set(channel, name);
		if (name) this.channels.set(name, channel);
		return name;
	}
	private taskOfThread(channel: string, ts: string): TaskKey | null {
		for (const [key, thread] of this.threads)
			if (thread.channel === channel && thread.ts === ts) {
				const [projectId = '', id = ''] = key.split('/');
				return { projectId, id };
			}
		return null;
	}
	private threadStarted(task: TaskKey, thread: Thread) {
		const key = `${task.projectId}/${task.id}`;
		this.threads.delete(key);
		this.threads.set(key, thread);
		void this.saveThreads().catch(() => {});
	}
	/** `Connect` and `Replace token…`: the token is sealed only after Slack accepted it. */
	async setToken(value: string): Promise<SlackState> {
		const token = value.trim();
		if (!isBotToken(token)) throw new Error('This is not a bot token (xoxb-…).');
		this.token = { value: token, source: 'keychain', file: null };
		await this.call('auth.test', {});
		await this.seal(token);
		return this.refresh();
	}
	/** `Move to Keychain`: the token found in the environment or a file is sealed; the file is not changed. */
	async moveToKeychain(): Promise<SlackState> {
		if (this.token && this.token.source !== 'keychain') await this.seal(this.token.value);
		return this.refresh();
	}
	/** `Disconnect`: forgets the sealed token; one in the environment or a file still connects. */
	async disconnect(): Promise<SlackState> {
		await rm(await this.file('token.json'), { force: true });
		this.queue = [];
		return this.refresh();
	}
	private async seal(token: string) {
		await atomicJson(await this.file('token.json', true), {
			schemaVersion: 1,
			sealed: this.deps.vault().seal(token).toString('base64'),
		});
	}
	/** An app event: posted when its kind is on, to the project's channel or the person's DM. */
	post(notice: SlackNotice, projectId: string | null) {
		if (!this.deps.enabled() || !this.deps.settings().events[slackNoticeEvent(notice)]) return;
		if (this.current.state === 'off' || this.current.state === 'token') return;
		this.queue.push({ notice, projectId });
		if (this.queue.length > queueLimit) this.queue.splice(0, this.queue.length - queueLimit);
		this.flush();
	}
	private flush() {
		this.sending = this.sending.then(() => this.drain()).catch(() => {});
	}
	private async drain() {
		await this.loaded;
		while (this.queue.length && this.token && this.current.state !== 'token') {
			const next = this.queue[0]!;
			try {
				await this.send(next);
				this.queue.shift();
				if (this.current.state === 'down') await this.refresh();
			} catch (error) {
				if (error instanceof SlackError && !error.network && !tokenErrors.has(error.code)) {
					this.queue.shift();
					this.deps.refused(error.code);
					continue;
				}
				this.fail(error);
				return;
			}
		}
	}
	private fail(error: unknown) {
		if (!this.token) return;
		const { source, file } = this.token;
		if (error instanceof SlackError && tokenErrors.has(error.code)) {
			this.queue = [];
			this.set({ state: 'token', source, file, error: error.code });
			return;
		}
		this.set({ state: 'down', source, file, waiting: this.queue.length });
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.refresh();
			}, this.deps.retryMs ?? retryMs);
			this.timer.unref?.();
		}
	}
	private async send({ notice, projectId }: Pending) {
		const settings = this.deps.settings(),
			route = projectId ? settings.projects[projectId] : undefined,
			channel = route?.channel.trim() || settings.memberId;
		if (!channel) throw new SlackError('no_member_id');
		const task =
				'task' in notice && notice.task ? `${notice.task.projectId}/${notice.task.id}` : null,
			thread = task ? this.threads.get(task) : undefined,
			// The thread lives where it began: a changed route starts a new one.
			reply = thread && (thread.channel === channel || !route?.channel) ? thread : undefined,
			text = slackText(notice, reply ? '' : slackMention(route?.mention ?? '')),
			// spec/notifications-slack-notes-and-schedules#slack: Needs you and a schedule's «Ask» carry their answers as buttons.
			buttons = slackNoticeButtons(notice);
		const sent = await this.call('chat.postMessage', {
			channel: reply?.channel ?? channel,
			...(buttons ? slackButtons(text, buttons) : { text }),
			unfurl_links: false,
			unfurl_media: false,
			...(reply
				? {
						thread_ts: reply.ts,
						...(notice.kind === 'prMerged' && route?.channel ? { reply_broadcast: true } : {}),
					}
				: {}),
		});
		const typed = route?.channel.trim().replace(/^#/, '');
		if (typed && typeof sent.channel === 'string' && typed !== sent.channel)
			this.channels.set(typed, sent.channel);
		if (task && !reply && typeof sent.channel === 'string' && typeof sent.ts === 'string') {
			this.threads.delete(task);
			this.threads.set(task, { channel: sent.channel, ts: sent.ts });
			await this.saveThreads().catch(() => {});
		}
	}
	/**
	 * One Web API call: the bot token by default, the App-Level Token for `apps.connections.open`; `form` — the read
	 * methods (`conversations.*`, `chat.getPermalink`) take form fields, not JSON.
	 */
	private async call(
		method: string,
		body: Record<string, unknown>,
		options: { app?: boolean; form?: boolean; token?: string } = {}
	): Promise<Record<string, unknown>> {
		const token = options.token ?? (options.app ? this.appToken : this.token?.value);
		if (!token) throw new SlackError('not_authed');
		let response: Response;
		try {
			response = await (this.deps.fetch ?? fetch)(`https://slack.com/api/${method}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': options.form
						? 'application/x-www-form-urlencoded'
						: 'application/json; charset=utf-8',
				},
				body: options.form
					? new URLSearchParams(
							Object.entries(body).map(([key, value]) => [key, String(value)])
						).toString()
					: JSON.stringify(body),
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			throw new SlackError('unreachable', true);
		}
		if (response.status === 429 || response.status >= 500)
			throw new SlackError(`http_${response.status}`, true);
		const value: unknown = await response.json().catch(() => null);
		if (!isRecord(value)) throw new SlackError('bad_response', true);
		if (value.ok !== true)
			throw new SlackError(typeof value.error === 'string' ? value.error : 'error');
		return value;
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack-agent-post: where an agent's `slack_post` goes and as whom — checked before the
	 * person is asked. A channel by ID as is, by name through the learned map or `conversations.list`; none — the task's thread.
	 */
	async agentTarget(
		task: TaskKey,
		input: { channel?: string | undefined; thread?: string | undefined }
	): Promise<{ bot: string; label: string; channel: string; threadTs: string | null }> {
		if (!this.deps.enabled()) throw new Error('Slack is off in Settings.');
		if (!this.token || this.current.state === 'off') await this.refresh();
		if (!this.token || this.current.state === 'off')
			throw new Error('Brigadir has no Slack bot token.');
		if (this.current.state === 'token')
			throw new Error(
				'The Slack bot token is no longer valid. The person replaces it in Settings.'
			);
		await this.loaded;
		const bot = await this.shownName(),
			link = slackPermalinkTarget(input.thread ?? ''),
			threadTs = link?.ts ?? (input.thread?.trim() || null);
		if (threadTs && !/^\d{9,}\.\d{1,9}$/.test(threadTs))
			throw new Error('thread must be a message ts like 1793884455.669649 or its Slack link.');
		const typed = input.channel?.trim().replace(/^#/, '') || link?.channel || '';
		if (!typed) {
			const own = this.threads.get(`${task.projectId}/${task.id}`);
			if (!own) throw new Error('This task has no Slack thread: name a channel.');
			const name = await this.channelName(own.channel);
			return {
				bot,
				label: `${name ? `#${name}` : own.channel} · this task's thread`,
				channel: own.channel,
				threadTs: threadTs ?? own.ts,
			};
		}
		const channel = /^[CGD][A-Z0-9]{6,}$/.test(typed)
			? typed
			: (this.channels.get(typed) ?? (await this.channelId(typed)) ?? typed);
		const name =
			channel === typed && !/^[CGD][A-Z0-9]{6,}$/.test(typed)
				? typed
				: await this.channelName(channel);
		return {
			bot,
			label: `${name ? `#${name}` : channel}${threadTs ? ' · thread' : ''}`,
			channel,
			threadTs,
		};
	}
	/** spec/notifications-slack-notes-and-schedules#slack-agent-post: the agent's message, sent now as the bot; the reason when Slack refuses. */
	async agentPost(
		task: TaskKey,
		input: { channel?: string | undefined; thread?: string | undefined; text: string }
	): Promise<
		| { posted: true; channel: string; ts: string; permalink: string | null }
		| { posted: false; reason: string }
	> {
		const target = await this.agentTarget(task, input);
		let sent: Record<string, unknown>;
		try {
			sent = await this.call('chat.postMessage', {
				channel: target.channel,
				text: input.text,
				unfurl_links: false,
				unfurl_media: false,
				...(target.threadTs ? { thread_ts: target.threadTs } : {}),
			});
		} catch (error) {
			const code = error instanceof SlackError ? error.code : String(error);
			if (error instanceof SlackError && tokenErrors.has(code)) this.fail(error);
			const where = target.label.split(' · ')[0];
			return {
				posted: false,
				reason:
					code === 'channel_not_found' || code === 'not_in_channel'
						? `The bot @${target.bot} is not in ${where}. Ask the person to run /invite @${target.bot} in that channel, then call slack_post again.`
						: code === 'is_archived'
							? `${where} is archived.`
							: code === 'msg_too_long'
								? 'The message is too long for Slack.'
								: `Slack refused the message: ${code}.`,
			};
		}
		const channel = typeof sent.channel === 'string' ? sent.channel : target.channel,
			ts = typeof sent.ts === 'string' ? sent.ts : '';
		const typed = input.channel?.trim().replace(/^#/, '');
		if (typed && typed !== channel && !/^[CGD][A-Z0-9]{6,}$/.test(typed)) {
			this.channels.set(typed, channel);
			await this.saveThreads().catch(() => {});
		}
		let permalink: string | null = null;
		try {
			const value = await this.call(
				'chat.getPermalink',
				{ channel, message_ts: ts },
				{ form: true }
			);
			permalink = typeof value.permalink === 'string' ? value.permalink : null;
		} catch {
			permalink = null;
		}
		return { posted: true, channel, ts, permalink };
	}
	/** The name people see and type after `@` in Slack: the bot user's display or real name (`users.info`), else the username of `auth.test`. */
	private async shownName(): Promise<string> {
		if (this.botName) return this.botName;
		const fallback = this.current.state === 'on' ? this.current.bot : 'bot';
		if (!this.botUser) return fallback;
		try {
			const value = await this.call('users.info', { user: this.botUser }, { form: true }),
				user = isRecord(value.user) ? value.user : {},
				profile = isRecord(user.profile) ? user.profile : {},
				name = [profile.display_name, profile.real_name, user.real_name].find(
					(item): item is string => typeof item === 'string' && item.trim() !== ''
				);
			this.botName = name?.trim() ?? fallback;
		} catch {
			// Without users:read Slack refuses; the username stays.
			this.botName = fallback;
		}
		return this.botName;
	}
	/** A channel name → its ID through `conversations.list` (public and private channels the bot sees); `null` without the scope or a match. */
	private async channelId(name: string): Promise<string | null> {
		const key = name.toLowerCase();
		let cursor = '';
		try {
			for (let page = 0; page < 5; page++) {
				const value = await this.call(
					'conversations.list',
					{
						types: 'public_channel,private_channel',
						exclude_archived: true,
						limit: 1000,
						...(cursor ? { cursor } : {}),
					},
					{ form: true }
				);
				for (const item of Array.isArray(value.channels) ? value.channels : [])
					if (
						isRecord(item) &&
						typeof item.id === 'string' &&
						typeof item.name === 'string' &&
						item.name.toLowerCase() === key
					) {
						this.channels.set(name, item.id);
						return item.id;
					}
				cursor =
					isRecord(value.response_metadata) &&
					typeof value.response_metadata.next_cursor === 'string'
						? value.response_metadata.next_cursor
						: '';
				if (!cursor) break;
			}
		} catch {
			// Without channels:read / groups:read Slack refuses; the name goes to Slack as it is.
		}
		return null;
	}
	/** A bell's run ended: the watches on it answer; `true` — the bell was a watch's own (no second CI message). */
	ciFinished(event: CIFinished, detail: CIRunDetail): Promise<boolean> {
		return this.watches?.ciFinished(event, detail) ?? Promise.resolve(false);
	}
	/** A task's turn ended: a «tell me when it is done» watch on it may fire. */
	taskEnded(task: TaskKey): Promise<void> {
		return this.watches?.taskEnded(task) ?? Promise.resolve();
	}
	dispose() {
		this.watches?.dispose();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.socket.stop();
	}
}
