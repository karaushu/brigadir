import { createHash } from 'node:crypto';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
	isRecord,
	type Scope,
	type CommitFile,
	type CommitPreview,
	type CommitResult,
	type CommitScope,
	type CommitBasketPlan,
	type CommitBasketState,
	type CommitBasketsResult,
	type SnapshotDocument,
} from '@brigadir/core';
import { git, gitText, isSha } from './command';
import { changedFiles } from './changes';
export function parseStatus(text: string): { path: string; oldPath: string; status: string }[] {
	const records = text.split('\0'),
		files = [];
	for (let i = 0; i < records.length - 1; i++) {
		const value = records[i]!;
		if (value.length < 4 || value[2] !== ' ') throw new Error('Invalid Git status');
		const status = value.slice(0, 2),
			path = value.slice(3),
			oldPath = /[RC]/.test(status) ? records[++i] : path;
		if (!oldPath) throw new Error('Invalid Git rename');
		if (status.includes('U') || status === 'AA' || status === 'DD')
			throw new Error('Resolve merge conflicts before committing');
		files.push({ path, oldPath, status });
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function head(scope: Scope) {
	return gitText(scope.path, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => null);
}
export async function statusFiles(scope: Scope, scopes: Scope[]) {
	const nested = scopes
		.filter(
			(child) =>
				child.id !== scope.id &&
				child.path.startsWith(`${scope.path}/`) &&
				child.kind !== 'submodule'
		)
		.map((child) => relative(scope.path, child.path));
	return parseStatus(
		(
			await git(scope.path, [
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
				'--ignore-submodules=none',
			])
		).toString('utf8')
	).filter(
		(file) =>
			!nested.some(
				(path) => file.path.replace(/\/$/, '') === path || file.path.startsWith(`${path}/`)
			)
	);
}
async function stage(
	scope: Scope,
	files: Pick<CommitFile, 'path' | 'oldPath'>[],
	env?: Record<string, string>
) {
	const tracked = new Set(
		(await git(scope.path, ['ls-files', '--cached', '-z'], env ? { env } : {}))
			.toString('utf8')
			.split('\0')
	);
	const paths = [];
	for (const path of new Set(files.flatMap((file) => [file.oldPath, file.path]))) {
		if (
			tracked.has(path) ||
			(await lstat(join(scope.path, path)).then(
				() => true,
				() => false
			))
		)
			paths.push(path);
	}
	if (!paths.length) return;
	await git(
		scope.path,
		['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
		{ ...(env ? { env } : {}), input: paths.join('\0') + '\0' }
	);
}
async function withIndex<T>(
	scope: Scope,
	base: string | null,
	run: (env: Record<string, string>) => Promise<T>
) {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-commit-'));
	try {
		const env = { GIT_INDEX_FILE: join(dir, 'index') };
		await git(scope.path, base ? ['read-tree', base] : ['read-tree', '--empty'], { env });
		return await run(env);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
// A repo's preview is determined by status, HEAD, the task base and the stat of each listed file; a directory in status
// is a submodule or nested repo, and `add` writes its HEAD. The same signature means the same tree and diffs, so a repeated
// read (focus, an event) builds no temporary index. When in doubt, no cache. A commit always rereads uncached (`fresh`).
const previews = new Map<string, { key: string; value: Omit<CommitScope, 'scope'> }>();
async function signature(
	scope: Scope,
	files: { path: string; oldPath: string; status: string }[],
	before: string | null,
	baseline: string | undefined
) {
	const stats: string[] = [];
	for (const path of new Set(files.flatMap((file) => [file.oldPath, file.path]))) {
		try {
			const stat = await lstat(join(scope.path, path), { bigint: true });
			if (stat.isDirectory()) {
				if (
					!(await lstat(join(scope.path, path, '.git')).then(
						() => true,
						() => false
					))
				)
					return null;
				const commit = await gitText(join(scope.path, path), [
					'rev-parse',
					'--verify',
					'--quiet',
					'HEAD',
				]).catch(() => null);
				if (!commit) return null;
				stats.push(`gitlink:${commit}`);
			} else
				stats.push(
					[stat.mtimeNs, stat.ctimeNs, stat.size, stat.ino, stat.dev, stat.mode].join(':')
				);
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') return null;
			stats.push('-');
		}
	}
	return createHash('sha256')
		.update(JSON.stringify([scope, before, baseline ?? null, files, stats]))
		.digest('hex');
}
export async function previewCommits(
	scopes: Scope[],
	snapshots?: SnapshotDocument,
	fresh = false
): Promise<CommitPreview> {
	const result: CommitScope[] = [];
	for (const scope of scopes.filter((scope) => scope.available !== false)) {
		const files = await statusFiles(scope, scopes);
		if (!files.length) continue;
		const before = await head(scope);
		const baseline = snapshots?.checkpoints[0]?.trees.find(
				(tree) => tree.scopeId === scope.id
			)?.tree,
			id = `${scope.id}\0${scope.path}`,
			key = fresh ? null : await signature(scope, files, before, baseline);
		let value = key && previews.get(id)?.key === key ? previews.get(id)!.value : null;
		if (!value) {
			const tree = await withIndex(scope, before, async (env) => {
				await stage(scope, files, env);
				return gitText(scope.path, ['write-tree'], { env });
			});
			const diffs = await changedFiles(
				scope,
				before ??
					(await gitText(scope.path, ['hash-object', '-t', 'tree', '--stdin', '-w'], {
						input: '',
					})),
				tree
			);
			const taskDiff = baseline ? await changedFiles(scope, baseline, tree) : diffs;
			value = {
				head: before,
				tree,
				files: files.map((file) => ({
					...file,
					beforeTask: !taskDiff.some((diff) => diff.path === file.path),
					diff: diffs.find((diff) => diff.path === file.path) ?? null,
				})),
			};
			if (key) {
				previews.delete(id);
				previews.set(id, { key, value });
				while (previews.size > 64) previews.delete(previews.keys().next().value!);
			}
		}
		result.push({
			scope: {
				...scope,
				branch: await gitText(scope.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
					() => null
				),
			},
			head: value.head,
			tree: value.tree,
			files: value.files.map((file) => ({ ...file, diff: file.diff && { ...file.diff } })),
		});
	}
	// Deepest repositories first, so every parent records its children's final gitlinks.
	result.sort(
		(a, b) =>
			b.scope.path.split('/').length - a.scope.path.split('/').length ||
			a.scope.name.localeCompare(b.scope.name)
	);
	return {
		revision: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
		scopes: result,
	};
}
/**
 * spec/git#commit-dialog: `base` plus the entries of `paths` from `source` (the reviewed tree of the preview), as a tree.
 * A path missing from `source` is removed (a deletion, the old path of a rename); a gitlink in `gitlinks` takes the
 * child's new commit instead of the reviewed one. Built in a temporary index; the person's index is not touched.
 */
export async function basketTree(
	scope: Scope,
	base: string | null,
	source: string,
	paths: readonly string[],
	gitlinks: ReadonlyMap<string, string> = new Map()
): Promise<string> {
	const wanted = new Set(paths),
		found = new Map<string, string>();
	const list = [...wanted];
	for (let i = 0; i < list.length; i += 400) {
		const records = (
			await git(scope.path, [
				'--literal-pathspecs',
				'ls-tree',
				'-r',
				'-z',
				'--full-tree',
				source,
				'--',
				...list.slice(i, i + 400),
			])
		)
			.toString('utf8')
			.split('\0');
		for (const record of records) {
			const tab = record.indexOf('\t');
			if (tab < 0) continue;
			const path = record.slice(tab + 1);
			if (wanted.has(path)) found.set(path, record.slice(0, tab));
		}
	}
	const zero = '0'.repeat(source.length),
		lines = list.map((path) => {
			const link = gitlinks.get(path);
			if (link) return `160000 commit ${link}\t${path}`;
			const entry = found.get(path);
			return entry ? `${entry}\t${path}` : `0 ${zero}\t${path}`;
		});
	return withIndex(scope, base, async (env) => {
		if (lines.length)
			await git(scope.path, ['update-index', '-z', '--index-info'], {
				env,
				input: lines.join('\0') + '\0',
			});
		return gitText(scope.path, ['write-tree'], { env });
	});
}
/** The paths a file of the preview touches in git: its path and, for a rename or copy, the old one. */
function touched(files: readonly CommitFile[]) {
	return [...new Set(files.flatMap((file) => [file.path, file.oldPath]))];
}
async function emptyTree(scope: Scope) {
	return gitText(scope.path, ['hash-object', '-t', 'tree', '--stdin', '-w'], { input: '' });
}
/**
 * spec/git#commit-dialog: the commit dialog's sequence. One revision check at the start, then basket after basket: the repo's
 * HEAD must be the one expected, the basket's tree is HEAD plus its files from the reviewed tree, the person's index
 * becomes exactly that tree, and `git commit` runs with the repo's hooks. A failure stops the rest; committed SHAs stay.
 */
export async function commitBaskets(
	preview: CommitPreview,
	scopes: Scope[],
	plan: readonly CommitBasketPlan[],
	snapshots?: SnapshotDocument,
	onProgress: (basketId: string, state: CommitBasketState, detail?: string) => void = () => {}
): Promise<CommitBasketsResult> {
	const fresh = await previewCommits(scopes, snapshots, true);
	if (fresh.revision !== preview.revision)
		throw new Error('Files changed. Review the commit list again.');
	const order = new Map(fresh.scopes.map((item, i) => [item.scope.id, i])),
		seen = new Set<string>();
	for (const basket of plan) {
		const item = fresh.scopes.find((value) => value.scope.id === basket.scopeId);
		if (
			!basket.message.trim() ||
			Buffer.byteLength(basket.message) > 16000 ||
			basket.message.includes('\0')
		)
			throw new Error('Invalid commit message');
		for (const path of basket.files) {
			const key = `${basket.scopeId}\0${path}`;
			if (!item || seen.has(key) || !item.files.some((file) => file.path === path))
				throw new Error('Files changed. Review the commit list again.');
			seen.add(key);
		}
	}
	const steps = plan
		.map((basket, i) => ({ basket, i }))
		.sort((a, b) => order.get(a.basket.scopeId)! - order.get(b.basket.scopeId)! || a.i - b.i)
		.map((step) => step.basket);
	const result: CommitBasketsResult = {
		committed: [],
		error: null,
		baskets: steps.map((basket) => ({ id: basket.id, state: 'waiting' })),
	};
	const heads = new Map(fresh.scopes.map((item) => [item.scope.id, item.head]));
	for (const [index, basket] of steps.entries()) {
		const item = fresh.scopes.find((value) => value.scope.id === basket.scopeId)!,
			{ scope } = item,
			state = result.baskets[index]!;
		state.state = 'running';
		onProgress(basket.id, 'running');
		try {
			const expectedHead = heads.get(scope.id) ?? null;
			if ((await head(scope)) !== expectedHead)
				throw new Error('The branch changed. Refresh the commit list.');
			// A child repo committed in this run: its gitlink in the parent is the child's new HEAD.
			const gitlinks = new Map<string, string>();
			for (const done of result.committed) {
				const child = fresh.scopes.find((value) => value.scope.id === done.scopeId)!.scope;
				if (child.kind === 'submodule' && child.path.startsWith(`${scope.path}/`))
					gitlinks.set(relative(scope.path, child.path), heads.get(child.id)!);
			}
			const files = item.files.filter((file) => basket.files.includes(file.path));
			const tree = await basketTree(scope, expectedHead, item.tree, touched(files), gitlinks),
				baseTree = expectedHead
					? await gitText(scope.path, ['rev-parse', `${expectedHead}^{tree}`])
					: await emptyTree(scope);
			if (tree === baseTree) {
				state.state = 'skipped';
				onProgress(basket.id, 'skipped');
				continue;
			}
			// The person's index is exactly the basket: other files stay in the working tree, unstaged.
			await git(scope.path, ['read-tree', tree]);
			await git(scope.path, ['commit', '-q', '--file=-'], {
				input: basket.message,
				hooks: true,
				timeoutMs: 600_000,
			});
			const sha = await head(scope);
			if (!sha || !isSha(sha)) throw new Error('Cannot read the new commit');
			heads.set(scope.id, sha);
			result.committed.push({ scopeId: scope.id, name: scope.name, sha });
			state.state = 'done';
			state.sha = sha;
			onProgress(basket.id, 'done', sha);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			state.state = 'failed';
			state.output = text.slice(0, 20000);
			result.error = `${scope.name}: ${text.split('\n')[0]}`;
			onProgress(basket.id, 'failed', state.output);
			break;
		}
	}
	return result;
}
/** Explicit Commit all: only reviewed paths; no shell interpolation or blanket add. */
export async function commitPreview(
	preview: CommitPreview,
	scopes: Scope[],
	message: string,
	snapshots?: SnapshotDocument
): Promise<CommitResult> {
	if (!message.trim() || Buffer.byteLength(message) > 16000 || message.includes('\0'))
		throw new Error('Invalid commit message');
	const fresh = await previewCommits(scopes, snapshots, true);
	if (fresh.revision !== preview.revision)
		throw new Error('Files changed. Review the commit list again.');
	const result: CommitResult = { committed: [], error: null };
	for (const item of fresh.scopes) {
		try {
			const { scope, files } = item;
			if ((await head(scope)) !== item.head)
				throw new Error('The branch changed. Refresh the commit list.');
			// Parent trees are rebased only for successful child commits. All other blobs
			// stay exactly as reviewed, and the real index must match before git commit.
			const expected = await withIndex(scope, item.tree, async (env) => {
				const children = result.committed
					.map((value) => fresh.scopes.find((child) => child.scope.id === value.scopeId)!)
					.filter(
						(child) =>
							child.scope.kind === 'submodule' && child.scope.path.startsWith(`${scope.path}/`)
					);
				for (const child of children) {
					const path = relative(scope.path, child.scope.path);
					if (files.some((file) => file.path === path))
						await stage(scope, [{ path, oldPath: path }], env);
				}
				return gitText(scope.path, ['write-tree'], { env });
			});
			await stage(scope, files);
			if ((await gitText(scope.path, ['write-tree'])) !== expected)
				throw new Error('Files or staging changed. Review the commit list again.');
			const baseTree = item.head
				? await gitText(scope.path, ['rev-parse', `${item.head}^{tree}`])
				: null;
			if (expected === baseTree) continue;
			await git(scope.path, ['commit', '-q', '--file=-'], { input: message });
			const sha = await head(scope);
			if (!sha || !isSha(sha)) throw new Error('Cannot read the new commit');
			result.committed.push({ scopeId: scope.id, name: scope.name, sha });
		} catch (error) {
			result.error = `${item.scope.name}: ${error instanceof Error ? error.message : String(error)}`;
			break;
		}
	}
	return result;
}
