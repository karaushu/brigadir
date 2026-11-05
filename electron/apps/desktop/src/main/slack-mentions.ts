import { randomUUID } from 'node:crypto';
import {
	isRecord,
	slackActionOf,
	slackActions,
	slackAllowed,
	slackButtons,
	slackFindTasks,
	slackMentionText,
	slackNoteText,
	slackNoteTitle,
	slackLanguage,
	slackLocalize,
	slackNamedProject,
	type SlackProjectRef,
	slackActive,
	slackAgentAnswer,
	slackAgentMessage,
	slackAgentSteps,
	slackAnswerReply,
	slackFactsText,
	slackModelAnswer,
	type SlackAgentStep,
	type SlackTaskFacts,
	type SlackLanguage,
	slackProjectPrefix,
	slackReply,
	slackSummaryPrompt,
	slackTaskTitle,
	slackThreadText,
	type SlackButton,
	type SlackSettings,
	type SlackStatusInput,
	type SlackTaskInfo,
	type SlackThreadMessage,
	type SlackThreadRef,
	type TaskKey,
	slackPRNumbers,
	slackWatchKinds,
	slackWatchReply,
	type SlackWatchKind,
} from '@brigadir/core';
import type { SlackAnswering } from './slack-answers';
import type { SlackWatchInput } from './slack-watches';
import type { SlackSideSession } from './slack-sessions';

/** The Slack thread a side question comes from: its session lives per thread; `context` — the thread above, as text. */
export type SlackSideThread = { channel: string; ts: string; context: string | null };

export type SlackTaskInput = {
	projectId: string;
	title: string;
	prompt: string;
	/** The thread above the mention as plain text — the task's text attachment; `null` for a mention outside a thread. */
	context: string | null;
	/** `New task: Start` — starts now; `Ask in Brigadir` — waits in the backlog with a notice. */
	start: boolean;
	thread: SlackThreadRef;
	/** spec/notifications-slack-notes-and-schedules#slack-agent: the other projects the agent named for the task; their folders join it. */
	alsoProjects: string[];
};
/**
 * What Brigadir gives Slack: its projects and tasks, the helper model, task and note creation (the mentions), and the agent's
 * messages and answers (spec/notifications-slack-notes-and-schedules#slack).
 */
export type SlackBrigadir = SlackAnswering & {
	notesOn(): boolean;
	/** One one-shot of the helper agent (spec/composer-steering-queue-and-ghost#ghost-headless); `null` — no helper agent or its window is spent. */
	helper(prompt: string, characterLimit: number): Promise<string | null>;
	/** spec/notifications-slack-notes-and-schedules#slack: a side question to the task's agent (spec/composer-steering-queue-and-ghost#quick-question, read-only); its answer, or `null`. */
	askAgent(
		task: TaskKey,
		question: string,
		language: SlackLanguage,
		thread?: SlackSideThread
	): Promise<string | null>;
	/** spec/notifications-slack-notes-and-schedules#slack-agent: the Slack agent — a session in a project's main tree that sees every project and runs only commands that read; its answer. */
	askCode?(
		/** The project to start in; `null` — the first one. The agent sees every project either way. */
		projectId: string | null,
		question: string,
		language: SlackLanguage,
		thread: SlackSideThread,
		agent?: { facts?: string; ack?(text: string): void }
	): Promise<string | null>;
	/** The thread's side session that still waits for a follow-up (ten minutes after its last answer). */
	sideSession?(channel: string, ts: string): SlackSideSession | null;
	createTask(input: SlackTaskInput): Promise<{ projectId: string; id: string; title: string }>;
	tasks(projectId: string): Promise<SlackTaskInfo[]>;
	/** The plan N of M and the CI state of a task, from its journal and the watched runs. */
	status(task: SlackTaskInfo): Promise<Pick<SlackStatusInput, 'plan' | 'ci'>>;
	createNote(project: string | null, text: string): Promise<void>;
};
export type SlackMentionDeps = SlackBrigadir & {
	api(
		method: string,
		body: Record<string, unknown>,
		form?: boolean
	): Promise<Record<string, unknown>>;
	settings(): SlackSettings;
	projects(): Promise<SlackProjectRef[]>;
	/** The bot's own user (`auth.test`'s `user_id`): its mention is cut from the text, its messages are not answered. */
	botUser(): string | null;
	/** The project whose `Where` channel this is (by ID or by a name the bot learned). */
	channelProject(channel: string): Promise<string | null>;
	channelName(channel: string): Promise<string | null>;
	/** The task whose messages go to this thread (threads of posted events and tasks made here). */
	taskOfThread(channel: string, ts: string): TaskKey | null;
	threadStarted(task: TaskKey, thread: { channel: string; ts: string }): void;
	/** «Watch and tell me here» (slack-watches.ts); without them a watch request is not understood. */
	watch?(inputs: SlackWatchInput[]): Promise<'ok' | 'full'>;
	unwatch?(channel: string, ts: string): Promise<number>;
	/** One pass over the watches right after a new one: what already happened is answered now. */
	watchNow?(): void;
	now?(): number;
};
/** A PR a watch may read: the task that has it and its repo's scope. */
type WatchPick = {
	task: SlackTaskInfo;
	scopeId: string;
	number: number;
	url: string;
	state: SlackTaskInfo['prs'][number]['state'];
};
/** A watch request as far as it is known; a button fills in what was ambiguous. */
type WatchDraft = { kinds: SlackWatchKind[]; pr?: WatchPick; task?: SlackTaskInfo };
/** One mention, as the handlers need it. `replyTs` — the thread the bot answers in (the mention's own, or its root). */
type Mention = {
	user: string;
	channel: string;
	ts: string;
	replyTs: string;
	inThread: boolean;
	text: string;
	projectId: string | null;
	/** The project came from an `in <project>:` prefix: the person named it, the dispatch does not move it. */
	prefixed: boolean;
	/** The project whose `Where` channel this is. */
	channelProject: string | null;
	unknownProject: string | null;
	thread: SlackThreadMessage[];
	/** The request's language; every answer to it is in it. */
	language: SlackLanguage;
};
type Pending = {
	mention: Mention;
	at: number;
	tasks?: TaskKey[];
	drafts?: WatchDraft[];
};
const pendingMs = 5 * 60_000,
	seenLimit = 300;

/**
 * spec/notifications-slack-notes-and-schedules#slack: an `@bot` mention — a task, the state of one, a note, or buttons when unclear. Everyone but the allowed
 * people gets an ephemeral refusal; the answer to «what state» is Brigadir's own data. Buttons keep their mention in memory
 * for five minutes.
 */
export class SlackMentions {
	private pending = new Map<string, Pending>();
	private seen: string[] = [];
	constructor(private readonly deps: SlackMentionDeps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	/** Events API callback of Socket Mode; only `app_mention` is ours. */
	async event(payload: Record<string, unknown>) {
		const event = payload.event;
		if (!isRecord(event) || event.type !== 'app_mention') return;
		if (event.bot_id || typeof event.subtype === 'string') return;
		const user = typeof event.user === 'string' ? event.user : null,
			channel = typeof event.channel === 'string' ? event.channel : null,
			ts = typeof event.ts === 'string' ? event.ts : null;
		if (!user || !channel || !ts || user === this.deps.botUser()) return;
		// Slack sends an envelope again when the ack was late; one mention is answered once.
		const id = typeof payload.event_id === 'string' ? payload.event_id : `${channel}/${ts}`;
		if (this.seen.includes(id)) return;
		this.seen.push(id);
		if (this.seen.length > seenLimit) this.seen.splice(0, this.seen.length - seenLimit);
		const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : null,
			replyTs = threadTs ?? ts;
		const language = slackLanguage(typeof event.text === 'string' ? event.text : '');
		if (!this.allowed(user)) {
			await this.ephemeral({ channel, user, replyTs, language }, slackReply.notAllowed);
			return;
		}
		const raw = slackMentionText(
				typeof event.text === 'string' ? event.text : '',
				this.deps.botUser()
			),
			projects = await this.deps.projects().catch(() => []),
			prefix = slackProjectPrefix(raw, projects),
			text = prefix ? prefix.rest : raw,
			channelProject = await this.deps.channelProject(channel).catch(() => null);
		const mention: Mention = {
			user,
			channel,
			ts,
			replyTs,
			inThread: threadTs !== null,
			text,
			projectId:
				prefix && 'project' in prefix
					? prefix.project
					: (channelProject ?? (prefix ? null : slackNamedProject(text, projects))),
			prefixed: !!prefix && 'project' in prefix,
			channelProject,
			unknownProject: prefix && 'unknown' in prefix ? prefix.unknown : null,
			thread: threadTs ? await this.replies(channel, threadTs, ts) : [],
			language,
		};
		try {
			if (!text && !mention.inThread) {
				await this.reply(mention, slackReply.noText);
				return;
			}
			await this.agent(mention);
		} catch (error) {
			await this.reply(mention, slackReply.failed(reason(error))).catch(() => {});
		}
	}
	/** `block_actions` of our buttons. */
	async interactive(payload: Record<string, unknown>) {
		if (payload.type !== 'block_actions' || !Array.isArray(payload.actions)) return;
		const action = payload.actions[0],
			user = isRecord(payload.user) && typeof payload.user.id === 'string' ? payload.user.id : null,
			container = isRecord(payload.container) ? payload.container : {},
			channel =
				isRecord(payload.channel) && typeof payload.channel.id === 'string'
					? payload.channel.id
					: typeof container.channel_id === 'string'
						? container.channel_id
						: null;
		if (!isRecord(action) || typeof action.action_id !== 'string' || !user || !channel) return;
		const kind = slackActionOf(action.action_id);
		if (!kind || kind === slackActions.answer) return;
		const [pendingId = '', taskId] = (typeof action.value === 'string' ? action.value : '').split(
				':'
			),
			messageTs = typeof container.message_ts === 'string' ? container.message_ts : null,
			threadTs = typeof container.thread_ts === 'string' ? container.thread_ts : (messageTs ?? '');
		const where = { channel, user, replyTs: threadTs };
		if (!this.allowed(user)) {
			await this.ephemeral(where, slackReply.notAllowed);
			return;
		}
		this.prune();
		const pending = this.pending.get(pendingId);
		if (!pending) {
			await this.ephemeral(where, slackReply.expired);
			return;
		}
		this.pending.delete(pendingId);
		// The buttons are answered: their message keeps its text and loses the buttons.
		if (messageTs && isRecord(payload.message) && typeof payload.message.text === 'string')
			void this.deps
				.api('chat.update', { channel, ts: messageTs, text: payload.message.text, blocks: [] })
				.catch(() => {});
		const mention = { ...pending.mention, user };
		try {
			if (kind === slackActions.watch) {
				const draft = pending.drafts?.[Number(taskId)];
				if (draft) await this.watch(mention, draft);
			}
		} catch (error) {
			await this.reply(mention, slackReply.failed(reason(error))).catch(() => {});
		}
	}
	private allowed(user: string) {
		return slackAllowed(this.deps.settings(), user);
	}
	/** The thread above the mention (the mention itself left out), oldest first. */
	private async replies(
		channel: string,
		threadTs: string,
		own: string
	): Promise<SlackThreadMessage[]> {
		try {
			const value = await this.deps.api(
				'conversations.replies',
				{ channel, ts: threadTs, limit: 200, inclusive: true },
				true
			);
			if (!Array.isArray(value.messages)) return [];
			return value.messages.flatMap((message): SlackThreadMessage[] => {
				if (!isRecord(message) || message.ts === own || typeof message.ts !== 'string') return [];
				const author =
					typeof message.user === 'string'
						? message.user
						: isRecord(message.bot_profile) && typeof message.bot_profile.name === 'string'
							? message.bot_profile.name
							: typeof message.username === 'string'
								? message.username
								: 'someone';
				const files = Array.isArray(message.files)
					? message.files.flatMap((file) =>
							isRecord(file) && typeof file.permalink === 'string'
								? [
										{
											name: typeof file.name === 'string' ? file.name : 'file',
											url: file.permalink,
										},
									]
								: []
						)
					: [];
				return [
					{
						user: author,
						ts: message.ts,
						text: typeof message.text === 'string' ? message.text : '',
						...(files.length ? { files } : {}),
					},
				];
			});
		} catch {
			// Without channels:history / groups:history the thread is not readable; the mention alone still works.
			return [];
		}
	}
	/**
	 * «Write here when …»: what to watch (CI of a PR, its merge, a task done), then which PR — `#N`, else the thread task's
	 * open one — and which task — the thread's, else the one the text names. Ambiguous: up to three buttons; nothing found:
	 * what is missing.
	 */
	private async watch(mention: Mention, start: WatchDraft) {
		let draft = start;
		if (!draft.kinds.length) {
			await this.choose(
				mention,
				slackWatchReply.what,
				slackWatchKinds.map((kind) => ({
					label: slackWatchReply.labels[kind],
					draft: { ...draft, kinds: [kind] },
				}))
			);
			return;
		}
		const own = mention.inThread ? this.deps.taskOfThread(mention.channel, mention.replyTs) : null,
			pool = await this.watchPool(mention, own),
			ownTask =
				(own && pool.find((task) => task.projectId === own.projectId && task.id === own.id)) ||
				null;
		if (draft.kinds.some((kind) => kind !== 'task-done') && !draft.pr) {
			const numbers = slackPRNumbers(mention.text),
				picks = watchPicks(pool, numbers, ownTask ?? draft.task ?? null, mention.text);
			if (!picks.length) {
				await this.reply(
					mention,
					numbers.length ? slackWatchReply.noPR(numbers) : slackWatchReply.noOpenPR
				);
				return;
			}
			if (picks.length > 1) {
				await this.choose(
					mention,
					slackWatchReply.severalPRs,
					picks.slice(0, 3).map((pick) => ({
						label: `#${pick.number} · ${pick.task.title}`,
						draft: { ...draft, pr: pick },
					}))
				);
				return;
			}
			draft = { ...draft, pr: picks[0]! };
		}
		if (draft.kinds.includes('task-done') && !draft.task) {
			let task = ownTask ?? draft.pr?.task ?? null;
			if (!task) {
				const found = slackFindTasks(
					mention.text,
					pool.filter((item) => !item.archived)
				);
				if (!found.length) {
					await this.reply(mention, slackReply.noTask);
					return;
				}
				if (found.length > 1) {
					await this.choose(
						mention,
						slackReply.severalTasks,
						found
							.slice(0, 3)
							.map((item) => ({ label: item.title, draft: { ...draft, task: item } }))
					);
					return;
				}
				task = found[0]!;
			}
			draft = { ...draft, task };
		}
		const completed = draft.task?.status === 'completed' && draft.kinds.includes('task-done'),
			kinds = completed ? draft.kinds.filter((kind) => kind !== 'task-done') : draft.kinds;
		if (!kinds.length) {
			await this.reply(mention, slackWatchReply.completed(draft.task!.title));
			return;
		}
		const ref = (task: SlackTaskInfo) => ({
			projectId: task.projectId,
			id: task.id,
			title: task.title,
		});
		const inputs: SlackWatchInput[] = kinds.map((kind) =>
			kind === 'task-done'
				? {
						kind,
						channel: mention.channel,
						ts: mention.replyTs,
						by: mention.user,
						language: mention.language,
						task: ref(draft.task!),
						pr: null,
						last: draft.task!.status,
					}
				: {
						kind,
						channel: mention.channel,
						ts: mention.replyTs,
						by: mention.user,
						language: mention.language,
						task: ref(draft.pr!.task),
						pr: {
							projectId: draft.pr!.task.projectId,
							taskId: draft.pr!.task.id,
							scopeId: draft.pr!.scopeId,
							number: draft.pr!.number,
							url: draft.pr!.url,
						},
					}
		);
		if ((await this.deps.watch!(inputs)) === 'full') {
			await this.reply(mention, slackWatchReply.tooMany);
			return;
		}
		await this.reply(
			mention,
			[
				slackWatchReply.watching(inputs),
				...(completed ? [slackWatchReply.completed(draft.task!.title)] : []),
			].join('\n')
		);
		this.deps.watchNow?.();
	}
	/** The tasks a watch may name: the thread task's project, the mention's project, else every project's. */
	private async watchPool(mention: Mention, own: TaskKey | null) {
		const ids = own
			? [own.projectId]
			: mention.projectId
				? [mention.projectId]
				: (await this.deps.projects().catch(() => [])).map((project) => project.id);
		return (await Promise.all(ids.map((id) => this.deps.tasks(id).catch(() => [])))).flat();
	}
	private async unwatch(mention: Mention) {
		const count = await this.deps.unwatch!(mention.channel, mention.replyTs);
		await this.reply(mention, count ? slackWatchReply.stopped(count) : slackWatchReply.nothing);
	}
	private choose(mention: Mention, text: string, options: { label: string; draft: WatchDraft }[]) {
		return this.buttons(
			mention,
			text,
			options.map((option, index) => ({
				action: slackActions.watch,
				label: option.label,
				task: String(index),
			})),
			undefined,
			options.map((option) => option.draft)
		);
	}
	/** The task in the first project; the other projects' folders join it (spec/notifications-slack-notes-and-schedules#slack-agent). */
	private async create(
		mention: Mention,
		ids: string[],
		title: string | null,
		prompt?: string | null
	) {
		const start = this.deps.settings().mentions.start === 'start',
			projects = await this.deps.projects().catch(() => []),
			name = (id: string) => projects.find((item) => item.id === id)?.name ?? id,
			[projectId, ...alsoProjects] = ids as [string, ...string[]];
		const created = await this.deps.createTask({
			projectId,
			title: title || slackTaskTitle(prompt || mention.text),
			prompt: prompt || mention.text,
			context: mention.thread.length ? slackThreadText(mention.thread) : null,
			start,
			thread: {
				channel: mention.channel,
				ts: mention.replyTs,
				permalink: await this.permalink(mention.channel, mention.replyTs),
			},
			alsoProjects,
		});
		// The task's later events (Needs you, Task done, CI) answer in this thread.
		this.deps.threadStarted(
			{ projectId: created.projectId, id: created.id },
			{ channel: mention.channel, ts: mention.replyTs }
		);
		const project = ids.map(name).join(' + ');
		await this.reply(
			mention,
			start
				? slackReply.taskCreated(project, created.title)
				: slackReply.taskWaiting(project, created.title)
		);
	}
	private async permalink(channel: string, ts: string) {
		try {
			const value = await this.deps.api('chat.getPermalink', { channel, message_ts: ts }, true);
			return typeof value.permalink === 'string' &&
				/^https:\/\/[^\s/]+\.slack\.com\//.test(value.permalink)
				? value.permalink
				: null;
		} catch {
			return null;
		}
	}
	/** «⏳ Asking the agent of …», then its answer with fenced code cut, or a short «did not answer». */
	private async askTaskAgent(mention: Mention, task: SlackTaskInfo) {
		await this.reply(mention, slackReply.askingAgent(task.title));
		const reply = await this.deps
			.askAgent(
				{ projectId: task.projectId, id: task.id },
				mention.text,
				mention.language,
				// Its own side session: the Slack agent's session of this thread stays.
				{ ...this.sideThread(mention), ts: `${mention.replyTs}/task` }
			)
			.catch(() => null);
		await this.agentReply(mention, reply);
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack-agent: the bot only carries the message. The agent gets it with the thread, every
	 * project and Brigadir's tasks; its `ACK: …` line goes out at once, then its answer, then the actions it asked for.
	 */
	private async agent(mention: Mention) {
		if (!this.deps.askCode) {
			await this.reply(mention, slackReply.agentSilent);
			return;
		}
		const own = mention.inThread ? this.deps.taskOfThread(mention.channel, mention.replyTs) : null,
			side = mention.inThread
				? (this.deps.sideSession?.(mention.channel, mention.replyTs) ?? null)
				: null,
			projectId =
				mention.projectId ?? own?.projectId ?? (side?.mode === 'aboutCode' ? side.projectId : null),
			{ facts, tasks } = await this.facts(own),
			where = { channel: mention.channel, replyTs: mention.replyTs };
		let acked: Promise<unknown> = Promise.resolve();
		const reply = await this.deps
			.askCode(
				projectId,
				mention.text || '(The message only mentions you: read the thread above it.)',
				mention.language,
				this.sideThread(mention),
				{
					facts,
					ack: (text) => {
						const said = slackModelAnswer(text);
						if (said) acked = this.reply(where, `⏳ ${said}`).catch(() => {});
					},
				}
			)
			.catch(() => null);
		await acked;
		if (!reply) {
			await this.reply(mention, slackReply.agentSilent);
			return;
		}
		const { text, actions } = slackAgentSteps(reply),
			said = text ? slackAgentAnswer(text) : null;
		if (said) await this.reply(where, said);
		for (const action of actions) await this.step(mention, action, tasks);
	}
	/** Brigadir's tasks for the agent: the thread's task first, then the newest of every project (≤ 40, plan and CI for 15). */
	private async facts(own: TaskKey | null) {
		const projects = await this.deps.projects().catch(() => []),
			all: { task: SlackTaskInfo; project: string }[] = [];
		const mine = (task: SlackTaskInfo) =>
			own !== null && task.id === own.id && task.projectId === own.projectId;
		for (const project of projects)
			for (const task of await this.deps.tasks(project.id).catch(() => []))
				if (!task.archived || mine(task)) all.push({ task, project: project.name });
		all.sort(
			(a, b) =>
				Number(mine(b.task)) - Number(mine(a.task)) ||
				(b.task.updatedAt ?? '').localeCompare(a.task.updatedAt ?? '')
		);
		const facts: SlackTaskFacts[] = [];
		for (const [index, item] of all.slice(0, 40).entries())
			facts.push({
				...item,
				...(index < 15 && slackActive(item.task)
					? await this.deps.status(item.task).catch(() => ({ plan: null, ci: null }))
					: { plan: null, ci: null }),
			});
		return { facts: slackFactsText(facts, this.now()), tasks: all.map((item) => item.task) };
	}
	/** One action the agent asked for; Brigadir runs it and says so in the thread. */
	private async step(mention: Mention, action: SlackAgentStep, tasks: SlackTaskInfo[]) {
		const taskOf = (ref: string) =>
			tasks.find((task) => task.id === ref.trim()) ??
			tasks.find((task) => task.title.toLowerCase() === ref.trim().toLowerCase());
		try {
			if (action.kind === 'create_task') {
				const projects = await this.deps.projects().catch(() => []),
					find = (name: string) =>
						projects.find((item) =>
							[item.id, item.name, item.folder ?? ''].some(
								(value) => value.toLowerCase() === name.toLowerCase()
							)
						),
					unknown = action.projects.find((name) => !find(name)),
					ids = [...new Set(action.projects.map((name) => find(name)?.id ?? ''))];
				if (unknown !== undefined || !ids.length)
					await this.reply(
						mention,
						slackReply.unknownProject(
							unknown ?? '',
							projects.map((item) => item.name)
						)
					);
				else await this.create(mention, ids, action.title, action.prompt);
			} else if (action.kind === 'send_to_task' || action.kind === 'ask_task') {
				const task = taskOf(action.task);
				if (!task) await this.reply(mention, slackReply.noTask);
				else if (action.kind === 'ask_task')
					await this.askTaskAgent({ ...mention, text: action.question }, task);
				else {
					const result = await this.deps.sendToTask(
						{ projectId: task.projectId, id: task.id },
						slackAgentMessage(mention.user, action.text)
					);
					await this.reply(
						mention,
						result === 'sent' ? slackReply.handedTo(task.title) : slackAnswerReply[result]
					);
				}
			} else if (action.kind === 'note') await this.note(mention, action.note);
			else if (action.kind === 'watch' && this.deps.watch)
				await this.watch(mention, { kinds: action.kinds });
			else if (action.kind === 'unwatch' && this.deps.unwatch) await this.unwatch(mention);
		} catch (error) {
			await this.reply(mention, slackReply.failed(reason(error))).catch(() => {});
		}
	}
	/** spec/notifications-slack-notes-and-schedules#slack-agent: a plain reply in a thread whose agent session still waits goes to the agent. */
	listens(channel: string, threadTs: string): boolean {
		return this.deps.sideSession?.(channel, threadTs)?.mode === 'aboutCode';
	}
	private sideThread(mention: Mention): SlackSideThread {
		return {
			channel: mention.channel,
			ts: mention.replyTs,
			context: mention.thread.length ? slackThreadText(mention.thread) : null,
		};
	}
	/** The agent wrote it in the question's language: no fixed-phrase translation over it. */
	private async agentReply(mention: Mention, reply: string | null) {
		const said = reply ? slackAgentAnswer(reply) : null;
		if (said) await this.reply({ channel: mention.channel, replyTs: mention.replyTs }, said);
		else await this.reply(mention, slackReply.agentSilent);
	}
	private async note(mention: Mention, kind: 'thread' | 'summary') {
		if (!this.deps.notesOn()) {
			await this.ephemeral(mention, slackReply.notesOff);
			return;
		}
		const messages = mention.thread.length
				? mention.thread
				: [{ user: mention.user, ts: mention.ts, text: mention.text }],
			thread = slackThreadText(messages);
		let body = thread;
		if (kind === 'summary') {
			const summary = await this.deps.helper(slackSummaryPrompt(thread), 6000).catch(() => null);
			if (!summary?.trim()) {
				await this.reply(mention, slackReply.failed('the helper agent is off in Brigadir'));
				return;
			}
			body = summary;
		}
		const title = slackNoteTitle(mention.text, mention.thread[0]?.text ?? null),
			channel = (await this.deps.channelName(mention.channel).catch(() => null)) ?? mention.channel;
		await this.deps.createNote(
			mention.projectId,
			slackNoteText({
				title,
				channel,
				permalink: await this.permalink(mention.channel, mention.replyTs),
				body,
			})
		);
		await this.reply(mention, slackReply.noteSaved(title));
	}
	private async buttons(
		mention: Mention,
		text: string,
		buttons: { action: SlackButton['action']; label: string; task?: string }[],
		tasks?: TaskKey[],
		drafts?: WatchDraft[]
	): Promise<string> {
		this.prune();
		const id = randomUUID().replace(/-/g, '').slice(0, 16);
		const pending: Pending = {
			mention,
			at: this.now(),
			...(tasks ? { tasks } : {}),
			...(drafts ? { drafts } : {}),
		};
		this.pending.set(id, pending);
		await this.deps.api('chat.postMessage', {
			channel: mention.channel,
			thread_ts: mention.replyTs,
			unfurl_links: false,
			unfurl_media: false,
			...slackButtons(
				slackLocalize(text, mention.language),
				buttons.map((button) => ({
					action: button.action,
					label: slackLocalize(button.label, mention.language),
					value: button.task ? `${id}:${button.task}` : id,
				}))
			),
		});
		return id;
	}
	private prune() {
		const now = this.now();
		for (const [id, pending] of this.pending)
			if (now - pending.at > pendingMs) this.pending.delete(id);
	}
	private reply(
		mention: Pick<Mention, 'channel' | 'replyTs'> & { language?: SlackLanguage },
		text: string
	) {
		return this.deps.api('chat.postMessage', {
			channel: mention.channel,
			thread_ts: mention.replyTs,
			text: slackLocalize(text, mention.language ?? 'en'),
			unfurl_links: false,
			unfurl_media: false,
		});
	}
	private ephemeral(
		mention: Pick<Mention, 'channel' | 'replyTs' | 'user'> & { language?: SlackLanguage },
		text: string
	) {
		return this.deps.api('chat.postEphemeral', {
			channel: mention.channel,
			user: mention.user,
			thread_ts: mention.replyTs,
			text: slackLocalize(text, mention.language ?? 'en'),
		});
	}
}
/** The PRs a watch can mean: the numbers named (any task's), else the open PRs of the thread's task or the named one. */
function watchPicks(
	pool: readonly SlackTaskInfo[],
	numbers: readonly number[],
	task: SlackTaskInfo | null,
	text: string
): WatchPick[] {
	const picksOf = (item: SlackTaskInfo): WatchPick[] =>
		item.prs.flatMap((pr) =>
			pr.scopeId
				? [{ task: item, scopeId: pr.scopeId, number: pr.number, url: pr.url, state: pr.state }]
				: []
		);
	const list = numbers.length
		? [...(task ? picksOf(task) : []), ...pool.flatMap(picksOf)].filter((pick) =>
				numbers.includes(pick.number)
			)
		: (task
				? [task]
				: slackFindTasks(
						text,
						pool.filter((item) => !item.archived)
					)
			)
				.flatMap(picksOf)
				.filter((pick) => pick.state === 'OPEN');
	// One PR may stand on several tasks: its address names it once.
	const seen = new Set<string>();
	return list.filter((pick) => {
		const key = pick.url || `${pick.task.projectId}/${pick.scopeId}#${pick.number}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function reason(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
