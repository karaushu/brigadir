import {
	canMergeInto,
	historyScopes,
	isGitScope,
	mergeResolvePrompt,
	type BranchList,
	type CommitFiles,
	type ConflictResolution,
	type ConflictTexts,
	type FileDiff,
	type HistoryPage,
	type HistoryScope,
	type MergeOutcome,
	type MergePreview,
	type MergeState,
	type Scope,
	type TaskKey,
} from '@brigadir/core';
import { SessionStore } from '@brigadir/persistence';
import {
	Snapshots,
	abortMerge,
	applyResolution,
	branchHistory,
	commitFiles,
	conflictFiles,
	conflictKind,
	conflictTexts,
	currentBranch,
	finishMerge,
	gitText,
	listBranches,
	markResolved,
	mergeSource,
	mergedCleanly,
	previewMerge,
	readBlobs,
	readMergeRecords,
	rebaseInfo,
	rememberMerge,
	reopenConflict,
	resolveWith,
	startMerge,
	swapSide,
	unmergedPaths,
	type MergeRecord,
} from '@brigadir/git';
import type { Changes } from './changes';
import type { Sessions } from './sessions';

/** spec/git#merge: the History mode of the changes panel — git reads only, the tree is not changed. */
export class GitHistory {
	private files = new Map<string, CommitFiles>();
	private tail = Promise.resolve() as Promise<unknown>;
	constructor(
		private dataDir: string | undefined,
		private changes: Changes,
		private sessions: Sessions
	) {}
	/** The same scopes the task's diff sees; a folder without git is left out. */
	async taskScopes(key: TaskKey): Promise<Scope[]> {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		return (await Snapshots.open(store, key)).current.scopes;
	}
	async scopes(key: TaskKey): Promise<HistoryScope[]> {
		return historyScopes(await this.taskScopes(key));
	}
	async scope(key: TaskKey, scopeId: string): Promise<Scope> {
		const scope = (await this.taskScopes(key)).find((item) => item.id === scopeId);
		if (!scope || !isGitScope(scope) || scope.available === false)
			throw new Error('The repo is unavailable');
		return scope;
	}
	async branches(key: TaskKey, scopeId: string): Promise<BranchList> {
		return listBranches(await this.scope(key, scopeId));
	}
	/** spec/editor#line-author: `path` narrows the page to one file of this repo; `limit` grows by pages of 100. spec/git#history-search: `query` searches
	 * the whole history of the branch. */
	async history(
		key: TaskKey,
		scopeId: string,
		branch: string,
		path?: string,
		limit = 100,
		query?: string
	): Promise<HistoryPage> {
		return branchHistory(await this.scope(key, scopeId), branch, limit, path, query);
	}
	/** spec/editor#line-author: the Git root that owns a file: the longest git scope path above it, selected or not (reading is not writing). */
	async owner(key: TaskKey, absolute: string): Promise<Scope | null> {
		return (
			(await this.taskScopes(key))
				.filter(
					(scope) =>
						isGitScope(scope) && scope.available !== false && absolute.startsWith(scope.path + '/')
				)
				.sort((a, b) => b.path.length - a.path.length)[0] ?? null
		);
	}
	async commit(key: TaskKey, scopeId: string, sha: string): Promise<CommitFiles> {
		const scope = await this.scope(key, scopeId),
			result = await commitFiles(scope, sha);
		this.files.set(`${scopeId}/${sha}`, result);
		while (this.files.size > 50) this.files.delete(this.files.keys().next().value!);
		return result;
	}
	// ── Merge (spec/git#merge) ─────────────────────────────────────────────────
	/** Actions that write to the tree run in turn: two clicks do not start two merges. */
	private serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.tail.then(run, run);
		this.tail = next.catch(() => {});
		return next;
	}
	private async writable(key: TaskKey, scopeId: string): Promise<Scope> {
		const scope = await this.scope(key, scopeId);
		if (!canMergeInto(scope)) throw new Error('Add the repo to the task before merging.');
		if ((await this.sessions.activity(key)).busy)
			throw new Error('Wait for the agent to finish before merging.');
		return scope;
	}
	private async records(key: TaskKey): Promise<Record<string, MergeRecord>> {
		return readMergeRecords(await SessionStore.at(this.dataDir), key);
	}
	private async remember(key: TaskKey, scopeId: string, record: MergeRecord | null) {
		await rememberMerge(await SessionStore.at(this.dataDir), key, scopeId, record);
	}
	/** After every tree change the task's diff is recomputed, as after a commit. */
	private checkpoint(key: TaskKey) {
		return this.sessions.command(key, { kind: 'checkpoint' }).catch(() => {});
	}
	async preview(key: TaskKey, scopeId: string, into: string, from: string): Promise<MergePreview> {
		return previewMerge(await this.scope(key, scopeId), into, from);
	}
	async merge(key: TaskKey, scopeId: string, into: string, from: string): Promise<MergeOutcome> {
		return this.serial(async () => {
			const scope = await this.writable(key, scopeId),
				outcome = await startMerge(scope, into, from);
			if (outcome.status === 'conflicts')
				await this.remember(key, scopeId, {
					from,
					into,
					conflicts: await unmergedPaths(scope),
					agent: [],
				});
			if (outcome.status !== 'up-to-date') await this.checkpoint(key);
			return outcome;
		});
	}
	/**
	 * spec/appearance#evolution-redesign: the record of the conflict in progress — what conflicted, how each file was resolved, which files the
	 * agent took. A rebase starts a new record on each commit; a merge started in the terminal gets one on first read.
	 */
	private async record(key: TaskKey, scope: Scope): Promise<MergeRecord | null> {
		const kind = await conflictKind(scope);
		if (!kind) return null;
		const saved = (await this.records(key))[scope.id],
			rebase = kind === 'rebase' ? await rebaseInfo(scope) : null,
			unmerged = await unmergedPaths(scope);
		if (saved && (!rebase || saved.step === rebase.step.current))
			return { ...saved, conflicts: [...new Set([...saved.conflicts, ...unmerged])].sort() };
		return {
			from: rebase?.onto ?? saved?.from ?? (await mergeSource(scope)) ?? 'MERGE_HEAD',
			into: rebase?.branch ?? saved?.into ?? (await currentBranch(scope)) ?? 'HEAD',
			conflicts: unmerged,
			agent: [],
			...(rebase ? { step: rebase.step.current } : {}),
		};
	}
	async state(key: TaskKey, scopeId: string): Promise<MergeState | null> {
		const scope = await this.scope(key, scopeId);
		const kind = await conflictKind(scope);
		if (!kind) return null;
		const record = (await this.record(key, scope))!,
			rebase = kind === 'rebase' ? await rebaseInfo(scope) : null;
		const task = await (await SessionStore.at(this.dataDir)).task(key);
		const busy = Boolean(record.pending?.length) && (await this.sessions.activity(key)).busy;
		const pending = new Set(record.pending ?? []);
		const files = await conflictFiles(scope, record.conflicts, record.agent, kind === 'rebase');
		return {
			scopeId,
			from: record.from,
			into: record.into,
			kind,
			...(rebase ? { step: rebase.step } : {}),
			head:
				rebase?.head ??
				(await gitText(scope.path, ['rev-parse', '--short=7', 'HEAD']).catch(() => '')),
			agentRunning: busy,
			conflicts: files.map((file) => {
				const resolution = file.resolved ? record.resolutions?.[file.path] : undefined;
				const agent =
					file.resolved || !file.byAgent
						? undefined
						: pending.has(file.path) && busy
							? ('running' as const)
							: pending.has(file.path) && file.places > 0
								? ('failed' as const)
								: file.places === 0 && !file.deleted
									? ('review' as const)
									: undefined;
				return { ...file, ...(resolution ? { resolution } : {}), ...(agent ? { agent } : {}) };
			}),
			clean: await mergedCleanly(scope, record.conflicts),
			external: scope.kind === 'external' && task.launch?.isolation === 'worktree',
		};
	}
	/** spec/appearance#evolution-redesign: every repo of the task with a merge or rebase that stopped — the banner in Changes reads it from git. */
	async states(key: TaskKey): Promise<MergeState[]> {
		const scopes = (await this.taskScopes(key)).filter(
			(scope) => isGitScope(scope) && scope.available !== false && canMergeInto(scope)
		);
		const states = await Promise.all(
			scopes.map((scope) => this.state(key, scope.id).catch(() => null))
		);
		return states.filter((state): state is MergeState => state !== null);
	}
	/**
	 * A file of a conflict may change while the agent resolves others (spec/appearance#evolution-redesign: «the rest lives»); a file the agent
	 * holds may not. Other writes wait for the agent as before.
	 */
	private async fileWritable(key: TaskKey, scopeId: string, path: string) {
		const scope = await this.scope(key, scopeId);
		if (!canMergeInto(scope)) throw new Error('Add the repo to the task before merging.');
		const record = await this.record(key, scope);
		if ((await this.sessions.activity(key)).busy) {
			if (!record?.pending?.length || record.pending.includes(path))
				throw new Error('Wait for the agent to finish before merging.');
		}
		return { scope, record, swap: (await conflictKind(scope)) === 'rebase' };
	}
	/** Remembers how a file was resolved (or forgets it, for Back to the conflict); the agent no longer holds it. */
	private async note(
		key: TaskKey,
		scope: Scope,
		path: string,
		resolution: ConflictResolution | null
	) {
		const record = await this.record(key, scope);
		if (!record) return;
		const resolutions = { ...record.resolutions };
		if (resolution) resolutions[path] = resolution;
		else delete resolutions[path];
		await this.remember(key, scope.id, {
			...record,
			conflicts: [...new Set([...record.conflicts, path])].sort(),
			resolutions,
			agent: resolution ? record.agent : record.agent.filter((item) => item !== path),
			pending: (record.pending ?? []).filter((item) => item !== path),
		});
	}
	async take(key: TaskKey, scopeId: string, path: string, take: 'ours' | 'theirs' | 'both') {
		return this.serial(async () => {
			const { scope, swap } = await this.fileWritable(key, scopeId, path);
			const done = await resolveWith(scope, path, swapSide(take, swap));
			await this.note(
				key,
				scope,
				path,
				done === 'kept' || done === 'deleted'
					? done
					: done === 'both'
						? 'merged'
						: swapSide(done, swap) === 'ours'
							? 'yours'
							: 'theirs'
			);
			await this.checkpoint(key);
			return this.state(key, scopeId);
		});
	}
	/** Accept of the agent's result in the list (or a file resolved by hand in the editor). */
	async resolved(key: TaskKey, scopeId: string, path: string) {
		return this.serial(async () => {
			const { scope } = await this.fileWritable(key, scopeId, path);
			await markResolved(scope, path);
			await this.note(key, scope, path, 'merged');
			await this.checkpoint(key);
			return this.state(key, scopeId);
		});
	}
	/** spec/appearance#evolution-redesign: the texts of the three columns. */
	async texts(key: TaskKey, scopeId: string, path: string): Promise<ConflictTexts> {
		const scope = await this.scope(key, scopeId);
		const record = await this.record(key, scope);
		const texts = await conflictTexts(scope, path, (await conflictKind(scope)) === 'rebase');
		return { ...texts, byAgent: Boolean(record?.agent.includes(path)) };
	}
	/** `Apply` of the merge view: the Result is the file, resolved. */
	async apply(key: TaskKey, scopeId: string, path: string, text: string) {
		return this.serial(async () => {
			const { scope } = await this.fileWritable(key, scopeId, path);
			await applyResolution(scope, path, text);
			await this.note(key, scope, path, 'merged');
			await this.checkpoint(key);
			return this.state(key, scopeId);
		});
	}
	/** `Back to the conflict` (`git checkout -m`): the file is open again, and the agent's mark on it goes. */
	async reopen(key: TaskKey, scopeId: string, path: string) {
		return this.serial(async () => {
			const { scope } = await this.fileWritable(key, scopeId, path);
			await reopenConflict(scope, path);
			await this.note(key, scope, path, null);
			await this.checkpoint(key);
			return this.state(key, scopeId);
		});
	}
	async finish(key: TaskKey, scopeId: string): Promise<MergeOutcome> {
		return this.serial(async () => {
			const scope = await this.writable(key, scopeId),
				outcome = await finishMerge(scope);
			// A rebase that stopped on the next commit keeps its dialog; its record starts again from git.
			await this.remember(key, scopeId, null);
			await this.checkpoint(key);
			return outcome;
		});
	}
	async abort(key: TaskKey, scopeId: string) {
		return this.serial(async () => {
			await abortMerge(await this.writable(key, scopeId));
			await this.remember(key, scopeId, null);
			await this.checkpoint(key);
		});
	}
	/**
	 * The agent resolves only when the person asks; the merge commit stays with the person. spec/appearance#evolution-redesign:
	 * `paths` — the files the person gave the agent (a row, the selection, a manual merge); without them, all with conflict places.
	 */
	async askAgent(key: TaskKey, scopeId: string, paths?: string[] | null) {
		return this.serial(async () => {
			await this.sessions.command(key, {
				kind: 'prompt',
				text: await this.handOver(key, scopeId, paths ?? undefined),
			});
		});
	}
	/** `Stop` of the agent's banner: the turn ends; files it did not finish are plain conflicts again. */
	async stopAgent(key: TaskKey, scopeId: string) {
		const scope = await this.scope(key, scopeId);
		await this.sessions.command(key, { kind: 'cancel' }).catch(() => {});
		return this.serial(async () => {
			const record = await this.record(key, scope);
			if (!record) return null;
			const files = await conflictFiles(scope, record.pending ?? []);
			const unfinished = new Set(files.filter((file) => file.places > 0).map((file) => file.path));
			await this.remember(key, scopeId, {
				...record,
				pending: [],
				agent: record.agent.filter((path) => !unfinished.has(path)),
			});
			return this.state(key, scopeId);
		});
	}
	/** spec/pull-requests-and-ci#resolve-conflicts: the same hand-over without sending: a task that has no agent yet starts with this prompt. */
	async agentPrompt(key: TaskKey, scopeId: string) {
		return this.serial(() => this.handOver(key, scopeId));
	}
	/** Files the agent takes are marked as resolved by the agent; the prompt names them. Text conflicts only (spec/overview#states-and-platforms). */
	private async handOver(key: TaskKey, scopeId: string, only?: string[]) {
		const scope = await this.writable(key, scopeId),
			record = await this.record(key, scope);
		const paths = (await conflictFiles(scope, await unmergedPaths(scope)))
			.filter((file) => file.places > 0 && !file.deleted && (!only || only.includes(file.path)))
			.map((file) => file.path);
		if (!paths.length) throw new Error('No conflict places are left.');
		const from = record?.from ?? 'MERGE_HEAD',
			into = record?.into ?? (await currentBranch(scope)) ?? 'HEAD';
		await this.remember(key, scopeId, {
			...(record ?? { conflicts: paths, agent: [] }),
			from,
			into,
			agent: [...new Set([...(record?.agent ?? []), ...paths])],
			pending: paths,
		});
		return mergeResolvePrompt({ repo: scope.name, from, into, paths });
	}
	/** One file's diff of a commit, by the same engine as the task's diff, so the tab looks the same. */
	async file(key: TaskKey, scopeId: string, sha: string, fileId: string): Promise<FileDiff> {
		const scope = await this.scope(key, scopeId);
		const files = this.files.get(`${scopeId}/${sha}`) ?? (await this.commit(key, scopeId, sha));
		const file = files.files.find((item) => item.id === fileId);
		if (!file) throw new Error('File is unavailable');
		const [before, after] = await readBlobs(scope, [file.before, file.after]);
		const base = {
			file,
			beforeText: before!.text,
			afterText: after!.text,
			lines: [],
			pairs: [],
			binary: before!.binary || after!.binary,
			tooLarge: before!.tooLarge || after!.tooLarge,
			baseLabel: `${sha.slice(0, 7)}^`,
			afterLabel: sha.slice(0, 7),
		};
		if (file.gitlink || base.binary || base.tooLarge) return base;
		const diff = await this.changes.compute<Pick<FileDiff, 'lines' | 'pairs' | 'tooLarge'>>({
			before: before!.text,
			after: after!.text,
		});
		if (diff.tooLarge) return { ...base, ...diff };
		const [beforeSyntax, afterSyntax] = await Promise.all([
			this.changes.syntax.read(file.oldPath, before!.text),
			this.changes.syntax.read(file.path, after!.text),
		]);
		return { ...base, ...diff, beforeSyntax, afterSyntax };
	}
}
