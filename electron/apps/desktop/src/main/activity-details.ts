import { isAbsolute, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { JournalCache, SessionStore } from '@brigadir/persistence';
import { readChanges } from '@brigadir/git';
import {
	turnResponse,
	turnSummaries,
	type EventRecord,
	type TaskKey,
	type ToolDiffPreview,
	type TurnChanges,
	type TurnSummary,
} from '@brigadir/core';
import { Changes } from './changes';
/** Journal IDs are capabilities to normalized content, never filesystem paths. */
export class ActivityDetails {
	private cache = new Map<string, Promise<ToolDiffPreview | TurnChanges>>();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private changes: Changes) {}
	private memo<T extends ToolDiffPreview | TurnChanges>(
		id: string,
		read: () => Promise<T>
	): Promise<T> {
		const existing = this.cache.get(id);
		if (existing) return existing as Promise<T>;
		const pending = this.queue.then(read);
		this.queue = pending.catch(() => {});
		this.cache.set(id, pending);
		if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
		void pending.catch(() => {
			if (this.cache.get(id) === pending) this.cache.delete(id);
		});
		return pending;
	}
	/** Two task journals stay parsed; a miss reads only what was appended since (CHAT-10). The journal is written from main too, so identity comes from the file. */
	private journals = new JournalCache(2);
	private summaries = new WeakMap<readonly EventRecord[], TurnSummary[]>();
	private async journal(key: TaskKey) {
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		const journal = await this.journals.read(store, key);
		if (journal.issue) throw new Error(journal.issue);
		return { store, records: journal.records };
	}
	private turns(records: readonly EventRecord[]) {
		let turns = this.summaries.get(records);
		if (!turns) {
			turns = turnSummaries(records);
			this.summaries.set(records, turns);
		}
		return turns;
	}
	tool(key: TaskKey, seq: number, index: number): Promise<ToolDiffPreview> {
		return this.memo(`tool/${key.projectId}/${key.id}/${seq}/${index}`, async () => {
			const { records } = await this.journal(key),
				event = records.find((record) => record.seq === seq)?.event;
			const content = event?.kind === 'tool.changed' ? event.patch.content?.[index] : undefined;
			if (content?.kind !== 'diff') throw new Error('Tool diff is unavailable');
			const before = content.before ?? '',
				after = content.after;
			const empty = {
				path: content.path,
				lines: [],
				beforeText: '',
				afterText: '',
				tooLarge: true,
			};
			if (Buffer.byteLength(before) + Buffer.byteLength(after) > 2 * 1024 * 1024) return empty;
			const result = await this.changes.compute<Pick<ToolDiffPreview, 'lines' | 'tooLarge'>>({
				before,
				after,
			});
			if (result.tooLarge) return empty;
			const [beforeSyntax, afterSyntax] = await Promise.all([
				this.changes.syntax.read(content.path, before),
				this.changes.syntax.read(content.path, after),
			]);
			return {
				path: content.path,
				lines: result.lines,
				tooLarge: false,
				beforeText: before,
				afterText: after,
				beforeSyntax,
				afterSyntax,
			};
		});
	}
	async canCopyTurn(key: TaskKey, seq: number) {
		const { records } = await this.journal(key);
		return Boolean(turnResponse(records, seq));
	}
	async currentToolChange(
		key: TaskKey,
		seq: number,
		index: number
	): Promise<{ scopeId: string; path: string } | null> {
		const { store, records } = await this.journal(key),
			event = records.find((record) => record.seq === seq)?.event,
			content = event?.kind === 'tool.changed' ? event.patch.content?.[index] : undefined;
		if (content?.kind !== 'diff') throw new Error('Tool diff is unavailable');
		const project = await store.workspace(key),
			root = project.released ? project.path : await realpath(project.path),
			path = content.path;
		if (path.includes('\0') || path.split('/').includes('..')) return null;
		const relativePath = isAbsolute(path)
			? [relative(project.path, path), relative(root, path)].find(
					(value) => value && !value.split('/').includes('..') && !isAbsolute(value)
				)
			: path;
		if (relativePath === undefined) return null;
		const absolute = resolve(root, relativePath),
			snapshot = await readChanges(store, key);
		for (const scope of snapshot.scopes) {
			const directory = await realpath(scope.path).catch(() => scope.path);
			const file = snapshot.files.find(
				(file) =>
					file.scopeId === scope.id &&
					(resolve(directory, file.path) === absolute ||
						resolve(directory, file.oldPath) === absolute)
			);
			if (file) return { scopeId: file.scopeId, path: file.path };
		}
		return null;
	}
	turn(key: TaskKey, seq: number): Promise<TurnChanges> {
		return this.memo(`turn/${key.projectId}/${key.id}/${seq}`, async () => {
			const { store, records } = await this.journal(key),
				turn = this.turns(records).find((turn) => turn.seq === seq);
			if (!turn || turn.status === 'running') throw new Error('Turn is not complete');
			if (!turn.range) return { range: null, files: [], total: 0 };
			const snapshot = await readChanges(store, key, turn.range);
			return {
				range: turn.range,
				files: snapshot.files.slice(0, 200),
				total: snapshot.files.length,
			};
		});
	}
}
