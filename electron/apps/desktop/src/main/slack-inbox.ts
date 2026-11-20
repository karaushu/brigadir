import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import {
	addDays,
	dayKey,
	isRecord,
	isSlackMention,
	slackAnswers,
	slackArchiveRows,
	slackArchived,
	slackDayAnswer,
	slackDayPrompt,
	slackDayRows,
	slackIsOwn,
	slackLatestMentions,
	slackMentionAnswer,
	slackMentionKind,
	slackMentionPrompt,
	slackMentionStatus,
	slackNamedProject,
	slackPlain,
	slackThreadKey,
	slackTodoList,
	slackTodoOf,
	slackTsMs,
	slackWeekAnswer,
	slackWeekPrompt,
	slackWeekRows,
	weekDays,
	weekKey,
	type SlackDayFile,
	type SlackInboxKind,
	type SlackInboxMessage,
	type SlackInboxTarget,
	type SlackInboxView,
	type SlackMention,
	type SlackMentionRow,
	type SlackOwnMessage,
	type SlackRawMessage,
	type SlackTodoRef,
	type SlackWeekFile,
} from '@brigadir/core';
import { atomicJson, atomicText, readDocument, safePath } from '@brigadir/persistence';

/** A one-shot call of `Slack: summaries`: its text, or why there is none. */
export type SlackInboxAgentResult =
	{ kind: 'text'; text: string } | { kind: 'quota' } | { kind: 'none' } | { kind: 'failed' };
/**
 * spec/todo-and-slack-inbox#slack-inbox-to-todo: what the Todo module gives the Slack section — injected, so the section works (and hides
 * `Add to Todo`) without it.
 */
export type SlackInboxTodo = {
	addTodo(input: {
		project: string | null;
		list: string | null;
		title: string;
		description: string;
		source: {
			kind: 'slack';
			permalink: string;
			channel: string;
			author: string;
			ts: string;
			mention: string;
		};
	}): Promise<{ listId: string; listName: string; project: string | null; itemId: string }>;
	removeTodo(listId: string, itemId: string): Promise<void>;
	todoLists(): Promise<{ name: string; project: string | null; updatedAt: string }[]>;
};
export type SlackInboxDeps = {
	dataRoot(): Promise<string>;
	/** A Web API read with the person's own token (form fields); throws without one or when Slack refuses. */
	api(
		method: string,
		body: Record<string, string | number | boolean>
	): Promise<Record<string, unknown>>;
	/** The person behind the token (`auth.test`); null — no token. */
	account(): { user: string; team: string } | null;
	botUser(): string | null;
	countHere(): boolean;
	locale(): 'en' | 'uk';
	agent(prompt: string, characterLimit: number): Promise<SlackInboxAgentResult>;
	projects(): Promise<{ id: string; name: string }[]>;
	/** The project whose Slack channel (`Where`) this is. */
	channelProject(channel: string): Promise<string | null>;
	channelName(channel: string): Promise<string | null>;
	todo: SlackInboxTodo | null;
	changed(view: SlackInboxView): void;
	now?(): number;
	/** How long a new mention waits before today's summary is made again while the section is open. */
	summaryDelayMs?: number;
};
type InboxState = {
	/** The last event's time. */
	lastEvent: string | null;
	/** The last day `search.messages` filled. */
	searchDay: string | null;
	/** The last day the section was opened. */
	opened: string | null;
	/** `<channel>/<thread>` of threads the person wrote in, newest last. */
	threads: string[];
	groups: { ids: string[]; at: string } | null;
};
type Person = { name: string; at: number };
const threadLimit = 500,
	contextLimit = 20,
	peopleMs = 24 * 3_600_000,
	groupsMs = 24 * 3_600_000;
const emptyState = (): InboxState => ({
	lastEvent: null,
	searchDay: null,
	opened: null,
	threads: [],
	groups: null,
});
const text = (value: unknown) => (typeof value === 'string' ? value : '');
/** `thread_ts` of a search result's permalink (`…/p1700000000123456?thread_ts=1700000000.000100`). */
function permalinkThread(permalink: string): string | null {
	const match = /[?&]thread_ts=(\d+\.\d+)/.exec(permalink);
	return match ? match[1]! : null;
}

/**
 * spec/todo-and-slack-inbox#slack-inbox: the Slack section in main. Mentions come from the user events of Socket Mode and, after a start, from
 * `search.messages`; they live in `~/.brigadir/slack-inbox/` (`mentions.jsonl` append-only, `days/`, `weeks/`, `people.json`, `state.json`).
 * Every mention, day and week gets a one-shot of `Slack: summaries`. The token stays with `Slack`; this class only calls `api`.
 */
export class SlackInbox {
	private mentions = new Map<string, SlackMention>();
	private days = new Map<string, SlackDayFile>();
	private weeks = new Map<string, SlackWeekFile>();
	private people = new Map<string, Person>();
	private state: InboxState = emptyState();
	private loaded: Promise<void> | null = null;
	private writes: Promise<unknown> = Promise.resolve();
	private calls: Promise<unknown> = Promise.resolve();
	private building = new Set<string>();
	private open = 0;
	private todayTimer: ReturnType<typeof setTimeout> | null = null;
	private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
	private catching: Promise<void> | null = null;
	constructor(private readonly deps: SlackInboxDeps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private async path(...parts: string[]) {
		return safePath(await this.deps.dataRoot(), 'slack-inbox', ...parts);
	}
	private async folder(...parts: string[]) {
		const root = await this.deps.dataRoot();
		await mkdir(await safePath(root, 'slack-inbox', ...parts), { recursive: true, mode: 0o700 });
	}
	/** One write at a time: `mentions.jsonl` lines and the documents keep their order. */
	private write<T>(work: () => Promise<T>): Promise<T> {
		const result = this.writes.then(work, work);
		this.writes = result.catch(() => {});
		return result;
	}
	/** One agent call at a time. */
	private call<T>(work: () => Promise<T>): Promise<T> {
		const result = this.calls.then(work, work);
		this.calls = result.catch(() => {});
		return result;
	}
	load(): Promise<void> {
		return (this.loaded ??= this.read());
	}
	private async read() {
		try {
			const raw = await readFile(await this.path('mentions.jsonl'), 'utf8');
			const lines = raw
				.split('\n')
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as unknown];
					} catch {
						return [];
					}
				});
			for (const mention of slackLatestMentions(lines)) this.mentions.set(mention.id, mention);
			// The append-only file is written anew when most of its lines are old states.
			if (lines.length > this.mentions.size * 3 + 200)
				await this.write(async () =>
					atomicText(
						await this.path('mentions.jsonl'),
						[...this.mentions.values()]
							.sort((a, b) => Number(a.ts) - Number(b.ts))
							.map((mention) => JSON.stringify(mention))
							.join('\n') + '\n'
					)
				);
		} catch {
			// No file yet.
		}
		for (const [folder, map, valid] of [
			['days', this.days, isDayFile],
			['weeks', this.weeks, isWeekFile],
		] as const)
			try {
				for (const name of await readdir(await this.path(folder)))
					if (name.endsWith('.json'))
						try {
							const value = await readDocument(await this.path(folder, name));
							if (valid(value))
								(map as Map<string, unknown>).set(
									'day' in value ? (value as SlackDayFile).day : (value as SlackWeekFile).week,
									value
								);
						} catch {
							/* Not ours: skipped. */
						}
			} catch {
				/* No folder yet. */
			}
		try {
			const value = await readDocument(await this.path('people.json'));
			if (isRecord(value.people))
				for (const [id, person] of Object.entries(value.people))
					if (isRecord(person) && typeof person.name === 'string' && typeof person.at === 'number')
						this.people.set(id, { name: person.name, at: person.at });
		} catch {
			/* No file yet. */
		}
		try {
			const value = await readDocument(await this.path('state.json'));
			this.state = {
				lastEvent: typeof value.lastEvent === 'string' ? value.lastEvent : null,
				searchDay: typeof value.searchDay === 'string' ? value.searchDay : null,
				opened: typeof value.opened === 'string' ? value.opened : null,
				threads: Array.isArray(value.threads)
					? value.threads.filter((item): item is string => typeof item === 'string')
					: [],
				groups:
					isRecord(value.groups) &&
					Array.isArray(value.groups.ids) &&
					typeof value.groups.at === 'string'
						? {
								ids: value.groups.ids.filter((item): item is string => typeof item === 'string'),
								at: value.groups.at,
							}
						: null,
			};
		} catch {
			/* No file yet. */
		}
	}
	private saveState() {
		return this.write(async () => {
			await this.folder();
			await atomicJson(await this.path('state.json'), { schemaVersion: 1, ...this.state });
		});
	}
	private savePeople() {
		return this.write(async () => {
			await this.folder();
			await atomicJson(await this.path('people.json'), {
				schemaVersion: 1,
				people: Object.fromEntries(this.people),
			});
		});
	}
	private put(mention: SlackMention) {
		this.mentions.set(mention.id, mention);
		return this.write(async () => {
			await this.folder();
			await appendFile(await this.path('mentions.jsonl'), `${JSON.stringify(mention)}\n`, {
				mode: 0o600,
			});
		});
	}
	private putDay(file: SlackDayFile) {
		this.days.set(file.day, file);
		return this.write(async () => {
			await this.folder('days');
			await atomicJson(await this.path('days', `${file.day}.json`), file);
		});
	}
	private putWeek(file: SlackWeekFile) {
		this.weeks.set(file.week, file);
		return this.write(async () => {
			await this.folder('weeks');
			await atomicJson(await this.path('weeks', `${file.week}.json`), file);
		});
	}
	/** The view goes to every window a moment after the last change. */
	private changed() {
		if (this.broadcastTimer) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = null;
			void this.view().then(
				(view) => this.deps.changed(view),
				() => {}
			);
		}, 50);
		this.broadcastTimer.unref?.();
	}

	/* ——— the view ——— */
	async view(): Promise<SlackInboxView> {
		await this.load();
		const now = this.now(),
			account = this.deps.account();
		const lists = this.deps.todo ? await this.deps.todo.todoLists().catch(() => null) : null;
		const projects = await this.deps.projects().catch(() => []);
		const all = [...this.mentions.values()].sort((a, b) => Number(b.ts) - Number(a.ts));
		const live = all.filter((mention) => !slackArchived(mention.ts, now)),
			rows: SlackMentionRow[] = [];
		for (const mention of live) rows.push(await this.row(mention, now, lists, projects));
		const days = slackDayRows(rows, this.days, now);
		return {
			connected: !!account,
			me: account?.user ?? null,
			todo: !!this.deps.todo,
			mentions: rows,
			days,
			weeks: slackWeekRows(days, this.weeks, now),
			archive: slackArchiveRows(all.filter((mention) => slackArchived(mention.ts, now))),
			people: Object.fromEntries([...this.people].map(([id, person]) => [id, person.name])),
			waiting: rows.filter((row) => row.status === 'waiting').length,
			building: [...this.building],
		};
	}
	private async row(
		mention: SlackMention,
		now: number,
		lists: { name: string; project: string | null; updatedAt: string }[] | null,
		projects: { id: string; name: string }[]
	): Promise<SlackMentionRow> {
		const status = slackMentionStatus(mention, now);
		let target: SlackMentionRow['target'] = null;
		if (lists && !mention.todo) {
			const project = await this.projectOf(mention, projects);
			target = {
				project: projects.find((item) => item.id === project)?.name ?? null,
				list: slackTodoList(project, mention.agent?.list ?? null, lists),
			};
		}
		return { ...mention, status, target };
	}
	/** spec/todo-and-slack-inbox#slack-inbox-to-todo: the channel's project, else a project the text names, else none. */
	private async projectOf(
		mention: Pick<SlackMention, 'channel' | 'text'>,
		projects: { id: string; name: string }[]
	): Promise<string | null> {
		return (
			(await this.deps.channelProject(mention.channel).catch(() => null)) ??
			slackNamedProject(slackPlain(mention.text), projects)
		);
	}
	/** A month of the archive, read-only. */
	async month(month: string): Promise<SlackMentionRow[]> {
		await this.load();
		const now = this.now();
		return [...this.mentions.values()]
			.filter(
				(mention) =>
					slackArchived(mention.ts, now) && dayKey(slackTsMs(mention.ts)).startsWith(`${month}-`)
			)
			.sort((a, b) => Number(b.ts) - Number(a.ts))
			.map((mention) => ({ ...mention, status: slackMentionStatus(mention, now), target: null }));
	}

	/* ——— reading Slack ——— */
	private me() {
		const account = this.deps.account();
		return account
			? {
					user: account.user,
					groups: this.state.groups?.ids ?? [],
					bot: this.deps.botUser(),
					here: this.deps.countHere(),
					threads: new Set(this.state.threads),
				}
			: null;
	}
	/**
	 * spec/todo-and-slack-inbox#slack-inbox-source: a `message` event of Socket Mode. A DM counts only when the event is the person's (a user
	 * event), not the bot's DM.
	 */
	async event(payload: Record<string, unknown>): Promise<void> {
		const event = isRecord(payload.event) ? payload.event : null,
			me = this.me();
		if (!event || event.type !== 'message' || !me) return;
		await this.load();
		const authorizations = Array.isArray(payload.authorizations)
			? payload.authorizations.filter(isRecord)
			: [];
		const ownDm = authorizations.some((item) => item.user_id === me.user && item.is_bot !== true);
		const message = rawOf(event);
		if (!message) return;
		this.state.lastEvent = new Date(this.now()).toISOString();
		await this.groups();
		await this.take(message, { ...this.me()!, ownDm }, null);
	}
	/** One message from an event or a search: the person's own, a mention, or nothing. */
	private async take(
		message: SlackRawMessage,
		me: NonNullable<ReturnType<SlackInbox['me']>> & { ownDm: boolean },
		known: { permalink: string | null; channelName: string | null } | null
	) {
		if (slackIsOwn(message, me)) return this.own(message, known?.channelName ?? null);
		const kind = slackMentionKind(message, me);
		if (kind) await this.mention(message, kind, known);
	}
	private async own(message: SlackRawMessage, channelName: string | null) {
		const thread = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : null,
			key = slackThreadKey(message.channel, message.ts, thread);
		if (!this.state.threads.includes(key)) {
			this.state.threads = [...this.state.threads, key].slice(-threadLimit);
			void this.saveState().catch(() => {});
		}
		const day = dayKey(slackTsMs(message.ts)),
			file = this.days.get(day) ?? emptyDay(day);
		if (!file.wrote.some((item) => item.ts === message.ts && item.channel === message.channel)) {
			const item: SlackOwnMessage = {
				ts: message.ts,
				channel: message.channel,
				channelName:
					channelName ?? (await this.deps.channelName(message.channel).catch(() => null)),
				thread,
				text: [...(message.text ?? '')].slice(0, 2000).join(''),
			};
			await this.putDay({ ...file, wrote: [...file.wrote, item] });
		}
		// spec/todo-and-slack-inbox#slack-inbox-source: the person wrote after a mention in its thread (a DM: in that DM).
		for (const mention of this.mentions.values())
			if (
				!mention.answered &&
				slackAnswers(mention, { channel: message.channel, ts: message.ts, thread })
			)
				await this.put({ ...mention, answered: 'reply' });
		this.changed();
	}
	private async mention(
		message: SlackRawMessage,
		kind: SlackInboxKind,
		known: { permalink: string | null; channelName: string | null } | null
	) {
		const id = `${message.channel}/${message.ts}`;
		if (this.mentions.has(id)) return;
		const thread = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : null;
		const dm =
			message.channel_type === 'im' ||
			message.channel_type === 'mpim' ||
			message.channel.startsWith('D');
		const mention: SlackMention = {
			id,
			ts: message.ts,
			channel: message.channel,
			channelName: dm
				? null
				: (known?.channelName ?? (await this.deps.channelName(message.channel).catch(() => null))),
			dm,
			author: message.user!,
			text: [...(message.text ?? '')].slice(0, 20_000).join(''),
			thread,
			kind,
			permalink: known?.permalink ?? (await this.permalink(message.channel, message.ts)),
			answered: null,
			agentState: 'pending',
			agent: null,
			suggestion: 'open',
			todo: null,
			context: [],
		};
		mention.context = await this.context(mention).catch(() => [
			{ ts: mention.ts, user: mention.author, text: mention.text },
		]);
		// The person may already have answered in the thread.
		const me = this.deps.account()?.user;
		if (
			me &&
			mention.context.some(
				(item) =>
					item.user === me &&
					slackAnswers(mention, {
						channel: mention.channel,
						ts: item.ts,
						thread: thread ?? mention.ts,
					})
			)
		)
			mention.answered = 'reply';
		await this.names([
			mention.author,
			...mention.context.map((item) => item.user),
			...(me ? [me] : []),
		]);
		await this.put(mention);
		this.changed();
		void this.understand(id).catch(() => {});
		if (this.open > 0 && dayKey(slackTsMs(mention.ts)) === dayKey(this.now())) this.soonToday();
	}
	private async permalink(channel: string, ts: string): Promise<string | null> {
		try {
			const value = await this.deps.api('chat.getPermalink', { channel, message_ts: ts });
			return typeof value.permalink === 'string' ? value.permalink : null;
		} catch {
			return null;
		}
	}
	/** spec/todo-and-slack-inbox#slack-inbox-mention: the messages around the mention, at most 20 — its thread, or the channel before it. */
	private async context(
		mention: Pick<SlackMention, 'channel' | 'ts' | 'thread' | 'author' | 'text'>
	): Promise<SlackInboxMessage[]> {
		const found = new Map<string, SlackInboxMessage>();
		const add = (value: unknown) => {
			for (const item of Array.isArray(value) ? value : [])
				if (isRecord(item) && typeof item.ts === 'string' && typeof item.user === 'string')
					found.set(item.ts, {
						ts: item.ts,
						user: item.user,
						text: [...text(item.text)].slice(0, 4000).join(''),
					});
		};
		const root = mention.thread ?? mention.ts;
		try {
			add(
				(
					await this.deps.api('conversations.replies', {
						channel: mention.channel,
						ts: root,
						limit: 100,
					})
				).messages
			);
		} catch {
			/* A DM message without a thread, or no history scope: the channel before it. */
		}
		if (!mention.thread)
			try {
				add(
					(
						await this.deps.api('conversations.history', {
							channel: mention.channel,
							latest: mention.ts,
							inclusive: true,
							limit: 8,
						})
					).messages
				);
			} catch {
				/* Kept to what the replies gave. */
			}
		if (!found.has(mention.ts))
			found.set(mention.ts, { ts: mention.ts, user: mention.author, text: mention.text });
		const all = [...found.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
			at = all.findIndex((item) => item.ts === mention.ts),
			from = Math.max(0, Math.min(at - Math.floor(contextLimit / 2), all.length - contextLimit));
		return all.slice(from, from + contextLimit);
	}
	/** spec/todo-and-slack-inbox#slack-inbox-files: names from `users.info`, kept 24 h in `people.json`. */
	private async names(ids: readonly string[]) {
		const now = this.now();
		let changed = false;
		for (const id of new Set(ids)) {
			const known = this.people.get(id);
			if (known && now - known.at < peopleMs) continue;
			try {
				const value = await this.deps.api('users.info', { user: id }),
					user = isRecord(value.user) ? value.user : {},
					profile = isRecord(user.profile) ? user.profile : {},
					name = [profile.real_name, user.real_name, profile.display_name, user.name].find(
						(item): item is string => typeof item === 'string' && item.trim() !== ''
					);
				if (name) {
					this.people.set(id, { name: name.trim(), at: now });
					changed = true;
				}
			} catch {
				// Without users:read the ID stands for the name.
			}
		}
		if (changed) await this.savePeople().catch(() => {});
	}
	/** spec/todo-and-slack-inbox#slack-inbox-source: the person's user groups (`usergroups.list` with their members), once a day. */
	private async groups() {
		const account = this.deps.account();
		if (!account) return;
		const at = this.state.groups ? Date.parse(this.state.groups.at) : 0;
		if (this.now() - at < groupsMs) return;
		try {
			const value = await this.deps.api('usergroups.list', { include_users: true });
			const ids = (Array.isArray(value.usergroups) ? value.usergroups : [])
				.filter(
					(group): group is Record<string, unknown> =>
						isRecord(group) && Array.isArray(group.users) && group.users.includes(account.user)
				)
				.map((group) => text(group.id))
				.filter(Boolean);
			this.state.groups = { ids, at: new Date(this.now()).toISOString() };
			await this.saveState();
		} catch {
			// Without usergroups:read only the member ID counts.
		}
	}
	/**
	 * spec/todo-and-slack-inbox#slack-inbox-source: while the app was closed — `search.messages` from the last searched day: `<@member>` and `to:me`
	 * for mentions, `from:me` for `You did`. On the first run, the last 7 days.
	 */
	catchUp(): Promise<void> {
		return (this.catching ??= this.search().finally(() => {
			this.catching = null;
		}));
	}
	private async search() {
		await this.load();
		const me = this.me();
		if (!me) return;
		await this.groups();
		const today = dayKey(this.now()),
			from = this.state.searchDay ?? addDays(today, -6),
			after = addDays(from, -1);
		const queries: { query: string; own: boolean }[] = [
			{ query: `<@${me.user}> after:${after}`, own: false },
			{ query: `to:me after:${after}`, own: false },
			{ query: `from:me after:${after}`, own: true },
		];
		let failed = false;
		for (const { query, own } of queries)
			for (let page = 1; page <= 3; page++) {
				let value: Record<string, unknown>;
				try {
					value = await this.deps.api('search.messages', {
						query,
						count: 100,
						page,
						sort: 'timestamp',
						sort_dir: 'asc',
					});
				} catch {
					failed = true;
					break;
				}
				const block = isRecord(value.messages) ? value.messages : {},
					matches = Array.isArray(block.matches) ? block.matches.filter(isRecord) : [];
				for (const match of matches) {
					const channel = isRecord(match.channel) ? match.channel : {},
						permalink = text(match.permalink),
						ts = text(match.ts),
						id = text(channel.id);
					if (!ts || !id) continue;
					const message: SlackRawMessage = {
						ts,
						channel: id,
						user: text(match.user) || undefined,
						text: text(match.text),
						thread_ts: permalinkThread(permalink) ?? undefined,
						channel_type: channel.is_im ? 'im' : channel.is_mpim ? 'mpim' : undefined,
					};
					if (own && message.user !== me.user) continue;
					await this.take(
						message,
						{ ...me, threads: new Set(this.state.threads), ownDm: true },
						{
							permalink: permalink || null,
							channelName: typeof channel.name === 'string' && !channel.is_im ? channel.name : null,
						}
					).catch(() => {});
				}
				const paging = isRecord(block.paging) ? block.paging : {};
				if (typeof paging.pages !== 'number' || page >= paging.pages) break;
			}
		if (!failed) {
			this.state.searchDay = today;
			await this.saveState().catch(() => {});
		}
		this.changed();
	}

	/* ——— the agent ——— */
	/** spec/todo-and-slack-inbox#slack-inbox-agent: the per-mention call — what it wants, a date, a to-do and its list. */
	private async understand(id: string, force = false) {
		await this.call(async () => {
			const mention = this.mentions.get(id);
			if (!mention || (mention.agentState === 'done' && !force)) return;
			const projects = await this.deps.projects().catch(() => []),
				project = await this.projectOf(mention, projects),
				lists = this.deps.todo
					? (await this.deps.todo.todoLists().catch(() => []))
							.filter((list) => list.project === project)
							.map((list) => list.name)
					: [];
			const prompt = slackMentionPrompt({
				locale: this.deps.locale(),
				today: dayKey(this.now()),
				author: this.name(mention.author),
				where: mention.dm ? 'a direct message' : `#${mention.channelName ?? mention.channel}`,
				text: this.plain(mention.text),
				thread: mention.context.map((item) => ({
					author: this.name(item.user),
					text: this.plain(item.text),
					mention: item.ts === mention.ts,
				})),
				lists,
			});
			const result = await this.deps.agent(prompt, 4000).catch(() => ({ kind: 'failed' }) as const);
			const latest = this.mentions.get(id) ?? mention;
			if (result.kind === 'text') {
				const agent = slackMentionAnswer(result.text, lists);
				await this.put({
					...latest,
					agent: agent ?? latest.agent,
					agentState: agent ? 'done' : 'failed',
				});
			} else
				await this.put({ ...latest, agentState: result.kind === 'quota' ? 'quota' : 'failed' });
			this.changed();
		});
	}
	private name(id: string) {
		return this.people.get(id)?.name ?? id;
	}
	/** Slack's markup as plain text with names in place of member IDs. */
	private plain(value: string) {
		return slackPlain(
			value.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${this.name(id)}`)
		);
	}
	/** spec/todo-and-slack-inbox#slack-inbox-day: a day's summary — its mentions, asks and the person's own messages. */
	async summarizeDay(day: string): Promise<void> {
		await this.load();
		if (this.building.has(day)) return;
		this.building.add(day);
		this.changed();
		try {
			await this.call(async () => {
				const mentions = [...this.mentions.values()]
						.filter((mention) => dayKey(slackTsMs(mention.ts)) === day)
						.sort((a, b) => Number(a.ts) - Number(b.ts)),
					file = this.days.get(day) ?? emptyDay(day);
				const prompt = slackDayPrompt({
					locale: this.deps.locale(),
					day,
					mentions: mentions.map((mention) => ({
						id: mention.id,
						author: this.name(mention.author),
						where: mention.dm ? 'a direct message' : `#${mention.channelName ?? mention.channel}`,
						text: this.plain(mention.text),
						ask: mention.agent?.ask ?? null,
					})),
					wrote: file.wrote.map((item) => ({
						where: item.channelName ? `#${item.channelName}` : 'a direct message',
						thread: slackThreadKey(item.channel, item.ts, item.thread),
						text: this.plain(item.text),
					})),
				});
				const result = await this.deps
					.agent(prompt, 12_000)
					.catch(() => ({ kind: 'failed' }) as const);
				const latest = this.days.get(day) ?? file,
					parts =
						result.kind === 'text'
							? slackDayAnswer(
									result.text,
									mentions.map((mention) => mention.id)
								)
							: null;
				await this.putDay(
					parts
						? {
								...latest,
								state: 'ready',
								madeAt: new Date(this.now()).toISOString(),
								summary: parts,
							}
						: { ...latest, state: result.kind === 'quota' ? 'quota' : 'failed' }
				);
			});
		} finally {
			this.building.delete(day);
			this.changed();
		}
	}
	/** spec/todo-and-slack-inbox#slack-inbox-day: a week's few lines from its day summaries. */
	async summarizeWeek(week: string): Promise<void> {
		await this.load();
		if (this.building.has(week)) return;
		this.building.add(week);
		this.changed();
		try {
			await this.call(async () => {
				const { from, to } = weekDays(week),
					days = [];
				for (let day = from; day <= to; day = addDays(day, 1)) {
					const mentions = [...this.mentions.values()].filter(
							(mention) => dayKey(slackTsMs(mention.ts)) === day
						),
						summary = this.days.get(day)?.summary;
					if (!mentions.length && !summary) continue;
					days.push({
						day,
						mentions: mentions.length,
						did: summary?.did ?? [],
						worth: summary?.worth ?? [],
						asks:
							summary?.asks.map((item) => item.line) ??
							mentions.flatMap((mention) => (mention.agent?.ask ? [mention.agent.ask] : [])),
					});
				}
				const result = await this.deps
					.agent(slackWeekPrompt({ locale: this.deps.locale(), from, to, days }), 6000)
					.catch(() => ({ kind: 'failed' }) as const);
				const lines = result.kind === 'text' ? slackWeekAnswer(result.text) : null,
					latest = this.weeks.get(week) ?? emptyWeek(week);
				await this.putWeek(
					lines
						? { ...latest, state: 'ready', madeAt: new Date(this.now()).toISOString(), lines }
						: { ...latest, state: result.kind === 'quota' ? 'quota' : 'failed' }
				);
			});
		} finally {
			this.building.delete(week);
			this.changed();
		}
	}
	/** While the section is open, a new mention of today makes today's summary again a little later. */
	private soonToday() {
		if (this.todayTimer) return;
		this.todayTimer = setTimeout(() => {
			this.todayTimer = null;
			if (this.open > 0) void this.summarizeDay(dayKey(this.now())).catch(() => {});
		}, this.deps.summaryDelayMs ?? 60_000);
		this.todayTimer.unref?.();
	}
	/**
	 * spec/todo-and-slack-inbox#slack-inbox-day: the section opened. On the first opening of a day the days since the last opening are summarized
	 * once more (they may have grown after their summary), and on the first opening of a week the last week; today is made when it has a
	 * mention newer than its summary.
	 */
	async opened(open: boolean): Promise<void> {
		this.open = Math.max(0, this.open + (open ? 1 : -1));
		if (!open) return;
		await this.load();
		if (!this.deps.account()) return;
		const today = dayKey(this.now()),
			last = this.state.opened;
		const work: Promise<void>[] = [];
		if (last !== today) {
			this.state.opened = today;
			await this.saveState().catch(() => {});
			const week = addDays(today, -7),
				start = last && last > week ? last : week;
			for (let day = start; day < today; day = addDays(day, 1))
				if (this.stale(day)) work.push(this.summarizeDay(day));
			if (!last || weekKey(last) !== weekKey(today)) {
				const previous = weekKey(addDays(today, -7));
				work.push(this.summarizeWeek(previous));
			}
		}
		if (this.stale(today)) work.push(this.summarizeDay(today));
		await Promise.all(work.map((item) => item.catch(() => {})));
	}
	/** A day with a mention or a message of the person after its summary was made (or with none made). */
	private stale(day: string): boolean {
		const file = this.days.get(day),
			made = file?.madeAt ? Date.parse(file.madeAt) : 0,
			newest = Math.max(
				0,
				...[...this.mentions.values()]
					.filter((mention) => dayKey(slackTsMs(mention.ts)) === day)
					.map((mention) => slackTsMs(mention.ts)),
				...(file?.wrote ?? []).map((item) => slackTsMs(item.ts))
			);
		return newest > 0 && newest > made && (file?.state ?? 'none') !== 'quota';
	}
	/** `Refresh`: Slack is read again, then the open day or week (today by default) is summarized again; a mention is understood again. */
	async refresh(target: SlackInboxTarget | null): Promise<void> {
		await this.load();
		if (!this.deps.account()) return;
		await this.catchUp().catch(() => {});
		// A mention the agent could not do (no quota, nothing usable) gets another call.
		for (const mention of this.mentions.values())
			if (mention.agentState === 'quota' || mention.agentState === 'failed')
				void this.understand(mention.id, true).catch(() => {});
		if (!target || target.kind === 'day')
			await this.summarizeDay(target?.day ?? dayKey(this.now()));
		else if (target.kind === 'week') await this.summarizeWeek(target.week);
		else if (target.kind === 'mention') {
			await this.thread(target.id).catch(() => []);
			await this.understand(target.id, true);
		}
	}

	/* ——— actions ——— */
	/** The open mention's thread, read again. */
	async thread(id: string): Promise<SlackInboxMessage[]> {
		await this.load();
		const mention = this.mentions.get(id);
		if (!mention) throw new Error('The mention is gone.');
		if (!this.deps.account()) return mention.context;
		const context = await this.context(mention);
		await this.names(context.map((item) => item.user));
		if (JSON.stringify(context) !== JSON.stringify(mention.context)) {
			const me = this.deps.account()?.user,
				answered =
					mention.answered ??
					(me &&
					context.some(
						(item) =>
							item.user === me &&
							slackAnswers(mention, {
								channel: mention.channel,
								ts: item.ts,
								thread: mention.thread ?? mention.ts,
							})
					)
						? ('reply' as const)
						: null);
			await this.put({ ...(this.mentions.get(id) ?? mention), context, answered });
			this.changed();
		}
		return context;
	}
	/** `Done`: answered without a reply. */
	async done(id: string): Promise<void> {
		await this.load();
		const mention = this.mentions.get(id);
		if (!mention || mention.answered) return;
		await this.put({ ...mention, answered: 'done' });
		this.changed();
	}
	/** `Dismiss` on the suggestion: it does not come back. */
	async dismiss(id: string): Promise<void> {
		await this.load();
		const mention = this.mentions.get(id);
		if (!mention || mention.suggestion === 'dismissed') return;
		await this.put({ ...mention, suggestion: 'dismissed' });
		this.changed();
	}
	/** spec/todo-and-slack-inbox#slack-inbox-to-todo: a to-do from the mention in its project's list, the message as its source. */
	async addTodo(id: string): Promise<SlackTodoRef> {
		await this.load();
		const todo = this.deps.todo,
			mention = this.mentions.get(id);
		if (!todo) throw new Error('Todo is off in Settings.');
		if (!mention) throw new Error('The mention is gone.');
		if (mention.todo) return mention.todo;
		const projects = await this.deps.projects().catch(() => []),
			project = await this.projectOf(mention, projects),
			lists = await todo.todoLists().catch(() => []),
			item = slackTodoOf(mention);
		const made = await todo.addTodo({
			project,
			list: slackTodoList(project, mention.agent?.list ?? null, lists),
			title: item.title,
			description: item.description,
			source: {
				kind: 'slack',
				permalink: mention.permalink ?? '',
				channel: mention.dm ? 'Direct message' : (mention.channelName ?? mention.channel),
				author: this.name(mention.author),
				ts: mention.ts,
				mention: mention.id,
			},
		});
		const ref: SlackTodoRef = {
			listId: made.listId,
			listName: made.listName,
			project: made.project
				? (projects.find((item) => item.id === made.project)?.name ?? made.project)
				: null,
			itemId: made.itemId,
		};
		await this.put({ ...(this.mentions.get(id) ?? mention), todo: ref });
		this.changed();
		return ref;
	}
	/** `Undo` of the toast: the to-do goes, the mention offers `Add to Todo` again. */
	async undoTodo(id: string): Promise<void> {
		await this.load();
		const mention = this.mentions.get(id);
		if (!mention?.todo || !this.deps.todo) return;
		await this.deps.todo.removeTodo(mention.todo.listId, mention.todo.itemId);
		await this.put({ ...(this.mentions.get(id) ?? mention), todo: null });
		this.changed();
	}
	/** The token changed (connected, replaced or gone): a new connection reads the gap. */
	accountChanged() {
		this.changed();
		if (this.deps.account()) void this.catchUp().catch(() => {});
	}
	dispose() {
		if (this.todayTimer) clearTimeout(this.todayTimer);
		if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
		this.todayTimer = this.broadcastTimer = null;
	}
	/** Tests: everything written so far is on disk. */
	settled(): Promise<unknown> {
		return Promise.all([this.writes, this.calls]);
	}
}
function emptyDay(day: string): SlackDayFile {
	return { schemaVersion: 1, day, wrote: [], state: 'none', madeAt: null, summary: null };
}
function emptyWeek(week: string): SlackWeekFile {
	return { schemaVersion: 1, week, state: 'none', madeAt: null, lines: [] };
}
function isDayFile(value: unknown): value is SlackDayFile {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		typeof value.day === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(value.day) &&
		Array.isArray(value.wrote) &&
		['none', 'ready', 'quota', 'failed'].includes(value.state as string) &&
		(value.madeAt === null || typeof value.madeAt === 'string') &&
		(value.summary === null ||
			(isRecord(value.summary) &&
				Array.isArray(value.summary.asks) &&
				Array.isArray(value.summary.did) &&
				Array.isArray(value.summary.worth)))
	);
}
function isWeekFile(value: unknown): value is SlackWeekFile {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		typeof value.week === 'string' &&
		/^\d{4}-W\d{2}$/.test(value.week) &&
		['none', 'ready', 'quota', 'failed'].includes(value.state as string) &&
		Array.isArray(value.lines)
	);
}
/** A `message` event as the inbox reads it; an edit gives its new text. */
function rawOf(event: Record<string, unknown>): SlackRawMessage | null {
	const channel = text(event.channel),
		ts = text(event.ts);
	if (!channel || !ts) return null;
	return {
		ts,
		channel,
		user: text(event.user) || undefined,
		text: text(event.text),
		thread_ts: text(event.thread_ts) || undefined,
		channel_type: text(event.channel_type) || undefined,
		subtype: text(event.subtype) || undefined,
		bot_id: text(event.bot_id) || undefined,
	};
}
