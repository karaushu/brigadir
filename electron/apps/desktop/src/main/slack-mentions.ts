import { randomUUID } from 'node:crypto';
import {
	isRecord,
	parseSlackIntent,
	slackActionOf,
	slackActions,
	slackActiveText,
	slackAllowed,
	slackAsksActive,
	slackAsksQuestion,
	slackTitleKey,
	slackButtons,
	slackFindTasks,
	slackIntentFallback,
	slackIntentPrompt,
	slackMentionText,
	slackNoteText,
	slackNoteTitle,
	slackLanguage,
	slackLocalize,
	slackNamedProject,
	slackDispatchPrompt,
	parseSlackDispatch,
	type SlackProjectRef,
	slackActive,
	slackAnswerPrompt,
	slackAskAgentOf,
	slackAskProjectOf,
	slackAgentAnswer,
	slackFactsText,
	slackModelAnswer,
	type SlackTaskFacts,
	type SlackLanguage,
	slackProjectPrefix,
	slackReply,
	slackStatusText,
	slackSummaryPrompt,
	slackTaskTitle,
	slackThreadText,
	type SlackButton,
	type SlackIntent,
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
	/** spec/notifications-slack-notes-and-schedules#slack-dispatch: the other projects the work is in; their folders join the task. */
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
	/** spec/notifications-slack-notes-and-schedules#slack-project-questions: a question to look up in the project — a new agent in its main tree that runs only commands that read; its answer. */
	askCode?(
		projectId: string,
		question: string,
		language: SlackLanguage,
		thread: SlackSideThread
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
	/** spec/notifications-slack-notes-and-schedules#slack-which-project: the dispatch's title of a task that waits for its project. */
	title?: string | null;
	/** The message with the project buttons: its buttons go when the wait ends another way. */
	buttonsTs?: string;
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
	/** spec/notifications-slack-notes-and-schedules#slack-which-project: `<channel>/<thread>/<user>` → the pending task that waits for its project. */
	private awaiting = new Map<string, string>();
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
			if (await this.resume(mention, projects)) return;
			await this.route(await this.intent(mention), mention);
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
			if (kind === slackActions.status) await this.status(mention);
			else if (kind === slackActions.task) await this.task(mention);
			else if (kind === slackActions.summary) await this.note(mention, 'summary');
			else if (kind === slackActions.thread) await this.note(mention, 'thread');
			else if (kind === slackActions.show) {
				const key = pending.tasks?.find((item) => item.id === taskId);
				if (key) await this.statusOf(mention, key);
			} else if (kind === slackActions.watch) {
				const draft = pending.drafts?.[Number(taskId)];
				if (draft) await this.watch(mention, draft);
			} else if (kind === slackActions.project) {
				this.forget(pendingId);
				const projects = await this.deps.projects().catch(() => []);
				if (taskId && projects.some((project) => project.id === taskId))
					await this.create(pending.mention, [taskId], pending.title ?? null);
			}
		} catch (error) {
			await this.reply(mention, slackReply.failed(reason(error))).catch(() => {});
		}
	}
	/** spec/notifications-slack-notes-and-schedules#slack-which-project: a plain reply of this person in this thread finishes a task that waits for its project. */
	waits(channel: string, threadTs: string, user: string): boolean {
		this.prune();
		const id = this.awaiting.get(`${channel}/${threadTs}/${user}`);
		return !!id && this.pending.has(id);
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack-which-project: the next message of the person in the thread names the project of the
	 * waiting task — the original request is made with it. `false` — nothing waits here, or the message names no project (it
	 * is a new mention then).
	 */
	private async resume(mention: Mention, projects: SlackProjectRef[]): Promise<boolean> {
		if (!mention.inThread || !this.waits(mention.channel, mention.replyTs, mention.user))
			return false;
		const key = `${mention.channel}/${mention.replyTs}/${mention.user}`,
			id = this.awaiting.get(key)!,
			pending = this.pending.get(id)!;
		this.forget(id);
		let ids = mention.prefixed && mention.projectId ? [mention.projectId] : [];
		if (!ids.length) {
			const named = slackNamedProject(mention.text, projects);
			if (named) ids = [named];
		}
		if (!ids.length && mention.text)
			ids =
				parseSlackDispatch(
					await this.deps
						.helper(
							slackDispatchPrompt({
								text: mention.text,
								thread: null,
								projects,
								channelProject: null,
							}),
							400
						)
						.catch(() => null),
					projects
				)?.projects ?? [];
		if (!ids.length) return false;
		await this.create(pending.mention, ids, pending.title ?? null);
		return true;
	}
	/** The waiting task is answered: its buttons and its wait go. */
	private forget(id: string) {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		for (const [key, value] of this.awaiting) if (value === id) this.awaiting.delete(key);
		const ts = pending?.buttonsTs;
		if (pending && ts)
			void this.deps
				.api('chat.update', {
					channel: pending.mention.channel,
					ts,
					text: slackLocalize(slackReply.whichProjectShort, pending.mention.language),
					blocks: [],
				})
				.catch(() => {});
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
	private async intent(mention: Mention): Promise<SlackIntent> {
		const thread = mention.thread.length ? slackThreadText(mention.thread) : null;
		if (!mention.text) return { kind: 'unsure' };
		const answer = await this.deps
			.helper(slackIntentPrompt(mention.text, thread), 40)
			.catch(() => null);
		return parseSlackIntent(answer) ?? slackIntentFallback(mention.text);
	}
	private async route(intent: SlackIntent, mention: Mention) {
		// A follow-up question in a thread whose side session still waits goes to that session.
		const side = mention.inThread
				? (this.deps.sideSession?.(mention.channel, mention.replyTs) ?? null)
				: null,
			question =
				intent.kind === 'code' ||
				intent.kind === 'status' ||
				(intent.kind === 'unsure' && slackAsksQuestion(mention.text));
		if (side && question && side.mode === 'aboutCode' && this.deps.askCode) {
			await this.code(mention, side.projectId);
			return;
		}
		if (side && question && side.mode === 'aboutTask') {
			const task = (await this.deps.tasks(side.task.projectId).catch(() => [])).find(
				(item) => item.id === side.task.id
			);
			if (task) {
				await this.askTaskAgent(mention, task);
				return;
			}
		}
		if (intent.kind === 'code' && this.deps.askCode) await this.code(mention);
		else if (intent.kind === 'task') await this.task(mention);
		else if (intent.kind === 'watch' && this.deps.watch)
			await this.watch(mention, { kinds: intent.watch });
		else if (intent.kind === 'unwatch' && this.deps.unwatch) await this.unwatch(mention);
		// A question is answered from the facts (or by the task's agent), not with «not sure» buttons.
		else if (
			intent.kind === 'status' ||
			intent.kind === 'code' ||
			(intent.kind === 'unsure' && slackAsksQuestion(mention.text))
		)
			await this.status(mention);
		else if (intent.kind === 'note' && intent.note !== 'unclear')
			await this.note(mention, intent.note);
		else if (intent.kind === 'note') {
			if (!this.deps.notesOn()) await this.ephemeral(mention, slackReply.notesOff);
			else
				await this.buttons(mention, slackReply.noteKind, [
					{ action: slackActions.summary, label: 'Save a summary' },
					{ action: slackActions.thread, label: 'Save the thread' },
				]);
		} else
			await this.buttons(mention, slackReply.unsure, [
				{ action: slackActions.status, label: 'Show state' },
				{ action: slackActions.task, label: 'Create task' },
			]);
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
	private async projectNames() {
		return (await this.deps.projects().catch(() => [])).map((project) => project.name);
	}
	private async task(mention: Mention) {
		if (mention.unknownProject) {
			await this.reply(
				mention,
				slackReply.unknownProject(mention.unknownProject, await this.projectNames())
			);
			return;
		}
		if (!mention.text) {
			await this.reply(mention, slackReply.noText);
			return;
		}
		const dispatch = await this.dispatch(mention),
			ids = mention.prefixed
				? [mention.projectId!]
				: dispatch?.projects.length
					? dispatch.projects
					: mention.projectId
						? [mention.projectId]
						: [];
		if (!ids.length) {
			await this.askProject(mention, dispatch?.title ?? null);
			return;
		}
		await this.create(mention, ids, dispatch?.title ?? null);
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack-dispatch: the helper model reads the mention, the thread and the projects and says which
	 * projects the work is in and what the task is called; `null` — no helper agent or no valid answer.
	 */
	private async dispatch(mention: Mention) {
		const projects = await this.deps.projects().catch(() => []);
		if (!projects.length) return null;
		const answer = await this.deps
			.helper(
				slackDispatchPrompt({
					text: mention.text,
					thread: mention.thread.length ? slackThreadText(mention.thread) : null,
					projects,
					channelProject: mention.channelProject,
				}),
				400
			)
			.catch(() => null);
		return parseSlackDispatch(answer, projects);
	}
	/** spec/notifications-slack-notes-and-schedules#slack-which-project: one button per project; the request waits for a click or the next message. */
	private async askProject(mention: Mention, title: string | null) {
		const projects = await this.deps.projects().catch(() => []);
		if (!projects.length) {
			await this.reply(mention, slackReply.whichProject([]));
			return;
		}
		const shown = projects.slice(0, 10),
			id = await this.buttons(
				mention,
				projects.length > shown.length
					? slackReply.whichProject(projects.map((project) => project.name))
					: slackReply.whichProjectShort,
				shown.map((project) => ({
					action: slackActions.project,
					label: project.name,
					task: project.id,
				})),
				undefined,
				undefined,
				{ title }
			);
		this.awaiting.set(`${mention.channel}/${mention.replyTs}/${mention.user}`, id);
	}
	/** The task in the first project; the other projects' folders join it (spec/notifications-slack-notes-and-schedules#slack-dispatch). */
	private async create(mention: Mention, ids: string[], title: string | null) {
		const start = this.deps.settings().mentions.start === 'start',
			projects = await this.deps.projects().catch(() => []),
			name = (id: string) => projects.find((item) => item.id === id)?.name ?? id,
			[projectId, ...alsoProjects] = ids as [string, ...string[]];
		const created = await this.deps.createTask({
			projectId,
			title: title || slackTaskTitle(mention.text),
			prompt: mention.text,
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
	private async status(mention: Mention) {
		if (!mention.unknownProject && (await this.smartStatus(mention).catch(() => false))) return;
		const own = mention.inThread ? this.deps.taskOfThread(mention.channel, mention.replyTs) : null;
		if (own) {
			await this.statusOf(mention, own);
			return;
		}
		if (mention.unknownProject) {
			await this.ephemeral(
				mention,
				slackReply.unknownProject(mention.unknownProject, await this.projectNames())
			);
			return;
		}
		if (!mention.projectId) {
			await this.ephemeral(mention, slackReply.whichProject(await this.projectNames()));
			return;
		}
		const tasks = await this.deps.tasks(mention.projectId),
			project = await this.projectName(mention.projectId);
		if (slackAsksActive(mention.text)) {
			await this.reply(mention, slackActiveText(project, tasks));
			return;
		}
		const found = slackFindTasks(mention.text, tasks);
		if (found.length === 1) await this.answer(mention, found[0]!, project);
		else if (found.length > 1) {
			const shown = found.slice(0, 3);
			await this.buttons(
				mention,
				slackReply.severalTasks,
				shown.map((task) => ({ action: slackActions.show, label: task.title, task: task.id })),
				shown.map((task) => ({ projectId: task.projectId, id: task.id }))
			);
		} else
			// Nothing named: what is in progress is the nearest answer, and the task can still be made.
			await this.buttons(mention, `${slackReply.noTask}\n\n${slackActiveText(project, tasks)}`, [
				{ action: slackActions.task, label: 'Create task' },
			]);
	}
	/**
	 * The helper model answers the question itself from Brigadir's facts — the thread's
	 * task, else the project's tasks, else every project's — in the question's language. `false` — no helper or no answer;
	 * the fixed answers below stay for that.
	 */
	private async smartStatus(mention: Mention): Promise<boolean> {
		const own = mention.inThread ? this.deps.taskOfThread(mention.channel, mention.replyTs) : null,
			projects = await this.deps.projects().catch(() => []),
			ids = own
				? [own.projectId]
				: mention.projectId
					? [mention.projectId]
					: projects.map((p) => p.id);
		const all: { task: SlackTaskInfo; project: string }[] = [];
		for (const id of ids) {
			const project = projects.find((item) => item.id === id)?.name ?? id;
			for (const task of await this.deps.tasks(id).catch(() => []))
				if (own ? task.id === own.id : !task.archived) all.push({ task, project });
		}
		all.sort((a, b) => (b.task.updatedAt ?? '').localeCompare(a.task.updatedAt ?? ''));
		const shown = all.slice(0, 40);
		const facts: SlackTaskFacts[] = [];
		for (const [index, item] of shown.entries())
			facts.push({
				...item,
				...(index < 15 && slackActive(item.task)
					? await this.deps.status(item.task).catch(() => ({ plan: null, ci: null }))
					: { plan: null, ci: null }),
			});
		const thread = mention.thread.length ? slackThreadText(mention.thread) : null,
			answer = await this.deps
				.helper(slackAnswerPrompt(mention.text, slackFactsText(facts, this.now()), thread), 3000)
				.catch(() => null),
			text = answer ? slackModelAnswer(answer) : null;
		if (!text) return false;
		const lookup = this.deps.askCode ? slackAskProjectOf(text) : null;
		if (lookup !== null) {
			// spec/notifications-slack-notes-and-schedules#slack-project-questions: the project can tell what the facts cannot.
			const key = lookup.toLowerCase(),
				named = key
					? projects.find((item) =>
							[item.id, item.name, item.folder ?? ''].some((name) => name.toLowerCase() === key)
						)
					: undefined;
			await this.code(mention, named?.id ?? (ids.length === 1 ? ids[0] : undefined));
			return true;
		}
		const asked = slackAskAgentOf(text);
		if (asked !== null) {
			const key = slackTitleKey(asked),
				task =
					(own && all.find((item) => item.task.id === own.id)?.task) ??
					all.find((item) => item.task.title === asked)?.task ??
					all.find((item) => slackTitleKey(item.task.title) === key)?.task;
			if (!task) return false;
			await this.askTaskAgent(mention, task);
			return true;
		}
		// The model wrote it in the question's language: no fixed-phrase translation over it.
		await this.reply({ channel: mention.channel, replyTs: mention.replyTs }, text);
		return true;
	}
	/** «⏳ Asking the agent of …», then its answer with fenced code cut, or a short «did not answer». */
	private async askTaskAgent(mention: Mention, task: SlackTaskInfo) {
		await this.reply(mention, slackReply.askingAgent(task.title));
		const reply = await this.deps
			.askAgent(
				{ projectId: task.projectId, id: task.id },
				mention.text,
				mention.language,
				this.sideThread(mention)
			)
			.catch(() => null);
		await this.agentReply(mention, reply);
	}
	/**
	 * spec/notifications-slack-notes-and-schedules#slack: a question about the project's code — the
	 * project of the thread's session, of the `in <project>:` prefix or the channel, of a name in the text, of the thread's
	 * task; none — which project.
	 */
	private async code(mention: Mention, sessionProject?: string) {
		const own = mention.inThread ? this.deps.taskOfThread(mention.channel, mention.replyTs) : null,
			projectId = sessionProject ?? mention.projectId ?? own?.projectId ?? null;
		if (!projectId && mention.unknownProject) {
			await this.reply(
				mention,
				slackReply.unknownProject(mention.unknownProject, await this.projectNames())
			);
			return;
		}
		if (!projectId) {
			await this.reply(mention, slackReply.whichProject(await this.projectNames()));
			return;
		}
		if (!mention.text) {
			await this.reply(mention, slackReply.noText);
			return;
		}
		await this.reply(mention, slackReply.askingCode(await this.projectName(projectId)));
		const reply = await this.deps.askCode!(
			projectId,
			mention.text,
			mention.language,
			this.sideThread(mention)
		).catch(() => null);
		await this.agentReply(mention, reply);
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
	private async projectName(projectId: string) {
		return (
			(await this.deps.projects().catch(() => [])).find((item) => item.id === projectId)?.name ??
			projectId
		);
	}
	private async statusOf(mention: Mention, key: TaskKey) {
		const task = (await this.deps.tasks(key.projectId)).find((item) => item.id === key.id);
		if (!task) {
			await this.reply(mention, slackReply.noTask);
			return;
		}
		await this.answer(mention, task, await this.projectName(key.projectId));
	}
	private async answer(mention: Mention, task: SlackTaskInfo, project: string) {
		const { plan, ci } = await this.deps.status(task);
		await this.reply(mention, slackStatusText({ task, project, plan, ci, now: this.now() }));
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
		drafts?: WatchDraft[],
		extra?: Pick<Pending, 'title'>
	): Promise<string> {
		this.prune();
		const id = randomUUID().replace(/-/g, '').slice(0, 16);
		const pending: Pending = {
			mention,
			at: this.now(),
			...(tasks ? { tasks } : {}),
			...(drafts ? { drafts } : {}),
			...extra,
		};
		this.pending.set(id, pending);
		const sent = await this.deps.api('chat.postMessage', {
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
		if (typeof sent?.ts === 'string') pending.buttonsTs = sent.ts;
		return id;
	}
	private prune() {
		const now = this.now();
		for (const [id, pending] of this.pending)
			if (now - pending.at > pendingMs) this.pending.delete(id);
		for (const [key, id] of this.awaiting) if (!this.pending.has(id)) this.awaiting.delete(key);
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
