import {
	MAIN_TREE_ID,
	type QuickAskChoice,
	type QuickAskEvent,
	type QuickAskRequest,
	type SlackLanguage,
	type TaskKey,
} from '@brigadir/core';
/**
 * spec/notifications-slack-notes-and-schedules#slack: the read-only side sessions that answer Slack — a question about a task (its agent,
 * spec/composer-steering-queue-and-ghost#quick-question `aboutTask`) or about a project's code (a new agent in the project's main tree, `aboutCode`). One session per Slack
 * thread lives ten minutes after its last answer: a follow-up mention in that thread goes to it; then it is closed.
 */
export type SlackSessionMode = 'aboutTask' | 'aboutCode';
export type SlackSideSession =
	{ mode: 'aboutCode'; projectId: string } | { mode: 'aboutTask'; task: TaskKey };
export type SlackSessionDeps = {
	ask(
		key: TaskKey,
		request: QuickAskRequest,
		mode: SlackSessionMode,
		thread: string | null
	): Promise<void>;
	followUp(key: TaskKey, id: string, question: string, language: SlackLanguage): Promise<void>;
	stop(id: string): Promise<void>;
	close(id: string): void;
	/** The events of one session id while a turn runs (`null` — no longer). */
	listen(id: string, listener: ((event: QuickAskEvent) => void) | null): void;
	/** The project's main tree exists before an `aboutCode` session opens it. */
	ensureMainTree(projectId: string): Promise<void>;
	newId(): string;
	now?(): number;
	/** One answer's limit: five minutes (a project question may run several gh calls). */
	answerMs?: number;
	/** How long a thread's session waits for a follow-up: ten minutes. */
	idleMs?: number;
};
export type SlackSessionAsk = {
	thread: { channel: string; ts: string };
	question: string;
	language: SlackLanguage;
	/** The agent (spec/appearance#evolution-redesign `slackCode`, else the app's default for code); empty — the task's own. */
	choice: QuickAskChoice;
	/** The Slack thread above the question as text, for a new session's prompt. */
	context?: string | null;
};
type Live = {
	id: string;
	key: TaskKey;
	mode: SlackSessionMode;
	at: number;
	busy: boolean;
	timer?: ReturnType<typeof setTimeout>;
};
/** A follow-up the session no longer takes (closed by its own idle timer, or still answering): a new one asks instead. */
const gone = Symbol('gone');
const sameKey = (a: TaskKey, b: TaskKey) => a.projectId === b.projectId && a.id === b.id;

export class SlackSessions {
	private live = new Map<string, Live>();
	constructor(private readonly deps: SlackSessionDeps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private get idleMs() {
		return this.deps.idleMs ?? 600_000;
	}
	/** The thread's live session, if it has one that has not waited ten minutes yet. */
	session(channel: string, ts: string): SlackSideSession | null {
		const live = this.live.get(`${channel}/${ts}`);
		if (!live || this.now() - live.at > this.idleMs) return null;
		return live.mode === 'aboutCode'
			? { mode: 'aboutCode', projectId: live.key.projectId }
			: { mode: 'aboutTask', task: live.key };
	}
	/** A question about the project's code: the session lives in its main tree. */
	async askCode(projectId: string, input: SlackSessionAsk): Promise<string | null> {
		await this.deps.ensureMainTree(projectId);
		return this.ask({ projectId, id: MAIN_TREE_ID }, 'aboutCode', input);
	}
	askTask(task: TaskKey, input: SlackSessionAsk): Promise<string | null> {
		return this.ask(task, 'aboutTask', input);
	}
	closeAll() {
		for (const name of [...this.live.keys()]) this.drop(name);
	}
	private async ask(
		key: TaskKey,
		mode: SlackSessionMode,
		input: SlackSessionAsk
	): Promise<string | null> {
		const name = `${input.thread.channel}/${input.thread.ts}`;
		let live = this.live.get(name);
		if (
			live &&
			!live.busy &&
			(this.now() - live.at > this.idleMs || !sameKey(live.key, key) || live.mode !== mode)
		) {
			this.drop(name);
			live = undefined;
		}
		if (live && !live.busy) {
			const entry = live,
				said = await this.turn(entry, () =>
					this.deps.followUp(key, entry.id, input.question, input.language)
				);
			if (said !== gone) {
				if (said === null) this.drop(name);
				return said;
			}
			this.drop(name);
		}
		// A session busy with another question of this thread answers that one; this one gets its own, closed after it.
		const keep = !this.live.has(name),
			entry: Live = { id: this.deps.newId(), key, mode, at: this.now(), busy: false };
		if (keep) this.live.set(name, entry);
		const request: QuickAskRequest = {
			...input.choice,
			id: entry.id,
			question: input.question,
			language: input.language,
			selection: {
				path: '',
				start: 0,
				end: 0,
				side: 'new',
				text: '',
				around: { start: 0, text: '' },
			},
		};
		const said = await this.turn(entry, () =>
			this.deps.ask(key, request, mode, input.context ?? null)
		);
		const value = said === gone ? null : said;
		if (value === null || !keep) {
			if (this.live.get(name) === entry) this.drop(name);
			else this.deps.close(entry.id);
		}
		return value;
	}
	/** One turn: its text when it ends, `null` when it fails, what came by the limit when it takes too long. */
	private turn(entry: Live, start: () => Promise<void>): Promise<string | null | typeof gone> {
		clearTimeout(entry.timer);
		entry.busy = true;
		return new Promise((resolve) => {
			let text = '',
				ended = false;
			const finish = (value: string | null | typeof gone) => {
				if (ended) return;
				ended = true;
				clearTimeout(limit);
				this.deps.listen(entry.id, null);
				entry.busy = false;
				entry.at = this.now();
				const name = [...this.live].find(([, item]) => item === entry)?.[0];
				if (name) entry.timer = setTimeout(() => this.drop(name), this.idleMs);
				resolve(value);
			};
			const limit = setTimeout(() => {
				void this.deps.stop(entry.id).catch(() => {});
				finish(text.trim() || null);
			}, this.deps.answerMs ?? 300_000);
			this.deps.listen(entry.id, (event) => {
				if (event.kind === 'text') text += event.text;
				else if (event.kind === 'done') finish(text.trim() || null);
				else if (event.kind === 'failed') finish(null);
			});
			start().catch(() => finish(gone));
		});
	}
	private drop(name: string) {
		const live = this.live.get(name);
		if (!live) return;
		this.live.delete(name);
		clearTimeout(live.timer);
		this.deps.close(live.id);
	}
}
