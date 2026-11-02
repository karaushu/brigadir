import { mkdir, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import {
	isNoteId,
	isNoteMeta,
	isRecord,
	newNoteId,
	noteMaxBytes,
	noteTaskLine,
	noteTitle,
	withNoteTaskLine,
	type NoteDocument,
	type NoteMeta,
	type NoteSummary,
	type NoteTaskLink,
} from '@brigadir/core';
import { atomicJson, atomicText, safePath, SessionStore } from './session';
import { ReadFailure } from './index';
const missing = (e: unknown) => isRecord(e) && e.code === 'ENOENT';
/**
 * spec/notifications-slack-notes-and-schedules#notes: notes as plain files — `notes/<id>.md` is the text, `notes/<id>.json` its project and tasks, `notes/<id>/`
 * the files of its chat. Writes go one after another, like the template store, so a debounced save never overtakes the
 * one before it.
 */
export class NotesStore {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(readonly root: string) {}
	static async at(dataDir?: string) {
		return new NotesStore((await SessionStore.at(dataDir)).root);
	}
	waitForWrites() {
		return this.tail;
	}
	private serial<T>(work: () => Promise<T>) {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	async dir() {
		const dir = await safePath(this.root, 'notes');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	}
	private async path(id: string, ext: '.md' | '.json') {
		if (!isNoteId(id)) throw new ReadFailure('invalid_document');
		return safePath(this.root, 'notes', `${id}${ext}`);
	}
	/** spec/notifications-slack-notes-and-schedules#notes: the note's chat journal, `notes/<id>.chat.jsonl`. */
	async chatPath(id: string) {
		if (!isNoteId(id)) throw new ReadFailure('invalid_document');
		await this.dir();
		return safePath(this.root, 'notes', `${id}.chat.jsonl`);
	}
	/** The absolute path of the note's text. */
	async textPath(id: string) {
		return this.path(id, '.md');
	}
	/** The note's own folder (its chat journal); made on demand. */
	async noteDir(id: string) {
		if (!isNoteId(id)) throw new ReadFailure('invalid_document');
		const dir = await safePath(this.root, 'notes', id);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	}
	private async meta(id: string): Promise<NoteMeta> {
		try {
			const value: unknown = JSON.parse(await readFile(await this.path(id, '.json'), 'utf8'));
			if (isNoteMeta(value)) return value;
		} catch (e) {
			if (!missing(e) && !(e instanceof SyntaxError)) throw e;
		}
		// A note written by hand, without its JSON, is a note without a project.
		return { schemaVersion: 1, project: null, createdAt: new Date(0).toISOString(), tasks: [] };
	}
	async read(id: string): Promise<NoteDocument> {
		const file = await this.path(id, '.md');
		const info = await stat(file);
		if (info.size > noteMaxBytes) throw new ReadFailure('invalid_document');
		const text = await readFile(file, 'utf8');
		const meta = await this.meta(id);
		return {
			id,
			text,
			title: noteTitle(text),
			project: meta.project,
			updatedAt: info.mtime.toISOString(),
			tasks: meta.tasks.length,
			taskKeys: meta.tasks.map((task) => `${task.projectId}/${task.taskId}`),
		};
	}
	async list(): Promise<NoteSummary[]> {
		const dir = await this.dir();
		const ids = (await readdir(dir))
			.filter((name) => name.endsWith('.md'))
			.map((name) => name.slice(0, -3))
			.filter(isNoteId);
		const notes = await Promise.all(
			ids.map(async (id) => {
				try {
					const { text: _text, ...summary } = await this.read(id);
					return summary;
				} catch {
					return null;
				}
			})
		);
		return notes
			.filter((note): note is NoteSummary => note !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
	}
	create(project: string | null, text = '', now = new Date()) {
		return this.serial(async () => {
			await this.dir();
			let id = newNoteId(now.getTime());
			while (
				await stat(await this.path(id, '.md')).then(
					() => true,
					() => false
				)
			)
				id = newNoteId(now.getTime());
			const meta: NoteMeta = { schemaVersion: 1, project, createdAt: now.toISOString(), tasks: [] };
			await atomicJson(await this.path(id, '.json'), meta);
			await atomicText(await this.path(id, '.md'), text);
			return id;
		});
	}
	write(id: string, text: string) {
		return this.serial(async () => {
			if (Buffer.byteLength(text) > noteMaxBytes) throw new ReadFailure('invalid_document');
			const file = await this.path(id, '.md');
			await stat(file); // a deleted note is not written back by a late save
			await atomicText(file, text);
			return (await stat(file)).mtime.toISOString();
		});
	}
	private update(id: string, change: (meta: NoteMeta) => NoteMeta) {
		return this.serial(async () => {
			await stat(await this.path(id, '.md'));
			await atomicJson(await this.path(id, '.json'), change(await this.meta(id)));
		});
	}
	/** spec/notifications-slack-notes-and-schedules#notes: the task joins the note and its link goes into the text, in one write. */
	linkTask(id: string, link: NoteTaskLink, title: string, after: number | null) {
		return this.serial(async () => {
			const file = await this.path(id, '.md');
			const text = await readFile(file, 'utf8');
			await atomicText(
				file,
				withNoteTaskLine(text, noteTaskLine(title, link.projectId, link.taskId), after)
			);
			const meta = await this.meta(id);
			await atomicJson(await this.path(id, '.json'), {
				...meta,
				tasks: [...meta.tasks.filter((t) => t.taskId !== link.taskId), link],
			});
		});
	}
	setProject(id: string, project: string | null) {
		return this.update(id, (meta) => ({ ...meta, project }));
	}
	addTask(id: string, link: NoteTaskLink) {
		return this.update(id, (meta) => ({
			...meta,
			tasks: [...meta.tasks.filter((t) => t.taskId !== link.taskId), link],
		}));
	}
	delete(id: string) {
		return this.serial(async () => {
			for (const ext of ['.md', '.json'] as const)
				await unlink(await this.path(id, ext)).catch((e) => {
					if (!missing(e)) throw e;
				});
			await unlink(await safePath(this.root, 'notes', `${id}.chat.jsonl`)).catch((e) => {
				if (!missing(e)) throw e;
			});
			await rm(await safePath(this.root, 'notes', id), { recursive: true, force: true });
		});
	}
}
