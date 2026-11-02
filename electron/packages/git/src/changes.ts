import { changeBaseOf, inTask } from '@brigadir/core';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import type {
	ChangeView,
	ChangedFile,
	ChangesSnapshot,
	Scope,
	SnapshotDocument,
	TaskKey,
} from '@brigadir/core';
import type { SessionStore } from '@brigadir/persistence';
import { git, gitText, isSha } from './command';
import { readSnapshots } from './snapshots';
const zero = (sha: string) => (/^0+$/.test(sha) ? null : sha);
// Trees are immutable, so a tree pair's diff is stable: a cache without invalidation, bounded only by entries and files.
const diffs = new Map<string, { files: Promise<ChangedFile[]>; size: number }>();
let diffWeight = 0;
function forget(key: string) {
	const entry = diffs.get(key);
	if (entry) {
		diffs.delete(key);
		diffWeight -= entry.size;
	}
}
/** Where Git reads this scope's objects: its own repo, or the source repo once a released worktree is gone (spec/tasks#released-worktree). */
export const repoPath = (scope: Pick<Scope, 'path' | 'available' | 'source'>) =>
	scope.available === false && scope.source ? scope.source : scope.path;
export async function changedFiles(
	scope: Scope,
	before: string,
	after: string
): Promise<ChangedFile[]> {
	if (!isSha(before) || !isSha(after)) throw new Error('Invalid tree');
	const key = `${scope.id}\0${scope.path}\0${before}\0${after}`;
	let entry = diffs.get(key);
	if (entry) {
		diffs.delete(key);
		diffs.set(key, entry);
	} else {
		const files = diffTrees(scope, before, after),
			created = { files, size: 1 };
		entry = created;
		diffs.set(key, created);
		diffWeight++;
		files.then(
			(list) => {
				if (diffs.get(key) === created) {
					diffWeight += list.length;
					created.size += list.length;
				}
			},
			() => {
				if (diffs.get(key) === created) forget(key);
			}
		);
		while (diffs.size > 512 || (diffWeight > 50_000 && diffs.size > 1))
			forget(diffs.keys().next().value!);
	}
	return (await entry.files).map((file) => ({ ...file }));
}
/** One `diff-tree` emits raw records first, then numstat, with a single rename/copy detection. */
async function diffTrees(scope: Scope, before: string, after: string): Promise<ChangedFile[]> {
	const records = (
		await git(repoPath(scope), [
			'diff-tree',
			'-r',
			'-M',
			'-C',
			'--no-commit-id',
			'--no-abbrev',
			'--raw',
			'--numstat',
			'-z',
			before,
			after,
		])
	)
		.toString('utf8')
		.split('\0');
	const raw: { match: RegExpExecArray; oldPath: string; path: string }[] = [];
	let i = 0;
	for (; i < records.length - 1 && records[i]!.startsWith(':'); i++) {
		const match = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z]\d*)$/.exec(records[i]!);
		if (!match) throw new Error('Invalid Git raw diff');
		const oldPath = records[++i]!;
		raw.push({ match, oldPath, path: /^[RC]/.test(match[5]!) ? records[++i]! : oldPath });
	}
	const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
	for (; i < records.length - 1; i++) {
		const entry = records[i]!;
		const first = entry.indexOf('\t'),
			second = entry.indexOf('\t', first + 1);
		if (first < 0 || second < 0) throw new Error('Invalid Git numstat');
		const added = entry.slice(0, first),
			removed = entry.slice(first + 1, second);
		let oldPath = entry.slice(second + 1),
			path = oldPath;
		if (!path) {
			oldPath = records[++i]!;
			path = records[++i]!;
		}
		stats.set(`${oldPath}\0${path}`, {
			additions: added === '-' ? 0 : Number(added),
			deletions: removed === '-' ? 0 : Number(removed),
			binary: added === '-' || removed === '-',
		});
	}
	return raw.map(({ match, oldPath, path }) => {
		const status = match[5]!,
			counts = stats.get(`${oldPath}\0${path}`);
		if (!counts) throw new Error('Missing file counts');
		return {
			id: createHash('sha256')
				.update(
					`${scope.id}\0${oldPath}\0${path}\0${match[1]}\0${match[2]}\0${match[3]}\0${match[4]}`
				)
				.digest('hex'),
			scopeId: scope.id,
			path,
			oldPath,
			status,
			beforeMode: match[1]!,
			afterMode: match[2]!,
			before: zero(match[3]!),
			after: zero(match[4]!),
			...counts,
			gitlink: match[1] === '160000' || match[2] === '160000',
			generated: /(?:^|\/)(?:pnpm-lock.yaml|package-lock.json|yarn.lock)$|\.tsbuildinfo$/.test(
				path
			),
		};
	});
}
/** spec/diff-and-review#diff-base: HEAD of a repo, its tree, and the empty tree before the first commit. Every change read asks it,
 *  so one lookup per repo serves reads within 300 ms; a commit is seen on the next refresh after that. */
const heads = new Map<
	string,
	{ at: number; value: Promise<{ commit: string | null; tree: string } | null> }
>();
export function headTree(scope: Scope): Promise<{ commit: string | null; tree: string } | null> {
	const cached = heads.get(scope.path);
	if (cached && Date.now() - cached.at < 300) return cached.value;
	const value = (async () => {
		const found = await gitText(scope.path, ['rev-parse', 'HEAD', 'HEAD^{tree}'], {
			env: { GIT_OPTIONAL_LOCKS: '0' },
		}).then(
			(text) => text.trim().split('\n'),
			() => null
		);
		if (found?.length === 2 && found.every(isSha)) return { commit: found[0]!, tree: found[1]! };
		// No commit yet: everything in the snapshot is new. Not a repo at all: no HEAD base.
		const empty = await gitText(scope.path, ['hash-object', '-t', 'tree', '--stdin', '-w'], {
			input: '',
		}).then(
			(text) => text.trim(),
			() => null
		);
		return empty && isSha(empty) ? { commit: null, tree: empty } : null;
	})();
	heads.set(scope.path, { at: Date.now(), value });
	if (heads.size > 256) heads.delete(heads.keys().next().value!);
	void value.catch(() => {
		if (heads.get(scope.path)?.value === value) heads.delete(scope.path);
	});
	return value;
}
/** Nested repos with their own trees are diffed on their own, so their paths leave the parent's diff. */
export function nestedPrefixes(doc: SnapshotDocument, scope: Scope, upTo: number): string[] {
	return doc.scopes
		.filter(
			(child) =>
				child.id !== scope.id &&
				child.kind !== 'submodule' &&
				child.path.startsWith(`${scope.path}/`) &&
				doc.checkpoints
					.slice(0, upTo + 1)
					.some((point) => point.trees.some((tree) => tree.scopeId === child.id))
		)
		.map((child) => relative(scope.path, child.path) + '/');
}
/** The pair of trees a view compares for one scope: a snapshot range, or HEAD against the latest snapshot (spec/diff-and-review#diff-base). */
export async function viewTrees(
	doc: SnapshotDocument,
	scope: Scope,
	view?: ChangeView
): Promise<{ old: string; next: string; current: number; head?: string | null } | null> {
	const range = view === 'head' ? undefined : view,
		current = range ? doc.checkpoints[range.current] : doc.checkpoints.at(-1);
	if (!current) return null;
	// A released worktree has no HEAD to compare with: its changes read as the task's own snapshot range.
	if (view === 'head' && scope.available === false) view = undefined;
	const next = current.trees.find((t) => t.scopeId === scope.id);
	if (!next) return null;
	if (view === 'head') {
		const head = await headTree(scope);
		return head
			? { old: head.tree, next: next.tree, current: current.id, head: head.commit }
			: null;
	}
	const base = doc.checkpoints[range?.base ?? 0];
	if (!base) return null;
	const old =
		base.trees.find((t) => t.scopeId === scope.id) ??
		doc.checkpoints
			.slice(0, current.id + 1)
			.flatMap((point) => point.trees)
			.find((t) => t.scopeId === scope.id);
	return old ? { old: old.tree, next: next.tree, current: current.id } : null;
}
/** The blob at `path` in `tree`, or null when the tree has no such file. */
export async function treeBlob(scope: Scope, tree: string, path: string): Promise<string | null> {
	if (!isSha(tree)) throw new Error('Invalid tree');
	const bytes = await git(repoPath(scope), ['ls-tree', '-z', tree, '--', `:(literal)${path}`], {
		maxBytes: 32 * 1024,
	});
	const entry = bytes
		.toString('utf8')
		.split('\0')
		.find((entry) => entry.slice(entry.indexOf('\t') + 1) === path);
	if (!entry) return null;
	const match = /^\d+ blob ([a-f0-9]+)\t/.exec(entry);
	return match?.[1] ?? null;
}
export async function readChanges(
	store: SessionStore,
	key: TaskKey,
	view?: ChangeView
): Promise<ChangesSnapshot> {
	const doc = await readSnapshots(store, key);
	// spec/crew#parts: «All changes» of a task count from its change base (a crew part's start); a chosen range stays absolute.
	if (view === undefined && doc?.checkpoints.length) {
		const from = changeBaseOf(doc, (await store.task(key)).changeBase);
		if (from > 0) view = { base: from, current: doc.checkpoints.length - 1 };
	}
	const range = view === 'head' ? undefined : view;
	const base = doc?.checkpoints[range?.base ?? 0],
		current = range ? doc?.checkpoints[range.current] : doc?.checkpoints.at(-1);
	if (range && (!base || !current || base.id > current.id))
		throw new Error('Invalid snapshot range');
	if (!doc || !base || !current)
		return { scopes: doc?.scopes ?? [], files: [], checkpoint: null, issue: null };
	const files: ChangedFile[] = [],
		heads: Record<string, string | null> = {};
	for (const scope of doc.scopes.filter((s) => inTask(s) && (s.available !== false || s.source))) {
		const trees = await viewTrees(doc, scope, view);
		if (!trees) continue;
		if (trees.head !== undefined) heads[scope.id] = trees.head;
		const children = nestedPrefixes(doc, scope, current.id);
		files.push(
			...(await changedFiles(scope, trees.old, trees.next)).filter(
				(file) => !children.some((prefix) => file.path.startsWith(prefix))
			)
		);
	}
	return {
		scopes: doc.scopes,
		files,
		checkpoint: current.id,
		issue: null,
		...(view === 'head' ? { heads } : {}),
	};
}
export async function readBlobs(
	scope: Scope,
	shas: (string | null)[]
): Promise<{ text: string; binary: boolean; tooLarge: boolean }[]> {
	const present = [...new Set(shas.filter((s): s is string => s !== null))];
	if (present.some((s) => !isSha(s))) throw new Error('Invalid blob');
	const results = new Map<string, { text: string; binary: boolean; tooLarge: boolean }>();
	if (!present.length) return shas.map(() => ({ text: '', binary: false, tooLarge: false }));
	const metadata = (
		await gitText(repoPath(scope), ['cat-file', '--batch-check'], {
			input: present.join('\n') + '\n',
		})
	).split('\n');
	const small: string[] = [];
	for (const line of metadata) {
		const [sha, kind, size] = line.split(' ');
		if (!sha || kind !== 'blob' || !Number.isSafeInteger(Number(size)))
			throw new Error('Missing blob');
		if (Number(size) > 2 * 1024 * 1024)
			results.set(sha, { text: '', binary: false, tooLarge: true });
		else small.push(sha);
	}
	if (small.length) {
		const bytes = await git(repoPath(scope), ['cat-file', '--batch'], {
			input: small.join('\n') + '\n',
			maxBytes: 5 * 1024 * 1024,
		});
		let offset = 0;
		for (const sha of small) {
			const end = bytes.indexOf(10, offset);
			const fields = bytes.subarray(offset, end).toString('ascii').split(' ');
			if (fields[0] !== sha || fields[1] !== 'blob') throw new Error('Invalid blob response');
			const size = Number(fields[2]);
			const content = bytes.subarray(end + 1, end + 1 + size);
			if (content.length !== size) throw new Error('Truncated blob');
			const binary =
				content.includes(0) || !Buffer.from(content.toString('utf8'), 'utf8').equals(content);
			results.set(sha, { text: binary ? '' : content.toString('utf8'), binary, tooLarge: false });
			offset = end + size + 2;
		}
	}
	return shas.map((sha) =>
		sha ? results.get(sha)! : { text: '', binary: false, tooLarge: false }
	);
}
