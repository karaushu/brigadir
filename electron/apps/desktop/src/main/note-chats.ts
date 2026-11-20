import { randomUUID } from 'node:crypto';
import { appendFile, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { AgentTransport, type AdapterCommand } from '@brigadir/transport';
import type { NotesStore } from '@brigadir/persistence';
import {
	attachmentToken,
	isNoteChatRow,
	promptParts,
	lastSeenNote,
	noteChatPrompt,
	noteLineDelta,
	quickAskWrites,
	selectOption,
	toolPaths,
	undoableEdit,
	type AgentEvent,
	type AgentOption,
	type AttachmentInput,
	type PromptAttachment,
	type NoteChatChoice,
	type NoteChatEvent,
	type NoteChatEntry,
	type NoteChatRow,
	type NoteChatState,
	type PermissionRequest,
} from '@brigadir/core';
/** What the note chat needs from the rest of main; injected so a test runs without Electron. */
export type NoteChatDeps = {
	store: Promise<NotesStore>;
	/** The folder of the note's project, or null for a note without one (or whose project is gone). */
	projectPath(project: string | null): Promise<string | null>;
	send(event: NoteChatEvent): void;
	/** The note's text changed under the editor: the agent's edit or an Undo. */
	changed(id: string): void;
	/**
	 * spec/composer#chat-composer: the note chat's own attachments by id, in that order, each read and checked (`Attachments` of
	 * `notes/<id>/`); the limits of a prompt hold. Without it a message carries no attachments.
	 */
	attachments?(
		note: string,
		ids: string[]
	): Promise<{ attachment: PromptAttachment; input: AttachmentInput }[]>;
	/** Makes an attachment of the note chat (a file reference picked in `@`). */
	attach?(note: string, input: AttachmentInput): Promise<PromptAttachment>;
	/** spec/composer#chat-composer: the summary a task pill becomes when the message goes, as the task composer's `@task`; null — the task is gone. */
	taskSummary?(task: string): Promise<{ name: string; text: string } | null>;
	adapter?: AdapterCommand | undefined;
	idleMs?: number;
};
/**
 * spec/composer#chat-composer: a file or folder of the note's project picked in the `@` menu — a reference the agent reads itself, as the
 * task composer's (spec/composer#agent-blocks). `path` is relative to the project's main tree and stays inside it.
 */
export async function projectReference(
	root: string,
	path: string
): Promise<{ name: string; text: string }> {
	const clean = normalize(path).replace(/[\\/]+$/, '');
	if (
		!clean ||
		clean === '.' ||
		isAbsolute(clean) ||
		clean === '..' ||
		clean.startsWith(`..${sep}`)
	)
		throw new Error('The path is outside the project');
	const absolute = join(root, clean),
		[real, base] = await Promise.all([realpath(absolute), realpath(root)]);
	const inside = relative(base, real);
	if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
		throw new Error('The path is outside the project');
	const directory = (await stat(real)).isDirectory(),
		name = basename(clean);
	return {
		name: directory ? `${name.slice(0, 199)}/` : name.slice(0, 200),
		text: `${directory ? 'Directory' : 'File'} reference:\nProject-relative path: ${JSON.stringify(clean.split(sep).join('/'))}\nAbsolute path: ${JSON.stringify(absolute)}\nRead the current contents from disk when needed.`,
	};
}
type Chat = {
	id: string;
	transport: AgentTransport | null;
	choice: NoteChatChoice | null;
	busy: boolean;
	answering: boolean;
	options: AgentOption[];
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	/** The note's text as the agent may write it: its path and the real path (/var and /private/var on macOS). */
	files: string[];
	stopped: boolean;
};
const writeKinds = new Set(['allow_once', 'allow_always']);
const sameChoice = (a: NoteChatChoice | null, b: NoteChatChoice) =>
	!!a && a.provider === b.provider && a.model === b.model;
/**
 * spec/notifications-slack-notes-and-schedules#notes: one agent session per note, kept across restarts by its `session.started` in the chat journal. The
 * agent works in the note's project (reading only) or, without one, in the notes folder; it may write only the note's
 * file, and every edit is a row with the text before it, so Undo can put it back.
 */
export class NoteChats {
	private chats = new Map<string, Chat>();
	private writes = new Map<string, Promise<unknown>>();
	constructor(private deps: NoteChatDeps) {}
	private async rows(id: string): Promise<NoteChatRow[]> {
		const path = await (await this.deps.store).chatPath(id);
		const text = await readFile(path, 'utf8').catch(() => '');
		return text
			.split('\n')
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const value: unknown = JSON.parse(line);
					return isNoteChatRow(value) ? [value] : [];
				} catch {
					return [];
				}
			});
	}
	async read(id: string): Promise<NoteChatState> {
		const chat = this.chats.get(id);
		return { rows: await this.rows(id), busy: chat?.busy ?? false, choice: chat?.choice ?? null };
	}
	/** Appends one row (rows of a note one after another) and sends it to every window. */
	private append(id: string, row: NoteChatEntry) {
		const work = (this.writes.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const rows = await this.rows(id);
				const full = {
					...row,
					seq: (rows.at(-1)?.seq ?? 0) + 1,
					at: new Date().toISOString(),
				} as NoteChatRow;
				await appendFile(await (await this.deps.store).chatPath(id), `${JSON.stringify(full)}\n`, {
					mode: 0o600,
				});
				this.deps.send({ id, row: full });
				return full;
			});
		this.writes.set(id, work);
		return work;
	}
	private state(chat: Chat, busy: boolean) {
		chat.busy = busy;
		this.deps.send({ id: chat.id, busy });
	}
	private turns = new Map<string, Promise<void>>();
	/**
	 * spec/notifications-slack-notes-and-schedules#note-concurrent: resolves when the note's agent is not answering. A Slack addition waits for it,
	 * so the agent's edit (and its Undo) holds only what the agent wrote, and the agent's own write does not overtake it.
	 */
	idle(id: string): Promise<void> {
		return this.turns.get(id) ?? Promise.resolve();
	}
	private async readAttachments(id: string, ids: string[]) {
		if (!ids.length) return [];
		if (!this.deps.attachments) throw new Error('This chat takes no attachments.');
		return this.deps.attachments(id, ids);
	}
	/** Throws when a message's attachments are gone, changed or over the limits: the window keeps its draft. */
	async checkAttachments(id: string, ids: string[]) {
		await this.readAttachments(id, ids);
	}
	/** spec/composer#chat-composer: where the `/` list is read before the agent starts — the note's project, else the notes folder. */
	async slashFolder(id: string): Promise<string> {
		const store = await this.deps.store;
		const note = await store.read(id);
		return (await this.deps.projectPath(note.project)) ?? (await store.dir());
	}
	/** spec/composer#chat-composer: a file or folder of the note's project, picked in `@`, as an attachment of the chat. */
	async attachFile(id: string, path: string): Promise<PromptAttachment> {
		const note = await (await this.deps.store).read(id);
		const root = await this.deps.projectPath(note.project);
		if (!root || !this.deps.attach) throw new Error('The note has no project');
		return this.deps.attach(id, { kind: 'text', ...(await projectReference(root, path)) });
	}
	async send(id: string, text: string, choice: NoteChatChoice, attachmentIds: string[] = []) {
		if (this.chats.get(id)?.busy || this.turns.has(id))
			throw new Error('The agent is still answering');
		let end = () => {};
		this.turns.set(id, new Promise<void>((resolve) => (end = resolve)));
		try {
			const attached = await this.readAttachments(id, attachmentIds);
			await this.turn(id, text, choice, await this.deps.store, attached);
		} finally {
			this.turns.delete(id);
			end();
		}
	}
	/**
	 * spec/composer#chat-composer: what the agent reads of the person's text — a task pill becomes the task's summary in its place, as in the
	 * task composer; a task that is gone stays its id.
	 */
	private async agentText(text: string) {
		const summaries: (AttachmentInput & { id: string })[] = [];
		let out = '';
		for (const part of promptParts(text)) {
			if (part.kind === 'text') out += part.text;
			else if (part.token.kind === 'task') {
				const summary = await this.deps.taskSummary?.(part.token.id).catch(() => null);
				if (!summary) {
					out += `the task with id ${part.token.id}`;
					continue;
				}
				const id = randomUUID();
				summaries.push({ id, kind: 'text', ...summary });
				out += attachmentToken(id);
			} else out += part.raw;
		}
		return { text: out, summaries };
	}
	private async turn(
		id: string,
		text: string,
		choice: NoteChatChoice,
		store: NotesStore,
		attached: { attachment: PromptAttachment; input: AttachmentInput }[] = []
	) {
		let chat = this.chats.get(id);
		const note = await store.read(id);
		const file = await store.textPath(id);
		if (!chat) {
			chat = {
				id,
				transport: null,
				choice: null,
				busy: false,
				answering: false,
				options: [],
				controller: new AbortController(),
				files: [...new Set([file, await realpath(file).catch(() => file)])],
				stopped: false,
			};
			this.chats.set(id, chat);
		}
		clearTimeout(chat.timer);
		this.state(chat, true);
		const begun = Date.now();
		try {
			const rows = await this.rows(id);
			// spec/notifications-slack-notes-and-schedules#notes: the person's edits between messages are a row of the chat, so both sides see them.
			const seen = lastSeenNote(rows);
			if (seen !== undefined && seen !== note.text)
				await this.append(id, { kind: 'person-edit', ...noteLineDelta(seen, note.text) });
			await this.append(id, {
				kind: 'prompt',
				text,
				note: note.text,
				choice,
				...(attached.length ? { attachments: attached.map((item) => item.attachment) } : {}),
			});
			const project = await this.deps.projectPath(note.project);
			const fresh = !chat.transport || !sameChoice(chat.choice, choice);
			if (fresh) await this.start(chat, choice, project, rows, store);
			chat.stopped = false;
			chat.answering = true;
			const said = await this.agentText(text);
			try {
				await chat.transport!.send(
					{
						kind: 'prompt',
						text: noteChatPrompt({
							text: said.text,
							note: note.text,
							file,
							project: note.project && project ? note.project : null,
							first: fresh,
						}),
					},
					[
						...attached.map((item) => ({ ...item.input, id: item.attachment.id })),
						...said.summaries,
					]
				);
			} finally {
				chat.answering = false;
			}
			const after = await store.read(id).catch(() => null);
			if (after && after.text !== note.text) {
				await this.append(id, {
					kind: 'edit',
					before: note.text,
					after: after.text,
					...noteLineDelta(note.text, after.text),
				});
				this.deps.changed(id);
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
			this.state(chat, false);
			chat.timer = setTimeout(() => this.close(id), this.deps.idleMs ?? 600_000);
		}
	}
	private async start(
		chat: Chat,
		choice: NoteChatChoice,
		project: string | null,
		rows: NoteChatRow[],
		store: NotesStore
	) {
		chat.transport?.close();
		chat.transport = null;
		chat.controller = new AbortController();
		const notes = await store.dir();
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
		const transport = await AgentTransport.start({
			provider: choice.provider,
			cwd: project ?? notes,
			signal: chat.controller.signal,
			...(project ? { additionalDirectories: [notes] } : {}),
			...(this.deps.adapter ? { adapter: this.deps.adapter } : {}),
			...(resume ? { resumeSessionId: resume } : {}),
			requestPermission: async (request) => this.permission(chat, request),
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
	private event(chat: Chat, event: AgentEvent) {
		if (event.kind === 'session.started' || event.kind === 'options.changed')
			chat.options = event.options;
		// A resumed session may replay its history on load; only the answer to our message is the chat's.
		// The agent's commands may come before the first answer; the `/` menu reads them (spec/composer#chat-composer).
		if (event.kind === 'session.started' || event.kind === 'commands.changed' || chat.answering)
			void this.append(chat.id, { kind: 'event', event });
	}
	/** Edits of the note's own file go through; any other write is declined; the rest needs no write and is allowed. */
	private permission(chat: Chat, request: PermissionRequest): string | null {
		const allow = request.options.find((option) => option.kind === 'allow_once')?.id ?? null,
			reject = request.options.find((option) => !writeKinds.has(option.kind))?.id ?? null;
		if (!quickAskWrites(request.tool)) return request.tool.category === 'execute' ? reject : allow;
		const paths = toolPaths(request.tool);
		return paths.length > 0 && paths.every((path) => chat.files.includes(path)) ? allow : reject;
	}
	async stop(id: string) {
		const chat = this.chats.get(id);
		if (!chat?.busy) return;
		chat.stopped = true;
		await chat.transport?.send({ kind: 'cancel' }).catch(() => {});
	}
	async undo(id: string, seq: number) {
		const store = await this.deps.store;
		const note = await store.read(id);
		const rows = await this.rows(id);
		if (undoableEdit(rows, note.text) !== seq) throw new Error('The note changed after this edit');
		const edit = rows.find((row) => row.seq === seq);
		if (edit?.kind !== 'edit') throw new Error('No such edit');
		await store.write(id, edit.before);
		await this.append(id, { kind: 'undo', of: seq });
		this.deps.changed(id);
	}
	close(id: string) {
		const chat = this.chats.get(id);
		if (!chat) return;
		this.chats.delete(id);
		clearTimeout(chat.timer);
		chat.controller.abort();
		chat.transport?.close();
	}
	closeAll() {
		for (const id of [...this.chats.keys()]) this.close(id);
	}
}
