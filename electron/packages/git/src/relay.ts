import { posix } from 'node:path';
import type { RelayDiff, TaskKey, ChangeRange } from '@brigadir/core';
import type { SessionStore } from '@brigadir/persistence';
import { readChanges } from './changes';
import { readSnapshots } from './snapshots';
import { git, GitError } from './command';
const patchOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=3'];
/**
 * The patch of every non-renamed file comes from one `git diff` per repo, not a process per file (up to 128). For a single
 * path `--no-renames` changes nothing, so the sections are the same bytes `git diff -- <path>` would give. Raw records come
 * in the same order as the sections; a file type change gives two sections. A different section count (e.g.
 * `diff.submodule=log`), output over 16 MB or an error — `null`, and each file is read separately. A section over 128 KB is
 * `null` in the map: the same «resource limit» a separate process would hit.
 */
async function batch(
	cwd: string,
	before: string,
	after: string,
	files: readonly { path: string }[]
): Promise<Map<string, Buffer | null> | null> {
	if (files.length < 2) return null;
	let output: Buffer;
	try {
		output = await git(
			cwd,
			[
				'diff',
				'--no-renames',
				...patchOptions,
				'--patch-with-raw',
				'-z',
				before,
				after,
				'--',
				...files.map((file) => `:(top,literal)${file.path}`),
			],
			{ maxBytes: 16 * 1024 * 1024 }
		);
	} catch (error) {
		if (error instanceof GitError) return null;
		throw error;
	}
	const records: { path: string; sections: number }[] = [];
	let offset = 0;
	while (output[offset] === 0x3a) {
		const status = output.indexOf(0, offset),
			end = output.indexOf(0, status + 1);
		if (status < 0 || end < 0) return null;
		const [from, to] = output.toString('latin1', offset + 1, status).split(' ');
		const type = (mode: string | undefined) => Number.parseInt(mode ?? '0', 8) & 0o170000;
		records.push({
			path: output.toString('utf8', status + 1, end),
			sections: type(from) && type(to) && type(from) !== type(to) ? 2 : 1,
		});
		offset = end + 1;
	}
	if (records.length !== files.length || (records.length && output[offset++] !== 0)) return null;
	const header = Buffer.from('diff --git '),
		starts: number[] = [];
	for (let at = offset; at < output.length;) {
		if (!output.subarray(at, at + header.length).equals(header)) return null;
		starts.push(at);
		const next = output.indexOf('\ndiff --git ', at);
		at = next < 0 ? output.length : next + 1;
	}
	if (starts.length !== records.reduce((sum, record) => sum + record.sections, 0)) return null;
	const result = new Map<string, Buffer | null>();
	let section = 0;
	for (const record of records) {
		const from = starts[section]!;
		section += record.sections;
		const patch = output.subarray(from, starts[section] ?? output.length);
		result.set(record.path, patch.length > 128000 ? null : patch);
	}
	return result;
}
/** Freeze the selected task range, including untracked files captured in snapshot trees. */
export async function readRelayDiff(
	store: SessionStore,
	key: TaskKey,
	range?: ChangeRange
): Promise<RelayDiff> {
	const doc = await readSnapshots(store, key),
		changes = await readChanges(store, key, range),
		current = doc?.checkpoints[range?.current ?? doc.checkpoints.length - 1],
		base = doc?.checkpoints[range?.base ?? 0];
	const result: RelayDiff = { stat: '', patch: '', files: [], truncated: false };
	if (!doc || !current || !base) return { ...result, stat: 'No captured changes.' };
	let added = 0,
		removed = 0;
	const lines: string[] = [],
		batches = new Map<string, Promise<Map<string, Buffer | null> | null>>();
	for (const [index, file] of changes.files.entries()) {
		const scope = changes.scopes.find((scope) => scope.id === file.scopeId)!,
			path = posix.join(scope.name, file.path);
		added += file.additions;
		removed += file.deletions;
		if (index < 1000)
			lines.push(
				`${JSON.stringify(path)} | ${file.binary ? 'binary' : `+${file.additions} -${file.deletions}`} (${file.status})`
			);
		else result.truncated = true;
		if (file.after && !file.gitlink && result.files.length < 20) result.files.push(path);
		if (index >= 128 || Buffer.byteLength(result.patch) > 120000) {
			result.truncated = true;
			continue;
		}
		const before =
				base.trees.find((tree) => tree.scopeId === scope.id) ??
				doc.checkpoints
					.slice(0, current.id + 1)
					.flatMap((point) => point.trees)
					.find((tree) => tree.scopeId === scope.id),
			after = current.trees.find((tree) => tree.scopeId === scope.id);
		if (!before || !after) continue;
		try {
			if (!batches.has(scope.id))
				batches.set(
					scope.id,
					batch(
						scope.path,
						before.tree,
						after.tree,
						changes.files
							.slice(0, 128)
							.filter((item) => item.scopeId === scope.id && item.path === item.oldPath)
					)
				);
			const batched = (await batches.get(scope.id))?.get(file.path);
			if (batched === null)
				throw new GitError([], null, 'Git operation exceeded its resource limit');
			const patch =
				batched ??
				(await git(
					scope.path,
					[
						'diff',
						...patchOptions,
						before.tree,
						after.tree,
						'--',
						`:(top,literal)${file.oldPath}`,
						...(file.path === file.oldPath ? [] : [`:(top,literal)${file.path}`]),
					],
					{ maxBytes: 128000 }
				));
			if (Buffer.byteLength(result.patch) + patch.length > 128000) {
				result.truncated = true;
				continue;
			}
			result.patch += `\nScope: ${JSON.stringify(scope.name)}\n${patch.toString('utf8')}`;
		} catch (error) {
			if (!(error instanceof GitError) || !error.message.includes('resource limit')) throw error;
			result.truncated = true;
		}
	}
	result.stat = `${changes.files.length} files changed, ${added} insertions, ${removed} deletions\n${lines.join('\n')}`;
	if (Buffer.byteLength(result.stat) > 100000) {
		result.stat = Buffer.from(result.stat).subarray(0, 100000).toString('utf8');
		result.truncated = true;
	}
	if (result.truncated) result.patch += '\n[Patch truncated to fit the handoff budget.]';
	return result;
}
