import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import {
	addToastNotice,
	applyNoticeAction,
	isNoticeEntry,
	pruneNotices,
	readTaskNotices,
	type CIFinished,
	type CIWatch,
	type NoticeCenter,
	type NoticeCenterAction,
	type NoticeEntry,
	type NoticeEntryKind,
	type PendingNotice,
	type TaskKey,
	type ToastNotice,
} from '@brigadir/core';
import { SessionStore, atomicText, safePath } from '@brigadir/persistence';

type Deps = {
	dataDir?: string | undefined;
	/** Live requests, rebuilt from pending inputs (main/notifications.ts). */ pending(): PendingNotice[];
	answer(id: string, option: 'allow' | 'deny'): void;
	openTask(key: TaskKey): void;
	/** spec/notifications-slack-notes-and-schedules#schedules: a schedule's live row opens the Schedules section. */ openSchedule?(
		key: TaskKey
	): void;
	openRun(watch: CIWatch): void;
	changed(center: NoticeCenter): void;
	now?(): number;
};
/**
 * spec/notifications-slack-notes-and-schedules#notification-center: the notification center's history — `notifications.jsonl` beside the tasks, one entry a line, the last 200
 * of the last 7 days. Small enough to write whole (atomically, 300 ms after the last change); quit flushes the rest.
 */
export class NoticeLog {
	private entries: NoticeEntry[] = [];
	private loading: Promise<void> | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private writes: Promise<unknown> = Promise.resolve();
	constructor(private deps: Deps) {}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private async file() {
		const store = await SessionStore.at(this.deps.dataDir);
		await mkdir(store.root, { recursive: true, mode: 0o700 });
		return safePath(store.root, 'notifications.jsonl');
	}
	load() {
		return (this.loading ??= (async () => {
			let text = '';
			try {
				text = await readFile(await this.file(), 'utf8');
			} catch {
				return;
			}
			const read: NoticeEntry[] = [];
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				try {
					const value: unknown = JSON.parse(line);
					if (isNoticeEntry(value)) read.push(value);
				} catch {
					// A torn last line after a crash: the rest stays.
				}
			}
			this.entries = pruneNotices([...this.entries, ...read], this.now());
		})());
	}
	async center(): Promise<NoticeCenter> {
		await this.load();
		return { entries: this.entries, pending: this.deps.pending() };
	}
	/** Pending requests changed (a question asked or answered): only the live part is new. */
	pendingChanged() {
		if (this.loading) void this.center().then(this.deps.changed, () => {});
	}
	private async update(next: (entries: NoticeEntry[]) => NoticeEntry[]) {
		await this.load();
		const changed = next(this.entries);
		if (changed === this.entries) return;
		const entries = (this.entries = pruneNotices(changed, this.now()));
		this.schedule();
		this.deps.changed({ entries, pending: this.deps.pending() });
	}
	/** What a system notification says, whatever «When» and the OS permission are (spec/notifications-slack-notes-and-schedules#notification-center). */
	addTask(input: {
		kind: NoticeEntryKind;
		task: TaskKey;
		title: string;
		body: string;
		read: boolean;
	}) {
		return this.update((entries) => [
			{
				id: randomUUID(),
				at: this.now(),
				kind: input.kind,
				title: input.title,
				body: input.body,
				target: { kind: 'task', task: input.task },
				action: null,
				count: 1,
				read: input.read,
			},
			...entries,
		]);
	}
	/** A row without a task to open: a schedule's run that could not start, or slots it missed (spec/notifications-slack-notes-and-schedules#schedules). */
	addPlain(input: { kind: NoticeEntryKind; title: string; body: string }) {
		return this.update((entries) => [
			{
				id: randomUUID(),
				at: this.now(),
				kind: input.kind,
				title: input.title,
				body: input.body,
				target: null,
				action: null,
				count: 1,
				read: false,
			},
			...entries,
		]);
	}
	addRun(event: CIFinished) {
		return this.update((entries) => [
			{
				id: randomUUID(),
				at: this.now(),
				kind:
					event.state === 'pass' ? 'ci-pass' : event.state === 'fail' ? 'ci-fail' : 'ci-cancelled',
				title: event.title,
				body: event.body,
				target: { kind: 'run', watch: event.watch },
				action: null,
				count: 1,
				read: false,
			},
			...entries,
		]);
	}
	addToast(toast: ToastNotice) {
		return this.update(
			(entries) => addToastNotice(entries, toast, randomUUID(), this.now()).entries
		);
	}
	/** The person opened the task: its rows are read (spec/notifications-slack-notes-and-schedules#notification-center). */
	readTask(key: TaskKey) {
		if (!this.loading) return Promise.resolve();
		return this.update((entries) => {
			const next = readTaskNotices(entries, key);
			return next.every((entry, index) => entry === entries[index]) ? entries : next;
		});
	}
	async act(action: NoticeCenterAction) {
		await this.load();
		switch (action.kind) {
			case 'answer':
				this.deps.answer(action.id, action.option);
				return;
			case 'open': {
				const entry = this.entries.find((item) => item.id === action.id);
				if (entry) {
					await this.update((entries) =>
						applyNoticeAction(entries, { kind: 'read', ids: [entry.id] })
					);
					if (entry.target?.kind === 'task') this.deps.openTask(entry.target.task);
					else if (entry.target?.kind === 'run') this.deps.openRun(entry.target.watch);
					return;
				}
				const live = this.deps.pending().find((item) => item.id === action.id);
				if (live?.schedule) this.deps.openSchedule?.(live.task);
				else if (live) this.deps.openTask(live.task);
				return;
			}
			default:
				return this.update((entries) => applyNoticeAction(entries, action));
		}
	}
	private schedule() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush().catch(() => {}), 300);
	}
	private flush() {
		if (!this.timer) return this.writes;
		clearTimeout(this.timer);
		this.timer = null;
		const next = this.writes
			.catch(() => {})
			.then(async () => {
				const text = this.entries.map((entry) => JSON.stringify(entry)).join('\n');
				await atomicText(await this.file(), text ? `${text}\n` : '');
			});
		this.writes = next;
		return next;
	}
	get isSaving() {
		return this.timer !== null;
	}
	waitForWrites() {
		return this.flush();
	}
}
