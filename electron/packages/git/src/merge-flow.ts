import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isRecord,
	type ConflictFile,
	type ConflictResolution,
	type ConflictTexts,
	type MergeFile,
	type MergeOutcome,
	type MergePreview,
	type Scope,
	type TaskKey,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath, type SessionStore } from '@brigadir/persistence';
import { git, gitText } from './command';
import { resolveBranch } from './history';
import { gitPath, squashInProgress, unmergedNames, unmergedStages } from './merge';

/**
 * spec/git#merge: merging a branch into the current branch of a task's repo.
 * `merge.ts` next to it squashes crew worker branches (spec/crew#accept); a different action with different rules,
 * but the person resolves its conflict here, so a «merge in progress» also means an unfinished squash.
 */

/**
 * What conflicted at the start of the merge: git does not remember resolved files. Keyed by the task's scope.
 * spec/appearance#evolution-redesign: `resolutions` — how the person resolved a file (✓ `Yours` / `Theirs` / `Merged` / `Kept` / `Deleted`);
 * `pending` — files of the last request to the agent, not yet accepted or resolved; `step` — the rebase commit the
 * record belongs to (the next commit starts the list over).
 */
export type MergeRecord = {
	from: string;
	into: string;
	conflicts: string[];
	agent: string[];
	resolutions?: Record<string, ConflictResolution>;
	pending?: string[];
	step?: number;
};
const resolutionKinds = new Set(['yours', 'theirs', 'merged', 'kept', 'deleted']);
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');
/** The task's `git-merge.json`: written by the merge surface and crew acceptance (spec/crew#accept), read by the merge bar. */
export async function readMergeRecords(
	store: SessionStore,
	key: TaskKey
): Promise<Record<string, MergeRecord>> {
	try {
		const doc = await readDocument(await safePath(await store.taskDir(key), 'git-merge.json'));
		if (!isRecord(doc.merges)) return {};
		const out: Record<string, MergeRecord> = {};
		for (const [id, value] of Object.entries(doc.merges)) {
			if (
				isRecord(value) &&
				typeof value.from === 'string' &&
				typeof value.into === 'string' &&
				strings(value.conflicts) &&
				strings(value.agent)
			) {
				const resolutions = isRecord(value.resolutions)
					? (Object.fromEntries(
							Object.entries(value.resolutions).filter(
								(entry) => typeof entry[1] === 'string' && resolutionKinds.has(entry[1])
							)
						) as Record<string, ConflictResolution>)
					: undefined;
				out[id] = {
					from: value.from,
					into: value.into,
					conflicts: value.conflicts,
					agent: value.agent,
					...(resolutions ? { resolutions } : {}),
					...(strings(value.pending) ? { pending: value.pending } : {}),
					...(typeof value.step === 'number' ? { step: value.step } : {}),
				};
			}
		}
		return out;
	} catch {
		return {};
	}
}
export async function rememberMerge(
	store: SessionStore,
	key: TaskKey,
	scopeId: string,
	record: MergeRecord | null
) {
	const merges = await readMergeRecords(store, key);
	if (record) merges[scopeId] = record;
	else delete merges[scopeId];
	await atomicJson(await safePath(await store.taskDir(key), 'git-merge.json'), {
		schemaVersion: 1,
		merges,
	});
}

/** Like `git`, but the exit code is a result, not an error: `merge-tree` and `merge` report a conflict with code 1. */
function gitExit(
	cwd: string,
	args: string[],
	input?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
	);
	return new Promise((resolve, reject) => {
		const child = spawn(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'-c',
				'core.fsmonitor=false',
				'-c',
				'commit.gpgsign=false',
				...args,
			],
			// `rebase --continue` would open an editor for the message; the commit keeps its own.
			{
				cwd,
				env: { ...env, GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true' },
				stdio: 'pipe',
				shell: false,
			}
		);
		const out: Buffer[] = [],
			err: Buffer[] = [];
		const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
		timer.unref();
		child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin.on('error', () => {});
		child.once('close', (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(out).toString('utf8'),
				stderr: Buffer.concat(err).toString('utf8').trim(),
			});
		});
		child.stdin.end(input);
	});
}

export async function currentBranch(scope: Scope): Promise<string | null> {
	return (
		(await gitText(scope.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')) || null
	);
}
async function mergeHead(scope: Scope): Promise<boolean> {
	return Boolean(
		await gitText(scope.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')
	);
}
/** `MERGE_HEAD`, or a crew acceptance squash not committed yet (spec/crew#accept). */
export async function mergeInProgress(scope: Scope): Promise<boolean> {
	return (await mergeHead(scope)) || (await squashInProgress(scope.path));
}

/** spec/appearance#evolution-redesign: a rebase that stopped — `rebase-merge` (the merge backend) or `rebase-apply` (`am`). */
async function rebaseDir(scope: Scope): Promise<string | null> {
	for (const name of ['rebase-merge', 'rebase-apply']) {
		const path = await gitPath(scope.path, name).catch(() => null);
		if (
			path &&
			(await access(path).then(
				() => true,
				() => false
			))
		)
			return path;
	}
	return null;
}
export async function rebaseInProgress(scope: Scope): Promise<boolean> {
	return Boolean(await rebaseDir(scope));
}
/** What stopped in the tree: a merge (or a crew squash), a rebase, or nothing. */
export async function conflictKind(scope: Scope): Promise<'merge' | 'rebase' | null> {
	if (await rebaseInProgress(scope)) return 'rebase';
	return (await mergeInProgress(scope)) ? 'merge' : null;
}
/** A merge started outside the app (the terminal): the branch it brings, by name if a branch points at `MERGE_HEAD`. */
export async function mergeSource(scope: Scope): Promise<string | null> {
	const sha = await gitText(scope.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(
		() => ''
	);
	if (!sha) return null;
	const names = (
		await gitText(scope.path, [
			'for-each-ref',
			'--points-at',
			sha,
			'--format=%(refname:short)',
			'refs/heads',
			'refs/remotes',
		]).catch(() => '')
	)
		.split('\n')
		.filter(Boolean);
	return names.find((name) => !name.includes('/')) ?? names[0] ?? sha.slice(0, 7);
}
export type RebaseInfo = {
	branch: string;
	onto: string;
	head: string;
	step: { current: number; total: number };
};
/** `Rebasing <branch> onto <onto> · commit N of M`: git keeps it all in the rebase directory. */
export async function rebaseInfo(scope: Scope): Promise<RebaseInfo | null> {
	const dir = await rebaseDir(scope);
	if (!dir) return null;
	const read = (name: string) =>
		readFile(join(dir, name), 'utf8').then(
			(text) => text.trim(),
			() => ''
		);
	const merge = dir.endsWith('rebase-merge');
	const [head, onto, orig, current, total] = await Promise.all([
		read('head-name'),
		read('onto'),
		read('orig-head'),
		read(merge ? 'msgnum' : 'next'),
		read(merge ? 'end' : 'last'),
	]);
	const ontoName = onto
		? (
				await gitText(scope.path, [
					'for-each-ref',
					'--points-at',
					onto,
					'--format=%(refname:short)',
					'refs/heads',
					'refs/remotes',
				]).catch(() => '')
			)
				.split('\n')
				.find(Boolean) || onto.slice(0, 7)
		: 'HEAD';
	return {
		branch: head.replace(/^refs\/heads\//, '') || 'HEAD',
		onto: ontoName,
		head: orig.slice(0, 7),
		step: { current: Number(current) || 1, total: Number(total) || 1 },
	};
}

/** A merge writes into the tree; it could mix uncommitted changes in tracked files with incoming ones. */
async function assertMergeable(scope: Scope, into: string) {
	if ((await mergeInProgress(scope)) || (await rebaseInProgress(scope)))
		throw new Error('A merge is already in progress.');
	if ((await currentBranch(scope)) !== into) throw new Error('Merge into the current branch only.');
	const dirty = (
		await git(scope.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
	).toString('utf8');
	if (dirty.length) throw new Error('Commit or stash the changes before merging.');
}

function numstat(text: string): MergeFile[] {
	const files: MergeFile[] = [];
	const fields = text.split('\0');
	for (let i = 0; i < fields.length - 1; i++) {
		const entry = fields[i]!,
			first = entry.indexOf('\t'),
			second = entry.indexOf('\t', first + 1);
		if (first < 0 || second < 0) continue;
		let path = entry.slice(second + 1);
		if (!path) {
			i++;
			path = fields[++i]!;
		}
		const added = entry.slice(0, first),
			removed = entry.slice(first + 1, second);
		files.push({
			path,
			additions: added === '-' ? 0 : Number(added),
			deletions: removed === '-' ? 0 : Number(removed),
		});
	}
	return files;
}

/** What will arrive: commits and files from the `from` side; `merge-tree` predicts a conflict; the task's tree is untouched. */
export async function previewMerge(
	scope: Scope,
	into: string,
	from: string
): Promise<MergePreview> {
	const [target, source] = await Promise.all([
		resolveBranch(scope, into),
		resolveBranch(scope, from),
	]);
	const commits = Number(
		await gitText(scope.path, ['rev-list', '--count', `${target.sha}..${source.sha}`])
	);
	const base = {
		scopeId: scope.id,
		into,
		from,
		commits,
		files: [] as MergeFile[],
		conflicts: [] as string[],
		upToDate: commits === 0,
	};
	if (!commits) return base;
	const files = numstat(
		(
			await git(scope.path, ['diff', '--numstat', '-z', '-M', `${target.sha}...${source.sha}`])
		).toString('utf8')
	);
	const tree = await gitExit(scope.path, [
		'merge-tree',
		'--write-tree',
		'--name-only',
		'--no-messages',
		'-z',
		target.sha,
		source.sha,
	]);
	if (tree.code !== 0 && tree.code !== 1)
		throw new Error(tree.stderr || 'The merge could not be checked.');
	const conflicts = tree.code === 1 ? tree.stdout.split('\0').slice(1).filter(Boolean) : [];
	return { ...base, files, conflicts: [...new Set(conflicts)] };
}

export async function startMerge(scope: Scope, into: string, from: string): Promise<MergeOutcome> {
	await assertMergeable(scope, into);
	const source = await resolveBranch(scope, from);
	const behind = Number(await gitText(scope.path, ['rev-list', '--count', `HEAD..${source.sha}`]));
	if (!behind) return { status: 'up-to-date', sha: null };
	const result = await gitExit(scope.path, [
		'merge',
		'--no-ff',
		'--no-edit',
		'-m',
		`Merge ${from} into ${into}`,
		source.ref,
	]);
	if (result.code === 0)
		return { status: 'merged', sha: await gitText(scope.path, ['rev-parse', 'HEAD']) };
	if ((await mergeHead(scope)) && (await unmergedPaths(scope)).length)
		return { status: 'conflicts', sha: null };
	if (await mergeHead(scope)) await gitExit(scope.path, ['merge', '--abort']);
	throw new Error(result.stderr || 'The merge failed.');
}

export async function unmergedPaths(scope: Scope): Promise<string[]> {
	return [...new Set(await unmergedNames(scope.path))].sort();
}

const OURS = /^<{7}(?: |$)/,
	SPLIT = /^={7}$/,
	THEIRS = /^>{7}(?: |$)/,
	BASE = /^\|{7}(?: |$)/;
/** How many conflict regions are left in the file's text. */
export function conflictPlaces(text: string): number {
	return text.split('\n').filter((line) => OURS.test(line)).length;
}

/** Resolve every region of a file with one side. `both` — ours, then theirs, without markers. */
export function takeSide(text: string, take: 'ours' | 'theirs' | 'both'): string {
	const out: string[] = [];
	let state: 'none' | 'ours' | 'base' | 'theirs' = 'none';
	for (const line of text.split('\n')) {
		if (state === 'none' && OURS.test(line)) {
			state = 'ours';
			continue;
		}
		if (state === 'ours' && BASE.test(line)) {
			state = 'base';
			continue;
		}
		if ((state === 'ours' || state === 'base') && SPLIT.test(line)) {
			state = 'theirs';
			continue;
		}
		if (state === 'theirs' && THEIRS.test(line)) {
			state = 'none';
			continue;
		}
		if (state === 'none') out.push(line);
		else if (state === 'ours' && take !== 'theirs') out.push(line);
		else if (state === 'theirs' && take !== 'ours') out.push(line);
	}
	if (state !== 'none') throw new Error('The conflict markers are incomplete.');
	return out.join('\n');
}

function inside(scope: Scope, path: string) {
	if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0'))
		throw new Error('Invalid path');
	return join(scope.path, path);
}

/** Which side deleted an unmerged file: no stage 2 — ours (the current branch), no stage 3 — theirs. */
function deletedSide(stages: Set<number> | undefined): ConflictFile['deleted'] {
	if (!stages) return undefined;
	const ours = stages.has(2),
		theirs = stages.has(3);
	return !ours && !theirs ? 'both' : !ours ? 'ours' : !theirs ? 'theirs' : undefined;
}

/** spec/appearance#evolution-redesign: in a rebase git's «ours» is the base and «theirs» the person's commit; the person sees them swapped. */
export const swapSide = <T extends string>(side: T, swap: boolean): T =>
	(swap ? (side === 'ours' ? 'theirs' : side === 'theirs' ? 'ours' : side) : side) as T;

export async function conflictFiles(
	scope: Scope,
	paths: string[],
	agentPaths: string[] = [],
	swap = false
): Promise<ConflictFile[]> {
	const stages = await unmergedStages(scope.path),
		agent = new Set(agentPaths);
	return Promise.all(
		paths.map(async (path) => {
			const resolved = !stages.has(path),
				deleted = resolved ? undefined : deletedSide(stages.get(path)),
				text =
					resolved || deleted ? '' : await readFile(inside(scope, path), 'utf8').catch(() => '');
			return {
				path,
				places: resolved || deleted ? 0 : conflictPlaces(text),
				resolved,
				byAgent: agent.has(path),
				...(deleted ? { deleted: swapSide(deleted, swap) } : {}),
				...(text.includes('\0') || text.length > textLimit ? { binary: true } : {}),
			};
		})
	);
}

/**
 * A side that deleted the file wins by `git rm`; the other side's file comes back from its stage.
 * Returns what happened to the file: a side, both, or — for a file deleted on one side — kept or deleted.
 */
export async function resolveWith(
	scope: Scope,
	path: string,
	take: 'ours' | 'theirs' | 'both'
): Promise<'ours' | 'theirs' | 'both' | 'kept' | 'deleted'> {
	const file = inside(scope, path),
		stages = (await unmergedStages(scope.path)).get(path);
	if (!stages) throw new Error('The file has no conflict.');
	const deleted = deletedSide(stages);
	if (deleted) {
		if (take === 'both') throw new Error('The file was deleted on one side.');
		if (deleted === 'both' || deleted === take) {
			await git(scope.path, ['rm', '-q', '--', path]);
			return 'deleted';
		}
		await git(scope.path, ['checkout', `--${take}`, '--', path]);
		await git(scope.path, ['add', '--', path]);
		return 'kept';
	}
	if (take === 'both') {
		await writeFile(file, takeSide(await readFile(file, 'utf8'), 'both'));
	} else await git(scope.path, ['checkout', `--${take}`, '--', path]);
	await git(scope.path, ['add', '--', path]);
	return take;
}

/** The merge view shows text files up to 2 MB; a larger or binary file resolves by a whole side. */
const textLimit = 2 * 1024 * 1024;
/**
 * spec/appearance#evolution-redesign: base, both sides and the file as it is now, for the three columns. `swap` — a rebase: the person's
 * commit is git's «theirs». A side that deleted the file has no text: that conflict is `Keep` / `Delete`, not columns.
 */
export async function conflictTexts(
	scope: Scope,
	path: string,
	swap = false
): Promise<Omit<ConflictTexts, 'byAgent'>> {
	const file = inside(scope, path);
	if (!(await unmergedStages(scope.path)).has(path)) throw new Error('The file has no conflict.');
	const stage = (n: number) => git(scope.path, ['show', `:${n}:${path}`]).catch(() => null);
	const [base, ours, theirs, current] = await Promise.all([
		stage(1),
		stage(2),
		stage(3),
		readFile(file).catch(() => null),
	]);
	if (!ours || !theirs) throw new Error('The file was deleted on one side.');
	for (const blob of [base, ours, theirs, current])
		if (blob && (blob.length > textLimit || blob.includes(0)))
			throw new Error('The file is not text.');
	const text = (blob: Buffer | null) => blob?.toString('utf8') ?? '';
	return {
		path,
		base: text(base),
		ours: text(swap ? theirs : ours),
		theirs: text(swap ? ours : theirs),
		current: text(current),
	};
}
/** `Apply` of the merge view: the person's Result is the file, and the file is resolved (`git add`). */
export async function applyResolution(scope: Scope, path: string, text: string) {
	if (!(await unmergedStages(scope.path)).has(path)) throw new Error('The file has no conflict.');
	await writeFile(inside(scope, path), text);
	await git(scope.path, ['add', '--', path]);
}
/**
 * `Back to the conflict`: the index's resolve-undo record gives the stages back (`update-index --unresolve`), then
 * `git checkout -m` writes the markers again; a file deleted on one side comes back as the other side's file.
 */
export async function reopenConflict(scope: Scope, path: string) {
	inside(scope, path);
	if ((await unmergedStages(scope.path)).has(path)) return;
	const fail = (stderr: string) => new Error(stderr || 'The conflict could not be restored.');
	const unresolve = await gitExit(scope.path, ['update-index', '--unresolve', '--', path]);
	const stages = (await unmergedStages(scope.path)).get(path);
	if (unresolve.code !== 0 || !stages) throw fail(unresolve.stderr);
	const args =
		stages.has(2) && stages.has(3)
			? ['checkout', '-m', '--', path]
			: stages.has(2)
				? ['checkout', '--ours', '--', path]
				: stages.has(3)
					? ['checkout', '--theirs', '--', path]
					: null;
	if (!args) return;
	const result = await gitExit(scope.path, args);
	if (result.code !== 0) throw fail(result.stderr);
}

/** The person resolved it by hand in the editor: no markers left, so mark it resolved. No file on disk — `git rm`. */
export async function markResolved(scope: Scope, path: string) {
	const text = await readFile(inside(scope, path), 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return null;
		throw error;
	});
	if (text === null) return void (await git(scope.path, ['rm', '-q', '--', path]));
	if (conflictPlaces(text)) throw new Error('Resolve every conflict place first.');
	await git(scope.path, ['add', '--', path]);
}

export async function mergedCleanly(scope: Scope, conflicted: string[]): Promise<MergeFile[]> {
	const skip = new Set(conflicted);
	return numstat(
		(await git(scope.path, ['diff', '--cached', '--numstat', '-z', '-M', 'HEAD'])).toString('utf8')
	).filter((file) => !skip.has(file.path));
}

/**
 * Only the person creates the merge commit: this function is the «Finish merge» button.
 * For a crew squash the same `commit --no-edit` takes `SQUASH_MSG`, the generated message (spec/crew#accept).
 */
export async function finishMerge(scope: Scope): Promise<MergeOutcome> {
	if (await rebaseInProgress(scope)) return continueRebase(scope);
	if (!(await mergeInProgress(scope))) throw new Error('No merge is in progress.');
	if ((await unmergedPaths(scope)).length) throw new Error('Resolve every conflict place first.');
	const result = await gitExit(scope.path, ['commit', '--no-edit', '-q']);
	if (result.code !== 0) throw new Error(result.stderr || 'The merge could not be committed.');
	return { status: 'merged', sha: await gitText(scope.path, ['rev-parse', 'HEAD']) };
}

/**
 * spec/appearance#evolution-redesign: `Continue` of a rebase. The next commit may stop with its own conflicts — then the dialog stays with
 * them (`conflicts`); a step that stopped for another reason says git's words.
 */
async function continueRebase(scope: Scope): Promise<MergeOutcome> {
	if ((await unmergedPaths(scope)).length) throw new Error('Resolve every conflict place first.');
	const result = await gitExit(scope.path, ['rebase', '--continue']);
	if (await rebaseInProgress(scope)) {
		if ((await unmergedPaths(scope)).length) return { status: 'conflicts', sha: null };
		if (result.code !== 0) throw new Error(result.stderr || 'The rebase could not continue.');
	} else if (result.code !== 0) throw new Error(result.stderr || 'The rebase could not continue.');
	return { status: 'merged', sha: await gitText(scope.path, ['rev-parse', 'HEAD']) };
}

/** `merge --abort` refuses without `MERGE_HEAD`; a squash is undone by `reset --merge`, the same step `merge --abort` runs. */
export async function abortMerge(scope: Scope) {
	if (await rebaseInProgress(scope)) {
		const result = await gitExit(scope.path, ['rebase', '--abort']);
		if (result.code !== 0) throw new Error(result.stderr || 'The rebase could not be aborted.');
		return;
	}
	if (!(await mergeInProgress(scope))) return;
	const result = await gitExit(
		scope.path,
		(await mergeHead(scope)) ? ['merge', '--abort'] : ['reset', '-q', '--merge']
	);
	if (result.code !== 0) throw new Error(result.stderr || 'The merge could not be aborted.');
}
