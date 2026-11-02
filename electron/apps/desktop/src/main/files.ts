import {
	inTask,
	newFilePath,
	filePathCandidates,
	syntaxLanguage,
	planSlug,
	type FilePathText,
	type FilePathLink,
	type FilePathCandidate,
} from '@brigadir/core';
import { homedir } from 'node:os';
import { FileTreeMetadata } from './file-tree-metadata';
import { fuzzy } from './project-files';
import type { EditorGutter, FileDiff, GutterHunk } from '@brigadir/core';
import { readSnapshots, readBlobs, git, treeBlob, viewTrees } from '@brigadir/git';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, dirname, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type {
	EditorDocument,
	FileEntry,
	FileListing,
	SaveFileResult,
	TaskKey,
} from '@brigadir/core';
import {
	Attachments,
	SessionStore,
	safePath,
	readProjectFile,
	projectFile,
	writeProjectFile,
} from '@brigadir/persistence';
import { Changes } from './changes';
import { Sessions } from './sessions';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const excluded = new Set(['.git', '.brigadir']);
/** `external` holds the project root of a read-only file outside it, such as a bundled `lib.dom.d.ts` (spec/editor-code-intelligence#typescript-features).
 *  `plan` is the copy of a plan for approval in the task folder (spec/chat-turns-plans-and-questions#plan-approval): writable, without a lease or a snapshot. */
type Resource = {
	key: TaskKey;
	root: string;
	path: string;
	kind: 'file' | 'directory';
	external?: string;
	plan?: true;
};
/** Runs `work` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await work(items[index]!);
			}
		})
	);
	return results;
}
const tildePath = (path: string) =>
	path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path;
/** spec/tasks#released-worktree: the task's worktree was removed (archive or «Remove worktree…»). Not a failure: panels show a calm empty state. */
/** The walk of a task's tree: its files and, for the `@` menu, its folders (spec/composer#mention-menu). */
type FileIndex = {
	root: string;
	entries: (FileEntry & { scope: string })[];
	directories: { name: string; path: string; scope: string }[];
	truncated: boolean;
};
/** The project-relative file behind a written path, a folder with a trailing `/` (spec/chat#folder-links), or `null`: a lexical
 *  candidate need not exist or be accessible. The project root is no target, nor a bare name of a folder (`src`, `docs`):
 *  inline code names words like that too often; `src/` or `docs/domains` is a folder. */
async function linkPath(root: string, target: string): Promise<string | null> {
	let path = isAbsolute(target)
		? relative(root, target)
		: target.replace(/^\.\//, '').replace(/\/+$/, '');
	try {
		if (isAbsolute(target) && path.split('/').includes('..'))
			path = relative(root, await realpath(target));
		if (!path || path.split('/').some((part) => excluded.has(part))) return null;
		const info = await stat(await safePath(root, path));
		return info.isFile() ? path : info.isDirectory() && target.includes('/') ? `${path}/` : null;
	} catch {
		return null;
	}
}
/** Of several targets with one tail, the one sharing the most leading folders with a resolved path; a tie is no answer. */
function nearest(paths: string[], anchors: string[]): string | null {
	const shared = (a: string, b: string) => {
		const x = a.split('/'),
			y = b.split('/');
		let n = 0;
		while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
		return n;
	};
	const [best, next] = paths
		.map((path) => ({ path, score: Math.max(0, ...anchors.map((anchor) => shared(path, anchor))) }))
		.sort((a, b) => b.score - a.score);
	return best && best.score > 0 && best.score > (next?.score ?? 0) ? best.path : null;
}
/** The comment context's refusal for a file in no repo of the task; the editor names it instead of «save or refresh». */
export const outsideTaskRepos = 'File is outside the task repos';
export class WorkspaceReleased extends Error {
	constructor() {
		super('The task worktree was removed');
		this.name = 'WorkspaceReleased';
	}
}
export class Files {
	/** Code intelligence closes its documents with the editor buffers (spec/editor-code-intelligence#server-processes); `null` is every task. */
	onClosed: (key: TaskKey | null, id: string | null) => void = () => {};
	private linkTail: Promise<unknown> = Promise.resolve();
	private linkQueued = 0;
	private treeMetadata = new FileTreeMetadata();
	private saves = new Set<Promise<unknown>>();
	get isSaving() {
		return this.saves.size > 0;
	}
	async waitForSaves() {
		await Promise.allSettled([...this.saves]);
	}
	private dirty = new Map<string, string>();
	private resources = new Map<string, Resource>();
	private leases = new Map<string, string>();
	constructor(
		readonly changes: Changes,
		readonly sessions: Sessions
	) {}
	/** spec/tasks#released-worktree: the root of the task's files; a task whose worktree was released has none, and says so instead of failing on a missing file. */
	private async root(store: SessionStore, key: TaskKey) {
		const workspace = await store.workspace(key);
		if (workspace.released) throw new WorkspaceReleased();
		return realpath(workspace.path);
	}
	private async released(key: TaskKey) {
		return (await (await SessionStore.at(this.changes.dataDir)).workspace(key)).released;
	}
	private register(resource: Resource) {
		const id = createHash('sha256')
			.update(`${name(resource.key)}\0${resource.root}\0${resource.path}`)
			.digest('hex');
		this.resources.set(id, resource);
		return id;
	}
	private registered(key: TaskKey, id: string) {
		const resource = this.resources.get(id);
		if (!resource || name(key) !== name(resource.key)) throw new Error('Unknown file');
		return resource;
	}
	private async resource(key: TaskKey, id: string) {
		const resource = this.registered(key, id);
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		if (resource.plan) {
			if ((await realpath(join(await store.taskDir(key), 'plans'))) !== resource.root)
				throw new Error('Task location changed');
			return resource;
		}
		if ((await this.root(store, key)) !== (resource.external ?? resource.root))
			throw new Error('Project location changed');
		return resource;
	}
	private async planFile(key: TaskKey, requestId: string, text: string) {
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		const dir = join(await store.taskDir(key), 'plans');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return {
			root: await realpath(dir),
			path: `${planSlug(text)}-${createHash('sha256').update(requestId).digest('hex').slice(0, 8)}.md`,
		};
	}
	/** spec/chat-turns-plans-and-questions#plan-approval: one copy per request, written once and never overwritten, then opened as an ordinary editor tab. */
	async plan(key: TaskKey, requestId: string, text: string): Promise<EditorDocument> {
		const { root, path } = await this.planFile(key, requestId, text);
		try {
			const handle = await open(join(root, path), 'wx', 0o600);
			try {
				await handle.writeFile(text.endsWith('\n') ? text : `${text}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		return this.read(key, this.register({ key, root, path, kind: 'file', plan: true }));
	}
	/** spec/chat-turns-plans-and-questions#plan-approval: the copy's text while the request lives (`null` before anybody opens it) and where it lives. */
	async planText(
		key: TaskKey,
		requestId: string,
		text: string
	): Promise<{ text: string | null; path: string }> {
		const { root, path } = await this.planFile(key, requestId, text),
			shown = tildePath(join(root, path));
		try {
			const content = await readProjectFile(root, path);
			return { text: content.state === 'text' ? content.text : null, path: shown };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, path: shown };
			throw error;
		}
	}
	/**
	 * spec/task-window-workspace#restore-window: the path `surface.json` keeps for a file tab — inside the task's root; `null` for a file this app cannot reopen
	 * by path after a restart (outside the project, a plan copy) or an id it does not know.
	 */
	surfacePath(key: TaskKey, id: string): string | null {
		const resource = this.resources.get(id);
		if (!resource || name(key) !== name(resource.key) || resource.kind !== 'file') return null;
		return resource.external || resource.plan ? null : resource.path;
	}
	/** spec/task-window-workspace#restore-window: a stored file tab's id again — the same opaque id as before the restart, for a file that is still there. */
	async surfaceId(key: TaskKey, path: string): Promise<string | null> {
		if (path.split('/').some((part) => excluded.has(part))) return null;
		const store = await SessionStore.at(this.changes.dataDir);
		try {
			const root = await this.root(store, key);
			if (!(await stat(await safePath(root, path))).isFile()) return null;
			return this.register({ key, root, path, kind: 'file' });
		} catch {
			return null;
		}
	}
	/** Absolute file behind an opaque ID for the code-intelligence bridge; the renderer never sees it. */
	async codeTarget(key: TaskKey, id: string) {
		const resource = await this.resource(key, id);
		if (resource.kind !== 'file') throw new Error('Not a file');
		const absolute = resource.external
			? join(resource.root, resource.path)
			: await safePath(resource.root, resource.path);
		const owner = this.leases.get(absolute);
		return {
			absolute,
			projectRoot: resource.external ?? resource.root,
			readOnly: Boolean(resource.external),
			locked: !resource.external && !resource.plan && owner !== undefined && owner !== name(key),
		};
	}
	/** Registers a language-server location: inside the project as usual, outside it as read-only. */
	async locate(
		key: TaskKey,
		absolute: string
	): Promise<{ id: string; path: string; readOnly: boolean; absolute: string } | null> {
		const store = await SessionStore.at(this.changes.dataDir);
		let root: string;
		try {
			root = await this.root(store, key);
		} catch (error) {
			if (error instanceof WorkspaceReleased) return null;
			throw error;
		}
		let real: string;
		try {
			real = await realpath(absolute);
			if (!(await stat(real)).isFile()) return null;
		} catch {
			return null;
		}
		const path = relative(root, real);
		if (path && !path.startsWith('..') && !isAbsolute(path)) {
			if (path.split('/').some((part) => excluded.has(part))) return null;
			return {
				id: this.register({ key, root, path, kind: 'file' }),
				path,
				readOnly: false,
				absolute: real,
			};
		}
		return {
			id: this.register({
				key,
				root: dirname(real),
				path: basename(real),
				kind: 'file',
				external: root,
			}),
			path: tildePath(real),
			readOnly: true,
			absolute: real,
		};
	}
	/** Same-language files of the task's project for the fallback (spec/editor-code-intelligence#fallback-mode): the Open Quickly walk over every repo. */
	async codeFiles(key: TaskKey, language: string) {
		if (await this.released(key)) return [];
		const store = await SessionStore.at(this.changes.dataDir);
		const root = await this.root(store, key);
		return (await this.index(key, false, true)).entries
			.filter((entry) => syntaxLanguage(entry.path) === language)
			.map((entry) => join(root, entry.path));
	}
	links(key: TaskKey, texts: FilePathText[]): Promise<FilePathLink[][]> {
		if (this.linkQueued >= 12) return Promise.reject(new Error('File link queue is full'));
		this.linkQueued++;
		const result = this.linkTail
			.catch(() => {})
			.then(async () => {
				const store = await SessionStore.at(this.changes.dataDir);
				await store.task(key);
				if ((await store.workspace(key)).released) return texts.map(() => []);
				const root = await this.root(store, key),
					rows: { candidate: FilePathCandidate; path: string | null }[][] = [];
				let checked = 0;
				for (const text of texts) {
					const row: (typeof rows)[number] = [];
					for (const candidate of filePathCandidates(text.text, text.literal)) {
						if (checked >= 64) break;
						if (candidate.from < (row.findLast((item) => item.path)?.candidate.to ?? 0)) continue;
						checked++;
						row.push({ candidate, path: await linkPath(root, candidate.path) });
					}
					rows.push(row);
				}
				// spec/chat#path-tails: the tail of a path (`Header/index.tsx`, `AsidePanel.tsx:161`) is one file or folder of the walk; of
				// several, the one nearest to the paths of this batch that did resolve. A tie or an absolute path stays text.
				// spec/chat#folder-links: a folder links only when the walk has it, so Files can show it (an ignored one it hides stays text).
				const folders = rows.flat().filter((item) => item.path?.endsWith('/')),
					misses = rows
						.flat()
						.filter((item) => item.path === null && !isAbsolute(item.candidate.path));
				const names =
					misses.length || folders.length ? await this.linkNames(key).catch(() => null) : null;
				for (const item of folders) {
					const path = item.path!.slice(0, -1);
					if (!names?.get(basename(path))?.includes(item.path!)) item.path = null;
				}
				if (names) {
					const anchors = rows.flat().flatMap((item) => (item.path ? [item.path] : []));
					const tails = misses.map((item) => {
						const written = item.candidate.path.replace(/^\.\//, ''),
							tail = written.replace(/\/+$/, ''),
							folder = written !== tail;
						return {
							item,
							found: tail
								? (names.get(basename(tail)) ?? []).filter(
										(path) =>
											(path.endsWith('/') ? written.includes('/') : !folder) &&
											(path.replace(/\/$/, '') === tail ||
												path.replace(/\/$/, '').endsWith(`/${tail}`))
									)
								: [],
						};
					});
					for (const { item, found } of tails)
						if (found.length === 1) {
							item.path = found[0]!;
							anchors.push(item.path);
						}
					for (const { item, found } of tails)
						if (found.length > 1) item.path = nearest(found, anchors);
				}
				return rows.map((row) => {
					const links: FilePathLink[] = [];
					for (const { candidate, path: target } of row) {
						if (target === null || candidate.from < (links.at(-1)?.to ?? 0)) continue;
						if (!target.endsWith('/')) {
							links.push({
								...candidate,
								path: target,
								id: this.register({ key, root, path: target, kind: 'file' }),
							});
							continue;
						}
						// The IDs Files gives these folders, so the tree expands down to the link (spec/chat#folder-links).
						const path = target.slice(0, -1),
							parts = path.split('/'),
							parents = parts.slice(0, -1).map((_, i) =>
								this.register({
									key,
									root,
									path: parts.slice(0, i + 1).join('/'),
									kind: 'directory',
								})
							);
						links.push({
							...candidate,
							path,
							id: this.register({ key, root, path, kind: 'directory' }),
							folder: { parents },
						});
					}
					return links;
				});
			})
			.finally(() => {
				this.linkQueued--;
			});
		this.linkTail = result;
		return result;
	}
	/** Names of the walk for path tails: files, and folders with a trailing `/`. Kept for 30 s, not the index's 5, so a long
	 *  transcript does not walk the tree per block. */
	private linkNameCache = new Map<
		string,
		{ at: number; promise: Promise<Map<string, string[]>> }
	>();
	private linkNames(key: TaskKey) {
		const id = name(key),
			cached = this.linkNameCache.get(id);
		if (cached && Date.now() - cached.at <= 30000) return cached.promise;
		const promise = this.index(key, false).then((index) => {
			const names = new Map<string, string[]>();
			const add = (name: string, path: string) => {
				const list = names.get(name);
				if (list) list.push(path);
				else names.set(name, [path]);
			};
			for (const entry of index.entries) add(entry.name, entry.path);
			for (const folder of index.directories) add(folder.name, `${folder.path}/`);
			return names;
		});
		this.linkNameCache.set(id, { at: Date.now(), promise });
		if (this.linkNameCache.size > 5)
			this.linkNameCache.delete(this.linkNameCache.keys().next().value!);
		promise.catch(() => {
			if (this.linkNameCache.get(id)?.promise === promise) this.linkNameCache.delete(id);
		});
		return promise;
	}
	async compare(key: TaskKey, id: string, text: string) {
		const resource = await this.resource(key, id);
		const disk = await readProjectFile(resource.root, resource.path);
		if (
			disk.state !== 'text' ||
			Buffer.byteLength(text) > 2 * 1024 * 1024 ||
			Buffer.byteLength(disk.text) > 2 * 1024 * 1024
		)
			return { lines: [], pairs: [], tooLarge: true };
		return this.changes.compute<Pick<FileDiff, 'lines' | 'pairs' | 'tooLarge'>>({
			before: disk.text,
			after: text,
		});
	}
	/** spec/editor#change-marks: base text per open file and base trees; a new snapshot or base setting reads it once more. */
	private gutterBases = new Map<
		string,
		{ trees: string; text: string | null; state: 'text' | 'none' | 'too-large' }
	>();
	/** The buffer's hunks against the base setting (spec/diff-and-review#diff-base): the task's first snapshot, or HEAD. The range chosen in the
	 *  diff panel is not the gutter's (spec/editor#change-marks). A file neither tree holds (ignored, outside snapshots) has no gutter. */
	async gutter(key: TaskKey, id: string, text: string): Promise<EditorGutter> {
		const resource = await this.resource(key, id);
		if (resource.kind !== 'file') return { state: 'none' };
		const store = await SessionStore.at(this.changes.dataDir),
			doc = await readSnapshots(store, key),
			latest = doc?.checkpoints.at(-1);
		if (!doc || !latest) return { state: 'none' };
		const absolute = join(resource.root, resource.path),
			scope = doc.scopes
				.filter(
					(s) =>
						s.available !== false &&
						inTask(s) &&
						absolute.startsWith(s.path + '/') &&
						latest.trees.some((tree) => tree.scopeId === s.id)
				)
				.sort((a, b) => b.path.length - a.path.length)[0];
		if (!scope) return { state: 'none' };
		const base = this.changes.baseFor(key),
			trees = await viewTrees(doc, scope, base === 'head' ? 'head' : undefined);
		if (!trees) return { state: 'none' };
		const path = relative(scope.path, absolute),
			cacheKey = `${name(key)}/${id}`,
			treesKey = `${base}/${trees.old}/${trees.next}/${resource.path}`;
		let cached = this.gutterBases.get(cacheKey);
		if (cached?.trees !== treesKey) {
			const [old, current] = await Promise.all([
				treeBlob(scope, trees.old, path),
				treeBlob(scope, trees.next, path),
			]);
			const blob = old ? (await readBlobs(scope, [old]))[0]! : null;
			cached = {
				trees: treesKey,
				text: blob && !blob.binary && !blob.tooLarge ? blob.text : old ? null : '',
				state: (!old && !current) || blob?.binary ? 'none' : blob?.tooLarge ? 'too-large' : 'text',
			};
			this.gutterBases.delete(cacheKey);
			this.gutterBases.set(cacheKey, cached);
			while (this.gutterBases.size > 64)
				this.gutterBases.delete(this.gutterBases.keys().next().value!);
		}
		if (cached.state !== 'text' || cached.text === null)
			return { state: cached.state === 'text' ? 'none' : cached.state };
		const result = await this.changes.compute<{ hunks: GutterHunk[]; tooLarge: boolean }>({
			hunks: true,
			before: cached.text,
			after: text,
		});
		return result.tooLarge
			? { state: 'too-large' }
			: {
					state: 'ready',
					base,
					...(trees.head !== undefined ? { head: trees.head } : {}),
					hunks: result.hunks,
					target: { scopeId: scope.id, path },
				};
	}
	async syntax(key: TaskKey, id: string, text: string) {
		const resource = await this.resource(key, id);
		if (resource.kind !== 'file') throw new Error('Not a file');
		return this.changes.syntax.read(resource.path, text, 'view', `${name(key)}/${id}`);
	}
	async commentContext(key: TaskKey, id: string, version: string) {
		const resource = await this.resource(key, id);
		const content = await readProjectFile(resource.root, resource.path);
		if (content.state !== 'text' || content.version !== version)
			throw new Error('File version changed');
		const store = await SessionStore.at(this.changes.dataDir);
		const snapshots = await readSnapshots(store, key);
		if (!snapshots) throw new Error('No snapshot');
		const absolute = join(resource.root, resource.path);
		const scope = snapshots.scopes
			.filter((s) => absolute.startsWith(s.path + '/'))
			.sort((a, b) => b.path.length - a.path.length)[0];
		if (!scope || !inTask(scope)) throw new Error(outsideTaskRepos);
		const tree = snapshots.checkpoints.at(-1)?.trees.find((t) => t.scopeId === scope.id);
		if (!tree) throw new Error('No snapshot');
		const path = relative(scope.path, absolute);
		const entry = (
			await git(scope.path, ['--literal-pathspecs', 'ls-tree', '-z', tree.tree, '--', path])
		).toString('utf8');
		const match = /^100(?:644|755) blob ([a-f0-9]+)\t([\s\S]*)\0$/.exec(entry);
		if (!match || match[2] !== path) throw new Error('No file snapshot');
		const blob = match[1]!;
		const saved = (await readBlobs(scope, [blob]))[0]!;
		if (saved.tooLarge || saved.binary || saved.text !== content.text)
			throw new Error('Refresh the file snapshot');
		return { scopeId: scope.id, path, blob, text: content.text };
	}
	async list(key: TaskKey, directoryId: string | null, showIgnored = false): Promise<FileListing> {
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		if ((await store.workspace(key)).released)
			return { entries: [], truncated: false, released: true };
		const scopes = (await readSnapshots(store, key))?.scopes ?? [];
		// spec/appearance#evolution-redesign: a repo is a root of the tree; `scope:<id>` reads its folder — inside the task's root by the same
		// ids as a walk from the root, outside it (a folder added from elsewhere) as a read-only root of its own.
		const directory: Resource = directoryId?.startsWith('scope:')
			? await this.scopeFolder(store, key, scopes, directoryId.slice('scope:'.length))
			: directoryId
				? await this.resource(key, directoryId)
				: { key, root: await this.root(store, key), path: '', kind: 'directory' as const };
		if (directory.kind !== 'directory') throw new Error('Not a directory');
		const absolute = await safePath(directory.root, directory.path);
		const all = (await readdir(absolute, { withFileTypes: true })).filter(
			(e) => !excluded.has(e.name)
		);
		const metadata = await this.treeMetadata.read(
			absolute,
			all.map((entry) => entry.name)
		);
		const children = all.filter(
			(entry) =>
				showIgnored ||
				!metadata.ignored.has(entry.name) ||
				scopes.some(
					(scope) =>
						scope.path === join(absolute, entry.name) ||
						scope.path.startsWith(join(absolute, entry.name) + '/')
				)
		);
		children.sort(
			(a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
		);
		const entries: FileEntry[] = children.slice(0, 5000).map((e) => {
			const path = directory.path ? `${directory.path}/${e.name}` : e.name;
			const kind =
				e.isSymbolicLink() || (!e.isFile() && !e.isDirectory())
					? 'unavailable'
					: e.isDirectory()
						? 'directory'
						: 'file';
			const id =
				kind === 'unavailable'
					? createHash('sha256').update(path).digest('hex')
					: this.register({
							key,
							root: directory.root,
							path,
							kind,
							...(directory.external ? { external: directory.external } : {}),
						});
			const scope = scopes.find((scope) => scope.path === join(absolute, e.name));
			return {
				id,
				name: e.name,
				path,
				kind,
				...(metadata.ignored.has(e.name) ? { ignored: true } : {}),
				...(metadata.statuses.has(e.name) ? { status: metadata.statuses.get(e.name)! } : {}),
				...(scope ? { scopeName: scope.name, scopeKind: scope.kind } : {}),
			};
		});
		return { entries, truncated: children.length > 5000 };
	}
	/** The folder of a repo of the task as a directory resource (spec/appearance#evolution-redesign). */
	private async scopeFolder(
		store: SessionStore,
		key: TaskKey,
		scopes: { id: string; path: string }[],
		id: string
	): Promise<Resource> {
		const scope = scopes.find((item) => item.id === id);
		if (!scope) throw new Error('Unknown repo');
		const root = await this.root(store, key),
			path = await realpath(scope.path),
			inside = relative(root, path);
		return inside && !inside.startsWith('..') && !isAbsolute(inside)
			? { key, root, path: inside, kind: 'directory' }
			: { key, root: path, path: '', kind: 'directory', external: root };
	}
	/** spec/search-menus-and-commands#search-tabs: what Text searches — the files of the Files tab (gitignore, every repo root), with the root their paths start from. */
	async textFiles(key: TaskKey) {
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		if ((await store.workspace(key)).released) return { root: '', entries: [], truncated: false };
		const root = await this.root(store, key),
			index = await this.index(key, false);
		return {
			root,
			entries: index.entries.map((entry) => ({
				id: entry.id,
				path: entry.path,
				scope: entry.scope,
			})),
			truncated: index.truncated,
		};
	}
	private indexes = new Map<string, { at: number | null; promise: Promise<FileIndex> }>();
	/** spec/composer#mention-menu: `folders` — the `@` menu also finds the folders of the walk, ranked with the files; ⌘⇧O and Search Everywhere list files. */
	async search(key: TaskKey, query: string, showIgnored = false, folders = false) {
		const index = await this.index(key, showIgnored);
		const needle = query.toLocaleLowerCase().trim();
		// The same order as the `@` menu of the New task sheet: a match in the file name before one only in its folders (spec/composer#mention-menu).
		const score = (path: string) => fuzzy(path.toLocaleLowerCase(), needle) ?? Infinity;
		const directories = folders
			? index.directories.map(({ name, path, scope }): FileEntry & { scope: string } => ({
					id: this.register({ key, root: index.root, path, kind: 'directory' }),
					name,
					path,
					kind: 'directory',
					scope,
				}))
			: [];
		return {
			entries: [...index.entries, ...directories]
				.map((entry) => ({ entry, score: score(entry.path) }))
				.filter((row) => Number.isFinite(row.score))
				.sort((a, b) => a.score - b.score || a.entry.path.localeCompare(b.entry.path))
				.slice(0, 100)
				.map((row) => row.entry),
			truncated: index.truncated,
		};
	}
	/** `allRepos` keeps repos outside the task: code navigation reads them and writes nothing (spec/editor-code-intelligence#fallback-mode). */
	private index(key: TaskKey, showIgnored: boolean, allRepos = false) {
		const id = `${name(key)}/${showIgnored}/${allRepos}`;
		const cached = this.indexes.get(id);
		// A walk in flight is shared, and its age counts from completion: a long walk never starts a second one.
		if (cached && (cached.at === null || Date.now() - cached.at <= 5000)) return cached.promise;
		const entry: { at: number | null; promise: Promise<FileIndex> } = {
			at: null,
			promise: this.walk(key, showIgnored, allRepos),
		};
		this.indexes.set(id, entry);
		if (this.indexes.size > 5) this.indexes.delete(this.indexes.keys().next().value!);
		entry.promise.then(
			() => {
				entry.at = Date.now();
			},
			() => {
				if (this.indexes.get(id) === entry) this.indexes.delete(id);
			}
		);
		return entry.promise;
	}
	/**
	 * The same entries `list` would show, level by level: one snapshot read for the walk, repository roots from `.git`
	 * entries instead of a `rev-parse` per directory, and one `check-ignore` per repository per level.
	 */
	private async walk(key: TaskKey, showIgnored: boolean, allRepos: boolean): Promise<FileIndex> {
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		if ((await store.workspace(key)).released)
			return { root: '', entries: [], directories: [], truncated: false };
		const root = await this.root(store, key),
			known = (await readSnapshots(store, key))?.scopes ?? [],
			scopes = (await this.changes.read(key)).scopes;
		type Directory = { path: string; absolute: string; repo: string | null };
		const entries: (FileEntry & { scope: string })[] = [],
			directories: FileIndex['directories'] = [];
		let truncated = false,
			visited = 0,
			level: Directory[] = [{ path: '', absolute: root, repo: await this.treeMetadata.repo(root) }];
		while (level.length && entries.length < 50000) {
			if (visited + level.length > 10000) {
				level = level.slice(0, 10000 - visited);
				truncated = true;
			}
			visited += level.length;
			const read = await mapLimit(level, 32, async (directory) => {
				try {
					const all = await readdir(directory.absolute, { withFileTypes: true });
					return {
						directory,
						repo: all.some((entry) => entry.name === '.git') ? directory.absolute : directory.repo,
						all: all.filter((entry) => !excluded.has(entry.name)),
					};
				} catch {
					truncated = true;
					return null;
				}
			});
			const listed = read.filter((value) => value !== null);
			const ignored = new Set<string>(),
				byRepo = new Map<string, typeof listed>();
			for (const item of listed)
				if (item.repo && item.all.length) {
					const group = byRepo.get(item.repo) ?? [];
					group.push(item);
					byRepo.set(item.repo, group);
				}
			await mapLimit([...byRepo], 4, async ([repo, group]) => {
				const paths = group.flatMap((item) =>
					item.all.map((entry) => relative(repo, join(item.directory.absolute, entry.name)))
				);
				// One unreadable path must not hide a whole level: fall back to the per-directory check `list` makes.
				const found = await this.treeMetadata.ignored(repo, paths).catch(async () => {
					const each = new Set<string>();
					for (const item of group) {
						const names = await this.treeMetadata
							.ignored(
								item.directory.absolute,
								item.all.map((entry) => entry.name)
							)
							.catch(() => new Set<string>());
						for (const name of names) each.add(relative(repo, join(item.directory.absolute, name)));
					}
					return each;
				});
				for (const path of found) ignored.add(join(repo, path));
			});
			const statuses = new Map<string, Map<string, NonNullable<FileEntry['status']>>>();
			for (const repo of byRepo.keys())
				statuses.set(repo, await this.treeMetadata.status(repo).catch(() => new Map()));
			const next: Directory[] = [];
			for (const { directory, repo, all } of listed) {
				const children = all.filter((entry) => {
					const absolute = join(directory.absolute, entry.name);
					return (
						showIgnored ||
						!ignored.has(absolute) ||
						known.some((scope) => scope.path === absolute || scope.path.startsWith(absolute + '/'))
					);
				});
				children.sort(
					(a, b) =>
						Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
				);
				truncated ||= children.length > 5000;
				for (const child of children.slice(0, 5000)) {
					const path = directory.path ? `${directory.path}/${child.name}` : child.name,
						absolute = join(directory.absolute, child.name);
					if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) continue;
					if (child.isDirectory()) {
						next.push({ path, absolute, repo });
						// spec/composer#mention-menu: a folder of a repo outside the task is not offered, like its files.
						const owner = scopes
							.filter((scope) => absolute === scope.path || absolute.startsWith(scope.path + '/'))
							.sort((a, b) => b.path.length - a.path.length)[0];
						if (!owner || allRepos || inTask(owner))
							directories.push({ name: child.name, path, scope: owner?.name ?? '' });
						continue;
					}
					const scope = scopes
						.filter((scope) => absolute.startsWith(scope.path + '/'))
						.sort((a, b) => b.path.length - a.path.length)[0];
					if (scope && !allRepos && !inTask(scope)) continue;
					const status = repo ? statuses.get(repo)?.get(relative(repo, absolute)) : undefined,
						snapshot = known.find((scope) => scope.path === absolute);
					entries.push({
						id: this.register({ key, root, path, kind: 'file' }),
						name: child.name,
						path,
						kind: 'file',
						...(ignored.has(absolute) ? { ignored: true } : {}),
						...(status ? { status } : {}),
						...(snapshot ? { scopeName: snapshot.name, scopeKind: snapshot.kind } : {}),
						scope: scope?.name ?? '',
					});
					if (entries.length === 50000) {
						truncated = true;
						break;
					}
				}
				if (entries.length === 50000) break;
			}
			level = next;
		}
		return { root, entries, directories, truncated: truncated || level.length > 0 };
	}
	async fromAnchor(key: TaskKey, anchor: { scopeId: string; path: string }) {
		const store = await SessionStore.at(this.changes.dataDir),
			doc = await readSnapshots(store, key),
			scope = doc?.scopes.find((scope) => scope.id === anchor.scopeId);
		if (!scope || scope.available === false) throw new Error('Repo is unavailable');
		const root = await this.root(store, key),
			path = relative(root, await safePath(scope.path, anchor.path));
		return this.read(key, this.register({ key, root, path, kind: 'file' }));
	}
	async fromDiff(key: TaskKey, fileId: string): Promise<EditorDocument> {
		const snapshot = await this.changes.read(key);
		const file = snapshot.files.find((f) => f.id === fileId);
		const scope = snapshot.scopes.find((s) => s.id === file?.scopeId);
		if (!file || !scope || file.gitlink) throw new Error('File is unavailable');
		const store = await SessionStore.at(this.changes.dataDir);
		const root = await this.root(store, key);
		const path = relative(root, join(scope.path, file.path));
		// spec/diff-and-review#scope-kinds: an external repo (spec/projects-and-board#external-folders) lies outside the root; its file opens read-only, rooted at that repo, because
		// Save writes through the task's snapshot path under the root.
		if (path.startsWith('..') || isAbsolute(path))
			return this.read(
				key,
				this.register({
					key,
					root: await realpath(scope.path),
					path: file.path,
					kind: 'file',
					external: root,
				})
			);
		return this.read(key, this.register({ key, root, path, kind: 'file' }));
	}
	/**
	 * spec/editor#new-file: «New file…» — an empty file at `path` in the task's root, with the folders it lacks, then read like a tree
	 * file. A file already there is not touched: `created` is false and the caller offers to open it. No symlink on the
	 * way (`safePath`), never `.git` / `.brigadir`, never outside the root.
	 */
	async create(
		key: TaskKey,
		path: string
	): Promise<{ created: boolean; document: EditorDocument }> {
		const checked = newFilePath(path);
		if (!checked.ok) throw new Error('Invalid file path');
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		const root = await this.root(store, key),
			absolute = await safePath(root, checked.path);
		await mkdir(dirname(absolute), { recursive: true });
		await safePath(root, checked.path);
		let created = true;
		try {
			const handle = await open(absolute, 'wx', 0o644);
			await handle.close();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (!(await stat(absolute)).isFile()) throw new Error('Not a file');
			created = false;
		}
		const document = await this.read(
			key,
			this.register({ key, root, path: checked.path, kind: 'file' })
		);
		return { created, document };
	}
	/** spec/search-menus-and-commands#search-tabs: the preview of Text reads a file without taking the editor's lease. */
	async peek(key: TaskKey, id: string) {
		const resource = await this.resource(key, id);
		if (resource.kind !== 'file') throw new Error('Not a file');
		// Security review W2 (spec/remote-access-and-mobile#phone-task-tools): a phone reads with `peek`, and an id is no secret (a hash of the task and the
		// path). Text search never peeks outside the task, so a file outside its tree (code navigation's) or a plan copy is refused.
		if (resource.external || resource.plan) throw new Error('Not a file of the task');
		return readProjectFile(resource.root, resource.path);
	}
	async read(key: TaskKey, id: string): Promise<EditorDocument> {
		const resource = await this.resource(key, id);
		if (resource.kind !== 'file') throw new Error('Not a file');
		if (resource.external || resource.plan) {
			const content = await readProjectFile(resource.root, resource.path);
			return {
				...content,
				id,
				path: tildePath(join(resource.root, resource.path)),
				locked: false,
				readOnly: !resource.plan,
			};
		}
		const content = await readProjectFile(resource.root, resource.path);
		const path = await safePath(resource.root, resource.path);
		const owner = this.leases.get(path);
		const locked = owner !== undefined && owner !== name(key);
		if (!locked && content.state === 'text') this.leases.set(path, name(key));
		return { ...content, id, path: resource.path, locked };
	}
	private stats = new Map<string, { signature: string; version: string; text: boolean }>();
	/**
	 * The open editor's poll: a `stat` answers while the file keeps its device, inode, size, mtime
	 * and ctime (nanoseconds); only then is it read and hashed, and its text crosses IPC only when `version` differs.
	 * The lease is taken as `read` takes it.
	 */
	async check(
		key: TaskKey,
		id: string,
		version: string
	): Promise<EditorDocument | { locked: boolean }> {
		const resource = await this.resource(key, id);
		if (resource.kind !== 'file') throw new Error('Not a file');
		const absolute = await projectFile(resource.root, resource.path),
			info = await stat(absolute, { bigint: true });
		const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
			known = this.stats.get(absolute);
		if (known?.signature === signature && known.version === version) {
			if (resource.external || resource.plan) return { locked: false };
			const path = await safePath(resource.root, resource.path),
				owner = this.leases.get(path),
				locked = owner !== undefined && owner !== name(key);
			if (!locked && known.text) this.leases.set(path, name(key));
			return { locked };
		}
		// The signature predates the read: a write in between changes it again, and the next poll reads once more.
		const document = await this.read(key, id);
		this.stats.delete(absolute);
		this.stats.set(absolute, {
			signature,
			version: document.version,
			text: document.state === 'text',
		});
		if (this.stats.size > 64) this.stats.delete(this.stats.keys().next().value!);
		return document.version === version ? { locked: document.locked } : document;
	}
	save(
		key: TaskKey,
		id: string,
		expectedVersion: string,
		text: string,
		afterTurn = false
	): Promise<SaveFileResult> {
		const operation = this.performSave(key, id, expectedVersion, text, afterTurn);
		// spec/editor#save-during-turn: a save the host holds until the turn ends is not main's write: commits and quit do not wait for it.
		if (afterTurn) return operation;
		this.saves.add(operation);
		void operation.then(
			() => this.saves.delete(operation),
			() => this.saves.delete(operation)
		);
		return operation;
	}
	private async performSave(
		key: TaskKey,
		id: string,
		expectedVersion: string,
		text: string,
		afterTurn: boolean
	): Promise<SaveFileResult> {
		const resource = await this.resource(key, id);
		if (resource.external) throw new Error('File is read-only');
		if (resource.plan)
			return writeProjectFile(resource.root, { path: resource.path, expectedVersion, text });
		const path = await safePath(resource.root, resource.path);
		if (this.leases.get(path) !== name(key)) throw new Error('File is open in another task');
		return this.sessions.saveFile(key, {
			path: resource.path,
			expectedVersion,
			text,
			...(afterTurn ? { afterTurn } : {}),
		});
	}
	async location(key: TaskKey, id: string, source: 'tree' | 'changes') {
		if (source === 'tree') {
			const resource = await this.resource(key, id);
			return safePath(resource.root, resource.path);
		}
		const snapshot = await this.changes.read(key),
			file = snapshot.files.find((file) => file.id === id),
			scope = snapshot.scopes.find((scope) => scope.id === file?.scopeId);
		if (!file || !scope) throw new Error('File changed');
		return safePath(scope.path, file.path);
	}
	/** spec/editor#tab-menu: a local diff tab's paths, project-relative from the root scope like the tree's. */
	async changesLocation(key: TaskKey, id: string) {
		const snapshot = await this.changes.read(key),
			absolute = await this.location(key, id, 'changes'),
			root =
				snapshot.scopes.find((scope) => scope.kind === 'root')?.path ?? snapshot.scopes[0]?.path;
		return { path: root ? relative(root, absolute) : absolute, absolute };
	}
	async treeLocation(key: TaskKey, id: string) {
		const resource = await this.resource(key, id);
		const path = await safePath(resource.root, resource.path);
		const info = await stat(path);
		if (resource.kind === 'directory' ? !info.isDirectory() : !info.isFile())
			throw new Error('File changed');
		return { ...resource, absolute: path };
	}
	/** spec/editor#editor-context-menu: the editor menu's paths. A read-only file outside the project has no project-relative path; it shows its `~/` one. */
	async editorLocation(key: TaskKey, id: string) {
		const resource = await this.resource(key, id);
		if (resource.external || resource.plan) {
			const absolute = join(resource.root, resource.path);
			return { path: tildePath(absolute), absolute, external: true };
		}
		const location = await this.treeLocation(key, id);
		return { path: location.path, absolute: location.absolute, external: false };
	}
	async attach(key: TaskKey, id: string) {
		const resource = await this.treeLocation(key, id);
		return new Attachments(await SessionStore.at(this.changes.dataDir)).create(key, {
			kind: 'text',
			name:
				resource.kind === 'directory'
					? `${basename(resource.path).slice(0, 199)}/`
					: basename(resource.path).slice(0, 200),
			text: `${resource.kind === 'directory' ? 'Directory' : 'File'} reference:\nProject-relative path: ${JSON.stringify(resource.path)}\nAbsolute path: ${JSON.stringify(resource.absolute)}\nRead the current contents from disk when needed.`,
		});
	}
	async terminalHere(key: TaskKey, id: string) {
		const resource = await this.treeLocation(key, id);
		const directory =
			resource.kind === 'directory'
				? resource.path
				: relative(resource.root, dirname(resource.absolute));
		return this.sessions.terminal(key, { kind: 'create', role: 'console', directory });
	}
	refresh(key: TaskKey) {
		const operation = this.sessions.command(key, { kind: 'checkpoint' });
		this.saves.add(operation);
		void operation.then(
			() => this.saves.delete(operation),
			() => this.saves.delete(operation)
		);
		return operation;
	}
	revert(key: TaskKey, fileId: string) {
		const operation = this.sessions.revertFile(key, fileId, this.changes.view(key));
		this.saves.add(operation);
		void operation.then(
			() => this.saves.delete(operation),
			() => this.saves.delete(operation)
		);
		return operation;
	}
	async canRevert(key: TaskKey, fileId: string) {
		const snapshot = await this.changes.read(key);
		const file = snapshot.files.find((file) => file.id === fileId),
			scope = snapshot.scopes.find((scope) => scope.id === file?.scopeId);
		if (!file || !scope) throw new Error('File changed');
		const paths = [join(scope.path, file.path), join(scope.path, file.oldPath)];
		for (const id of this.dirty.keys()) {
			const resource = this.resources.get(id);
			if (resource && paths.includes(join(resource.root, resource.path)))
				throw new Error('There are unsaved changes.');
		}
		if (this.isSaving) throw new Error('A file is being saved');
		return file;
	}
	taskUnsavedPaths(key: TaskKey) {
		return [...this.dirty]
			.filter(([id]) => {
				const resource = this.resources.get(id);
				return resource && name(resource.key) === name(key);
			})
			.map(([, path]) => path);
	}
	forgetTask(key: TaskKey) {
		this.onClosed(key, null);
		for (const [id, resource] of this.resources)
			if (name(resource.key) === name(key)) {
				this.dirty.delete(id);
				const path = join(resource.root, resource.path);
				if (this.leases.get(path) === name(key)) this.leases.delete(path);
			}
	}
	/** spec/task-window-workspace#restore-window: the unsaved buffers outside `kept` (file ids a hot exit wrote to `drafts/`). */
	unsavedExcept(kept: ReadonlySet<string>) {
		return [...this.dirty].filter(([id]) => !kept.has(id)).map(([, path]) => path);
	}
	/** The unsaved buffers that `pick` takes by their file id (spec/remote-access-and-mobile#browser-from-device: one device's window). */
	unsaved(pick: (id: string) => boolean) {
		return [...this.dirty].filter(([id]) => pick(id)).map(([, path]) => path);
	}
	resetEditors() {
		this.onClosed(null, null);
		this.dirty.clear();
		this.leases.clear();
	}
	async markDirty(key: TaskKey, id: string, dirty: boolean) {
		const resource = this.registered(key, id);
		if (dirty) {
			if (this.leases.get(join(resource.root, resource.path)) !== name(key))
				throw new Error('File is open in another task');
			this.dirty.set(id, resource.path);
		} else this.dirty.delete(id);
	}
	async release(key: TaskKey, id: string) {
		const resource = this.registered(key, id);
		const path = join(resource.root, resource.path);
		this.onClosed(key, id);
		if (this.leases.get(path) === name(key)) this.leases.delete(path);
		this.dirty.delete(id);
	}
}
