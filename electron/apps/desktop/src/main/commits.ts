import { join } from 'node:path';
import {
	isRecord,
	type CommitPreview,
	type CommitResult,
	type CommitBasketPlan,
	type CommitProgress,
	type CommitSplitProposal,
	type FileDiff,
	type TaskKey,
	type HelperRun,
} from '@brigadir/core';
import { SessionStore, atomicJson, safePath, readDocument } from '@brigadir/persistence';
import {
	Snapshots,
	previewCommits,
	commitPreview,
	commitBaskets,
	basketTree,
	readBlobs,
	commitMessageContext,
	commitMessagePrompt,
	commitSplitPrompt,
	parseCommitSplit,
	type CommitMessageSource,
} from '@brigadir/git';
import type { Changes } from './changes';
import type { Sessions } from './sessions';
import type { Files } from './files';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
export class Commits {
	private previews = new Map<string, CommitPreview>();
	private pending = new Map<string, Promise<CommitResult>>();
	private generations = new Map<string, AbortController>();
	isGitBusy: () => boolean = () => false;
	isRemoving: (projectId: string) => boolean = () => false;
	constructor(
		private dataDir: string | undefined,
		private changes: Changes,
		private sessions: Sessions,
		private files: Files
	) {}
	get isSaving() {
		return this.pending.size > 0;
	}
	waitForWrites() {
		return Promise.allSettled([...this.pending.values()]);
	}
	cancelAll() {
		for (const controller of this.generations.values()) controller.abort();
		for (const controller of this.splits.values()) controller.abort();
	}
	async read(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		const snapshots = await Snapshots.open(store, key),
			preview = await previewCommits(snapshots.current.scopes, snapshots.current);
		this.previews.set(`${name(key)}/${preview.revision}`, preview);
		while (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value!);
		let result: CommitResult | null = null;
		try {
			const doc = await readDocument(await safePath(await store.taskDir(key), 'commits.json'));
			if (
				!isRecord(doc.result) ||
				!Array.isArray(doc.result.committed) ||
				!doc.result.committed.every(
					(item) =>
						isRecord(item) &&
						typeof item.scopeId === 'string' &&
						typeof item.name === 'string' &&
						typeof item.sha === 'string' &&
						/^[a-f0-9]{40,64}$/.test(item.sha)
				) ||
				!(doc.result.error === null || typeof doc.result.error === 'string')
			)
				throw new Error('Invalid commit history');
			result = doc.result as CommitResult;
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
		}
		return { preview, result };
	}
	private preview(key: TaskKey, revision: string) {
		const preview = this.previews.get(`${name(key)}/${revision}`);
		if (!preview || preview.revision !== revision)
			throw new Error('Files changed. Review the commit list again.');
		return preview;
	}
	async file(key: TaskKey, revision: string, id: string): Promise<FileDiff> {
		const preview = this.preview(key, revision),
			item = preview.scopes.find((item) => item.files.some((file) => file.diff?.id === id)),
			file = item?.files.find((file) => file.diff?.id === id)?.diff;
		if (!item || !file) throw new Error('File is unavailable');
		const [before, after] = await readBlobs(item.scope, [file.before, file.after]);
		const empty = {
			file,
			beforeText: before!.text,
			afterText: after!.text,
			lines: [],
			pairs: [],
			binary: before!.binary || after!.binary,
			tooLarge: before!.tooLarge || after!.tooLarge,
			baseLabel: item.head ? `HEAD · ${item.head.slice(0, 7)}` : 'HEAD · ∅',
		};
		if (file.gitlink || empty.binary || empty.tooLarge) return empty;
		const [diff, beforeSyntax, afterSyntax] = await Promise.all([
			this.changes.compute<Pick<FileDiff, 'lines' | 'pairs' | 'tooLarge'>>({
				before: before!.text,
				after: after!.text,
			}),
			this.changes.syntax.read(file.oldPath, before!.text),
			this.changes.syntax.read(file.path, after!.text),
		]);
		return { ...empty, ...diff, beforeSyntax, afterSyntax };
	}
	async editor(key: TaskKey, revision: string, id: string) {
		const preview = this.preview(key, revision),
			item = preview.scopes.find((item) => item.files.some((file) => file.diff?.id === id)),
			file = item?.files.find((file) => file.diff?.id === id)?.diff;
		if (!item || !file) throw new Error('File is unavailable');
		return this.files.fromAnchor(key, { scopeId: item.scope.id, path: file.path });
	}
	run(key: TaskKey, revision: string, message: string) {
		if (this.pending.size || this.isGitBusy())
			throw new Error('A Git operation is already in progress');
		const work = this.runNow(key, revision, message);
		this.pending.set(name(key), work);
		void work.finally(() => this.pending.delete(name(key))).catch(() => {});
		return work;
	}
	/** The checks every commit passes: no project removal, no file being saved, no agent turn running. */
	private async guard(key: TaskKey) {
		if (this.isRemoving(key.projectId)) throw new Error('Project removal is in progress');
		if (this.files.isSaving) throw new Error('A file is being saved');
		const session = await this.sessions.read(key);
		if (
			session.records.findLast((record) =>
				['turn.started', 'turn.completed', 'host.stopped', 'session.failed'].includes(
					record.event.kind
				)
			)?.event.kind === 'turn.started'
		)
			throw new Error('Wait for the agent to finish before committing');
	}
	/** spec/git#commit-dialog: the commit dialog's baskets, one commit each, in order; steps go out through `onProgress`. */
	baskets(
		key: TaskKey,
		revision: string,
		plan: CommitBasketPlan[],
		onProgress: (progress: CommitProgress) => void = () => {}
	) {
		if (this.pending.size || this.isGitBusy())
			throw new Error('A Git operation is already in progress');
		const work = (async () => {
			const preview = this.preview(key, revision);
			await this.guard(key);
			const store = await SessionStore.at(this.dataDir),
				snapshots = await Snapshots.open(store, key),
				result = await commitBaskets(
					preview,
					snapshots.current.scopes,
					plan,
					snapshots.current,
					(basketId, state, detail) =>
						onProgress({
							key,
							basketId,
							state,
							...(state === 'done' ? { sha: detail } : {}),
							...(state === 'failed' ? { output: detail } : {}),
						})
				);
			if (result.committed.length || result.error)
				await atomicJson(await safePath(await store.taskDir(key), 'commits.json'), {
					schemaVersion: 1,
					result: { committed: result.committed, error: result.error },
				});
			await this.sessions.command(key, { kind: 'checkpoint' }).catch(() => {});
			return result;
		})();
		this.pending.set(name(key), work);
		void work.finally(() => this.pending.delete(name(key))).catch(() => {});
		return work;
	}
	private async runNow(key: TaskKey, revision: string, message: string) {
		const preview = this.preview(key, revision);
		await this.guard(key);
		const store = await SessionStore.at(this.dataDir),
			snapshots = await Snapshots.open(store, key),
			result = await commitPreview(preview, snapshots.current.scopes, message, snapshots.current);
		await atomicJson(await safePath(await store.taskDir(key), 'commits.json'), {
			schemaVersion: 1,
			result,
		});
		await this.sessions.command(key, { kind: 'checkpoint' }).catch(() => {});
		return result;
	}
	async generate(key: TaskKey, revision: string, run?: HelperRun | null) {
		const preview = this.preview(key, revision);
		return this.write(
			name(key),
			preview.scopes.map((item) => ({
				name: item.scope.name,
				path: item.scope.path,
				base: item.head,
				tree: item.tree,
			})),
			run
		);
	}
	/** spec/git#commit-dialog: the message of one basket — the generator over HEAD plus the basket's reviewed files. */
	async generateBasket(
		key: TaskKey,
		revision: string,
		scopeId: string,
		paths: string[],
		run?: HelperRun | null
	) {
		const preview = this.preview(key, revision),
			item = preview.scopes.find((value) => value.scope.id === scopeId);
		const files = item?.files.filter((file) => paths.includes(file.path)) ?? [];
		if (!item || files.length !== paths.length)
			throw new Error('Files changed. Review the commit list again.');
		const tree = await basketTree(item.scope, item.head, item.tree, [
			...new Set(files.flatMap((file) => [file.path, file.oldPath])),
		]);
		return this.write(
			`${name(key)}/${scopeId}/${[...paths].sort().join('\0')}`,
			[{ name: item.scope.name, path: item.scope.path, base: item.head, tree }],
			run
		);
	}
	/** One generation per task (or per basket): its cancel controller lives while it runs. */
	private async write(id: string, sources: CommitMessageSource[], run?: HelperRun | null) {
		if (this.generations.has(id)) throw new Error('Generation is already in progress');
		const controller = new AbortController();
		this.generations.set(id, controller);
		try {
			const context = await commitMessageContext(sources);
			return await this.messageWriter(commitMessagePrompt(context), controller.signal, run);
		} finally {
			this.generations.delete(id);
		}
	}
	/** spec/git#commit-dialog: the hint model's one-shot; main sets it (the model, the quota, the test fixture). */
	splitWriter: (prompt: string, signal: AbortSignal, run?: HelperRun | null) => Promise<string> =
		async () => {
			throw new Error('The helper agent is off.');
		};
	/** spec/appearance#evolution-redesign: the commit message is a one-shot of the Helper agent; main sets it. */
	messageWriter: (prompt: string, signal: AbortSignal, run?: HelperRun | null) => Promise<string> =
		async () => {
			throw new Error('The helper agent is off.');
		};
	private splits = new Map<string, AbortController>();
	/** «Split with the agent»: baskets with messages and reasons for every repo of the preview. Only on the person's click. */
	async split(
		key: TaskKey,
		revision: string,
		run?: HelperRun | null
	): Promise<CommitSplitProposal> {
		const preview = this.preview(key, revision);
		this.splits.get(name(key))?.abort();
		const controller = new AbortController();
		this.splits.set(name(key), controller);
		try {
			const context = await commitMessageContext(
				preview.scopes.map((item) => ({
					name: item.scope.name,
					path: item.scope.path,
					base: item.head,
					tree: item.tree,
				}))
			);
			const sources = preview.scopes
				.map((item) => ({
					scopeId: item.scope.id,
					context: context.find((value) => value.scope === item.scope.name)!,
					files: item.files.map((file) => ({
						path: file.path,
						status: file.status,
						additions: file.diff?.additions ?? 0,
						deletions: file.diff?.deletions ?? 0,
					})),
				}))
				.filter((source) => source.context);
			const answer = await this.splitWriter(commitSplitPrompt(sources), controller.signal, run);
			if (controller.signal.aborted) throw new Error('Stopped');
			return parseCommitSplit(
				answer,
				preview.scopes.map((item) => ({ scopeId: item.scope.id, name: item.scope.name }))
			);
		} finally {
			if (this.splits.get(name(key)) === controller) this.splits.delete(name(key));
		}
	}
	stopSplit(key: TaskKey) {
		this.splits.get(name(key))?.abort();
		this.splits.delete(name(key));
	}
}
