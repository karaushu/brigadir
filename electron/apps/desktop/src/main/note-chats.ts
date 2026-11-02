import { appendFile, readFile, realpath } from 'node:fs/promises';
import { AgentTransport, type AdapterCommand } from '@brigadir/transport';
import type { NotesStore } from '@brigadir/persistence';
import {
	isNoteChatRow,
	lastSeenNote,
	noteChatPrompt,
	noteLineDelta,
	quickAskWrites,
	selectOption,
	toolPaths,
	undoableEdit,
	type AgentEvent,
	type AgentOption,
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
	adapter?: AdapterCommand | undefined;
	idleMs?: number;
};
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
	async send(id: string, text: string, choice: NoteChatChoice) {
		const store = await this.deps.store;
		let chat = this.chats.get(id);
		if (chat?.busy) throw new Error('The agent is still answering');
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
			await this.append(id, { kind: 'prompt', text, note: note.text, choice });
			const project = await this.deps.projectPath(note.project);
			const fresh = !chat.transport || !sameChoice(chat.choice, choice);
			if (fresh) await this.start(chat, choice, project, rows, store);
			chat.stopped = false;
			chat.answering = true;
			try {
				await chat.transport!.send({
					kind: 'prompt',
					text: noteChatPrompt({
						text,
						note: note.text,
						file,
						project: note.project && project ? note.project : null,
						first: fresh,
					}),
				});
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
		if (event.kind === 'session.started' || chat.answering)
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
