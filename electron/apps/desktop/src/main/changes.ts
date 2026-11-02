import { join, dirname, relative } from 'node:path';
import { Syntax } from './syntax';
import { WorkerPool } from './worker';
import { SessionStore } from '@brigadir/persistence';
import {
	readSnapshots,
	readChanges,
	readBlobs,
	changedFiles,
	attributionHunks,
} from '@brigadir/git';
import {
	isMainTree,
	traceAttributionRange,
	type ToolPatch,
	type AttributionRange,
	type Attribution,
	type ChangeRange,
	type ChangeView,
	type DiffBase,
	type TaskKey,
	type FileDiff,
} from '@brigadir/core';
export class Changes {
	private ranges = new Map<string, ChangeRange>();
	private rangeRequests = new Map<string, number>();
	/** spec/diff-and-review#diff-base: the base setting; main sets it on start and on every save. */
	diffBase: DiffBase = 'task';
	range(key: TaskKey) {
		return this.ranges.get(`${key.projectId}/${key.id}`);
	}
	/** A chosen turn range shows its snapshots in either mode; «All changes» follows the base setting. */
	/** spec/tasks#quick-tasks: the main tree always counts from the last commit, like `git status`, whatever the setting. */
	baseFor(key: TaskKey): DiffBase {
		return isMainTree(key) ? 'head' : this.diffBase;
	}
	view(key: TaskKey): ChangeView | undefined {
		return this.range(key) ?? (this.baseFor(key) === 'head' ? 'head' : undefined);
	}
	async timeline(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		return (
			(await readSnapshots(store, key))?.checkpoints.map(({ id, at, reason }) => ({
				id,
				at,
				reason,
			})) ?? []
		);
	}
	async selectRange(key: TaskKey, range: ChangeRange | null) {
		const id = `${key.projectId}/${key.id}`,
			request = (this.rangeRequests.get(id) ?? 0) + 1;
		this.rangeRequests.set(id, request);
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		const value = await readChanges(
			store,
			key,
			range ?? (this.baseFor(key) === 'head' ? 'head' : undefined)
		);
		if (this.rangeRequests.get(id) === request) {
			if (range) this.ranges.set(id, range);
			else this.ranges.delete(id);
		}
		return value;
	}
	/** Least recently used diffs within 16 entries and ~32 MB of text (three entries missed on every review round). */
	private cache = new Map<string, { diff: Promise<FileDiff>; bytes: number }>();
	private remember(id: string, diff: Promise<FileDiff>) {
		const entry = { diff, bytes: 0 };
		this.cache.set(id, entry);
		void diff.then(
			(value) => {
				entry.bytes = (value.beforeText.length + value.afterText.length) * 4;
				this.evict();
			},
			() => {
				if (this.cache.get(id) === entry) this.cache.delete(id);
			}
		);
		this.evict();
	}
	private evict() {
		let bytes = 0;
		for (const entry of this.cache.values()) bytes += entry.bytes;
		for (const [id, entry] of this.cache) {
			if (this.cache.size <= 16 && bytes <= 32 * 1024 * 1024) break;
			this.cache.delete(id);
			bytes -= entry.bytes;
		}
	}
	readonly syntax: Syntax;
	/** Diff and reanchor jobs for every surface: two keep-alive workers, so one large diff leaves the other free. */
	readonly diffs: WorkerPool;
	constructor(
		readonly dataDir: string | undefined,
		readonly workerPath: string
	) {
		this.syntax = new Syntax(join(dirname(workerPath), 'syntax.cjs'));
		this.diffs = new WorkerPool(workerPath, { size: 2 });
	}
	compute<T>(data: unknown) {
		return this.diffs.run<T>(data);
	}
	async read(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		return readChanges(store, key, this.view(key));
	}
	async attribution(key: TaskKey, fileId: string, range?: AttributionRange): Promise<Attribution> {
		const current = await this.read(key),
			file = current.files.find((file) => file.id === fileId);
		if (!file) throw new Error('File changed');
		const store = await SessionStore.at(this.dataDir),
			snapshots = await readSnapshots(store, key),
			journal = await store.journal(key);
		if (journal.issue) throw new Error(journal.issue);
		const scope = snapshots?.scopes.find((scope) => scope.id === file.scopeId);
		if (!snapshots || !scope || current.checkpoint === null)
			return { entries: [], truncated: false };
		const project = await store.workspace(key),
			entries: Attribution['entries'] = [];
		const from = Math.max(1, current.checkpoint - 127);
		type Turn = {
			seq: number;
			number: number;
			text: string;
			excerpt: string;
			tools: Map<string, ToolPatch>;
		};
		const boundaries = new Map<number, Turn | null>(),
			saves = new Set<string>(),
			quick = new Map<number, { question: string; files: Set<string> }>();
		let turn: Turn | null = null,
			turnNumber = 0;
		for (const record of journal.records) {
			const event = record.event;
			if (event.kind === 'turn.started')
				turn = {
					seq: record.seq,
					number: ++turnNumber,
					text: event.text,
					excerpt: '',
					tools: new Map(),
				};
			if (['turn.completed', 'host.stopped', 'session.failed'].includes(event.kind)) turn = null;
			if (
				turn &&
				event.kind === 'message.delta' &&
				event.role === 'assistant' &&
				event.content.kind === 'text'
			)
				turn.excerpt = (turn.excerpt + event.content.text.slice(0, 800)).slice(0, 800);
			if (turn && event.kind === 'tool.changed') {
				turn.tools.set(event.patch.id, { ...turn.tools.get(event.patch.id), ...event.patch });
				if (turn.tools.size > 32) turn.tools.delete(turn.tools.keys().next().value!);
			}
			if (
				event.kind === 'checkpoint.created' &&
				event.checkpoint >= from &&
				event.checkpoint <= current.checkpoint &&
				!boundaries.has(event.checkpoint)
			)
				boundaries.set(event.checkpoint, turn ? { ...turn, tools: new Map(turn.tools) } : null);
			if (event.kind === 'file.saved') saves.add(`${event.after}/${event.path}`);
			if (event.kind === 'quick-ask.changed')
				quick.set(event.after, { question: event.question, files: new Set(event.files) });
		}
		let trackedPath: string | null = file.path,
			mapped = range ?? null,
			truncated = from > 1;
		for (let i = current.checkpoint; i >= from && trackedPath !== null; i--) {
			const checkpoint = snapshots.checkpoints[i]!,
				previous = snapshots.checkpoints[i - 1]!;
			const before = previous.trees.find((tree) => tree.scopeId === file.scopeId),
				after = checkpoint.trees.find((tree) => tree.scopeId === file.scopeId);
			if (!before || !after) {
				mapped = null;
				continue;
			}
			if (before.tree === after.tree) continue;
			const changed = (await changedFiles(scope, before.tree, after.tree)).find(
				(change) => change.path === trackedPath
			);
			if (!changed) continue;
			let precision: 'file' | 'lines' = 'file';
			if (mapped) {
				const hunks = await attributionHunks(scope, changed);
				if (hunks) {
					const result = traceAttributionRange(mapped, hunks);
					if (result.hit) precision = 'lines';
					mapped = result.previous;
				} else {
					mapped = null;
					truncated = true;
				}
			}
			const source = boundaries.get(checkpoint.id),
				user = saves.has(
					`${checkpoint.id}/${relative(project.path, join(scope.path, changed.path))}`
				);
			// spec/composer-steering-queue-and-ghost#quick-question: a quick question's capture is its own, even while a task turn runs.
			const asked = checkpoint.reason === 'quick-after' ? quick.get(checkpoint.id) : undefined;
			if (asked && !user) {
				entries.push({
					checkpoint: checkpoint.id,
					at: checkpoint.at,
					author: 'agent',
					turn: null,
					prompt: asked.question,
					quick: true,
					precision,
				});
				trackedPath =
					changed.status.startsWith('C') || changed.before === null ? null : changed.oldPath;
				continue;
			}
			const author = user
				? 'user'
				: !['tools', 'turn', 'refresh'].includes(checkpoint.reason) || !source
					? 'unknown'
					: 'agent';
			const locations = new Set([
				changed.path,
				relative(project.path, join(scope.path, changed.path)),
				join(scope.path, changed.path),
			]);
			const tool =
				source &&
				[...source.tools.values()].findLast(
					(tool) =>
						tool.locations?.some((location) => locations.has(location.path)) ||
						tool.content?.some((content) => content.kind === 'diff' && locations.has(content.path))
				);
			const excerpt =
				author === 'agent'
					? [source?.excerpt, tool?.title].filter(Boolean).join('\n').slice(0, 1100)
					: '';
			entries.push({
				...(excerpt ? { excerpt } : {}),
				checkpoint: checkpoint.id,
				at: checkpoint.at,
				author,
				turn: author === 'agent' ? source!.seq : null,
				...(author === 'agent' ? { turnNumber: source!.number } : {}),
				prompt: author === 'agent' ? source!.text : null,
				precision,
			});
			// Copy/new file starts a new identity; a rename keeps its previous path.
			trackedPath =
				changed.status.startsWith('C') || changed.before === null ? null : changed.oldPath;
		}
		return {
			entries: entries.sort(
				(a, b) =>
					Number(b.precision === 'lines') - Number(a.precision === 'lines') ||
					b.checkpoint - a.checkpoint
			),
			truncated,
		};
	}
	async file(key: TaskKey, fileId: string): Promise<FileDiff> {
		const snapshot = await this.read(key);
		const file = snapshot.files.find((f) => f.id === fileId);
		const scope = snapshot.scopes.find((s) => s.id === file?.scopeId);
		if (!file || !scope) throw new Error('The file changed. Refresh the changes.');
		const id = `${key.projectId}/${key.id}/${fileId}`;
		// spec/diff-and-review#diff-base: the same blobs under a HEAD base keep their diff; only the side label learns the commit.
		const labelled = (diff: Promise<FileDiff>) =>
			snapshot.heads
				? diff.then((value) => ({ ...value, head: snapshot.heads![scope.id] ?? null }))
				: diff;
		const cached = this.cache.get(id);
		if (cached) {
			this.cache.delete(id);
			this.cache.set(id, cached);
			return labelled(cached.diff);
		}
		const pending = (async (): Promise<FileDiff> => {
			const empty = {
				file,
				beforeText: '',
				afterText: '',
				lines: [],
				pairs: [],
				binary: file.binary,
				tooLarge: false,
			};
			if (file.gitlink || file.binary) return empty;
			const [before, after] = await readBlobs(scope, [file.before, file.after]);
			if (before!.binary || after!.binary || before!.tooLarge || after!.tooLarge)
				return {
					...empty,
					binary: before!.binary || after!.binary,
					tooLarge: before!.tooLarge || after!.tooLarge,
				};
			const result = await this.compute<Pick<FileDiff, 'lines' | 'pairs' | 'tooLarge'>>({
				before: before!.text,
				after: after!.text,
			});
			return {
				...empty,
				...result,
				beforeText: result.tooLarge ? '' : before!.text,
				afterText: result.tooLarge ? '' : after!.text,
			};
		})();
		this.remember(id, pending);
		return labelled(pending);
	}
	/**
	 * Highlighting for `file`, asked separately: the diff shows without waiting for two tree-sitter passes.
	 * Syntax keeps its own cache and never stores a failure, so a failed side is retried on the next request.
	 */
	async fileSyntax(
		key: TaskKey,
		fileId: string
	): Promise<Pick<FileDiff, 'beforeSyntax' | 'afterSyntax'>> {
		const diff = await this.file(key, fileId);
		if (diff.binary || diff.tooLarge || diff.file.gitlink) return {};
		const [beforeSyntax, afterSyntax] = await Promise.all([
			this.syntax.read(diff.file.oldPath, diff.beforeText),
			this.syntax.read(diff.file.path, diff.afterText),
		]);
		return { beforeSyntax, afterSyntax };
	}
}
