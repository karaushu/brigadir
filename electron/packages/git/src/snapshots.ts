import {
	isMainTree,
	scopeKinds,
	snapshotted,
	type ScopeKind,
	type TaskLaunch,
} from '@brigadir/core';
import { lstat, realpath } from 'node:fs/promises';
import { relative, isAbsolute, join, dirname, basename } from 'node:path';
import {
	isRecord,
	type ScopeUpdate,
	type ScopeChoice,
	type Checkpoint,
	type Scope,
	type SnapshotDocument,
	type SnapshotTree,
	type TaskKey,
} from '@brigadir/core';
import {
	SessionStore,
	readDocument,
	atomicJson,
	atomicText,
	jsonText,
	safePath,
} from '@brigadir/persistence';
import { gitText, git, isSha, GitError } from './command';
import { discoverScopes, worktreePaths, mayHaveLinkedWorktrees, gitDir } from './scopes';
import { seedIndex } from './seed-index';
import { advanceTip, checkpointRefPrefix, tipRef } from './snapshot-refs';
import type { ScopeChange } from './watch-scopes';
// The parsed and validated document, keyed by the file's stat identity. readChanges, markAddressed, relay, TaskDiffs,
// crew and History reread it, so an unchanged file (megabytes on a long task) is not parsed and validated every time.
// The file is written only through atomicJson (a new inode); stat before and after the read must match. Repo path checks
// depend on the filesystem, so they run on every read, on copies of the scopes; checkpoints are frozen and shared.
const documents = new Map<string, { identity: string; doc: Record<string, unknown> }>();
async function fileIdentity(path: string) {
	try {
		const stat = await lstat(path, { bigint: true });
		return stat.isFile()
			? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
			: null;
	} catch {
		return null;
	}
}
function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}
export async function readSnapshots(
	store: SessionStore,
	key: TaskKey
): Promise<SnapshotDocument | null> {
	const path = await safePath(await store.taskDir(key), 'snapshots.json'),
		identity = await fileIdentity(path),
		cached = documents.get(path);
	let doc: Record<string, unknown>;
	if (identity && cached?.identity === identity) {
		documents.delete(path);
		documents.set(path, cached);
		doc = cached.doc;
	} else {
		try {
			doc = await readDocument(path, 32 * 1024 * 1024);
		} catch (e) {
			if (isRecord(e) && e.code === 'ENOENT') return null;
			throw e;
		}
		validateSnapshots(doc, key);
		if (identity && identity === (await fileIdentity(path))) {
			documents.delete(path);
			documents.set(path, { identity, doc: deepFreeze(doc) });
			while (documents.size > 16) documents.delete(documents.keys().next().value!);
		}
	}
	const scopes = (doc.scopes as Record<string, unknown>[]).map((scope) => ({
		...scope,
	})) as unknown as Scope[];
	// spec/tasks#released-worktree: a released worktree is gone on purpose. Its repos read as unavailable, and `source` points at the project's
	// own repo at the same relative path, where the snapshot objects and refs live.
	const released = await store.releasedWorktree(key),
		source = released ? await realpath((await store.project(key.projectId)).path) : null;
	const project = released ? null : await store.projectForTask(key);
	const root = released ?? (await realpath(project!.path));
	for (const scope of scopes) {
		if (!outsideRoot(scope)) {
			if (scope.path !== root && !scope.path.startsWith(`${root}/`))
				throw new Error('Repo is outside the project');
			await safePath(root, relative(root, scope.path));
		}
		try {
			const actual = await realpath(scope.path);
			if (actual !== scope.path) throw new Error('Repo is outside the project');
			/* spec/projects-and-board#external-folders: a folder without git has no `.git`; its presence is the path itself. */ if (
				scope.kind === 'folder'
			) {
				scope.available = scope.available !== false;
				continue;
			}
			const dotGit = await lstat(join(scope.path, '.git'));
			scope.available = scope.available !== false && !dotGit.isSymbolicLink();
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') {
				scope.available = false;
				if (released && source && scope.kind !== 'folder' && scope.kind !== 'external') {
					const target = join(source, relative(root, scope.path));
					if (target === source || target.startsWith(`${source}/`)) scope.source = target;
				}
			} else throw error;
		}
	}
	return { ...doc, scopes } as SnapshotDocument;
}
/** spec/projects-and-board#external-folders: an external repo or a folder without git lies outside the root, so `safePath` from the root would give `../` and `unsafe_path`.
 *  Their bound is different: an absolute canonical path that `realpath` does not move. */
function outsideRoot(scope: Scope) {
	return scope.kind === 'external' || scope.kind === 'folder';
}
/** Content validation is a pure function of the document and the task key, so a cached document gets the same result. */
function validateSnapshots(doc: Record<string, unknown>, key: TaskKey) {
	const { scopes, checkpoints } = doc;
	if (!Array.isArray(scopes) || !Array.isArray(checkpoints)) throw new Error('Invalid snapshots');
	const ids = new Set<string>();
	for (const scope of scopes) {
		if (
			!isRecord(scope) ||
			typeof scope.id !== 'string' ||
			!/^[a-f0-9]{16}$/.test(scope.id) ||
			typeof scope.path !== 'string' ||
			!isAbsolute(scope.path) ||
			typeof scope.name !== 'string' ||
			!scopeKinds.includes(scope.kind as ScopeKind) ||
			!(scope.branch === null || typeof scope.branch === 'string') ||
			!(
				scope.remote === undefined ||
				scope.remote === null ||
				(typeof scope.remote === 'string' && scope.remote.length <= 4096)
			) ||
			!(scope.available === undefined || typeof scope.available === 'boolean') ||
			!(typeof scope.selected === 'boolean' || typeof scope.agentWritable === 'boolean') ||
			ids.has(scope.id)
		)
			throw new Error('Invalid repo');
		// spec/projects-and-board#repo-selection migration: the old record still reads and maps to a single `selected`.
		if (typeof scope.selected !== 'boolean') {
			scope.selected = scope.agentWritable === true;
			delete scope.agentWritable;
			delete scope.diffEnabled;
		}
		ids.add(scope.id);
	}
	for (const [i, c] of checkpoints.entries()) {
		if (
			!isRecord(c) ||
			c.id !== i ||
			typeof c.at !== 'string' ||
			!Number.isFinite(Date.parse(c.at)) ||
			![
				'baseline',
				'turn',
				'tools',
				'refresh',
				'user-before',
				'user-after',
				'quick-before',
				'quick-after',
			].includes(String(c.reason)) ||
			!Array.isArray(c.trees)
		)
			throw new Error('Invalid checkpoint');
		const seen = new Set<string>();
		for (const tree of c.trees) {
			if (
				!isRecord(tree) ||
				typeof tree.scopeId !== 'string' ||
				!ids.has(tree.scopeId) ||
				seen.has(tree.scopeId) ||
				!isSha(tree.tree) ||
				!isSha(tree.commit) ||
				typeof tree.ref !== 'string' ||
				// The task and repo tip, or a legacy per-checkpoint name. Reads go by tree/commit, not by ref.
				(tree.ref !== tipRef(key, tree.scopeId) &&
					(!tree.ref.startsWith(checkpointRefPrefix(key, tree.scopeId)) ||
						!/^(0|[1-9][0-9]*)$/.test(tree.ref.split('/').at(-1)!) ||
						Number(tree.ref.split('/').at(-1)) > i))
			)
				throw new Error('Invalid snapshot tree');
			seen.add(tree.scopeId);
		}
	}
}

// An index's path list is a pure function of its file, and git writes an index only as a new file through lock and rename.
// The same inode, mtime, ctime and size before and after the read mean the same list: the user's index, which usually does
// not change between snapshots, is not listed every time (60k files: 2.5 MB of stdout and parsing). `add -A` and
// `write-tree` rewrite our index on every capture, so its list is always fresh. Stat unreadable — no cache.
const listings = new Map<string, { stat: string; names: Set<string> }>(),
	listingBytes = 256 * 1024 * 1024;
async function indexStat(file: string) {
	try {
		const stat = await lstat(file, { bigint: true });
		return stat.isFile()
			? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
			: null;
	} catch {
		return null;
	}
}
async function trackedNames(cwd: string, file: string | null): Promise<Set<string>> {
	const key = `${cwd}\0${file}`,
		before = file ? await indexStat(file) : null,
		hit = listings.get(key);
	if (before && hit?.stat === before) {
		listings.delete(key);
		listings.set(key, hit);
		return hit.names;
	}
	// Up to 500k+ paths: a 32 MB limit would break capture of a large monorepo.
	const names = new Set(
		(await git(cwd, ['ls-files', '--cached', '-z'], { maxBytes: listingBytes }))
			.toString('utf8')
			.split('\0')
	);
	if (before && before === (await indexStat(file!))) {
		listings.delete(key);
		listings.set(key, { stat: before, names });
		while (listings.size > 16) listings.delete(listings.keys().next().value!);
	} else listings.delete(key);
	return names;
}
/** spec/projects-and-board#external-folders: an external repo or a folder without git comes from the task's selection, since discovery sees only the root. */
async function launchExtras(launch: TaskLaunch | undefined): Promise<Scope[]> {
	const extras: Scope[] = [];
	for (const choice of launch?.scopes ?? []) {
		if ((choice.kind !== 'external' && choice.kind !== 'folder') || !choice.path) continue;
		const present = await lstat(choice.path).then(
			() => true,
			() => false
		);
		const branch =
			choice.kind === 'external' && present
				? await gitText(choice.path, ['symbolic-ref', '--short', '-q', 'HEAD']).then(
						(value) => value.trim() || null,
						() => null
					)
				: null;
		/* The task's selection is the source of truth: one removed in the panel does not return from the previous document (spec/projects-and-board#external-folders). */ extras.push(
			{
				id: choice.id,
				path: choice.path,
				name: choice.name,
				kind: choice.kind,
				branch,
				selected: choice.selected,
				...(present ? {} : { available: false }),
			}
		);
	}
	return extras;
}
export class Snapshots {
	scopeRevision = 0;
	private tail: Promise<unknown> = Promise.resolve();
	/** The tip this instance itself wrote and consolidated, by scope; without an entry — the slow path (spec/architecture-and-platform#snapshot-refs). */
	private readonly tips = new Map<string, string>();
	private constructor(
		readonly store: SessionStore,
		readonly key: TaskKey,
		private document: SnapshotDocument
	) {}
	static async open(store: SessionStore, key: TaskKey) {
		const existing = await readSnapshots(store, key);
		// Discovery is only the seed of a new document; an existing one gains repos through capture('refresh').
		if (existing) return new Snapshots(store, key, existing);
		const project = await store.projectForTask(key),
			launch = (await store.task(key)).launch;
		const scopes = (
			await discoverScopes(
				project.path,
				launch?.isolation === 'worktree'
					? new Map(launch.scopes.map((scope) => [scope.name, scope.kind ?? 'nested']))
					: undefined
			)
		).map((scope) => {
			const choice = launch?.scopes.find((item) => item.name === scope.name);
			return launch ? { ...scope, selected: choice ? choice.selected : false } : scope;
		});
		return new Snapshots(store, key, {
			schemaVersion: 1,
			scopes: [...scopes, ...(await launchExtras(launch))],
			checkpoints: [],
		});
	}
	get current() {
		return this.document;
	}
	/** The caller owns host.lock. Preserve unrelated flags and managed/source identities by name. */
	setScope(update: ScopeUpdate) {
		const result = this.tail.then(async () => {
			const scope = this.document.scopes.find(
				(scope) => scope.id === update.id && scope.available !== false
			);
			if (!scope) throw new Error('Repo is unavailable');
			const task = await this.store.task(this.key);
			if (task.preparation?.state === 'preparing') throw new Error('Workspace is being prepared');
			const launch = task.launch ?? {
				isolation: 'in-place' as const,
				branch: '',
				baseRef: 'origin/main',
				setupCommand: '',
				scopes: this.document.scopes.map(({ id, name, kind, selected }) => ({
					id,
					name,
					kind,
					selected,
				})),
			};
			const existing = launch.scopes.find((choice) => choice.name === scope.name);
			const choice = {
				id: scope.id,
				name: scope.name,
				kind: scope.kind,
				...existing,
				selected: update.selected,
			};
			await this.store.updateTask(this.key, {
				launch: {
					...launch,
					scopes: [...launch.scopes.filter((item) => item.name !== scope.name), choice],
				},
			});
			return this.captureNow('refresh');
		});
		this.tail = result.catch(() => {});
		return result;
	}
	/** spec/projects-and-board#folders-mid-task: a folder from outside the root (spec/projects-and-board#external-folders) joins the task chosen, also under a running agent; `refresh` adds its scope. */
	addScope(choice: ScopeChoice) {
		const result = this.tail.then(async () => {
			if ((choice.kind !== 'external' && choice.kind !== 'folder') || !choice.path)
				throw new Error('Only a folder outside the project joins a task');
			const task = await this.store.task(this.key);
			if (task.preparation?.state === 'preparing') throw new Error('Workspace is being prepared');
			const launch = task.launch ?? {
				isolation: 'in-place' as const,
				branch: '',
				baseRef: 'origin/main',
				setupCommand: '',
				scopes: this.document.scopes.map(({ id, name, kind, selected }) => ({
					id,
					name,
					kind,
					selected,
				})),
			};
			await this.store.updateTask(this.key, {
				launch: {
					...launch,
					scopes: [
						...launch.scopes.filter((item) => item.id !== choice.id),
						{ ...choice, selected: true },
					],
				},
			});
			const scope = this.document.scopes.find((item) => item.id === choice.id);
			if (scope) scope.selected = true;
			return this.captureNow('refresh');
		});
		this.tail = result.catch(() => {});
		return result;
	}
	/** `scopeIds`: an explicit file write changes one repo; the other scopes take the previous checkpoint's tree.
	 *  A scope without such a tree, `refresh` and `baseline` are captured in full. */
	capture(
		reason: Checkpoint['reason'],
		options: { scopeIds?: readonly string[] | undefined; discover?: false } = {}
	): Promise<Checkpoint | null> {
		const result = this.tail.then(() =>
			this.captureNow(reason, options.scopeIds, options.discover !== false)
		);
		this.tail = result.catch(() => {});
		return result;
	}
	/** A watcher event → `refresh` parameters. A HEAD change of known repos only — no discovery; anything else — a full refresh. */
	refreshOptions(change: ScopeChange): { scopeIds?: string[]; discover?: false } {
		const ids = change.heads.map(
			(path) => this.document.scopes.find((scope) => scope.path === path)?.id
		);
		return change.discover || !ids.length || !ids.every(Boolean)
			? {}
			: { scopeIds: ids as string[], discover: false };
	}
	/** The deepest repo containing the file; `undefined` — capture all. The file or folder may not exist yet. */
	async scopesFor(path: string): Promise<string[] | undefined> {
		if (!isAbsolute(path)) return undefined;
		let real: string | undefined,
			rest = '';
		for (let current = path; !real; current = dirname(current)) {
			try {
				real = join(await realpath(current), rest);
			} catch {
				if (dirname(current) === current) return undefined;
				rest = join(basename(current), rest);
			}
		}
		const scope = this.document.scopes
			.filter((scope) => snapshotted(scope) && real.startsWith(`${scope.path}/`))
			.sort((a, b) => b.path.length - a.path.length)[0];
		return scope ? [scope.id] : undefined;
	}
	private async captureNow(
		reason: Checkpoint['reason'],
		scopeIds?: readonly string[],
		discover = true
	) {
		let scopes = this.document.scopes.map((scope) => ({ ...scope })),
			scopesChanged = false;
		// `refresh` without discovery — a HEAD change of known repos: only their branch (as in discovery) and their trees.
		const discovering = reason === 'baseline' || (reason === 'refresh' && (discover || !scopeIds));
		if (reason === 'refresh' && !discovering)
			for (const scope of scopes)
				if (scopeIds!.includes(scope.id) && scope.available !== false && scope.kind !== 'folder') {
					const branch = await gitText(scope.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
						() => null
					);
					if (branch !== scope.branch) {
						scope.branch = branch;
						scopesChanged = true;
					}
				}
		if (discovering) {
			const launch = (await this.store.task(this.key)).launch,
				project = await this.store.projectForTask(this.key),
				found = await discoverScopes(
					project.path,
					launch?.isolation === 'worktree'
						? new Map(launch.scopes.map((scope) => [scope.name, scope.kind ?? 'nested']))
						: undefined
				),
				prior = new Map(scopes.map((scope) => [scope.id, scope]));
			const next = found.map((scope) => {
				const choice = launch?.scopes.find((item) => item.name === scope.name);
				/* spec/projects-and-board#repo-selection: a repo found after setup arrives unselected. */ return {
					...scope,
					selected: choice
						? choice.selected
						: (prior.get(scope.id)?.selected ?? isMainTree(this.key)),
					available: true,
				};
			}); /* spec/tasks#quick-tasks: the main tree sees every repo of the project. */
			for (const extra of await launchExtras(launch))
				if (!next.some((item) => item.id === extra.id))
					next.push({ ...extra, available: extra.available !== false });
			for (const scope of scopes)
				if (!next.some((item) => item.id === scope.id)) next.push({ ...scope, available: false });
			scopesChanged =
				next.length !== scopes.length ||
				next.some((scope) => {
					const before = prior.get(scope.id);
					return (
						!before ||
						Object.entries(scope).some(([key, value]) => before[key as keyof Scope] !== value)
					);
				});
			scopes = next;
		}
		const trees: SnapshotTree[] = [];
		const dir = await this.store.taskDir(this.key);
		const previous = this.document.checkpoints.at(-1);
		const id = this.document.checkpoints.length;
		const only = scopeIds && !discovering ? new Set(scopeIds) : null;
		for (const scope of scopes.filter((s) => snapshotted(s))) {
			const kept =
				only && !only.has(scope.id)
					? previous?.trees.find((t) => t.scopeId === scope.id)
					: undefined;
			if (kept) {
				trees.push(kept);
				continue;
			}
			if (outsideRoot(scope)) {
				try {
					if ((await realpath(scope.path)) !== scope.path)
						throw new Error('Repo is outside the project');
				} catch (error) {
					if (isRecord(error) && error.code === 'ENOENT') {
						scope.available = false;
						scopesChanged = true;
						continue;
					}
					throw error;
				}
			} else {
				const project = await this.store.projectForTask(this.key),
					root = await realpath(project.path);
				await safePath(root, relative(root, scope.path));
			}
			try {
				const dotGit = await lstat(join(scope.path, '.git'));
				if (dotGit.isSymbolicLink()) throw new Error('Unsafe Git directory');
			} catch (error) {
				if (isRecord(error) && error.code === 'ENOENT') {
					scope.available = false;
					scopesChanged = true;
					continue;
				}
				throw error;
			}
			const priorTree = this.document.checkpoints
				.findLast((point) => point.trees.some((tree) => tree.scopeId === scope.id))
				?.trees.find((tree) => tree.scopeId === scope.id);
			if (priorTree)
				try {
					await gitText(scope.path, ['cat-file', '-e', priorTree.commit]);
				} catch (error) {
					if (!(error instanceof GitError)) throw error;
					scope.available = false;
					scopesChanged = true;
					continue;
				}
			const index = await safePath(dir, `snap-index-${scope.id}`);
			const env = { GIT_INDEX_FILE: index };
			try {
				await lstat(index);
			} catch (e) {
				if (!isRecord(e) || e.code !== 'ENOENT') throw e;
				const head = await gitText(scope.path, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(
					() => null
				);
				if (!head || !isSha(head) || !(await seedIndex(scope.path, head, index, env)))
					await gitText(scope.path, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
			}
			const nested = scopes
				.filter((s) => s.available !== false && s.path !== scope.path && s.kind !== 'submodule')
				.map((s) => s.path);
			const locals = [
				...new Set([
					...nested,
					...((await mayHaveLinkedWorktrees(scope.path)) ? await worktreePaths(scope.path) : []),
				]),
			]
				.filter((path) => path.startsWith(`${scope.path}/`))
				.map((path) => relative(scope.path, path));
			// Git treats even excluded ignored pathspecs as explicit ignored inputs. One check-ignore answers all paths.
			let ignored = new Set<string>();
			if (locals.length)
				try {
					ignored = new Set(
						(
							await git(scope.path, ['check-ignore', '-z', '--stdin'], {
								input: locals.join('\0') + '\0',
							})
						)
							.toString('utf8')
							.split('\0')
					);
				} catch (e) {
					if (!(e instanceof GitError) || e.code !== 1) throw e;
				}
			const exclusions = locals
				.filter((local) => !ignored.has(local))
				.map((local) => `:(top,literal,exclude)${local}`);
			// Newly tracked ignored files (including an agent's force-add) must join the snapshot.
			// Read the user's tracked names, then stage their current contents only in our index.
			const userIndex = await gitDir(scope.path),
				tracked = await trackedNames(scope.path, userIndex && join(userIndex, 'index')),
				known = new Set(
					(await git(scope.path, ['ls-files', '--cached', '-z'], { env, maxBytes: listingBytes }))
						.toString('utf8')
						.split('\0')
				);
			const missing: string[] = [];
			for (const path of tracked) {
				if (!path || known.has(path)) continue;
				try {
					await lstat(join(scope.path, path));
					missing.push(path);
				} catch (e) {
					if (!isRecord(e) || e.code !== 'ENOENT') throw e;
				}
			}
			if (missing.length)
				await gitText(
					scope.path,
					['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
					{ env, input: missing.join('\0') + '\0' }
				);
			// This add writes only the task's isolated index; the user's index is never staged.
			await gitText(scope.path, ['add', '-A', '--', '.', ...exclusions], { env });
			const tree = await gitText(scope.path, ['write-tree'], { env });
			if (!isSha(tree)) throw new Error('Invalid Git tree');
			const old = previous?.trees.find((t) => t.scopeId === scope.id);
			if (old?.tree === tree) {
				trees.push(old);
				continue;
			}
			// The parent is this scope's latest snapshot (not only the previous checkpoint's), so a scope that vanished and came
			// back does not break the chain; `cat-file -e` above already checked it exists. One tip keeps the whole chain from gc.
			const parent = priorTree?.commit;
			const commit = await gitText(
				scope.path,
				['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Brigadir snapshot ${id}`],
				{
					env: {
						GIT_AUTHOR_NAME: 'Brigadir',
						GIT_AUTHOR_EMAIL: 'brigadir@localhost',
						GIT_COMMITTER_NAME: 'Brigadir',
						GIT_COMMITTER_EMAIL: 'brigadir@localhost',
					},
				}
			);
			if (!isSha(commit)) throw new Error('Invalid snapshot commit');
			const settled = await advanceTip(
				scope.path,
				this.key,
				scope.id,
				commit,
				parent,
				parent ? this.tips.get(scope.id) : null,
				(oid) =>
					this.document.checkpoints.find((point) =>
						point.trees.some((item) => item.scopeId === scope.id && item.commit === oid)
					)?.id ?? id
			);
			if (settled) this.tips.set(scope.id, commit);
			else this.tips.delete(scope.id);
			trees.push({ scopeId: scope.id, tree, commit, ref: tipRef(this.key, scope.id) });
		}
		const same =
			previous &&
			trees.length === previous.trees.length &&
			trees.every((t) => previous.trees.some((p) => p.scopeId === t.scopeId && p.tree === t.tree));
		if (!trees.length || same) {
			if (scopesChanged) {
				const document = { ...this.document, scopes };
				await atomicJson(await safePath(dir, 'snapshots.json'), document);
				this.document = document;
				this.scopeRevision++;
			}
			return previous ?? null;
		}
		const checkpoint: Checkpoint = { id, at: new Date().toISOString(), reason, trees };
		const document = {
			...this.document,
			scopes,
			checkpoints: [...this.document.checkpoints, checkpoint],
		};
		// One stringify per capture; the limit is the size of the file itself, which readSnapshots reads.
		const text = jsonText(document);
		if (Buffer.byteLength(text) > 32 * 1024 * 1024)
			throw new Error('Snapshot history exceeds its storage limit');
		await atomicText(await safePath(dir, 'snapshots.json'), text);
		this.document = document;
		if (scopesChanged) this.scopeRevision++;
		return checkpoint;
	}
}
