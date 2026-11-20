import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, readDocument, safePath } from '@brigadir/persistence';
import { AgentTransport, type AdapterCommand, type McpCommand } from '@brigadir/transport';
import {
	brigadirCards,
	brigadirChatFollowUp,
	brigadirChatPrompt,
	brigadirChatTitle,
	setupInProgress,
	changeSetting,
	findSettings,
	isBrigadirChatMeta,
	isBrigadirChatRow,
	isBrigadirSetupLink,
	isRecord,
	mcpCall,
	missingSlackScopes,
	quickSlackAllows,
	selectOption,
	settingsRegistryText,
	slackManifestLink,
	type AgentEvent,
	type AgentOption,
	type AppSettings,
	type BrigadirCard,
	type BrigadirChatChoice,
	type BrigadirChatEntry,
	type BrigadirChatEvent,
	type BrigadirChatMeta,
	type BrigadirChatRow,
	type BrigadirChatState,
	type BrigadirSecretKind,
	type BrigadirSetupKind,
	type BrigadirSetupState,
	type BrigadirStep,
	type Locale,
	type PermissionRequest,
	type TaskKey,
} from '@brigadir/core';

/** spec/settings-modules-and-onboarding#brigadir-chat: what the chat needs from the rest of main; injected so a test runs without Electron. */
export type BrigadirChatDeps = {
	/** `~/.brigadir/assistant` */
	root: string;
	mcp: {
		register(
			chat: string,
			call: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
		): Promise<McpCommand>;
		unregister(chat: string): void;
	};
	send(event: BrigadirChatEvent): void;
	locale(): Locale;
	settings(): AppSettings;
	saveSettings(next: AppSettings): Promise<void>;
	/** Opens Settings at the row of a registry key; false — Settings has no such row. */
	openSettings(key: string): boolean;
	/** Settings ▸ Modules ▸ Remote access, where access is turned on with a password. */
	openRemoteSettings(): void;
	projects(): Promise<{ id: string; name: string; path: string }[]>;
	/** The project the window shows, the chat's working directory. */
	openProject(): string | null;
	/** Brigadir's tasks as the Slack agent gets them, and the tasks to find by id or title. */
	facts(): Promise<{ text: string; tasks: { projectId: string; id: string; title: string }[] }>;
	choice(): BrigadirChatChoice;
	today(): string;
	createTask(input: {
		projectId: string;
		alsoProjects: string[];
		title: string;
		prompt: string;
		baseRef: string | null;
	}): Promise<TaskKey>;
	sendToTask(task: TaskKey, text: string): Promise<string>;
	askTask(task: TaskKey, question: string, chat: string): Promise<string | null>;
	openTask(task: TaskKey): void;
	/** Saves a note in Notes; its id. */
	createNote(project: string | null, text: string): Promise<string>;
	openExternal(url: string): void;
	slack: {
		/** Seals a bot token after `auth.test`; the bot, team, granted scopes and app id when Slack gives them. */
		connectBot(
			token: string
		): Promise<{ bot: string; team: string; scopes: string | null; appId: string | null }>;
		connectApp(token: string): Promise<void>;
		state(): { bot: boolean; app: boolean; memberId: boolean; listening: boolean };
	};
	/** A short title for a chat from its first message; null — keep the first line. */
	title?(text: string): Promise<string | null>;
	adapter?: AdapterCommand | undefined;
	idleMs?: number;
};
type Live = {
	id: string;
	transport: AgentTransport | null;
	choice: BrigadirChatChoice | null;
	busy: boolean;
	answering: boolean;
	stopped: boolean;
	options: AgentOption[];
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
};
type Waiting = { chat: string; resolve(value: { action: string; value?: string }): void };
type WatchKind = 'ci' | 'merged' | 'done';
type Watch = { chat: string; task: TaskKey; kinds: WatchKind[] };
/** A task's event as the chat tells it. */
export type BrigadirNotice = {
	kind: 'ci' | 'prMerged' | 'taskDone' | 'taskCompleted';
	task: TaskKey;
	text: string;
	tone: 'green' | 'red' | 'amber' | 'accent';
	link: string | null;
};
type Setups = Partial<
	Record<BrigadirSetupKind, { chat: string | null; name?: string; appId?: string | null }>
>;
const writeKinds = new Set(['allow_once', 'allow_always']);
const sameChoice = (a: BrigadirChatChoice | null, b: BrigadirChatChoice) =>
	!!a && a.provider === b.provider && a.model === b.model;

/**
 * spec/settings-modules-and-onboarding#brigadir-chat: the Brigadir chats — each its own agent session in the open project's folder with every
 * project added, reading only; Brigadir's tools come from `BrigadirChatMcp`. A card that waits for the person (Apply, a secret, a task) holds
 * its tool call until the person answers in the window.
 */
export class BrigadirChats {
	private live = new Map<string, Live>();
	private writes = new Map<string, Promise<unknown>>();
	private waiting = new Map<string, Waiting>();
	constructor(private deps: BrigadirChatDeps) {}
	private dir(id: string) {
		return safePath(this.deps.root, 'chats', id);
	}
	// ---------- list and storage ----------
	async list(): Promise<{
		chats: BrigadirChatMeta[];
		archived: BrigadirChatMeta[];
		setups: BrigadirSetupState[];
	}> {
		const names = await readdir(join(this.deps.root, 'chats')).catch(() => [] as string[]);
		const all: BrigadirChatMeta[] = [];
		for (const name of names) {
			const meta = await this.meta(name).catch(() => null);
			if (meta) all.push(meta);
		}
		all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return {
			chats: all.filter((chat) => !chat.archived),
			archived: all.filter((chat) => chat.archived),
			setups: await this.setupStates(),
		};
	}
	/** Whether a chat is in the archive, for its row menu. */
	async archivedChat(id: string) {
		return (await this.meta(id))?.archived ?? false;
	}
	private async meta(id: string): Promise<BrigadirChatMeta | null> {
		const doc = await readDocument(await safePath(this.deps.root, 'chats', id, 'chat.json'));
		return isRecord(doc) && isBrigadirChatMeta(doc.chat) ? doc.chat : null;
	}
	private async writeMeta(meta: BrigadirChatMeta) {
		await mkdir(await this.dir(meta.id), { recursive: true, mode: 0o700 });
		await atomicJson(await safePath(this.deps.root, 'chats', meta.id, 'chat.json'), {
			schemaVersion: 1,
			chat: meta,
		});
	}
	private async broadcastList() {
		this.deps.send({ kind: 'list', ...(await this.list()) });
	}
	private async rows(id: string): Promise<BrigadirChatRow[]> {
		const text = await readFile(
			await safePath(this.deps.root, 'chats', id, 'events.jsonl'),
			'utf8'
		).catch(() => '');
		return text
			.split('\n')
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const value: unknown = JSON.parse(line);
					return isBrigadirChatRow(value) ? [value] : [];
				} catch {
					return [];
				}
			});
	}
	async read(id: string): Promise<BrigadirChatState> {
		const meta = await this.meta(id);
		if (!meta) throw new Error('This chat is gone.');
		const live = this.live.get(id);
		return {
			meta,
			rows: await this.rows(id),
			busy: live?.busy ?? false,
			choice: live?.choice ?? null,
		};
	}
	async create(): Promise<BrigadirChatMeta> {
		const now = new Date().toISOString();
		const meta: BrigadirChatMeta = {
			id: randomUUID(),
			title: '',
			createdAt: now,
			updatedAt: now,
			archived: false,
		};
		await this.writeMeta(meta);
		await this.broadcastList();
		return meta;
	}
	async rename(id: string, title: string) {
		const meta = await this.meta(id);
		if (!meta) return;
		await this.writeMeta({ ...meta, title: brigadirChatTitle(title) });
		await this.broadcastList();
	}
	async archive(id: string) {
		const meta = await this.meta(id);
		if (!meta) return;
		this.close(id);
		await this.writeMeta({ ...meta, archived: true });
		await this.broadcastList();
	}
	/** `Restore` of an archived chat: back in the list. */
	async unarchive(id: string) {
		const meta = await this.meta(id);
		if (!meta) return;
		await this.writeMeta({ ...meta, archived: false });
		await this.broadcastList();
	}
	async remove(id: string) {
		this.close(id);
		await rm(await this.dir(id), { recursive: true, force: true });
		await this.broadcastList();
	}
	private append(id: string, row: BrigadirChatEntry) {
		const work = (this.writes.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const rows = await this.rows(id);
				const full = {
					...row,
					seq: (rows.at(-1)?.seq ?? 0) + 1,
					at: new Date().toISOString(),
				} as BrigadirChatRow;
				await mkdir(await this.dir(id), { recursive: true, mode: 0o700 });
				await appendFile(
					await safePath(this.deps.root, 'chats', id, 'events.jsonl'),
					`${JSON.stringify(full)}\n`,
					{ mode: 0o600 }
				);
				this.deps.send({ kind: 'row', id, row: full });
				return full;
			});
		this.writes.set(id, work);
		return work;
	}
	private card(chat: string, card: BrigadirCard) {
		return this.append(chat, { kind: 'card', card });
	}
	// ---------- a turn ----------
	async send(id: string, text: string) {
		const live = this.live.get(id);
		if (live?.busy) throw new Error('Brigadir is still answering');
		let meta = await this.meta(id);
		if (!meta) throw new Error('This chat is gone.');
		const message = text.trim();
		if (!message) return;
		if (!meta.title) {
			meta = { ...meta, title: brigadirChatTitle(message) };
			void this.deps
				.title?.(message)
				.then(async (title) => {
					if (title) await this.rename(id, title);
				})
				.catch(() => {});
		}
		await this.writeMeta({ ...meta, updatedAt: new Date().toISOString() });
		void this.broadcastList();
		await this.turn(id, message);
	}
	private async turn(id: string, text: string) {
		let chat = this.live.get(id);
		if (!chat) {
			chat = {
				id,
				transport: null,
				choice: null,
				busy: false,
				answering: false,
				stopped: false,
				options: [],
				controller: new AbortController(),
			};
			this.live.set(id, chat);
		}
		clearTimeout(chat.timer);
		chat.busy = true;
		this.deps.send({ kind: 'busy', id, busy: true });
		const begun = Date.now();
		const choice = this.deps.choice();
		try {
			const rows = await this.rows(id);
			await this.append(id, { kind: 'prompt', text, choice });
			const fresh = !chat.transport || !sameChoice(chat.choice, choice);
			const projects = await this.deps.projects();
			if (fresh) await this.start(chat, choice, rows, projects);
			const facts = await this.deps.facts().catch(() => ({ text: '', tasks: [] }));
			chat.stopped = false;
			chat.answering = true;
			try {
				await chat.transport!.send({
					kind: 'prompt',
					text: fresh
						? brigadirChatPrompt({
								text,
								language: /[а-яіїєґ]/i.test(text) ? 'uk' : this.deps.locale(),
								today: this.deps.today(),
								project: projects.find((item) => item.id === this.deps.openProject())?.name ?? null,
								projects: projects.map(({ name, path }) => ({ name, path })),
								facts: facts.text,
								settings: settingsRegistryText(this.deps.settings()),
								setups: await this.unfinishedSetups(),
							})
						: brigadirChatFollowUp({ text, facts: facts.text }),
				});
			} finally {
				chat.answering = false;
			}
			await this.append(id, {
				kind: 'done',
				milliseconds: Date.now() - begun,
				stopped: chat.stopped,
			});
		} catch (error) {
			await this.append(id, {
				kind: 'failed',
				message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
			});
		} finally {
			chat.busy = false;
			this.deps.send({ kind: 'busy', id, busy: false });
			chat.timer = setTimeout(() => this.close(id), this.deps.idleMs ?? 600_000);
		}
	}
	private async start(
		chat: Live,
		choice: BrigadirChatChoice,
		rows: BrigadirChatRow[],
		projects: { id: string; name: string; path: string }[]
	) {
		chat.transport?.close();
		chat.transport = null;
		chat.controller = new AbortController();
		const open = projects.find((item) => item.id === this.deps.openProject()) ?? projects[0];
		const cwd = open?.path ?? this.deps.root;
		await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
		// After a restart the same provider and model go on with the journal's session.
		const last = rows.findLast((row) => row.kind === 'prompt'),
			started = rows.findLast(
				(row) => row.kind === 'event' && row.event.kind === 'session.started'
			);
		const resume =
			chat.choice === null &&
			last?.kind === 'prompt' &&
			last.choice &&
			sameChoice(last.choice, choice) &&
			started?.kind === 'event' &&
			started.event.kind === 'session.started'
				? started.event.sessionId
				: undefined;
		const mcp = await this.deps.mcp.register(chat.id, (method, params, signal) =>
			this.tool(chat.id, method, params, signal)
		);
		const transport = await AgentTransport.start({
			provider: choice.provider,
			cwd,
			signal: chat.controller.signal,
			mcpServers: [mcp],
			...(projects.some((item) => item.path !== cwd)
				? {
						additionalDirectories: projects.map((item) => item.path).filter((path) => path !== cwd),
					}
				: {}),
			...(this.deps.adapter ? { adapter: this.deps.adapter } : {}),
			...(resume ? { resumeSessionId: resume } : {}),
			requestPermission: async (request) => this.permission(request),
			preapprove: (request) => {
				const call = mcpCall(request.tool);
				return call?.server === 'brigadir'
					? (request.options.find((option) => option.kind === 'allow_once')?.id ?? null)
					: null;
			},
			onEvent: (event) => this.event(chat, event),
		});
		chat.transport = transport;
		chat.choice = choice;
		if (choice.model) {
			const option = selectOption(chat.options, 'model');
			if (option?.choices.some((item) => item.value === choice.model))
				await transport.send({ kind: 'setOption', id: option.id, value: choice.model });
		}
	}
	private event(chat: Live, event: AgentEvent) {
		if (event.kind === 'session.started' || event.kind === 'options.changed')
			chat.options = event.options;
		// A resumed session may replay its history on load; only the answer to our message is the chat's.
		if (event.kind === 'session.started' || chat.answering)
			void this.append(chat.id, { kind: 'event', event });
	}
	/** spec/settings-modules-and-onboarding#brigadir-chat-session: reads and commands that read; every edit and every other command is declined. */
	private permission(request: PermissionRequest): string | null {
		const call = mcpCall(request.tool);
		if (call?.server === 'brigadir' || quickSlackAllows(request.tool))
			return request.options.find((option) => option.kind === 'allow_once')?.id ?? null;
		return request.options.find((option) => !writeKinds.has(option.kind))?.id ?? null;
	}
	async stop(id: string) {
		const chat = this.live.get(id);
		if (!chat?.busy) return;
		chat.stopped = true;
		for (const [card, wait] of this.waiting) if (wait.chat === id) this.answer(id, card, 'cancel');
		await chat.transport?.send({ kind: 'cancel' }).catch(() => {});
	}
	close(id: string) {
		const chat = this.live.get(id);
		if (!chat) return;
		this.live.delete(id);
		clearTimeout(chat.timer);
		chat.controller.abort();
		chat.transport?.close();
		this.deps.mcp.unregister(id);
		for (const [card, wait] of this.waiting) if (wait.chat === id) this.answer(id, card, 'cancel');
	}
	closeAll() {
		for (const id of [...this.live.keys()]) this.close(id);
	}
	// ---------- cards the person answers ----------
	/** The window's answer to a waiting card: `apply` / `cancel` (a setting), `secret` with its value, `start` / `decline` (a task). */
	answer(chat: string, card: string, action: string, value?: string) {
		const wait = this.waiting.get(card);
		if (!wait || wait.chat !== chat) return false;
		this.waiting.delete(card);
		wait.resolve({ action, ...(value !== undefined ? { value } : {}) });
		return true;
	}
	private wait(chat: string, card: string, signal: AbortSignal) {
		return new Promise<{ action: string; value?: string }>((resolve) => {
			this.waiting.set(card, { chat, resolve });
			signal.addEventListener('abort', () => this.answer(chat, card, 'cancel'), { once: true });
		});
	}
	/** `Undo` on a setting card: the old value goes back while the setting still has the new one. */
	async undo(chat: string, card: string) {
		const found = brigadirCards(await this.rows(chat)).find((item) => item.id === card);
		if (found?.type !== 'setting' || found.state !== 'done') throw new Error('Nothing to undo');
		const settings = this.deps.settings();
		const now = changeSetting(settings, found.key, found.after);
		if (JSON.stringify(now.before) !== JSON.stringify(found.after))
			throw new Error('The setting changed since. Undo is off.');
		await this.deps.saveSettings(changeSetting(settings, found.key, found.before).settings);
		await this.card(chat, { ...found, state: 'undone' });
	}
	/** A link card's button: opens only links a setup built. */
	async openLink(chat: string, card: string) {
		const found = brigadirCards(await this.rows(chat)).find((item) => item.id === card);
		if (found?.type !== 'link' || !isBrigadirSetupLink(found.url)) return;
		this.deps.openExternal(found.url);
		if (!found.opened) await this.card(chat, { ...found, opened: true });
	}
	// ---------- tools ----------
	private async tool(
		chat: string,
		method: string,
		params: unknown,
		signal: AbortSignal
	): Promise<unknown> {
		const args = isRecord(params) ? params : {};
		const str = (name: string) => (typeof args[name] === 'string' ? (args[name] as string) : '');
		switch (method) {
			case 'settings_find':
				return findSettings(str('query'), this.deps.settings(), this.deps.locale());
			case 'settings_set':
				return this.setSetting(chat, str('key'), args.value, signal);
			case 'settings_open':
				if (!this.deps.openSettings(str('key'))) throw new Error(`No setting ${str('key')}.`);
				return 'opened';
			case 'setup_start':
				return this.setup(chat, str('kind') as BrigadirSetupKind, str('name') || null);
			case 'secret_request':
				return this.secret(chat, str('kind') as BrigadirSecretKind, signal);
			case 'open_link': {
				const url = str('url');
				if (!isBrigadirSetupLink(url))
					throw new Error('Only links a setup built open from the chat.');
				await this.card(chat, {
					type: 'link',
					id: randomUUID(),
					url,
					label: str('label') || 'Open',
					title: str('label') || 'Open',
					detail: url.replace(/^https:\/\//, '').split('?')[0]!,
					opened: false,
				});
				return 'shown; it opens when the person clicks it';
			}
			case 'create_task':
				return this.proposeTask(chat, args, signal);
			case 'send_to_task':
				return this.deps.sendToTask(await this.taskOf(str('task')), str('text'));
			case 'ask_task':
				return (
					(await this.deps.askTask(await this.taskOf(str('task')), str('question'), chat)) ??
					'The task agent did not answer.'
				);
			case 'open_task':
				this.deps.openTask(await this.taskOf(str('task')));
				return 'opened';
			case 'note':
				return this.note(chat, str('text'), str('title') || null, str('project') || null);
			case 'watch':
				return this.watch(
					chat,
					await this.taskOf(str('task')),
					Array.isArray(args.kinds)
						? args.kinds.filter(
								(kind): kind is WatchKind => kind === 'ci' || kind === 'merged' || kind === 'done'
							)
						: []
				);
			case 'unwatch':
				return this.unwatch(chat, str('task') ? await this.taskOf(str('task')) : null);
			default:
				throw new Error(`Unknown tool ${method}`);
		}
	}
	// ---------- notes and watches ----------
	private async note(chat: string, text: string, title: string | null, project: string | null) {
		let projectId: string | null = null;
		if (project) {
			const found = (await this.deps.projects()).find(
				(item) => item.id === project || item.name.toLowerCase() === project.trim().toLowerCase()
			);
			if (!found) throw new Error(`No project ${project}.`);
			projectId = found.id;
		}
		const body = title && !text.trimStart().startsWith('#') ? `# ${title}\n\n${text}` : text;
		const note = await this.deps.createNote(projectId, body);
		await this.card(chat, {
			type: 'note',
			id: randomUUID(),
			note,
			title: title ?? brigadirChatTitle(text),
			project,
		});
		return { note, saved: true };
	}
	private async readWatches(): Promise<Watch[]> {
		const doc = await readDocument(await safePath(this.deps.root, 'watches.json')).catch(
			() => null
		);
		return isRecord(doc) && Array.isArray(doc.watches) ? (doc.watches as Watch[]) : [];
	}
	private async writeWatches(watches: Watch[]) {
		await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
		await atomicJson(await safePath(this.deps.root, 'watches.json'), { schemaVersion: 1, watches });
	}
	private async watch(chat: string, task: TaskKey, kinds: WatchKind[]) {
		if (!kinds.length) throw new Error('kinds takes ci, merged or done.');
		const watches = (await this.readWatches()).filter(
			(item) =>
				!(item.chat === chat && item.task.projectId === task.projectId && item.task.id === task.id)
		);
		const before = (await this.readWatches()).find(
			(item) =>
				item.chat === chat && item.task.projectId === task.projectId && item.task.id === task.id
		);
		await this.writeWatches([
			...watches,
			{ chat, task, kinds: [...new Set([...(before?.kinds ?? []), ...kinds])] },
		]);
		return `Watching: this chat hears when ${kinds.join(', ')} happens to the task; each kind once.`;
	}
	private async unwatch(chat: string, task: TaskKey | null) {
		const watches = await this.readWatches(),
			kept = watches.filter(
				(item) =>
					item.chat !== chat ||
					(task !== null && (item.task.projectId !== task.projectId || item.task.id !== task.id))
			);
		await this.writeWatches(kept);
		return watches.length === kept.length ? 'Nothing was watched.' : 'Stopped watching.';
	}
	/** spec/settings-modules-and-onboarding#brigadir-chat-tools: an event of a task — CI, a merge, a turn's end, completion — reaches the chats that watch it. */
	async notice(event: BrigadirNotice) {
		const kind: WatchKind =
			event.kind === 'ci' ? 'ci' : event.kind === 'prMerged' ? 'merged' : 'done';
		const watches = await this.readWatches();
		let changed = false;
		for (const watch of watches) {
			if (
				watch.task.projectId !== event.task.projectId ||
				watch.task.id !== event.task.id ||
				!watch.kinds.includes(kind)
			)
				continue;
			watch.kinds = watch.kinds.filter((item) => item !== kind);
			changed = true;
			if (!(await this.meta(watch.chat).catch(() => null))) continue;
			await this.card(watch.chat, {
				type: 'event',
				id: randomUUID(),
				text: event.text,
				tone: event.tone,
				link: event.link,
				task: event.task,
			});
			const meta = await this.meta(watch.chat);
			if (meta) await this.writeMeta({ ...meta, updatedAt: new Date().toISOString() });
		}
		if (changed) {
			await this.writeWatches(watches.filter((watch) => watch.kinds.length));
			await this.broadcastList();
		}
	}
	private async taskOf(ref: string): Promise<TaskKey> {
		const { tasks } = await this.deps.facts();
		const needle = ref.trim().toLowerCase();
		const task =
			tasks.find((item) => item.id === ref.trim()) ??
			tasks.find((item) => item.title.toLowerCase() === needle);
		if (!task) throw new Error(`No task ${ref}. Name it by its id from the task list.`);
		return { projectId: task.projectId, id: task.id };
	}
	private async setSetting(chat: string, key: string, value: unknown, signal: AbortSignal) {
		const change = changeSetting(this.deps.settings(), key, value);
		if (JSON.stringify(change.before) === JSON.stringify(change.after))
			return `${key} is already ${JSON.stringify(change.after)}.`;
		const card: Extract<BrigadirCard, { type: 'setting' }> = {
			type: 'setting',
			id: randomUUID(),
			key,
			place: change.place,
			before: change.before,
			after: change.after,
			state: change.confirm ? 'pending' : 'done',
			...(change.confirm ? { fact: settingFact(key) } : {}),
		};
		if (change.confirm) {
			await this.card(chat, card);
			const { action } = await this.wait(chat, card.id, signal);
			if (action !== 'apply') {
				await this.card(chat, { ...card, state: 'cancelled' });
				return 'The person cancelled the change.';
			}
		}
		// The settings as they are now: the person may have changed others while the card waited.
		await this.deps.saveSettings(changeSetting(this.deps.settings(), key, value).settings);
		await this.card(chat, { ...card, state: 'done' });
		return { key, before: change.before, after: change.after };
	}
	private async proposeTask(chat: string, args: Record<string, unknown>, signal: AbortSignal) {
		const projects = await this.deps.projects();
		const names = Array.isArray(args.projects)
			? args.projects.filter((item): item is string => typeof item === 'string')
			: [];
		const find = (name: string) =>
			projects.find(
				(item) => item.id === name || item.name.toLowerCase() === name.trim().toLowerCase()
			);
		const missing = names.find((name) => !find(name));
		if (missing !== undefined || !names.length)
			throw new Error(
				`No project ${missing ?? ''}. Projects: ${projects.map((item) => item.name).join(', ')}`
			);
		const ids = [...new Set(names.map((name) => find(name)!.id))];
		const card: Extract<BrigadirCard, { type: 'task' }> = {
			type: 'task',
			id: randomUUID(),
			project: ids.map((id) => projects.find((item) => item.id === id)!.name).join(' + '),
			title: String(args.title ?? '').slice(0, 80),
			prompt: String(args.prompt ?? ''),
			base: typeof args.base === 'string' ? args.base : null,
			state: 'proposed',
		};
		await this.card(chat, card);
		const { action } = await this.wait(chat, card.id, signal);
		if (action !== 'start') {
			await this.card(chat, { ...card, state: 'declined' });
			return 'declined';
		}
		const task = await this.deps.createTask({
			projectId: ids[0]!,
			alsoProjects: ids.slice(1),
			title: card.title,
			prompt: card.prompt,
			baseRef: card.base,
		});
		await this.card(chat, { ...card, state: 'started', task });
		return { task: task.id, project: task.projectId, started: true };
	}
	// ---------- setups ----------
	private async readSetups(): Promise<Setups> {
		const doc = await readDocument(await safePath(this.deps.root, 'setups.json')).catch(() => null);
		return isRecord(doc) && isRecord(doc.setups) ? (doc.setups as Setups) : {};
	}
	private async writeSetups(setups: Setups) {
		await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
		await atomicJson(await safePath(this.deps.root, 'setups.json'), { schemaVersion: 1, setups });
	}
	private slackSteps(name: string | undefined): BrigadirStep[] {
		const state = this.deps.slack.state();
		return [
			{ name: 'Name', detail: name ?? 'Brigadir', done: Boolean(name) || state.bot },
			{
				name: 'Create in Slack',
				detail: 'api.slack.com · pick the workspace, then Create',
				done: state.bot,
			},
			{
				name: 'Bot token',
				detail: 'Install to Workspace, then the Bot User OAuth Token',
				done: state.bot,
			},
			{
				name: 'App-level token',
				detail: 'Basic Information ▸ App-Level Tokens · connections:write',
				done: state.app,
			},
			{ name: 'Your member ID', detail: 'Profile ▸ ⋯ ▸ Copy member ID', done: state.memberId },
		];
	}
	private async setupStates(): Promise<BrigadirSetupState[]> {
		const setups = await this.readSetups();
		const steps = this.slackSteps(setups.slack?.name);
		const done = steps.filter((step) => step.done).length;
		const next = steps.find((step) => !step.done);
		const slack: BrigadirSetupState = {
			kind: 'slack',
			done: !next,
			status: !next
				? this.deps.slack.state().listening
					? 'Listening for mentions'
					: 'Connected'
				: done === 0 && !setups.slack
					? 'Not set up'
					: `${done} of ${steps.length} · ${next.name}`,
			chat: setups.slack?.chat ?? null,
		};
		const remote = this.deps.settings().remoteAccess.enabled;
		return [
			slack,
			{
				kind: 'remoteAccess',
				done: remote,
				status: remote ? 'On' : 'Not set up',
				chat: setups.remoteAccess?.chat ?? null,
			},
		];
	}
	private async unfinishedSetups(): Promise<string> {
		const states = await this.setupStates();
		return states
			.filter(setupInProgress)
			.map((state) => `- ${state.kind}: ${state.status}`)
			.join('\n');
	}
	private async setup(chat: string, kind: BrigadirSetupKind, name: string | null) {
		const setups = await this.readSetups();
		if (kind === 'remoteAccess') {
			await this.writeSetups({ ...setups, remoteAccess: { chat } });
			this.deps.openRemoteSettings();
			void this.broadcastList();
			return 'Opened Settings ▸ Modules ▸ Remote access: the person turns it on there with a password and pairs each device. Tell them so.';
		}
		const own = { ...setups.slack, chat, ...(name ? { name } : {}) };
		await this.writeSetups({ ...setups, slack: own });
		const steps = this.slackSteps(own.name);
		await this.card(chat, {
			type: 'steps',
			id: 'setup-slack',
			setup: 'slack',
			title: 'Slack setup',
			steps,
		});
		const state = this.deps.slack.state();
		if (!state.bot)
			await this.card(chat, {
				type: 'link',
				id: 'slack-create',
				url: slackManifestLink(own.name ?? 'Brigadir'),
				label: 'Create in Slack',
				title: `Create the ${own.name ?? 'Brigadir'} app`,
				detail: 'api.slack.com · scopes, events and Socket Mode are filled in',
				opened: false,
			});
		void this.broadcastList();
		const lines = steps.map(
			(step, index) =>
				`${index + 1}. ${step.name} — ${step.done ? 'done' : 'to do'}: ${step.detail}`
		);
		return [
			'Steps (shown to the person as a card):',
			...lines,
			state.bot
				? 'The bot token is connected.'
				: 'A "Create in Slack" button is in the chat: tell the person to open it, pick the workspace and press Create, then Install to Workspace; then ask for the bot token with secret_request kind slackBotToken.',
			state.bot && !state.app
				? "Next: tell them to open the app's Basic Information ▸ App-Level Tokens, generate one with connections:write, then ask for it with secret_request kind slackAppToken."
				: '',
			!state.memberId
				? 'Last: their member ID (Profile ▸ ⋯ ▸ Copy member ID, starts with U) — ask them to paste it in the chat (it is not a secret) and save it with settings_set key slack.memberId.'
				: '',
			'Every developer needs their own Slack app: with one app shared, Slack spreads mentions across everyone connected to it.',
		]
			.filter(Boolean)
			.join('\n');
	}
	private async refreshSteps(chat: string) {
		const setups = await this.readSetups();
		await this.card(chat, {
			type: 'steps',
			id: 'setup-slack',
			setup: 'slack',
			title: 'Slack setup',
			steps: this.slackSteps(setups.slack?.name),
		});
		void this.broadcastList();
	}
	private async secret(
		chat: string,
		kind: BrigadirSecretKind,
		signal: AbortSignal
	): Promise<string> {
		const card: Extract<BrigadirCard, { type: 'secret' }> = {
			type: 'secret',
			id: randomUUID(),
			kind,
			state: 'waiting',
		};
		await this.card(chat, card);
		for (;;) {
			const { action, value } = await this.wait(chat, card.id, signal);
			if (action !== 'secret' || !value) {
				await this.card(chat, { ...card, state: 'closed' });
				return 'The person closed the field without a token.';
			}
			await this.card(chat, { ...card, state: 'checking' });
			try {
				if (kind === 'slackBotToken') {
					const bot = await this.deps.slack.connectBot(value.trim());
					const setups = await this.readSetups();
					await this.writeSetups({ ...setups, slack: { ...setups.slack, chat, appId: bot.appId } });
					const missing = bot.scopes === null ? [] : missingSlackScopes(bot.scopes);
					const link = bot.appId
						? `https://api.slack.com/apps/${bot.appId}/oauth`
						: 'https://api.slack.com/apps';
					await this.card(
						chat,
						missing.length
							? {
									...card,
									state: 'scopes',
									result: `@${bot.bot} · ${bot.team} · missing ${missing.join(', ')}`,
									link,
								}
							: { ...card, state: 'connected', result: `@${bot.bot} · ${bot.team}` }
					);
					await this.refreshSteps(chat);
					return missing.length
						? `Connected as @${bot.bot} in ${bot.team}, but the token lacks scopes: ${missing.join(', ')}. Tell the person to add them on the app's OAuth & Permissions page (the card has the link) and Reinstall to Workspace, then paste the new token: call secret_request again.`
						: `Connected as @${bot.bot} in ${bot.team}.${bot.appId ? ` The app's pages: https://api.slack.com/apps/${bot.appId}/general` : ''}`;
				}
				await this.deps.slack.connectApp(value.trim());
				await this.card(chat, { ...card, state: 'connected', result: 'Listening for mentions' });
				await this.refreshSteps(chat);
				return 'The app-level token is connected; Brigadir listens for mentions.';
			} catch (error) {
				const message =
					error instanceof Error
						? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
						: String(error);
				await this.card(chat, { ...card, state: 'error', result: message.slice(0, 200) });
				// The card stays open for another try.
			}
		}
	}
}
/** What a change behind a confirmation removes or allows, as one line of its card. */
function settingFact(key: string): string {
	if (key === 'agents.slackPostWithoutAsking')
		return 'Agents post to Slack without a permission card.';
	if (key.startsWith('modules.'))
		return 'Its part of the window, menu items, background work and agent tools go away.';
	return '';
}
